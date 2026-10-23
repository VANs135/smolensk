import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'

import { fail, succeed, type RuleFailure, type RuleOutcome } from '../result-types'
import type { GamePhase } from '../state-types'
import {
  RAIL_CONVERSION_MAX_PER_PHASE,
  RAIL_MULTI_TRACK_MULTIPLIER,
  RAIL_PRE_LOAD_MA_FRACTION,
  RAIL_SHORT_LEG_EQUIVALENT_MULTIPLIER,
  RAIL_SHORT_LEG_MA_MAX,
  RAIL_SHORT_LEG_MA_MIN,
  RAIL_TRAINBUSTING_MULTIPLIER,
  computeLoadingCost,
} from './movement'
import type { BaseMode, Orientation } from './modes'
import type { MobilityType } from './terrain'

/**
 * 铁路运输与运输点数（B8，OCS 13.2 / 13.3 / 4.7 / 13.9）
 *
 * 覆盖四件事，全部为纯函数（玩家决策与运行期事实作为入参给出，故可脱离整局状态独立测试）：
 *   ① **铁路容量与运输当量**（4.7 / 13.3a / 13.3b）：1 点容量 = 1 SP 或 1 RE；破坏区加倍、全程多轨减半，
 *      短腿（步行 MA 1–6）单位当量减半；
 *   ② **铁路移动三步**（13.3e / 13.3g）：登车 → 沿铁路移动 → 卸货，**三步必须同一阶段完成**（本模块一次调用即含三步，
 *      故天然同阶段）；登车格/卸货格须为可火车卸货格且不在敌方 ZOC，路径须相连、轨距正确、受控、无敌方单位与 ZOC。
 *      铁路修理单位有三处例外（13.3g）：可在**战斗模式**下铁路移动（13.3g-B，5.5a/5.6a 例外）、
 *      可在**任意铁路格**登车与卸货（13.3g-C）、且**卸货后仍可按「完整 MA − 登车前移动」继续移动**
 *      （13.3g-B；4.7d 的「卸货后不得再移动」对它们不适用）；
 *   ③ **轨距转换**（13.3f / 13.3g）：仅铁路修理单位可做，敌方 ZOC 内不可转换（不可抵消），
 *      每移动阶段至多 4 格（当前 MA 更小则取 MA），且不得「接力」；另含**剧本初设换轨**的逐格推导
 *      （专规 1.2 剧本页只给端点，见 `convertedRailRun`）；
 *   ④ **运输点数的装载卸货与合并拆分**（13.2c / 13.2f）：装载/卸载各耗印刷 MA 的 10%（4.2 取整），
 *      合并/拆分不耗 MP、仅友方移动阶段、同类型且同格。
 *
 * ## 与既有模块的分工（不重复实现）
 *   - 铁路容量数值：`rail-cap.ts#getRailCap`（13.3b / 专规 1.2 的日期闸门）；
 *   - 4.2 取整：`combat.ts#roundHalfUp`（与攻防比同口径）；装载费与容量费都走它；
 *   - 4.5/4.5b 的 ZOC 判定：`zoc.ts`（★ 运货时敌方 ZOC **不可抵消**，见 13.3c 末句）；
 *   - 可火车卸货格的三条判据（13.3c）由事实提供者给出，本模块只消费结论（不臆造铁路连通性）。
 *
 * ## 数据接口
 *   运行期事实（控制 / 轨距 / EZOC / 敌方单位 / 可卸货格 / 破坏区）由 `RailFacts` 注入；
 *   静态铁路图层（哪格有铁路、两格是否以铁路相接、该格边单轨还是多轨）由 `createRailFacts`
 *   从产品数据 map-layers.json 建索引。
 *
 * ## 明确不由本模块负责（避免过度声称）
 *   - **13.3c 的「铁路路径免 EZOC 回到补给源」**：属补给网判定，由补给层/事实提供者算出「是否可卸货」后注入；
 *   - **13.3h 控制权**：随前线与敌方单位移动而变的运行期状态，由状态层给出 `isControlled`；
 *   - **13.3d 铁路端头标记**：地图上的轨距分界标记属记录轨式记账（谁把端头推到哪），
 *     其机制已由 13.3f/g 的轨距转换覆盖，标记位置不在引擎建模范围；
 *   - **4.7d 的「同一阶段不能使用超过一种运输类型」**：跨动作的阶段级记账，须由命令层在阶段内累计
 *     （本模块是无状态纯函数，只判单次铁路移动本身）。
 */

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 4.7a：1 点铁路容量可运 1 SP 或 1 RE（任意距离）——运输当量即容量基准，比值恒为 1 */
export const RAIL_CAP_PER_TRANSPORT_EQUIVALENT = 1

/** 4.7d / 13.3e-3：铁路运输卸货后**不允许继续移动**，故普通单位卸货后的可用 MP 恒为 0 */
export const RAIL_POST_DETRAIN_MP = 0

/**
 * 13.3e / 4.7d：铁路移动**本身不消耗 MP**（只按铁路容量点数计费，距离不限）
 *
 * 单位在铁路上的移动不由 MA 结算，唯一的 MA 消耗是「登车前最多一半 MA」的正常地面移动
 * （13.3e-1 / 4.7d）；铁路修理单位例外可于卸货后继续用剩余 MA（13.3g-B）。
 */
export const RAIL_MOVEMENT_MP_COST = 0

/* ────────────────────────────── 运输当量（4.7） ────────────────────────────── */

