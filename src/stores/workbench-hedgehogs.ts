/**
 * workbench-hedgehogs.ts —— C8f：16.0b/c 环形工事的修建与缩减（＋专规 1.3a 印刷工事）
 *
 * B3-2b14（2026-11-21）：搬出 21 个声明 / 298 行声明区：
 * `hedgehogTurnLedger` / `hedgehogInputs` / `hedgehogExecutorMode` / `hedgehogEngineerId` /
 * `hedgehogError` / `hedgehogLevelOf` / `isPrintedHedgehogAt` / `printedHedgehogPositions` /
 * `hedgehogRecordFor` / `hedgehogHexState` / `noteHedgehogLedger` / `paySpFromDump` /
 * `constructionExecutor` / `pickedHedgehogEngineer` / `hedgehogUsesEngineerRoute` /
 * `hedgehogTargetHex` / `hedgehogEngineer` / `hedgehogEngineerLegRange` /
 * `markConstructionWorkersImmobile` / `buildHedgehogNow` / `reduceHedgehogNow`。
 * 函数体**零改写**（状态全部随块搬进本域，facade 侧只按 ref 对象读写）。
 *
 * B3-2b15（2026-11-21）：补搬 16.0b 的**付款站面板** 4 个声明（45 + 13 行）——
 * `hedgehogPayDumps` / `hedgehogPayPick` / `toggleHedgehogPayPick` / `pickHedgehogPayDumpNow`。
 * 这四件物理上住在 C8g 段（banner 属 15.3/15.4），语义属本域；零改写，端口 29 → **34**
 * （新增依赖 `deliverableDumpsFor`、新增 4 名返回）。合计 25 个声明 / 356 行。
 *
 * ## 为什么 facade 的装配点要前移到「各动作的待点格入口」段之前
 *   本域的三个符号在**声明区之前**就被读：
 *   · `hedgehogInputs`：B27a 的 `beginHedgehogHexPickNow` 在点地图上写 `hexText`；
 *   · `hedgehogLevelOf` / `hedgehogHexState`：C5 的建域参数按值传（不是闭包延迟求值）。
 *   ⇒ 解构必须早于这些读点，否则 const 绑定在初始化期被读（TDZ／`check-tdz` 报）。
 *   deps 里的 `requireAction` / `pushLog` / `dumpById` / `captureUndoSnapshot` / `dropUndoBySeq` /
 *   `engineerExecutorFor` / `constructionGateNow` / `noteConstruction` / `payConstructionFee`
 *   全部是 `function` 声明（提升），晚于装配点也能按值传。
 *
 * ## 端口为什么是 34 项
 *   14 依赖 + 20 返回（b15 各 +1 / +4）。返回名单只含「别人要用的」：`hedgehogRecordFor` /
 *   `noteHedgehogLedger` / `paySpFromDump` / `constructionExecutor` / `markConstructionWorkersImmobile`
 *   只在域内被调，不 return、facade 不解构。
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'

import {
  HEDGEHOG_LEVELS_PER_TURN,
  HEDGEHOG_MAX_LEVEL,
  SP_TO_T,
  holdingsToT,
  planHedgehogBuild,
  planHedgehogReduce,
  printedPermanentHedgehogAt,
  type ConstructionExecutor,
  type ConstructionTask,
} from '@/engine/rules'
import { ruleErrorTextOf } from '@/engine/rules/rule-error-text'
import { hasUnitMovementThisPhase } from '@/engine/rules/air-unit-movement'
import { sameHex } from '@/engine/hex-geometry'
import type { Derivation } from '@/engine/derivation'
import type { RuleFailure } from '@/engine/result-types'
import { mapLayers, type HexRef, type Side } from '@/data'
import { createId } from '@/shared'
import {
  constructionLegMpDistance,
  hedgehogLevelAt,
  hexLabel,
  parseHexPath,
  printedHedgehogLevelAt,
  toConsoleUnit,
  unitChoices,
} from './workbench-model'
import type { ActionKey, ConsoleUnit, UnitRecordView, WorkbenchLogEntry } from './workbench-model'
import type { useGameSessionStore } from './session'
import type { SpDump } from './supply-types'

/** C8f 环形工事域的端口（34 项 = 14 依赖 + 20 返回，2026-11-21 实测）。 */
export interface HedgehogsDeps {
  activeSide: ComputedRef<Side>
  date: ComputedRef<string>
  units: Ref<ConsoleUnit[]>
  session: ReturnType<typeof useGameSessionStore>
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  /** B8 环节闸门（`function` 声明 ⇒ 提升，可按值传） */
  requireAction: (key: ActionKey, action: string) => boolean
  /** 12.1b：装载中的 SP 也能付工事费 */
  dumpById: (dumpId: string) => SpDump | undefined
  captureUndoSnapshot: (label: string) => number | null
  dropUndoBySeq: (seq: number) => void
  /** 12.3a/12.3b：施工者可达的己方补给站（barrage 域的薄转发，`function` ⇒ 提升） */
  deliverableDumpsFor: (side: Side, beneficiaries: readonly ConsoleUnit[]) => SpDump[]
  /** 13.8d 的两条途径共用的执行者构造（C8g 段声明，`function` ⇒ 提升） */
  engineerExecutorFor: (
    engineer: ConsoleUnit | null,
    target: HexRef,
  ) => Extract<ConstructionExecutor, { kind: 'engineer' }>
  constructionGateNow: (task: ConstructionTask, engineer: ConsoleUnit | null) => RuleFailure | null
  noteConstruction: (task: ConstructionTask, hex: HexRef, engineerId: string | null) => void
  payConstructionFee: (dumpId: string | null, wantT: number, rule: string) => boolean
}

