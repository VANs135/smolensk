import { describe, expect, it } from 'vitest'

import { fresh, progress } from './flow-harness'

/**
 * 反应阶段换观察方（10.x）：**玩家回合归属与阶段账本**不变
 *
 * 用户 2026-11-11 口径：换手不自动切视角 ⇒ 观察方只由 `setViewerSide` 手动改；
 * 改视角不得翻转行动方、不得动指导步骤、不得清阶段账本。
 *
 * 从 `full-game-regressions.test.ts` 拆出：该用例与整局回归无共享状态，
 * 单独成文件既便于定位，也避免它在整局大文件里被长时间占用。
 */
describe('反应阶段换观察方：不改玩家回合归属或清空阶段账本', () => {
  it('观察方不自动翻面；手动换视角不动行动方 / 指导步骤 / 阶段账本', async () => {
    const ctx = fresh()
    ctx.hot.setMode('pvp')
    ctx.g.startGame()
    await progress(ctx, () => ctx.w.phase === 'reaction')
    // 反应阶段的决策方是苏方，但观察方不自动跟过去（默认建局时的行动方）
    expect(ctx.hot.viewerSide).toBe('axis')
    const side = ctx.w.activeSide
    const ledger = ctx.w.attackPhaseLedger
    ctx.hot.setViewerSide('soviet')
    expect(ctx.hot.viewerSide).toBe('soviet')
    expect(ctx.w.activeSide).toBe(side)
    expect(ctx.g.guidance?.step.id).toBe('first.reaction')
    ctx.hot.setViewerSide('axis')
    expect(ctx.hot.viewerSide).toBe('axis')
    expect(ctx.w.attackPhaseLedger).toEqual(ledger)
  })
})
