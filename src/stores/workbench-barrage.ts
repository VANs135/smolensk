import type { RuleOutcome, RuleFailure } from '@/engine/result-types'
import {
  beginBarrage,
  countSupplyDistanceToUnitViaTable,
  canThrowViaHQ,
  drawableDumpsFor,
  canDrawFromCarrier,
  SUPPLY_CACHE_SHELLS_T,
  holdingsToT,
  planBarrageSupplyPayment,
  selectAffordableBarrageColumn,
  barrageTableWithScenarioRule,
  barrageTableMeta,
  planBarrageSupply,
  planSpPayment,
  BARRAGE_COLUMN_SHIFTS,
  declareBarrageShifts,
  isFacilityBarrage,
  SP_TO_T,
} from '@/engine/rules'
import type {
  BarrageUnitPatch,
  BarrageKind,
  BarrageTargetKind,
  CombatLine,
  FacilityPatch,
  SopSegmentStep,
  SupplyCacheHoldings,
  PanzerGroupSpPurpose,
  SpHoldings,
  AirBaseView,
  TrainbustingMarkerView,
} from '@/engine/rules'
import {
  parseHexPath,
  toConsoleAirUnit,
  hexLabel,
  toBarrageUnitRequest,
  toAirBarrageUnitRequest,
  isHqUnit,
  toThrowHqView,
  defenseTerrainChoices,
} from './workbench-model'
import type {
  ConsoleUnit,
  ConsoleAirUnit,
  DeadPileEntry,
  AircraftRecordView,
  ActionKey,
  ActionGateQuery,
} from './workbench-model'
import { createId } from '@/shared'
import { sameHex } from '@/engine/hex-geometry'
import { ruleErrorTextOf } from '@/engine/rules/rule-error-text'
import { roll1d6 } from '@/engine/rng'
import type { RngState } from '@/engine/state-types'
import type { SpDump } from './supply-types'
import { ref, computed } from 'vue'
import type { Ref, ComputedRef, WritableComputedRef } from 'vue'
import type { createFireResolutionDomain } from './fire-resolution'
import type { createAirMissionDomain } from './air-mission'
import type { HexRef, Side } from '@/data'
import type { BattleTarget, ConsolePhase } from './workbench-model'
import type { SettlementRecordInput } from './workbench-core'
import type { TraceSupplyFacts } from '@/engine/rules/trace-supply'

/**
 * C7 轰炸（10.0 通用流程）的领域切片 —— B1
 *
 * 纯搬移：39 个动作 + 18 个账本/派生从 `workbench.ts` 原样迁出，函数体一字未改；
 * 依赖一律由 facade 以「ref 传引用 / 函数传引用」注入，切片不认识 store 本身。
 *
 * ★ 装配点被有意放在 setup 的**末尾**（`return` 之前）：本切片有 13 个依赖声明在
 *   24k–29k 行（B8 / B19 区），早装配必踩 TDZ。
 * ★ `barrageAutoOpened` 是唯一不是 ref 的跨切片状态，用 getter/setter 槽对象承接，
 *   保持「非响应式裸标志」的原语义（改成 ref 会多触发一次 watch）。
 * ★ `barrageState` / `barrageError` / `barrageInputs` / `combatState` / `combatError`
 *   与 `airError` 是域对象解构出来的 ref，切片只认成员、不认域（避免与域切片互相依赖）。
 */
export interface BarragePorts {
  activeSide: ComputedRef<Side>
  phase: ComputedRef<ConsolePhase>
  rng: WritableComputedRef<RngState>
  drawCount: WritableComputedRef<number>
  units: Ref<ConsoleUnit[]>
  battleTarget: Ref<BattleTarget | null>
  fireResolution: ReturnType<typeof createFireResolutionDomain>
  barrageActive: Ref<boolean>
  autoOpened: { value: boolean }
  barrageKind: Ref<BarrageKind>
  barrageTargetKind: Ref<BarrageTargetKind>
  barrageUnitIds: Ref<string[]>
  barrageScopeHex: Ref<HexRef | null>
  barragedHexesThisPhase: Ref<string[]>
  barragedUnitIdsThisPhase: Ref<string[]>
  airUnits: Ref<ConsoleAirUnit[]>
  airBoxMembers: Ref<string[]>
  barrageAirIds: Ref<string[]>
  spDumps: Ref<SpDump[]>
  airMissionDomain: ReturnType<typeof createAirMissionDomain>
  combatAttackers: ComputedRef<ConsoleUnit[]>
  barrageUnits: ComputedRef<ConsoleUnit[]>
  barrageUnitChoices: ComputedRef<
    readonly {
      unit: ConsoleUnit
      selected: boolean
      inRange: boolean
      disabledReason: string | null
    }[]
  >
  barrageTargetHex: ComputedRef<HexRef | null>
  barrageTargetFacts: ComputedRef<{
    enemyREInHex: number
    hedgehogLevel: number
    stratModeInHex: boolean
    hasSpotter: boolean
  }>
  barrageTargetKindIssue: ComputedRef<{ rule: string; reason: string } | null>
  barrageTerrainLineOptions: ComputedRef<CombatLine[]>
  airUnitChoices: ComputedRef<AircraftRecordView[]>
  barrageAirUnits: ComputedRef<ConsoleAirUnit[]>
  allSpDumps: ComputedRef<SpDump[]>
  dumpById: (dumpId: string) => SpDump | undefined
  supplyFacts: ComputedRef<TraceSupplyFacts>
  airBases: ComputedRef<AirBaseView[]>
  pushLog: (kind: 'info' | 'success' | 'warning' | 'danger', text: string, rule?: string) => void
  recordSettlement: (input: SettlementRecordInput) => boolean
  canReplaceBarrage: () => boolean
  eliminateEntry: (entry: DeadPileEntry, rule: string, text: string, _refresh?: boolean) => void
  applyDgToUnit: (unit: ConsoleUnit) => void
  setSpDumpHoldings: (id: string, holdings: SpHoldings) => void
  onMapAirUnits: ComputedRef<ConsoleAirUnit[]>
  airDistanceFromRealBase: (air: ConsoleAirUnit, hex: HexRef) => number
  scenarioId: ComputedRef<string>
  segmentStep: ComputedRef<SopSegmentStep | null>
  segmentGateQuery: ComputedRef<ActionGateQuery>
  barrageKindsInSegment: ComputedRef<readonly BarrageKind[]>
  pickBarrageTargetAt: (hex: HexRef) => void
  requireAction: (key: ActionKey, action: string) => boolean
  supplyCacheHoldings: Ref<SupplyCacheHoldings>
  trainbustingMarks: Ref<TrainbustingMarkerView[]>
  panzerGroupSpGate: (input: {
    dumpId: string | null
    purpose: PanzerGroupSpPurpose
    beneficiaryUnitIds: readonly string[]
  }) => RuleFailure | null
  panzerGroupSpRefusal: (failure: RuleFailure, purpose: string, dumpId: string | null) => string
}

