import { rulesConstants } from '@/data'
import type { HexRef } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'
import { SUPPLY_CACHE_PER_SIDE } from './timing'

/**
 * 补给缓存标记（Smolensk 专规 1.7 ← OCS 21.10）
 *
 * ## 条文原文
 *   - **专规 1.7**：「**Supply Cache Marker（1.7）**：来自 OCS v4.3 规则 21.10，本作
 *     **为标准规则（非可选）**；双方每剧本开局各持**两个**，偶尔经 **Special Repl** 再得，
 *     可用于 **Shells（弹药）** 或 **Forage（应急补给）**。」
 *   - **通规 21.10（Supply Caches）**：「在地图上任意友方 HQ 处可『花掉』，二选一：
 *     · **Shells（炮弹）**：抵付一个 HQ 投递（throw）的火炮轰炸成本，**每标记付 2T**；
 *       成本降到 0 以下**不找零**；它还让火炮能打『部分火力』……**即使 HQ 不在追溯补给中也**可用。
 *     · **Forage（应急征粮）**：在**补给阶段**花 1 标记，让 HQ 为其**投递距离内所有战斗单位**
 *       提供追溯补给。限制：只在敌军切断该 HQ 补给的**第一个回合**可用；**不可用于 spearhead（矛头部队）**；
 *       之后若仍断补，只能突围、吃图上补给或承受损耗。」
 *
 * ## 实现口径
 *   - 数值取 `rules-constants.json`（`smolensk.supplyCachePerSide` / `supplyCacheShellsT`），无硬编码；
 *   - 本模块**不写状态**：返回「花掉一枚标记换到什么」，由调用方扣减标记数；
 *   - 「spearhead（矛头部队）」在可得素材中未再定义，故由调用方以事实注入（`isSpearhead`），
 *     引擎不臆造判据。
 */

/** 1.7：每方每剧本开局的补给缓存枚数（唯一实现在 `timing.ts`） */
const SUPPLY_CACHE_PER_SCENARIO = SUPPLY_CACHE_PER_SIDE

/** 21.10 Shells：一枚标记抵付的轰炸成本（T） */
export const SUPPLY_CACHE_SHELLS_T = rulesConstants.smolensk.supplyCacheShellsT

/** 1.7 / 21.10：两种用法 */
export type SupplyCacheUse = 'shells' | 'forage'

/** 补给缓存持有量（按方） */
export interface SupplyCacheHoldings {
  axis: number
  soviet: number
}

/**
 * 1.7：开局持有量
 *
 * 层级为 **剧本 > 专规**：调用方应传入剧本初设的枚数（`scenarios.setup.supplyCache`）；
 * 缺省值取专规 1.7 的规则值（`rules-constants.smolensk.supplyCachePerSide`）。
 */
export function initialSupplyCacheHoldings(
  perSide: number = SUPPLY_CACHE_PER_SCENARIO,
): SupplyCacheHoldings {
  return { axis: perSide, soviet: perSide }
}

/** 1.7 / 21.10：某方还剩几枚 */
export function supplyCacheCount(holdings: SupplyCacheHoldings, side: 'axis' | 'soviet'): number {
  return holdings[side]
}

/** 1.7：经 1.6c 特殊补员追加一枚（苏方 `division_caches` / 轴方 `supply_cache` 结果） */
export function addSupplyCache(
  holdings: SupplyCacheHoldings,
  side: 'axis' | 'soviet',
): SupplyCacheHoldings {
  return { ...holdings, [side]: holdings[side] + 1 }
}

/** 21.10 Shells 的用法输入 */
export interface ShellsUseInput {
  side: 'axis' | 'soviet'
  holdings: SupplyCacheHoldings
  /** 友方 HQ 所在格（21.10：在地图上任意友好 HQ 处花掉） */
  hqHex: HexRef
  /** 本次 HQ 投递的火炮轰炸成本（T） */
  barrageCostT: number
  /**
   * 本次**计划花掉**的标记枚数（默认 1）。
   *
   * 21.10：「Shells pay 2T ... **per marker spent**」⇒ 多枚按枚整花，最后一枚可溢出（不找零）。
   */
  markers?: number
  /**
   * 该 HQ 是否处于追溯补给（21.10：**即使 HQ 不在追溯补给中也可用**）
   *
   * 故本项只作日志说明，**不参与**合法性判定。
   */
  hqDrawsTraceSupply?: boolean
}

