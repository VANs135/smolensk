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
  /** 友方 HQ 所在格（21.10：在地图上任意友方 HQ 处花掉） */
  hqHex: HexRef
  /** 本次 HQ 投递的火炮轰炸成本（T） */
  barrageCostT: number
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
  /** 本次实际抵付的 T（每标记 2T；不足不找零 ⇒ 取 min） */
  paidT: number
  /** 剩余仍须支付的轰炸成本 T */
  remainingCostT: number
  /** 是否实现了「部分火力」（成本被降到 0 以下的情形 ⇒ 无找零） */
  partialFire: boolean
  detail: string
}

/**
 * 21.10 **Shells**：用一枚补给缓存抵付 HQ 投递的火炮轰炸成本
 *
 * 「每标记付 2T；成本降到 0 以下不找零」⇒ `paidT = min(2, cost)`，
 * 余量不足以构成一次完整投递时即为「部分火力」（条文举 26-1-1 只打 10 点的例子）。
 */
export function useSupplyCacheAsShells(input: ShellsUseInput): RuleOutcome<ShellsUseResult> {
  if (supplyCacheCount(input.holdings, input.side) <= 0)
    return fail('1.7', `noSupplyCacheLeft:${input.side}`)
  const cost = Math.max(0, Math.trunc(input.barrageCostT))
  if (cost === 0) return fail('21.10', 'shellsRequirePositiveBarrageCost')

  const paidT = Math.min(SUPPLY_CACHE_SHELLS_T, cost)
  const remainingCostT = cost - paidT
  return succeed('21.10', {
    rule: '21.10',
    paidT,
    remainingCostT,
    // 成本被完全抵掉（或本来就低于 2T）⇒ 视为部分火力，无找零
    partialFire: remainingCostT === 0,
    detail:
      `Shells（21.10）：在 ${input.hqHex.col}.${input.hqHex.row} 的友方 HQ 花掉一枚补给缓存 ⇒ 抵付 ${paidT} T` +
      `（每标记 ${SUPPLY_CACHE_SHELLS_T} T，成本降到 0 以下不找零），剩余 ${remainingCostT} T` +
      (input.hqDrawsTraceSupply === false ? '；HQ 即使不在追溯补给中也可用（21.10）' : ''),
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
