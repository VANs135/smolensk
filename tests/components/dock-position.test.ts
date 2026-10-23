import { describe, expect, it } from 'vitest'

import {
  clampDockOffset,
  createDockMemory,
  DOCK_MIN_VISIBLE_PX,
} from '@/components/map/dock-position'

/**
 * B4：唯一会话框的落位规则（纯函数）
 *
 * 这是「看不见的几何」——回弹对不对，肉眼只能靠"拖出去试试"，所以用单测钉住。
 * 容器约定：地图视口 1000×600（视口坐标系），面板 380×200 停在右上角（右内沿 12px、上内沿 12px）。
 */

const container = { left: 0, top: 100, right: 1000, bottom: 700 }
const base = { left: 608, top: 112, right: 988, bottom: 312 }
const headerHeight = 32

const clampWith = (offset: { dx: number; dy: number }, minVisible?: number) =>
  clampDockOffset({ container, base, offset, headerHeight, minVisible })

describe('B4：会话框回弹（clampDockOffset）', () => {
  it('在容器内 ⇒ 原样保留（不无缘无故动玩家摆好的位置）', () => {
    expect(clampWith({ dx: -100, dy: 50 })).toEqual({ dx: -100, dy: 50 })
  })

  it('往右拖出容器 ⇒ 面板左沿被夹到「容器右沿 − 最小可见量」', () => {
    const result = clampWith({ dx: 1000, dy: 0 })
    expect(result.dx).toBe(container.right - DOCK_MIN_VISIBLE_PX - base.left)
    // 反空转：夹后的位置确实在容器内留有可见量
    expect(base.left + result.dx).toBe(container.right - DOCK_MIN_VISIBLE_PX)
  })

  it('往左拖出容器 ⇒ 面板右沿被夹到「容器左沿 + 最小可见量」', () => {
    const result = clampWith({ dx: -2000, dy: 0 })
    expect(base.right + result.dx).toBe(container.left + DOCK_MIN_VISIBLE_PX)
  })

  it('往上拖出容器 ⇒ 标题栏下沿仍留在容器上沿之下 ≥ 最小可见量', () => {
    const result = clampWith({ dx: 0, dy: -500 })
    expect(base.top + result.dy + headerHeight).toBe(container.top + DOCK_MIN_VISIBLE_PX)
  })

  it('往下拖出容器 ⇒ 标题栏上沿仍留在容器下沿之上 ≥ 最小可见量', () => {
    const result = clampWith({ dx: 0, dy: 5000 })
    expect(base.top + result.dy).toBe(container.bottom - DOCK_MIN_VISIBLE_PX)
  })

  it('面板拉到最低时标题栏仍留有可见量（够抓住拖回来——回弹保的是"能救回来"）', () => {
    const result = clampWith({ dx: 0, dy: 5000 })
    const headerTop = base.top + result.dy
    // 规格是「标题栏夹回容器内 ≥ 8px」：**至少** 8px 在容器里，而不是整条标题栏都在
    // （否则没法把面板停靠在底部边缘读地图；8px 的一条仍抓得住，拖得回来）
    expect(headerTop).toBeLessThan(container.bottom)
    expect(container.bottom - headerTop).toBe(DOCK_MIN_VISIBLE_PX)
    expect(headerTop).toBeGreaterThan(container.top)
  })

  it('最小可见量可调（0 ⇒ 允许整块拖出，用于"贴边停靠"这类观感）', () => {
    expect(clampWith({ dx: 1000, dy: 0 }, 0).dx).toBe(container.right - base.left)
  })

  it('面板比容器宽 ⇒ 仍保证 8px 可见（`resize: both` 让玩家能把面板拉宽，也不能丢）', () => {
    const narrow = { left: 0, top: 0, right: 300, bottom: 300 }
    const panel = { left: 0, top: 0, right: 500, bottom: 200 }
    const result = clampDockOffset({
      container: narrow,
      base: panel,
      offset: { dx: 5000, dy: 0 },
      headerHeight,
    })
    // 保证是「至少 8px 与容器相交」，不承诺夹到哪条边（面板比容器宽时两边不可能都贴住）
    expect(panel.left + result.dx).toBeLessThanOrEqual(narrow.right - DOCK_MIN_VISIBLE_PX)
    expect(panel.right + result.dx).toBeGreaterThanOrEqual(narrow.left + DOCK_MIN_VISIBLE_PX)
  })

  it('容器量不到尺寸（隐藏 / 未布局，0×0）⇒ 回默认位置（夹没有意义，且绝不能把面板留在视口外）', () => {
    const hidden = { left: 0, top: 0, right: 0, bottom: 0 }
    const result = clampDockOffset({
      container: hidden,
      base,
      offset: { dx: 900, dy: 900 },
      headerHeight,
    })
    expect(result).toEqual({ dx: 0, dy: 0 })
  })

  it('通用保证：任何非退化输入下，两个轴都至少留 `minVisible` 与容器相交', () => {
    const containerFor = (width: number, height: number) => ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
    })
    for (const [width, height] of [
      [1000, 600],
      [400, 300],
      [200, 150],
      [40, 40],
    ] as const) {
      const box = containerFor(width, height)
      for (const offset of [
        { dx: 0, dy: 0 },
        { dx: 9999, dy: 9999 },
        { dx: -9999, dy: -9999 },
        { dx: 9999, dy: -9999 },
      ]) {
        const result = clampDockOffset({ container: box, base, offset, headerHeight })
        const panel = {
          left: base.left + result.dx,
          right: base.right + result.dx,
          top: base.top + result.dy,
        }
        // 横向有交集，竖向标题栏有交集（两者都按"≥ 最小可见量"判）
        expect(panel.right).toBeGreaterThanOrEqual(box.left + DOCK_MIN_VISIBLE_PX)
        expect(panel.left).toBeLessThanOrEqual(box.right - DOCK_MIN_VISIBLE_PX)
        expect(panel.top + headerHeight).toBeGreaterThanOrEqual(box.top + DOCK_MIN_VISIBLE_PX)
        expect(panel.top).toBeLessThanOrEqual(box.bottom - DOCK_MIN_VISIBLE_PX)
      }
    }
  })

  it('非有限输入一律归零（transform 里出现 NaN 会让面板彻底消失且拖不回来）', () => {
    expect(clampDockOffset({ container, base, offset: { dx: NaN, dy: 10 }, headerHeight })).toEqual(
      { dx: 0, dy: 0 },
    )
    expect(
      clampDockOffset({
        container,
        base,
        offset: { dx: 0, dy: 0 },
        headerHeight: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ dx: 0, dy: 0 })
  })
})

