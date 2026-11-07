import { nextTick } from 'vue'
import { expect } from 'vitest'

import { replaySessionLog } from '@/engine/log-book'

import { answerBoardChoices, fillSetup, fresh } from './flow-harness'

/**
 * 整回合冒烟的共用驱动（剧本 1–7 同一口径）
 *
 * 只回答**测试玩家**的盘面义务（补给损耗分摊、预备转战斗等），再推进一段；
 * 不含断言主题。死锁判据：「盘面状态 + 已落盘损耗数 + awaiting」连续 3 轮不变。
 */
export interface FullTurnSmokeResult {
  scenarioId: string
  ctx: ReturnType<typeof fresh>
  phases: string[]
  stalls: string[]
  iterations: number
  reachedNextTurn: boolean
}

export async function runFullTurnSmoke(
  scenarioId: string,
  limit = 4000,
): Promise<FullTurnSmokeResult> {
  const ctx = fresh()
  expect(ctx.setup.enterSetup(scenarioId), `剧本 ${scenarioId} 进入初设`).toBe(true)
  fillSetup(ctx)
  expect(ctx.setup.startGameNow(), `剧本 ${scenarioId} 开局`).toBe(true)
  await nextTick()

  const turn0 = ctx.w.turn
  const phases = new Set<string>()
  let sameState = 0
  let lastToken = ''
  const stalls: string[] = []
  let iterations = 0

  while (ctx.w.turn === turn0 && !ctx.g.terminated && iterations < limit) {
    phases.add(ctx.w.phase)
    answerBoardChoices(ctx)
    if (ctx.g.awaiting)
      expect(ctx.g.answerNow('first'), `剧本 ${scenarioId} 应答盘面问题`).toBe(true)
    else ctx.w.advanceSegmentNow()
    await nextTick()

    const state = `${ctx.w.turn}|${ctx.w.phase}|${ctx.w.activeSide}|${ctx.w.segmentStepIndex}`
    const token = `${state}|${ctx.w.attritionAppliedHexes.length}|${ctx.g.awaiting}`
    if (token === lastToken) {
      sameState += 1
      if (sameState >= 3) {
        const latest = ctx.w.log[0]
        stalls.push(
          `${state} :: ${latest ? `[${latest.kind}${latest.rule ? ` ${latest.rule}` : ''}] ${latest.text}` : '无日志'}（连续 ${sameState} 轮无推进、无落盘）`,
        )
        break
      }
    } else {
      sameState = 0
      lastToken = token
    }
    iterations += 1
  }

  return {
    scenarioId,
    ctx,
    phases: [...phases],
    stalls,
    iterations,
    reachedNextTurn: ctx.w.turn === turn0 + 1,
  }
}

const BASE_PHASES = [
  'aircraftRefit',
  'reinforcement',
  'movement',
  'supply',
  'reaction',
  'combat',
  'exploitation',
]

/** 每个剧本的最小闭环断言：无卡死、进第 2 回合、A–G 走遍、自动段结算、日志可复算。 */
export function expectFullTurnSmoke(result: FullTurnSmokeResult): void {
  const id = result.scenarioId
  expect(result.stalls, `剧本 ${id} 卡在：${result.stalls.join(' / ')}`).toEqual([])
  expect(result.reachedNextTurn, `剧本 ${id} 一个回合后应进入下一回合`).toBe(true)
  expect(result.iterations, `剧本 ${id} 驱动次数应在合理范围`).toBeLessThan(4000)
  expect(result.phases, `剧本 ${id} A–G 各玩家阶段都应被走到`).toEqual(
    expect.arrayContaining(BASE_PHASES),
  )
  expect(
    result.ctx.g.log.filter((e) => e.action === 'variableRepl'),
    `剧本 ${id} 双方各一次 A 段变数补充`,
  ).toHaveLength(2)
  expect(
    result.ctx.g.log.filter((e) => e.action === 'cleanUp'),
    `剧本 ${id} 双方各一次 H 段清理`,
  ).toHaveLength(2)
  const replay = replaySessionLog(result.ctx.g.session!)
  expect(replay.ok, `剧本 ${id} 会话日志复算：${replay.detail}`).toBe(true)
}
