import { describe, expect, it } from 'vitest'
import { createRngState, roll1d6 } from '@/engine/rng'
import { fresh } from '../flows/flow-harness'

/**
 * 3.3c + 1.6b 记账：同一批 8 颗骰只能入账一次。
 *
 * 真实序列（`rollVariableReplNow`，autoRoll=true）：
 *   0) 剧本 7 开局已按剧本页「Roll for Variable Exit」掷过 1 颗（种子首骰），并已了结；
 *   1) 增援窗先掷 8 颗骰（2+2+1+1+2），由 `rng` setter 进 `pendingRolls`；
 *   2) 撤离已了结，不再掷、也不再结算；
 *   3) 可变增援结算（`variableRepl`，带显式 rolls）。
 *
 * 修前 (2) 的 `recordSettlement` 会把 `pendingRolls` 全吃掉，(3) 又记一遍显式骰
 * ⇒ 日志 16 颗、重放游标 +8。修后 (2) 传 `consumePendingRolls: false`，骰只记在 (3)。
 */
describe('3.3c / 1.6b：可变撤离与可变增援不重复记骰', () => {
  it('撤离结算不消费 variableRepl 的 8 颗骰', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('7')).toBe(true)
    const preset = ctx.setup.presetSelfSetupNow()
    expect(preset.failures).toEqual([])
    expect(preset.remaining).toBe(0)
    // E4：种子只能在开局前设定（开局后锁定）；先定种子，再建会话
    ctx.w.seed = seedWithVariableExitRemove()
    expect(ctx.setup.startGameNow()).toBe(true)

    const w = ctx.w
    w.setPhase('reinforcement')
    w.setActiveSide('axis')
    expect(w.variableReplInputs.autoRoll).toBe(true)
    // 开局那颗已掷出 1（remove）⇒ 增援阶段不再掷，也不应再出现 variableExit 结算
    expect(w.variableExitStartRolled).toBe(true)
    expect(w.variableExitResolved).toBe(true)
    expect(w.rollVariableReplNow()).toBe(true)
    expect(w.lastVariableRepl?.variableExit ?? null).toBeNull()

    const ledger = (ctx.g.session?.log ?? []).filter(
      (entry) => entry.action === 'variableExit' || entry.action === 'variableRepl',
    )
    const exit = ledger.find((entry) => entry.action === 'variableExit')
    const repl = ledger.find((entry) => entry.action === 'variableRepl')
    const facesOf = (entry: (typeof ledger)[number] | undefined) =>
      (entry?.rolls ?? []).reduce((n, roll) => n + roll.faces.length, 0)
    const totalDice = ledger.reduce((n, entry) => n + facesOf(entry), 0)

    expect(facesOf(exit)).toBe(1)
    expect(facesOf(repl)).toBe(8)
    expect(totalDice).toBe(9)
  })
})

/** 找一枚让「开局第一颗」可变撤离骰为 1（remove SS Reich）的种子，免得测试依赖随机结果 */
function seedWithVariableExitRemove(limit = 20000): number {
  for (let seed = 1; seed <= limit; seed++) {
    const exit = roll1d6(createRngState(seed))
    if (exit.value.total === 1) return seed
  }
  throw new Error(`未在 1..${limit} 找到可变撤离首掷为 1 的种子`)
}
