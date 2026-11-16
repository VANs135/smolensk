import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'

import { beforeEach, describe, expect, it } from 'vitest'

import { nextTick } from 'vue'

import type { HexRef } from '@/data'
import { actionGateOf, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, NEAR_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * C4（用户 2026-11-17 实走）：炮击结算后就地留结果行，再收窗
 *
 * 现场：确认支付后没有军力损失的炮击把整窗收掉，玩家在面板上看不到掷骰与 DG，
 * 结果只能去战报里翻。口径与 S1 一致：结算后就地显示完成态（掷骰 / 最终列 /
 * DG 或损失 / 扣 T），点「关闭」再收窗。
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

function defenderRecord() {
  return groundRecord('soviet', (record) => record.isCombat === true)
}

function enemyAirBaseRecord() {
  return groundRecord('soviet', (record) => record.noncombatKind === 'air_base')
}

/** 走到第 2 步并选好付款站 */
function setupToSupply(targetHex: HexRef, targetRecord = defenderRecord()) {
  const { workbench, mapView } = newStores()
  enterBarrageStep(workbench)
  const gun = placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
  const target = placeGround(workbench, targetRecord, targetHex, 'soviet', 'def-1')
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

describe('C4：无军力损失（设施 / 无事）炮击就地留结果行', () => {
  it('★ 确认支付 ⇒ 第 4 步「已结算」，结果行含掷骰与扣 T，再点关闭才收窗', () => {
    const { workbench, mapView } = setupToSupply(NEAR_HEX, enemyAirBaseRecord())
    workbench.barrageInputs.die = 4
    workbench.barrageInputs.halfDie = 6

    expect(mapView.confirmOpsBarrageSupply()).toBe(true)
    // 修前：`opsFlow` 直接置 null ⇒ 面板消失、无结果行
    expect(mapView.opsFlow?.step).toBe(4)
    const result = mapView.opsFlow?.result ?? ''
    expect(result).toContain('掷骰 4')
    expect(result).toContain('最终列')
    expect(result).toMatch(/扣 \d+ T/)
    // 会话步也指向「已结算」，面板据此渲染结果块
    expect(mapView.sessionStep?.id).toBe('ops:barrage:done')

    expect(mapView.finishOpsFlow()).toBeUndefined()
    expect(mapView.opsFlow).toBeNull()
  })
})

describe('C4：有军力损失炮击在受损确认后留结果行', () => {
  it('★ 选完受损单位 ⇒ 第 4 步结果行含 DG / 损失，再关闭收窗', () => {
    const { workbench, mapView, target } = setupToSupply(NEAR_HEX)
    workbench.barrageInputs.die = 12
    workbench.barrageInputs.halfDie = 6

    expect(mapView.confirmOpsBarrageSupply()).toBe(true)
    expect(mapView.opsFlow?.step).toBe(3)

    for (let guard = 0; guard < 6 && !workbench.barrageLossReady; guard += 1)
      workbench.addBarrageLossPoint(target.instanceId)
    expect(workbench.barrageLossReady).toBe(true)
    expect(mapView.confirmOpsBarrageLoss()).toBe(true)

    expect(mapView.opsFlow?.step).toBe(4)
    const result = mapView.opsFlow?.result ?? ''
    expect(result).toContain('掷骰 12')
    expect(result).toContain('最终列')
    expect(result).toMatch(/DG|损失/)
    expect(result).toMatch(/扣 \d+ T/)
    expect(mapView.sessionStep?.id).toBe('ops:barrage:done')

    mapView.finishOpsFlow()
    expect(mapView.opsFlow).toBeNull()
  })
})

describe('C4 源码守卫：面板有「已结算」结果块', () => {
  const panel = readFileSync('src/components/ops/OpsFlowPanel.vue', 'utf8')

  it('★ 结果块接在 `ops:barrage:done` 门上，展示 `flow.result` 并有「关闭」', () => {
    expect(panel).toContain('ops:barrage:done')
    expect(panel).toContain('flow.result')
    expect(panel).toContain('map.finishOpsFlow()')
    expect(panel).toContain('④ 已结算')
  })
})

describe('C4 步骤清单：第 4 步不再落回「受损单位」', () => {
  it('★ step 4 的事项 id 是 `ops:barrage:done`，不再复用 `ops:barrage:loss`', () => {
    const { workbench, mapView } = setupToSupply(NEAR_HEX, enemyAirBaseRecord())
    workbench.barrageInputs.die = 4
    workbench.barrageInputs.halfDie = 6
    expect(mapView.confirmOpsBarrageSupply()).toBe(true)
    expect(mapView.sessionStep?.id).not.toBe('ops:barrage:loss')
  })

  it('★ 结果行不跨环节残留：点「进入下一环节」换环节后，已结算的窗自动收掉', async () => {
    const { workbench, mapView } = setupToSupply(NEAR_HEX, enemyAirBaseRecord())
    workbench.barrageInputs.die = 4
    workbench.barrageInputs.halfDie = 6
    expect(mapView.confirmOpsBarrageSupply()).toBe(true)
    expect(mapView.opsFlow?.step).toBe(4)

    const index = workbench.playerSegmentSteps.findIndex((step) => step.id === 'combat.barrage')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(workbench.setSegmentStepIndex(index + 1)).toBe(true)
    await nextTick()
    expect(mapView.opsFlow).toBeNull()
  })
})
