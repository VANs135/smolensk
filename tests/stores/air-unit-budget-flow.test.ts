import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import type { HexRef } from '@/data'
import { validBoardEntities } from '@/engine/board-validation'
import { HEX_DIRECTIONS, neighbor, sameHex } from '@/engine/hex-geometry'
import type { ModeState, MovementSegmentPhase } from '@/engine/rules/modes'
import { evaluateStepFrom } from '@/engine/rules/move'
import {
  aircraftChoices,
  availableMaOf,
  resolveBattle,
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
  label,
  NEAR_HEX,
  placeAir,
  placeGround,
  type Workbench,
} from '../flows/sop-harness'

function enterMovementSegment(w: Workbench, phase: MovementSegmentPhase) {
  const segment = phase === 'movement' ? 'movement.modeAndMovement' : `${phase}.movement`
  expect(w.setSegmentStepIndex(w.playerSegmentSteps.findIndex((step) => step.id === segment))).toBe(
    true,
  )
}

function setup(phase: MovementSegmentPhase = 'movement', withSession = false) {
  setActivePinia(createPinia())
  const w = useWorkbenchStore()
  if (withSession) {
    const game = useGameSessionStore()
    game.setSaveStorage(createMemoryStorage())
    game.startGame()
  }
  w.setActiveSide(phase === 'reaction' ? 'soviet' : 'axis')
  w.setPhase(phase)
  enterMovementSegment(w, phase)
  placeGround(w, airBaseRecord(1), CORE_HEX, 'axis', 'origin-base')
  placeGround(w, airBaseRecord(1), NEAR_HEX, 'axis', 'destination-base')
  const record = unitChoices('axis').find((record) => {
    const unit = toConsoleUnit({ record, instanceId: 'probe', hex: CORE_HEX, side: 'axis' })
    return (
      unit.isCombat &&
      unit.attackCapable &&
      unit.re === 1 &&
      unit.faces.move.mobility === 'leg' &&
      unit.faces.move.ma >= 4 &&
      unit.faces.move.ma <= 6
    )
  })
  if (record === undefined) throw new Error('找不到可空运的真实1RE步行单位')
  placeGround(w, record, CORE_HEX, 'axis', 'cargo', 'move')
  const transport = aircraftChoices('axis').find((record) => (record.transportCapacity ?? 0) > 0)
  if (transport === undefined) throw new Error('找不到真实运输机')
  placeAir(w, transport, CORE_HEX, 'axis', 'transport')
  w.airUnits[0]!.transportCapacity = 1
  w.airUnits[0]!.transportCapacityBack = 0.5
  w.setAirActive(true)
  w.setAirMissionKind('air_transport')
  w.setAirTargetFromText(label(NEAR_HEX))
  w.toggleAirMissionUnit('transport')
  w.toggleAirCargoUnit('cargo')
  return { w, cargo: w.units.find((unit) => unit.instanceId === 'cargo')!, transport }
}

function finishFlight(w: Workbench) {
  expect(w.confirmAirCombatNow()).toBe(true)
  expect(w.declareInterceptionNow()).toBe(true)
  w.airInputs.flakDie = 2
  expect(w.resolveFlakNow()).toBe(true)
  expect(w.resolveAirCargoNow()).toBe(true)
  expect(w.confirmAirMissionNow()).toBe(true)
  expect(w.completeAirReturnNow()).toBe(true)
}

function snapshot(w: Workbench) {
  return {
    units: w.units.map((unit) => ({
      id: unit.instanceId,
      hex: { ...unit.hex },
      mpSpent: unit.mpSpent,
      transport: unit.airTransportThisPhase,
    })),
    dumps: w.spDumps.map((dump) => ({ ...dump, hex: { ...dump.hex } })),
    rng: w.rng,
    draws: w.drawCount,
  }
}

