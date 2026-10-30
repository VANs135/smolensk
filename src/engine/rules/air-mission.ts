import { rulesConstants } from '@/data'
import type { Side } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'
import type { AirStatus, GamePhase, UnitMode } from '../state-types'
import {
  AIR_MISSION_MAX_AIRCRAFT,
  flakAppliesToMission,
  refitCapacityPerLevel,
  type AirMissionKind,
} from './air'
import {
  AIRSTRIP_REFIT_AIRCRAFT,
  AIR_BASE_MIN_LEVEL,
  AIR_BASE_LEVELS_PER_TURN,
  CONSTRUCTION_MIN_BUILDER_RE,
} from './construction'
import { EDGE_BOX_ENTRY_MP } from './movement'
import { AXIS_AIR_BOX_RANGE_HEXES, SOVIET_AIR_BOX_RANGE_HEXES } from './timing'

/**
 * 空军任务流程、整备额度、基地转移与缩减、地图外盒（W5 B16）
 *
 * 本模块承接 `air.ts` 的**判定原语**（空战 14.3e / 防空 14.4e / 空运 14.10d / 基地能力 15.0b），
 * 补齐「一次任务怎么走完」以及「飞机怎么整备、怎么搬家、从哪儿起飞」这些**程序与额度**问题。
 * 每个函数只回答一个规则问题，全部为纯函数、无副作用，可直接独立测试。
 *
 * ## 条文索引（通规 14.x / 15.x；专规 1.4）
 *   - 14.2e 任务执行的时机：同一飞机不能执行多种任务、**每个阶段只能执行一次任务**；
 *           各任务的执行环节（移动环节 / 轰炸环节）在此登记
 *   - 14.2f 任务七步流程 A宣布 → B移动 → C空战 → D拦截 → E防空 → F结算任务 → G返航
 *           （★ C 之后不能再往任务里加飞机）
 *   - 14.3d 主动返航窗口：A 空战前（须留 ≥1 架继续战斗）/ B 空战中禁止 / C 空战完全结束后允许
 *   - 14.5  拦截：只拦截受防空影响的任务且任务格须在巡逻区内；一次一架战斗机；每个任务只能拦一次；
 *           胜 ⇒ 返回基地**保持激活**且不算执行过任务（同阶段可再拦）；败 ⇒ 返回基地非激活；
 *           ★ 拦截永不受专规天气与阶段限制
 *   - 14.11 基地转移：距离可**加倍**；战斗机在**正常距离内**保持激活，超出即非激活（其他机种一律非激活）
 *   - 15.1  整备：每基地每整备阶段一次、1T、容量＝等级×2、未抵消的敌方 ZOC 内不可整备、天气从不禁止
 *   - 15.2B 简易机场每阶段只整备 1 架
 *   - 15.4  基地缩减：只在移动阶段；1RE 战斗模式且未移动的单位，或具工程能力单位；每基地每阶段一次；
 *           不得降到低于 1 级（15.0c）；不耗 SP
 *   - 专规 1.4  图外盒：盒内**不允许战斗或轰炸**
 *   - 专规 1.4a 图外空军盒：无限驻机容量、每回合免费整备任意架数、盒内另有「额外」SP 可空运入图
 *   - 专规 1.4b 边缘盒：仅苏方地面单位在移动阶段以 1MP 或铁路容量进出；禁止撤退进出；
 *               盒内含追溯补给但图上单位不得从中取补；进入即停；离开时按「1T/单位」免费加注燃料
 */

/* ────────────────────────────── ① 14.2f 任务七步序列 ────────────────────────────── */

/** 任务流程步骤标识（14.2f A–G，顺序即规则要求的结算顺序） */
export const AIR_MISSION_STEP_IDS = [
  'declare',
  'move',
  'airCombat',
  'interception',
  'flak',
  'resolveMission',
  'returnToBase',
] as const

export type AirMissionStep = (typeof AIR_MISSION_STEP_IDS)[number]