/** 铁路货物（13.3a：只有战斗单位、运输点数与 SP 可作为铁路货物；飞机/舰船/环形工事永远不可） */
export type RailCargo =
  | {
      kind: 'unit'
      /** 4.6：团级当量 */
      re: number
      /** 3.1a：机动类型（4.7b 只对**步行** MP 减半） */
      mobility: MobilityType
      /** 4.7b：**移动模式下**的印刷 MA */
      moveMa: number
    }
  /** 3.3a：补给点数 */
  | { kind: 'sp'; amount: number }
  /** 13.2/4.7c：运输点数（按自身规模计，无论是否装载 SP） */
  | { kind: 'transportPoint'; size: number }

/**
 * 4.7 / 4.7a / 4.7b / 4.7c：运输当量
 *
 * 「一点铁路容量可以运输 1SP 或 1RE（也可二者组合，如 2T 的补给和 1/2 RE 的单位）。」
 * 「如果一个单位在**移动模式下**的印刷 MA 为 1 至 6 的**步行 MP**（含 1 和 6），则它所需的运输当量减半。」
 * 「运输点数本身……计算运输当量时，只需计算运输点数本身的数量（无论是否装载有 SP）。」
 */
export function transportEquivalentOf(cargo: RailCargo): number {
  switch (cargo.kind) {
    case 'unit': {
      const isShortLeg =
        cargo.mobility === 'leg' &&
        cargo.moveMa >= RAIL_SHORT_LEG_MA_MIN &&
        cargo.moveMa <= RAIL_SHORT_LEG_MA_MAX
      return isShortLeg ? cargo.re * RAIL_SHORT_LEG_EQUIVALENT_MULTIPLIER : cargo.re
    }
    case 'sp':
      return cargo.amount
    case 'transportPoint':
      return cargo.size
  }
}

/* ────────────────────────────── 铁路容量成本（13.3a / 13.3b） ────────────────────────────── */

/** 13.3a 的两条路径修正（由调用方按路径逐段/逐格算出） */
export interface RailPathFacts {
  /** 路径上是否含一个或多个运输破坏区（14.8） */
  hasTrainbustingZone: boolean
  /** 路径的**每一段铁路格边**是否都为多轨（至少一段方可成立；见 `railPathFacts`） */
  entirePathMultiTrack: boolean
}

/** 铁路容量成本明细 */
export interface RailCapacityCost {
  /** 运输当量（4.7） */
  equivalent: number
  /** 13.3a 修正系数 = 破坏区倍率 × 多轨倍率（4.3：修正累计） */
  factor: number
  /** 应付铁路容量点数（可含小数，如 2T + 1/2 RE） */
  cost: number
  rule: string
  detail: string
}

/**
 * 13.3a：铁路容量成本
 *
 * 「通过铁路移动，每个铁路运量点数可以运输一个 SP 或 RE，距离不限。有两种可能的修正：
 *   · 如果货物移动的路径上包含一个或多个运输破坏区，则铁路运量的费用翻倍；
 *   · 如果货物移动的路径全部是多轨铁路格，则将正常的铁路运量费用减半。」
 * 4.3：两条修正**累计**（×2 与 ×½ 同时命中即回到原值）。
 */
export function railCapacityCost(input: {
  cargo: RailCargo
  path: RailPathFacts
}): RailCapacityCost {
  const equivalent = transportEquivalentOf(input.cargo)
  const factor =
    (input.path.hasTrainbustingZone ? RAIL_TRAINBUSTING_MULTIPLIER : 1) *
    (input.path.entirePathMultiTrack ? RAIL_MULTI_TRACK_MULTIPLIER : 1)
  const cost = equivalent * RAIL_CAP_PER_TRANSPORT_EQUIVALENT * factor
  const notes: string[] = []
  if (input.path.hasTrainbustingZone) notes.push('含运输破坏区 ⇒ 费用翻倍（13.3a）')
  if (input.path.entirePathMultiTrack) notes.push('全程多轨 ⇒ 费用减半（13.3a）')
  return {
    equivalent,
    factor,
    cost,
    rule: '13.3a',
    detail:
      `运输当量 ${equivalent}（4.7）× 修正 ${factor} = ${cost} 点铁路容量（13.3a）` +
      (notes.length === 0 ? '；无路径修正' : `；${notes.join('；')}`),
  }
}

/**
 * 由路径与事实算出 13.3a 的两条路径修正（路径按调用方给出的格序列逐格/逐段扫描）
 *
 * 多轨判在**格边**上：把路径折成相邻两格组成的**段**，要求每一段都是多轨铁路格边。
 * 单格路径（`from === to`，零段）**不成立**减半——没有任何一段走在多轨上。
 */
export function railPathFacts(
  path: readonly HexRef[],
  facts: Pick<RailFacts, 'isTrainbusting' | 'isMultiTrackEdge'>,
): RailPathFacts {
  const legs: { from: HexRef; to: HexRef }[] = []
  for (let index = 1; index < path.length; index += 1)
    legs.push({ from: path[index - 1]!, to: path[index]! })
  return {
    hasTrainbustingZone: path.some((hex) => facts.isTrainbusting(hex)),
    entirePathMultiTrack:
      legs.length > 0 && legs.every((leg) => facts.isMultiTrackEdge(leg.from, leg.to)),
  }
}

/* ────────────────────────────── 运行期事实 ────────────────────────────── */

/**
 * 铁路运行期事实（注入）
 *
 * 「可火车卸货格」的三条判据（13.3c）与「控制」（13.3h）都是运行期结论，
 * 由状态层/补给层算出后注入，本模块不臆造铁路连通性与控制权。
 */
