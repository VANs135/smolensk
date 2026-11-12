import { describe, expect, it } from 'vitest'

import {
  barrageColumnUpperBound,
  barrageCostT,
  planBarrageSupplyPayment,
  selectAffordableBarrageColumn,
  useSupplyCacheAsShells,
  type SupplyCacheHoldings,
} from '@/engine/rules'

const hq = { col: 36, row: 4 }
const two: SupplyCacheHoldings = { axis: 2, soviet: 2 }
const three: SupplyCacheHoldings = { axis: 3, soviet: 3 }

describe('21.10 Shells：2T/枚、溢出作废、可与 SP 混付、可降档', () => {
  it('S1 成本 2T + 1 枚 ⇒ 抵 2T，浪费 0', () => {
    const result = useSupplyCacheAsShells({
      side: 'axis',
      holdings: two,
      hqHex: hq,
      barrageCostT: 2,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({ markersSpent: 1, paidT: 2, wasteT: 0, remainingCostT: 0 })
  })

  it('S2 成本 1T + 1 枚 ⇒ 抵 1T，浪费 1T（不找零）', () => {
    const result = useSupplyCacheAsShells({
      side: 'axis',
      holdings: two,
      hqHex: hq,
      barrageCostT: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({ markersSpent: 1, paidT: 1, wasteT: 1, remainingCostT: 0 })
  })

  it('S3 成本 5T + 3 枚 ⇒ 抵 5T，浪费 1T', () => {
    const result = useSupplyCacheAsShells({
      side: 'axis',
      holdings: three,
      hqHex: hq,
      barrageCostT: 5,
      markers: 3,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({ markersSpent: 3, paidT: 5, wasteT: 1, remainingCostT: 0 })
  })

  it('S4 成本 5T = 1 枚 + 3T SP ⇒ 无浪费、无缺口', () => {
    const result = planBarrageSupplyPayment({ costT: 5, markers: 1, spT: 3 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({
      markersSpent: 1,
      shellsAppliedT: 2,
      wasteT: 0,
      spT: 3,
      coveredT: 5,
      shortT: 0,
    })
  })

  it('S5 成本 5T = 1 枚 + 2T SP ⇒ 缺口 1T（调用方降档或放弃）', () => {
    const result = planBarrageSupplyPayment({ costT: 5, markers: 1, spT: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({ coveredT: 4, shortT: 1 })
  })

  it('S6 20 值（17–24 列 = 3T）额度 2T ⇒ 降到 8–11 列，值压到 11', () => {
    expect(barrageCostT(20)).toBe(3)
    const column = selectAffordableBarrageColumn({
      target: 'combatUnits',
      valueRange: 20,
      availableT: 2,
    })
    expect(column).toMatchObject({ initialColumn: 4, columnLabel: '8-11', costT: 2, valueUsed: 11 })
  })

  it('S7 20 值额度 3T ⇒ 不降档，仍用 17–24 列', () => {
    const column = selectAffordableBarrageColumn({
      target: 'combatUnits',
      valueRange: 20,
      availableT: 3,
    })
    expect(column).toMatchObject({
      initialColumn: 6,
      columnLabel: '17-24',
      costT: 3,
      valueUsed: 20,
    })
  })

  it('S8 26 值（25–40 列 = 4T）额度 2T ⇒ 降到 8–11，不是 12–16（3T）', () => {
    expect(barrageCostT(26)).toBe(4)
    const column = selectAffordableBarrageColumn({
      target: 'combatUnits',
      valueRange: 26,
      availableT: 2,
    })
    expect(column).toMatchObject({ initialColumn: 4, columnLabel: '8-11', costT: 2, valueUsed: 11 })
  })

  it('S9 20 值额度 1T ⇒ 降到「2」列（1T），值压到 2', () => {
    const column = selectAffordableBarrageColumn({
      target: 'combatUnits',
      valueRange: 20,
      availableT: 1,
    })
    expect(column).toMatchObject({ initialColumn: 1, columnLabel: '2', costT: 1, valueUsed: 2 })
  })

  it('S10 HQ 断补 + 1 枚 ⇒ 仍可用', () => {
    const result = useSupplyCacheAsShells({
      side: 'axis',
      holdings: two,
      hqHex: hq,
      barrageCostT: 2,
      hqDrawsTraceSupply: false,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.detail).toContain('即使不在追溯补给中也可用')
  })

  it('S11 成本 5T = 2 枚 + 2T SP ⇒ 4T + 1T SP，浪费 0', () => {
    const result = planBarrageSupplyPayment({ costT: 5, markers: 2, spT: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({
      markersSpent: 2,
      shellsAppliedT: 4,
      wasteT: 0,
      spT: 1,
      coveredT: 5,
      shortT: 0,
    })
  })

  it('S12 成本 3T + 2 枚 ⇒ 抵 3T，浪费 1T', () => {
    const result = planBarrageSupplyPayment({ costT: 3, markers: 2, spT: 0 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({
      shellsAppliedT: 3,
      wasteT: 1,
      spT: 0,
      coveredT: 3,
      shortT: 0,
    })
  })

  it('S13 枚数超过持有量 ⇒ 拒；列上界解析正确', () => {
    const result = useSupplyCacheAsShells({
      side: 'axis',
      holdings: two,
      hqHex: hq,
      barrageCostT: 8,
      markers: 3,
    })
    expect(result.ok).toBe(false)
    expect(barrageColumnUpperBound(4)).toBe(11)
    expect(barrageColumnUpperBound(10)).toBe(Number.POSITIVE_INFINITY)
  })
})
