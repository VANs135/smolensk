import type { HexRef, Side } from '@/data'

import { fail, type RuleFailure, type RuleRef } from '../result-types'
import type { GamePhase } from '../state-types'
import { actionNeedsFuel, computeFuelCost, requiresFuelToSpendMp, type FuelMethod } from './fuel'
import {
  baseOrientation,
  canConvertGauge,
  canEngineer,
  canUseTransport,
  hasMarker,
  isInCombatMode,
  resolveModeStats,
  type BaseMode,
  type ModeState,
  type MovementSegmentPhase,
} from './modes'
import { RAIL_CONVERSION_MAX_PER_PHASE, STACKING_LIMIT_RE } from './movement'
import { getRailCap } from './rail-cap'
import type { MobilityType } from './terrain'

/**
 * 合法性校验层（B21）——所有动作的统一前置校验
 *
 * 设计口径（照 `ocs-rules-v43` 的**第一条心智模型**：「合法性来自 SOP 槽位，不是来自意图。
 * 把 SOP 建成一张『槽位→许可动作集合』的表，比散落的 if 判断可靠得多」）：
 *   一次调用 `checkLegality(request)` 即可拿到「能不能做 / 为什么不能 / 做完还欠什么」。
 *
 * ## 一、七类约束族（用户点名，全部收在本层）
 *
 * | 族 | 内容 | 条文 |
 * |---|---|---|
 * | `timing` | SOP 槽位许可动作 + 行动者身份 | 2.2 流程表、6.0/6.3a/7.0a/11.0a |
 * | `mode` | 该模式下能否做该动作 | 5.5a/5.5b/5.6a/5.7/5.8/5.9/5.10b/5.10e、8.1 |
 * | `zoc` | 敌方 ZOC 内的禁止动作（含能否被抵消） | 4.5 / 4.5a A–K / 4.5b |
 * | `fuel` | 是否需要燃料、编队法来源是否同源 | 12.5a/12.5b/12.5c-A |
 * | `stacking` | 堆叠上限与**阶段末**义务（4.8a：移动中可暂时超堆叠） | 4.8 / 4.8a / 4.8c |
 * | `allowance` | 额度（铁路容量、每阶段轨距转换上限） | 专规 1.2 / 13.3 / 13.3g |
 * | `formation` | 编队同源（同一 HQ 投递或同一补给站拖取） | 12.5c-A |
 *
 * ## 二、三种结论（不是简单的「能/不能」）
 *   - **违规（violations）**：此刻不允许，动作被否决；
 *   - **提示（warnings）**：允许，但有后果须让玩家看见（如 4.5a-A 轮式进入敌方 ZOC 后必须停止）；
 *   - **义务（obligations）**：允许，但稍后（环节/阶段结束时）必须结清——
 *     典型是 4.8a 超堆叠：**移动过程中可以暂时超堆叠**，只在「任何环节或阶段结束时」才要求 ≤10 RE，
 *     故它不是逐步禁令，而是阶段末义务（由 `stackingObligations()` 结算）。
 *
 * ## 三、单一来源原则（本层**不重复实现**任何规则）
 *   模式 → modes.ts｜燃料 → fuel.ts｜堆叠上限 → movement.ts｜额度 → rail-cap.ts / rules-constants.json。
 *   本层只做「取请求 → 依次问各家 → 收成一份结论」。
 */

/* ────────────────────────────── 词表 ────────────────────────────── */

/**
 * 可被校验的动作（同时是 4.5a A–K 与 SOP 段内容的索引键）
 *
 * 刻意保持「规则书里的动作名」粒度，而不是 UI 操作粒度：一个 UI 操作可能触发多个动作校验。
 */
export type ActionKind =
  /** 6.0 地面移动 */
  | 'move'
  /** 8.0 突袭 */
  | 'overrun'
  /** 9.0 常规战斗（含 9.1 宣告） */
  | 'attack'
  /** 10.0 轰炸（炮兵 / 空中 / 舰炮，见 barrageSource） */
  | 'barrage'
  /** 12.8e 突围（C 段最先行） */
  | 'breakout'
  /** 5.4 主动模式切换 */
  | 'modeChange'
  /** 5.7b 释放预备 */
  | 'reserveRelease'
  /** 13.3c 铁路运输（literal，占用铁路容量） */
  | 'railTransport'
  /** 13.3 沿铁路的追溯补给（4.5a-D） */
  | 'railTraceSupply'
  /** 13.3f/g 轨距转换 */
  | 'railConversion'
  /** 13.2f 装载 / 卸载 */
  | 'loadUnload'
  /** 13.8 工程功能 */
  | 'engineer'
  /** 16.0 修建环形工事 */
  | 'buildHedgehog'
  /** 12.3a/b 追溯补给（拖取与投递） */
  | 'supplyTrace'
  /** 12.3b HQ 投递 */
  | 'hqThrow'
  /** 12.5 加油 */
  | 'fuel'
  /** 14.x 空中任务（非轰炸类） */
  | 'airMission'
  /** 15.1 整备 */
  | 'refit'
  /** 19.x 港口追溯补给（4.5a-F；本作无海运，保留以完整覆盖 A–K） */
  | 'portTraceSupply'
  /** 19.x 港口海运（4.5a-G） */
  | 'portSeaCap'
  /** 13.5 重建（增援阶段） */
  | 'rebuild'
  /** 13.9 合并（增援阶段） */
  | 'consolidate'
  /** 1.6a / 13.6 到达表执行与增援投放（增援阶段） */
  | 'arrival'
  /** 20.0a 创建拆分单位（开始移动 / 战后推进 / 战后撤退三个时机） */
  | 'breakdown'
  /** 2.2 末段 H 清理阶段的通用自动清理（摘 DG/进击/燃料标记 + 移除敌方运输破坏标记） */
  | 'cleanUp'

