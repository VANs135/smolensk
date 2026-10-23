import type { Side } from '@/data'

import { succeed } from './result-types'
import {
  SESSION_FORMS,
  TERMINATION_REASONS,
  type SessionAnswer,
  type SessionForm,
  type SessionQuestion,
  type TerminationReason,
} from './session-types'
import type { GameSession, SessionLogEntry } from './state-types'
import { GAME_PHASES } from './state-types'

/**
 * 会话框架（B4）
 *
 * 规范依据：
 *   - CODE_SPEC.md §2：engine 为纯 TS（禁 Vue / Pinia / DOM / Canvas / 网络 / Math.random）
 *   - CODE_SPEC.md §3.1「规则结算只在引擎」：形态迁移与校验都在此，UI 不重算
 *   - CODE_SPEC.md §3.6：节点带规则编号；§7：整局回归比对「结算结果与日志」
 *
 * 本模块提供四形态会话的**机制**（不含具体规则）：
 *   步骤推进 · 待答问题 · 当前应答方 · 终止判定 · 序列化
 *
 * 形态迁移全部是**纯函数**（会话进 / 会话出），与引擎其它部分一致。
 *
 * 硬性约定（与 session-types 文件头一致，并在实现处以守卫强制）：
 *   **强制动作与自动后果不进待答**。
 *   规则强制发生、玩家无可选择的事项，由调用方直接更新状态并经 appendLog() 入账；
 *   只有真正的玩家决策才允许经 askQuestion() 产生待答问题。
 *   advanceSession() 还会校验步进函数返回的形态与该步自述的类型一致，
 *   防止「把强制后果伪装成待答」或「该问而未问」。
 */

/** 存档格式版本（与数据管线 DATA_VERSION 相互独立：数据是内容，存档是对局） */
export const SESSION_SAVE_VERSION = 1

/** 会话错误：带字段路径，便于定位（对齐数据层 DataError 的报错风格，CODE_SPEC §3.4） */
export class SessionError extends Error {
  /** 出错的字段路径（如 `#/status/form`） */
  readonly path: string

  constructor(path: string, message: string) {
    super(`[session] ${path}: ${message}`)
    this.name = 'SessionError'
    this.path = path
  }
}

/* ────────────────────────────── 形态查询 ────────────────────────────── */

/** 当前形态（B4 四种） */
export function sessionForm(session: GameSession): SessionForm {
  return session.status.form
}

/** 是否为待答（有未答问题，须先作答才能推进） */
export function isAwaiting(session: GameSession): boolean {
  return session.status.form === 'awaiting'
}

/** 是否已终止 */
export function isTerminated(session: GameSession): boolean {
  return session.status.form === 'terminated'
}

/** 当前待答问题；非待答形态为 null */
export function currentQuestion(session: GameSession): SessionQuestion | null {
  return session.status.form === 'awaiting' ? session.status.question : null
}

/**
 * 当前应答方；非待答形态为 null
 *
 * 只有待答问题才有「当前应答方」——强制动作与自动后果不产生应答方。
 */
export function currentResponder(session: GameSession): Side | null {
  return session.status.form === 'awaiting' ? session.status.question.responder : null
}

/** 终止原因；未终止为 null */
export function terminationOf(session: GameSession): TerminationReason | null {
  return session.status.form === 'terminated' ? session.status.reason : null
}

/** 当前能否推进（仅 advancing 形态可推进） */
export function canAdvance(session: GameSession): boolean {
  return session.status.form === 'advancing'
}

/* ────────────────────────────── 形态迁移（纯函数） ────────────────────────────── */

/** 开局：created → advancing */
export function startSession(session: GameSession): GameSession {
  if (session.status.form !== 'created') {
    throw new SessionError(
      '#/status/form',
      `仅未开局（created）会话可开局，当前为 ${session.status.form}`,
    )
  }
  return { ...session, status: { form: 'advancing' } }
}

/**
 * 提问：advancing → awaiting
 *
 * 一次只允许一个待答（已有的必须先作答）；已终止或未开局不可提问。
 */
export function askQuestion(session: GameSession, question: SessionQuestion): GameSession {
  switch (session.status.form) {
    case 'created':
      throw new SessionError('#/status/form', '会话尚未开局（先 startSession 再提问）')
    case 'awaiting':
      throw new SessionError('#/status/form', '已有待答问题，须先作答（一次只允许一个待答）')
    case 'terminated':
      throw new SessionError('#/status/form', '会话已终止，不能再提问')
    case 'advancing':
      break
  }
  // 题面必须完整：空 id 会让「题号一致」校验失效，空 rule 会丢掉规则引用
  checkQuestion(question, '#/question')
  return { ...session, status: { form: 'awaiting', question } }
}

