/**
 * workbench-move.ts —— C5 地面移动交互域（选子 → 范围 → 逐格 → 结束/撤销；含 20.0a 拆分/4.3 初设摆位）
 *
 * 搬了 **B3-1**：workbench.ts 7527–7969 的 **443 行 / 21 个顶层声明**
 * （15 个 function + 6 个 const：`settlementInProgress` / `breakdownWindows` / `setupWiggleParents` /
 * `setupWiggleOn` / `setupWiggleRemaining` / `breakdownTimingOf`）。
 *
 * 端口 **16 项**（2026-11-21 B-4 端口束试点后实测）：
 *   · 3 个共享束：`core`（日志/撤销/闸门）、`board`（板面 ref/computed 与查询）、`helpers`（纯判据/格式化）；
 *   · 8 个域对象/常量：NO_MOVEMENT_PHASES / session / groundMovement / airUnitTransit / selectedUnit /
 *     choices / moveUnits / PHASE_LABELS；
 *   · 5 个晚绑定访问器：breakdownPool / initialSetupInProgress / gates / specialPending / confirmMovePick。
 * 切片顶部仍按原名从束里解构，函数体零改动；晚绑定项只在调用时读 `ports.x`。
 *
 * 序列上的特殊之处：**建域点就在原区间位置（7527）**，因为 `movePick`/`stackSelect`/`moveUnits` 等
 * 状态都声明在 1.1k–7.2k，若把域提前到 `groundMovement`(1110) 之前，就得为 18 项状态开 getter。
 * 代价是 `nameOf`/`applyMovePatches`/`refuseWhileSettling`/`closeBreakdownWindows` 被**更早的域**
 * 当端口吃（1113/1115/1122/1567/2159/2222/7066），故 facade 侧保留 4 个一行薄转发。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import type { useGameSessionStore } from './session'
import type { createGroundMovementDomain } from './ground-movement'
import type { createAirDomain } from './workbench-air'
import type { WorkbenchGates } from './workbench-gates'
import type { MoveStepSnapshot } from './movement-types'
import type {
  ActionKey,
  ConsolePhase,
  ConsoleUnit,
  SettlementLock,
  TransportHandlingUndoEntry,
  UnitRecordView,
  WorkbenchLogEntry,
} from './workbench-model'
import type { Derivation } from '@/engine/derivation'
import type { HexRef, Side } from '@/data'
import type { BarrageInteractionState } from '@/engine/rules/barrage-interaction'
import { hexesWithin } from '@/engine/hex-geometry'
import type { CombatInteractionState } from '@/engine/rules/combat-interaction'
import type { BreakdownCreateTiming } from '@/engine/rules/breakdown'
import { canMoveInPhase, canSetModeAtSetup, canStackWithHedgehog } from '@/engine/rules/modes'
import type { BaseMode, Orientation } from '@/engine/rules/modes'
import { applyModeSwitch, canSwitchModeNow } from '@/engine/rules/move-interaction'
import type { MoveUnitRuntime } from '@/engine/rules/move-interaction'
import type { MoveInteractionState, GroupReachable } from '@/engine/rules/move-interaction'
import type { MoveContext, StepFailure } from '@/engine/rules/move-types'
import type { MoveStepRecord } from '@/engine/rules'
import type * as Rules from '@/engine/rules'
import type * as Geo from '@/engine/hex-geometry'
import type * as Model from './workbench-model'
import { engineerCapableNow, isReplUnit, modeUnitClassOf } from './workbench-model'
import type { SettlementRecordInput } from './workbench-core'
import {
  SETUP_WIGGLE_BREAKDOWN_RADIUS,
  SETUP_WIGGLE_MAX_DIVISIONS,
  isSetupWiggleParent,
} from '@/engine/rules/setup-wiggle'

/** 撤销账的族名（与 facade 私有 `UndoFamily` 同构；本切片只登记 `move.step`） */
export type MovementUndoFamily =
  'move.step' | 'transport' | 'setup' | 'draft' | 'arrival' | 'cache' | 'snapshot'

/**
 * 端口束 1：日志 / 撤销账 / 闸门 —— 每个交互域都要用的同一批能力。
 * 束化后它只占 1 个端口，而不是散成 5 项（见 2026-11-21 计划 §5 B-4）。
 */
export interface MovementCore {
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  noteUndoable: (family: MovementUndoFamily, label: string, snapshot?: unknown) => number
  requireAction: (key: ActionKey, action: string) => boolean
  actionAllowedNow: (key: ActionKey) => boolean
  refuseWhileLocked: (action: string) => boolean
  /** B3-2b2：撤销账读写（撤销 / 取消整次移动 / 装卸同账回退） */
  moveUndoSealReasonNow: () => string | null
  undoTransportHandlingNow: () => boolean
  dropUndoOf: (family: MovementUndoFamily) => void
  dropUndoFamilies: (families: readonly MovementUndoFamily[]) => void
  revertTransportHandlingSinceBaseline: () => void
  sealTransportHandlingForCommit: () => void
  clearMoveInteraction: () => void
}

/** 端口束 2：板面状态 —— 所有地面交互域共读的 ref / computed 与查询函数 */
export interface MovementBoard {
  activeSide: ComputedRef<Side>
  phase: ComputedRef<ConsolePhase>
  segmentLocked: ComputedRef<boolean>
  units: Ref<ConsoleUnit[]>
  selectedId: Ref<string | null>
  lastStep: Ref<MoveStepSnapshot | null>
  moveBlocked: ReturnType<typeof createGroundMovementDomain>['moveBlocked']
  moveInteraction: ReturnType<typeof createGroundMovementDomain>['moveInteraction']
  moveSessionSeq: Ref<number>
  transportHandlingBaseline: Ref<number>
  stackSelect: Ref<boolean>
  movePick: Ref<{ hex: HexRef; ids: string[] } | null>
  pausedTransportIds: Ref<string[]>
  transportHandlingUndo: Ref<TransportHandlingUndoEntry[]>
  combatState: Ref<CombatInteractionState | null>
  barrageState: Ref<BarrageInteractionState | null>
  /** 13.3f-B：每单位最后一次地面入格的格号文本 */
  lastGroundEntryByUnit: Ref<Record<string, string>>
  activeMoveUnits: ComputedRef<ConsoleUnit[]>
  moveContext: ComputedRef<MoveContext>
  moveRuntime: ComputedRef<MoveUnitRuntime[]>
  movePickPreviewInteraction: ComputedRef<MoveInteractionState | null>
  groupReachable: ComputedRef<GroupReachable>
  unitsAt: (hex: HexRef) => ConsoleUnit[]
  friendlyUnitsAt: (hex: HexRef) => ConsoleUnit[]
  movePickPoolAt: (hex: HexRef) => ConsoleUnit[]
  defaultMovePickIdsAt: (hex: HexRef) => string[]
  /** B3-2b3：当前日期（模式切换的日期闸门） */
  date: ComputedRef<string>
  /** B3-2b2：收束 / 悬停 / 过筹结算的板面状态 */
  moveLinger: Ref<boolean>
  hoverHex: Ref<HexRef | null>
  overrunContext: Ref<{
    target: HexRef
    participantIds: string[]
    mpRemainingBefore: number
    runtimeBefore: MoveUnitRuntime[]
  } | null>
  combatDefendingHexCleared: ComputedRef<boolean>
}

/** 端口束 3：纯判据 / 格式化 / 结算辅助 —— 全部是可提升的函数声明或静态 import */
export interface MovementHelpers {
  noteUnitLeftOwnBridgeHex: (unit: ConsoleUnit) => void
  unitOfInstance: (instanceId: string) => ConsoleUnit | undefined
  noteUnitEnteredHex: (unit: ConsoleUnit, hex: HexRef) => void
  nationalityOfUnit: (unit: ConsoleUnit) => string
  reserveMarkerStatusOf: (side: Side) => { cap: number; used: number; remaining: number }
  reservedHexes: (side: Side) => string[]
  hexKeyOf: (unit: ConsoleUnit) => string
  hexTextOf: (hex: HexRef) => string
  moveFailureNote: (failure: StepFailure) => { rule: string; text: string }
  applyFormationFuelCoverageToIds: (ids: readonly string[]) => void
  resolveSpecialCombatAt: (hex: HexRef, enteringSide: Side, byAdvance?: boolean) => void
  hexLabel: typeof Model.hexLabel
  allowReserveEntryAtHex: typeof Rules.allowReserveEntryAtHex
  previewStep: typeof Rules.previewStep
  planStep: typeof Rules.planStep
  reachableNodeAt: typeof Rules.reachableNodeAt
  sameHex: typeof Geo.sameHex
  areAdjacent: typeof Geo.areAdjacent
  /** B3-2b2：结算 / 过筹 / 步记录查询（按值可提升） */
  settleOverrunMove: (defenderLeftHex: boolean) => boolean
  snapshotOf: (record: MoveStepRecord) => MoveStepSnapshot
  recordSettlement: (input: SettlementRecordInput) => boolean
  hedgehogLevelOf: (hex: HexRef) => number
  endMoveEarly: typeof Rules.endMoveEarly
  zocStoppedMoveUnitIds: Ref<string[]>
  /** B3-2b3：模式名 / 工事状态 / 工程能力记账 */
  MODE_LABELS: Record<BaseMode, string>
  hedgehogHexState: (hex: HexRef) => { level: number }
  noteEngineerCapabilityAfter: (unit: ConsoleUnit, wasCapable: boolean) => void
}

