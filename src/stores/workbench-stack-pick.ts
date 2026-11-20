/**
 * workbench-stack-pick.ts —— C5 堆叠取子（6.1f / 8.1g / 8.1h）
 *
 * 搬了 **B3-2a**：workbench.ts 7590–7800 的 **211 行 / 13 个顶层声明**
 * （11 个 function + 2 个 computed：`movePickHex`(7593) / `movePickChoices`(7643)）。
 *
 * 端口 **13 项**（2026-11-21 实测，正文引用这 13 个端口共 **42** 处）：
 *   · 按值解构（12 项）：`activeSide`(855) / `phase`(863) / `units`(997) / `nameOf`(1114 薄转发) /
 *     `moveBlocked`(1151) / `movePick`(1403) / `pausedTransportIds`(1452) / `pushLog`(6117) /
 *     `friendlyUnitsAt`(7035) / `beginMoveFor`(7575) / `applyFormationFuelCoverage`(9342) /
 *     `applyFormationFuelCoverageToIds`(9354)；
 *   · 走 `ports.X`（1 项）：`initialSetupInProgress`(19100) —— 声明在建域点之后，facade 用 `get` 访问器传，
 *     切片里写 `ports.initialSetupInProgress.value`。
 *
 * 建域点仍在原区间位置（7590）：`movePick`/`pausedTransportIds` 声明在 1.4k，若把域提前到
 * `groundMovement`(1130) 之前，就要给 `moveBlocked`(1151) / `movePick`(1403) / `pausedTransportIds`(1452) /
 * `beginMoveFor`(7575) / `initialSetupInProgress`(19100) 开 **5 个 getter**；
 * 原地建域只要 **1 个 getter**，代价是 4 个名字被**更早的域**当端口吃
 * （`snapshotOf` 1138 / `stepTextOf` 1139 / `movePickPoolAt` 5768、7552 / `defaultMovePickIdsAt` 7553），
 * 故 facade 侧保留 4 个一行薄转发。
 */
import { computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import type { createGroundMovementDomain } from './ground-movement'
import type { createMovementDomain } from './workbench-move'
import { isReplUnit } from './workbench-model'
import type { ConsolePhase, ConsoleUnit, WorkbenchLogEntry } from './workbench-model'
import type { MoveStepSnapshot } from './movement-types'
import type { Derivation } from '@/engine/derivation'
import type { HexRef, Side } from '@/data'
import { canMoveInPhase } from '@/engine/rules/modes'
import type { MoveStepRecord } from '@/engine/rules/move-interaction'

/** C5 堆叠取子的端口。12 项按值解构、1 项走 ports（见文件头）。 */
export interface StackPickDomainPorts {
  /** ── 按值：建域点之前声明的状态/派生 ── */
  activeSide: ComputedRef<Side>
  phase: ComputedRef<ConsolePhase>
  units: Ref<ConsoleUnit[]>
  moveBlocked: ReturnType<typeof createGroundMovementDomain>['moveBlocked']
  movePick: Ref<{ hex: HexRef; ids: string[] } | null>
  pausedTransportIds: Ref<string[]>
  /** ── 按值：函数声明 / 薄转发（可提升或已初始化） ── */
  nameOf: (unitId: string) => string
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  friendlyUnitsAt: (hex: HexRef) => ConsoleUnit[]
  beginMoveFor: ReturnType<typeof createMovementDomain>['beginMoveFor']
  applyFormationFuelCoverage: (unit: ConsoleUnit) => void
  applyFormationFuelCoverageToIds: (ids: readonly string[]) => void
  /** ── 晚绑定（声明在 19100，晚于建域点） ── */
  initialSetupInProgress: Ref<boolean>
}

export function createStackPickDomain(ports: StackPickDomainPorts) {
  const {
    activeSide,
    phase,
    units,
    moveBlocked,
    movePick,
    pausedTransportIds,
    nameOf,
    pushLog,
    friendlyUnitsAt,
    beginMoveFor,
    applyFormationFuelCoverage,
    applyFormationFuelCoverageToIds,
  } = ports

  /* ──────────── C5：堆叠取子（6.1f / 8.1g / 8.1h） ──────────── */

  /** 当前取子清单所在格（用于界面判断是否显示该块） */
  const movePickHex = computed<HexRef | null>(() => movePick.value?.hex ?? null)

  /**
   * 6.1 取子的**可开拔集**：同格本方单位，剔掉 13.5 的补员算子
   *
   * 补员算子只为「消耗补员重建」存在（数据层也是 `isCombat: true`），不参加移动；
   * 左键窗的 chip 与取子清单共用这一份，避免 chip 看不见它、`movePick` 里却留着它。
   *
   * 13.2g：编内卡车＝**特殊的运输点数**（「与其他运输点数基本一样」）⇒ 照常进可开拔集，
   * 可单独选中/单独移动；原文没有"不能独立移动"这一条。
   */
  function movePickPoolAt(hex: HexRef): ConsoleUnit[] {
    // #15：已结束本轮移动的实例不再进池（没有"开始移动"入口、不占配额）；
    // 13.2a 显式暂停的运输点数仍可继续 ⇒ 保留在池里。
    const pool = friendlyUnitsAt(hex).filter(
      (unit) =>
        !isReplUnit(unit) &&
        (!unit.movementEnded || pausedTransportIds.value.includes(unit.instanceId)),
    )
    /*
     * 7.0a / 11.0a：反应段只有**已释放的预备**、进击段只有**进击模式或已释放的预备**可以开拔。
     * 判据与引擎 `canMoveInPhase` 同源 ⇒ 不合格的单位不进取子清单，界面不会出现
     * "勾了、点开始移动才被拒"的假入口。
     */
    const segmentPhase = phase.value
    if (segmentPhase !== 'reaction' && segmentPhase !== 'exploitation') return pool
    return pool.filter(
      (unit) =>
        canMoveInPhase(
          { state: unit.mode, side: unit.side, activeSide: activeSide.value },
          segmentPhase,
        ).ok,
    )
  }

  /**
   * #12：摊开/「全选本格」的**默认集合**＝同格可开拔的本方**战斗单位**
   *
   * 用户 2026-11-10 实机：默认全选把最后一枚 SP 补给站也收进来了。
   * 补给站 / SP / 编内卡车（13.2g）这类非战斗算子不参加默认集，但仍留在可选清单里，
   * 玩家显式点它才进集合（点一枚取消、再点恢复）。若整格没有战斗单位，退回全部可开拔算子，
   * 免得运输点数/编内卡车在没有战斗单位的格子里无法开拔。
   */
  function defaultMovePickIdsAt(hex: HexRef): string[] {
    const pool = movePickPoolAt(hex)
    const combat = pool.filter((unit) => unit.isCombat && unit.replKind === null)
    return (combat.length > 0 ? combat : pool).map((unit) => unit.instanceId)
  }

  /** 取子清单的候选单位（该格当前方可开拔的算子，按摆放顺序） */
  const movePickChoices = computed<ConsoleUnit[]>(() => {
    const pick = movePick.value
    if (pick === null) return []
    return movePickPoolAt(pick.hex)
  })
  /** 勾选/取消一枚（#12：点一枚取消、再点恢复，允许空集；不在可开拔池里的实例一律忽略） */
  function toggleMovePick(unitId: string): void {
    const pick = movePick.value
    if (pick === null) return
    // #12：点一枚取消（允许空集，再点恢复）；不在可开拔池里的实例一律忽略
    if (!movePickPoolAt(pick.hex).some((unit) => unit.instanceId === unitId)) return
    if (pick.ids.includes(unitId)) {
      pick.ids = pick.ids.filter((id) => id !== unitId)
    } else {
      pick.ids = [...pick.ids, unitId]
      // #13：显式点进来的同编队单位同样按编队油窗口补记
      const unit = units.value.find((item) => item.instanceId === unitId)
      if (unit !== undefined) applyFormationFuelCoverage(unit)
    }
  }
  /** 只选这一枚（点「只动这一枚」即「就它动」，不需要先勾上） */
  function setMovePickOnly(unitId: string): void {
    const pick = movePick.value
    if (pick === null) return
    pick.ids = [unitId]
    applyFormationFuelCoverageToIds(pick.ids)
  }
  /** 全选（等价于点「整堆叠」）——#12：只选该格**可开拔的战斗单位**（非战斗须显式点选） */
  function setMovePickAll(): void {
    const pick = movePick.value
    if (pick === null) return
    pick.ids = defaultMovePickIdsAt(pick.hex)
    applyFormationFuelCoverageToIds(pick.ids)
  }

  /**
   * B26：为某格**建立或同步**取子清单（地图上"就地摊开"时用）
   *
   * 为什么需要它：B26 把"点堆叠"改成**先摊开**（看这一格）再谈开拔，于是摊开那一击不再经过
   * `selectForMove` ⇒ 取子清单不会自动出现，而"开始移动"与小窗的勾选列表都要它。
   * 本函数只写 `movePick`（**不碰任何引擎状态、不开始移动**）：
   *   · 入参即"地图上圈出来的那些"（摊开时＝参与本环节的集合）；
   *   · 全部不合格或缺省时退回"顶上一枚"（与 `selectForMove` 的默认一致）；
   *   · 该格没有己方算子 ⇒ 清掉清单。
   */
  function beginMovePick(hex: HexRef, ids: readonly string[]): void {
    // 用户 2026-11-18：初设期不建待开拔集（只做选中/堆叠显示）
    if (ports.initialSetupInProgress.value) {
      movePick.value = null
      return
    }
    const here = movePickPoolAt(hex).map((unit) => unit.instanceId)
    if (here.length === 0) {
      movePick.value = null
      return
    }
    const picked = ids.filter((id) => here.includes(id))
    const chosen = picked.length > 0 ? picked : [here[here.length - 1]!]
    movePick.value = {
      hex: { col: hex.col, row: hex.row },
      ids: chosen,
    }
    applyFormationFuelCoverageToIds(chosen)
  }
  /**
   * 直接给定取子集合（B3：地图上的就地展开把它当**唯一选择集**来驱动）
   *
   * 与 `toggleMovePick` 的差别：这里**允许空集**。地图上把最后一枚也点掉是合法操作
   * （玩家只是把这一格全放掉），空集时「确认开拔」按 6.1 给出提示，而不是静默改回"全选"。
   */
  function setMovePickIds(ids: readonly string[]): void {
    const pick = movePick.value
    if (pick === null) return
    // #8：地图/堆叠窗给出的集合仍以可开拔池为准——未选中的补员算子等不得被顺手扩进来
    const here = movePickPoolAt(pick.hex).map((unit) => unit.instanceId)
    pick.ids = [...ids].filter((id) => here.includes(id))
    applyFormationFuelCoverageToIds(pick.ids)
  }
  /** 放弃取子（不移动任何人） */
  function cancelMovePick(): void {
    movePick.value = null
  }
  /** 确认取子 ⇒ 以所选子集开拔（其余留驻；8.1h 的留驻单位不受本次移动/突袭影响） */
  function confirmMovePick(): boolean {
    const pick = movePick.value
    if (pick === null) {
      if (phase.value === 'reaction')
        moveBlocked.value = { rule: '6.3a', reason: '反应段请先选择非阶段玩家的合资格单位' }
      return false
    }
    // #8：开拔集只认可开拔池里的实例（补员算子即便被某条旧路径写进 `ids` 也不带走）
    const poolIds = new Set(movePickPoolAt(pick.hex).map((unit) => unit.instanceId))
    const ids = friendlyUnitsAt(pick.hex)
      .filter((unit) => pick.ids.includes(unit.instanceId) && poolIds.has(unit.instanceId))
      .map((unit) => unit.instanceId)
    if (ids.length === 0) {
      if (phase.value === 'reaction') {
        moveBlocked.value = { rule: '6.3a', reason: '反应段只能由非阶段玩家的合资格单位移动' }
        pushLog('warning', moveBlocked.value.reason, '6.3a')
        return false
      }
      pushLog('warning', '至少要勾选一枚才能开始移动（6.1）', '6.1')
      return false
    }
    const hex = { ...pick.hex }
    const names = friendlyUnitsAt(hex)
      .filter((unit) => ids.includes(unit.instanceId))
      .map((unit) => unit.name)
      .join(' + ')
    /*
     * ★ B26：取子清单**开拔成功之后**才清（修前先清）——
     *   开拔被拒（12.5a 缺燃料 / 5.4 模式 / 阶段闸门）时，清单必须留着：
     *   玩家的付款受益集（`fuelTargets` 走 `movePick.ids`）与"重试开拔"（`retryBeginMove`）
     *   都要靠它，否则一堆叠付完油只剩顶上一枚能动（用户报告的那条）。
     */
    if (!beginMoveFor(ids)) {
      // 开拔被拒：原因已由 beginMoveFor 写入 moveBlocked，此处不重复报错
      return false
    }
    movePick.value = null
    pushLog(
      'info',
      `开始移动：${names} @ ${hex.col}.${hex.row}` +
        `${ids.length > 1 ? `（自堆叠中取 ${ids.length} 枚，6.1）` : ''}`,
      '6.1',
    )
    return true
  }

  /** C5：把步骤记录折成可显示的文本 */
  function stepTextOf(record: MoveStepRecord): string {
    if (record.kind === 'end') return '结束本次移动（6.1）'
    const parts = [
      `${record.movedIds.map(nameOf).join(' + ')} → ${record.to.col}.${record.to.row}`,
      `${record.movedIds.map((id) => `${nameOf(id)} 消耗 ${record.costById[id] ?? 0} MP`).join('；')}`,
    ]
    if (record.droppedIds.length > 0)
      parts.push(`走不动而留在原格：${record.droppedIds.map(nameOf).join('、')}（6.1f）`)
    if (record.zocStoppedIds.length > 0)
      parts.push(`进入敌方 ZOC 被迫停止：${record.zocStoppedIds.map(nameOf).join('、')}（4.5a-A）`)
    return parts.join('；')
  }

  /** C5：步骤记录 → 界面快照 */
  function snapshotOf(record: MoveStepRecord): MoveStepSnapshot {
    return {
      kind: record.kind,
      from: { ...record.from },
      to: { ...record.to },
      movedNames: record.movedIds.map(nameOf),
      droppedNames: record.droppedIds.map(nameOf),
      zocStoppedNames: record.zocStoppedIds.map(nameOf),
      costText: record.movedIds
        .map((id) => `${nameOf(id)} ${record.costById[id] ?? 0} MP`)
        .join('；'),
      rules: [...record.rules],
    }
  }

  return {
    movePickHex,
    movePickPoolAt,
    defaultMovePickIdsAt,
    movePickChoices,
    toggleMovePick,
    setMovePickOnly,
    setMovePickAll,
    beginMovePick,
    setMovePickIds,
    cancelMovePick,
    confirmMovePick,
    stepTextOf,
    snapshotOf,
  }
}
