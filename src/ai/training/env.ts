/**
 * 训练环境（同步单步）
 *
 * 目标：给采集/训练侧一个**可重置、可复现、无 UI 等待**的环境壳：
 *   reset() → observe() → step(action) → observe() ...
 *
 * 与 `runAiSelfPlay` 的区别：
 * - 不 `await nextTick()`、不驱动 Vue 渲染，只推进 store 里的规则状态；
 * - `reset` 重建 Pinia，不复用上一局的 store / memory / 实体别名；
 * - 观测固定走 `snapshotOf` + `trainingObservationOf`，不另拼字段。
 *
 * 边界：
 * - 这是**单进程训练/采集**环境，不是浏览器运行时；不要拿它替代 `runAiSelfPlay` 做 UI 回归。
 * - 初设先用 `presetSelfSetupNow`，剩下的自由落位交给脚本策略补完；补不完直接报错，
 *   不静默开一局缺单位的盘面。
 * - 奖励暂为 0：S1 只交付接口；奖励/终止规则在训练侧定义，不在这里脑补。
 */

import { createPinia, setActivePinia } from 'pinia'

import type { AiAction, AiControlMode, AiSnapshot } from '../policy'
import {
  createAiMemory,
  runAiStep,
  snapshotOf,
  type AiContext,
  type AiMemory,
  type AiStepResult,
} from '../driver'
import type { AiStepRecord } from '../trace'
import { deserializeSession, serializeSession } from '@/engine/session'
import { createMemoryStorage } from '@/shared/storage'
import { useGameSessionStore } from '@/stores/session'
import { useHotseatStore } from '@/stores/hotseat'
import { useSetupStore } from '@/stores/setup'
import { useWorkbenchStore } from '@/stores/workbench'
import { canonicalActionKeyOf } from './action-key'
import type { TrainingCandidate } from './candidates'
import { candidateActionsOf } from './candidates'
import type { TrainingObservation } from './contract'
import { createTrainingIdentity, type TrainingIdentity } from './identity'
import { trainingObservationOf } from './serialize'

export interface TrainingEnvOptions {
  /** 剧本 id（与 `setup.enterSetup` 同一入口） */
  scenarioId: string
  /** 对局种子；同 seed + 同动作序列 ⇒ 同观测（实体 id 已被训练别名归一化） */
  seed: number
  /** 控制方；训练通常 `both`（双方都由动作驱动） */
  control?: AiControlMode
  /** 初设补步上限，防止异常剧本卡死 */
  maxSetupSteps?: number
  /** 单局步数上限；0 表示只由会话终止/调用方停止 */
  maxSteps?: number
}

export interface TrainingStepInfo extends AiStepResult {
  /** 执行前的观测（与 `record.obs` 同源） */
  before: TrainingObservation
  /** 执行 driver 记录的动作 key（外部动作结构非法时可能是回退动作） */
  executedKey: string
  /** 本次动作的 canonical key（训练动作表用） */
  actionKey: string
  /** 本步后是否截断（达到 maxSteps） */
  truncated: boolean
}

export interface TrainingStepResult {
  observation: TrainingObservation
  /** 外部传入动作的 canonical key */
  actionKey: string
  /** 暂固定 0；训练侧按规则/战果自行塑形 */
  reward: number
  done: boolean
  info: TrainingStepInfo
}

export interface TrainingEnv {
  /** 最近一次 reset 的上下文（测试/采集诊断用） */
  readonly ctx: AiContext
  readonly identity: TrainingIdentity
  readonly done: boolean
  readonly steps: number
  reset(options?: Partial<TrainingEnvOptions>): TrainingObservation
  observe(): TrainingObservation
  step(action: AiAction): TrainingStepResult
  /** 动作 → canonical key（候选表/日志用） */
  actionKey(action: AiAction): string
  /** 当前快照下的候选动作（v1；不是穷举合法动作） */
  candidates(): TrainingCandidate[]
  /** 只读快照（不含训练投影；诊断用） */
  snapshot(): AiSnapshot
  /**
   * 把当前局面写进内存存档（用于多 worker 回到同一起点）
   *
   * 只保存一份；再调用会覆盖上一份。与 `reset` 不同：不重建 Pinia，也不重跑初设。
   */
  checkpoint(): void
  /** 回到最近一次 `checkpoint`，并清空 AI 内存；失败即抛，不静默继续 */
  restoreCheckpoint(): void
}

