import { rulesConstants } from '@/data'

import { roundHalfUp } from './combat'

/**
 * 移动、堆叠与铁路常量（OCS 4.6 / 4.7 / 4.8 / 6.0 / 13.2 / 13.3）
 */

/** 最小移动：MA > 0 至少移动 1 格（6.1c） */
export const MINIMUM_MOVE_HEXES = rulesConstants.movement.minimumMoveHexes

/** 堆叠上限（RE，4.8） */
export const STACKING_LIMIT_RE = rulesConstants.movement.stackingLimitRe

/** RE 换算：营 = 0.5（4.6） */
export const RE_SCALE_BATTALION = rulesConstants.movement.reScaleBattalion

/** RE 换算：补员或连 = 0.25 */
export const RE_SCALE_REPLACEMENT = rulesConstants.movement.reScaleReplacement

/** 装载/卸载费用：各耗 MA 的 10%（13.2f） */
export const LOADING_COST_FRACTION = rulesConstants.movement.loadingCostFraction

/** 每移动阶段轨道转换上限（格，13.3g） */
export const RAIL_CONVERSION_MAX_PER_PHASE = rulesConstants.movement.railConversionMaxPerPhase

/** 13.3e-1：登车前最多可消耗的 MA 比例（半个 MA；4.7d 同义） */
export const RAIL_PRE_LOAD_MA_FRACTION = rulesConstants.movement.railPreLoadMaFraction

/** 4.7b：「短腿」步行 MA 下界（含）——落在此区间的单位运输当量减半 */
export const RAIL_SHORT_LEG_MA_MIN = rulesConstants.movement.railShortLegMaMin

/** 4.7b：「短腿」步行 MA 上界（含） */
export const RAIL_SHORT_LEG_MA_MAX = rulesConstants.movement.railShortLegMaMax

/** 4.7b：短腿单位的运输当量倍率（1/2） */
export const RAIL_SHORT_LEG_EQUIVALENT_MULTIPLIER =
  rulesConstants.movement.railShortLegEquivalentMultiplier

/** 13.3a：路径含运输破坏区 ⇒ 铁路容量费用加倍 */
export const RAIL_TRAINBUSTING_MULTIPLIER = rulesConstants.movement.railTrainbustingMultiplier

/** 13.3a：路径全程多轨 ⇒ 铁路容量费用减半 */
export const RAIL_MULTI_TRACK_MULTIPLIER = rulesConstants.movement.railMultiTrackMultiplier

/** 边缘盒进入费用：移动模式 1 MP 或 1 铁路容量点（专规 1.4b） */
export const EDGE_BOX_ENTRY_MP = rulesConstants.movement.edgeBoxEntryMp

/* ── 移动与堆叠判定 ── */

/**
 * 装载 / 卸载费用（13.2f）
 *
 * 「运输点数在一个格内装载/卸载任意数量的 SP 时，需支付它**印刷 MA 的 10%**。
 *   费用按**正常方法取整**（因此，45MA 的卡车必须支付 5MP 才能装载或卸载 SP）。」
 * 「正常方法取整」＝ 4.2 的分数取整（小数 ≥ .5 进位），故 6MA ⇒ 0.6 ⇒ 1MP、45MA ⇒ 4.5 ⇒ 5MP。
 *
 * @param ma 该单位**印刷**的移动力（用当前 MA 会在 DG 等修正后算错）
 */
export function computeLoadingCost(ma: number): number {
  return roundHalfUp(ma * LOADING_COST_FRACTION)
}

/**
 * 堆叠上限判定（4.8）：总 RE 是否未超过 STACKING_LIMIT_RE
 */
export function isWithinStackingLimit(totalRE: number): boolean {
  return totalRE <= STACKING_LIMIT_RE
}
