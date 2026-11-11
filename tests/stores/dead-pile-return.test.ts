import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { actionGateOf, useWorkbenchStore, type ActionKey } from '@/stores'

import { CORE_HEX, groundRecord, label, placeGround } from '../flows/sop-harness'

/**
 * 死亡堆单位可回场（13.5 / 20.0）—— 用户 2026-11-10 报的实机 bug
 *
 * 修前：死亡堆窗口是只读 `<li>` 列表 ⇒ 玩家点不动、右键无菜单，也不知道"为什么不能回场"。
 * 修后：
 *   · 每条死亡堆持项可**点选**（选中即预选重建对象）；
 *   · **右键**弹出该单位的动作菜单（重建 13.5 / 永久移除 13.5c）；
 *   · 不可回场时菜单里带**可见原因**（哪个条款挡的：13.5 时机 / 13.5c 永久 / 13.5a 落点）；
 *   · 合法时给出「重建（13.5）」入口，付费与落账仍走唯一的 `rebuildUnitNow`。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function goToActionStep(store: ReturnType<typeof newStore>, key: ActionKey): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

const infDivRecord = (side: 'axis' | 'soviet') =>
  groundRecord(side, (record) => /Inf Div|Rifle Div/i.test(record.vassalName ?? ''))

const hqRecord = () => groundRecord('axis', (record) => record.specialized?.includes('hq') === true)

/** 摆一枚「已带损」的本方步兵师并送进死亡堆 */
function deadUnit(store: ReturnType<typeof newStore>, instanceId = 'dead-1'): void {
  const unit = placeGround(store, infDivRecord('axis'), CORE_HEX, 'axis', instanceId)
  unit.steps = unit.printedSteps - 1
  store.sendToDeadPileNow(instanceId)
  expect(store.deadPile.some((item) => item.instanceId === instanceId)).toBe(true)
}

function readyForRebuild(): ReturnType<typeof newStore> {
  const store = newStore()
  store.setActiveSide('axis')
  store.setTurn(2)
  store.setPhase('reinforcement')
  goToActionStep(store, 'rein.rebuild')
  return store
}

