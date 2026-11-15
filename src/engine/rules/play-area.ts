import type { HexRef } from '@/data'

/**
 * 剧本活动区（用户 2026-11-15 口径：地图活动范围限定在截图内可见的六角格）
 *
 * 口径：
 *   - 格集写在剧本数据里（`scenario.playArea.hexes`，逐格读数，不用包围盒推导）；
 *   - 范围外**不可进入**：移动 / 突袭进格 / 可达格高亮 / 撤退路径与落点 / 战后推进
 *     一律走本函数，判据只有这一处；
 *   - 缺省（`undefined`）＝全图不限，既有剧本行为不变。
 *
 * 范围外并不删除地图数据：那些格照旧在 map-layers 里、照旧渲染，只是不可进入。
 */
export function insidePlayArea(area: readonly HexRef[] | undefined, hex: HexRef): boolean {
  if (area === undefined) return true
  return area.some((item) => item.col === hex.col && item.row === hex.row)
}
