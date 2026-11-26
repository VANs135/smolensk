import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { constructionMarkerBadges } from '@/render/map-render'
import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
  combatRecord,
  fighterRecord,
  groundRecord,
  label,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 专规 3.5：**建造标记的简易机场**在 3.5 明文限制之外，与普通空军基地同一套操作
 *
 * 3.5 只把三件事写死：一次性/免费放、不可移动、只有苏军战斗单位入格才被毁（不可重建）。
 * 其余能力（驻机名册、15.1 整备、14.x 任务、转场）都按 15.2 的简易机场口径走；
 * 本条钉住"能点开、能整备、不会被 15.2A 再叠一座设施"这三层。
 */
function markerAirstripStage() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  useHotseatStore().setViewerSide('axis')
  workbench.setAirActive(true)
  placeAir(workbench, fighterRecord('axis'), CORE_HEX, 'axis', 'air-0', 'inactive')
  workbench.constructionMarkerPieces.push({ id: 'm1', kind: 'airStrip', hex: CORE_HEX })
  workbench.setSupplyActive(true)
  workbench.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 0 }
  workbench.addSpDump()
  workbench.setPhase('aircraftRefit')
  return { workbench, mapView: useMapViewStore() }
}

/** 移动中的地面单位 + 一枚落在可达格上的建造标记（用于钉「移动落点优先」） */
function movementMarkerStage() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  useHotseatStore().setViewerSide('axis')
  workbench.setAirActive(true)
  placeAir(workbench, fighterRecord('axis'), CORE_HEX, 'axis', 'air-0', 'inactive')
  const unit = placeGround(workbench, combatRecord('axis'), CORE_HEX, 'axis', 'move-1')
  unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
  unit.mpSpent = 0
  unit.movementEnded = false
  workbench.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
  workbench.setPhase('movement')
  const index = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'movement.modeAndMovement',
  )
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
  workbench.selectedId = unit.instanceId
  expect(workbench.beginMoveFor([unit.instanceId])).toBe(true)
  return { workbench, mapView: useMapViewStore(), unit }
}

