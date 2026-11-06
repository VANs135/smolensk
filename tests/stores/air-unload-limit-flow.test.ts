import { createPinia, setActivePinia } from 'pinia'
import { createMemoryStorage } from '@/shared'
import { useGameSessionStore } from '@/stores'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor, hexDistance, sameHex } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * 14.9f / 15.0b-C / 15.2C：**空运卸载限额**在 store 这一侧的落地
 *
 * 条文：
 *   · **14.9f**「同一个空军基地在每个移动环节中，只能使用**空运**卸载 2T 乘上其**基地等级**的货物量。
 *     但是，如果货物超过此限额，**如果超出部分对应的运输机在目的地格变为非激活状态**，
 *     则可以卸载超额部分的货物。」
 *   · **15.0b-C**「（……**或者是空投或滑翔机行动，则无限制**）。**装载货物没有限制**。」
 *   · **15.2C**「（简易机场）每个移动环节中，它们的**卸载容量上限为 2T**。」
 *
 * ★ 修前病灶：空运的 SP 货物**只掷骰、不落盘**（`resolveAirCargoNow` 的注释写着"SP 货物只影响账本，
 *   由调用方按需处理"，但**没有任何调用方处理**）⇒ ① 空运来的 SP 进不了 SP 账本；② 限额常量
 *   `unloadTPerLevelPerPhase` 全库零消费 ⇒ 同一基地同一环节可无限收油。本文件把三件事钉住：
 *   ① 限额判定（含 14.9e-A 例外与空投例外）；② 允许的部分**真的落进 SP 账本**（12.1b）；
 *   ③ 台账**按移动环节**清零（换环节即重获额度）。
 *
 * 测法边界：本组用真实地图上的两枚基地格（起点/目的地）与真实运输机库记录；费率的细节（等级×2T）
 * 由 `tests/engine/air-mission.test.ts` 的 `planAirUnload` 单测覆盖，本组只问"落地了没有、落了多少"。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格（起点：基地 + 运输机） */
const CORE_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

/** 目的地：与起点相邻的一格（14.9e：空运可飞往任何友方空军基地） */
const DEST_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(CORE_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
    )
      return candidate
  }
  throw new Error('起点旁找不到图内格')
})()

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

function airBaseRecord() {
  const found = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
  if (found === undefined) throw new Error('单位库中没有空军基地算子')
  return found
}

function transportRecord(side: Side) {
  const found = aircraftChoices(side).find((record) => record.aircraftType === 'T')
  if (found === undefined) throw new Error(`${side} 飞机库中没有运输机`)
  return found
}

