import { rulesConstants } from '@/data'
import type { HexRef, Side } from '@/data'

import { hexDistance } from '../hex-geometry'
import type { GamePhase, InternalStocks } from '../state-types'
import { attritionLookup, type AttritionResult } from '../tables/attrition'
import type { BaseMode } from './modes'
import { SP_TO_T, STOCK_LOW_T_PER_RE, computeDumpBlowLoss } from './supply'
import type { StockLevel } from './supply'
import {
  assessUnitSupply,
  eatingOffTheMapCostT,
  planOutOfSupply,
  type OutOfSupplyPlan,
  type SupplyMobility,
  type SupplyVerdict,
  type TraceSupplyFacts,
  type UnitSupplyAssessment,
} from './trace-supply'

/**
 * 补给阶段与断补损耗（B11，OCS 12.8 / 12.10 / 12.11 / 9.14d）
 *
 * 本模块是**补给阶段的调度与结算**，只消费 B10（trace-supply.ts）的追溯补给判定，
 * 不重复实现补给线（12.6）：物资「够不够得着」问 B10，本模块管「阶段里按什么顺序花 SP、欠什么账」。
 *
 * ## 条文索引（中文规则书 / `ocs-rules-v43` ch08）
 *   - 12.8a 补给阶段中无法「获得追溯补给」或「吃图上补给」的友方堆叠被标记断补；标记保留到
 *           下一个友方补给阶段重新判定为有追溯补给为止；每个友方补给阶段结束时检查损耗
 *   - 12.8b 损耗表：掷 2 骰，用**断补单位中最高的行动值**取列，数格内**断补单位的军力数**；
 *           格值＝该堆叠必须损失的军力点数；由拥有者决定谁承受（**无**「最高 AR 必须承受」的要求）；
 *           掷骰修正 **格中断补军力 ≥5 时 +3**
 *   - 12.8c 检查损耗时**不因 DG 修正 AR**，但要按**战略模式**修正（战略模式 AR 归 0）
 *   - 12.10 部队储备（Low / Exhausted）：只能用于战斗补给
 *   - 12.10e 恢复：在自己的补给阶段，若这些单位**可拖取或可被投递** SP，则**必须尽量恢复**——
 *            Low 单位 2T/单位（多军力单位＝其 RE 数量的补给），Exhausted ＝ 两倍；
 *            A) 恢复部队储备的优先级**高于**把 SP 用于替代追溯补给；
 *            B) 只要可拖取/可投递就必须恢复（例外：编内卡车上的 SP）；
 *            C) 不足以完全恢复时**消耗现有全部补给**：1T 直接浪费；2T 可恢复一个 Low 单位，
 *            或把 Exhausted 改为 Low（唯一待恢复单位是多军力时，2T 同样浪费）
 *   - 12.11a 销毁补给站：担心被夺取时可在**己方移动/反应/进击阶段的移动环节**销毁该格全部或部分 SP
 *            （含装在运输点上的 SP）；**每个阶段每个补给站只能尝试一次**；掷 1 骰查表得销毁百分比，
 *            损失**取整到最接近的 T**；**运输点数不会以此方式被摧毁**
 *   - 9.14d 延补队崩溃：敌方可攻击单位进入该格时必须崩溃（也可在常规移动时主动崩溃）——
 *            位移到其**特殊拖取距离**内的任意格，前提是**该格此时有追溯补给**；
 *            敌方单位、ZOC 与禁入地形**对位移均无影响**，且不产生损失或夺取；
 *            在新格翻面到常规运输点数面。**若不存在合法格**，则在原格不动、翻面，并按 9.14c 接受夺取判定
 *
 * ## 设计口径
 *   - 「SP 分配」按 12.10e-A 的优先级实现：**先**强制恢复部队储备，**再**把剩下的 SP 用于吃图上补给；
 *   - 取表只走 `engine/tables`（损耗表在 charts-tables.json）；数值只取自 rules-constants.json；
 *   - 掷骰由调用方注入骰面（种子化 RNG，可复算），本模块不含随机。
 */

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 部队储备「低」的每单位基准 T（12.10e） */
export const STOCK_LOW_T_PER_UNIT = rulesConstants.supply.stockLowTPerUnit

/** 部队储备「耗尽」相对「低」的倍数（12.10e：两倍） */
export const STOCK_EXHAUSTED_MULT = rulesConstants.supply.stockExhaustedMult