/** 约束族 */
export type LegalityFamily =
  'timing' | 'mode' | 'zoc' | 'fuel' | 'stacking' | 'allowance' | 'formation'

/** 固定检查顺序（结论里 checked 恒按此序，便于测试与界面标注） */
export const LEGALITY_FAMILIES: readonly LegalityFamily[] = [
  'timing',
  'mode',
  'zoc',
  'fuel',
  'stacking',
  'allowance',
  'formation',
]

/* ────────────────────────────── 请求 ────────────────────────────── */

/** 参与动作的单位（最小视图；字段名照 state-types 与数据层） */
export interface LegalityUnit {
  id: string
  /** 是否战斗单位（4.5b 抵消 ZOC 要求「友方战斗单位」；4.8 堆叠上限只计战斗单位） */
  isCombat: boolean
  /** 是否可攻击（4.4/3.2b） */
  attackCapable: boolean
  /** 机动类型（3.1a） */
  mobility: MobilityType
  /** 模式状态（5.x） */
  mode: ModeState
  /** 团级当量（4.6） */
  re: number
  /** 朝向那一面的印值（用于 5.x 的数值改写） */
  raw: { attack: number; ar: number; ma: number; barrage?: number }
  /** 是否具备工程能力（5.10e / 13.8a）；未给出按 false 处理 */
  engineerCapable?: boolean
  /**
   * 13.3g：是否为**铁路修理单位**；未给出按 false 处理
   *
   * 铁路修理单位有两条例外：5.6a/5.5a 的「须移动模式」不适用（13.3g-B：可在**战斗模式**下铁路移动），
   * 且只有它能做轨距转换（13.3g）。深度校验见 `rail.ts`，本层只做模式族的粗筛。
   */
  railRepair?: boolean
  /** 非战斗单位类型（4.8 的「每格 1 港口 + 1 空军基地 + 1 环形工事」用） */
  noncombatKind?: string | null
}

/** 额度占用事实（额度上限由本层按 kind 从数据层取，避免调用方各写一份） */
export interface AllowanceUsage {
  kind: 'railCap' | 'railConversion' | 'custom'
  /** 本回合 / 本阶段已用（含本次之前的占用） */
  used: number
  /** 本次动作需要 */
  required: number
  /** kind='custom' 时必须给出上限 */
  limit?: number
}

/** 编队同源事实（12.5c-A） */
export interface FormationFacts {
  /**
   * 参与单位是否**共用同一来源**（同一 HQ 投递，或同一补给站直接拖取）
   *
   * 12.5c-A：「如果编队中所有需要燃料补给的单位，没有通过同一个 HQ 来投递补给，
   *          或者没有通过同一个补给站来直接拖取补给，则只能对不能从通用来源获得补给的
   *          单位使用单单位法。」
   */
  sameSource: boolean
  /** 参与单位数（用于提示可改用单单位法） */
  unitCount?: number
}

/** 目标格事实（堆叠与 4.8c 用） */
export interface TargetHexFacts {
  hex: HexRef
  /** 格内战斗单位 RE 合计（不含本次移动的单位） */
  friendlyCombatRe: number
  /** 格内敌方战斗单位数（4.8c：有敌方战斗单位则不可进入） */
  enemyCombatUnits: number
  /** 格内敌方非战斗单位/飞机/舰船数（4.8c-A：可进入并按 9.14 结算） */
  enemyNonCombatUnits?: number
  /** 格内已有的港口 / 空军基地 / 环形工事数（4.8：各自至多 1） */
  ports?: number
  airBases?: number
  hedgehogs?: number
}

/** 合法性校验请求 */
export interface LegalityRequest {
  action: ActionKind
  /** 执行方 */
  side: Side
  /** 当前阶段（2.2 流程表 A–H） */
  phase: GamePhase
  /** 当前阶段玩家（2.2） */
  activeSide: Side
  /** 当前日期（ISO，专规时点与铁路容量用） */
  date: string
  /** 参与单位（整格动作可省略） */
  units?: readonly LegalityUnit[]
  /** 目标格事实 */
  target?: TargetHexFacts
  /** 所在格是否处于**未被 4.5b 抵消**的敌方 ZOC */
  inEnemyZoc?: boolean
  /** 模式切换的目标模式（5.4；action='modeChange' 时必给） */
  modeTarget?: BaseMode
  /** 轰炸来源（10.1a：炮兵 / 空中 / 舰炮；SOP 各段的许可不同） */
  barrageSource?: 'artillery' | 'air' | 'ship'
  /** 额度占用 */
  allowance?: AllowanceUsage
  /** 编队同源事实（加油为编队法时必给） */
  formation?: FormationFacts
  /** 加油方法（12.5c） */
  fuelMethod?: FuelMethod
  /** 本次动作所需燃料是否已付清（12.5a/b） */
  fuelPaid?: boolean
  /** 本条移动所耗 MP（预留给调用方展示；不参与判定） */
  mpSpent?: number
}

/* ────────────────────────────── 结论 ────────────────────────────── */

