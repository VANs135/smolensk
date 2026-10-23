import type { DiceRoll, RngState } from './state-types'

/**
 * 随机数与种子管理（B2）
 *
 * 规范依据：
 *   - CODE_SPEC.md §3.3「掷骰必须可重放：禁 Math.random；所有随机走 engine/rng.ts（种子入存档）」
 *   - CODE_SPEC.md §2：engine 为纯 TS，禁引 Vue / Pinia / DOM / Canvas / 网络 / Math.random
 *
 * 设计要点：
 *   1. **纯函数式**：函数收 RngState、返回「新状态 + 抽取值」，不改入参——
 *      与引擎「状态进 / 状态出」一致，配合 GameState 不可变更新。
 *      调用方约定：同一 RngState 只消费一次（消费后须用返回的新状态继续）。
 *   2. **可复算**：同一 seed 的抽取序列唯一确定；`seed` + `drawCount`
 *      可从头重推，`verifyRngState()` 用于校验存档未被篡改。
 *   3. **可移植**：全部运算限定在 32 位整数（`|0` / `>>>0` / `Math.imul`），
 *      不使用浮点累计，跨平台结果一致。
 *   4. **无取模偏差**：骰面用拒绝采样（见 rollDie），丢弃尾部不足一轮的取值。
 *
 * 算法：mulberry32（Tommy Ettinger 提出的 32 位 PRNG，公有领域）。
 * 兵棋场景只做 1d6 / 2d6 判定，无需密码学强度；如需改算法，请同时升
 * 存档 schemaVersion 并重放校验（RNG_ALGORITHM 供存档兼容性判定）。
 */

/** 算法标识（入存档头，用于判定存档是否可用当前算法复算） */
export const RNG_ALGORITHM = 'mulberry32'

/** 骰面数（本作判定均为 1d6 / 2d6，见 9.8 奇袭、9.9 战斗表等） */
export const DIE_FACES = 6

/** 一次抽取的结果：推进后的状态 + 抽出的值 */
export interface RngDraw<T> {
  /** 推进后的 RNG 状态（须替换旧值） */
  rng: RngState
  /** 抽出的值 */
  value: T
}

/** mulberry32 单步：内部状态 → 新内部状态 + 32 位输出 */
function step(state: number): { state: number; output: number } {
  const next = (state + 0x6d2b79f5) | 0
  let t = Math.imul(next ^ (next >>> 15), 1 | next)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return { state: next >>> 0, output: (t ^ (t >>> 14)) >>> 0 }
}

/** 规范化种子为 32 位无符号整数（负数、小数、非有限值都收敛到合法种子） */
function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 0
  return Math.trunc(seed) >>> 0
}

/**
 * 由种子创建初始 RNG 状态（对局开局调用一次；同种子必得同序列）
 *
 * @param seed 任意整数；内部规范化为 32 位无符号
 */
export function createRngState(seed: number): RngState {
  const normalized = normalizeSeed(seed)
  return { seed: normalized, state: normalized, drawCount: 0 }
}

/** 抽取一个 32 位无符号整数（[0, 2^32) 均匀） */
export function nextUint32(rng: RngState): RngDraw<number> {
  const stepped = step(rng.state)
  return {
    rng: { seed: rng.seed, state: stepped.state, drawCount: rng.drawCount + 1 },
    value: stepped.output,
  }
}

/** 抽取一个 [0, 1) 浮点数（用于百分比类判定，如 12.11a 补给站爆破） */
export function nextFloat(rng: RngState): RngDraw<number> {
  const draw = nextUint32(rng)
  return { rng: draw.rng, value: draw.value / 2 ** 32 }
}

/** 32 位取值中可整除成整轮骰面的上界（其上为尾部余数，须拒绝） */
const DICE_LIMIT = Math.floor(2 ** 32 / DIE_FACES) * DIE_FACES

/**
 * 掷一枚骰（1..6）
 *
 * 拒绝采样消除取模偏差：`2^32` 不是 6 的倍数，直接取模会让前几个面略多；
 * 这里丢弃落在尾部余数区间的取值（概率约 1e-9），保证六面等概率。
 */
