import { describe, expect, it } from 'vitest'

import {
  placeReserveMarkerForMove,
  reserveMarkersInUse,
  type ReserveMarkerLedger,
} from '@/engine/rules'

/**
 * 5.4a / 5.7：预备标记的**计量单位**与**校验时点**
 *
 * 原文（5.4a）：「游戏专属规则中会对每一方可用的预备标记数量进行严格的限制。……玩家可以用
 * 一个预备标记（4.8b），表示**堆叠中一部分单位全部处于预备模式**。而且在这些单位**完成 25%
 * 的移动后，才需要放置该预备标记**。」
 *
 * 两句分别钉住两件事：① 计量单位＝**标记（覆盖组）**，不按单位计；② 切模式**不占**标记，
 * 只在这组真正迈步（按预备 MA ×1/4）时才占一枚。
 */

const ledger = (cap: Record<'axis' | 'soviet', number> | null): ReserveMarkerLedger => ({
  cap,
  groups: [],
})

const allReserve = () => true
const noneReserve = () => false

describe('5.4a 预备标记：按组计量', () => {
  it('★ 一组多枚只占一枚（一个标记表示堆叠中一部分单位）', () => {
    const outcome = placeReserveMarkerForMove({
      ledger: ledger({ axis: 1, soviet: 0 }),
      side: 'axis',
      origin: '57.35',
      unitIds: ['u1', 'u2', 'u3'],
      isReserveUnit: allReserve,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.groups).toHaveLength(1)
    expect(reserveMarkersInUse(outcome.data, 'axis', allReserve)).toBe(1)
  })

  it('★ 同一起点再次移动（并进新成员）仍只占一枚', () => {
    const first = placeReserveMarkerForMove({
      ledger: ledger({ axis: 2, soviet: 0 }),
      side: 'axis',
      origin: '57.35',
      unitIds: ['u1'],
      isReserveUnit: allReserve,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = placeReserveMarkerForMove({
      ledger: first.data,
      side: 'axis',
      origin: '57.35',
      unitIds: ['u1', 'u2'],
      isReserveUnit: allReserve,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.groups).toHaveLength(1)
    expect(second.data.groups[0]!.unitIds).toEqual(['u1', 'u2'])
    expect(reserveMarkersInUse(second.data, 'axis', allReserve)).toBe(1)
  })

  it('不同起点的两组各占一枚（标记以堆叠为界）', () => {
    const first = placeReserveMarkerForMove({
      ledger: ledger({ axis: 2, soviet: 0 }),
      side: 'axis',
      origin: '57.35',
      unitIds: ['u1'],
      isReserveUnit: allReserve,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = placeReserveMarkerForMove({
      ledger: first.data,
      side: 'axis',
      origin: '58.36',
      unitIds: ['u2'],
      isReserveUnit: allReserve,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(reserveMarkersInUse(second.data, 'axis', allReserve)).toBe(2)
  })
})

describe('5.4a 预备标记：校验时点与池上限', () => {
  it('★ 切到预备模式本身不占标记（未迈步 ⇒ 占用数为 0）', () => {
    expect(reserveMarkersInUse(ledger({ axis: 0, soviet: 0 }), 'axis', allReserve)).toBe(0)
  })

  it('★ 池空（剧本给 0）⇒ 拒绝放置（5.4a / noReserveMarkerAvailable）', () => {
    const outcome = placeReserveMarkerForMove({
      ledger: ledger({ axis: 0, soviet: 0 }),
      side: 'axis',
      origin: '57.35',
      unitIds: ['u1'],
      isReserveUnit: allReserve,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.rule).toBe('5.4a')
    expect(outcome.reason).toBe('noReserveMarkerAvailable:axis')
  })

  it('非预备单位移动不占标记（普通移动与标记无关）', () => {
    const outcome = placeReserveMarkerForMove({
      ledger: ledger({ axis: 0, soviet: 0 }),
      side: 'axis',
      origin: '57.35',
      unitIds: ['u1'],
      isReserveUnit: noneReserve,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.groups).toHaveLength(0)
  })

  it('★ 释放（5.7b）/ 接敌（5.7d）/ DG（5.10c）把单位移出预备 ⇒ 该组自动归还标记', () => {
    const placed = placeReserveMarkerForMove({
      ledger: ledger({ axis: 1, soviet: 0 }),
      side: 'axis',
      origin: '57.35',
      unitIds: ['u1'],
      isReserveUnit: allReserve,
    })
    expect(placed.ok).toBe(true)
    if (!placed.ok) return
    expect(reserveMarkersInUse(placed.data, 'axis', allReserve)).toBe(1)
    // 释放后：账本条目仍在，但不再计占用 ⇒ 池里那枚可再用
    const releasedU1 = (unitId: string) => unitId !== 'u1'
    expect(reserveMarkersInUse(placed.data, 'axis', releasedU1)).toBe(0)
    const again = placeReserveMarkerForMove({
      ledger: placed.data,
      side: 'axis',
      origin: '59.34',
      unitIds: ['u2'],
      isReserveUnit: releasedU1,
    })
    expect(again.ok).toBe(true)
  })

  it('双方池各算各的（一方满不挡另一方）', () => {
    const axis = placeReserveMarkerForMove({
      ledger: ledger({ axis: 1, soviet: 1 }),
      side: 'axis',
      origin: '57.35',
      unitIds: ['u1'],
      isReserveUnit: allReserve,
    })
    expect(axis.ok).toBe(true)
    if (!axis.ok) return
    const soviet = placeReserveMarkerForMove({
      ledger: axis.data,
      side: 'soviet',
      origin: '30.20',
      unitIds: ['s1'],
      isReserveUnit: allReserve,
    })
    expect(soviet.ok).toBe(true)
  })

  it('剧本未给上限（cap=null）⇒ 不校验（数据缺口，不臆造上限）', () => {
    let data = ledger(null)
    for (let index = 0; index < 3; index += 1) {
      const outcome = placeReserveMarkerForMove({
        ledger: data,
        side: 'axis',
        origin: `5${index}.3${index}`,
        unitIds: [`u${index}`],
        isReserveUnit: allReserve,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      data = outcome.data
    }
    expect(reserveMarkersInUse(data, 'axis', allReserve)).toBe(3)
  })
})