describe('死亡堆：可点选 / 可右键 / 可见原因（13.5 / 13.5a / 13.5c）', () => {
  it('点选一条持项 ⇒ 选中它并预选为重建对象；行键按类型自动映射', () => {
    const store = readyForRebuild()
    deadUnit(store)

    store.pickDeadPileUnitNow('dead-1')
    expect(store.deadPilePickId).toBe('dead-1')
    expect(store.rebuildPickUnitId).toBe('dead-1')
    // 2026-11-11：不再手点「采用建议」——能唯一确定就自动填行
    expect(store.rebuildSuggestedRow).not.toBeNull()
    expect(store.rebuildPickRow).toBe(store.rebuildSuggestedRow)

    // v7.1 §4.1：这一刻没有合法落点（无补员 / 无 HQ）⇒ 重建项**不出现**，只剩永久移除
    expect(store.deadPileActionsOf('dead-1').map((item) => item.key)).toEqual([
      'deadPile.removeForever',
    ])
  })

  it('13.5a：右键重建 → 点合法格落位；再点该单位撤回 ⇒ 回死亡堆并退回补员', () => {
    const store = readyForRebuild()
    deadUnit(store)
    store.setReplHoldingsNow({ pax: 10, eq: 0, ftr: 0, tac: 0 }, CORE_HEX)
    placeGround(store, hqRecord(), CORE_HEX, 'axis', 'hq-1')

    expect(store.beginDeadPileRebuildNow('dead-1')).toBe(true)
    expect(store.hexPickView?.candidates).toContainEqual(CORE_HEX)
    expect(store.pickHexFor(CORE_HEX)).toBe(true)
    expect(store.deadPile.some((item) => item.instanceId === 'dead-1')).toBe(false)
    const spent = store.replHoldings.pax
    expect(spent).toBeLessThan(10)

    // §1.1：本段内再点已重建的单位 ⇒ 收回并退点
    expect(store.withdrawRebuildNow('dead-1')).toBe(true)
    expect(store.deadPile.some((item) => item.instanceId === 'dead-1')).toBe(true)
    expect(store.replHoldings.pax).toBe(10)
    // 同一枚不能撤回两次
    expect(store.withdrawRebuildNow('dead-1')).toBe(false)
  })

  it('13.5a 第 2 项：图上打残右键重建，落点固定本格、不出高亮；撤回恢复原军力', () => {
    const store = readyForRebuild()
    placeGround(store, hqRecord(), CORE_HEX, 'axis', 'hq-1')
    store.setReplHoldingsNow({ pax: 10, eq: 10, ftr: 0, tac: 0 }, CORE_HEX)
    const unit = placeGround(store, infDivRecord('axis'), CORE_HEX, 'axis', 'hurt')
    unit.steps = 1

    expect(store.canRebuildOnMapNow('hurt')).toBe(true)
    expect(store.rebuildOnMapUnitNow('hurt')).toBe(true)
    expect(store.hexPickView).toBe(null)
    expect(unit.steps).toBeGreaterThan(1)
    expect(store.units.some((item) => item.instanceId === 'hurt')).toBe(true)

    expect(store.withdrawRebuildNow('hurt')).toBe(true)
    expect(store.units.find((item) => item.instanceId === 'hurt')?.steps).toBe(1)
    expect(store.deadPile.some((item) => item.instanceId === 'hurt')).toBe(false)
  })

  it('13.5a：没有合法落点（无战斗面 HQ）⇒ 重建项不出现（不置灰）', () => {
    const store = readyForRebuild()
    deadUnit(store)

    const keys = store.deadPileActionsOf('dead-1').map((item) => item.key)
    expect(keys).not.toContain('deadPile.rebuild')
    expect(keys).toContain('deadPile.removeForever')
    // 条件满足时同一入口才出现（顺序：重建 → 永久移除）
    store.setReplHoldingsNow({ pax: 10, eq: 0, ftr: 0, tac: 0 }, CORE_HEX)
    placeGround(store, hqRecord(), CORE_HEX, 'axis', 'hq-1')
    expect(store.deadPileActionsOf('dead-1').map((item) => item.key)).toEqual([
      'deadPile.rebuild',
      'deadPile.removeForever',
    ])
  })

  it('13.5c：AR 后有黄点（rebuildable=false）⇒ 永久不可重建，原因写明 13.5c', () => {
    const store = readyForRebuild()
    deadUnit(store)
    const dead = store.deadPile.find((item) => item.instanceId === 'dead-1')!
    expect('rebuildable' in dead).toBe(true)
    if ('rebuildable' in dead) dead.rebuildable = false

    expect(store.deadPileRebuildBlockedReason('dead-1')).toContain('13.5c')
  })

  it('13.5：不在增援段的「重建」环节 ⇒ 禁用并说明时机条款', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setTurn(2)
    store.setPhase('movement')
    goToActionStep(store, 'move.order')
    deadUnit(store)

    expect(store.deadPileRebuildBlockedReason('dead-1')).toContain('增援')
  })

  it('增援段 + 战斗面 HQ + 补员 ⇒ 可回场；付费与落账仍由 rebuildUnitNow 一次完成', () => {
    const hex: HexRef = CORE_HEX
    const store = readyForRebuild()
    store.setReplHoldingsNow({ pax: 10, eq: 0, ftr: 0, tac: 0 }, hex)
    placeGround(store, hqRecord(), hex, 'axis', 'hq-1')
    deadUnit(store)

    expect(store.deadPileRebuildBlockedReason('dead-1')).toBeNull()
    expect(
      store.rebuildUnitNow({
        unitId: 'dead-1',
        rebuildType: 'Infantry Div step',
        replHexText: label(hex),
      }),
    ).toBe(true)
    expect(store.deadPile.some((item) => item.instanceId === 'dead-1')).toBe(false)
    expect(store.units.some((item) => item.instanceId === 'dead-1')).toBe(true)
    // 4 军力师满血重建 = 8 Pax（13.5b：按 step 计费）
    expect(store.replHoldings.pax).toBe(2)
  })

  it('★ 面板守卫：死亡堆持项绑了点击 / 右键 / 菜单与重建入口（不再是只读 li）', () => {
    const source = readFileSync(
      new URL('../../src/components/containers/ContainersPanel.vue', import.meta.url),
      'utf8',
    )
    expect(source).toContain('pickDeadPileUnitNow(')
    expect(source).toContain('@contextmenu.prevent')
    expect(source).toContain('deadPileActionsOf(')
    expect(source).toContain('runDeadPileActionNow(')
    expect(source).toContain('runDeadPileAction(')
  })
})
