import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { actionGateOf, useMapViewStore, useWorkbenchStore, type ActionKey } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 13.5 重建：**盒贴图点选即开选格**（用户 2026-11-18）
 *
 * 要求：「死亡堆里选中一个单位后，地图上直接高亮该单位所有合法放置格；玩家点其中一个格就完成
 * 放置，不需要再走弹窗确认或二次点选。」
 *
 * 合法格不另写判据：走的仍是 `rebuildLegalHexes`（13.5a 既有闸门），点格由 `pickHexFor` 落盘。
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

const infDivRecord = () =>
  groundRecord('axis', (record) => /Inf Div|Rifle Div/i.test(record.vassalName ?? ''))
const hqRecord = () => groundRecord('axis', (record) => record.specialized?.includes('hq') === true)

function readyWithDeadUnit(): ReturnType<typeof newStore> {
  const store = newStore()
  store.setActiveSide('axis')
  store.setTurn(2)
  store.setPhase('reinforcement')
  goToActionStep(store, 'rein.rebuild')

  const unit = placeGround(store, infDivRecord(), CORE_HEX, 'axis', 'dead-1')
  unit.steps = unit.printedSteps - 1
  store.sendToDeadPileNow('dead-1')
  expect(store.deadPile.some((item) => item.instanceId === 'dead-1')).toBe(true)

  // 13.5a 落点前提：补员全在该格 + 战斗面友方 HQ 2 格内
  store.setReplHoldingsNow({ pax: 10, eq: 0, ftr: 0, tac: 0 }, CORE_HEX)
  placeGround(store, hqRecord(), CORE_HEX, 'axis', 'hq-1')
  return store
}

describe('13.5：死亡堆贴图点选 ⇒ 地图直接高亮合法格 ⇒ 点格即落位', () => {
  it('★ 一次点选就开好待点格；候选＝rebuildLegalHexes；点其中一格即完成重建', () => {
    const store = readyWithDeadUnit()
    const mapView = useMapViewStore()

    expect(mapView.pickBoxUnitAtFace('dead_pile', 'dead-1', false)).toBe(true)
    expect(store.deadPilePickId).toBe('dead-1')
    expect(store.rebuildPickUnitId).toBe('dead-1')
    expect(store.hexPickView?.candidates).toEqual(store.rebuildLegalHexes('dead-1'))
    expect(store.hexPickView?.candidates).toContainEqual(CORE_HEX)

    // 用户要的"点格即放置"：不再经过会话框按钮或二次确认
    expect(store.pickHexFor(CORE_HEX)).toBe(true)
    expect(store.deadPile.some((item) => item.instanceId === 'dead-1')).toBe(false)
    expect(store.units.some((item) => item.instanceId === 'dead-1')).toBe(true)
    expect(store.replHoldings.pax).toBeLessThan(10)
  })

  it('不在重建环节 ⇒ 点选不强行开选格（保留"为什么不能重建"的可见原因）', () => {
    const store = readyWithDeadUnit()
    store.setPhase('movement')
    const mapView = useMapViewStore()

    expect(mapView.pickBoxUnitAtFace('dead_pile', 'dead-1', false)).toBe(false)
    expect(store.hexPickView).toBeNull()
    expect(store.pickDeadPileUnitNow('dead-1')).toBeUndefined()
    expect(store.hexPickView).toBeNull()
  })

  it('在盒贴图上取消选中 ⇒ 收起高亮（不会留下悬空待点格）', () => {
    const store = readyWithDeadUnit()
    const mapView = useMapViewStore()

    expect(mapView.pickBoxUnitAtFace('dead_pile', 'dead-1', false)).toBe(true)
    expect(store.hexPickView).not.toBeNull()
    expect(mapView.pickBoxUnitAtFace('dead_pile', 'dead-1', true)).toBe(true)
    expect(store.hexPickView).toBeNull()
  })

  it('非死亡堆的盒贴图点选不改重建状态', () => {
    const store = readyWithDeadUnit()
    const mapView = useMapViewStore()

    expect(mapView.pickBoxUnitAtFace('breakdown_pool', 'dead-1', false)).toBe(false)
    expect(store.hexPickView).toBeNull()
  })
})