/** 可尝试销毁补给站的移动环节（12.11a：移动 / 反应 / 进击三个移动环节） */
export const DUMP_DESTRUCTION_SEGMENTS: readonly GamePhase[] = [
  'movement',
  'reaction',
  'exploitation',
]

/* ────────────────────────────── 12.8 损耗 ────────────────────────────── */

/**
 * 12.8c：取列用的行动值
 *
 * 「不要因单位处于 DG 模式而修正单位的 AR，但要按战略模式进行修正」——
 * 故 DG 一律**不加修正**；战略模式的 AR 按 0（5.8：战略模式行动值降为 0）。
 */
export function attritionArOf(unit: { ar: number; mode: BaseMode }): number {
  return unit.mode === 'strat' ? 0 : unit.ar
}

/** 12.8b：断补堆叠的取列 AR ＝ 断补单位中最高的行动值（无断补单位时无意义，返回 0） */
export function attritionStackAr(
  units: readonly { id: string; ar: number; mode: BaseMode }[],
): number {
  let best = 0
  for (const unit of units) best = Math.max(best, attritionArOf(unit))
  return best
}

/**
 * 12.8b：损耗判定
 *
 * @param die      2 骰之和（2–12）
 * @param bestAr   格中断补单位中最高的行动值（用 `attritionStackAr` 算好）
 * @param oosSteps 格中断补单位的军力点数合计（≥5 时 +3）
 */
export function resolveAttrition(input: { die: number; bestAr: number; oosSteps: number }): {
  rule: '12.8b'
  losses: AttritionResult
  modifiedDice: number
  drm: number
  raw: string
} {
  const lookup = attritionLookup(input.die, input.bestAr, input.oosSteps)
  return {
    rule: '12.8b',
    losses: lookup.result,
    modifiedDice: lookup.modifiedDice,
    drm: lookup.drm,
    raw: lookup.raw,
  }
}

/**
 * 12.8b：损耗义务的校验
 *
 * 「表格的结果代表该堆叠必须损失的军力点数总量。堆叠的拥有者玩家可以选择如何让该堆叠中的
 *   断补单位承受这些损失。**没有**让 AR 最高的单位必须承受损失的要求。」
 * 故本函数只校验「分摊合法且恰好满足义务」：
 *   - 每单位分摊不超过其现有军力；
 *   - 合计恰等于要求的点数（`all` 表示该格**所有**断补单位的军力全部损失）。
 */
export function validateAttritionAllocation(input: {
  required: number | 'all'
  /** 该格全部断补单位（军力点数） */
  units: readonly { id: string; steps: number }[]
  allocation: Readonly<Record<string, number>>
}): SupplyVerdict {
  const known = new Map(input.units.map((unit) => [unit.id, unit.steps]))
  let total = 0
  for (const [unitId, steps] of Object.entries(input.allocation)) {
    const available = known.get(unitId)
    if (available === undefined)
      return {
        ok: false,
        rule: '12.8b',
        reason: 'unknownUnit',
        detail: `分摊给了不在该格断补单位之列的 ${unitId}`,
      }
    if (!Number.isInteger(steps) || steps < 0)
      return { ok: false, rule: '12.8b', reason: 'badSteps', detail: `${unitId} 分摊 ${steps}` }
    if (steps > available)
      return {
        ok: false,
        rule: '12.8b',
        reason: 'exceedsSteps',
        detail: `${unitId} 分摊 ${steps} > 现有军力 ${available}`,
      }
    total += steps
  }
  if (input.required === 'all') {
    const full = input.units.reduce((sum, unit) => sum + unit.steps, 0)
    if (total !== full)
      return {
        ok: false,
        rule: '12.8b',
        reason: 'allStepsNotMet',
        detail: `结果为 All Steps，须消灭该格全部断补军力 ${full}，实分摊 ${total}`,
      }
    return { ok: true, rule: '12.8b', detail: `全部 ${full} 点军力损失` }
  }
  if (total !== input.required)
    return {
      ok: false,
      rule: '12.8b',
      reason: 'lossNotMet',
      detail: `须损失 ${input.required} 点，实分摊 ${total}`,
    }
  return { ok: true, rule: '12.8b', detail: `损失 ${total} 点军力` }
}

/* ────────────────────────────── 12.11a 主动销毁补给站 ────────────────────────────── */

