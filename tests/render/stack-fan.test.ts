import { describe, expect, it } from 'vitest'

import { HEX_RADIUS_PX, hexCanvasPoint } from '@/render/map-layout'
import {
  STACK_FAN_PAGE_SIZE,
  TOKEN_SIZE_PX,
  counterHitSize,
  defaultSelectionOf,
  hitStackFan,
  normalizePage,
  pageCountOf,
  stackFanLayout,
  toggleSelection,
} from '@/render/stack-fan'

const HEX = { col: 15, row: 10 }
const CENTER = hexCanvasPoint(HEX)

describe('格内展开几何', () => {
  it.each([1, 0.74, 0.68, 0.58, 0.58, 0.5].map((ratio, index) => [index + 1, ratio] as const))(
    '%i 枚按指定尺寸排布，四角不越格，每枚仍可单独命中',
    (total, ratio) => {
      const layout = stackFanLayout({ hex: HEX, total })
      expect(layout.slots).toHaveLength(total)
      expect(layout.pageBadge).toBeNull()
      for (const slot of layout.slots) {
        expect(slot.size).toBeCloseTo(TOKEN_SIZE_PX * ratio)
        for (const dx of [0, slot.size]) {
          for (const dy of [0, slot.size]) {
            const x = Math.abs(slot.x + dx - CENTER.x)
            const y = Math.abs(slot.y + dy - CENTER.y)
            expect(y).toBeLessThanOrEqual((Math.sqrt(3) / 2) * HEX_RADIUS_PX)
            expect(x + y / Math.sqrt(3)).toBeLessThanOrEqual(HEX_RADIUS_PX)
          }
        }
        expect(
          hitStackFan({ layout, point: { x: slot.x + slot.size / 2, y: slot.y + slot.size / 2 } }),
        ).toEqual({ kind: 'slot', index: slot.index })
      }
    },
  )

  it('两枚左右并排，三枚品字排列', () => {
    const two = stackFanLayout({ hex: HEX, total: 2 })
    expect(two.slots[0]!.x).toBeLessThan(two.slots[1]!.x)
    expect(two.slots[0]!.y).toBe(two.slots[1]!.y)
    const three = stackFanLayout({ hex: HEX, total: 3 })
    expect(three.slots[0]!.y).toBe(three.slots[1]!.y)
    expect(three.slots[2]!.y).toBeGreaterThan(three.slots[1]!.y)
    expect(three.slots[2]!.x + three.slots[2]!.size / 2).toBeCloseTo(CENTER.x)
  })

  it('第一屏包含顶层算子，翻页仍命中原数组下标', () => {
    const order = [0, 2, 1, 4, 6, 5, 3]
    const first = stackFanLayout({ hex: HEX, total: 7, order })
    expect(first.slots).toHaveLength(STACK_FAN_PAGE_SIZE)
    expect(first.slots.map((slot) => slot.index)).toEqual(order.slice(1))
    expect(hitStackFan({ layout: first, point: first.pageBadge! })).toEqual({
      kind: 'page',
      nextPage: 1,
    })
    const last = stackFanLayout({ hex: HEX, total: 7, page: 99, order })
    expect(last.slots.map((slot) => slot.index)).toEqual([0])
    expect(hitStackFan({ layout: last, point: last.pageBadge! })).toEqual({
      kind: 'page',
      nextPage: 0,
    })
    expect(pageCountOf(0)).toBe(1)
    expect(pageCountOf(7)).toBe(2)
    expect(normalizePage(-3, 9)).toBe(0)
    expect(stackFanLayout({ hex: HEX, total: 0 }).slots).toEqual([])
  })

  it('两枚图面相叠时命中后画的顶层算子', () => {
    const layout = stackFanLayout({ hex: HEX, total: 2, order: [1, 0] })
    expect(hitStackFan({ layout, point: CENTER })).toEqual({ kind: 'slot', index: 0 })
  })

  it('按屏幕尺寸扩展点击热区，仍留出格内空白', () => {
    const layout = stackFanLayout({ hex: HEX, total: 6 })
    const scale = 0.5
    const slot = layout.slots[0]!
    const point = { x: slot.x + slot.size / 2, y: slot.y - 2 }
    expect(counterHitSize(slot.size, scale) * scale).toBe(24)
    expect(hitStackFan({ layout, point, scale })).toEqual({ kind: 'slot', index: slot.index })
    expect(hitStackFan({ layout, point })).toBeNull()
  })
})

describe('选择集', () => {
  it('复制候选集合', () => {
    const source = ['a', 'b']
    const copy = defaultSelectionOf(source)
    expect(copy).toEqual(source)
    expect(copy).not.toBe(source)
  })

  it('切换一枚时保留其他选择顺序', () => {
    expect(toggleSelection(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
    expect(toggleSelection(['a', 'c'], 'b')).toEqual(['a', 'c', 'b'])
  })
})