/**
 * 作答：awaiting → advancing，并把本次作答记入日志
 *
 * 校验三件事：题号一致（防答错题）、应答方一致（当前应答方约束）、选项在列。
 * 作答本身入日志（action = 'answer'），使整局可复算。
 */
export function answerQuestion(session: GameSession, answer: SessionAnswer): GameSession {
  if (session.status.form !== 'awaiting') {
    throw new SessionError('#/status/form', `当前无待答问题（形态 ${session.status.form}）`)
  }

  const question = session.status.question
  if (answer.questionId !== question.id) {
    throw new SessionError('#/answer/questionId', `题号不匹配：当前待答为 ${question.id}`)
  }
  if (answer.side !== question.responder) {
    throw new SessionError('#/answer/side', `应答方不符：该题须由 ${question.responder} 作答`)
  }
  if (question.options !== undefined && question.options.length > 0) {
    if (answer.optionId === undefined) {
      throw new SessionError('#/answer/optionId', '该问题带选项，必须给出 optionId')
    }
    if (!question.options.some((option) => option.id === answer.optionId)) {
      throw new SessionError('#/answer/optionId', `选项不在列：${answer.optionId}`)
    }
  } else if (answer.optionId !== undefined) {
    // 无选项问题不接受 optionId：否则会把无意义的选项写进日志
    throw new SessionError('#/answer/optionId', '该问题不带选项，请改用 value 作答')
  }

  const entry: SessionLogEntry = {
    turn: session.state.records.turn,
    phase: session.state.records.phase,
    side: answer.side,
    action: 'answer',
    rolls: [],
    outcome: succeed(question.rule, {
      questionId: question.id,
      kind: question.kind,
      optionId: answer.optionId ?? null,
      value: answer.value ?? null,
    }),
  }

  return {
    ...session,
    status: { form: 'advancing' },
    log: [...session.log, entry],
  }
}

/**
 * 终止会话：任意形态 → terminated（已终止则原样返回，保证幂等）
 *
 * @param reason `turnsExhausted` 回合用尽（5.0a）/ `earlyDecision` 提前决胜（5.0b）
 */
export function terminateSession(session: GameSession, reason: TerminationReason): GameSession {
  if (session.status.form === 'terminated') return session
  return { ...session, status: { form: 'terminated', reason } }
}

/**
 * 追加日志（强制动作与自动后果的入账通道）
 *
 * 与 askQuestion 的区别：本函数**只记账、不改形态**。
 * 规则强制发生、玩家无可选择的事项走这条路，永不进入待答。
 */
export function appendLog(session: GameSession, entry: SessionLogEntry): GameSession {
  return { ...session, log: [...session.log, entry] }
}

/* ────────────────────────────── 步骤推进 ────────────────────────────── */

/**
 * 一步推进的三种去向
 *
 * - `advanced`   已推进一步（其中的强制动作与自动后果已直接结算并入账）
 * - `question`   停下提问（须由当前应答方作答后才能继续）
 * - `terminated` 本步触发终止（回合用尽 / 提前决胜）
 */
export type SessionAdvanceKind = 'advanced' | 'question' | 'terminated'

/** 一步推进的结果 */
export interface SessionAdvance {
  kind: SessionAdvanceKind
  /** 推进后的会话（形态已与 kind 一致） */
  session: GameSession
}

/**
 * 步进函数：由命令层提供，负责「这一步具体做什么」
 *
 * 框架只负责形态守卫与一致性校验，不解释规则。
 */
export type SessionStepper = (session: GameSession) => SessionAdvance

/** 校验步进结果：自述类型必须与返回会话的形态一致（防「该问未问」「伪装待答」） */
function assertAdvanceConsistency(advance: SessionAdvance): SessionAdvance {
  const form = advance.session.status.form
  const expected: Record<SessionAdvanceKind, SessionForm> = {
    advanced: 'advancing',
    question: 'awaiting',
    terminated: 'terminated',
  }
  const want = expected[advance.kind]
  if (form !== want) {
    // 'advanced' 一律不许落到 awaiting / terminated（那两类各有其自述类型）
    throw new SessionError(
      '#/status/form',
      `步进结果不一致：自述 ${advance.kind} 应得形态 ${want}，实际 ${form}；` +
        '强制动作与自动后果不得伪装成待答，须经 appendLog 入账',
    )
  }
  return advance
}