/**
 * 12.11a：能否此刻尝试销毁补给站
 *
 * 「这只能在该玩家的移动、反应和进击阶段中的移动环节进行。玩家在每个阶段中，
 *   只能每个补给站只能尝试销毁一次。」
 */
export function canAttemptDumpDestruction(input: {
  /** 当前 SOP 段（2.2：只有三个移动环节可尝试） */
  segment: GamePhase
  /** 本阶段已对该补给站尝试销毁的次数（0＝尚未尝试） */
  attemptsThisPhase?: number
}): SupplyVerdict {
  if (!DUMP_DESTRUCTION_SEGMENTS.includes(input.segment))
    return {
      ok: false,
      rule: '12.11a',
      reason: 'wrongSegment',
      detail: `销毁补给站只能在移动环节进行（本作三个移动环节：${DUMP_DESTRUCTION_SEGMENTS.join(' / ')}）`,
    }
  if ((input.attemptsThisPhase ?? 0) >= 1)
    return {
      ok: false,
      rule: '12.11a',
      reason: 'alreadyAttempted',
      detail: '每个阶段每个补给站只能尝试销毁一次',
    }
  return { ok: true, rule: '12.11a' }
}

/** 12.11a：掷 1 骰 → 销毁百分比（25 / 50 / 75 / 100） */
export function dumpDestructionPercent(die: number): number {
  return computeDumpBlowLoss(die)
}

/** 补给点数拆分：T → SP 与余数 T（12.1a：1 SP = 4 T） */
export function supplyTokensOf(t: number): { sp: number; t: number } {
  const whole = Math.max(0, Math.trunc(t))
  return { sp: Math.floor(whole / SP_TO_T), t: whole % SP_TO_T }
}

/**
 * 12.11a：销毁结果
 *
 * 「玩家可尝试销毁补给站中的全部 SP，或只尝试销毁其中部分的 SP……根据补给站销毁表掷一枚骰子，
 *   以确定被销毁 SP 的百分比。将销毁的损失以 T 作为最小单位进行取整，取整到最接近的 T 值。
 *   注意运输点数不能以这种方式摧毁。」
 *
 * @param requestedT 本次尝试销毁的 SP 折算成的 T（全部或部分；不含运输点数）
 * @param percent    销毁百分比（`dumpDestructionPercent(die)`）
 */
export function planDumpDestruction(input: { requestedT: number; percent: number }):
  | {
      ok: true
      destroyedT: number
      sp: number
      t: number
      rule: '12.11a'
      detail: string
    }
  | {
      ok: false
      rule: '12.11a'
      reason: string
      detail: string
    } {
  if (!Number.isFinite(input.requestedT) || input.requestedT < 0)
    return {
      ok: false,
      rule: '12.11a',
      reason: 'badRequest',
      detail: `销毁量 ${input.requestedT} T 非法`,
    }
  if (!Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100)
    return {
      ok: false,
      rule: '12.11a',
      reason: 'badPercent',
      detail: `百分比 ${input.percent} 非法`,
    }
  const destroyedT = Math.round((input.requestedT * input.percent) / 100)
  const tokens = supplyTokensOf(destroyedT)
  return {
    ok: true,
    destroyedT,
    sp: tokens.sp,
    t: tokens.t,
    rule: '12.11a',
    detail: `${input.requestedT} T × ${input.percent}% → ${destroyedT} T（${tokens.sp} SP + ${tokens.t} T）`,
  }
}

/* ────────────────────────────── 12.10 部队储备（强制恢复） ────────────────────────────── */

/**
 * 需恢复的部队储备档位（12.10：Low / Exhausted）
 *
 * ★ 口径唯一（M3②）：档位类型与"用一次降一级"的判据都在 `supply.ts`（12.10 的原文所在），
 *   本模块**转发**它，不再自持一份 `Exclude<InternalStocks, null>`。
 */
export type { StockLevel }

/**
 * 12.10e：恢复一个单位部队储备的 T 成本
 *
 * 「恢复低下的单位时，每个单位消耗 2T（如果是多军力单位，则需要花费等同于其 RE 数量的补给）；
 *   恢复耗尽的单位时，需要消耗两倍的补给。」
 * 落实口径：单军力单位取 `stockLowTPerUnit`；多军力单位取 `RE × stockLowTPerRe`；
 * Exhausted 再乘 `stockExhaustedMult`。**这三项都取自 rules-constants.supply**，
 * 若规则书复核后需改为「每 RE 1 SP」，只改数据一处即可。
 */
