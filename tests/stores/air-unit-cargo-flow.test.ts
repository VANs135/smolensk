import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { HEX_DIRECTIONS, neighbor, sameHex } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  availableMaOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  useGameSessionStore,
} from '@/stores'
import { createMemoryStorage } from '@/shared'
import {
  CORE_HEX,
  NEAR_HEX,
  placeGround,
  placeAir,
  airBaseRecord,
  fighterRecord,
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
  placeGround(w, airBaseRecord(1), CORE_HEX, 'axis', 'base')
  placeGround(w, airBaseRecord(1), NEAR_HEX, 'axis', 'destination')
  const record = unitChoices('axis').find((record) => {
    const view = toConsoleUnit({ record, instanceId: 'probe', hex: CORE_HEX, side: 'axis' })
    return (
      view.isCombat &&
      view.re === 1 &&
      view.faces.move.mobility === 'leg' &&
      view.faces.move.ma >= 1 &&
      view.faces.move.ma <= 6
    )
  })!
  expect(record).toBeDefined()
  placeGround(w, record, CORE_HEX, 'axis', 'cargo', 'move')
  const aircraft = aircraftChoices('axis').find((record) => (record.transportCapacity ?? 0) > 0)!
  placeAir(w, aircraft, CORE_HEX, 'axis', 'transport')
  w.airUnits[0]!.transportCapacity = 1
  w.airUnits[0]!.transportCapacityBack = 0.5
  w.setAirActive(true)
  w.setAirMissionKind('air_transport')
  w.setAirTargetFromText(`${NEAR_HEX.col}.${NEAR_HEX.row}`)
  w.toggleAirMissionUnit('transport')
  w.toggleAirCargoUnit('cargo')
  return w
}

