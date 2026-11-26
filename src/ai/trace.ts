/**
 * AI 训练 / 采集的**数据契约**（TS ↔ Python 的唯一交接面）
 *
 * 定位：
 * - 驱动不落盘、不做 IO；这里只定义"一局元信息"与"一步记录"的形状，以及观测的序列化；
 * - 采集器（`tests/tools` 下的 vitest 用例或 `scripts/` 下的 vite-node 脚本）负责写 JSONL；
 * - 训练侧只认这些字段，**不直接读 store、不自己拼观测**。
 *
 * 硬约束：
 * 1. `obs` 必须来自 `snapshotOf`（`AiSnapshot`），不能另拼一套；
 * 2. `act` / `intent` 一律以 `actionKeyOf` 为键，新增动作 kind 只增不改；
 * 3. `AI_IO_VERSION` 随观测结构变化递增；模型加载时必须校验版本（不匹配就拒载）。
 */
import type { AiAction, AiControlMode, AiSnapshot } from './policy'

/**
 * 观测版本号
 *
 * 1：2026-11-25 首版（`AiSnapshot` 全量 + `can` 转字符串数组）
 * 2：2026-11-26 增加 `branch.dumpBlow`（12.11a 销毁补给站候选）
 *
 * 改 `AiSnapshot` 的字段、含义、取值范围都要 +1；训练数据与模型文件都记这个号。
 */
export const AI_IO_VERSION = 2

/** 一局元信息（JSONL 的首行；采集器负责填 `ep` / `seed` / 时间） */
export interface AiEpisodeMeta {
  /** 采集批次内的局号（从 1 开始；与文件名/种子一起定位唯一一局） */
  ep: number
  scenarioId: string
  /** 本局 PRNG 种子（`ctx.w.seed` / `session.startGame(seed)`） */
  seed: number
  aiProfile: 'full' | 'baseline'
  /** 本局动作由谁产出：脚本策略（采集基线）或外部策略（自对打/蒸馏） */
  policy: 'scripted' | 'nn'
  ioVersion: number
  control: AiControlMode
  startedAt: string
  /** 采集器的说明（可选）：命令行、提交号、机器名 */
  note?: string
}

/**
 * 一步记录（JSONL 的一行，由采集器逐行追加）
 *
 * ★ `t`（局内步序）由采集器自己维护：驱动是单步函数，不持有局内游标。
 */
export interface AiStepRecord {
  turn: number
  phase: string
  /** 环节步 id（`segmentStep.id`，如 `movement.barrage`） */
  segment: string
  /** 同 `segment`（保留字段名对齐报告里的 `segment`） */
  step: string
  side: 'axis' | 'soviet'
  /**
   * `actionKeyOf(action)` 的结果；拒绝时也是"想做什么"，便于统计
   *
   * ★ 部分 key 内嵌 `instanceId`（如 `transportLoad:u-mwvvfrsr-co`），仅供**同局内**定位：
   *   跨进程不复现（`createId` 含 `Date.now()`），做特征/统计前须先归一化掉 id 段。
   */
  intent: string
  /** 完整动作（含参数）：训练侧解码的对照物 */
  act: AiAction
  /** 观测（未序列化；写盘前过 `serializeObservation`） */
  obs: AiSnapshot
  ok: boolean
  /** 引擎/入口拒绝的条款号（`ok:false` 时尽量有） */
  rule?: string
  /** 拒绝人话（给数据集做可读抽样用） */
  reason?: string
  /** 本步执行后是否终局 */
  terminal: boolean
  /** 外部策略给出的动作结构非法、已回退脚本策略（训练侧应把它当负样本，而不是专家动作） */
  fellBack?: boolean
}

/**
 * 观测序列化：把 `AiSnapshot` 转成**可 JSON**的纯数据
 *
 * 现状只有 `can: ReadonlySet<string>` 需要转换（转成**排序后**的字符串数组，保证同盘面同字节）；
 * 其余字段已是纯数据，这里仍做一次深拷贝式转换，避免调用方误改快照对象。
 */
export function serializeObservation(snap: AiSnapshot): Record<string, unknown> {
  return jsonSafe(snap) as Record<string, unknown>
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Set) {
    // 集合成员的次序本身不稳定（插入序），训练/复算都要求同一盘面字节一致 ⇒ 统一按字符串排序
    return [...value].map(jsonSafe).sort((a, b) => String(a).localeCompare(String(b)))
  }
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(item)
    }
    return out
  }
  return value
}