/** 用真实一步验证运输前的消耗；不把空运本身折算成地面MP。 */
function releaseAndMoveIntoOrigin(w: Workbench) {
  const cargo = w.units.find((unit) => unit.instanceId === 'cargo')!
  cargo.mode = { mode: 'reserve', orientation: 'move', dg: false, exploit: false }
  let start: HexRef | undefined
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(CORE_HEX, direction)
    if (sameHex(candidate, NEAR_HEX) || !w.moveContext.map.onMap(candidate)) continue
    cargo.hex = { ...candidate }
    // 释放后的真实模式只用于选合法夹具；正式释放仍从store入口执行。
    const view = {
      ...w.moveContext.units.find((unit) => unit.id === 'cargo')!,
      releasedFromReserve: true,
    }
    const step = evaluateStepFrom(w.moveContext, view, candidate, CORE_HEX)
    if (step.ok && !step.mustEndMove && step.cost <= cargo.faces.move.ma / 4) {
      start = candidate
      break
    }
  }
  if (start === undefined) throw new Error('找不到反应阶段可在四分之一MA内走到机场的一步')
  w.selectedId = 'cargo'
  expect(w.releaseReserveNow()).toBe(true)
  expect(cargo.mode.releasedFromReserve).toBe(true)
  if (w.moveInteraction === null) expect(w.beginMoveFor(['cargo'])).toBe(true)
  w.clickHex(CORE_HEX)
  expect(cargo.hex).toEqual(CORE_HEX)
  expect(cargo.mpSpent).toBeGreaterThan(0)
  expect(cargo.mpSpent).toBeLessThanOrEqual(cargo.faces.move.ma / 4)
}

