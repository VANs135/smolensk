import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  fighterRecord,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 用户 2026-11-16：整备支付步点「补给站与另一座空军基地同格」的格子
 *
 * 关注的是**分派顺序**：`onHexClick` 里这类点击必须先归「15.1 付款选站」，
 * 不能因为同格有空军基地算子就走算子命中（开基地面板/切换整备目标）。
 * 支付步只在 `refitBase !== null && refitStage === 'pay'` 期间接管点击；
 * 退出付款步后立即恢复常规命中（由既有 `aircraft-refit-stage` 用例兜底）。
 */
function stage(): {
  workbench: ReturnType<typeof useWorkbenchStore>
  mapView: ReturnType<typeof useMapViewStore>
} {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  useHotseatStore().setViewerSide('axis')
  workbench.setAirActive(true)
  workbench.setPhase('aircraftRefit')
  // 整备目标 base-1：本格无补给站，靠 1 MP 外的补给站付款（12.3a ≤ 5 MP）
  placeGround(workbench, airBaseRecord(1), CORE_HEX, 'axis', 'base-1')
  placeAir(workbench, fighterRecord('axis'), CORE_HEX, 'axis', 'air-0', 'inactive')
  // 付款格：同格既有补给站，又有**另一座**空军基地（15.0a 允许异格各一座）
  placeGround(workbench, airBaseRecord(1), NEAR_HEX, 'axis', 'base-2')
  workbench.spDumps.push({ id: 'd1', hex: { ...NEAR_HEX }, side: 'axis', sp: 1, t: 0 })
  return { workbench, mapView: useMapViewStore() }
}

describe('15.1：整备支付步的点击优先于算子命中', () => {
  it('★ 点「补给站 + 另一座空军基地」同格 ⇒ 记为付款来源，不切换整备目标、不开基地动作', () => {
    const { workbench, mapView } = stage()
    expect(workbench.beginRefitNow('base-1')).toBe(true)
    workbench.toggleRefitAircraft('air-0')
    expect(workbench.confirmRefitSelectionNow()).toBe(true)
    expect(workbench.refitStage).toBe('pay')
    expect(workbench.refitPayDumps.map((dump) => dump.id)).toEqual(['d1'])

    mapView.onHexClick(NEAR_HEX, { x: 0, y: 0 }, { x: 0, y: 0 }, 1)

    // ① 这一击归付款选站
    expect(workbench.airInputs.refitDumpId).toBe('d1')
    // ② 整备目标没被同格基地抢走
    expect(workbench.refitBase?.id).toBe('base-1')
    expect(workbench.refitStage).toBe('pay')
    expect(mapView.unitActionUnitId).not.toBe('base-2')
    expect(mapView.session).toBeNull()
    expect(mapView.popup).toBeNull()

    // ③ 付款照常结算：只有 base-1 完成整备
    expect(workbench.confirmRefitPaymentNow()).toBe(true)
    expect(workbench.refitDoneBases.map((base) => base.id)).toEqual(['base-1'])
    expect(workbench.spDumps.find((dump) => dump.id === 'd1')).toMatchObject({ sp: 0, t: 3 })
  })

  it('★ 退出支付步后，同一格恢复常规命中（选格态不残留）', () => {
    const { workbench, mapView } = stage()
    expect(workbench.beginRefitNow('base-1')).toBe(true)
    workbench.toggleRefitAircraft('air-0')
    expect(workbench.confirmRefitSelectionNow()).toBe(true)
    workbench.cancelRefitNow()
    expect(workbench.refitBase).toBeNull()

    mapView.onHexClick(NEAR_HEX, { x: 0, y: 0 }, { x: 0, y: 0 }, 1)
    // 常规命中：该格会被摊开/出格子内容，但不会再改 refitDumpId
    expect(workbench.airInputs.refitDumpId).toBeNull()
    expect(workbench.refitBase).toBeNull()
    expect(workbench.spDumps.find((dump) => dump.id === 'd1')).toMatchObject({ sp: 1, t: 0 })
  })
})
