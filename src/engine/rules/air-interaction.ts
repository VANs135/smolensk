import type { HexRef, Side } from '@/data'

import { hexDistance, hexesWithin, sameHex } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import type { AirStatus, GamePhase } from '../state-types'
// 14.4f：防空任务损失表的取表（行标 `<N> aircraft`）只有一处实现
import { flakMissionLoss } from '../tables/flak'
import {
  PARADROP_PLANNING_TURNS_ADVANCE,
  PATROL_ZONE_MAX_HEXES,
  activeStackingLimit,
  airCombatModifiedRoll,
  canHipShoot,
  canMissionInPhase,
  canPlannedAirdrop,
  computeFlakDrm,
  flakAppliesToMission,
  flakKillCheck,
  resolveAirCombat,
  resolveAirTransportSuccess,
  type AirCombatResultSide,
  type AirMissionKind,
  type ResolveAirCombatResult,
} from './air'
// 14.9c：单位货物"处于移动模式"的判据基准（与 5.x 的基础模式同一枚举）
import type { BaseMode } from './modes'
import {
  AIR_MISSION_SEQUENCE,
  AIR_MISSION_STEP_IDS,
  canFlyMission,
  canIntercept,
  canJoinMission,
  canPerformMissionThisPhase,
  canReduceAirBase,
  refitEligibility,
  resolveBaseTransfer,
  type AirBaseOperatingUnit,
} from './air-mission'
// 15.2E：简易机场永不缩减的常量（唯一实现）在 construction.ts
import { canReduceAirstrip } from './construction'
import { isAirMissionAllowedInPhase } from './weather'

/**
 * 空军交互（C9，OCS 14.0 / 15.0 章）
 *
 * 本模块是**交互层**：把用户在界面上的动作（选任务、点飞机、应答拦截、掷防空骰、整备、搬家、缩减）
 * 折成引擎输入，并把引擎结论整理成可直接显示的形状。判定原语仍在 `air.ts`（14.3e 空战 / 14.4e 防空 /
 * 14.10d 空运 / 15.0b 基地能力）与 `air-mission.ts`（14.2f 流程 / 14.5 拦截 / 14.11 转移 / 15.1 整备 /
 * 15.4 缩减）；本模块不重复实现它们，只负责**组合、顺序与归属校验**。
 *
 * ## ★ 基地归属权（用户指定的重点）
 * 全篇以「**友方**空军基地」为准绳，任何用到基地的地方都先判归属：
 *   - **14.1a**「**友方**空军基地格内的激活飞机可以无限期地保持其激活状态」⇒ 激活状态只在**本方**基地成立；
 *     飞机停在敌方基地格内即失去「停在基地」的资格（`checkAircraftOrigin` 报 `aircraftBaseNotFriendly`）；
 *   - **14.1c**「返航……必须返回其距离内的一个**友方**空军基地」⇒ 任务起飞与返航两头都须是**本方**基地；
 *   - **14.4c** 巡逻区「由任何拥有一个或多个激活战斗机的**空军基地**创建」⇒ 只说本方基地（`patrolZoneSources`
 *     只取本方的、且场内确有激活战斗机的基地）；
 *   - **15.1 / 15.4** 整备与缩减：15.4 原文即「同一个**友方**空军基地在一个阶段只能被缩减一次」；
 *   - **15.0a** 一格至多一个空军基地 ⇒ `airBaseAt` 取首个即唯一。
 * 中立算子（units-*.json 里空军基地 `side='both'`）在运行期由**占有一方**决定归属：调用方须把
 * `AirBaseView.side` 填成实际归属方（摆放时按己方、被 9.14f 夺取后翻面），本模块不再猜。
 *
 * ## 条文索引
 *   - 14.1a 激活/非激活（友方基地格内可无限期保持激活）
 *   - 14.1b 军力：每机 2 点，损失第二点即摧毁
 *   - 14.1c 返航/返回基地：必须回到距离内的**友方**基地并变为非激活
 *           （例外：成功拦截的战斗机、正常距离内转移的战斗机保持激活）
 *   - 14.1d 整备：飞机唯一需要/消耗补给的情形
 *   - 14.1e 战略轰炸机：轰炸总被认为无观察员、永不低空扫射、永不获短程横移
 *   - 14.1f 天气：可以把任务限制在特定阶段，甚至完全禁飞；但激活状态与整备不受影响
 *   - 14.1g 阶段：激活飞机可在**友方移动/进击/反应阶段**执行飞行任务
 *   - 14.2a 堆叠：每机算一个单位；一次任务合计 ≤4 架；每基地激活堆叠 ≤ 4 + 基地等级
 *   - 14.2c 飞机移动：基地被敌方地面单位夺取时，基地内所有空军单位被转移（9.14f）
 *   - 14.2d 距离：飞往/返回任务格的飞行距离（格）；只放格内，不论地形与敌单位，无须具体路径
 *   - 14.2e 任务：同一飞机不能执行多种任务，且**每个阶段只能执行一次**；任务本身从不限制机种
 *   - 14.2f 流程：A 宣布 → B 移动 → C 空战 → D 拦截 → E 防空 → F 结算 → G 返航
 *   - 14.3a/14.3c 带括号空战值：不能发起空战；若攻击方全为括号值则攻守互换；双方全为括号值则不发生空战
 *   - 14.4a 受防空影响的任务：always＝轰炸/低空扫射/运输破坏；onlyInPatrolZone＝空运/空投/基地转移
 *           ；never＝战机扫荡/拦截
 *   - 14.4c 巡逻区：由拥有 ≥1 架激活战斗机的空军基地向外 **10 格**
 *   - 14.4e 防空结算：掷 2 骰 + 防空点数修正，≥11 ⇒ 一架任务机损失 1 点军力
 *   - 14.4f 防空损失：用**任务损失表**（1 骰）确定哪一架承受损失
 *   - 14.5 拦截：仅受防空影响的任务；任务格须在巡逻区内；一次一架战斗机；每个任务只拦一次；
 *           胜 ⇒ 回起飞基地并保持激活（不算执行过任务）；败 ⇒ 回起飞基地变非激活；
 *           ★ 拦截永不受专规天气与阶段限制
 *   - 14.6 战机扫荡：移动环节执行；战斗机飞入有激活敌机的格并空战（只有战斗机能攻击，14.1）
 *   - 14.7c 短距离轰炸：所有飞机都在各自起飞基地 10 格内 ⇒ 额外右移
 *   - 14.11 基地转移：距离可加倍；战斗机在**正常距离内**保持激活，超出即非激活
 *   - 15.0a 一格至多一个空军基地；15.0b 等级效果（整备/防空/卸载/堆叠）；15.0d 基地永不需要追溯补给
 *   - 15.1A–D 整备：每基地每整备阶段一次、1T、容量＝等级×2、未抵消敌方 ZOC 内不可整备、天气从不禁止
 *   - 15.2B/D/E 简易机场：每阶段整备 1 架、激活堆叠上限 4、永不被缩减
 *   - 15.4 基地缩减：移动阶段；被指定单位 RE 合计 ≥1（或具工程能力）且战斗模式未移动；每阶段一次；
 *           永不低于 1 级；不耗 SP
 *
 * ## 明确不做的部分（防「无中生有」）
 *   - **14.3e 的逐轮空战**：本模块给出 14.3c 的攻守角色判定（`airCombatAttackerSide`）与**拦截的单轮**
 *     结算（`resolveInterception`）；一整个空战的多轮推进仍由 `air.ts` 的 `resolveAirCombat` 逐轮驱动。
 *   - **9.14f 基地夺取后的转移/损失**：已在 `special-combat.ts` 实现，本模块只消费其结论（归属翻面）。
 */

/* ────────────────────────────── 视图与词表 ────────────────────────────── */

/**
 * 空军基地运行期视图（15.0）
 *
 * `side` 是**归属方**：unit 库把空军基地标为中立（`side='both'`），运行期由占有一方决定
 * —— 摆放时按己方、被夺取后翻面（14.2c / 9.14f）。本视图要求调用方给出确定归属，不再猜。
 */
export interface AirBaseView {
  id: string
  hex: HexRef
  /** ★ 归属方（14.1a/14.1c/15.1/15.4：一切基地用途都要求本方） */
  side: Side
  /** 15.0：等级（1–3）；简易机场与图外空军盒为 0/省略 */
  level: number
  /** 15.2：简易机场（整备 1 架、堆叠 4、永不缩减、无防空值） */
  isAirstrip?: boolean
  /** 专规 1.4a：图外空军盒（容量无限、每回合免费整备） */
  isAirBox?: boolean
  /** 15.1C：该基地是否处于**未被抵消**的敌方 ZOC 内（不可整备） */
  inUnnegatedEnemyZoc?: boolean
  /** 15.1A：该基地在本整备阶段是否已整备过 */
  refitDoneThisPhase?: boolean
  /** 15.4：该基地在本阶段是否已被缩减过 */
  reducedThisPhase?: boolean
}

/** 任务机视图（14.1/14.2，字段取自 aircraft.json + 运行期状态） */
export interface AirMissionAircraftView {
  id: string
  side: Side
  /** 14.1a：激活/非激活 */
  airStatus: AirStatus
  /** 14.1a/14.1c：飞机所在的**空军基地格**（运行时即其起飞基地；返航也须回本方基地） */
  baseHex: HexRef
  /** 14.2e：本阶段已执行的任务数（≥1 即本阶段不能再执行任务） */
  missionsFlownThisPhase: number
  /** 14.1：机种代号（仅用于说明文本，判定一律用下方能力位） */
  aircraftType: string
  /** 14.3e：空战值 */
  airCombatRating: number
  /** 14.3a：能否发起空战（带括号空战值为 false） */
  canInitiateAirCombat: boolean
  /** 14.2d：航程（格） */
  rangeHexes: number
  /**
   * 专规 1.4a：该机驻在**地图外空军盒**里（盒本身就是空军基地，容量无限、整备免费）
   *
   * 用户 2026-10-30 口径：「两家的图外空军基地的飞机**从对应行入场**，剩余航程为
   * 航程减去图外空军基地到那一行的航程。」
   * ⇒ `edgeCol` = 连接地图的那一列（苏方 62 / 轴方 1），`rangeCost` = 往返该列的固定航程
   * （苏 20 / 轴 30，见 `airBoxRangeHexes`）。任务距离按「先花 rangeCost 到该行，再飞剩下的」算。
   */
  offMap?: { edgeCol: number; rangeCost: number } | null
  /** 14.1b：剩余军力（0 ⇒ 已摧毁） */
  steps: number
  /** 14.7b：可否轰炸 */
  canBarrage?: boolean
  /** 14.7d：可否低空扫射（苏军另有专规 2.2a 限制） */
  canHipShoot?: boolean
  /** 14.10：可否空投 */
  canAirDrop?: boolean
  /** 14.4c：可否创建巡逻区（战斗机） */
  canPatrolZone?: boolean
  /** 14.9a：运输容量（T） */
  transportCapacity?: number
  /**
   * 14.4f/14.4g：**减损面**（1 step）的运输容量（T；缺省＝与正面相同）
   *
   * 「剩下一 点军力的飞机将使用其**减少后的数值**来完成任务」（14.4f）——运输机的减损面印值更低
   * （本作 Ju.52 与 TB.3：正面 1T ⇒ 减损面 1/2T，取自工程库 `printed_values.back.transport_capacity`）。
   */
  transportCapacityBack?: number | null
  /** 14.1e：战略轰炸机 */
  isStrategicBomber?: boolean
}

/* ────────────────────────────── ① 基地归属权（14.1a/14.1c/15.1/15.4） ────────────────────────────── */

/** ★ 基地归属权：该基地是否属于 `side`（14.1a/14.1c/15.1/15.4 一律要求本方基地） */
export function isFriendlyAirBase(base: AirBaseView, side: Side): boolean {
  return base.side === side
}

/** 在该格找空军基地（15.0a：一格至多一个，故取首个即唯一） */
export function airBaseAt(bases: readonly AirBaseView[], hex: HexRef): AirBaseView | null {
  return bases.find((base) => sameHex(base.hex, hex)) ?? null
}

/** 某机所在的空军基地（该格无基地 ⇒ null） */
export function baseOfAircraft(
  aircraft: AirMissionAircraftView,
  bases: readonly AirBaseView[],
): AirBaseView | null {
  return airBaseAt(bases, aircraft.baseHex)
}

