import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import { replaySessionLog } from '@/engine/log-book'

import { answerBoardChoices, fresh, fillSetup } from './flow-harness'

/**
 * P9：剧本 1 的**端到端一回合冒烟**（引擎 + store 驱动，不依赖点击）
 *
 * 目的不是复核某条规则，而是回答一个更基础的问题：
 *   初设落位 → A 整备 → B 增援 → C 移动 → D 补给 → E 反应 → F 战斗 → G 进击 → H 清理 → 第 2 回合
 * 这条链在 store 层能不能**自己走完**，且中途不出现「没有合法动作、阶段也不前进」的卡死。
 *
 * 死锁判据：每一轮先处理玩家义务（补给损耗分摊等，与 `flow-harness.progress` 同口径），
 * 再推进一段。若「盘面状态 + 已落盘损耗数」连续 3 轮完全不变即判定卡死——
 * 说明既没有推进，也没有任何合法动作被真正执行。断言消息带当场最后一条日志。
 */
describe('P9：剧本 1 完整一回合端到端冒烟', () => {
  it('初设后从 A 段走到第 2 回合，全程无死锁', async () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    fillSetup(ctx)
    expect(ctx.setup.startGameNow()).toBe(true)
    await nextTick()

    const phases = new Set<string>()
    let sameState = 0
    let lastToken = ''
    const stalls: string[] = []
    let iterations = 0

    while (ctx.w.turn === 1 && !ctx.g.terminated && iterations < 4000) {
      phases.add(ctx.w.phase)
      answerBoardChoices(ctx)
      if (ctx.g.awaiting) expect(ctx.g.answerNow('first')).toBe(true)
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

    expect(stalls, `卡在：${stalls.join(' / ')}`).toEqual([])
    expect(ctx.w.turn, '一个回合后应进入第 2 回合').toBe(2)
    expect(iterations, '驱动次数应在合理范围').toBeLessThan(4000)
    // 停在过的玩家段（H 清理是自动段，不停留，故不在此集合里，另由会话日志证明已执行）
    expect([...phases], 'A–G 各玩家阶段都应被走到').toEqual(
      expect.arrayContaining([
        'aircraftRefit',
        'reinforcement',
        'movement',
        'supply',
        'reaction',
        'combat',
        'exploitation',
      ]),
    )
    // 双方各一次 A 段变数补充 + H 段清理，证明自动段也真正结算了
    expect(ctx.g.log.filter((e) => e.action === 'variableRepl')).toHaveLength(2)
    expect(ctx.g.log.filter((e) => e.action === 'cleanUp')).toHaveLength(2)
    const replay = replaySessionLog(ctx.g.session!)
    expect(replay.ok, replay.detail).toBe(true)
  }, 60000)
})