interface TrainingCheckpoint {
  /** `serializeSession` 的原文（只含会话；盘面另存） */
  sessionText: string
  /** `workbench.snapshotBoard()` 的深拷贝 */
  board: unknown
}

interface EnvState {
  ctx: AiContext
  identity: TrainingIdentity
  memory: AiMemory
  checkpoint: TrainingCheckpoint | null
  options: Required<
    Pick<TrainingEnvOptions, 'scenarioId' | 'seed' | 'control' | 'maxSetupSteps' | 'maxSteps'>
  >
  started: boolean
  done: boolean
  steps: number
}

function normalizeOptions(
  defaults: TrainingEnvOptions | null,
  override: Partial<TrainingEnvOptions> | undefined,
): EnvState['options'] {
  const scenarioId = override?.scenarioId ?? defaults?.scenarioId
  const seed = override?.seed ?? defaults?.seed
  if (scenarioId === undefined || seed === undefined) {
    throw new Error('TrainingEnv: scenarioId / seed 必填')
  }
  return {
    scenarioId,
    seed,
    control: override?.control ?? defaults?.control ?? 'both',
    maxSetupSteps: override?.maxSetupSteps ?? defaults?.maxSetupSteps ?? 500,
    maxSteps: override?.maxSteps ?? defaults?.maxSteps ?? 0,
  }
}

/**
 * 新开一套 Pinia + 剧本。
 *
 * 注意 `setActivePinia` 是进程级全局：同一进程不要并发跑两个 env。
 * 采集器要并行时用多进程/worker，不要在同一 JS 上下文里交错 reset。
 */
function bootstrap(options: EnvState['options']): EnvState {
  setActivePinia(createPinia())
  const setup = useSetupStore()
  const workbench = useWorkbenchStore()
  const session = useGameSessionStore()
  const hotseat = useHotseatStore()

  hotseat.setMode('solo')
  session.setSaveStorage(createMemoryStorage())
  workbench.seed = options.seed

  if (!setup.enterSetup(options.scenarioId)) {
    throw new Error(`TrainingEnv: enterSetup(${options.scenarioId}) 失败`)
  }

  const preset = setup.presetSelfSetupNow()
  const ctx: AiContext = { workbench, session, setup }
  const memory = createAiMemory()
  const identity = createTrainingIdentity(ctx)

  let setupSteps = 0
  while (setup.pendingPlacement.length > 0 && setupSteps < options.maxSetupSteps) {
    const result = runAiStep(ctx, { memory, control: 'both' })
    setupSteps += 1
    if (result.intent === 'none' || result.intent === 'wait' || !result.ok) break
  }
  identity.refresh()

  let started = setup.startGameNow()
  if (!started && setup.setupDrawEntryVisible) {
    setup.drawSetupEffectsNow()
    started = setup.startGameNow()
  }
  if (!started) {
    const remaining = setup.pendingPlacement
      .map((item) => `${item.side}:${item.label}×${String(item.remaining)}`)
      .join(', ')
    throw new Error(
      `TrainingEnv: 初设未完成（scenario=${options.scenarioId}，seed=${String(options.seed)}，` +
        `preset.remaining=${String(preset.remaining)}，pending=${remaining || '无'}，` +
        `setupSteps=${String(setupSteps)}）`,
    )
  }

  identity.refresh()
  return {
    ctx,
    identity,
    memory,
    checkpoint: null,
    options,
    started: true,
    done: session.terminated,
    steps: 0,
  }
}