/** 14.2f 七步流程的机器可读清单（供界面与日志按序提示） */
export const AIR_MISSION_SEQUENCE: readonly {
  step: AirMissionStep
  rule: string
  note: string
}[] = [
  { step: 'declare', rule: '14.2f-A', note: '宣布任务类型' },
  {
    step: 'move',
    rule: '14.2f-B',
    note: '飞机从各基地移动到任务格（来自多个基地者合计 ≤4 个空军单位）',
  },
  { step: 'airCombat', rule: '14.2f-C', note: '任务格内双方皆有激活飞机 ⇒ 结算所有空战（14.3）' },
  { step: 'interception', rule: '14.2f-D', note: '结算所有拦截（14.5）' },
  { step: 'flak', rule: '14.2f-E', note: '结算所有防空（14.4）' },
  { step: 'resolveMission', rule: '14.2f-F', note: '结算任务本身' },
  { step: 'returnToBase', rule: '14.2f-G', note: '飞机返回基地（14.1c），通常变为非激活' },
]

/** 取步骤在 14.2f 流程中的序号（0 起） */
export function airMissionStepIndex(step: AirMissionStep): number {
  return AIR_MISSION_STEP_IDS.indexOf(step)
}

/**
 * 14.2f 游戏说明：**在步骤 C 之后就不能再向任务中添加飞机了**
 *
 * 故只有「宣布 / 移动」两步允许继续加入飞机；要补战机扫荡须回到该阶段的移动环节。
 */
export function canAddAircraftAtStep(step: AirMissionStep): boolean {
  return airMissionStepIndex(step) <= airMissionStepIndex('move')
}

/**
 * 14.2a / 14.2f-B：一次任务的空军单位合计上限
 *
 * 返回加入后的合计与是否超限；`adding` 默认为 1（再加一架）。
 */
export function canJoinMission(
  currentAircraft: number,
  adding = 1,
): RuleOutcome<{ total: number; limit: number }> {
  const total = currentAircraft + adding
  if (total > AIR_MISSION_MAX_AIRCRAFT)
    return fail('14.2a', `missionAircraftLimitExceeded:${total}`)
  return succeed('14.2a', { total, limit: AIR_MISSION_MAX_AIRCRAFT })
}

/** 14.2e：同一个空军单位在一个阶段内只能执行一次任务 */
export const MISSIONS_PER_AIRCRAFT_PER_PHASE = 1

/**
 * 14.1a：该机此刻能不能执行任务（激活 / 非激活）
 *
 * 「飞机有两种模式：激活或非激活……整体来说，**激活的飞机可以执行任务，而非激活飞机不能**。
 *   友方空军基地格内的激活飞机可以无限期地保持其激活状态。」
 * ⇒ 这是**选择飞机那一刻**就该挡住的闸（用户 2026-09-18 报告的第 8 条：「可执行空军任务的环节时
 *   点击机场，未激活的飞机应该不可选中」）：判据只有这一处，选择闸（store）、候选阵列（
 *   `airMissionJoinChoices`）与宣布任务（`beginAirInteraction` 的 14.1a 校验）共用它。
 *
 * 非激活飞机要靠 14.1d 的**整备**（15.1，A 段）转激活——本条只管"现在能不能飞"。
 */
export function canFlyMission(airStatus: AirStatus): boolean {
  return airStatus === 'active'
}

/**
 * 14.2e：该机在本阶段是否还能再执行一次任务
 *
 * 注意 14.5 的例外：**成功拦截不算「执行过任务」**——判定拦截机时须用
 * `interceptionPostCombatStatus` / `canInterceptAgainSamePhase`，不套用本函数。
 */
export function canPerformMissionThisPhase(missionsFlownThisPhase: number): boolean {
  return missionsFlownThisPhase < MISSIONS_PER_AIRCRAFT_PER_PHASE
}

/** 任务所在的**环节**（14.2e：各任务在不同环节执行） */
export type AirMissionSegment = 'movementSegment' | 'barrageSegment' | 'interceptStep'

/**
 * 各任务类型所属环节（14.2e / 14.6 / 14.7b / 14.7d / 14.8 / 14.9 / 14.10 / 14.11）
 *
 * - 移动环节：低空扫射 14.7d、空运 14.9、空投 14.10、基地转移 14.11、战机扫荡 14.6
 * - 轰炸环节：空军轰炸 14.7b、运输破坏 14.8
 * - 拦截不是独立环节：它插在**敌方任务流程的 D 步**（14.5）
 */
