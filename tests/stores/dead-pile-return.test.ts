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
  it('点选一条持项 ⇒ 选中它并预选为重建对象；行键保持空（仍由玩家点）', () => {
    const store = readyForRebuild()
    deadUnit(store)

    store.pickDeadPileUnitNow('dead-1')
    expect(store.deadPilePickId).toBe('dead-1')
    expect(store.rebuildPickUnitId).toBe('dead-1')
    expect(store.rebuildPickRow).toBe('')

    // 右键菜单：两条动作，顺序固定（重建 → 永久移除）
    expect(store.deadPileActionsOf('dead-1').map((item) => item.key)).toEqual([
      'deadPile.rebuild',
      'deadPile.removeForever',
    ])
  })

  it('13.5a：没有合法落点（无战斗面 HQ）⇒ 重建项禁用并说明是落点条款挡的', () => {
    const store = readyForRebuild()
    deadUnit(store)

    const rebuild = store
      .deadPileActionsOf('dead-1')
      .find((item) => item.key === 'deadPile.rebuild')!
    expect(rebuild.disabledReason).toContain('13.5a')
    expect(rebuild.disabledReason).toContain('HQ')
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
    expect(source).toContain('deadPileRebuildBlockedReason(')
    expect(source).toContain('workbench.rebuildUnitNow({')
  })
})