/** 21.10 Shells 的结论 */
export interface ShellsUseResult {
  rule: string
  /** 实际花掉的标记枚数（= 输入 `markers`） */
  markersSpent: number
  /** 本次实际抵付的 T（每标记 2T；不足不找零 ⇒ 取 min） */
  paidT: number
  /** 未抵付、被浪费的 T（= 枚数×2 − `paidT`；「No 'change' is given」） */
  wasteT: number
  /** 剩余仍须支付的轰炸成本 T */
  remainingCostT: number
  /** 是否实现了「部分火力」（成本被降到 0 以下的情形 ⇒ 无找零） */
  partialFire: boolean
  detail: string
}

/**
 * 21.10 **Shells**：花掉若干枚补给缓存，抵付 HQ 投递的火炮轰炸成本
 *
 * 「每标记付 2T；成本降到 0 以下不找零」⇒ `paidT = min(枚数×2, cost)`，
 * 差额记入 `wasteT`（溢出作废，不退）。余量为 0 时即「部分火力」
 * （条文举 26-1-1 只打 10 点的例子；具体选列见 `selectAffordableBarrageColumn`）。
 */
export function useSupplyCacheAsShells(input: ShellsUseInput): RuleOutcome<ShellsUseResult> {
  const held = supplyCacheCount(input.holdings, input.side)
  const markers = Math.max(1, Math.trunc(input.markers ?? 1))
  // 兼容旧原因码：一枚都没有时维持 `noSupplyCacheLeft`，只是枚数不够才用新码
  if (held <= 0) return fail('1.7', `noSupplyCacheLeft:${input.side}`)
  if (held < markers) return fail('1.7', `notEnoughSupplyCache:${input.side}:${held}<${markers}`)
  const cost = Math.max(0, Math.trunc(input.barrageCostT))
  if (cost === 0) return fail('21.10', 'shellsRequirePositiveBarrageCost')

  const faceT = markers * SUPPLY_CACHE_SHELLS_T
  const paidT = Math.min(faceT, cost)
  const wasteT = faceT - paidT
  const remainingCostT = cost - paidT
  return succeed('21.10', {
    rule: '21.10',
    markersSpent: markers,
    paidT,
    wasteT,
    remainingCostT,
    // 成本被完全抵掉（或本来就低于 2T）⇒ 视为部分火力，无找零
    partialFire: remainingCostT === 0,
    detail:
      `Shells（21.10）：在 ${input.hqHex.col}.${input.hqHex.row} 的友方 HQ 花掉 ${markers} 枚补给缓存 ⇒ 抵付 ${paidT} T` +
      `（每标记 ${SUPPLY_CACHE_SHELLS_T} T，成本降到 0 以下不找零；浪费 ${wasteT} T），剩余 ${remainingCostT} T` +
      (input.hqDrawsTraceSupply === false ? '；HQ 即使不在追溯补给中也可用（21.10）' : ''),
  })
}

/** 21.10 Shells + SP 混付的输入 */
export interface BarrageSupplyPaymentInput {
  /** 本次炮击的初始列成本（T，10.1b） */
  costT: number
  /** 计划花掉的 Shells 枚数（可 0） */
  markers: number
  /** 可用于补足的 SP（T） */
  spT: number
}

/** 21.10 Shells + SP 混付的账目 */
export interface BarrageSupplyPaymentPlan {
  rule: string
  /** 实际花掉的 Shells 枚数 */
  markersSpent: number
  /** Shells 抵付的 T（≤ 面值，差额为 `wasteT`） */
  shellsAppliedT: number
  /** 溢出作废的 T */
  wasteT: number
  /** 实际用掉的 SP（T） */
  spT: number
  /** 合计覆盖的 T */
  coveredT: number
  /** 仍缺口的 T（0 ＝ 付得起） */
  shortT: number
  detail: string
}

/**
 * 21.10：Shells 与 SP 混合支付（用户 2026-11-12 裁定：允许混付；溢出作废）
 *
 * 顺序固定「先 Shells、后 SP」：标记不可拆分，先按枚整花；缺口再由 SP 补。
 * 本函数只算账、不判断 SP 来源（来源约束仍在 10.1b-A）；`shortT > 0` 时由调用方
 * 决定"降档"（`selectAffordableBarrageColumn`）或拒绝本次炮击。
 */
