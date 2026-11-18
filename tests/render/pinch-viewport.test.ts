import { describe, expect, it } from 'vitest'

import { MAX_SCALE, MIN_SCALE, pinchViewport, screenToWorld } from '@/render/viewport'

/**
 * 触摸屏双指捏合的一步变换（`pinchViewport`）
 *
 * 捏合同时有两种意图：**缩放**（两指距离变化）与**平移**（两指中点移动）。
 * 这条几何在真机上只能靠手感判对错，故在这里钉两条**可断言**的性质：
 *   ① 起始中点下的世界点，缩放后必须仍落在**当前中点**（玩家指间那格不跑）；
 *   ② 距离不变（factor = 1）时退化成纯平移，倍率一点都不许变。
 */

const viewport = { scale: 0.5, offsetX: -120, offsetY: 40 }

/** 世界点是否落在屏幕点附近（浮点容差） */
function expectScreenNear(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
  tolerance = 1e-6,
): void {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
  void tolerance
}

describe('双指捏合：锚点跟手', () => {
  it('★ 起始中点下的世界点，缩放后落在当前中点（指间那格不跑）', () => {
    const anchor = { x: 300, y: 200 }
    const target = { x: 340, y: 180 }
    const worldUnderAnchor = screenToWorld(anchor, viewport)

    const next = pinchViewport(viewport, anchor, target, 1.6)
    expect(next.scale).toBeCloseTo(0.8, 6)
    // 同一个世界点，在新视口下换算后的屏幕位置 == 当前中点
    expectScreenNear(
      {
        x: worldUnderAnchor.x * next.scale + next.offsetX,
        y: worldUnderAnchor.y * next.scale + next.offsetY,
      },
      target,
    )
  })

  it('中点不动 ⇒ 退化成"以中点为锚点缩放"（与滚轮缩放同一套语义）', () => {
    const anchor = { x: 500, y: 400 }
    const world = screenToWorld(anchor, viewport)
    const next = pinchViewport(viewport, anchor, anchor, 2)
    expectScreenNear(
      { x: world.x * next.scale + next.offsetX, y: world.y * next.scale + next.offsetY },
      anchor,
    )
  })

  it('★ 距离不变（factor = 1）⇒ 倍率不动、只平移（两指一起拖不该顺手放大）', () => {
    const next = pinchViewport(viewport, { x: 100, y: 100 }, { x: 160, y: 130 }, 1)
    expect(next.scale).toBeCloseTo(viewport.scale, 10)
    expect(next.offsetX).toBeCloseTo(viewport.offsetX + 60, 10)
    expect(next.offsetY).toBeCloseTo(viewport.offsetY + 30, 10)
  })

  it('倍率夹在 [MIN_SCALE, MAX_SCALE]：手指分得再开也不会把地图拉成无穷大', () => {
    expect(pinchViewport(viewport, { x: 0, y: 0 }, { x: 0, y: 0 }, 1e6).scale).toBe(MAX_SCALE)
    expect(pinchViewport(viewport, { x: 0, y: 0 }, { x: 0, y: 0 }, 1e-6).scale).toBe(MIN_SCALE)
  })

  it('每次都从**手势起始**视口重算 ⇒ 同一段手势重复调用结果一致（不累积误差）', () => {
    const anchor = { x: 200, y: 150 }
    const target = { x: 250, y: 170 }
    const first = pinchViewport(viewport, anchor, target, 1.25)
    const second = pinchViewport(viewport, anchor, target, 1.25)
    expect(second).toEqual(first)
  })
})
