import { DATA_VERSION, scenarios } from '@/data'
import type { Side } from '@/data'

import { RNG_ALGORITHM, verifyRngState } from './rng'
import { deserializeSession, SESSION_SAVE_VERSION } from './session'
import { consensusDecisions } from './session-flow'
import type { SessionForm, TerminationReason } from './session-types'
import type { GamePhase, GameSession } from './state-types'

/**
 * 存档文件（W6 D1：序列化与会话持久化）
 *
 * ## 分层：两层版本各管一件事
 *   - **存档文件版本**（本模块 `SAVE_FILE_VERSION`）：管「存档文件这个外壳怎么装」
 *     —— 含哪些字段、旧文件还能不能读；
 *   - **会话容器版本**（`session.ts` 的 `SESSION_SAVE_VERSION`）：管「会话信封」；
 *   - **会话数据模型版本**（`meta.schemaVersion`）：管「会话内部字段变了没有」；
 *   - **数据契约版本**（`data/DATA_VERSION`）：管「数据文件（单位库/图表/剧本）的契约」。
 *   四者相互独立：读档时逐层校验，任一层不符即拒（不静默迁移、不猜值）。
 *
 * ## 存档内容（对应用户要求的六项）
 *   | 要求 | 落在哪里 |
 *   |---|---|
 *   | 状态 | `session.state`（records / units / stacks / markers / rng） |
 *   | 种子 | `session.state.rng.seed`（及内部状态 `state`） |
 *   | 日志游标 | `session.state.rng.drawCount`（掷骰步数）＋ `session.log`（整局审计） |
 *   | 进行中会话 | `session.status`（`awaiting` 时 **含待答问题**，读回后照旧停下等作答） |
 *   | 共识开关 | `session.log` 里的 `answer` 条目（`scenarios.agreedOptions` 逐条结论） |
 *   | 剧本与数据版本 | 文件头的 `scenarioId` / `dataVersion` / `saveVersion` |
 *
 * ## 纪律
 *   - 本模块是**纯函数**：字符串进、对象出；**不碰 localStorage**（浏览器存储属 stores 层），
 *     也**不取系统时间**（`savedAt` 由存档层盖章后传入）。
 *   - 读档只做「校验 + 还原」，**不做任何补值或迁移**：缺字段、版本不符、剧本对不上、内外剧本不一致
 *     ⇒ 一律报错并指出字段路径（对齐数据层 DataError 的报错风格，CODE_SPEC §3.4）。
 */

/** 存档文件格式版本（外壳；破坏性变更须递增） */
export const SAVE_FILE_VERSION = 1

/** 存档文件（可直接 `JSON.stringify` 落盘） */
export interface SaveFile {
  /** 存档文件格式版本 */
  saveVersion: number
  /** 数据契约版本（`data/version.ts` 的 DATA_VERSION） */
  dataVersion: string
  /** 剧本标识（与 `session.state.scenarioId` 必须一致） */
  scenarioId: string
  /** 写盘时间戳（ISO 8601；由存档层盖章——引擎无时钟） */
  savedAt: string
  /** 会话容器版本（`session.ts` 的 SESSION_SAVE_VERSION；存档自带，读档时显式校验） */
  sessionSaveVersion: number
  /**
   * 掷骰算法标识（`rng.ts` 的 RNG_ALGORITHM）
   *
   * 存档要能**复算**就必须知道骰子是怎么掷的：算法换了，同一 seed/drawCount 就推不出同一序列。
   */
  rngAlgorithm: string
  /** 会话本体（状态 / 种子与游标 / 日志 / 形态；四形态皆可存档） */
  session: GameSession
  /**
   * **盘面快照**（不透明；形状由 store 层拥有）
   *
   * 引擎只认识"会话"（记录轨 / 日志 / 种子），而**盘面**（算子、补给站、飞机、各类账本）活在
   * `stores/workbench` 里 —— 修前存档不带它 ⇒ 读档只恢复记录轨、盘面留在原处，两边**互相矛盾**。
   * 故此处透传一个 store 层自己序列化的快照：引擎不解释它的内容，只做"存在即透传"与最小形态校验。
   * 缺省（未注册编解码器）时该字段不出现 —— 旧档读起来照旧。
   */
  board?: unknown
}

