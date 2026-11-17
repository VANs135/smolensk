import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
  airBaseRecord,
  combatRecord,
  fighterRecord,
  label,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 整备段不得投地面移动范围（用户 2026-11-17 走查）
 *
 * 实走问题：A 段点格展开堆叠时，地图仍画地面单位的可走格。
 * 修前 `overlay.reachable` 无条件投影 `groupReachable`；只要待开拔集/预览还带着，
 * 非移动段也会画出来。现在只在移动语境（移动步或未结束的移动交互）投影。
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

describe('整备段不投地面可走格', () => {
  it('★ 待开拔集还在时，overlay.reachable 仍为空', () => {
    const s = refitStage()
    const inf = placeGround(s.workbench, combatRecord('axis'), CORE_HEX, 'axis', 'inf-1')
    // 模拟移动段残留的待开拔集（修前 overlay 会照它把可走格画出来）
    s.workbench.movePick = { hex: CORE_HEX, ids: [inf.instanceId] }
    // 用户 2026-11-18：整备段**一律不投**，引擎的 groupReachable 与覆盖层同一闸门
    expect(s.workbench.groupReachable.hexes).toEqual([])
    expect(s.mapView.overlay.reachable).toEqual([])
  })
})
