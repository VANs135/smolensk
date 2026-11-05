import type { Side } from '@/data'
import { fail, succeed, type RuleOutcome } from '@/engine/result-types'

/**
 * 5.4a / 5.7：预备标记的**计量单位**与**校验时点**
 *
 * 原文（5.4a）：「游戏专属规则中会对每一方可用的预备标记数量进行严格的限制。为了节约这些
 * 宝贵的标记，玩家可以用一个预备标记（4.8b），表示**堆叠中一部分单位全部处于预备模式**。
 * 而且在这些单位**完成 25% 的移动后，才需要放置该预备标记**。」
 * 原文（5.7）：「预备模式下的单位……玩家需要用预备标记来标记它们。预备模式标记池中的
 * 标记数量是有限的，见 5.4a。」
 *
 * 由此两条口径（本模块只实现这两条，不自创第三条）：
 *   ① **计量单位＝标记（覆盖组）**：一个标记可以覆盖"堆叠中一部分单位"，故按**组**计数，
 *      不按单位计数；同组在账本里始终只占一枚。
 *   ② **校验时点＝实际放置时**：切到预备模式**不占**标记（5.4a「完成 25% 的移动后，才需要
 *      放置」），只有这组真正按预备 MA（×1/4）迈出移动时才占一枚；池空则拒绝这次移动。
 *
 * 标记随**组内还有成员处于预备模式**而占用：释放（5.7b）、接敌（5.7d）、DG（5.10c）都会
 * 把单位移出预备模式，该组若再无预备成员则自动归还那一枚（账本条目保留，计数不计）。
 *
 * ★ 原文只给"一部分单位"而未给"部分移动如何计"：本模块取"**开始按预备 MA 移动即放置**"
 * 作为最贴近上下文的口径（只在真正移动时消耗，不因切模式而消耗）。若另有口径，回滚点仅
 * 在 `placeReserveMarkerForMove` 的调用时点（`workbench.commitStep`）。
 */

/** 一组共用一枚预备标记的单位（5.4a「堆叠中一部分单位」） */
export interface ReserveMarkerGroup {
  /** 账本内的稳定标识（释放后条目保留，不回收 id） */
  id: string
  side: Side
  /** 同组共用一枚标记的单位 */
  unitIds: readonly string[]
}

/** 预备标记账本 */
export interface ReserveMarkerLedger {
  /**
   * 剧本初设给每方的预备标记上限（`setup.reserveMarkers`；5.4a「严格限制」）
   *
   * `null`＝剧本数据未给 ⇒ **不校验**（按用户口径记"数据缺口"，不臆造上限）。
   */
  cap: Record<Side, number> | null
  groups: readonly ReserveMarkerGroup[]
}

/** 该组此刻是否仍占着一枚标记（组内至少一员仍处于预备模式） */
export function isReserveMarkerGroupInUse(
  group: ReserveMarkerGroup,
  isReserveUnit: (unitId: string) => boolean,
): boolean {
  return group.unitIds.some((unitId) => isReserveUnit(unitId))
}

/** 某方此刻占用的标记数（5.4a：按组计，空条目不计） */
export function reserveMarkersInUse(
  ledger: ReserveMarkerLedger,
  side: Side,
  isReserveUnit: (unitId: string) => boolean,
): number {
  return ledger.groups.filter(
    (group) => group.side === side && isReserveMarkerGroupInUse(group, isReserveUnit),
  ).length
}

/**
 * 为一次移动放置本组的预备标记（5.4a 的**实际放置时点**）
 *
 * - 参移单位中没有预备模式单位 ⇒ 原样返回（普通移动与标记无关）；
 * - 已有成员落在某个已放置的组里 ⇒ 把本次同起的预备成员并进该组（仍只占一枚）；
 * - 否则要新占一枚：池已空 ⇒ 拒绝（`5.4a` / `noReserveMarkerAvailable`）。
 */
export function placeReserveMarkerForMove(input: {
  ledger: ReserveMarkerLedger
  side: Side
  /** 本次移动的起始堆叠键（`"col.row"`）——5.4a 的"堆叠中一部分"以堆叠为界 */
  origin: string
  unitIds: readonly string[]
  isReserveUnit: (unitId: string) => boolean
}): RuleOutcome<ReserveMarkerLedger> {
  const { ledger, side, origin, unitIds, isReserveUnit } = input
  const reserveIds = unitIds.filter((unitId) => isReserveUnit(unitId))
  if (reserveIds.length === 0) return succeed('5.4a', ledger)

  const existing = ledger.groups.find(
    (group) => group.side === side && reserveIds.some((unitId) => group.unitIds.includes(unitId)),
  )
  if (existing !== undefined) {
    const merged = new Set([...existing.unitIds, ...reserveIds])
    return succeed('5.4a', {
      ...ledger,
      groups: ledger.groups.map((group) =>
        group === existing ? { ...group, unitIds: [...merged] } : group,
      ),
    })
  }

  const used = reserveMarkersInUse(ledger, side, isReserveUnit)
  if (ledger.cap !== null && used >= ledger.cap[side])
    return fail('5.4a', `noReserveMarkerAvailable:${side}`)

  return succeed('5.4a', {
    ...ledger,
    groups: [
      ...ledger.groups,
      {
        id: `reserve-marker:${side}:${origin}:${ledger.groups.length + 1}`,
        side,
        unitIds: reserveIds,
      },
    ],
  })
}
