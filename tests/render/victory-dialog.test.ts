import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import { evaluateFinalVictory, type VictoryAssessment } from '@/engine/rules'

import { terminationAssessment, victoryDialogView } from '@/components/victory/victory-dialog'

/**
 * 用户 2026-11-15（实机试玩第 1 项）：**对局结束要弹「判定胜利」的窗**。
 *
 * 口径：一窗一事、窗内不放描述性文字、条款号收进 `?`。
 * 本组钉住两件可测的事：
 *   ① 终止原因 → 该拿哪一份判定结论（5.0a 终局 / 5.0b 提前决胜）；
 *   ② 判定结论 → 窗内的「胜负 + 判定依据」事实行（Intro 看两格/补给，其余看所列格与城市）。
 */
const ALL_AXIS = (): Side => 'axis'
const ALL_SOVIET = (): Side => 'soviet'

function introAssessment(input: {
  controlOf: (hex: HexRef) => Side | null
  canTraceSupplyAt?: (hex: HexRef, side: Side) => boolean
}): VictoryAssessment {
  return evaluateFinalVictory({ scenarioId: 'Intro', ...input })
}

describe('判定胜利窗：终止原因 → 判定结论', () => {
  const final = introAssessment({ controlOf: ALL_AXIS })
  const decisive = introAssessment({ controlOf: ALL_AXIS })

  it('回合用尽 ⇒ 取 5.0a 的回合末判定；它没结论时退回最终评估', () => {
    const atEnd = introAssessment({ controlOf: ALL_AXIS })
    expect(
      terminationAssessment({
        termination: 'turnsExhausted',
        turnEnd: atEnd,
        final,
        decisive,
      }),
    ).toBe(atEnd)

    const ongoing = { ...atEnd, outcome: 'ongoing' as const }
    expect(
      terminationAssessment({
        termination: 'turnsExhausted',
        turnEnd: ongoing,
        final,
        decisive,
      }),
    ).toBe(final)
  })

  it('提前决胜 ⇒ 取 5.0b 的结论', () => {
    expect(
      terminationAssessment({
        termination: 'earlyDecision',
        turnEnd: final,
        final,
        decisive,
      }),
    ).toBe(decisive)
  })

  it('未终止 ⇒ 不弹（null）', () => {
    expect(
      terminationAssessment({
        termination: null,
        turnEnd: final,
        final,
        decisive,
      }),
    ).toBeNull()
  })
})

describe('判定胜利窗：Intro: Vitebsk 的胜负与依据', () => {
  it('两格维捷布斯克均轴控 ⇒ 轴心 Major Victory；依据是两格控制', () => {
    const view = victoryDialogView(introAssessment({ controlOf: ALL_AXIS }), 'Intro')
    expect(view.verdict).toBe('轴心 Major Victory')
    const row = view.rows.find((item) => item.label.includes('维捷布斯克'))
    expect(row?.value).toBe('两格均轴控')
  })

  it('未全控但苏方无法追溯抽象补给 ⇒ 轴心 Minor Victory；依据写明补给不可追溯', () => {
    const view = victoryDialogView(
      introAssessment({ controlOf: ALL_SOVIET, canTraceSupplyAt: () => false }),
      'Intro',
    )
    expect(view.verdict).toBe('轴心 Minor Victory')
    const supply = view.rows.find((item) => item.label === '苏方抽象补给')
    expect(supply?.value).toBe('不可追溯')
  })

  it('未全控且苏方仍能追溯 ⇒ 轴方失败；补给依据写「可追溯」', () => {
    const view = victoryDialogView(
      introAssessment({ controlOf: ALL_SOVIET, canTraceSupplyAt: () => true }),
      'Intro',
    )
    expect(view.verdict).toBe('轴方失败')
    const supply = view.rows.find((item) => item.label === '苏方抽象补给')
    expect(supply?.value).toBe('可追溯')
  })

  it('全控时不写补给行（该依据在本局不适用）', () => {
    const view = victoryDialogView(introAssessment({ controlOf: ALL_AXIS }), 'Intro')
    expect(view.rows.some((item) => item.label === '苏方抽象补给')).toBe(false)
  })
})

describe('判定胜利窗：其他剧本按 5.0a 的所列格与城市给依据', () => {
  it('轴方全控 ⇒ 轴心国胜，所列格读数为 11 / 11 且阈值进依据', () => {
    const assessment = evaluateFinalVictory({ scenarioId: '1', controlOf: ALL_AXIS })
    const view = victoryDialogView(assessment, '1')
    expect(view.verdict).toBe('轴心国胜')
    const axis = view.rows.find((item) => item.label === '轴控所列格')
    expect(axis?.value).toBe('11 / 11（需 ≥6）')
    const city = view.rows.find((item) => item.label === '轴方五城')
    expect(city?.value).toBe('已全控')
  })

  it('条款号只进 rule（界面由 RuleTip 显示 `?`），不进判定行', () => {
    const view = victoryDialogView(
      evaluateFinalVictory({ scenarioId: '1', controlOf: ALL_AXIS }),
      '1',
    )
    expect(view.rule).toBe('5.0a')
    expect(
      view.rows.every((item) => !item.label.includes('5.0') && !item.value.includes('5.0')),
    ).toBe(true)
  })
})

describe('判定胜利窗：挂在对局台上（单入口）', () => {
  it('GameTableView 挂载 VictoryDialog，且窗只在终止后打开', () => {
    const table = readFileSync('src/views/GameTableView.vue', 'utf8')
    const dialog = readFileSync('src/components/victory/VictoryDialog.vue', 'utf8')
    expect(table).toContain('<VictoryDialog')
    expect(dialog).toContain('判定胜利')
    expect(dialog).toContain('gameSession.terminated')
    expect(dialog).toContain('<RuleTip')
  })
})
