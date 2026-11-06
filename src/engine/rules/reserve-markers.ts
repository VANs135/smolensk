import type { Side } from '@/data'
import { fail, succeed, type RuleOutcome } from '@/engine/result-types'

/**
 * 5.4 / 5.4a / 5.7：预备标记（电子版＝程序校验的**额度**）
 *
 * 原文（5.4a）：「游戏专属规则中会对每一方可用的预备标记数量进行严格的限制。为了节约这些
 * 宝贵的标记，玩家可以用一个预备标记（4.8b），表示**堆叠中一部分单位全部处于预备模式**。
 * 而且在这些单位**完成 25% 的移动后，才需要放置该预备标记**。」
 * 原文（5.7）：「预备模式下的单位……玩家需要用预备标记来标记它们。预备模式标记池中的
 * 标记数量是有限的，见 5.4a。」
 * 原文（5.7b）：「A player can release a unit and have it move and overrun before deciding to
 * release other Reserves.」（**部分释放**：一个单位释放完，再决定是否释放其他预备单位。）
 *
 * 由此四条口径（原文 + 用户 2026-11-06 裁定，不自创第五条）：
 *   ① **准入**：已耗 MP ≤ 当前面的 `MA × 1/4`（`canSwitchModeNow` 里判）。**0 MP 也满足**
 *      （用户原话「单位哪怕不移动也可以转入预备，因为不消耗也是小于等于四分之一」）。
 *   ② **放置时点＝转入预备的那一刻**。原文「完成 25% 的移动后，才需要放置」是**实体版**的
 *      宽容条款（省实物标记）；电子版由程序校验，故**进入即占**（用户裁定）。
 *   ③ **计量单位＝标记（覆盖组）**：一个标记覆盖"堆叠中一部分单位"，同组只占一枚，不按单位计。
 *   ④ **占用的实质＝同时处于预备模式的堆叠**组数**上限**（剧本 `setup.reserveMarkers`）。
 *      组内**部分单位释放**（5.7b）**不归还**额度——只要组里还有预备成员，这枚就仍被占着；
 *      **整组走空**（全部释放 / 5.7d 接敌 / 5.10c DG）才归还。
 *
 * 标记的账面语义：`groups` 里的条目**只增不删**（保留 released 空条目，不回收 id），
 * "是否在占用"由 `isReserveMarkerGroupInUse` 按**当前模式**实时判定；因此释放、接敌、DG 都
 * 不需要写账，也能正确归还额度。
 */

/**
 * 5.4 / 5.4a：当前面 MA 的 25%
 *
 * **不取整**（`docs/2026-11-05-取整规则对照表.md` U4：绝不取整 MA）⇒ MA 5 的 25% 是 1.25；
 * MP 消耗按 0.5 的倍数累计，25% 边界（.25/.5/.75）在二进制浮点里是精确值，故可直接比较。
 */
export function reserveQuarterMa(ma: number): number {
  return ma / 4
}

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

/** 某方此刻占用的标记数（5.4a：按组计，走空的组不计） */
export function reserveMarkersInUse(
  ledger: ReserveMarkerLedger,
  side: Side,
  isReserveUnit: (unitId: string) => boolean,
): number {
  return ledger.groups.filter(
    (group) => group.side === side && isReserveMarkerGroupInUse(group, isReserveUnit),
  ).length
}

/** 一次转入预备的记账结果：新账本 + 归属的组（`null`＝空转入，无单位） */
export interface ReserveMarkerPlacement {
  ledger: ReserveMarkerLedger
  groupId: string | null
}

/**
 * 转入预备模式的那一刻**占用**额度（5.4a + 用户裁定）
 *
 * - `enteringIds`：本次一起转入的单位（同一堆叠多枚共占一枚）；
 * - `mergeGroupId`：由状态层给出的"同格、仍有预备成员的已有组"——并入它**不占新额度**
 *   （5.4a「堆叠中一部分单位」，同一堆叠不该因为分批转入而多烧标记）；
 * - 否则要新开一组：池已空 ⇒ 拒绝（`5.4a` / `noReserveMarkerAvailable`）。
 */
export function placeReserveMarkersAtEntry(input: {
  ledger: ReserveMarkerLedger
  side: Side
  /** 转入格（`"col.row"`）——5.4a 的"堆叠中一部分"以堆叠为界 */
  origin: string
  enteringIds: readonly string[]
  isReserveUnit: (unitId: string) => boolean
  mergeGroupId?: string
}): RuleOutcome<ReserveMarkerPlacement> {
  const { ledger, side, origin, enteringIds, isReserveUnit } = input
  if (enteringIds.length === 0) return succeed('5.4a', { ledger, groupId: null })

  if (input.mergeGroupId !== undefined) {
    const target = ledger.groups.find(
      (group) => group.id === input.mergeGroupId && group.side === side,
    )
    if (target !== undefined) {
      const merged = new Set([...target.unitIds, ...enteringIds])
      return succeed('5.4a', {
        ledger: {
          ...ledger,
          groups: ledger.groups.map((group) =>
            group === target ? { ...group, unitIds: [...merged] } : group,
          ),
        },
        groupId: target.id,
      })
    }
  }

  const used = reserveMarkersInUse(ledger, side, isReserveUnit)
  if (ledger.cap !== null && used >= ledger.cap[side])
    return fail('5.4a', `noReserveMarkerAvailable:${side}`)

  const group: ReserveMarkerGroup = {
    id: `reserve-marker:${side}:${origin}:${ledger.groups.length + 1}`,
    side,
    unitIds: [...new Set(enteringIds)],
  }
  return succeed('5.4a', {
    ledger: { ...ledger, groups: [...ledger.groups, group] },
    groupId: group.id,
  })
}

/**
 * 一次"占用"的日志事件（`session.log` 的 `action='reserveMarker'` 条目）
 *
 * 读档时从会话日志**反推**账本（不新增存档字段）：日志是整局审计、随存档往返，
 * 而账本只是它的派生视图。
 */
export interface ReserveMarkerLogEvent {
  side: Side
  groupId: string
  unitIds: readonly string[]
}

/** 读档重建：按日志时间顺序把"占用事件"重放成账本（同 id 的条目并入同一组） */
export function rebuildReserveMarkerLedger(
  events: readonly ReserveMarkerLogEvent[],
  cap: Record<Side, number> | null,
): ReserveMarkerLedger {
  const groups: ReserveMarkerGroup[] = []
  for (const event of events) {
    const index = groups.findIndex((group) => group.id === event.groupId)
    if (index < 0) {
      groups.push({ id: event.groupId, side: event.side, unitIds: [...new Set(event.unitIds)] })
      continue
    }
    const merged = new Set([...groups[index]!.unitIds, ...event.unitIds])
    groups[index] = { ...groups[index]!, unitIds: [...merged] }
  }
  return { cap, groups }
}
