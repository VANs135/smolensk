import type { Ref } from 'vue'

import type { Side } from '@/data'
import type { Derivation } from '@/engine/derivation'
import { succeed, type PendingEffect } from '@/engine/result-types'
import type { DiceRoll, SessionLogEntry } from '@/engine/state-types'
import { createId } from '@/shared'

import type { RecorderEventInput } from './recorder'
import type { ConsolePhase, WorkbenchLogEntry } from './workbench-model'

/**
 * workbench 的全局服务：日志、结算账本。
 *
 * 解构第一批（B0 切片 1，见 `docs/specs/2026-11-20-workbench解构/`）：
 * 这三个服务被多节调用（`pushLog` 669 处、`recordSettlement` 77 处），任何切片都要用，
 * 所以先把**实现**搬出 32k 行的 `workbench.ts`，facade 只保留同名薄转发 —— 存量调用点一个都不改。
 *
 * 依赖全部以**引用或 getter**传入，不传快照值：
 * - `log` / `pendingRolls` 是稳定引用（后者靠 `splice` 就地出账，传值会丢）；
 * - `segmentStepId` 用 getter，因为 `segmentStep` 在 `workbench.ts` 里声明得很晚（:24471），
 *   直接传 `segmentStep.value` 会在装配期读到 `undefined`。
 */

/** 日志上限：超过就丢最旧的（对局只关心最近 60 条） */
const LOG_LIMIT = 60

export interface WorkbenchCoreDeps {
  /** 操作台日志（新条目在前，`unshift`） */
  log: Ref<WorkbenchLogEntry[]>
  /** 对局记录器（旁路，异常自吞） */
  recorder: { note: (input: RecorderEventInput) => void }
  turn: () => number
  phase: () => ConsolePhase
  activeSide: () => Side
  segmentStepId: () => string | null
  /** 骰源缓冲：`recordSettlement` 会就地 `splice` 取走 */
  pendingRolls: DiceRoll[]
  /** 本段一旦掷骰就封撤销 */
  sealUndo: (reason: string) => void
  appendSettlement: (entry: SessionLogEntry) => boolean
}

/** `recordSettlement` 的入参（`workbench.ts` 里的同名内联类型搬到这里，便于 facade 薄转发引用） */
export interface SettlementRecordInput {
  action: string
  rule: string
  side?: Side
  rolls?: readonly DiceRoll[]
  pending?: PendingEffect[]
  data?: Record<string, unknown>
  /**
   * 3.3c 的撤离结算是「同批骰子里的中间结算」，这批骰属于紧随其后的 `variableRepl`；
   * 传 false 可避免它把 `pendingRolls` 吃掉、导致同一批骰被记两次（修 1.6b 重放错位）。
   * 默认 true，其他调用点行为不变。
   */
  consumePendingRolls?: boolean
}

export interface WorkbenchCore {
  noteRecord(input: RecorderEventInput): void
  pushLog(
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ): void
  recordSettlement(input: SettlementRecordInput): boolean
}

export function createWorkbenchCore(deps: WorkbenchCoreDeps): WorkbenchCore {
  /** ⑧：把事实投给对局记录器 —— 记录是旁路，未开启时立即返回，异常一律吞掉 */
  function noteRecord(input: RecorderEventInput): void {
    try {
      deps.recorder.note(input)
    } catch {
      // 记录失败不阻断游戏
    }
  }

  function pushLog(
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ): void {
    deps.log.value.unshift({
      id: createId('log'),
      kind,
      text,
      ...(rule === undefined ? {} : { rule }),
      ...(derivation === undefined ? {} : { derivation }),
    })
    if (deps.log.value.length > LOG_LIMIT) deps.log.value.length = LOG_LIMIT
    noteRecord({
      kind: 'log',
      level: kind,
      text,
      rule: rule ?? null,
      turn: deps.turn(),
      phase: deps.phase(),
      side: deps.activeSide(),
      step: deps.segmentStepId(),
    })
  }

  /**
   * ⑭ 接线：把操作台的**一笔结算**写进会话日志（D2 的检索与重放随即覆盖它）
   *
   * 与会话日志条目同构：`turn / phase / side / action / rolls / outcome`。
   * `rolls` 以骰源缓冲为准：凡「掷了骰」必有一条记录，避免「先掷骰、再被引擎拒绝」时漏记而错位重放。
   * **未开局**（没有会话）时静默跳过，操作台照常独立演练。
   *
   * @returns 是否真的入账（未开局 ⇒ false）
   */
  function recordSettlement(input: SettlementRecordInput): boolean {
    const rolls =
      input.consumePendingRolls === false
        ? [...(input.rolls ?? [])]
        : deps.pendingRolls.length > 0
          ? deps.pendingRolls.splice(0)
          : [...(input.rolls ?? [])]
    /*
     * 本段一旦掷过骰，撤销入口直接关掉。
     * 不依赖具体动作（战斗/补给/抽签/特殊补员都走这里记录掷骰），一律按「本段」封。
     */
    if (rolls.length > 0) deps.sealUndo(`本段已掷骰结算（${input.action}·${input.rule}），不能撤销`)
    const entry: SessionLogEntry = {
      turn: deps.turn(),
      phase: deps.phase(),
      side: input.side ?? deps.activeSide(),
      action: input.action,
      rolls,
      outcome: succeed(input.rule, input.data ?? {}, [...(input.pending ?? [])]),
    }
    const recorded = deps.appendSettlement(entry)
    if (recorded) {
      noteRecord({
        kind: 'settle',
        turn: entry.turn,
        phase: entry.phase,
        side: entry.side,
        step: deps.segmentStepId(),
        rule: input.rule,
        detail: { action: input.action, rolls, outcome: entry.outcome },
      })
    }
    return recorded
  }

  return { noteRecord, pushLog, recordSettlement }
}