/** 未通过项 */
export interface LegalityViolation {
  family: LegalityFamily
  rule: RuleRef
  /** 机器可读原因码 */
  reason: string
  /** 面向玩家的说明 */
  detail?: string
}

/** 非阻止性提示（允许动作，但玩家应知悉后果） */
export interface LegalityWarning {
  family: LegalityFamily
  rule: RuleRef
  reason: string
  detail?: string
}

/** 动作通过后仍需在稍后结算的义务 */
export interface LegalityObligation {
  family: LegalityFamily
  rule: RuleRef
  reason: string
  detail?: string
}

/** 三种结论的公共部分 */
interface LegalityCommon {
  /** 已检查的约束族（恒按 LEGALITY_FAMILIES 顺序） */
  checked: readonly LegalityFamily[]
  warnings: readonly LegalityWarning[]
  obligations: readonly LegalityObligation[]
}

/** 合法性结论（判别联合，以 ok 收窄） */
export type LegalityVerdict =
  | ({ ok: true } & LegalityCommon)
  | ({ ok: false; violations: readonly LegalityViolation[] } & LegalityCommon)

/* ────────────────────────────── 时机表（2.2 SOP） ────────────────────────────── */

/**
 * SOP 槽位 → 许可动作（2.2 流程表原文段落照录，见工程库 charts.json `tables.sop`）
 *
 * | 段 | 原文 | 许可动作 |
 * |---|---|---|
 * | A Aircraft Refit | 「A. Aircraft Refit Phase」 | 整备 15.1 |
 * | B Reinforcement | 「B. Reinforcement Phase」 | 增援放置（时机由 13.6 定义，本层不判） |
 * | C Movement | 「C. Movement Phase: Breakout / Mode & Movement / Barrage (air & ship only)」 | 突围 / 模式与移动 / **仅空中与舰炮**轰炸 |
 * | D Supply | 「D. Supply Phase」 | 追溯判定（12.6）/ 吃图上补给 12.6c / 断补标记与损耗 12.8（**无燃料**，见下） |
 * | E Reaction | 「E. Reaction Phase: Movement / Barrage」 | 移动（限非行动方已释放预备 7.0a）/ 轰炸 |
 * | F Combat | 「F. Combat Phase: Barrage (artillery only) / Combat」 | **仅炮兵**轰炸 / 常规战斗 |
 * | G Exploitation | 「G. Exploitation Phase: Movement / Barrage / Combat」 | 移动 / 轰炸 / 战斗 |
 * | H Clean Up | 「H. Clean Up Phase」 | 全自动，无玩家动作 |
 *
 * 注意两处**同一动作不同段许可范围不同**，必须靠 `barrageSource` 区分：
 * C 段只允许空中与舰炮轰炸，F 段只允许炮兵轰炸。
 *
 * ★ **燃料不在本表任何一段**（用户 2026-09-19 口径）：2.2 的段名里没有它，12.5c 把付款绑在
 *   「发生燃料消耗的**任何阶段**」的消耗时刻 ⇒ 它的"时机"由 `fuel.ts` 定义，故列在
 *   `TIMING_DEFERRED_ACTIONS`（本表只登记"段名里写出的动作族"）。
 */
export const ACTIONS_BY_PHASE: Record<GamePhase, readonly ActionKind[]> = {
  // Pre-Turn 只有天气判定与先手判定（引擎自动 + 胜者选择，无地面/空中动作）
  preTurn: [],
  aircraftRefit: ['refit'],
  // B 增援：到达表投放（13.6 / 2.1 / 3.1）、重建（13.5a）、合并（13.9）
  reinforcement: ['arrival', 'rebuild', 'consolidate'],
  movement: [
    'breakout',
    'modeChange',
    'move',
    'overrun',
    'barrage',
    'railTransport',
    'railConversion',
    'loadUnload',
    'engineer',
    'buildHedgehog',
    // 20.0a：多军力单位在**开始移动**时可创建拆分单位
    'breakdown',
  ],
  supply: ['supplyTrace', 'hqThrow'],
  // 7.0 首句「反应阶段是非阶段玩家可利用移动、**突袭**和轰炸打乱敌方计划的机会」+
  // 7.0b「反应阶段中，轰炸和突袭的结算照常」⇒ 反应段也允许突袭（8.0「各个移动环节」）
  reaction: ['reserveRelease', 'move', 'overrun', 'barrage'],
  // F 战斗：20.0a 的「战后推进 / 战后撤退」同属战斗结算，故允许创建拆分单位
  combat: ['barrage', 'attack', 'breakdown'],
  exploitation: ['reserveRelease', 'move', 'overrun', 'barrage', 'attack', 'breakdown'],
  // H 清理：2.2 末段的**通用自动清理**（摘 DG/进击/燃料标记 + 移除敌方运输破坏标记）
  cleanUp: ['cleanUp'],
  // Turn End 只推进回合标记（2.2）
  turnEnd: [],
}

