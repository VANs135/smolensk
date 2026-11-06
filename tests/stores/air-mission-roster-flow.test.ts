import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { aircraftChoices, useWorkbenchStore } from '@/stores'
import { HEX_DIRECTIONS, neighbor, sameHex } from '@/engine/hex-geometry'
import {
  CORE_HEX,
  NEAR_HEX,
  placeGround,
  placeAir,
  airBaseRecord,
  fighterRecord,
  groundRecord,
} from '../flows/sop-harness'

function cargoTask() {
  setActivePinia(createPinia())
  const w = useWorkbenchStore()
  w.setPhase('movement')
  w.setSegmentStepIndex(
    w.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
  )
  placeGround(w, airBaseRecord(1), CORE_HEX, 'axis', 'origin')
  placeGround(w, airBaseRecord(1), NEAR_HEX, 'axis', 'destination')
  const pz = HEX_DIRECTIONS.map((dir) => neighbor(NEAR_HEX, dir)).find(
    (hex) => !sameHex(hex, CORE_HEX),
  )!
  placeGround(w, airBaseRecord(1), pz, 'soviet', 'enemy-base')
  placeAir(w, fighterRecord('soviet'), pz, 'soviet', 'interceptor')
  const record = aircraftChoices('axis').find((record) => (record.transportCapacity ?? 0) > 0)!
  placeAir(w, record, CORE_HEX, 'axis', 'transport')
  w.airUnits.find((air) => air.instanceId === 'transport')!.transportCapacity = 1
  w.airUnits.find((air) => air.instanceId === 'transport')!.transportCapacityBack = 0.5
  w.spDumps.push({ id: 'stock', side: 'axis', hex: CORE_HEX, sp: 0, t: 2 })
  w.setAirActive(true)
  w.setAirMissionKind('air_transport')
  w.setAirTargetFromText(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
  w.toggleAirMissionUnit('transport')
  w.airInputs.cargoSpT = 1
  return w
}
const totalT = (w: ReturnType<typeof cargoTask>) =>
  w.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)