export const AIR_MISSION_SEGMENT: Readonly<Record<AirMissionKind, AirMissionSegment>> = {
  barrage: 'barrageSegment',
  hip_shoot: 'movementSegment',
  trainbusting: 'barrageSegment',
  air_transport: 'movementSegment',
  air_drop: 'movementSegment',
  base_transfer: 'movementSegment',
  fighter_sweep: 'movementSegment',
  interception: 'interceptStep',
}

/** 取任务类型所属环节（14.2e） */
export function missionSegmentOf(kind: AirMissionKind): AirMissionSegment {
  return AIR_MISSION_SEGMENT[kind]
}

/* ────────────────────────────── ② 14.3d 主动返航窗口 ────────────────────────────── */

/** 空战时机（14.3d 的三种窗口） */
export type AirCombatWindow = 'beforeAirCombat' | 'duringAirCombat' | 'afterAirCombat'

export interface VoluntaryReturnInput {
  /** 当前处于空战的哪个时机 */
  window: AirCombatWindow
  /**
   * 己方选择返航这些飞机**之后**，该格中仍保持激活、可继续战斗的己方空军单位数
   *
   * 14.3d-A 要求「至少有一个空军单位必须保持激活并战斗」；14.3d-C 无此要求。
   */
  friendlyActiveRemainingAfterReturn: number
}

/**
 * 14.3d / 14.2b 主动返航是否被允许
 *
 * - 空战前（14.3d-A）：允许返航**部分**飞机，但须至少留 1 架保持激活并战斗；
 * - 空战中（14.3d-B）：**任何一方都不能返航**（空战一直打到该格只剩一方为止）；
 * - 空战完全结束后（14.3d-C）：激活空军单位可主动返航。
 *
 * 注意 14.1c 的例外：在**友方空军基地格内**的空战中，空战前或空战中返航的飞机必须返回该基地。
 */
export function canVoluntarilyReturn(
  input: VoluntaryReturnInput,
): RuleOutcome<{ returnAllowed: true }> {
  switch (input.window) {
    case 'duringAirCombat':
      return fail('14.3d-B', 'noVoluntaryReturnDuringAirCombat')
    case 'beforeAirCombat':
      if (input.friendlyActiveRemainingAfterReturn < 1)
        return fail('14.3d-A', 'mustKeepOneActiveUnitInCombat')
      return succeed('14.3d-A', { returnAllowed: true })
    case 'afterAirCombat':
      return succeed('14.3d-C', { returnAllowed: true })
  }
}

/* ────────────────────────────── ③ 14.5 拦截 ────────────────────────────── */

/**
 * 14.5 重要提示：拦截任务**永远不会**因专规天气规则和/或阶段的限制而被禁止
 *
 * 故本模块的拦截判定**不接收**天气或阶段入参；苏军专规 2.2d 的
 * Reaction/Exploitation 禁飞也**不适用于拦截**（拦截由对手在 D 步触发）。
 */
export const INTERCEPTION_EXEMPT_FROM_WEATHER_AND_PHASE = true

export interface InterceptionEligibilityInput {
  /** 被拦截的任务类型 */
  missionKind: AirMissionKind
  /** 任务格是否位于拦截方的巡逻区内（14.5：只有巡逻区覆盖任务格才能拦截） */
  missionHexInPatrolZone: boolean
  /** 拦截方是否有 1 架激活战斗机，且其巡逻区覆盖任务格（14.5：一次仅一架战斗机拦截） */
  hasActiveFighterInPatrolZone: boolean
  /** 本任务是否已被拦截过一次（14.5：每个任务只能被拦截一次） */
  alreadyIntercepted: boolean
}

/**
 * 14.5 / 14.4a 拦截资格
 *
 * 三个门槛缺一不可：任务须**受防空影响**（14.4a；战机扫荡与拦截本身永不在此列）、
 * 任务格须在巡逻区内、拦截方须有可用的激活战斗机；且**每个任务只能被拦截一次**。
 * 「是否真的拦截」是玩家的选择（14.5：不强制），本函数只判资格。
 */