/**
 * 14.1a：起飞基地校验——飞机必须停在**自己的**空军基地格内
 *
 * 「激活的飞机算子放在**空军基地**算子的上方……**友方**空军基地格内的激活飞机可以无限期地保持其激活状态」
 * ⇒ 两种不合格：该格根本没有空军基地（`aircraftNotInAirBaseHex`）、该基地是敌方的（`aircraftBaseNotFriendly`）。
 */
export function checkAircraftOrigin(input: {
  aircraft: AirMissionAircraftView
  side: Side
  bases: readonly AirBaseView[]
}): RuleOutcome<{ base: AirBaseView }> {
  const base = baseOfAircraft(input.aircraft, input.bases)
  if (base === null) return fail('14.1a', `aircraftNotInAirBaseHex:${input.aircraft.id}`)
  if (!isFriendlyAirBase(base, input.side))
    return fail('14.1a', `aircraftBaseNotFriendly:${input.aircraft.id}`)
  return succeed('14.1a', { base })
}

/** 14.2a：该基地格的激活堆叠上限 = 4 + 基地等级（简易机场 15.2D 恒为 4） */
export function activeStackingLimitOf(base: AirBaseView): number {
  return activeStackingLimit(base.isAirstrip === true ? 0 : base.level)
}

/** 14.2a：某基地格内当前的激活飞机数 */
export function activeAircraftInBase(
  aircraft: readonly AirMissionAircraftView[],
  hex: HexRef,
): number {
  return aircraft.filter((plane) => plane.airStatus === 'active' && sameHex(plane.baseHex, hex))
    .length
}

/* ────────────────────────────── ② 巡逻区（14.4c） ────────────────────────────── */

/** 巡逻区来源：一个拥有 ≥1 架激活战斗机的**本方**基地 */
export interface PatrolZoneSource {
  baseId: string
  hex: HexRef
  /** 巡逻区半径（14.4c：向所有方向延伸 10 格） */
  radiusHexes: number
}

/**
 * 14.4c：本方的巡逻区来源
 *
 * 「巡逻区是由任何拥有一 个或多个激活战斗机的**空军基地**创建的防御区域，从空军基地向所有方向延伸 10 格」
 * ⇒ 判据三层：基地是**本方**的、基地格内确有 1 架**激活**的、具备巡逻能力的飞机（战斗机）。
 */
export function patrolZoneSources(input: {
  side: Side
  bases: readonly AirBaseView[]
  aircraft: readonly AirMissionAircraftView[]
}): PatrolZoneSource[] {
  return input.bases
    .filter((base) => isFriendlyAirBase(base, input.side))
    .filter((base) =>
      input.aircraft.some(
        (plane) =>
          plane.side === input.side &&
          plane.airStatus === 'active' &&
          plane.canPatrolZone === true &&
          plane.steps > 0 &&
          sameHex(plane.baseHex, base.hex),
      ),
    )
    .map((base) => ({
      baseId: base.id,
      hex: base.hex,
      radiusHexes: PATROL_ZONE_MAX_HEXES,
    }))
}

/** 14.4c / 14.5：该格是否处于 `side` 的巡逻区内 */
export function inPatrolZoneOf(input: {
  hex: HexRef
  side: Side
  bases: readonly AirBaseView[]
  aircraft: readonly AirMissionAircraftView[]
}): boolean {
  return patrolZoneSources(input).some(
    (source) => hexDistance(source.hex, input.hex) <= source.radiusHexes,
  )
}

/**
 * 14.4c：巡逻区覆盖的**全部格**（供界面铺色）
 *
 * 多个来源取并集；只保留图内格（图外无需绘制）。
 */
export function patrolZoneHexes(input: {
  side: Side
  bases: readonly AirBaseView[]
  aircraft: readonly AirMissionAircraftView[]
  onMapOnly?: boolean
}): HexRef[] {
  const seen = new Set<string>()
  const hexes: HexRef[] = []
  for (const source of patrolZoneSources(input)) {
    for (const hex of hexesWithin(source.hex, source.radiusHexes, {
      onMapOnly: input.onMapOnly ?? true,
    })) {
      const key = `${hex.col}.${hex.row}`
      if (seen.has(key)) continue
      seen.add(key)
      hexes.push(hex)
    }
  }
  return hexes
}

/* ────────────────────────────── ③ 任务分配（14.2e/14.2f-A/14.2a/14.2d） ────────────────────────────── */

export interface AirMissionRequest {
  /** 任务方（发起方，14.3c 的「本来的攻击方」） */
  side: Side
  /** 当前阶段（14.1g：移动/进击/反应；专规 2.2c 另对苏军设限） */
  phase: GamePhase
  kind: AirMissionKind
  targetHex: HexRef
  /** 14.1f：天气是否允许飞行（受限飞行一律禁飞） */
  flyingAllowed: boolean
  /** 14.7d 低空扫射另需「天气正常」（专规 3.2a 轴方） */
  weatherNormal?: boolean
  /**
   * 专规 1.5：本次是否为**受限飞行**（Limited Flight）
   *
   * 「受限飞行时**仅移动阶段**允许空军任务；反应 / 进击不可。」故它与 `flyingAllowed`
   * （能不能飞）是两件事：受限飞行**可以飞**，但不能在反应/进击阶段飞。
   * 判据唯一实现在 `weather.ts#isAirMissionAllowedInPhase`，本处只是它的调用方。
   */
  weatherLimited?: boolean
  /** 参战飞机（每机自带所在基地格） */
  aircraft: readonly AirMissionAircraftView[]
  /** 全图空军基地（用于归属与堆叠判定） */
  bases: readonly AirBaseView[]
  /** 14.9a/14.10a：装载的货物（空运/空投任务） */
  cargo?: readonly AirMissionCargo[]
  /** 14.10b：空投计划（空投**战斗单位**必须预先计划） */
  airdropPlan?: AirDropPlan
  /** 当前回合数（14.10b：计划须提前两个回合） */
  currentTurn?: number
}

/** 空运/空投的货物（14.9a / 14.10a） */
export interface AirMissionCargo {
  id: string
  /** 货物类别：补给指示物（SP）或战斗单位 */
  kind: 'sp' | 'unit'
  /** SP 货物的 T 数（14.10d：**每 1T 分别掷骰**，调用方须按 1T 拆分） */
  t?: number
  /** 14.10a：战斗单位是否标有「空降/Para」标识 */
  paraCapable?: boolean
  /** 14.10a：是否战斗单位（非战斗单位不得空投） */
  isCombat?: boolean
  /**
   * 14.9c（第五批批 C 切片 2）：单位货物须**处于移动模式**
   *
   * 「补给点数可以被空运，**处于移动模式**的战斗单位也可以空运，前提是其 MA 为 10 或以下的步行 MP。」
   */
  mode?: BaseMode
  /** 14.9c：该单位的**步行 MP**（本作＝战斗面印值 MA；> 10 不可空运/空投） */
  ma?: number
}

/** 14.9c：可空运单位的步行 MP 上限（原文「MA 为 10 或以下的步行 MP」） */
const CARGO_UNIT_MAX_WALKING_MA = 10

/**
 * 14.10b：空投计划
 *
 * 「这种空投只能在**移动阶段**进行，并且需要一份空投计划。玩家需要书面记录每个战斗单位将被空投的格，
 *   以及执行任务的具体回合。您必须在游戏开始前，或者至少在**计划空投的两个回合前**制定该计划。」
 */
export interface AirDropPlan {
  /** 计划中记录的格（14.10b：须与本次任务格一致） */
  targetHex: HexRef
  /** 制定计划的回合 */
  plannedTurn: number
  /** 计划执行任务的回合 */
  scheduledTurn: number
  /** 本轮实际执行的回合（14.10b：必须等于计划回合；14.10c 的延迟即改成下一回合的等价计划） */
  currentTurn: number
}

export interface AirMissionAssignment {
  kind: AirMissionKind
  side: Side
  targetHex: HexRef
  /** 参战机 id（顺序照输入，供 14.4f 的任务损失表按 #1..#4 解引用） */
  aircraftIds: string[]
  /** 逐机的起飞基地格（14.2d：距离自起飞基地起算）与其航程（14.1c 返航校验用） */
  origins: {
    aircraftId: string
    baseHex: HexRef
    distanceHexes: number
    rangeHexes: number
    /** 专规 1.4a：本机自图外空军盒起飞（返航回盒，不校验图上基地） */
    fromOffMapBox?: boolean
  }[]
  /** 14.9a：空运/空投的总运输容量（T；其余任务为 0） */
  cargoCapacity: number
  /** 装载的货物（14.9a/14.10a；其余任务为空数组） */
  cargo: readonly AirMissionCargo[]
  /** 本任务中最远的飞行距离（格） */
  maxDistanceHexes: number
  /** 14.7c：所有飞机都在各自起飞基地 10 格内（享短距离轰炸修正） */
  allWithinShortRange: boolean
  rule: string
}

/* ────────────────────── 14.9e：空运/空投的三种飞法（逐机判定） ────────────────────── */

/** 14.9e 的单机结论 */
export interface AirTransportProfileResult {
  rule: string
  /** A＝双程（目的地变非激活）/ B＝正常 / C＝半程（容量翻倍）；超出两倍航程 ⇒ null（去不了） */
  profile: 'A' | 'B' | 'C' | null
  /** 14.9e-C：运输容量翻倍 ⇒ 2；A/B 档 ⇒ 1 */
  capacityMultiplier: number
  /** 14.9e-A：飞机在**目的地空军基地**变为非激活（不返航） */
  endsInactiveAtDestination: boolean
  /** 返航可选基地的距离上限（格）：B 档＝正常航程、C 档＝半程、A 档＝0（留在目的地） */
  returnRangeHexes: number
  detail: string
}

/**
 * 14.9e：**单架运输机**按任务格距离落在哪一档
 *
 * 「A) 任务格可以在**飞机距离的两倍**内，前提是飞机在**目的地空军基地变为非激活**，或
 *   B) 任务格可以在飞机的**正常距离**内……或
 *   C) 任务格可以在**飞机距离的一半**内，在这种情况下，飞机的**运输容量将翻倍**……」
 *
 * 判据只有一处（本函数）：档位**只由距离与航程的比值**决定，不另设开关 ——
 * 于是 14.9f 的「超额部分由在目的地变非激活的运输机承运」这条例外可以由**飞法**推出，
 * 而不是让玩家手填一个布尔（§17.71 当时的如实边界②）。
 *
 * 边界口径：距离与航程都以**格**计（14.1c/14.2d 同口径，引擎不换算英里）；半程取 `range / 2` 的**实数**
 * 比较（不预先取整），与 4.2「永远不要对移动力上限的小数取整」同一精神。
 */
export function airTransportProfile(input: {
  distanceHexes: number
  rangeHexes: number
}): AirTransportProfileResult {
  const distance = Math.max(0, input.distanceHexes)
  const range = Math.max(0, input.rangeHexes)
  if (range <= 0 || distance > range * 2)
    return {
      rule: '14.9e',
      profile: null,
      capacityMultiplier: 1,
      endsInactiveAtDestination: false,
      returnRangeHexes: range,
      detail: `${String(distance)} 格超出航程 ${String(range)} 格的两倍 ⇒ 该机飞不到任务格（14.9e）`,
    }
  if (distance <= range / 2)
    return {
      rule: '14.9e-C',
      profile: 'C',
      capacityMultiplier: 2,
      endsInactiveAtDestination: false,
      returnRangeHexes: range / 2,
      detail: `${String(distance)} 格 ≤ 航程 ${String(range)} 的一半 ⇒ **运输容量翻倍**，返航限 ${String(range / 2)} 格内（14.9e-C）`,
    }
  if (distance <= range)
    return {
      rule: '14.9e-B',
      profile: 'B',
      capacityMultiplier: 1,
      endsInactiveAtDestination: false,
      returnRangeHexes: range,
      detail: `${String(distance)} 格 ≤ 航程 ${String(range)} ⇒ 正常飞法，返航限 ${String(range)} 格内（14.9e-B）`,
    }
  return {
    rule: '14.9e-A',
    profile: 'A',
    capacityMultiplier: 1,
    endsInactiveAtDestination: true,
    returnRangeHexes: 0,
    detail: `${String(distance)} 格 > 航程 ${String(range)} 但 ≤ 两倍 ⇒ 双程飞法：飞机在**目的地空军基地变为非激活**（不返航）（14.9e-A）`,
  }
}

