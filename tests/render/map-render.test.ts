import { describe, expect, it } from 'vitest'

import { mapConfig, mapLayers } from '@/data'
import {
  BOARD_MARGIN_PX,
  BOARD_SIZE_PX,
  CALIBRATION_CANVAS_OFFSET,
  HEX_RADIUS_PX,
  hexCalibrationPoint,
  hexCanvasPoint,
} from '@/render/map-layout'
import {
  MAP_IMAGE_ORIGIN,
  MAP_IMAGE_SRC,
  canDraw,
  visibleEdges,
  visibleHexes,
  visiblePrintedHedgehogs,
  visibleWorldRectWithMargin,
} from '@/render/map-render'
import { fitViewport, visibleWorldRect, type Size, type ViewportTransform } from '@/render/viewport'

/**
 * 地图渲染的**几何与裁剪**测试（C2）
 *
 * 渲染本身需要 Canvas（浏览器），故这里只测「不碰 DOM 的部分」：
 *   · 地图图片的铺放位置是否由标定推出（不手填数字）；
 *   · 视口裁剪是否与「全量遍历 + 精确判定」的结果**完全一致**（既不漏，也不多）。
 */

/** 工程尺度：整幅约 5837 × 3938 世界像素 */
const FULL_VIEW: Size = { width: 2000, height: 1400 }
const SMALL_VIEW: Size = { width: 640, height: 420 }

/** 参照实现：全量遍历 + 精确判定（与 visibleHexes 的窗口法互为独立实现） */
function bruteForceHexes(viewport: ViewportTransform, viewSize: Size) {
  const rect = visibleWorldRectWithMargin(viewport, viewSize)
  return mapLayers.hexes.filter((hex) => {
    const center = hexCanvasPoint(hex)
    return (
      center.x >= rect.x &&
      center.x <= rect.x + rect.width &&
      center.y >= rect.y &&
      center.y <= rect.y + rect.height
    )
  })
}

function keyOf(hex: { col: number; row: number }): string {
  return `${hex.col}.${hex.row}`
}

describe('地图图片铺放（专规无、仅版式）', () => {
  it('图片路径为素材库原文件名（CODE_SPEC §4：图档名一律不改）', () => {
    expect(MAP_IMAGE_SRC).toBe('/map/Smolensk-map-011717.png')
  })

  it('铺放原点 = 标定原点 → 画布坐标的平移量，由标定参数推出而非手填', () => {
    expect(MAP_IMAGE_ORIGIN).toEqual(CALIBRATION_CANVAS_OFFSET)
    expect(MAP_IMAGE_ORIGIN.x).toBeCloseTo(BOARD_MARGIN_PX - mapConfig.geometry.originX, 6)
  })

  it('画布坐标 = 标定坐标 + 图片铺放原点 ⇒ 扫描图像素坐标可直接当标定坐标用', () => {
    // map-config.geometry 的 (originX, originY) 就是第 1 列第 0 行的格心
    expect(hexCalibrationPoint({ col: 1, row: 0 })).toEqual({
      x: mapConfig.geometry.originX,
      y: mapConfig.geometry.originY,
    })
    // 对每个图内格：画布坐标减去铺放原点，必须回到标定坐标
    const samples = [mapLayers.hexes[0]!, mapLayers.hexes[1000]!, mapLayers.hexes.at(-1)!]
    for (const hex of samples) {
      const calibration = hexCalibrationPoint(hex)
      const canvasPoint = hexCanvasPoint(hex)
      expect(canvasPoint.x - MAP_IMAGE_ORIGIN.x).toBeCloseTo(calibration.x, 6)
      expect(canvasPoint.y - MAP_IMAGE_ORIGIN.y).toBeCloseTo(calibration.y, 6)
    }
  })
})