/** 存档错误：带字段路径，便于定位（与 SessionError / DataError 同风格） */
export class SaveFileError extends Error {
  /** 出错的字段路径（如 `#/dataVersion`） */
  readonly path: string

  constructor(path: string, reason: string) {
    super(`[save-file] ${path}: ${reason}`)
    this.name = 'SaveFileError'
    this.path = path
  }
}

/* ────────────────────────────── 写档 ────────────────────────────── */

/**
 * 序列化为 JSON 文本
 *
 * @param session 会话本体（引擎不取时间，`savedAt` 由调用方传入）
 * @param savedAt 写盘时间戳（ISO 8601）
 * @param dataVersion 数据契约版本；缺省取当前 `DATA_VERSION`
 */
export function serializeSaveFile(
  session: GameSession,
  savedAt: string,
  dataVersion: string = DATA_VERSION,
  /** 盘面快照（**不透明**；由 store 层的编解码器产出，引擎不解释） */
  board?: unknown,
): string {
  const file: SaveFile = {
    saveVersion: SAVE_FILE_VERSION,
    dataVersion,
    scenarioId: session.state.scenarioId,
    savedAt,
    sessionSaveVersion: SESSION_SAVE_VERSION,
    rngAlgorithm: RNG_ALGORITHM,
    session,
    ...(board === undefined ? {} : { board }),
  }
  return JSON.stringify(file, null, 2)
}

/* ────────────────────────────── 读档 ────────────────────────────── */

/** 读档的期望值（缺省取当前环境：数据版本取 DATA_VERSION、剧本取剧本库） */
export interface LoadSaveOptions {
  /** 期望的数据契约版本；缺省 `DATA_VERSION` */
  expectedDataVersion?: string
  /** 已知剧本号（缺省取 `scenarios.scenarios` 的实际剧本） */
  knownScenarioIds?: readonly string[]
}

/** 取对象，否则以路径报错 */
function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SaveFileError(path, `期望对象，实际 ${Array.isArray(value) ? 'array' : typeof value}`)
  }
  return value as Record<string, unknown>
}

/** 取非空字符串，否则以路径报错 */
function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SaveFileError(path, `期望非空字符串，实际 ${JSON.stringify(value) ?? String(value)}`)
  }
  return value
}

/** 取有限数字，否则以路径报错 */
function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SaveFileError(path, `期望有限数字，实际 ${String(value)}`)
  }
  return value
}

/**
 * 从 JSON 文本读回存档并**逐层校验**
 *
 * 校验顺序（任一步失败即抛 `SaveFileError`，且不返回半成品）：
 *   ① 文本是合法 JSON；
 *   ② `saveVersion` 与 `SAVE_FILE_VERSION` 一致；
 *   ③ `dataVersion` 与期望一致（默认当前 `DATA_VERSION`）；
 *   ④ `scenarioId` 在剧本库内；
 *   ⑤ `sessionSaveVersion` 与 `SESSION_SAVE_VERSION` 一致、`rngAlgorithm` 与 `RNG_ALGORITHM` 一致；
 *   ⑥ 会话本体的骨架（交给 `deserializeSession`：形态、待答问题、日志形状、rng 字段）；
 *   ⑦ **种子—游标—内部状态自洽**（`verifyRngState`：seed + drawCount 能否重推出同一个内部状态，
 *      即「这一档还能不能复算」）；
 *   ⑧ 内外剧本一致（`scenarioId` === `session.state.scenarioId`）—— 防止外壳与状态被各自改过。
 */
