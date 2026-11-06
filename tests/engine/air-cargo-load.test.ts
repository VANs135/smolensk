import { describe, expect, it } from 'vitest'
import {
  airCargoTransportT,
  checkAirCargoLoad,
  checkAirTransportMovementHandoff,
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
  it('6.1g / 14.9d：只允许正在移动的同批货物交接空运，不能暂停他人移动', () => {
    expect(
      checkAirTransportMovementHandoff({ cargoUnitIds: ['u'], movingUnitIds: ['u'] }),
    ).toMatchObject({ ok: true, data: { detachMovement: true } })
    expect(
      checkAirTransportMovementHandoff({ cargoUnitIds: ['u'], movingUnitIds: ['u', 'other'] }),
    ).toMatchObject({ ok: false, rule: '6.1g' })
    expect(
      checkAirTransportMovementHandoff({ cargoUnitIds: ['u'], movingUnitIds: [] }),
    ).toMatchObject({ ok: true, data: { detachMovement: false } })
  })
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
  it('14.9b：1/2T 容量不能取整为 1T，也不能留作以后使用', () => {
    const oneT = { ...unit, re: 0.5 } // RE 0.5、步行 MA 6 ⇒ 1T（见上表）
    expect(airCargoTransportT(oneT)).toBe(1)
    // 单架 1/2T 装 1T ⇒ 拒；不因 14.4g 之外的场景向上取整
    expect(load([oneT], 0.5)).toMatchObject({ ok: false, rule: '14.9a' })
    // 下一次任务重新起算：0.5T 可装，1T 仍拒，说明上次的 1/2T 没有留存叠加
    expect(load([{ id: 'sp:half', kind: 'sp', t: 0.5 }], 0.5).ok).toBe(true)
    expect(load([oneT], 0.5).ok).toBe(false)
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
