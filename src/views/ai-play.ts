import type { Ref } from 'vue'

import { createAiMemory, runAiStep, type AiContext } from '@/ai/driver'
import type { AiControlMode } from '@/ai/policy'
import { advanceAiStepGuard, createAiStepGuard } from '@/ai/step-guard'

/**
 * 棋桌页的 PVE AI 驱动循环（从 `GameTableView` 抽出，视图只留挂载与状态文案）
 *
 * 2026-11-25（用户「AI 不点撤退 / 撤退卡住」）：修前只有 `intent === 'wait'` 才退避 600ms，
 * 其余失败一律 0ms 重排 ⇒ 被规则拒绝且 AI 无解的那一步会空转（界面看着不动）。
 * 现在每步都过 `ai/step-guard`：失败一律退避，同一判据连续失败判「卡住」并停下（交回玩家）。
 *
 * 纪律：本模块不判规则、不改盘面 —— 只负责「何时再步进」与「何时停」。
 */
export interface AiPlayLoop {
  /** 启动（已在跑时不要重复调用；`restart` 会先停） */
  start(delayMs?: number): void
  /** 停表（离开棋桌 / 模式切换时） */
  stop(): void
  /** 换模式后重来：清记忆、清等待文案、重新起表 */
  restart(): void
}

export interface AiPlayLoopOptions {
  /** 每次步进时现取上下文（会话终止状态会随盘面变化） */
  context: () => AiContext
  /** 当前控制模式（`off` ＝不接管） */
  control: () => AiControlMode
  /** 等待 / 卡住的说明文案（页面状态条显示） */
  waiting: Ref<string>
  /** 卡住时写一条日志（页面不猜规则，原文由驱动结果给） */
  log: (text: string, rule?: string) => void
}

export function createAiPlayLoop(options: AiPlayLoopOptions): AiPlayLoop {
  let memory = createAiMemory()
  let guard = createAiStepGuard()
  let timer: ReturnType<typeof setTimeout> | null = null

  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const start = (delayMs = 0): void => {
    timer = setTimeout(() => {
      timer = null
      if (options.control() === 'off') return
      const ctx = options.context()
      const result = runAiStep(ctx, { memory, control: options.control() })
      const decision = advanceAiStepGuard(guard, result)
      guard = decision.state
      options.waiting.value = result.waiting ?? decision.stalled ?? ''
      if (decision.stalled !== null) options.log(decision.stalled, result.rule)
      if (ctx.session.terminated || decision.stop) {
        stop()
        return
      }
      start(decision.delayMs)
    }, delayMs)
  }

  const restart = (): void => {
    stop()
    options.waiting.value = ''
    memory = createAiMemory()
    guard = createAiStepGuard()
    if (options.control() !== 'off') start()
  }

  return { start, stop, restart }
}
