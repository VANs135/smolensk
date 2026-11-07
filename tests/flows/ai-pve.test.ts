import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import { createAiMemory, runAiStep, type AiContext } from '@/ai/driver'
import { replaySessionLog } from '@/engine/log-book'

import { fillSetup, fresh } from './flow-harness'

const AXIS_CAP = 20260913

/**
 * B4：PVE 控制方回归
 *
 * 甲）**分方初设**：`onlySide` 只预设 AI 控制的一方，另一方保留自由落位。
 * 乙）**AI 打轴心**：测试驱动苏联侧（`control: 'soviet'`）模拟玩家，跑到第 2 回合，
 *     断言 AI 没有替玩家作答、也没有在玩家行动环节擅自推进。
 */
function openAxisOnlyGame(): { ctx: ReturnType<typeof fresh>; remaining: number } {
  const ctx = fresh()
  ctx.w.seed = AXIS_CAP
  expect(ctx.setup.enterSetup('1'), '剧本 1 进入初设').toBe(true)
  const preset = ctx.setup.presetSelfSetupNow({ onlySide: 'axis' })
  expect(preset.failures, `轴心单方预设失败：${JSON.stringify(preset.failures)}`).toEqual([])
  return { ctx, remaining: preset.remaining }
}

describe('B4 PVE 控制方回归', () => {
  it('分方初设：只预设 AI 一方，玩家侧保留自由落位', () => {
    const { ctx, remaining } = openAxisOnlyGame()
    expect(remaining, '轴心预设后仍应有玩家侧待落位').toBeGreaterThan(0)
    expect(ctx.setup.setupSideCursor, '轴心确认后轮次应交给苏联').toBe('soviet')
    const sovietPending = ctx.setup.pendingPlacement.filter(
      (item) => item.remaining > 0 && item.side === 'soviet',
    )
    expect(sovietPending.length, '苏联侧自由项不应被 AI 落位').toBeGreaterThan(0)
  })

  it('AI 打轴心：玩家侧决定不由 AI 代办（跑到第 2 回合）', async () => {
    const { ctx } = openAxisOnlyGame()
    // 玩家侧由测试补完（真实玩家会自己点自由落位）
    fillSetup(ctx)
    expect(ctx.setup.startGameNow(), '开局').toBe(true)

    const aiCtx: AiContext = { workbench: ctx.w, session: ctx.g, setup: ctx.setup }
    const axisMemory = createAiMemory()
    const playerMemory = createAiMemory()

    const violations: string[] = []
    let axisAnswers = 0
    let axisActions = 0
    let playerAnswers = 0
    let playerDecisions = 0
    let stall = ''

    for (let n = 0; n < 4000 && ctx.w.turn < 2 && !ctx.g.terminated; n += 1) {
      const before = {
        awaiting: ctx.g.awaiting,
        responder: ctx.g.question?.responder ?? null,
        activeSide: ctx.w.activeSide,
        locked: ctx.w.segmentLocked,
        canSize: ctx.w.segmentActionKeys.size,
        inCombat: ctx.w.combatState !== null,
        inBarrage: ctx.w.barrageState !== null,
        setup: ctx.w.initialSetupInProgress,
      }

      const axis = runAiStep(aiCtx, { memory: axisMemory, control: 'axis' })

      // ① 玩家应答：AI 必须停手并给出等待文案
      if (before.awaiting && before.responder !== 'axis') {
        if (axis.intent !== 'wait' || axis.waiting === undefined || axis.waiting === '')
          violations.push(
            `回合 ${String(ctx.w.turn)} 环节 ${ctx.w.segmentStep?.id ?? ''}：` +
              `应答方=${before.responder ?? '?'}，AI 却执行了 ${axis.intent}（应停下等待）`,
          )
      }
      if (axis.intent === 'answer') {
        if (before.responder !== 'axis')
          violations.push(`AI 替 ${before.responder ?? '?'} 作答（answer）`)
        else axisAnswers += 1
      }
      if (axis.intent !== 'wait' && axis.intent !== 'none') axisActions += 1

      // ② 玩家行动环节：AI 不得擅自推进有可做动作的环节
      if (
        before.activeSide === 'soviet' &&
        !before.locked &&
        !before.setup &&
        !before.inCombat &&
        !before.inBarrage &&
        before.canSize > 0 &&
        axis.intent !== 'wait'
      )
        violations.push(
          `回合 ${String(ctx.w.turn)} 环节 ${ctx.w.segmentStep?.id ?? ''}：` +
            `轮到苏联行动（可做 ${before.canSize} 类动作），AI 却执行了 ${axis.intent}`,
        )

      if (violations.length > 0) break

      // ③ 玩家侧待办 ⇒ 由测试用 `control: 'soviet'` 驱动（真实玩家会自己点）
      if (axis.intent === 'wait') {
        if (ctx.g.awaiting) {
          expect(ctx.g.question?.responder, 'AI 等待时应是苏联方的待答').toBe('soviet')
          expect(ctx.g.answerNow('first'), '玩家作答').toBe(true)
          playerAnswers += 1
        } else {
          const player = runAiStep(aiCtx, { memory: playerMemory, control: 'soviet' })
          if (player.intent === 'wait') {
            stall = `双方都停：${axis.waiting ?? ''} / ${player.waiting ?? ''}`
            break
          }
          if (player.intent !== 'advance' && player.intent !== 'none') playerDecisions += 1
        }
      }

      await nextTick()
    }

    expect(stall, 'PVE 出现双方都停').toBe('')
    expect(violations, `AI 越权：${violations.join(' / ')}`).toEqual([])
    expect(axisAnswers, 'AI 的作答只能发给轴心方').toBeLessThanOrEqual(axisActions)
    expect(axisActions, '轴心方应由 AI 实际推进').toBeGreaterThan(0)
    expect(playerAnswers + playerDecisions, '苏联侧至少要由玩家完成一次应答/结算').toBeGreaterThan(
      0,
    )
    expect(ctx.w.turn, '应跑到第 2 回合').toBeGreaterThanOrEqual(2)

    const replay = replaySessionLog(ctx.g.session!)
    expect(replay.ok, `会话日志复算：${replay.detail}`).toBe(true)
  }, 300_000)
})
