import type { Side } from '@/data'

import type { OutcomeData, RuleRef } from './result-types'

/**
 * 会话框架类型（B4）
 *
 * 会话的**四种形态**（同一时刻恰处于其一，判别联合收窄）：
 *   1. `created`    未开局：已建会话、尚未开始推进
 *   2. `advancing`  步骤推进：无待答问题，可继续推进
 *   3. `awaiting`   待答问题：停下等「当前应答方」作答（question 内含 responder）
 *   4. `terminated` 终止判定：已结束（回合用尽 5.0a / 提前决胜 5.0b）
 *
 * 另含**序列化**：四形态都可整体存档与读回（入口见 engine/session.ts）。
 *
 * 硬性约定（写在类型与实现两侧，避免误用）：
 *   **强制动作与自动后果不进待答** —— 规则强制发生、玩家无可选择的事项
 *   （如阶段自动清理、增援自动到场、补给自动追溯）一律由引擎直接结算并记日志，
 *   只有**真正的玩家决策**才允许产生待答问题。
 */

/* ────────────────────────────── 形态 ────────────────────────────── */

/** 会话形态顺序（枚举与顺序的单一来源；新增形态只改这里） */
export const SESSION_FORMS = ['created', 'advancing', 'awaiting', 'terminated'] as const

/** 会话形态（B4 四种） */
export type SessionForm = (typeof SESSION_FORMS)[number]

/**
 * 终止原因（终止判定）
 *
 * - `turnsExhausted` 回合用尽：剧本回合数（scenarios.json scenarios[].turns）走完（5.0a）
 * - `earlyDecision`  提前决胜：1941-08-19 起达成提前决胜条件（5.0b）
 */
export const TERMINATION_REASONS = ['turnsExhausted', 'earlyDecision'] as const

/** 终止原因类型 */
export type TerminationReason = (typeof TERMINATION_REASONS)[number]

/* ────────────────────────────── 待答问题 ────────────────────────────── */

/** 问题可选项（玩家从中选择；无选项的问题表示自由作答/确认） */
export interface QuestionOption {
  /** 选项标识（作答时回传） */
  id: string
  /** 选项文字 */
  label: string
}

/**
 * 待答问题：仅承载**真正的玩家决策**
 *
 * 强制动作与自动后果不得构造本类型（见文件头约定）。
 * 每问必带：谁是应答方、依据哪条规则、题面是什么。
 */
export interface SessionQuestion {
  /** 问题标识（作答时校验，防答错题） */
  id: string
  /** 当前应答方（双方共识开关类决策由引擎指定一方代答，见 专规 4.1–4.3） */
  responder: Side
  /** 问题类别（词表随各命令单元补齐，如 'option' 选项 9.10） */
  kind: string
  /** 该问题的规则依据 */
  rule: RuleRef
  /** 面向玩家的题面 */
  prompt: string
  /** 可选项；无选项表示自由作答或确认 */
  options?: QuestionOption[]
  /** 附加上下文（供界面渲染，如候选单位 id、候选格），不参与判定 */
  payload?: OutcomeData
}

/** 会话形态（判别联合：以 `form` 收窄） */
export type SessionStatus =
  | { form: 'created' }
  | { form: 'advancing' }
  | { form: 'awaiting'; question: SessionQuestion }
  | { form: 'terminated'; reason: TerminationReason }

/* ────────────────────────────── 作答 ────────────────────────────── */

/**
 * 一次作答（对应一个待答问题）
 *
 * 引擎在接收时校验：题号一致、应答方一致、所选选项在列（若有选项）。
 */
export interface SessionAnswer {
  /** 所答问题 id（须与当前待答一致） */
  questionId: string
  /** 作答方（须等于提问时的 responder） */
  side: Side
  /** 所选选项 id（问题带 options 时必填） */
  optionId?: string
  /** 自由作答值（问题无 options 时使用，如掷骰改判、数值输入） */
  value?: number
}
