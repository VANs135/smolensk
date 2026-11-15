import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 13.3f：Railhead 端头 = 换轨账本 + 铁路连通的**推导结果**（不是手摆实例）
 *
 * 原文只写「Players keep track of the current extent of each rail gauge using Railhead markers」，
 * 取法未写；本组钉的是 store 接线：账本一变，`railheadMarkers` 立即跟着前移/后撤，
 * 没有任何「设置端头位置」的入口。推导本身（推进/后撤/分叉/不重复）见 `tests/engine/rail.test.ts`。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

type Workbench = ReturnType<typeof useWorkbenchStore>

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 13.3f-B：换轨须是"移动进入"的副产品 ⇒ 先让单位真的走一格 */
function walkInto(store: Workbench, unitId: string, from: HexRef, to: HexRef): void {
  const active = store.moveInteraction?.unitIds.includes(unitId) === true
  if (!active || store.moveInteraction?.finished === true) {
    store.clickHex(from)
    if (store.movePickHex !== null) {
      store.setMovePickOnly(unitId)
      expect(store.confirmMovePick()).toBe(true)
    }
  }
  store.clickHex(to)
  expect(store.units.find((unit) => unit.instanceId === unitId)?.hex).toEqual(to)
}
const heads = (store: Workbench): string[] =>
  store.railheadMarkers.map((marker) => label(marker.hex!))

function rrUnit(
  store: Workbench,
  side: 'axis' | 'soviet',
  hex: HexRef,
  instanceId: string,
): ReturnType<typeof placeGround> {
  const record = groundRecord(side, (item) => (item.specialized ?? []).includes('rail_repair'))
  const unit = placeGround(store, record, hex, side, instanceId, 'combat')
  unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
  unit.raw = unit.faces.combat
  unit.mpSpent = 0
  unit.movementEnded = false
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('13.3f：Railhead 端头随换轨账本自动前移 / 后撤', () => {
  it('★ 轴方换进 ⇒ 端头前移到 3.2；苏方换回 ⇒ 端头后撤到 2.2', () => {
    const store = newStore()
    store.setPhase('movement')
    // 剧本 1 的初设换轨（01.03 → 2.02）落账后的端头是 2.2，不是西缘的 1.3
    store.convertedRailHexes = ['1.3', '2.2']
    expect(heads(store)).toEqual(['2.2'])

    const axis = rrUnit(store, 'axis', { col: 2, row: 2 }, 'rr-axis')
    // 13.3f-B：走进 3.2 才可换轨
    walkInto(store, axis.instanceId, { col: 2, row: 2 }, { col: 3, row: 2 })
    expect(store.convertRailGaugeNow(axis.instanceId, '3.2')).toBe(true)
    expect(heads(store)).toEqual(['3.2'])

    // 苏方要换回，须先进入该格（敌人走开后再进入）
    store.units.splice(store.units.indexOf(axis), 1)
    store.switchSide()
    store.setPhase('movement')
    const soviet = rrUnit(store, 'soviet', { col: 2, row: 2 }, 'rr-soviet')
    walkInto(store, soviet.instanceId, { col: 2, row: 2 }, { col: 3, row: 2 })
    expect(store.convertRailGaugeNow(soviet.instanceId, '3.2')).toBe(true)
    expect(heads(store)).toEqual(['2.2'])
  })
})