export function deserializeSaveFile(text: string, options: LoadSaveOptions = {}): SaveFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SaveFileError('#', `不是合法 JSON：${(error as Error).message}`)
  }

  const root = requireObject(parsed, '#')
  const saveVersion = requireNumber(root['saveVersion'], '#/saveVersion')
  if (saveVersion !== SAVE_FILE_VERSION) {
    throw new SaveFileError(
      '#/saveVersion',
      `存档文件版本不匹配：期望 ${SAVE_FILE_VERSION}，实际 ${saveVersion}（本作不做静默迁移）`,
    )
  }

  const expectedData = options.expectedDataVersion ?? DATA_VERSION
  const dataVersion = requireNonEmptyString(root['dataVersion'], '#/dataVersion')
  if (dataVersion !== expectedData) {
    throw new SaveFileError(
      '#/dataVersion',
      `数据契约版本不匹配：期望 ${expectedData}，实际 ${dataVersion}（数据文件契约已变更，旧档不可直读）`,
    )
  }

  const scenarioId = requireNonEmptyString(root['scenarioId'], '#/scenarioId')
  const known = options.knownScenarioIds ?? scenarios.scenarios.map((item) => item.id)
  if (!known.includes(scenarioId)) {
    throw new SaveFileError('#/scenarioId', `剧本不存在于剧本库：${scenarioId}`)
  }

  const savedAt = requireNonEmptyString(root['savedAt'], '#/savedAt')

  const sessionSaveVersion = requireNumber(root['sessionSaveVersion'], '#/sessionSaveVersion')
  if (sessionSaveVersion !== SESSION_SAVE_VERSION) {
    throw new SaveFileError(
      '#/sessionSaveVersion',
      `会话容器版本不匹配：期望 ${SESSION_SAVE_VERSION}，实际 ${sessionSaveVersion}`,
    )
  }

  const rngAlgorithm = requireNonEmptyString(root['rngAlgorithm'], '#/rngAlgorithm')
  if (rngAlgorithm !== RNG_ALGORITHM) {
    throw new SaveFileError(
      '#/rngAlgorithm',
      `掷骰算法不一致：存档 ${rngAlgorithm}，当前 ${RNG_ALGORITHM}（换算法后旧档不可复算）`,
    )
  }

  // 会话本体：按文件自述的容器版本拼回会话层信封，复用其骨架校验
  const sessionText = JSON.stringify({
    saveVersion: sessionSaveVersion,
    session: root['session'],
  })
  let session: GameSession
  try {
    session = deserializeSession(sessionText)
  } catch (error) {
    throw new SaveFileError('#/session', (error as Error).message)
  }

  // 种子—游标—内部状态自洽：seed + drawCount 必须能重推出存档里的内部状态，否则不可复算
  if (!verifyRngState(session.state.rng)) {
    throw new SaveFileError(
      '#/session/state/rng',
      `掷骰状态不可复算：seed ${session.state.rng.seed} + drawCount ${session.state.rng.drawCount} 推不出内部状态 ${session.state.rng.state}`,
    )
  }

  const innerScenario = session.state.scenarioId
  if (innerScenario !== scenarioId) {
    throw new SaveFileError(
      '#/session/state/scenarioId',
      `内外剧本不一致：文件头 ${scenarioId}，会话状态 ${String(innerScenario)}`,
    )
  }

  /*
   * 盘面快照：**只透传**。这里仅做最小形态校验（若给了它就必须是个对象），
   * 业务形态由 store 层的 `restoreBoard` 负责 —— 引擎不认识算子的数据形状。
   */
  const board = root['board']
  if (board !== undefined && (typeof board !== 'object' || board === null))
    throw new SaveFileError('#/board', '盘面快照应为对象（形状由 store 层定义）')

  return {
    saveVersion,
    dataVersion,
    scenarioId,
    savedAt,
    sessionSaveVersion,
    rngAlgorithm,
    session,
    ...(board === undefined ? {} : { board }),
  }
}

/* ────────────────────────────── 存档摘要（列表/校验用） ────────────────────────────── */

/** 进行中会话的待答摘要 */
export interface SaveAwaitingInfo {
  questionId: string
  kind: string
  responder: Side
  prompt: string
}