/**
 * 时机表**未覆盖**的动作（其时机由专门模块定义，本层不臆造）
 *
 * - `airMission`：非轰炸类空中任务（空运 14.9 / 空投 14.10 / 扫荡 14.6…）的时机散在 14.x，
 *   且受天气与 Active/Inactive 约束，不在 SOP 段文字里枚举；
 * - `railTraceSupply` / `portTraceSupply` / `portSeaCap`：属铁路与港口子系统（13.3 / 19.0）的时机；
 * - `fuel`：**支付燃料**的时机由 12.5c 定义 —— 「在发生燃料消耗的**任何阶段**，单位都应在燃料消耗时支付」
 *   ⇒ 只在 C/E/G 三段的**移动环节**当场付（12.5a/12.5f：开拔与离开入场格前须已付）。
 *   用户 2026-09-19 口径：「补给阶段有燃料环节……燃料环节不应该存在，未加油单位是在移动前加油」
 *   ⇒ D 段（12.6 检定 / 12.10e 恢复）**不含**燃料；此处的"跳过"正是"段名没列它、时机另有出处"。
 *
 * 这些动作在时机族里**跳过**（既不判合法也不判非法），其余族照常校验。
 * 跳过不等于没人管：`fuel` 的闸门在 store 的 `ACTION_GATES`（`supply.fuel`，只挂 C/E/G 的移动环节），
 * 由 `sop-segments` 的 `OPERATION_TIMINGS` 与其交叉对齐。
 *
 * 注：`rebuild` 已按 13.5 / 13.9 归入 **B 增援段**（原先因「时机未核对」被列为跳过，现已核到条文）。
 */
export const TIMING_DEFERRED_ACTIONS: readonly ActionKind[] = [
  'airMission',
  'railTraceSupply',
  'portTraceSupply',
  'portSeaCap',
  'fuel',
]

/** 各段允许的轰炸来源（SOP 原文：C 段 air & ship only、F 段 artillery only） */
export const BARRAGE_SOURCES_BY_PHASE: Partial<Record<GamePhase, readonly string[]>> = {
  movement: ['air', 'ship'],
  reaction: ['artillery', 'air', 'ship'],
  combat: ['artillery'],
  exploitation: ['artillery', 'air', 'ship'],
}

/* ────────────────────────────── 4.5a 敌方 ZOC 内禁止的动作（A–K） ────────────────────────────── */

/** 4.5a 清单项 */
export interface ZocForbiddenItem {
  /** 清单字母（照原文） */
  item: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K'
  /** 原文动作名 */
  text: string
  /** 能否被 4.5b 抵消（原文带 <Negation> 的项） */
  negatable: boolean
  /** 由哪一族执行（I/J 属模式切换，由 mode 族判，避免重复报错） */
  family: 'zoc' | 'mode'
  /** 仅在这些动作上成立（留空表示「该动作全部形态都禁止」） */
  appliesWhen?: Partial<Record<'moveMobility' | 'modeTarget', string>>
}

/**
 * 4.5a：敌方 ZOC 内禁止的动作清单（原文 A–K，逐条照录）
 *
 * 「以下动作不能在敌方 ZOC 中执行。但是，标记为 <Negation> 的动作，在 ZOC 被抵消 (4.5b) 后
 * 就可以执行；其他动作即使 ZOC 被抵消也无法执行。」
 */
export const ZOC_FORBIDDEN: readonly (ZocForbiddenItem & { actions: readonly ActionKind[] })[] = [
  {
    item: 'A',
    text: 'Truck Movement 轮式单位移动',
    negatable: true,
    family: 'zoc',
    actions: ['move'],
    // 4.5a-A：进入敌方 ZOC 的**轮式 MP 单位**必须停止或突袭（徒步/履带不受影响）
    appliesWhen: { moveMobility: 'truck' },
  },
  {
    item: 'B',
    text: 'Supply Lines 补给线',
    negatable: true,
    family: 'zoc',
    actions: ['supplyTrace', 'hqThrow'],
  },
  {
    item: 'C',
    text: 'Rail Transport - Literal 铁路运输（占用容量）',
    negatable: false,
    family: 'zoc',
    actions: ['railTransport'],
  },
  {
    item: 'D',
    text: 'Rail Transport - Trace Supply 沿铁路追溯补给',
    negatable: true,
    family: 'zoc',
    actions: ['railTraceSupply'],
  },
  {
    item: 'E',
    text: 'Rail Conversion operations 轨距转换',
    negatable: false,
    family: 'zoc',
    actions: ['railConversion'],
  },
  {
    item: 'F',
    text: 'Port Operations - Trace Supply 港口追溯补给',
    negatable: true,
    family: 'zoc',
    actions: ['portTraceSupply'],
  },
  {
    item: 'G',
    text: 'Port Operations - Literal, Using Sea Cap 港口海运',
    negatable: false,
    family: 'zoc',
    actions: ['portSeaCap'],
  },
  {
    item: 'H',
    text: 'Aircraft Refit 飞机整备',
    negatable: true,
    family: 'zoc',
    actions: ['refit'],
  },
  {
    item: 'I',
    text: 'Reserve Mode 进入预备模式（5.7c）',
    negatable: false,
    family: 'mode',
    actions: ['modeChange'],
    appliesWhen: { modeTarget: 'reserve' },
  },
  {
    item: 'J',
    text: 'Strat Mode 进入战略模式（5.8a）',
    negatable: false,
    family: 'mode',
    actions: ['modeChange'],
    appliesWhen: { modeTarget: 'strat' },
  },
  {
    item: 'K',
    text: 'Repl Rebuilds 补员重建',
    negatable: false,
    family: 'zoc',
    actions: ['rebuild'],
  },
]

/* ────────────────────────────── 各族校验 ────────────────────────────── */

/** 阶段 → 移动环节名（mode 族的 MA / 行动者判定用） */
function movementSegmentOf(phase: GamePhase): MovementSegmentPhase | null {
  if (phase === 'movement') return 'movement'
  if (phase === 'reaction') return 'reaction'
  if (phase === 'exploitation') return 'exploitation'
  return null
}

