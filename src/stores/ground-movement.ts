import { computed, ref, type Ref } from 'vue'
import type { HexRef } from '@/data'
import {
  beginMove,
  planStep,
  undoMoveStep as revertInteractionStep,
  cancelMove as revertInteraction,
  type MoveContext,
  type MoveUnitRuntime,
  type MoveInteractionState,
  type MoveStepRecord,
} from '@/engine/rules'
import type { MoveStepSnapshot } from './movement-types'
export interface GroundMovementPorts {
  context(): MoveContext
  runtime(): readonly MoveUnitRuntime[]
  /** 实例 id → 上屏用军名（拒绝文案不许露实例 id） */
  unitNameOf(unitId: string): string
  lastStep: Ref<MoveStepSnapshot | null>
  applyMovePatches(patches: readonly MoveUnitRuntime[]): void
  pushLog(kind: 'info' | 'success' | 'warning' | 'danger', text: string, rule?: string): void
  recordSettlement(input: { action: string; rule: string; data: Record<string, unknown> }): boolean
  snapshotOf(record: MoveStepRecord): MoveStepSnapshot
  stepTextOf(record: MoveStepRecord): string
  triggerSpecialCombatAfterStep(to: HexRef, movedIds: readonly string[]): void
  mayMutate(): boolean
  /** 本段是否已经过掷骰结算（非 null ⇒ 该原因会直接关掉撤销入口） */
  undoSealReason(): string | null
}
/** 6.1：地面单位的移动历史、ZOC暂停和撤销边界；空军不写这里的MP。 */
export function createGroundMovementDomain(ports: GroundMovementPorts) {
  const moveInteraction = ref<MoveInteractionState | null>(null)
  const zocStoppedMoveUnitIds = ref<string[]>([]),
    moveBlocked = ref<{ rule: string; reason: string } | null>(null)
  const moveContext = computed(ports.context),
    moveRuntime = computed(ports.runtime)
  const {
    lastStep,
    applyMovePatches,
    pushLog,
    recordSettlement,
    snapshotOf,
    stepTextOf,
    triggerSpecialCombatAfterStep,
  } = ports
  const rollbackFloor = ref(-1),
    rollbackReason = ref('')
  let applyingStep = false
  function markIrreversible(reason: string): void {
    if (moveInteraction.value === null) return
    rollbackFloor.value = Math.max(
      rollbackFloor.value,
      moveInteraction.value.steps.length + (applyingStep ? 1 : 0),
    )
    rollbackReason.value = reason
  }
  /**
   * K5：最后一步为什么不能撤（null＝可撤或没有可撤的步）
   *
   * 判据与 `refuseRollback` 同一处：一步可撤销 ⇔ 它只改动了 `before` 快照能还原的运行态。
   * 快照之外的账一旦落盘（突袭战斗 9.5/9.2、9.14 特战、专规 1.4b 入盒……），边界就被推到该步之后；
   * 此处只把同一判据投影成按钮态，避免 UI 留一个必被拒的「撤销一步」。
   */
  const undoBlockedReason = computed<string | null>(() => {
    const interaction = moveInteraction.value
    if (interaction === null || interaction.steps.length === 0) return null
    // 用户 2026-11-18：结束移动＝提交 ⇒ 之后不再有任何撤销
    if (interaction.finished) return '本次移动已结束（6.1）：结束即提交，不能再撤销'
    // 用户 2026-11-18：本段只要经过掷骰结算，撤销入口直接关掉（不再允许"撤骰后步"）
    const sealed = ports.undoSealReason()
    if (sealed !== null) return sealed
    const locked = interaction.unitIds.some(
      (id) => moveContext.value.units.find((unit) => unit.id === id)?.mpLockedThisPhase,
    )
    if (locked) return '单位已承诺抵消ZOC，本阶段不能还原其移动'
    if (rollbackFloor.value >= 0) return `移动已触发${rollbackReason.value}，本段不能再撤销`
    return null
  })
  const canUndoStep = computed<boolean>(
    () =>
      ports.mayMutate() &&
      moveInteraction.value !== null &&
      moveInteraction.value.steps.length > 0 &&
      undoBlockedReason.value === null,
  )
  /**
   * 用户 2026-11-13 批：不可用项不出现 ⇒「放弃本次移动」同样按同源判据隐藏。
   * 口径比 `canUndoStep` 更严一档：放弃＝整次回滚 + 收起会话，所以「无步可锚」的
   * 专规 1.4b 入盒（`rollbackFloor >= 0` 而 `steps.length === 0`）也算不可放弃。
   */
  const canAbortMove = computed<boolean>(() => {
    const interaction = moveInteraction.value
    if (interaction === null || !ports.mayMutate()) return false
    // 用户 2026-11-18：已结束＝已提交；越过掷骰边界或无步可锚的不可逆步 ⇒ 放弃同样不可用
    if (interaction.finished || rollbackFloor.value >= 0 || ports.undoSealReason() !== null)
      return false
    const locked = interaction.unitIds.some(
      (id) => moveContext.value.units.find((unit) => unit.id === id)?.mpLockedThisPhase,
    )
    return !locked
  })
  function refuseRollback(all = false): boolean {
    if (!ports.mayMutate()) return true
    const interaction = moveInteraction.value
    if (interaction === null) return true
    /*
     * 用户 2026-11-18：本段经过任何掷骰结算后，撤销一步与放弃整次移动都不再可用；
     * 已结束（=已提交）的移动同样不可再还原。无步可锚的 专规 1.4b 仍按原口径挡放弃。
     */
    if (interaction.finished) {
      moveBlocked.value = {
        rule: '6.1',
        reason: '本次移动已结束（6.1）：结束即提交，不能再还原',
      }
      pushLog('warning', moveBlocked.value.reason, moveBlocked.value.rule)
      return true
    }
    const sealed = ports.undoSealReason()
    if (sealed !== null) {
      moveBlocked.value = { rule: '6.1', reason: sealed }
      pushLog('warning', moveBlocked.value.reason, moveBlocked.value.rule)
      return true
    }
    const reason = undoBlockedReason.value
    const locked = reason?.startsWith('单位已承诺') === true
    // 撤销一步：有挡因即拒；放弃整次移动：只要已越过任何不可逆边界（含无步可锚的 专规 1.4b）即拒
    const hit = all ? locked || rollbackFloor.value >= 0 : reason !== null
    if (hit) {
      moveBlocked.value = {
        rule: locked ? '4.5b' : '6.1',
        reason: reason ?? `移动已触发${rollbackReason.value}，不能还原整次移动`,
      }
      pushLog('warning', moveBlocked.value.reason, moveBlocked.value.rule)
      return true
    }
    return false
  }
  function begin(unitIds: readonly string[]): boolean {
    if (!ports.mayMutate()) return false
    const current = moveInteraction.value
    if (current !== null && !current.finished && current.steps.length > 0) {
      moveBlocked.value = { rule: '6.1g', reason: '先结束当前单位或堆叠的移动，再移动另一组单位' }
      pushLog('warning', moveBlocked.value.reason, '6.1g')
      return false
    }
    const outcome = beginMove({
      context: moveContext.value,
      unitIds,
      runtime: moveRuntime.value,
      unitLabel: ports.unitNameOf,
    })
    if (!outcome.ok) {
      moveBlocked.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `不能移动：${outcome.reason}`, outcome.rule)
      return false
    }
    moveInteraction.value = outcome.data
    moveBlocked.value = null
    rollbackFloor.value = -1
    rollbackReason.value = ''
    return true
  }
  function commitStep(to: HexRef, path: readonly HexRef[]): boolean {
    const interaction = moveInteraction.value
    if (interaction === null || !ports.mayMutate()) return false
    const result = planStep({
      context: moveContext.value,
      interaction,
      runtime: moveRuntime.value,
      to,
      path,
    })
    if (!result.ok) {
      moveBlocked.value = { rule: result.rule, reason: result.reason }
      pushLog(
        'danger',
        `走 ${to.col}.${to.row} 不合法：${result.reason}（${result.rule}）`,
        result.rule,
      )
      return false
    }
    applyingStep = true
    try {
      applyMovePatches(result.data.patches)
    } finally {
      applyingStep = false
    }
    moveInteraction.value = result.data.interaction
    moveBlocked.value = null
    /*
     * 4.5a-A：把这一步**因进敌方 ZOC 被迫停车**的单位记进本轮账本 ——
     *   它们随后仍可选择"突袭"（原文的两个分支），`overrunCandidateUnits` 据此把它们留在候选里。
     *   `planStep` 已把它们的运行态 `ended` 置真，若不记这一笔，停车后 `overrunTargets` 会变成空集。
     */
    if (result.data.record.zocStoppedIds.length > 0) {
      zocStoppedMoveUnitIds.value = [
        ...new Set([...zocStoppedMoveUnitIds.value, ...result.data.record.zocStoppedIds]),
      ]
      /*
       * ★ 同一条 4.5a-A 的另一半：`planStep` 见"全体 ended"就把交互标成 `finished`，
       *   而 `applyOverrunMove` / `planStep` 都**拒绝**已 finished 的交互 ⇒ 停车后连突袭也一起被锁死。
       *   原文给的正是两个分支（停止 / 突袭）⇒ 只要本次有因 ZOC 停车者，交互就**不算收束**。
       *   ★ 不会因此放开普通移动：`reachableForMove` 仍按运行态的 `ended` 过滤
       *     （`move-interaction.ts:233`），停车的单位依旧走不了下一格。
       */
      if (moveInteraction.value?.finished === true) {
        moveInteraction.value = { ...moveInteraction.value, finished: false }
      }
    }
    lastStep.value = snapshotOf(result.data.record)
    pushLog('success', stepTextOf(result.data.record), result.data.record.rules[0] ?? '6.1')
    // ⑭ 接线：本步移动（6.1 逐格移动）入会话日志（本笔不掷骰；MP 消耗按 costById 复核）
    recordSettlement({
      action: 'move',
      rule: result.data.record.rules[0] ?? '6.1',
      data: {
        stage: 'step',
        from: { ...result.data.record.from },
        to: { ...result.data.record.to },
        movedIds: [...result.data.record.movedIds],
        droppedIds: [...result.data.record.droppedIds],
        zocStoppedIds: [...result.data.record.zocStoppedIds],
        costById: { ...result.data.record.costById },
      },
    })
    // 9.14：进入的格若有**敌方设施/后勤目标**（补给站/运输点/延补队/工事/空军基地）⇒ 触发特殊战斗
    triggerSpecialCombatAfterStep(to, result.data.record.movedIds)
    return true
  }

  function undoLastStep(): boolean {
    if (refuseRollback(false)) return false
    const interaction = moveInteraction.value
    if (interaction === null) return false
    if (interaction.steps.length === 0) {
      pushLog('info', '本次移动还没有可撤销的步骤')
      return false
    }
    const reverted = revertInteractionStep(interaction)
    applyMovePatches(reverted.patches)
    moveInteraction.value = reverted.interaction
    moveBlocked.value = null
    lastStep.value = null
    // 4.5a-A：撤销这一步 ⇒ 它带来的"进 ZOC 停车"记账一并对销（账本只反映**当前**盘面）
    zocStoppedMoveUnitIds.value = zocStoppedMoveUnitIds.value.filter(
      (id) => !interaction.steps[interaction.steps.length - 1]?.zocStoppedIds.includes(id),
    )
    pushLog('info', '撤销一步（还原运行态快照）', '6.1')
    return true
  }

  function cancelWholeMove(): boolean {
    if (refuseRollback(true)) return false
    const interaction = moveInteraction.value
    if (interaction === null) return false
    const reverted = revertInteraction(interaction)
    applyMovePatches(reverted.patches)
    moveInteraction.value = reverted.interaction
    moveBlocked.value = null
    lastStep.value = null
    // 4.5a-A：整次移动还原 ⇒ 停车账本随之清空
    zocStoppedMoveUnitIds.value = []
    pushLog('info', '取消本次移动（全部还原）', '6.1')
    return true
  }

  return {
    moveInteraction,
    zocStoppedMoveUnitIds,
    moveBlocked,
    begin,
    commitStep,
    undoLastStep,
    cancelWholeMove,
    markIrreversible,
    /** K5：撤销一步的可用性（UI 只读这一处；判据与 `refuseRollback` 同源） */
    canUndoStep,
    undoBlockedReason,
    /** 用户 2026-11-13 批：「放弃本次移动」的可用性（整次回滚口径，含无步可锚的 专规 1.4b） */
    canAbortMove,
    mayMutate: ports.mayMutate,
  }
}
