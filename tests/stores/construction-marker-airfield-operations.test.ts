import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { constructionMarkerBadges } from '@/render/map-render'
import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
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
