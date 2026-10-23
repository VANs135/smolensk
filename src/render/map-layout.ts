import { mapConfig, mapLayers } from '@/data'
import type { HexRef } from '@/data'

import { neighbor } from '@/engine/hex-geometry'

/**
 * 地图版式（U0 骨架操作台用）——**纯几何**，无状态写入
 *
 * 唯一来源是标定数据 `map-config.geometry` 与格清单 `map-layers.hexes`，不另造尺寸：
 *   格心公式（与 scripts/sync-map-config.mjs 的 centerOf 同式，VERIFIED）：
 *     x = originX + (col − 1) · hexWidthPx          （向右＝向东）
 *     s = originY − row · hexHeightPx − (偶列 ? hexHeightPx / 2 : 0)   （**向南为正**的纵坐标）
 *   即 flat-top + even-q：偶数列整体下移半格，故 `hexHeightPx / 2` 正是中心到平边的距离（内切半径）。
 *
 * ★ 朝向（用户裁定 2026-09-13：上北下南左西右东）：上式里行号越大 → s 越小 → 越靠北；
 *   故画布坐标 y 与 s **同向**（都向南为正），直接把 s 平移到留白即可，**不要再翻转一次**，
 *   否则整幅地图会南北颠倒（格号仍能点对，但图是倒的）。
 */

/** 列间距（相邻列格心水平距离，＝ flat-top 六角格的 3/4 宽） */
export const HEX_COL_SPACING_PX = mapConfig.geometry.hexWidthPx

/** 行间距（同列相邻行格心距离，＝ flat-top 六角格的高） */
export const HEX_ROW_SPACING_PX = mapConfig.geometry.hexHeightPx

/** 标定原点（第 1 列第 0 行的格心） */
export const CALIBRATION_ORIGIN = {
  x: mapConfig.geometry.originX,
  y: mapConfig.geometry.originY,
}

/** 图幅留白（画布坐标，像素） */
export const BOARD_MARGIN_PX = 24

/** flat-top 六角格的外接圆半径 R = 高 / √3（高 = √3·R） */
export const HEX_RADIUS_PX = HEX_ROW_SPACING_PX / Math.sqrt(3)

/** 格心到平边的距离（内切半径），也＝偶列错位的半格 */
export const HEX_INRADIUS_PX = HEX_ROW_SPACING_PX / 2

/** 是否偶数列（even-q 的错位分支；取模规范化，兼容负数） */
function isEvenColumn(col: number): boolean {
  return ((col % 2) + 2) % 2 === 0
}

/** 标定坐标（x 向东、y 向北）格心 */
export function hexCalibrationPoint(hex: HexRef): { x: number; y: number } {
  return {
    x: CALIBRATION_ORIGIN.x + (hex.col - 1) * HEX_COL_SPACING_PX,
    y:
      CALIBRATION_ORIGIN.y -
      hex.row * HEX_ROW_SPACING_PX -
      (isEvenColumn(hex.col) ? HEX_INRADIUS_PX : 0),
  }
}

/** 图幅范围（标定坐标），由**产物格清单**归纳，故削角与半格自动正确 */
function boardExtent(): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const hex of mapLayers.hexes) {
    const point = hexCalibrationPoint(hex)
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, maxX, minY, maxY }
}

const EXTENT = boardExtent()

/**
 * 图幅范围（**标定坐标**，非画布坐标）
 *
 * 由格清单归纳而来；地图图片按标定坐标直接铺放，故需要这个范围来求「标定原点 → 画布」的平移。
 */
export const BOARD_EXTENT = EXTENT

/** 画布尺寸（含留白与半格外廓；供 canvas 的 width/height） */
export const BOARD_SIZE_PX = {
  width: EXTENT.maxX - EXTENT.minX + 2 * BOARD_MARGIN_PX,
  height: EXTENT.maxY - EXTENT.minY + 2 * BOARD_MARGIN_PX,
} as const

/**
 * 标定坐标 → 画布坐标的平移量
 *
 * 标定点 (x, y) 落到画布就是 `(x + offset.x, y + offset.y)`；
 * 地图扫描图的像素坐标即标定坐标（标定参数由该图 `center_px` 反求，见 sync-map-config.mjs），
 * 故整幅地图图片直接以本偏移铺放，无需逐格对齐。
 */
export const CALIBRATION_CANVAS_OFFSET = {
  x: BOARD_MARGIN_PX - EXTENT.minX,
  y: BOARD_MARGIN_PX - EXTENT.minY,
} as const

/** 格心（**画布坐标**：x 向右、y 向下） */
export function hexCanvasPoint(hex: HexRef): { x: number; y: number } {
  const point = hexCalibrationPoint(hex)
  return {
    x: point.x - EXTENT.minX + BOARD_MARGIN_PX,
    // 标定 s 向南为正、画布 y 也向南为正 → 同向平移，**不翻转**（翻转会使地图南北颠倒）
    y: point.y - EXTENT.minY + BOARD_MARGIN_PX,
  }
}

/** flat-top 六角格顶点（画布坐标；自正右方起逆时针 60° 一份，共 6 点） */
export function hexCanvasCorners(hex: HexRef): { x: number; y: number }[] {
  const center = hexCanvasPoint(hex)
  const corners: { x: number; y: number }[] = []
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i
    corners.push({
      x: center.x + HEX_RADIUS_PX * Math.cos(angle),
      y: center.y - HEX_RADIUS_PX * Math.sin(angle),
    })
  }
  return corners
}

