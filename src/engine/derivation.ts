import type { DiceRoll } from './state-types'

/**
 * 结算复核（W7 C11：骰点 / 计算过程 / 规则编号 / 修正来源）
 *
 * ## 这一层解决什么
 *   引擎各结算函数把「骰点 ＋各项修正」直接算成一个标量（如 `modifiedDice`），
 *   修正的**来源**（哪个单位、什么条件、依据哪条规则）随之丢失。
 *   本模块把一次结算摊开成一串**有出处**的步骤，供界面逐项展示与复核：
 *     `骰点 → 修正项（值 + 来源 + 规则号）→ 合计 → 取列/查表 → 结果`
 *
 * ## 硬纪律（不得无中生有）
 *   - 本模块**不重算任何规则**：`modifier` 的值要么直接来自引擎已算出的结论
 *     （如 9.6 的 `drm = 攻方AR − 守方AR`），要么由**同一个常量来源**逐项加总而来
 *     （如 14.4e 防空、12.8b 损耗，常量仍取自 `rules-constants.json`）；
 *   - 每个构造器都与它所对应的引擎函数**成对**，并在测试里做**等价性核对**
 *     （`modifier` 之和 === 该函数用的 DRM、`subtotal` === 该函数算出的修正后骰值），
 *     从而保证「界面上看到的计算过程」与「引擎实际用的算式」是同一件事；
 *   - 规则号一律写在步骤上（`rule`），便于反向检索规则书。
 *
 * ## 两种落点
 *   ① **结算日志**：写入方把 derivation 放进 `outcome.data` 的 `DERIVATION_KEY` 键，
 *      日志数据层（`log-book.ts`）会识别并单独渲染（不再当普通明细 JSON 摊平）；
 *   ② **实时复核**：把当前这次结算（如战斗）的结论交给对应构造器，界面即时展示。
 */

/* ────────────────────────────── 类型 ────────────────────────────── */

/** 步骤类别 */
export type DerivationStepKind = 'dice' | 'modifier' | 'subtotal' | 'fact' | 'lookup' | 'result'

interface StepBase {
  kind: DerivationStepKind
  /** 步骤名（界面左栏） */
  label: string
  /** 该步骤的规则依据（与规则编号对齐） */
  rule: string
}

/** 骰点：这一掷掷了什么（骰面 + 合计） */
export interface DiceStep extends StepBase {
  kind: 'dice'
  rolls: readonly DiceRoll[]
  /** 掷骰者 / 用途的来源说明（如「攻方奇袭掷骰」） */
  source: string
}

/** 修正项：作用于**骰值**的一项加减，必须写出值、来源与规则号 */
export interface ModifierStep extends StepBase {
  kind: 'modifier'
  value: number
  source: string
}

/** 合计：骰值经全部修正后的结果（引擎已算出的那个数） */
export interface SubtotalStep extends StepBase {
  kind: 'subtotal'
  value: number
  /** 合计来历的算式文字（如 `7 ＋2 −1`） */
  formula: string
}

/** 事实项：不加减骰值、但决定**取列/查表/判定**的输入（军力、倍率、地形、攻防比…） */
export interface FactStep extends StepBase {
  kind: 'fact'
  text: string
  source: string
}

/** 取列 / 查表 */
export interface LookupStep extends StepBase {
  kind: 'lookup'
  /** 表名（如 `CRT9.9` / `轰炸 10.0a` / `天气表`） */
  table: string
  /** 行（如修正后骰值） */
  row?: string | number
  /** 列（如 `3:1` / 地形列组） */
  column?: string
}

/** 结果 */
export interface ResultStep extends StepBase {
  kind: 'result'
  value: string
}

/** 一步 */
export type DerivationStep =
  DiceStep | ModifierStep | SubtotalStep | FactStep | LookupStep | ResultStep

/** 一次结算的完整复核过程 */
export interface Derivation {
  /** 结算名（如「战斗结算」「防空掷骰」） */
  title: string
  /** 该结算的总规则依据（如 `9.9`） */
  rule: string
  steps: readonly DerivationStep[]
}

/** 写入 `outcome.data` 时使用的键名（日志数据层据此识别并单独渲染） */
export const DERIVATION_KEY = 'derivation'

/* ────────────────────────────── 构造工具 ────────────────────────────── */

/** 骰点步骤 */
export function diceStep(input: {
  label: string
  rule: string
  source: string
  rolls: readonly DiceRoll[]
}): DiceStep {
  return {
    kind: 'dice',
    label: input.label,
    rule: input.rule,
    source: input.source,
    rolls: input.rolls,
  }
}

/** 修正项步骤（值为 0 也照留 —— 复核要看到「这一项算过且为 0」） */
export function modifierStep(input: {
  label: string
  rule: string
  source: string
  value: number
}): ModifierStep {
  return {
    kind: 'modifier',
    label: input.label,
    rule: input.rule,
    source: input.source,
    value: input.value,
  }
}

/** 事实项步骤 */
export function factStep(input: {
  label: string
  rule: string
  source: string
  text: string
}): FactStep {
  return {
    kind: 'fact',
    label: input.label,
    rule: input.rule,
    source: input.source,
    text: input.text,
  }
}

