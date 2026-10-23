import { describe, expect, it } from 'vitest'

import {
  SUPPLY_CACHE_SHELLS_T,
  addSupplyCache,
  forageAvailable,
  initialSupplyCacheHoldings,
  supplyCacheCount,
  useSupplyCacheAsForage,
  useSupplyCacheAsShells,
  type SupplyCacheHoldings,
} from '@/engine/rules'

/**
 * 补给缓存标记（Smolensk 专规 1.7 ← OCS 21.10，本作**标准规则**）
 *
 * 条文：
 *   - 1.7：每方每剧本开局各持**两个**，偶尔经 Special Repl 再得，可用于 **Shells** 或 **Forage**。
 *   - 21.10 Shells：在任意友方 HQ 处花掉，抵付该次 HQ 投递的火炮轰炸成本，**每标记 2T**；
 *     成本降到 0 以下**不找零**；**即使该 HQ 不在追溯补给中也可用**。
 *   - 21.10 Forage：**只在补给阶段**花 1 枚，让 HQ 为其投递距离内所有战斗单位提供追溯补给；
 *     只在**断补的第一个回合**可用；**不可用于 spearhead（矛头部队）**。
 */

const TWO: SupplyCacheHoldings = { axis: 2, soviet: 2 }
/** 苏方存量耗尽（轴方仍有 2 枚，用于验证「按方扣减」） */
const NO_SOVIET: SupplyCacheHoldings = { axis: 2, soviet: 0 }
const HQ = { col: 36, row: 13 }

describe('1.7：持有量', () => {
  it('1.7：每方开局各 2 枚（数值取自 rules-constants，脚本初设可覆盖）', () => {
    expect(initialSupplyCacheHoldings()).toEqual({ axis: 2, soviet: 2 })
    expect(initialSupplyCacheHoldings(3)).toEqual({ axis: 3, soviet: 3 })
    expect(SUPPLY_CACHE_SHELLS_T).toBe(2)
  })

  it('1.7：经 1.6c 特殊补员追加（只加指定一方）', () => {
    const after = addSupplyCache(TWO, 'soviet')
    expect(after).toEqual({ axis: 2, soviet: 3 })
    expect(supplyCacheCount(after, 'soviet')).toBe(3)
    // 原对象不被改写（引擎不写状态）
    expect(TWO).toEqual({ axis: 2, soviet: 2 })
  })
})

describe('21.10 Shells：抵付 HQ 投递的轰炸成本', () => {
  it('21.10：每标记抵 2T；成本高于 2T 时余量仍需支付', () => {
    const outcome = useSupplyCacheAsShells({
      side: 'axis',
      holdings: TWO,
      hqHex: HQ,
      barrageCostT: 5,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.data).toMatchObject({
        rule: '21.10',
        paidT: 2,
        remainingCostT: 3,
        partialFire: false,
      })
    }
  })

  it('21.10：成本降到 0 以下**不找零** ⇒ 记为「部分火力」', () => {
    const outcome = useSupplyCacheAsShells({
      side: 'axis',
      holdings: TWO,
      hqHex: HQ,
      barrageCostT: 2,
    })
    if (outcome.ok) {
      expect(outcome.data.paidT).toBe(2)
      expect(outcome.data.remainingCostT).toBe(0)
      expect(outcome.data.partialFire).toBe(true)
    }
    // 成本不足 2T 时只抵实际成本（不产生负成本）
    const cheap = useSupplyCacheAsShells({
      side: 'axis',
      holdings: TWO,
      hqHex: HQ,
      barrageCostT: 1,
    })
    if (cheap.ok) {
      expect(cheap.data.paidT).toBe(1)
      expect(cheap.data.remainingCostT).toBe(0)
    }
  })

  it('21.10：HQ 不在追溯补给中也可用（该事实只作日志，不参与合法性）', () => {
    const outcome = useSupplyCacheAsShells({
      side: 'axis',
      holdings: TWO,
      hqHex: HQ,
      barrageCostT: 4,
      hqDrawsTraceSupply: false,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.data.detail).toContain('不在追溯补给中也可用')
  })

  it('1.7 / 21.10：没有存量或成本为 0 ⇒ 拒', () => {
    const noStock = useSupplyCacheAsShells({
      side: 'soviet',
      holdings: NO_SOVIET,
      hqHex: HQ,
      barrageCostT: 4,
    })
    expect(noStock.ok).toBe(false)
    if (!noStock.ok) expect(noStock.reason).toBe('noSupplyCacheLeft:soviet')

    const zeroCost = useSupplyCacheAsShells({
      side: 'axis',
      holdings: TWO,
      hqHex: HQ,
      barrageCostT: 0,
    })
    expect(zeroCost.ok).toBe(false)
    if (!zeroCost.ok) expect(zeroCost.reason).toBe('shellsRequirePositiveBarrageCost')
  })
})

describe('21.10 Forage：断补首回合的应急征粮', () => {
  const base = {
    side: 'axis' as const,
    holdings: TWO,
    phase: 'supply',
    hqHex: HQ,
    hqThrowRangeHexes: 5,
    firstTurnOfBeingCut: true,
  }

  it('21.10：补给阶段 + 断补首回合 + 非矛头 ⇒ 通过（覆盖投递距离内全部战斗单位）', () => {
    const outcome = useSupplyCacheAsForage(base)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.rule).toBe('21.10')
      expect(outcome.data.coveredHexes).toBe('allWithinThrowRange')
    }
  })

  it('21.10：只在补给阶段（其它阶段一律拒）', () => {
    for (const phase of ['movement', 'reaction', 'combat', 'exploitation', 'cleanUp']) {
      const outcome = useSupplyCacheAsForage({ ...base, phase })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe('forageOnlyInSupplyPhase')
    }
  })

  it('21.10：只在断补的第一个回合（之后拒）', () => {
    const outcome = useSupplyCacheAsForage({ ...base, firstTurnOfBeingCut: false })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('forageOnlyOnFirstTurnOfBeingCut')
  })

  it('21.10：不可用于矛头部队（spearhead）', () => {
    const outcome = useSupplyCacheAsForage({ ...base, isSpearhead: true })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('forageNotAllowedForSpearhead')
  })

  it('21.10：受益单位须在 HQ 投递距离内', () => {
    const outcome = useSupplyCacheAsForage({
      ...base,
      unitHex: { col: 36, row: 20 },
      distanceHexes: 6,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('forageTargetOutOfThrowRange:6>5')
  })

  it('1.7：没有存量 ⇒ 拒', () => {
    const outcome = useSupplyCacheAsForage({ ...base, side: 'soviet', holdings: NO_SOVIET })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('noSupplyCacheLeft:soviet')
  })

  it('21.10：可用性速查（供界面在补给阶段提示）', () => {
    expect(
      forageAvailable({ phase: 'supply', firstTurnOfBeingCut: true, holdings: TWO, side: 'axis' }),
    ).toBe(true)
    expect(
      forageAvailable({
        phase: 'movement',
        firstTurnOfBeingCut: true,
        holdings: TWO,
        side: 'axis',
      }),
    ).toBe(false)
    expect(
      forageAvailable({ phase: 'supply', firstTurnOfBeingCut: false, holdings: TWO, side: 'axis' }),
    ).toBe(false)
    expect(
      forageAvailable({
        phase: 'supply',
        firstTurnOfBeingCut: true,
        holdings: { axis: 0, soviet: 0 },
        side: 'soviet',
      }),
    ).toBe(false)
  })
})