/** 14.7c：短距离轰炸的判定半径（格） */
export const SHORT_RANGE_BARRAGE_HEXES = 10

/**
 * 14.2f-A/B：任务分配（选任务 + 点名参战飞机）
 *
 * 逐条校验（失败即返回带条文号的原因码，界面据此高亮该机）：
 *   1. **不能把拦截当任务宣布**（14.5：拦截发生在敌方任务的 D 步，由对手触发）；
 *   2. 天气允许飞行（14.1f）；阶段允许（14.1g；专规 2.2c 苏军不得在反应/进击阶段出击）；
 *   3. 参战机 1–4 架（14.2a：一次任务合计上限 4 个空军单位）；
 *   4. 逐机：本方所有、**激活**（14.1a）、本阶段未执行过任务（14.2e）、军力未归零（14.1b）、
 *      **起飞基地为本方空军基地**（★ 归属权，14.1a/14.1c）、距任务格 ≤ 航程（14.2d）；
 *   5. 任务类型的能力门槛（14.1 的能力位 + 专规 2.2a/b/3.2a）：
 *      轰炸/运输破坏须至少 1 架可轰炸、低空扫射须至少 1 架可低空扫射且天候/专规允许、
 *      空运/空投须至少 1 架有运输容量（其余飞机可护航，14.2e「任务从不限制参加的飞机必须属于某一类型」）、
 *      战机扫荡须至少 1 架能发起空战（14.6 + 14.1：只有战斗机能攻击）。
 */
export function assignAirMission(input: AirMissionRequest): RuleOutcome<AirMissionAssignment> {
  if (input.kind === 'interception') return fail('14.5', 'interceptionIsNotADeclaredMission')
  if (input.kind === 'base_transfer') return fail('14.11', 'baseTransferUsesDedicatedPlan')
  if (!input.flyingAllowed) return fail('14.1f', 'weatherProhibitsFlying')

  if (input.phase !== 'movement' && input.phase !== 'reaction' && input.phase !== 'exploitation')
    return fail('14.1g', `missionsNotAllowedInPhase:${input.phase}`)
  if (!canMissionInPhase(input.side, input.phase))
    return fail('2.2c', 'sovietNoReactionOrExploitationMission')
  /*
   * 专规 1.5：受限飞行下**仅移动阶段**允许空军任务（反应 / 进击不可）。
   * ★ 这条**天气维度**的闸门此前**没人调用**（`weather.ts` 的注释还以为它在管这事），
   *   于是受限飞行时双方都能在反应 / 进击阶段出击。它与上一条（专规 2.2c 的**阵营维度**）
   *   是两条不同的规则，必须都过。
   */
  if (!isAirMissionAllowedInPhase({ isLimited: input.weatherLimited === true }, input.phase))
    return fail('专规 1.5', `limitedFlightBlocksPhase:${input.phase}`)

  if (input.aircraft.length === 0) return fail('14.2f-A', 'noAircraftInMission')
  // 14.2a：合计上限 4 架——判据只有一处（`canJoinMission`），此处不再自算 `length > 上限`
  const join = canJoinMission(input.aircraft.length, 0)
  if (!join.ok) return join

  const origins: AirMissionAssignment['origins'] = []
  let allWithinShortRange = true
  let maxDistanceHexes = 0
  for (const plane of input.aircraft) {
    if (plane.side !== input.side)
      return fail('14.2f-A', `aircraftNotOwnedByMissionSide:${plane.id}`)
    if (plane.steps <= 0) return fail('14.1b', `aircraftEliminated:${plane.id}`)
    // 14.1a：非激活飞机不能执行任务——判据只有一处（`canFlyMission`；选择闸与候选阵列也用它）
    if (!canFlyMission(plane.airStatus)) return fail('14.1a', `aircraftNotActive:${plane.id}`)
    // 14.2e：本阶段一架只能执行一次任务——判据只有一处（`canPerformMissionThisPhase`）
    if (!canPerformMissionThisPhase(plane.missionsFlownThisPhase))
      return fail('14.2e', `aircraftAlreadyFlewMissionThisPhase:${plane.id}`)

    /*
     * 专规 1.4a：**驻在图外空军盒的飞机**以盒为基地（容量无限、整备免费）。
     * 用户 2026-10-30 口径：「从对应行入场，剩余航程 = 印刷航程 − 盒到该行的航程。」
     * ⇒ 起点取「连接列（苏 62 / 轴 1）× 任务格所在行」这一点（同行的格距恰为列差），
     *   并把可用航程先扣掉 20/30 格。于是判据等价于 `rangeCost + 列差 ≤ 印刷航程`。
     */
    const offMap = plane.offMap ?? null
    let originHex: HexRef
    let effectiveRange: number
    if (offMap !== null) {
      originHex = { col: offMap.edgeCol, row: input.targetHex.row }
      effectiveRange = plane.rangeHexes - offMap.rangeCost
      if (effectiveRange < 0)
        return fail(
          '专规 1.4a',
          `offMapOriginBeyondRange:${plane.id}:${plane.rangeHexes}<${offMap.rangeCost}`,
        )
    } else {
      // ★ 基地归属权：起飞基地必须是本方的空军基地（14.1a/14.1c）
      const origin = checkAircraftOrigin({ aircraft: plane, side: input.side, bases: input.bases })
      if (!origin.ok) return origin
      originHex = origin.data.base.hex
      effectiveRange = plane.rangeHexes
    }

    const distanceHexes = hexDistance(originHex, input.targetHex)
    /*
     * 14.2d：任务格须在飞机航程内；**14.9e-A 的例外** —— 空运/空投任务允许飞到**两倍航程**，
     * 代价是该机在**目的地**变为非激活（档位由 `airTransportProfile` 判，见本文件上方的判据）。
     * 其余任务类型（轰炸 / 低空扫射 / 战机扫荡 / 运输破坏）仍按 14.2d 的正常航程。
     */
    const isTransportRun = input.kind === 'air_transport' || input.kind === 'air_drop'
    const profile = airTransportProfile({ distanceHexes, rangeHexes: effectiveRange })
    if (isTransportRun ? profile.profile === null : distanceHexes > effectiveRange)
      return fail(
        offMap === null ? '14.2d' : '专规 1.4a',
        `aircraftOutOfRange:${plane.id}:${distanceHexes}>${effectiveRange}`,
      )

    origins.push({
      aircraftId: plane.id,
      baseHex: originHex,
      distanceHexes,
      rangeHexes: effectiveRange,
      ...(offMap === null ? {} : { fromOffMapBox: true }),
    })
    maxDistanceHexes = Math.max(maxDistanceHexes, distanceHexes)
    if (distanceHexes > SHORT_RANGE_BARRAGE_HEXES) allWithinShortRange = false
  }

  const ability = missionAbilityCheck(input)
  if (!ability.ok) return ability
  const cargoCheck = missionCargoCheck(input)
  if (!cargoCheck.ok) return cargoCheck

  const cargoCapacity =
    input.kind === 'air_transport' || input.kind === 'air_drop'
      ? input.aircraft.reduce(
          (sum, plane) =>
            /*
             * 14.9e-C：任务格在**航程一半**内 ⇒ 该机**运输容量翻倍**。
             * 逐机判（原文：「将每个飞机分开处理」）⇒ 容量按各机档位分别折算后求和。
             * 14.4f：减损机（1 step）取**减损面**的容量（`transportCapacityBack`，缺省＝正面值）。
             */
            sum +
            transportCapacityOf(plane) *
              airTransportProfile({
                distanceHexes:
                  origins.find((item) => item.aircraftId === plane.id)?.distanceHexes ?? 0,
                rangeHexes: plane.rangeHexes,
              }).capacityMultiplier,
          0,
        )
      : 0
  const cargo =
    input.kind === 'air_transport' || input.kind === 'air_drop' ? (input.cargo ?? []) : []
  // 14.9a：装载量不得超过总运输容量
  const cargoT = cargo.reduce((sum, item) => sum + (item.kind === 'sp' ? (item.t ?? 0) : 0), 0)
  if (cargoT > cargoCapacity)
    return fail('14.9a', `cargoExceedsCapacity:${cargoT}>${cargoCapacity}`)

  return succeed('14.2f-A', {
    kind: input.kind,
    side: input.side,
    targetHex: input.targetHex,
    aircraftIds: input.aircraft.map((plane) => plane.id),
    origins,
    cargoCapacity,
    cargo,
    maxDistanceHexes,
    allWithinShortRange,
    rule: '14.2f-A',
  })
}

/**
 * 14.10a / 14.10b：空投的货物资格与计划
 *
 * - 14.10a：**只有 SP 和标有「空降/Para」标识的战斗单位**才可以被空投（非战斗单位不得空投）；
 * - 14.10b：空投**战斗单位**只能在**移动阶段**进行，且须有**空投计划**：
 *   计划中记录的格须与本次任务格一致、须提前至少两个回合制定、且实际执行回合＝计划回合。
 */
function missionCargoCheck(input: AirMissionRequest): RuleOutcome<{ ok: true }> {
  if (input.kind !== 'air_transport' && input.kind !== 'air_drop')
    return succeed('14.9a', { ok: true })
  const cargo = input.cargo ?? []
  /*
   * 14.9c（第五批批 C 切片 2）：「补给点数可以被空运，处于**移动模式**的战斗单位也可以空运，
   *   前提是其 MA 为 **10 或以下的步行 MP**。」14.10 明写「第 14.9 节中的规则均适用于空投」
   *   ⇒ 空运与空投**都**查本条（`ma` 由调用方给**步行 MP**，本作＝战斗面印值 MA）。
   */
  for (const item of cargo) {
    if (item.kind !== 'unit') continue
    if (item.mode !== 'move') return fail('14.9c', `cargoUnitNotInMoveMode:${item.id}`)
    if (item.ma === undefined || item.ma > CARGO_UNIT_MAX_WALKING_MA)
      return fail('14.9c', `cargoUnitMaAboveTen:${item.id}`)
  }
  if (input.kind !== 'air_drop') return succeed('14.9c', { ok: true })

  const illegal = cargo.find(
    (item) => item.kind !== 'sp' && !(item.isCombat === true && item.paraCapable === true),
  )
  if (illegal !== undefined) return fail('14.10a', `cargoNotParaCapable:${illegal.id}`)

  const dropsUnits = cargo.some((item) => item.kind === 'unit')
  if (!dropsUnits) return succeed('14.10a', { ok: true })

  if (input.phase !== 'movement') return fail('14.10b', 'plannedAirdropOnlyInMovementPhase')
  const plan = input.airdropPlan
  if (plan === undefined) return fail('14.10b', 'plannedAirdropRequiresPlan')
  if (!sameHex(plan.targetHex, input.targetHex)) return fail('14.10b', 'airdropPlanTargetMismatch')
  if (plan.scheduledTurn !== plan.currentTurn) return fail('14.10b', 'airdropPlanTurnMismatch')
  if (plan.currentTurn - plan.plannedTurn < PARADROP_PLANNING_TURNS_ADVANCE)
    return fail('14.10b', `airdropPlanTooLate:${plan.currentTurn - plan.plannedTurn}`)
  return succeed('14.10b', { ok: true })
}

