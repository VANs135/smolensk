import { describe, expect, it } from 'vitest'

import { runAiSelfPlay, type AiSelfPlayReport } from '@/ai/driver'
import { replaySessionLog } from '@/engine/log-book'

import { fresh } from './flow-harness'

/**
 * 教学剧本 Intro: Vitebsk 的双 AI 自对打回归（人机对打作「自动找 bug」的第一站）
 *
 * 首跑（2026-11-15）暴露并修掉一个缺陷：一键预设先确认双方布设、再摆飞机，
 * 而 `canEditAirSetup` 要求游标停在该方 ⇒ Intro 的 7 枚德军飞机全部落不了位
 * （本图无轴方空军基地，须进图外空军盒），开局却照常成功 → 状态不一致。
 * 现在预设按「先落飞机、再确认本方」执行，无基地候选时落盒（1.4a）。
 *
 * 本用例把首跑要盯的东西钉住：初设零残留、单回合跑到终局、不卡死、不要人、
 * A–H 各段确有条目落日志、会话日志可复算。
 */

const SEED = 20261115

async function runIntro(): Promise<{
  report: AiSelfPlayReport
  ctx: ReturnType<typeof fresh>
  preset: ReturnType<ReturnType<typeof fresh>['setup']['presetSelfSetupNow']>
}> {
  const ctx = fresh()
  ctx.w.seed = SEED
  expect(ctx.setup.enterSetup('Intro')).toBe(true)
  const preset = ctx.setup.presetSelfSetupNow()
  expect(ctx.setup.startGameNow()).toBe(true)
  if (ctx.setup.setupDrawEntryVisible) expect(ctx.setup.drawSetupEffectsNow()).toBe(true)
  expect(ctx.setup.startGameNow()).toBe(true)
  const report = await runAiSelfPlay({
    ctx: { workbench: ctx.w, session: ctx.g, setup: ctx.setup },
    targetTurns: 1,
    scenarioId: 'Intro',
    limit: 1500,
  })
  return { report, ctx, preset }
}

describe('Intro 双 AI 自对打', () => {
  it('初设零残留：7 枚德军飞机进图外空军盒，开局盘面 47 个地面算子 + 7 枚飞机', () => {
    const ctx = fresh()
    ctx.w.seed = SEED
    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    const preset = ctx.setup.presetSelfSetupNow()
    expect(preset.failures).toEqual([])
    expect(preset.remaining).toBe(0)
    expect(preset.airPlaced).toBe(7)
    expect(ctx.setup.startGameNow()).toBe(true)
    expect(ctx.w.airUnits).toHaveLength(7)
    expect(ctx.w.units).toHaveLength(47)
  })

  it('单回合跑到终局：不卡死、不用等玩家、按剧本页判出胜负', async () => {
    const { report, ctx } = await runIntro()
    expect(report.stalls, `卡死：${report.stalls.join(' / ')}`).toEqual([])
    expect(report.noLegal).toBe(0)
    expect(report.awaiting).toBe(false)
    expect(report.terminated).toBe(true)
    expect(ctx.g.terminated).toBe(true)
    expect(
      ctx.w.log.some((entry) => entry.text.includes('剧本终局：剧本页胜利（Intro: Vitebsk）')),
    ).toBe(true)
  }, 300_000)

  it('A–H 各段确有条目落日志（整备 / 移动 / 战斗 / 撤退 / 挺进 / 补给）', async () => {
    const { ctx } = await runIntro()
    const rules = new Set(ctx.w.log.map((entry) => entry.rule))
    for (const rule of ['2.2', '6.1a', '9.1', '9.12', '9.12g', '12.4', '12.6'])
      expect(rules.has(rule), `日志缺少 ${rule} 段条目`).toBe(true)
  }, 300_000)

  it('会话日志可复算（状态一致）', async () => {
    const { ctx } = await runIntro()
    const replay = replaySessionLog(ctx.g.session!)
    expect(replay.ok, replay.detail).toBe(true)
  }, 300_000)
})
