import { describe, expect, it } from 'vitest'

import {
  FIT_PADDING_PX,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  clampScale,
  clampViewport,
  expandRect,
  fitViewport,
  identityViewport,
  panBy,
  rectContainsPoint,
  rectsIntersect,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  worldUnitsPerScreenPixel,
  zoomAt,
  zoomToScale,
} from '@/render/viewport'

/**
 * 视口变换测试（C2）
 *
 * 视口是纯几何，故断言全部是**数学性质**而非某个魔法数字：
 *   · 正逆变换互消；· 以锚点缩放后锚点不动；· 适应窗口后整幅进得来且居中；
 *   · 平移约束后地图不会被拖出视口。
 */

const VIEW = { width: 1200, height: 800 }
const WORLD = { width: 5837, height: 3938 }

describe('坐标变换（screen = world × scale + offset）', () => {
  it('正变换与逆变换互消', () => {
    const viewport = { scale: 0.37, offsetX: -42.5, offsetY: 16 }
    const world = { x: 1234.5, y: 678.25 }
    const roundTrip = screenToWorld(worldToScreen(world, viewport), viewport)
    expect(roundTrip.x).toBeCloseTo(world.x, 9)
    expect(roundTrip.y).toBeCloseTo(world.y, 9)
  })

  it('scale=1 且无平移时恒等', () => {
    expect(worldToScreen({ x: 3, y: 4 }, identityViewport())).toEqual({ x: 3, y: 4 })
  })

  it('1 屏幕像素对应的世界距离 = 1 / scale', () => {
    expect(worldUnitsPerScreenPixel({ scale: 0.5, offsetX: 0, offsetY: 0 })).toBe(2)
  })
})

describe('缩放', () => {
  it('倍率夹在 [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.0001)).toBe(MIN_SCALE)
    expect(clampScale(999)).toBe(MAX_SCALE)
    expect(clampScale(0.5)).toBe(0.5)
  })

  it('以锚点缩放：锚点下的世界点在缩放前后落在同一屏幕位置（滚轮手感）', () => {
    const viewport = { scale: 0.3, offsetX: 12, offsetY: -30 }
    const anchor = { x: 640, y: 360 }
    const worldBefore = screenToWorld(anchor, viewport)
    const zoomed = zoomAt(viewport, anchor, ZOOM_STEP)
    expect(zoomed.scale).toBeCloseTo(0.3 * ZOOM_STEP, 9)
    const screenAfter = worldToScreen(worldBefore, zoomed)
    expect(screenAfter.x).toBeCloseTo(anchor.x, 6)
    expect(screenAfter.y).toBeCloseTo(anchor.y, 6)
  })

  it('缩放到上限后继续放大不再改变倍率，锚点仍然不动', () => {
    const viewport = { scale: MAX_SCALE, offsetX: 5, offsetY: 5 }
    const anchor = { x: 10, y: 10 }
    const zoomed = zoomAt(viewport, anchor, 2)
    expect(zoomed.scale).toBe(MAX_SCALE)
    expect(screenToWorld(anchor, zoomed)).toEqual(screenToWorld(anchor, viewport))
  })

  it('zoomToScale 以视口中心为锚点', () => {
    const viewport = { scale: 0.3, offsetX: 0, offsetY: 0 }
    const center = { x: VIEW.width / 2, y: VIEW.height / 2 }
    const worldCenter = screenToWorld(center, viewport)
    const zoomed = zoomToScale(viewport, 0.8, VIEW)
    expect(zoomed.scale).toBeCloseTo(0.8, 9)
    const after = worldToScreen(worldCenter, zoomed)
    expect(after.x).toBeCloseTo(center.x, 6)
    expect(after.y).toBeCloseTo(center.y, 6)
  })
})

describe('平移', () => {
  it('平移量直接叠加到 offset 上（世界坐标不动，屏幕整体位移）', () => {
    const viewport = { scale: 0.5, offsetX: 10, offsetY: 20 }
    const moved = panBy(viewport, -30, 45)
    expect(moved).toEqual({ scale: 0.5, offsetX: -20, offsetY: 65 })
  })
})

