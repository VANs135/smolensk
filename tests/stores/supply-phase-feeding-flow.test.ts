import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { holdingsToT } from '@/engine/rules'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

import { CORE_HEX, combatRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * M4③：D 段的 **③ 喂食（12.6c）** 与 **④ 断补标记（12.6d）** 一键落盘 + **21.10 Forage 可用性提示**
 *
 * 条文要点：
 *   · 12.6c 游戏说明：吃图上补给**永不强迫**（只有玩家勾选的单位才被喂）；
 *   · 12.6c 喂食的 T 从**图上**取（12.3a/12.3b 是仅有的取补途径）；
 *   · 12.6d：喂饱者免于断补、喂不到者置断补标记（本作唯一写点 `markTraceSupply`）；
 *   · 21.10：Forage 需要「该 HQ 被切断补给的**第一回合**」+ 仍有补给缓存 + 在补给阶段。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('12.6c/12.6d：喂食与断补标记的一键落盘', () => {
  it('勾选吃图上补给 + 有 T ⇒ 扣款、摘标；未勾者仍断补', () => {
    const store = newStore()
    store.setPhase('supply')
    const fedUnit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'fed')
    const unfed = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'unfed')
    // 12.6c：吃图上补给吃的是**图上**的 SP ⇒ 该格要有可拖到的补给站
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 }) // 16 T
    store.supplyPhaseInputs = {
      availableT: 0,
      eatOffTheMap: { [fedUnit.instanceId]: true },
    }
    store.planSupplyPhaseNow()
    expect(store.supplyPhasePlan?.feeding.map((item) => item.unitId)).toEqual([fedUnit.instanceId])
    expect(store.supplyPhasePlan?.feeding[0]?.affordable).toBe(true)

    const before = holdingsToT(store.spDumps[0]!)
    expect(store.applySupplyPhaseFeedingNow()).toBe(true)
    expect(holdingsToT(store.spDumps[0]!)).toBeLessThan(before)
    expect(fedUnit.hasTraceSupply).toBe(true) // 喂饱 ⇒ 免于断补（12.6d clear）
    expect(unfed.hasTraceSupply).toBe(false) // 未勾 ⇒ 仍置断补（12.6d mark）
  })

  it('T 不够 ⇒ 不喂、整笔不扣款（12.3a/12.3b 只能从己方站取）', () => {
    const store = newStore()
    store.setPhase('supply')
    const unit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 0 }) // 没有 T
    store.supplyPhaseInputs = { availableT: 0, eatOffTheMap: { [unit.instanceId]: true } }
    store.planSupplyPhaseNow()
    // 有站但站里没 T ⇒ 引擎判 affordable=false ⇒ 不喂、不扣、仍断补
    expect(store.supplyPhasePlan?.feeding[0]?.affordable).toBe(false)
    expect(store.applySupplyPhaseFeedingNow()).toBe(true)
    expect(unit.hasTraceSupply).toBe(false)
    expect(holdingsToT(store.spDumps[0]!)).toBe(0)
  })

  it('未载入计划就落盘 ⇒ 被拒（先算后落）', () => {
    const store = newStore()
    store.setPhase('supply')
    expect(store.applySupplyPhaseFeedingNow()).toBe(false)
  })

  it('落盘后**不**立刻重判（本计划就是这一段的结论，重判会覆盖它）', () => {
    const store = newStore()
    store.setPhase('supply')
    const unit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
    store.supplyPhaseInputs = { availableT: 0, eatOffTheMap: { [unit.instanceId]: true } }
    store.planSupplyPhaseNow()
    store.applySupplyPhaseFeedingNow()
    expect(unit.hasTraceSupply).toBe(true)
    // 若落盘后立刻重判，单位会被事实层重新判回断补 —— 这里钉住"不重判"
    expect(store.supplyPhasePlan).not.toBeNull()
  })
})

describe('21.10：Forage 可用性提示（补给阶段 + 断补首回合 + 有缓存）', () => {
  const placeHq = (store: Workbench, side: 'axis' | 'soviet', id: string) => {
    const record = unitChoices(side).find((item) => (item.specialized ?? []).includes('hq'))
    if (record === undefined) throw new Error(`${side} 单位库中没有 HQ`)
    const unit = toConsoleUnit({ record, instanceId: id, hex: CORE_HEX, side })
    store.units.push(unit)
    return unit
  }

  /** 取 store 里的**响应式代理**（直接改外面那个裸对象不会触发 computed 失效） */
  const fromStore = (store: Workbench, id: string) => {
    const found = store.units.find((item) => item.instanceId === id)
    if (found === undefined) throw new Error(`单位 ${id} 不在盘面上`)
    return found
  }

  it('补给阶段 + HQ 断补首回合 + 有缓存 ⇒ 提示；缺任一条件则不提示', () => {
    const store = newStore()
    /*
     * ★ 契约变更（批 F 切片 5，**不是放宽**）：21.10 的「被切断的第一个回合」修前由裁判勾选
     *   （`supplyCacheInputs.firstTurnOfBeingCut`），现已删除 ⇒ 判据按盘面事实算
     *   （`cutSinceTurn`，与 12.8e 同源）。故这里不再手改 `hasTraceSupply`，而是**让 store 自己判**：
     *   摆好 HQ → 进补给段（自动重判 12.6）⇒ 该 HQ 的连续断补起点＝当前回合。
     */
    placeHq(store, 'axis', 'hq1')
    store.setPhase('supply')
    expect(fromStore(store, 'hq1').hasTraceSupply).toBe(false)
    expect(fromStore(store, 'hq1').cutSinceTurn).toBe(store.turn)
    // 缓存初值来自剧本（剧本 1 为每方 2）
    expect(store.supplyCacheHoldings.axis).toBeGreaterThan(0)
    expect(store.forageHints.map((item) => item.hqId)).toContain('hq1')

    // 有追溯补给 ⇒ 不再"被切断"（连续期清零）⇒ 不提示
    store.supplySourceDraft = {
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
      kind: 'supplySourceHex',
    }
    expect(store.addSupplySource()).toBe(true)
    store.evaluateTraceSupplyNow()
    expect(fromStore(store, 'hq1').cutSinceTurn).toBe(null)
    expect(store.forageHints.map((item) => item.hqId)).not.toContain('hq1')

    // 不在补给阶段
    store.setPhase('movement')
    expect(store.forageHints).toEqual([])
  })

  it('没有补给缓存 ⇒ 不提示（21.10 要先花掉一枚缓存）', () => {
    const store = newStore()
    placeHq(store, 'axis', 'hq1')
    store.setPhase('supply')
    expect(fromStore(store, 'hq1').hasTraceSupply).toBe(false)
    store.supplyCacheHoldings = { ...store.supplyCacheHoldings, axis: 0 }
    expect(store.forageHints).toEqual([])
  })
})