/**
 * 时机族（2.2 流程表 + 6.3a/7.0a/11.0a）
 *
 * ① SOP 槽位：动作必须出现在当前段的许可集合里（`ACTIONS_BY_PHASE`）；
 * ② 同段内可执行者不同：移动类动作还要满足行动者身份——反应阶段只有非行动方的
 *    **已释放预备**能动（6.3a/7.0a），进击阶段只有行动方的进击单位或已释放预备能动（11.0a）。
 */
export function checkTiming(request: LegalityRequest): LegalityViolation[] {
  const violations: LegalityViolation[] = []
  if (TIMING_DEFERRED_ACTIONS.includes(request.action)) return violations

  const allowed = ACTIONS_BY_PHASE[request.phase]
  if (!allowed.includes(request.action)) {
    violations.push({
      family: 'timing',
      rule: '2.2',
      reason: 'actionNotInSegment',
      detail: `${request.phase} 段的许可动作为 [${allowed.join(', ')}]，不含 ${request.action}`,
    })
    return violations
  }

  // 轰炸来源：C 段仅空中与舰炮、F 段仅炮兵（SOP 原文）
  if (request.action === 'barrage') {
    const sources = BARRAGE_SOURCES_BY_PHASE[request.phase]
    if (sources !== undefined) {
      const source = request.barrageSource ?? 'artillery'
      if (!sources.includes(source)) {
        violations.push({
          family: 'timing',
          rule: request.phase === 'combat' ? '10.1a' : '2.2',
          reason: 'barrageSourceNotAllowedInSegment',
          detail: `${request.phase} 段只允许 [${sources.join(', ')}] 轰炸，实为 ${source}`,
        })
      }
    }
  }

  // 行动者身份（6.3a / 7.0a / 11.0a）——只对「由单位执行」的移动类动作判
  // 5.7b 的「释放预备」同属阶段限定的单位动作，但判据少一层：释放**不要求**已释放 / 进击标记
  const movable: readonly ActionKind[] = ['move', 'overrun', 'breakout', 'reserveRelease']
  const isRelease = request.action === 'reserveRelease'
  if (movable.includes(request.action) && request.units !== undefined && request.units.length > 0) {
    const segment = movementSegmentOf(request.phase)
    if (segment !== null) {
      for (const unit of request.units) {
        if (segment === 'movement') {
          if (request.side !== request.activeSide) {
            violations.push({
              family: 'timing',
              rule: '6.0',
              reason: 'notActiveSide',
              detail: '移动阶段只能移动当前阶段玩家的地面单位',
            })
            break
          }
          continue
        }
        if (segment === 'reaction') {
          // 6.3a：只有非阶段玩家的单位才能在反应阶段中移动
          if (request.side === request.activeSide) {
            violations.push({
              family: 'timing',
              rule: '6.3a',
              reason: 'activeSideInReaction',
              detail: '反应阶段只能移动非阶段玩家的单位',
            })
            break
          }
          // 7.0a：此阶段唯一可以行动的地面单位，是非阶段玩家释放的预备模式单位
          // （释放动作本身除外——5.7b 的释放正是把「未释放」变成「已释放」的那一步）
          if (!isRelease && unit.mode.releasedFromReserve !== true) {
            violations.push({
              family: 'timing',
              rule: '7.0a',
              reason: 'reserveNotReleased',
              detail: `${unit.id} 未在本阶段释放`,
            })
            break
          }
          continue
        }
        // 进击阶段（11.0a）
        if (request.side !== request.activeSide) {
          violations.push({
            family: 'timing',
            rule: '11.0a',
            reason: 'notActiveSide',
            detail: '进击阶段只能移动当前阶段玩家的单位',
          })
          break
        }
        if (!isRelease && !unit.mode.exploit && unit.mode.releasedFromReserve !== true) {
          violations.push({
            family: 'timing',
            rule: '11.0a',
            reason: 'notExploitOrReleased',
            detail: `${unit.id} 既非进击模式也非已释放预备`,
          })
          break
        }
      }
    }
  }

  return violations
}