/** 命中结果：格号 + 到格心的距离（画布像素） */
export interface HexHit {
  hex: HexRef
  /**
   * 到格心的距离（画布像素）
   *
   * ★ 这不是判据，只是便于调用方排序/调试：六角格**密铺**，格心的 Voronoi 胞就是该格本身，
   *   故「最近格心」与「点在该格多边形内」等价 ⇒ 无须再拿一个半径去卡（见 `hitTestHex`）。
   */
  distance: number
}

/**
 * 画布坐标 → 格号（点击选格）
 *
 * 做法：由 x 反推列号（列间距固定），再在该列及左右各一列里按公式求出「最近行」，
 * 取九宫候选中最接近的格心；最近格心落在图外（削角空洞/图廓留白）则返回 null。
 * 不遍历 2156 格，也不建索引——式子是闭式的。
 *
 * ★ 为什么**不**再用半径卡一刀：六角格在板上密铺，任一点到「最近格心」的距离 ≤ **外接半径**
 *   （`HEX_RADIUS_PX`，顶点处恰为 R 且三格等距），而**内切半径**（`HEX_INRADIUS_PX` ≈ 0.866R）
 *   以内的判定会把**顶点与角区**误判为空白——实测「点在本格顶点附近却选不中本格」。
 *   又因密铺的格心 Voronoi 胞恰为该格多边形，「最近格心」本身就是精确的点在格内判据，
 *   故这里只保留「最近格心必须在图内」这一条（`isBoardHex`）。
 */
export function hitTestHex(x: number, y: number): HexHit | null {
  const calibrationX = x + EXTENT.minX - BOARD_MARGIN_PX
  // 与 hexCanvasPoint 互逆：画布 y 与标定 s 同向
  const calibrationY = y - BOARD_MARGIN_PX + EXTENT.minY
  const approxCol = Math.round((calibrationX - CALIBRATION_ORIGIN.x) / HEX_COL_SPACING_PX) + 1

  let best: HexHit | null = null
  for (const col of [approxCol - 1, approxCol, approxCol + 1]) {
    const offset = isEvenColumn(col) ? HEX_INRADIUS_PX : 0
    const approxRow = Math.round(
      (CALIBRATION_ORIGIN.y - offset - calibrationY) / HEX_ROW_SPACING_PX,
    )
    for (const row of [approxRow - 1, approxRow, approxRow + 1]) {
      // ★ 归一 `-0`：`Math.round(-0.2)` 得 `-0`，而 `2.-0` 与 `2.0` 在**格号文本**上是两个键
      //   （`hexLabel`／`parseHexPath` 都是文本比较）——第 0 行的命中必须落到 `0`。
      const hex = { col: col === 0 ? 0 : col, row: row === 0 ? 0 : row }
      const center = hexCanvasPoint(hex)
      const distance = Math.hypot(center.x - x, center.y - y)
      if (best === null || distance < best.distance) best = { hex, distance }
    }
  }
  if (best === null) return null
  // 最近格心落在图外（削角空洞/图廓留白）＝ 点到空白处
  if (!isBoardHex(best.hex)) return null
  return best
}

/** 图内格的画布多边形点串（供 canvas path / SVG points） */
export function hexPolygonPoints(hex: HexRef): string {
  return hexCanvasCorners(hex)
    .map((corner) => `${corner.x.toFixed(2)},${corner.y.toFixed(2)}`)
    .join(' ')
}

/**
 * 两相邻格的**共享格边**端点（画布坐标）
 *
 * 取法：格边的方向垂直于「本格格心 → 邻格格心」的连线，故在本格 6 个顶点里挑
 * 投影到该方向最大的两个顶点——几何上正是这两个顶点构成共享边。
 * a、b 不相邻时返回 null。
 */
export function hexsideCanvasSegment(
  a: HexRef,
  b: HexRef,
): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
  const centerA = hexCanvasPoint(a)
  const centerB = hexCanvasPoint(b)
  const dx = centerB.x - centerA.x
  const dy = centerB.y - centerA.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return null
  const ux = dx / length
  const uy = dy / length
  const ranked = hexCanvasCorners(a)
    .map((corner) => ({
      corner,
      projection: (corner.x - centerA.x) * ux + (corner.y - centerA.y) * uy,
    }))
    .sort((left, right) => right.projection - left.projection)
  const first = ranked[0]?.corner
  const second = ranked[1]?.corner
  if (first === undefined || second === undefined) return null
  return { from: first, to: second }
}

/** 用于「走一步」高亮的相邻格（只取图内格） */
export function boardNeighbors(hex: HexRef): HexRef[] {
  const out: HexRef[] = []
  for (const direction of ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const) {
    const candidate = neighbor(hex, direction)
    if (mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)) {
      out.push(candidate)
    }
  }
  return out
}

/** 图内格键集合（供调用方 O(1) 判「这格在图上吗」） */
export const BOARD_HEX_KEYS: ReadonlySet<string> = new Set(
  mapLayers.hexes.map((hex) => `${hex.col}.${hex.row}`),
)

/** 该格是否在图内（格清单判据，与引擎 isOnMap 同源） */
export function isBoardHex(hex: HexRef): boolean {
  return BOARD_HEX_KEYS.has(`${hex.col}.${hex.row}`)
}
