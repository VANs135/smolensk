import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 20.0d：吸收拆分单位**只在阶段末**（H 清理）出现
 *
 * 原文：「减损的多军力单位在任何阶段结束时，都必须吸收与之堆叠、且符合吸收规则的
 * 拆分单位……**只有在这种时机才能吸收拆分单位**。」
 *
 * 用户 2026-11-14 裁定 2：移动阶段不摆吸收入口；现在没有阶段末窗口就补在 H 清理段，
 * 而不是在移动中放一个早入口。
 */

const HEX: HexRef = { col: 36, row: 13 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setScenarioId('1')
  workbench.setActiveSide('axis')
  workbench.setPhase('movement')
  return { workbench, mapView: useMapViewStore() }
}

function infantryDivRecord() {
  return groundRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.classes?.combatClass === 'other' &&
      (record.steps?.total ?? 1) >= 2 &&
      record.specialized?.includes('breakdown') !== true,
  )
}

/** 在移动阶段（20.0a 开始移动）拆出一枚，供阶段末吸收 */
function splitOne(workbench: ReturnType<typeof useWorkbenchStore>) {
  const parent = placeGround(workbench, infantryDivRecord(), HEX, 'axis', 'p1')
  const record = workbench
    .breakdownRecordChoicesFor(parent.instanceId)
    .find((item) => (item.factors?.combat?.ar ?? 0) === parent.faces.combat.ar)
  expect(record, '需要一枚 AR 与母单位相同的拆分记录').toBeDefined()
  expect(workbench.createBreakdownNow(parent.instanceId, record!.id)).toBe(true)
  const breakdown = workbench.units.find(
    (unit) => unit.instanceId !== parent.instanceId && unit.specialized.includes('breakdown'),
  )
  expect(breakdown).toBeDefined()
  return { parent, breakdown: breakdown! }
}

beforeEach(() => setActivePinia(createPinia()))

describe('20.0d：吸收只在阶段末出现（移动阶段不摆）', () => {
  it('移动阶段：canAbsorb=false，absorbBreakdownNow 按 20.0d 拒，菜单不出吸收项', () => {
    const { workbench, mapView } = stores()
    const { parent, breakdown } = splitOne(workbench)

    expect(workbench.canAbsorbBreakdownNow(parent.instanceId)).toBe(false)
    expect(workbench.absorbBreakdownNow(parent.instanceId, breakdown.instanceId)).toBe(false)
    expect(workbench.log.some((line) => line.rule === '20.0d')).toBe(true)
    expect(workbench.units.some((unit) => unit.instanceId === breakdown.instanceId)).toBe(true)

    mapView.openUnitContext(HEX, parent.instanceId, { x: 0, y: 0 }, { fromStackWindow: true })
    const target = mapView.contextOptions.find((item) => item.id === parent.instanceId)
    const labels = (target?.actions ?? []).map((action) => action.label)
    expect(labels).not.toContain('吸收拆分单位')
  })

  it('H 清理段：canAbsorb=true，菜单出吸收项，吸收成功（母单位 +1 军力、拆分回池）', () => {
    const { workbench, mapView } = stores()
    const { parent, breakdown } = splitOne(workbench)
    const stepsBefore = parent.steps
    const poolBefore = workbench.breakdownPool.ax ?? 0

    workbench.setPhase('cleanUp')
    expect(workbench.canAbsorbBreakdownNow(parent.instanceId)).toBe(true)
    mapView.openUnitContext(HEX, parent.instanceId, { x: 0, y: 0 }, { fromStackWindow: true })
    const target = mapView.contextOptions.find((item) => item.id === parent.instanceId)
    expect((target?.actions ?? []).map((action) => action.label)).toContain('吸收拆分单位')
    expect(workbench.absorbBreakdownNow(parent.instanceId, breakdown.instanceId)).toBe(true)
    expect(parent.steps).toBe(stepsBefore + 1)
    expect(workbench.breakdownPool.ax).toBe(poolBefore + 1)
    expect(workbench.units.some((unit) => unit.instanceId === breakdown.instanceId)).toBe(false)
  })

  it('源码守卫：拆分面板的创建/吸收各自按 store 判据显示，不把吸收常驻在移动里', () => {
    const panel = readFileSync('src/components/game/CounterOrderPanel.vue', 'utf8')
    expect(panel).toContain('workbench.canCreateBreakdownNow(')
    expect(panel).toContain('workbench.canAbsorbBreakdownNow(')
  })
})