describe('视口裁剪：可见格', () => {
  it('整幅入视口时，返回全部图内格', () => {
    const viewport = fitViewport(BOARD_SIZE_PX, FULL_VIEW)
    const hexes = visibleHexes(viewport, FULL_VIEW)
    expect(hexes).toHaveLength(mapLayers.hexes.length)
    expect(new Set(hexes.map(keyOf)).size).toBe(mapLayers.hexes.length)
  })

  it('窗口法与全量遍历逐格一致（既不漏也不多）', () => {
    const cases: ViewportTransform[] = [
      fitViewport(BOARD_SIZE_PX, SMALL_VIEW),
      { scale: 1, offsetX: -3000, offsetY: -2200 },
      { scale: 0.5, offsetX: -100, offsetY: -90 },
      { scale: 0.12, offsetX: -20, offsetY: -10 },
      { scale: 2, offsetX: -6400, offsetY: -4300 },
    ]
    for (const viewport of cases) {
      const window = visibleHexes(viewport, SMALL_VIEW).map(keyOf).sort()
      const brute = bruteForceHexes(viewport, SMALL_VIEW).map(keyOf).sort()
      expect(window).toEqual(brute)
    }
  })

  it('缩小到局部时确实裁掉了大部分格（裁剪有效，不是全量重绘）', () => {
    // 放大到 1 倍并聚焦 Pochinok（36.13）附近
    const center = hexCanvasPoint({ col: 36, row: 13 })
    const viewport: ViewportTransform = {
      scale: 1,
      offsetX: SMALL_VIEW.width / 2 - center.x,
      offsetY: SMALL_VIEW.height / 2 - center.y,
    }
    const hexes = visibleHexes(viewport, SMALL_VIEW)
    expect(hexes.length).toBeGreaterThan(0)
    expect(hexes.length).toBeLessThan(200)
    expect(hexes.map(keyOf)).toContain('36.13')
    expect(hexes.map(keyOf)).not.toContain('2.10')
  })

  it('每个返回的格，其格心都落在「可见矩形外扩一格半径」之内', () => {
    const viewport = fitViewport(BOARD_SIZE_PX, SMALL_VIEW)
    const rect = visibleWorldRectWithMargin(viewport, SMALL_VIEW)
    for (const hex of visibleHexes(viewport, SMALL_VIEW)) {
      const center = hexCanvasPoint(hex)
      expect(center.x).toBeGreaterThanOrEqual(rect.x)
      expect(center.x).toBeLessThanOrEqual(rect.x + rect.width)
      expect(center.y).toBeGreaterThanOrEqual(rect.y)
      expect(center.y).toBeLessThanOrEqual(rect.y + rect.height)
    }
  })

  it('视口扩大后可见格集合只增不减（同一锚点单调性）', () => {
    const viewport = { scale: 0.4, offsetX: -500, offsetY: -500 }
    const small = new Set(visibleHexes(viewport, { width: 300, height: 300 }).map(keyOf))
    const large = new Set(visibleHexes(viewport, { width: 900, height: 900 }).map(keyOf))
    for (const key of small) expect(large.has(key)).toBe(true)
  })
})

describe('视口裁剪：格边要素与印刷工事', () => {
  it('整幅入视口时返回全部格边要素', () => {
    const viewport = fitViewport(BOARD_SIZE_PX, FULL_VIEW)
    expect(visibleEdges(viewport, FULL_VIEW)).toHaveLength(mapLayers.edges.length)
  })

  it('局部视口下格边要素被裁剪，且返回项都是原数据的子集', () => {
    const center = hexCanvasPoint({ col: 36, row: 13 })
    const viewport: ViewportTransform = {
      scale: 1,
      offsetX: 320 - center.x,
      offsetY: 210 - center.y,
    }
    const edges = visibleEdges(viewport, SMALL_VIEW)
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.length).toBeLessThan(mapLayers.edges.length)
    for (const edge of edges) expect(mapLayers.edges).toContain(edge)
  })

  it('整幅入视口时返回全部印刷工事（专规 1.3a 共 58 个）', () => {
    const viewport = fitViewport(BOARD_SIZE_PX, FULL_VIEW)
    const hogs = visiblePrintedHedgehogs(viewport, FULL_VIEW)
    expect(hogs).toHaveLength(mapLayers.printedHedgehogs.length)
    expect(hogs.length).toBeGreaterThan(0)
  })

  it('局部视口下印刷工事数量收敛', () => {
    const center = hexCanvasPoint({ col: 36, row: 13 })
    const viewport: ViewportTransform = {
      scale: 1,
      offsetX: 320 - center.x,
      offsetY: 210 - center.y,
    }
    expect(visiblePrintedHedgehogs(viewport, SMALL_VIEW).length).toBeLessThan(
      mapLayers.printedHedgehogs.length,
    )
  })
})

describe('可见矩形与兜底', () => {
  it('裁剪用的可见矩形 = 视口世界矩形外扩一格半径', () => {
    const viewport = { scale: 0.5, offsetX: -100, offsetY: -100 }
    const plain = visibleWorldRect(viewport, SMALL_VIEW)
    const expanded = visibleWorldRectWithMargin(viewport, SMALL_VIEW)
    expect(expanded.x).toBeLessThan(plain.x)
    // 外扩量左右各一份 ⇒ 宽高各多 2 × 外接圆半径
    expect(expanded.width - plain.width).toBeCloseTo(2 * HEX_RADIUS_PX, 6)
    expect(expanded.height - plain.height).toBeCloseTo(2 * HEX_RADIUS_PX, 6)
  })

  it('容器尺寸为 0 时不绘制（避免除零）', () => {
    expect(canDraw({ width: 0, height: 400 })).toBe(false)
    expect(canDraw({ width: 400, height: 0 })).toBe(false)
    expect(canDraw(SMALL_VIEW)).toBe(true)
  })
})