/** 任务类型的能力门槛（14.1 能力位 + 14.2e「不限制机种」的组合口径） */
function missionAbilityCheck(input: AirMissionRequest): RuleOutcome<{ ok: true }> {
  const planes = input.aircraft
  switch (input.kind) {
    case 'barrage':
    case 'trainbusting':
      if (!planes.some((plane) => plane.canBarrage === true))
        return fail('14.7b', 'noBarrageCapableAircraft')
      return succeed('14.7b', { ok: true })
    case 'hip_shoot': {
      if (!planes.some((plane) => plane.canHipShoot === true))
        return fail('14.7d', 'noHipShootCapableAircraft')
      /*
       * 14.7d-B（第五批批 C 切片 3）：「低空扫射必须由**单独一个飞机**完成」
       * ⇒ 任务编成**恰好 1 架**（多机同任务即拒，防止把轰炸值相加）。
       */
      if (planes.length !== 1)
        return fail('14.7d-B', `hipShootMustBeSingleAircraft:${planes.length}`)
      // 专规 2.2a 苏军禁低空扫射；专规 3.2a 轴方须天气允许
      if (!canHipShoot(input.side, input.weatherNormal ?? true))
        return fail('2.2a', 'hipShootNotAllowedForSideOrWeather')
      return succeed('14.7d', { ok: true })
    }
    case 'air_transport':
    case 'air_drop':
      if (!planes.some((plane) => (plane.transportCapacity ?? 0) > 0))
        return fail('14.9a', 'noTransportCapableAircraft')
      if (input.kind === 'air_drop' && !canPlannedAirdrop(input.side))
        return fail('2.2b', 'plannedAirdropNotAllowedForSide')
      return succeed('14.9a', { ok: true })
    case 'fighter_sweep':
      // 14.6：战斗机飞入有激活敌机的格进行空战；14.1：只有战斗机能攻击 ⇒ 须至少 1 架能发起空战
      if (!planes.some((plane) => plane.canInitiateAirCombat))
        return fail('14.6', 'noAirCombatCapableAircraft')
      return succeed('14.6', { ok: true })
    default:
      return fail('14.2e', `unsupportedMissionKind:${input.kind}`)
  }
}

/* ────────────────────────────── ④ 空战角色（14.3a/14.3c） ────────────────────────────── */

export interface AirCombatRoles {
  /** 实际攻击方（14.3c：可能因攻方全为括号值而互换） */
  attackerSide: Side | null
  defenderSide: Side | null
  /** 是否发生了攻守互换（14.3c） */
  swapped: boolean
  /** 是否根本不会发生空战（14.3a/14.3c：双方都只有括号值时互不理睬） */
  noCombat: boolean
  rule: string
  detail: string
}

/**
 * 14.3a / 14.3c：空战的攻守角色
 *
 * 「带括号空战值的飞机**不能发起空战**。……如果本来的『攻击方』只有带括号空战值的空军单位，则双方角色互换；
 *   如果该格中的所有激活飞机都有带括号的空战值，则战斗结束，格中现存的飞机无视彼此，任务继续。」
 *
 * 括号值在数据层表达为 `canInitiateAirCombat === false`（见 aircraft.json air_abilities）；
 * 判定只需「各方**是否至少有一架**能发起空战」这一事实。
 */
export function airCombatAttackerSide(input: {
  /** 本来的攻击方（任务玩家或拦截玩家，14.3c） */
  initiatorSide: Side
  /** 攻击方在该格的激活飞机中，是否至少一架能发起空战 */
  attackerCanInitiate: boolean
  /** 防守方同判 */
  defenderCanInitiate: boolean
}): AirCombatRoles {
  const opponent: Side = input.initiatorSide === 'axis' ? 'soviet' : 'axis'

  if (!input.attackerCanInitiate && !input.defenderCanInitiate)
    return {
      attackerSide: null,
      defenderSide: null,
      swapped: false,
      noCombat: true,
      rule: '14.3a',
      detail: '双方在该格的激活飞机全为括号空战值 ⇒ 互不理睬，不发生空战，任务继续',
    }
  if (!input.attackerCanInitiate)
    return {
      attackerSide: opponent,
      defenderSide: input.initiatorSide,
      swapped: true,
      noCombat: false,
      rule: '14.3c',
      detail: '本来的攻击方只有括号空战值 ⇒ 攻守角色互换',
    }
  return {
    attackerSide: input.initiatorSide,
    defenderSide: opponent,
    swapped: false,
    noCombat: false,
    rule: '14.3c',
    detail: '攻击方为任务/拦截的发起方',
  }
}

/**
 * 14.3：本格是否会发生空战
 *
 * 「当双方在某一格内都有激活的飞机时，立刻结算空战。**只有当任务格内有敌方空军基地并有激活的飞机时**，
 *   或在拦截的过程中（14.5），才会发生这种情况。」⇒ 任务格内没有**敌方**空军基地就不发生空战。
 */
export function airCombatOccursAt(input: {
  /** 该格内的本方激活飞机数 */
  friendlyActiveCount: number
  /** 该格内的敌方激活飞机数 */
  enemyActiveCount: number
  /** 该格是否有**敌方**空军基地（★ 归属权：只有敌方基地才算敌方据点） */
  enemyAirBaseInHex: boolean
}): boolean {
  if (input.friendlyActiveCount === 0 || input.enemyActiveCount === 0) return false
  return input.enemyAirBaseInHex
}

/* ────────────────────────────── ⑤ 拦截应答（14.5 / 14.4a / 14.4c） ────────────────────────────── */

export interface InterceptionResponse {
  /** 是否有可执行的拦截机（14.5：不强制拦截，是否真拦由玩家决定） */
  eligible: boolean
  /** 可执行拦截的战斗机 id（14.5：一次仅一架，多个候选由玩家选） */
  eligibleFighterIds: string[]
  rule: string
  reason?: string
  detail: string
}

/**
 * 14.5 / 14.4a / 14.4c：拦截资格
 *
 * 三道门槛（缺一不可）：任务须**受防空影响**（14.4a：战机扫荡与拦截本身不在此列）、
 * 任务格须处于拦截方的**巡逻区**内（14.4c：本方基地 + 激活战斗机 + 10 格）、
 * 且拦截方须有 1 架**激活战斗机**且其巡逻区覆盖任务格；另有「每个任务只能被拦截一次」。
 *
 * ★ 14.5 重要提示：拦截**永远不因**专规天气规则和/或阶段的限制而被禁止 ⇒ 本函数没有天气/阶段入参。
 */
/**
 * 14.5 拦截被拒的中文说明（`canIntercept` 的四个原因码一一对应）
 *
 * ★ 判定与文案分家：判定只有 `canIntercept` 一处，本表只负责把原因码翻成人话
 *   （修前这段文案与判定一起被抄在 `planInterceptionResponse` 里，与 `canIntercept` 各判一遍）。
 */
const INTERCEPTION_REFUSAL_DETAILS: Readonly<Record<string, string>> = {
  missionAlreadyIntercepted: '本任务已被拦截过一次（14.5：每个任务只能被拦截一次）',
  missionHexOutsidePatrolZone:
    '任务格不在拦截方的巡逻区内（14.5 / 14.4c：巡逻区由**本方基地 + 激活战斗机**向外 10 格产生）',
  noActiveFighterInPatrolZone: '巡逻区内没有可用的**激活战斗机**（14.5：一次仅一架战斗机拦截）',
}

export function planInterceptionResponse(input: {
  /** 拦截方（对手） */
  side: Side
  missionKind: AirMissionKind
  missionHex: HexRef
  /** 本任务是否已被拦截过（14.5：每任务只拦一次） */
  alreadyIntercepted: boolean
  /** 拦截方全部飞机（用于巡逻区判定） */
  aircraft: readonly AirMissionAircraftView[]
  bases: readonly AirBaseView[]
}): InterceptionResponse {
  /*
   * 14.5 的**资格判定只有一处**（`air-mission.ts#canIntercept`）：本函数先算出两项事实
   * （任务格是否在巡逻区内、巡逻区内是否有可用激活战斗机），把结论交给它，
   * 自己只负责「有哪些拦截机候选」与中文说明。
   * 修前这里把同样的四个门槛（已拦截 / 巡逻区 / 14.4a 受防空影响 / 有无激活战斗机）又写了一遍。
   */
  const missionHexInPatrolZone = inPatrolZoneOf({
    hex: input.missionHex,
    side: input.side,
    bases: input.bases,
    aircraft: input.aircraft,
  })

  // 14.5：巡逻区内可用的激活战斗机（★ 归属权：须停在本方空军基地上）
  const fighters = input.aircraft.filter(
    (plane) =>
      plane.side === input.side &&
      plane.airStatus === 'active' &&
      plane.steps > 0 &&
      plane.canPatrolZone === true &&
      (() => {
        const base = baseOfAircraft(plane, input.bases)
        return base !== null && isFriendlyAirBase(base, input.side)
      })() &&
      hexDistance(plane.baseHex, input.missionHex) <= PATROL_ZONE_MAX_HEXES,
  )

  const verdict = canIntercept({
    missionKind: input.missionKind,
    missionHexInPatrolZone,
    hasActiveFighterInPatrolZone: fighters.length > 0,
    alreadyIntercepted: input.alreadyIntercepted,
  })
  if (!verdict.ok)
    return {
      eligible: false,
      eligibleFighterIds: [],
      rule: verdict.rule,
      reason: verdict.reason,
      detail: INTERCEPTION_REFUSAL_DETAILS[verdict.reason] ?? `不具备拦截资格（${verdict.rule}）`,
    }

  return {
    eligible: true,
    eligibleFighterIds: fighters.map((plane) => plane.id),
    rule: '14.5',
    detail: `可派 1 架战斗机拦截（14.5）；候选 ${fighters.length} 架，是否拦截由拦截方决定（不强制）`,
  }
}

export interface InterceptionCombatResult {
  combat: ResolveAirCombatResult
  /** 14.5：拦截机是否获胜 */
  interceptorWon: boolean
  /** 14.5：拦截机战后归属状态（胜 ⇒ 保持激活；否则非激活） */
  interceptorAirStatus: AirStatus
  /** 14.5：获胜的拦截机不算执行过任务（同阶段可再拦） */
  interceptorCountsAsMission: false
  /** 14.3e-C：本轮回基地并须损失 1 点军力的飞机（双方返航时为两边各一架） */
  stepLossIds: string[]
  rule: string
  detail: string
}

/**
 * 14.5：拦截的单轮空战结算
 *
 * 「拦截按空战结算」⇒ 用 14.3e 的修正骰与空战表（`air.ts` 的 `resolveAirCombat`）；
 * 战后特殊处理：败 ⇒ 回起飞基地变**非激活**；胜 ⇒ 回起飞基地**保持激活**且不算执行过任务。
 * 修正骰 = 7（双方返航）时视为未获胜（14.1c 的例外只给「成功完成一次拦截」者），故按非激活处理；
 * 14.3e-C 的损失骰对**返航的单位或单位们**生效，故双方返航时两边各损失 1 点军力。
 */
export function resolveInterception(input: {
  interceptor: { id: string; airCombatRating: number }
  /** 任务机中迎战的 1 架（14.3e-B：防御方选择任意一架；无可用者传 null） */
  defender: { id: string; airCombatRating: number } | null
  /** 攻击方（拦截机）的 2 骰 */
  die: number
  /** 14.3e-C：损失骰（1 骰；1–4 无损失 / 5–6 损失军力） */
  lossDie?: number
}): RuleOutcome<InterceptionCombatResult> {
  if (input.defender === null) return fail('14.3e-B', 'noDefendingAircraftInAirCombat')

  const modifiedRoll = airCombatModifiedRoll(
    input.die,
    input.interceptor.airCombatRating,
    input.defender.airCombatRating,
  )
  const combat = resolveAirCombat(modifiedRoll, input.lossDie)
  // 拦截机是 14.3e 的「攻击方」；防守方（任务机）返航 ⇒ 拦截成功
  const interceptorWon = combat.abortSide === 'defender'
  const stepLossIds: string[] = []
  if (combat.winnerLossRoll === 'step_loss') {
    if (combat.abortSide === 'attacker' || combat.abortSide === 'both')
      stepLossIds.push(input.interceptor.id)
    if (combat.abortSide === 'defender' || combat.abortSide === 'both')
      stepLossIds.push(input.defender.id)
  }
  return succeed('14.5', {
    combat,
    interceptorWon,
    interceptorAirStatus: interceptorWon ? 'active' : 'inactive',
    interceptorCountsAsMission: false,
    stepLossIds,
    rule: '14.5',
    detail:
      `拦截空战：修正骰 ${modifiedRoll} ⇒ ${
        combat.abortSide === 'attacker'
          ? '拦截机返航'
          : combat.abortSide === 'defender'
            ? '任务机返航'
            : '双方返航'
      }` +
      (combat.winnerLossRoll === undefined
        ? ''
        : `；损失骰 ${combat.rawLossRoll} ⇒ ${
            combat.winnerLossRoll === 'step_loss'
              ? `损失军力（${stepLossIds.join('、')}）`
              : '无损失'
          }`) +
      `；拦截机 ${interceptorWon ? '保持激活（14.5）' : '变为非激活（14.5）'}`,
  })
}

/* ────────────────────────────── ⑪ 14.3e 逐轮空战（C9 补全） ────────────────────────────── */