export interface RailFacts {
  /** 该格是否有铁路（沿铁路移动的基本前提） */
  hasRail(hex: HexRef): boolean
  /** 两格之间是否以铁路相接（沿铁路逐格移动） */
  isRailConnected(from: HexRef, to: HexRef): boolean
  /** 13.3f：该格轨距是否为本方可用（苏宽轨 / 德标准轨；含已转换状态） */
  railGaugeUsable(hex: HexRef, side: Side): boolean
  /** 13.3h：该铁路格是否处于本方控制 */
  isControlled(hex: HexRef, side: Side): boolean
  /** 该格是否有敌方 ZOC（★ 运货时不可抵消，见 13.3c 末句） */
  inEnemyZoc(hex: HexRef, side: Side): boolean
  /** 13.3e-2：该格是否有敌方战斗单位 */
  hasEnemyCombatUnit(hex: HexRef, side: Side): boolean
  /** 13.3c：该格是否为「可火车卸货格」（聚落/港口/工程 HQ + 受控 + 免 EZOC 铁路路径回补给源） */
  isDetrainable(hex: HexRef, side: Side): boolean
  /** 14.8：该格是否处于运输破坏区（13.3a 费用翻倍） */
  isTrainbusting(hex: HexRef): boolean
  /**
   * 13.3a：两格之间的铁路格边是否为**多轨**
   *
   * ★ 判在**格边**上而非格上：多轨在地图上是一段线（用户 2026-09-15 的口述口径即「两点之间为多轨」），
   *   同一格完全可能一侧多轨、另一侧单轨，故「全程多轨」须逐段判定（见 `railPathFacts`）。
   */
  isMultiTrackEdge(from: HexRef, to: HexRef): boolean
  /** 13.3g：该单位是否为铁路修理单位（可在任意铁路格登车/卸货、可做轨距转换） */
  isRailRepairUnit(unitId: string): boolean
}

/* ────────────────────────────── 铁路移动三步（13.3e） ────────────────────────────── */

/** 参与铁路移动的货物（在 4.7 当量之外，单位还需要模式、当前 MA 与登车前 MP） */
export type RailCargoView =
  | (Extract<RailCargo, { kind: 'unit' }> & {
      id: string
      side: Side
      /** 5.6a：铁路运输须移动模式；13.3g-B 例外——铁路修理单位可在战斗模式下铁路移动 */
      mode: BaseMode
      /** 5.10d：DG 单位不能使用铁路运输 */
      dg: boolean
      /**
       * 当前**生效**面的印刷 MA（6.1h：不取整）
       *
       * 13.3e-1 的「登车前最多消耗**一半 MA**」与 13.3g-B 的「完整 MA（减去登车前的移动）」都以它为准
       * （移动模式单位＝移动面 MA，即与 4.7b 的 `moveMa` 相同；战斗模式的铁路修理单位＝战斗面 MA）。
       */
      currentMa: number
      /** 13.3e-1：登车前已消耗的 MP（≤ 当前 MA 的一半） */
      preLoadMp: number
    })
  | (Extract<RailCargo, { kind: 'sp' }> & { id: string; side: Side })
  | (Extract<RailCargo, { kind: 'transportPoint' }> & { id: string; side: Side })

/** 铁路移动结果 */
export interface RailMovementResult {
  /** 13.3a：应付铁路容量点数 */
  cost: number
  /** 4.7：运输当量 */
  equivalent: number
  /** 13.3a：路径修正系数 */
  factor: number
  /** 13.3e / 4.7d：铁路移动**本身不消耗的 MP**（恒为 0；只按铁路容量计费，距离不限） */
  mpCost: number
  /**
   * 卸货后仍可用的 MP
   *
   * - 普通单位：**0** —— 4.7d / 13.3e-3「单位卸货后，不允许继续移动」；
   * - 铁路修理单位：**当前 MA − 登车前已耗** —— 13.3g-B「铁路修理单位在使用铁路移动之后，
   *   可以用它们的完整 MA 移动（要减去登车前的移动）」。
   */
  postDetrainMp: number
  rule: string
  detail: string
}

/** 铁路移动输入 */
export interface RailMovementInput {
  /** 2.2 SOP 段：铁路运输只能在**移动阶段**使用（13.3b） */
  phase: GamePhase
  cargo: RailCargoView
  /** 登车格（起点） */
  from: HexRef
  /** 卸货格（终点） */
  to: HexRef
  /** 铁路路径（含起点与终点、逐格相接）；13.3a 的路径修正按此数组逐格扫描 */
  path: readonly HexRef[]
  facts: RailFacts
  /**
   * 13.6b：增援与新增 SP 的抵达格含铁路时可在「地图外」登车
   *
   * 「增援单位可放置在有敌方 ZOC 的格中，也可通过铁路抵达（**忽略 13.3e 中通常要求的『登车』**）。」
   * 给出本项即跳过 13.3e-1 的**登车格**检查（是否有铁路 / 是否可卸货 / 是否在敌方 ZOC）；
   * ★ 单位自身的运输资格（5.6a 移动模式、5.10d 非 DG、13.3e-1 登车前 MP）仍照常校验。
   */
  entrainOffMap?: boolean
}