/** 模式族所需动作能力（把动作映射到 modes.ts 的裁定结果） */
function modeAllows(
  unit: LegalityUnit,
  request: LegalityRequest,
): { ok: true } | ({ ok: false } & LegalityViolation) {
  const phase = movementSegmentOf(request.phase) ?? 'movement'
  const stats = resolveModeStats(unit.raw, unit.mode, phase)

  switch (request.action) {
    case 'attack':
      return stats.canAttack
        ? { ok: true }
        : {
            ok: false,
            family: 'mode',
            rule: '5.7/5.8',
            reason: 'modeForbidsAttack',
            detail: `${unit.id} 当前模式不可攻击（生效模式 ${stats.effectiveMode}）`,
          }
    case 'barrage':
      return stats.canBarrage
        ? { ok: true }
        : {
            ok: false,
            family: 'mode',
            rule: '5.7/5.8',
            reason: 'modeForbidsBarrage',
            detail: `${unit.id} 当前模式不可轰炸（生效模式 ${stats.effectiveMode}）`,
          }
    case 'overrun':
      // 8.1：须处于战斗、移动或进击模式；5.10b-C：DG 不能突袭
      if (hasMarker(unit.mode, 'dg'))
        return {
          ok: false,
          family: 'mode',
          rule: '5.10b',
          reason: 'dgCannotOverrun',
          detail: `${unit.id} 处于 DG 模式`,
        }
      return stats.canOverrun
        ? { ok: true }
        : {
            ok: false,
            family: 'mode',
            rule: '8.1',
            reason: 'modeForbidsOverrun',
            detail: `${unit.id} 当前模式不可突袭`,
          }
    case 'railTransport':
      // 5.10d：DG 单位不能使用铁路运输（无例外）
      if (hasMarker(unit.mode, 'dg'))
        return {
          ok: false,
          family: 'mode',
          rule: '5.10d',
          reason: 'dgCannotRail',
          detail: `${unit.id} 处于 DG 模式（5.10d）`,
        }
      // 5.6a：铁路运输须移动模式；★ 13.3g-B 例外——**铁路修理单位可在战斗模式下**使用铁路移动
      return canUseTransport(unit.mode) || (unit.railRepair === true && isInCombatMode(unit.mode))
        ? { ok: true }
        : {
            ok: false,
            family: 'mode',
            rule: '5.6a/5.8d',
            reason: 'modeForbidsRail',
            detail: `${unit.id} 不在移动模式（5.6a）`,
          }
    case 'airMission':
      return canUseTransport(unit.mode)
        ? { ok: true }
        : {
            ok: false,
            family: 'mode',
            rule: '5.6a',
            reason: 'modeForbidsAirTransport',
            detail: `${unit.id} 不在移动模式`,
          }
    case 'engineer':
      return canEngineer(unit.mode)
        ? { ok: true }
        : {
            ok: false,
            family: 'mode',
            rule: '5.5b',
            reason: 'modeForbidsEngineering',
            detail: `${unit.id} 不处于战斗模式（5.5b）`,
          }
    case 'railConversion':
      // 13.3g：只有**铁路修理单位**能转换铁路格
      if (unit.railRepair !== true)
        return {
          ok: false,
          family: 'mode',
          rule: '13.3g',
          reason: 'notRailRepairUnit',
          detail: `${unit.id} 不是铁路修理单位（13.3g）`,
        }
      // 5.5b / 5.10e：须战斗模式，或 DG 但朝向战斗面
      return canConvertGauge(unit.mode)
        ? { ok: true }
        : {
            ok: false,
            family: 'mode',
            rule: '5.5b',
            reason: 'modeForbidsEngineering',
            detail: `${unit.id} 不处于战斗模式（5.5b）`,
          }
    case 'buildHedgehog':
      // 5.10e：DG 时工程单位（朝战斗面）仍可施工，但**非工程兵不能修建环形工事**
      if (hasMarker(unit.mode, 'dg') && unit.engineerCapable !== true) {
        return {
          ok: false,
          family: 'mode',
          rule: '5.10e',
          reason: 'dgNonEngineerCannotBuildHedgehog',
          detail: `${unit.id} 处于 DG 且非工程兵`,
        }
      }
      return { ok: true }
    case 'modeChange': {
      if (request.modeTarget === undefined)
        return {
          ok: false,
          family: 'mode',
          rule: '5.4',
          reason: 'modeTargetMissing',
          detail: 'modeChange 必须给出 modeTarget',
        }
      // 4.5a-I / 5.7c：不可在敌方 ZOC 内进入预备模式
      if (request.modeTarget === 'reserve' && request.inEnemyZoc === true)
        return {
          ok: false,
          family: 'mode',
          rule: '5.7c',
          reason: 'enterReserveInEnemyZoc',
          detail: '不可在敌方 ZOC 内进入预备模式（4.5a-I）',
        }
      // 4.5a-J / 5.8a：不可在敌方 ZOC 内进入战略模式
      if (request.modeTarget === 'strat' && request.inEnemyZoc === true)
        return {
          ok: false,
          family: 'mode',
          rule: '5.8a',
          reason: 'enterStratInEnemyZoc',
          detail: '不可在敌方 ZOC 内进入战略模式（4.5a-J）',
        }
      // 5.8：战略模式朝向必须是移动面（mode∈{combat,move} 时模式兼作朝向，故取 baseOrientation）
      if (request.modeTarget === 'strat' && baseOrientation(unit.mode) !== 'move')
        return {
          ok: false,
          family: 'mode',
          rule: '5.8',
          reason: 'stratMustFaceMove',
          detail: '战略模式下单位朝向必须是移动模式面',
        }
      return { ok: true }
    }
    default:
      return { ok: true }
  }
}

/**
 * 模式族（5.5–5.10 / 8.1）
 *
 * 逐单位问 modes.ts 的裁定结果；本层不自行推断模式语义（避免与 zoc/move 两处判据漂移）。
 */
export function checkMode(request: LegalityRequest): LegalityViolation[] {
  const units = request.units ?? []
  if (units.length === 0) return []
  const violations: LegalityViolation[] = []
  for (const unit of units) {
    const verdict = modeAllows(unit, request)
    if (verdict.ok === false) {
      violations.push(verdict)
      break
    }
  }
  return violations
}

/**
 * 控制区族（4.5 / 4.5a / 4.5b）
 *
 * 4.5a 的 A–K 清单按动作查表：命中且处于**未被抵消**的敌方 ZOC → 违规；
 * 带 `<Negation>` 的项在 `inEnemyZoc=false`（已抵消）时放行。
 * A 项（轮式移动）不是禁令而是**后果**：进入后可停或突袭，故降级为提示。
 */