describe('14.9a / 14.4g：单位载货与真实盘面闭环', () => {
  it('宣布后不能加机重装，原任务及在途单位保留且仍可整组返航', () => {
    const w = setup()
    const record = aircraftChoices('axis').find((record) => (record.transportCapacity ?? 0) > 0)!
    placeAir(w, record, CORE_HEX, 'axis', 'out-of-range')
    w.airUnits.find((air) => air.instanceId === 'out-of-range')!.rangeHexes = 0
    expect(w.beginAirMissionNow()).toBe(true)
    const original = w.airState
    w.toggleAirMissionUnit('out-of-range')
    expect(w.airState).toBe(original)
    expect(w.airError?.reason).toBe('airCargoAlreadyLoaded')
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    expect(w.airUnitCargoManifest).toMatchObject([{ cargoId: 'unit:cargo', fate: 'aboard' }])
    expect(w.airState!.assignment.aircraftIds).toEqual(['transport'])
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.voluntaryReturnNow(['transport'])).toBe(true)
    expect(w.airState!.finished).toBe(true)
    expect(w.units.find((unit) => unit.instanceId === 'cargo')!.hex).toEqual(CORE_HEX)
  })
  it('留存单位随整组运输机退到实际基地，并记录该基地卸载量', () => {
    const w = mixedTask()
    w.airInputs.unloadCargoIds = ['sp:1']
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    expect(w.airUnitCargoManifest).toMatchObject([{ cargoId: 'unit:cargo', fate: 'aboard' }])
    expect(w.confirmAirMissionNow()).toBe(true)
    w.airInputs.returnHexText.transport = `${NEAR_HEX.col}.${NEAR_HEX.row}`
    expect(w.completeAirReturnNow()).toBe(true)
    const unit = w.units.find((unit) => unit.instanceId === 'cargo')!
    expect(unit.hex).toEqual(NEAR_HEX)
    expect(unit.mpSpent).toBe(0)
    expect(availableMaOf(unit, 'movement')).toBe(unit.faces.move.ma / 2)
    expect(w.airUnitCargoManifest).toMatchObject([{ cargoId: 'unit:cargo', fate: 'returned' }])
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(3)
    expect(w.completeAirReturnNow()).toBe(false)
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(3)
  })
  it('半T单位消耗的卸载额度可完整存读档，不被截成整数', () => {
    const w = setup(true)
    w.units.find((unit) => unit.instanceId === 'cargo')!.re = 0.25
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.declareInterceptionNow()).toBe(true)
    w.airInputs.flakDie = 2
    expect(w.resolveFlakNow()).toBe(true)
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(0.5)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
    const game = useGameSessionStore()
    expect(game.saveNow()).toBe(true)
    w.airUnloadLedger = {}
    expect(game.loadNow()).toBe(true)
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(0.5)
  })
  function mixedTask() {
    const w = setup()
    w.airUnits[0]!.transportCapacity = 2
    w.spDumps.push({ id: 'stock', side: 'axis', hex: CORE_HEX, sp: 0, t: 1 })
    w.airInputs.cargoSpT = 1
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.declareInterceptionNow()).toBe(true)
    w.airInputs.flakDie = 2
    expect(w.resolveFlakNow()).toBe(true)
    return w
  }
  it('混合卸载超限先拒绝且不改盘面；选择单位后SP只退一次', () => {
    const w = mixedTask()
    const before = w.units.map((unit) => ({
      id: unit.instanceId,
      hex: { ...unit.hex },
      mp: unit.mpSpent,
    }))
    const rng = w.rng
    expect(w.resolveAirCargoNow()).toBe(false)
    expect(w.airError?.reason).toBe('airUnloadSelectionRequired')
    expect(w.airState!.cargo).toBeNull()
    expect(w.airCargoUnloadReceipt).toBeNull()
    expect(
      w.units.map((unit) => ({ id: unit.instanceId, hex: { ...unit.hex }, mp: unit.mpSpent })),
    ).toEqual(before)
    expect(w.rng).toEqual(rng)
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(0)
    w.airInputs.unloadCargoIds = ['unit:cargo', 'sp:1']
    expect(w.resolveAirCargoNow()).toBe(false)
    expect(w.airError?.reason).toBe('selectedCargoExceedsUnloadLimit')
    w.airInputs.unloadCargoIds = ['unit:cargo']
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.units.find((unit) => unit.instanceId === 'cargo')!.hex).toEqual(NEAR_HEX)
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(2)
    expect(w.airState!.cargo!.items.find((item) => item.id === 'sp:1')!.fate).toBe('retained')
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(2)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
    expect(w.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(1)
    expect(w.airSupplyManifest!.items[0]!.fate).toBe('returned')
    expect(w.completeAirReturnNow()).toBe(false)
  })
  it('选SP卸载时不销毁未卸单位，并保留单位空运后的移动限制', () => {
    const w = mixedTask()
    w.airInputs.unloadCargoIds = ['sp:1']
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    expect(w.airUnitCargoManifest).toMatchObject([{ cargoId: 'unit:cargo', fate: 'aboard' }])
    expect(w.deadPile.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    expect(w.airUnloadedTAt(NEAR_HEX, 'axis')).toBe(1)
    expect(w.airCargoUnloadReceipt!.refusedIds).toEqual(['unit:cargo'])
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
    const returned = w.units.find((unit) => unit.instanceId === 'cargo')!
    expect(returned.hex).toEqual(CORE_HEX)
    expect(returned.mpSpent).toBe(0)
    expect(availableMaOf(returned, 'movement')).toBe(returned.faces.move.ma / 2)
    expect(w.spDumps.find((dump) => sameHex(dump.hex, NEAR_HEX))!.t).toBe(1)
  })
  it('单位载货中途不能保存不完整状态；任务及返航完成后可保存', () => {
    const w = setup(true)
    const game = useGameSessionStore()
    expect(game.saveNow()).toBe(true)
    expect(w.beginAirMissionNow()).toBe(true)
    expect(game.saveNow()).toBe(false)
    expect(game.saveError?.reason).toContain('载货空军任务仍在结算中')
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.declareInterceptionNow()).toBe(true)
    w.airInputs.flakDie = 2
    expect(w.resolveFlakNow()).toBe(true)
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
    expect(game.saveNow()).toBe(true)
  })
  it('SP与单位合计超运力时拒绝，不能先扣除SP再失败', () => {
    const w = setup()
    w.spDumps.push({ id: 'stock', hex: CORE_HEX, side: 'axis', sp: 0, t: 1 })
    w.airInputs.cargoSpT = 1 // 单位2T + SP1T，大于当前半程运力2T。
    expect(w.beginAirMissionNow()).toBe(false)
    expect(w.spDumps).toMatchObject([{ id: 'stock', sp: 0, t: 1 }])
    expect(w.airSupplyManifest).toBeNull()
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(true)
    expect(w.airUnitCargoManifest).toEqual([])
  })
  it('不能用战斗面的步行MA装载移动面16轮式MP的摩托化部队', () => {
    const w = setup()
    const motor = unitChoices('axis').find(
      (record) => record.id === 'ax-armor_pz-ge-3-pz-3-mot-inf',
    )!
    placeGround(w, motor, CORE_HEX, 'axis', 'motor', 'move')
    expect(w.airCargoUnitChoices.some((unit) => unit.instanceId === 'motor')).toBe(false)
    w.airInputs.cargoUnitIds = ['motor']
    expect(w.beginAirMissionNow()).toBe(false)
    expect(w.airError?.rule).toBe('14.9c')
  })
  it('真实2T单位不能放入1T运力；失败不改盘面或骰序', () => {
    const w = setup()
    w.airUnits[0]!.transportCapacity = 0.5 // 半程翻倍后仍只有1T。
    const rng = w.rng
    expect(w.beginAirMissionNow()).toBe(false)
    expect(w.airState).toBeNull()
    expect(w.units.find((unit) => unit.instanceId === 'cargo')!.hex).toEqual(CORE_HEX)
    expect(w.rng).toEqual(rng)
  })
  it('不能从异地搬走单位，也不能装载已不存在的ID', () => {
    const w = setup()
    w.units.find((unit) => unit.instanceId === 'cargo')!.hex = { ...NEAR_HEX }
    expect(w.beginAirMissionNow()).toBe(false)
    expect(w.airError?.reason).toBe('cargoUnitNotAtOrigin:unit:cargo')
    w.airInputs.cargoUnitIds = ['missing']
    expect(w.beginAirMissionNow()).toBe(false)
    expect(w.airError?.reason).toBe('cargoUnitMissing:missing')
  })
  it('防空减损后要求选择单位货损，确认后进死亡堆，重试不重复淘汰', () => {
    const w = setup()
    const pz = HEX_DIRECTIONS.map((dir) => neighbor(NEAR_HEX, dir)).find(
      (hex) => !sameHex(hex, CORE_HEX),
    )!
    placeGround(w, airBaseRecord(1), pz, 'soviet', 'enemy-base')
    placeAir(w, fighterRecord('soviet'), pz, 'soviet', 'enemy-fighter')
    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.confirmAirCombatNow()).toBe(true)
    expect(w.declareInterceptionNow()).toBe(true)
    w.airInputs.flakDie = 12
    w.airInputs.lossDie = 1
    expect(w.resolveFlakNow()).toBe(true)
    expect(w.airCargoLossPending).toMatchObject({ allowedT: 1, excessT: 1 })
    const rng = w.rng
    expect(w.resolveAirCargoNow()).toBe(false)
    expect(w.confirmAirCargoLossNow()).toBe(false)
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    expect(w.airUnitCargoManifest).toMatchObject([{ cargoId: 'unit:cargo', fate: 'aboard' }])
    expect(w.rng).toEqual(rng)
    w.toggleAirCargoLossPick('unit:cargo')
    expect(w.confirmAirCargoLossNow()).toBe(true)
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
    expect(w.deadPile.filter((unit) => unit.instanceId === 'cargo')).toHaveLength(1)
    expect(w.confirmAirCargoLossNow()).toBe(false)
    expect(w.resolveAirCargoNow()).toBe(true)
    expect(w.confirmAirMissionNow()).toBe(true)
    expect(w.completeAirReturnNow()).toBe(true)
    expect(w.deadPile.filter((unit) => unit.instanceId === 'cargo')).toHaveLength(1)
    expect(w.units.some((unit) => unit.instanceId === 'cargo')).toBe(false)
  })
})

describe('专规 2.2b：苏军补给空投不属「需计划空降」', () => {
  it('只载 SP 的 air_drop 不触发计划空降禁令', () => {
    setActivePinia(createPinia())
    const w = useWorkbenchStore()
    w.setActiveSide('soviet')
    w.setPhase('movement')
    w.setAirMissionKind('air_drop')
    w.airInputs.cargoSpT = 1
    w.airInputs.cargoUnitIds = []
    expect(w.redAirForceAdvisory).toMatchObject({ ok: true })
  })
})
