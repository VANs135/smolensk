import { describe, expect, it } from 'vitest'
import {
  airCargoTransportT,
  checkAirCargoLoad,
  type AirCargoLoadView,
} from '@/engine/rules/air-cargo'

const hex = { col: 20, row: 20 }
const unit: AirCargoLoadView = {
  id: 'unit:u',
  kind: 'unit',
  isCombat: true,
  re: 1,
  mobility: 'leg',
  ma: 6,
  side: 'axis',
  sourceHex: hex,
}
const load = (cargo: AirCargoLoadView[], capacityT = 4) =>
  checkAirCargoLoad({ side: 'axis', cargo, origins: [{ hex, offMap: false, capacityT }] })

describe('4.7 / 14.9：单位货物使用真实运输当量和起点', () => {
  it.each([
    [0.25, 6, 0.5],
    [1, 6, 2],
    [1, 7, 4],
    [1, 10, 4],
    [1, 0, 4],
  ])('RE %s、步行MA %s ⇒ %s T', (re, ma, expected) => {
    expect(airCargoTransportT({ ...unit, re, ma })).toBe(expected)
  })
  it('单位与SP共用容量，单位不再按0T计算', () => {
    expect(load([unit])).toMatchObject({ ok: true, data: { loadedT: 2 } })
    expect(load([unit, { id: 'sp:1', kind: 'sp', t: 1 }])).toMatchObject({
      ok: true,
      data: { loadedT: 3 },
    })
    expect(load([unit], 1).ok).toBe(false)
  })
  it('同基地两架半T飞机可以合运1T，不能向另一基地借运力', () => {
    const cargo = [{ ...unit, re: 0.5 }]
    expect(
      checkAirCargoLoad({
        side: 'axis',
        cargo,
        origins: [
          { hex, offMap: false, capacityT: 0.5 },
          { hex, offMap: false, capacityT: 0.5 },
        ],
      }).ok,
    ).toBe(true)
    expect(
      checkAirCargoLoad({
        side: 'axis',
        cargo,
        origins: [
          { hex, offMap: false, capacityT: 0.5 },
          { hex: { col: 21, row: 20 }, offMap: false, capacityT: 9 },
        ],
      }).ok,
    ).toBe(false)
  })
  it.each([
    { re: undefined },
    { re: NaN },
    { re: 0 },
    { re: -1 },
    { mobility: 'truck' as const },
    { ma: NaN },
    { ma: 11 },
    { isCombat: false },
    { side: 'soviet' as const },
    { sourceHex: undefined },
    { sourceHex: { col: 21, row: 20 } },
  ])('不完整或非法的货物事实不能通过：%o', (overrides) => {
    expect(load([{ ...unit, ...overrides }]).ok).toBe(false)
  })
  it('重复货物ID拒绝，不能对同一单位装载两次', () => {
    expect(load([unit, unit])).toMatchObject({ ok: false, reason: 'duplicateAirCargo' })
  })
})
