import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import type { HexRef } from '@/data'
import { areAdjacent, HEX_DIRECTIONS, neighbor, sameHex } from '@/engine/hex-geometry'
import { evaluateStepFrom, zocNegatedAt } from '@/engine/rules/move'
import {
  aircraftChoices,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
} from '@/stores'
import { createMemoryStorage } from '@/shared'
import {
  airBaseRecord,
  combatRecord,
  CORE_HEX,
  fighterRecord,
  label,
  NEAR_HEX,
  placeAir,
  placeGround,
  type Workbench,
} from '../flows/sop-harness'

function setup(startSession = false) {
  setActivePinia(createPinia())
  const w = useWorkbenchStore()
  if (startSession) {
    const game = useGameSessionStore()
    game.setSaveStorage(createMemoryStorage())
    game.startGame()
  }
  w.setPhase('movement')
  w.setSegmentStepIndex(
    w.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
  )
  placeGround(w, airBaseRecord(1), CORE_HEX, 'axis', 'origin-base')
  placeGround(w, airBaseRecord(1), NEAR_HEX, 'axis', 'destination-base')
  const cargoRecord = unitChoices('axis').find((record) => {
    const view = toConsoleUnit({ record, instanceId: 'probe', hex: CORE_HEX, side: 'axis' })
    return (
      view.isCombat &&
      view.re === 1 &&
      view.faces.move.mobility === 'leg' &&
      view.faces.move.ma >= 4 &&
      view.faces.move.ma <= 6 &&
      view.rebuildable !== false
    )
  })
  if (cargoRecord === undefined) throw new Error('找不到可空运且有运输前后移动额度的真实单位')
  placeGround(w, cargoRecord, CORE_HEX, 'axis', 'cargo', 'move')
  const transport = aircraftChoices('axis').find((record) => (record.transportCapacity ?? 0) > 0)
  if (transport === undefined) throw new Error('找不到运输机')
  placeAir(w, transport, CORE_HEX, 'axis', 'transport')
  // 真实1RE步行单位计2T，半程档的1T运输机恰好能承运。
  w.airUnits[0]!.transportCapacity = 1
  w.airUnits[0]!.transportCapacityBack = 0.5
  w.setAirActive(true)
  w.setAirMissionKind('air_transport')
  w.setAirTargetFromText(label(NEAR_HEX))
  w.toggleAirMissionUnit('transport')
  w.toggleAirCargoUnit('cargo')
  return { w, cargoRecord }
}

function toCargoStep(w: Workbench) {
  expect(w.confirmAirCombatNow()).toBe(true)
  expect(w.declareInterceptionNow()).toBe(true)
  w.airInputs.flakDie = 2
  expect(w.resolveFlakNow()).toBe(true)
  expect(w.airState!.step).toBe('resolveMission')
}

/** 先实际走入起飞机场；依据真实地图选择仍保留运输后移动额度的一步。 */
function moveIntoOrigin(w: Workbench, ids: readonly string[]): HexRef {
  const cargo = w.units.find((unit) => unit.instanceId === 'cargo')!
  let from: HexRef | undefined
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(CORE_HEX, direction)
    if (sameHex(candidate, NEAR_HEX) || !w.moveContext.map.onMap(candidate)) continue
    for (const id of ids) w.units.find((unit) => unit.instanceId === id)!.hex = { ...candidate }
    const view = w.moveContext.units.find((unit) => unit.id === 'cargo')!
    const step = evaluateStepFrom(w.moveContext, view, candidate, CORE_HEX)
    if (step.ok && !step.mustEndMove && step.cost < cargo.faces.move.ma / 2) {
      from = candidate
      break
    }
  }
  if (from === undefined) throw new Error('找不到有运输后剩余额度的合法入机场路径')
  expect(w.beginMoveFor(ids)).toBe(true)
  w.clickHex(CORE_HEX)
  expect(cargo.hex).toEqual(CORE_HEX)
  expect(cargo.mpSpent).toBeGreaterThan(0)
  expect(cargo.movementEnded).toBe(false)
  expect(w.moveInteraction!.steps).toHaveLength(1)
  return from
}

