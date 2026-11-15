import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { runAiSelfPlay } from '@/ai/driver'

import { fresh } from './flow-harness'

/**
 * 教学剧本的**空军任务**回归（14.2f / 14.3 / 14.4 / 14.5 / 14.1c）
 *
 * 首跑日志里一条 14.x 都没有：AI 只会走地面。本用例钉住两件事：
 *   1. 正常天气（开局天气选 Normal）时 AI 会宣布低空扫射，并走完
 *      宣布（14.2f-A）→ 空战（14.3c）→ 拦截应答（14.5）→ 防空（14.4f）→ 结算 → 返航（14.1c）；
 *   2. 天气受限时按原文**不飞**（引擎闸门不给 `air.mission`，策略不另设放宽）。
 */

// 种子按「必须覆盖 14.4f 防空命中」挑：20261123 的骰序让低空扫射真的挨了防空
// （2d6 ≥ 11），从而走到 14.4f 的损失归属；其余条款同序列一并覆盖。
const SEED = 20261123

async function runIntro(command: { weatherNormal: boolean }) {
  const ctx = fresh()
  ctx.w.seed = SEED
  expect(ctx.setup.enterSetup('Intro')).toBe(true)
  if (command.weatherNormal) expect(ctx.g.setFirstWeatherChoice('normal')).toBe(true)
  expect(ctx.setup.presetSelfSetupNow().remaining).toBe(0)
  expect(ctx.setup.startGameNow()).toBe(true)
  if (ctx.setup.setupDrawEntryVisible) expect(ctx.setup.drawSetupEffectsNow()).toBe(true)
  expect(ctx.setup.startGameNow()).toBe(true)
  // 空军输入由 `records.weather` 经 watch 同步，等一拍再跑 AI
  await nextTick()
  const report = await runAiSelfPlay({
    ctx: { workbench: ctx.w, session: ctx.g, setup: ctx.setup },
    targetTurns: 1,
    scenarioId: 'Intro',
    limit: 1500,
  })
  return { ctx, report }
}

describe('Intro 双 AI 自对打：空军任务', () => {
  it('正常天气会飞任务：14.2f-A / 14.3c / 14.5 / 14.4f / 14.1c 都落日志，且不卡死', async () => {
    const { report } = await runIntro({ weatherNormal: true })
    // 日志只留 60 条（`pushLog` 上限）⇒ 覆盖按驱动累积的规则号判，别读末态日志
    const rules = new Set(report.rules)
    for (const rule of ['14.2f-A', '14.3c', '14.5', '14.4f', '14.1c'])
      expect(rules.has(rule), `日志缺少 ${rule}；实际 ${[...rules].join(',')}`).toBe(true)
    expect(report.stalls, report.stalls.join(' / ')).toEqual([])
    expect(report.terminated).toBe(true)
  }, 300_000)

  it('天气受限按原文不飞：没有 14.2f-A，也照常到终局', async () => {
    const { report } = await runIntro({ weatherNormal: false })
    expect(report.rules).not.toContain('14.2f-A')
    expect(report.stalls, report.stalls.join(' / ')).toEqual([])
    expect(report.terminated).toBe(true)
  }, 300_000)
})
