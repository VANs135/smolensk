import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { sameHex } from '@/engine/hex-geometry'
import { aircraftChoices, useWorkbenchStore } from '@/stores'
import { CORE_HEX, NEAR_HEX, placeGround, placeAir, airBaseRecord } from '../flows/sop-harness'

function setup() {
  setActivePinia(createPinia())
  const w = useWorkbenchStore()
  w.setPhase('movement')
  w.setSegmentStepIndex(
    w.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
  )
  placeGround(w, airBaseRecord(1), CORE_HEX, 'axis', 'base')
  placeGround(w, airBaseRecord(1), NEAR_HEX, 'axis', 'destination')
  const aircraft = aircraftChoices('axis').find((record) => (record.transportCapacity ?? 0) > 0)!
  placeAir(w, aircraft, CORE_HEX, 'axis', 'transport')
  w.airUnits[0]!.transportCapacity = 1
  w.airUnits[0]!.transportCapacityBack = 0.5
  w.setAirInBoxMembership('transport', true)
  w.setAirActive(true)
  w.setAirMissionKind('air_transport')
  w.setAirTargetFromText(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
  w.toggleAirMissionUnit('transport')
  w.airInputs.cargoSpT = 1
  return w
}

describe('14.9（T16）：图外空军盒补给库存账本', () => {
  it('盒内有2T，装1T后剩1T，不再一律拒绝离图来源', () => {
    const w = setup()
    w.offMapSupplyStocks = { 'axis:axis': { sp: 0, t: 2 } }
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.offMapSupplyStocks['axis:axis']).toEqual({ sp: 0, t: 1 })
    expect(w.spDumps).toEqual([])
  })

  it('任务中止、留存返航回盒后库存恢复', () => {
    const w = setup()
    w.offMapSupplyStocks = { 'axis:axis': { sp: 0, t: 2 } }
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.offMapSupplyStocks['axis:axis']).toEqual({ sp: 0, t: 1 })
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.voluntaryReturnNow(['transport'])).toBe(true)
    expect(w.offMapSupplyStocks['axis:axis']).toEqual({ sp: 0, t: 2 })
    expect(w.spDumps).toEqual([])
  })

  it.each([4, 5, 6])('旧 v%i 存档缺 offMapSupplyStocks 可读，spDumps 原样保留', (version) => {
    const w = setup()
    const before = w.spDumps.map((dump) => ({ ...dump }))
    const snapshot = w.snapshotBoard() as unknown as {
      version: number
      fields: Record<string, unknown>
    }
    snapshot.version = version
    delete snapshot.fields.offMapSupplyStocks
    expect(w.boardSnapshotFits(snapshot)).toBe(true)
    w.restoreBoard(snapshot)
    expect(w.offMapSupplyStocks).toEqual({})
    expect(w.spDumps).toEqual(before)
    expect(
      w.airUnits.every((air) => sameHex(air.hex, CORE_HEX) || sameHex(air.hex, NEAR_HEX)),
    ).toBe(true)
  })
})