describe('14.9d / 4.7d：空运地面移动额度及阶段身份的真实流程', () => {
  it('14.9d：超半MA装载前拒绝且不扣库存；恰好半MA可运输，落地不能再走', () => {
    const { w, cargo } = setup()
    const limit = cargo.faces.move.ma / 2
    cargo.mpSpent = limit + 0.5
    w.airUnits[0]!.transportCapacity = 2
    w.spDumps.push({ id: 'stock', side: 'axis', hex: CORE_HEX, sp: 0, t: 1 })
    w.airInputs.cargoSpT = 1
    const before = snapshot(w)
    expect(w.beginAirMissionNow()).toBe(false)
    expect(w.airError).toEqual({ rule: '14.9d', reason: 'airTransportGroundMovementExceeded' })
    expect(snapshot(w)).toEqual(before)
    expect(w.airUnitCargoManifest).toEqual([])
    expect(w.airSupplyManifest).toBeNull()
    expect(cargo.airTransportThisPhase).toBeNull()

    cargo.mpSpent = limit
    w.airInputs.cargoSpT = 0
    expect(w.beginAirMissionNow()).toBe(true)
    expect(cargo.airTransportThisPhase).toEqual({
      kind: 'air_transport',
      phase: 'movement',
      releasedFromReserve: false,
    })
    expect(cargo.mpSpent).toBe(limit)
    finishFlight(w)
    expect(cargo.mpSpent).toBe(limit)
    expect(availableMaOf(cargo, 'movement')).toBe(limit)
    expect(w.beginMoveFor(['cargo'])).toBe(true)
    expect(w.groupReachable.units[0]).toMatchObject({ ma: limit, spentMp: limit, remaining: 0 })
    expect(w.groupReachable.hexes).toEqual([])
    w.clickHex(CORE_HEX)
    expect(cargo.hex).toEqual(NEAR_HEX)
    expect(cargo.mpSpent).toBe(limit)
  })

  it('5.7b / 14.9d：反应空运属于非阶段玩家，真正释放后前后共用四分之一印刷MA', () => {
    const { w, cargo } = setup('reaction')
    expect(w.activeSide).toBe('soviet')
    releaseAndMoveIntoOrigin(w)
    const spentBeforeFlight = cargo.mpSpent
    const limit = cargo.faces.move.ma / 4
    expect(w.airCargoUnitChoices.some((unit) => unit.instanceId === 'cargo')).toBe(true)
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.airState!.side).toBe('axis')
    expect(cargo.airTransportThisPhase).toEqual({
      kind: 'air_transport',
      phase: 'reaction',
      releasedFromReserve: true,
    })
    expect(w.moveInteraction).toBeNull()
    expect(cargo.mpSpent).toBe(spentBeforeFlight)
    finishFlight(w)
    expect(w.activeSide).toBe('soviet')
    expect(cargo.mode.releasedFromReserve).toBe(true)
    expect(cargo.mpSpent).toBe(spentBeforeFlight)
    expect(availableMaOf(cargo, 'reaction')).toBe(limit)
    expect(w.beginMoveFor(['cargo'])).toBe(true)
    expect(w.groupReachable.units[0]).toMatchObject({
      ma: limit,
      spentMp: spentBeforeFlight,
      remaining: limit - spentBeforeFlight,
    })
    expect(w.groupReachable.hexes.every((node) => node.mpSpent <= limit)).toBe(true)
  })

  it('5.7b / 14.9d：进击阶段已释放预备空运后保留身份及半印刷MA，不再重复折半', () => {
    const { w, cargo } = setup('exploitation')
    cargo.mode = { mode: 'reserve', orientation: 'move', dg: false, exploit: false }
    w.selectedId = 'cargo'
    expect(w.releaseReserveNow()).toBe(true)
    expect(w.beginAirMissionNow()).toBe(true)
    finishFlight(w)
    expect(cargo.airTransportThisPhase).toMatchObject({
      phase: 'exploitation',
      releasedFromReserve: true,
    })
    expect(cargo.mode.releasedFromReserve).toBe(true)
    expect(cargo.mpSpent).toBe(0)
    expect(availableMaOf(cargo, 'exploitation')).toBe(cargo.faces.move.ma / 2)
    expect(w.beginMoveFor(['cargo'])).toBe(true)
    expect(w.groupReachable.units[0]!.ma).toBe(cargo.faces.move.ma / 2)
  })

  it('14.9d：进击阶段普通移动模式可空运但MA为零，转到战斗环节强选参战仍被内核拒绝', () => {
    const { w, cargo } = setup('exploitation')
    expect(w.beginAirMissionNow()).toBe(true)
    finishFlight(w)
    expect(cargo.mpSpent).toBe(0)
    expect(cargo.airTransportThisPhase).toEqual({
      kind: 'air_transport',
      phase: 'exploitation',
      releasedFromReserve: false,
    })
    expect(availableMaOf(cargo, 'exploitation')).toBe(0)
    expect(w.beginMoveFor(['cargo'])).toBe(false)
    const enemyHex = HEX_DIRECTIONS.map((direction) => neighbor(NEAR_HEX, direction)).find(
      (hex) => !sameHex(hex, CORE_HEX) && w.moveContext.map.onMap(hex),
    )!
    placeGround(w, combatRecord('soviet'), enemyHex, 'soviet', 'enemy')
    expect(
      w.setSegmentStepIndex(
        w.playerSegmentSteps.findIndex((step) => step.id === 'exploitation.combat'),
      ),
    ).toBe(true)
    expect(cargo.airTransportThisPhase!.releasedFromReserve).toBe(false)
    w.battleTarget = { hex: enemyHex, defenderIds: ['enemy'] }
    w.combatAttackerIds = ['cargo']
    const rng = w.rng
    expect(w.beginCombatNow()).toBe(false)
    expect(w.combatError).toEqual({ rule: '14.9d', reason: 'airTransportForbidsAttack:cargo' })
    expect(w.combatState).toBeNull()
    expect(
      resolveBattle({
        rng: w.rng,
        attackers: [cargo],
        defenders: [w.units.find((unit) => unit.instanceId === 'enemy')!],
        chosenTerrain: 'Open',
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('14.9d') })
    expect(w.rng).toEqual(rng)
  })

  it('14.9d：反应阶段未释放的普通移动单位可空运，落地无地面移动额度', () => {
    const { w, cargo } = setup('reaction')
    expect(w.beginAirMissionNow()).toBe(true)
    finishFlight(w)
    expect(cargo.airTransportThisPhase).toMatchObject({
      phase: 'reaction',
      releasedFromReserve: false,
    })
    expect(cargo.mpSpent).toBe(0)
    expect(availableMaOf(cargo, 'reaction')).toBe(0)
    expect(w.beginMoveFor(['cargo'])).toBe(false)
  })

  it('14.9d：同阶段换用第二架激活运输机不重复扣MP，也不把半MA变成四分之一', () => {
    const { w, cargo, transport } = setup()
    cargo.mpSpent = 1
    expect(w.beginAirMissionNow()).toBe(true)
    finishFlight(w)
    expect(cargo.mpSpent).toBe(1)
    expect(availableMaOf(cargo, 'movement')).toBe(cargo.faces.move.ma / 2)
    placeAir(w, transport, NEAR_HEX, 'axis', 'second-transport')
    const second = w.airUnits.find((air) => air.instanceId === 'second-transport')!
    second.transportCapacity = 1
    second.transportCapacityBack = 0.5
    w.clearAir()
    w.setAirMissionKind('air_transport')
    w.setAirTargetFromText(label(CORE_HEX))
    w.toggleAirMissionUnit('second-transport')
    w.toggleAirCargoUnit('cargo')
    expect(w.beginAirMissionNow()).toBe(true)
    expect(cargo.mpSpent).toBe(1)
    finishFlight(w)
    expect(cargo.hex).toEqual(CORE_HEX)
    expect(cargo.mpSpent).toBe(1)
    expect(availableMaOf(cargo, 'movement')).toBe(cargo.faces.move.ma / 2)
    expect(w.beginMoveFor(['cargo'])).toBe(true)
    expect(w.groupReachable.units[0]).toMatchObject({
      ma: cargo.faces.move.ma / 2,
      spentMp: 1,
      remaining: cargo.faces.move.ma / 2 - 1,
    })
  })

  it('14.9d / 14.1c：装载后主动中止并退运仍保留本阶段半MA义务，不伪造地面MP', () => {
    const { w, cargo } = setup()
    cargo.mpSpent = 1
    expect(w.beginAirMissionNow()).toBe(true)
    expect(cargo.airTransportThisPhase).toMatchObject({ kind: 'air_transport', phase: 'movement' })
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.voluntaryReturnNow(['transport'])).toBe(true)
    expect(w.airState!.finished).toBe(true)
    expect(w.airUnitCargoManifest[0]!.fate).toBe('returned')
    expect(cargo.hex).toEqual(CORE_HEX)
    expect(cargo.mpSpent).toBe(1)
    expect(cargo.airTransportThisPhase).toMatchObject({ kind: 'air_transport', phase: 'movement' })
    expect(availableMaOf(cargo, 'movement')).toBe(cargo.faces.move.ma / 2)
  })

  it('专规3.5：空运后即使实际地面MP为0，也不能补放仅限移动前的建造标记', () => {
    const { w, cargo } = setup()
    w.constructionMarkers = 1
    expect(w.beginAirMissionNow()).toBe(true)
    finishFlight(w)
    expect(cargo.mpSpent).toBe(0)
    expect(w.useConstructionMarkerNow('bridge', label(NEAR_HEX))).toBe(false)
    expect(w.exclusiveError).toMatchObject({
      rule: '专规 3.5',
      reason: 'constructionMarkerMustBePlacedBeforeMovement',
    })
    expect(w.constructionMarkers).toBe(1)
  })

  it('2.2 / 14.9d：重复点当前阶段不清除MP、运输义务、出动和卸载记录', () => {
    const { w, cargo } = setup()
    cargo.mpSpent = 1
    expect(w.beginAirMissionNow()).toBe(true)
    finishFlight(w)
    const before = snapshot(w)
    const transport = cargo.airTransportThisPhase
    const flights = w.airUnits.map((air) => air.missionsFlownThisPhase)
    const unloaded = w.airUnloadedTAt(NEAR_HEX, 'axis')
    const step = w.segmentStepIndex
    w.setPhase('movement')
    expect(snapshot(w)).toEqual(before)
    expect(cargo.airTransportThisPhase).toBe(transport)
    expect(w.airUnits.map((air) => air.missionsFlownThisPhase)).toEqual(flights)
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(unloaded)
    expect(w.segmentStepIndex).toBe(step)
  })

  it('14.9d：存读档保留真实已耗MP和半MA义务，下一阶段清理限制', () => {
    const { w, cargo } = setup('movement', true)
    cargo.mpSpent = 1
    expect(w.beginAirMissionNow()).toBe(true)
    finishFlight(w)
    const game = useGameSessionStore()
    expect(game.saveNow()).toBe(true)
    cargo.airTransportThisPhase = null
    cargo.mpSpent = 0
    expect(game.loadNow()).toBe(true)
    const restored = w.units.find((unit) => unit.instanceId === 'cargo')!
    expect(restored.airTransportThisPhase).toEqual({
      kind: 'air_transport',
      phase: 'movement',
      releasedFromReserve: false,
    })
    expect(restored.mpSpent).toBe(1)
    expect(availableMaOf(restored, 'movement')).toBe(restored.faces.move.ma / 2)
    w.setPhase('supply')
    expect(restored.airTransportThisPhase).toBeNull()
    expect(restored.mpSpent).toBe(0)
    w.setPhase('movement')
    expect(availableMaOf(restored, 'movement')).toBe(restored.faces.move.ma)
  })

  it('5.4 / 14.9d：主移动空运后受DG可按例外翻朝向，但不能解除空运额度', () => {
    const { w, cargo } = setup()
    expect(w.beginAirMissionNow()).toBe(true)
    finishFlight(w)
    const transport = cargo.airTransportThisPhase
    cargo.mode = { ...cargo.mode, dg: true }
    w.selectedId = 'cargo'
    w.flipUnitOrientation()
    expect(cargo.mode.orientation).toBe('combat')
    expect(cargo.airTransportThisPhase).toBe(transport)
    expect(availableMaOf(cargo, 'movement')).toBe(cargo.faces.combat.ma / 4)
    expect(cargo.mpSpent).toBe(0)
  })

  it('保存兼容：旧单位缺少运输字段仍通过实体校验，非法运输字段被拒绝', () => {
    const { w } = setup()
    const fields = {
      units: w.units,
      airUnits: w.airUnits,
      deadPile: w.deadPile,
      spDumps: w.spDumps,
    }
    const legacy = {
      ...fields,
      units: fields.units.map((unit) => {
        const copy = { ...unit }
        delete copy.airTransportThisPhase
        return copy
      }),
    }
    expect(validBoardEntities(legacy)).toBe(true)
    const malformed = {
      ...fields,
      units: fields.units.map((unit) => ({
        ...unit,
        airTransportThisPhase: { kind: 'invalid', phase: 'movement', releasedFromReserve: false },
      })),
    }
    const before = snapshot(w)
    expect(validBoardEntities(malformed)).toBe(false)
    expect(snapshot(w)).toEqual(before)
  })

  it('4.7d（N/A）：人员空投已整体关闭，4.7d 不再有触发路径', () => {
    /*
     * ★ P0（R6）：本作无空降兵 ⇒ 任何单位货物空投在宣布阶段即被 2.2b 拒绝，
     *   因而「空投单位先花过地面MP」这一分支不再可达；此处钉住入口与零副作用。
     */
    const { w, cargo } = setup()
    w.setAirMissionKind('air_drop')
    w.setTurn(3)
    enterMovementSegment(w, 'movement')
    w.airInputs.airdropPlannedTurn = 1
    w.airInputs.airdropScheduledTurn = 3
    w.airUnits[0]!.transportCapacity = 2
    w.airInputs.cargoSpT = 1
    w.spDumps.push({ id: 'stock', side: 'axis', hex: CORE_HEX, sp: 0, t: 1 })
    cargo.mpSpent = 0.5
    const before = snapshot(w)
    expect(w.beginAirMissionNow()).toBe(false)
    expect(w.airError).toMatchObject({ rule: '2.2b' })
    expect(snapshot(w)).toEqual(before)
    expect(w.airUnitCargoManifest).toEqual([])
    expect(w.airSupplyManifest).toBeNull()
  })

  it.each<{ label: string; mode: ModeState }>([
    { label: 'DG', mode: { mode: 'move', orientation: 'move', dg: true, exploit: false } },
    { label: '进击标记', mode: { mode: 'move', orientation: 'move', dg: false, exploit: true } },
    {
      label: '未释放预备',
      mode: { mode: 'reserve', orientation: 'move', dg: false, exploit: false },
    },
  ])('5.6a / 14.9c：$label 单位即使移动面朝上也不能绕过候选强行装载', ({ mode }) => {
    const { w, cargo } = setup()
    cargo.mode = mode
    expect(w.airCargoUnitChoices.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    const before = snapshot(w)
    expect(w.beginAirMissionNow()).toBe(false)
    expect(snapshot(w)).toEqual(before)
    expect(w.airUnitCargoManifest).toEqual([])
    expect(cargo.airTransportThisPhase).toBeNull()
  })
})