/** 空战参与机（14.3e 所需最小视图） */
export interface AirCombatAircraftView {
  id: string
  airCombatRating: number
  /** 14.3a：带括号空战值者不能发起空战（攻击方**不能点它**） */
  canInitiateAirCombat: boolean
}

/** 一轮空战（14.3e-B / C） */
export interface AirCombatRound {
  round: number
  attackerAircraftId: string
  defenderAircraftId: string
  /** 修正 2 骰 = 2 骰 + 攻方空战值 − 守方空战值（14.3b/e） */
  modifiedRoll: number
  abortSide: AirCombatResultSide
  /** 本轮回基地并转非激活的飞机（14.1c） */
  returnedAttackerIds: string[]
  returnedDefenderIds: string[]
  /** 14.3e-C：损失骰与承受方 */
  lossRoll: number | null
  stepLossIds: string[]
  detail: string
}

export interface AirCombatResolution {
  attackerSide: Side
  rounds: AirCombatRound[]
  /** 结束时仍在该格、保持激活的双方飞机（14.3e-D 的终止状态） */
  survivingAttackerIds: string[]
  survivingDefenderIds: string[]
  /** 终止原因（14.3e-D） */
  stopReason: 'oneSideOnly' | 'noCombatCapability' | 'diceExhausted'
  rule: string
  detail: string
}

/** 取空战值最高者（同值取列表在前者）——攻击方/防守方的**默认**选择（玩家可覆盖） */
function pickHighestAcv(planes: readonly AirCombatAircraftView[]): AirCombatAircraftView {
  return planes.reduce((best, plane) =>
    plane.airCombatRating > best.airCombatRating ? plane : best,
  )
}

/**
 * 14.3e：**空战的逐轮推进**（A–D）
 *
 * - B) 攻击方（14.3c 判定后）从**非括号**空战值的飞机中点一架，防守方点**任意**一架；
 * - C) 攻方掷 2 骰 + 己方空战值 − 守方空战值 → 空战表定返航方，再掷损失骰（5–6 损失 1 军力）；
 * - D) 重复 B/C（每对一轮），直到**一方在该格内成为唯一一方**，或**双方都没有可发起空战的飞机**。
 *
 * 骰面由调用方逐轮注入（种子化 RNG）；点名可选（`picks`），缺省按「空战值最高者」自动选
 * （攻击方在**可发起空战**的飞机中选）。返航者一律回基地转**非激活**（14.1c）。
 */
export function resolveAirCombatRounds(input: {
  attackerSide: Side
  attackerAircraft: readonly AirCombatAircraftView[]
  defenderAircraft: readonly AirCombatAircraftView[]
  dice: readonly { die: number; lossDie?: number }[]
  picks?: readonly { attackerAircraftId?: string; defenderAircraftId?: string }[]
}): RuleOutcome<AirCombatResolution> {
  let attackers = [...input.attackerAircraft]
  let defenders = [...input.defenderAircraft]
  const rounds: AirCombatRound[] = []
  let stopReason: AirCombatResolution['stopReason'] = 'oneSideOnly'

  for (;;) {
    if (attackers.length === 0 || defenders.length === 0) {
      stopReason = 'oneSideOnly'
      break
    }
    const capable = attackers.filter((plane) => plane.canInitiateAirCombat)
    // 14.3e-D：双方都没有可发起空战的飞机 ⇒ 战斗结束（14.3a：互不理睬）
    if (capable.length === 0) {
      stopReason = 'noCombatCapability'
      break
    }
    if (rounds.length >= input.dice.length) {
      stopReason = 'diceExhausted'
      break
    }

    const index = rounds.length
    const dice = input.dice[index]!
    const pick = input.picks?.[index]
    const attacker =
      pick?.attackerAircraftId === undefined
        ? pickHighestAcv(capable)
        : capable.find((plane) => plane.id === pick.attackerAircraftId)
    if (attacker === undefined)
      return fail(
        '14.3e-B',
        `attackerMustPickNonBracketedAircraft:${pick?.attackerAircraftId ?? ''}`,
      )
    const defender =
      pick?.defenderAircraftId === undefined
        ? pickHighestAcv(defenders)
        : defenders.find((plane) => plane.id === pick.defenderAircraftId)
    if (defender === undefined)
      return fail('14.3e-B', `defenderAircraftNotFound:${pick?.defenderAircraftId ?? ''}`)

    const modifiedRoll = airCombatModifiedRoll(
      dice.die,
      attacker.airCombatRating,
      defender.airCombatRating,
    )
    const combat = resolveAirCombat(modifiedRoll, dice.lossDie)
    const returnedAttackerIds =
      combat.abortSide === 'attacker' || combat.abortSide === 'both' ? [attacker.id] : []
    const returnedDefenderIds =
      combat.abortSide === 'defender' || combat.abortSide === 'both' ? [defender.id] : []
    attackers = attackers.filter((plane) => !returnedAttackerIds.includes(plane.id))
    defenders = defenders.filter((plane) => !returnedDefenderIds.includes(plane.id))
    const stepLossIds =
      combat.winnerLossRoll === 'step_loss' ? [...returnedAttackerIds, ...returnedDefenderIds] : []

    rounds.push({
      round: index + 1,
      attackerAircraftId: attacker.id,
      defenderAircraftId: defender.id,
      modifiedRoll,
      abortSide: combat.abortSide,
      returnedAttackerIds,
      returnedDefenderIds,
      lossRoll: combat.rawLossRoll ?? null,
      stepLossIds,
      detail:
        `第 ${index + 1} 轮：${attacker.id}（ACV ${attacker.airCombatRating}）对 ${defender.id}` +
        `（ACV ${defender.airCombatRating}）⇒ 修正骰 ${modifiedRoll} ⇒ ` +
        (combat.abortSide === 'attacker'
          ? '攻击方返航'
          : combat.abortSide === 'defender'
            ? '防守方返航'
            : '双方返航') +
        (combat.winnerLossRoll === 'step_loss' ? `；损失骰 ${combat.rawLossRoll} ⇒ 损失军力` : ''),
    })
  }

  return succeed('14.3e', {
    attackerSide: input.attackerSide,
    rounds,
    survivingAttackerIds: attackers.map((plane) => plane.id),
    survivingDefenderIds: defenders.map((plane) => plane.id),
    stopReason,
    rule: '14.3e',
    detail:
      `空战共 ${rounds.length} 轮；结束原因＝` +
      (stopReason === 'oneSideOnly'
        ? '一方已成该格唯一一方（14.3e-D）'
        : stopReason === 'noCombatCapability'
          ? '双方均无可发起空战的飞机（14.3a）'
          : '骰面用尽（调用方需继续供给骰面）') +
      `；存活：攻方 ${attackers.length} 架 / 守方 ${defenders.length} 架`,
  })
}

/* ────────────────────────────── ⑥ 防空应答（14.4a/e/f） ────────────────────────────── */

/*
 * 14.4f：防空任务损失表的表 id 与其取表只在一处 —— `tables/flak.ts`（`FLAK_MISSION_LOSS_TABLE`
 * 与 `flakMissionLoss`）。本模块不再自持该 id：修前这里另有一份 `'flak-mission-loss'`，
 * 与 `tables/flak.ts` 里那份并存，两处各写一遍同一个表名。
 */

export interface FlakResponse {
  /** 14.4a：该任务是否受防空影响（不受则整段跳过） */
  applies: boolean
  /** 14.4e：影响任务的防空点数（修正骰） */
  drm: number
  /** 修正后的 2 骰 */
  modifiedDie: number
  /** 14.4e：修正后 ≥ 11 ⇒ 命中，一架任务机损失 1 点军力 */
  hit: boolean
  /** 14.4f：承受损失的飞机 id（未命中为 null） */
  lossAircraftId: string | null
  /** 14.4f：任务损失表格值（`#1`–`#4` / `W` 最弱 / `S` 最强，按轰炸值） */
  lossCode: string | null
  rule: string
  detail: string
}

/**
 * 14.4a / 14.4e / 14.4f：防空应答（由**敌方玩家**在 14.2f 的 E 步结算）
 *
 * - 14.4a：先判该任务是否受防空影响（空运/空投/基地转移仅在敌方巡逻区内受影响）；
 * - 14.4e：掷 2 骰 + 防空点数（`computeFlakDrm`，14.4e 表），修正后 **≥ 11** 即命中；
 *   其中「目标格在敌方巡逻区内」这一组按**任务编成里有没有战斗机**分档 +1/+2（表 17-3），
 *   运输破坏再累计 +1；
 * - 14.4f：命中后用**任务损失表**掷 1 骰决定哪架任务机承受损失：
 *   行＝任务机架数（表内 2/3/4 架；1 架时自明即该机），列＝损失骰；格值 `#n` 为输入顺序中的第 n 架，
 *   `W`/`S` 分别为轰炸值最弱/最强者（同值时取先出现者，保证确定性）。
 * - 14.4b：防空从不消耗 SP、也不受补给影响 ⇒ 本函数无补给入参。
 */
export function resolveFlakResponse(input: {
  kind: AirMissionKind
  /** 14.4c：任务格是否在敌方巡逻区内 */
  inEnemyPatrolZone: boolean
  /** 14.4e 表 17-3：**任务**中是否编有战斗机（有 +1 / 无 +2，仅当处于敌方巡逻区内） */
  missionHasFighter?: boolean
  /** 14.4e：任务机架数（≥3 时 +1） */
  missionAircraft: readonly { id: string; barrageStrength: number }[]
  /** 14.4e：目标格内有 HQ（+1） */
  targetHasHQ?: boolean
  /** 14.4e：目标格空军基地等级（每级 +1；简易机场为 0） */
  targetAirBaseLevel?: number
  /** 15.2F：目标格的空中设施是**简易机场**（不能提供任何防空值 ⇒ 防空点数为 0） */
  targetBaseIsAirstrip?: boolean
  /** 14.4e：地图印刷防空值 */
  printedFlakValue?: number
  /** 14.4e：对铁路的运输破坏在敌方巡逻区内（+1） */
  trainbustingInPatrolZone?: boolean
  /** 14.4e：2 骰之和 */
  die2d6: number
  /** 14.4f：损失归属骰（1 骰；未命中时忽略） */
  lossDie?: number
}): FlakResponse {
  const applies = flakAppliesToMission(input.kind, input.inEnemyPatrolZone)
  if (!applies)
    return {
      applies: false,
      drm: 0,
      modifiedDie: input.die2d6,
      hit: false,
      lossAircraftId: null,
      lossCode: null,
      rule: '14.4a',
      detail: `该任务在此情形下不受防空影响（14.4a：${input.kind}）`,
    }

  const drm = computeFlakDrm({
    missionAircraftCount: input.missionAircraft.length,
    targetHasHQ: input.targetHasHQ ?? false,
    airBaseLevel: input.targetAirBaseLevel ?? 0,
    baseIsAirstrip: input.targetBaseIsAirstrip === true,
    printedFlakValue: input.printedFlakValue ?? 0,
    inEnemyPatrolZone: input.inEnemyPatrolZone,
    missionHasFighter: input.missionHasFighter ?? false,
    trainbustingInPatrolZone: input.trainbustingInPatrolZone ?? false,
  })
  const modifiedDie = input.die2d6 + drm
  // 14.4e：修正后 ≥ 阈值 ⇒ 一架任务机损失 1 点军力。阈值只在 `air.ts#flakKillCheck` 一处判
  // （此前此处把 11 写死，常量一改本路径不会跟着变 —— M2 口径收敛）
  const hit = flakKillCheck(modifiedDie)

  if (!hit)
    return {
      applies: true,
      drm,
      modifiedDie,
      hit: false,
      lossAircraftId: null,
      lossCode: null,
      rule: '14.4e',
      detail: `防空：2 骰 ${input.die2d6} + 修正 ${drm} = ${modifiedDie} < 11 ⇒ 防空无效（14.4e）`,
    }

  const loss = resolveFlakLoss(input.missionAircraft, input.lossDie)
  return {
    applies: true,
    drm,
    modifiedDie,
    hit: true,
    lossAircraftId: loss.aircraftId,
    lossCode: loss.code,
    rule: '14.4f',
    detail: `防空：2 骰 ${input.die2d6} + 修正 ${drm} = ${modifiedDie} ≥ 11 ⇒ 命中；任务损失表${
      loss.code === null ? '' : ` 格值 ${loss.code}`
    } ⇒ ${loss.aircraftId} 损失 1 点军力（14.4f）`,
  }
}

