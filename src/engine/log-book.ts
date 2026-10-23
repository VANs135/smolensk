import type { Side } from '@/data'

import {
  DERIVATION_KEY,
  derivationFromOutcomeData,
  formatDerivation,
  type Derivation,
} from './derivation'
import type { PendingEffect } from './result-types'
import { createRngState, RNG_ALGORITHM, rollDice, verifyRngState } from './rng'
import type { DiceRoll, GamePhase, GameSession, SessionLogEntry } from './state-types'

/**
 * 结算日志数据层（W7 D2）
 *
 * ## 它是什么
 *   把会话里那串「原始日志条目」（`session.log`：回合 / 阶段 / 阵营 / 动作 / 掷骰 / 结算结果）
 *   加工成**结构化、可检索、可展开、与规则编号对齐**的日志手册，并支持**固定种子重放复算**。
 *
 * ## 四件事怎么落
 *   ① **结构化**：每条日志规范化成 `LogBookEntry`（规则号、成败、掷骰明细、待处理项、
 *      可展开的明细行、一行可检索摘要）；
 *   ② **可检索**：`queryLogBook()` 按回合 / 阶段 / 阵营 / 动作 / **规则号** / 关键词 / 只看失败过滤；
 *      另给 `rules`（规则号索引）、`actions`、`turns`、`stats` 四张索引表；
 *   ③ **可展开**：`details` 把 `outcome.data`（或失败原因）摊平成键值行，界面点开即见全文；
 *      待处理项（9.10 选项 / 战后推进 / DG / 进击）单列成行；
 *   ④ **与规则编号对齐**：每条日志都带 `outcome.rule`（引擎统一结果形状的既有字段），
 *      规则号索引把「本局哪些规则动过、各多少次」列出来，可直接反向检索规则书。
 *
 * ## 重放复算（`replaySessionLog`）
 *   固定种子下，掷骰序列唯一确定 ⇒ 从 `rng.seed` 起重放日志里的每一次掷骰，逐条比对骰面：
 *     - 一路吻合 ⇒ 报告 `ok`，并给出每条日志的**掷骰游标**（`drawCountBefore/After`）便于定位；
 *     - 出现分歧 ⇒ 报出**首个分歧**（第几条、什么动作、依据哪条规则、当时游标、日志值 vs 重放值）。
 *   另核对三件事：掷骰算法标识、`seed+游标` 能否重推出存档内部状态（`verifyRngState`）、
 *   重放到末尾的状态与存档是否一致。
 *
 * ## 纪律
 *   本模块是**纯函数**：会话进、结论出，不改入参、不掷暗骰、不取时间；界面只消费它的输出。
 */

/* ────────────────────────────── 结构化：日志条目 ────────────────────────────── */

/** 可展开的明细行（值已渲染为字符串，界面直接显示） */
export interface LogDetailRow {
  label: string
  value: string
}

/** 掷骰明细（骰面 + 合计 + 颗数） */
export interface LogRollRow {
  count: number
  faces: readonly number[]
  total: number
}

/** 结构化后的**一条**结算日志 */
export interface LogBookEntry {
  /** 日志下标（0 起；与 `session.log` 同序，用作稳定键） */
  index: number
  turn: number
  phase: GamePhase
  side: Side
  /** 动作标签（由写入方给出，如 `weather` / `initiative` / `phase` / `answer` / `terminate`） */
  action: string
  /** 规则编号（与规则书对齐；取自 `outcome.rule`） */
  rule: string
  /** 是否结算成功 */
  ok: boolean
  /** 失败原因（`ok === false` 时给出） */
  reason: string | null
  /** 掷骰明细（无掷骰为空数组） */
  rolls: readonly LogRollRow[]
  /** 本条的**掷骰颗数**（不含未被记录的内部抽取；PRNG 游标由重放给出） */
  diceCount: number
  /** 待处理项（`outcome.pending`：9.10 选项 / 战后推进 / DG / 进击） */
  pending: readonly PendingEffect[]
  /** 可展开的明细行（成功 ⇒ `outcome.data` 摊平；失败 ⇒ 一行「原因」） */
  details: readonly LogDetailRow[]
  /**
   * 结算复核过程（W7 C11）
   *
   * 写入方把复核过程放在 `outcome.data.derivation`（见 `engine/derivation.ts`）；
   * 有则单独渲染（骰点 / 修正项与来源 / 合计 / 查表 / 结果），不再当普通明细 JSON 摊平。
   */
  derivation: Derivation | null
  /** 复核过程的一行文字（无复核过程为 null；便于检索与悬浮提示） */
  formula: string | null
  /** 一行摘要（含规则号与全部明细值，供关键词检索） */
  summary: string
}