describe('专规 3.5：建造标记简易机场的基地操作', () => {
  it('★ 虚拟基地进入本方基地投影：有 id、有等级、有 15.1 整备入口', () => {
    const { workbench } = markerAirstripStage()
    const id = workbench.constructionMarkerAirBaseId('m1')
    expect(workbench.isConstructionMarkerAirBaseId(id)).toBe(true)

    const base = workbench.ownAirBases.find((item) => item.id === id)
    expect(base).toMatchObject({ id, hex: CORE_HEX, side: 'axis', isAirstrip: true, level: 0 })
    expect(workbench.refitStartBases.map((item) => item.id)).toContain(id)
    expect(workbench.airUnitsAt(CORE_HEX, 'axis').map((air) => air.instanceId)).toEqual(['air-0'])
  })

  it('★ 15.1 整备按简易机场容量工作（1T；不是只能看的特殊物件）', () => {
    const { workbench } = markerAirstripStage()
    const id = workbench.constructionMarkerAirBaseId('m1')
    expect(workbench.beginRefitNow(id)).toBe(true)
    expect(workbench.refitBaseNow(id)).toBe(true)
  })

  it('★ 点贴片就能打开空军基地面板（与普通基地同一 `air` 面板/名册）', () => {
    const { workbench, mapView } = markerAirstripStage()
    const badges = constructionMarkerBadges(workbench.constructionMarkerPieces)
    const badge = badges.find((item) => item.kind === 'airStrip')
    expect(badge).toBeDefined()
    mapView.onHexClick(CORE_HEX, badge!.center, badge!.center, 1)
    const id = workbench.constructionMarkerAirBaseId('m1')
    expect(mapView.unitActionUnitId).toBe(id)
    expect(mapView.unitActionFamily).toBe('air')
    expect(mapView.actionBase?.id).toBe(id)
  })

  it('★ 同格桥 + 机场：按完整贴片槽位命中，桥贴片不误开机场面板', () => {
    const stage = markerAirstripStage()
    stage.workbench.constructionMarkerPieces = [
      { id: 'bridge-1', kind: 'bridge', hex: CORE_HEX },
      ...stage.workbench.constructionMarkerPieces,
    ]
    const badges = constructionMarkerBadges(stage.workbench.constructionMarkerPieces)
    const airportBadge = badges.find((item) => item.kind === 'airStrip')
    const bridgeBadge = badges.find((item) => item.kind === 'bridge')
    expect(airportBadge).toBeDefined()
    expect(bridgeBadge).toBeDefined()
    expect(airportBadge!.center.x).not.toBe(bridgeBadge!.center.x)

    stage.mapView.onHexClick(CORE_HEX, airportBadge!.center, airportBadge!.center, 1)
    expect(stage.mapView.unitActionUnitId).toBe(stage.workbench.constructionMarkerAirBaseId('m1'))

    const second = markerAirstripStage()
    second.workbench.constructionMarkerPieces = [
      { id: 'bridge-1', kind: 'bridge', hex: CORE_HEX },
      ...second.workbench.constructionMarkerPieces,
    ]
    const bridge = constructionMarkerBadges(second.workbench.constructionMarkerPieces).find(
      (item) => item.kind === 'bridge',
    )
    expect(bridge).toBeDefined()
    second.mapView.onHexClick(CORE_HEX, bridge!.center, bridge!.center, 1)
    expect(second.mapView.unitActionUnitId).not.toBe(
      second.workbench.constructionMarkerAirBaseId('m1'),
    )
  })

  it('★ 敌方观察视角：标记机场贴片保持只读，不能打开本方操作面板', () => {
    const { workbench, mapView } = markerAirstripStage()
    useHotseatStore().setViewerSide('soviet')
    const badge = constructionMarkerBadges(workbench.constructionMarkerPieces).find(
      (item) => item.kind === 'airStrip',
    )
    expect(badge).toBeDefined()
    mapView.onHexClick(CORE_HEX, badge!.center, badge!.center, 1)
    expect(mapView.unitActionUnitId).toBeNull()
    expect(mapView.unitActionFamily).toBeNull()
  })

  it('★ 移动落点优先：点标记贴片仍执行移动，不被机场面板吞掉', () => {
    const { workbench, mapView, unit } = movementMarkerStage()
    const destination = workbench.groupReachable.hexes.find((node) => node.path.length === 2)
    expect(destination).toBeDefined()
    workbench.constructionMarkerPieces.push({
      id: 'm-move',
      kind: 'airStrip',
      hex: { ...destination!.hex },
    })
    const badge = constructionMarkerBadges(workbench.constructionMarkerPieces).find(
      (item) => item.kind === 'airStrip',
    )
    expect(badge).toBeDefined()

    mapView.onHexClick(destination!.hex, badge!.center, badge!.center, 1)
    expect(unit.hex).toEqual(destination!.hex)
    expect(workbench.moveInteraction?.steps).toHaveLength(1)
    expect(mapView.unitActionUnitId).toBeNull()
  })

  it('★ 3.5 限制仍在：不能在标记上再建 15.2A 设施（4.8 / 15.0a）', () => {
    const { workbench } = markerAirstripStage()
    workbench.constructionInputs = {
      hexText: label(CORE_HEX),
      engineerId: null,
      payDumpId: null,
    }
    expect(workbench.airConstructionMissing('baseBuild')).toContain('建造标记')
    expect(workbench.airConstructionMissing('airstripBuild')).toContain('建造标记')
  })

  it('★ 3.5「标准简易机场」：可支付 3T 升为 1 级基地，升格后标记本体撤掉', () => {
    const { workbench } = markerAirstripStage()
    const id = workbench.constructionMarkerAirBaseId('m1')
    const hq = groundRecord('axis', (item) => (item.specialized ?? []).includes('hq'))
    const engineer = placeGround(workbench, hq, CORE_HEX, 'axis', 'eng-1')
    engineer.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    engineer.mpSpent = 0
    engineer.movementEnded = false
    workbench.setPhase('movement')
    const index = workbench.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.modeAndMovement',
    )
    expect(workbench.setSegmentStepIndex(index)).toBe(true)
    workbench.constructionInputs = {
      hexText: label(CORE_HEX),
      engineerId: engineer.instanceId,
      payDumpId: workbench.spDumps[0]!.id,
    }
    expect(workbench.airConstructionMissing('airstripUpgrade', id)).toBeNull()
    expect(workbench.upgradableAirstripsFor(engineer.instanceId).map((base) => base.id)).toContain(
      id,
    )
    expect(workbench.upgradeAirstripNow(id)).toBe(true)

    // 15.2A：1 级基地算子落盘；3.5 的标记本体撤掉（不再重复画一座 0 级机场）
    expect(workbench.airBaseUnitAt(CORE_HEX)?.noncombatLevel).toBe(1)
    expect(workbench.airBaseLevelAt(CORE_HEX)).toBe(1)
    expect(workbench.constructionMarkerPieces.map((piece) => piece.id)).not.toContain('m1')
    expect(workbench.ownAirBases.map((base) => base.id)).not.toContain(id)
  })
})
