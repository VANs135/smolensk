import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import {
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

import { CORE_HEX, NEAR_HEX } from '../flows/sop-harness'

/**
 * 2026-11-26：右键工程兵 → 地图高亮候选格 → 点格直接进付款
 *
 * 这条走**真实右键入口**（`openUnitContext` + `openContextAction`），不直接改 store 字段：
 * 玩家右键时已经选好施工者，窗口不应再列全部工程兵；点中高亮格后应把目标写回并打开付款选站。
 */
function stage() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  const mapView = useMapViewStore()
  const hq = unitChoices('axis').find((record) => (record.specialized ?? []).includes('hq'))
  if (hq === undefined) throw new Error('单位库里没有 HQ')
  const engineer = toConsoleUnit({
    record: hq,
    instanceId: 'hq-1',
    hex: CORE_HEX,
    side: 'axis',
  })
  engineer.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
  engineer.mpSpent = 0
  workbench.units.push(engineer)
  workbench.setPhase('movement')
  const index = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'movement.modeAndMovement',
  )
  expect(index).toBeGreaterThanOrEqual(0)
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
  workbench.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
  return { workbench, mapView }
}

describe('右键工程兵 → 高亮候选格 → 点格进付款', () => {
  it('★ 右键开窗后：不再列全部工程兵，地图直接铺出这一名工程兵的候选格', () => {
    const { workbench, mapView } = stage()
    expect(mapView.openUnitContext(CORE_HEX, 'hq-1', { x: 0, y: 0 })).toBe(true)
    expect(mapView.openContextAction('hq-1', 'move.construction.baseBuild')).toBe(true)
    expect(mapView.unitActionIntent?.only).toBe('airstrip')
    expect(workbench.airConstructionTask).toBe('baseBuild')
    expect(workbench.constructionInputs.engineerId).toBe('hq-1')
    // 候选由 store 的同一判据给；地图高亮层已经并进 `mapHighlightHexes`
    expect(workbench.airConstructionCandidateHexes('baseBuild')).toContainEqual(NEAR_HEX)
    expect(mapView.mapHighlightHexes).toContainEqual(NEAR_HEX)
    expect(mapView.mapHighlightHexes).toContainEqual(CORE_HEX)
  })

  it('★ 点候选格：写目标 + 自动打开付款选站；再点补给站即完成付款输入', () => {
    const { workbench, mapView } = stage()
    mapView.openUnitContext(CORE_HEX, 'hq-1', { x: 0, y: 0 })
    mapView.openContextAction('hq-1', 'move.construction.baseBuild')

    mapView.onHexClick(NEAR_HEX, { x: 0, y: 0 }, { x: 0, y: 0 }, 1)
    expect(workbench.constructionTargetHex).toEqual(NEAR_HEX)
    expect(workbench.constructionPayPick).toBe(true)

    mapView.onHexClick(CORE_HEX, { x: 0, y: 0 }, { x: 0, y: 0 }, 1)
    expect(workbench.constructionInputs.payDumpId).toBe('d1')
    expect(workbench.airConstructionMissing('baseBuild')).toBeNull()
    expect(workbench.buildAirBaseNow()).toBe(true)
    expect(workbench.airBaseLevelAt(NEAR_HEX)).toBe(1)
  })

  it('★ 目标格点定后：不再铺全候选，只留目标格；回窗里仍只有这一名施工者', () => {
    const { workbench, mapView } = stage()
    mapView.openUnitContext(CORE_HEX, 'hq-1', { x: 0, y: 0 })
    mapView.openContextAction('hq-1', 'move.construction.baseBuild')
    mapView.onHexClick(NEAR_HEX, { x: 0, y: 0 }, { x: 0, y: 0 }, 1)
    expect(mapView.mapHighlightHexes).toEqual([NEAR_HEX])
    expect(workbench.constructionInputs.engineerId).toBe('hq-1')
  })

  it('★ 16.0b 走同一条地图路径：点候选格 → 自动选付款站 → 修建工事', () => {
    const { workbench, mapView } = stage()
    mapView.openUnitContext(CORE_HEX, 'hq-1', { x: 0, y: 0 })
    expect(mapView.openContextAction('hq-1', 'move.hedgehog.build')).toBe(true)
    expect(mapView.unitActionIntent?.only).toBe('hedgehog')
    expect(workbench.hedgehogCandidateHexes('build')).toContainEqual(NEAR_HEX)

    mapView.onHexClick(NEAR_HEX, { x: 0, y: 0 }, { x: 0, y: 0 }, 1)
    expect(workbench.hedgehogTargetHex).toEqual(NEAR_HEX)
    expect(workbench.hedgehogPayPick).toBe(true)

    mapView.onHexClick(CORE_HEX, { x: 0, y: 0 }, { x: 0, y: 0 }, 1)
    expect(workbench.hedgehogInputs.payDumpId).toBe('d1')
    expect(workbench.buildHedgehogNow()).toBe(true)
    expect(workbench.hedgehogLevelOf(NEAR_HEX)).toBeGreaterThan(0)
  })
})