export function canIntercept(
  input: InterceptionEligibilityInput,
): RuleOutcome<{ interceptorCount: 1 }> {
  if (input.alreadyIntercepted) return fail('14.5', 'missionAlreadyIntercepted')
  if (!input.missionHexInPatrolZone) return fail('14.5', 'missionHexOutsidePatrolZone')
  if (!flakAppliesToMission(input.missionKind, input.missionHexInPatrolZone))
    return fail('14.4a', `missionNotFlakAffected:${input.missionKind}`)
  if (!input.hasActiveFighterInPatrolZone) return fail('14.5', 'noActiveFighterInPatrolZone')
  return succeed('14.5', { interceptorCount: 1 })
}

/**
 * 14.5 拦截战斗后的归属状态
 *
 * 拦截机败 ⇒ 放回起飞的空军基地并变为**非激活**；
 * 拦截机胜 ⇒ 放回起飞的空军基地并**保持激活**（该机不算执行过任务）。
 */
export function interceptionPostCombatStatus(interceptorWon: boolean): AirStatus {
  return interceptorWon ? 'active' : 'inactive'
}

/** 14.5：获胜的拦截机未被视作执行过任务 ⇒ 同一阶段稍后可再拦截另一次敌方任务 */
export function canInterceptAgainSamePhase(interceptorWon: boolean): boolean {
  return interceptorWon
}

/* ────────────────────────────── ④ 14.11 基地转移 ────────────────────────────── */

/** 14.11：基地转移的距离可增加**一倍** */
export const BASE_TRANSFER_RANGE_MULTIPLIER = 2

export interface BaseTransferInput {
  /** 是否战斗机（14.11：只有战斗机在正常距离内保持激活） */
  isFighter: boolean
  /** 该机型的印刷射程（格） */
  rangeHexes: number
  /** 起降两基地之间的飞行距离（格） */
  distanceHexes: number
}

export interface BaseTransferResult {
  /** 转移后的激活状态（14.11） */
  airStatus: AirStatus
  /** 允许的最大转移距离 = 射程 × 2 */
  maxDistanceHexes: number
}

/** 14.11：基地转移的最大距离（射程的 2 倍） */
export function baseTransferMaxRange(rangeHexes: number): number {
  return rangeHexes * BASE_TRANSFER_RANGE_MULTIPLIER
}

/**
 * 14.11 基地转移结算
 *
 * - 距离超过射程的 2 倍 ⇒ 不可转移；
 * - **战斗机**在**正常射程内**完成转移 ⇒ 保持激活；超出正常射程（但在 2 倍内）⇒ 非激活；
 * - 其他机种（轰炸机 / 运输机 / 组合型）一律变为非激活。
 *
 * 注：基地转移属**受防空影响**的任务，但仅在敌方巡逻区内（14.4a）。
 */
export function resolveBaseTransfer(input: BaseTransferInput): RuleOutcome<BaseTransferResult> {
  const maxDistanceHexes = baseTransferMaxRange(input.rangeHexes)
  if (input.distanceHexes > maxDistanceHexes)
    return fail('14.11', `beyondDoubleRange:${input.distanceHexes}>${maxDistanceHexes}`)

  const keepsActive = input.isFighter && input.distanceHexes <= input.rangeHexes
  return succeed('14.11', { airStatus: keepsActive ? 'active' : 'inactive', maxDistanceHexes })
}

/* ────────────────────────────── ⑤ 15.1 整备额度 ────────────────────────────── */

export interface RefitCapacityInput {
  /** 是否图外空军盒（专规 1.4a：无限容量、免费） */
  isAirBox?: boolean
  /** 是否简易机场（15.2B：每阶段 1 架） */
  isAirstrip?: boolean
  /** 空军基地等级（1–3；简易机场传 0/省略） */
  level?: number
}

export interface RefitCapacity {
  /** 该基地每整备阶段可整备的飞机数上限（空军盒为 Infinity） */
  capacity: number
  /** 是否无限（专规 1.4a 空军盒） */
  unlimited: boolean
  /** 整备一次的固定费用 T（空军盒免费为 0；与等级和架数无关） */
  costT: number
}