export function createTrainingEnv(defaults: TrainingEnvOptions): TrainingEnv {
  let state: EnvState | null = null
  let defaultOptions: TrainingEnvOptions = defaults

  const ensure = (): EnvState => {
    if (state === null || !state.started) {
      state = bootstrap(normalizeOptions(defaultOptions, undefined))
    }
    return state
  }

  const env: TrainingEnv = {
    get ctx() {
      return ensure().ctx
    },
    get identity() {
      return ensure().identity
    },
    get done() {
      return ensure().done
    },
    get steps() {
      return ensure().steps
    },
    reset(override) {
      if (override !== undefined) defaultOptions = { ...defaultOptions, ...override }
      state = bootstrap(normalizeOptions(defaultOptions, undefined))
      return trainingObservationOf(
        snapshotOf(state.ctx, state.memory, state.options.control),
        state.identity,
      )
    },
    observe() {
      const current = ensure()
      current.identity.refresh()
      return trainingObservationOf(
        snapshotOf(current.ctx, current.memory, current.options.control),
        current.identity,
      )
    },
    snapshot() {
      const current = ensure()
      return snapshotOf(current.ctx, current.memory, current.options.control)
    },
    checkpoint() {
      const current = ensure()
      const game = current.ctx.session.session
      if (game === null) throw new Error('TrainingEnv: 没有会话，不能 checkpoint')
      /*
       * 不用 `session.saveNow()`：它会为「读档失败回滚」再抓一份当前盘面，
       * 而训练回滚经常发生在移动/战斗结算中途，`snapshotBoard` 会按 UI 存档守卫拒绝。
       * 这里直接抓「会话 + 盘面」；训练侧只在明确的起点调用，守卫条件由调用方保证。
       */
      current.checkpoint = {
        sessionText: serializeSession(game),
        board: current.ctx.workbench.snapshotBoard(),
      }
    },
    restoreCheckpoint() {
      const current = ensure()
      if (current.checkpoint === null) throw new Error('TrainingEnv: 尚未 checkpoint，不能恢复')
      /*
       * 绕过 `session.loadNow()`：它也会先抓当前盘面做备份，训练回滚可能正处在
       * 结算中途。这里的两份快照都来自同一局，直接替换会话 + 盘面即可。
       */
      const restored = deserializeSession(current.checkpoint.sessionText)
      current.ctx.session.session = restored
      current.ctx.workbench.restoreBoard(current.checkpoint.board, true)
      current.ctx.session.lastAdvanceKind = null
      current.ctx.session.error = null
      // 记忆里可能挂着上一段的动作/事实；回滚后必须换新，不能把旧状态带进下一段。
      current.memory = createAiMemory()
      current.steps = 0
      current.done = current.ctx.session.terminated
      current.identity.refresh()
    },
    actionKey(action) {
      return canonicalActionKeyOf(action, ensure().identity.actionIds)
    },
    candidates() {
      const current = ensure()
      current.identity.refresh()
      return candidateActionsOf(
        snapshotOf(current.ctx, current.memory, current.options.control),
        current.identity,
      )
    },
    step(action) {
      const current = ensure()
      if (current.done) throw new Error('TrainingEnv: 本局已结束，请先 reset()')
      current.identity.refresh()
      const beforeSnapshot = snapshotOf(current.ctx, current.memory, current.options.control)
      const before = trainingObservationOf(beforeSnapshot, current.identity)
      const captured: { step?: AiStepRecord } = {}
      const result = runAiStep(current.ctx, {
        memory: current.memory,
        control: current.options.control,
        decider: () => action,
        onStep: (step) => {
          captured.step = step
        },
      })
      current.steps += 1
      current.identity.refresh()
      const after = trainingObservationOf(
        snapshotOf(current.ctx, current.memory, current.options.control),
        current.identity,
      )
      const actionKey = canonicalActionKeyOf(action, current.identity.actionIds)
      const truncated =
        current.options.maxSteps > 0 &&
        current.steps >= current.options.maxSteps &&
        !current.ctx.session.terminated
      current.done = current.ctx.session.terminated || truncated
      const executedRecord = captured.step
      const info: TrainingStepInfo = {
        ...result,
        before,
        executedKey:
          executedRecord === undefined
            ? actionKey
            : canonicalActionKeyOf(executedRecord.act, current.identity.actionIds),
        actionKey,
        truncated,
      }
      return {
        observation: after,
        actionKey,
        reward: 0,
        done: current.done,
        info,
      }
    },
  }
  return env
}
