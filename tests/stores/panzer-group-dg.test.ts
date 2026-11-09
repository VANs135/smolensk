import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { TURN_TRACK } from '@/stores'

import { CORE_HEX, NEAR_HEX, combatRecord, newConsole, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 3.4a 的 **DG 落盘入口**（`applyPanzerGroupDgNow`）
 *
 * 原文 3.4a：「…place a DG on one unit of the multi-unit formation」——义务由引擎
 * `dividingLineObligations` 给出（`panzerGroupObligations`），本入口只做落盘：
 *   · 义务名单内的单位可以投 DG（走 5.10 的唯一落盘点 `applyDgToUnit`）；
 *   · 不在义务名单内的单位被拒；
 *   · 19 August 起义务整体失效（`panzerGroupObligations` 为空）⇒ 入口同样拒绝。
 *
 * ★ 3.4a 是**专规、常开**，本文件**不**去勾 3.4b 的可选项：判据与开关互不替代。
 */

/** 1941-08-19（3.4 约束失效日）对应的回合号，取自工程数据 turnTrack */
const TURN_19_AUG = TURN_TRACK.find((entry) => entry.date === '1941-08-19')?.turn ?? 13

/** 造出「两个集群的多单位编队同堆叠/相邻」⇒ 两边各一条 3.4a 义务 */
function crossGroupObligations(store: Workbench) {
  store.setPhase('movement')
  const guderian = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'g1')
  const hoth = placeGround(store, combatRecord('axis'), NEAR_HEX, 'axis', 'h1')
  store.setMultiUnitFormationNow('g1', true)
  store.setMultiUnitFormationNow('h1', true)
  store.setPanzerGroupNow('g1', 'guderian')
  store.setPanzerGroupNow('h1', 'hoth')
  return { guderian, hoth }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('3.4a：分界线义务的 DG 落盘', () => {
  it('义务名单内的单位可以投 DG，义务仍挂在原地（3.4a）', () => {
    const store = newConsole()
    const { guderian } = crossGroupObligations(store)

    const obligations = store.panzerGroupObligations
    expect(obligations.map((item) => item.rule)).toEqual(['3.4a', '3.4a'])
    expect(obligations.some((item) => item.unitIds.includes(guderian.instanceId))).toBe(true)

    expect(store.applyPanzerGroupDgNow(guderian.instanceId)).toBe(true)
    expect(guderian.mode.dg).toBe(true)
    // 3.4a 只要求「该编队一个单位」；入口不擅自清空义务清单
    expect(store.panzerGroupObligations.length).toBeGreaterThan(0)
  })

  it('不在义务名单内的单位被拒（3.4a）', () => {
    const store = newConsole()
    crossGroupObligations(store)
    const idle = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'idle')

    expect(store.applyPanzerGroupDgNow(idle.instanceId)).toBe(false)
    expect(idle.mode.dg).toBe(false)
  })

  it('19 August 起义务整体失效 ⇒ 入口拒绝（3.4 / 1941-08-19）', () => {
    const store = newConsole()
    const { guderian } = crossGroupObligations(store)
    store.setTurn(TURN_19_AUG)

    expect(store.panzerGroupObligations).toEqual([])
    expect(store.applyPanzerGroupDgNow(guderian.instanceId)).toBe(false)
    expect(guderian.mode.dg).toBe(false)
  })
})