/**
 * 15.1B / 15.2B / 专规 1.4a 整备额度
 *
 * - 空军基地：容量＝等级 × 2，费用 1T（**与等级、架数无关**）；
 * - 简易机场：容量 1，费用 1T；
 * - 图外空军盒：容量无限、**免费**。
 *
 * 15.1B 补充：进行整备时**每个空军单位都算作一架飞机**，军力减损的单位也照算。
 */
export function refitCapacity(input: RefitCapacityInput): RefitCapacity {
  if (input.isAirBox) {
    const airBox = rulesConstants.smolensk.offMapBox.air
    return {
      capacity: airBox.infiniteCapacity ? Number.POSITIVE_INFINITY : 0,
      unlimited: airBox.infiniteCapacity,
      costT: airBox.freeRefitPerTurn ? 0 : rulesConstants.air.refitTPerBase,
    }
  }
  if (input.isAirstrip)
    return {
      capacity: AIRSTRIP_REFIT_AIRCRAFT,
      unlimited: false,
      costT: rulesConstants.air.refitTPerBase,
    }
  const level = input.level ?? 0
  return {
    capacity: refitCapacityPerLevel(level),
    unlimited: false,
    costT: rulesConstants.air.refitTPerBase,
  }
}

export interface RefitEligibilityInput extends RefitCapacityInput {
  /** 当前阶段（15.1A：整备只在**飞机整备阶段**进行） */
  phase: GamePhase
  /** 该基地在本整备阶段是否已整备过（15.1A：每基地每阶段一次） */
  alreadyRefitThisPhase: boolean
  /** 基地是否处于**未被抵消的敌方 ZOC** 内（15.1C：不可整备） */
  inUnnegatedEnemyZoc: boolean
  /** 请求整备的飞机数（每个空军单位算 1 架，含减损单位；15.1B） */
  requestedAircraft: number
  /** 可用 T */
  availableT: number
}

/**
 * 15.1 / 15.2B / 专规 1.4a 整备资格与额度校验
 *
 * 判定顺序：阶段 → 每基地一次 → ZOC → 容量 → T。任一条不满足即失败并给出原因码。
 * 15.1D：**天气条件从不会禁止整备**，也从不影响飞机保持激活——故本函数**没有天气入参**。
 */
export function refitEligibility(
  input: RefitEligibilityInput,
): RuleOutcome<{ capacity: number; unlimited: boolean; costT: number }> {
  if (input.phase !== 'aircraftRefit') return fail('15.1A', 'refitOnlyInAircraftRefitPhase')
  if (input.alreadyRefitThisPhase) return fail('15.1A', 'baseAlreadyRefitThisPhase')
  if (input.inUnnegatedEnemyZoc) return fail('15.1C', 'unnegatedEnemyZoc')

  const { capacity, unlimited, costT } = refitCapacity(input)
  if (input.requestedAircraft > capacity) return fail('15.1B', `refitCapacityExceeded:${capacity}`)
  if (input.availableT < costT) return fail('15.1B', 'insufficientRefitT')
  return succeed('15.1', { capacity, unlimited, costT })
}

/* ────────────────────────────── ⑥ 15.4 基地缩减 ────────────────────────────── */

/** 15.4：一次缩减降低的等级（与 15.3 的每回合 +1 同源：construction.airBaseLevelsPerTurn） */
const AIR_BASE_REDUCTION_LEVELS = AIR_BASE_LEVELS_PER_TURN

/**
 * 15.4 / 16.0b：施工类作业所需的 RE 下限
 *
 * 单一定义处是 `construction.ts#CONSTRUCTION_MIN_BUILDER_RE`（取自 rules-constants 的
 * construction.minBuilderRe），本模块直接复用，避免同值两处定义。
 */
export const ENGINEERING_MIN_RE = CONSTRUCTION_MIN_BUILDER_RE