export function internalStocksReplenishCost(input: {
  level: StockLevel
  /** 团级当量（4.6） */
  reSize: number
  /** 是否多军力单位（多军力按其 RE 计） */
  multiStep: boolean
}): { ok: true; t: number; rule: '12.10e' } | { ok: false; rule: '12.10e'; reason: string } {
  if (!Number.isFinite(input.reSize) || input.reSize <= 0)
    return { ok: false, rule: '12.10e', reason: `RE 非正数（${input.reSize}）` }
  const base = input.multiStep
    ? Math.round(input.reSize * STOCK_LOW_T_PER_RE)
    : STOCK_LOW_T_PER_UNIT
  const t = input.level === 'exhausted' ? base * STOCK_EXHAUSTED_MULT : base
  return { ok: true, t, rule: '12.10e' }
}

/** 恢复结果条目 */
export interface StockRecovery {
  unitId: string
  from: StockLevel
  /** 恢复到 ready（＝null）或仅降级到 low（12.10e-C 的「耗尽改为低下」） */
  to: 'ready' | 'low'
  costT: number
}

/** 部队储备恢复计划（12.10e-A/B/C） */
export interface InternalStocksRecoveryPlan {
  rule: '12.10e'
  /** 实际执行的恢复（按输入单位顺序） */
  recoveries: StockRecovery[]
  /** 已消耗 T */
  spentT: number
  /**
   * **被浪费**的 T（12.10e-C）
   *
   * 只在「现有 SP 不足以完全恢复」时出现：此时必须消耗现有全部补给，花不出去的即为浪费
   * （1T 直接浪费；唯一待恢复单位是多军力单位时 2T 同样浪费）。SP 充裕时不会有浪费，余额留作 SP。
   */
  wastedT: number
  /** 仍待恢复的单位实例 id */
  unmet: string[]
}

/**
 * 12.10e-A/B/C：部队储备的强制恢复
 *
 * 「在拥有部队储备低下或耗尽单位的玩家的补给阶段中，如果有了可用的 SP（可通过直接拖取或从指挥部
 *   投递），则要将标记为低下或耗尽的单位的部队储备进行恢复」——故 `canDraw` 为真者**必须**恢复；
 * 「A) 各单位必须尽可能地恢复部队储备」；
 * 「C) 如果现有一些 SP，但**不足以完全恢复**内部储备，则需要消耗现有的全部补给。只有一个 T，
 *   则将直接被浪费掉；2 个 T 可恢复一个低下的单位，或将一个耗尽的单位改为低下（如果唯一需要恢复的
 *   单位是多军力单位，则 2T 也会被浪费）」——故仅在**不足**时把现有 SP 用完，余额即为 `wastedT`；
 *   SP 充裕时按需消耗，余额留在 SP 池中（不是浪费）。
 *
 * @param units      待恢复单位（调用方须先判 `canDraw`＝该单位本阶段可拖取或被投递到 SP；
 *                   编内卡车上的 SP 例外：12.10e-B，调用方直接置 false）
 * @param availableT 本阶段可用于恢复的 T
 */
