import { describe, expect, it } from 'vitest'

import { mapConfig, mapLayers } from '@/data'
import {
  BOARD_MARGIN_PX,
  BOARD_SIZE_PX,
  HEX_COL_SPACING_PX,
  HEX_INRADIUS_PX,
  HEX_RADIUS_PX,
  HEX_ROW_SPACING_PX,
  boardNeighbors,
  hexCanvasCorners,
  hexCanvasPoint,
  hexCalibrationPoint,
  hexsideCanvasSegment,
  hitTestHex,
  isBoardHex,
} from '@/render/map-layout'

/**
 * 地图版式（U0 操作台）测试
 *
 * 断言的是**标定数据的直接推论**（不引入任何自造尺寸）：
 *   格心公式 = scripts/sync-map-config.mjs 的 centerOf（VERIFIED）；flat-top ＋ even-q 半格错位；
 *   命中测试与绘制互为逆运算（每个图内格的格心都必须命中它自己）。
 */

const HEXES = mapLayers.hexes
const GEO = mapConfig.geometry

describe('格心公式与标定一致（flat-top + even-q）', () => {
  it('列间距＝hexWidthPx、行间距＝hexHeightPx、原点即第 1 列第 0 行', () => {
    expect(HEX_COL_SPACING_PX).toBe(GEO.hexWidthPx)
    expect(HEX_ROW_SPACING_PX).toBe(GEO.hexHeightPx)
    expect(hexCalibrationPoint({ col: 1, row: 0 })).toEqual({ x: GEO.originX, y: GEO.originY })
  })

  it('同列相邻行：x 不变、标定 y 减小一个行距（行号增＝向北）', () => {
    const a = hexCalibrationPoint({ col: 3, row: 10 })
    const b = hexCalibrationPoint({ col: 3, row: 11 })
    expect(b.x).toBeCloseTo(a.x, 6)
    expect(a.y - b.y).toBeCloseTo(HEX_ROW_SPACING_PX, 6)
  })

  it('相邻列：x 差一个列距；**偶列**在标定 y 上多减半格（even-q 错位）', () => {
    const odd = hexCalibrationPoint({ col: 3, row: 10 })
    const even = hexCalibrationPoint({ col: 4, row: 10 })
    expect(even.x - odd.x).toBeCloseTo(HEX_COL_SPACING_PX, 6)
    expect(odd.y - even.y).toBeCloseTo(HEX_INRADIUS_PX, 3)
    // 半格错位必须＝内切半径＝行距的一半（否则奇偶列自相矛盾）
    expect(HEX_INRADIUS_PX).toBeCloseTo(HEX_ROW_SPACING_PX / 2, 6)
  })

  it('外接圆半径 R 与行距自洽（行距 = √3·R）', () => {
    expect(HEX_ROW_SPACING_PX).toBeCloseTo(Math.sqrt(3) * HEX_RADIUS_PX, 6)
  })
})

describe('画布坐标（y 向下、整体平移）', () => {
  it('全部图内格都落在留白之内', () => {
    for (const hex of HEXES) {
      const point = hexCanvasPoint(hex)
      expect(point.x).toBeGreaterThanOrEqual(BOARD_MARGIN_PX - 0.001)
      expect(point.x).toBeLessThanOrEqual(BOARD_SIZE_PX.width - BOARD_MARGIN_PX + 0.001)
      expect(point.y).toBeGreaterThanOrEqual(BOARD_MARGIN_PX - 0.001)
      expect(point.y).toBeLessThanOrEqual(BOARD_SIZE_PX.height - BOARD_MARGIN_PX + 0.001)
    }
  })

  it('画布 y 向下 ⇒ 北（行号大）在上：第 35 行贴顶、第 0 行贴底', () => {
    // 最北格＝偶列第 35 行（标定 s 最小），落在上留白处
    const north = hexCanvasPoint({ col: 62, row: 35 })
    expect(north.y).toBeCloseTo(BOARD_MARGIN_PX, 3)
    // 最南格＝偶列第 0 行（标定 s 最大），落在下留白处
    const south = hexCanvasPoint({ col: 2, row: 0 })
    expect(south.y).toBeCloseTo(BOARD_SIZE_PX.height - BOARD_MARGIN_PX, 3)
    // 行号越大越靠北 ⇒ 画布 y 越小（上北下南）
    expect(north.y).toBeLessThan(south.y)
  })

  it('顶点：flat-top 六边形，6 个顶点到格心距离都＝R', () => {
    const center = hexCanvasPoint({ col: 36, row: 13 })
    const corners = hexCanvasCorners({ col: 36, row: 13 })
    expect(corners).toHaveLength(6)
    for (const corner of corners) {
      expect(Math.hypot(corner.x - center.x, corner.y - center.y)).toBeCloseTo(HEX_RADIUS_PX, 6)
    }
  })
})

