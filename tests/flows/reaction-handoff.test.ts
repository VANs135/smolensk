import { describe, expect, it } from 'vitest'

import { fresh, progress } from './flow-harness'

/**
 * 反应交接（10.x）：**玩家回合归属与阶段账本**在「交接 / 取消交接」下不变
 *
 * 从 `full-game-regressions.test.ts` 拆出（代码未改）：该用例与整局回归无共享状态，
 * 单独成文件既便于定位，也避免它在整局大文件里被长时间占用（实测单跑 84–99 ms，
 * 整仓并行下曾观测到 ~20 s 的排队/调度放大）。
 */
describe('反应交接：不改玩家回合归属或清空阶段账本', () => {
  it('反应交接与取消交接不改玩家回合归属或清空阶段账本', async () => {
    const ctx = fresh()
    ctx.hot.setMode('pvp')
    ctx.g.startGame()
    await progress(ctx, () => ctx.w.phase === 'reaction')
    expect(ctx.hot.viewerSide).toBe('soviet')
    const side = ctx.w.activeSide
    const ledger = ctx.w.attackPhaseLedger
    ctx.hot.beginHandoff()
    expect(ctx.w.activeSide).toBe(side)
    expect(ctx.g.guidance?.step.id).toBe('first.reaction')
    ctx.hot.cancelHandoff()
    expect(ctx.hot.viewerSide).toBe('soviet')
    expect(ctx.w.attackPhaseLedger).toEqual(ledger)
  })
})