/**
 * 推进一步（形态守卫 + 一致性校验）
 *
 * 守卫：created 须先开局；awaiting 须先作答；terminated 幂等返回（不再推进）。
 */
export function advanceSession(session: GameSession, stepper: SessionStepper): SessionAdvance {
  switch (session.status.form) {
    case 'created':
      throw new SessionError('#/status/form', '会话尚未开局（先 startSession 再推进）')
    case 'awaiting':
      throw new SessionError(
        '#/status/form',
        `有待答问题未答（当前应答方 ${session.status.question.responder}），须先作答`,
      )
    case 'terminated':
      // 已终止：幂等返回，不再推进
      return { kind: 'terminated', session }
    case 'advancing':
      break
  }
  return assertAdvanceConsistency(stepper(session))
}

/* ────────────────────────────── 序列化 ────────────────────────────── */

/** 存档信封：版本 + 会话本体（四形态皆可整体存档） */
export interface SessionSaveFile {
  /**
   * 存档**容器**格式版本（读档时校验，不匹配即拒）
   *
   * 只管「信封怎么装」；会话内部字段的版本由 `session.meta.schemaVersion` 表达。
   * 二者分工见 state-types 的 SessionMeta 注释。
   */
  saveVersion: number
  session: GameSession
}

/**
 * 序列化为 JSON 文本（会话本体不含函数/类实例，可直接 JSON 化）
 *
 * 两点约定：
 *   - 引擎保持确定性、不取系统时间，故形态迁移一律**不改** `meta.updatedAt`；
 *     写盘时间戳由调用方（存档层）在序列化前自行盖章。
 *   - JSON 会丢弃值为 `undefined` 的键；构造会话时请用 `null` 表示「无」
 *     （例如作答记录里 `optionId`/`value` 缺省写 null），否则往返后键会消失。
 */
export function serializeSession(session: GameSession): string {
  const file: SessionSaveFile = { saveVersion: SESSION_SAVE_VERSION, session }
  return JSON.stringify(file, null, 2)
}

/** 断言取到对象，否则以路径报错 */
function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionError(path, `期望对象，实际 ${Array.isArray(value) ? 'array' : typeof value}`)
  }
  return value as Record<string, unknown>
}

/** 断言字段为字符串 */
function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new SessionError(path, `期望字符串，实际 ${typeof value}`)
  return value
}

/** 断言字段为数字 */
function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SessionError(path, `期望有限数字，实际 ${typeof value}`)
  }
  return value
}

/** 断言字段为数组 */
function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SessionError(path, `期望数组，实际 ${typeof value}`)
  return value
}

/** 断言字段为非空字符串（空串会让「题号一致」之类的校验形同虚设） */
function requireNonEmptyString(value: unknown, path: string): string {
  const text = requireString(value, path)
  if (text === '') throw new SessionError(path, '不得为空字符串')
  return text
}

/** 断言字段为合法阵营（axis / soviet） */
function checkSide(value: unknown, path: string): Side {
  const side = requireString(value, path)
  if (side !== 'axis' && side !== 'soviet') throw new SessionError(path, `未知阵营：${side}`)
  return side
}

/**
 * 校验待答问题（提问与读档共用同一把尺子）
 *
 * 必填：id / rule / prompt 非空、responder 为合法阵营；
 * 带 options 时逐项校验——否则读档损坏（如 options 是字符串）会在作答时崩在数组方法上。
 */
function checkQuestion(value: unknown, path: string): void {
  const question = requireObject(value, path)
  requireNonEmptyString(question['id'], `${path}/id`)
  requireNonEmptyString(question['rule'], `${path}/rule`)
  requireNonEmptyString(question['prompt'], `${path}/prompt`)
  checkSide(question['responder'], `${path}/responder`)

  const options = question['options']
  if (options !== undefined) {
    const list = requireArray(options, `${path}/options`)
    list.forEach((raw, index) => {
      const option = requireObject(raw, `${path}/options/${index}`)
      requireNonEmptyString(option['id'], `${path}/options/${index}/id`)
      requireString(option['label'], `${path}/options/${index}/label`)
    })
  }
}

