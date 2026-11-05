import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * 专规 3.3d：**轴心国多单位编队不得整编**（13.9-1 / 13.9-4）
 *
 * 原文（`Smolensk_Rules_v1.1.txt:396-398`）：
 * 「**Axis multi-unit formations** cannot make use of Consolidation (OCS 13.9).」
 * 限定语是**多单位编队**，不是"一切轴方单位"（2026-11-05 用户裁定收窄；原误标 3.2 已更正）。
 *
 * 判据挂**两处**（动作方是轴方 / 被合并的算子属轴方），且至少一枚带编队番号才拒。
 * 本文件三组：轴方多单位编队被拒且账本一字未动；轴方飞机允许（不属编队）；
 * 同样形状换苏方不再命中该条。苏方真的合并成功（13.9-1 军力相加）由
 * `tests/stores/reinforcement-flow.test.ts` 覆盖。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格：合并要求同格，这里避开地图形状对邻格的干扰 */
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

/** 13.9-1 的多军力地面单位（合并表行 `Infantry Div step` 那种两/三军力师） */
function multiStepRecord(side: 'axis' | 'soviet') {
  const found =
    side === 'axis'
      ? unitChoices('axis').find((record) => /Inf Div/i.test(record.vassalName ?? ''))
      : unitChoices('soviet').find((record) => /Tk Div|Rifle Div/i.test(record.vassalName ?? ''))
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/** 14.1：战斗机（13.9-4 合并的是同类同值的减损飞机） */
function fighterRecord(side: 'axis' | 'soviet') {
  const found = aircraftChoices(side).find((record) => record.aircraftType === 'F')
  if (found === undefined) throw new Error(`${side} 飞机库中没有战斗机`)
  return found
}

/**
 * 把 store 放到 B 段里允许「合并整编」的环节
 *
 * `requireAction`（B7 闸门表）**先于**阵营判据 ⇒ 不走到该环节，测到的会是"段不对"而不是专规 3.2。
 */
function armRebuildStep(store: ReturnType<typeof newStore>): void {
  store.setPhase('reinforcement')
  const allowed = actionGateOf('rein.rebuild')
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error('B 段没有允许 rein.rebuild 的环节')
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

const hasAxisBanLog = (store: ReturnType<typeof newStore>): boolean =>
  store.log.some((entry) => (entry.text ?? '').includes('轴心国多单位编队不得整编'))

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('专规 3.3d：轴心国多单位编队不得整编（13.9-1 / 13.9-4）', () => {
  it('★ 13.9-1：轴方合并两个带编队番号的多军力单位 ⇒ 拒，且账本一字未动', () => {
    const store = newStore()
    armRebuildStep(store)
    const record = multiStepRecord('axis')
    const keep = toConsoleUnit({ record, instanceId: 'k1', hex: CORE_HEX, side: 'axis' })
    const remove = toConsoleUnit({ record, instanceId: 'r1', hex: CORE_HEX, side: 'axis' })
    // 3.3d 的限定语：多单位编队。用真实编队番号让两枚都属编队
    keep.formation = 'Pz-Gr Div'
    remove.formation = 'Pz-Gr Div'
    store.units.push(keep, remove)
    keep.steps = 2
    remove.steps = 1
    const before = { keep: keep.steps, remove: remove.steps, count: store.units.length }

    expect(store.activeSide).toBe('axis')
    expect(store.consolidateUnitsNow('k1', 'r1')).toBe(false)
    expect(hasAxisBanLog(store)).toBe(true)
    // "未改动任何账本"：两个算子都还在、军力不动、也不留"上一次合并"的记录
    expect(store.units.length).toBe(before.count)
    expect(keep.steps).toBe(before.keep)
    expect(remove.steps).toBe(before.remove)
    expect(store.lastConsolidation).toBe(null)
  })

  it('★ 13.9-4：轴方合并两架同类减损飞机 ⇒ 允许（飞机不属多单位编队）', () => {
    const store = newStore()
    // 13.9-4 不限阶段：故意停在默认阶段（连 B 段都不进），证明放行不是段闸门漏判
    const record = fighterRecord('axis')
    const keep = toConsoleAirUnit({
      aircraft: record,
      instanceId: 'air-k',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'inactive',
    })
    const remove = toConsoleAirUnit({
      aircraft: record,
      instanceId: 'air-r',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'inactive',
    })
    store.airUnits.push(keep, remove)
    keep.steps = 1
    remove.steps = 1

    expect(store.consolidateAircraftNow('air-k', 'air-r')).toBe(true)
    expect(hasAxisBanLog(store)).toBe(false)
    expect(store.airUnits.length).toBe(1)
    expect(keep.steps).toBe(2)
  })

  it('★ 同一形状换成苏方 ⇒ 不再命中专规 3.3d（判据是阵营不是调用形状）', () => {
    const store = newStore()
    const record = fighterRecord('soviet')
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: record,
        instanceId: 'air-k2',
        hex: CORE_HEX,
        side: 'soviet',
        airStatus: 'inactive',
      }),
      toConsoleAirUnit({
        aircraft: record,
        instanceId: 'air-r2',
        hex: CORE_HEX,
        side: 'soviet',
        airStatus: 'inactive',
      }),
    )
    store.setActiveSide('soviet')
    store.consolidateAircraftNow('air-k2', 'air-r2')
    expect(hasAxisBanLog(store)).toBe(false)
  })
})
