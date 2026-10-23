import { createPinia, setActivePinia } from 'pinia'

import type { Side } from '@/data'
import { appendLog } from '@/engine/session'
import { createRngState, roll1d6, rollDice, type RngDraw } from '@/engine/rng'
import { succeed, fail, type OutcomeData } from '@/engine/result-types'
import type {
  DiceRoll,
  GamePhase,
  GameSession,
  RngState,
  SessionLogEntry,
} from '@/engine/state-types'
import { useGameSessionStore } from '@/stores'

/**
 * **W7 D3 回归基线夹具**（共享夹具，非测试文件）
 *
 * 目的：给整局回归提供一份**唯一、可复算**的基线——
 *   · 固定种子（`BASELINE_SEED`）⇒ 掷骰序列唯一确定，任何一次结算都能从种子重推；
 *   · 真实数据（剧本 1 / 真实共识开关 / 真实回合轨）⇒ 不造数，回归的是产品数据本身；
 *   · 真实流程（会话步进，`stepNow`）⇒ 回归的是「引擎 + 数据 + 流程」三者合起来的行为。
 *
 * 纪律（CODE_SPEC §7 / §3.3）：
 *   - 一切随机走 `engine/rng.ts`（本文件不掷暗骰、不用 `Math.random`）；
 *   - 夹具只**摆放/驱动**，结论仍在各测试里由引擎给出并断言；
 *   - 测试名带规则编号或波次编号（`W7 D3`），便于反向检索。
 */

/** 基线固定种子：取战役首日（1941-07-08）的紧凑写法，便于人眼识别 */
export const BASELINE_SEED = 19410708

/** 基线推进到第几回合（含）——足够覆盖「天气判定 / 先手判定 / 段推进 / 回合收束」 */
export const BASELINE_TURNS = 3

/** 会话 store 类型（测试里 `store.session` 等字段直接用） */
export type SessionStore = ReturnType<typeof useGameSessionStore>

/** 全新会话 store（每个用例独立 Pinia，互不串状态） */
export function newSessionStore(): SessionStore {
  setActivePinia(createPinia())
  return useGameSessionStore()
}

/**
 * 用固定种子开一局，并一路推进到目标回合
 *
 * 途中按规则要求作答（开局共识＝全部采纳；2.3 先手＝先手），
 * 故推进路径与玩家实际操作一致（不是旁路写状态）。
 */
export function driveToTurn(store: SessionStore, targetTurn: number): void {
  // 专规 4.0：开局共识先写成日志结论（基线取「全部采纳」，让可选规则也进入回归面）
  if (!store.agreedRecorded) {
    store.setAllAgreedChecks(true)
    if (!store.confirmAgreedChecklist()) {
      throw new Error(`开局共识写入被拒：${store.error?.rule}/${store.error?.reason}`)
    }
  }
  let guard = 0
  while ((store.records?.turn ?? Number.MAX_SAFE_INTEGER) < targetTurn) {
    guard += 1
    if (guard > 3000) throw new Error('流程未在合理步数内到达目标回合（疑似死循环）')
    if (store.terminated) return
    if (store.awaiting) {
      store.answerNow(store.question?.kind === 'agreedOption' ? 'adopt' : 'first')
    } else {
      store.stepNow()
    }
  }
}

/** 固定种子 + 真实数据 + 真实流程 ⇒ 基线会话（`BASELINE_TURNS` 回合后的存档态） */
export function buildBaselineSession(seed: number = BASELINE_SEED): GameSession {
  const store = newSessionStore()
  if (!store.startGame(seed))
    throw new Error(`开局被拒：${store.error?.rule}/${store.error?.reason}`)
  driveToTurn(store, BASELINE_TURNS)
  const session = store.session
  if (session === null) throw new Error('基线会话缺席：startGame 后 session 仍为 null')
  return session
}

/* ────────────────────────────── 掷骰序列（黄金样本的取数口） ────────────────────────────── */

/** 连续掷 `count` 次 1d6，返回骰面与终点 RNG 状态（`replayFrom` 的对照物） */
export function consume1d6(seed: number, count: number): { faces: number[]; rng: RngState } {
  let rng = createRngState(seed)
  const faces: number[] = []
  for (let index = 0; index < count; index += 1) {
    const draw: RngDraw<DiceRoll> = roll1d6(rng)
    rng = draw.rng
    faces.push(draw.value.faces[0] ?? 0)
  }
  return { faces, rng }
}

/** 连续掷 `count` 次 2d6，返回逐次骰面（形如 `6+2`）与终点 RNG 状态 */
export function consume2d6(seed: number, count: number): { faces: string[]; rng: RngState } {
  let rng = createRngState(seed)
  const faces: string[] = []
  for (let index = 0; index < count; index += 1) {
    const draw = rollDice(rng, 2)
    rng = draw.rng
    faces.push(draw.value.faces.join('+'))
  }
  return { faces, rng }
}

/* ────────────────────────────── 定向构造日志（重放契约的用例入口） ────────────────────────────── */

/** 造一条结算日志（成功 / 失败二选一；掷骰由调用方给出） */
export function makeLogEntry(input: {
  turn?: number
  phase?: GamePhase
  side?: Side
  action: string
  rule: string
  rolls?: DiceRoll[]
  /** 省略即成功（`detail` 进 data）；给了 reason 即失败 */
  reason?: string
  data?: OutcomeData
}): SessionLogEntry {
  return {
    turn: input.turn ?? 1,
    phase: input.phase ?? 'movement',
    side: input.side ?? 'axis',
    action: input.action,
    rolls: input.rolls ?? [],
    outcome:
      input.reason === undefined
        ? succeed(input.rule, input.data ?? { detail: `${input.action} 已结算` })
        : fail(input.rule, input.reason),
  }
}

/** 按顺序把若干日志条目追加进会话（返回新会话；不改入参） */
export function appendEntries(
  session: GameSession,
  entries: readonly SessionLogEntry[],
): GameSession {
  return entries.reduce((current, entry) => appendLog(current, entry), session)
}

/** 造一条**消耗真骰**的日志（掷骰来自 `seed` 的下一段序列，故与重放必然吻合） */
export function makeRollingEntry(input: {
  rng: RngState
  count: number
  action: string
  rule: string
  turn?: number
  side?: Side
}): { entry: SessionLogEntry; rng: RngState } {
  const draw = rollDice(input.rng, input.count)
  return {
    entry: makeLogEntry({
      turn: input.turn,
      side: input.side,
      action: input.action,
      rule: input.rule,
      rolls: [draw.value],
    }),
    rng: draw.rng,
  }
}