/** 把任意值渲染成可读字符串（数组用顿号连接，对象走 JSON，空值记「—」） */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value === '' ? '—' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '（空）'
    return value.map((item) => renderValue(item)).join('、')
  }
  try {
    return JSON.stringify(value) ?? '—'
  } catch {
    return '（无法渲染）'
  }
}

/** 把 `outcome` 摊平成明细行（成功看 data，失败看 reason；复核过程另走 `derivation` 字段） */
function detailRowsOf(entry: SessionLogEntry, derivationRendered: boolean): LogDetailRow[] {
  const rows: LogDetailRow[] = []
  const outcome = entry.outcome
  if (outcome.ok) {
    for (const [key, value] of Object.entries(outcome.data)) {
      // 复核过程已单独渲染（见 LogBookEntry.derivation），此处不再当普通明细摊平；
      // 但若它形状不认识（认不出 ⇒ derivation 为 null），仍照常摊平 —— 不把数据藏起来
      if (key === DERIVATION_KEY && derivationRendered) continue
      rows.push({ label: key, value: renderValue(value) })
    }
    for (const item of outcome.pending) {
      rows.push({
        label: `待处理（${item.kind}）`,
        value: `${item.rule}｜单位 ${item.unitIds.length} 个${item.note === undefined ? '' : `｜${item.note}`}`,
      })
    }
    if (rows.length === 0) rows.push({ label: '结算内容', value: '（无附加数据）' })
  } else {
    rows.push({ label: '原因码', value: outcome.reason })
  }
  return rows
}

/** 一条日志 → 结构化记录 */
export function toLogBookEntry(entry: SessionLogEntry, index: number): LogBookEntry {
  const rolls: LogRollRow[] = entry.rolls.map((roll) => ({
    count: roll.count,
    faces: [...roll.faces],
    total: roll.total,
  }))
  const diceCount = rolls.reduce((sum, roll) => sum + roll.count, 0)
  const derivation = entry.outcome.ok ? derivationFromOutcomeData(entry.outcome.data) : null
  const details = detailRowsOf(entry, derivation !== null)
  const formula = derivation === null ? null : formatDerivation(derivation)
  const rollText = rolls.length === 0 ? null : rolls.map((roll) => roll.faces.join('+')).join(' / ')

  return {
    index,
    turn: entry.turn,
    phase: entry.phase,
    side: entry.side,
    action: entry.action,
    rule: entry.outcome.rule,
    ok: entry.outcome.ok,
    reason: entry.outcome.ok ? null : entry.outcome.reason,
    rolls,
    diceCount,
    pending: entry.outcome.ok ? [...entry.outcome.pending] : [],
    details,
    derivation,
    formula,
    summary: [
      entry.action,
      `规则 ${entry.outcome.rule}`,
      rollText === null ? null : `掷骰 ${rollText}`,
      entry.outcome.ok ? '已结算' : `被拒 ${entry.outcome.reason}`,
      ...details.map((row) => `${row.label}=${row.value}`),
      // 复核过程进摘要 ⇒ 关键词也能命中的计算过程/结果码（如 CRT9.9 / AL1）
      formula,
    ]
      .filter((part): part is string => part !== null)
      .join('｜'),
  }
}

/* ────────────────────────────── 索引与统计 ────────────────────────────── */

/** 规则号索引的一条（与规则编号对齐） */
export interface LogRuleIndexEntry {
  rule: string
  /** 出现次数 */
  count: number
  /** 首次出现的日志下标 */
  firstIndex: number
  /** 涉及该规则的日志下标（升序） */
  indexes: readonly number[]
}

/** 日志统计 */
export interface LogBookStats {
  total: number
  ok: number
  failed: number
  /** 记录在案的掷骰颗数合计（不含未被记录的内部抽取） */
  diceCount: number
  bySide: Record<Side, number>
  byPhase: readonly { phase: GamePhase; count: number }[]
}

/** 结算日志手册（结构化结果 + 四张索引表） */
export interface LogBook {
  entries: readonly LogBookEntry[]
  /** 规则号索引（按规则号字符串升序） */
  rules: readonly LogRuleIndexEntry[]
  /** 出现过的动作标签（升序去重） */
  actions: readonly string[]
  /** 出现过的回合号（升序） */
  turns: readonly number[]
  stats: LogBookStats
}