describe('B4：会话框位置记忆（createDockMemory）', () => {
  it('没记过 ⇒ recall 给 null（调用方据此用默认右上角）', () => {
    expect(createDockMemory().recall('combat')).toBeNull()
  })

  it('记过 ⇒ 按类型分别取回（同类记得、换类型回默认）', () => {
    const memory = createDockMemory()
    memory.remember('combat', { dx: -120, dy: 40 })
    expect(memory.recall('combat')).toEqual({ dx: -120, dy: 40 })
    // 换类型（轰炸）没有记录 ⇒ 调用方会回默认位置
    expect(memory.recall('barrage')).toBeNull()
  })

  it('取回的是副本（调用方改它不会污染记忆）', () => {
    const memory = createDockMemory()
    memory.remember('combat', { dx: -120, dy: 40 })
    const first = memory.recall('combat')!
    first.dx = 999
    expect(memory.recall('combat')).toEqual({ dx: -120, dy: 40 })
  })

  it('偏移为零视同回默认 ⇒ 不留记录（免得记忆表攒一堆假位置）', () => {
    const memory = createDockMemory()
    memory.remember('combat', { dx: -120, dy: 40 })
    memory.remember('combat', { dx: 0, dy: 0 })
    expect(memory.recall('combat')).toBeNull()
  })

  it('非有限偏移不记（拖动中被 NaN 污染的位置不该被记住）', () => {
    const memory = createDockMemory()
    memory.remember('combat', { dx: NaN, dy: 0 })
    expect(memory.recall('combat')).toBeNull()
  })

  it('forget / clear 能清（换剧本、重开一局用）', () => {
    const memory = createDockMemory()
    memory.remember('combat', { dx: 10, dy: 10 })
    memory.remember('barrage', { dx: 20, dy: 20 })
    memory.forget('combat')
    expect(memory.recall('combat')).toBeNull()
    expect(memory.recall('barrage')).toEqual({ dx: 20, dy: 20 })
    memory.clear()
    expect(memory.recall('barrage')).toBeNull()
  })
})