export function planInternalStocksRecovery(input: {
  units: readonly {
    id: string
    level: StockLevel
    reSize: number
    multiStep: boolean
    /** 12.10e-B：本阶段是否可拖取/可被投递到 SP */
    canDraw: boolean
  }[]
  availableT: number
}): InternalStocksRecoveryPlan {
  const available = Math.max(0, input.availableT)
  const recoveries: StockRecovery[] = []
  const unmet: string[] = []

  /** 该单位的「低」价与「完全恢复」价（数据异常者返回 null） */
  const costsOf = (unit: (typeof input.units)[number]): { low: number; full: number } | null => {
    const low = internalStocksReplenishCost({
      level: 'low',
      reSize: unit.reSize,
      multiStep: unit.multiStep,
    })
    if (!low.ok) return null
    return {
      low: low.t,
      full: unit.level === 'exhausted' ? low.t * STOCK_EXHAUSTED_MULT : low.t,
    }
  }

  const eligible = input.units.filter((unit) => unit.canDraw)
  const fullTotal = eligible.reduce((sum, unit) => sum + (costsOf(unit)?.full ?? 0), 0)

  if (available >= fullTotal) {
    // SP 充裕：按需完全恢复，余额留作 SP（12.10e-A）
    let spent = 0
    for (const unit of input.units) {
      if (!unit.canDraw) {
        unmet.push(unit.id)
        continue
      }
      const cost = costsOf(unit)
      if (cost === null) {
        unmet.push(unit.id)
        continue
      }
      spent += cost.full
      recoveries.push({ unitId: unit.id, from: unit.level, to: 'ready', costT: cost.full })
    }
    return { rule: '12.10e', recoveries, spentT: spent, wastedT: 0, unmet }
  }

  // SP 不足（12.10e-C）：尽量恢复；Exhausted 可先降级为 Low；最后**消耗现有全部补给**，余数即浪费
  let remaining = available
  for (const unit of input.units) {
    if (!unit.canDraw) {
      unmet.push(unit.id)
      continue
    }
    const cost = costsOf(unit)
    if (cost === null) {
      unmet.push(unit.id)
      continue
    }
    if (remaining >= cost.full) {
      remaining -= cost.full
      recoveries.push({ unitId: unit.id, from: unit.level, to: 'ready', costT: cost.full })
      continue
    }
    if (unit.level === 'exhausted' && remaining >= cost.low) {
      remaining -= cost.low
      recoveries.push({ unitId: unit.id, from: 'exhausted', to: 'low', costT: cost.low })
      continue
    }
    unmet.push(unit.id)
  }
  const applied = available - remaining
  return {
    rule: '12.10e',
    recoveries,
    // 12.10e-C：不足时必须消耗现有的全部补给
    spentT: available,
    wastedT: available - applied,
    unmet,
  }
}

/* ────────────────────────────── 补给阶段总计划（SP 分配） ────────────────────────────── */

/** 补给阶段参战单位视图（字段名照 state-types） */
export interface SupplyPhaseUnitView {
  id: string
  side: Side
  hex: HexRef | null
  /** 是否战斗单位（12.0：只有战斗单位需要追溯补给与部队储备） */
  isCombat: boolean
  /** 当前军力（3.2） */
  steps: number
  /** 团级当量（4.6） */
  re: number
  /** 印值行动值（3.2c） */
  ar: number
  /** 模式（12.8c：战略模式取列时按 0） */
  mode: BaseMode
  /** 部队储备（12.10） */
  internalStocks: InternalStocks
  /** 是否已带断补标记（12.8a） */
  outOfSupply: boolean
  /** 是否多军力单位（12.10e：多军力按 RE 计恢复成本） */
  multiStep: boolean
}

/** 需掷损耗的堆叠（12.8a/b；按格汇总） */
export interface AttritionDuty {
  hex: HexRef
  unitIds: string[]
  /** 取列 AR＝格中断补单位中最高者（12.8b/12.8c） */
  bestAr: number
  /** 格中断补军力点数（12.8b：≥5 时 +3） */
  oosSteps: number
}

/** 补给阶段计划（SP 分配结果） */
export interface SupplyPhasePlan {
  rule: string
  /** ① 部队储备强制恢复（12.10e；优先级高于「以 SP 代 trace」） */
  internalStocks: InternalStocksRecoveryPlan
  /** ② 恢复之后剩余的 T（可用于吃图上补给，12.6c） */
  remainingT: number
  /** ③ 逐单位补给评估（12.6 / 12.6c；只含当前方单位） */
  assessments: UnitSupplyAssessment[]
  /** ④ 断补标记的置/除（12.6d） */
  outOfSupply: OutOfSupplyPlan
  /** ⑤ 吃图上补给的分配（12.6c：按剩余 T 自前向后分配；affordable=false 者仍会断补） */
  feeding: { unitId: string; costT: number; affordable: boolean }[]
  /** ⑥ 需掷损耗的堆叠（12.8a/b） */
  attritionDuty: AttritionDuty[]
  detail: string
}

/**
 * 补给阶段总计划（2.2 的 D 段；SP 分配顺序照 12.10e-A）
 *
 * 顺序：① 强制恢复部队储备（含「多军力按 RE」「不足则降级/浪费」）→ ② 判定追溯补给与吃图上补给
 * （12.6/12.6c）→ ③ 按剩余 T 分配吃图上补给 → ④ 置/除断补标记（12.6d，只有**真付得起**的才算免于断补）
 * → ⑤ 汇总须掷损耗的断补堆叠（12.8a/b）。
 * `eatOffTheMap(unitId)` 是玩家的自愿选择（12.6c 游戏说明：**永不强迫**吃图上补给）。
 */
