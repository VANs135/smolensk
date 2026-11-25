/**
 * AI 驱动步的重排策略（界面侧的**纯**判据）
 *
 * 背景（2026-11-25 用户报障「AI 与玩家交互时撤退卡住」）：
 * `GameTableView` 修前只有 `intent === 'wait'` 才退避 600ms，其余失败一律 `runAiStep` 立刻重排
 * ⇒ 一旦某一步的提交被规则拒绝且 AI 自己无解（如 9.10a 选项点数超过可用军力、又没有「退 k +
 * 吃 N-k」的档），就会 0ms 空转：界面看着是「不动」，实际每秒几十次拒绝。
 *
 * 本模块只做两件事：
 * 1. 失败一律按 `retryMs` 退避（不再 0ms 重排）；
 * 2. 同一 `intent|rule|reason` 连续 `repeatLimit` 次 ⇒ 报「卡住」并停止驱动，交给玩家（不假装成功）。
 *
 * 不判规则、不改盘面：只决定「多久后再试」与「是否已经卡死」。
 */

export interface AiStepGuardState {
  /** 上一次失败的签名（intent|rule|reason）；非失败步为空 */
  signature: string | null
  /** 同一签名连续出现的次数 */
  repeats: number
}

export interface AiStepGuardOptions {
  /** 玩家侧待办的等待间隔（默认 600ms，与原 `scheduleAiStep` 同口径） */
  waitMs?: number
  /** 失败后的退避间隔（默认 400ms） */
  retryMs?: number
  /** 同一签名连续失败多少次判「卡住」（默认 5） */
  repeatLimit?: number
}

export interface AiStepGuardDecision {
  state: AiStepGuardState
  /** 下一次驱动前的等待毫秒数（stop 时无意义） */
  delayMs: number
  /** 是否停止驱动 */
  stop: boolean
  /** 判为卡住时的说明（可直接显示给玩家）；未卡住为 null */
  stalled: string | null
}

/** 只取本模块需要的结果字段（`AiStepResult` 的子集） */
export interface AiStepGuardInput {
  intent: string
  ok: boolean
  rule?: string
  reason?: string
  waiting?: string
}

const DEFAULT_WAIT_MS = 600
const DEFAULT_RETRY_MS = 400
const DEFAULT_REPEAT_LIMIT = 5

export function createAiStepGuard(): AiStepGuardState {
  return { signature: null, repeats: 0 }
}

export function advanceAiStepGuard(
  state: AiStepGuardState,
  result: AiStepGuardInput,
  options: AiStepGuardOptions = {},
): AiStepGuardDecision {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const repeatLimit = Math.max(2, options.repeatLimit ?? DEFAULT_REPEAT_LIMIT)
  if (result.intent === 'none') {
    return { state: createAiStepGuard(), delayMs: 0, stop: true, stalled: null }
  }
  if (result.intent === 'wait') {
    return { state: createAiStepGuard(), delayMs: waitMs, stop: false, stalled: null }
  }
  if (result.ok) {
    return { state: createAiStepGuard(), delayMs: 0, stop: false, stalled: null }
  }
  const signature = `${result.intent}|${result.rule ?? ''}|${result.reason ?? ''}`
  const repeats = state.signature === signature ? state.repeats + 1 : 1
  if (repeats >= repeatLimit) {
    const detail = `${result.rule ?? '未标条款'}｜${result.reason ?? '提交被拒'}`
    return {
      state: { signature, repeats },
      delayMs: 0,
      stop: true,
      stalled: `AI 连续 ${String(repeats)} 次被同一判据拒绝，已暂停（${detail}）`,
    }
  }
  return { state: { signature, repeats }, delayMs: retryMs, stop: false, stalled: null }
}
