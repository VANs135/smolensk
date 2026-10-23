import { describe, expect, it } from 'vitest'

import { HEX_RADIUS_PX, hexCanvasPoint } from '@/render/map-layout'
import {
  STACK_FAN_PAGE_SIZE,
  combatNoncombatColumns,
  defaultSelectionOf,
  hitStackFan,
  normalizePage,
  pageCountOf,
  stackFanLayout,
  toggleSelection,
} from '@/render/stack-fan'

/**
 * B2：**就地展开堆叠**的布局与命中（用户 2026-09-16 #1）
 *
 * 要点全部来自用户口径：点格就地摊开、**默认全选**、点某一枚即取消、**不必去别的页面取消**。
 * 本测试只钉几何与两个纯函数（选择集切换），不碰界面。
 */
const HEX = { col: 15, row: 10 }
const CENTER = hexCanvasPoint(HEX)

describe('B2 就地展开：布局', () => {
  it('1 枚：不展开（原地，边长＝算子图定尺）', () => {
    const layout = stackFanLayout({ hex: HEX, total: 1 })
    expect(layout.slots).toHaveLength(1)
    const slot = layout.slots[0]!
    expect(slot.size).toBeCloseTo(HEX_RADIUS_PX * 0.5, 6)
    expect(slot.x + slot.size / 2).toBeCloseTo(CENTER.x, 6)
    expect(layout.pageCount).toBe(1)
    expect(layout.pageBadge).toBeNull()
  })

  it('2 枚：左右对角摊开（互不重叠且都在格内）', () => {
    const layout = stackFanLayout({ hex: HEX, total: 2 })
    expect(layout.slots).toHaveLength(2)
    const [a, b] = layout.slots as [(typeof layout.slots)[0], (typeof layout.slots)[0]]
    // 两枚不重叠
    const overlap =
      a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size
    expect(overlap).toBe(false)
    // 都落在格的外接圆内（不越格边）
    for (const slot of [a, b]) {
      const cx = slot.x + slot.size / 2 - CENTER.x
      const cy = slot.y + slot.size / 2 - CENTER.y
      expect(Math.hypot(cx, cy) + slot.size / 2).toBeLessThan(HEX_RADIUS_PX)
    }
  })

  it('3–4 枚：2×2 栅格，四枚互不重叠且都在格内', () => {
    const layout = stackFanLayout({ hex: HEX, total: 4 })
    expect(layout.slots).toHaveLength(4)
    for (const slot of layout.slots) {
      const cx = slot.x + slot.size / 2 - CENTER.x
      const cy = slot.y + slot.size / 2 - CENTER.y
      expect(Math.hypot(cx, cy) + slot.size / 2).toBeLessThan(HEX_RADIUS_PX)
    }
    // 两两不重叠
    const slots = [...layout.slots]
    for (let i = 0; i < slots.length; i += 1)
      for (let j = i + 1; j < slots.length; j += 1) {
        const a = slots[i]!
        const b = slots[j]!
        const overlap =
          a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size
        expect(overlap).toBe(false)
      }
  })

  it('>4 枚：2×2 + 分页角标；页码越界自动夹回', () => {
    const layout = stackFanLayout({ hex: HEX, total: 9, page: 99 })
    expect(layout.pageCount).toBe(Math.ceil(9 / STACK_FAN_PAGE_SIZE))
    expect(layout.page).toBe(layout.pageCount - 1)
    expect(layout.slots).toHaveLength(9 - layout.pageStart)
    expect(layout.pageBadge).not.toBeNull()
    // 页码工具函数与之一致
    expect(pageCountOf(0)).toBe(1)
    expect(pageCountOf(5)).toBe(2)
    expect(normalizePage(-3, 9)).toBe(0)
  })

  it('槽位带原堆叠下标（翻页后仍是绝对下标，选择集才对得上）', () => {
    const first = stackFanLayout({ hex: HEX, total: 9, page: 0 })
    const second = stackFanLayout({ hex: HEX, total: 9, page: 1 })
    expect(first.slots.map((slot) => slot.index)).toEqual([0, 1, 2, 3])
    expect(second.slots[0]!.index).toBe(4)
  })
})