export function planSupplyPhase(
  facts: TraceSupplyFacts,
  input: {
    activeSide: Side
    units: readonly SupplyPhaseUnitView[]
    mobility: SupplyMobility
    /** 本阶段可用于「部队储备恢复 + 吃图上补给」的 T 总量 */
    availableT: number
    /** 玩家选择：该单位是否吃图上补给（缺省＝不吃） */
    eatOffTheMap?: (unitId: string) => boolean
    /** 该单位本阶段是否可拖取/可被投递到 SP（12.10e-B；缺省＝true） */
    canDraw?: (unitId: string) => boolean
  },
): SupplyPhasePlan {
  const mine = input.units.filter((unit) => unit.side === input.activeSide)
  const canDraw = input.canDraw ?? (() => true)

  // ① 部队储备强制恢复（12.10e）：只针对战斗单位中带 Low/Exhausted 标记者
  const recovery = planInternalStocksRecovery({
    units: mine
      .filter((unit) => unit.isCombat && unit.internalStocks !== null)
      .map((unit) => ({
        id: unit.id,
        level: unit.internalStocks as StockLevel,
        reSize: unit.re,
        multiStep: unit.multiStep,
        canDraw: canDraw(unit.id),
      })),
    availableT: input.availableT,
  })

  // ② 追溯/吃图上补给判定（12.6）：B10 逐单位评估
  const assessments = mine.map((unit) =>
    assessUnitSupply(
      facts,
      {
        id: unit.id,
        side: unit.side,
        hex: unit.hex,
        isCombat: unit.isCombat,
        re: unit.re,
        mode: unit.mode,
      },
      { mobility: input.mobility },
    ),
  )

  // ③ 吃图上补给（12.6c）：用「恢复之后剩余」的 T 依次分配（12.10e-A：恢复优先）
  //
  // ★ 12.6c 的取整作用在**批次 RE 总量**上（「6.5 的 RE 需消耗 4T」；`trace-supply` 的
  //   `assessUnitSupply#alreadyFedRe` 与交互链同一条口径）⇒ 本循环按**累计已喂 RE** 取增量成本，
  //   不能逐单位各取整再相加（修前取 `assessments` 里逐单位各算的 `eatingCostT` ⇒ 三个 1RE
  //   单位收 3T，而交互链同批次收 2T）。
  let remainingT = Math.max(0, input.availableT - recovery.spentT)
  const feeding: { unitId: string; costT: number; affordable: boolean }[] = []
  const fedUnitIds = new Set<string>()
  let fedRe = 0
  for (const unit of mine) {
    if (input.eatOffTheMap?.(unit.id) !== true) continue
    const assessment = assessments.find((item) => item.unitId === unit.id)
    if (assessment === undefined || !assessment.canEatOffTheMap) continue
    const costT = eatingOffTheMapCostT(fedRe + unit.re) - eatingOffTheMapCostT(fedRe)
    const affordable = remainingT >= costT
    if (affordable) {
      remainingT -= costT
      fedRe += unit.re
      fedUnitIds.add(unit.id)
    }
    feeding.push({ unitId: unit.id, costT, affordable })
  }

  // ④ 断补标记（12.6d）：只有**真正被喂饱**（T 够付）的单位才算免于断补
  const outOfSupply = planOutOfSupply({
    assessments,
    alreadyOutOfSupply: mine.filter((unit) => unit.outOfSupply).map((unit) => unit.id),
    eatOffTheMap: (unitId) => fedUnitIds.has(unitId),
  })

  // ⑤ 损耗义务（12.8a/b）：按格汇总「本阶段结束时仍断补」的堆叠
  const markedOrStill = new Set<string>([
    ...mine.filter((unit) => unit.outOfSupply).map((unit) => unit.id),
    ...outOfSupply.mark,
  ])
  const byHex = new Map<string, { hex: HexRef; units: SupplyPhaseUnitView[] }>()
  for (const unit of mine) {
    if (unit.hex === null) continue
    if (!markedOrStill.has(unit.id)) continue
    const key = `${unit.hex.col}.${unit.hex.row}`
    const entry = byHex.get(key)
    if (entry === undefined) byHex.set(key, { hex: unit.hex, units: [unit] })
    else entry.units.push(unit)
  }
  const attritionDuty: AttritionDuty[] = [...byHex.values()]
    .map((entry) => ({
      hex: entry.hex,
      unitIds: entry.units.map((unit) => unit.id),
      bestAr: attritionStackAr(entry.units),
      oosSteps: entry.units.reduce((sum, unit) => sum + unit.steps, 0),
    }))
    .filter((duty) => duty.oosSteps > 0)
    .sort((a, b) => a.hex.col - b.hex.col || a.hex.row - b.hex.row)

  return {
    rule: '12.10e/12.6/12.8',
    internalStocks: recovery,
    remainingT,
    assessments,
    outOfSupply,
    feeding,
    attritionDuty,
    detail: `恢复消耗 ${recovery.spentT} T（浪费 ${recovery.wastedT} T）；剩余 ${remainingT} T；断补置 ${outOfSupply.mark.length} 除 ${outOfSupply.clear.length}；需掷损耗 ${attritionDuty.length} 格`,
  }
}