/** 格号文本（仅用于失败详情的可读性；业务坐标一律 { col, row }） */
function hexText(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

function sameHex(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}

/**
 * 13.3e：铁路移动三步校验 + 容量成本
 *
 * 「铁路移动包括三个步骤：**登车、移动、卸货**。这三个步骤必须在**同一阶段**完成。」
 *   1) 登车：货物位于**不在敌方 ZOC 内**的可火车卸货铁路格；单位须移动模式，且该阶段登车前最多消耗**一半 MA**；
 *      （13.6b 的「地图外登车」忽略本步；13.3g-C 铁路修理单位可在**任意**铁路格登车）
 *   2) 移动：沿相连的铁路格移动，**不可进入**有敌方战斗单位或 ZOC 的格；不能使用**错误轨距**或**未控制**的铁路格；
 *   3) 卸货：位于**不在敌方 ZOC 内**的可火车卸货铁路格；卸货后**不得再移动**（4.7d）。
 *      ★ 13.3g-B 例外：铁路修理单位卸货后可用「完整 MA − 登车前移动」继续移动（见返回值 `postDetrainMp`）。
 */
export function validateRailMovement(input: RailMovementInput): RuleOutcome<RailMovementResult> {
  const { cargo, from, to, path, facts } = input

  // 13.3b：铁路运量只能在移动阶段使用（也因此三步必然同阶段）
  if (input.phase !== 'movement') return fail('13.3b', 'railOnlyInMovementPhase')
  if (path.length === 0) return fail('13.3e', 'emptyPath')
  if (!sameHex(path[0]!, from)) return fail('13.3e', 'pathMustStartAtCargoHex')
  if (!sameHex(path[path.length - 1]!, to)) return fail('13.3e', 'pathMustEndAtDestination')

  // 13.3g-C：铁路修理单位可在任何铁路格登车与卸货（不受「可火车卸货格」限制）
  const isRailRepair = cargo.kind === 'unit' && facts.isRailRepairUnit(cargo.id)

  /* ① 登车格（13.3e-1）；13.6b 的「地图外登车」忽略本项 */
  if (input.entrainOffMap !== true) {
    if (!facts.hasRail(from)) return fail('13.3e', `entrainHexHasNoRail:${hexText(from)}`)
    if (!isRailRepair && !facts.isDetrainable(from, cargo.side))
      return fail('13.3e', `entrainHexNotDetrainable:${hexText(from)}`)
    // 「货物必须位于**不在敌方 ZOC 内**的一个可火车卸货的铁路格」；★ 运货时 EZOC **不可**抵消（13.3c）
    if (facts.inEnemyZoc(from, cargo.side))
      return fail('13.3e', `entrainHexInEnemyZoc:${hexText(from)}`)
  }

  /* ①′ 单位自身的运输资格（5.6a / 5.10d / 13.3e-1）：与是否「地图外登车」无关 */
  if (cargo.kind === 'unit') {
    // 5.10d：DG 单位不能使用铁路运输（无例外）
    if (cargo.dg) return fail('5.10d', `dgUnitCannotRail:${cargo.id}`)
    // 5.6a 铁路运输须移动模式；13.3g-B 例外——铁路修理单位可在战斗模式下铁路移动
    if (cargo.mode !== 'move' && !(isRailRepair && cargo.mode === 'combat'))
      return fail('5.6a', `railRequiresMoveMode:${cargo.id}`)
    // 13.3e-1 / 4.7d：登车前最多消耗一半 MA（6.1h：MA 不取整）
    const preLoadLimit = cargo.currentMa * RAIL_PRE_LOAD_MA_FRACTION
    if (cargo.preLoadMp > preLoadLimit)
      return fail('13.3e', `preLoadMpExceedsHalfMa:${cargo.preLoadMp}>${preLoadLimit}`)
  }

  /* ② 起点格的轨距与受控（13.3e-2：不能使用错误轨距或未控制的铁路格） */
  if (!facts.railGaugeUsable(from, cargo.side))
    return fail('13.3f', `entrainHexWrongGauge:${hexText(from)}`)
  if (!facts.isControlled(from, cargo.side))
    return fail('13.3h', `entrainHexUncontrolled:${hexText(from)}`)

  /* ③ 沿铁路移动（13.3e-2）：逐格检查相连性；**途经格**检查可用性（终点属「卸货格」，见 ④） */
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1]!
    const hex = path[index]!
    if (!facts.isRailConnected(previous, hex))
      return fail('13.3e', `pathNotRailConnected:${hexText(previous)}>${hexText(hex)}`)
    // 终点格按 13.3e-3「卸货」单独校验（见 ④），此处只查中途经过的格
    if (index === path.length - 1) continue
    if (!facts.hasRail(hex)) return fail('13.3e', `pathHexHasNoRail:${hexText(hex)}`)
    if (!facts.railGaugeUsable(hex, cargo.side))
      return fail('13.3f', `pathHexWrongGauge:${hexText(hex)}`)
    if (!facts.isControlled(hex, cargo.side))
      return fail('13.3h', `pathHexUncontrolled:${hexText(hex)}`)
    // 「不可进入有敌方战斗单位或 ZOC 的格」
    if (facts.hasEnemyCombatUnit(hex, cargo.side))
      return fail('13.3e', `pathHexEnemyCombatUnit:${hexText(hex)}`)
    if (facts.inEnemyZoc(hex, cargo.side)) return fail('13.3e', `pathHexInEnemyZoc:${hexText(hex)}`)
  }

  /* ④ 卸货（13.3e-3）：「货物必须位于不在敌方 ZOC 内的可火车卸货的铁路格」 */
  if (!facts.hasRail(to)) return fail('13.3e', `detrainHexHasNoRail:${hexText(to)}`)
  if (!facts.railGaugeUsable(to, cargo.side))
    return fail('13.3f', `detrainHexWrongGauge:${hexText(to)}`)
  if (!facts.isControlled(to, cargo.side))
    return fail('13.3h', `detrainHexUncontrolled:${hexText(to)}`)
  if (!isRailRepair && !facts.isDetrainable(to, cargo.side))
    return fail('13.3e', `detrainHexNotDetrainable:${hexText(to)}`)
  if (facts.hasEnemyCombatUnit(to, cargo.side))
    return fail('13.3e', `detrainHexEnemyCombatUnit:${hexText(to)}`)
  if (facts.inEnemyZoc(to, cargo.side)) return fail('13.3e', `detrainHexInEnemyZoc:${hexText(to)}`)

  const cost = railCapacityCost({ cargo, path: railPathFacts(path, facts) })
  // 卸货后的可用 MP：普通单位 0（4.7d）；铁路修理单位＝完整 MA − 登车前移动（13.3g-B，4.7d 的例外）
  const isUnit = cargo.kind === 'unit'
  const postDetrainMp =
    isUnit && isRailRepair ? Math.max(0, cargo.currentMa - cargo.preLoadMp) : RAIL_POST_DETRAIN_MP
  return succeed('13.3e', {
    cost: cost.cost,
    equivalent: cost.equivalent,
    factor: cost.factor,
    // 铁路移动本身不耗 MP：只按铁路容量计费（13.3a 距离不限）
    mpCost: RAIL_MOVEMENT_MP_COST,
    postDetrainMp,
    rule: '13.3e',
    detail:
      `铁路移动：${hexText(from)} → ${hexText(to)}（${path.length - 1} 格）；` +
      `${cost.detail}；` +
      (isUnit && isRailRepair
        ? `铁路修理单位卸货后可用 MA ${postDetrainMp}（完整 MA − 登车前移动，13.3g-B）`
        : '卸货后不得再移动（4.7d）'),
  })
}