export function checkZoc(request: LegalityRequest): {
  violations: LegalityViolation[]
  warnings: LegalityWarning[]
} {
  const violations: LegalityViolation[] = []
  const warnings: LegalityWarning[] = []
  const inZoc = request.inEnemyZoc === true

  for (const entry of ZOC_FORBIDDEN) {
    if (entry.family !== 'zoc' || !entry.actions.includes(request.action)) continue
    // 条件项：例如 A 项只对轮式 MP 单位成立
    if (entry.appliesWhen?.moveMobility !== undefined) {
      const mobility = request.units?.[0]?.mobility
      if (mobility !== entry.appliesWhen.moveMobility) continue
    }
    if (!inZoc) continue
    if (entry.item === 'A') {
      // 4.5a-A：轮式进入敌方 ZOC 后「必须结束移动，或进行一次突袭」
      warnings.push({
        family: 'zoc',
        rule: '4.5a-A',
        reason: 'truckMustStopOrOverrun',
        detail: '轮式单位进入敌方 ZOC 后必须停止（或在该格进行突袭），不能继续移动',
      })
      continue
    }
    violations.push({
      family: 'zoc',
      rule: `4.5a-${entry.item}`,
      reason: entry.negatable ? 'zocForbiddenUnlessNegated' : 'zocForbidden',
      detail: `${entry.text}${entry.negatable ? '（可经 4.5b 抵消）' : '（抵消也不可行）'}`,
    })
  }

  // 4.8c：有敌方战斗单位的格不能进入（须以 8.0 突袭处理）
  if (
    request.action === 'move' &&
    request.target !== undefined &&
    request.target.enemyCombatUnits > 0
  ) {
    violations.push({
      family: 'zoc',
      rule: '4.8c',
      reason: 'enemyCombatUnitInHex',
      detail: '目标格有敌方战斗单位：不能直接移动进入，须以突袭（8.0）处理',
    })
  }

  return { violations, warnings }
}

/**
 * 燃料族（12.5a / 12.5b）
 *
 * 12.5a：使用轮式或履带 MP 的**战斗单位**要消耗 MP 就必须付燃料，「即使就移动一格」；
 * 12.5b：**攻击、防御、轰炸、撤退、战后推进**都不需要燃料，只有**移动与突袭**需要
 *        （突袭即使堆叠开始移动时就与防御方相邻也要付）。
 */
export function checkFuel(request: LegalityRequest): LegalityViolation[] {
  const units = request.units ?? []
  // 12.5b：需要燃料的行动只有移动与突袭（攻击/防御/轰炸/撤退/战后推进都不需要）
  if (request.action !== 'move' && request.action !== 'overrun') return []
  if (!actionNeedsFuel(request.action)) return []
  for (const unit of units) {
    if (!requiresFuelToSpendMp({ isCombat: unit.isCombat, mobility: unit.mobility })) continue
    if (request.fuelPaid !== true) {
      return [
        {
          family: 'fuel',
          rule: request.action === 'overrun' ? '12.5b' : '12.5a',
          reason: 'fuelNotPaid',
          detail: `${unit.id} 使用${unit.mobility === 'truck' ? '轮式' : '履带'} MP，须先付燃料才能消耗 MP（12.5a）`,
        },
      ]
    }
  }
  return []
}

/**
 * 堆叠族（4.8 / 4.8a / 4.8c）
 *
 * ★ 关键口径：4.8a「**超堆叠，是指在任何环节或阶段结束时**，某一格内的战斗单位超过 10RE」，
 * 且「单位在**移动过程中**可以暂时地超堆叠」——所以堆叠**不是逐步禁令**：
 *   - 本族只在两种**即时禁令**上判违规：4.8 的「每格 1 港口 + 1 空军基地 + 1 环形工事」、
 *     以及 4.8c 的敌方单位同格限制（后者由 zoc 族按 4.8c 报）；
 *   - 「合计 ≤10 RE」属**阶段末义务**，见 `stackingObligations()`（增援阶段例外，13.6）。
 */
export function checkStacking(request: LegalityRequest): LegalityViolation[] {
  const violations: LegalityViolation[] = []
  const target = request.target
  if (target === undefined || request.action !== 'move') return violations

  // 4.8：一格中累计不可超过一个港口、一个空军基地加上一个环形工事
  for (const unit of request.units ?? []) {
    const kind = unit.noncombatKind ?? null
    if (kind === 'port' && (target.ports ?? 0) >= 1)
      violations.push({
        family: 'stacking',
        rule: '4.8',
        reason: 'portPerHexLimit',
        detail: '一格至多 1 个港口',
      })
    if (kind === 'air_base' && (target.airBases ?? 0) >= 1)
      violations.push({
        family: 'stacking',
        rule: '4.8',
        reason: 'airBasePerHexLimit',
        detail: '一格至多 1 个空军基地',
      })
    if (kind === 'hedgehog' && (target.hedgehogs ?? 0) >= 1)
      violations.push({
        family: 'stacking',
        rule: '4.8',
        reason: 'hedgehogPerHexLimit',
        detail: '一格至多 1 个环形工事',
      })
  }
  return violations
}

/** 按额度种类取上限（数值来源：rail-cap.ts / rules-constants.json） */
export function resolveAllowanceLimit(
  usage: AllowanceUsage,
  context: { date: string; side: Side },
): number | null {
  if (usage.kind === 'railCap') return getRailCap(context.date, context.side)
  if (usage.kind === 'railConversion') return RAIL_CONVERSION_MAX_PER_PHASE
  return usage.limit ?? null
}

