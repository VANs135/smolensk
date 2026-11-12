import { createPinia, setActivePinia } from 'pinia'

import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { actionGateOf, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, NEAR_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 炮击链路重做（用户 2026-11-12 口径）
 *
 * 钉住统一流程的四件事：
 *   ① 第 2 步「确认支付」后**自动**走完横移 / 掷骰 / 结算，不再停在分步块；
 *   ② 有军力损失时停在第 3 步，分配完才收束；
 *   ③ 第 3 步取消要退回已扣补给，且不写 10.0e-A/B 账本；
 *   ④ 目标是设施（敌空军基地）时走 10.0c 设施表，不被"只能打单位"挡住。
 *
 * 骰面固定：轴方炮兵印值 18–20 ⇒ 列 17–24；`die=12` 至少落在「1」或「1/2」，
 * 再固定 `halfDie=6`（≥4）⇒ 必得 1 点军力损失，从而稳定进入第 3 步（10.0a）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

function enterBarrageStep(workbench: ReturnType<typeof useWorkbenchStore>): void {
  workbench.setPhase('combat')
  const allowed = actionGateOf('barrage.declare')
    .where.filter((item) => item.phase === 'combat')
    .map((item) => item.segment)
  const index = workbench.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error('F 段没有允许 barrage.declare 的环节')
  workbench.setSegmentStepIndex(index)
}

function artilleryRecord() {
  return groundRecord(
    'axis',
    (record) =>
      (record.factors?.combat?.barrage ?? 0) > 0 && (record.factors?.combat?.range ?? 0) > 0,
  )
}

function rifleRecord() {
  return groundRecord('soviet', (record) => record.isCombat === true)
}

function enemyAirBaseRecord() {
  return groundRecord('soviet', (record) => record.noncombatKind === 'air_base')
}

/** 走到第 2 步并选好付款站（炮击统一流程） */
function setupToSupply(targetHex: HexRef) {
  const { workbench, mapView } = newStores()
  enterBarrageStep(workbench)
  const gun = placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
  const target = placeGround(workbench, rifleRecord(), targetHex, 'soviet', 'def-1')
  workbench.spDumps.push({ id: 'dump-1', hex: { ...CORE_HEX }, side: 'axis', sp: 20, t: 0 })

  expect(mapView.openOpsFlow('barrage', targetHex)).toBe(true)
  workbench.toggleBarrageUnit(gun.instanceId)
  expect(mapView.advanceOpsFlow()).toBe(true)
  expect(mapView.opsFlow?.step).toBe(2)
  workbench.toggleBarrageSupplyDump('dump-1')
  return { workbench, mapView, gun, target }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('炮击第 2 步：确认支付后自动结算（10.0 / 10.1b / 10.0c）', () => {
  it('★ 点站支付 → 自动横移+掷骰；有伤害则列受损单位，选完收束', () => {
    const { workbench, mapView, target } = setupToSupply(NEAR_HEX)
    const spBefore = workbench.spDumps.find((dump) => dump.id === 'dump-1')!.sp
    workbench.barrageInputs.die = 12
    workbench.barrageInputs.halfDie = 6

    expect(mapView.confirmOpsBarrageSupply()).toBe(true)
    // 补给已实扣（10.1b）
    expect(workbench.spDumps.find((dump) => dump.id === 'dump-1')!.sp).toBeLessThan(spBefore)
    // 横移与掷骰已自动走完，停在第 3 步等选受损单位
    expect(mapView.opsFlow?.step).toBe(3)
    expect(workbench.barrageLossRequired).toBeGreaterThan(0)

    for (let guard = 0; guard < 6 && !workbench.barrageLossReady; guard += 1)
      workbench.addBarrageLossPoint(target.instanceId)
    expect(workbench.barrageLossReady).toBe(true)
    expect(mapView.confirmOpsBarrageLoss()).toBe(true)

    expect(workbench.barrageState?.finished).toBe(true)
    expect(mapView.opsFlow).toBeNull()
    expect(workbench.barragePhaseLedger.hexes).toEqual([`${NEAR_HEX.col}.${NEAR_HEX.row}`])
    expect(workbench.barragePhaseLedger.unitIds).toEqual(['art-1'])
  })

  it('★ 第 3 步取消 ⇒ 已扣补给退回，账本不记这一场', () => {
    const { workbench, mapView } = setupToSupply(NEAR_HEX)
    const spBefore = workbench.spDumps.find((dump) => dump.id === 'dump-1')!.sp
    workbench.barrageInputs.die = 12
    workbench.barrageInputs.halfDie = 6
    expect(mapView.confirmOpsBarrageSupply()).toBe(true)
    expect(mapView.opsFlow?.step).toBe(3)

    expect(mapView.cancelOpsFlow()).toBe(true)
    expect(workbench.spDumps.find((dump) => dump.id === 'dump-1')!.sp).toBe(spBefore)
    expect(workbench.barrageState).toBeNull()
    expect(workbench.barragePhaseLedger).toEqual({ hexes: [], unitIds: [] })
    expect(mapView.opsFlow).toBeNull()
  })

  it('★ 目标为敌方空军基地 ⇒ 走 10.0c 设施表，炮击合法', () => {
    const { workbench, mapView } = newStores()
    enterBarrageStep(workbench)
    const gun = placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
    placeGround(workbench, enemyAirBaseRecord(), NEAR_HEX, 'soviet', 'base-1')
    workbench.spDumps.push({ id: 'dump-1', hex: { ...CORE_HEX }, side: 'axis', sp: 20, t: 0 })

    expect(mapView.openOpsFlow('barrage', NEAR_HEX)).toBe(true)
    // 无敌方战斗单位 ⇒ 自动宣布整体目标为空军基地（10.0c）
    expect(workbench.barrageTargetKind).toBe('airBase')
    workbench.toggleBarrageUnit(gun.instanceId)
    expect(mapView.advanceOpsFlow()).toBe(true)
    workbench.toggleBarrageSupplyDump('dump-1')
    workbench.barrageInputs.die = 4
    expect(mapView.confirmOpsBarrageSupply()).toBe(true)

    expect(workbench.barrageState?.targetKind).toBe('airBase')
    expect(workbench.barrageState?.finished).toBe(true)
    expect(workbench.barrageState?.outcome?.table).toBe('barrage-vs-facility')
    expect(mapView.opsFlow).toBeNull()
  })

  it('★ 重开一场会清掉上一场的选子与付款来源（不残留）', () => {
    const { workbench, mapView } = newStores()
    enterBarrageStep(workbench)
    const gun = placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
    placeGround(workbench, rifleRecord(), NEAR_HEX, 'soviet', 'def-1')
    workbench.spDumps.push({ id: 'dump-1', hex: { ...CORE_HEX }, side: 'axis', sp: 20, t: 0 })

    expect(mapView.openOpsFlow('barrage', NEAR_HEX)).toBe(true)
    workbench.toggleBarrageUnit(gun.instanceId)
    workbench.toggleBarrageSupplyDump('dump-1')
    expect(workbench.barrageUnitIds).toEqual([gun.instanceId])
    expect(workbench.barrageSupplyDumpId).toBe('dump-1')

    // 重开同一目标（新一场入口）：旧选子 / 付款来源必须清零
    expect(mapView.openOpsFlow('barrage', NEAR_HEX)).toBe(true)
    expect(workbench.barrageUnitIds).toEqual([])
    expect(workbench.barrageSupplyDumpId).toBeNull()
  })
})