/* ────────────────────────────── 轨距转换（13.3f / 13.3g） ────────────────────────────── */

/** 轨距转换输入 */
export interface GaugeConversionInput {
  /** 13.3g-D：只能在移动阶段（而非其他阶段）转换 */
  phase: GamePhase
  unit: {
    id: string
    side: Side
  }
  /** 目标铁路格 */
  targetHex: HexRef
  /**
   * 本移动阶段**已转换**的格数（含之前几次）
   *
   * 13.3g-D：「在移动阶段……最多可转换 4 格（如果其当前 MA 小于 4，则为其当前 MA 的格数）」
   */
  convertedThisPhase: number
  /** 5.10e / 13.3g-D：转换时须处于战斗模式，或 DG 但朝向战斗面 */
  mode: BaseMode
  orientation: Orientation
  dg: boolean
  /** 该单位**当前** MA（13.3g-D：小于 4 时上限取当前 MA） */
  currentMa: number
  /**
   * 13.3g-A「不能接力」：本阶段该单位是否用铁路移动**进入过本阶段刚转换的铁路格**
   *
   * 「例外：如果用于铁路移动的格刚刚在当前阶段内进行了轨距转换，则不能这样做。**不能接力！**」
   */
  usedNewlyConvertedRailThisPhase: boolean
  facts: Pick<RailFacts, 'hasRail' | 'inEnemyZoc' | 'isRailRepairUnit'>
}

/** 轨距转换结果 */
export interface GaugeConversionResult {
  /** 转换后的本阶段累计格数 */
  convertedThisPhase: number
  /** 13.3f-B：轨距转换不消耗 SP */
  spCost: number
  /** 13.3f-B：轨距转换不消耗额外移动点数 */
  mpCost: number
  rule: string
  detail: string
}

/**
 * 13.3f / 13.3g：轨距转换
 *
 * 「A) 铁路**不能**在敌方 ZOC 内转换轨距（无法被抵消）。B) 一个铁路修理单位只需**移动进入**一个铁路格，
 *   就可转换该铁路格的轨距。轨距转换**不消耗 SP，也不消耗额外的移动点数**。」
 * 「D) 在移动阶段（而非其他阶段），铁路修理单位最多可转换 4 格（如果其当前 MA 小于 4，则为其当前 MA 的格数）。
 *   它们必须处于战斗模式，或处于 DG 模式但朝向战斗模式面（根据 5.10e）。」
 */
export function validateGaugeConversion(
  input: GaugeConversionInput,
): RuleOutcome<GaugeConversionResult> {
  const { unit, facts } = input

  // 13.3g：只有铁路修理单位能转换铁路格
  if (!facts.isRailRepairUnit(unit.id)) return fail('13.3g', `notRailRepairUnit:${unit.id}`)
  // 13.3g-D：只能在移动阶段
  if (input.phase !== 'movement') return fail('13.3g', 'conversionOnlyInMovementPhase')
  if (!facts.hasRail(input.targetHex))
    return fail('13.3f', `targetHexHasNoRail:${hexText(input.targetHex)}`)
  // 13.3f-A：敌方 ZOC 内不可转换，且**不可抵消**（无 4.5b 例外）
  if (facts.inEnemyZoc(input.targetHex, unit.side))
    return fail('13.3f', `enemyZocCannotConvert:${hexText(input.targetHex)}`)
  // 13.3g-D via 5.10e：战斗模式，或 DG 但朝向战斗面
  const canConvert = input.mode === 'combat' || (input.dg && input.orientation === 'combat')
  if (!canConvert) return fail('13.3g', `mustBeCombatMode:${unit.id}`)

  const limit = Math.min(RAIL_CONVERSION_MAX_PER_PHASE, input.currentMa)
  if (input.convertedThisPhase >= limit)
    return fail('13.3g', `conversionLimitReached:${input.convertedThisPhase}>=${limit}`)
  // 13.3g-A：不得接力
  if (input.usedNewlyConvertedRailThisPhase) return fail('13.3g', `noLeapfrogging:${unit.id}`)

  return succeed('13.3f', {
    convertedThisPhase: input.convertedThisPhase + 1,
    // 13.3f-B：不消耗 SP，也不消耗额外 MP
    spCost: 0,
    mpCost: 0,
    rule: '13.3f',
    detail: `转换 ${hexText(input.targetHex)} 的轨距（本阶段第 ${input.convertedThisPhase + 1}/${limit} 格；13.3f-B 不耗 SP 与 MP）`,
  })
}

