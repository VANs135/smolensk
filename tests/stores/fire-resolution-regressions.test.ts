import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { RuleOutcome } from '@/engine/result-types'
import { createFireResolutionDomain } from '@/stores/fire-resolution'
import { createRngState, roll1d6 } from '@/engine/rng'
import { resolveBarrageDice, createMapFacts, selectMovementTerrain } from '@/engine/rules'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import { useWorkbenchStore, useHotseatStore } from '@/stores'
import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  groundRecord,
  placeGround,
  placeAir,
  fighterRecord,
} from '../flows/sop-harness'

function fresh() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}
function barrageFixture(target: 'combatUnits' | 'airBase' = 'combatUnits', gunCount = 2) {
  const w = fresh()
  w.setPhase('combat')
  w.setSegmentStepIndex(0)
  w.setBarrageActive(true)
  const record = groundRecord('axis', (r) => (r.factors?.combat?.barrage ?? 0) >= 30)
  const guns = Array.from({ length: gunCount }, (_, index) =>
    placeGround(w, record, NEAR_HEX, 'axis', `g${index + 1}`),
  )
  const victim = placeGround(
    w,
    target === 'airBase'
      ? airBaseRecord(3)
      : groundRecord('soviet', (r) => r.attackCapable === true && (r.steps?.total ?? 0) >= 3),
    CORE_HEX,
    'soviet',
    'd',
  )
  w.clickHex(CORE_HEX)
  for (const gun of guns) w.toggleBarrageUnit(gun.instanceId)
  w.setBarrageTargetKind(target)
  w.spDumps.push({ id: 's', hex: NEAR_HEX, side: 'axis', sp: 10, t: 0 })
  const group = w.groupOfUnit(guns[0]!)
  if (group !== null) w.setDumpPanzerGroupNow('s', group)
  expect(w.beginBarrageNow()).toBe(true)
  expect(w.pickBarrageSupplyDump('s')).toBe(true)
  expect(w.confirmBarrageSupplyStep()).toBe(true)
  return { w, guns, victim }
}
function chooseBarrageResult(w: ReturnType<typeof fresh>, losses: number) {
  expect(w.confirmBarrageShiftsStep()).toBe(true)
  const state = w.barrageState!
  const die = Array.from({ length: 11 }, (_, i) => i + 2).find((value) => {
    const result = resolveBarrageDice(state, { die: value, halfDie: 4 })
    return (
      result.ok &&
      result.data.state.outcome?.table === 'barrage' &&
      result.data.state.outcome.value.stepLosses === losses
    )
  })
  expect(die).toBeDefined()
  w.barrageInputs.die = die!
  w.barrageInputs.halfDie = 4
  expect(w.rollBarrageDiceStep()).toBe(true)
}
function combatFixture() {
  const w = fresh()
  w.setPhase('combat')
  w.setSegmentStepIndex(1)
  const map = createMapFacts()
  const from = HEX_DIRECTIONS.map((d) => neighbor(CORE_HEX, d)).find(
    (h) =>
      selectMovementTerrain({
        terrainsPresent: map.terrainsAt(CORE_HEX),
        mobility: 'leg',
        crossing: map.crossingBetween(h, CORE_HEX),
        followingRoad: true,
        forOverrun: false,
      }).ok,
  )!
  const a = placeGround(
    w,
    groundRecord('axis', (r) => r.attackCapable === true && r.classes?.movementClass === 'leg'),
    from,
    'axis',
    'a',
  )
  const d = placeGround(
    w,
    groundRecord('soviet', (r) => r.attackCapable === true),
    CORE_HEX,
    'soviet',
    'd',
  )
  w.combatAttackerIds = [a.instanceId]
  w.battleTarget = { hex: CORE_HEX, defenderIds: [d.instanceId] }
  w.spDumps.push(
    { id: 'sa', hex: from, side: 'axis', sp: 10, t: 0 },
    { id: 'sd', hex: CORE_HEX, side: 'soviet', sp: 10, t: 0 },
  )
  const group = w.groupOfUnit(a)
  if (group !== null) w.setDumpPanzerGroupNow('sa', group)
  expect(w.beginCombatNow()).toBe(true)
  expect(w.pickCombatSupplyDump('attacker', 'sa')).toBe(true)
  expect(w.pickCombatSupplyDump('defender', 'sd')).toBe(true)
  return { w, a, d }
}