/** 15.4：在目标格内被指定执行缩减的**作业单位**（格内堆叠的一支分队） */
export interface AirBaseOperatingUnit {
  id: string
  /** 4.6：团级当量（作业单位的 RE **合计**须 ≥ 1，除非其中有人具工程能力） */
  re: number
  /** 15.4：该单位须处于**战斗模式** */
  mode: UnitMode
  /** 15.4：「且不能移动」——被指定的单位须**本阶段未移动** */
  movedThisPhase: boolean
  /** 13.8d：具工程能力者**替代**「RE 合计 ≥ 1」这条资格 */
  engineerCapable?: boolean
}

export interface AirBaseReductionInput {
  /** 当前阶段（15.4：只能在移动阶段） */
  phase: GamePhase
  /** 目标基地当前等级 */
  currentLevel: number
  /**
   * 15.4：在目标格内**指定执行本次缩减的单位**（格内堆叠的一支分队）
   *
   * ★ 判读口径（用户 2026-09-13 裁定）：条文说的「1RE 的单位」＝**被指定执行作业的这些单位**（堆叠的
   *   子集），其 RE **合计 ≥ 1** 即可——不是整格全部单位、也不是要求某一个单位自身刚好 1 RE。
   *   缩减后**只有这批被指定的单位**本阶段不能再移动，格内其余单位照常行动。
   */
  operatingUnits: readonly AirBaseOperatingUnit[]
  /** 该基地在本阶段是否已被缩减过一次（15.4：每阶段一次） */
  alreadyReducedThisPhase: boolean
}

/**
 * 15.4 / 15.0c 空军基地缩减资格
 *
 * 条件：移动阶段；目标格内**指定的一小队单位**（RE **合计** ≥ 1，或其中有人具工程能力 13.8d）
 * **逐员**处于战斗模式且本阶段未移动；同一基地每阶段只能缩减一次；**永远不能降到低于 1 级**；缩减不耗 SP。
 *
 * 成功时给出 `immobileUnitIds`：**只有这些被指定的单位**本阶段不能再移动（格内其余单位照常行动）。
 */
export function canReduceAirBase(
  input: AirBaseReductionInput,
): RuleOutcome<{ levelAfter: number; immobileUnitIds: string[] }> {
  if (input.phase !== 'movement') return fail('15.4', 'reductionOnlyInMovementPhase')
  if (input.alreadyReducedThisPhase) return fail('15.4', 'baseAlreadyReducedThisPhase')
  if (input.currentLevel <= AIR_BASE_MIN_LEVEL) return fail('15.0c', 'airBaseLevelCannotGoBelowOne')

  const levelAfter = Math.max(input.currentLevel - AIR_BASE_REDUCTION_LEVELS, AIR_BASE_MIN_LEVEL)
  if (input.operatingUnits.length === 0) return fail('15.4', 'reducingUnitNotEligible')
  // 「且不能移动」：被指定的单位逐员须本阶段未移动
  const moved = input.operatingUnits.find((unit) => unit.movedThisPhase)
  if (moved !== undefined) return fail('15.4', `reducingUnitAlreadyMoved:${moved.id}`)
  const notCombat = input.operatingUnits.find((unit) => unit.mode !== 'combat')
  if (notCombat !== undefined) return fail('15.4', `reducingUnitMustBeCombatMode:${notCombat.id}`)
  // 13.8d：有人具工程能力即可替代 RE 门槛；否则被指定单位的 RE 合计须 ≥ 1
  const hasEngineer = input.operatingUnits.some((unit) => unit.engineerCapable === true)
  if (!hasEngineer) {
    const totalRe = input.operatingUnits.reduce((sum, unit) => sum + unit.re, 0)
    if (totalRe < ENGINEERING_MIN_RE) return fail('15.4', `reducingUnitsReBelowMinimum:${totalRe}`)
  }

  return succeed('15.4', {
    levelAfter,
    immobileUnitIds: input.operatingUnits.map((unit) => unit.id),
  })
}

/* ────────────────────────────── ⑦ 专规 1.4 地图外盒与边缘盒 ────────────────────────────── */

/** 专规 1.4：地图外盒内**不允许战斗或轰炸** */
export function isCombatOrBarrageAllowedInOffMapBox(): boolean {
  return !rulesConstants.smolensk.offMapBox.noCombatOrBarrage
}

/* ── 专规 1.4a 图外空军盒（Red Air Force Box / Luftwaffe Box） ── */