/** 校验日志条目（浅层：骨架 + 统一结果形状，B3） */
function checkLogEntry(value: unknown, path: string): void {
  const entry = requireObject(value, path)
  requireNumber(entry['turn'], `${path}/turn`)

  const phase = requireString(entry['phase'], `${path}/phase`)
  if (!(GAME_PHASES as readonly string[]).includes(phase)) {
    throw new SessionError(`${path}/phase`, `未知阶段：${phase}`)
  }
  checkSide(entry['side'], `${path}/side`)
  requireNonEmptyString(entry['action'], `${path}/action`)
  requireArray(entry['rolls'], `${path}/rolls`)

  const outcome = requireObject(entry['outcome'], `${path}/outcome`)
  const ok = outcome['ok']
  if (typeof ok !== 'boolean') {
    throw new SessionError(`${path}/outcome/ok`, `期望布尔，实际 ${typeof ok}`)
  }
  requireNonEmptyString(outcome['rule'], `${path}/outcome/rule`)
  if (ok) {
    requireObject(outcome['data'], `${path}/outcome/data`)
    requireArray(outcome['pending'], `${path}/outcome/pending`)
  } else {
    requireNonEmptyString(outcome['reason'], `${path}/outcome/reason`)
  }
}

/** 校验会话形态（含待答问题必填字段），返回收窄后的形态名 */
function checkStatus(status: unknown): SessionForm {
  const object = requireObject(status, '#/session/status')
  const form = requireString(object['form'], '#/session/status/form')
  if (!(SESSION_FORMS as readonly string[]).includes(form)) {
    throw new SessionError('#/session/status/form', `未知形态：${form}`)
  }
  if (form === 'awaiting') {
    checkQuestion(object['question'], '#/session/status/question')
  }
  if (form === 'terminated') {
    const reason = requireString(object['reason'], '#/session/status/reason')
    if (!(TERMINATION_REASONS as readonly string[]).includes(reason)) {
      throw new SessionError('#/session/status/reason', `未知终止原因：${reason}`)
    }
  }
  // 上面已校验 form 属于 SESSION_FORMS
  return form as SessionForm
}

/**
 * 从 JSON 文本读回会话
 *
 * 校验范围：存档信封（版本）＋会话级字段（meta / status / state 骨架 / log / rng）。
 * 深度状态字段（units / stacks / markers / records 明细）的结构校验由状态 schema 单元
 * 接入 §3.4 的 Zod 管线后补齐；本函数保证「会话能不能安全地用起来」这一层。
 */
export function deserializeSession(text: string): GameSession {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SessionError('#', `不是合法 JSON：${(error as Error).message}`)
  }

  const file = requireObject(parsed, '#')
  const saveVersion = requireNumber(file['saveVersion'], '#/saveVersion')
  if (saveVersion !== SESSION_SAVE_VERSION) {
    throw new SessionError(
      '#/saveVersion',
      `存档版本不匹配：期望 ${SESSION_SAVE_VERSION}，实际 ${saveVersion}`,
    )
  }

  const session = requireObject(file['session'], '#/session')

  // meta
  const meta = requireObject(session['meta'], '#/session/meta')
  requireString(meta['sessionId'], '#/session/meta/sessionId')
  requireString(meta['createdAt'], '#/session/meta/createdAt')
  requireString(meta['updatedAt'], '#/session/meta/updatedAt')
  requireNumber(meta['schemaVersion'], '#/session/meta/schemaVersion')

  // state：骨架（深度字段待状态 schema 单元）
  const state = requireObject(session['state'], '#/session/state')
  requireString(state['scenarioId'], '#/session/state/scenarioId')
  requireArray(state['units'], '#/session/state/units')
  requireArray(state['stacks'], '#/session/state/stacks')
  requireArray(state['markers'], '#/session/state/markers')
  const records = requireObject(state['records'], '#/session/state/records')
  requireNumber(records['turn'], '#/session/state/records/turn')
  const rng = requireObject(state['rng'], '#/session/state/rng')
  requireNumber(rng['seed'], '#/session/state/rng/seed')
  requireNumber(rng['state'], '#/session/state/rng/state')
  requireNumber(rng['drawCount'], '#/session/state/rng/drawCount')

  // log 与 status
  const log = requireArray(session['log'], '#/session/log')
  log.forEach((entry, index) => checkLogEntry(entry, `#/session/log/${index}`))
  checkStatus(session['status'])

  return session as unknown as GameSession
}
