import { describe, expect, it } from 'vitest'

import {
  allowReserveEntryAtHex,
  reserveHexesInUse,
  reserveQuarterMa,
  type ReserveUnitView,
} from '@/engine/rules'

/**
 * 5.4a / 5.7 预备额度（**按格**计）
 *
 * 口径（原文 + 用户 2026-11-06 裁定）：
 *   - 5.4a「玩家可以用一个预备标记（4.8b），表示**堆叠中一部分单位全部处于预备模式**」
 *     ⇒ 一枚标记覆盖**一个格子**里处于预备模式的那部分单位：同格多枚只算 1 格；
 *   - 剧本 `setup.reserveMarkers` 给几枚 ＝ 能同时保持几个格子处于预备；**没给就是 0**
 *     ⇒ 该方完全没有预备权（进入即拒，不是"不校验"）；
 *   - 释放后标记**留在未释放的单位上**（5.7b 逐枚摘标记）⇒ 该格只要还有预备单位就仍占额度。
 */

const view = (hex: string, over: Partial<ReserveUnitView> = {}): ReserveUnitView => ({
  hex,
  side: 'axis',
  inReserve: true,
  ...over,
})

describe('5.4a 额度按格计', () => {
  it('同格两枚只占 1 格（5.4a「堆叠中一部分单位」）', () => {
    const hexes = reserveHexesInUse([view('10.10'), view('10.10')], 'axis')
    expect(hexes).toEqual(['10.10'])
  })

  it('异格各占 1 格', () => {
    const hexes = reserveHexesInUse([view('10.10'), view('11.11'), view('12.12')], 'axis')
    expect(hexes).toHaveLength(3)
  })

  it('归并（5.7 各走 1/4 MA 进同格）：两格 → 同格后只占 1 格，额度自动腾出', () => {
    // 归并前：起点 A、B 两处各 1 枚
    expect(reserveHexesInUse([view('10.10'), view('11.11')], 'axis')).toHaveLength(2)
    // 归并后：两枚都在 C（A、B 已空 ⇒ 只剩 C 一格）
    const after = reserveHexesInUse([view('12.12'), view('12.12')], 'axis')
    expect(after).toEqual(['12.12'])
    // 腾出的那一格额度可立刻被一个新格使用（cap=2）
    expect(
      allowReserveEntryAtHex({
        side: 'axis',
        cap: 2,
        hex: '13.13',
        occupiedHexes: after,
      }).ok,
    ).toBe(true)
  })

  it('不统计敌方与不在预备模式的单位', () => {
    const hexes = reserveHexesInUse(
      [view('10.10'), view('9.9', { side: 'soviet' }), view('10.10', { inReserve: false })],
      'axis',
    )
    expect(hexes).toEqual(['10.10'])
  })

  it('部分释放后标记仍在剩余单位上：该格只要有预备单位就仍占额度', () => {
    // 同格两枚，仅一枚被释放（5.7b「先释放一个……再决定是否释放其他预备」）
    const hexes = reserveHexesInUse([view('10.10', { inReserve: false }), view('10.10')], 'axis')
    expect(hexes).toEqual(['10.10'])
  })

  it('最后一枚也释放后该格归还', () => {
    expect(
      reserveHexesInUse(
        [view('10.10', { inReserve: false }), view('10.10', { inReserve: false })],
        'axis',
      ),
    ).toEqual([])
  })
})

describe('5.4a 额度闸门（转入那一刻）', () => {
  it('同格已有预备单位 ⇒ 不额外占，即使在 cap 已满时也允许', () => {
    const outcome = allowReserveEntryAtHex({
      side: 'axis',
      cap: 1,
      hex: '10.10',
      occupiedHexes: ['10.10'],
    })
    expect(outcome.ok).toBe(true)
  })

  it('异格新预备 ⇒ 占 1 格；未达 cap 时允许', () => {
    expect(
      allowReserveEntryAtHex({
        side: 'axis',
        cap: 2,
        hex: '11.11',
        occupiedHexes: ['10.10'],
      }).ok,
    ).toBe(true)
  })

  it('上限＝格数：已达 cap，再转一个**新格**被拒（5.4a）', () => {
    expect(
      allowReserveEntryAtHex({
        side: 'axis',
        cap: 2,
        hex: '12.12',
        occupiedHexes: ['10.10', '11.11'],
      }),
    ).toMatchObject({ ok: false, rule: '5.4a', reason: 'reserveMarkerCapReached:axis' })
  })

  it('cap 0 ⇒ 一律拒（包括同格已有、以及完全没动的情形）', () => {
    expect(
      allowReserveEntryAtHex({
        side: 'soviet',
        cap: 0,
        hex: '10.10',
        occupiedHexes: [],
      }),
    ).toMatchObject({ ok: false, rule: '5.4a', reason: 'noReserveMarkerAvailable:soviet' })
    expect(
      allowReserveEntryAtHex({
        side: 'soviet',
        cap: 0,
        hex: '10.10',
        occupiedHexes: ['10.10'],
      }),
    ).toMatchObject({ ok: false, rule: '5.4a' })
  })

  it('剧本未给（调用方按 0 传）⇒ 拒，不是"不校验"', () => {
    expect(
      allowReserveEntryAtHex({
        side: 'axis',
        cap: 0,
        hex: '10.10',
        occupiedHexes: [],
      }),
    ).toMatchObject({ ok: false, rule: '5.4a' })
  })
})

describe('5.4a 25% 边界', () => {
  it('U4 绝不取整：MA 5 的 25% 是 1.25（不是 1）', () => {
    expect(reserveQuarterMa(5)).toBe(1.25)
    expect(reserveQuarterMa(6)).toBe(1.5)
  })
})
