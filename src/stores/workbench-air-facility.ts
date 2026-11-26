/**
 * workbench-air-facility.ts —— 15.3 / 15.4 空军基地 与 15.2A 简易机场的盘面事实与四个动作
 *
 * B3-2b17（2026-11-21）：从 facade 的 C8g 段搬出 15 个声明 / 294 行（两段不连续，中间隔着
 * `canEngineerInPhase`）：`airBaseTurnLedger` / `airUnloadLedger` / `airUnloadedTAt` /
 * `engineerChoices` / `airBaseUnitAt` / `isAirstripAt` / `airBaseLevelAt` / `hexHasAirFacility` /
 * `airBaseBuildCostSpPerLevel` / `airBaseRecordFor` / `pickedEngineer` / `placeAirBaseOperator` /
 * `buildAirBaseNow` / `buildAirstripNow` / `upgradeAirstripNow`。
 * 除下面两处"晚绑定 getter"的取值写法外，函数体**零改写**。
 *
 * ## 为什么装配点必须早于 air 建域
 *   `createAirDomain` 的 `airUnloadedTAt` 是**按值** deps（建域即求值），故本域必须先建好。
 *
 * ## `canEngineerInPhase` 为什么留在 facade
 *   它读 `moveContext`（facade 的 computed，晚于本装配点），且作为 store 公开键被直接返回。
 *
 * ## 两个晚声明 getter（`airstripBaseIds` / `airBases`）
 *   二者来自 air 域解构（facade 的 `} = airDomain` 段），晚于本装配点 ⇒ deps 给 getter，
 *   本切片**不解构**它们、一律写 `deps.xxx`，于是求值推迟到调用期（无 TDZ）。
 *
 * ## 端口（32 项 = 19 依赖 + 13 返回）
 *   `airBaseRecordFor` 只被本切片内部调用（`placeAirBaseOperator`），故不 return。
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'

import {
  CONSTRUCTION_RADIUS_HEXES,
  SP_TO_T,
  airBaseBuildCostSp,
  holdingsToT,
  planAirBaseBuild,
  planAirstripBuild,
  planAirstripUpgrade,
  type AirBaseView,
  type ConstructionExecutor,
  type ConstructionTask,
} from '@/engine/rules'
import { ruleErrorTextOf } from '@/engine/rules/rule-error-text'
import { sameHex } from '@/engine/hex-geometry'
import type { Derivation } from '@/engine/derivation'
import type { RuleFailure } from '@/engine/result-types'
import { createId } from '@/shared'
import { mapLayers, type HexRef, type Side } from '@/data'
import {
  hexLabel,
  parseHexPath,
  toConsoleUnit,
  unitChoices,
  type ActionKey,
  type ConsoleUnit,
  type UnitRecordView,
  type WorkbenchLogEntry,
} from './workbench-model'
import type { SpDump } from './supply-types'

/** C8g 空中设施域的端口（31 项 = 18 依赖 + 13 返回，2026-11-21 实测）。 */
export interface AirFacilityDeps {
  activeSide: ComputedRef<Side>
  units: Ref<ConsoleUnit[]>
  /**
   * 12.1b：按施工工程兵**可达**的付款站取站
   *
   * ★ 13.2g-A/B：编内卡车装的 SP 也是补给站，但只许同一多单位编队内的单位取用；
   *   不能只按 id 取 `spDumps`：窗内换工程兵后旧付款站可能已不可达（12.3a/12.3b），
   *   预检与落盘都要以这一份为准，避免把旧站的 SP 付给新施工者。
   */
  constructionPayDumpFor: (engineer: ConsoleUnit | null) => SpDump | null
  constructionInputs: Ref<{ hexText: string; engineerId: string | null; payDumpId: string | null }>
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  requireAction: (key: ActionKey, action: string) => boolean
  captureUndoSnapshot: (label: string) => number | null
  dropUndoBySeq: (seq: number) => void
  isConstructionMarkerAirBaseId: (id: string) => boolean
  /** 专规 3.5：已放置的建造标记（晚绑定，升格标记简易机场后撤掉那一枚） */
  constructionMarkerPieces: () => Ref<{ id: string; kind: 'bridge' | 'airStrip'; hex: HexRef }[]>
  /** 留在 facade（读 `moveContext`，见文件头） */
  canEngineerInPhase: (unit: ConsoleUnit) => boolean
  /** 13.8d 施工域（b16 切片）的共享状态与入口 */
  constructionError: Ref<{ rule: string; reason: string } | null>
  constructionFeeT: (task: ConstructionTask, costSp: number, costT: number) => number
  constructionGateNow: (task: ConstructionTask, engineer: ConsoleUnit | null) => RuleFailure | null
  noteConstruction: (task: ConstructionTask, hex: HexRef, engineerId: string | null) => void
  engineerExecutorFor: (
    engineer: ConsoleUnit | null,
    target: HexRef,
  ) => Extract<ConstructionExecutor, { kind: 'engineer' }>
  payConstructionFee: (dumpId: string | null, wantT: number, rule: string) => boolean
  /** air 域解构，晚于装配点 ⇒ getter，本切片不解构 */
  get airstripBaseIds(): Ref<string[]>
  get airBases(): ComputedRef<AirBaseView[]>
}

