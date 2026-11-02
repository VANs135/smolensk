import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { HEX_DIRECTIONS, neighbor, sameHex } from '@/engine/hex-geometry'
import { useWorkbenchStore } from '@/stores'
import {
  CORE_HEX,
  NEAR_HEX,
  groundRecord,
  placeGround,
  placeAir,
  airBaseRecord,
  fighterRecord,
} from '../flows/sop-harness'

function fresh() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}
function ground() {
  const w = fresh()
  w.setPhase('movement')
  w.setSegmentStepIndex(
    w.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
  )
  const record = groundRecord(
    'axis',
    (r) =>
      r.attackCapable === true &&
      r.classes?.movementClass === 'leg' &&
      (r.factors?.combat?.ma ?? 0) >= 4,
  )
  const unit = placeGround(w, record, CORE_HEX, 'axis', 'moving')
  w.beginMovePick(CORE_HEX, ['moving'])
  expect(w.confirmMovePick()).toBe(true)
  const destination = w.groupReachable.hexes.find((node) => node.path.length === 2)!
  expect(destination).toBeDefined()
  return { w, unit, destination, record }
}
function air(phase: 'movement' | 'reaction' = 'movement') {
  const w = fresh()
  w.setPhase(phase)
  if (phase === 'reaction') w.activeSide = 'soviet'
  w.setSegmentStepIndex(
    w.playerSegmentSteps.findIndex((step) => step.id.endsWith('modeAndMovement')),
  )
  placeGround(w, airBaseRecord(2), CORE_HEX, 'axis', 'base')
  placeGround(w, airBaseRecord(2), NEAR_HEX, 'axis', 'other-base')
  placeAir(w, fighterRecord('axis'), CORE_HEX, 'axis', 'plane')
  w.setAirActive(true)
  w.setAirMissionKind('fighter_sweep')
  w.setAirTargetFromText(`${CORE_HEX.col}.${CORE_HEX.row}`)
  w.toggleAirMissionUnit('plane')
  w.airInputs.flakDie = 2
  return w
}
describe('移动运行时与空军任务隔离', () => {
  it('14.2f-F：同格同编成的旧轰炸不能替代新任务，重试则沿用本次进度', () => {
    function task() {
      const w = air()
      w.setAirMissionKind('barrage')
      w.setAirTargetFromText(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
      placeGround(
        w,
        groundRecord('soviet', (r) => r.isCombat === true),
        NEAR_HEX,
        'soviet',
        'target',
      )
      expect(w.beginAirMissionNow()).toBe(true)
      expect(w.confirmAirCombatNow()).toBe(true)
      expect(w.declareInterceptionNow()).toBe(true)
      expect(w.resolveFlakNow()).toBe(true)
      return w
    }
    const previous = task()
    expect(previous.beginAirBarrageNow()).toBe(true)
    expect(previous.confirmBarrageSupplyStep()).toBe(true)
    expect(previous.confirmBarrageShiftsStep()).toBe(true)
    previous.barrageInputs.die = 2
    expect(previous.rollBarrageDiceStep()).toBe(true)
    expect(previous.confirmBarrageOutcomeStep()).toBe(true)
    expect(previous.confirmAirMissionNow()).toBe(true)

    const current = task()
    // 注入真实完成的旧结算，验证归属不能仅凭坐标和飞机ID判断。
    current.barrageState = previous.barrageState
    expect(current.confirmAirMissionNow()).toBe(false)
    expect(current.airError?.reason).toBe('barrageOutcomePending')
    expect(current.beginAirBarrageNow()).toBe(true)
    expect(current.barrageState).not.toBe(previous.barrageState)
    expect(current.confirmBarrageSupplyStep()).toBe(true)
    const progress = current.barrageState
    const rng = current.rng
    expect(current.beginAirBarrageNow()).toBe(true)
    expect(current.barrageState).toBe(progress)
    expect(current.rng).toEqual(rng)
    expect(current.confirmBarrageShiftsStep()).toBe(true)
    current.barrageInputs.die = 2
    expect(current.rollBarrageDiceStep()).toBe(true)
    expect(current.confirmBarrageOutcomeStep()).toBe(true)
    expect(current.confirmAirMissionNow()).toBe(true)
  })
  it('14.2f：任务进行中不能开拔、结束或拆分地面移动', () => {
    const w = air()
    placeGround(
      w,
      groundRecord('axis', (r) => r.classes?.movementClass === 'leg'),
      CORE_HEX,
      'axis',
      'ground',
    )
    expect(w.beginMoveFor(['ground'])).toBe(true)
    expect(w.beginAirMissionNow()).toBe(true)
    const movement = w.moveInteraction
    expect(w.beginMoveFor(['ground'])).toBe(false)
    w.finishMove()
    expect(w.dropUnitFromMove('ground')).toBe(false)
    expect(w.moveInteraction).toBe(movement)
    expect(w.units.find((unit) => unit.instanceId === 'ground')!.movementEnded).toBe(false)
  })
  it('6.1：普通迈步可撤销，位置与MP一起还原', () => {
    const { w, destination } = ground()
    w.clickHex(destination.hex)
    expect(w.units.find((unit) => unit.instanceId === 'moving')!.mpSpent).toBeGreaterThan(0)
    w.undoLastStep()
    const restored = w.units.find((unit) => unit.instanceId === 'moving')!
    expect(restored.hex).toEqual(CORE_HEX)
    expect(restored.mpSpent).toBe(0)
  })
  it('6.1g：另一单位不能挤掉尚未结束的移动现场', () => {
    const { w, destination, record } = ground()
    w.clickHex(destination.hex)
    placeGround(w, record, CORE_HEX, 'axis', 'second')
    const current = w.moveInteraction
    w.beginMovePick(CORE_HEX, ['second'])
    expect(w.confirmMovePick()).toBe(false)
    expect(w.moveInteraction).toBe(current)
    expect(w.moveBlocked?.rule).toBe('6.1g')
  })
  it('9.14：移动触发缴获后不能只撤回位置而保留战果', () => {
    const { w, destination } = ground()
    w.spDumps.push({ id: 'enemy-sp', hex: destination.hex, side: 'soviet', sp: 2, t: 0 })
    w.clickHex(destination.hex)
    const at = w.units.find((unit) => unit.instanceId === 'moving')!.hex
    const dumps = JSON.stringify(w.spDumps),
      rng = w.rng
    w.undoLastStep()
    w.cancelWholeMove()
    expect(w.units.find((unit) => unit.instanceId === 'moving')!.hex).toEqual(at)
    expect(JSON.stringify(w.spDumps)).toBe(dumps)
    expect(w.rng).toEqual(rng)
    expect(w.moveBlocked).not.toBeNull()
  })
  it('14.2f：正在执行的任务不能改目标、改类型、取消或换阶段丢弃', () => {
    const w = air()
    expect(w.beginAirMissionNow()).toBe(true)
    const state = w.airState
    w.setAirTargetFromText(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
    w.setAirMissionKind('barrage')
    w.cancelAir()
    w.setPhase('supply')
    expect(w.airState).toBe(state)
    expect(w.airMissionKind).toBe('fighter_sweep')
    expect(w.phase).toBe('movement')
    w.resetAll()
    expect(w.airState).toBeNull()
  })
  it('14.2d/14.1c：飞越地面ZOC，返航到所选基地并变非激活，不花地面MP', () => {
    const w = air()
    const enemyHex = HEX_DIRECTIONS.map((dir) => neighbor(CORE_HEX, dir)).find(
      (hex) => !sameHex(hex, NEAR_HEX),
    )!
    placeGround(
      w,
      groundRecord('soviet', (r) => r.attackCapable === true),
      enemyHex,
      'soviet',
      'enemy',
    )
    const groundBefore = w.units.map((unit) => ({
      id: unit.instanceId,
      hex: { ...unit.hex },
      mp: unit.mpSpent,
    }))
    expect(w.runAirMissionNow()).toBe(true)
    expect(w.airState!.step).toBe('returnToBase')
    w.airInputs.returnHexText.plane = `${NEAR_HEX.col}.${NEAR_HEX.row}`
    expect(w.completeAirReturnNow()).toBe(true)
    expect(w.airUnits[0]!.hex).toEqual(NEAR_HEX)
    expect(w.airUnits[0]!.airStatus).toBe('inactive')
    expect(w.airUnits[0]!.missionsFlownThisPhase).toBe(1)
    expect(
      w.units.map((unit) => ({ id: unit.instanceId, hex: unit.hex, mp: unit.mpSpent })),
    ).toEqual(groundBefore)
    expect(w.completeAirReturnNow()).toBe(false)
    expect(w.airUnits[0]!.missionsFlownThisPhase).toBe(1)
  })
  it('7.0/14.2：反应任务使用非阶段玩家身份，不改变玩家回合归属', () => {
    const w = air('reaction')
    expect(w.ownAirUnits.every((plane) => plane.side === 'axis')).toBe(true)
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.airState!.side).toBe('axis')
    expect(w.activeSide).toBe('soviet')
  })
})