/** 取列 / 查表步骤 */
export function lookupStep(input: {
  label: string
  rule: string
  table: string
  row?: string | number
  column?: string
}): LookupStep {
  return {
    kind: 'lookup',
    label: input.label,
    rule: input.rule,
    table: input.table,
    ...(input.row === undefined ? {} : { row: input.row }),
    ...(input.column === undefined ? {} : { column: input.column }),
  }
}

/** 结果步骤 */
export function resultStep(input: { label: string; rule: string; value: string }): ResultStep {
  return { kind: 'result', label: input.label, rule: input.rule, value: input.value }
}

/** 修正项之和（只加 `modifier` 步骤；纯展示算术，不涉规则判定） */
export function modifierTotal(derivation: Derivation): number {
  return derivation.steps.reduce(
    (sum, step) => (step.kind === 'modifier' ? sum + step.value : sum),
    0,
  )
}

/** 把一步渲染成一行文字（界面与日志共用，避免两处口径） */
export function formatStep(step: DerivationStep): string {
  switch (step.kind) {
    case 'dice': {
      const rolls = step.rolls.map((roll) => `${roll.faces.join('+')}=${roll.total}`).join(' / ')
      return `骰点 ${rolls === '' ? '（无掷骰记录）' : rolls}（${step.source}｜${step.rule}）`
    }
    case 'modifier':
      return `${step.value >= 0 ? '＋' : '−'}${Math.abs(step.value)} ${step.label}（${step.source}｜${step.rule}）`
    case 'subtotal':
      return `${step.label} ${step.value}（${step.formula}）`
    case 'fact':
      return `${step.label}：${step.text}（${step.source}｜${step.rule}）`
    case 'lookup':
      return `查表 ${step.table}${step.row === undefined ? '' : ` 行 ${step.row}`}${
        step.column === undefined ? '' : ` 列 ${step.column}`
      }（${step.rule}）`
    case 'result':
      return `结果 ${step.value}（${step.rule}）`
  }
}

/** 把整段复核渲染成一行（日志摘要 / 悬浮提示用） */
export function formatDerivation(derivation: Derivation): string {
  return `${derivation.title}（${derivation.rule}）：${derivation.steps.map(formatStep).join(' ⇒ ')}`
}

/* ────────────────────────────── 逐条解析（读档后的日志） ────────────────────────────── */

/** 断言取对象 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 解析骰点（faces/total/count 均为数字才收） */
function parseRolls(value: unknown): DiceRoll[] | null {
  if (!Array.isArray(value)) return null
  const rolls: DiceRoll[] = []
  for (const raw of value) {
    const record = asRecord(raw)
    if (record === null) return null
    const { count, total } = record
    const faces = record['faces']
    if (typeof count !== 'number' || typeof total !== 'number' || !Array.isArray(faces)) return null
    if (!faces.every((face) => typeof face === 'number')) return null
    rolls.push({ count, total, faces: faces as number[] })
  }
  return rolls
}

/** 解析一步；形状不认识即返回 null（整段作废，不半信半疑） */
function parseStep(value: unknown): DerivationStep | null {
  const record = asRecord(value)
  if (record === null) return null
  const kind = record['kind']
  const label = record['label']
  const rule = record['rule']
  if (typeof kind !== 'string' || typeof label !== 'string' || typeof rule !== 'string') return null

  switch (kind) {
    case 'dice': {
      const rolls = parseRolls(record['rolls'])
      const source = record['source']
      if (rolls === null || typeof source !== 'string') return null
      return { kind: 'dice', label, rule, source, rolls }
    }
    case 'modifier': {
      const value = record['value']
      const source = record['source']
      if (typeof value !== 'number' || typeof source !== 'string') return null
      return { kind: 'modifier', label, rule, source, value }
    }
    case 'subtotal': {
      const value = record['value']
      const formula = record['formula']
      if (typeof value !== 'number' || typeof formula !== 'string') return null
      return { kind: 'subtotal', label, rule, value, formula }
    }
    case 'fact': {
      const text = record['text']
      const source = record['source']
      if (typeof text !== 'string' || typeof source !== 'string') return null
      return { kind: 'fact', label, rule, text, source }
    }
    case 'lookup': {
      const table = record['table']
      if (typeof table !== 'string') return null
      const row = record['row']
      const column = record['column']
      return {
        kind: 'lookup',
        label,
        rule,
        table,
        ...(typeof row === 'number' || typeof row === 'string' ? { row } : {}),
        ...(typeof column === 'string' ? { column } : {}),
      }
    }
    case 'result': {
      const value = record['value']
      if (typeof value !== 'string') return null
      return { kind: 'result', label, rule, value }
    }
    default:
      return null
  }
}

/**
 * 从 `outcome.data` 里取出复核过程
 *
 * 存档读回后 `data` 是 `unknown`（JSON），故此处**逐字段校验**：
 * 形状不认识即返回 null（当作没有复核过程），绝不半信半疑地渲染。
 */
export function derivationFromOutcomeData(data: Record<string, unknown>): Derivation | null {
  const raw = data[DERIVATION_KEY]
  const record = asRecord(raw)
  if (record === null) return null
  const title = record['title']
  const rule = record['rule']
  const steps = record['steps']
  if (typeof title !== 'string' || typeof rule !== 'string' || !Array.isArray(steps)) return null
  const parsed: DerivationStep[] = []
  for (const item of steps) {
    const step = parseStep(item)
    if (step === null) return null
    parsed.push(step)
  }
  return { title, rule, steps: parsed }
}
