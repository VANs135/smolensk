import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  bomberRecord,
  combatRecord,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 10.0c / 10.2：**空军轰炸的整体目标**（用户 2026-11-18）
 *
 * 原文：10.0d「玩家必须预先指定他的具体目标：空军基地或港口」；10.2 的空军轰炸沿用
 * 10.0 通用流程 ⇒ 表随目标：战斗单位走 10.0a，空军基地走 10.0c。
 *
 * 修前：空军轰炸流程从不设置 `barrageTargetKind` ⇒ 恒用残留/默认的「战斗单位」，
 * 基地格即使只有空军基地也炸不到设施（10.0c-A 的降级与逐机掷骰永远走不到）。
 */

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  useHotseatStore().setViewerSide('axis')
  workbench.setPhase('movement')
  const index = workbench.playerSegmentSteps.findIndex((step) => step.id === 'movement.barrage')
  expect(index, '移动阶段没有 movement.barrage 环节').toBeGreaterThanOrEqual(0)
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
  return { workbench, mapView: useMapViewStore() }
}

/** 本方基地 + 一架战术轰炸机 */
function plantBomber(workbench: ReturnType<typeof stores>['workbench']) {
  placeGround(workbench, airBaseRecord(), CORE_HEX, 'axis', 'own-base')
  return placeAir(workbench, bomberRecord('axis'), CORE_HEX, 'axis', 'bomber-1')
}

describe('10.0c / 10.2：空军轰炸可选「战斗单位 / 空军基地」', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
  })

  it('★ 敌格只有空军基地 ⇒ 整体目标取空军基地（10.0c）', () => {
    plantBomber(s.workbench)
    placeGround(s.workbench, airBaseRecord(), NEAR_HEX, 'soviet', 'enemy-base')

    expect(s.mapView.openOpsFlow('bombing', NEAR_HEX)).toBe(true)
    expect(s.workbench.barrageTargetKind).toBe('airBase')
    expect(s.workbench.barrageTargetKindChoicesAt).toEqual(['airBase'])
  })

  it('★ 敌格同时有战斗单位与空军基地 ⇒ 两个整体目标都可选（10.0d）', () => {
    plantBomber(s.workbench)
    placeGround(s.workbench, airBaseRecord(), NEAR_HEX, 'soviet', 'enemy-base')
    placeGround(s.workbench, combatRecord('soviet'), NEAR_HEX, 'soviet', 'enemy-combat')

    expect(s.mapView.openOpsFlow('bombing', NEAR_HEX)).toBe(true)
    // 10.0d 的默认取法与炮击同源：有敌战斗单位先打单位，但玩家可切到基地
    expect(s.workbench.barrageTargetKind).toBe('combatUnits')
    expect(s.workbench.barrageTargetKindChoicesAt).toEqual(['combatUnits', 'airBase'])
  })

  it('★ 选「空军基地」后结算 ⇒ 走对设施表，基地降级落盘（10.0c-A）', () => {
    const bomber = plantBomber(s.workbench)
    const base = placeGround(s.workbench, airBaseRecord(), NEAR_HEX, 'soviet', 'enemy-base')
    const levelBefore = base.noncombatLevel ?? 0

    expect(s.mapView.openOpsFlow('bombing', NEAR_HEX)).toBe(true)
    s.workbench.setBarrageTargetKind('airBase')
    s.workbench.toggleAirMissionUnit(bomber.instanceId)
    expect(s.mapView.advanceOpsFlow()).toBe(true)
    expect(s.workbench.airState?.step).toBe('resolveMission')

    expect(s.workbench.settleAirMissionNow()).toBe(true)
    expect(s.workbench.barrageState?.targetKind).toBe('airBase')
    expect(s.workbench.barrageState?.outcome?.table).toBe('barrage-vs-facility')
    expect(base.noncombatLevel ?? 0).toBeLessThanOrEqual(levelBefore)
    expect(base.noncombatLevel ?? 0).toBeGreaterThanOrEqual(1)
  })
})