/* ────────────────────────────── 9.14d 延补队崩溃 ────────────────────────────── */

/** 延补队崩溃输入 */
export interface ExtenderCollapseInput {
  extender: {
    id: string
    hex: HexRef
    side: Side
    /** 12.7b：延补队距离（MP）＝距后方被连接格的最远距离，也是崩溃位移的上限 */
    rangeMp: number
  }
  /**
   * 候选落点（调用方按 12.7b 的距离枚举；本模块不发明位移的计费细则）
   *
   * 用 `extenderDisplacementCandidates` 可从一批格里按格距筛出候选。
   */
  candidates: readonly HexRef[]
  /** 该格此刻是否有追溯补给（9.14d 的硬条件） */
  hasTraceSupplyAt: (hex: HexRef, side: Side) => boolean
}

/** 延补队崩溃结果 */
export interface ExtenderCollapseResult {
  rule: '9.14d'
  /** 位移落点；null＝不存在合法格（留在原格） */
  hex: HexRef | null
  /** 全部合法落点（按 列 → 行 升序） */
  legalHexes: HexRef[]
  /** 崩溃后一律翻面到常规运输点数面（9.14d） */
  flipToTransportPoints: true
  /** 无合法格时须按 9.14c 接受夺取判定（9.14d 末段） */
  captureCheckRequired: boolean
  detail: string
}

/**
 * 9.14d：延补队崩溃的位移判定
 *
 * 「将已崩溃的延补队位移到该延补队**特殊拖取距离**内的任意格中，前提是**该格此时拥有追溯补给**。
 *   敌方单位、ZOC 和禁入地形对位移均无影响，且不产生损失或被夺取。」
 * 故本函数**只查**两件事：候选格是否在给定候选集内、该格是否有追溯补给；
 * 敌方单位/ZOC/禁入地形一律不查（规则明说无影响）。
 * 落点取「列 → 行」最小者（确定性；点选实际由玩家决定，命令层可覆盖）。
 */
export function resolveExtenderCollapse(input: ExtenderCollapseInput): ExtenderCollapseResult {
  const legalHexes = input.candidates
    .filter((hex) => input.hasTraceSupplyAt(hex, input.extender.side))
    .sort((a, b) => a.col - b.col || a.row - b.row)
  const target = legalHexes[0] ?? null
  return {
    rule: '9.14d',
    hex: target,
    legalHexes,
    flipToTransportPoints: true,
    captureCheckRequired: target === null,
    detail:
      target === null
        ? '不存在合法落点：留在原格、翻面到运输点数面，并按 9.14c 接受夺取判定'
        : `位移到 ${target.col}.${target.row}（共 ${legalHexes.length} 个合法格）并翻面到运输点数面`,
  }
}

/**
 * 9.14d：从一批格中筛出崩溃位移的候选
 *
 * 位移上限＝延补队距离（12.7b）。规则未给位移的逐格计费细则，故此处按**格距**
 * （`hexDistance ≤ rangeMp`）筛选，且如 9.14d 所述**无视**敌方单位/ZOC/禁入地形。
 */
export function extenderDisplacementCandidates(
  extender: { hex: HexRef; rangeMp: number },
  hexes: readonly HexRef[],
): HexRef[] {
  return hexes
    .filter((hex) => hexDistance(extender.hex, hex) <= extender.rangeMp)
    .sort((a, b) => a.col - b.col || a.row - b.row)
}