/**
 * 14.4f：查**防空任务损失表**（1 骰）确定承受损失的飞机
 *
 * 表的行标是架数（`2 aircraft` / `3 aircraft` / `4 aircraft`），非数值标签，故行号按架数取；
 * 1 架任务机时自明（必为该机，与表不冲突）；列标是损失骰。
 */
export function resolveFlakLoss(
  missionAircraft: readonly { id: string; barrageStrength: number }[],
  lossDie = 1,
): { aircraftId: string | null; code: string | null } {
  if (missionAircraft.length === 0) return { aircraftId: null, code: null }
  if (missionAircraft.length === 1) return { aircraftId: missionAircraft[0]!.id, code: `#1` }

  /*
   * 取表格的**唯一实现**是 `tables/flak.ts#flakMissionLoss`：它按行标 `<N> aircraft` 取行、
   * 按损失骰取列，**行标缺失即抛错**——比此处原先的算术行号（`min(架数, 4) - 2`）更安全：
   * 表的结构一改，算术版会静默取到相邻行，而标签版当场失败。
   * 本函数只保留「格值 → 具体哪一架」这一段映射（'#N' 位置序 / 'W' 最弱 / 'S' 最强）。
   */
  const aircraftCount = Math.min(missionAircraft.length, 4) as 2 | 3 | 4
  const code = flakMissionLoss(aircraftCount, lossDie)

  if (code === 'W' || code === 'S') {
    // W＝最弱（按轰炸值） S＝最强；同值时取先出现者（确定性）
    const picked = missionAircraft.reduce((best, plane) =>
      code === 'W'
        ? plane.barrageStrength < best.barrageStrength
          ? plane
          : best
        : plane.barrageStrength > best.barrageStrength
          ? plane
          : best,
    )
    return { aircraftId: picked.id, code }
  }

  const match = /^#(\d+)$/.exec(code)
  const index = match === null ? 1 : Number(match[1]) - 1
  return { aircraftId: missionAircraft[index]?.id ?? missionAircraft[0]!.id, code }
}

/* ────────────────────────────── ⑫ 14.10d 空运/空投成功检定（C9 补全） ────────────────────────────── */

/** 逐件空运/空投结果（14.10d） */
export interface AirCargoItemResult {
  id: string
  kind: 'sp' | 'unit'
  /** 2 骰和 */
  die2d6: number
  modified: number
  threshold: number
  success: boolean
  /** 14.10d：成功 ⇒ 置于空投格（其本阶段移动结束）；失败 ⇒ 被摧毁 */
  fate: 'placed' | 'destroyed'
  detail: string
}

export interface AirCargoResolution {
  items: AirCargoItemResult[]
  /** 14.10d：落在敌方战斗单位上的货物（一律摧毁） */
  destroyedOnEnemyCombatUnitIds: string[]
  rule: string
  detail: string
}

/**
 * 14.10d：空运/空投的成功检定
 *
 * 「结算防空，然后使用**空运成功表**检查损失。根据任务格的**地形类型**和**空投方式**（滑翔机或伞降），
 *   为**每个战斗单位或 1T 的补给分别掷两枚骰子**。……如果掷骰成功，则将该单位放置在空投格
 *   （并且该单位在此阶段中的移动结束）。如果失败则单位被摧毁。同时摧毁任何试图降落在**敌方战斗单位**
 *   上的货物（但如果该格内只有敌方非战斗单位，则应用 9.14 的相关规则）。」
 *
 * 门槛与 DRM 见表 17-4（苏军空投 −1；滑翔机 +1；可选 21.12e 地形 −1/−2）。
 */
export function resolveAirCargoDrop(input: {
  cargo: readonly AirMissionCargo[]
  /** 表 17-4：目标格在**本阶段开始时**是否有友方单位（决定 Friendly / Enemy 列） */
  friendlyAtPhaseStart: boolean
  /** 表 17-4：目标格地形是否为 Closed（见 `airTransportTerrainIsClosed`） */
  closedTerrain: boolean
  /** 任务方（苏军空投 −1，表 17-4） */
  side: Side
  /** 14.10e-E：滑翔机降落（+1） */
  glider?: boolean
  /** 可选 21.12e 的地形修正（`optionalAirdropTerrainDrm`） */
  optionalTerrainDrm?: number
  /** 14.10d：目标格内是否有**敌方战斗单位**（在其上着陆的货物被摧毁） */
  enemyCombatUnitInHex?: boolean
  /** 逐件 2 骰之和（顺序与 `cargo` 一致；缺件即失败——骰面必须由调用方给全） */
  dice: readonly number[]
}): RuleOutcome<AirCargoResolution> {
  const items: AirCargoItemResult[] = []
  const destroyedOnEnemyCombatUnitIds: string[] = []

  for (const [index, item] of input.cargo.entries()) {
    const die2d6 = input.dice[index]
    if (die2d6 === undefined) return fail('14.10d', `missingCargoDice:${item.id}`)
    const roll = resolveAirTransportSuccess({
      die2d6,
      friendly: input.friendlyAtPhaseStart,
      closed: input.closedTerrain,
      // 表 17-4：苏军空投任何时间 −1
      ...(input.side === 'soviet' ? { sovietAirdrop: true } : {}),
      ...(input.glider === true ? { glider: true } : {}),
      ...(input.optionalTerrainDrm === undefined
        ? {}
        : { optionalTerrainDrm: input.optionalTerrainDrm }),
    })
    const onEnemyCombatUnit = input.enemyCombatUnitInHex === true
    if (onEnemyCombatUnit) destroyedOnEnemyCombatUnitIds.push(item.id)
    const success = roll.success && !onEnemyCombatUnit
    items.push({
      id: item.id,
      kind: item.kind,
      die2d6,
      modified: roll.modified,
      threshold: roll.threshold,
      success,
      fate: success ? 'placed' : 'destroyed',
      detail: onEnemyCombatUnit
        ? `${item.id}：降在敌方战斗单位上 ⇒ 摧毁（14.10d）`
        : `${item.id}：2 骰 ${die2d6}${roll.drm === 0 ? '' : ` ${roll.drm > 0 ? '+' : ''}${roll.drm}`}` +
          ` = ${roll.modified} vs ≥${roll.threshold} ⇒ ${success ? '成功置入空投格（本阶段移动结束）' : '失败被摧毁'}（14.10d）`,
    })
  }

  const placed = items.filter((item) => item.fate === 'placed').length
  return succeed('14.10d', {
    items,
    destroyedOnEnemyCombatUnitIds,
    rule: '14.10d',
    detail: `空投检定：${items.length} 件中成功 ${placed} 件、摧毁 ${items.length - placed} 件（表 17-4）`,
  })
}

/**
 * 14.10d：任务流程 **F 步（结算任务）** 的空投/空运检定入口
 *
 * 调用后状态停留在 `resolveMission` 步（与 `confirmMissionStep` 配合使用）。
 */
export function resolveAirCargoStep(
  state: AirInteractionState,
  input: {
    friendlyAtPhaseStart: boolean
    closedTerrain: boolean
    glider?: boolean
    optionalTerrainDrm?: number
    enemyCombatUnitInHex?: boolean
    dice: readonly number[]
  },
): RuleOutcome<{ state: AirInteractionState; cargo: AirCargoResolution }> {
  if (state.step !== 'resolveMission')
    return fail('14.2f-F', `notAtResolveMissionStep:${state.step}`)
  if (state.kind !== 'air_transport' && state.kind !== 'air_drop')
    return fail('14.10d', `missionHasNoCargo:${state.kind}`)
  const cargo = resolveAirCargoDrop({
    cargo: state.assignment.cargo,
    side: state.side,
    friendlyAtPhaseStart: input.friendlyAtPhaseStart,
    closedTerrain: input.closedTerrain,
    ...(input.glider === undefined ? {} : { glider: input.glider }),
    ...(input.optionalTerrainDrm === undefined
      ? {}
      : { optionalTerrainDrm: input.optionalTerrainDrm }),
    ...(input.enemyCombatUnitInHex === undefined
      ? {}
      : { enemyCombatUnitInHex: input.enemyCombatUnitInHex }),
    dice: input.dice,
  })
  if (!cargo.ok) return cargo
  return succeed('14.10d', { state: { ...state, cargo: cargo.data }, cargo: cargo.data })
}

/* ────────────────────────────── ⑦ 整备额度（15.1 / 15.2B / 14.2a） ────────────────────────────── */

export interface BaseRefitPlan {
  baseId: string
  hex: HexRef
  capacity: number
  costT: number
  /** 15.1B：本次实际整备（转为激活）的飞机 id */
  activateAircraftIds: string[]
  /** 14.2a：整备后的激活堆叠数（须 ≤ 4 + 等级） */
  activeAfter: number
  stackingLimit: number
  rule: string
  detail: string
}

/**
 * 15.1 / 15.2B / 14.2a：一个基地的整备
 *
 * 判定链：★**归属**（15.1/15.4：只在**本方**基地）→ 阶段/每基地一次/ZOC/容量/T（复用 `air-mission.ts`
 * 的 `refitEligibility`）→ **14.2a 激活堆叠不得超限**（整备会把非激活转为激活，故须校验 4+等级）。
 *
 * 15.1B：费用 1T **与等级和架数无关**；每个空军单位都算一架（含减损单位）。
 * 15.1D：天气从不禁止整备 ⇒ 本函数无天气入参。
 *
 * 注意 1T 的来源：15.1 只规定费用，取用仍走 12.3 的补给渠道（拖取/投递）——调用方须用
 * `supply-interaction` / `trace-supply` 判定后把可动用的 T 传入 `availableT`（本模块不猜补给）。
 */
export function planBaseRefit(input: {
  base: AirBaseView
  side: Side
  phase: GamePhase
  /** 该基地格内**非激活**的飞机（15.1B：由玩家选择整备哪些） */
  inactiveAircraft: readonly { id: string; side: Side }[]
  /** 该基地格内当前的激活飞机数（14.2a 堆叠校验用） */
  activeAircraftInBase: number
  /** 请求整备的架数 */
  requested: number
  /** 本基地可动用的 T（经 12.3 补给渠道取得） */
  availableT: number
}): RuleOutcome<BaseRefitPlan> {
  // ★ 基地归属权：整备只能在本方空军基地进行
  if (!isFriendlyAirBase(input.base, input.side))
    return fail('15.1', `refitAtEnemyAirBase:${input.base.id}`)

  const own = input.inactiveAircraft.filter((plane) => plane.side === input.side)
  if (own.length === 0) return fail('15.1B', 'noInactiveAircraftAtBase')
  if (input.requested <= 0) return fail('15.1B', 'nothingRequestedToRefit')
  if (input.requested > own.length)
    return fail('15.1B', `notEnoughInactiveAircraft:${input.requested}>${own.length}`)

  const eligibility = refitEligibility({
    isAirstrip: input.base.isAirstrip === true,
    isAirBox: input.base.isAirBox === true,
    level: input.base.level,
    phase: input.phase,
    alreadyRefitThisPhase: input.base.refitDoneThisPhase === true,
    inUnnegatedEnemyZoc: input.base.inUnnegatedEnemyZoc === true,
    requestedAircraft: input.requested,
    availableT: input.availableT,
  })
  if (!eligibility.ok) return eligibility

  // 14.2a：整备后该基地格的激活堆叠不得超限（4 + 等级；简易机场恒 4）
  const stackingLimit = activeStackingLimitOf(input.base)
  const activeAfter = input.activeAircraftInBase + input.requested
  if (activeAfter > stackingLimit)
    return fail('14.2a', `activeStackingLimitExceeded:${activeAfter}>${stackingLimit}`)

  return succeed('15.1', {
    baseId: input.base.id,
    hex: input.base.hex,
    capacity: eligibility.data.capacity,
    costT: eligibility.data.costT,
    activateAircraftIds: own.slice(0, input.requested).map((plane) => plane.id),
    activeAfter,
    stackingLimit,
    rule: '15.1',
    detail:
      `整备 ${input.requested} 架（容量 ${eligibility.data.unlimited ? '∞' : eligibility.data.capacity}，` +
      `费用 ${eligibility.data.costT} T）；整备后激活 ${activeAfter}/${stackingLimit}（14.2a）`,
  })
}