/** 图外空军盒的归属（苏方 Red Air Force Box / 轴方 Luftwaffe Box） */
export type AirBoxSide = Side

/**
 * 专规 1.4a：从图外空军盒飞入地图的**任务射程**
 *
 * 苏方 Red Air Force Box ↔ 62.xx 行 = 20 格；轴方 Luftwaffe Box ↔ 01.xx 行 = 30 格。
 */
export function airBoxRangeHexes(side: AirBoxSide): number {
  return side === 'soviet' ? SOVIET_AIR_BOX_RANGE_HEXES : AXIS_AIR_BOX_RANGE_HEXES
}

/** 专规 1.4a：往返图外空军盒的判定结果 */
export interface OffMapAirBoxFlight {
  /** 这一次往返要花掉的航程（格）——固定代价，不是"到某格的距离" */
  rangeCost: number
}

/**
 * 专规 1.4a：**进出图外空军盒**是否飞得到（判据，不是文案）
 *
 * 原文（Smolensk 专规 1.4a）：
 *   「Moving between the Soviet player's Red Air Force Box and the map's 62.xx row
 *     **costs 20 hexes of range**. Moving between the Axis player's Luftwaffe Box and the
 *     map's **01.xx row costs 30 hexes of range**.」
 *
 * 要点：代价是**固定航程**（苏 20 / 轴 30），故机型印刷射程不足这个数就**根本飞不进去/飞不出来**
 * （数据里确有反例：`Ru I.153` 射程 15 ⇒ 只能落图上基地）。
 * 修前 store 只改盒成员并打一句"航程 20/30 格"，**不做任何裁断** ⇒ 等于免费瞬移。
 */
export function planOffMapAirBoxFlight(input: {
  side: AirBoxSide
  rangeHexes: number
}): RuleOutcome<OffMapAirBoxFlight> {
  const rangeCost = airBoxRangeHexes(input.side)
  if (input.rangeHexes < rangeCost)
    return fail('专规 1.4a', `offMapBoxBeyondRange:${input.rangeHexes}<${rangeCost}`)
  return succeed('专规 1.4a', { rangeCost })
}

/** 专规 1.4a 图外空军盒的能力（容量无限、整备免费） */
export interface AirBoxRules {
  /** 无限驻机容量（1.4a） */
  infiniteCapacity: boolean
  /** 每回合免费整备任意架数（1.4a） */
  freeRefitPerTurn: boolean
  /** 盒内的「额外」SP 可经**空运任务**飞入地图（1.4a / 1.6b Notes） */
  extraSpFlownByAirTransport: true
  /** 盒内永不允许战斗或轰炸（1.4） */
  combatOrBarrageAllowed: boolean
}

/** 读取图外空军盒规则（专规 1.4a） */
export function airBoxRules(): AirBoxRules {
  const airBox = rulesConstants.smolensk.offMapBox.air
  return {
    infiniteCapacity: airBox.infiniteCapacity,
    freeRefitPerTurn: airBox.freeRefitPerTurn,
    extraSpFlownByAirTransport: true,
    combatOrBarrageAllowed: isCombatOrBarrageAllowedInOffMapBox(),
  }
}

/**
 * 专规 1.4a：盒内飞机的整备额度
 *
 * 便捷包装：等价于 `refitCapacity({ isAirBox: true })`。
 *
 * ★ 唯一实现是 `refitCapacity` 的 `isAirBox` 分支（本函数与它同源）；界面上要显示「盒内整备
 *   容量无限 / 免费」时取本函数即可，**不要再读一遍 `offMapBox.air` 的原始常量**。
 */
export function airBoxRefitCapacity(): RefitCapacity {
  return refitCapacity({ isAirBox: true })
}

/* ── 专规 1.4b 边缘盒（Northeast Box / Southeast Box） ── */

/** 边缘盒标识（专规 1.4b；仅苏方地面单位可在移动阶段进出） */
export type EdgeBoxId = 'northeast' | 'southeast'

/** 边缘盒连接的地图边缘补给源范围（专规 1.4b） */
export type EdgeBoxConnection = 'northAndEast' | 'southAndEast'