export function createHedgehogsDomain(deps: HedgehogsDeps) {
  const {
    activeSide,
    date,
    units,
    session,
    pushLog,
    requireAction,
    deliverableDumpsFor,
    dumpById,
    captureUndoSnapshot,
    dropUndoBySeq,
    engineerExecutorFor,
    constructionGateNow,
    noteConstruction,
    payConstructionFee,
  } = deps

  /**
   * 16.0b/c：逐格「本回合已提升 / 已降低」的账本（键＝`列.行`）
   *
   * 「每格每回合最多 +1 / −1 级」是**按格按回合**的额度，故需单独记账（换回合即清零）。
   */
  const hedgehogTurnLedger = ref<Record<string, { built: number; reduced: number }>>({})

  /**
   * 16.0b/c 的玩家输入（目标格 / 执行作业的单位 / 付款补给站）
   *
   * ★ 只放**两条途径共用**的输入；途径本身与 13.8d 的工程兵另立两个 ref
   *   （见 `hedgehogExecutorMode` / `hedgehogEngineerId`），免得改一处就动一堆字面量。
   */
  const hedgehogInputs = ref<{ hexText: string; workerIds: string[]; payDumpId: string | null }>({
    hexText: '',
    workerIds: [],
    payDumpId: null,
  })

  /**
   * 16.0b/c 的**执行途径**（16.0b 的条文给了两条）
   *
   * 「需要处于**战斗模式的 1RE 的单位**，且不能移动，才能在**自己所在格**修建或改进一个等级的环形工事。
   *   **一个具有工程能力的单位也可以完成这项工作（13.8d）**。」
   *   ⇒ `inPlace` ＝ 目标格内指定的一小队单位（16.0b 的字面途径）；
   *     `engineer` ＝ 具工程能力的单位按 13.8d 在 **2 格步行 MP** 半径内施工（**不必在目标格内**）。
   * ★ 只有 `engineer` 途径受 13.8d 的「**一格一任务**」约束（那句的主语是"具有工程能力的单位"）。
   */
  const hedgehogExecutorMode = ref<'inPlace' | 'engineer'>('inPlace')

  /** 13.8d 途径下被派去施工的工程兵实例 id */
  const hedgehogEngineerId = ref<string | null>(null)
  /** 16.0b/c 的错误（统一形状：rule + reason） */
  const hedgehogError = ref<{ rule: string; reason: string } | null>(null)

  /**
   * 2026-11-26（用户口径「右键菜单一个操作一个窗口」）：本窗只做**一件事**
   *
   * 16.0b（修建 / 改进 +1 级，2 SP）与 16.0c（缩减 −1 级，免费）是两个菜单项、两个窗口；
   * 同一个 `only='hedgehog'` 面板按本字段只画对应的一段，避免"开修建窗却把缩减按钮也摆上"。
   */
  const hedgehogWindowTask = ref<'build' | 'reduce'>('build')

  /** 16.0b/c 错误的中文行（弹窗统一走 `ruleErrorTextOf`，英文码不再直出） */
  const hedgehogErrorLine = computed<string | null>(() =>
    hedgehogError.value === null ? null : ruleErrorTextOf(hedgehogError.value),
  )

  /** 16.0 / 9.9：该格**当前**工事等级（印刷与摆出取高，与战斗路径同口径） */
  function hedgehogLevelOf(hex: HexRef): number {
    return Math.max(printedHedgehogLevelAt(hex), hedgehogLevelAt(units.value, hex))
  }

  /** 专规 1.3a：该格是否为**印刷永久工事**（永久且**不可降低**） */
  function isPrintedHedgehogAt(hex: HexRef): boolean {
    return printedPermanentHedgehogAt(hex)
  }

  /**
   * 专规 1.3a：地图**印刷工事**的清单（数据层 `map-layers.printedHedgehogs`）
   *
   * 供界面逐格查询：16.0 的等级修正与 9.14e 的归属翻转都以「印刷工事视作一类特殊工事单位」处理。
   */
  const printedHedgehogPositions = computed<HexRef[]>(() =>
    mapLayers.printedHedgehogs.map((item) => ({ col: item.col, row: item.row })),
  )

  /** 该方该等级的工事算子记录（本作上限 1 级，故实际只用到 1 级那枚） */
  function hedgehogRecordFor(level: number): UnitRecordView | null {
    return (
      unitChoices(activeSide.value).find(
        (record) => record.noncombatKind === 'hedgehog' && record.noncombatDetails?.level === level,
      ) ?? null
    )
  }

  /** 目标格的工事状态（16.0b/c 的逐格输入） */
  function hedgehogHexState(hex: HexRef) {
    const key = hexLabel(hex)
    const ledger = hedgehogTurnLedger.value[key] ?? { built: 0, reduced: 0 }
    return {
      level: hedgehogLevelOf(hex),
      isPrintedPermanent: isPrintedHedgehogAt(hex),
      levelsBuiltThisTurn: ledger.built,
      levelsReducedThisTurn: ledger.reduced,
    }
  }

  /** 记一次「本回合该格已提升 / 已降低」 */
  function noteHedgehogLedger(hex: HexRef, kind: 'built' | 'reduced'): void {
    const key = hexLabel(hex)
    const current = hedgehogTurnLedger.value[key] ?? { built: 0, reduced: 0 }
    hedgehogTurnLedger.value = {
      ...hedgehogTurnLedger.value,
      [key]:
        kind === 'built'
          ? { ...current, built: current.built + 1 }
          : { ...current, reduced: current.reduced + 1 },
    }
  }

  /**
   * 从**指定的付款站**扣 SP（1 SP = 4 T，12.1a）；未指定即拒
   *
   * ★ 唯一入口：直接委托 `payConstructionFee`（同一套「只能从己方补给站扣」与找零逻辑），
   *   避免 16.0b 与 15.3 各写一份扣款。
   */
  function paySpFromDump(dumpId: string | null, wantSp: number): boolean {
    return payConstructionFee(dumpId, wantSp * SP_TO_T, '16.0b')
  }

  /**
   * 16.0b/c 原地途径：只认**目标格内、本方**的被指定单位
   *
   * ★ `workerIds` 可能在改目标格后残留旧格单位（窗口只换 `hexText`）。这里按当前目标格与
   *   当前行动方重新过滤，保证引擎收到的 `inPlaceUnits` 真的“在自己所在格”（16.0b）。
   */
  function hedgehogInPlaceUnitsAt(hex: HexRef | null): ConsoleUnit[] {
    if (hex === null) return []
    return hedgehogInputs.value.workerIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter(
        (unit): unit is ConsoleUnit =>
          unit !== undefined &&
          unit.isCombat === true &&
          unit.re > 0 &&
          unit.side === activeSide.value &&
          sameHex(unit.hex, hex),
      )
  }

  /**
   * 组装 16.0b/c 的执行者（两条途径，按 `hedgehogExecutorMode` 分派）
   *
   * `engineer` 途径需要目标格才能量 13.8d 的**步行 MP** 半径，故本函数收一个目标格。
   */
  function constructionExecutor(target: HexRef): ConstructionExecutor {
    if (hedgehogExecutorMode.value === 'engineer') {
      return engineerExecutorFor(pickedHedgehogEngineer(), target)
    }
    const workers = hedgehogInPlaceUnitsAt(target)
    return {
      kind: 'inPlaceUnits',
      units: workers.map((unit) => ({
        id: unit.instanceId,
        re: unit.re,
        mode: unit.mode.mode,
        movedThisPhase: hasUnitMovementThisPhase(unit.mpSpent, unit.airTransportThisPhase),
      })),
    }
  }

  /** 16.0b/c：`engineer` 途径下被派去施工的工程兵（未指定或找不到 ⇒ null） */
  function pickedHedgehogEngineer(): ConsoleUnit | null {
    const id = hedgehogEngineerId.value
    if (id === null) return null
    return units.value.find((unit) => unit.instanceId === id) ?? null
  }

  /** 16.0b/c：本途径**是否**走 13.8d（决定要不要过 13.8d 的公共前提与一格一任务账本） */
  const hedgehogUsesEngineerRoute = computed<boolean>(
    () => hedgehogExecutorMode.value === 'engineer',
  )

  /** 16.0b/c：目标格（未填或格式不合 ⇒ null；目标格的解析只有这一处） */
  const hedgehogTargetHex = computed<HexRef | null>(
    () => parseHexPath(hedgehogInputs.value.hexText)[0] ?? null,
  )

  /** 目标格此刻的工事实况（未填/格式错 ⇒ null；供窗口显示等级与"本回合已施工"） */
  const hedgehogTargetState = computed(() => {
    const hex = hedgehogTargetHex.value
    return hex === null ? null : hedgehogHexState(hex)
  })

  /** 13.8d 途径下被派去施工的工程兵（未选或找不到 ⇒ null） */
  const hedgehogEngineer = computed<ConsoleUnit | null>(() => pickedHedgehogEngineer())

  /**
   * 13.8d 途径下：工程兵到目标格的**步行 MP** 距离（**无视敌方 ZOC**；上限 2）
   *
   * ★ 一律按**步行价目**量（用户 2026-09-15 裁定：2 格步行 MA 是**专门针对工程能力**的限制，
   *   与 6.2「按该单位自身机动类型取费」不同）——故这里**不**传机动类型。
   * 任一输入缺失 ⇒ null。界面直接显示它，免得把「解析格号」这类事写进模板。
   */
  const hedgehogEngineerLegRange = computed<number | null>(() => {
    const engineer = hedgehogEngineer.value
    const hex = hedgehogTargetHex.value
    if (engineer === null || hex === null) return null
    return constructionLegMpDistance(engineer.hex, hex)
  })

  /** 16.0b/c：执行者是否已就位（决定窗口给不给主按钮，免得点了才被告知"没有施工者"） */
  const hedgehogExecutorReady = computed<boolean>(() =>
    hedgehogUsesEngineerRoute.value
      ? pickedHedgehogEngineer() !== null
      : hedgehogInPlaceUnitsAt(hedgehogTargetHex.value).length > 0,
  )

  /**
   * 16.0b 预检：与 `buildHedgehogNow` 同一份引擎规则
   *
   * 只用于窗口的“还差”文案；不落盘、不写账本。缺目标格/执行者时返回 null，让上层给更具体的提示。
   */
  const hedgehogBuildPreflight = computed(() => {
    const hex = hedgehogTargetHex.value
    if (hex === null || !hedgehogExecutorReady.value) return null
    const dump =
      hedgehogInputs.value.payDumpId === null
        ? null
        : (dumpById(hedgehogInputs.value.payDumpId) ?? null)
    return planHedgehogBuild({
      side: activeSide.value,
      date: date.value,
      executor: constructionExecutor(hex),
      hex: hedgehogHexState(hex),
      availableSp: dump === null ? 0 : holdingsToT({ sp: dump.sp, t: dump.t }) / SP_TO_T,
      ignoreOperationalLimits: session.rule4On('ignoreOperationalLimits'),
    })
  })

  /** 16.0c 预检：与 `reduceHedgehogNow` 同一份引擎规则（缩减免费，不看付款站） */
  const hedgehogReducePreflight = computed(() => {
    const hex = hedgehogTargetHex.value
    if (hex === null || !hedgehogExecutorReady.value) return null
    return planHedgehogReduce({
      executor: constructionExecutor(hex),
      hex: hedgehogHexState(hex),
    })
  })

  /** 16.0b：还差什么（null ＝ 主按钮可以出现） */
  const hedgehogBuildMissing = computed<string | null>(() => {
    const hex = hedgehogTargetHex.value
    if (hex === null) return '还差：先「点地图选格」'
    const state = hedgehogHexState(hex)
    if (state.isPrintedPermanent) return '这一格是地图印刷永久工事：不可修建、不可降低（专规 1.3a）'
    if (state.level >= HEDGEHOG_MAX_LEVEL) return '本作工事上限 1 级，该格已有工事（专规 1.3b）'
    if (state.levelsBuiltThisTurn >= HEDGEHOG_LEVELS_PER_TURN)
      return '该格本回合已经提升过（16.0b：每回合 +1 级）'
    if (!hedgehogExecutorReady.value)
      return hedgehogUsesEngineerRoute.value
        ? '还差：指定 13.8d 的施工工程兵'
        : '还差：在目标格勾选施工小队'
    if (hedgehogInputs.value.payDumpId === null) return '还差：付款补给站（16.0b：2 SP）'
    if (hedgehogUsesEngineerRoute.value) {
      const gate = constructionGateNow('buildHedgehog', hedgehogEngineer.value)
      if (gate !== null) return `还差：${ruleErrorTextOf(gate)}（${gate.rule}）`
    }
    const outcome = hedgehogBuildPreflight.value
    if (outcome !== null && !outcome.ok)
      return `还差：${ruleErrorTextOf(outcome)}（${outcome.rule}）`
    return null
  })

  /** 16.0c：还差什么（null ＝ 主按钮可以出现；缩减免费，不需要付款站） */
  const hedgehogReduceMissing = computed<string | null>(() => {
    const hex = hedgehogTargetHex.value
    if (hex === null) return '还差：先「点地图选格」'
    const state = hedgehogHexState(hex)
    if (state.isPrintedPermanent) return '这一格是地图印刷永久工事：不可修建、不可降低（专规 1.3a）'
    if (state.level < 1) return '该格没有环形工事（16.0c）'
    if (state.levelsReducedThisTurn >= HEDGEHOG_LEVELS_PER_TURN)
      return '该格本回合已经缩减过（16.0c：每回合 −1 级）'
    if (!hedgehogExecutorReady.value)
      return hedgehogUsesEngineerRoute.value
        ? '还差：指定 13.8d 的施工工程兵'
        : '还差：在目标格勾选施工小队'
    if (hedgehogUsesEngineerRoute.value) {
      const gate = constructionGateNow('reduceHedgehog', hedgehogEngineer.value)
      if (gate !== null) return `还差：${ruleErrorTextOf(gate)}（${gate.rule}）`
    }
    const outcome = hedgehogReducePreflight.value
    if (outcome !== null && !outcome.ok)
      return `还差：${ruleErrorTextOf(outcome)}（${outcome.rule}）`
    return null
  })

  /** 16.0b/c：环形工事的付款站候选（施工小队或 13.8d 工程兵可达的来源） */
  const hedgehogPayDumps = computed<SpDump[]>(() => {
    const beneficiaries: ConsoleUnit[] = []
    if (hedgehogUsesEngineerRoute.value) {
      const engineer = pickedHedgehogEngineer()
      if (engineer !== null) beneficiaries.push(engineer)
    } else {
      for (const id of hedgehogInputs.value.workerIds) {
        const unit = units.value.find((item) => item.instanceId === id)
        if (unit !== undefined) beneficiaries.push(unit)
      }
    }
    if (beneficiaries.length === 0) return []
    return deliverableDumpsFor(activeSide.value, beneficiaries)
  })

  /** 工事付款的「点地图选站」模式 */
  const hedgehogPayPick = ref(false)

  /** 开启/取消工事付款的地图选站模式 */
  function toggleHedgehogPayPick(): boolean {
    if (hedgehogPayPick.value) {
      hedgehogPayPick.value = false
      return true
    }
    const executorMissing = hedgehogUsesEngineerRoute.value
      ? pickedHedgehogEngineer() === null
      : hedgehogInputs.value.workerIds.length === 0
    if (executorMissing) {
      pushLog(
        'warning',
        hedgehogUsesEngineerRoute.value
          ? '先指定 13.8d 的施工工程兵，再选付款补给站（16.0b）'
          : '先在目标格勾选施工小队，再选付款补给站（16.0b）',
        '16.0b',
      )
      return false
    }
    if (hedgehogPayDumps.value.length === 0) {
      pushLog('warning', '施工者此刻没有可达的己方补给站（12.3a/12.3b）', '12.3a')
      return false
    }
    hedgehogPayPick.value = true
    return true
  }

  /** 地图点到某一座候选站 ⇒ 写入工事付款站并退出选站模式 */
  function pickHedgehogPayDumpNow(dumpId: string): boolean {
    const dump = hedgehogPayDumps.value.find((item) => item.id === dumpId)
    if (dump === undefined) return false
    hedgehogInputs.value = { ...hedgehogInputs.value, payDumpId: dump.id }
    hedgehogPayPick.value = false
    pushLog(
      'info',
      `工事付款站：${hexLabel(dump.hex)}（${dump.sp} SP + ${dump.t} T，12.1b）`,
      '12.1b',
    )
    return true
  }

  /**
   * 2026-11-26：从右键菜单开**本任务的窗口**时统一清预填
   *
   * 以前开窗只写 `engineerId`，上一轮的 `hexText` / `payDumpId` 会跟过来（实机上出现
   * "付款站 2.2 已在、目标格却是空的"）。这里一次写清：任务、途径、执行者、目标格、付款站、错误。
   */
  function prepareHedgehogWindowNow(
    task: 'build' | 'reduce',
    mode: 'inPlace' | 'engineer',
    unitId: string,
    hexText: string,
  ): void {
    hedgehogWindowTask.value = task
    hedgehogExecutorMode.value = mode
    hedgehogEngineerId.value = mode === 'engineer' ? unitId : null
    hedgehogInputs.value =
      mode === 'inPlace'
        ? { hexText, workerIds: [unitId], payDumpId: null }
        : { hexText, workerIds: [], payDumpId: null }
    hedgehogPayPick.value = false
    hedgehogError.value = null
  }

  /** 16.0b/c：把「本阶段不能再移动」落到被指定的单位上（仅这些单位受约束） */
  function markConstructionWorkersImmobile(ids: readonly string[]): void {
    for (const id of ids) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit !== undefined) unit.movementEnded = true
    }
  }

  /**
   * 16.0b：环形工事**修建 / 改进**（+1 级）
   *
   * 硬条件由引擎判（`planHedgehogBuild`）：移动阶段、执行者合格（**两条途径**见下）、该格本回合未
   * 提升过、未达上限（**专规 1.3b：1 级**）、**苏方在专规 2.3e 起始日之前不得修建**、SP 足够（2 SP/级）。
   * 本处负责：换算子（摆出对应等级的工事算子）＋支付 SP ＋把被指定的单位标为"本阶段不能再移动"。
   *
   * ★ 两条途径（16.0b 原文「一个**具有工程能力**的单位也可以完成这项工作（**13.8d**）」）：
   *   · `inPlace`：目标格内指定的一小队单位（RE 合计 ≥ 1、逐员战斗模式、本阶段未移动）；
   *   · `engineer`：具工程能力的单位在 **2 格步行 MP** 半径内施工（**不必在目标格内**），
   *     并额外受 13.8d 的公共前提约束（**一格一任务**、2 格半径、本阶段未移动）。
   */
  function buildHedgehogNow(): boolean {
    if (!requireAction('move.hedgehog', '修建环形工事')) return false
    const hex = parseHexPath(hedgehogInputs.value.hexText)[0]
    if (hex === undefined) {
      pushLog(
        'warning',
        `目标格号应为「列.行」，收到「${hedgehogInputs.value.hexText}」（16.0b）`,
        '16.0b',
      )
      return false
    }
    const engineer = pickedHedgehogEngineer()
    // 13.8d 的公共前提**只对工程兵途径**生效（「一格一任务」那句的主语是"具有工程能力的单位"）
    if (hedgehogUsesEngineerRoute.value) {
      const gate = constructionGateNow('buildHedgehog', engineer)
      if (gate !== null) {
        hedgehogError.value = { rule: gate.rule, reason: gate.reason }
        pushLog('warning', `修建工事被拒（13.8d）：${gate.reason}（${gate.rule}）`, gate.rule)
        return false
      }
    }
    // 12.1b（用户 2026-11-13）：装载中的 SP 也能付工事费
    const dump =
      hedgehogInputs.value.payDumpId === null
        ? null
        : (dumpById(hedgehogInputs.value.payDumpId) ?? null)
    const outcome = planHedgehogBuild({
      side: activeSide.value,
      date: date.value,
      executor: constructionExecutor(hex),
      hex: hedgehogHexState(hex),
      availableSp: dump === null ? 0 : holdingsToT({ sp: dump.sp, t: dump.t }) / SP_TO_T,
      // 专规 4.1a（可选）：忽略 2.3e ⇒ 苏军 8 月 1 日前也能修建环形工事
      ignoreOperationalLimits: session.rule4On('ignoreOperationalLimits'),
    })
    if (!outcome.ok) {
      hedgehogError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `修建工事被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const record = hedgehogRecordFor(outcome.data.levelAfter)
    if (record === null) {
      pushLog('warning', `算子库没有 ${outcome.data.levelAfter} 级工事算子（16.0b）`, '16.0b')
      return false
    }
    const undoSeq = captureUndoSnapshot(`修建环形工事 ${hexLabel(hex)}`)
    if (!paySpFromDump(hedgehogInputs.value.payDumpId, outcome.data.costSp)) {
      if (undoSeq !== null) dropUndoBySeq(undoSeq)
      return false
    }
    // 4.8：一格至多 1 个工事 ⇒ 摆出该等级的算子；8.1e/9.14e 的归属随算子
    units.value = [
      ...units.value,
      toConsoleUnit({ record, instanceId: createId('hog'), hex, side: activeSide.value }),
    ]
    markConstructionWorkersImmobile(outcome.data.immobileUnitIds)
    if (hedgehogUsesEngineerRoute.value)
      noteConstruction('buildHedgehog', hex, engineer?.instanceId ?? null)
    noteHedgehogLedger(hex, 'built')
    hedgehogError.value = null
    pushLog(
      'success',
      `${outcome.data.detail}；付款站 ${dump === null ? '—' : hexLabel(dump.hex)}` +
        (hedgehogUsesEngineerRoute.value ? `；施工者 ${engineer?.name ?? '—'}（13.8d 途径）` : ''),
      outcome.rule,
    )
    return true
  }

  /**
   * 16.0c：环形工事**缩减**（−1 级；**免费**）
   *
   * ★ **专规 1.3a：印刷永久工事不可降低**（引擎按 `isPrintedPermanent` 拒）；降到 1 级以下即**移除**；
   * 每格每回合最多 −1 级。
   */
  function reduceHedgehogNow(): boolean {
    if (!requireAction('move.hedgehog', '缩减环形工事')) return false
    const hex = parseHexPath(hedgehogInputs.value.hexText)[0]
    if (hex === undefined) {
      pushLog(
        'warning',
        `目标格号应为「列.行」，收到「${hedgehogInputs.value.hexText}」（16.0c）`,
        '16.0c',
      )
      return false
    }
    const engineer = pickedHedgehogEngineer()
    // 13.8d 的公共前提**只对工程兵途径**生效（同 `buildHedgehogNow`）
    if (hedgehogUsesEngineerRoute.value) {
      const gate = constructionGateNow('reduceHedgehog', engineer)
      if (gate !== null) {
        hedgehogError.value = { rule: gate.rule, reason: gate.reason }
        pushLog('warning', `缩减工事被拒（13.8d）：${gate.reason}（${gate.rule}）`, gate.rule)
        return false
      }
    }
    const outcome = planHedgehogReduce({
      executor: constructionExecutor(hex),
      hex: hedgehogHexState(hex),
    })
    if (!outcome.ok) {
      hedgehogError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `缩减工事被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const placed = units.value.find(
      (unit) => sameHex(unit.hex, hex) && unit.noncombatKind === 'hedgehog',
    )
    captureUndoSnapshot(`缩减环形工事 ${hexLabel(hex)}`)
    if (outcome.data.removes) {
      if (placed !== undefined)
        units.value = units.value.filter((unit) => unit.instanceId !== placed.instanceId)
    } else if (placed !== undefined) {
      placed.noncombatLevel = outcome.data.levelAfter
    }
    markConstructionWorkersImmobile(outcome.data.immobileUnitIds)
    if (hedgehogUsesEngineerRoute.value)
      noteConstruction('reduceHedgehog', hex, engineer?.instanceId ?? null)
    noteHedgehogLedger(hex, 'reduced')
    hedgehogError.value = null
    pushLog('success', outcome.data.detail, outcome.rule)
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
    hedgehogInputs,
    hedgehogExecutorMode,
    hedgehogEngineerId,
    hedgehogUsesEngineerRoute,
    hedgehogTargetHex,
    hedgehogTargetState,
    hedgehogEngineer,
    hedgehogEngineerLegRange,
    pickedHedgehogEngineer,
    hedgehogExecutorReady,
    hedgehogBuildMissing,
    hedgehogReduceMissing,
    hedgehogWindowTask,
    hedgehogError,
    hedgehogErrorLine,
    hedgehogTurnLedger,
    hedgehogLevelOf,
    isPrintedHedgehogAt,
    printedHedgehogPositions,
    buildHedgehogNow,
    reduceHedgehogNow,
    hedgehogPayDumps,
    hedgehogPayPick,
    toggleHedgehogPayPick,
    pickHedgehogPayDumpNow,
    prepareHedgehogWindowNow,
  }
  return {
    publicSurface,
    hedgehogInputs,
    hedgehogExecutorMode,
    hedgehogEngineerId,
    hedgehogUsesEngineerRoute,
    hedgehogTargetHex,
    hedgehogTargetState,
    hedgehogEngineer,
    hedgehogEngineerLegRange,
    pickedHedgehogEngineer,
    hedgehogExecutorReady,
    hedgehogBuildMissing,
    hedgehogReduceMissing,
    hedgehogWindowTask,
    hedgehogError,
    hedgehogErrorLine,
    hedgehogTurnLedger,
    hedgehogLevelOf,
    hedgehogHexState,
    isPrintedHedgehogAt,
    printedHedgehogPositions,
    buildHedgehogNow,
    reduceHedgehogNow,
    hedgehogPayDumps,
    hedgehogPayPick,
    toggleHedgehogPayPick,
    pickHedgehogPayDumpNow,
    prepareHedgehogWindowNow,
  }
}
