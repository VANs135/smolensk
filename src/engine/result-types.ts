/**
 * 结果对象与规则引用（B3）
 *
 * 规范依据：
 *   - CODE_SPEC.md §3.6「规则编号落字符串」：任何结算都带上它依据的规则编号
 *     （如 `'9.5'`、`'12.8e'`），便于反向检索规则书与整局回归比对。
 *   - CODE_SPEC.md §7：引擎单元配规则条款级单测，测试名含规则编号。
 *
 * 统一结果形状（所有规则函数共用同一把尺子）：
 *   成功 → `{ ok: true, rule, data, pending }`   —— 依据的规则、结算数据、待处理项
 *   失败 → `{ ok: false, rule, reason }`         —— 依据的规则、机器可读的原因码
 *
 * 「待处理项」（pending）用于规则上**不能一次结清**的部分：需要玩家决策
 * （如 9.10 选项：撤退或损失）、或留到后续阶段施加的标记（5.10 混乱 / 9.13 进击）。
 * 这样一次调用的返回即「已结算 + 待结算」，调用方无需再猜哪些事还没做。
 *
 * 本文件是结果模型的唯一定义处：形状与它的唯一构造路径放在一起，
 * 调用方一律经 succeed() / fail() 构造，保证 `pending` 等字段不缺项。
 */

/**
 * 规则引用：规则编号字符串（如 `'9.5'` / `'12.8e'` / `'专规 2.2a'`）
 *
 * 故意用普通字符串而非封闭枚举：OCS 编号是「章节.条」，跨通规与专规，
 * 枚举化无收益且每次引用新条款都要改类型。
 */
export type RuleRef = string

/**
 * 结果数据载荷
 *
 * 引擎内各规则函数用具体泛型参数（如 `RuleOutcome<CombatResult>`）；
 * 只有进入日志（需同质数组）时才退化为本类型。
 */
export type OutcomeData = Record<string, unknown>

/**
 * 待处理项类别（词表随各命令单元补齐；以下为已登记的规则概念，均见 §5 术语表）
 *
 * - `option`            9.10 选项（撤退或损失）
 * - `advanceAfterCombat` 9.12g 战后推进
 * - `dg`                5.10 混乱标记
 * - `exploit`           9.13 / 11.0 进击标记
 */
export type PendingKind = 'option' | 'advanceAfterCombat' | 'dg' | 'exploit'

/** 待处理项：本次结算留下、但尚未结清的事项 */
export interface PendingEffect {
  /** 待处理类别 */
  kind: PendingKind
  /** 涉及的单位实例 id（针对整格的待处理项为空数组） */
  unitIds: string[]
  /** 该待处理项的规则依据 */
  rule: RuleRef
  /** 面向玩家的说明（界面提示用） */
  note?: string
}

/** 成功结果：依据的规则 + 结算数据 + 待处理项（无待处理时为空数组） */
export interface RuleSuccess<T> {
  ok: true
  rule: RuleRef
  data: T
  pending: PendingEffect[]
}

/** 失败结果：依据的规则 + 机器可读的原因码（具体词表由各模块登记） */
export interface RuleFailure {
  ok: false
  rule: RuleRef
  reason: string
}

/** 统一结果对象（判别联合：以 `ok` 收窄） */
export type RuleOutcome<T> = RuleSuccess<T> | RuleFailure

/**
 * 构造成功结果（唯一构造路径）
 *
 * @param rule    依据的规则编号
 * @param data    结算数据
 * @param pending 待处理项；省略即无（默认空数组，保证形状一致）
 */
export function succeed<T>(rule: RuleRef, data: T, pending: PendingEffect[] = []): RuleSuccess<T> {
  return { ok: true, rule, data, pending }
}

/**
 * 构造失败结果（唯一构造路径）
 *
 * @param rule   依据的规则编号
 * @param reason 机器可读的原因码（如 `'prohibited'` / `'unknownTerrain'`）
 */
export function fail(rule: RuleRef, reason: string): RuleFailure {
  return { ok: false, rule, reason }
}

/** 成功判别（布尔量按 §4 以 is 开头命名） */
export function isSuccess<T>(outcome: RuleOutcome<T>): outcome is RuleSuccess<T> {
  return outcome.ok
}

/** 失败判别 */
export function isFailure<T>(outcome: RuleOutcome<T>): outcome is RuleFailure {
  return !outcome.ok
}
