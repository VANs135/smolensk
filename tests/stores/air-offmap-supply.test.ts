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

  it('14.9e：离图盒载货机可途中部分返航——返航机 SP 回盒，留场机继续任务', () => {
    setActivePinia(createPinia())
    const w = useWorkbenchStore()
    w.setPhase('movement')
    w.setSegmentStepIndex(
      w.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
    )
    placeGround(w, airBaseRecord(1), CORE_HEX, 'axis', 'base')
    placeGround(w, airBaseRecord(1), NEAR_HEX, 'axis', 'destination')
    const aircraft = aircraftChoices('axis').find((record) => (record.transportCapacity ?? 0) > 0)!
    for (const instanceId of ['transport', 'transport2']) {
      placeAir(w, aircraft, CORE_HEX, 'axis', instanceId)
      const air = w.airUnits.find((item) => item.instanceId === instanceId)!
      air.transportCapacity = 1
      air.transportCapacityBack = 0.5
      w.setAirInBoxMembership(instanceId, true)
    }
    w.setAirActive(true)
    w.setAirMissionKind('air_transport')
    w.setAirTargetFromText(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
    w.toggleAirMissionUnit('transport')
    w.toggleAirMissionUnit('transport2')
    w.airInputs.cargoSpT = 2
    // 逐机货单（14.9e：把每架飞机分开处理）——各带 1T，便于验证“返航机回盒、留场机继续”
    w.airInputs.cargoByAircraft = [
      { aircraftId: 'transport', cargoIds: ['sp:1'] },
      { aircraftId: 'transport2', cargoIds: ['sp:2'] },
    ]
    w.offMapSupplyStocks = { 'axis:axis': { sp: 0, t: 4 } }

    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.offMapSupplyStocks['axis:axis']).toEqual({ sp: 0, t: 2 })
    expect(w.confirmAirCombatNow()).toBe(true)

    // 一架返航、一架留场：返航机的 1T 回盒，留场机仍带 1T
    expect(w.voluntaryReturnNow(['transport'])).toBe(true)
    expect(w.airError).toBeNull()
    expect(w.offMapSupplyStocks['axis:axis']).toEqual({ sp: 0, t: 3 })
    expect(w.airUnits.find((air) => air.instanceId === 'transport')?.airStatus).toBe('inactive')
    expect(w.airUnits.find((air) => air.instanceId === 'transport2')?.airStatus).toBe('active')
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
