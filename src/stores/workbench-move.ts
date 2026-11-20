/**
 * workbench-move.ts —— C5 地面移动交互域（选子 → 范围 → 逐格 → 结束/撤销；含 20.0a 拆分/4.3 初设摆位）
 *
 * 搬了 **B3-1**：workbench.ts 7527–7969 的 **445 行 / 21 个顶层声明**
 * （15 个 function + 6 个 const：`settlementInProgress` / `breakdownWindows` / `setupWiggleParents` /
 * `setupWiggleOn` / `setupWiggleRemaining` / `breakdownTimingOf`）。
 *
 * 端口 **40 项**（2026-11-21 实测），两种接法：
 *   · 按值解构（37 项）：声明在建域点之前，或是**有提升的函数声明**（声明在 8k–25k 也能按值传）；
 *   · 走 `ports.X`（3 项）：`breakdownPool`(18046) / `initialSetupInProgress`(19481) / `gates`(20698)
 *     —— 声明在建域点之后，facade 用 `get` 访问器传，切片里写 `ports.x.value`（`gates` 是对象，写 `ports.gates`）。
 *     只在求值时读取，避免建 store 时撞 TDZ（§12.3 记录过一次同源事故）。
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
import { canMoveInPhase } from '@/engine/rules/modes'
import type { MoveUnitRuntime } from '@/engine/rules/move-interaction'
import {
  SETUP_WIGGLE_BREAKDOWN_RADIUS,
  SETUP_WIGGLE_MAX_DIVISIONS,
  isSetupWiggleParent,
} from '@/engine/rules/setup-wiggle'

/** C5 移动交互的端口。37 项按值解构、3 项走 ports（见文件头）。 */
export interface MovementDomainPorts {
  /** ── 按值：建域点之前声明的状态/派生 ── */
  NO_MOVEMENT_PHASES: readonly ConsolePhase[]
  session: ReturnType<typeof useGameSessionStore>
  activeSide: ComputedRef<Side>
  phase: ComputedRef<ConsolePhase>
  segmentLocked: ComputedRef<boolean>
  units: Ref<ConsoleUnit[]>
  selectedId: Ref<string | null>
  lastStep: Ref<MoveStepSnapshot | null>
  groundMovement: ReturnType<typeof createGroundMovementDomain>
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
  airUnitTransit: ReturnType<typeof createAirDomain>['airUnitTransit']
  selectedUnit: ComputedRef<ConsoleUnit | null>
  choices: ComputedRef<UnitRecordView[]>
  moveUnits: ComputedRef<ConsoleUnit[]>
  PHASE_LABELS: Record<ConsolePhase, string>
  /** ── 按值：函数声明（可提升，声明在 8k–25k 也能按值传） ── */
  refuseWhileLocked: (action: string) => boolean
  noteUnitLeftOwnBridgeHex: (unit: ConsoleUnit) => void
  unitOfInstance: (instanceId: string) => ConsoleUnit | undefined
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  unitsAt: (hex: HexRef) => ConsoleUnit[]
  friendlyUnitsAt: (hex: HexRef) => ConsoleUnit[]
  movePickPoolAt: (hex: HexRef) => ConsoleUnit[]
  defaultMovePickIdsAt: (hex: HexRef) => string[]
  applyFormationFuelCoverageToIds: (ids: readonly string[]) => void
  actionAllowedNow: (key: ActionKey) => boolean
  requireAction: (key: ActionKey, action: string) => boolean
  noteUnitEnteredHex: (unit: ConsoleUnit, hex: HexRef) => void
  nationalityOfUnit: (unit: ConsoleUnit) => string
  /** ── 以下 3 项晚绑定（声明在 18046 / 19481 / 20698，晚于建域点） ── */
  breakdownPool: Ref<Record<string, number>>
  initialSetupInProgress: Ref<boolean>
  gates: WorkbenchGates
}

export function createMovementDomain(ports: MovementDomainPorts) {
  const {
    NO_MOVEMENT_PHASES,
    session,
    activeSide,
    phase,
    segmentLocked,
    units,
    selectedId,
    lastStep,
    groundMovement,
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
    airUnitTransit,
    selectedUnit,
    choices,
    moveUnits,
    PHASE_LABELS,
    refuseWhileLocked,
    noteUnitLeftOwnBridgeHex,
    unitOfInstance,
    pushLog,
    unitsAt,
    friendlyUnitsAt,
    movePickPoolAt,
    defaultMovePickIdsAt,
    applyFormationFuelCoverageToIds,
    actionAllowedNow,
    requireAction,
    noteUnitEnteredHex,
    nationalityOfUnit,
  } = ports

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
  return {
    nameOf,
    unitNameOf,
    applyMovePatches,
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
  }
}