/** C5 移动交互的端口：3 个共享束 + 8 个域对象 + 5 个晚绑定访问器（2026-11-21 实测 16 项）。 */
export interface MovementDomainPorts {
  /** ── 按值：常量 / 会话 / 域对象 ── */
  NO_MOVEMENT_PHASES: readonly ConsolePhase[]
  session: ReturnType<typeof useGameSessionStore>
  groundMovement: ReturnType<typeof createGroundMovementDomain>
  airUnitTransit: ReturnType<typeof createAirDomain>['airUnitTransit']
  selectedUnit: ComputedRef<ConsoleUnit | null>
  choices: ComputedRef<UnitRecordView[]>
  moveUnits: ComputedRef<ConsoleUnit[]>
  PHASE_LABELS: Record<ConsolePhase, string>
  /** ── 端口束（B-4 试点） ── */
  core: MovementCore
  board: MovementBoard
  helpers: MovementHelpers
  /** ── 晚绑定：声明在建域点之后，只在求值时读取 ── */
  breakdownPool: Ref<Record<string, number>>
  initialSetupInProgress: Ref<boolean>
  gates: WorkbenchGates
  specialPending: Ref<Model.SpecialCombatPending | null>
  confirmMovePick: () => boolean
}

export function createMovementDomain(ports: MovementDomainPorts) {
  const {
    NO_MOVEMENT_PHASES,
    session,
    groundMovement,
    airUnitTransit,
    selectedUnit,
    choices,
    moveUnits,
    PHASE_LABELS,
  } = ports

  /** 端口束 1：日志 / 撤销 / 闸门 */
  const {
    pushLog,
    noteUndoable,
    requireAction,
    actionAllowedNow,
    refuseWhileLocked,
    moveUndoSealReasonNow,
    undoTransportHandlingNow,
    dropUndoOf,
    dropUndoFamilies,
    revertTransportHandlingSinceBaseline,
    sealTransportHandlingForCommit,
    clearMoveInteraction,
  } = ports.core

  /** 端口束 2：板面状态 */
  const {
    activeSide,
    phase,
    segmentLocked,
    units,
    selectedId,
    lastStep,
    moveBlocked,
    moveInteraction,
    moveSessionSeq,
    transportHandlingBaseline,
    stackSelect,
    movePick,
    pausedTransportIds,
    transportHandlingUndo,
    combatState,
    barrageState,
    lastGroundEntryByUnit,
    activeMoveUnits,
    moveContext,
    moveRuntime,
    movePickPreviewInteraction,
    groupReachable,
    unitsAt,
    friendlyUnitsAt,
    movePickPoolAt,
    defaultMovePickIdsAt,
    moveLinger,
    hoverHex,
    overrunContext,
    combatDefendingHexCleared,
    date,
  } = ports.board

  /** 端口束 3：纯判据 / 格式化 / 结算辅助 */
  const {
    noteUnitLeftOwnBridgeHex,
    unitOfInstance,
    noteUnitEnteredHex,
    nationalityOfUnit,
    reserveMarkerStatusOf,
    reservedHexes,
    hexKeyOf,
    hexTextOf,
    moveFailureNote,
    applyFormationFuelCoverageToIds,
    resolveSpecialCombatAt,
    hexLabel,
    allowReserveEntryAtHex,
    previewStep,
    planStep,
    reachableNodeAt,
    sameHex,
    areAdjacent,
    settleOverrunMove,
    snapshotOf,
    recordSettlement,
    hedgehogLevelOf,
    endMoveEarly,
    zocStoppedMoveUnitIds,
    MODE_LABELS,
    hedgehogHexState,
    noteEngineerCapabilityAfter,
  } = ports.helpers

  /* ──────────────── C5 移动交互：选子 → 范围 → 逐格 → 结束/撤销 ──────────────── */

  /** 单位实例 id → 显示名 */
  function nameOf(unitId: string): string {
    return (
      units.value.find((item) => item.instanceId === unitId)?.name ??
      airUnitTransit.find(`unit:${unitId}`)?.name ??
      unitId
    )
  }

  /** 界面用：单位实例 id → 显示名（与 `nameOf` 同源，导出供面板直接调用而不自行查表） */
  function unitNameOf(unitId: string): string {
    return nameOf(unitId)
  }

  /** 把引擎给出的运行态变更落盘到单位上（引擎不写状态，CODE_SPEC §3.1） */
  function applyMovePatches(patches: readonly MoveUnitRuntime[]): void {
    for (const patch of patches) {
      const unit = units.value.find((item) => item.instanceId === patch.unitId)
      if (unit === undefined) continue
      unit.hex = { ...patch.hex }
      unit.mpSpent = patch.spentMp
      unit.movementEnded = patch.ended
      // 13.8b 末句例外：离开自有桥格后，这条例外即用尽
      noteUnitLeftOwnBridgeHex(unit)
      // 专规 3.5：进入建造标记格即触发毁伤判定
      noteUnitEnteredHex(unit, patch.hex)
    }
  }

  /**
   * 9.2 / 10.0：**结算进行中**（一场战斗或轰炸已开局、尚未收束）
   *
   * 用户口径（第六批 BUG ②）：「在**任何**结算战斗或者轰炸的时候**不应该有单位能动**」。
   * 规则依据：
   *   · 8.0 突袭**照 9.2 的九步流程**结算（8.0 原文「请像结算其他战斗一样来结算突袭」），
   *     故突袭一开局就**在 9.2 流程里**；9.2 的流程走完前，8.1a 的 3 MP、8.0 的进格、
   *     9.12 的推进与撤退**都还没有落盘**（`finishMove` 早已按这个理由拒绝收束）；
   *   · 10.0 的轰炸同样是「宣布 → 逐项结算 → 收束」的单一流程，DG 与军力损失同理。
   * 流程没收束就插入移动 ⇒ 同一批单位同时处在两个流程里，两边都要写同一批事实，
   * 记账无从收束。故这里给出**唯一判据**：收束或按 Esc 放弃（`cancelCombat` / `cancelBarrage`）后自动解除。
   */
  const settlementInProgress = computed<SettlementLock | null>(() => {
    const combat = combatState.value
    if (combat !== null && !combat.finished)
      return { kind: 'combat', rule: '9.2', label: '战斗（含 8.0 突袭，照 9.2 结算）' }
    const barrage = barrageState.value
    if (barrage !== null && !barrage.finished)
      return { kind: 'barrage', rule: '10.0', label: '轰炸（10.0 流程）' }
    return null
  })

  /**
   * 9.2 / 10.0：结算进行中 ⇒ 拒绝移动（唯一的拒绝出口；三个移动入口都问它）
   *
   * 不静默：`moveBlocked` 给对局台状态条、日志给侧栏，玩家看得见"为什么动不了"以及怎么办。
   */
  function refuseWhileSettling(action: string): boolean {
    return ports.gates.refuseWhileSettling(action)
  }

  /**
   * 开始一次移动（1 个单位或 1 个堆叠，6.1）
   *
   * 可行性一律问引擎 `beginMove`（阶段 6.0 / MA 6.1b / 垫人锁 4.5b / 燃料 12.5a / 延补队面 12.7）；
   * 失败时把原因留在 `moveBlocked` 供界面显示，不静默。
   */
  function beginMoveFor(unitIds: readonly string[]): boolean {
    // 2.2：回合准备环节（天气 / 先手判定）不属于任何段 ⇒ 先于「段」判断题拦下
    if (segmentLocked.value) return refuseWhileLocked('移动')
    // 9.2 / 10.0：战斗或轰炸正在结算 ⇒ 任何单位都不得开拔（第六批 BUG ②）
    if (refuseWhileSettling('移动')) return false
    // 2.2：A 整备 / B 增援 / D 补给 / F 战斗 / H 清理都没有移动环节（只有 C/E/G 有）
    if (NO_MOVEMENT_PHASES.includes(phase.value)) {
      const reason = `${PHASE_LABELS[phase.value]}段没有移动环节，不能移动（2.2）`
      moveBlocked.value = { rule: '2.2', reason }
      pushLog('warning', reason, '2.2')
      return false
    }
    // 专规 2.4：Slow Mobilization 锁定的师不能移动（也不能拆出 breakdown）
    const locked = unitIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined && unit.locked)
    if (locked.length > 0) {
      const reason = `被锁定的师不能移动：${locked.map((unit) => unit.name).join('、')}（专规 2.4）`
      moveBlocked.value = { rule: '专规 2.4', reason }
      pushLog('warning', reason, '专规 2.4')
      return false
    }
    /*
     * B8：**环节级**闸门。上面的 `NO_MOVEMENT_PHASES` 只判"这一段有没有移动环节"
     * （A/B/D/F/H 没有），这里再判"这一段**当前这一环**允不允许移动"——C 段的首环是
     * **突围**（12.8e「before any other movement」），那一刻不该放行常规移动。
     * 两条判据都保留：段级那条给出更贴切的原因码（如 `moveBlocked` 的 2.2），环节级这条管细粒度。
     */
    if (!requireAction('move.order', '移动')) return false
    /*
     * 13.2g：编内卡车＝**特殊的运输点数**（原文「与其他运输点数基本一样」），所以它**是独立算子**：
     * 可以单独选中、单独开拔（载运/MA/装卸全部复用运输点数的既有实现）；选中整堆时它也一起走。
     * 原文只列特殊处 A–G（不得卸载 SP / 只服务同编队 / 不能并延补队 / 可进预备 / 可随撤退不可单独撤 /
     * 被夺取转常规运输点数 / 可留 SP 不付战斗补给），**没有**"不能独立移动"这一条 ⇒ 不设任何特判。
     */
    const moveIds = [...unitIds]
    // #13：本编队已付过编队油且同格 ⇒ 先补记（阅读顺序：判据在 applyFormationFuelCoverage）
    applyFormationFuelCoverageToIds(moveIds)
    /*
     * 13.2a：运输点数「暂停移动并使用它装载的部分补给、然后继续移动」——两条落地：
     *   ① 暂停的运输点数**可以**在同一移动阶段内再次开拔 ⇒ 解开 6.1g 的"本轮已结束"；
     *   ② 原文限制「运输点数必须在另一个单位移动之前完成它的移动」⇒ 暂停期间别的单位
     *      不得开拔（付款、切模式等非移动动作不受限）。
     * 阶段级排序原文未给：本处只判"别的单位是否先动"，不排阶段（见交付摘要"真空白"）。
     */
    const paused = pausedTransportIds.value
    const resumingIds = moveIds.filter((id) => paused.includes(id))
    if (paused.length > 0 && resumingIds.length === 0) {
      const reason = '运输点数已暂停移动：必须先让它继续并完成移动，其它单位才能开拔（13.2a）'
      moveBlocked.value = { rule: '13.2a', reason }
      pushLog('warning', reason, '13.2a')
      return false
    }
    const resumed = units.value.filter(
      (unit) => resumingIds.includes(unit.instanceId) && unit.movementEnded,
    )
    for (const unit of resumed) unit.movementEnded = false
    if (!groundMovement.begin(moveIds)) {
      // 引擎仍拒绝（燃料/阶段等）⇒ 恢复「已结束」并保留暂停账，免得凭空多出一次移动
      for (const unit of resumed) unit.movementEnded = true
      return false
    }
    // 13.2f：本次移动的装卸撤销账从这一刻起算（之前的装卸属于上一笔动作）
    transportHandlingBaseline.value = transportHandlingUndo.value.length
    // 用户 2026-11-20：新开拔＝新的一笔；上一支堆叠的掷骰封账不连坐这一笔
    moveSessionSeq.value += 1
    pausedTransportIds.value = paused.filter((id) => !resumingIds.includes(id))
    // 条 22（批 T）：20.0a 的**创建时机**＝「开始移动」这个**事件**（不是"当前在移动段"这个状态）
    openBreakdownWindow('startMove', moveIds)
    return true
  }

  /*
   * 条 22（批 T）：20.0a 创建拆分单位的**时机窗口**
   *
   * 原文 20.0a：「多军力单位在**开始移动、战后推进或战后撤退**时，可以创建一个或多个拆分单位。
   *   **只有在这些时机**才能创建拆分单位。」
   * ⇒ 时机是**事件**，不是"当前处在哪个阶段"。修前 `createBreakdownNow` 用
   *   `phase === 'movement' ? 'startMove' : 'advanceAfterCombat'` **按阶段猜**：
   *   ① 战后**撤退**被错记为 advanceAfterCombat（20.0a 的三个时机里没有这条）；
   *   ② C 段里"根本还没开拔"的单位也能创建。
   *   现在由三个真实事件各自开窗，`createBreakdownNow` 只认这里的记录（且母单位须在该事件的名单里）。
   */
  const breakdownWindows = ref<{ timing: BreakdownCreateTiming; unitIds: string[] }[]>([])

  /*
   * 专规 4.3（可选）Setup Wiggle A：初设阶段，最多 6 个**满员**苏军步兵师各拆一个团
   *
   * 本账本只记「已经拆过团」的母师实例 id（上限 6）；未勾定 4.3 时它恒空，
   * `breakdownTimingOf` 在初设阶段仍返回 null —— 初设流程与修前逐字相同。
   */
  const setupWiggleParents = ref<string[]>([])

  /** 4.3 是否启用（选剧本前勾定；开局冻结） */
  const setupWiggleOn = computed(() => session.rule4On('setupWiggle'))

  /** 4.3 A：还剩几个师的拆团名额（0..6） */
  const setupWiggleRemaining = computed(() =>
    Math.max(0, SETUP_WIGGLE_MAX_DIVISIONS - setupWiggleParents.value.length),
  )

  /**
   * 4.3 A：该单位此刻能否在初设里拆团
   *
   * 三关：初设进行中 ∧ 4.3 启用；母师是**满员**苏军步兵师（印值 ≥2 步，本作无 4 步师）；本师未用过且总名额未满。
   */
  function setupWiggleEligible(unit: ConsoleUnit): boolean {
    if (!setupWiggleOn.value || !ports.initialSetupInProgress.value) return false
    if (!isSetupWiggleParent(unit)) return false
    if (setupWiggleParents.value.includes(unit.instanceId)) return false
    return setupWiggleRemaining.value > 0
  }

  /** 4.3 A：初设拆团的落点候选（母师两格内；含母师格，均须在图上） */
  function setupBreakdownCandidates(parentId: string): readonly HexRef[] {
    const parent = units.value.find((item) => item.instanceId === parentId)
    if (parent === undefined || !setupWiggleEligible(parent)) return []
    return hexesWithin(parent.hex, SETUP_WIGGLE_BREAKDOWN_RADIUS, { onMapOnly: true })
  }

  /** 开/换一个时机窗口（同一时机只留最新一份） */
  function openBreakdownWindow(timing: BreakdownCreateTiming, unitIds: readonly string[]): void {
    if (unitIds.length === 0) return
    breakdownWindows.value = [
      ...breakdownWindows.value.filter((window) => window.timing !== timing),
      { timing, unitIds: [...unitIds] },
    ]
  }

  /** 关闭窗口（不传时机＝全关） */
  function closeBreakdownWindows(timing?: BreakdownCreateTiming): void {
    breakdownWindows.value =
      timing === undefined
        ? []
        : breakdownWindows.value.filter((window) => window.timing !== timing)
  }

  /** 该单位当前处在 20.0a 的哪一个时机里（null＝不在任何合法时机） */
  const breakdownTimingOf = (unitId: string): BreakdownCreateTiming | null => {
    for (const window of breakdownWindows.value) {
      if (window.unitIds.includes(unitId)) return window.timing
    }
    /*
     * ★ 用户 2026-11-10 裁定：**拆分不依赖「开始移动」按钮**。
     *   20.0a 的「开始移动」是事件，不是"必须先点一次开始移动"。对于本方移动环节里
     *   **本阶段还没动过**（`mpSpent === 0`）的单位，拆出拆分单位本身就是它开始移动的
     *   那一刻。已经动过的单位不能再按这个时机拆，仍只认推进 / 撤退两个事件窗口。
     */
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) return null
    /*
     * 专规 4.3（可选）A：初设阶段的拆团窗口（满员苏军 4 步步兵师，最多 6 个师）。
     * 未启用时 `setupWiggleEligible` 恒 false ⇒ 初设阶段仍返回 null（与修前逐字相同）。
     */
    if (setupWiggleEligible(unit)) return 'setupWiggle'
    if (phase.value !== 'movement' || activeSide.value !== unit.side) return null
    if (unit.mpSpent > 0) return null
    return 'startMove'
  }

  /**
   * 20.0 / 20.0a / 20.0b / 20.0g：该单位此刻**能不能**作为母单位创建拆分单位
   *
   * 用户 2026-11-14 口径「不可用项不出现」：修前右键菜单只看 `breakdownTimingOf`，
   * 于是运输点数、空军基地、乃至**1 军力的拆分单位本身**都出「创建拆分单位」，
   * 点开后才被 20.0（类型 / 最后一点军力）拒——入口是假的。这里把同一批判据前移：
   *   · 20.0：只有「其他」类型；拆分单位本身已无军力可拆；最后一点军力不能拆；
   *   · 20.0a：须处在真事件开出的时机窗口（`breakdownTimingOf`）；
   *   · 20.0b：同方池里至少有一档 AR ≤ 母单位 AR；
   *   · 20.0g：该方拆分单位池尚有存量。
   */
  function canCreateBreakdownNow(unitId: string): boolean {
    const unit = unitOfInstance(unitId)
    if (unit === undefined) return false
    if (unit.specialized.includes('breakdown')) return false
    if (unit.combatClass !== 'other') return false
    if (unit.steps < 2) return false
    if (breakdownTimingOf(unitId) === null) return false
    if (breakdownRecordChoicesFor(unitId).length === 0) return false
    return (ports.breakdownPool.value[nationalityOfUnit(unit)] ?? 0) > 0
  }

  /**
   * 20.0b：该母单位可选的拆分单位**记录**（同方、AR ≤ 母单位 AR）
   *
   * 面板的下拉只列这一份——修前列了整张拆分单位表，选 AR5 才被 20.0b 拒。
   */
  function breakdownRecordChoicesFor(parentId: string) {
    const parent = unitOfInstance(parentId)
    if (parent === undefined) return []
    const parentAr = parent.faces.combat.ar
    return choices.value.filter(
      (item) =>
        item.branch === 'breakdown' &&
        item.side === parent.side &&
        (item.factors?.combat?.ar ?? Number.POSITIVE_INFINITY) <= parentAr,
    )
  }

  /**
   * 20.0b / 20.0c / 20.0d：该母单位此刻可吸收的拆分单位（同方、同格堆叠、AR ≥ 母单位、标记模式相同）
   *
   * 吸收只发生在阶段末且须与母单位堆叠 ⇒ 面板不该列出别格 / 敌方 / 状态不一致的算子。
   */
  function breakdownAbsorbChoicesFor(parentId: string): ConsoleUnit[] {
    const parent = unitOfInstance(parentId)
    if (parent === undefined) return []
    const parentAr = parent.faces.combat.ar
    return unitsAt(parent.hex).filter(
      (unit) =>
        unit.side === parent.side &&
        unit.specialized.includes('breakdown') &&
        unit.faces.combat.ar >= parentAr &&
        unit.mode.mode === parent.mode.mode &&
        unit.mode.dg === parent.mode.dg &&
        (unit.internalStocks ?? 'ready') === (parent.internalStocks ?? 'ready'),
    )
  }

  /**
   * 20.0d：该母单位此刻能否**吸收**拆分单位
   *
   * 原文：「减损的多军力单位在任何阶段结束时，都必须吸收与之堆叠、且符合吸收规则的
   * 拆分单位……**只有在这种时机才能吸收**」⇒ 只在 H 清理（`phase === 'cleanUp'`）露面；
   * 移动 / 战斗 / 反应 / 进击段一律不摆入口（用户 2026-11-14 裁定 2）。
   */
  function canAbsorbBreakdownNow(parentId: string): boolean {
    return phase.value === 'cleanUp' && breakdownAbsorbChoicesFor(parentId).length > 0
  }

  /** 因燃料/模式等原因没能开始移动时，条件满足后自动重试，省得玩家再点一次 */
  function retryBeginMove(): void {
    if (moveInteraction.value !== null) return
    /*
     * ★ B26：重试的对象必须与**付款口径**一致（`moveUnits → movePick.ids → selectedUnit`，见 `fuelTargets`）。
     *   修前这里只取 `selectedUnit`（＝堆叠顶上一枚）⇒ 一堆叠付完油后**只有顶上一枚开拔**，
     *   其余既没加油也没跟上，玩家再点那一堆叠又只会看到"这是当前所在格"。
     *   这正是用户报告「点击堆叠总是默认移动第一个单位、无法选中堆叠其它单位」的直接机制。
     */
    const ids =
      moveUnits.value.length > 0
        ? moveUnits.value.map((unit) => unit.instanceId)
        : (movePick.value?.ids ??
          (selectedUnit.value === null ? [] : [selectedUnit.value.instanceId]))
    if (ids.length === 0) return
    beginMoveFor(ids)
  }

  /**
   * C5：选中某格的单位作为开拔候选（6.1）
   *
   * ★ 条 10（M1）：**只建立取子清单，不自动开拔**——旧口径「点格即开始移动」已作废
   *   （裁定表 ②），玩家勾选（地图上点枚）或单选后，必须点移动会话里的「开始移动」按钮才真正开拔；
   *   保留条 18 的"点回本单位即停 + 惰性清理"。三种情形都只写 `movePick`：
   *   - 该格只有一枚 ⇒ 候选即这一枚；
   *   - 多枚且未开「整堆叠」 ⇒ 候选先放顶上一枚，玩家在地图上逐枚勾选；
   *   - 多枚且已开「整堆叠」 ⇒ 整堆叠一起作为候选。
   */
  function selectForMove(hex: HexRef, only?: readonly string[]): void {
    /*
     * 2.2：回合准备环节（天气 / 先手判定）**没有行动段** ⇒ 左键只做只读选中，
     * 不建「待开拔」取子清单。否则本地段的移动会话（含「开始移动」）会漏进这个环节：
     * 玩家点了才算被 2.2 拒，观感上等于"这里本来能移动"。
     *
     * 缺陷 B（2026-11-14 实点）：同样按**环节归属**收口——只有放行 `move.order` 的环节
     * （C 移动 / E 反应 / G 进击的对应环节）才建待开拔集；补给、战斗、轰炸、重建等环节
     * 点己方单位只做只读选中，不再写 `movePick`、不再记「已选待开拔（6.1）」。
     */
    /*
     * 用户 2026-11-18：初设期左键只做选中与堆叠显示，**不建待开拔集**、不投移动力范围。
     * 初设阶段值沿用 `movement` 默认，若不在这里早退，点格摊堆叠会直接建出取子清单。
     */
    if (ports.initialSetupInProgress.value) {
      movePick.value = null
      const atHex = friendlyUnitsAt(hex)
      selectedId.value = only?.[only.length - 1] ?? atHex[atHex.length - 1]?.instanceId ?? null
      return
    }
    const moveAllowed = actionAllowedNow('move.order')
    if (segmentLocked.value || !moveAllowed) {
      movePick.value = null
      const atHex = friendlyUnitsAt(hex)
      const picked = only?.[only.length - 1] ?? atHex[atHex.length - 1]?.instanceId ?? null
      selectedId.value = picked
      if (segmentLocked.value) {
        refuseWhileLocked('开拔')
        return
      }
      /*
       * 2.2 / M9②：段别不对时仍要给**带规则号的解释**（A/B/D/F/H 没有移动环节）——
       * 与 `beginMoveFor` 同一句文案，界面反馈条据此显示；只是不再建「待开拔」。
       */
      if (NO_MOVEMENT_PHASES.includes(phase.value)) {
        const reason = `${PHASE_LABELS[phase.value]}段没有移动环节，不能移动（2.2）`
        moveBlocked.value = { rule: '2.2', reason }
        pushLog('warning', reason, '2.2')
        return
      }
      const unit =
        picked === null ? undefined : units.value.find((item) => item.instanceId === picked)
      pushLog('info', `选中 ${unit?.name ?? `${hex.col}.${hex.row}`}（本环节不可移动，仅供查看）`)
      return
    }
    const friendlies = movePickPoolAt(hex)
    if (friendlies.length === 0) {
      /*
       * #15：本格只剩**已结束本轮移动**（或补员）的算子 ⇒ 不建立取子清单 ⇒ 界面没有「开始移动」入口。
       * 6.1g「一旦开始移动就必须走完」；13.2a 的暂停实例仍在池里（可继续），不落到这里。
       *
       * 7.0a / 11.0a：若池空是因为**本阶段资格**（未释放的预备 / 无进击标记），给出那条规则号，
       * 而不是笼统的"本轮移动已结束"。
       */
      movePick.value = null
      const atHex = friendlyUnitsAt(hex)
      selectedId.value = atHex[atHex.length - 1]?.instanceId ?? null
      const segmentPhase = phase.value
      const verdict =
        segmentPhase === 'reaction' || segmentPhase === 'exploitation'
          ? atHex
              .map((unit) =>
                canMoveInPhase(
                  { state: unit.mode, side: unit.side, activeSide: activeSide.value },
                  segmentPhase,
                ),
              )
              .find((item) => !item.ok)
          : undefined
      if (verdict !== undefined && !verdict.ok) {
        moveBlocked.value = { rule: verdict.rule, reason: verdict.reason }
        pushLog('warning', verdict.reason, verdict.rule)
        return
      }
      pushLog('info', '该格没有可开拔的单位（本轮移动已结束，6.1g / 13.2a）', '6.1g')
      return
    }
    const defaults = defaultMovePickIdsAt(hex)
    const last =
      friendlies.find((unit) => unit.instanceId === defaults[defaults.length - 1]) ??
      friendlies[friendlies.length - 1]!
    /*
     * ★ 用户 2026-11-10：地图上**点某一枚** ⇒ 就选这一枚（`only`），不再整格全选；
     *   整格全选走"点格内空白"（`expandStackAt`）。
     * #8：`only` 指向池外实例（补员 / 已结束移动）⇒ 不建清单，绝不用默认集顶替。
     */
    const pickedOnly =
      only === undefined ? [] : friendlies.filter((unit) => only.includes(unit.instanceId))
    if (only !== undefined && pickedOnly.length === 0) {
      movePick.value = null
      selectedId.value = only[only.length - 1] ?? null
      return
    }
    const picked = pickedOnly.length > 0 ? pickedOnly[0]! : last
    const ids =
      pickedOnly.length > 0
        ? pickedOnly.map((unit) => unit.instanceId)
        : stackSelect.value
          ? defaults
          : [last.instanceId]
    movePick.value = { hex: { col: hex.col, row: hex.row }, ids }
    // #13：选中即补记编队油（同格同编队，付款后进入本格的单位不再被要求加油）
    applyFormationFuelCoverageToIds(ids)
    selectedId.value = picked.instanceId
    /*
     * G2（用户 2026-11-17 实走）：**换选成功即清掉旧拒绝** ——
     * 修前 `moveBlocked` 只在成功走一步 / 撤销 / 结束移动时清；先点远格被拒、再换选另一支己方
     * 堆叠时，顶部红字仍指着已经不存在的意图（「这一步被拒：…」挂在新的选中上）。
     */
    moveBlocked.value = null
    lastStep.value = null
    pushLog(
      'info',
      `${hex.col}.${hex.row} 已选 ${ids.length} 枚待开拔（6.1）：${ids.length > 1 ? '在地图上点枚勾选' : '单选'}，点「开始移动」才开拔`,
      '6.1',
    )
  }
  /**
   * 5.4a：该单位此刻能否**转入预备模式**（按格额度闸门；电子版＝程序校验）
   *
   * 用户 2026-11-06 裁定：
   *   - 一枚标记＝**一个格子**里处于预备模式的那部分单位（5.4a / 4.8b）⇒ 同格已有预备单位
   *     ⇒ 不额外占额度；同格没有 ⇒ 占 1 格；
   *   - 剧本给几枚 ＝ 能同时保持几个格子处于预备；**没给就是 0** ⇒ 该方完全没有预备权
   *     （进入即拒，不是"不校验"）；
   *   - 转入那一刻即占（原文「完成 25% 移动后才需要放置标记」是实体版省标记的宽容条款）。
   *
   * 额度由 `units` 的当前模式**派生**（见 `reservedHexes`），不维护账本 ⇒ 被拒时单位仍停在
   * 原模式，不留半截状态。
   *
   * @returns 能否转入（被拒时已写日志）
   */
  function canEnterReserveMode(unit: ConsoleUnit): boolean {
    const status = reserveMarkerStatusOf(unit.side)
    const outcome = allowReserveEntryAtHex({
      side: unit.side,
      cap: status.cap,
      hex: hexKeyOf(unit),
      occupiedHexes: reservedHexes(unit.side),
    })
    if (outcome.ok) return true
    const detail = outcome.reason.startsWith('noReserveMarkerAvailable')
      ? '剧本未给本方预备标记（0 枚），无预备权（5.4a）'
      : `本方的预备标记已用完（${String(status.cap)} 个格子），不能再把一个格子转入预备（5.4a）`
    pushLog('warning', `${unit.name} 不能转入预备模式：${detail}`, outcome.rule)
    return false
  }

  /** C5：提交一步（引擎给出 patches 与新的交互状态） */
  function commitStep(to: HexRef, path: readonly HexRef[]): boolean {
    const ok = groundMovement.commitStep(to, path)
    if (ok) {
      // 13.3f-B：记「本阶段最后一次地面入格」，供移动交互被替换后仍能换轨
      const steps = moveInteraction.value?.steps ?? []
      const step = steps[steps.length - 1]
      if (step !== undefined && step.kind === 'step') {
        const next = { ...lastGroundEntryByUnit.value }
        for (const id of step.movedIds) next[id] = hexTextOf(to)
        lastGroundEntryByUnit.value = next
      }
      // 用户 2026-11-20：全局撤销账 —— 每一步都是一笔可撤操作
      noteUndoable('move.step', `移动一步 → ${hexLabel(to)}`)
    }
    return ok
  }

  /** 13.3f-B：撤销/取消后按移动交互里剩余的步骤回算地面入格账本 */
  function syncGroundEntries(unitIds: readonly string[]): void {
    const steps = moveInteraction.value?.steps ?? []
    const next = { ...lastGroundEntryByUnit.value }
    for (const id of unitIds) {
      let last: HexRef | null = null
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        const step = steps[index]!
        if (step.kind === 'step' && step.movedIds.includes(id)) {
          last = step.to
          break
        }
      }
      if (last === null) delete next[id]
      else next[id] = hexTextOf(last)
    }
    lastGroundEntryByUnit.value = next
  }

  /**
   * 9.14：移动进入某格后的**特殊战斗**触发
   *
   * 前提（规则原文）：「（敌方）可攻击单位**进入**该格」——故要传本次**实际移动**的单位
   * （`movedIds`），由进入方阵营与 `attackCapable` 决定是否成立；引擎会再核一遍。
   * 位移落点由玩家在地图上选（`specialPending`），因此移动路径在待决清空前应当停住。
   */
  function triggerSpecialCombatAfterStep(to: HexRef, movedIds: readonly string[]): void {
    if (ports.specialPending.value !== null) return
    const enteringSide = movedIds
      .map((id) => units.value.find((unit) => unit.instanceId === id)?.side)
      .find((side) => side !== undefined)
    if (enteringSide === undefined) return
    resolveSpecialCombatAt(to, enteringSide)
  }

  /**
   * 沿路径逐格推进（点远处的可达格 = 沿预览路径一直走过去；6.1 逐格移动）
   *
   * 每一格都重新问引擎（`previewStep`）——「走一格、范围重算一次」由此自然成立；
   * 遇到 4.5a-A 的敌方 ZOC 会**停下来先问玩家**，确认后从该步继续。
   * `path` 含起点，故从下标 1 起。
   */
  function advanceAlongPath(path: readonly HexRef[]): void {
    for (let index = 1; index < path.length; index += 1) {
      if (moveInteraction.value === null) return
      if (activeMoveUnits.value.length === 0) return
      const to = path[index]!
      const preview = previewStep({
        context: moveContext.value,
        interaction: moveInteraction.value,
        runtime: moveRuntime.value,
        to,
        path: path.slice(0, index + 1),
      })
      if (!preview.ok) {
        const blocked = preview.blocked
        if (blocked !== undefined) {
          const note = moveFailureNote(blocked)
          moveBlocked.value = {
            rule: blocked.rule,
            reason: `走不进 ${to.col}.${to.row}：${note.text}`,
          }
          pushLog(
            'warning',
            `走到 ${to.col}.${to.row} 停住：${note.text}（${blocked.rule}）`,
            blocked.rule,
          )
        }
        return
      }
      /*
       * 4.5a-A：轮式单位进入未抵消的敌方 ZOC ⇒ **必须就地停止**。这是规则既定后果，
       * 不再弹「进入并突袭 / 进入停下」确认面板（用户裁定：轮式不该因守规则多一步确认）。
       * 直接落这一步；同行而仍能走的步行/履带单位继续沿原路径推进。
       * 停车的单位随后照常留在突袭候选里（`commitStep` 记 `zocStoppedIds`），
       * 相邻敌方格的高亮与地图上的突袭入口与其它单位完全一致。
       */
      if (preview.needsConfirm) {
        pushLog(
          'warning',
          `进入 ${to.col}.${to.row} 的敌方 ZOC：轮式单位就地停止（4.5a-A；仍可对相邻敌方格发起突袭）`,
          '4.5a-A',
        )
        if (!commitStep(to, path.slice(0, index + 1))) return
        if (ports.specialPending.value !== null) return
        continue
      }
      if (!commitStep(to, path.slice(0, index + 1))) return
      // 9.14：该步触发了设施夺取的待决（位移落点待选）⇒ 停住推进，先让玩家处置
      if (ports.specialPending.value !== null) return
    }
  }

  /**
   * 2026-11-18：把画布给的拖动路径规范化成「起点开头、逐格相邻」的序列。
   *
   * 落位（`moveAlongDraggedPath`）与预览（`previewDraggedPath`）共用这一份形状校验，
   * 免得两处各写一遍、日后一处改了一处忘。
   */
  function normalizeDraggedPath(
    path: readonly HexRef[],
  ): { ok: true; full: HexRef[] } | { ok: false; rule: string; reason: string } {
    const pick = movePick.value
    const start = moveInteraction.value?.start ?? pick?.hex ?? null
    if (start === null) return { ok: false, rule: '6.1', reason: '尚未选择要移动的单位' }
    const full: HexRef[] = [{ ...start }]
    for (const hex of path) {
      const last = full[full.length - 1]!
      if (sameHex(last, hex)) continue
      if (!areAdjacent(last, hex)) return { ok: false, rule: '6.1', reason: '拖动路径不连续' }
      full.push({ ...hex })
    }
    return { ok: true, full }
  }

  /**
   * 2026-11-18：**拖动路径预览**（只读，画布拖动中每换一格调一次）
   *
   * 与 `moveAlongDraggedPath` 同一串判据（`simulateMovePath` 的纯预演）；只回答
   * "整条路径此刻走不走得通"，**不写步、不动单位、不写 `moveBlocked`**。
   * 画布据此决定要不要画落位终点：走不通时只留路径线（用户 2026-11-18）。
   */
  function previewDraggedPath(path: readonly HexRef[]): { ok: boolean } {
    const normalized = normalizeDraggedPath(path)
    if (!normalized.ok || normalized.full.length < 2) return { ok: false }
    const simulation = moveInteraction.value ?? movePickPreviewInteraction.value
    if (simulation === null) return { ok: false }
    return { ok: simulateMovePath(simulation, moveRuntime.value, normalized.full).ok }
  }

  /**
   * 2026-11-18：**拖拽落子**——沿玩家实际拖过的路径逐步判通行，全部合法才走。
   *
   * 与点目标格共用同一套引擎判据（`planStep`／`commitStep`）：先按路径逐段预演
   * （`planStep` 不写盘面），任一段不可进入就整次不动并报「无法通行」＋引擎给的原因；
   * 全部通过后逐段提交，MP 与账本按 **实际走过的格** 记账，撤销仍逐步回退。
   *
   * `path` 含起点（画布已按六角直线补全成相邻格序列）。
   */
  function moveAlongDraggedPath(path: readonly HexRef[]): boolean {
    // 规范化：起点开头、去重、拒绝不相邻的段（画布已补全；这里只守引擎输入形状）
    const normalized = normalizeDraggedPath(path)
    if (!normalized.ok) {
      moveBlocked.value = { rule: normalized.rule, reason: `无法通行：${normalized.reason}` }
      pushLog('warning', moveBlocked.value.reason, normalized.rule)
      return false
    }
    const full = normalized.full
    if (full.length < 2) return false
    const simulation = moveInteraction.value ?? movePickPreviewInteraction.value
    if (simulation === null) return false
    const dry = simulateMovePath(simulation, moveRuntime.value, full)
    if (!dry.ok) {
      moveBlocked.value = { rule: dry.rule, reason: `无法通行：${dry.reason}` }
      pushLog('warning', `无法通行：${dry.reason}（${dry.rule}）`, dry.rule)
      return false
    }
    if (moveInteraction.value === null && !ports.confirmMovePick()) return false
    advanceAlongPath(full)
    return true
  }

  /** 拖拽路径的**纯预演**：按当前引擎判据逐段算一遍，不写盘面 */
  function simulateMovePath(
    interaction: MoveInteractionState,
    runtime: readonly MoveUnitRuntime[],
    path: readonly HexRef[],
  ): { ok: true } | { ok: false; rule: string; reason: string } {
    let simulated = interaction
    const simulatedRuntime = runtime.map((item) => ({ ...item, hex: { ...item.hex } }))
    for (let index = 1; index < path.length; index += 1) {
      const to = path[index]!
      /*
       * 用户 2026-11-18：中文原因要用**引擎的原始 StepFailure**（`reason` 是内部码）。
       * `planStep` 的失败会把代码和 detail 拼成一条字符串（如 `enemyOccupied（14.9）`），
       * 拿它反过来查表就查不到 ⇒ 先问一次纯预览，拿到原始代码再翻译。
       */
      const preview = previewStep({
        context: moveContext.value,
        interaction: simulated,
        runtime: simulatedRuntime,
        to,
        path: path.slice(0, index + 1),
      })
      if (!preview.ok) {
        const blocked = preview.blocked
        if (blocked === undefined) {
          return { ok: false, rule: '6.1', reason: '本次移动已经结束' }
        }
        const note = moveFailureNote(blocked)
        return { ok: false, rule: blocked.rule, reason: `${to.col}.${to.row}：${note.text}` }
      }
      const result = planStep({
        context: moveContext.value,
        interaction: simulated,
        runtime: simulatedRuntime,
        to,
        path: path.slice(0, index + 1),
      })
      if (!result.ok) {
        return { ok: false, rule: result.rule, reason: `该步不可进入（${result.rule}）` }
      }
      for (const patch of result.data.patches) {
        const at = simulatedRuntime.findIndex((item) => item.unitId === patch.unitId)
        if (at >= 0) simulatedRuntime[at] = { ...patch, hex: { ...patch.hex } }
      }
      simulated = result.data.interaction
      // 中途已被迫收束（进 ZOC 停车 / 最小移动 / 战略模式）⇒ 路径后段走不了
      if (index < path.length - 1) {
        const stillActive = simulated.unitIds.some((id) => {
          const item = simulatedRuntime.find((entry) => entry.unitId === id)
          return item !== undefined && !item.ended
        })
        if (!stillActive) {
          return {
            ok: false,
            rule: '4.5a-A',
            reason: `${to.col}.${to.row} 之后必须停止：进入敌方 ZOC 必须停（4.5a-A）`,
          }
        }
      }
    }
    return { ok: true }
  }

  /** C5：点击某格走动（移动交互入口） */
  function tryMoveTo(hex: HexRef): void {
    const interaction = moveInteraction.value
    if (interaction === null) return
    // 9.2 / 10.0：战斗或轰炸正在结算 ⇒ 这一步也不许走（第六批 BUG ②）
    if (refuseWhileSettling('继续移动')) return
    const node = reachableNodeAt(groupReachable.value.hexes, hex)
    if (node === null) {
      // 不在可到达范围内：给出引擎对该单步的判定，说明为什么不能走
      const probe = previewStep({
        context: moveContext.value,
        interaction,
        runtime: moveRuntime.value,
        to: hex,
      })
      const blocked = probe.blocked
      const blockedInfo =
        blocked === undefined
          ? { rule: '6.1', reason: '该格不在本次移动的可到达范围内' }
          : {
              rule: blocked.rule,
              // 用户 2026-11-18：界面只写中文原因，引擎内部码不外泄
              reason: `走不进 ${hex.col}.${hex.row}：${moveFailureNote(blocked).text}`,
            }
      moveBlocked.value = blockedInfo
      pushLog(
        'warning',
        `不能走到 ${hex.col}.${hex.row}：${blockedInfo.reason}（${blockedInfo.rule}）`,
        blockedInfo.rule,
      )
      return
    }
    advanceAlongPath(node.path)
  }

  /**
   * C5：撤销上一步（还原该步提交前的运行态快照）
   *
   * 13.2f：装卸也是「一步」——发生在最后一个移动步之后时先退它（面板按钮与快捷键同一条路）。
   */
  function undoLastStep(): boolean {
    if (moveUndoSealReasonNow() !== null || moveInteraction.value?.finished === true) {
      groundMovement.undoLastStep() // 走引擎的统一拒绝并给出原因
      return false
    }
    if (undoTransportHandlingNow()) return true
    const unitIds = moveInteraction.value?.unitIds ?? []
    const ok = groundMovement.undoLastStep()
    if (ok) {
      // 用户 2026-11-20：族内按钮直接撤销后销掉统一账上的同一笔
      dropUndoOf('move.step')
      syncGroundEntries(unitIds)
    }
    return ok
  }

  /** C5：取消整次移动（回到开始移动之前；本段装卸与移动同账一起回退） */
  function cancelWholeMove(): void {
    const unitIds = moveInteraction.value?.unitIds ?? []
    if (!groundMovement.cancelWholeMove()) return
    revertTransportHandlingSinceBaseline()
    dropUndoFamilies(['move.step', 'transport'])
    syncGroundEntries(unitIds)
  }

  /**
   * B15a：**放弃本次移动并退出移动态**（地图会话框的「取消」＝ `Esc`，方案 §4.3）
   *
   * 与 `cancelWholeMove` 的区别：那个**只把盘面还原**（单位仍处于"已选中、可继续走"的移动态，
   * 引擎验证页的按钮就是它）；本动作在还原之后**再清掉本次交互** ⇒ 地图上的移动会话随之收起。
   * 两者都落到同一份 `revertInteraction`（唯一实现），不存在两套"还原"。
   */
  function abortMoveNow(): boolean {
    if (moveInteraction.value === null) return false
    cancelWholeMove()
    if (moveBlocked.value !== null) return false
    clearMoveInteraction()
    return true
  }

  /**
   * C5：结束当前单位/堆叠的移动（6.1 末句；仍可撤销）
   *
   * ★ 用户 2026-11-10 实机 #15：**「结束移动」＝完成**。修前这里把主动停车的运输点数自动记成
   *   13.2a 的「暂停」⇒ 别的单位永远被拦（"运输点数没有移动完"），且已结束的点数还能再「开始移动」。
   *   13.2a 的暂停是**可选动作**（「运输点数可以移动、暂停移动并使用它装载的部分补给、然后继续移动」），
   *   只由 `pauseTransportMove` 触发；这里不再代替玩家做这个决定。
   */
  function finishMove(): void {
    concludeMove(false)
  }

  /** 13.2a：显式「暂停移动」——只有本次移动里有运输点数时才有意义（其它单位按结束移动处理） */
  function pauseTransportMove(): boolean {
    const interaction = moveInteraction.value
    if (interaction === null || interaction.finished) {
      pushLog('warning', '当前没有正在进行的移动（6.1）', '6.1')
      return false
    }
    const hasTransport = moveUnits.value.some(
      (unit) =>
        !unit.movementEnded &&
        !unit.isCombat &&
        unit.noncombatTransport > 0 &&
        unit.noncombatKind !== 'organic_truck',
    )
    if (!hasTransport) {
      pushLog('warning', '本次移动里没有可暂停的运输点数（13.2a）', '13.2a')
      return false
    }
    return concludeMove(true)
  }

  /** 结束/暂停的共用实现（`pauseTransports` 只决定是否记 13.2a 的暂停账） */
  function concludeMove(pauseTransports: boolean): boolean {
    if (moveInteraction.value === null) return false
    /*
     * 8.1a：突袭的 3 MP 是在 9.2 推进步记账的 ⇒ 战斗未收束就结束移动会让这笔账无处落盘。
     *
     * ★ 批 A 切片 1（2026-09-18 修）：这里原先**只记一行日志就 return** —— 玩家点「结束移动 / 收束」
     *   在界面上看起来**毫无反应**（会话框挡住日志时更是如此）。现在按**事实**分两路：
     *   · 战斗已结束或已放弃（`combatState` 为 null 或 `finished`）⇒ 托管信息本就该清 ⇒
     *     先 `settleOverrunMove` 就地收束，再照常结束移动（并顺带维持不变量：
     *     `overrunContext !== null ⇒ 战斗仍在进行`）；
     *   · 战斗仍在进行 ⇒ **可见地**拒绝：写 `moveBlocked`（对局台的状态条会显示它）+ 日志，
     *     并明确给出两条出路。
     */
    if (overrunContext.value !== null) {
      const combat = combatState.value
      if (combat === null || combat.finished) {
        settleOverrunMove(combatDefendingHexCleared.value)
      } else {
        const reason =
          '本场突袭尚未收束（8.0）：请先走完 9.2 流程的推进步，或点「放弃本场战斗 / 突袭」后再结束移动；' +
          '否则 8.1a 的 3 MP 与 8.0 的进格都无法记账'
        moveBlocked.value = { rule: '8.1a', reason }
        pushLog('warning', reason, '8.1a')
        return false
      }
    }
    // 收束可能已经把本次移动就近结束（参突者全灭那一路）⇒ 重新读取，避免二次落盘
    const interaction = moveInteraction.value
    if (interaction === null || interaction.finished) return false
    if (!groundMovement.mayMutate()) return false
    // 走到这里说明本步能落地 ⇒ 清掉上一次的拒绝原因（moveBlocked 是当前这一步被拒的显示位）
    moveBlocked.value = null
    /*
     * 5.7g（用户 2026-11-01 口径）兜底：预备（未释放）单位不得停在环形工事格。
     * 正常路径下可停列表已排除工事格；但若中转途中因工事格触发 ZOC 确认 / 设施夺取而暂停，
     * 玩家可能在工事格里点「结束移动」——此处拦截，要求先走出工事格再结束。
     */
    const reserveStuckInHedgehog = moveUnits.value
      .filter((unit) => !unit.movementEnded)
      .some((unit) => unit.mode.mode === 'reserve' && hedgehogLevelOf(unit.hex) > 0)
    if (reserveStuckInHedgehog) {
      moveBlocked.value = {
        rule: '5.7g',
        reason: '预备模式的单位不得停在环形工事格（5.7g）：请先走出工事格再结束移动',
      }
      pushLog('warning', moveBlocked.value.reason, '5.7g')
      return false
    }
    const names = moveUnits.value.map((unit) => unit.name).join(' + ')
    /*
     * 13.2a：只有**显式暂停**才记这笔账（3.3b 的运输点数＝非战斗、带运力点数的算子；
     * 编内卡车（13.2g）虽 `isCombat:false`，但不是独立运输点数，必须排除）。
     * 记账必须在 `applyMovePatches` 之前 —— 补丁会把它们的 `movementEnded` 置真，
     * 之后就分不出"本来就停下的"与"这次停的"。
     */
    const pausedIds = pauseTransports
      ? moveUnits.value
          .filter(
            (unit) =>
              !unit.movementEnded &&
              !unit.isCombat &&
              unit.noncombatTransport > 0 &&
              unit.noncombatKind !== 'organic_truck', // 13.2g：编内卡车不是「3.3b 运输点数」
          )
          .map((unit) => unit.instanceId)
      : []
    const result = endMoveEarly({ interaction, runtime: moveRuntime.value })
    applyMovePatches(result.patches)
    moveInteraction.value = result.interaction
    /*
     * 4.5a-A：玩家主动「结束移动」＝选了原文的两个分支中的**前者**（就地结束移动）
     * ⇒ 停车账本随之作废，这些单位此后不再出现在突袭候选里（否则界面会一直挂紫环）。
     */
    zocStoppedMoveUnitIds.value = []
    // 13.2a：显式暂停的运输点数＝「暂停」——同一阶段内可继续（其它单位开拔须等它完成）
    if (pausedIds.length > 0) {
      pausedTransportIds.value = [...new Set([...pausedTransportIds.value, ...pausedIds])]
      pushLog('info', `${names}：运输点数暂停移动（可用其装载的 SP 付款后再继续，13.2a）`, '13.2a')
    }
    /*
     * E2（用户 2026-11-17 实走）：**结束不是一步**。`endMoveEarly` 返回的是 `kind: 'end'`
     * 的原地记录（`from === to`、`movedIds` 为空），当成「上一步结论」会渲染成
     * `某格 → 同一格｜`（无单位、无 MP）的伪步成功行 ⇒ 这里只接受真正的移动步；
     * 结束态由面板的中性提示（「已结束本次移动」）表达。
     */
    if (result.record !== null && result.record.kind !== 'end')
      lastStep.value = snapshotOf(result.record)
    else lastStep.value = null
    pushLog('info', `结束移动：${names}`, '6.1')
    // ⑭ 接线：结束本次移动（6.1 末句）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'move',
      rule: '6.1',
      data: {
        stage: 'endMove',
        unitIds: moveUnits.value.map((unit) => unit.instanceId),
      },
    })
    /*
     * 用户 2026-11-18：**结束移动＝提交**。
     * 结束之后关窗、再点撤销都不得回滚位置/MP；本段装卸账同时封存（SP 也不退）。
     */
    sealTransportHandlingForCommit()
    // H7：不自动收窗 —— 留成"点下一支己方堆叠"
    moveLinger.value = true
    return true
  }

  /**
   * 用户 2026-11-18：关掉**已结束**的移动窗 —— 只收会话，不动盘面
   *
   * 修前 `map-view` 的 × / Esc 在 `moveInteraction` 非空时一律走 `abortMoveNow`，
   * 于是「结束移动」后再关窗会把位置与 MP 整笔退回（等于免费重走）。
   */
  function dismissFinishedMoveNow(): boolean {
    if (moveInteraction.value === null || moveInteraction.value.finished !== true) return false
    clearMoveInteraction()
    return true
  }

  /** H7：收掉"移动工具就绪"的滞留状态（点 × / Esc） */
  function dismissMoveLinger(): void {
    moveLinger.value = false
  }

  /** C5：悬停格（路径与消耗预览） */
  function setHoverHex(hex: HexRef | null): void {
    hoverHex.value = hex
  }

  /**
   * 6.1f：把某一枚从**正在移动的堆叠**里「放下」（就地停住，其余继续走）
   *
   * 规则依据：6.1f「离开堆叠即不得再移动」——移动中的堆叠本就允许「走不动的留下、其余继续」
   * （`planStep` 的 `droppedIds` 就是这条），本函数是玩家**主动**的那一版：走到半路把某几枚留在当前格。
   *
   * 实现只做一件事：把该单位的 `movementEnded` 置真。引擎侧无需新规则——
   * `reachableForMove` 的 `activeUnitIds` 本就按 `ended` 过滤，故它自动退出后续移动与突袭资格。
   */
  function dropUnitFromMove(instanceId: string): boolean {
    if (!groundMovement.mayMutate()) return false
    const interaction = moveInteraction.value
    if (interaction === null) {
      pushLog('warning', '当前没有正在进行的移动（6.1）')
      return false
    }
    if (!interaction.unitIds.includes(instanceId)) {
      pushLog('warning', '该单位不在本次移动中')
      return false
    }
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return false
    if (unit.movementEnded) {
      pushLog('info', `${unit.name} 本次移动已经结束，无需再放下`)
      return false
    }
    unit.movementEnded = true
    pushLog(
      'success',
      `${unit.name} 就地放下（停在 ${hexLabel(unit.hex)}，本次移动结束；其余单位继续走，6.1f）`,
      '6.1f',
    )
    // ⑭ 接线：放下（6.1f）入会话日志（无骰）
    recordSettlement({
      action: 'move',
      rule: '6.1f',
      data: { stage: 'drop', unitId: instanceId, hex: { ...unit.hex } },
    })
    // 全部放完 ⇒ 本次移动就地收束（不必再点「结束移动」）
    if (activeMoveUnits.value.length === 0) finishMove()
    return true
  }

  /** 1.4b：入盒已经落盘，旧移动的撤销不得把盒内单位拖回图上。 */
  function sealEdgeBoxTransferNow(unitId: string): void {
    groundMovement.markIrreversible('边缘盒进出（1.4b）')
    const move = moveInteraction.value
    if (move !== null && move.unitIds.includes(unitId) && activeMoveUnits.value.length === 0) {
      moveInteraction.value = { ...move, finished: true }
    }
  }

  /** C5：选择方式 —— 单个单位 / 整堆叠（6.1） */
  function setStackSelect(on: boolean): void {
    stackSelect.value = on
    pushLog(
      'info',
      on ? '选择方式 → 整堆叠（同格内当前方全部单位一起移动，6.1）' : '选择方式 → 单个单位',
    )
  }

  /**
   * C5：切换主动模式（5.4：只在本方移动阶段、且在该单位开始移动时；切换不消耗 MP）
   *
   * ★ 条 9（M1）：**按选中集合批量**切换——优先作用于「取子清单」（`movePick.ids`，即开始移动前
   *   玩家在地图上勾选的那一组），没有取子清单时退回单枚 `selectedUnit`。这样多选的单位能一次切完，
   *   且 5.4a 的"开始移动前可随意改"才落得到实处。
   * ★ 用户 2026-11-09：新增可选第三形参 `ids`——窗内右键单枚改模式必须显式传 `[该枚]`，
   *   否则会误伤 `movePick` 整组（右键菜单走这条）。
   * 引擎 `canSwitchModeNow` 已支持 reserve/strat（5.7a / 5.8），故 combat/move/reserve/strat 四向都走同一批处理。
   */
  function switchUnitMode(to: BaseMode, orientation?: Orientation, ids?: readonly string[]): void {
    if (!requireAction('move.modeChange', '改模式')) return
    // 批量目标：显式给定 > 取子清单（开始移动前的选中集合）> 单枚选中单位
    const targets =
      ids ??
      (movePick.value !== null
        ? movePick.value.ids
        : selectedUnit.value === null
          ? []
          : [selectedUnit.value.instanceId])
    if (targets.length === 0) {
      pushLog('warning', '先选中要改模式的算子（在地图上勾选，或在移动中的单位里选一枚）')
      return
    }
    let okCount = 0
    for (const id of targets) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit === undefined) continue
      /*
       * 13.5（§5-D）：「补员永远无法进入战斗模式，但可以进入所有其他模式」⇒ 目标若为战斗模式
       * （或战斗面朝向），对补员算子直接拒。移动/战略/预备照常放行（它们都是"其他模式"）。
       */
      if (isReplUnit(unit) && to === 'combat') {
        pushLog('warning', `${unit.name} 是补员算子，不能进入战斗模式（13.5）`, '13.5')
        continue
      }
      // 朝向：战斗/移动面＝模式本身；战略必为移动面（5.8）；预备可任选（5.7a）
      const target: Orientation =
        to === 'combat'
          ? 'combat'
          : to === 'move'
            ? 'move'
            : to === 'strat'
              ? 'move'
              : (orientation ?? unit.mode.orientation)
      const verdict = canSwitchModeNow({
        context: moveContext.value,
        unitId: id,
        runtime: moveRuntime.value,
        to,
        orientation: target,
        unitClass: modeUnitClassOf(unit),
        date: date.value,
        // 专规 4.1a（可选）：忽略 2.3e ⇒ 苏军战略模式的日期闸门不参与判定
        ignoreOperationalLimits: session.rule4On('ignoreOperationalLimits'),
      })
      if (!verdict.ok) {
        pushLog(
          'warning',
          `${unit.name} 不能切换到${MODE_LABELS[to]}：${verdict.reason}（${verdict.rule}）`,
          verdict.rule,
        )
        continue
      }
      /*
       * 5.4a（用户 2026-11-06 裁定）：额度**按格**计，在转入那一刻校验；0 枚＝无预备权。
       * 必须放在 `applyModeSwitch` 之前——被拒时单位仍停在原模式，不留半截状态。
       * 同批同格：先转的那枚已把该格算作"有预备单位"⇒ 后续同格单位不再占新额度（派生判定）。
       */
      if (to === 'reserve' && !canEnterReserveMode(unit)) continue
      // 13.8b 末句例外：切换前记下当时的工程能力，切换后按"由真变假"登记自有桥格
      const wasEngineerCapable = engineerCapableNow(unit)
      unit.mode = applyModeSwitch(unit.mode, to, target)
      noteEngineerCapabilityAfter(unit, wasEngineerCapable)
      // 5.7a：本移动阶段内进入预备 ⇒ 该朝向锁定到下一个移动阶段
      if (to === 'reserve') unit.reserveEnteredThisPhase = true
      // 5.4a：一切数值以朝向那一面为基准 → 换面后刷新印值缓存
      unit.raw = unit.faces[unit.mode.orientation]
      /*
       * 5.7g：「在**任何移动环节结束时**，处于预备模式内的单位都**不可与环形工事堆叠**在一起。」
       *
       * ★ 修（2026-11-01）：修前这条判据只活在引擎的 `modeEffectsFor` 里（`canStackWithHedgehog`），
       *   盘面侧**无人读取** —— 玩家可以让预备单位与工事同格，一路走到环节结束都不被提示。
       *   这里不**拦**（预备单位之后还能走开，5.7 允许预备移动），只在切换那一刻把义务说出来；
       *   判据仍取引擎的 `canStackWithHedgehog`（不另写一份）。
       */
      if (!canStackWithHedgehog(unit.mode) && hedgehogHexState(unit.hex).level > 0)
        pushLog(
          'warning',
          `${unit.name} 进入预备模式但与环形工事同格 ⇒ 本移动环节结束时必须分开（5.7g）`,
          '5.7g',
        )
      okCount += 1
    }
    if (okCount > 0) {
      pushLog(
        'success',
        `已将 ${okCount} 枚切换到${MODE_LABELS[to]}（5.4 切换不消耗 MP；可开始移动前随意改）`,
        '5.4',
      )
    }
    // 条 10（M1）：模式切换不再自动开拔——改由「开始移动」按钮显式触发（与 retryBeginMove 解耦）
  }

  /**
   * 5.4a：该单位此刻**真正**可以切换到的模式（右键「模式改变」子菜单的唯一来源）
   *
   * 与 `switchUnitMode` 同一串判据（补员禁战斗 / 朝向 / 引擎 `canSwitchModeNow` / 预备按格额度），
   * 差别只在**不写日志**、也**不判环节闸门**——菜单投影随时可算，闸门由调用方先用
   * `actionAllowedNow('move.modeChange')` 挡一层。预备额度必须走纯函数 `allowReserveEntryAtHex`：
   * `canEnterReserveMode` 会 `pushLog`，投影里调它会把"看一眼菜单"写成一条警告。
   */
  function switchableModesOf(unitId: string): BaseMode[] {
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined || unit.side !== activeSide.value) return []
    const reachable: BaseMode[] = []
    for (const to of ['combat', 'move', 'reserve', 'strat'] as const) {
      // 当前模式不必列（切到自己没有意义）
      if (unit.mode.mode === to) continue
      // 13.5：补员永远无法进入战斗模式，但可以进入所有其他模式
      if (isReplUnit(unit) && to === 'combat') continue
      // 朝向：战斗/移动面＝模式本身；战略必为移动面（5.8）；预备可任选（5.7a）
      const orientation: Orientation =
        to === 'combat' ? 'combat' : to === 'reserve' ? unit.mode.orientation : 'move'
      const verdict = canSwitchModeNow({
        context: moveContext.value,
        unitId,
        runtime: moveRuntime.value,
        to,
        orientation,
        unitClass: modeUnitClassOf(unit),
        date: date.value,
        // 专规 4.1a（可选）：忽略 2.3e ⇒ 苏军战略模式的日期闸门不参与判定
        ignoreOperationalLimits: session.rule4On('ignoreOperationalLimits'),
      })
      if (!verdict.ok) continue
      if (to === 'reserve') {
        const cap = session.scenarioInfo?.setup.reserveMarkers?.[unit.side] ?? 0
        const outcome = allowReserveEntryAtHex({
          side: unit.side,
          cap,
          hex: hexKeyOf(unit),
          occupiedHexes: reservedHexes(unit.side),
        })
        if (!outcome.ok) continue
      }
      reachable.push(to)
    }
    return reachable
  }

  /** IV-B（4.4）：该单位所在格是否与**敌方攻击力单位**相邻 */
  function adjacentEnemyAttackCapableOf(unit: ConsoleUnit): boolean {
    const enemy: Side = unit.side === 'axis' ? 'soviet' : 'axis'
    return units.value.some(
      (other) =>
        other.side === enemy &&
        areAdjacent(other.hex, unit.hex) &&
        // 4.4：印有战斗值且非括号、且不在预备/战略模式 ⇒ 攻击力单位
        other.attackCapable &&
        other.mode.mode !== 'reserve' &&
        other.mode.mode !== 'strat',
    )
  }

  /** E5：初设模式约束（剧本数据优先；缺省按规格 §2.1：四种主动模式、上限取标记数、不禁预备） */
  const SETUP_MODES_ALL: readonly BaseMode[] = ['combat', 'move', 'reserve', 'strat']
  function setupModeConstraintsOf(side: Side): {
    allowed: readonly BaseMode[]
    reserveCap: number
    reserveForbidden: boolean
  } {
    const setup = session.scenarioInfo?.setup
    const constraints = setup?.modeConstraints
    return {
      allowed: constraints?.allowedSetupModes ?? SETUP_MODES_ALL,
      reserveCap: constraints?.reserveMax?.[side] ?? setup?.reserveMarkers?.[side] ?? 0,
      reserveForbidden: constraints?.reserveSetupForbidden ?? setup?.reserveSetupForbidden === true,
    }
  }

  /**
   * IV-B：初设阶段该单位**此刻可设**的模式（右键「初设模式」菜单的唯一数据源）
   *
   * 与 `setUnitModeAtSetup` 同源判定（`canSetModeAtSetup`）：当前模式不列，其余逐项判；
   * 不可用的不返回（不摆灰项）。非初设阶段恒空 —— 初设结束后右键不再给"初设模式"。
   */
  function setupSwitchableModesOf(unitId: string): BaseMode[] {
    if (!ports.initialSetupInProgress.value) return []
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) return []
    const limits = setupModeConstraintsOf(unit.side)
    const reachable: BaseMode[] = []
    for (const to of ['combat', 'move', 'reserve', 'strat'] as const) {
      if (unit.mode.mode === to) continue
      const target: Orientation =
        to === 'combat' ? 'combat' : to === 'reserve' ? unit.mode.orientation : 'move'
      const verdict = canSetModeAtSetup({
        to,
        orientation: target,
        unitClass: modeUnitClassOf(unit),
        side: unit.side,
        hex: hexKeyOf(unit),
        adjacentEnemyAttackCapable: adjacentEnemyAttackCapableOf(unit),
        reserveCap: limits.reserveCap,
        reserveOccupiedHexes: reservedHexes(unit.side),
        reserveSetupForbidden: limits.reserveForbidden,
        allowedModes: limits.allowed,
        date: date.value,
        // 专规 4.1a（可选）：忽略 2.3e ⇒ 初设也不受苏军战略模式日期闸门约束
        ignoreOperationalLimits: session.rule4On('ignoreOperationalLimits'),
      })
      if (verdict.ok) reachable.push(to)
    }
    return reachable
  }

  /**
   * IV-B：初设右键**一个模式都出不来**时的原因（界面就地给一行，不摆空菜单）
   *
   * 用户 2026-11-18：剧本不允许 / 没有可用预备标记 / 相邻敌方攻击力单位等情况下，
   * 入口按既有口径**不出现**，但要按同一判据说清是哪一条挡住，不能只让玩家觉得"右键没反应"。
   * 判据全在 `canSetModeAtSetup`，本函数只把第一条失败原因折成人话。
   */
  function setupModeBlockNote(unitId: string): { rule: string; text: string } | null {
    if (!ports.initialSetupInProgress.value) return null
    if (setupSwitchableModesOf(unitId).length > 0) return null
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) return null
    const limits = setupModeConstraintsOf(unit.side)
    for (const to of SETUP_MODES_ALL) {
      if (unit.mode.mode === to) continue
      if (!limits.allowed.includes(to))
        return { rule: 'IV-B', text: `本剧本初设不允许${MODE_LABELS[to]}（IV-B）` }
      const target: Orientation =
        to === 'combat' ? 'combat' : to === 'reserve' ? unit.mode.orientation : 'move'
      const verdict = canSetModeAtSetup({
        to,
        orientation: target,
        unitClass: modeUnitClassOf(unit),
        side: unit.side,
        hex: hexKeyOf(unit),
        adjacentEnemyAttackCapable: adjacentEnemyAttackCapableOf(unit),
        reserveCap: limits.reserveCap,
        reserveOccupiedHexes: reservedHexes(unit.side),
        reserveSetupForbidden: limits.reserveForbidden,
        allowedModes: limits.allowed,
        date: date.value,
        ignoreOperationalLimits: session.rule4On('ignoreOperationalLimits'),
      })
      if (!verdict.ok)
        return {
          rule: verdict.rule,
          text: `初设不能设为${MODE_LABELS[to]}：${verdict.reason}（${verdict.rule}）`,
        }
    }
    return { rule: 'IV-B', text: '该单位当前没有可切换的初设模式（IV-B）' }
  }

  /** IV-B：右键没有可用模式时就地写一行原因（与菜单同判据） */
  function noteSetupModeBlocked(unitId: string): void {
    const note = setupModeBlockNote(unitId)
    if (note !== null) pushLog('warning', note.text, note.rule)
  }

  return {
    nameOf,
    unitNameOf,
    applyMovePatches,
    canEnterReserveMode,
    commitStep,
    syncGroundEntries,
    triggerSpecialCombatAfterStep,
    advanceAlongPath,
    normalizeDraggedPath,
    previewDraggedPath,
    moveAlongDraggedPath,
    simulateMovePath,
    tryMoveTo,
    refuseWhileSettling,
    beginMoveFor,
    closeBreakdownWindows,
    setupBreakdownCandidates,
    openBreakdownWindow,
    canCreateBreakdownNow,
    breakdownRecordChoicesFor,
    breakdownAbsorbChoicesFor,
    canAbsorbBreakdownNow,
    retryBeginMove,
    selectForMove,
    settlementInProgress,
    setupWiggleParents,
    setupWiggleOn,
    setupWiggleRemaining,
    breakdownTimingOf,
    // B3-2b2：撤销 / 收束族
    undoLastStep,
    cancelWholeMove,
    abortMoveNow,
    finishMove,
    pauseTransportMove,
    dismissFinishedMoveNow,
    dismissMoveLinger,
    setHoverHex,
    dropUnitFromMove,
    sealEdgeBoxTransferNow,
    // B3-2b3：模式切换 / 初设模式判据
    setStackSelect,
    switchUnitMode,
    switchableModesOf,
    adjacentEnemyAttackCapableOf,
    setupModeConstraintsOf,
    setupSwitchableModesOf,
    setupModeBlockNote,
    noteSetupModeBlocked,
  }
}