/* ────────────────────────────── 剧本初设「已转换的铁路」（专规 1.2） ────────────────────────────── */

/**
 * 铁路邻接来源（把「哪些格以铁路相接」注入进来的最小接口）
 *
 * 生产实现由调用方给出（补给层的铁路邻接表），故本函数可脱离整局状态独立测试。
 */
export interface RailNeighborSource {
  railNeighbors(hex: HexRef): readonly HexRef[]
}

/** 剧本初设换轨的逐格清单 */
export interface ConvertedRailRun {
  /** 该走线的逐格清单（**含两端**，自 `from` 到 `to`） */
  hexes: HexRef[]
  rule: string
  detail: string
}

/**
 * 专规 1.2：剧本初设「Converted Axis Rails: A to B」→ **逐格**清单
 *
 * 剧本页只给两个端点（如「01.03 to 2.02」，并在端点标注驻该处的 RR Bn），给的是**那一条铁路线**。
 * 本函数在铁路邻接图上取 A→B 的**唯一最短路径**，并**在歧义时失败**：
 *
 *   - 两端不连通 ⇒ `convertedRunDisconnected`（数据或地图有误，不能悄悄给个空集）；
 *   - 最短路径不唯一（路上出现分叉/「弦」）⇒ `convertedRunAmbiguous`。
 *
 * ★ 为什么不猜：把错误的格标成「已转换」，等于把整段铁路的使用权错放给轴方（专规 1.2：轴方**只能**
 *   使用标准轨铁路），会直接影响追溯补给与运货，所以宁可失败也不猜。本作 7 个剧本的 8 条走线
 *   实测均为唯一（正反向同长、无分叉、无弦），见 `tests/engine/rail.test.ts` 的实测用例。
 */
export function convertedRailRun(
  facts: RailNeighborSource,
  input: { from: HexRef; to: HexRef },
): RuleOutcome<ConvertedRailRun> {
  const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
  const goal = key(input.to)
  const distance = new Map<string, number>([[key(input.from), 0]])
  /** 每个格在最短路上的**全部**前驱：多于一个即说明「那条线」不唯一 */
  const predecessors = new Map<string, HexRef[]>()
  const queue: HexRef[] = [input.from]

  while (queue.length > 0) {
    const hex = queue.shift()!
    const next = distance.get(key(hex))! + 1
    for (const candidate of facts.railNeighbors(hex)) {
      const candidateKey = key(candidate)
      const seen = distance.get(candidateKey)
      if (seen === undefined) {
        distance.set(candidateKey, next)
        predecessors.set(candidateKey, [hex])
        queue.push(candidate)
      } else if (seen === next) {
        predecessors.get(candidateKey)?.push(hex)
      }
    }
  }

  if (!distance.has(goal))
    return fail('13.3f', `convertedRunDisconnected:${hexText(input.from)}-${hexText(input.to)}`)

  const hexes: HexRef[] = [input.to]
  let cursor = input.to
  while (key(cursor) !== key(input.from)) {
    const from = predecessors.get(key(cursor)) ?? []
    if (from.length !== 1)
      return fail('13.3f', `convertedRunAmbiguous:${hexText(cursor)}<-${from.length}`)
    cursor = from[0]!
    hexes.push(cursor)
  }
  hexes.reverse()

  return succeed('13.3f', {
    hexes,
    rule: '13.3f',
    detail: `剧本初设换轨：${hexText(input.from)} → ${hexText(input.to)} 沿铁路 ${hexes.length} 格（专规 1.2）`,
  })
}

/* ────────────────────────────── 运输点数：合并 / 拆分（13.2c） ────────────────────────────── */

/** 运输点数视图（13.2） */
export interface TransportPointView {
  id: string
  /** 13.2c：类型（卡车 / 马车 / 骡子 / 编内卡车…）——**不同类型永不可合并为同一个算子** */
  type: string
  /** 规模（SP） */
  size: number
  hex: HexRef
}

/** 合并/拆分共用的阶段闸门（13.2c：只能在本方移动阶段进行） */
function checkTransportPointPhase(input: {
  phase: GamePhase
  side: Side
  activeSide: Side
}): RuleFailure | null {
  if (input.phase !== 'movement') return fail('13.2c', 'transportPointOpsOnlyInMovementPhase')
  if (input.side !== input.activeSide) return fail('13.2c', 'transportPointOpsOnlyInFriendlyPhase')
  return null
}

/**
 * 13.2c：合并运输点数
 *
 * 「运输点数可以在游戏提供算子的数量限制内，进行合并和拆分。合并与拆分**不消耗 MP**，
 *   但只能在**友方移动阶段**中进行，且所有涉及的运输点数必须在**同一格**内。
 *   ……**不同类型的运输点数永远不能合并为同一个算子**，这一限制也包括编内卡车。」
 *
 * 注意：算子上限（物理算子数量）由实物决定，引擎不建模；调用方若需限制，自行在命令层校验。
 */
export function mergeTransportPoints(input: {
  phase: GamePhase
  side: Side
  activeSide: Side
  points: readonly TransportPointView[]
}): RuleOutcome<{ type: string; size: number; mpCost: number; rule: string; detail: string }> {
  const gate = checkTransportPointPhase(input)
  if (gate !== null) return gate
  if (input.points.length < 2) return fail('13.2c', 'mergeNeedsAtLeastTwoPoints')

  const first = input.points[0]!
  if (input.points.some((point) => point.type !== first.type))
    return fail('13.2c', 'differentTypesCannotMerge')
  if (input.points.some((point) => !sameHex(point.hex, first.hex)))
    return fail('13.2c', 'differentHexesCannotMerge')

  const size = input.points.reduce((sum, point) => sum + point.size, 0)
  return succeed('13.2c', {
    type: first.type,
    size,
    // 13.2c：合并与拆分不消耗 MP
    mpCost: 0,
    rule: '13.2c',
    detail: `${input.points.length} 个「${first.type}」运输点数在 ${hexText(first.hex)} 合并为规模 ${size}（不耗 MP）`,
  })
}

