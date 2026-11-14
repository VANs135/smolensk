import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { actionGateOf, useWorkbenchStore } from '@/stores'
import type { ActionKey, ConsolePhase } from '@/stores'

import { CORE_HEX, aircraftRecord, groundRecord, placeAir, placeGround } from '../flows/sop-harness'

/**
 * 1.6a：到达卡的强制移除**真的落盘**（19 Jul 苏方 6 条）
 *
 * 实测缺陷（2026-11-14，A→B 实点）：卡面写 `12-2-2 Inf Div (186)`，盘面叫 `Ru 186 Rifle Div`，
 * 修前判据是 `removal.raw.includes(unit.name)`（两个字符串互不包含）⇒ 6 条移除**一条都没执行**，
 * 却在日志里写"盘面上没有可移除的同名算子 ⇒ 请手工处理"。
 *
 * 同时钉住「To Dead Pile」列的方向：`19 Pz Div (19 Aufk, III-27 Pz)` 是**进死亡堆**（13.5 可重建），
 * 不是"移出游戏"（修前两种情况共用一条 `removeFromPlayEverywhere`）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/** 第 4 回合 = 1941-07-19（到达卡的 19 Jul 块） */
const TURN_19_JUL = 4

describe('1.6a：19 Jul 苏方强制移除（真实到达卡 + 真实单位库）', () => {
  it('★ 六条移除逐条落到盘面：卡面番号形态（`12-2-2 Inf Div (186)`）必须命中 `Ru 186 Rifle Div`', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(TURN_19_JUL)
    store.setPhase('reinforcement')
    goToActionStep(store, 'rein.arrival')
    expect(store.arrivalPlan?.removals.map((item) => item.raw)).toContain('12-2-2 Inf Div (186)')

    const placed = [
      placeGround(
        store,
        groundRecord('soviet', (r) => r.vassalName === 'Ru HQ 22nd Army'),
        CORE_HEX,
        'soviet',
        'rm-hq',
      ),
      placeGround(
        store,
        groundRecord('soviet', (r) => r.vassalName === 'Ru 186 Rifle Div'),
        CORE_HEX,
        'soviet',
        'rm-186',
      ),
      placeGround(
        store,
        groundRecord('soviet', (r) => r.vassalName === 'Ru 126 Rifle Div'),
        CORE_HEX,
        'soviet',
        'rm-126',
      ),
      placeGround(
        store,
        groundRecord('soviet', (r) => r.vassalName === 'Ru 214 Rifle Div'),
        CORE_HEX,
        'soviet',
        'rm-214',
      ),
      placeGround(
        store,
        groundRecord('soviet', (r) => r.vassalName === 'Ru 48 Tk Div'),
        CORE_HEX,
        'soviet',
        'rm-48',
      ),
      placeGround(
        store,
        groundRecord('soviet', (r) => r.vassalName === 'Ru Arty Bde'),
        CORE_HEX,
        'soviet',
        'rm-arty',
      ),
      placeGround(
        store,
        groundRecord('soviet', (r) => r.vassalName === 'Ru Wagon 1'),
        CORE_HEX,
        'soviet',
        'rm-wagon',
      ),
    ]
    store.applyArrivalRemovalsNow()

    const left = new Set(store.units.map((unit) => unit.instanceId))
    for (const unit of placed) expect(left.has(unit.instanceId)).toBe(false)
    // 修前的假警告不得再出现
    expect(store.log.some((entry) => entry.text.includes('盘面上没有可移除的同名算子'))).toBe(false)
    // 至少这 6 条各写了一条落盘日志（`1 Wagon Point` 也吃 wagon）
    expect(
      store.log.filter((entry) => entry.text.includes('按到达卡移出游戏')).length,
    ).toBeGreaterThanOrEqual(6)
  })

  it('1.6a：`To Dead Pile` 列（`… III-27 Pz`）进死亡堆，不是移出游戏', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setTurn(TURN_19_JUL)
    store.setPhase('reinforcement')
    goToActionStep(store, 'rein.arrival')
    const targets = store.arrivalPlan?.removals.filter((item) => item.kind === 'deadPile') ?? []
    expect(targets.length).toBeGreaterThan(0)

    const panzer = placeGround(
      store,
      groundRecord('axis', (r) => r.vassalName === 'Ge 19.Pz III-27 Pz'),
      CORE_HEX,
      'axis',
      'dp-iii27',
    )
    store.applyArrivalRemovalsNow()

    expect(store.units.some((unit) => unit.instanceId === panzer.instanceId)).toBe(false)
    expect(store.deadPile.some((entry) => entry.instanceId === panzer.instanceId)).toBe(true)
  })

  it('1.6a：飞机 Removal（`Ju.87b`）也要移出游戏（修前只扫地面算子表）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setTurn(2) // 12 Jul
    store.setPhase('reinforcement')
    goToActionStep(store, 'rein.arrival')
    expect(store.arrivalPlan?.removals.map((item) => item.raw)).toContain('Ju.87b')

    const plane = placeAir(
      store,
      aircraftRecord('axis', (record) => (record.name ?? '') === 'Ge Ju.87b'),
      CORE_HEX,
      'axis',
      'rm-ju87',
    )
    store.applyArrivalRemovalsNow()
    expect(store.airUnits.some((air) => air.instanceId === plane.instanceId)).toBe(false)
  })
})