/* ────────────────────────────── ⑧ 基地转移（14.11 + 14.1c） ────────────────────────────── */

export interface BaseTransferPlan {
  aircraftId: string
  fromHex: HexRef
  toHex: HexRef
  distanceHexes: number
  maxDistanceHexes: number
  /** 14.11：战斗机在正常距离内保持激活，其余一律非激活 */
  airStatus: AirStatus
  rule: string
  detail: string
}

/**
 * 14.11 + 14.1c：基地转移
 *
 * 「基地转移是将飞机从一个基地转移到另一个基地的简单方法」；距离可**加倍**；
 * 战斗机在**正常距离内**完成转移 ⇒ 保持激活，超出 ⇒ 非激活（其他机种一律非激活）。
 * ★ 归属：起飞与落地两头都必须是**本方**空军基地（14.1c：返航须回友方基地）；
 * 若转移后仍激活，还须满足目标基地 14.2a 的激活堆叠上限。
 */
export function planBaseTransfer(input: {
  side: Side
  aircraft: { id: string; isFighter: boolean; rangeHexes: number }
  fromBase: AirBaseView
  toBase: AirBaseView
  /** 14.2a：目标基地格内当前的激活飞机数 */
  activeAircraftAtDestination: number
}): RuleOutcome<BaseTransferPlan> {
  if (!isFriendlyAirBase(input.fromBase, input.side))
    return fail('14.11', `transferFromEnemyAirBase:${input.fromBase.id}`)
  if (!isFriendlyAirBase(input.toBase, input.side))
    return fail('14.11', `transferToEnemyAirBase:${input.toBase.id}`)

  const distanceHexes = hexDistance(input.fromBase.hex, input.toBase.hex)
  const transfer = resolveBaseTransfer({
    isFighter: input.aircraft.isFighter,
    rangeHexes: input.aircraft.rangeHexes,
    distanceHexes,
  })
  if (!transfer.ok) return transfer

  // 14.2a：若落地后仍为激活（战斗机在正常射程内），目标基地的激活堆叠须未超限
  if (transfer.data.airStatus === 'active') {
    const limit = activeStackingLimitOf(input.toBase)
    const after = input.activeAircraftAtDestination + 1
    if (after > limit) return fail('14.2a', `activeStackingLimitExceeded:${after}>${limit}`)
  }

  return succeed('14.11', {
    aircraftId: input.aircraft.id,
    fromHex: input.fromBase.hex,
    toHex: input.toBase.hex,
    distanceHexes,
    maxDistanceHexes: transfer.data.maxDistanceHexes,
    airStatus: transfer.data.airStatus,
    rule: '14.11',
    detail:
      `基地转移 ${distanceHexes} 格（上限 ${transfer.data.maxDistanceHexes} = 航程 ×2，14.11）` +
      ` ⇒ ${transfer.data.airStatus === 'active' ? '战斗机在正常距离内，保持激活' : '变为非激活'}（14.11）`,
  })
}

/* ────────────────────────────── ⑨ 基地缩减（15.4 + 15.2E） ────────────────────────────── */

export interface AirBaseReductionPlan {
  baseId: string
  hex: HexRef
  levelAfter: number
  /** 15.4：只有这批被指定的单位本阶段不能再移动（格内其余单位照常行动） */
  immobileUnitIds: string[]
  rule: string
  detail: string
}

/**
 * 15.4 / 15.2E：空军基地缩减
 *
 * 「空军基地只能在移动阶段中缩减。需要 1RE 的单位，处于战斗模式，且不能移动，即可将空军基地缩减一个等级。
 *   具有工程能力的单位也能完成这项工作（13.8d）。缩减无需 SP 费用。…… 同一个**友方**空军基地在一个阶段
 *   只能被缩减一次。…… 空军基地永远不能降到低于一级。」
 *
 * ★ 归属：只能缩减**本方**基地；15.2E：简易机场**永不**因伤害或自愿而缩减。
 * 具体资格（阶段/等级下限/被指定单位 RE 合计≥1 或工程能力/逐员战斗模式且未移动/每阶段一次）
 * 交给 `air-mission.ts` 的 `canReduceAirBase`（唯一实现），本函数只补归属与简易机场两条。
 */
export function planAirBaseReduction(input: {
  side: Side
  base: AirBaseView
  phase: GamePhase
  /** 15.4：格内**被指定**执行本次缩减的单位（堆叠的子集；多不退、少必须补） */
  operatingUnits: readonly AirBaseOperatingUnit[]
}): RuleOutcome<AirBaseReductionPlan> {
  if (!isFriendlyAirBase(input.base, input.side))
    return fail('15.4', `reduceEnemyAirBase:${input.base.id}`)
  /*
   * 15.2E：简易机场**永远**不会被缩减降级（伤害或玩家自愿都不行）。
   * 「永远」这个常量只有一处（`construction.canReduceAirstrip`），故此处不再写第二份 `isAirstrip` 判据。
   */
  if (input.base.isAirstrip === true && !canReduceAirstrip())
    return fail('15.2E', 'airstripCannotBeReduced')

  const verdict = canReduceAirBase({
    phase: input.phase,
    currentLevel: input.base.level,
    operatingUnits: input.operatingUnits,
    alreadyReducedThisPhase: input.base.reducedThisPhase === true,
  })
  if (!verdict.ok) return verdict

  return succeed('15.4', {
    baseId: input.base.id,
    hex: input.base.hex,
    levelAfter: verdict.data.levelAfter,
    immobileUnitIds: verdict.data.immobileUnitIds,
    rule: '15.4',
    detail: `基地降级 ${input.base.level} → ${verdict.data.levelAfter}（15.4：不耗 SP）；被指定单位本阶段不能再移动`,
  })
}

/* ────────────────────────────── ⑩ 任务交互状态机（14.2f A–G） ────────────────────────────── */

/** 交互步骤＝14.2f 的 A–G 七步 + 结束（与 `air-mission.ts` 的步骤 id 同源） */
export const AIR_INTERACTION_STEPS = [...AIR_MISSION_STEP_IDS, 'done'] as const
export type AirInteractionStep = (typeof AIR_INTERACTION_STEPS)[number]

/** 步骤中文名（供界面清单；A–G 的说明取自 14.2f 原文） */
export const AIR_INTERACTION_STEP_LABELS: Record<AirInteractionStep, string> = {
  declare: '宣布任务类型（14.2f-A）',
  move: '飞机飞往任务格（14.2f-B）',
  airCombat: '结算空战（14.2f-C / 14.3）',
  interception: '结算拦截（14.2f-D / 14.5）',
  flak: '结算防空（14.2f-E / 14.4）',
  resolveMission: '结算任务（14.2f-F）',
  returnToBase: '返航（14.2f-G / 14.1c）',
  done: '结束',
}

/** 14.2f 的机器可读步骤清单（供界面按序提示；note 原文见 air-mission.ts） */
export const AIR_INTERACTION_SEQUENCE = AIR_MISSION_SEQUENCE

/** 该步骤是否**已到达**（`step` 是「下一步待办」，与 C6/C7/C8 同语义） */
export function hasReachedAirInteractionStep(
  state: AirInteractionState,
  step: AirInteractionStep,
): boolean {
  return AIR_INTERACTION_STEPS.indexOf(state.step) >= AIR_INTERACTION_STEPS.indexOf(step)
}

/** 界面用的步骤清单 */
export function airInteractionChecklist(
  state: AirInteractionState,
): { step: AirInteractionStep; label: string; done: boolean }[] {
  return AIR_INTERACTION_STEPS.map((step) => ({
    step,
    label: AIR_INTERACTION_STEP_LABELS[step],
    done: AIR_INTERACTION_STEPS.indexOf(step) < AIR_INTERACTION_STEPS.indexOf(state.step),
  }))
}

/** 本次任务的空战环节结论 */
export interface AirInteractionCombatStep {
  roles: AirCombatRoles
  /** 14.3：任务格内是否有敌方空军基地（无 ⇒ 不发生空战） */
  enemyAirBaseInHex: boolean
  occurs: boolean
}

export interface AirInteractionState {
  /** 下一步待办 */
  step: AirInteractionStep
  side: Side
  phase: GamePhase
  kind: AirMissionKind
  targetHex: HexRef
  /** 14.2f-A/B：任务分配结论 */
  assignment: AirMissionAssignment
  /** 14.2f-C：空战环节（未到该步为 null） */
  combat: AirInteractionCombatStep | null
  /** 14.3e：空战的**逐轮结算**结论（发生了空战且已推进后填入） */
  airCombat: AirCombatResolution | null
  /** 14.2f-D：拦截应答（拦截方视角的资格 + 是否真的拦） */
  interception: {
    response: InterceptionResponse
    /** 拦截方是否决定拦截 */
    declared: boolean
    /** 实际出动的拦截机 id（declared=false 时为 null） */
    interceptorId: string | null
    combat: InterceptionCombatResult | null
  } | null
  /** 14.2f-E：防空应答 */
  flak: FlakResponse | null
  /** 14.10d：空运/空投的成功检定（仅空运/空投任务；未做时为 null） */
  cargo: AirCargoResolution | null
  /** 14.2f-F：任务本身的结果说明（由调用方写入，如 C7 轰炸结论） */
  missionNote: string | null
  /** 14.2f-G：逐机返航的目的地（14.1c：须为本方基地） */
  returns: { aircraftId: string; baseHex: HexRef }[]
  finished: boolean
}

/**
 * 14.2f-A/B：开始一次任务交互
 *
 * 先做任务分配（`assignAirMission`），成功即落在 14.2f-C（空战）步。
 */
export function beginAirInteraction(input: AirMissionRequest): RuleOutcome<AirInteractionState> {
  const assignment = assignAirMission(input)
  if (!assignment.ok) return assignment
  return succeed(assignment.data.rule, {
    step: 'airCombat',
    side: input.side,
    phase: input.phase,
    kind: input.kind,
    targetHex: input.targetHex,
    assignment: assignment.data,
    combat: null,
    airCombat: null,
    interception: null,
    flak: null,
    cargo: null,
    missionNote: null,
    returns: [],
    finished: false,
  })
}

/**
 * 14.2f-C / 14.3：结算空战环节
 *
 * 判两件事：任务格内是否有**敌方**空军基地且双方都有激活飞机（14.3：不满足则根本不发生空战）；
 * 若发生，按 14.3c 定攻守角色（攻击方全为括号空战值 ⇒ 互换；双方全为括号值 ⇒ 不发生）。
 */
export function declareAirCombatStep(
  state: AirInteractionState,
  input: {
    /** 任务格内的**本方**激活飞机（用于判「是否至少 1 架能发起空战」） */
    friendlyAircraft: readonly AirMissionAircraftView[]
    /** 任务格内的**敌方**激活飞机数 */
    enemyActiveCount: number
    /** 敌方这些飞机中是否至少 1 架能发起空战（14.3a：带括号空战值者不能） */
    enemyCanInitiate: boolean
    /** 任务格内是否有敌方空军基地（★ 归属权：只有敌方基地才算敌方据点） */
    enemyAirBaseInHex: boolean
  },
): RuleOutcome<{ state: AirInteractionState }> {
  if (state.step !== 'airCombat') return fail('14.2f-C', `notAtAirCombatStep:${state.step}`)
  const occurs = airCombatOccursAt({
    friendlyActiveCount: input.friendlyAircraft.length,
    enemyActiveCount: input.enemyActiveCount,
    enemyAirBaseInHex: input.enemyAirBaseInHex,
  })
  const roles = airCombatAttackerSide({
    initiatorSide: state.side,
    attackerCanInitiate: input.friendlyAircraft.some((plane) => plane.canInitiateAirCombat),
    defenderCanInitiate: input.enemyCanInitiate,
  })
  return succeed(occurs ? roles.rule : '14.3', {
    state: {
      ...state,
      combat: {
        roles,
        enemyAirBaseInHex: input.enemyAirBaseInHex,
        occurs: occurs && !roles.noCombat,
      },
      step: 'interception',
    },
  })
}

/**
 * 14.2f-D / 14.5：拦截应答（由**对手**决定是否拦截）
 *
 * 不强制拦截；声明拦截时必须给出一架合格的战斗机（`planInterceptionResponse` 的候选之一）。
 */