/**
 * 13.2c：拆分运输点数
 *
 * 约束与合并相同（同阶段、同格、同类型不涉及），并额外要求各份规模为正且**合计等于原规模**。
 */
export function splitTransportPoint(input: {
  phase: GamePhase
  side: Side
  activeSide: Side
  point: { id: string; type: string; size: number }
  /** 拆分后的各份规模（顺序即摆放顺序） */
  sizes: readonly number[]
}): RuleOutcome<{ type: string; sizes: number[]; mpCost: number; rule: string; detail: string }> {
  const gate = checkTransportPointPhase(input)
  if (gate !== null) return gate
  if (input.sizes.length < 2) return fail('13.2c', 'splitNeedsAtLeastTwoParts')
  if (input.sizes.some((size) => !Number.isFinite(size) || size <= 0))
    return fail('13.2c', `badSplitSize:${input.sizes.join(',')}`)

  const total = input.sizes.reduce((sum, size) => sum + size, 0)
  if (Math.abs(total - input.point.size) > 1e-9)
    return fail('13.2c', `splitSumMismatch:${total}!=${input.point.size}`)

  return succeed('13.2c', {
    type: input.point.type,
    sizes: [...input.sizes],
    mpCost: 0,
    rule: '13.2c',
    detail: `规模 ${input.point.size} 的「${input.point.type}」拆为 ${input.sizes.join(' + ')}（不耗 MP）`,
  })
}

/**
 * 13.2c：拆分/合并时**已装 SP 归谁**（用户 2026-09-15 裁定）
 *
 * 用户口径：「运输点数是可以**自由拆分**的，图片只是实体方便表示有几点而已……
 *   **先按照实体来几点给几点**的算子，玩家移动时可以自由拆分。」
 *
 * 故本函数只做**保货分配**（总数不变），按「1 点运力装 1 SP」逐份装填：
 *   · 各份依次装满（`min(剩余货, 该份点数)`），**最后一份兜底**拿走余下的货
 *     （13.2f 对装载量**没有上限**——「任意数量的 SP」——故超出运力的部分不丢，仍记在末份上）；
 *   · `sizes` 与返回数组一一对应；`cargoSp ≤ 0` 时全部为 0。
 *
 * ★ 与 13.2c 的「合并」配套：合并的货就是各份之和（`sum`），与本函数同源。
 */
export function distributeTransportCargo(input: {
  /** 原算子上的已装 SP 数（可为小数：内部以 T 计量时由调用方折算） */
  cargoSp: number
  /** 拆分后的各份**点数**（顺序即摆放顺序） */
  sizes: readonly number[]
}): number[] {
  const total = Math.max(0, input.cargoSp)
  const out: number[] = []
  let rest = total
  for (let index = 0; index < input.sizes.length; index += 1) {
    const isLast = index === input.sizes.length - 1
    const share = isLast ? rest : Math.min(rest, Math.max(0, input.sizes[index] ?? 0))
    out.push(share)
    rest -= share
  }
  return out
}

/* ────────────────────────────── 运输点数：装载 / 卸载（13.2f） ────────────────────────────── */

/**
 * 13.2f：运输点数装载/卸载 SP 的费用
 *
 * 「运输点数在一个格内装载/卸载任意数量的 SP 时，需支付它**印刷 MA 的 10%**。费用按正常方法取整
 *   （因此，45MA 的卡车必须支付 5MP 才能装载或卸载 SP）。」
 * 与 `computeLoadingCost` 同源（同一数值口径），此处只是把语义钉在运输点数的门上。
 */
export function transportPointLoadCost(printedMa: number): number {
  return computeLoadingCost(printedMa)
}

/** 运输点数与「编内卡车」的区分（13.2g：编内卡车有若干例外） */
export interface TransportPointActor {
  id: string
  type: string
  /** 13.2f：印刷 MA（费用基数，不用当前 MA） */
  printedMa: number
  /** 13.2g：是否为编内卡车 */
  isOrganicTruck: boolean
}

/**
 * 13.2f：装载 SP
 *
 * 「运输点数必须与**补给站**位于同一格中才能装载 SP。」「装载的要求：运输点数可在**任何格**内装载。」
 * （即：装载对格的**地形/设施**无要求，但必须与补给站同格；不能通过直接拖取或投递的方式装载。）
 */
export function validateTransportPointLoad(input: {
  transportPoint: TransportPointActor
  /** 该格是否有补给站（dump）——13.2f 装载的唯一位置前提 */
  dumpInHex: boolean
}): RuleOutcome<{ cost: number; rule: string; detail: string }> {
  if (!input.dumpInHex) return fail('13.2f', 'loadRequiresDumpInHex')
  const cost = transportPointLoadCost(input.transportPoint.printedMa)
  return succeed('13.2f', {
    cost,
    rule: '13.2f',
    detail: `装载：支付印刷 MA 的 10% = ${cost} MP（13.2f）`,
  })
}

/**
 * 13.2f：卸载 SP
 *
 * 「卸载的要求：运输点数只能在包含**友方战斗单位、港口、空军基地或已经有已卸载的补给站**的格内卸载。」
 * 13.2g-A：编内卡车**永远无法**在地图上卸载它们的 SP。
 */
