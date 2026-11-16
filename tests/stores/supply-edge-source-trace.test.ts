import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'
import type { ConsoleUnit } from '@/stores'

/**
 * 专规 3.1：图边补给源格必须真正进入**追溯补给**链路（12.6a①）
 *
 * ## 原文（Smolensk_Rules_v1.1 p.3，见 `tests/data/axis-supply-sources.test.ts`）
 *   「Map-edge hexes **west of 10.xx** where **any type of road or railroad enters the map**
 *    are Axis supply sources. Examples are **1.03, 1.26, and 4.00** (but **not 11.33**!)」
 *
 * ## 本文件钉什么
 *   剧本数据把 `1.26` 列进 `supplySources.axisLive`（8 个剧本同值），而追溯事实的
 *   `sources` 过去只取「玩家手声明的源 + 13.3c 铁路卸货格」⇒ 1.26 这种**非铁路格边源**
 *   在没有任何 SP 账本时判成"无抽象补给"。本文件从**玩家可见结论**出发：
 *   单位站在 1.26 本身（距离 0）就该有追溯补给。
 *
 * ## 测法
 *   用真实地图与真实单位库；不造源、不加 dump、不声明任何东西 ⇒ 结论只可能来自
 *   「2.1 / 3.1 的图边补给源清单」这一条数据。
 */

const EDGE_SOURCE = { col: 1, row: 26 }

function newStoreWithScenario(id: string): ReturnType<typeof useWorkbenchStore> {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  store.setScenarioId(id)
  return store
}

function placeCombatUnit(
  store: ReturnType<typeof useWorkbenchStore>,
  hex: { col: number; row: number },
  side: 'axis' | 'soviet',
): ConsoleUnit {
  const record = unitChoices(side).find((item) => item.isCombat === true && (item.reSize ?? 0) > 0)
  if (record === undefined) throw new Error(`${side} 单位库中没有带规模的战斗单位`)
  const unit = toConsoleUnit({ record, instanceId: `${side}-edge-1-26`, hex, side })
  store.units.push(unit)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('专规 3.1：轴方图边源格 1.26 的追溯补给', () => {
  it('单位停在 1.26（源格本身）⇒ 全场追溯判定后为有补给（12.6a①）', () => {
    const store = newStoreWithScenario('1')
    const unit = placeCombatUnit(store, EDGE_SOURCE, 'axis')

    store.evaluateTraceSupplyNow()

    expect(unit.hasTraceSupply).toBe(true)
    expect(store.traceSettlement?.byUnit[unit.instanceId]).toBe('inSupply')
  })

  it('逐单位检查（12.6）在 1.26 给出「有追溯补给」，不是断补', () => {
    const store = newStoreWithScenario('1')
    const unit = placeCombatUnit(store, EDGE_SOURCE, 'axis')
    // 12.6 的逐单位检查只在补给阶段开窗
    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    expect(store.supplySummary?.status).toBe('inSupply')
  })

  it('数据结构：全部剧本的 axisLive 都含 1.26（原文举的例，不能靠玩家手声明）', () => {
    for (const id of ['1', '2', '3', '4', '5', '6', '7', 'Intro']) {
      const store = newStoreWithScenario(id)
      const unit = placeCombatUnit(store, EDGE_SOURCE, 'axis')
      store.evaluateTraceSupplyNow()
      expect(unit.hasTraceSupply, `剧本 ${id}`).toBe(true)
    }
  })
})
