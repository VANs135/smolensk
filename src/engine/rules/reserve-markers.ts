import type { Side } from '@/data'
import { fail, succeed, type RuleOutcome } from '@/engine/result-types'

/**
 * 5.4 / 5.4a / 5.7：预备模式与预备标记（电子版＝程序校验的**按格额度**）
 *
 * **时机（原文原句）**
 *   - 5.4「Units in Combat, Move, Reserve, and Strat Mode can change to a different voluntary
 *     mode in the Movement Phase. This is done **as each individual unit or stack begins to
 *     move**.」⇒ 转入预备是在**该单位/堆叠开始移动的那一刻**、逐单位/逐堆叠判定：不是"整段
 *     开始前统一宣布"，也不是"每走一步都能改"。
 *   - 5.7b「A Reserve Mode unit can be used during the **Reaction or Exploitation Phases** of
 *     that player's turn. To release a unit, simply remove the Reserve marker … A player can
 *     release a unit and have it move and overrun before deciding to release other Reserves.」
 *     ⇒ 释放只发生在**反应/进击段**（移动段内只进不出），逐枚释放、可交错。
 *   - 5.7g「No unit in Reserve Mode can be stacked with a hedgehog at the **end of any Movement
 *     Segment**.」⇒ 移动环节结束时才判（入口不拦）。
 *   - 5.10c「An Organic Truck in Reserve Mode does, however, lose its mode marker when the hex
 *     receives a DG result.」⇒ DG 结算时强制摘标记。
 *   - 因此"同一移动段内转→放→再转"不存在：移动段只能转入，释放要等到反应/进击段；再转入
 *     只能等下一个移动阶段（此时该单位本段 MP 归零）。
 *
 * **额度（用户 2026-11-06 裁定，取代"组账户"口径）**
 *   - 一枚标记＝**一个格子里处于预备模式的单位**：5.4a「a player can show the entire portion of
 *     a stack that is in Reserve Mode with one marker (4.8b)」；
 *   - **按格计**：同格已有处于预备模式的其它单位 ⇒ 不额外占；同格没有 ⇒ 占 1 格；
 *   - 剧本 `setup.reserveMarkers` 给几枚 ＝ **能同时保持几个格子处于预备**；`0` ⇒ 该方**完全
 *     没有预备权**（进入即拒，不是"不校验"）；
 *   - 释放后标记**留在尚未释放的单位上** ⇒ 额度是"此刻哪些格子还有预备单位"的实时派生，
 *     不维护与成员脱节的组账户。
 */

/**
 * 5.4 / 5.4a：当前面 MA 的 25%
 *
 * **不取整**（`docs/2026-11-05-取整规则对照表.md` U4：绝不取整 MA）⇒ MA 5 的 25% 是 1.25。
 */
export function reserveQuarterMa(ma: number): number {
  return ma / 4
}

/** 某一格里的单位是否处于预备模式（额度按格计的最小事实） */
export interface ReserveUnitView {
  /** 格键 `"col.row"` */
  hex: string
  side: Side
  inReserve: boolean
}

/**
 * 某方此刻"有预备单位"的格子（去重，顺序即首次出现顺序）
 *
 * 5.4a/5.7：一枚标记覆盖一个格子里"处于预备模式的那部分单位" ⇒ 同格多枚只算 1 格额度。
 */
export function reserveHexesInUse(views: readonly ReserveUnitView[], side: Side): string[] {
  const hexes: string[] = []
  for (const view of views) {
    if (view.side !== side || !view.inReserve) continue
    if (!hexes.includes(view.hex)) hexes.push(view.hex)
  }
  return hexes
}

/**
 * 5.4a / 5.7：该格此刻能否转入预备（额度闸门）
 *
 * - 本方额度为 `0`（剧本没给也按 0）⇒ **一律拒**（用户裁定："没有就是 0"）；
 * - 同格已有预备单位 ⇒ 不额外占，允许（标记留在那一格上）；
 * - 否则要看"已有几个格子处于预备"是否已达上限，达上限 ⇒ 拒。
 */
export function allowReserveEntryAtHex(input: {
  side: Side
  /** 剧本初设的标记枚数＝可同时处于预备的格子数（未给时调用方传 0） */
  cap: number
  /** 本次要转入的格键 `"col.row"` */
  hex: string
  /** 该方此刻已有预备单位的格子（`reserveHexesInUse` 的结果） */
  occupiedHexes: readonly string[]
}): RuleOutcome<null> {
  const { side, cap, hex, occupiedHexes } = input
  if (cap <= 0) return fail('5.4a', `noReserveMarkerAvailable:${side}`)
  if (occupiedHexes.includes(hex)) return succeed('5.4a', null)
  if (occupiedHexes.length >= cap) return fail('5.4a', `reserveMarkerCapReached:${side}`)
  return succeed('5.4a', null)
}
