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
 * 待审批⑤：专规 3.3d **轴心国多单位编队不得整编**（13.9-1 / 13.9-4）
 *
 * ## 状态：`describe.skip` —— 修前失败用例留待审批，**不改语义**
 *
 * 原文（`Smolensk_Rules_v1.1.txt:396-398` / `ch03-axis-special-rules.md`）：
 * 「**Axis multi-unit formations** cannot make use of Consolidation (OCS 13.9).」
 * —— 限定语是**多单位编队**。现实现仍为"含 axis 即拒"（登记库 `axis_special.no_consolidation`
 * 记成无限定布尔），并误标"专规 3.2"。是否按原文收窄，见 `docs/2026-11-05-待审批事项汇总.md` ⑤。
 *
 * 复用 `consolidation-axis-ban.test.ts` 的夹具；启用 `describe.skip` 前请先拿到审批结论，
 * 再把判据改为 `keep/remove.formation`（地面）并让飞机不过闸。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

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

function multiStepRecord(side: 'axis' | 'soviet') {
  const found =
    side === 'axis'
      ? unitChoices('axis').find((record) => /Inf Div/i.test(record.vassalName ?? ''))
      : unitChoices('soviet').find((record) => /Tk Div|Rifle Div/i.test(record.vassalName ?? ''))
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

function fighterRecord(side: 'axis' | 'soviet') {
  const found = aircraftChoices(side).find((record) => record.aircraftType === 'F')
  if (found === undefined) throw new Error(`${side} 飞机库中没有战斗机`)
  return found
}

function armRebuildStep(store: ReturnType<typeof newStore>): void {
  store.setPhase('reinforcement')
  const allowed = actionGateOf('rein.rebuild')
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error('B 段没有允许 rein.rebuild 的环节')
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

const has33dLog = (store: ReturnType<typeof newStore>): boolean =>
  store.log.some((entry) => (entry.text ?? '').includes('专规 3.3d'))

beforeEach(() => {
  setActivePinia(createPinia())
})

describe.skip('待审批⑤：3.3d 收窄后的期望（审批后启用）', () => {
  it('轴方 Inf Div（无编队、多军力）可整编', () => {
    const store = newStore()
    armRebuildStep(store)
    const record = multiStepRecord('axis')
    const keep = toConsoleUnit({ record, instanceId: 'k0', hex: CORE_HEX, side: 'axis' })
    const remove = toConsoleUnit({ record, instanceId: 'r0', hex: CORE_HEX, side: 'axis' })
    store.units.push(keep, remove)
    keep.steps = 3
    remove.steps = 1
    expect(store.consolidateUnitsNow('k0', 'r0')).toBe(true)
    expect(keep.steps).toBe(4)
  })

  it('带编队番号的轴方单位整编仍拒，规则号 3.3d', () => {
    const store = newStore()
    armRebuildStep(store)
    const record = multiStepRecord('axis')
    const keep = toConsoleUnit({ record, instanceId: 'k1', hex: CORE_HEX, side: 'axis' })
    const remove = toConsoleUnit({ record, instanceId: 'r1', hex: CORE_HEX, side: 'axis' })
    keep.formation = 'Pz-Gr Div'
    remove.formation = 'Pz-Gr Div'
    store.units.push(keep, remove)
    keep.steps = 2
    remove.steps = 1
    expect(store.consolidateUnitsNow('k1', 'r1')).toBe(false)
    expect(has33dLog(store)).toBe(true)
  })

  it('轴方飞机可整编（不属多单位编队）', () => {
    const store = newStore()
    const record = fighterRecord('axis')
    const keep = toConsoleAirUnit({
      aircraft: record,
      instanceId: 'ak',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'inactive',
    })
    const remove = toConsoleAirUnit({
      aircraft: record,
      instanceId: 'ar',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'inactive',
    })
    store.airUnits.push(keep, remove)
    keep.steps = 1
    remove.steps = 1
    expect(store.consolidateAircraftNow('ak', 'ar')).toBe(true)
    expect(keep.steps).toBe(2)
  })
})