export function createAirFacilityDomain(deps: AirFacilityDeps) {
  const {
    activeSide,
    units,
    constructionPayDumpFor,
    constructionInputs,
    pushLog,
    requireAction,
    captureUndoSnapshot,
    dropUndoBySeq,
    isConstructionMarkerAirBaseId,
    constructionMarkerPieces,
    canEngineerInPhase,
    constructionError,
    constructionFeeT,
    constructionGateNow,
    noteConstruction,
    engineerExecutorFor,
    payConstructionFee,
  } = deps

  /**
   * 15.3：**空军基地**每格每回合的已提升级数（15.3「等级每回合只能提升一级」）
   *
   * 与 16.0b/c 的 `hedgehogTurnLedger` 同构：按格按回合记账，换回合即清零。
   */
  const airBaseTurnLedger = ref<Record<string, number>>({})

  /**
   * 14.9f / 15.0b-C / 15.2C：本**移动环节**各格**已空运卸载**的 T
   *
   * 「同一个空军基地在每个移动环节中，只能使用**空运**卸载 2T 乘上其**基地等级**的货物量。」
   * 键＝`${side}:${列}.${行}`（基地会换手，故按归属分开记）；换环节/换阶段即清零
   * （`resetSegmentTransient`），与 `refitDoneBaseIds` 同生命周期。
   */
  const airUnloadLedger = ref<Record<string, number>>({})

  /** 14.9f：本格本环节**已**空运卸载的 T（该格此刻无记录即 0） */
  function airUnloadedTAt(hex: HexRef, side: Side): number {
    return airUnloadLedger.value[`${side}:${hexLabel(hex)}`] ?? 0
  }

  /** 13.8d：本阶段可派去施工的本方工程单位（模式门槛走 `checkLegality`，不另写判据） */
  const engineerChoices = computed<ConsoleUnit[]>(() =>
    units.value.filter((unit) => unit.side === activeSide.value && canEngineerInPhase(unit)),
  )

  /** 该格上的空中设施算子（4.8：每格至多 1 个空军基地/简易机场） */
  function airBaseUnitAt(hex: HexRef): ConsoleUnit | undefined {
    return units.value.find((unit) => unit.noncombatKind === 'air_base' && sameHex(unit.hex, hex))
  }

  /** 15.2F：该格是否为**简易机场**（口径同 `airBases`：被声明者等级记 0） */
  function isAirstripAt(hex: HexRef): boolean {
    const base = airBaseUnitAt(hex)
    return base !== undefined && deps.airstripBaseIds.value.includes(base.instanceId)
  }

  /** 15.3：该格当前**空军基地**等级（0 ＝ 尚无基地，或该格是简易机场） */
  function airBaseLevelAt(hex: HexRef): number {
    const base = airBaseUnitAt(hex)
    if (base === undefined) return 0
    return deps.airstripBaseIds.value.includes(base.instanceId) ? 0 : base.noncombatLevel
  }

  /** 4.8 / 15.0a：该格是否已有空中设施（空军基地或简易机场 ⇒ 不可再建） */
  function hexHasAirFacility(hex: HexRef): boolean {
    return airBaseUnitAt(hex) !== undefined
  }

  /**
   * 15.3 / 15.2A 目标格的两类**入口预检**缺口
   *
   *   · 专规 3.5 的**建造标记简易机场**不在 `airBaseUnitAt`（它不是算子）里，
   *     修前 `isAirstripAt` / `hexHasAirFacility` 都看不见它 ⇒ 15.3 / 15.2A 会在同一格再建一座；
   *   · 敌方空军基地虽在 `airBaseUnitAt` 里，但 `planAirBaseBuild` 只按等级判，
   *     修前把「改进敌方基地」当成合法落盘，随后 `placeAirBaseOperator` 直接把敌方算子换成本方。
   *
   * 这里把两种目标格事实收成一处，窗口预检与三个落盘动作共用，避免「窗口能点、落盘另一套」。
   */
  function airFacilityTargetIssue(hex: HexRef): { rule: string; reason: string } | null {
    const marker = deps.airBases.value.find(
      (base) => sameHex(base.hex, hex) && isConstructionMarkerAirBaseId(base.id),
    )
    if (marker !== undefined) {
      return { rule: '15.0a / 专规 3.5', reason: 'airBaseTargetIsMarkerAirstrip' }
    }
    const existing = airBaseUnitAt(hex)
    if (existing !== undefined && existing.side !== activeSide.value) {
      return { rule: '9.14f', reason: 'airBaseTargetIsEnemy' }
    }
    return null
  }

  /**
   * 15.3：**加一级**空军基地的 SP 费用（供界面预显；引擎口径）
   *
   * 「费用为 1SP」「等级每回合只能提升一级」⇒ 单次施工恒为一级的价钱，故直接取 1 级的费用。
   */
  const airBaseBuildCostSpPerLevel = airBaseBuildCostSp(1)

  /** 15.0c：该等级的空军基地算子记录（1–3 级各一枚中立算子） */
  function airBaseRecordFor(level: number): UnitRecordView | null {
    return (
      unitChoices(activeSide.value).find(
        (record) => record.noncombatKind === 'air_base' && record.noncombatDetails?.level === level,
      ) ?? null
    )
  }

  /** 13.8d：指定的施工工程单位（未指定或找不到 ⇒ null） */
  function pickedEngineer(): ConsoleUnit | null {
    const id = constructionInputs.value.engineerId
    if (id === null) return null
    return units.value.find((unit) => unit.instanceId === id) ?? null
  }

  /**
   * 2026-11-26（用户口径「右键菜单一个操作一个窗口」）：本窗只做**一件事**
   *
   * 15.3（空军基地 +1 级，1 SP）与 15.2A 的「修简易机场 1 T」「升格 3 T」是三个菜单项、三个窗口；
   * `only='airstrip'` 面板按本字段只画对应的一段。
   */
  const airConstructionTask = ref<'baseBuild' | 'airstripBuild' | 'airstripUpgrade'>('baseBuild')

  /** 目标格（未填或格式错 ⇒ null）：15.3 / 15.2A 的修建共用同一输入 */
  const constructionTargetHex = computed<HexRef | null>(
    () => parseHexPath(constructionInputs.value.hexText)[0] ?? null,
  )

  /** 施工错误的中文行（与炮击 / 战斗共用 `ruleErrorTextOf`） */
  const constructionErrorLine = computed<string | null>(() =>
    constructionError.value === null ? null : ruleErrorTextOf(constructionError.value),
  )

  /** 开 15.3 / 15.2A 窗口时统一清预填：任务、工程兵、目标格、付款站、错误 */
  function prepareAirConstructionWindowNow(
    task: 'baseBuild' | 'airstripBuild' | 'airstripUpgrade',
    engineerId: string | null,
  ): void {
    airConstructionTask.value = task
    constructionInputs.value = { hexText: '', engineerId, payDumpId: null }
    constructionError.value = null
  }

  /**
   * 15.3 / 15.2A 主按钮的预检：与 `buildAirBaseNow` / `buildAirstripNow` / `upgradeAirstripNow`
   * 使用同一组引擎判据（13.8d 闸门 → 引擎 plan → 付款/目标格事实），只把失败翻成「还差」文案。
   *
   * 返回 null ＝ 主按钮可以出现。只读，不落盘、不写账本。
   */
  const airConstructionMissing = computed<
    (task: 'baseBuild' | 'airstripBuild' | 'airstripUpgrade', baseId?: string) => string | null
  >(() => (task, baseId) => {
    const upgradeBase =
      task === 'airstripUpgrade'
        ? (deps.airBases.value.find((base) => base.id === baseId) ?? null)
        : null
    const upgradeIsMarker =
      task === 'airstripUpgrade' && baseId !== undefined && isConstructionMarkerAirBaseId(baseId)
    const hex =
      task === 'airstripUpgrade' ? (upgradeBase?.hex ?? null) : constructionTargetHex.value
    if (hex === null) return '还差：点地图选目标格（15.2A / 15.3）'
    if (task === 'airstripUpgrade' && upgradeBase === null) return '还差：找不到该空中设施（15.2A）'
    if (task === 'airstripUpgrade' && upgradeBase !== null && upgradeBase.side !== activeSide.value)
      return '还差：只能升格本方简易机场（9.14f）'
    /*
     * 15.3 / 15.2A：目标格若已是**敌方空中设施**，或已有**建造标记的简易机场**，先由
     * `airFacilityTargetIssue` 拦下；否则 15.3 会把敌方基地当成本方基地“改进”，
     * 15.2A 也会在标记格上再摆一座设施。
     */
    const targetIssue = airFacilityTargetIssue(hex)
    if (
      targetIssue !== null &&
      !(
        task === 'airstripUpgrade' &&
        upgradeIsMarker &&
        targetIssue.reason === 'airBaseTargetIsMarkerAirstrip'
      )
    )
      return `还差：${ruleErrorTextOf(targetIssue)}（${targetIssue.rule}）`
    const engineer = pickedEngineer()
    if (engineer === null) return '还差：选施工工程兵（13.8d）'
    const gate = constructionGateNow(
      task === 'baseBuild'
        ? 'buildAirBase'
        : task === 'airstripBuild'
          ? 'buildAirstrip'
          : 'upgradeAirstrip',
      engineer,
    )
    if (gate !== null) return `还差：${ruleErrorTextOf(gate)}（${gate.rule}）`
    const payDump = constructionPayDumpFor(engineer)
    if (payDump === null) {
      return constructionInputs.value.payDumpId === null
        ? task === 'baseBuild'
          ? '还差：付款补给站（15.3：1 SP/级）'
          : '还差：付款补给站（15.2A：1 T / 升格 3 T）'
        : '还差：付款站不在施工者可达范围（12.3a/12.3b）'
    }
    const availableT = holdingsToT({ sp: payDump.sp, t: payDump.t })
    const executor = engineerExecutorFor(engineer, hex)
    if (task === 'baseBuild') {
      if (isAirstripAt(hex))
        return '还差：该格是简易机场，升格须走 15.2A 的 3 T（不适用 15.3 的 1 SP）'
      const outcome = planAirBaseBuild({
        executor,
        currentLevel: airBaseLevelAt(hex),
        levelsBuiltThisTurn: airBaseTurnLedger.value[hexLabel(hex)] ?? 0,
        availableSp: availableT / SP_TO_T,
      })
      return outcome.ok ? null : `还差：${ruleErrorTextOf(outcome)}（${outcome.rule}）`
    }
    if (task === 'airstripBuild') {
      const outcome = planAirstripBuild({
        executor,
        hexHasAirFacility: hexHasAirFacility(hex),
        availableT,
      })
      return outcome.ok ? null : `还差：${ruleErrorTextOf(outcome)}（${outcome.rule}）`
    }
    const outcome = planAirstripUpgrade({
      executor,
      hexHasAirstrip: isAirstripAt(hex) || upgradeIsMarker,
      availableT,
    })
    return outcome.ok ? null : `还差：${ruleErrorTextOf(outcome)}（${outcome.rule}）`
  })

  /**
   * 15.3 / 15.2A：**当前施工者**在这一刻能施工的**格全集**（地图高亮用）
   *
   * 用户 2026-11-26：「右键单位使用工程能力时不应该把工程能力的单位全列出来，因为玩家已经选好单位了，
   * 此时应该高亮可进行工程的格子，玩家点击格子就到支付补给。」
   *
   * 判据与三条落盘动作**同源**：13.8d 的公共闸门只判一次（未移动 / 一单位一格一任务 / 阶段），
   * 逐格再用同一引擎 `plan*` 判目标格本身（`availableSp/T` 先按无穷大放开，付款仍留到点格之后）。
   * 因此这里只回答"哪些格值得点"，不替玩家选付款站、也不落盘。
   */
  const airConstructionCandidateHexes = computed<
    (task: 'baseBuild' | 'airstripBuild' | 'airstripUpgrade') => HexRef[]
  >(() => (task) => {
    const engineer = pickedEngineer()
    if (engineer === null) return []
    const gate = constructionGateNow(
      task === 'baseBuild'
        ? 'buildAirBase'
        : task === 'airstripBuild'
          ? 'buildAirstrip'
          : 'upgradeAirstrip',
      engineer,
    )
    if (gate !== null) return []
    /*
     * 升格：目标不是"任意格"，而是**本方简易机场**（含专规 3.5 的建造标记简易机场：
     * 原文"acts like a standard air strip (OCS 15.2)"）。判据与 `upgradableAirstripsFor` 同源。
     */
    if (task === 'airstripUpgrade') {
      return deps.airBases.value
        .filter((base) => base.side === activeSide.value && base.isAirstrip === true)
        .filter((base) => {
          const executor = engineerExecutorFor(engineer, base.hex)
          return executor.legMpDistanceToTarget <= CONSTRUCTION_RADIUS_HEXES
        })
        .filter((base) => {
          const outcome = planAirstripUpgrade({
            executor: engineerExecutorFor(engineer, base.hex),
            hexHasAirstrip: true,
            availableT: Number.POSITIVE_INFINITY,
          })
          return outcome.ok
        })
        .map((base) => ({ ...base.hex }))
    }
    return mapLayers.hexes
      .map((hex) => ({ col: hex.col, row: hex.row }))
      .filter((hex) => {
        const executor = engineerExecutorFor(engineer, hex)
        if (executor.legMpDistanceToTarget > CONSTRUCTION_RADIUS_HEXES) return false
        if (airFacilityTargetIssue(hex) !== null) return false
        if (task === 'baseBuild') {
          // 简易机场的升格走 15.2A 的 3 T，不在 15.3 的 1 SP 候选里（与 `buildAirBaseNow` 同一拒绝）
          if (isAirstripAt(hex)) return false
          const outcome = planAirBaseBuild({
            executor,
            currentLevel: airBaseLevelAt(hex),
            levelsBuiltThisTurn: airBaseTurnLedger.value[hexLabel(hex)] ?? 0,
            availableSp: Number.POSITIVE_INFINITY,
          })
          return outcome.ok
        }
        const outcome = planAirstripBuild({
          executor,
          hexHasAirFacility: hexHasAirFacility(hex),
          availableT: Number.POSITIVE_INFINITY,
        })
        return outcome.ok
      })
  })

  /** 15.3：把该格的设施换成**该等级**的空军基地算子（升级＝换算子；无则新摆） */
  function placeAirBaseOperator(hex: HexRef, level: number, allowMarkerAirstrip = false): boolean {
    const record = airBaseRecordFor(level)
    if (record === null) {
      pushLog('warning', `算子库没有 ${level} 级空军基地算子（15.0c）`, '15.3')
      return false
    }
    /*
     * 落盘前的最后一道目标格闸：窗口预检可能被绕过（旧输入、脚本、并发点击），
     * 这里再按同一 `airFacilityTargetIssue` 拒一次，绝不允许“把敌方基地直接换成本方”。
     * 专规 3.5：升格标记简易机场时**唯一**允许带标记落 1 级基地，落盘后立刻撤掉标记。
     */
    const targetIssue = airFacilityTargetIssue(hex)
    if (
      targetIssue !== null &&
      !(allowMarkerAirstrip && targetIssue.reason === 'airBaseTargetIsMarkerAirstrip')
    ) {
      pushLog(
        'warning',
        `摆放空军基地被拒：${ruleErrorTextOf(targetIssue)}（${targetIssue.rule}）`,
        targetIssue.rule,
      )
      return false
    }
    const existing = airBaseUnitAt(hex)
    if (existing !== undefined) {
      // 简易机场升格为空军基地：撤掉简易机场声明（15.2A）
      deps.airstripBaseIds.value = deps.airstripBaseIds.value.filter(
        (id) => id !== existing.instanceId,
      )
      units.value = units.value.filter((unit) => unit.instanceId !== existing.instanceId)
    }
    units.value = [
      ...units.value,
      toConsoleUnit({ record, instanceId: createId('ab'), hex, side: activeSide.value }),
    ]
    return true
  }

  /**
   * 15.3：**修建 / 改进**空军基地（+1 级，1 SP/级）
   *
   * 硬条件由引擎判（`validateConstructionBase` ＋ `planAirBaseBuild`）：移动阶段、施工者具工程能力
   * 且在 2 格**步行 MP** 半径内、本阶段未移动、本格本阶段未施工过、该格每回合最多 +1 级、
   * 未达 3 级上限、SP 足够（1 SP/级）。
   *
   * ★ 与 15.2A 的分工（判读）：**简易机场的升格走 15.2A 的 3 T**，不走本处 1 SP——
   *   15.2A 为简易机场专设了那条价钱，若允许 1 SP 升格会把专条架空。
   */
  function buildAirBaseNow(): boolean {
    // 13.8d / 15.3：修建空军基地只在移动阶段（判据的下半段问引擎）
    if (!requireAction('move.construction', '修建空军基地')) return false
    const hex = parseHexPath(constructionInputs.value.hexText)[0]
    if (hex === undefined) {
      pushLog(
        'warning',
        `目标格号应为「列.行」，收到「${constructionInputs.value.hexText}」（15.3）`,
        '15.3',
      )
      return false
    }
    const engineer = pickedEngineer()
    const gate = constructionGateNow('buildAirBase', engineer)
    if (gate !== null) {
      constructionError.value = { rule: gate.rule, reason: gate.reason }
      pushLog('warning', `修建空军基地被拒：${gate.reason}（${gate.rule}）`, gate.rule)
      return false
    }
    const targetIssue = airFacilityTargetIssue(hex)
    if (targetIssue !== null) {
      constructionError.value = targetIssue
      pushLog(
        'warning',
        `修建空军基地被拒：${ruleErrorTextOf(targetIssue)}（${targetIssue.rule}）`,
        targetIssue.rule,
      )
      return false
    }
    if (isAirstripAt(hex)) {
      constructionError.value = { rule: '15.2A', reason: 'airstripMustUseAirstripUpgrade' }
      pushLog(
        'warning',
        `${hexLabel(hex)} 是**简易机场**：升格为一级空军基地按 15.2A 的 3 T，不适用 15.3 的 1 SP`,
        '15.2A',
      )
      return false
    }
    const dump = constructionPayDumpFor(engineer)
    const outcome = planAirBaseBuild({
      executor: engineerExecutorFor(engineer, hex),
      currentLevel: airBaseLevelAt(hex),
      levelsBuiltThisTurn: airBaseTurnLedger.value[hexLabel(hex)] ?? 0,
      availableSp: dump === null ? 0 : holdingsToT({ sp: dump.sp, t: dump.t }) / SP_TO_T,
    })
    if (!outcome.ok) {
      constructionError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `修建空军基地被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const feeT = constructionFeeT('buildAirBase', outcome.data.costSp, 0)
    const undoSeq = captureUndoSnapshot(`修建空军基地 ${hexLabel(hex)}`)
    if (!payConstructionFee(dump?.id ?? null, feeT, '15.3')) {
      if (undoSeq !== null) dropUndoBySeq(undoSeq)
      return false
    }
    if (!placeAirBaseOperator(hex, outcome.data.levelAfter)) {
      if (undoSeq !== null) dropUndoBySeq(undoSeq)
      return false
    }
    if (engineer !== null) engineer.movementEnded = true
    airBaseTurnLedger.value = {
      ...airBaseTurnLedger.value,
      [hexLabel(hex)]: (airBaseTurnLedger.value[hexLabel(hex)] ?? 0) + 1,
    }
    noteConstruction('buildAirBase', hex, engineer?.instanceId ?? null)
    constructionError.value = null
    pushLog(
      'success',
      `${hexLabel(hex)} ${outcome.data.detail}；付款站 ${dump === null ? '—' : hexLabel(dump.hex)}；` +
        `施工者 ${engineer === null ? '—' : engineer.name} 本阶段不能再移动`,
      outcome.rule,
    )
    return true
  }

  /**
   * 15.2A：**修建简易机场**（1 T）
   *
   * 「按照 15.3 中的流程，它们的建造费用为 1T」⇒ 时机与执行者与 15.3 相同（移动阶段、具工程能力
   * 单位、13.8d 的一格一任务）。本处落盘方式：摆出 1 级基地算子并**声明为简易机场**
   * （本作单位库无独立简易机场算子，口径同 `toggleAirstripBase`）⇒ 整备 1 架 / 激活堆叠 4 /
   * 无防空值 / 永不缩减（15.2B/E）。
   */
  function buildAirstripNow(): boolean {
    // 15.3「空军基地**只能在移动阶段**中修建或改进，而且只能由具备工程能力的单位执行（13.8d）」
    if (!requireAction('move.construction', '修建简易机场')) return false
    const hex = parseHexPath(constructionInputs.value.hexText)[0]
    if (hex === undefined) {
      pushLog(
        'warning',
        `目标格号应为「列.行」，收到「${constructionInputs.value.hexText}」（15.2A）`,
        '15.2A',
      )
      return false
    }
    const engineer = pickedEngineer()
    const gate = constructionGateNow('buildAirstrip', engineer)
    if (gate !== null) {
      constructionError.value = { rule: gate.rule, reason: gate.reason }
      pushLog('warning', `修建简易机场被拒：${gate.reason}（${gate.rule}）`, gate.rule)
      return false
    }
    const targetIssue = airFacilityTargetIssue(hex)
    if (targetIssue !== null) {
      constructionError.value = targetIssue
      pushLog(
        'warning',
        `修建简易机场被拒：${ruleErrorTextOf(targetIssue)}（${targetIssue.rule}）`,
        targetIssue.rule,
      )
      return false
    }
    const dump = constructionPayDumpFor(engineer)
    const outcome = planAirstripBuild({
      executor: engineerExecutorFor(engineer, hex),
      hexHasAirFacility: hexHasAirFacility(hex),
      availableT: dump === null ? 0 : dump.sp * SP_TO_T + dump.t,
    })
    if (!outcome.ok) {
      constructionError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `修建简易机场被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const undoSeq = captureUndoSnapshot(`修建简易机场 ${hexLabel(hex)}`)
    if (
      !payConstructionFee(
        dump?.id ?? null,
        constructionFeeT('buildAirstrip', 0, outcome.data.costT),
        '15.2A',
      )
    ) {
      if (undoSeq !== null) dropUndoBySeq(undoSeq)
      return false
    }
    if (!placeAirBaseOperator(hex, 1)) {
      if (undoSeq !== null) dropUndoBySeq(undoSeq)
      return false
    }
    const placed = airBaseUnitAt(hex)
    if (placed !== undefined)
      deps.airstripBaseIds.value = [...deps.airstripBaseIds.value, placed.instanceId]
    if (engineer !== null) engineer.movementEnded = true
    noteConstruction('buildAirstrip', hex, engineer?.instanceId ?? null)
    constructionError.value = null
    pushLog(
      'success',
      `${hexLabel(hex)} ${outcome.data.detail}；付款站 ${dump === null ? '—' : hexLabel(dump.hex)}`,
      outcome.rule,
    )
    return true
  }

  /**
   * 15.2A：把**简易机场**升级为一级空军基地（3 T）
   *
   * 15.2E 的另一面：简易机场可被升格，但**永不能被缩减**（`canReduceAirstrip` 恒 false）。
   */
  function upgradeAirstripNow(baseId: string): boolean {
    // 15.2A「简易机场可通过支付 3T 升级为一级空军基地」＋ 15.3「只能在移动阶段」⇒ 同一道闸
    if (!requireAction('move.construction', '改进空军基地')) return false
    const base = deps.airBases.value.find((item) => item.id === baseId)
    if (base === undefined) {
      pushLog('warning', `找不到空中设施 ${baseId}（15.2A）`, '15.2A')
      return false
    }
    // 专规 3.5：标记简易机场按 15.2「standard air strip」同口径，可支付 3T 升为 1 级基地；
    // 升格后标记本体撤掉（换成真正的基地算子），此后按普通基地参与 9.14f/15.4。
    const markerAirstrip = isConstructionMarkerAirBaseId(baseId)
    if (base.side !== activeSide.value) {
      const issue = { rule: '9.14f', reason: 'airBaseTargetIsEnemy' }
      constructionError.value = issue
      pushLog('warning', `简易机场升格被拒：${ruleErrorTextOf(issue)}（9.14f）`, '9.14f')
      return false
    }
    const engineer = pickedEngineer()
    const gate = constructionGateNow('upgradeAirstrip', engineer)
    if (gate !== null) {
      constructionError.value = { rule: gate.rule, reason: gate.reason }
      pushLog('warning', `简易机场升格被拒：${gate.reason}（${gate.rule}）`, gate.rule)
      return false
    }
    const dump = constructionPayDumpFor(engineer)
    const outcome = planAirstripUpgrade({
      executor: engineerExecutorFor(engineer, base.hex),
      hexHasAirstrip: base.isAirstrip === true,
      availableT: dump === null ? 0 : dump.sp * SP_TO_T + dump.t,
    })
    if (!outcome.ok) {
      constructionError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `简易机场升格被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    if (
      !payConstructionFee(
        dump?.id ?? null,
        constructionFeeT('upgradeAirstrip', 0, outcome.data.costT),
        '15.2A',
      )
    )
      return false
    // 15.2A：升格＝撤掉简易机场声明并把等级落到 1 级（整备 2 架、有防空值、可再被改进）
    deps.airstripBaseIds.value = deps.airstripBaseIds.value.filter((id) => id !== baseId)
    if (markerAirstrip) {
      if (!placeAirBaseOperator(base.hex, outcome.data.levelAfter, true)) return false
      const pieceId = baseId.slice('cm-airbase:'.length)
      constructionMarkerPieces().value = constructionMarkerPieces().value.filter(
        (piece) => piece.id !== pieceId,
      )
    } else {
      const target = units.value.find((unit) => unit.instanceId === baseId)
      if (target !== undefined) target.noncombatLevel = outcome.data.levelAfter
    }
    if (engineer !== null) engineer.movementEnded = true
    noteConstruction('upgradeAirstrip', base.hex, engineer?.instanceId ?? null)
    constructionError.value = null
    pushLog('success', `${hexLabel(base.hex)} ${outcome.data.detail}`, outcome.rule)
    return true
  }
  /**
   * 公开面清单（P2）：原 facade `workbench.ts` return 区属于本域的键，搬回域内。
   *
   * 为什么搬：这批键是对外承诺的接口，以前登记在 facade 的 1,005 键 return 表里，
   * 于是任何本域改动都要去共享文件登记一次 —— 两人并行改 store 必在 return 区冲突。
   * 搬到域内后，本域的改动人只改本文件；facade 只留一行 `...xxx.publicSurface`。
   *
   * 纪律：增删对外键时**同步改这里的清单**，否则公开面快照（1,013 键）会红。
   */
  const publicSurface = {
    airBaseTurnLedger,
    airUnloadLedger,
    airUnloadedTAt,
    engineerChoices,
    airBaseLevelAt,
    airBaseUnitAt,
    airBaseBuildCostSpPerLevel,
    isAirstripAt,
    hexHasAirFacility,
    airConstructionTask,
    constructionTargetHex,
    airConstructionCandidateHexes,
    constructionErrorLine,
    airConstructionMissing,
    buildAirBaseNow,
    buildAirstripNow,
    upgradeAirstripNow,
    prepareAirConstructionWindowNow,
  }
  return {
    publicSurface,
    airBaseTurnLedger,
    airUnloadLedger,
    airUnloadedTAt,
    engineerChoices,
    airBaseUnitAt,
    isAirstripAt,
    airBaseLevelAt,
    hexHasAirFacility,
    airBaseBuildCostSpPerLevel,
    pickedEngineer,
    airConstructionTask,
    constructionTargetHex,
    airConstructionCandidateHexes,
    constructionErrorLine,
    airConstructionMissing,
    buildAirBaseNow,
    buildAirstripNow,
    upgradeAirstripNow,
    prepareAirConstructionWindowNow,
  }
}