/** 由**日志条目串**造日志手册（结构化 + 索引 + 统计）；空数组 ⇒ 空手册 */
export function buildLogBook(log: readonly SessionLogEntry[]): LogBook {
  const entries = log.map((entry, index) => toLogBookEntry(entry, index))

  const ruleMap = new Map<string, number[]>()
  const actionSet = new Set<string>()
  const turnSet = new Set<number>()
  const phaseCount = new Map<GamePhase, number>()
  const stats: LogBookStats = {
    total: entries.length,
    ok: 0,
    failed: 0,
    diceCount: 0,
    bySide: { axis: 0, soviet: 0 },
    byPhase: [],
  }

  for (const entry of entries) {
    const list = ruleMap.get(entry.rule)
    if (list === undefined) ruleMap.set(entry.rule, [entry.index])
    else list.push(entry.index)

    actionSet.add(entry.action)
    turnSet.add(entry.turn)
    phaseCount.set(entry.phase, (phaseCount.get(entry.phase) ?? 0) + 1)
    if (entry.ok) stats.ok += 1
    else stats.failed += 1
    stats.diceCount += entry.diceCount
    stats.bySide[entry.side] += 1
  }

  const rules: LogRuleIndexEntry[] = [...ruleMap.entries()]
    .map(([rule, indexes]) => ({
      rule,
      count: indexes.length,
      firstIndex: indexes[0] ?? 0,
      indexes,
    }))
    .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0))

  stats.byPhase = [...phaseCount.entries()]
    .map(([phase, count]) => ({ phase, count }))
    // 阶段按 2.2 流程表顺序展示：这里按阶段名字典序即可复现（同一会话的阶段集合很小）
    .sort((a, b) => (a.phase < b.phase ? -1 : a.phase > b.phase ? 1 : 0))

  return {
    entries,
    rules,
    actions: [...actionSet].sort(),
    turns: [...turnSet].sort((a, b) => a - b),
    stats,
  }
}

/* ────────────────────────────── 检索 ────────────────────────────── */

/** 检索条件（全部可选；同时给出即「与」关系） */
export interface LogQuery {
  /** 回合号（精确） */
  turn?: number | null
  /** 阶段（精确） */
  phase?: GamePhase | null
  /** 阵营（精确） */
  side?: Side | null
  /** 动作标签（精确） */
  action?: string | null
  /** 规则号（精确；与规则编号对齐的入口） */
  rule?: string | null
  /** 只看失败（`outcome.ok === false`） */
  onlyFailed?: boolean
  /** 关键词（在摘要里做不区分大小写的子串匹配） */
  text?: string | null
}

/** 按条件检索日志（空条件 ⇒ 全部；顺序与 `session.log` 一致） */
export function queryLogBook(book: LogBook, query: LogQuery = {}): readonly LogBookEntry[] {
  const text = query.text?.trim().toLowerCase() ?? ''
  return book.entries.filter((entry) => {
    if (query.turn != null && entry.turn !== query.turn) return false
    if (query.phase != null && entry.phase !== query.phase) return false
    if (query.side != null && entry.side !== query.side) return false
    if (query.action != null && entry.action !== query.action) return false
    if (query.rule != null && entry.rule !== query.rule) return false
    if (query.onlyFailed === true && entry.ok) return false
    if (text !== '' && !entry.summary.toLowerCase().includes(text)) return false
    return true
  })
}

/* ────────────────────────────── 重放复算 ────────────────────────────── */

/** 掷骰分歧（日志记的 vs 从种子重放出来的） */
export interface ReplayDivergence {
  /** 第几条日志（下标） */
  index: number
  turn: number
  action: string
  rule: string
  /** 该次掷骰发生前的掷骰游标 */
  drawCountBefore: number
  /** 日志记录的掷骰 */
  expected: DiceRoll
  /** 从种子重放得到的掷骰 */
  actual: DiceRoll
}

/** 一条日志的掷骰游标区间（复算定位用） */
export interface ReplayCursor {
  index: number
  drawCountBefore: number
  drawCountAfter: number
}

