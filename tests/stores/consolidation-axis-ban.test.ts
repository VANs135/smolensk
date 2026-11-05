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
 * 专规 3.3d：**轴心国多单位编队不得整编**（13.9-1 / 13.9-4）的 store 行为
 *
 * ## 修正记录（2026-11-05，以规则书为准）
 *   · 原文（`Smolensk_Rules_v1.1.txt:396-398` / skill `ch03-axis-special-rules.md`）：
 *     「**Axis multi-unit formations** cannot make use of Consolidation (OCS 13.9).」
 *     —— 限定语是**多单位编队**，不是"所有轴方单位"。
 *   · 修前实现（`workbench.ts` 的 `axisConsolidationRefused`）把登记库
 *     `axis_special.no_consolidation: true` 当无限定布尔：含 axis 即拒，并误标"专规 3.2"。
 *   · 现口径：仅当参与整编的算子带**编队番号**（`formationId !== null`）才拒；
 *     轴方独立单位与**飞机**（不属多单位编队）不受本条限制（13.9-4 的"任何阶段"照常）。
 *
 * 判据挂**两处**（动作方是轴方 / 被合并的算子属轴方），故轴方编队地面用例钉住拒绝半边；
 * 轴方飞机与苏方用例钉住"不误伤"半边。拒绝时**账本一字未动**。
 *
 * ## 测法边界（如实交代）
 *   · 用**真实地图与真实单位库/飞机库**，不造数；只断言"禁条生效/不生效 + 状态未变"，
 *     不断言 13.9 引擎的内部判据（那些在 `tests/engine/` 的合并用例里）。
 *   · `units-axis.json` 里**没有**"带编队番号且多军力"的地面单位（`formation != null` 的 125 条
 *     全是单军力；29 个 Inf Div 虽多军力但无编队）⇒ 3.3d 的**拒绝**分支没有真实素材。
 *     为此拒绝用例只给同一枚真实 Inf Div 记录**贴上编队番号**（只改 `formation` 标签，
 *     数值仍来自单位库），并在此注明这是为覆盖闸门而做的标签化，不是造数。
 *   · **不覆盖界面**：本仓库没有组件渲染测试；面板按钮禁用态由源码守卫
 *     （`tests/engine/loss-allocation-freedom.test.ts` 的 3.3d 用例）盯着"两处共用一处判据"。
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
 * `requireAction`（B7 闸门表）**先于**编队判据 ⇒ 不走到该环节，测到的会是"段不对"而不是 3.3d。
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

const hasRuleLog = (store: ReturnType<typeof newStore>): boolean =>
  store.log.some((entry) => (entry.text ?? '').includes('专规 3.3d'))

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('专规 3.3d：轴方多单位编队不得整编（13.9-1 / 13.9-4）', () => {
  it('★ 13.9-1：轴方**步兵师**（无编队番号）可以合并 —— 3.3d 只禁多单位编队', () => {
    const store = newStore()
    armRebuildStep(store)
    const record = multiStepRecord('axis')
    const keep = toConsoleUnit({ record, instanceId: 'k0', hex: CORE_HEX, side: 'axis' })
    const remove = toConsoleUnit({ record, instanceId: 'r0', hex: CORE_HEX, side: 'axis' })
    store.units.push(keep, remove)
    keep.steps = 3
    remove.steps = 1

    expect(store.activeSide).toBe('axis')
    expect(store.consolidateUnitsNow('k0', 'r0')).toBe(true)
    expect(hasRuleLog(store)).toBe(false)
    expect(keep.steps).toBe(4)
    expect(store.units.some((item) => item.instanceId === 'r0')).toBe(false)
    expect(store.lastConsolidation?.rule).toBe('13.9')
  })

  it('★ 13.9-1：参与算子带编队番号 ⇒ 拒，且账本一字未动（标签化用例，见文件头）', () => {
    const store = newStore()
    armRebuildStep(store)
    const record = multiStepRecord('axis')
    const keep = toConsoleUnit({ record, instanceId: 'k1', hex: CORE_HEX, side: 'axis' })
    const remove = toConsoleUnit({ record, instanceId: 'r1', hex: CORE_HEX, side: 'axis' })
    // 数据里没有"带编队且多军力"的轴方地面单位；这里只贴编队标签以覆盖闸门
    keep.formation = 'Pz-Gr Div'
    remove.formation = 'Pz-Gr Div'
    store.units.push(keep, remove)
    keep.steps = 2
    remove.steps = 1
    const before = { keep: keep.steps, remove: remove.steps, count: store.units.length }

    expect(store.activeSide).toBe('axis')
    expect(store.consolidateUnitsNow('k1', 'r1')).toBe(false)
    expect(hasRuleLog(store)).toBe(true)
    // "未改动任何账本"：两个算子都还在、军力不动、也不留"上一次合并"的记录
    expect(store.units.length).toBe(before.count)
    expect(keep.steps).toBe(before.keep)
    expect(remove.steps).toBe(before.remove)
    expect(store.lastConsolidation).toBe(null)
  })

  it('★ 13.9-4：轴方两架同类减损飞机 ⇒ **可以**合并（飞机不属多单位编队，3.3d 不禁）', () => {
    const store = newStore()
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
    expect(hasRuleLog(store)).toBe(false)
    expect(store.airUnits.length).toBe(1)
    expect(keep.steps).toBe(2)
    expect(store.lastConsolidation?.rule).toBe('13.9')
  })

  it('★ 同一形状换成苏方 ⇒ 不命中 3.3d，飞机真的合并成功（判据是编队而非调用形状）', () => {
    const store = newStore()
    const record = fighterRecord('soviet')
    const keep = toConsoleAirUnit({
      aircraft: record,
      instanceId: 'air-k2',
      hex: CORE_HEX,
      side: 'soviet',
      airStatus: 'inactive',
    })
    const remove = toConsoleAirUnit({
      aircraft: record,
      instanceId: 'air-r2',
      hex: CORE_HEX,
      side: 'soviet',
      airStatus: 'inactive',
    })
    store.airUnits.push(keep, remove)
    keep.steps = 1
    remove.steps = 1
    store.setActiveSide('soviet')
    expect(store.consolidateAircraftNow('air-k2', 'air-r2')).toBe(true)
    expect(hasRuleLog(store)).toBe(false)
    expect(store.airUnits.length).toBe(1)
    expect(keep.steps).toBe(2)
  })
})