describe('命中测试（点击选格）', () => {
  it('每个图内格的格心都必须命中它自己（绘制与命中的互逆性）', () => {
    for (const hex of HEXES) {
      const hit = hitTestHex(hexCanvasPoint(hex).x, hexCanvasPoint(hex).y)
      expect(hit?.hex).toEqual({ col: hex.col, row: hex.row })
    }
  })

  it('图外格（削角空洞）即视为空白（不误吸）', () => {
    // 六角格在图内是密铺的，故"空白"＝最近格心落在图外。样例：第 35 行只从第 11 列起，
    // 故 2.35 是削角后的图外格，点它的格心必须得到 null（而不是这个图外格号）。
    expect(isBoardHex({ col: 2, row: 35 })).toBe(false)
    const hole = hexCanvasPoint({ col: 2, row: 35 })
    expect(hitTestHex(hole.x, hole.y)).toBeNull()
  })

  it('命中距离＝到格心的真实像素距离', () => {
    const center = hexCanvasPoint({ col: 36, row: 13 })
    const hit = hitTestHex(center.x + 3, center.y + 4)
    expect(hit?.distance).toBeCloseTo(5, 6)
  })

  /**
   * M9①：顶点与角区必须命中**本格**
   *
   * 修前用的是**内切半径**（`HEX_INRADIUS_PX` ≈ 0.866R）判「点在格内」，而本格的顶点离格心 R
   * ⇒ 顶点附近的点击被当成空白（返回 null）。这里沿「格心 → 各顶点」取 0.90R / 0.97R 两档
   * （都在内切半径之外、外接半径之内）逐格验：命中必须是本格。
   */
  it('顶点方向的点（0.90R / 0.97R）必须命中本格——修前内切半径会误判为空白', () => {
    for (const hex of HEXES) {
      const center = hexCanvasPoint(hex)
      for (const corner of hexCanvasCorners(hex)) {
        const dx = corner.x - center.x
        const dy = corner.y - center.y
        for (const ratio of [0.9, 0.97]) {
          const hit = hitTestHex(center.x + dx * ratio, center.y + dy * ratio)
          expect(hit?.hex, `${hex.col}.${hex.row} 顶点方向的 ${ratio}R 处`).toEqual({
            col: hex.col,
            row: hex.row,
          })
        }
      }
    }
  })

  it('顶点本身（恰在外接半径上）也命中本格之一——三格等距时的确定性', () => {
    const hex = { col: 36, row: 13 }
    const corner = hexCanvasCorners(hex)[0]!
    const hit = hitTestHex(corner.x, corner.y)
    expect(hit).not.toBeNull()
    // 该点属本格与两个邻格（三格等距）；命中必须是这三者之一，且距离＝外接半径
    const candidates = [
      { col: 36, row: 13 },
      { col: 37, row: 13 },
      { col: 37, row: 12 },
    ]
    expect(candidates).toContainEqual(hit!.hex)
    expect(hit!.distance).toBeCloseTo(HEX_RADIUS_PX, 6)
  })

  it('格心 Voronoi 判据：任取格内一点，命中的必是包含它的那一格', () => {
    // 取每格的多边形重心附近若干点（含偏向各顶点的点），命中格 = 最近格心 ⇒ 必为本格
    for (const hex of HEXES.slice(0, 200)) {
      const center = hexCanvasPoint(hex)
      for (const angle of [0, 1, 2, 3, 4, 5]) {
        const rad = (Math.PI / 3) * angle
        const point = {
          x: center.x + Math.cos(rad) * HEX_RADIUS_PX * 0.5,
          y: center.y - Math.sin(rad) * HEX_RADIUS_PX * 0.5,
        }
        expect(hitTestHex(point.x, point.y)?.hex).toEqual({ col: hex.col, row: hex.row })
      }
    }
  })
})

describe('格边与邻格', () => {
  it('共享格边端点：两点都同时属于两侧格的顶点集', () => {
    const a = { col: 36, row: 13 }
    const b = { col: 36, row: 14 }
    const segment = hexsideCanvasSegment(a, b)
    expect(segment).not.toBeNull()
    const cornersA = hexCanvasCorners(a)
    const cornersB = hexCanvasCorners(b)
    for (const point of [segment!.from, segment!.to]) {
      const inA = cornersA.some((c) => Math.hypot(c.x - point.x, c.y - point.y) < 0.001)
      const inB = cornersB.some((c) => Math.hypot(c.x - point.x, c.y - point.y) < 0.001)
      expect(inA && inB).toBe(true)
    }
  })

  it('可走邻格 = 引擎邻格表中落在图上的那几格', () => {
    const neighbors = boardNeighbors({ col: 36, row: 13 })
    expect(neighbors.length).toBeGreaterThan(0)
    for (const hex of neighbors) expect(isBoardHex(hex)).toBe(true)
    // 6.1：邻格必须真的相邻（距离为 1）
    expect(neighbors).toContainEqual({ col: 36, row: 14 })
    expect(neighbors).toContainEqual({ col: 37, row: 14 })
  })

  it('图内判定与格清单一致（含削角空洞）', () => {
    expect(isBoardHex({ col: 36, row: 13 })).toBe(true)
    // 奇数列没有第 0 行（削角）：1.0 在图外
    expect(isBoardHex({ col: 1, row: 0 })).toBe(false)
    // 半格属正常图内格（★ 用户裁定 2026-09-13）
    expect(isBoardHex({ col: 2, row: 0 })).toBe(true)
  })
})