export function validateTransportPointUnload(input: {
  transportPoint: TransportPointActor
  /** 该格是否满足 13.2f 的卸载条件（友方战斗单位 / 港口 / 空军基地 / 已卸载的补给站） */
  hexAllowsUnload: boolean
}): RuleOutcome<{ cost: number; rule: string; detail: string }> {
  if (input.transportPoint.isOrganicTruck)
    return fail('13.2g', `organicTruckCannotUnload:${input.transportPoint.id}`)
  if (!input.hexAllowsUnload) return fail('13.2f', 'unloadRequirementsNotMet')
  const cost = transportPointLoadCost(input.transportPoint.printedMa)
  return succeed('13.2f', {
    cost,
    rule: '13.2f',
    detail: `卸载：支付印刷 MA 的 10% = ${cost} MP（13.2f）`,
  })
}

/* ────────────────────────────── 静态铁路图层 → 事实（产品数据） ────────────────────────────── */

/** 静态铁路图层来源（map-layers.json 的 edges 子集） */
export interface RailLayerSource {
  edges: readonly { a: HexRef; b: HexRef; rail?: boolean; multiTrack?: boolean }[]
}

/* ────────────────────────────── 静态铁路图层 → 邻接索引（13.3a） ────────────────────────────── */

/** 13.3a 的静态铁路索引（唯一实现） */
export interface RailGraph {
  /** 该格是否有铁路格边（至少一条格边有轨即为铁路格） */
  isRailHex(hex: HexRef): boolean
  /** 与 `hex` 以**铁路格边**相接的邻格 */
  railNeighbors(hex: HexRef): readonly HexRef[]
  /** 13.3a：两格之间的格边是否为**多轨**铁路（单/多轨是静态图层数据，非运行期状态） */
  isMultiTrackEdge(from: HexRef, to: HexRef): boolean
}

/**
 * 13.3a：由静态图层（`map-layers.json` 的格边）建铁路邻接索引
 *
 * ★ 唯一实现：`createRailFacts` 的 `hasRail`/`isRailConnected`/`isMultiTrackEdge`、补给层的铁路邻接表
 *   （`workbench-model.railNeighborHexes`，供 13.3c 与专规 1.2 的换轨走线用）都从这里取，
 *   修前这两处各建了一份「筛 `rail === true` 再连边」的表（同一条规则抄两遍）。
 */
export function createRailGraph(source: RailLayerSource = mapLayers): RailGraph {
  const adjacency = new Map<string, HexRef[]>()
  const multiTrack = new Set<string>()
  const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
  /** 格边的规范键：与产物一致，格号文本字典序小者在前（一条边一个键） */
  const edgeKey = (from: HexRef, to: HexRef): string => {
    const first = key(from)
    const second = key(to)
    return first < second ? `${first}|${second}` : `${second}|${first}`
  }
  const link = (from: HexRef, to: HexRef): void => {
    const list = adjacency.get(key(from))
    if (list === undefined) adjacency.set(key(from), [to])
    else list.push(to)
  }
  for (const edge of source.edges) {
    if (edge.rail !== true) continue
    link(edge.a, edge.b)
    link(edge.b, edge.a)
    // 13.3a：多轨标记只出现在有铁路的格边上（源库 rail_track="multi"，用户逐段口述裁定）
    if (edge.multiTrack === true) multiTrack.add(edgeKey(edge.a, edge.b))
  }
  return {
    isRailHex: (hex) => adjacency.has(key(hex)),
    railNeighbors: (hex) => adjacency.get(key(hex)) ?? [],
    isMultiTrackEdge: (from, to) => multiTrack.has(edgeKey(from, to)),
  }
}

/**
 * 由静态铁路图层 + 运行期谓词构造 `RailFacts`
 *
 * 静态部分（哪格有铁路、两格是否以铁路相接、**该格边是否多轨**）从地图产物建索引——一次建表，
 * 随后 O(1) 查询；运行期部分（控制 13.3h / 轨距 13.3f / EZOC / 敌方单位 / 可卸货格 13.3c / 破坏区 14.8）
 * 由调用方注入。
 *
 * ★ 单/多轨**不是**注入项：它是印刷静态图层，故与 `hasRail` 同源于 `source`
 *   （2026-09-15 由源库 `map_edges.rail_track` 导出，用户逐段口述裁定）。
 */
export function createRailFacts(input: {
  isControlled: (hex: HexRef, side: Side) => boolean
  railGaugeUsable: (hex: HexRef, side: Side) => boolean
  inEnemyZoc: (hex: HexRef, side: Side) => boolean
  hasEnemyCombatUnit: (hex: HexRef, side: Side) => boolean
  isDetrainable: (hex: HexRef, side: Side) => boolean
  isRailRepairUnit: (unitId: string) => boolean
  isTrainbusting?: (hex: HexRef) => boolean
  /** 静态铁路图层来源（缺省取产品数据 map-layers.json） */
  source?: RailLayerSource
}): RailFacts {
  const graph = createRailGraph(input.source ?? mapLayers)

  return {
    hasRail: (hex) => graph.isRailHex(hex),
    // 13.3e-2：沿铁路逐格移动 ⇒ 两格必须**以铁路格边相接**（不相邻即不连通）
    isRailConnected: (from, to) =>
      graph.railNeighbors(from).some((hex) => hex.col === to.col && hex.row === to.row),
    railGaugeUsable: input.railGaugeUsable,
    isControlled: input.isControlled,
    inEnemyZoc: input.inEnemyZoc,
    hasEnemyCombatUnit: input.hasEnemyCombatUnit,
    isDetrainable: input.isDetrainable,
    isTrainbusting: input.isTrainbusting ?? (() => false),
    isMultiTrackEdge: (from, to) => graph.isMultiTrackEdge(from, to),
    isRailRepairUnit: input.isRailRepairUnit,
  }
}
