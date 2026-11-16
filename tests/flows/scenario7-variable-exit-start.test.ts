import { describe, expect, it } from 'vitest'

import { fillSetup, fresh } from './flow-harness'

/**
 * 剧本 7 专规：`Roll for Variable Exit (3.3c).`
 *
 * 3.3c 原文：`On 19 August, start rolling during every Axis Reinforcement Phase until a
 * division, either SS Reich or 14th Motorized, is Removed (using the 1.6a procedure).`
 * 剧本 7 首回合 26 Aug ⇒ 开局已在 19 Aug 之后，必须在**开局时**先掷一次；
 * 掷出 1/6 移除对应师即了结，2–5 留到下个轴方增援阶段续掷。
 */

function exitEntries(ctx: ReturnType<typeof fresh>) {
  return (ctx.g.session?.log ?? []).filter((entry) => entry.action === 'variableExit')
}

/** 结算日志的 data（只取成功条目；失败条目没有 data） */
function settlementData(entry: { outcome: { ok: true; data: unknown } | { ok: false } }) {
  return entry.outcome.ok ? (entry.outcome.data as Record<string, unknown>) : null
}

function setupRollEntries(ctx: ReturnType<typeof fresh>) {
  return exitEntries(ctx).filter((entry) => settlementData(entry)?.mode === 'setupRoll')
}

function startScenario7(die: number) {
  const ctx = fresh()
  expect(ctx.setup.enterSetup('7')).toBe(true)
  // 裁判可填骰面：关掉自动掷，指定本颗撤离骰（与增援窗同一组输入）
  ctx.w.variableReplInputs.autoRoll = false
  ctx.w.variableReplInputs.variableExitDie = die
  fillSetup(ctx)
  return ctx
}

describe('剧本 7：开局即掷可变撤离（3.3c）', () => {
  it('掷出 2–5：开局已掷并记账，未了结，留给下个轴方增援阶段续掷', () => {
    const ctx = startScenario7(4)
    expect(ctx.w.variableExitStartRolled).toBe(true)
    expect(ctx.w.variableExitResolved).toBe(false)
    const rolls = setupRollEntries(ctx)
    expect(rolls).toHaveLength(1)
    expect(settlementData(rolls[0]!)).toMatchObject({ die: 4, kind: 'reroll' })
    // 2–5 不撤离任何师
    const ssReich = ctx.w.units.filter((unit) => unit.formation === 'SS-R')
    expect(ssReich.length).toBeGreaterThan(0)
  })

  it('掷出 1：开局即移除 SS Reich 全部（盘面与死亡堆），并标记已了结', () => {
    const ctx = startScenario7(1)
    expect(ctx.w.variableExitStartRolled).toBe(true)
    expect(ctx.w.variableExitResolved).toBe(true)
    expect(settlementData(setupRollEntries(ctx)[0]!)).toMatchObject({ die: 1, kind: 'remove' })
    // 1.6a：不论在盘面还是死亡堆，全部移出游戏
    expect(ctx.w.units.filter((unit) => unit.formation === 'SS-R')).toHaveLength(0)
    expect(
      ctx.w.deadPile.filter(
        (entry) => !('aircraft' in entry) && (entry as { formation?: string }).formation === 'SS-R',
      ),
    ).toHaveLength(0)
  })

  it('开局已了结 ⇒ 之后进入轴方增援阶段不再重复掷', () => {
    const ctx = startScenario7(1)
    const before = exitEntries(ctx).length
    ctx.w.setActiveSide('axis')
    ctx.w.setPhase('reinforcement')
    expect(ctx.w.rollVariableReplNow()).toBe(true)
    expect(exitEntries(ctx)).toHaveLength(before)
    expect(ctx.w.variableExitResolved).toBe(true)
  })
})