const withCapacity = (unit: ReturnType<typeof toConsoleAirUnit>, capacity: number) => {
  unit.transportCapacity = capacity
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 摆好「起点基地 + 目的地基地（等级 1）+ 一架运输机」，并返回目的地基地等级 */
function setup(store: ReturnType<typeof newStore>, transportId = 'tpt-1'): number {
  store.spDumps.push({ id: 'origin-stock', side: 'axis', hex: CORE_HEX, sp: 4, t: 0 })
  store.setAirActive(true)
  store.units.push(
    toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-2', hex: DEST_HEX, side: 'axis' }),
  )
  store.airUnits.push(
    withCapacity(
      toConsoleAirUnit({
        aircraft: transportRecord('axis'),
        instanceId: transportId,
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
      4,
    ),
  )
  const dest = store.airBases.find(
    (base) => base.hex.col === DEST_HEX.col && base.hex.row === DEST_HEX.row,
  )
  if (dest === undefined) throw new Error('目的地基地没进 airBases')
  return dest.level
}

/** 走完 14.2f 的 A→F：宣布（带 cargoT 的 SP 货物）→ 空战 → 拦截 → 防空 → 结算 */
function runMission(
  store: ReturnType<typeof newStore>,
  input: { kind: 'air_transport' | 'air_drop'; cargoT: number; transportId?: string },
): boolean {
  store.setAirMissionKind(input.kind)
  store.setAirTargetFromText(label(DEST_HEX))
  store.toggleAirMissionUnit(input.transportId ?? 'tpt-1')
  store.airInputs.cargoSpT = input.cargoT
  // 14.10b：空投**战斗单位**才需要计划；本组运的是 SP，故不填计划
  if (!store.beginAirMissionNow()) return false
  if (!store.confirmAirCombatNow()) return false
  if (!store.declareInterceptionNow()) return false
  store.airInputs.flakDie = 2 // E 防空：2 骰 2 ⇒ 不命中
  if (!store.resolveFlakNow()) return false
  store.airInputs.cargoDice = 12 // 表 17-4：2 骰 12 必成功
  if (!store.resolveAirCargoNow()) return false
  if (!store.confirmAirMissionNow()) return false
  if (!store.completeAirReturnNow()) return false
  store.clearAir()
  store.setAirActive(true)
  return true
}

/** 目的地格上 SP 账本条目（未装载的、手工/空运落下的） */
const dumpsAtDest = (store: ReturnType<typeof newStore>) =>
  store.spDumps.filter((dump) => dump.hex.col === DEST_HEX.col && dump.hex.row === DEST_HEX.row)

describe('14.9f / 15.0b-C：空运卸载限额（真实基地格）', () => {
  it('有留存货物时按逐机货单回各自返航基地，不提前退款', () => {
    const store = newStore()
    setup(store)
    setup2(store)
    store.airInputs.cargoByAircraft = [
      { aircraftId: 'tpt-1', cargoIds: ['sp:1'] },
      { aircraftId: 'tpt-2', cargoIds: ['sp:2'] },
    ]
    store.setAirMissionKind('air_transport')
    store.setAirTargetFromText(label(DEST_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.toggleAirMissionUnit('tpt-2')
    store.airInputs.cargoSpT = 2
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    store.airInputs.unloadCargoIds = []
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(store.confirmAirMissionNow()).toBe(true)
    store.airInputs.returnHexText['tpt-1'] = label(DEST_HEX)
    store.airInputs.returnHexText['tpt-2'] = label(CORE_HEX)
    expect(store.completeAirReturnNow()).toBe(true)
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(16)
    expect(store.airUnits.every((air) => air.missionsFlownThisPhase === 1)).toBe(true)
    expect(store.airUnits.find((air) => air.instanceId === 'tpt-1')!.hex).toEqual(DEST_HEX)
    expect(store.airUnits.find((air) => air.instanceId === 'tpt-2')!.hex).toEqual(CORE_HEX)
    expect(store.airUnloadedTAt(DEST_HEX, 'axis')).toBe(1)
    expect(store.airUnloadedTAt(CORE_HEX, 'axis')).toBe(1)
  })
  it('两架从不同基地起飞各装1T飞同一目标，任务成功且各回各基地（14.9e）', () => {
    const store = newStore()
    const alt = HEX_DIRECTIONS.map((direction) => neighbor(CORE_HEX, direction)).find(
      (candidate) =>
        isOnMap(candidate) &&
        mapLayers.hexes.some((hex) => hex.col === candidate.col && hex.row === candidate.row) &&
        !sameHex(candidate, DEST_HEX),
    )!
    store.spDumps.push(
      { id: 'stock-core', side: 'axis', hex: CORE_HEX, sp: 0, t: 2 },
      { id: 'stock-alt', side: 'axis', hex: alt, sp: 0, t: 2 },
    )
    store.setAirActive(true)
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-2', hex: DEST_HEX, side: 'axis' }),
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-alt', hex: alt, side: 'axis' }),
    )
    store.airUnits.push(
      withCapacity(
        toConsoleAirUnit({
          aircraft: transportRecord('axis'),
          instanceId: 'tpt-1',
          hex: CORE_HEX,
          side: 'axis',
          airStatus: 'active',
        }),
        0.5,
      ),
      withCapacity(
        toConsoleAirUnit({
          aircraft: transportRecord('axis'),
          instanceId: 'tpt-2',
          hex: alt,
          side: 'axis',
          airStatus: 'active',
        }),
        0.5,
      ),
    )
    store.setAirMissionKind('air_transport')
    store.setAirTargetFromText(label(DEST_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.toggleAirMissionUnit('tpt-2')
    store.airInputs.cargoSpT = 2
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    store.airInputs.cargoDice = 12
    store.airInputs.unloadCargoIds = ['sp:1', 'sp:2']
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(store.confirmAirMissionNow()).toBe(true)
    expect(store.completeAirReturnNow()).toBe(true)
    expect(store.airUnits.find((air) => air.instanceId === 'tpt-1')!.hex).toEqual(CORE_HEX)
    expect(store.airUnits.find((air) => air.instanceId === 'tpt-2')!.hex).toEqual(alt)
    expect(dumpsAtDest(store).reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(2)
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(4)
  })
  it('一架双程档留场、另一架正常返航，留存货各归其位（14.9e/14.9f）', () => {
    const store = newStore()
    setup(store)
    setup2(store)
    const target = mapLayers.hexes.find((hex) => hexDistance(CORE_HEX, hex) === 2)!
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'far-base', hex: target, side: 'axis' }),
    )
    store.airUnits[0]!.rangeHexes = 1
    store.airUnits[0]!.transportCapacity = 1 // A档：距离2，运力1T
    store.airUnits[1]!.rangeHexes = 4
    store.airUnits[1]!.transportCapacity = 1.5 // C档：距离2，运力3T
    store.airInputs.cargoByAircraft = [
      { aircraftId: 'tpt-1', cargoIds: ['sp:1'] },
      { aircraftId: 'tpt-2', cargoIds: ['sp:2', 'sp:3', 'sp:4'] },
    ]
    store.setAirMissionKind('air_transport')
    store.setAirTargetFromText(label(target))
    store.toggleAirMissionUnit('tpt-1')
    store.toggleAirMissionUnit('tpt-2')
    store.airInputs.cargoSpT = 4
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    store.airInputs.cargoDice = 12
    store.airInputs.unloadCargoIds = ['sp:2', 'sp:3']
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(store.airCargoUnloadReceipt?.deliveredT).toBe(2)
    expect(store.confirmAirMissionNow()).toBe(true)
    expect(store.completeAirReturnNow()).toBe(true)
    expect(sameHex(store.airUnits.find((air) => air.instanceId === 'tpt-1')!.hex, target)).toBe(
      true,
    )
    expect(sameHex(store.airUnits.find((air) => air.instanceId === 'tpt-2')!.hex, CORE_HEX)).toBe(
      true,
    )
    const at = (hex: HexRef) =>
      store.spDumps
        .filter((dump) => sameHex(dump.hex, hex))
        .reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)
    expect(at(target)).toBe(3) // 卸载2T + 留场机自载1T
    expect(at(CORE_HEX)).toBe(13) // 原库存12T + 正常返航机自载1T
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(16)
  })
  it('超限卸载后运输机必须留在目的地；修改草稿或返航输入不能抹掉义务', () => {
    const store = newStore()
    setup(store)
    store.setAirMissionKind('air_transport')
    store.setAirTargetFromText(label(DEST_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.airInputs.cargoSpT = 4
    store.airInputs.unloadOverLimitInactive = true
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(store.airCargoUnloadReceipt?.requiresDestinationStay).toBe(true)
    store.airInputs.unloadOverLimitInactive = false
    expect(store.confirmAirMissionNow()).toBe(true)
    store.airInputs.returnHexText['tpt-1'] = label(CORE_HEX)
    const rng = store.rng
    expect(store.completeAirReturnNow()).toBe(false)
    expect(store.airError?.reason).toBe('overLimitTransportMustStayAtTarget')
    expect(store.rng).toEqual(rng)
    expect(dumpsAtDest(store)[0]!.sp * 4 + dumpsAtDest(store)[0]!.t).toBe(4)
    store.airInputs.returnHexText['tpt-1'] = label(DEST_HEX)
    expect(store.completeAirReturnNow()).toBe(true)
    expect(store.airUnits[0]!.hex).toEqual(DEST_HEX)
    expect(store.airUnits[0]!.airStatus).toBe('inactive')
    expect(store.airUnits[0]!.missionsFlownThisPhase).toBe(1)
  })
  it('只有一架双程运输机，不能自动替其余运输机获得超限卸载例外', () => {
    const store = newStore()
    setup(store)
    setup2(store)
    const target = mapLayers.hexes.find((hex) => hexDistance(CORE_HEX, hex) === 2)!
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'far-base', hex: target, side: 'axis' }),
    )
    store.airUnits[0]!.rangeHexes = 1 // 距离2，A档。
    store.airUnits[1]!.rangeHexes = 4 // 距离2，C档。
    store.setAirMissionKind('air_transport')
    store.setAirTargetFromText(label(target))
    store.toggleAirMissionUnit('tpt-1')
    store.toggleAirMissionUnit('tpt-2')
    store.airInputs.cargoSpT = 4
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.airOverLimitAircraftInactive).toBe(false)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(store.airCargoUnloadReceipt?.deliveredT).toBe(2)
    expect(store.airCargoUnloadReceipt?.requiresDestinationStay).toBe(false)
  })
  it('载货任务中拒绝保存，返航后可保存，避免读档丢失在途SP', () => {
    const store = newStore()
    const game = useGameSessionStore()
    game.setSaveStorage(createMemoryStorage())
    game.startGame()
    store.setPhase('movement')
    store.setSegmentStepIndex(
      store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
    )
    setup(store)
    expect(game.saveNow()).toBe(true)
    store.setAirMissionKind('air_transport')
    store.setAirTargetFromText(label(DEST_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.airInputs.cargoSpT = 2
    expect(store.beginAirMissionNow()).toBe(true)
    expect(game.saveNow()).toBe(false)
    expect(game.saveError?.reason).toContain('空运SP仍在结算中')
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.voluntaryReturnNow(['tpt-1'])).toBe(true)
    expect(game.saveNow()).toBe(true)
  })
  it('14.9a：超运力宣布失败不扣库存；普通空运卸载不消耗空投骰', () => {
    const store = newStore()
    setup(store)
    store.setAirMissionKind('air_transport')
    store.setAirTargetFromText(label(DEST_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.airInputs.cargoSpT = 16
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.spDumps[0]).toMatchObject({ sp: 4, t: 0 })
    store.airInputs.cargoSpT = 2
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.spDumps[0]).toMatchObject({ sp: 3, t: 2 })
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    store.airInputs.cargoDice = null
    const rng = store.rng
    const count = store.drawCount
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(store.rng).toEqual(rng)
    expect(store.drawCount).toBe(count)
    const inventory = store.spDumps.map((dump) => ({ ...dump }))
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(store.spDumps).toEqual(inventory)
    expect(store.airSupplyManifest!.items.every((item) => item.fate === 'delivered')).toBe(true)
  })
  it('14.3d / 14.9：无空战时整组主动返航退回SP，不留下任务或多退一笔', () => {
    const store = newStore()
    setup(store)
    store.setAirMissionKind('air_transport')
    store.setAirTargetFromText(label(DEST_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.airInputs.cargoSpT = 2
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.voluntaryReturnNow(['tpt-1'])).toBe(true)
    expect(store.airState?.finished).toBe(true)
    expect(store.airSupplyManifest!.items.every((item) => item.fate === 'returned')).toBe(true)
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(16)
    expect(store.completeAirReturnNow()).toBe(false)
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(16)
  })
  it('14.9a：空库存拒绝，失败不扣账、不掷骰，也不创建任务', () => {
    const store = newStore()
    setup(store)
    store.spDumps = []
    const before = store.rng
    expect(runMission(store, { kind: 'air_transport', cargoT: 1 })).toBe(false)
    expect(store.airError?.reason).toBe('airSupplyStockInsufficient')
    expect(store.airState).toBeNull()
    expect(store.spDumps).toEqual([])
    expect(store.rng).toEqual(before)
  })
  it('14.9：装载从真实库存扣除；拒卸部分只退一次；地面总量守恒', () => {
    const store = newStore()
    setup(store)
    expect(runMission(store, { kind: 'air_transport', cargoT: 4 })).toBe(true)
    const total = () => store.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)
    expect(total()).toBe(16)
    expect(store.airSupplyManifest!.items.map((item) => item.fate)).toEqual([
      'delivered',
      'delivered',
      'returned',
      'returned',
    ])
    expect(dumpsAtDest(store).reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(2)
    expect(store.completeAirReturnNow()).toBe(false)
    expect(total()).toBe(16)
  })
  it('14.10d：空投失败的SP已从起点消耗，不在返航时复活', () => {
    const store = newStore()
    setup(store)
    store.setAirMissionKind('air_drop')
    store.setAirTargetFromText(label(DEST_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.airInputs.cargoSpT = 2
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(14)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    store.airInputs.cargoDice = 2
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(store.airSupplyManifest!.items.every((item) => item.fate === 'lost')).toBe(true)
    expect(store.confirmAirMissionNow()).toBe(true)
    expect(store.completeAirReturnNow()).toBe(true)
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp * 4 + dump.t, 0)).toBe(14)
  })
  it('★ 1 级基地 + 4T 货物 ⇒ 只卸 2T（等级×2T），且**落进 SP 账本**；被拒的 2T 如实报出', () => {
    const store = newStore()
    const level = setup(store)
    expect(level).toBe(1) // 自检：本作基地算子摆出来就是 1 级 ⇒ 上限 2T

    expect(runMission(store, { kind: 'air_transport', cargoT: 4 })).toBe(true)
    const dumps = dumpsAtDest(store)
    expect(dumps).toHaveLength(1)
    expect(dumps[0]).toMatchObject({ sp: 0, t: 2, side: 'axis' })
    expect(store.airUnloadedTAt(DEST_HEX, 'axis')).toBe(2)
    // 被拒的部分不能说成成功：日志里要有 14.9f 的说明与"不能卸载"
    expect(store.log.some((line) => line.text.includes('不能卸载'))).toBe(true)
  })

  it('★ 14.9f 的例外：勾选「超出部分由目的地变非激活的运输机承运」⇒ 4T 全部卸下', () => {
    const store = newStore()
    setup(store)
    store.airInputs.unloadOverLimitInactive = true

    expect(runMission(store, { kind: 'air_transport', cargoT: 4 })).toBe(true)
    expect(dumpsAtDest(store)[0]).toMatchObject({ t: 4 })
    expect(store.airUnloadedTAt(DEST_HEX, 'axis')).toBe(4)
  })

  it('★ 限额是**每格每移动环节**：同环节第二趟一件也卸不下；换环节后额度恢复', () => {
    const store = newStore()
    setup(store)
    setup2(store)
    expect(runMission(store, { kind: 'air_transport', cargoT: 2 })).toBe(true)
    expect(store.airUnloadedTAt(DEST_HEX, 'axis')).toBe(2)

    // 同一移动环节再来一趟（另一架运输机）⇒ 余额已用尽
    expect(runMission(store, { kind: 'air_transport', cargoT: 2, transportId: 'tpt-2' })).toBe(true)
    expect(store.airUnloadedTAt(DEST_HEX, 'axis')).toBe(2)
    expect(dumpsAtDest(store).reduce((sum, dump) => sum + dump.t, 0)).toBe(2)

    // 14.9f：「**每个移动环节**」⇒ 换环节即清零（`resetSegmentTransient`）
    store.setPhase('reaction')
    expect(store.airUnloadedTAt(DEST_HEX, 'axis')).toBe(0)
  })

  it('★ 15.0b-C：空投**不设上限**（同一格没有基地也能全卸）', () => {
    const store = newStore()
    setup(store)
    // 目的地留空（把基地删掉）⇒ 空运上限会是 0，空投不该受此限制
    store.units = store.units.filter((unit) => unit.instanceId !== 'base-2')

    expect(runMission(store, { kind: 'air_drop', cargoT: 3 })).toBe(true)
    const dumps = dumpsAtDest(store)
    expect(dumps).toHaveLength(1)
    expect(dumps[0]).toMatchObject({ t: 3 })
    expect(store.airUnloadedTAt(DEST_HEX, 'axis')).toBe(0) // 空投不占普通空运卸载额度（15.0b-C）。
  })
})

/** 再加一架运输机（同一环节的第二趟用） */
function setup2(store: ReturnType<typeof newStore>): void {
  store.airUnits.push(
    withCapacity(
      toConsoleAirUnit({
        aircraft: transportRecord('axis'),
        instanceId: 'tpt-2',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
      4,
    ),
  )
}