/** 存档摘要（读档校验通过后给出；供界面显示「这一档是什么」） */
export interface SaveSlotInfo {
  saveVersion: number
  dataVersion: string
  scenarioId: string
  /** 剧本名（取自剧本库） */
  scenarioName: string
  savedAt: string
  /** 会话形态（`awaiting` = 进行中且正等待作答） */
  form: SessionForm
  /** 待答问题摘要（无待答为 null） */
  awaiting: SaveAwaitingInfo | null
  /** 终止原因（未终止为 null） */
  termination: TerminationReason | null
  /** 记录轨：回合 / 阶段 */
  turn: number
  phase: GamePhase
  /** 种子与内部状态（复算入口） */
  seed: number
  rngState: number
  /** 日志游标：已掷骰次数（`RngState.drawCount`） */
  drawCount: number
  /** 日志条目数（整局审计条数；与 drawCount 一起构成复算游标） */
  logEntries: number
  /** 共识开关结论（`scenarios.agreedOptions` 逐条；未作答为 null） */
  consensus: readonly { item: string; adopted: boolean | null }[]
}

/** 存档摘要：内部走完整读档校验（版本不符即抛错，不产出摘要） */
export function describeSaveFile(text: string, options: LoadSaveOptions = {}): SaveSlotInfo {
  const file = deserializeSaveFile(text, options)
  const { session } = file
  const status = session.status
  const scenario = scenarios.scenarios.find((item) => item.id === file.scenarioId)

  return {
    saveVersion: file.saveVersion,
    dataVersion: file.dataVersion,
    scenarioId: file.scenarioId,
    scenarioName: scenario?.name ?? file.scenarioId,
    savedAt: file.savedAt,
    form: status.form,
    awaiting:
      status.form === 'awaiting'
        ? {
            questionId: status.question.id,
            kind: status.question.kind,
            responder: status.question.responder,
            prompt: status.question.prompt,
          }
        : null,
    termination: status.form === 'terminated' ? status.reason : null,
    turn: session.state.records.turn,
    phase: session.state.records.phase,
    seed: session.state.rng.seed,
    rngState: session.state.rng.state,
    drawCount: session.state.rng.drawCount,
    logEntries: session.log.length,
    consensus: consensusDecisions(session, scenarios.agreedOptions.items),
  }
}

/* ────────────────────────────── 存档错误的归类（W7 C15） ────────────────────────────── */

/**
 * 存档错误的类别（供界面把「版本不匹配」与「档损坏 / 无档 / 无介质」分开提示）
 *
 * 存档层（`stores/session.ts`）给出的 `reason` 是**字符串**（内核与存储层的原始原因），
 * 界面不该自己去猜字符串含义 ⇒ 归类逻辑集中在这里（纯函数，可单测）。
 */
export const SAVE_ERROR_KINDS = [
  /** 槽里没东西（尚未存过档 / 已清档） */
  'emptySlot',
  /** 浏览器不给本地存储（隐私模式 / 沙箱） */
  'storageUnavailable',
  /** 当前没有会话可存（还没开局） */
  'noSessionToSave',
  /** 内容不是合法 JSON */
  'notJson',
  /** **版本不匹配**（存档格式 / 数据契约 / 会话容器 / 掷骰算法四层之一） */
  'versionMismatch',
  /** 存档里的剧本不在剧本库 */
  'scenarioUnknown',
  /** 文件头剧本与会话状态剧本不一致 */
  'innerScenarioMismatch',
  /** 种子—游标—内部状态不自洽（该档不可复算） */
  'rngNotReplayable',
  /** 其它结构性损坏（缺字段 / 形状不对） */
  'corrupt',
  /** 存储读写失败等环境问题 */
  'other',
] as const
export type SaveErrorKind = (typeof SAVE_ERROR_KINDS)[number]

