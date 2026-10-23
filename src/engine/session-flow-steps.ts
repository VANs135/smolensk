import type { Side } from '@/data'

import type { SessionQuestion } from './session-types'
import type { GamePhase, PreTurnSegment, Records } from './state-types'
import { PRE_TURN_SEGMENTS } from './state-types'
import { PLAYER_TURN_PHASES } from './turn-driver'

/**
 * 2.2 流程表的**步骤清单**（W6 C10 的逐步引导数据）
 *
 * ## 条文依据
 *   - **2.2 流程表**（源库 charts.json → tables.sop）：回合 = Pre-Turn（天气判定 → 先手判定）
 *     → 先手方 A–H → 后手方 A–H → 回合结束，故一个回合共 **19 步**（2 + 8×2 + 1）；
 *   - **逐步分类**（见 turn-driver 文件头的【全自动】/【玩家参与】逐段核对）：
 *     · Pre-Turn 天气判定、H 清理、Turn End 为**全自动**（引擎掷骰/结算，玩家无输入）；
 *     · Pre-Turn 先手判定为**待答**（2.3：胜者选择先手或后手）；
 *     · A–G 七段为**玩家参与**（引擎自动算基准，具体动作由玩家在段内做）。
 *
 * 本文件只描述「流程长什么样」，不含任何结算逻辑（结算在 session-flow.ts）。
 */

/* ────────────────────────────── 步骤类型 ────────────────────────────── */

/**
 * 该步归属的回合角色
 *
 * - `turn`  回合级（Pre-Turn / Turn End）：没有行动方；
 * - `first` 先手方回合的 A–H；
 * - `second` 后手方回合的 A–H。
 */
export type SopStepRole = 'turn' | 'first' | 'second'

/** 该步的驱动方式（决定界面徽标与是否需要盘面操作） */
export type SopStepDriver =
  /** 引擎自动结算，玩家无输入 */
  | 'automatic'
  /** 引擎自动结算 + 玩家在段内做盘面操作（移动/战斗/补给…） */
  | 'player'
  /** 停下来等玩家作答（先手判定 2.3） */
  | 'question'

/** 流程的一步 */
export interface SopStep {
  /** 稳定标识（`preTurn.weatherDetermination` / `first.movement` / `turnEnd`） */
  id: string
  /** 归属角色 */
  role: SopStepRole
  /** 该步所在阶段（与 turn-driver 的阶段机同源） */
  phase: GamePhase
  /** 驱动方式 */
  driver: SopStepDriver
  /** 该步的中文名（2.2 流程表的段名） */
  label: string
  /** 该步的规则依据（段的归属章） */
  rule: string
}

/** 逐步引导结论 */
export interface SopGuidance {
  step: SopStep
  /** 步骤序号（0 起） */
  index: number
  /** 步骤总数 */
  total: number
}

/* ────────────────────────────── 段名与规则章 ────────────────────────────── */

/** 玩家回合八段（A–H）的段名与该段归属章（与 legality 的动作清单同源） */
const SEGMENT_INFO: Record<
  (typeof PLAYER_TURN_PHASES)[number],
  { label: string; rule: string; driver: SopStepDriver }
> = {
  aircraftRefit: { label: 'A 飞机整备段', rule: '15.1', driver: 'player' },
  reinforcement: { label: 'B 增援段', rule: '2.1', driver: 'player' },
  movement: { label: 'C 移动段', rule: '6.0', driver: 'player' },
  supply: { label: 'D 补给段', rule: '12.0', driver: 'player' },
  reaction: { label: 'E 反应段', rule: '7.0', driver: 'player' },
  combat: { label: 'F 战斗段', rule: '9.0', driver: 'player' },
  exploitation: { label: 'G 进击段', rule: '11.0', driver: 'player' },
  // 2.2 注：H 清理段的收束（移除 DG / 进击标记、翻面燃料标记、移除敌方运输破坏标记）为**自动**
  cleanUp: { label: 'H 清理段', rule: '2.2', driver: 'automatic' },
}

/** 角色前缀（先手方 / 后手方） */
const ROLE_PREFIX: Record<Exclude<SopStepRole, 'turn'>, string> = {
  first: '先手方',
  second: '后手方',
}

/** 一个回合的 19 步（顺序即 2.2 流程表的执行顺序） */
export const SOP_STEPS: readonly SopStep[] = [
  {
    id: 'preTurn.weatherDetermination',
    role: 'turn',
    phase: 'preTurn',
    driver: 'automatic',
    label: '回合开始：天气判定',
    rule: '1.5',
  },
  {
    id: 'preTurn.firstPlayerDetermination',
    role: 'turn',
    phase: 'preTurn',
    driver: 'question',
    label: '回合开始：先手判定',
    rule: '2.3',
  },
  ...(['first', 'second'] as const).flatMap((role) =>
    PLAYER_TURN_PHASES.map((phase) => {
      const info = SEGMENT_INFO[phase]
      return {
        id: `${role}.${phase}`,
        role,
        phase,
        driver: info.driver,
        label: `${ROLE_PREFIX[role]} · ${info.label}`,
        rule: info.rule,
      } satisfies SopStep
    }),
  ),
  {
    id: 'turnEnd',
    role: 'turn',
    phase: 'turnEnd',
    driver: 'automatic',
    label: '回合结束：推进回合标记',
    rule: '2.2',
  },
]

