import { rulesConstants } from '@/data'

/**
 * 铁路容量查询（专规 1.2）
 *
 * 本作苏方仅宽轨、轴方仅标准轨；19 July 起容量提升：
 *   轴方：0 → 1（勘误覆盖：剧本 3/5/7 初值已为 1，不受此限）
 *   苏方：2 → 3
 * 引擎在运输/补给/铁路移动判定时调 getRailCap(date, side) 取当前容量。
 */

export type RailSide = 'axis' | 'soviet'

/**
 * 按日期查询一方当前铁路容量（点/回合）
 *
 * 输入 ISO 日期串（YYYY-MM-DD），与 railCapBoostDate 字符串比较（ISO 格式天然可比较）。
 * 早于提升日返回 before 值；当天及之后返回 after 值。
 */
export function getRailCap(date: string, side: RailSide): number {
  const boostDate = rulesConstants.smolensk.railCapBoostDate
  if (date >= boostDate) {
    return rulesConstants.smolensk.railCapAfter[side]
  }
  return rulesConstants.smolensk.railCapBefore[side]
}

/** 铁路容量提升前值（按 side） */
export const RAIL_CAP_BEFORE = rulesConstants.smolensk.railCapBefore

/** 铁路容量提升后值（按 side） */
export const RAIL_CAP_AFTER = rulesConstants.smolensk.railCapAfter
