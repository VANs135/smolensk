import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { replaySessionLog } from '@/engine/log-book'

import { answerBoardChoices, fresh } from './flow-harness'

/**
 * Intro: Vitebsk 的**确定性**全程流程（初设 → 唯一的玩家回合 → 终局）
 *
 * 与 `intro-selfplay.test.ts` 的分工：
 * - 那边走 `runAiSelfPlay`（AI 会真的移动、开火，结果随策略/种子波动）；
 * - 这边只推阶段（`advanceSegmentNow`），由测试玩家替面板义务，不打仗、不移动，
 *   因此能**钉死**流程骨架：A→H 段级落账、终局类型、单方一次 Variable Repl / Cleanup、
 *   会话日志可复算。AI 用例查"规则算得对不对"，这条查"流程走得通不通"。
 *
 * Intro 是 `singlePlayerTurn: true` + `turns: 1`（只打 1 个轴方玩家回合），
 * 所以主线回归 `full-game-regressions.test.ts` 特意把它排除在外，另行覆盖。
 */

const SEED = 20261115

/** 预设初设（7 枚德机进图外空军盒，1.4a）+ 开局；任何残留都直接失败 */
function openIntro() {
  const ctx = fresh()
  ctx.w.seed = SEED
  expect(ctx.setup.enterSetup('Intro')).toBe(true)
  const preset = ctx.setup.presetSelfSetupNow()
  expect(preset.failures).toEqual([])
  expect(preset.remaining).toBe(0)
  expect(preset.airPlaced).toBe(7)
  expect(ctx.setup.startGameNow(), ctx.setup.lastAction?.detail).toBe(true)
  if (ctx.setup.setupDrawEntryVisible) expect(ctx.setup.drawSetupEffectsNow()).toBe(true)
  expect(ctx.setup.startGameNow(), ctx.setup.lastAction?.detail).toBe(true)
  return ctx
}

/**
 * 通规 5.7g：预备单位不得与环形工事同格跨过段末。
 *
 * 教学剧本把 18 Tk Div 预设在 19.26（有印刷工事），若一路只推阶段，段末就会被 5.7g 拒住。
 * 规则给的出口之一是按 5.7b 释放预备（另一个是移出工事格），这里替测试玩家做这一个动作，
 * 其余照旧不动手 —— 不放这一步，用例断言的「流程能走通」就不成立。
 */
function releaseReservesOnHedgehogs(w: ReturnType<typeof fresh>['w']): void {
  // 5.7b 的释放闸门只在「非阶段玩家的反应段移动环节」开（`reserve.release`），别处不开口
  if (w.phase !== 'reaction' || w.segmentStep?.id !== 'reaction.movement') return
  for (const unit of w.units) {
    if (unit.mode.mode !== 'reserve') continue
    // 5.7b：已释放的仍保留 `mode: 'reserve'`，只把 `releasedFromReserve` 置真 —— 那批不用再管
    if (unit.mode.releasedFromReserve === true) continue
    if (w.hedgehogLevelOf(unit.hex) === 0) continue
    w.selectedId = unit.instanceId
    expect(w.releaseReserveNow(), `${unit.name} 释放预备失败`).toBe(true)
  }
}

/** 只推阶段（不调 AI）；每步先替测试玩家答复面板义务，再推进 */
async function runThroughSingleTurn(ctx: ReturnType<typeof fresh>, limit = 400): Promise<number> {
  const turn0 = ctx.w.turn
  let steps = 0
  while (steps < limit && !ctx.g.terminated && ctx.w.turn <= turn0) {
    answerBoardChoices(ctx)
    releaseReservesOnHedgehogs(ctx.w)
    if (ctx.g.awaiting) expect(ctx.g.answerNow('first')).toBe(true)
    else ctx.w.advanceSegmentNow()
    steps += 1
    await nextTick()
  }
  expect(steps, '单回合未能在上限内推完（疑似卡死）').toBeLessThan(limit)
  expect(ctx.g.terminated).toBe(true)
  return steps
}

describe('Intro 确定性全程流程', () => {
  it('预设初设零残留：地面 47 个算子 + 7 枚飞机，开局即完成初设', () => {
    const ctx = openIntro()
    expect(ctx.w.units).toHaveLength(47)
    expect(ctx.w.airUnits).toHaveLength(7)
    expect(ctx.setup.pendingPlacement.filter((row) => row.remaining > 0)).toHaveLength(0)
    expect(ctx.setup.initialPlacementsComplete).toBe(true)
  })

  it(
    '走完唯一的玩家回合：A→H 逐段落账、终局为 turnsExhausted、单方一次 Variable Repl / Cleanup',
    { timeout: 120_000 },
    async () => {
      const ctx = openIntro()
      const steps = await runThroughSingleTurn(ctx)

      // 末回合打完后不越界（turns: 1 ⇒ 仍停在 turn 1），且停在 H 清理
      expect(ctx.w.turn).toBe(1)
      expect(ctx.g.termination).toBe('turnsExhausted')
      expect(ctx.w.phase).toBe('cleanUp')
      // 空回合（不移动、不开火）：维捷布斯克两格未全控 ⇒ 剧本页判轴方失败
      expect(ctx.w.log.some((entry) => entry.text.includes('⇒ 轴方失败'))).toBe(true)

      // 单方回合：Variable Repl / Cleanup / 终局各一次，补给追溯只算一轮
      const actions = ctx.g.log.map((entry) => entry.action)
      for (const action of ['variableRepl', 'cleanUp', 'finalVictory', 'terminate']) {
        expect(actions.filter((item) => item === action)).toHaveLength(1)
      }
      expect(actions.filter((item) => item === 'supplyTrace')).toHaveLength(1)
      // 整回合：A→H 每进入一个新阶段都会落一条 phase 日志（至少 8 段）
      expect(actions.filter((item) => item === 'phase').length).toBeGreaterThanOrEqual(8)

      // 段级日志：环节（2.1/2.2）、补给缓存（1.7）、图上供养（12.6c）都真落过账
      const rules = new Set(ctx.w.log.map((entry) => entry.rule))
      for (const rule of ['2.1', '2.2', '1.7', '12.6c']) {
        expect(rules.has(rule), `日志缺少 ${rule} 段条目`).toBe(true)
      }

      // 5.0b 提前决胜明确不适用于单回合剧本
      expect(ctx.w.decisiveVictory.detail).toContain('只有 1 个玩家回合')

      // 推完即会话日志自洽（可复算）
      const replay = replaySessionLog(ctx.g.session!)
      expect(replay.ok, replay.detail).toBe(true)
      expect(steps).toBeGreaterThan(10)
    },
  )
})