export function planBarrageSupplyPayment(
  input: BarrageSupplyPaymentInput,
): RuleOutcome<BarrageSupplyPaymentPlan> {
  const cost = Math.trunc(input.costT)
  if (cost <= 0) return fail('21.10', 'shellsRequirePositiveBarrageCost')
  const markers = Math.trunc(input.markers)
  if (markers < 0) return fail('21.10', `negativeShellsMarkers:${input.markers}`)
  const spAvailable = Math.max(0, Math.trunc(input.spT))

  const faceT = markers * SUPPLY_CACHE_SHELLS_T
  const shellsAppliedT = Math.min(faceT, cost)
  const wasteT = faceT - shellsAppliedT
  const remainingT = cost - shellsAppliedT
  const spT = Math.min(spAvailable, remainingT)
  const shortT = remainingT - spT
  const coveredT = shellsAppliedT + spT
  return succeed('21.10', {
    rule: '21.10',
    markersSpent: markers,
    shellsAppliedT,
    wasteT,
    spT,
    coveredT,
    shortT,
    detail:
      `Shells 混付（21.10）：${markers} 枚 ⇒ 抵付 ${shellsAppliedT} T（浪费 ${wasteT} T）；` +
      `SP ${spT} T；合计 ${coveredT}/${cost} T` +
      (shortT > 0 ? `；缺口 ${shortT} T ⇒ 需降档或放弃` : ''),
  })
}

/** 21.10 Forage 的用法输入 */
export interface ForageUseInput {
  side: 'axis' | 'soviet'
  holdings: SupplyCacheHoldings
  /** 21.10：只能在**补给阶段**花掉 */
  phase: string
  /** 友方 HQ 所在格 */
  hqHex: HexRef
  /** 该 HQ 的投递距离（格；13.1b 印值） */
  hqThrowRangeHexes: number
  /** 受益战斗单位所在格（须在投递距离内） */
  unitHex?: HexRef
  /** 该格到 HQ 的距离（格） */
  distanceHexes?: number
  /** 本回合是否为「敌军切断该 HQ 补给的**第一个回合**」 */
  firstTurnOfBeingCut: boolean
  /** 该受益单位是否属 **spearhead（矛头部队）**（21.10：不可用于矛头部队） */
  isSpearhead?: boolean
}

/** 21.10 Forage 的结论 */
export interface ForageUseResult {
  rule: string
  /** 受益的战斗单位格（null ＝ 作用于 HQ 投递距离内全部战斗单位） */
  coveredHexes: 'allWithinThrowRange'
  detail: string
}

/**
 * 21.10 **Forage**：在补给阶段花一枚补给缓存，让 HQ 为其投递距离内**所有**战斗单位提供追溯补给
 *
 * 三条限制逐条判：① 只在**补给阶段**；② 只在**断补的第一个回合**；③ **不可用于 spearhead**。
 */
export function useSupplyCacheAsForage(input: ForageUseInput): RuleOutcome<ForageUseResult> {
  if (supplyCacheCount(input.holdings, input.side) <= 0)
    return fail('1.7', `noSupplyCacheLeft:${input.side}`)
  // ① 21.10：只在补给阶段
  if (input.phase !== 'supply') return fail('21.10', 'forageOnlyInSupplyPhase')
  // ② 21.10：只在断补的第一个回合
  if (!input.firstTurnOfBeingCut) return fail('21.10', 'forageOnlyOnFirstTurnOfBeingCut')
  // ③ 21.10：不可用于 spearhead（矛头部队）
  if (input.isSpearhead === true) return fail('21.10', 'forageNotAllowedForSpearhead')
  // 受益单位须在 HQ 投递距离内
  if (
    input.unitHex !== undefined &&
    input.distanceHexes !== undefined &&
    input.distanceHexes > input.hqThrowRangeHexes
  )
    return fail(
      '21.10',
      `forageTargetOutOfThrowRange:${input.distanceHexes}>${input.hqThrowRangeHexes}`,
    )

  return succeed('21.10', {
    rule: '21.10',
    coveredHexes: 'allWithinThrowRange',
    detail:
      `Forage（21.10）：在 ${input.hqHex.col}.${input.hqHex.row} 的友方 HQ 花掉一枚补给缓存 ⇒ 为其投递距离` +
      `（${input.hqThrowRangeHexes} 格）内**所有**战斗单位提供追溯补给（仅限断补首回合；不可用于矛头部队）`,
  })
}

/**
 * 21.10：该 HQ 是否可以用 Forage（= 它正处在断补状态）
 *
 * 条文把可用性绑定在「敌军切断该 HQ 补给的第一个回合」，故把该事实单独列出，
 * 供界面在补给阶段提示可用性（真正的合法性判定仍在 `useSupplyCacheAsForage` 内）。
 */
export function forageAvailable(input: {
  phase: string
  firstTurnOfBeingCut: boolean
  holdings: SupplyCacheHoldings
  side: 'axis' | 'soviet'
}): boolean {
  return (
    supplyCacheCount(input.holdings, input.side) > 0 &&
    input.phase === 'supply' &&
    input.firstTurnOfBeingCut
  )
}