describe('9.2/10.0：战斗与火炮真实盘面回归', () => {
  it('9.12f：连续穿越待决逐项恢复，不漏掉后续格、不重复判定已处理格', () => {
    let pending = false
    const visits: string[] = []
    const accept = <T>(outcome: RuleOutcome<T>): T | null => (outcome.ok ? outcome.data : null)
    const domain = createFireResolutionDomain({
      rng: ref(createRngState(17)),
      drawCount: ref(0),
      acceptCombat: accept,
      acceptBarrage: accept,
      applyCombatPatches() {},
      stripReserveMarkersAfterDefense() {},
      logCombatSurprise() {},
      pushLog() {},
      recordSettlement() {
        return true
      },
      nameOf: (id) => id,
      barrageLossTargets: () => [],
      barrageAircraftTargets: () => [],
      applyBarragePatches() {},
      applyAirStepLoss() {},
      applyFacilityPatch() {},
      facilityFacts: () => ({ baseLevel: 1, isAirstrip: false, portDamageBefore: 0 }),
      retreatPlans: () => [],
      hasPendingSpecial: () => pending,
      applyRetreatCrossing(crossing) {
        visits.push(crossing.unitId)
        pending = crossing.unitId !== 'third'
      },
    })
    domain.scheduleRetreatCrossings(
      ['first', 'second', 'third'].map((unitId) => ({ unitId, hex: CORE_HEX })),
    )
    expect(visits).toEqual(['first'])
    expect(domain.combatSupplyCommitted.value).toBe(true)
    domain.resumeRetreatCrossings()
    expect(visits).toEqual(['first'])
    pending = false
    domain.resumeRetreatCrossings()
    expect(visits).toEqual(['first', 'second'])
    pending = false
    domain.resumeRetreatCrossings()
    expect(visits).toEqual(['first', 'second', 'third'])
    domain.resumeRetreatCrossings()
    expect(visits).toHaveLength(3)
    expect(domain.combatSupplyCommitted.value).toBe(false)
    domain.resetCombat()
    expect(domain.combatState.value).toBeNull()
  })
  it('10.0a：损失1点是扣1点，重复确认不再扣除', () => {
    const { w, victim } = barrageFixture()
    const before = victim.steps
    chooseBarrageResult(w, 1)
    w.barrageInputs.losses = { d: 1 }
    expect(w.confirmBarrageOutcomeStep()).toBe(true)
    expect(w.units.find((u) => u.instanceId === 'd')!.steps).toBe(before - 1)
    expect(w.confirmBarrageOutcomeStep()).toBe(false)
    expect(w.units.find((u) => u.instanceId === 'd')!.steps).toBe(before - 1)
  })
  it('10.0a：单军力单位承受1点后淘汰，超额结果不能强迫分配不存在的军力', () => {
    const { w, victim } = barrageFixture('combatUnits', 4)
    victim.steps = 1
    chooseBarrageResult(w, 2)
    w.barrageInputs.losses = { d: 1 }
    expect(w.confirmBarrageOutcomeStep()).toBe(true)
    expect(w.units.some((u) => u.instanceId === 'd')).toBe(false)
    expect([...w.deadPile, ...w.removedForever].some((u) => u.instanceId === 'd')).toBe(true)
  })
  it('10.0a：取整骰仅掷1d6；重复、越步调用不推进骰源', () => {
    const { w } = barrageFixture()
    const untouched = w.rng,
      draws = w.drawCount
    expect(w.rollBarrageDiceStep()).toBe(false)
    expect(w.rng).toEqual(untouched)
    expect(w.drawCount).toBe(draws)
    expect(w.confirmBarrageShiftsStep()).toBe(true)
    const state = w.barrageState!
    const die = Array.from({ length: 11 }, (_, i) => i + 2).find((value) => {
      const result = resolveBarrageDice(state, { die: value })
      return result.ok && result.data.awaitingHalfDie
    })!
    expect(die).toBeDefined()
    w.barrageInputs.die = die
    w.rng = createRngState(17)
    const expected = roll1d6(w.rng)
    w.barrageInputs.halfDie = 7
    expect(w.rollBarrageDiceStep()).toBe(false)
    expect(w.rng).toEqual(createRngState(17))
    w.barrageInputs.halfDie = null
    expect(w.rollBarrageDiceStep()).toBe(true)
    expect(w.barrageState!.dice!.halfDie).toBe(expected.value.total)
    expect(w.rng).toEqual(expected.rng)
    const after = w.rng
    expect(w.rollBarrageDiceStep()).toBe(false)
    expect(w.rng).toEqual(after)
  })
  it('10.0：已付轰炸不能被取消、改目标、改参炸名单或换阶段抹除；整局复位可以清除', () => {
    const { w, guns } = barrageFixture()
    const state = w.barrageState,
      hex = { ...state!.targetHex }
    w.cancelBarrage()
    w.clearBarrageSelectionNow()
    w.toggleBarrageUnit(guns[0]!.instanceId)
    w.setBarrageTargetKind('airBase')
    w.clickHex(NEAR_HEX)
    w.setBarrageActive(false)
    w.setPhase('movement')
    expect(w.barrageState).toBe(state)
    expect(w.barrageState!.targetHex).toEqual(hex)
    expect(w.phase).toBe('combat')
    w.resetAll()
    expect(w.barrageState).toBeNull()
    expect(w.combatState).toBeNull()
  })
  it('10.0c：基地等级使用实际盘面并真正落盘', () => {
    const { w } = barrageFixture('airBase')
    expect(w.confirmBarrageShiftsStep()).toBe(true)
    w.barrageInputs.baseLevel = 1
    w.barrageInputs.die = 6
    expect(w.rollBarrageDiceStep()).toBe(true)
    expect(w.confirmBarrageOutcomeStep()).toBe(true)
    expect(w.units.find((u) => u.instanceId === 'd')!.noncombatLevel).toBe(1)
    expect(w.barrageState!.outcome?.table).toBe('barrage-vs-facility')
  })
  it('10.0c-A：只检查目标格实际飞机，漏填骰面自动逐机掷1d6并落损失', () => {
    const { w } = barrageFixture('airBase')
    placeAir(w, fighterRecord('soviet'), CORE_HEX, 'soviet', 'p1')
    placeAir(w, fighterRecord('soviet'), CORE_HEX, 'soviet', 'p2')
    expect(w.confirmBarrageShiftsStep()).toBe(true)
    w.barrageInputs.die = 6
    expect(w.rollBarrageDiceStep()).toBe(true)
    const before = w.airUnits.find((air) => air.instanceId === 'p1')!.steps
    w.barrageInputs.aircraftRolls = { outsider: 6 }
    const rng = w.rng
    expect(w.confirmBarrageOutcomeStep()).toBe(false)
    expect(w.rng).toEqual(rng)
    w.barrageInputs.aircraftRolls = { p1: 6 }
    const expected = roll1d6(w.rng)
    expect(w.confirmBarrageOutcomeStep()).toBe(true)
    expect(w.rng).toEqual(expected.rng)
    expect(w.airUnits.find((air) => air.instanceId === 'p1')!.steps).toBe(before - 1)
  })
  it('9.5：付款失败仍停在补给步，可补足后重试且双方不出现半笔扣款', () => {
    const { w } = combatFixture()
    const defenderBefore = w.spDumps.find((d) => d.id === 'sd')!.sp
    w.spDumps.find((d) => d.id === 'sa')!.sp = 0
    expect(w.confirmCombatSupply()).toBe(false)
    expect(w.combatState!.step).toBe('combatSupply')
    expect(w.spDumps.find((d) => d.id === 'sd')!.sp).toBe(defenderBefore)
    w.spDumps.find((d) => d.id === 'sa')!.sp = 10
    expect(w.confirmCombatSupply()).toBe(true)
    expect(w.combatState!.step).toBe('declareAr')
  })
  it('9.6：攻方先公开并锁定AR，守方后宣布；地形与损失交接给正确玩家', () => {
    const { w, a, d } = combatFixture()
    const hot = useHotseatStore()
    expect(w.confirmCombatSupply()).toBe(true)
    w.combatInputs.attackerArUnitId = a.instanceId
    w.combatInputs.defenderArUnitId = d.instanceId
    expect(w.declareCombatArStep('defender')).toBe(false)
    expect(w.declareCombatArStep('attacker')).toBe(true)
    expect(hot.viewerSide).toBe('soviet')
    expect(w.combatState!.declaredAttackerArUnitId).toBe(a.instanceId)
    expect(w.declareCombatArStep('defender')).toBe(true)
    expect(hot.viewerSide).toBe('soviet')
    const state = w.combatState
    w.selectCombatDefenderHex(NEAR_HEX)
    w.setBattleMode('quick')
    w.toggleCombatAttacker(a.instanceId)
    expect(w.combatState).toBe(state)
    expect(w.battleMode).toBe('full')
    const rng = w.rng,
      count = w.drawCount
    expect(w.rollCombatDice()).toBe(false)
    expect(w.rollCombatShiftDie()).toBe(false)
    expect(w.rng).toEqual(rng)
    expect(w.drawCount).toBe(count)
  })
  it('10.0a：轰炸横移与目标损失时热坐交给目标方', () => {
    const { w } = barrageFixture()
    const hot = useHotseatStore()
    expect(hot.viewerSide).toBe('soviet')
    expect(w.confirmBarrageShiftsStep()).toBe(true)
    expect(hot.viewerSide).toBe('axis')
    w.barrageInputs.die = 2
    expect(w.rollBarrageDiceStep()).toBe(true)
    expect(hot.viewerSide).toBe('soviet')
  })
})
