import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
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
  return store.resolveAirCargoNow()
}

/** 目的地格上 SP 账本条目（未装载的、手工/空运落下的） */
const dumpsAtDest = (store: ReturnType<typeof newStore>) =>
  store.spDumps.filter((dump) => dump.hex.col === DEST_HEX.col && dump.hex.row === DEST_HEX.row)

describe('14.9f / 15.0b-C：空运卸载限额（真实基地格）', () => {
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
    expect(store.airUnloadedTAt(DEST_HEX, 'axis')).toBe(3)
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