/** 版本不匹配涉及的层（含该层拒读的理由与处置建议） */
interface SaveVersionLayer {
  /** 报错路径（`SaveFileError.path`） */
  path: string
  /** 层名（界面用） */
  layer: string
  /** 拒读理由（为什么这一层不符就不能读） */
  why: string
  /** 处置建议 */
  hint: string
}

/**
 * 四层版本（与文件头的四个版本字段一一对应）
 *
 * 逐条对照 `deserializeSaveFile` 的校验顺序：存档格式 → 数据契约 → 会话容器 → 掷骰算法。
 * 剧本号 / 内外一致 / 种子自洽属**内容**校验，不属版本层。
 */
const SAVE_VERSION_LAYERS: readonly SaveVersionLayer[] = [
  {
    path: '#/saveVersion',
    layer: '存档文件格式',
    why: '存档外壳的字段结构变过',
    hint: '本作不做静默迁移：请用新版本重新保存一档（旧档不会被改写）',
  },
  {
    path: '#/dataVersion',
    layer: '数据契约',
    why: '单位库 / 图表 / 剧本等数据文件的契约已变更，旧档里的数值口径可能与现库不一致',
    hint: '确认数据版本后再开局重存一档；旧档保持原样，不会被覆盖',
  },
  {
    path: '#/sessionSaveVersion',
    layer: '会话容器',
    why: '会话信封（状态 / 日志 / 待答问题的装法）变过',
    hint: '同上：不做迁移，请以当前版本重存一档',
  },
  {
    path: '#/rngAlgorithm',
    layer: '掷骰算法',
    why: '换算法后同一 seed + 游标推不出同一骰序，旧档**不可复算**',
    hint: '这一层最关键：旧档的掷骰无法重放复算，须以当前算法重开一局',
  },
]

/** 存档错误的可读归类（界面直接照着显示，不再解析字符串） */
export interface SaveErrorInfo {
  kind: SaveErrorKind
  /** 版本层名（仅 `versionMismatch`；如 '数据契约'） */
  layer: string | null
  /** 该层的期望值（能解析出来时给出） */
  expected: string | null
  /** 该层的实际值（能解析出来时给出） */
  actual: string | null
  /** 面向玩家的一句话说明 */
  detail: string
  /** 可操作的处置建议 */
  hint: string
}

/** 从「期望 X，实际 Y」里取两个值（取不到即 null） */
function parseExpectedActual(reason: string): { expected: string | null; actual: string | null } {
  const match = /期望\s*(.+?)[，,]\s*实际\s*(.+?)(?:（|$)/.exec(reason)
  if (match?.[1] === undefined || match[2] === undefined) return { expected: null, actual: null }
  return { expected: match[1].trim(), actual: match[2].trim() }
}

/**
 * 把存档层的 `reason` 归成「界面该说哪句话」
 *
 * 输入是 `stores/session.ts` 的 `saveError.reason`（原样），输出是可直接显示的说明 + 建议。
 * 归类判据来自本模块与存档层的**既定原因码**与 `SaveFileError` 的**报错文案**（含字段路径）。
 */
