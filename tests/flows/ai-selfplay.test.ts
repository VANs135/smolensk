import { describe, expect, it } from 'vitest'

import { replaySessionLog } from '@/engine/log-book'
import { scenarios } from '@/data'

import { fresh } from './flow-harness'
import { runAiSelfPlay, type AiSelfPlayReport } from '@/ai/driver'

const SEED = 20260913

/** 七个剧本各自的目标回合数：剧本 1 跑 8 回合，其余 min(5, 总回合数)。 */
function targetTurnsOf(scenarioId: string): number {
  if (scenarioId === '1') return 8
  const spec = scenarios.scenarios.find((item) => item.id === scenarioId)
  return Math.min(5, spec?.turns ?? 5)
}

function whereOf(id: string, report: AiSelfPlayReport): string {
  return (
    `剧本 ${id} 第 ${report.turn} 回合 / 阶段 ${report.phase} / 环节 ${report.segment} / ` +
    `行动方 ${report.activeSide}`
  )
}

function describeReport(id: string, report: AiSelfPlayReport): void {
  console.log(
    `[AI 对打] 剧本 ${id}：回合 ${report.turn}（目标 ${report.targetTurn}）` +
      `阶段 ${report.phase} 环节 ${report.segment} 行动方 ${report.activeSide}` +
      ` | iterations=${report.iterations} stalls=${report.stalls.length}` +
      ` refused=${JSON.stringify(report.refusedByRule)} warnings=${report.warnings.length}` +
      ` noLegal=${report.noLegal} awaiting=${report.awaiting} terminated=${report.terminated}`,
  )
}

/**
 * 预期内的拒绝白名单：对打里**只允许**出现这些 rule。
 *
 * 这些拒绝都是「AI 按既有投影试探性提交 → 引擎/入口按规则拒绝」的结果，不是判定错误，
 * 也不该被当成失败；列在这里是为了「以后新增的拒绝 ⇒ 立即红」，避免红绿不分。
 */
const EXPECTED_REFUSALS: Readonly<Record<string, string>> = {
  '12.5a':
    'AI 会尝试开拔未加注燃料的轮式/履带战斗单位；12.5a 要求先付燃料才能消耗 MP ⇒ 拒绝（加油决策不在 B3 基线内）',
  '13.2a':
    '有运输点数处于「暂停移动」时 AI 仍会尝试开拔其它单位；13.2a 要求先让它继续并完成移动 ⇒ 拒绝',
  '10.0e-D':
    'AI 在移动段按候选尝试火炮轰炸；10.0e-D 只允许在战斗/反应/进击段轰炸 ⇒ 拒绝（阶段门槛由引擎裁决）',
  '9.1a':
    '战斗候选取自「相邻敌格 + 存在 attackCapable 友军」的投影，入口另要求 isCombat / 空运后可攻击 ⇒ 部分候选按 9.1a 拒绝（试探性提交）',
  '12.4':
    'AI 取第一个补给站支付战斗补给；该站 0 SP / 0 T 时 12.4 判「无法满足」⇒ 拒绝（基线不做补给站优选，随后走 combatSkip）',
}

function expectOnlyExpectedRefusals(id: string, report: AiSelfPlayReport): void {
  const where = whereOf(id, report)
  const unexpected = Object.keys(report.refusedByRule).filter(
    (rule) => EXPECTED_REFUSALS[rule] === undefined,
  )
  const samples = report.refused
    .filter((entry) => EXPECTED_REFUSALS[entry.rule] === undefined)
    .slice(0, 5)
    .map((entry) => `${entry.rule}｜${entry.intent}｜${entry.reason}`)
  expect(
    unexpected,
    `${where} 出现白名单外的拒绝：${unexpected.join('、')}${samples.length === 0 ? '' : `；样例 ${samples.join(' / ')}`}`,
  ).toEqual([])
}

function expectClean(id: string, report: AiSelfPlayReport): void {
  const where = whereOf(id, report)
  expect(report.stalls, `${where} 卡死：${report.stalls.join(' / ')}`).toEqual([])
  expect(report.noLegal, `${where} 无合法动作（noLegal=${report.noLegal}）`).toBe(0)
  expect(report.awaiting, `${where} 仍有未处理的 awaiting`).toBe(false)
  expect(
    report.reachedTarget || report.terminated,
    `${where} 未达到目标回合 ${report.targetTurn}，也未正常终止`,
  ).toBe(true)
}

async function runScenario(id: string): Promise<{
  report: AiSelfPlayReport
  ctx: ReturnType<typeof fresh>
}> {
  const ctx = fresh()
  // 回归必须显式设种子（B28：同一颗 PRNG）
  ctx.w.seed = SEED
  expect(ctx.setup.enterSetup(id), `剧本 ${id} 进入初设`).toBe(true)
  const preset = ctx.setup.presetSelfSetupNow()
  expect(preset.failures, `剧本 ${id} 一键预设初设失败`).toEqual([])
  expect(preset.remaining, `剧本 ${id} 一键预设初设未完成`).toBe(0)
  expect(ctx.setup.startGameNow(), `剧本 ${id} 开局`).toBe(true)
  const report = await runAiSelfPlay({
    ctx: { workbench: ctx.w, session: ctx.g, setup: ctx.setup },
    targetTurns: targetTurnsOf(id),
    scenarioId: id,
    limit: 1500,
  })
  return { report, ctx }
}

describe('B3 AI 对打回归', () => {
  for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
    it(`剧本 ${id} 双 AI 对打`, async () => {
      const { report, ctx } = await runScenario(id)
      describeReport(id, report)
      expectClean(id, report)
      expectOnlyExpectedRefusals(id, report)
      const replay = replaySessionLog(ctx.g.session!)
      expect(replay.ok, `${whereOf(id, report)} 会话日志复算：${replay.detail}`).toBe(true)
    }, 300_000)
  }

  it('剧本 1 同种子两次 ⇒ 完全一致', async () => {
    const first = await runScenario('1')
    const second = await runScenario('1')
    // instanceId 含 `Date.now()`（`shared/id.ts`）⇒ 跨进程必然不同；比**单位型号 + 位置**的多重集
    const positions = (ctx: ReturnType<typeof fresh>) =>
      ctx.w.units.map((unit) => `${unit.unitId}@${unit.hex.col}.${unit.hex.row}`).sort()
    const signature = (ctx: ReturnType<typeof fresh>) => ({
      turn: ctx.w.turn,
      phase: ctx.w.phase,
      activeSide: ctx.w.activeSide,
      positions: positions(ctx),
      drawCount: ctx.w.drawCount,
    })
    expect(signature(first.ctx), `${whereOf('1', first.report)} 确定性（第一次）`).toEqual(
      signature(second.ctx),
    )
  }, 900_000)
})