/** 步骤总数（19） */
export const SOP_STEP_COUNT = SOP_STEPS.length

/** 先手方第一段的序号（= Pre-Turn 两步之后） */
const FIRST_PLAYER_BASE = PRE_TURN_SEGMENTS.length

/* ────────────────────────────── 当前步 ────────────────────────────── */

/**
 * 当前应处的步骤序号（0 起）；无法确定时为 null
 *
 * 由 `Records` 推出（阶段 + Pre-Turn 子步骤 + 先手方对比），**不持额外状态**：
 *   - Pre-Turn 按 `preTurnSegment` 落在前两步；
 *   - A–H 先按「行动方 = 先手方？」决定 0 / 8 的基址，再加段内序号；
 *   - Turn End 固定在最后一步。
 * 行动方或先手方缺失（例如清理段缺 `activeSide`）⇒ 返回 null，由界面显示「—」，不做静默兜底。
 */
export function stepIndexFor(records: Records): number | null {
  if (records.phase === 'preTurn') {
    const segment = records.preTurnSegment
    if (segment === null) return null
    const index = (PRE_TURN_SEGMENTS as readonly PreTurnSegment[]).indexOf(segment)
    return index < 0 ? null : index
  }
  if (records.phase === 'turnEnd') return SOP_STEP_COUNT - 1

  const phaseIndex = (PLAYER_TURN_PHASES as readonly GamePhase[]).indexOf(records.phase)
  if (phaseIndex < 0) return null
  if (records.activeSide === null || records.firstPlayer === null) return null
  const base =
    records.activeSide === records.firstPlayer
      ? FIRST_PLAYER_BASE
      : FIRST_PLAYER_BASE + PLAYER_TURN_PHASES.length
  return base + phaseIndex
}

/** 逐步引导：当前步 + 序号 + 总数（无法确定时为 null） */
export function guidanceFor(records: Records): SopGuidance | null {
  const index = stepIndexFor(records)
  if (index === null) return null
  const step = SOP_STEPS[index]
  if (step === undefined) return null
  return { step, index, total: SOP_STEP_COUNT }
}

/**
 * 回合级步骤（Pre-Turn / Turn End）的**审计用** side 字段
 *
 * `SessionLogEntry.side` 不可为空，而回合级步骤没有行动方 ⇒ 记「本回合先手方」，
 * 尚未判定时记剧本首回合先手。该字段**仅供审计**，不参与任何判定。
 */
export function turnLevelLogSide(records: Records, scenarioFirstPlayer: Side): Side {
  return records.activeSide ?? records.firstPlayer ?? scenarioFirstPlayer
}

/* ────────────────────────────── 待答问题的词表 ────────────────────────────── */

/** 2.3 先手选择的问题类别（与 turn-driver 的 `initiativeQuestion` 同源） */
export const INITIATIVE_QUESTION_KIND = 'initiative'

/** 开局共识开关的问题类别 */
export const AGREED_OPTION_QUESTION_KIND = 'agreedOption'

/**
 * 共识开关的规则依据
 *
 * `scenarios.json → agreedOptions` 明确「需双方一致同意才生效，必须写入存档」，
 * 其条目跨 1.4（地图外盒）/ 4.9e（秘密掷骰）/ 2.4（同步操作回合）/ 4.1–4.3（可选规则与房规）
 * ⇒ 引用**可选规则章 4.0** 作为该组开关的出处。
 */
export const CONSENSUS_RULE = '4.0'

/** 共识开关的两个选项 id（原文只有「采纳 / 不采纳」两态） */
export const AGREED_OPTION_IDS = { adopt: 'adopt', decline: 'decline' } as const

/** 共识开关的题号（按条目序号生成，便于日志反查） */
export function agreedOptionQuestionId(index: number): string {
  return `agreedOption:${index}`
}

/**
 * 共识开关的待答问题（逐条一问：采纳 / 不采纳）
 *
 * `responder` 由引擎指定一方代答（见 session-types：双方共识开关类决策由引擎指定一方）；
 * 本作取**先手方**代答——共识开关在开局前定下，与谁先行动无关。
 */
export function agreedOptionQuestion(
  index: number,
  item: string,
  responder: Side,
): SessionQuestion {
  return {
    id: agreedOptionQuestionId(index),
    responder,
    kind: AGREED_OPTION_QUESTION_KIND,
    rule: CONSENSUS_RULE,
    prompt: `开局共识：是否采用「${item}」？（须双方一致同意才生效，作答即写入存档）`,
    options: [
      { id: AGREED_OPTION_IDS.adopt, label: '采纳（双方一致同意，生效）' },
      { id: AGREED_OPTION_IDS.decline, label: '不采纳（按标准规则进行）' },
    ],
    payload: { item, index },
  }
}