/** 重放复算报告 */
export interface ReplayReport {
  /** 使用的掷骰算法标识（`rng.ts` 唯一实现） */
  algorithm: string
  /** 重放起点种子 */
  seed: number
  /** 日志条数 */
  logEntries: number
  /** 重放掉的骰子颗数（= 日志里记录在案的颗数） */
  diceCount: number
  /** 存档的「种子—游标—内部状态」是否自洽（`verifyRngState`） */
  rngSelfConsistent: boolean
  /** 重放到末尾的状态是否与存档一致（seed / state / drawCount 三者） */
  stateMatches: boolean
  /** 首个分歧（null = 全程吻合） */
  firstDivergence: ReplayDivergence | null
  /** 每条日志的游标区间 */
  cursors: readonly ReplayCursor[]
  /** 总判定：自洽 ∧ 状态一致 ∧ 无分歧 */
  ok: boolean
  /** 面向人的结论 */
  detail: string
}

/** 两次掷骰是否完全一致（颗数 / 骰面 / 合计） */
function sameRoll(a: DiceRoll, b: DiceRoll): boolean {
  if (a.count !== b.count || a.total !== b.total) return false
  if (a.faces.length !== b.faces.length) return false
  return a.faces.every((face, index) => face === b.faces[index])
}

/**
 * 固定种子重放复算
 *
 * 从 `session.state.rng.seed` 开始，按日志顺序重放每一次掷骰并逐条比对：
 * 吻合 ⇒ `ok`；出现分歧 ⇒ 报出首个分歧（含当时的掷骰游标，便于直接定位到结算点）。
 * 同时核对存档的种子—游标—内部状态自洽，以及重放终点与存档状态是否一致。
 */
export function replaySessionLog(session: GameSession): ReplayReport {
  const recorded = session.state.rng
  let rng = createRngState(recorded.seed)
  const cursors: ReplayCursor[] = []
  let divergence: ReplayDivergence | null = null
  let diceCount = 0

  for (let index = 0; index < session.log.length; index += 1) {
    const entry = session.log[index]
    if (entry === undefined) continue
    const drawCountBefore = rng.drawCount
    for (const logged of entry.rolls) {
      const rollCursor = rng.drawCount
      // 以**骰面长度**为重放依据：即便日志里的 count 与 faces 不一致（存档被手改过），
      // 也能把这一条作为「分歧」如实报出，而不是崩在掷骰数量校验上
      const count = logged.faces.length
      const draw =
        count > 0
          ? rollDice(rng, count)
          : { rng, value: { count: 0, faces: [], total: 0 } satisfies DiceRoll }
      rng = draw.rng
      diceCount += count
      if (divergence === null && !sameRoll(draw.value, logged)) {
        divergence = {
          index,
          turn: entry.turn,
          action: entry.action,
          rule: entry.outcome.rule,
          drawCountBefore: rollCursor,
          expected: logged,
          actual: draw.value,
        }
      }
    }
    cursors.push({ index, drawCountBefore, drawCountAfter: rng.drawCount })
  }

  const rngSelfConsistent = verifyRngState(recorded)
  const stateMatches =
    rng.seed === recorded.seed &&
    rng.state === recorded.state &&
    rng.drawCount === recorded.drawCount
  const ok = rngSelfConsistent && stateMatches && divergence === null

  const detail = ok
    ? `重放复算通过（算法 ${RNG_ALGORITHM}，种子 ${recorded.seed}）：${session.log.length} 条日志、${diceCount} 颗骰全部吻合，` +
      `终点游标 ${rng.drawCount} 与存档一致`
    : [
        `重放复算未通过（算法 ${RNG_ALGORITHM}，种子 ${recorded.seed}）`,
        rngSelfConsistent ? null : '存档的种子—游标—内部状态不自洽（verifyRngState 失败）',
        stateMatches
          ? null
          : `重放终点与存档不一致：游标 ${rng.drawCount} ≠ ${recorded.drawCount}，内部状态 ${rng.state} ≠ ${recorded.state}`,
        divergence === null
          ? null
          : `首个分歧在第 ${divergence.index + 1} 条（T${divergence.turn} ${divergence.action}，规则 ${divergence.rule}，` +
            `掷骰游标 ${divergence.drawCountBefore}）：日志 ${divergence.expected.faces.join('+')} ≠ 重放 ${divergence.actual.faces.join('+')}`,
      ]
        .filter((part): part is string => part !== null)
        .join('；')

  return {
    algorithm: RNG_ALGORITHM,
    seed: recorded.seed,
    logEntries: session.log.length,
    diceCount,
    rngSelfConsistent,
    stateMatches,
    firstDivergence: divergence,
    cursors,
    ok,
    detail,
  }
}
