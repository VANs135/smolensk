import { describe, expect, it } from 'vitest'
import {
  planAirCargoUnload,
  applyAirCargoUnloadResult,
  validateAirCargoReturns,
} from '@/engine/rules/air-cargo-unload'
import { planAirUnload } from '@/engine/rules/air'
import { resolveAirTransportDelivery } from '@/engine/rules/air-interaction'
import type { AirMissionCargo } from '@/engine/rules/air-interaction'

const unit: AirMissionCargo = { id: 'unit:u', kind: 'unit', re: 1, ma: 6, mobility: 'leg' }
const sp: AirMissionCargo = { id: 'sp:1', kind: 'sp', t: 1 }
function plan(cargo: AirMissionCargo[], selectedIds: string[] | null = null, usedT = 0) {
  return planAirCargoUnload({
    kind: 'air_transport',
    baseLevel: 1,
    isAirstrip: false,
    usedT,
    overLimitAircraftInactive: false,
    cargo,
    selectedIds,
  })
}
describe('14.9f：完整货物共同卸载', () => {
  it('超限卸载收据记录留场要求，返航不能带走承担例外的运输机', () => {
    const result = planAirCargoUnload({
      kind: 'air_transport',
      cargo: [unit, sp],
      baseLevel: 1,
      isAirstrip: false,
      usedT: 0,
      overLimitAircraftInactive: true,
      selectedIds: null,
    })
    expect(result).toMatchObject({
      ok: true,
      data: { deliveredT: 3, requiresDestinationStay: true },
    })
    const input = { requiresStay: true, transportIds: ['plane'], targetHex: { col: 20, row: 20 } }
    expect(
      validateAirCargoReturns({
        ...input,
        returns: [{ aircraftId: 'plane', baseHex: { col: 21, row: 20 } }],
      }).ok,
    ).toBe(false)
    expect(
      validateAirCargoReturns({
        ...input,
        returns: [{ aircraftId: 'plane', baseHex: input.targetHex }],
      }).ok,
    ).toBe(true)
    expect(
      validateAirCargoReturns({
        ...input,
        returns: [{ aircraftId: 'escort', baseHex: { col: 21, row: 20 } }],
      }).ok,
    ).toBe(true)
  })
  it('14.9f（T15）：留场名单只含承运超额部分的飞机', () => {
    const cargo = [
      { id: 'sp:1', kind: 'sp' as const, t: 1 },
      { id: 'sp:2', kind: 'sp' as const, t: 1 },
      { id: 'sp:3', kind: 'sp' as const, t: 1 },
    ]
    const result = planAirCargoUnload({
      kind: 'air_transport',
      cargo,
      baseLevel: 1,
      isAirstrip: false,
      usedT: 0,
      overLimitAircraftInactive: true,
      selectedIds: null,
      cargoByAircraft: [
        { aircraftId: 'a', cargoIds: ['sp:1', 'sp:2'] },
        { aircraftId: 'b', cargoIds: ['sp:3'] },
      ],
    })
    expect(result).toMatchObject({
      ok: true,
      data: { deliveredT: 3, requiresDestinationStay: true, stayAircraftIds: ['b'] },
    })
  })
  it('2T单位与1T补给超2T限额时，必须由玩家选择', () => {
    expect(plan([unit, sp])).toMatchObject({ ok: false, reason: 'airUnloadSelectionRequired' })
    expect(plan([unit, sp], [unit.id, sp.id])).toMatchObject({
      ok: false,
      reason: 'selectedCargoExceedsUnloadLimit',
    })
  })
  it('不能将单位拆成部分卸载，选单位则SP保留退运', () => {
    expect(plan([unit, sp], [unit.id])).toMatchObject({
      ok: true,
      data: {
        deliveredIds: [unit.id],
        refusedIds: [sp.id],
        deliveredT: 2,
        refusedT: 1,
        consumedT: 2,
        deliveredSpT: 0,
      },
    })
    expect(plan([unit], [unit.id], 1)).toMatchObject({ ok: false })
  })
  it('选SP时单位保留，空选择可整批退运', () => {
    expect(plan([unit, sp], [sp.id])).toMatchObject({
      ok: true,
      data: { deliveredIds: [sp.id], refusedIds: [unit.id], consumedT: 1, deliveredSpT: 1 },
    })
    expect(plan([unit, sp], [])).toMatchObject({
      ok: true,
      data: { deliveredIds: [], refusedT: 3, consumedT: 0 },
    })
  })
  it('保留半T单位的精度，既有额度也不能截掉小数', () => {
    const halfT = { ...unit, re: 0.25 }
    expect(plan([halfT, sp], null, 0.5)).toMatchObject({ ok: true, data: { consumedT: 1.5 } })
    expect(plan([sp], null, 1.5)).toMatchObject({ ok: true, data: { consumedT: 0, refusedT: 1 } })
    expect(
      planAirUnload({
        kind: 'air_transport',
        baseLevel: 1,
        isAirstrip: false,
        usedT: 1.5,
        cargoT: 1,
        overLimitAircraftInactive: false,
      }),
    ).toMatchObject({ ok: true, data: { allowedT: 0.5, refusedT: 0.5 } })
  })
  it.each([NaN, Infinity, -1])('非法额度%s被拒绝', (usedT) => {
    expect(plan([sp], null, usedT).ok).toBe(false)
  })
  it('选择的货物必须存在且不能重复', () => {
    expect(plan([unit], ['missing']).ok).toBe(false)
    expect(plan([unit], [unit.id, unit.id]).ok).toBe(false)
  })
  it('空投不占普通空运卸载额度', () => {
    expect(
      planAirCargoUnload({
        kind: 'air_drop',
        cargo: [unit, sp],
        baseLevel: 0,
        isAirstrip: false,
        usedT: 9,
        overLimitAircraftInactive: false,
        selectedIds: null,
      }),
    ).toMatchObject({ ok: true, data: { deliveredT: 3, consumedT: 0, refusedT: 0 } })
  })
  it('未卸货物在结果中明确标成留存，不冒充送达或被毁', () => {
    const result = resolveAirTransportDelivery([unit, sp])
    const choice = plan([unit, sp], [sp.id])
    if (!result.ok || !choice.ok) throw new Error('fixture')
    const final = applyAirCargoUnloadResult(result.data, choice.data)
    expect(final.items.map((item) => item.fate)).toEqual(['retained', 'placed'])
    expect(result.data.items[0]!.fate).toBe('placed')
  })
})