/** 专规 1.4b：该边缘盒连接哪些边（Northeast 连北＋东；Southeast 连南＋东） */
export function edgeBoxConnection(box: EdgeBoxId): EdgeBoxConnection {
  return box === 'northeast' ? 'northAndEast' : 'southAndEast'
}

/** 专规 1.4b 边缘盒的静态规则（供引擎与界面单点读取） */
export interface EdgeBoxRules {
  /** 仅苏方地面单位可使用（1.4b） */
  sovietOnly: boolean
  /** 只在移动阶段可进出（1.4b：反应/进击阶段不得进出） */
  movementPhaseOnly: boolean
  /** 进入费用：1 MP，或改用铁路容量（1.4b） */
  entryMp: number
  allowsRailCapEntry: true
  /** 盒内含追溯补给（1.4b） */
  hasTraceSupply: boolean
  /** **图上单位不得**从边缘盒取得 SP 或追溯补给（1.4b） */
  onMapUnitsCanDraw: boolean
  /** 撤退不得进出边缘盒（1.4b） */
  retreatAllowed: boolean
  /** 进入边缘盒即须停止移动（勘误：units must stop when entering a box） */
  mustStopOnEntry: boolean
  /** 离开边缘盒时按「1T/单位」免费加注燃料（1.4b） */
  exitFuelsFree: boolean
}

/** 读取边缘盒规则（专规 1.4b） */
export function edgeBoxRules(): EdgeBoxRules {
  const edge = rulesConstants.smolensk.offMapBox.edge
  return {
    sovietOnly: edge.sovietOnly,
    movementPhaseOnly: true,
    entryMp: EDGE_BOX_ENTRY_MP,
    allowsRailCapEntry: true,
    hasTraceSupply: rulesConstants.smolensk.edgeBoxTraceSupply,
    onMapUnitsCanDraw: !edge.onMapUnitsCannotDraw,
    retreatAllowed: !edge.noRetreatEntryExit,
    mustStopOnEntry: edge.mustStopOnEntry,
    // ★ 唯一实现是 `isEdgeBoxExitFuelFree`（本对象不再直接读一遍原始常量）
    exitFuelsFree: isEdgeBoxExitFuelFree(),
  }
}

export interface EdgeBoxEntryInput {
  /** 行动方（1.4b：仅苏方） */
  side: Side
  /** 当前阶段（1.4b：仅移动阶段） */
  phase: GamePhase
  /** 进出单位类别（1.4b：仅地面单位） */
  unitKind: 'ground' | 'air'
  /** 是否在己方地图边缘补给源格与边缘盒之间移动（1.4b） */
  fromSupplySourceHex: boolean
}

/**
 * 专规 1.4b 边缘盒进出资格
 *
 * 四项同时成立：苏方、地面单位、移动阶段、且只在**地图边缘补给源格**与盒之间移动。
 * 进入费用为 1 MP 或铁路容量（`edgeBoxRules().entryMp`）；进入即停；撤退不得进出。
 */
export function canEnterEdgeBox(
  input: EdgeBoxEntryInput,
): RuleOutcome<{ entryMp: number; allowsRailCap: true }> {
  if (rulesConstants.smolensk.offMapBox.edge.sovietOnly && input.side !== 'soviet')
    return fail('1.4b', 'edgeBoxSovietOnly')
  if (input.unitKind !== 'ground') return fail('1.4b', 'edgeBoxGroundUnitsOnly')
  if (input.phase !== 'movement') return fail('1.4b', 'edgeBoxMovementPhaseOnly')
  if (!input.fromSupplySourceHex) return fail('1.4b', 'edgeBoxNeedsSupplySourceHex')
  return succeed('1.4b', { entryMp: EDGE_BOX_ENTRY_MP, allowsRailCap: true })
}

/**
 * 专规 1.4b：离开边缘盒时的燃料
 *
 * 回到图上时按「1T/单位」的方式加注燃料，但**不消耗 SP**（1.4b：fueled at no SP cost）。
 */
export function isEdgeBoxExitFuelFree(): boolean {
  return rulesConstants.smolensk.offMapBox.edge.exitFuelsFree
}
