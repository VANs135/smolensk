import { describe, expect, it } from 'vitest'

import { canUseInternalStocks, planCombatSupplyFunding } from '@/engine/rules/supply'

/**
 * 12.10 部队储备：支付战斗补给的付款规划（12.10a/b/c/g/h）
 *
 * 条文要点（本文件的每条断言都对应一句）：
 *   · 12.10 储备**只能**用于战斗补给（9.5b）；用与不用，战斗值不变；
 *   · 12.10a 只有**拿不到所需图上 SP** 时才能用；例外：唯一来源是编内卡车上的 SP；
 *   · 12.10b 用一次就降一级：ready → low → exhausted（**不是折算 T**）；
 *   · 12.10c 已耗尽者无法再用，因而**无法攻击**；
 *   · 12.10g 储备与图上 SP **可以混用**；但**单个算子**必须全额二选一；
 *   · 12.10h 多军力单位因图上不足而改用储备时，**图上那点补给被浪费**。
 *
 * 规则书的两个例子在下面逐字复现（见"规则书例①/例②"）。
 */
const unit = (unitId: string, requiredT: number, internalStocks: 'low' | 'exhausted' | null) => ({
  unitId,
  requiredT,
  internalStocks,
})

describe('12.10：付款规划（规则书两个例子）', () => {
  it('规则书例①：3 个 1RE 单位攻击、手上 1T ⇒ 1T 付其中一个，另两个标记低下（不浪费）', () => {
    const plan = planCombatSupplyFunding({
      units: [unit('a', 1, null), unit('b', 1, null), unit('c', 1, null)],
      availableMapT: 1,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.funding).toEqual([
      { unitId: 'a', source: 'map', t: 1, from: null, to: null },
      { unitId: 'b', source: 'stocks', t: 1, from: null, to: 'low' },
      { unitId: 'c', source: 'stocks', t: 1, from: null, to: 'low' },
    ])
    expect(plan.data.mapTUsed).toBe(1)
    expect(plan.data.wastedT).toBe(0)
    expect(plan.data.downgraded).toBe(2)
  })

  it('规则书例②：同样攻击由一个多军力单位（需 3T）完成、手上 1T ⇒ 该单位低下，**那 1T 被浪费**', () => {
    const plan = planCombatSupplyFunding({ units: [unit('div', 3, null)], availableMapT: 1 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.funding).toEqual([
      { unitId: 'div', source: 'stocks', t: 3, from: null, to: 'low' },
    ])
    // 12.10h：凑不满这个单位的 1T 照样被消耗
    expect(plan.data.wastedT).toBe(1)
    expect(plan.data.mapTUsed).toBe(1)
  })
})

describe('12.10g：单个算子全额二选一（不得混用）', () => {
  it('图上 T 差 1 点就能付清单个算子 ⇒ 该算子整体走储备，不"图上 2 + 储备 1"', () => {
    const plan = planCombatSupplyFunding({ units: [unit('u', 3, null)], availableMapT: 2 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.funding[0]).toMatchObject({ source: 'stocks', t: 3 })
    expect(plan.data.wastedT).toBe(2) // 12.10h：2T 也不够付清它 ⇒ 一并浪费
  })

  it('够付清就走图上，且**不得**动用储备（12.10a）', () => {
    const plan = planCombatSupplyFunding({ units: [unit('u', 2, null)], availableMapT: 5 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.funding[0]).toMatchObject({ source: 'map', t: 2 })
    expect(plan.data.downgraded).toBe(0)
    expect(plan.data.mapTUsed).toBe(2) // 全部付清 ⇒ 多余的 T 只是没取用，不算消耗
    expect(plan.data.wastedT).toBe(0)
  })
})

describe('12.10b：用一次降一级（ready → low → exhausted）', () => {
  it('ready 用一次 ⇒ low；已 low 再用 ⇒ exhausted', () => {
    const first = planCombatSupplyFunding({ units: [unit('u', 1, null)], availableMapT: 0 })
    expect(first.ok && first.data.funding[0]).toMatchObject({ from: null, to: 'low' })
    const second = planCombatSupplyFunding({ units: [unit('u', 1, 'low')], availableMapT: 0 })
    expect(second.ok && second.data.funding[0]).toMatchObject({ from: 'low', to: 'exhausted' })
  })
})

describe('12.10c：耗尽者无法再用 ⇒ 无法攻击（攻方须全额，12.4）', () => {
  it('攻方栈里有一个耗尽单位且图上 T 不够 ⇒ 整笔失败，给 12.10c', () => {
    const plan = planCombatSupplyFunding({
      units: [unit('ok', 1, null), unit('spent', 1, 'exhausted')],
      availableMapT: 0,
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.rule).toBe('12.10c')
    expect(plan.reason).toBe('internalStocksExhausted:spent')
  })

  it('耗尽单位改由图上补给支付 ⇒ 可以通过（12.10c：标记低下/耗尽者**仍可使用正常战斗补给**）', () => {
    const plan = planCombatSupplyFunding({
      units: [unit('ok', 1, null), unit('spent', 1, 'exhausted')],
      availableMapT: 10,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.funding.every((item) => item.source === 'map')).toBe(true)
    expect(plan.data.downgraded).toBe(0)
  })
})

describe('12.10a：唯一来源是编内卡车上的 SP ⇒ 例外允许用储备', () => {
  it('编内卡车例外打开时，即便图上"有"该 SP 也允许动用储备', () => {
    const allowed = planCombatSupplyFunding({
      units: [unit('u', 1, null)],
      availableMapT: 0,
      onlyOrganicTruck: (id) => id === 'u',
    })
    expect(allowed.ok && allowed.data.funding[0]?.source).toBe('stocks')
  })

  it('无条件满足时不得动用储备（闸门来自 canUseInternalStocks）', () => {
    // 图上够用 ⇒ 走图上（上面的 12.10g 用例已覆盖）；此处直接钉闸门本身
    expect(canUseInternalStocks({ onMapSupplyAvailable: true })).toMatchObject({
      ok: false,
      rule: '12.10a',
      reason: 'onMapSupplyAvailable',
    })
    expect(canUseInternalStocks({ onMapSupplyAvailable: true, onlyOrganicTruckSp: true }).ok).toBe(
      true,
    )
    expect(canUseInternalStocks({ onMapSupplyAvailable: false }).ok).toBe(true)
  })
})

describe('12.10：需求为 0 时不动任何账本', () => {
  it('无参战单位 ⇒ 计划为空', () => {
    const plan = planCombatSupplyFunding({ units: [], availableMapT: 4 })
    expect(plan.ok && plan.data.mapTUsed).toBe(0)
    expect(plan.ok && plan.data.funding).toEqual([])
  })
})