export function classifySaveError(reason: string): SaveErrorInfo {
  if (reason === 'emptySlot') {
    return {
      kind: 'emptySlot',
      layer: null,
      expected: null,
      actual: null,
      detail: '存档槽是空的：还没有存过档（或刚清过档）。',
      hint: '在有会话时点「保存到槽」即可建立一档。',
    }
  }
  if (reason === 'storageUnavailable') {
    return {
      kind: 'storageUnavailable',
      layer: null,
      expected: null,
      actual: null,
      detail: '浏览器没有提供本地存储（localStorage）⇒ 本次不落盘。',
      hint: '检查是否处于隐私模式 / 站点数据被禁用；不落盘时仍可继续对局，但关掉页面即丢。',
    }
  }
  if (reason === 'noSessionToSave') {
    return {
      kind: 'noSessionToSave',
      layer: null,
      expected: null,
      actual: null,
      detail: '当前没有会话可存：还没有开局（或已重置）。',
      hint: '先「开局」建立会话，再保存。',
    }
  }
  if (reason.startsWith('storageReadFailed') || reason.startsWith('storageWriteFailed')) {
    return {
      kind: 'other',
      layer: null,
      expected: null,
      actual: null,
      detail: `本地存储读写失败：${reason}`,
      hint: '多为配额已满或被浏览器拦截；清理站点数据后重试。',
    }
  }
  if (reason.includes('不是合法 JSON')) {
    return {
      kind: 'notJson',
      layer: null,
      expected: null,
      actual: null,
      detail: '槽里的内容不是合法 JSON ⇒ 档已损坏或被改写。',
      hint: '清档后用当前会话重新保存；不要手工编辑槽内容。',
    }
  }
  if (reason.includes('剧本不存在于剧本库')) {
    return {
      kind: 'scenarioUnknown',
      layer: null,
      expected: null,
      actual: null,
      detail: `存档里的剧本号不在当前剧本库中：${reason}`,
      hint: '该档来自别的版本 / 别的作品；清档后以当前剧本重开。',
    }
  }
  if (reason.includes('内外剧本不一致')) {
    return {
      kind: 'innerScenarioMismatch',
      layer: null,
      expected: null,
      actual: null,
      detail: `文件头剧本与会话状态里的剧本不一致 ⇒ 外壳或状态被各自改过：${reason}`,
      hint: '该档不可信；清档后重新保存。',
    }
  }
  if (reason.includes('掷骰状态不可复算')) {
    return {
      kind: 'rngNotReplayable',
      layer: null,
      expected: null,
      actual: null,
      detail: `种子 + 游标推不出存档里的内部状态 ⇒ 这一档无法重放复算：${reason}`,
      hint: '该档不可用于复盘；请以当前会话重新保存一档。',
    }
  }
  if (reason.includes('版本不匹配') || reason.includes('算法不一致')) {
    const layer = SAVE_VERSION_LAYERS.find((item) => reason.includes(item.path))
    const { expected, actual } = parseExpectedActual(reason)
    return {
      kind: 'versionMismatch',
      layer: layer?.layer ?? null,
      expected,
      actual,
      detail: layer
        ? `${layer.layer}版本不匹配（${layer.why}）：期望 ${expected ?? '—'}，实际 ${actual ?? '—'}。`
        : `版本不匹配：${reason}`,
      hint: layer?.hint ?? '本作不做静默迁移：请以当前版本重新保存一档。',
    }
  }
  /*
   * P0 修复（B48）：盘面快照的两条原因码（`stores/session.ts` 给出）——它们不是"档损坏"，
   * 而是"这份档与当前构建对盘面的约定不符"，故单列两条，把话说清楚。
   */
  if (reason.startsWith('boardMissing:')) {
    return {
      kind: 'corrupt',
      layer: null,
      expected: null,
      actual: null,
      detail: `该档没有盘面快照（存档只含记录轨，盘面不在其中）：${reason}`,
      hint: '这是修复前写下的旧档：读它会让"时钟走了、算子与账本还停在原处"，故拒读。请以当前版本重存一档。',
    }
  }
  if (reason.startsWith('boardUnrecognized:')) {
    return {
      kind: 'versionMismatch',
      layer: '盘面快照',
      expected: null,
      actual: null,
      detail: `盘面快照的版本或字段表与当前构建不符：${reason}`,
      hint: '该档来自别的构建；不做静默迁移，请以当前版本重存一档（旧档不会被改写）。',
    }
  }
  if (reason.startsWith('[save-file]')) {
    return {
      kind: 'corrupt',
      layer: null,
      expected: null,
      actual: null,
      detail: `存档结构损坏（缺字段或形状不对）：${reason}`,
      hint: '清档后重新保存；若反复出现请反馈该原因码。',
    }
  }
  return {
    kind: 'other',
    layer: null,
    expected: null,
    actual: null,
    detail: reason,
    hint: '按原因码排查；必要时清档重存。',
  }
}