describe('14.9 / 14.10：在途单位的唯一归属与地面移动交接', () => {
  it('14.9a / 4.5b / 10.0b：在途单位退出地图、守军、观察员与补给ZOC抵消，F落地后恢复', () => {
    const { w } = setup()
    const cargo = w.units.find((unit) => unit.instanceId === 'cargo')!
    cargo.mpLockedThisPhase = true
    const enemyHex = HEX_DIRECTIONS.map((direction) => neighbor(CORE_HEX, direction)).find(
      (hex) => !sameHex(hex, NEAR_HEX) && areAdjacent(hex, NEAR_HEX),
    )!
    expect(enemyHex).toBeDefined()
    placeGround(w, combatRecord('soviet'), enemyHex, 'soviet', 'enemy')
    w.units.find((unit) => unit.instanceId === 'enemy')!.hasTraceSupply = true
    w.battleTarget = { hex: CORE_HEX, defenderIds: ['cargo'] }
    expect(w.battleDefenders.map((unit) => unit.instanceId)).toEqual(['cargo'])
    expect(zocNegatedAt(w.moveContext, CORE_HEX, 'axis')).toBe(true)
    expect(w.supplyFacts.inEnemyZoc(CORE_HEX, 'axis')).toBe(false)
    expect(w.supplyFacts.hasEnemyCombatUnit(CORE_HEX, 'soviet')).toBe(true)
    w.battleTarget = { hex: enemyHex, defenderIds: ['enemy'] }
    expect(w.barrageTargetFacts.hasSpotter).toBe(true)

    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.airUnitCargoManifest).toMatchObject([
      { cargoId: 'unit:cargo', unitId: 'cargo', sourceHex: CORE_HEX, fate: 'aboard' },
    ])
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    expect(w.moveContext.units.some((unit) => unit.id === 'cargo')).toBe(false)
    expect(zocNegatedAt(w.moveContext, CORE_HEX, 'axis')).toBe(false)
    expect(w.supplyFacts.inEnemyZoc(CORE_HEX, 'axis')).toBe(true)
    expect(w.supplyFacts.hasEnemyCombatUnit(CORE_HEX, 'soviet')).toBe(false)
    expect(w.barrageTargetFacts.hasSpotter).toBe(false)
    w.battleTarget = { hex: CORE_HEX, defenderIds: ['cargo'] }
    expect(w.battleDefenders).toEqual([])

    toCargoStep(w)
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.airState!.step).toBe('resolveMission')
    expect(w.airUnitCargoManifest[0]!.fate).toBe('delivered')
    expect(w.units.filter((unit) => unit.instanceId === 'cargo')).toHaveLength(1)
    expect(w.moveContext.units.find((unit) => unit.id === 'cargo')!.hex).toEqual(NEAR_HEX)
    expect(zocNegatedAt(w.moveContext, NEAR_HEX, 'axis')).toBe(true)
    expect(w.supplyFacts.inEnemyZoc(NEAR_HEX, 'axis')).toBe(false)
    expect(w.supplyFacts.hasEnemyCombatUnit(NEAR_HEX, 'soviet')).toBe(true)
    w.battleTarget = { hex: NEAR_HEX, defenderIds: ['cargo'] }
    expect(w.battleDefenders.map((unit) => unit.instanceId)).toEqual(['cargo'])
    w.battleTarget = { hex: enemyHex, defenderIds: ['enemy'] }
    expect(w.barrageTargetFacts.hasSpotter).toBe(true)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
  })

  it('6.1g / 14.9d：装载交接丢弃旧移动历史，运输前后共用半MA，落地撤销不跨越飞行', () => {
    const { w } = setup()
    const cargo = w.units.find((unit) => unit.instanceId === 'cargo')!
    const beforeFlightStart = moveIntoOrigin(w, ['cargo'])
    const beforeFlightSpent = cargo.mpSpent
    const ma = cargo.faces.move.ma
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.moveInteraction).toBeNull()
    expect(cargo.mpSpent).toBe(beforeFlightSpent)
    w.undoLastStep()
    expect(cargo.hex).toEqual(CORE_HEX)
    expect(cargo.mpSpent).toBe(beforeFlightSpent)
    toCargoStep(w)
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(cargo.hex).toEqual(NEAR_HEX)
    expect(cargo.mpSpent).toBe(ma / 2 + beforeFlightSpent)
    expect(cargo.movementEnded).toBe(false)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
    expect(w.beginMoveFor(['cargo'])).toBe(true)
    expect(w.moveInteraction!.start).toEqual(NEAR_HEX)
    expect(w.moveInteraction!.steps).toEqual([])
    const next = w.groupReachable.hexes.find(
      (node) =>
        !sameHex(node.hex, NEAR_HEX) &&
        !sameHex(node.hex, beforeFlightStart) &&
        node.path.length === 2 &&
        node.mpSpent <= ma,
    )
    expect(next).toBeDefined()
    w.clickHex(next!.hex)
    expect(cargo.hex).toEqual(next!.hex)
    expect(cargo.mpSpent).toBeLessThanOrEqual(ma)
    w.undoLastStep()
    expect(cargo.hex).toEqual(NEAR_HEX)
    expect(cargo.mpSpent).toBe(ma / 2 + beforeFlightSpent)
    expect(w.moveInteraction!.steps).toEqual([])
    w.undoLastStep()
    expect(cargo.hex).toEqual(NEAR_HEX)
    expect(cargo.mpSpent).toBe(ma / 2 + beforeFlightSpent)
  })

  it('6.1g：同行尚未结束的非货物单位阻止空运，失败不移图、扣SP或消费骰子', () => {
    const { w, cargoRecord } = setup()
    placeGround(w, cargoRecord, CORE_HEX, 'axis', 'companion', 'move')
    moveIntoOrigin(w, ['cargo', 'companion'])
    w.airUnits[0]!.transportCapacity = 2
    w.spDumps.push({ id: 'stock', side: 'axis', hex: CORE_HEX, sp: 0, t: 1 })
    w.airInputs.cargoSpT = 1
    const units = w.units.map((unit) => ({
      id: unit.instanceId,
      hex: { ...unit.hex },
      mp: unit.mpSpent,
    }))
    const moving = w.moveInteraction
    const rng = w.rng
    const draws = w.drawCount
    expect(w.beginAirMissionNow()).toBe(false)
    expect(w.airError).toEqual({
      rule: '6.1g',
      reason: 'finishOtherGroundMovementBeforeAirTransport',
    })
    expect(w.airState).toBeNull()
    expect(w.airUnitCargoManifest).toEqual([])
    expect(w.airSupplyManifest).toBeNull()
    expect(w.moveInteraction).toBe(moving)
    expect(
      w.units.map((unit) => ({ id: unit.instanceId, hex: { ...unit.hex }, mp: unit.mpSpent })),
    ).toEqual(units)
    expect(w.spDumps).toMatchObject([{ id: 'stock', sp: 0, t: 1 }])
    expect(w.rng).toEqual(rng)
    expect(w.drawCount).toBe(draws)
  })

  it('14.9f / 14.1c：F未卸货保持在途，非法G不提前返场，合法退运只返场一次', () => {
    const { w } = setup()
    const cargo = w.units.find((unit) => unit.instanceId === 'cargo')!
    expect(w.beginAirMissionNow()).toBe(true)
    toCargoStep(w)
    w.airInputs.unloadCargoIds = []
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.airState!.cargo!.items).toMatchObject([{ id: 'unit:cargo', fate: 'retained' }])
    expect(w.airUnitCargoManifest[0]!.fate).toBe('aboard')
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    expect(cargo.mpSpent).toBe(cargo.faces.move.ma / 2)
    expect(w.confirmAirMissionNow()).toBe(true)
    w.airInputs.returnHexText.transport = label(neighbor(CORE_HEX, 'S'))
    expect(w.completeAirReturnNow()).toBe(false)
    expect(w.airUnitCargoManifest[0]!.fate).toBe('aboard')
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    w.airInputs.returnHexText.transport = label(NEAR_HEX)
    expect(w.completeAirReturnNow()).toBe(true)
    expect(w.airUnitCargoManifest[0]!.fate).toBe('returned')
    expect(cargo.hex).toEqual(NEAR_HEX)
    expect(w.units.filter((unit) => unit.instanceId === 'cargo')).toHaveLength(1)
    expect(w.completeAirReturnNow()).toBe(false)
    expect(w.units.filter((unit) => unit.instanceId === 'cargo')).toHaveLength(1)
  })

  it('14.9a：载货时存读档被拒；任务引用意外丢失仍不能保存缺失在途单位的盘面，全局重置清仓', () => {
    const { w } = setup(true)
    const game = useGameSessionStore()
    expect(game.saveNow()).toBe(true)
    expect(w.beginAirMissionNow()).toBe(true)
    expect(game.saveNow()).toBe(false)
    expect(game.saveError!.reason).toContain('地面单位在途')
    expect(game.loadNow()).toBe(false)
    expect(w.airUnitCargoManifest[0]!.fate).toBe('aboard')
    w.airState = null
    expect(game.saveNow()).toBe(false)
    expect(game.saveError!.reason).toContain('地面单位在途')
    w.resetAll()
    expect(w.airUnitCargoManifest).toEqual([])
    expect(w.units).toEqual([])
    expect(w.airState).toBeNull()
    expect(game.saveNow()).toBe(true)
  })

  it('14.10d：空投失败从在途进入死亡堆，完成返航和重试不会使单位返场', () => {
    const { w } = setup()
    w.setAirMissionKind('air_drop')
    w.setTurn(3)
    w.airInputs.airdropPlannedTurn = 1
    w.airInputs.airdropScheduledTurn = 3
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.airUnitCargoManifest[0]!.fate).toBe('aboard')
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    toCargoStep(w)
    w.airInputs.cargoDice = 2
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.airState!.cargo!.items).toMatchObject([{ id: 'unit:cargo', fate: 'destroyed' }])
    expect(w.airUnitCargoManifest[0]!.fate).toBe('lost')
    expect(w.deadPile.filter((unit) => unit.instanceId === 'cargo')).toHaveLength(1)
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(false)
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    expect(w.deadPile.filter((unit) => unit.instanceId === 'cargo')).toHaveLength(1)
  })

  it('14.2e：非载货任务忽略残留货物草稿，不移走单位或扣除SP', () => {
    const { w } = setup()
    w.toggleAirMissionUnit('transport')
    placeAir(w, fighterRecord('axis'), CORE_HEX, 'axis', 'fighter')
    w.setAirMissionKind('fighter_sweep')
    w.toggleAirMissionUnit('fighter')
    w.airInputs.cargoUnitIds = ['cargo', 'missing-old-selection']
    w.airInputs.cargoSpT = 99
    w.spDumps.push({ id: 'stock', side: 'axis', hex: CORE_HEX, sp: 0, t: 1 })
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.airState!.assignment.cargo).toEqual([])
    expect(w.airUnitCargoManifest).toEqual([])
    expect(w.airSupplyManifest).toBeNull()
    expect(w.units.find((unit) => unit.instanceId === 'cargo')!.hex).toEqual(CORE_HEX)
    expect(w.spDumps).toMatchObject([{ id: 'stock', sp: 0, t: 1 }])
  })
})
