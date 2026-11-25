import { describe, expect, it } from 'vitest'

import { advanceAiStepGuard, createAiStepGuard } from '@/ai/step-guard'

/**
 * AI 驱动的重排策略（2026-11-25「撤退卡住」根因之一）
 *
 * 修前：`GameTableView` 只在 `intent === 'wait'` 时退避 600ms，其余失败一律 0ms 重排
 * ⇒ 被规则拒绝且 AI 自己无解的那一步会空转（界面看着不动、日志刷满同一条拒绝）。
 * 本用例钉：失败要退避、同一判据连续失败要判卡住并停下（而不是假装成功）。
 */

const failure = {
  intent: 'combatOptions',
  ok: false,
  rule: '9.11',
  reason: '选项结算被拒绝：optionLossExceedsAvailableSteps:2>1（9.11）',
}

describe('advanceAiStepGuard', () => {
  it('成功 ⇒ 立刻继续', () => {
    const decision = advanceAiStepGuard(createAiStepGuard(), {
      intent: 'combatSupply',
      ok: true,
    })
    expect(decision.delayMs).toBe(0)
    expect(decision.stop).toBe(false)
    expect(decision.state.repeats).toBe(0)
  })

  it('wait（玩家侧待办）⇒ 退避等待，不计入卡住', () => {
    const decision = advanceAiStepGuard(createAiStepGuard(), {
      intent: 'wait',
      ok: false,
      reason: '等待玩家选择撤退落点（9.12）',
    })
    expect(decision.delayMs).toBe(600)
    expect(decision.stop).toBe(false)
    expect(decision.state.signature).toBeNull()
  })

  it('普通失败 ⇒ 退避重试（不再 0ms 重排）', () => {
    const decision = advanceAiStepGuard(createAiStepGuard(), failure)
    expect(decision.delayMs).toBe(400)
    expect(decision.stop).toBe(false)
    expect(decision.state.repeats).toBe(1)
  })

  it('同一判据连续 5 次 ⇒ 判卡住并停下，说明里带条款与原因', () => {
    let state = createAiStepGuard()
    let last = advanceAiStepGuard(state, failure)
    for (let round = 2; round <= 4; round += 1) {
      state = last.state
      last = advanceAiStepGuard(state, failure)
      expect(last.stop).toBe(false)
    }
    const final = advanceAiStepGuard(last.state, failure)
    expect(final.stop).toBe(true)
    expect(final.stalled).toContain('9.11')
    expect(final.stalled).toContain('optionLossExceedsAvailableSteps')
    expect(final.stalled).toContain('5')
  })

  it('中途换原因 ⇒ 计数归零（不是同一处卡住）', () => {
    const first = advanceAiStepGuard(createAiStepGuard(), failure)
    const second = advanceAiStepGuard(first.state, {
      ...failure,
      reason: '另一种拒绝',
    })
    expect(second.state.repeats).toBe(1)
    expect(second.stop).toBe(false)
  })

  it('成功一次就把连续计数清空', () => {
    let state = advanceAiStepGuard(createAiStepGuard(), failure).state
    state = advanceAiStepGuard(state, failure).state
    state = advanceAiStepGuard(state, { intent: 'combatSupply', ok: true }).state
    expect(state.repeats).toBe(0)
    expect(state.signature).toBeNull()
  })

  it('intent === none（驱动已收束）⇒ 停止', () => {
    const decision = advanceAiStepGuard(createAiStepGuard(), { intent: 'none', ok: false })
    expect(decision.stop).toBe(true)
    expect(decision.stalled).toBeNull()
  })
})