/**
 * 额度族（专规 1.2 / 13.3 / 13.3g）
 *
 * 只做「已用 + 本次 ≤ 上限」的一致性判定；上限一律按种类从数据层取，
 * 不在此重写铁路容量或转换上限。
 */
export function checkAllowance(request: LegalityRequest): LegalityViolation[] {
  const usage = request.allowance
  if (usage === undefined) return []
  const limit = resolveAllowanceLimit(usage, { date: request.date, side: request.side })
  if (limit === null) {
    return [
      {
        family: 'allowance',
        rule: '13.3',
        reason: 'allowanceLimitUnknown',
        detail: `额度种类 ${usage.kind} 未给出上限，且数据层没有该种类的上限`,
      },
    ]
  }
  if (usage.used + usage.required > limit) {
    return [
      {
        family: 'allowance',
        rule: usage.kind === 'railConversion' ? '13.3g' : '专规 1.2',
        reason: 'allowanceExceeded',
        detail: `已用 ${usage.used} + 本次 ${usage.required} > 上限 ${limit}`,
      },
    ]
  }
  return []
}

/**
 * 编队同源族（12.5c-A）
 *
 * 「如果编队中所有需要燃料补给的单位，没有通过同一个 HQ 来投递补给，或者没有通过同一个
 *   补给站来直接拖取补给，则只能对不能从通用来源获得补给的单位使用单单位法。」
 * 故未同源时**不是不能加油**，而是不能用编队法——本族把「改用单单位法」写进说明。
 */
export function checkFormation(request: LegalityRequest): LegalityViolation[] {
  if (request.action !== 'fuel') return []
  if (request.fuelMethod !== 'formation') return []
  if (request.formation === undefined) {
    return [
      {
        family: 'formation',
        rule: '12.5c-A',
        reason: 'formationFactsMissing',
        detail: '编队法加油必须给出同源事实（同一 HQ 投递或同一补给站拖取）',
      },
    ]
  }
  const cost = computeFuelCost({
    method: 'formation',
    commonSource: request.formation.sameSource,
    unitsNeedingFuel: request.formation.unitCount,
  })
  if (cost.ok === false) {
    return [
      {
        family: 'formation',
        rule: cost.rule,
        reason: 'formationSourceNotShared',
        detail: cost.reason,
      },
    ]
  }
  return []
}

/* ────────────────────────────── 聚合入口 ────────────────────────────── */

/**
 * 堆叠阶段末义务（4.8a）
 *
 * 「超堆叠，是指在**任何环节或阶段结束时**，某一格内的战斗单位超过 10RE。
 *   但有一个例外：在**增援阶段**中没有超堆叠限制（见 13.6）。」
 * 调用方在环节/阶段结束时对每个受检格调用本函数，得到需要结算的义务
 * （超堆叠格内单位的拥有者必须通过摧毁单位来使规模满足限制，摧毁哪些由他任选）。
 */
export function stackingObligations(
  hex: HexRef,
  combatRe: number,
  phase: GamePhase,
): LegalityObligation[] {
  if (phase === 'reinforcement') return [] // 13.6 例外
  if (combatRe <= STACKING_LIMIT_RE) return []
  return [
    {
      family: 'stacking',
      rule: '4.8a',
      reason: 'overstackAtSegmentEnd',
      detail: `${hex.col}.${hex.row} 战斗单位 ${combatRe} RE > ${STACKING_LIMIT_RE} RE，须由拥有者摧毁单位直至满足限制`,
    },
  ]
}

/**
 * 统一前置校验（**所有动作的唯一入口**）
 *
 * 按 `LEGALITY_FAMILIES` 固定顺序依次询问各族；违规**全量收集**（不短路），
 * 以便界面一次把所有不能做的理由都讲清楚；提示与义务与是否通过无关，恒返回。
 */
export function checkLegality(request: LegalityRequest): LegalityVerdict {
  const timing = checkTiming(request)
  const mode = checkMode(request)
  const zoc = checkZoc(request)
  const fuel = checkFuel(request)
  const stacking = checkStacking(request)
  const allowance = checkAllowance(request)
  const formation = checkFormation(request)

  const violations: LegalityViolation[] = [
    ...timing,
    ...mode,
    ...zoc.violations,
    ...fuel,
    ...stacking,
    ...allowance,
    ...formation,
  ]
  const checked = LEGALITY_FAMILIES
  const warnings = zoc.warnings
  // 4.8a：本动作造成的暂时超堆叠 → 记为阶段末义务（不是违规）
  const obligations: LegalityObligation[] = []
  if (request.action === 'move' && request.target !== undefined) {
    for (const unit of request.units ?? []) {
      const after = request.target.friendlyCombatRe + (unit.isCombat ? unit.re : 0)
      if (after > STACKING_LIMIT_RE) {
        obligations.push(...stackingObligations(request.target.hex, after, request.phase))
        break
      }
    }
  }

  if (violations.length > 0) return { ok: false, violations, checked, warnings, obligations }
  return { ok: true, checked, warnings, obligations }
}

/**
 * 把结论投影到 B3 的统一失败形状（便于命令层直接返回 `{ok:false, rule, reason}`）
 *
 * 通过时返回 null。
 */
export function legalityFailure(verdict: LegalityVerdict): RuleFailure | null {
  if (verdict.ok) return null
  const primary = verdict.violations[0]!
  return fail(primary.rule, primary.reason)
}

/** 便捷判别：动作此刻是否被允许 */
export function isLegal(verdict: LegalityVerdict): boolean {
  return verdict.ok
}