describe('B2 就地展开：命中', () => {
  it('命中本页某一枚 ⇒ 返回该枚的**原下标**', () => {
    const layout = stackFanLayout({ hex: HEX, total: 4 })
    for (const slot of layout.slots) {
      const hit = hitStackFan({
        layout,
        point: { x: slot.x + slot.size / 2, y: slot.y + slot.size / 2 },
      })
      expect(hit).toEqual({ kind: 'slot', index: slot.index })
    }
  })

  it('点空白（离所有枚都远）⇒ null（调用方据此收起展开）', () => {
    const layout = stackFanLayout({ hex: HEX, total: 4 })
    const hit = hitStackFan({ layout, point: { x: CENTER.x, y: CENTER.y + HEX_RADIUS_PX * 3 } })
    expect(hit).toBeNull()
  })

  it('分页角标优先命中，并给出**下一页**（点角标翻页，不弹新窗）', () => {
    const layout = stackFanLayout({ hex: HEX, total: 6, page: 0 })
    const badge = layout.pageBadge!
    const hit = hitStackFan({ layout, point: { x: badge.x, y: badge.y } })
    expect(hit).toEqual({ kind: 'page', nextPage: 1 })
    // 最后一页再点回到第一页（循环）
    const last = stackFanLayout({ hex: HEX, total: 6, page: 1 })
    const lastBadge = last.pageBadge!
    expect(hitStackFan({ layout: last, point: { x: lastBadge.x, y: lastBadge.y } })).toEqual({
      kind: 'page',
      nextPage: 0,
    })
  })

  it('单枚也走同一套命中（便于"点格=展开/点枚=切换"统一处理）', () => {
    const layout = stackFanLayout({ hex: HEX, total: 1 })
    const slot = layout.slots[0]!
    expect(
      hitStackFan({ layout, point: { x: slot.x + slot.size / 2, y: slot.y + slot.size / 2 } }),
    ).toEqual({ kind: 'slot', index: 0 })
  })
})

describe('B2 就地展开：选择集（默认全选 / 点枚切换）', () => {
  it('默认全选：可参与的那些全部入选择集', () => {
    expect(defaultSelectionOf(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    // 返回的是新数组（不共享引用，避免误改 store 里的源）
    const source = ['a']
    expect(defaultSelectionOf(source)).not.toBe(source)
  })

  it('点某枚 = 切换它（已在集合里就取消，不在就加入），顺序稳定', () => {
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b'])
    // 取消一枚不影响其它枚（用户口径：不必去别的页面取消）
    expect(toggleSelection(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
})

describe('条 7 / R3 战斗 | 非战斗两栏', () => {
  it('combatNoncombatColumns：纯战斗堆退回 undefined（走单栏旧行为）', () => {
    expect(
      combatNoncombatColumns([{ noncombatKind: null }, { noncombatKind: null }]),
    ).toBeUndefined()
  })

  it('combatNoncombatColumns：战斗 + 非战斗（含飞机 air）分两栏，下标正确', () => {
    expect(
      combatNoncombatColumns([
        { noncombatKind: null }, // 0 战斗
        { noncombatKind: 'organic_truck' }, // 1 非战斗
        { air: true }, // 2 非战斗（停机场的飞机）
        { noncombatKind: null }, // 3 战斗
      ]),
    ).toEqual([
      [0, 3],
      [1, 2],
    ])
  })

  it('两栏布局：命中下标＝原堆叠下标；战斗栏在左、非战斗栏在右', () => {
    const layout = stackFanLayout({ hex: HEX, total: 4, columns: [[0, 1, 2], [3]] })
    expect(layout.slots.map((slot) => slot.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    const combat = layout.slots.filter((slot) => slot.index <= 2)
    const nonCombat = layout.slots.filter((slot) => slot.index === 3)
    for (const slot of combat) expect(slot.x + slot.size / 2).toBeLessThan(CENTER.x)
    for (const slot of nonCombat) expect(slot.x + slot.size / 2).toBeGreaterThan(CENTER.x)
  })

  it('每栏独立分页：战斗栏 >4 时分页，非战斗栏共享同一页码', () => {
    const columns: number[][] = [
      [0, 1, 2, 3, 4, 5, 6, 7],
      [8, 9],
    ]
    const page0 = stackFanLayout({ hex: HEX, total: 10, columns, page: 0 })
    expect(page0.pageCount).toBe(2) // 战斗栏 8 枚 → 2 页
    expect(page0.slots.map((slot) => slot.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 8, 9])
    const page1 = stackFanLayout({ hex: HEX, total: 10, columns, page: 1 })
    expect(page1.slots.map((slot) => slot.index).sort((a, b) => a - b)).toEqual([4, 5, 6, 7])
  })

  it('非战斗栏为空（纯战斗）走单栏（columns = undefined）', () => {
    const layout = stackFanLayout({ hex: HEX, total: 3, columns: undefined })
    expect(layout.slots).toHaveLength(3)
  })
})