describe('任务中止与存活名单真实流程', () => {
  it('主动中止整场轰炸也记录目标格尝试次数，不能通过退出反复试探', () => {
    const w = cargoTask()
    w.clearAir()
    placeAir(w, fighterRecord('axis'), CORE_HEX, 'axis', 'abort-fighter')
    w.setAirActive(true)
    w.setAirMissionKind('barrage')
    w.setAirTargetFromText(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
    w.toggleAirMissionUnit('abort-fighter')
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.voluntaryReturnNow(['abort-fighter'])).toBe(true)
    expect(w.airState!.finished).toBe(true)
    expect(w.barragePhaseLedger.hexes).toContain(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
    expect(w.voluntaryReturnNow(['abort-fighter'])).toBe(false)
    expect(
      w.airUnits.find((air) => air.instanceId === 'abort-fighter')!.missionsFlownThisPhase,
    ).toBe(1)
  })
  it('轰炸机全部中止后不产生对地战果，但仍记录轰炸尝试并正常收束', () => {
    const w = cargoTask()
    w.clearAir()
    w.units = w.units.filter((unit) => unit.instanceId !== 'destination')
    const target = placeGround(
      w,
      groundRecord('soviet', (r) => r.isCombat === true),
      NEAR_HEX,
      'soviet',
      'target',
    )
    placeAir(w, fighterRecord('axis'), CORE_HEX, 'axis', 'bombing-fighter')
    w.airUnits.find((air) => air.instanceId === 'bombing-fighter')!.airCombatRating = 0
    w.setAirActive(true)
    w.setAirMissionKind('barrage')
    w.setAirTargetFromText(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
    w.toggleAirMissionUnit('bombing-fighter')
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.confirmAirCombatNow()).toBe(true)
    w.airInputs.interceptDeclared = true
    w.airInputs.interceptorId = 'interceptor'
    expect(w.declareInterceptionNow()).toBe(true)
    w.airInputs.interceptDie = 12
    w.airInputs.interceptLossDie = 1
    expect(w.resolveInterceptionCombatNow()).toBe(true)
    expect(w.resolveFlakNow()).toBe(true)
    expect(w.beginAirBarrageNow()).toBe(false)
    const steps = target.steps
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.barrageState).toBeNull()
    expect(target.steps).toBe(steps)
    expect(w.barragePhaseLedger.hexes).toContain(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
    expect(w.completeAirReturnNow()).toBe(true)
  })
  it('空战减损并中止、承运机仍存活时，原装载货物整组退回，不套用继续投送的防空货损', () => {
    const w = cargoTask()
    w.airInputs.cargoSpT = 2
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.confirmAirCombatNow()).toBe(true)
    w.airInputs.interceptDeclared = true
    w.airInputs.interceptorId = 'interceptor'
    expect(w.declareInterceptionNow()).toBe(true)
    w.airInputs.interceptDie = 12
    w.airInputs.interceptLossDie = 6
    expect(w.resolveInterceptionCombatNow()).toBe(true)
    expect(w.airUnits.find((air) => air.instanceId === 'transport')!.steps).toBe(1)
    expect(w.resolveFlakNow()).toBe(true)
    expect(w.airCargoLossPending).toBeNull()
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.airState!.cargo!.items.every((item) => item.fate === 'retained')).toBe(true)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
    expect(totalT(w)).toBe(2)
  })
  it('拦截中止承运机后不再防空或投送；货物随实际返航基地落账', () => {
    const w = cargoTask()
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.confirmAirCombatNow()).toBe(true)
    w.airInputs.interceptDeclared = true
    w.airInputs.interceptorId = 'interceptor'
    expect(w.declareInterceptionNow()).toBe(true)
    const rng = w.rng
    expect(w.resolveFlakNow()).toBe(false) // 尚未结算已宣布的拦截。
    expect(w.rng).toEqual(rng)
    w.airInputs.interceptDie = 12
    w.airInputs.interceptLossDie = 1
    expect(w.resolveInterceptionCombatNow()).toBe(true)
    expect(w.airUnits.find((air) => air.instanceId === 'transport')!.airStatus).toBe('inactive')
    expect(w.airMissionCargoCapacityNow).toBe(0)
    const after = w.rng
    expect(w.resolveInterceptionCombatNow()).toBe(false)
    expect(w.rng).toEqual(after)
    expect(w.resolveFlakNow()).toBe(true)
    expect(w.rng).toEqual(after)
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.airState!.cargo!.items[0]!.fate).toBe('retained')
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(0)
    expect(totalT(w)).toBe(1)
    expect(w.confirmAirMissionNow()).toBe(true)
    w.airInputs.returnHexText.transport = `${NEAR_HEX.col}.${NEAR_HEX.row}`
    expect(w.completeAirReturnNow()).toBe(true)
    expect(w.spDumps.find((dump) => sameHex(dump.hex, NEAR_HEX))!.t).toBe(1)
    expect(totalT(w)).toBe(2)
    expect(w.airUnits.find((air) => air.instanceId === 'transport')!.hex).toEqual(NEAR_HEX)
    expect(w.airUnits.find((air) => air.instanceId === 'transport')!.missionsFlownThisPhase).toBe(1)
    expect(w.airUnits.find((air) => air.instanceId === 'interceptor')!.missionsFlownThisPhase).toBe(
      0,
    )
    expect(w.completeAirReturnNow()).toBe(false)
    expect(totalT(w)).toBe(2)
  })
  it('防空摧毁最后承运机后，货物按逐机货单确定损失；不能空返航退款或让死亡飞机返航', () => {
    const w = cargoTask()
    w.airUnits.find((air) => air.instanceId === 'transport')!.steps = 1
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.declareInterceptionNow()).toBe(true)
    w.airInputs.flakDie = 12
    w.airInputs.lossDie = 1
    expect(w.resolveFlakNow()).toBe(true)
    // 14.9e（T14）：唯一承运机被毁 ⇒ 其货物确定损失，不再要求玩家选 14.4g 超额货损。
    expect(w.airCargoLossPending).toBeNull()
    expect(w.voluntaryReturnNow([])).toBe(false)
    expect(totalT(w)).toBe(1)
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.airMissionReturnOrigins).toEqual([])
    expect(w.completeAirReturnNow()).toBe(true)
    expect(w.airState!.returns).toEqual([])
    expect(w.airState!.assignment.origins).toEqual([])
    expect(w.deadPile.filter((unit) => unit.instanceId === 'transport')).toHaveLength(1)
    expect(w.airSupplyManifest!.items[0]!.fate).toBe('lost')
    expect(totalT(w)).toBe(1)
  })
  it('任务飞机仍在起飞基地坐标时，也必须实际参加任务格空战', () => {
    const w = cargoTask()
    w.clearAir()
    w.units = w.units.filter((unit) => unit.instanceId !== 'destination')
    placeGround(w, airBaseRecord(1), NEAR_HEX, 'soviet', 'target-base')
    placeAir(w, fighterRecord('axis'), CORE_HEX, 'axis', 'sweep')
    placeAir(w, fighterRecord('soviet'), NEAR_HEX, 'soviet', 'defender')
    w.airUnits.find((air) => air.instanceId === 'sweep')!.airCombatRating = 0
    w.airUnits.find((air) => air.instanceId === 'defender')!.airCombatRating = 9
    w.setAirActive(true)
    w.setAirMissionKind('fighter_sweep')
    w.setAirTargetFromText(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
    w.toggleAirMissionUnit('sweep')
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.airState!.combat!.occurs).toBe(true)
    expect(w.airState!.airCombat!.rounds.length).toBeGreaterThan(0)
    expect(w.airUnits.find((air) => air.instanceId === 'sweep')!.airStatus).toBe('inactive')
    expect(w.declareInterceptionNow()).toBe(true)
    const rng = w.rng
    expect(w.resolveFlakNow()).toBe(true)
    expect(w.rng).toEqual(rng)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
    expect(w.airUnits.find((air) => air.instanceId === 'sweep')!.missionsFlownThisPhase).toBe(1)
  })
})