describe('可见世界矩形', () => {
  it('矩形左上/右下角即视口两角的世界坐标', () => {
    const viewport = { scale: 0.25, offsetX: -100, offsetY: -60 }
    const rect = visibleWorldRect(viewport, VIEW)
    const topLeft = screenToWorld({ x: 0, y: 0 }, viewport)
    const bottomRight = screenToWorld({ x: VIEW.width, y: VIEW.height }, viewport)
    expect(rect.x).toBeCloseTo(topLeft.x, 9)
    expect(rect.y).toBeCloseTo(topLeft.y, 9)
    expect(rect.width).toBeCloseTo(bottomRight.x - topLeft.x, 9)
    expect(rect.height).toBeCloseTo(bottomRight.y - topLeft.y, 9)
  })

  it('矩形外扩/相交/含点三个谓词', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 }
    const expanded = expandRect(rect, 5)
    expect(expanded).toEqual({ x: -5, y: -5, width: 20, height: 20 })
    expect(rectContainsPoint(rect, { x: 10, y: 10 })).toBe(true)
    expect(rectContainsPoint(rect, { x: 10.5, y: 0 })).toBe(false)
    expect(rectsIntersect(rect, { x: 10, y: 10, width: 1, height: 1 })).toBe(true)
    expect(rectsIntersect(rect, { x: 20, y: 20, width: 1, height: 1 })).toBe(false)
  })
})

describe('适应窗口与平移约束', () => {
  it('适应窗口：整幅世界都落在视口内（含内边距）', () => {
    const viewport = fitViewport(WORLD, VIEW)
    const corners = [
      { x: 0, y: 0 },
      { x: WORLD.width, y: 0 },
      { x: 0, y: WORLD.height },
      { x: WORLD.width, y: WORLD.height },
    ]
    for (const corner of corners) {
      const screen = worldToScreen(corner, viewport)
      expect(screen.x).toBeGreaterThanOrEqual(FIT_PADDING_PX - 0.001)
      expect(screen.x).toBeLessThanOrEqual(VIEW.width - FIT_PADDING_PX + 0.001)
      expect(screen.y).toBeGreaterThanOrEqual(FIT_PADDING_PX - 0.001)
      expect(screen.y).toBeLessThanOrEqual(VIEW.height - FIT_PADDING_PX + 0.001)
    }
  })

  it('适应窗口：两个方向都居中', () => {
    const viewport = fitViewport(WORLD, VIEW)
    const left = worldToScreen({ x: 0, y: 0 }, viewport).x
    const right = worldToScreen({ x: WORLD.width, y: 0 }, viewport).x
    expect(left).toBeCloseTo(VIEW.width - right, 6)
  })

  it('适应窗口得到的倍率同样受 [MIN_SCALE, MAX_SCALE] 约束', () => {
    const tiny = fitViewport(WORLD, { width: 20, height: 20 })
    expect(tiny.scale).toBe(MIN_SCALE)
  })

  it('地图大于视口：平移被夹住，不露出空边', () => {
    const viewport = { scale: 1, offsetX: 500, offsetY: 500 }
    const clamped = clampViewport(viewport, WORLD, VIEW)
    expect(clamped.offsetX).toBe(0)
    expect(clamped.offsetY).toBe(0)

    const draggedFar = clampViewport({ scale: 1, offsetX: -99999, offsetY: -99999 }, WORLD, VIEW)
    expect(draggedFar.offsetX).toBeCloseTo(VIEW.width - WORLD.width, 6)
    expect(draggedFar.offsetY).toBeCloseTo(VIEW.height - WORLD.height, 6)
  })

  it('地图小于视口：强制居中', () => {
    const viewport = { scale: 0.1, offsetX: 999, offsetY: -999 }
    const clamped = clampViewport(viewport, WORLD, VIEW)
    expect(clamped.offsetX).toBeCloseTo((VIEW.width - WORLD.width * 0.1) / 2, 6)
    expect(clamped.offsetY).toBeCloseTo((VIEW.height - WORLD.height * 0.1) / 2, 6)
  })

  it('倍率不变：约束只动平移量', () => {
    const clamped = clampViewport({ scale: 0.42, offsetX: 10, offsetY: 10 }, WORLD, VIEW)
    expect(clamped.scale).toBe(0.42)
  })
})
