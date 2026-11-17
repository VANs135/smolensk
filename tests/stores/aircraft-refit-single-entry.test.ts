import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { UnitToken } from '@/render/token-layer'
import { facilityTokenViews } from '@/render/token-layer'
import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
  airBaseRecord,
  fighterRecord,
  label,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 15.1 整备**单入口**（用户 2026-11-17 走查）
 *
 * 实走问题：点基地会直接开基地动作会话，点格摊堆叠后又能从基地卡进整备 ⇒ 两条入口。
 * 收口口径：**点格展开堆叠 → 从基地卡进整备**；点基地只摊堆叠/选中，基地详情可看，
 * 但不再直接起整备会话；右键「整备飞机」并入同一入口（不成为第三条）。
 */
function refitStage() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  useHotseatStore().setViewerSide('axis')
  workbench.setAirActive(true)
  placeGround(workbench, airBaseRecord(1), CORE_HEX, 'axis', 'base-1')
  placeAir(workbench, fighterRecord('axis'), CORE_HEX, 'axis', 'air-0', 'inactive')
  workbench.setSupplyActive(true)
  workbench.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 0 }
  workbench.addSpDump()
  workbench.setPhase('aircraftRefit')
  return { workbench, mapView: useMapViewStore() }
}

describe('15.1 整备单入口', () => {
  it('★ 点基地只摊堆叠窗，不再直接起基地整备会话', () => {
    const s = refitStage()
    const [view] = facilityTokenViews(CORE_HEX, [
      { id: 'base-1', hex: CORE_HEX, side: 'axis', noncombatKind: 'air_base' } as UnitToken,
    ])
    s.mapView.onHexClick(CORE_HEX, { x: view!.centerX, y: view!.centerY }, { x: 10, y: 10 }, 1)
    expect(s.mapView.session?.kind ?? null).toBeNull()
    expect(s.mapView.unitActionUnitId).toBeNull()
    expect(s.mapView.popup?.variant).toBe('content')
    expect(s.mapView.stackSelection).toContain('base-1')
  })

  it('★ 右键不再单开「整备飞机」（整备动作只在堆叠窗基地卡）', () => {
    const s = refitStage()
    expect(s.workbench.refitStartBases.map((base) => base.id)).toEqual(['base-1'])
    expect(s.mapView.unitActionOptions('base-1').map((item) => item.key)).not.toContain('air.refit')
    s.mapView.onHexContext(CORE_HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(s.mapView.openContextAction('base-1', 'air.refit')).toBe(false)
  })
})
