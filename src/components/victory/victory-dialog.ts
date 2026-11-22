import type { VictoryAssessment } from '@/engine/rules'
import { INTRO_SCENARIO_ID } from '@/engine/rules'

/**
 * 判定胜利窗的**只读投影**（用户 2026-11-15 实机试玩第 1 项）
 *
 * 界面口径：一窗一事、窗内不放描述性文字、条款号收进 `?`。
 * 故本模块只把引擎给出的 `VictoryAssessment` 折成「胜负 + 判定依据事实行」，
 * 不重算任何规则；条款原文与 `detail` 由组件放进 `RuleTip`（`?`）。
 */

/** 判定依据的一行事实（label 是判据名，value 是读数） */
export interface VictoryDialogRow {
  label: string
  value: string
  /** 该判据是否满足（null = 只是事实，不做达成标记） */
  ok: boolean | null
}

/** 窗内要显示的全部内容 */
export interface VictoryDialogView {
  verdict: string
  tone: 'success' | 'danger' | 'warning'
  rows: readonly VictoryDialogRow[]
  /** 判定的规则依据（进 `?`，不进正文） */
  rule: string
}

/** 终止原因（与会话层同一词表；未终止为 null） */
export type TerminationReason = 'turnsExhausted' | 'earlyDecision' | null

/**
 * 终止原因 → 该拿哪一份判定结论
 *
 * - 回合用尽（专规 5.0a）：取回合末检查；它只在最终回合给结论，没结论时退回最终评估；
 * - 提前决胜（专规 5.0b）：取提前决胜的结论；
 * - 未终止：null（不弹窗）。
 */
export function terminationAssessment(input: {
  termination: TerminationReason
  turnEnd: VictoryAssessment
  final: VictoryAssessment
  decisive: VictoryAssessment
}): VictoryAssessment | null {
  if (input.termination === null) return null
  if (input.termination === 'earlyDecision') return input.decisive
  return input.turnEnd.outcome === 'ongoing' ? input.final : input.turnEnd
}

/** 胜负文字与色调 */
function verdictOf(
  assessment: VictoryAssessment,
  intro: boolean,
): { verdict: string; tone: VictoryDialogView['tone'] } {
  if (intro) {
    if (assessment.grade === 'major') return { verdict: '轴心 Major Victory', tone: 'success' }
    if (assessment.grade === 'minor') return { verdict: '轴心 Minor Victory', tone: 'success' }
    if (assessment.outcome === 'axis') return { verdict: '轴心 Major Victory', tone: 'success' }
    return { verdict: '轴方失败', tone: 'danger' }
  }
  if (assessment.outcome === 'axis') return { verdict: '轴心国胜', tone: 'success' }
  if (assessment.outcome === 'soviet') return { verdict: '苏军胜', tone: 'success' }
  if (assessment.outcome === 'draw') return { verdict: 'Draw', tone: 'warning' }
  return { verdict: '未判定', tone: 'warning' }
}

/** Intro: Vitebsk：两格是否轴控；未全控时补一行「苏方补给是否可追溯」 */
function introRows(assessment: VictoryAssessment): VictoryDialogRow[] {
  const city = assessment.summary.axisCities.find((item) => item.name === 'Vitebsk')
  const hexText = (city?.hexes ?? []).map((hex) => `${hex.col}.${hex.row}`).join(' + ')
  const held = city?.held === true
  const rows: VictoryDialogRow[] = [
    {
      label: `维捷布斯克（${hexText}）`,
      value: held ? '两格均轴控' : '未全部轴控',
      ok: held,
    },
  ]
  if (!held) {
    rows.push({
      label: '苏方抽象补给',
      value: assessment.grade === 'minor' ? '不可追溯' : '可追溯',
      ok: null,
    })
  }
  return rows
}

/** 专规 5.0a / 专规 5.0b：所列格读数（带阈值）与两城/五城的全控状态 */
function standardRows(assessment: VictoryAssessment): VictoryDialogRow[] {
  const total = assessment.summary.listedTotal
  const tier = assessment.thresholds
  const rows: VictoryDialogRow[] = [
    {
      label: '轴控所列格',
      value:
        tier === null
          ? `${assessment.summary.listedBySide.axis} / ${total}`
          : `${assessment.summary.listedBySide.axis} / ${total}（需 ≥${tier.axisListedHexes}）`,
      ok: tier === null ? null : assessment.summary.listedBySide.axis >= tier.axisListedHexes,
    },
    {
      label: '苏控所列格',
      value:
        tier === null
          ? `${assessment.summary.listedBySide.soviet} / ${total}`
          : `${assessment.summary.listedBySide.soviet} / ${total}（需 ≥${tier.sovietListedHexes}）`,
      ok: tier === null ? null : assessment.summary.listedBySide.soviet >= tier.sovietListedHexes,
    },
    {
      label: '轴方五城',
      value: assessment.summary.axisCitiesAllHeld ? '已全控' : '未全控',
      ok: assessment.summary.axisCitiesAllHeld,
    },
    {
      label: '苏方两城',
      value: assessment.summary.sovietCitiesAllHeld ? '已全控' : '未全控',
      ok: assessment.summary.sovietCitiesAllHeld,
    },
  ]
  return rows
}

/** 判定结论 → 窗内视图（胜负 + 依据行；不含描述性文字） */
export function victoryDialogView(
  assessment: VictoryAssessment,
  scenarioId: string,
): VictoryDialogView {
  const intro = scenarioId === INTRO_SCENARIO_ID
  const { verdict, tone } = verdictOf(assessment, intro)
  return {
    verdict,
    tone,
    rows: intro ? introRows(assessment) : standardRows(assessment),
    rule: assessment.rule,
  }
}