export function declareInterceptionStep(
  state: AirInteractionState,
  input: {
    response: InterceptionResponse
    /** 拦截方是否决定拦截 */
    declared: boolean
    /** 出动的拦截机 id（declared=true 时必填） */
    interceptorId?: string
  },
): RuleOutcome<{ state: AirInteractionState }> {
  if (state.step !== 'interception') return fail('14.2f-D', `notAtInterceptionStep:${state.step}`)
  if (input.declared) {
    if (!input.response.eligible)
      return fail('14.5', input.response.reason ?? 'notEligibleToIntercept')
    if (input.interceptorId === undefined) return fail('14.5', 'interceptorNotChosen')
    if (!input.response.eligibleFighterIds.includes(input.interceptorId))
      return fail('14.5', `interceptorNotEligible:${input.interceptorId}`)
  }
  return succeed('14.5', {
    state: {
      ...state,
      interception: {
        response: input.response,
        declared: input.declared,
        interceptorId: input.declared ? (input.interceptorId ?? null) : null,
        combat: null,
      },
      step: 'flak',
    },
  })
}

/**
 * 14.4f：该机**此刻**的运输容量（T）—— 完好（steps ≥ 2）取正面印值；减损（1 step）取**减损面**
 *
 * 「剩下一 点军力的飞机将使用其**减少后的数值**来完成任务。」减损面的容量由数据给出
 * （`transportCapacityBack`）；数据缺该值即视为与正面相同（不自造折半规则）。
 */
export function transportCapacityOf(plane: {
  transportCapacity?: number
  transportCapacityBack?: number | null
  steps?: number
}): number {
  const front = plane.transportCapacity ?? 0
  if ((plane.steps ?? 2) >= 2) return front
  return plane.transportCapacityBack ?? front
}

/**
 * 14.4g：防空致**货容量变化**后重算可用装载量
 *
 * 「如果运输任务的货物容量因防空而发生变化，则**重新计算可用的装载量**（注意 14.9e 的距离效果），
 *   并根据新的容量，**摧毁超出部分**的货物（**由玩家自主选择**）。**取整时，按有利于货物存留的方式取整**
 *   （举例，如果运输 1T 的货物，而飞机容量从 1T 下降到 1/2T，则按 1T 取整，使 1T 的货物存留并可成功抵达目的地）。」
 *
 * ★ 取整口径：可用装载量 ＝ `Math.ceil(容量)` —— 这正是 14.9b 的例外（「1/2T 的容量……**不能取整为 1T**。
 *   例外：**货物损失**，14.4g」）：正常装载时 1/2T 就是 1/2T，只有在**货物损失**这一场景才向上取整。
 */
export function planCargoLoss(input: {
  /** 当前任务货物（每件的运输当量 T） */
  cargo: readonly { id: string; t: number }[]
  /** 防空结算**之后**该任务的总容量（已按 14.9e 的距离效果折算、按 14.4f 取减损面） */
  capacityAfter: number
}): RuleOutcome<{
  loadedT: number
  allowedT: number
  excessT: number
  rule: '14.4g'
  detail: string
}> {
  if (!Number.isFinite(input.capacityAfter) || input.capacityAfter < 0)
    return fail('14.4g', `badCapacityAfter:${input.capacityAfter}`)
  const loadedT = input.cargo.reduce((sum, item) => sum + item.t, 0)
  const allowedT = Math.ceil(input.capacityAfter)
  const excessT = Math.max(0, loadedT - allowedT)
  return succeed('14.4g', {
    loadedT,
    allowedT,
    excessT,
    rule: '14.4g',
    detail:
      `防空后容量 ${input.capacityAfter} T ⇒ 可用装载量按**有利于货物存留**取整为 ${allowedT} T` +
      `（载货 ${loadedT} T；` +
      (excessT > 0 ? `须摧毁超出部分 ${excessT} T，由玩家选择摧毁哪几件` : '无超出部分') +
      '）',
  })
}

/**
 * 14.4g：校验玩家选定的**摧毁清单**（摧毁量必须覆盖超出部分）
 *
 * 「根据新的容量，**摧毁超出部分**的货物（由玩家自主选择）」⇒ 玩家选哪几件由他定，
 * 但**摧毁掉的运输当量**不得少于超出量；`planCargoLoss` 的取整口径（`ceil`）先在此沿用。
 */
export function validateCargoLossChoice(input: {
  cargo: readonly { id: string; t: number }[]
  capacityAfter: number
  destroyedIds: readonly string[]
}): RuleOutcome<{ destroyedT: number; excessT: number; rule: '14.4g'; detail: string }> {
  const plan = planCargoLoss({ cargo: input.cargo, capacityAfter: input.capacityAfter })
  if (!plan.ok) return plan
  const known = new Set(input.cargo.map((item) => item.id))
  for (const id of input.destroyedIds) {
    if (!known.has(id)) return fail('14.4g', `unknownCargoItem:${id}`)
  }
  if (new Set(input.destroyedIds).size !== input.destroyedIds.length)
    return fail('14.4g', 'duplicateCargoItem')
  const destroyedT = input.cargo
    .filter((item) => input.destroyedIds.includes(item.id))
    .reduce((sum, item) => sum + item.t, 0)
  if (destroyedT < plan.data.excessT)
    return fail('14.4g', `cargoLossTooSmall:${destroyedT}<${plan.data.excessT}`)
  return succeed('14.4g', {
    destroyedT,
    excessT: plan.data.excessT,
    rule: '14.4g',
    detail:
      `按新容量摧毁 ${destroyedT} T 货物（超出部分 ${plan.data.excessT} T` +
      `${destroyedT > plan.data.excessT ? '，玩家选择多摧毁的部分一并计入' : ''}）`,
  })
}

/** 14.2f-E / 14.4：防空应答（掷骰与损失归属由调用方给出骰面） */
export function resolveFlakStep(
  state: AirInteractionState,
  input: {
    inEnemyPatrolZone: boolean
    missionHasFighter?: boolean
    missionAircraft: readonly { id: string; barrageStrength: number }[]
    targetHasHQ?: boolean
    targetAirBaseLevel?: number
    /** 15.2F：目标格是简易机场（不能提供任何防空值） */
    targetBaseIsAirstrip?: boolean
    printedFlakValue?: number
    trainbustingInPatrolZone?: boolean
    die2d6: number
    lossDie?: number
  },
): RuleOutcome<{ state: AirInteractionState; flak: FlakResponse }> {
  if (state.step !== 'flak') return fail('14.2f-E', `notAtFlakStep:${state.step}`)
  const flak = resolveFlakResponse({ kind: state.kind, ...input })
  return succeed(flak.rule, { state: { ...state, flak, step: 'resolveMission' }, flak })
}

/** 14.2f-F：记录任务本身的结果（如 C7 轰炸结论），随后进入返航步 */
export function confirmMissionStep(
  state: AirInteractionState,
  input: { note: string },
): RuleOutcome<{ state: AirInteractionState }> {
  if (state.step !== 'resolveMission')
    return fail('14.2f-F', `notAtResolveMissionStep:${state.step}`)
  return succeed('14.2f-F', {
    state: { ...state, missionNote: input.note, step: 'returnToBase' },
  })
}

/**
 * 14.2f-G / 14.1c：返航
 *
 * 逐机指定目的地，并校验：目的地须是**本方**空军基地（★ 归属权）、且在该机航程内（14.2d）。
 * 成功即落 `done`。返航后是否保持激活由 14.1c 的例外决定（成功拦截的拦截机、正常距离内转移的战斗机），
 * 常规任务返航一律非激活 —— 由调用方按 `stayActiveIds` 显式声明例外。
 *
 * ★ 第五批批 C 切片 2（14.9e）：**空运/空投任务**的返航距离按**档位**收紧
 *   （C 档「返回其**距离一半**内的任何空军基地」、B 档正常航程）；**A 档（双程飞法）不返航** ——
 *   该机「在**目的地空军基地**变为非激活」⇒ 出现在 `returns` 里即拒，并在 `stayedAircraftIds`
 *   列出（调用方据此把它落在目的地并置非激活）。其余任务类型保持 14.2d 的正常航程口径。
 */
export function completeAirReturnStep(
  state: AirInteractionState,
  input: {
    returns: readonly { aircraftId: string; baseHex: HexRef }[]
    /** 全图空军基地（用于返航目的地的**归属**判定） */
    bases: readonly AirBaseView[]
    /** 14.1c 例外：返航后仍保持激活的飞机（如成功拦截的战斗机） */
    stayActiveIds?: readonly string[]
  },
): RuleOutcome<{
  state: AirInteractionState
  inactiveAircraftIds: string[]
  /** 14.9e-A：双程档机（不返航、留在目的地并变非激活）的 id 列表 */
  stayedAircraftIds: string[]
}> {
  if (state.step !== 'returnToBase') return fail('14.2f-G', `notAtReturnToBaseStep:${state.step}`)

  const byId = new Map(state.assignment.origins.map((item) => [item.aircraftId, item]))
  const stayActive = input.stayActiveIds ?? []
  const inactiveAircraftIds: string[] = []
  const stayedAircraftIds: string[] = []
  const isCargoMission = state.kind === 'air_transport' || state.kind === 'air_drop'
  const profileOf = (origin: { distanceHexes: number; rangeHexes: number }) =>
    airTransportProfile({ distanceHexes: origin.distanceHexes, rangeHexes: origin.rangeHexes })

  // 14.9e-A：双程档机**不得返航**（出现在 returns 即拒；缺省时列入 stayed）
  if (isCargoMission) {
    for (const origin of state.assignment.origins) {
      if (profileOf(origin).profile !== 'A') continue
      if (input.returns.some((item) => item.aircraftId === origin.aircraftId))
        return fail('14.9e-A', `twoWayAircraftMustStayAtDestination:${origin.aircraftId}`)
      stayedAircraftIds.push(origin.aircraftId)
      // 「在目的地空军基地**变为非激活**」⇒ 与常规返航同列（调用方统一置非激活）
      if (!stayActive.includes(origin.aircraftId)) inactiveAircraftIds.push(origin.aircraftId)
    }
  }

  for (const item of input.returns) {
    const origin = byId.get(item.aircraftId)
    if (origin === undefined) return fail('14.2f-G', `unknownMissionAircraft:${item.aircraftId}`)

    /*
     * 专规 1.4a：自**图外空军盒**起飞的飞机，返航即**回盒**（盒本身就是空军基地，容量无限）。
     * ⇒ 不要求"返航点是图上空军基地"；出击时已按 `盒航程 + 列差 ≤ 印刷航程` 校验过，
     *   返航同一距离，必然在航程内（用户 2026-10-30 口径：不可能没有空军基地，至少有图外的）。
     */
    if (origin.fromOffMapBox === true) {
      if (!stayActive.includes(item.aircraftId)) inactiveAircraftIds.push(item.aircraftId)
      continue
    }

    // ★ 14.1c：返航必须回到**本方**空军基地
    const base = airBaseAt(input.bases, item.baseHex)
    if (base === null) return fail('14.1c', `returnHexNotAirBase:${item.aircraftId}`)
    if (!isFriendlyAirBase(base, state.side))
      return fail('14.1c', `returnToEnemyAirBase:${item.aircraftId}`)

    // 14.2d / 14.9e：返航距离 —— 空运/空投按**档位**（C 档限半程），其余任务按正常航程
    const distanceHexes = hexDistance(state.targetHex, base.hex)
    if (isCargoMission) {
      const profile = profileOf(origin)
      if (distanceHexes > profile.returnRangeHexes)
        return fail(
          profile.profile === 'C' ? '14.9e-C' : '14.1c',
          profile.profile === 'C'
            ? `returnBeyondProfileRange:${item.aircraftId}:${distanceHexes}>${profile.returnRangeHexes}`
            : `returnOutOfRange:${item.aircraftId}:${distanceHexes}>${origin.rangeHexes}`,
        )
    } else if (distanceHexes > origin.rangeHexes) {
      return fail(
        '14.1c',
        `returnOutOfRange:${item.aircraftId}:${distanceHexes}>${origin.rangeHexes}`,
      )
    }

    if (!stayActive.includes(item.aircraftId)) inactiveAircraftIds.push(item.aircraftId)
  }

  return succeed('14.1c', {
    state: { ...state, returns: [...input.returns], step: 'done', finished: true },
    inactiveAircraftIds,
    stayedAircraftIds,
  })
}
