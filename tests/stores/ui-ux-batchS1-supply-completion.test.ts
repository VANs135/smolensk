import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { newConsole } from '../flows/sop-harness'

/**
 * S1（用户 2026-11-17）：补给段结算不能「面板直接消失、流程条停在 1/2、界面无反馈」
 *
 * 口径：允许点结算，但结算后要就地显示完成态（已恢复 N 单位 / 已结算 N 单位），
 * 并明确下一步是「进入下一环节」；无结算对象时也一样给出结果，而不是把整块面板卸载。
 */

describe('S1：补给段结算后就地给完成态', () => {
  it('12.10e 没有需要恢复的单位 ⇒ 落盘后给出 0 单位的结果，而不是空', () => {
    const store = newConsole()
    store.setPhase('supply')
    expect(store.planSupplyPhaseNow()).toBe(true)
    expect(store.supplyPhasePlan?.internalStocks.recoveries).toEqual([])
    expect(store.supplyRecoveryOutcome).toBeNull()

    expect(store.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(store.supplyRecoverySettled).toBe(true)
    expect(store.supplyRecoveryOutcome).toEqual({ units: 0, spentT: 0 })
  })

  it('12.6c 没有可喂的单位 ⇒ 供养落盘后给出 0 单位的结算结果', () => {
    const store = newConsole()
    store.setPhase('supply')
    const index = store.playerSegmentSteps.findIndex((step) => step.id === 'supply.check')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(store.setSegmentStepIndex(index)).toBe(true)
    expect(store.planSupplyPhaseNow()).toBe(true)

    expect(store.applySupplyPhaseFeedingNow()).toBe(true)
    expect(store.supplyFeedingSettled).toBe(true)
    expect(store.supplyFeedingOutcome).toEqual({ units: 0, spentT: 0, marked: 0, cleared: 0 })
  })

  it('面板不再按「还有没有待决」卸载自身，并给出完成态与下一步', () => {
    const panel = readFileSync('src/components/supply/SupplyPhasePanel.vue', 'utf8')
    // 修前：settled 后 `pending` 立刻为 false ⇒ 整块 section 卸载，完成态永远看不到
    expect(panel).not.toContain('<section\n    v-if="pending"')
    expect(panel).not.toContain('v-if="pending"')
    expect(panel).toContain('supplyRecoveryOutcome')
    expect(panel).toContain('supplyFeedingOutcome')
    expect(panel).toContain('已恢复')
    expect(panel).toContain('已结算')
    expect(panel).toContain('进入下一环节')
  })
})