export function rollDie(rng: RngState): RngDraw<number> {
  let draw = nextUint32(rng)
  while (draw.value >= DICE_LIMIT) {
    draw = nextUint32(draw.rng)
  }
  return { rng: draw.rng, value: (draw.value % DIE_FACES) + 1 }
}

/**
 * 掷若干枚骰，返回可入日志的掷骰记录（数量 / 各骰面 / 合计）
 *
 * 返回的 DiceRoll 直接对应 state-types 的会话日志条目（CODE_SPEC §7 整局回归比对）。
 *
 * @param count 骰数（≥1 的整数）
 */
export function rollDice(rng: RngState, count: number): RngDraw<DiceRoll> {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`掷骰数量须为 ≥1 的整数，收到 ${count}`)
  }

  let current = rng
  const faces: number[] = []
  for (let index = 0; index < count; index += 1) {
    const draw = rollDie(current)
    current = draw.rng
    faces.push(draw.value)
  }

  const total = faces.reduce((sum, face) => sum + face, 0)
  return { rng: current, value: { count, faces, total } }
}

/** 掷 1 骰（1d6）：天气判定（专规 1.5）、夺取表（9.14b）等 */
export function roll1d6(rng: RngState): RngDraw<DiceRoll> {
  return rollDice(rng, 1)
}

/** 掷 2 骰（2d6）：战斗表（9.9）、空战（14.3e）、防空（14.4e）等 */
export function roll2d6(rng: RngState): RngDraw<DiceRoll> {
  return rollDice(rng, 2)
}

/**
 * 等概率抽取 `[0, size)` 的**下标**（无取模偏差）
 *
 * 用途：随机抽取盒（1.6c 从死亡堆里抽一个师、剧本编队抽签抽 N 个编队）需要「在候选池中
 * 均匀抽一个」，而骰子只给 1–6。与 `rollDie` 同样用拒绝采样丢掉尾部余数，保证等概率。
 *
 * @param size 候选个数（≥1 的整数）
 */
export function pickIndex(rng: RngState, size: number): RngDraw<number> {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`候选个数须为 ≥1 的整数，收到 ${size}`)
  }
  if (size === 1) return { rng, value: 0 }
  const limit = Math.floor(2 ** 32 / size) * size
  let draw = nextUint32(rng)
  while (draw.value >= limit) {
    draw = nextUint32(draw.rng)
  }
  return { rng: draw.rng, value: draw.value % size }
}

/**
 * 仅推进状态若干步（不取值）：用于跳过、或从种子重推时对齐游标
 *
 * @param steps 推进步数（≥0 的整数）
 */
export function advance(rng: RngState, steps: number): RngState {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new RangeError(`推进步数须为 ≥0 的整数，收到 ${steps}`)
  }

  let state = rng.state
  let drawCount = rng.drawCount
  for (let index = 0; index < steps; index += 1) {
    state = step(state).state
    drawCount += 1
  }
  return { seed: rng.seed, state, drawCount }
}

/**
 * 由种子与抽取次数从头重建状态（复算入口）
 *
 * 存档若只保留 seed，也可用本函数回复到任意一次结算前的状态。
 */
export function replayFrom(seed: number, drawCount: number): RngState {
  if (!Number.isInteger(drawCount) || drawCount < 0) {
    throw new RangeError(`抽取次数须为 ≥0 的整数，收到 ${drawCount}`)
  }
  return advance(createRngState(seed), drawCount)
}

/**
 * 校验存档中的 RNG 状态可复算（seed + drawCount 重推的内部状态应与存档一致）
 *
 * 任一结算可复算的前提是「种子—游标—内部状态」三者自洽；本函数用于读档时的完整性检查。
 */
export function verifyRngState(rng: RngState): boolean {
  if (
    !Number.isInteger(rng.seed) ||
    !Number.isInteger(rng.state) ||
    !Number.isInteger(rng.drawCount)
  ) {
    return false
  }
  if (rng.seed < 0 || rng.state < 0 || rng.drawCount < 0) return false
  return replayFrom(rng.seed, rng.drawCount).state === rng.state
}