export function createBarrageDomain(deps: BarragePorts) {
  const {
    canReplaceBarrage,
    barrageActive,
    pushLog,
    barrageUnitIds,
    barrageScopeHex,
    barrageAirIds,
    fireResolution,
    barrageKind,
    barrageTargetKind,
    units,
    applyDgToUnit,
    eliminateEntry,
    airBoxMembers,
    airUnitChoices,
    activeSide,
    airUnits,
    barrageKindsInSegment,
    barrageUnitChoices,
    requireAction,
    barrageTargetHex,
    barrageTargetKindIssue,
    barrageUnits,
    barrageAirUnits,
    segmentGateQuery,
    phase,
    segmentStep,
    scenarioId,
    airDistanceFromRealBase,
    barragedHexesThisPhase,
    barragedUnitIdsThisPhase,
    barrageTargetFacts,
    recordSettlement,
    supplyFacts,
    allSpDumps,
    combatAttackers,
    battleTarget,
    spDumps,
    supplyCacheHoldings,
    dumpById,
    panzerGroupSpGate,
    panzerGroupSpRefusal,
    setSpDumpHoldings,
    barrageTerrainLineOptions,
    pickBarrageTargetAt,
    airBases,
    rng,
    drawCount,
    trainbustingMarks,
    onMapAirUnits,
    autoOpened,
  } = deps
  const { barrageState, barrageError, barrageInputs, combatState, combatError } =
    deps.fireResolution
  const { airError } = deps.airMissionDomain

  /* ──────────────── C7 轰炸交互：选子 → 10.0 通用流程动作（全部问引擎） ──────────────── */

  /** C7：开/关轰炸工具（开启时清空上一场） */
  function setBarrageActive(on: boolean): void {
    if (!canReplaceBarrage()) return
    barrageActive.value = on
    // 关掉即不再欠"自动开的"这笔账（手动关、换段收回都走这里）
    if (!on) autoOpened.value = false
    clearBarrage()
    pushLog('info', on ? '轰炸工具已开启（10.0 通用流程）' : '轰炸工具已关闭', '10.0')
  }

  /**
   * C7：清空本场轰炸的全部交互状态（换方/换阶段/重置/关闭时调用；不卸载已摆放的飞机）
   *
   * ★ 注意：**不清 10.0e-A/B 的账本**（`barragedHexesThisPhase` / `barragedUnitIdsThisPhase`）。
   *   它记的是"这一格/这一单位**本阶段**已轰炸过"，属阶段级事实；清它的是 `setPhase`/`setTurn`/复位。
   *   混在一起会让"关掉轰炸工具再打开"就能绕过每阶段一次的限制。
   */
  function clearBarrage(): void {
    if (!canReplaceBarrage()) return
    barrageUnitIds.value = []
    barrageScopeHex.value = null
    barrageAirIds.value = []
    fireResolution.resetBarrage()
    /*
     * ★ 第六批条 23-②：修前**不清** `barrageKind` / `barrageTargetKind` ⇒
     *   一场低空扫射（kind 会带成 `'air'`，hipShoot 为 true）结束后，这两个选择器仍停在
     *   上一次的取值上；换段后炮兵候选/目标表按**残留的** `'air'` 去列，界面与引擎口径分叉。
     *   10.0e-F 与 10.0d 都是「一次轰炸内」的声明 ⇒ 一场结束（或换段）即应回到默认值。
     */
    barrageKind.value = 'artillery'
    barrageTargetKind.value = 'combatUnits'
    // 付款来源由统一流程在开场/收场显式清（K6：不能靠这里清——面板允许"先选站后开工具"）
    barragePaidSupply.value = null
    barrageShellMarkers.value = 0
  }

  /** C7：统一收引擎结论（失败即记 `barrageError` 与日志并返回 null） */
  function acceptBarrage<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      barrageError.value = null
      return outcome.data
    }
    barrageError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /** C7：把引擎给出的轰炸变更落盘（DG 与军力损失；军力归零者移入死亡堆） */
  function applyBarragePatches(patches: readonly BarrageUnitPatch[]): void {
    const eliminated: ConsoleUnit[] = []
    for (const patch of patches) {
      const unit = units.value.find((item) => item.instanceId === patch.unitId)
      if (unit === undefined) continue
      if (patch.stepLoss !== undefined) {
        unit.steps = Math.max(0, unit.steps - patch.stepLoss)
        if (unit.steps <= 0) eliminated.push(unit)
      }
      if (patch.dg === true) applyDgToUnit(unit)
    }
    for (const unit of eliminated)
      eliminateEntry(unit, '10.0a', `${unit.name} 军力归零，移入死亡堆（10.0a）`)
  }

  /** C7：选/取消一个参炸单位（10.0e-F 的同类型限制由引擎裁决；此处只收集选择） */
  function toggleBarrageUnit(unitId: string): void {
    if (!canReplaceBarrage()) return
    if (barrageUnitIds.value.includes(unitId)) {
      barrageUnitIds.value = barrageUnitIds.value.filter((id) => id !== unitId)
    } else {
      barrageUnitIds.value = [...barrageUnitIds.value, unitId]
    }
    // 选择变化即作废进行中的流程（与 C6 换选同规）
    barrageState.value = null
    barrageError.value = null
  }

  /* ── C7 空军：摆放与参炸勾选（14.1a / 10.2b） ── */

  /**
   * 专规 1.4a：把飞机放进 / 移出**地图外空军盒**（盒成员账本的**唯一写入口**）
   *
   * 盒即基地（容量无限、整备免费），其成员身份决定：① 盒内清单；② 任务航程
   * （「从对应列入场，剩余航程 = 印刷航程 − 20/30 格」）。合法性（射程够不够飞）由调用方
   * 先用 `planOffMapAirBoxFlight` 判，本函数只落账。
   */
  function setAirInBoxMembership(instanceId: string, inBox: boolean): void {
    airBoxMembers.value = inBox
      ? [...new Set([...airBoxMembers.value, instanceId])]
      : airBoxMembers.value.filter((id) => id !== instanceId)
  }

  /** 专规 1.4a：清空图外空军盒的驻机名单（换剧本 / 复位） */
  function clearAirBoxMembers(): void {
    airBoxMembers.value = []
  }

  /**
   * C7：摆放一架飞机到指定**基地格**（14.1a）
   *
   * 「飞机的模式表示方式是，将激活的飞机算子放在**空军基地算子**的上方，或将非激活的放在下方」
   * ⇒ 飞机在图上就位于其空军基地格，该格即 10.2b 判定用的「它们基地」。
   */
  function addAirUnit(aircraftId: string | null, hexText: string): boolean {
    const record = airUnitChoices.value.find((item) => item.aircraftId === aircraftId)
    if (record === undefined) {
      pushLog('warning', '请先选择机型（A5 空军专表）', '14.1')
      return false
    }
    const hex = parseHexPath(hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `基地格格式应为「列.行」（如 36.13），收到「${hexText}」`, '14.1a')
      return false
    }
    const unit = toConsoleAirUnit({
      aircraft: record,
      instanceId: createId('air'),
      hex,
      side: activeSide.value,
    })
    airUnits.value = [...airUnits.value, unit]
    pushLog(
      'info',
      `摆放飞机 ${unit.name}（机型 ${unit.aircraftType}，轰炸 ${unit.barrageStrength}，航程 ${unit.rangeHexes}）` +
        `于 ${hexLabel(hex)}（14.1a：该格即其空军基地格）`,
      '14.1a',
    )
    return true
  }

  /** C7：移除一架飞机（连带取消其参炸勾选） */
  function removeAirUnit(instanceId: string): void {
    if (!canReplaceBarrage()) return
    const unit = airUnits.value.find((item) => item.instanceId === instanceId)
    airUnits.value = airUnits.value.filter((item) => item.instanceId !== instanceId)
    barrageAirIds.value = barrageAirIds.value.filter((id) => id !== instanceId)
    barrageState.value = null
    if (unit !== undefined) pushLog('info', `移除飞机 ${unit.name}`, '14.1')
  }

  /** C7：勾选/取消一架参炸飞机（10.2b 的短程判定随之更新） */
  function toggleBarrageAirUnit(instanceId: string): void {
    if (!canReplaceBarrage()) return
    if (barrageAirIds.value.includes(instanceId)) {
      barrageAirIds.value = barrageAirIds.value.filter((id) => id !== instanceId)
    } else {
      barrageAirIds.value = [...barrageAirIds.value, instanceId]
    }
    barrageState.value = null
    barrageError.value = null
  }

  /**
   * B15c：把地图上**某一格**的选择集**镜像**到参炸名单（方案 §4.2「选择集就是参与集合」）
   *
   * 逐格同步：只按选择集增删**该格**的候选（候选表就是 `barrageUnitChoices` —— 同一份判据，
   * 不在界面里另筛一次）；别格的参炸单位原样保留（多格联合炮击时各自摊开选）。
   * 落点仍是既有的 `toggleBarrageUnit`（10.0e-F 的同类型限制与 10.0e-A/B 的账本由引擎在宣布时裁）
   * ⇒ 镜像不产生第二套判定。
   */
  function syncBarrageParticipants(hex: HexRef, selectedIds: readonly string[]): void {
    /*
     * #9 / 10.0e-D：本环节**明确**不许炮兵轰炸（移动环节；`barrage.declare` 只为低空扫射的空军放行）
     * ⇒ 点地图不往名单里镜像，避免"点己方炮兵就弹宣布轰炸"。
     * 无环节上下文（引擎验证页 / 夹具）时 `barrageKindsInSegment` 为空，不按环节收口。
     */
    const kinds = barrageKindsInSegment.value
    if (kinds.length > 0 && !kinds.includes('artillery')) return
    // 镜像自带作用域：摊开的是哪一格，阵列就收到哪一格（条 13；别格已选成员仍保留）
    barrageScopeHex.value = { col: hex.col, row: hex.row }
    const candidates = barrageUnitChoices.value
      .map((choice) => choice.unit)
      .filter((unit) => sameHex(unit.hex, hex))
    for (const unit of candidates) {
      const wanted = selectedIds.includes(unit.instanceId)
      const has = barrageUnitIds.value.includes(unit.instanceId)
      if (wanted !== has) toggleBarrageUnit(unit.instanceId)
    }
  }

  /**
   * B15c：清掉**尚未宣布**的参炸选择（会话框的「取消」；宣布之后用 `cancelBarrage`）
   *
   * 为什么单列一个：`barrageState === null` 时没有引擎状态可取消，但玩家仍需要一条"我选错了、
   * 全部退掉"的退路（方案 §4.3「Esc = 取消当前会话」）。
   */
  function clearBarrageSelectionNow(): void {
    if (!canReplaceBarrage()) return
    barrageUnitIds.value = []
    barrageAirIds.value = []
    barrageState.value = null
    barrageError.value = null
    pushLog('info', '退掉本次轰炸的参炸选子（10.0：尚未宣布，无账可回滚）', '10.0')
  }

  /** C7：切参炸单位类别（10.0e-F）与整体目标（10.0d）——换选即作废进行中的流程 */ function setBarrageKind(
    kind: BarrageKind,
  ): void {
    if (!canReplaceBarrage()) return
    barrageKind.value = kind
    barrageState.value = null
    barrageError.value = null
  }

  function setBarrageTargetKind(kind: BarrageTargetKind): void {
    if (!canReplaceBarrage()) return
    barrageTargetKind.value = kind
    barrageState.value = null
    barrageError.value = null
  }

  /** C7 第 1 步：宣布整体目标与轰炸值分配（10.0d / 10.0e） */
  function beginBarrageNow(): boolean {
    if (!canReplaceBarrage() || (combatState.value !== null && !combatState.value.finished))
      return false
    // 10.0：轰炸在**当前段的轰炸环节**（C 段限空中与舰炮、F 段限炮兵，来源限定由引擎判）
    if (!requireAction('barrage.declare', '宣布轰炸')) return false
    const targetHex = barrageTargetHex.value
    if (targetHex === null) {
      pushLog('warning', '请先选定轰炸目标格（10.0d）', '10.0d')
      return false
    }
    // B39 / A-1：先按**盘面**核对"整体目标"是否与该格相符（10.0c / 10.0d）
    const targetIssue = barrageTargetKindIssue.value
    if (targetIssue !== null) {
      barrageError.value = { rule: targetIssue.rule, reason: 'targetKindNotInHex' }
      pushLog(
        'warning',
        `宣布轰炸被拒：${targetIssue.reason}（${targetIssue.rule}）`,
        targetIssue.rule,
      )
      return false
    }
    const firingGround = barrageUnits.value
    const firingAir = barrageAirUnits.value
    if ([...firingGround, ...firingAir].some((unit) => unit.side !== segmentGateQuery.value.side)) {
      pushLog('warning', '只能由当前环节的行动方宣布轰炸', '7.0 / 10.0')
      return false
    }
    if (firingGround.length === 0 && firingAir.length === 0) {
      pushLog('warning', '请先选择参炸单位（10.0：地面点选算子 / 空中勾选飞机）', '10.0')
      return false
    }
    const inputs = barrageInputs.value
    const targetKey = `${targetHex.col}.${targetHex.row}`
    const firingIds = [
      ...firingGround.map((unit) => unit.instanceId),
      ...firingAir.map((unit) => unit.instanceId),
    ]
    const data = acceptBarrage(
      beginBarrage({
        kind: barrageKind.value,
        phase: phase.value,
        // 10.0 第二段：移动环节只有低空扫射的空军可借轰炸口子（引擎按环节判）
        segment: segmentStep.value?.id,
        targetKind: barrageTargetKind.value,
        targetHex,
        // 剧本级炮击折扣（Intro: Vitebsk 德军 −2T）：按当前剧本与开火方取初始列成本
        scenarioId: scenarioId.value,
        side: firingGround[0]?.side ?? firingAir[0]?.side,
        units: [
          // 10.1a：地面（火炮）不带距基地事实，其射程由引擎另行判定
          ...firingGround.map((unit) => toBarrageUnitRequest(unit, targetHex)),
          // 10.2b / 14.1e：空军带「距其基地（= 所在格）格数」与「是否战略轰炸机」
          ...firingAir.map((unit) =>
            // 专规 1.4a：盒内驻机的"距基地格数"按盒算（20/30 + 列差），与任务航程同源
            toAirBarrageUnitRequest(unit, targetHex, airDistanceFromRealBase(unit, targetHex)),
          ),
        ],
        facts: {
          /*
           * 10.0e-A：该格本阶段是否已被轰炸过 ⇒ 取**账本**（A 组接线）；
           * `inputs.hexAlreadyBarragedThisPhase` 保留为**裁判补记**入口（如手工改正漏记的一场），
           * 但它不再是唯一来源——不勾也拦得住。
           * 10.0b 低空扫射的例外由引擎判（`hipShoot` 时放行）。
           */
          hexAlreadyBarragedThisPhase:
            barragedHexesThisPhase.value.includes(targetKey) || inputs.hexAlreadyBarragedThisPhase,
          // 10.0e-B：任一参炸单位本阶段已经轰炸过 ⇒ 重复参炸（也就是"把轰炸值拆分到多次"）
          unitAlreadyBarragedThisPhase: firingIds.some((id) =>
            barragedUnitIdsThisPhase.value.includes(id),
          ),
          hipShoot: inputs.hipShoot,
          hasSpotter: barrageTargetFacts.value.hasSpotter,
          // 10.0e-F：一次轰炸只能用同一类型 ⇒ 地面与空中同时参炸即是混类型（事实可判，无须玩家勾选）
          mixedKinds: firingGround.length > 0 && firingAir.length > 0,
        },
      }),
      '宣布轰炸',
    )
    if (data === null) return false
    barrageState.value = data
    pushLog(
      'info',
      `宣布轰炸（10.0d）：目标${data.targetKind === 'combatUnits' ? '战斗单位' : targetKindLabel(data.targetKind)}；` +
        `轰炸值 ${data.totalValue} ⇒ 初始列 ${data.table.columnLabel}，成本 ${data.table.costT} T` +
        `（${firingGround.length} 个地面单位 + ${firingAir.length} 架飞机，类型 ${data.kind}）`,
      '10.0',
    )
    // ⑭ 接线：轰炸宣布与轰炸值分配（10.0d / 10.0e）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'barrageDeclare',
      rule: '10.0',
      data: {
        kind: data.kind,
        targetKind: data.targetKind,
        targetHex: { ...targetHex },
        totalValue: data.totalValue,
        initialColumn: data.table.initialColumn,
        columnLabel: data.table.columnLabel,
        costT: data.table.costT,
        groundUnitIds: firingGround.map((unit) => unit.instanceId),
        airUnitIds: firingAir.map((unit) => unit.instanceId),
      },
    })
    return true
  }

  /**
   * 12.3a ∪ 12.3b：**一组受益单位**（炮击的参炸火炮 / 战斗的参战堆叠）能为之付款的补给站
   *
   * 「**直接拖取 (12.3a) 和指挥部投递 (12.3b) 都可用于**接收及分配战斗补给」（12.4）；
   * 「多个单位同时轰炸时，补给必须来自**同一个指挥部**。如果不使用指挥部，则需要来自**同一个补给站**」（10.1b-A）。
   * ⇒ 只有在"同一个来源"下才成立，故：
   *   · **直拖支**：取**每个**受益单位各自 5 MP 直拖（或相邻，12.3c）可达的**交集**；
   *   · **HQ 投递支**：本部 HQ 能按 12.3a 拖到该站（含 12.3b-C/D 的两条限制，由 `canThrowViaHQ` 判），
   *     且按印刷投递距离能把补给投到**每一个**受益单位（12.3c 的相邻也计入）；
   * 两条并集 —— 这正是"多门火炮分散时经同一指挥部付款"（10.1b-A）缺的那一半。
   *
   * ★ 13.2g-B（编内卡车）：「只允许**同一多单位编队内的单位拖取**它们的 SP」⇒ 判据按**受益单位逐个**过
   *   （修前战斗侧用的是"参战堆叠里**有没有**同编队单位"，会让非同编队的同伴蹭到该车的油）；
   *   13.2g 末句同时允许「用指挥部把编内卡车的补给投递给同一编队内的单位」，故 HQ 支同样只受这一条限制。
   */
  /**
   * 12.3b：**经 HQ 投递**可用的补给站（格键集合）
   *
   * 某座 HQ 成立的条件：① 它自己能按 12.3a 拖到那座站（含 12.3b-C/D 的两条限制，`canThrowViaHQ` 判）；
   * ② 它能把补给投到**每一个**受益单位（印刷投递距离，或 12.3c 的相邻）。
   *
   * ★ 受益者只按**所在格**参与判据（12.3b 的投递距离以格计）⇒ 参数放宽为 `{ hex }`，
   *   既收盘上算子（`ConsoleUnit`），也收 15.1 整备那一路的基地投影（`AirBaseView`）。
   */
  function hqDeliveryDumpKeys(side: Side, beneficiaries: readonly { hex: HexRef }[]): Set<string> {
    const facts = supplyFacts.value
    const keys = new Set<string>()
    if (beneficiaries.length === 0) return keys
    for (const hq of units.value.filter((unit) => unit.side === side && isHqUnit(unit))) {
      const hqView = toThrowHqView(hq)
      const coversAll = beneficiaries.every((unit) => {
        // 12.3c：终点取「单位格或其任一相邻格」（与直接拖取同一口径）
        const reach = countSupplyDistanceToUnitViaTable(facts, {
          from: hq.hex,
          unitHex: unit.hex,
          side,
          mobility: hqView.throwMobility,
          maxMp: hqView.throwRangeMp,
        })
        if (!reach.ok) return false
        return canThrowViaHQ({
          hqMode: hq.mode.mode,
          distanceMp: reach.mp,
          throwRangeMp: hqView.throwRangeMp,
          ...(hqView.receivedByThrow === undefined
            ? {}
            : { receivedByThrow: hqView.receivedByThrow }),
        }).ok
      })
      if (!coversAll) continue
      for (const entry of drawableDumpsFor(facts, {
        hex: hq.hex,
        side,
        mobility: hqView.throwMobility,
      }))
        if (entry.ok) keys.add(hexLabel(entry.hex))
    }
    return keys
  }

  function deliverableDumpsFor(side: Side, beneficiaries: readonly ConsoleUnit[]): SpDump[] {
    if (beneficiaries.length === 0) return []
    const facts = supplyFacts.value
    const keys = new Set<string>()
    // ① 12.3a：**每个**受益单位都能自己拖到的站（同一次付款只有一个来源 ⇒ 取交集）
    const direct = beneficiaries.map(
      (unit) =>
        new Set(
          drawableDumpsFor(facts, { hex: unit.hex, side })
            .filter((entry) => entry.ok)
            .map((entry) => hexLabel(entry.hex)),
        ),
    )
    const first = direct[0]
    if (first !== undefined) {
      for (const key of first) {
        if (direct.every((set) => set.has(key))) keys.add(key)
      }
    }
    // ② 12.3b：HQ 投递（HQ 自己拖得到 + 覆盖每一个受益单位）
    for (const key of hqDeliveryDumpKeys(side, beneficiaries)) keys.add(key)
    // ③ 12.1b/13.2g-B：落到具体账本条目上，并对编内卡车来源逐个受益单位验编队资格
    return allSpDumps.value.filter(
      (dump) =>
        dump.side === side &&
        keys.has(hexLabel(dump.hex)) &&
        (dump.carrierIsOrganicTruck !== true ||
          beneficiaries.every((unit) =>
            canDrawFromCarrier({
              carrierIsOrganicTruck: true,
              carrierFormation: dump.carrierFormation ?? null,
              drawerFormation: unit.formation,
            }),
          )),
    )
  }

  /** 12.4 / 10.1b-A：该方在该次交互里的**受益单位**（炮击＝参炸火炮；战斗＝参战的那一叠） */
  function combatBeneficiariesOf(side: Side, attackerSide: Side): ConsoleUnit[] {
    // 7.0a：攻方可能是反应段的非阶段玩家 ⇒ 不能拿 `activeSide` 判"这方是不是攻方"
    return side === attackerSide
      ? combatAttackers.value
      : units.value.filter((unit) =>
          (battleTarget.value?.defenderIds ?? []).includes(unit.instanceId),
        )
  }

  /**
   * C7：轰炸战斗补给的**付款来源**（10.1b：只能来自 SP，且只能是同一 HQ 或同一 dump）
   */
  const barrageSupplyDumpId = ref<string | null>(null)

  /**
   * 本次炮击**已实扣**的补给（10.1b）
   *
   * 用户口径：任何一步取消后，已扣的补给都要退回原状。记账点在 `confirmBarrageSupplyStep`
   * 的真实扣款之后；`refundBarrageSupply` 按同一份记录把 T 加回原站，并从 10.0e-A/B 账本里
   * 摘掉这一次（付不出不视为已轰炸过，取消同理）。
   */
  const barragePaidSupply = ref<{
    dumpId: string
    t: number
    /** 21.10：本次花掉的 Shells 枚数（撤销时原数退回） */
    markers: number
    /** 21.10：被浪费的 T（仅记账，不退） */
    wasteT: number
    hexKey: string
    unitIds: string[]
  } | null>(null)

  /**
   * C7：可作轰炸付款来源的补给站
   *
   * ★ 10.1b-A 要求「来自**同一指挥部**或**同一补给站**」⇒ 这一座站必须被**每个**参炸地面单位
   *   拖得到（12.3a 的 5 MP 直拖或相邻；12.3c）。修前这里给的是「该方**全部**补给站」，
   *   等于可以在全图任意远处给一场轰炸付款。
   *   10.2c：空军轰炸无补给消耗 ⇒ 空军参炸时不需要来源（候选给空集即可）。
   */
  const barrageSupplyDumpChoices = computed<SpDump[]>(() => {
    if (barrageState.value?.kind !== 'artillery') return []
    const units = barrageUnits.value
    if (units.length === 0) return []
    /*
     * 10.1b-A：「多个单位同时轰炸时，补给必须来自**同一个指挥部**。如果不使用指挥部，则需要来自**同一个补给站**。」
     * ⇒ 直拖支取交集、HQ 投递支由 `deliverableDumpsFor` 一并给出（修前**没有** HQ 支：多门炮分散时
     *   根本选不出来源，炮击补给这一步永远过不去）。
     */
    return deliverableDumpsFor(segmentGateQuery.value.side ?? activeSide.value, units)
  })

  /**
   * 10.1b-A：这批来源里哪些是**经 HQ 投递**达成的（付款时据此声明 `fromSameHq`）
   *
   * 判据与 `deliverableDumpsFor` 的 ② 支**同源**（同一个 `hqDeliveryDumpKeys`），故不会与候选漂移。
   */
  const barrageSupplyHqChoices = computed<SpDump[]>(() => {
    if (barrageState.value?.kind !== 'artillery') return []
    const firingUnits = barrageUnits.value
    if (firingUnits.length === 0) return []
    const keys = hqDeliveryDumpKeys(segmentGateQuery.value.side ?? activeSide.value, firingUnits)
    return spDumps.value.filter((dump) => keys.has(hexLabel(dump.hex)))
  })

  /** 21.10：本次炮击计划花掉的 Shells 枚数（0 = 不用；按枚整花，最后一枚可溢出作废） */
  const barrageShellMarkers = ref(0)

  /** 10.1b：本次炮击仍需从补给站付的 T（初始列成本 − Shells 抵付）——「可选补给源」角标用 */
  const barragePayNeedT = computed<number>(() => {
    const table = barrageState.value?.table
    if (table === undefined) return 0
    const shellsT = Math.trunc(barrageShellMarkers.value) * SUPPLY_CACHE_SHELLS_T
    return Math.max(0, table.costT - shellsT)
  })

  /** 21.10：本次可用额度 = Shells 面值 + 所选站的 T（降档按此挑列） */
  const barrageShellBudgetT = computed<number>(() => {
    const dump = barrageSupplyDump.value
    const dumpT = dump === null ? 0 : holdingsToT({ sp: dump.sp, t: dump.t })
    return Math.max(0, Math.trunc(barrageShellMarkers.value)) * SUPPLY_CACHE_SHELLS_T + dumpT
  })

  /** 21.10：Shells 预览（抵付 / 浪费 / SP 缺口 / 降档列），界面只读 */
  const barrageShellPreview = computed<{
    markers: number
    appliedT: number
    wasteT: number
    spT: number
    shortT: number
    downgrade: { columnLabel: string; costT: number; valueUsed: number } | null
  } | null>(() => {
    const state = barrageState.value
    if (state === null || state.kind !== 'artillery') return null
    const held = supplyCacheHoldings.value[activeSide.value]
    const markers = Math.min(Math.max(0, Math.trunc(barrageShellMarkers.value)), held)
    const dump = barrageSupplyDump.value
    const dumpT = dump === null ? 0 : holdingsToT({ sp: dump.sp, t: dump.t })
    const plan = planBarrageSupplyPayment({ costT: state.table.costT, markers, spT: dumpT })
    if (!plan.ok) return null
    const data = plan.data
    const downgrade =
      data.shortT > 0
        ? selectAffordableBarrageColumn({
            target: state.targetKind,
            valueRange: state.totalValue,
            availableT: markers * SUPPLY_CACHE_SHELLS_T + dumpT,
          })
        : null
    return {
      markers: data.markersSpent,
      appliedT: data.shellsAppliedT,
      wasteT: data.wasteT,
      spT: data.spT,
      shortT: data.shortT,
      downgrade:
        downgrade === null
          ? null
          : {
              columnLabel: downgrade.columnLabel,
              costT: downgrade.costT,
              valueUsed: downgrade.valueUsed,
            },
    }
  })

  /** C7：点选的轰炸付款补给站（未选或已不存在 ⇒ null；12.1b 含装载中的 SP） */
  const barrageSupplyDump = computed<SpDump | null>(() =>
    barrageSupplyDumpId.value === null ? null : (dumpById(barrageSupplyDumpId.value) ?? null),
  )

  /** C7：声明轰炸的付款来源（12.3a：只能是自己方的补给站） */
  function pickBarrageSupplyDump(dumpId: string | null): boolean {
    if (dumpId === null) {
      barrageSupplyDumpId.value = null
      return true
    }
    // 12.1b（用户 2026-11-13）：装载中的 SP 也是补给站 ⇒ 与候选项同一份表
    const dump = dumpById(dumpId)
    if (dump === undefined || dump.side !== activeSide.value) {
      pushLog(
        'warning',
        `该补给站不是 ${activeSide.value === 'axis' ? '轴心国' : '苏联'}的（12.3a）`,
        '12.3a',
      )
      return false
    }
    barrageSupplyDumpId.value = dumpId
    /*
     * 10.1b-A：这一座站是经哪一支进来的 —— 「来自同一指挥部」还是「来自同一补给站」。
     * 两条支命中哪条就声明哪条（修前恒为 `fromSameDump: true`，"同一指挥部"那半从未被表达）。
     */
    const viaHq = barrageSupplyHqChoices.value.some((item) => item.id === dumpId)
    barrageInputs.value = {
      ...barrageInputs.value,
      availableT: holdingsToT({ sp: dump.sp, t: dump.t }),
      fromSameHq: viaHq,
      fromSameDump: !viaHq,
    }
    pushLog(
      'info',
      `轰炸补给来源：${hexLabel(dump.hex)}（${dump.sp} SP + ${dump.t} T = ${holdingsToT({ sp: dump.sp, t: dump.t })} T）`,
      '10.1b',
    )
    return true
  }

  /**
   * B14b（用户口径⑪）：在算子图阵列里**点选/再点取消**轰炸的付款来源
   *
   * 旧界面的下拉有一个「（未声明 ⇒ 火炮付不出）」的空档，阵列没有空档可言 ⇒
   * 用「点同一座站即取消」补上这条退路（与 15.4 被指定单位、参战机的阵列同一手感）。
   */
  function toggleBarrageSupplyDump(dumpId: string): void {
    if (barrageSupplyDumpId.value === dumpId) {
      pickBarrageSupplyDump(null)
      return
    }
    pickBarrageSupplyDump(dumpId)
  }

  /** C7 第 2 步：按初始列支付火炮战斗补给（10.1b；空军/海军免费 10.2c）
   *
   * ★ 12.3a/12.3b 是仅有的两条取补途径 ⇒ 火炮的这笔 T **必须落到一座声明的补给站上**。
   *   原先 `barrageInputs.availableT` 是玩家手填的裸数字：引擎把状态标成 `paid: true`，
   *   而**没有任何一步扣款** ⇒ 那是一次**免费轰炸**。现在：选站 ⇒ 可用量由该站持仓推出 ⇒
   *   付完从该站扣（与 12.4 的战斗补给同一条纪律）。
   */
  function confirmBarrageSupplyStep(): boolean {
    const state = barrageState.value
    if (state === null) return false
    const inputs = barrageInputs.value
    const dump = barrageSupplyDump.value
    /*
     * 21.10：本次计划花掉的 Shells（按枚整花；上限＝该方持有）。
     * 原文「a barrage being thrown supply by an HQ」⇒ 只有 **HQ 投递** 的炮击可用；
     * 面板上对应「来自同一指挥部（10.1b-A）」，未勾即拒。
     */
    const heldMarkers = supplyCacheHoldings.value[activeSide.value]
    const markers = Math.min(Math.max(0, Math.trunc(barrageShellMarkers.value)), heldMarkers)
    if (markers > 0 && state.kind === 'artillery' && !inputs.fromSameHq) {
      barrageError.value = { rule: '21.10', reason: 'shellsRequireHqThrow' }
      pushLog(
        'danger',
        '21.10：Shells 只能用于**由 HQ 投递补给**的炮击 ⇒ 先选一座经 HQ 投递的来源，并勾「来自同一指挥部」',
        '21.10',
      )
      return false
    }
    // 10.2c：空军轰炸无需战斗补给 ⇒ 不要求来源；火炮按初始列收费 ⇒ 必须先有来源
    if (state.kind === 'artillery' && state.table.costT > 0) {
      if (dump === null) {
        barrageError.value = { rule: '12.3a', reason: 'barrageSupplyNeedsADump' }
        pushLog(
          'danger',
          '12.3a：火炮的战斗补给必须从**己方补给站**取 ⇒ 先在「轰炸补给来源」里点选一座补给站',
          '12.3a',
        )
        return false
      }
      // 10.1b-A / 12.3a：这一座站必须被**每个**参炸单位拖得到（同一来源）
      if (!barrageSupplyDumpChoices.value.some((item) => item.id === dump.id)) {
        barrageError.value = { rule: '12.3a', reason: 'barrageSupplyDumpOutOfRange' }
        pushLog(
          'danger',
          `12.3a/10.1b-A：参炸单位拖不到 ${hexLabel(dump.hex)}（须 5 MP 直拖内或相邻，且各参炸单位共用同一来源）` +
            `⇒ 可达的候选：${barrageSupplyDumpChoices.value.map((item) => hexLabel(item.hex)).join('、') || '（无）'}`,
          '12.3a',
        )
        return false
      }
      // 3.4b：错误集群的 SP 不得支付多单位编队的轰炸成本（受益方＝本次参炸单位）
      const restricted = panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'barrage',
        beneficiaryUnitIds: state.units.map((unit) => unit.unitId),
      })
      if (restricted !== null) {
        barrageError.value = { rule: restricted.rule, reason: restricted.reason }
        pushLog(
          'danger',
          `轰炸补给被拒（3.4b）：${panzerGroupSpRefusal(restricted, '轰炸', dump.id)}——本次不改动任何账本`,
          '3.4b',
        )
        return false
      }
    }
    /*
     * 21.10：额度不足时**降档**——按「Shells 面值 + 本站 T」挑最高可负担列，
     * 用部分轰炸值开火（原文 "fire partial factors"）。成本仍取**新的初始列**（10.1b），
     * 横移随后作用在该列上；总轰炸值一并压到所选列的上界。
     */
    let working = state
    if (markers > 0 && state.kind === 'artillery' && state.table.costT > 0 && dump !== null) {
      const budget = markers * SUPPLY_CACHE_SHELLS_T + holdingsToT({ sp: dump.sp, t: dump.t })
      if (state.table.costT > budget) {
        const chosen = selectAffordableBarrageColumn({
          target: state.targetKind,
          valueRange: state.totalValue,
          availableT: budget,
        })
        if (chosen === null) {
          barrageError.value = { rule: '21.10', reason: 'shellsCannotAffordAnyColumn' }
          pushLog(
            'danger',
            `21.10：额度 ${budget} T 连最低轰炸列都付不出 ⇒ 本次炮击取消（可加 Shells 或换来源）`,
            '21.10',
          )
          return false
        }
        working = {
          ...state,
          totalValue: chosen.valueUsed,
          // 重建 table 时同步套用剧本级折扣，避免降档把 −2T 抹掉
          table: barrageTableWithScenarioRule(
            barrageTableMeta({ target: state.targetKind, valueRange: chosen.valueUsed }),
            { scenarioId: scenarioId.value, side: state.side },
          ),
        }
        pushLog(
          'info',
          `21.10：额度 ${budget} T 不足以支付 ${state.table.columnLabel} 列的 ${state.table.costT} T` +
            ` ⇒ 降档到 ${chosen.columnLabel} 列（轰炸值 ${state.totalValue} → ${chosen.valueUsed}，成本 ${chosen.costT} T）`,
          '21.10',
        )
      }
    }
    const data = acceptBarrage(
      planBarrageSupply(working, {
        // 12.1a：可用量按所选站的持仓（含 SP 折算）推出，不再采信手填数字；
        // 21.10：Shells 面值也计入本次可用额度（先花 Shells、再补 SP）
        availableT:
          (dump === null ? inputs.availableT : holdingsToT({ sp: dump.sp, t: dump.t })) +
          markers * SUPPLY_CACHE_SHELLS_T,
        fromSameHq: inputs.fromSameHq,
        fromSameDump: inputs.fromSameDump,
        usedInternalStocks: inputs.usedInternalStocks,
      }),
      '轰炸补给',
    )
    if (data === null) return false
    const supply = data.state.supply
    // 10.1b / 21.10：先花 Shells（按枚整花、溢出作废），不足由 SP 补
    if (supply?.paid === true && supply.waived !== true && supply.requiredT > 0) {
      if (dump === null) {
        barrageError.value = { rule: '12.3a', reason: 'barrageSupplyNeedsADump' }
        pushLog('danger', '12.3a：这笔轰炸补给没有付款来源，交易取消', '12.3a')
        return false
      }
      const requiredT = supply.requiredT
      const shellFaceT = markers * SUPPLY_CACHE_SHELLS_T
      const shellsAppliedT = Math.min(shellFaceT, requiredT)
      const wasteT = shellFaceT - shellsAppliedT
      const spNeed = requiredT - shellsAppliedT
      let spPaid = 0
      if (spNeed > 0) {
        const payment = planSpPayment({
          holdings: { sp: dump.sp, t: dump.t },
          wantT: spNeed,
        })
        if (!payment.ok) {
          barrageError.value = { rule: payment.rule, reason: payment.reason }
          pushLog(
            'danger',
            `轰炸补给付不出：Shells 抵 ${shellsAppliedT} T 后仍缺 ${spNeed} T，${payment.reason}（${payment.rule}）` +
              `——本次不改动任何账本`,
            payment.rule,
          )
          return false
        }
        setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
        spPaid = spNeed
      }
      if (markers > 0) {
        supplyCacheHoldings.value = {
          ...supplyCacheHoldings.value,
          [activeSide.value]: heldMarkers - markers,
        }
        pushLog(
          'info',
          `21.10：在 ${hexLabel(dump.hex)} 的 HQ 花掉 ${markers} 枚补给缓存 ⇒ 抵付 ${shellsAppliedT} T` +
            `（溢出作废 ${wasteT} T；即使 HQ 不在追溯补给中也可用）`,
          '21.10',
        )
      }
      // 用户口径：取消要退回原状 ⇒ 记下实扣的那一笔（站 + T + Shells + 本场涉及的账本键）
      barragePaidSupply.value = {
        dumpId: dump.id,
        t: spPaid,
        markers,
        wasteT,
        hexKey: barrageTargetHex.value === null ? '' : hexLabel(barrageTargetHex.value),
        unitIds: data.state.units.map((unit) => unit.unitId),
      }
      pushLog(
        'info',
        spPaid > 0
          ? `10.1b：从 ${hexLabel(dump.hex)} 扣 ${spPaid} T 作本次轰炸的战斗补给`
          : `10.1b：本次战斗补给全部由 Shells 抵付，未动 SP`,
        '10.1b',
      )
      barrageShellMarkers.value = 0
    }
    pushLog(
      'success',
      supply?.waived === true
        ? `轰炸无需战斗补给（10.2c：空军轰炸）`
        : `按初始列支付战斗补给 ${supply?.requiredT ?? 0} T（10.1b）`,
      supply?.rule ?? '10.1b',
    )
    barrageState.value = data.state
    // ⑭ 接线：轰炸战斗补给（10.1b / 10.2c）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'barrageSupply',
      rule: supply?.rule ?? '10.1b',
      data: {
        waived: supply?.waived === true,
        requiredT: supply?.requiredT ?? 0,
      },
    })
    /*
     * 10.0e-A/B 记账（A 组接线）：走到这里＝补给这一关过了（或空军免补给）⇒ 从此刻起这一格
     * 与这些单位在本阶段"已轰炸过"。之所以**不在宣布时**就记：10.1b 明写「付不出则全部取消，
     * 且**不视为已轰炸过**」——宣布了却付不出补给的那一场，不该占用本阶段的这一次。
     * 10.0e-A 的例外（已宣布但被防空完全摧毁/返航也算）也在这个时点之后，故一并覆盖。
     */
    const barragedHex = barrageTargetHex.value
    /*
     * ★ 14.7d-A（第六批条 23-③）：「低空扫射**不计入**每个阶段内对一个格最多一次轰炸的限制。」
     *   ⇒ 低空扫射**不写格账本**（否则同格第二次低空扫射会被 10.0e-A 拒掉，正是修前的表现）。
     *   ★ 但 10.0e-B「一个单位在一个阶段只能进行一次轰炸」**没有**给低空扫射开口子
     *     （10.0e-A 的例外只写了反舰船轰炸与低空扫射）⇒ 单位账本照记。
     *   另注：10.0e-A 的另一处例外是**反舰船轰炸（18.3）**，本作无海军单位，暂不接线（如实登记）。
     */
    if (barragedHex !== null && inputs.hipShoot !== true) {
      const key = `${barragedHex.col}.${barragedHex.row}`
      barragedHexesThisPhase.value = [...new Set([...barragedHexesThisPhase.value, key])]
    }
    barragedUnitIdsThisPhase.value = [
      ...new Set([
        ...barragedUnitIdsThisPhase.value,
        ...data.state.units.map((unit) => unit.unitId),
      ]),
    ]
    return true
  }

  /**
   * 10.0a：目标玩家可选地形里**对防守方最有利**的一条
   *
   * 用户口径（2026-11-12）：炮击链路不再让玩家挑地形，按对防守方最有利的地形自动结算。
   * 「最有利」＝列横移最左（Extr Close −2 > Very Close/Close −1 > Open 0）；
   * 判据仍取自引擎同一份 `BARRAGE_COLUMN_SHIFTS.terrainByCombatLine`。
   */
  function bestDefenderTerrainLine(): CombatLine | undefined {
    const lines = barrageTerrainLineOptions.value
    const weight = (line: CombatLine): number =>
      BARRAGE_COLUMN_SHIFTS.terrainByCombatLine[line] ?? 0
    return [...lines].sort((a, b) => weight(a) - weight(b))[0]
  }

  /** C7 第 3 步：确认列横移（10.0a 目标玩家选地形 / 10.0b 观察员 / 10.2b 短程）
   *
   * 默认 `autoTerrain = true`：用户 2026-11-12 口径「按对防守方最有利的地形结算，不再让玩家选择地形」。
   */
  function confirmBarrageShiftsStep(autoTerrain = true): boolean {
    const state = barrageState.value
    if (state === null) return false
    const inputs = barrageInputs.value
    const facts = barrageTargetFacts.value
    const targetHex = barrageTargetHex.value
    const terrainLine = autoTerrain ? bestDefenderTerrainLine() : inputs.terrainLine
    const data = acceptBarrage(
      declareBarrageShifts(state, {
        enemyREInHex: facts.enemyREInHex,
        hedgehogLevel: facts.hedgehogLevel,
        stratModeInHex: facts.stratModeInHex,
        hasSpotter: facts.hasSpotter,
        // 10.0a：地形横移只能取自**目标格内**的地形（候选集与 9.3b 一致）
        ...(targetHex === null ? {} : { terrainCandidates: defenseTerrainChoices(targetHex) }),
        // K5：自动取值时让引擎明细写明「守方地形＝X（自动取最有利）」
        terrainAuto: autoTerrain,
        ...(terrainLine === undefined || terrainLine === '' ? {} : { terrainLine }),
      }),
      '列横移',
    )
    if (data === null) return false
    barrageState.value = data.state
    const shifts = data.state.shifts
    pushLog(
      isFacilityBarrage(data.state) ? 'info' : 'success',
      isFacilityBarrage(data.state)
        ? '对设施轰炸无横移、不需观察员（10.0c）'
        : `列横移合计 ${shifts?.total ?? 0}（${(shifts?.detail ?? []).join('；') || '无'}）` +
            ` ⇒ 最终列 ${data.state.finalColumn}（初始 ${data.state.table.initialColumn}）`,
      isFacilityBarrage(data.state) ? '10.0c' : '10.0a',
    )
    // ⑭ 接线：列横移（10.0a / 10.0b / 10.0c）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'barrageShifts',
      rule: isFacilityBarrage(data.state) ? '10.0c' : '10.0a',
      data: {
        facility: isFacilityBarrage(data.state),
        shiftTotal: shifts?.total ?? 0,
        finalColumn: data.state.finalColumn,
        initialColumn: data.state.table.initialColumn,
        // K5：把这次实际采用的地形线与「是否自动」也写进结算数据
        terrainLine: terrainLine ?? null,
        terrainAuto: autoTerrain,
      },
    })
    return true
  }

  /**
   * 炮击第 2 步之后**自动走完**横移 → 掷骰（用户 2026-11-12 流程）
   *
   * 用户口径：确认支付后不再有中间的横移 / 掷骰 / 结果分步块要让玩家点。
   * 引擎仍保留那三步（验证页与备用路径照旧），这里只是一次性把它们串完：
   *   · 横移：目标地形按「对防守方最有利」自动取（不再让玩家选）；
   *   · 掷骰：`rollBarrageDiceStep` 自带 `1/2` 的自动补掷；
   *   · 结果：设施与「无军力损失」直接收束；有军力损失则停在 `outcome` 等玩家选承受单位。
   *
   * 返回 `'finished'`（已收束）/ `'loss'`（等玩家选受损单位）/ `'failed'`（引擎拒绝）。
   */
  function runBarrageResolution(): 'finished' | 'loss' | 'failed' {
    const state = barrageState.value
    if (state === null) return 'failed'
    if (state.step === 'shifts' && !confirmBarrageShiftsStep(true)) return 'failed'
    if (barrageState.value?.step === 'dice' && !rollBarrageDiceStep()) return 'failed'
    const current = barrageState.value
    if (current === null || current.step !== 'outcome') return 'failed'
    if (isFacilityBarrage(current)) {
      return confirmBarrageOutcomeStep() ? 'finished' : 'failed'
    }
    const outcome = current.outcome
    if (outcome === undefined || outcome.table !== 'barrage') return 'failed'
    if (outcome.value.stepLosses > 0) return 'loss'
    return confirmBarrageOutcomeStep() ? 'finished' : 'failed'
  }

  /**
   * 用户口径：任何一步取消后，已扣的补给退回原状
   *
   * 只在**尚未落盘结果**时有意义（`outcome` 确认后会话即收束，不会再走这里）：
   *   · 把 `barragePaidSupply` 记下的 T 加回原补给站；
   *   · 从 10.0e-A/B 账本里摘掉这一次（10.1b：取消不视为已轰炸过）。
   */
  function refundBarrageSupply(): void {
    const paid = barragePaidSupply.value
    if (paid === null) return
    // 12.1b（用户 2026-11-13）：原路退回——装载中的 SP 也按同一 id 还原
    const dump = dumpById(paid.dumpId)
    if (dump !== undefined && paid.t > 0) {
      const totalT = holdingsToT({ sp: dump.sp, t: dump.t }) + paid.t
      setSpDumpHoldings(dump.id, { sp: Math.floor(totalT / SP_TO_T), t: totalT % SP_TO_T })
    }
    // 21.10：Shells 与 SP 一样原数退回（尚未掷骰 ⇒ 视同未使用）
    if (paid.markers > 0) {
      supplyCacheHoldings.value = {
        ...supplyCacheHoldings.value,
        [activeSide.value]: supplyCacheHoldings.value[activeSide.value] + paid.markers,
      }
    }
    if (paid.hexKey !== '')
      barragedHexesThisPhase.value = barragedHexesThisPhase.value.filter(
        (key) => key !== paid.hexKey,
      )
    barragedUnitIdsThisPhase.value = barragedUnitIdsThisPhase.value.filter(
      (id) => !paid.unitIds.includes(id),
    )
    pushLog(
      'info',
      `退回本次炮击的战斗补给 ${paid.t} T` +
        (paid.markers > 0 ? `、Shells ${paid.markers} 枚（21.10）` : '') +
        `（10.1b：取消不视为已轰炸过）`,
      paid.markers > 0 ? '21.10' : '10.1b',
    )
    barragePaidSupply.value = null
  }

  /** 用户口径：取消整单并把已扣补给、已选炮兵退回原状（炮击统一流程用） */
  function cancelOpsBarrage(): void {
    /*
     * 不走 `canReplaceBarrage` / `clearBarrage`：付款后引擎把本场标成「已提交」，
     * 那条闸是为**已落盘结果**保留的；统一流程在结果确认前取消是允许的，且必须退款。
     * 结果尚未落盘（`outcome` 未确认），故这里只清交互态与账本，不动盘面。
     */
    refundBarrageSupply()
    barrageUnitIds.value = []
    barrageScopeHex.value = null
    barrageAirIds.value = []
    fireResolution.resetBarrage()
    barrageKind.value = 'artillery'
    barrageTargetKind.value = 'combatUnits'
    barrageSupplyDumpId.value = null
    barragePaidSupply.value = null
    barrageShellMarkers.value = 0
    barrageError.value = null
    pushLog('info', '取消本次炮击（10.0 流程中止；补给与选子已退回）', '10.0')
  }

  /**
   * 10.0a：本次结果的军力损失点数（**按可选单位实际军力封顶**）
   *
   * 引擎 `validateBarrageLossAllocation` 在给了 `units` 时会取 `min(required, 可承受合计)`
   * ⇒ 界面与它同口径，避免玩家把必填值填成一个永远凑不满的数。
   */
  const barrageLossRequired = computed<number>(() => {
    const state = barrageState.value
    if (state === null || state.outcome?.table !== 'barrage') return 0
    const capacity = barrageLossTargets.value.reduce((sum, unit) => sum + unit.steps, 0)
    return Math.min(state.outcome.value.stepLosses, capacity)
  })

  /** 10.0a：已分配的军力点数 */
  const barrageLossAllocated = computed<number>(() =>
    Object.values(barrageInputs.value.losses).reduce((sum, steps) => sum + steps, 0),
  )

  function barrageLossPointsOf(unitId: string): number {
    return barrageInputs.value.losses[unitId] ?? 0
  }

  /** 10.0a：点一枚单位 ⇒ 给它加 1 点军力损失（不超过该单位当前军力） */
  function addBarrageLossPoint(unitId: string): void {
    const target = barrageLossTargets.value.find((unit) => unit.instanceId === unitId)
    if (target === undefined) return
    if (barrageLossAllocated.value >= barrageLossRequired.value) return
    const current = barrageLossPointsOf(unitId)
    if (current >= target.steps) return
    barrageInputs.value = {
      ...barrageInputs.value,
      losses: { ...barrageInputs.value.losses, [unitId]: current + 1 },
    }
  }

  function removeBarrageLossPoint(unitId: string): void {
    const current = barrageLossPointsOf(unitId)
    if (current <= 0) return
    const next = { ...barrageInputs.value.losses }
    if (current === 1) delete next[unitId]
    else next[unitId] = current - 1
    barrageInputs.value = { ...barrageInputs.value, losses: next }
  }

  /** 10.0a：损失分配足额才能确认（引擎仍会复判） */
  const barrageLossReady = computed<boolean>(
    () => barrageLossRequired.value > 0 && barrageLossAllocated.value === barrageLossRequired.value,
  )

  /** 10.0a：确认受损单位（选完本次炮击结束） */
  function confirmBarrageLossNow(): boolean {
    if (!barrageLossReady.value) return false
    return confirmBarrageOutcomeStep()
  }

  /**
   * 炮击统一流程第 1 步的入口：清掉上一场残留，锁定目标格与整体目标
   *
   * 10.0d 要求**预先指定**整体目标：格内有敌方战斗单位 → 打战斗单位；否则若有敌方空军基地 → 打基地
   * （10.0c）。运输破坏按原文只「作为空军任务执行」，故不在火炮炮击里提供。
   */
  function prepareOpsBarrage(hex: HexRef, targetKind: BarrageTargetKind): boolean {
    if (!canReplaceBarrage()) return false
    setBarrageActive(true)
    // K3：上一场用过的炮兵不能留到这一场（已炸过的炮会被 10.0e-B 拒，留在名单里只会"点下一步必被拒"）
    clearBarrage()
    pickBarrageTargetAt(hex)
    barrageScopeHex.value = { col: hex.col, row: hex.row }
    barrageKind.value = 'artillery'
    barrageTargetKind.value = targetKind
    // K6：新一场不得沿用上一场的付款来源（否则未点站就"已有来源"，跨场残留）
    barrageSupplyDumpId.value = null
    barragePaidSupply.value = null
    barrageInputs.value = { ...barrageInputs.value, hipShoot: false }
    barrageError.value = null
    return true
  }

  /** 10.0d / 10.0c：该格默认的整体目标（有敌战斗单位→战斗单位；否则敌空军基地→基地） */
  function defaultBarrageTargetKindAt(hex: HexRef): BarrageTargetKind {
    const side = segmentGateQuery.value.side ?? activeSide.value
    const hasEnemyCombat = units.value.some(
      (unit) => unit.side !== side && sameHex(unit.hex, hex) && unit.isCombat,
    )
    if (hasEnemyCombat) return 'combatUnits'
    const hasEnemyBase = airBases.value.some((base) => base.side !== side && sameHex(base.hex, hex))
    return hasEnemyBase ? 'airBase' : 'combatUnits'
  }

  /**
   * 12.3a / 10.1b：本场炮击的付款补给站（界面在地图上高亮并显示 SP 数）
   *
   * 判据仍是 `barrageSupplyDumpChoices`（同一来源 + 每个参炸单位拖得到），这里只补一格文本。
   */
  const barrageSupplyMapDumps = computed<readonly { dump: SpDump; label: string }[]>(() =>
    barrageSupplyDumpChoices.value.map((dump) => ({
      dump,
      label: `${dump.sp} SP${dump.t > 0 ? ` + ${dump.t} T` : ''}`,
    })),
  )

  /** 当前炮击错误的中文行（无错误 ⇒ null） */
  const barrageErrorLine = computed<string | null>(() => {
    const error = barrageError.value
    return error === null ? null : ruleErrorTextOf(error)
  })

  /**
   * 战斗错误的中文行（与炮击共用 `ruleErrorTextOf`，三张表在 `engine/rules/rule-error-text`）
   */
  const combatErrorLine = computed<string | null>(() => {
    const error = combatError.value
    return error === null ? null : ruleErrorTextOf(error)
  })

  /** 空中任务错误的中文行（14.x / 15.x，与炮击、战斗同表） */
  const airErrorLine = computed<string | null>(() => {
    const error = airError.value
    return error === null ? null : ruleErrorTextOf(error)
  })

  /**
   * B28：**12.11a 的销毁骰**（1d6）——一律自动，不再让玩家填骰面
   *
   * 与 `drawBarrageDie` 同一套：走种子化 `rng` 并按掷骰计数，骰面可在结算日志里复算。
   */
  function drawDumpDestructionDie(): number {
    const draw = roll1d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }

  /**
   * C7 第 4 步：掷骰结算（10.0a / 10.0c）
   *
   * `1/2` 结果须再掷取整骰（10.0a）：本动作在需要时**自动补掷**，玩家若想自定骰值可先填 `inputs.die`/`halfDie`。
   */
  function rollBarrageDiceStep(): boolean {
    return fireResolution.rollBarrageDiceStep()
  }

  /** C7：把设施结果写进日志（10.0c A/B/C） */
  function barrageFacilityFacts(hex: HexRef) {
    const base = airBases.value.find((item) => sameHex(item.hex, hex))
    return {
      baseLevel: base?.level ?? barrageInputs.value.baseLevel,
      isAirstrip: base?.isAirstrip ?? barrageInputs.value.isAirstrip,
      portDamageBefore: barrageInputs.value.portDamageBefore,
    }
  }
  function applyBarrageFacilityPatch(patch: FacilityPatch, hex: HexRef): void {
    if (patch.baseLevelAfter !== undefined) {
      const base = airBases.value.find((item) => sameHex(item.hex, hex))
      const unit = units.value.find((item) => item.instanceId === base?.id)
      if (unit !== undefined) unit.noncombatLevel = patch.baseLevelAfter
    }
    if (
      patch.trainbustingPlaced === true &&
      !trainbustingMarks.value.some((mark) => sameHex(mark.hex, hex))
    ) {
      trainbustingMarks.value = [
        ...trainbustingMarks.value,
        {
          id: createId('tb'),
          hex: { ...hex },
          side: segmentGateQuery.value.side ?? activeSide.value,
          cause: 'airMission',
        },
      ]
    }
    if (patch.baseLevelAfter !== undefined)
      pushLog('success', `空军基地降级至 ${patch.baseLevelAfter} 级（10.0c-A）`, '10.0c-A')
    if (patch.portDamage !== undefined)
      pushLog('success', `港口累计伤害 ${patch.portDamage}（上限 4；10.0c-B）`, '10.0c-B')
    if (patch.trainbustingPlaced === true)
      pushLog('success', '放置运输破坏标记（10.0c-C；14.8c 于下一敌方清理阶段移除）', '10.0c-C')
  }

  /**
   * 10.0a：损失承受者＝**目标格内的敌方战斗单位**（原文：「他还需要选择**堆叠中的**哪些战斗单位
   * 来承受此次轰炸造成的军力损失」，`_ocs_v43_clean.txt:1573-1574`）
   *
   * ★ 修前面板的损失输入取 `battleDefenders`（9.x 战斗工具的守方）⇒ 正常对局（无战斗会话）里
   *   输入清单为空，出「#」点数结果时 ⑤ 永远填不满＝死锁；引擎校验本来就按目标格判
   *   ⇒ 现在投影与 `confirmBarrageOutcomeStep` 的 `eligibleUnitIds` **共用这一处**口径，面板只读它。
   */
  const barrageLossTargets = computed<ConsoleUnit[]>(() => {
    const state = barrageState.value
    if (state === null) return []
    return units.value.filter(
      (unit) =>
        unit.side !== (segmentGateQuery.value.side ?? activeSide.value) &&
        sameHex(unit.hex, state.targetHex) &&
        unit.isCombat,
    )
  })

  /**
   * 10.0c-A：目标格内**所有敌方飞机**（「检查该格内所有敌方飞机的损失情况。对每个飞机分别掷骰」，
   * txt:1595-1600）⇒ 面板逐机掷骰输入的候选（修前同样错取 `battleDefenders`＝地面单位清单）。
   */
  const barrageAircraftRollTargets = computed<ConsoleAirUnit[]>(() => {
    const state = barrageState.value
    if (state === null) return []
    // 专规 1.4：盒内**不允许轰炸**，盒内驻机也不在该格 ⇒ 不作为 10.0c-A 的掷骰对象
    return onMapAirUnits.value.filter(
      (air) =>
        air.side !== (segmentGateQuery.value.side ?? activeSide.value) &&
        sameHex(air.hex, state.targetHex),
    )
  })

  /** C7 第 5 步：结果确认（10.0a 损失分配 / 10.0c 设施结果）并落盘 */
  function confirmBarrageOutcomeStep(): boolean {
    return fireResolution.confirmBarrageOutcomeStep()
  }

  /** C7：放弃本次轰炸（中止 10.0 流程；已落盘的结果不自动回滚） */
  function cancelBarrage(): void {
    if (!canReplaceBarrage()) return
    clearBarrage()
    pushLog('info', '放弃本次轰炸（10.0 流程中止）', '10.0')
  }

  /** C7：整体目标名（日志用） */
  function targetKindLabel(kind: BarrageTargetKind): string {
    if (kind === 'airBase') return '空军基地'
    if (kind === 'port') return '港口'
    if (kind === 'trainbusting') return '运输破坏'
    return '战斗单位'
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
    barrageSupplyDumpId,
    barrageSupplyDumpChoices,
    barrageSupplyHqChoices,
    barrageSupplyDump,
    barragePaidSupply,
    barrageShellMarkers,
    barragePayNeedT,
    barrageShellBudgetT,
    barrageShellPreview,
    combatErrorLine,
    barrageLossTargets,
    barrageAircraftRollTargets,
    barrageErrorLine,
    barrageSupplyMapDumps,
    barrageLossRequired,
    barrageLossAllocated,
    barrageLossReady,
    airErrorLine,
  }
  return {
    publicSurface,
    setBarrageActive,
    clearBarrage,
    acceptBarrage,
    applyBarragePatches,
    toggleBarrageUnit,
    setAirInBoxMembership,
    clearAirBoxMembers,
    addAirUnit,
    removeAirUnit,
    toggleBarrageAirUnit,
    syncBarrageParticipants,
    clearBarrageSelectionNow,
    setBarrageKind,
    setBarrageTargetKind,
    beginBarrageNow,
    hqDeliveryDumpKeys,
    deliverableDumpsFor,
    combatBeneficiariesOf,
    pickBarrageSupplyDump,
    toggleBarrageSupplyDump,
    confirmBarrageSupplyStep,
    bestDefenderTerrainLine,
    confirmBarrageShiftsStep,
    runBarrageResolution,
    refundBarrageSupply,
    cancelOpsBarrage,
    barrageLossPointsOf,
    addBarrageLossPoint,
    removeBarrageLossPoint,
    confirmBarrageLossNow,
    prepareOpsBarrage,
    defaultBarrageTargetKindAt,
    drawDumpDestructionDie,
    rollBarrageDiceStep,
    barrageFacilityFacts,
    applyBarrageFacilityPatch,
    confirmBarrageOutcomeStep,
    cancelBarrage,
    targetKindLabel,
    barrageSupplyDumpId,
    barragePaidSupply,
    barrageSupplyDumpChoices,
    barrageSupplyHqChoices,
    barrageShellMarkers,
    barragePayNeedT,
    barrageShellBudgetT,
    barrageShellPreview,
    barrageSupplyDump,
    barrageLossRequired,
    barrageLossAllocated,
    barrageLossReady,
    barrageSupplyMapDumps,
    barrageErrorLine,
    combatErrorLine,
    airErrorLine,
    barrageLossTargets,
    barrageAircraftRollTargets,
  }
}
