/**
 * workbench-air.ts —— C9 空军域（状态 + 派生 + 整备/转移动作）
 *
 * 搬了四批：
 *   · B2-1：26 个 ref（2416–2592）+ 派生块 5949–6086；
 *   · B2-1b：5701–6321 的 48 个声明（返航三选一 / 空战轮对 / 巡逻区 / 任务格敌方事实 /
 *     可夺基地 / 整备套件 / 转移 / 缩减），其中含 `beginTransferNow` 这类**动作**；
 *   · B2-2a：17197–17992 的 796 行 / 16 声明（任务开始、空战确认、目标候选、载货结算、夺基地）；
 *   · B2-2b：17880–18318 的 439 行 / 14 声明（货物损失、防空、任务执行前半、自动返航收束）。
 *
 * 端口 **57 项**（2026-11-21 实测），两种接法：
 *   · 按值解构（44 项）：声明在建域点（2239）之前，或是**有提升的函数声明**（声明在 13k–27k 也能按值传）；
 *   · 走 `ports.X`（13 项）：`constructionMarkerAirBaseId`（函数）+ 12 个 `const`/`computed` ——
 *     声明在建域点之后，facade 用 `get` 访问器传进来，切片里一律写成 `ports.x.value`（函数写 `ports.x(...)`）。
 *     只在求值时读取，避免建 store 时撞 TDZ（§12.3 记录过一次同源事故）。
 *     名单：`zocOnlySupplyFacts`/`segmentGateQuery`/`constructionMarkerPieces`/`allSpDumps`/`supplyFacts`/
 *     `barrageFacts`/`railMoveFacts`/`airUnloadLedger`/`airMissionJoinChoices`/`specialPending`/
 *     `airMissionSegmentKind`/`airMissionKindChoices`。
 *     注意：**这类端口在被搬的正文里也是 `ports.x.value`**，不要写裸名。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import { createAirCargoResolutionDomain } from './air-cargo-resolution'
import { createAirMissionDomain } from './air-mission'
import { createAirSupplyDomain } from './air-supply'
import { createAirUnitTransitDomain } from './air-unit-transit'
import type { SpDump } from './supply-types'
import type { SettlementRecordInput } from './workbench-core'
import {
  airCombatRatingOf,
  createAirInputs,
  hexLabel,
  isFighterAircraft,
  parseHexPath,
  terrainsAt,
  toAirBaseView,
  toAirMissionAircraftView,
  type ActionGateQuery,
  type ActionKey,
  type AirInputs,
  type ConsoleAirUnit,
  type ConsolePhase,
  type ConsoleUnit,
  type WorkbenchLogEntry,
  type createSupplyFacts,
  type AirMissionJoinChoice,
  type DeadPileEntry,
  type SpecialCombatPending,
  airRangeFromBase,
  airBarrageStrengthOf,
  type PendingHexPick,
  movementPhaseOf,
} from './workbench-model'
import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import type { Derivation } from '@/engine/derivation'
import { hexDistance, sameHex } from '@/engine/hex-geometry'
import type { RuleOutcome } from '@/engine/result-types'
import type { BarrageInteractionState } from '@/engine/rules/barrage-interaction'
import type { BarrageInputs } from './engagement-inputs'
import {
  checkAirTransportMovementHandoff,
  airCargoTransportT,
  isAirTransportableUnit,
} from '@/engine/rules/air-cargo'
import type { AirCargoUnloadPlan } from '@/engine/rules/air-cargo-unload'
import { planOffMapAirBoxFlightFromHex } from '@/engine/rules/air-mission'
import { airMissionRoster, planRetainedCargoReturn } from '@/engine/rules/air-mission-roster'
import { skipEmptyAirMissionFlak } from '@/engine/rules/air-mission-roster'
import { canonicalMode, canUseTransport } from '@/engine/rules/modes'
import type { AirStatus, DiceRoll, RngState } from '@/engine/state-types'
import {
  activeAircraftInBase,
  activeStackingLimitOf,
  airDistanceToOffMapBox,
  airInteractionChecklist,
  airTransportProfile,
  airTransportTerrainIsClosed,
  drawableDumpsFor,
  holdingsToT,
  inPatrolZoneOf,
  patrolZoneHexes,
  planInterceptionResponse,
  refitCapacity,
  tToHoldings,
  transportCapacityOf,
  type AirBaseReductionPlan,
  type AirBaseView,
  type AirCargoResolution,
  type AirInteractionState,
  type AirMissionAircraftView,
  type AirMissionKind,
  type BaseRefitPlan,
  type BaseTransferPlan,
  type InterceptionResponse,
  type PanzerGroup,
  type SpHoldings,
  type AirMissionCargo,
  type AirMissionSegment,
  type AirTargetHexFacts,
  type SupplyInteractionState,
  airBoxEdgeColumn,
  airBoxRangeHexes,
  airMissionTargetCandidates as engineAirMissionTargetCandidates,
  airMissionTargetTypeAllowed,
  beginAirInteraction,
  declareAirCombatStep,
  planCargoLoss,
  resolveFlakStep,
  validateCargoLossChoice,
  missionSegmentOf,
  planOffMapAirBoxFlight,
  resolveAirCombatRounds,
  resolveBaseTransfer,
  resolveSpecialCombat,
  type RailFacts,
  type BarrageKind,
  type BarrageTargetKind,
} from '@/engine/rules'
import type { createGroundMovementDomain } from './ground-movement'
import { planAirSupplyLoad } from '@/engine/rules/air-supply'
import { planAirUnitTransport, type AirUnitTransportState } from '@/engine/rules/air-unit-movement'
import { roll1d6, roll2d6 } from '@/engine/rng'

/** © 空军的端口。29 项按值、7 项晚绑定（见文件头）。 */
export interface AirDomainPorts {
  activeSide: ComputedRef<Side>
  rng: ComputedRef<RngState>
  units: Ref<ConsoleUnit[]>
  selectedId: Ref<string | null>
  airUnits: Ref<ConsoleAirUnit[]>
  offMapSupplyStocks: Ref<Record<string, SpHoldings>>
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  recordSettlement: (input: SettlementRecordInput) => boolean
  nameOf: (unitId: string) => string
  setAirInBoxMembership: (instanceId: string, inBox: boolean) => void
  addSpAtHex: (input: {
    hex: HexRef
    side: Side
    sp: number
    t: number
    source?: string
    panzerGroup?: PanzerGroup
  }) => string | null
  airUnloadedTAt: (hex: HexRef, side: Side) => number
  acceptAir: <T>(outcome: RuleOutcome<T>, action: string) => T | null
  setAirStatus: (instanceId: string, status: AirStatus) => void
  markAirMissionFlown: (instanceId: string) => void
  drawAir2d6: () => number
  constructionMarkerAirBaseId: (pieceId: string) => string
  /** ── 以下 5 项晚绑定（facade 用 getter 传入，切片里写 ports.x） ── */
  zocOnlySupplyFacts: ComputedRef<ReturnType<typeof createSupplyFacts>>
  segmentGateQuery: ComputedRef<ActionGateQuery>
  constructionMarkerPieces: Ref<{ id: string; kind: 'bridge' | 'airStrip'; hex: HexRef }[]>
  phase: ComputedRef<ConsolePhase>
  airBoxMembers: Ref<string[]>
  hqDeliveryDumpKeys: (side: Side, beneficiaries: readonly { hex: HexRef }[]) => Set<string>
  actionAllowedNow: (key: ActionKey) => boolean
  isConstructionMarkerAirBaseId: (id: string) => boolean
  /** ── 以下 2 项晚绑定（声明在 3849/3911，晚于建域点） ── */
  allSpDumps: ComputedRef<SpDump[]>
  supplyFacts: ComputedRef<ReturnType<typeof createSupplyFacts>>
  /** ── 以下 13 项 B2-2a 新增（按值；声明早于或函数声明可提升） ── */
  turn: ComputedRef<number>
  groundMovement: ReturnType<typeof createGroundMovementDomain>
  moveInteraction: ReturnType<typeof createGroundMovementDomain>['moveInteraction']
  spDumps: Ref<SpDump[]>
  supplyState: Ref<SupplyInteractionState | null>
  clearMoveInteraction: () => void
  refuseWhileSettling: (action: string) => boolean
  eliminateEntry: (entry: DeadPileEntry, rule: string, text: string, refresh?: boolean) => void
  applyAirStepLoss: (instanceId: string) => void
  drawAir1d6: () => number
  airMissionKindLabel: (kind: string) => string
  requireAction: (key: ActionKey, action: string) => boolean
  noteUnitEnteredHex: (unit: ConsoleUnit, hex: HexRef) => void
  /** ── 以下 7 项晚绑定（B2-2a）：声明晚于建域点，切片里写 ports.x.value ── */
  barrageFacts: ComputedRef<{
    enemyREInHex: (hex: HexRef) => number
    hedgehogLevelInHex: (hex: HexRef) => number
    stratModeInHex: (hex: HexRef) => boolean
    hasSpotter: (hex: HexRef) => boolean
  }>
  railMoveFacts: ComputedRef<RailFacts>
  airUnloadLedger: Ref<Record<string, number>>
  airMissionJoinChoices: ComputedRef<readonly AirMissionJoinChoice[]>
  specialPending: Ref<SpecialCombatPending | null>
  airMissionSegmentKind: ComputedRef<AirMissionSegment | null>
  airMissionKindChoices: ComputedRef<readonly { key: AirMissionKind; label: string }[]>
  /** ── 以下 6 项 B2-2b 新增（按值；函数声明可提升，不需要 getter） ── */
  barrageState: Ref<BarrageInteractionState | null>
  beginHexPick: (pick: PendingHexPick) => void
  hexTextOf: (hex: HexRef) => string
  setAirTargetFromText: (text: string) => boolean
  declareInterceptionNow: () => boolean
  resolveInterceptionCombatNow: () => boolean
  /** ── 以下 15 项 B2-2c 新增（按值；轰炸链为函数声明可提升） ── */
  barrageInputs: Ref<BarrageInputs>
  barrageKind: Ref<BarrageKind>
  barrageTargetKind: Ref<BarrageTargetKind>
  barrageUnitIds: Ref<string[]>
  barragedHexesThisPhase: Ref<string[]>
  barragedUnitIdsThisPhase: Ref<string[]>
  barrageAirIds: Ref<string[]>
  canReplaceBarrage: () => boolean
  clearBarrage: () => void
  beginBarrageNow: () => boolean
  confirmBarrageSupplyStep: () => boolean
  confirmBarrageShiftsStep: () => boolean
  confirmBarrageLossNow: () => boolean
  rollBarrageDiceStep: () => boolean
  confirmBarrageOutcomeStep: () => boolean
  /** ── 以下 3 项晚绑定（B2-2c）：不进解构，切片里写 ports.x.value ── */
  barragePickHex: Ref<HexRef | null>
  barrageLossRequired: ComputedRef<number>
  barrageLossReady: ComputedRef<boolean>
}

export function createAirDomain(ports: AirDomainPorts) {
  const {
    activeSide,
    rng,
    units,
    selectedId,
    airUnits,
    offMapSupplyStocks,
    pushLog,
    recordSettlement,
    nameOf,
    setAirInBoxMembership,
    addSpAtHex,
    airUnloadedTAt,
    acceptAir,
    setAirStatus,
    markAirMissionFlown,
    drawAir2d6,
    phase,
    airBoxMembers,
    hqDeliveryDumpKeys,
    actionAllowedNow,
    isConstructionMarkerAirBaseId,
    turn,
    groundMovement,
    moveInteraction,
    spDumps,
    supplyState,
    clearMoveInteraction,
    refuseWhileSettling,
    eliminateEntry,
    applyAirStepLoss,
    drawAir1d6,
    airMissionKindLabel,
    requireAction,
    noteUnitEnteredHex,
    barrageState,
    beginHexPick,
    hexTextOf,
    setAirTargetFromText,
    declareInterceptionNow,
    resolveInterceptionCombatNow,
    barrageInputs,
    barrageKind,
    barrageTargetKind,
    barrageUnitIds,
    barragedHexesThisPhase,
    barragedUnitIdsThisPhase,
    barrageAirIds,
    canReplaceBarrage,
    clearBarrage,
    beginBarrageNow,
    confirmBarrageSupplyStep,
    confirmBarrageShiftsStep,
    confirmBarrageLossNow,
    rollBarrageDiceStep,
    confirmBarrageOutcomeStep,
  } = ports

  /**
   * C9：空军工具是否已开启
   *
   * ★ 用户口径：正式游戏界面里**必要模块默认开启**⇒ 默认 `true`（巡逻区与空军交互随时可用）。
   */
  const airActive = ref(true)
  /** C9：任务类型（14.2e；拦截与基地转移不走此入口） */
  const airMissionKind = ref<AirMissionKind>('barrage')
  /** C9：任务格（14.2f-B 的目标；null＝未定） */
  const airTargetHex = ref<HexRef | null>(null)
  /** C9：参战飞机实例 id（14.2a：一次任务合计 ≤4 架） */
  const airMissionAirIds = ref<string[]>([])
  /**
   * 14.2f-E 的扩展：任务按**中止**收束（轰炸宣布被引擎拒，且任务机仍在）。
   * 置位时跳过「必须先有一场已结算轰炸」的检查，直接记任务结算并返航，
   * 否则任务态会永远停在 `resolveMission`（`cancelAir` 与环节推进都以 14.1c 拒绝）。
   */
  const airMissionAbortPending = ref(false)
  /** C9：任务交互状态机（14.2f A–G；null＝未开始） */
  const airSupply = createAirSupplyDomain({
    returnSupply(hex, side, t, fromOffMapBox) {
      // 14.9（T16）：从离图盒起飞的任务，退运加回图外库存，而不是凭空落到图上格。
      if (fromOffMapBox !== undefined) {
        const key = `${side}:${fromOffMapBox}`
        const current = offMapSupplyStocks.value[key] ?? { sp: 0, t: 0 }
        offMapSupplyStocks.value = {
          ...offMapSupplyStocks.value,
          [key]: tToHoldings(holdingsToT(current) + t),
        }
        recordSettlement({
          action: 'airSupplyReturn',
          rule: '14.9',
          data: { offMap: true, box: fromOffMapBox, side, t },
        })
        return
      }
      addSpAtHex({ hex, side, sp: 0, t, source: '14.9 退运' })
      recordSettlement({ action: 'airSupplyReturn', rule: '14.9', data: { hex, side, t } })
    },
  })
  const airSupplyManifest = airSupply.manifest
  // 14.9a：装载后从盘面移出，所有地图事实只读取仍在地图上的 units。
  const airUnitTransit = createAirUnitTransitDomain({
    units: () => units.value,
    removeFromMap(ids) {
      const loaded = new Set(ids)
      units.value = units.value.filter((unit) => !loaded.has(unit.instanceId))
      if (selectedId.value !== null && loaded.has(selectedId.value)) selectedId.value = null
    },
    addToMap(unit) {
      units.value = [...units.value, unit]
    },
  })
  const airUnitCargoManifest = airUnitTransit.manifest
  const airMissionDomain = createAirMissionDomain({
    inputs: () => airInputs.value,
    profiles: () => airTransportProfiles.value,
    bases: () => airBases.value,
    aircraft: () => airUnits.value,
    target: () => airTargetHex.value,
    acceptAir,
    resultReady: airMissionResultReady,
    returnCargo: completeAirCargoReturn,
    resetSupply: airSupply.reset,
    resetCargo: () => {
      airCargoResolution.reset()
      airInputs.value.unloadCargoIds = null
    },
    mustStayAtTarget: () => airCargoUnloadReceipt.value?.stayAircraftIds ?? [],
    setAirStatus,
    setInOffMapBox: (id) => setAirInBoxMembership(id, true),
    markAirMissionFlown,
    nameOf,
    pushLog,
    recordSettlement,
  })
  const { airState, airError } = airMissionDomain
  const airCargoResolution = createAirCargoResolutionDomain({
    state: () => airState.value,
    rng: () => rng.value,
    inputs: () => airInputs.value,
    facts: () => {
      const state = airState.value
      const base = airBases.value.find(
        (entry) =>
          state !== null && sameHex(entry.hex, state.targetHex) && entry.side === state.side,
      )
      return {
        closedTerrain: airTransportTerrainIsClosed({
          terrainsInHex: state === null ? [] : terrainsAt(state.targetHex),
          hasAirBase:
            state !== null && airBases.value.some((entry) => sameHex(entry.hex, state.targetHex)),
        }),
        baseLevel: base?.level ?? 0,
        isAirstrip: base?.isAirstrip === true,
        usedT: state === null ? 0 : airUnloadedTAt(state.targetHex, state.side),
        overLimitAircraftInactive:
          airInputs.value.unloadOverLimitInactive || airOverLimitAircraftInactive.value,
      }
    },
    lossPending: () => airCargoLossPending.value !== null,
    roster: () => airMissionRosterNow.value!,
    unitExists: (id) => airUnitTransit.canLand([id]),
    draw2d6: drawAir2d6,
    accept: acceptAir,
    commit: (state, result, plan) => {
      const landedIds = result.items
        .filter((item) => item.kind === 'unit' && item.fate === 'placed')
        .map((item) => item.id)
      if (!airUnitTransit.canLand(landedIds)) return false
      return airMissionDomain.commitCargo(state, result, () =>
        applyAirCargoDelivery(state, result, plan),
      )
    },
    pushLog,
    record: recordSettlement,
  })
  const airCargoUnloadReceipt = airCargoResolution.receipt
  const airCargoUnloadChoices = computed(() =>
    (airState.value?.assignment.cargo ?? []).map((item) => ({
      id: item.id,
      t: airCargoTransportT(item),
      label: item.kind === 'sp' ? item.id : nameOf(item.id.slice(5)),
    })),
  )
  /** C9：最近一次被引擎拒绝的步骤（供界面提示；成功后清空） */
  /** C9：玩家在本次空军交互里的各项输入（界面 v-model 绑定） */
  const airInputs = ref<AirInputs>(createAirInputs())

  /** C9：本阶段已完成整备的基地 id（15.1A：每基地每整备阶段一次） */
  const refitDoneBaseIds = ref<string[]>([])
  /**
   * C9：正在整备的那个基地 id（15.1；null = 没有进行中的整备）
   *
   * 用户口径：「整备阶段点击机场的整备按钮 → 勾选要整备的飞机 → 点地图上高亮的可用补给消耗」
   * ⇒ 本字段就是这个「已点开、正在选飞机 / 选补给」的中间态。
   */
  const refitTargetBaseId = ref<string | null>(null)
  /**
   * 15.1 整备的两段式（用户 2026-11-12 口径）：
   *   `select` 勾飞机 →「确认整备」→ `pay` 高亮补给站 → 点站 →「确认支付」。
   * 修前 beginRefitNow 就铺出补给站高亮、点一下就立即结算，缺「确认整备 / 确认支付」两步。
   */
  const refitStage = ref<'select' | 'pay' | null>(null)
  /**
   * 14.11 转场（用户 2026-11-12）：
   *   `box`  = 进入地图外盒（点即移入，无格可高亮）；
   *   `base` = 放入另一个己方空军基地（高亮航程内的基地格，点格放置）。
   * 起点可以是图上基地，也可以是盒（盒只能转入图上基地，不提供盒到盒）。
   */
  const transferBaseId = ref<string | null>(null)
  const transferMode = ref<'box' | 'base' | null>(null)
  const transferFromBox = ref(false)
  const transferSelectedIds = ref<string[]>([])
  /** C9：本阶段已缩减过的基地 id（15.4：同一友方基地每阶段一次） */
  const reducedBaseIds = ref<string[]>([])
  /** C9：被声明为**简易机场**的基地 id（15.2；本作单位库无独立算子，由玩家声明） */
  const airstripBaseIds = ref<string[]>([])
  /** C9：最近一次整备结论（供界面显示） */
  const lastRefit = ref<BaseRefitPlan | null>(null)
  /** C9：最近一次基地转移结论 */
  const lastTransfer = ref<BaseTransferPlan | null>(null)
  /** C9：最近一次基地缩减结论 */
  const lastReduction = ref<AirBaseReductionPlan | null>(null)

  /* ── C9 空军交互：派生（一切结论来自引擎；此处只做视图整形） ── */

  const airActingSide = computed<Side>(
    () => airState.value?.side ?? ports.segmentGateQuery.value.side ?? activeSide.value,
  )
  /** C9：对手方 */
  const enemySide = computed<Side>(() => (airActingSide.value === 'axis' ? 'soviet' : 'axis'))

  /** C9：全部飞机视图（双方；引擎内部按阵营过滤） */
  /**
   * C9：**图上**飞机的引擎视图
   *
   * 专规 1.4a：驻在**地图外空军盒**的飞机不在图上任何一格 ⇒ 它们不投影巡逻区（14.4c）、
   * 不作基地在场机计数（15.x 的整备/堆叠），也不作为 14.5 的拦截候选。
   * 需要"盒内也能出击"的地方（任务编成、1.4a 的入场航程）另走 `airMissionAirUnits` +
   * `toAirMissionAircraftView(plane, offMap)`，**不从这里取**。
   */
  const allAirViews = computed<AirMissionAircraftView[]>(() =>
    onMapAirUnits.value.map((plane) => toAirMissionAircraftView(plane)),
  )

  /** C9：当前方的飞机 */
  const ownAirUnits = computed<ConsoleAirUnit[]>(() =>
    airUnits.value.filter((air) => air.side === airActingSide.value),
  )

  /**
   * C9：全部空军基地（★ 基地归属权）
   *
   * 归属方＝该空军基地算子被摆放/翻面后的 `side`（15.0：中立算子由占有一方决定）；
   * 15.2 的**简易机场**在本作单位库没有独立算子，故由玩家逐格声明（`airstripBaseIds`），
   * 声明后按 15.2 的能力处理：无防空值（等级 0）、整备 1 架、激活堆叠 4、永不缩减；
   * 15.1C 的「未抵消敌方 ZOC」由追溯事实的 `inEnemyZoc`（含 4.5b 抵消）逐基地填入。
   */
  const airBases = computed<AirBaseView[]>(() => {
    const real = units.value
      .filter((unit) => unit.noncombatKind === 'air_base')
      .map(toAirBaseView)
      .map((base) => {
        const airstrip = airstripBaseIds.value.includes(base.id)
        return {
          ...base,
          inUnnegatedEnemyZoc: ports.zocOnlySupplyFacts.value.inEnemyZoc(base.hex, base.side),
          ...(airstrip ? { level: 0, isAirstrip: true } : {}),
        }
      })
    /*
     * 专规 3.5：建造标记的**简易机场面**「按 OCS 15.2 的标准简易机场处理」⇒ 它不是"只记账"，
     * 而要在空军侧真正可用：停机 / 整备 1 架（15.2B）/ 激活堆叠 4（15.2D）/ 无防空值 / 永不缩减（15.2E）。
     * 这些效果全部由 `isAirstrip` 在引擎各处推出，故此处把它投影成一枚**虚拟基地**；
     * 标记被苏方战斗单位摧毁时 `constructionMarkerPieces` 里那一项消失 ⇒ 虚拟基地随之消失。
     */
    const markers = ports.constructionMarkerPieces.value
      .filter((piece) => piece.kind === 'airStrip')
      .map<AirBaseView>((piece) => ({
        id: ports.constructionMarkerAirBaseId(piece.id),
        hex: piece.hex,
        side: 'axis',
        level: 0,
        isAirstrip: true,
        inUnnegatedEnemyZoc: ports.zocOnlySupplyFacts.value.inEnemyZoc(piece.hex, 'axis'),
      }))
    return [...real, ...markers]
  })

  /** C9：当前方的空军基地 */
  const ownAirBases = computed<AirBaseView[]>(() =>
    airBases.value.filter((base) => base.side === airActingSide.value),
  )

  /**
   * 14.9e：**逐机档位**（A 双程 / B 正常 / C 半程）
   *
   * 「空运任务可飞往任何友方空军基地。**将每个飞机分开处理**，任务格可以……A) 两倍距离内（目的地变
   *   非激活）/ B) 正常距离内 / C) 一半距离内（**运输容量翻倍**）。」
   * 判据只有一处（引擎 `airTransportProfile`）；本投影只把 `origins` 里逐机的距离与航程喂进去，
   * 供界面逐机显示，并让 14.9f 的例外可以由"有没有 A 档"推出（§17.71 的如实边界②）。
   */
  const airTransportProfiles = computed<
    { aircraftId: string; profile: string; capacityMultiplier: number; detail: string }[]
  >(() => {
    const assignment = airState.value?.assignment
    if (assignment === undefined) return []
    return assignment.origins.map((origin) => {
      const result = airTransportProfile({
        distanceHexes: origin.distanceHexes,
        rangeHexes: origin.rangeHexes,
      })
      return {
        aircraftId: origin.aircraftId,
        profile: result.profile ?? '—',
        capacityMultiplier: result.capacityMultiplier,
        detail: result.detail,
      }
    })
  })

  /** 14.9e-A：本次任务里**在目的地变非激活**（双程飞法）的飞机 —— 14.9f 的例外交给它判 */
  const airOverLimitAircraftInactive = computed<boolean>(() => {
    const transports = airTransportProfiles.value.filter((item) => {
      const plane = airUnits.value.find((air) => air.instanceId === item.aircraftId)
      return plane !== undefined && transportCapacityOf(plane) > 0
    })
    return transports.length > 0 && transports.every((item) => item.profile === 'A')
  })

  /** C9：本次任务的参战机（未开始时＝点选集合；已开始时＝分配结论里的名单） */
  const airMissionAirUnits = computed<ConsoleAirUnit[]>(() => {
    const state = airState.value
    const ids = state === null ? airMissionAirIds.value : state.assignment.aircraftIds
    return ids
      .map((id) => airUnits.value.find((air) => air.instanceId === id))
      .filter((air): air is ConsoleAirUnit => air !== undefined)
  })
  const airMissionRosterNow = computed(() => {
    const state = airState.value
    return state === null
      ? null
      : airMissionRoster(
          state.assignment,
          airUnits.value.map((air) => toAirMissionAircraftView(air)),
          airMissionDomain.initialAircraft(),
        )
  })
  const airMissionFlyingUnits = computed(() => {
    const ids = airMissionRosterNow.value?.activeIds
    return airMissionAirUnits.value.filter((air) =>
      ids === undefined
        ? air.airStatus === 'active' && air.steps > 0
        : ids.includes(air.instanceId),
    )
  })
  const airMissionReturnOrigins = computed(() => {
    const ids = airMissionRosterNow.value?.liveIds ?? []
    return (
      airState.value?.assignment.origins.filter((origin) => ids.includes(origin.aircraftId)) ?? []
    )
  })

  /**
   * 14.1c / 专规 1.4a：返航三选一的**可用性**
   *
   * - `departureAvailable`：出发基地仍是**本方**空军基地；自图外盒起飞者恒可回盒。
   * - `offMapBoxAvailable`：图上起飞的飞机，`目标格 → 盒`（1.4a：连接列 20/30 + 列距）
   *   ≤ 印刷航程（14.1c 返航用正常航程，不翻倍）。
   *   空运/空投任务只有**货全部卸完**才放行（14.9f：未卸载的货仍在机上，返盒没有入库规则）。
   * - `offMapBoxBlockedReason`：上一条被拒时给界面的原因（子项本身不出现）。
   * - `otherBases`：剩余航程（`target → base ≤ 印刷航程`）内的其它己方基地格。
   */
  const airMissionReturnChoices = computed<
    {
      aircraftId: string
      fromBox: boolean
      departureAvailable: boolean
      departureHex: HexRef
      offMapBoxAvailable: boolean
      /** 14.9f：货未卸完时给界面的禁用原因（子项本身不出现） */
      offMapBoxBlockedReason: string | null
      otherBases: HexRef[]
    }[]
  >(() => {
    const state = airState.value
    if (state === null) return []
    return airMissionReturnOrigins.value.map((origin) => {
      const plane = airUnits.value.find((air) => air.instanceId === origin.aircraftId)
      const range = plane?.rangeHexes ?? origin.rangeHexes
      const fromBox = origin.fromOffMapBox === true
      const departureBase = airBases.value.find(
        (base) => base.side === state.side && sameHex(base.hex, origin.baseHex),
      )
      const cargoMission = state.kind === 'air_transport' || state.kind === 'air_drop'
      // 14.9f：`assignment.cargo` 是卸载/货损后的余量 ⇒ 非空即「货还在机上」
      // 空运/空投只有货全卸完才放行返盒（用户 2026-11-13 批复的最小改法）
      const cargoRemaining = cargoMission && state.assignment.cargo.length > 0
      // 专规 1.4a：从**任务格**回盒的代价＝20/30 + 任务格到连接列的列距（不是只看 20/30）
      const boxReachable = planOffMapAirBoxFlightFromHex({
        side: state.side,
        rangeHexes: range,
        fromHex: state.targetHex,
      }).ok
      return {
        aircraftId: origin.aircraftId,
        fromBox,
        departureAvailable: fromBox || departureBase !== undefined,
        departureHex: { ...origin.baseHex },
        offMapBoxAvailable: !fromBox && !cargoRemaining && boxReachable,
        offMapBoxBlockedReason:
          !fromBox && cargoRemaining ? '14.9f：货物未卸载，不可返盒（原文缺口）' : null,
        otherBases: airBases.value
          .filter(
            (base) =>
              base.side === state.side &&
              !sameHex(base.hex, origin.baseHex) &&
              hexDistance(state.targetHex, base.hex) <= range,
          )
          .map((base) => ({ ...base.hex })),
      }
    })
  })

  /** 14.2f-G：某架机当前选定的返航落点（供界面显示） */
  function airReturnSelectionLabel(aircraftId: string): string {
    if (airInputs.value.returnToBox[aircraftId] === true) return '图外空军基地'
    const text = airInputs.value.returnHexText[aircraftId]
    const choice = airMissionReturnChoices.value.find((item) => item.aircraftId === aircraftId)
    if (text !== undefined && text !== '') {
      const parsed = parseHexPath(text)[0]
      if (
        choice !== undefined &&
        !choice.fromBox &&
        parsed !== undefined &&
        sameHex(parsed, choice.departureHex)
      )
        return `出发基地（${text}）`
      return text
    }
    if (choice === undefined) return ''
    return choice.fromBox ? '出发基地（图外盒）' : `出发基地（${hexLabel(choice.departureHex)}）`
  }

  /**
   * 14.2f-G：这一架是否已被**明确选过**返航落点（供界面给"已选"状态）
   *
   * 2026-11-15 实点：未选时 `airReturnSelectionLabel` 已显示「出发基地（15.10）」，
   * 点「返回出发基地」写回的正是同一个落点 ⇒ 文案一字不变，看起来"点了没反应"。
   */
  function airReturnChosen(aircraftId: string): boolean {
    if (airInputs.value.returnToBox[aircraftId] === true) return true
    const text = airInputs.value.returnHexText[aircraftId]
    return text !== undefined && text !== ''
  }

  /**
   * 14.3e-B：本场空战里**攻方**在场的飞机（逐轮点名的候选取此）
   *
   * 攻方由引擎给（`combat.roles.attackerSide`，14.3c 的资格判定在引擎里），
   * 本投影只做"哪一方 / 格内哪几架"的搬运 —— 界面据此铺阵列，缺省仍可全自动。
   */
  const airCombatAttackerPlanes = computed<ConsoleAirUnit[]>(() => {
    const hex = airTargetHex.value
    const side = airState.value?.combat?.roles.attackerSide ?? null
    if (hex === null || side === null) return []
    return airUnitsInHex(hex, side)
  })

  /** 14.3e-B：本场空战里**守方**在场的飞机（守方**任选**，含括号值的飞机） */
  const airCombatDefenderPlanes = computed<ConsoleAirUnit[]>(() => {
    const hex = airTargetHex.value
    const side = airState.value?.combat?.roles.defenderSide ?? null
    if (hex === null || side === null) return []
    return airUnitsInHex(hex, side)
  })

  /**
   * 14.3e-B：逐轮点名的**轮数上界**（双方在场机数之和）
   *
   * 实际轮数由骰面与返航决定（14.3e-D：直到一方成为该格唯一一方），故这是"最多可能几轮"，
   * 界面按它铺点名的行数；少铺的行玩家不点名，即交给引擎自动。
   */
  const airCombatRoundBudget = computed<number>(
    () => airCombatAttackerPlanes.value.length + airCombatDefenderPlanes.value.length,
  )

  /**
   * 14.5 / 14.3e-B：**迎战拦截机的那一架任务机**（拦截空战里的守方）
   *
   * 缺省口径与引擎**一致**：ACV 最高（`resolveAirCombatRounds` 的 `pickHighestAcv`）。
   * ★ 修前 store 在未点名时回落"任务机名单第一架"，与引擎的缺省不一致 ——
   *   同一件事两处不同答案，玩家看到的那一架与实际交手的那一架可能不是同一架。
   */
  const airInterceptionDefender = computed<ConsoleAirUnit | null>(() => {
    const named = airInputs.value.namedDefenderId
    if (named !== null) {
      return airMissionFlyingUnits.value.find((air) => air.instanceId === named) ?? null
    }
    const planes = airMissionFlyingUnits.value
    if (planes.length === 0) return null
    // 14.1b：ACV 取**当前面**（减损机用减损面值；与引擎 `pickHighestAcv` 的入参同源）
    return planes.reduce((best, plane) =>
      airCombatRatingOf(plane) > airCombatRatingOf(best) ? plane : best,
    )
  })

  /**
   * 14.10a：把某枚单位加入 / 移出**本次的货物**（面板点算子图阵列直连这里）
   *
   * 只做清单维护：资格（Para 声明）、运力、计划回合、目标格全部由引擎在**宣布任务**时判。
   */
  function toggleAirCargoUnit(instanceId: string): void {
    const ids = airInputs.value.cargoUnitIds
    airInputs.value = {
      ...airInputs.value,
      cargoUnitIds: ids.includes(instanceId)
        ? ids.filter((id) => id !== instanceId)
        : [...ids, instanceId],
    }
  }

  /**
   * 14.9c（第五批批 C 切片 2）：**可作单位货物的本方单位**
   *
   * 候选＝图上本方**地面战斗**单位且**处于移动模式**——「处于**移动模式**的战斗单位也可以空运，
   * 前提是其 MA 为 **10 或以下的步行 MP**」。本作数据里战斗面 MA 最大 10 ⇒ "步行 MP≤10" 恒满足
   * （判据层真值表在引擎 `missionCargoCheck` 里钉），候选只筛"模式"这一半；
   * 空投的人员/战斗单位投送在本作 N/A（R6），候选仍可供空运使用；空投只允许 SP。
   */
  const airCargoUnitChoices = computed<ConsoleUnit[]>(() =>
    units.value.filter(
      (unit) =>
        unit.side === airActingSide.value &&
        canUseTransport(unit.mode) &&
        isAirTransportableUnit({
          id: `unit:${unit.instanceId}`,
          kind: 'unit',
          isCombat: unit.isCombat,
          re: unit.re,
          ma: unit.faces.move.ma,
          mobility: unit.faces.move.mobility,
        }),
    ),
  )

  /** C9：任务编成里是否编有战斗机（14.4e 表 17-3 的 +1/+2 分档以此为准） */
  const airMissionHasFighter = computed<boolean>(() =>
    airMissionFlyingUnits.value.some((air) => isFighterAircraft(air.aircraftType)),
  )

  /** C9：步骤清单（14.2f A–G；给界面打勾用） */
  const airChecklist = computed(() =>
    airState.value === null ? [] : airInteractionChecklist(airState.value),
  )

  /** C9：任务格是否位于对手的巡逻区内（14.4a/14.4e ⇒ 防空加强；也是拦截的前提） */
  const airTargetInEnemyPatrolZone = computed<boolean>(() => {
    const hex = airTargetHex.value
    if (hex === null) return false
    return inPatrolZoneOf({
      hex,
      side: enemySide.value,
      bases: airBases.value,
      aircraft: allAirViews.value,
    })
  })

  /** C9：对手的拦截资格与候选拦截机（14.5；null＝任务格未定） */
  const airInterceptionResponse = computed<InterceptionResponse | null>(() => {
    const hex = airTargetHex.value
    if (hex === null) return null
    return planInterceptionResponse({
      side: enemySide.value,
      missionKind: airMissionKind.value,
      missionHex: hex,
      // 14.5：一次任务只能被拦截一次；操作台在声明拦截后即由 `airState` 记录下来
      alreadyIntercepted: airState.value?.interception?.declared === true,
      aircraft: allAirViews.value,
      bases: airBases.value,
    })
  })

  /** C9：可作为拦截机的对手飞机（14.5：一次仅一架） */
  const airInterceptorCandidates = computed<ConsoleAirUnit[]>(() => {
    const response = airInterceptionResponse.value
    if (response === null) return []
    return response.eligibleFighterIds
      .map((id) => airUnits.value.find((air) => air.instanceId === id))
      .filter((air): air is ConsoleAirUnit => air !== undefined)
  })

  /** C9：任务格的空军基地等级（14.4e 的 +# 项；简易机场为 0，15.2F） */
  const airTargetBaseLevel = computed<number>(() => {
    const hex = airTargetHex.value
    if (hex === null) return 0
    return airBases.value.find((base) => sameHex(base.hex, hex))?.level ?? 0
  })

  /** C9：任务格的空中设施**是否为简易机场**（15.2F：不能提供任何防空值） */
  const airTargetBaseIsAirstrip = computed<boolean>(() => {
    const hex = airTargetHex.value
    if (hex === null) return false
    return airBases.value.find((base) => sameHex(base.hex, hex))?.isAirstrip === true
  })

  /**
   * C9：任务格内的**敌方**空中/基地事实（14.3 空战前提）
   *
   * 全部由**盘面**推出（不再手工填数字）：敌方激活机数、是否有可发起空战的机、是否有敌方基地。
   * 14.3：任务格内没有敌方基地就不会发生空战。
   */
  const airEnemyAtTarget = computed<{
    activeAircraft: number
    canInitiate: boolean
    hasAirBase: boolean
  }>(() => {
    const hex = airTargetHex.value
    if (hex === null) return { activeAircraft: 0, canInitiate: false, hasAirBase: false }
    // 专规 1.4a：盒内驻机不在图上任何一格 ⇒ 不参与"该格有敌机"的判定
    const aircraft = onMapAirUnits.value.filter(
      (air) =>
        air.side === enemySide.value &&
        air.airStatus === 'active' &&
        air.steps > 0 &&
        sameHex(air.hex, hex),
    )
    return {
      activeAircraft: aircraft.length,
      canInitiate: aircraft.some((air) => air.canInitiateAirCombat),
      hasAirBase: airBases.value.some(
        (base) => base.side === enemySide.value && sameHex(base.hex, hex),
      ),
    }
  })

  /** C9：可被夺取的**敌方**空军基地（9.14f：敌方可攻击单位已进入该格） */
  const capturableEnemyAirBases = computed<AirBaseView[]>(() =>
    airBases.value.filter(
      (base) => base.side === enemySide.value && !isConstructionMarkerAirBaseId(base.id),
    ),
  )

  /** C9：当前方的巡逻区覆盖格（14.4c；供地图铺色） */
  const airPatrolZoneHexes = computed<HexRef[]>(() =>
    patrolZoneHexes({
      side: airActingSide.value,
      bases: airBases.value,
      aircraft: allAirViews.value,
    }),
  )

  /** C9：对手的巡逻区覆盖格（14.4c；供地图铺色） */
  const airEnemyPatrolZoneHexes = computed<HexRef[]>(() =>
    patrolZoneHexes({ side: enemySide.value, bases: airBases.value, aircraft: allAirViews.value }),
  )

  /** C9：某基地格内的非激活飞机（15.1B：由玩家选择整备哪些） */
  const airInactiveAtBase = computed<(baseId: string) => ConsoleAirUnit[]>(
    () => (baseId: string) => {
      const base = airBases.value.find((item) => item.id === baseId)
      if (base === undefined) return []
      // 专规 1.4a：盒内驻机由「盒内免费整备」（activateAirBox）处理，不占图上基地的整备名额
      return onMapAirUnits.value.filter(
        (air) =>
          air.side === base.side && air.airStatus === 'inactive' && sameHex(air.hex, base.hex),
      )
    },
  )

  /**
   * C9：某基地的**整备付款补给站**候选（15.1B：1T/基地）
   *
   * 15.1 只规定费用，取用仍走 12.3 的补给渠道：「图上补给……可通过**直接拖取或从指挥部投递**
   * 获得」⇒ 候选＝ 12.3a 直拖可达的站 **∪** 12.3b 指挥部投递可达的站（第五批 B1 补上后半，
   * 判据与燃料链 `hqDeliveryDumpKeys` 共用一处；修前只有直拖半边 ⇒ 基地 5MP 内无站但
   * 在某 HQ 投递距离内时合法整备被拒）。
   */
  const airRefitPayDumps = computed<(baseId: string) => SpDump[]>(() => (baseId: string) => {
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) return []
    const drawable = drawableDumpsFor(ports.supplyFacts.value, {
      hex: base.hex,
      side: base.side,
    }).filter((dump) => dump.ok)
    const keys = new Set(drawable.map((dump) => hexLabel(dump.hex)))
    // 12.3b：该基地格同时处在某指挥部的投递距离内 ⇒ 该 HQ 拖得到的站也是合法付款来源
    for (const key of hqDeliveryDumpKeys(base.side, [base])) keys.add(key)
    /*
     * 13.2g-A/B（用户 2026-11-16 裁定）：编内卡车的 SP **永远不**能作为整备来源——
     * 它不许在地图上卸载，且只许**同一多单位编队内**的单位拖取；指挥部也只投递给**同编队**单位。
     * 整备的是空军基地（12.9c 的「图上补给」），不属该编队 ⇒ 候选里直接剔除编内卡车。
     * 普通运输点数上装载的 SP 仍是 12.1b 的补给站，照常可付。
     */
    return ports.allSpDumps.value.filter(
      (dump) =>
        dump.side === base.side &&
        keys.has(hexLabel(dump.hex)) &&
        dump.sp + dump.t > 0 &&
        dump.carrierIsOrganicTruck !== true,
    )
  })

  /** C9：某基地格内**可被指定**执行缩减的地面单位（15.4：战斗模式且本阶段未移动） */
  const airReductionCandidates = computed<(baseId: string) => ConsoleUnit[]>(
    () => (baseId: string) => {
      const base = airBases.value.find((item) => item.id === baseId)
      if (base === undefined) return []
      return units.value.filter(
        (unit) =>
          unit.side === base.side &&
          unit.isCombat &&
          !unit.movementEnded &&
          sameHex(unit.hex, base.hex),
      )
    },
  )

  /** C9：本阶段已完成整备的基地（15.1A；视图用） */
  const refitDoneBases = computed(() =>
    ownAirBases.value.filter((base) => refitDoneBaseIds.value.includes(base.id)),
  )

  /* ── 15.1 整备的交互三件套（点基地 → 勾飞机 → 点地图上的补给付款） ── */

  /** 正在整备的基地（null = 没有进行中的整备） */
  const refitBase = computed(() =>
    refitTargetBaseId.value === null
      ? null
      : (airBases.value.find((base) => base.id === refitTargetBaseId.value) ?? null),
  )

  /** 该基地格内可勾选整备的非激活飞机（15.1B） */
  const refitCandidates = computed<readonly ConsoleAirUnit[]>(() =>
    refitTargetBaseId.value === null ? [] : airInactiveAtBase.value(refitTargetBaseId.value),
  )

  /** 已勾选要整备的飞机实例 id */
  const refitSelectedIds = computed<string[]>(() => airInputs.value.refitAircraftIds)

  /**
   * 15.1B / 15.2B / 14.2a：某基地**本次最多能整备几架**
   *
   * `min(容量, 激活堆叠余额)`：容量＝等级×2（简易机场 1）；整备会把非激活转激活，
   * 故还须给 14.2a 的 `4 + 等级` 留出位置。0 ⇒ 这个基地此刻整备不了。
   */
  function refitSelectLimitAt(baseId: string): number {
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) return 0
    const capacity = refitCapacity({
      isAirstrip: base.isAirstrip === true,
      level: base.level,
    }).capacity
    const room = activeStackingLimitOf(base) - activeAircraftInBase(allAirViews.value, base.hex)
    return Math.max(0, Math.min(capacity, room))
  }

  /** 当前整备交互最多能勾几架（勾机阶段就按它收口，别等付款才被引擎拒） */
  const refitSelectLimit = computed<number>(() =>
    refitTargetBaseId.value === null ? 0 : refitSelectLimitAt(refitTargetBaseId.value),
  )

  /** 该基地可付款的补给站（15.1B：1T；地图上金黄方框高亮，点它即付款并结算） */
  const refitPayDumps = computed<readonly SpDump[]>(() =>
    refitTargetBaseId.value === null ? [] : airRefitPayDumps.value(refitTargetBaseId.value),
  )

  /** 15.1B：整备每个基地一次 1T（「可选补给源」角标用） */
  const refitPayNeedT = computed<number>(() => 1)

  /* ── 14.11 转场（用户 2026-11-12） ── */

  const transferBase = computed(() =>
    transferBaseId.value === null
      ? null
      : (airBases.value.find((base) => base.id === transferBaseId.value) ?? null),
  )

  /** 可勾选的转场飞机：图上基地 = 本格驻机；盒 = 盒内驻机（盒只转入图上基地） */
  const transferCandidates = computed<readonly ConsoleAirUnit[]>(() => {
    if (transferFromBox.value) {
      return ownAirUnits.value.filter((air) => isAirInOffMapBox(air))
    }
    const base = transferBase.value
    if (base === null) return []
    return airUnitsAt(base.hex, base.side)
  })

  /** 14.11：基地 → 盒的航程（专规 1.4a：盒连接列 20/30 **加上**与连接列的列差） */
  function airDistanceToBox(air: ConsoleAirUnit): number {
    return airDistanceToOffMapBox(air.side, air.hex)
  }

  /** 这架机是否够得到（转场）盒：14.11 基地转移距离**可增加一倍** */
  function canTransferAirToBox(air: ConsoleAirUnit): boolean {
    return airDistanceToBox(air) <= air.rangeHexes * 2
  }

  const transferBoxReady = computed(
    () =>
      transferSelectedIds.value.length > 0 &&
      transferSelectedIds.value.every((id) => {
        const air = airUnits.value.find((item) => item.instanceId === id)
        return air !== undefined && canTransferAirToBox(air)
      }),
  )

  /** 14.11：基地→基地距离**可增加一倍**（`*2`）；图外盒按 1.4a 也是空军基地，盒→基地按 1.4a 盒代价 */
  const transferBaseCandidates = computed<HexRef[]>(() => {
    if (transferMode.value !== 'base' || transferSelectedIds.value.length === 0) return []
    const selected = transferSelectedIds.value
      .map((id) => airUnits.value.find((item) => item.instanceId === id))
      .filter((air): air is ConsoleAirUnit => air !== undefined)
    if (selected.length === 0) return []
    const fromBox = transferFromBox.value
    return ownAirBases.value
      .filter((base) => base.id !== transferBaseId.value)
      .filter((base) =>
        selected.every((air) =>
          fromBox
            ? airDistanceToOffMapBox(air.side, base.hex) <= air.rangeHexes * 2
            : airDistanceFromRealBase(air, base.hex) <= air.rangeHexes * 2,
        ),
      )
      .map((base) => base.hex)
  })

  /** 14.11：该基地是否有飞机够得到图外盒（够 ⇒ 菜单出现「进入地图外盒」） */
  function transferHasBoxOption(baseId: string): boolean {
    const base = ownAirBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    return airUnitsAt(base.hex, base.side).some((air) => canTransferAirToBox(air))
  }

  /** 14.11：该基地是否有飞机够得到另一个己方基地（够 ⇒ 菜单出现「放入别的空军基地」） */
  function transferHasBaseOption(baseId: string): boolean {
    const base = ownAirBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    const planes = airUnitsAt(base.hex, base.side)
    return planes.some((air) =>
      ownAirBases.value.some(
        (dest) =>
          dest.id !== baseId && airDistanceFromRealBase(air, dest.hex) <= air.rangeHexes * 2,
      ),
    )
  }

  /**
   * 14.11：**这一架**此刻是否有够得到的别的本方基地（右键菜单据此决定出不出「转移基地」）
   *
   * 与 `transferBaseCandidates` 同源判据（图上按格距、盒内按 1.4a 盒代价，均可双倍航程），
   * 区别只是不要求先建转场中间态 —— 菜单要"能做的才出现"，不能在打开菜单时改状态。
   */
  function canTransferAirToBaseNow(instanceId: string): boolean {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air === undefined) return false
    const fromBox = airBoxMembers.value.includes(instanceId)
    return ownAirBases.value.some((dest) => {
      if (!fromBox && sameHex(dest.hex, air.hex)) return false
      return fromBox
        ? airDistanceToOffMapBox(air.side, dest.hex) <= air.rangeHexes * 2
        : airDistanceFromRealBase(air, dest.hex) <= air.rangeHexes * 2
    })
  }

  /** 14.11：开始一次转场（`baseId` 为空 ⇒ 从盒出发） */
  function beginTransferNow(
    mode: 'box' | 'base',
    baseId: string | null,
    fromBox: boolean,
  ): boolean {
    if (!actionAllowedNow('air.transfer')) {
      pushLog('warning', '当前环节不能转场（14.11）', '14.11')
      return false
    }
    transferMode.value = mode
    transferBaseId.value = baseId
    transferFromBox.value = fromBox
    transferSelectedIds.value = []
    pushLog(
      'info',
      mode === 'box'
        ? '转场（14.11）：勾选要移入图外空军盒的飞机，再点「确认移入」'
        : '转场（14.11）：勾选要转场的飞机，再点「选择目的基地」',
      '14.11',
    )
    return true
  }

  function toggleTransferAircraft(instanceId: string): boolean {
    if (!transferCandidates.value.some((air) => air.instanceId === instanceId)) return false
    const current = transferSelectedIds.value
    transferSelectedIds.value = current.includes(instanceId)
      ? current.filter((id) => id !== instanceId)
      : [...current, instanceId]
    return true
  }

  /** 结束转场交互（不改盘面） */
  function cancelTransferNow(): void {
    transferMode.value = null
    transferBaseId.value = null
    transferFromBox.value = false
    transferSelectedIds.value = []
  }

  /**
   * 14.11：落到目的基地（用户点选高亮基地格后调用）
   *
   * 战斗机在**正常航程内**保持激活；超出正常航程（但 ≤ 双倍）转入非激活。
   * 盒→图上基地：先 `setAirInBoxMembership(false)` 把飞机放回图上，再改格。
   */
  function completeTransferToBaseNow(dest: HexRef): boolean {
    const selected = transferSelectedIds.value
      .map((id) => airUnits.value.find((item) => item.instanceId === id))
      .filter((air): air is ConsoleAirUnit => air !== undefined)
    if (selected.length === 0) return false
    if (!transferBaseCandidates.value.some((hex) => sameHex(hex, dest))) return false
    for (const air of selected) {
      // 14.11：盒→基地按 1.4a 盒代价（20/30 + 列距）；图上基地→基地按格距
      const distance = transferFromBox.value
        ? airDistanceToOffMapBox(air.side, dest)
        : airDistanceFromRealBase(air, dest)
      if (transferFromBox.value) setAirInBoxMembership(air.instanceId, false)
      air.hex = { col: dest.col, row: dest.row }
      // 14.11：只有**战斗机**在正常距离内保持激活；其余机型/超出正常距离一律非激活
      air.airStatus =
        isFighterAircraft(air.aircraftType) && distance <= air.rangeHexes ? 'active' : 'inactive'
    }
    pushLog('info', `转场（14.11）：${selected.length} 架飞机转到 ${hexLabel(dest)}`, '14.11')
    cancelTransferNow()
    return true
  }

  /**
   * 条 4：**可开整备的基地**（15.1 / 15.1B）
   *
   * 判据：**当前在 A 整备段** ∧ 本方基地 ∧ 本阶段尚未整备过 ∧ 格内有非激活飞机 ∧ 能拖到补给（1T）
   *       ∧ **不在未抵消的敌方 ZOC 内**（15.1C）∧ **激活堆叠还有余额**（14.2a）。
   * 后两条修前只在引擎的 `planBaseRefit` 里判 ⇒ 基地照样高亮/出整备入口，玩家勾完机、
   * 付完款才被拒（回执还只在日志里）——按"不可用项不出现"的口径收在这里。
   * 提交入口 `beginRefitNow` 收的是**基地 id** ⇒ 合法动作视图的候选也从这里取（P0-02c）。
   * 「整备完消失」自动成立：整备后该基地进 `refitDoneBaseIds`、飞机转激活 ⇒ 两个条件都不再成立。
   */
  const refitStartBases = computed<AirBaseView[]>(() => {
    if (phase.value !== 'aircraftRefit') return []
    return ownAirBases.value
      .filter((base) => !refitDoneBaseIds.value.includes(base.id))
      .filter((base) => base.inUnnegatedEnemyZoc !== true)
      .filter((base) => airInactiveAtBase.value(base.id).length > 0)
      .filter((base) => refitSelectLimitAt(base.id) > 0)
      .filter((base) => airRefitPayDumps.value(base.id).length > 0)
  })

  /** 条 4：可整备的机场格（地图高亮；由 `refitStartBases` 映射，判据只留一处） */
  const refitAirbaseHexes = computed<readonly HexRef[]>(() =>
    refitStartBases.value.map((base) => ({ col: base.hex.col, row: base.hex.row })),
  )

  /**
   * 条 4：某基地**此刻不能整备**的原因（null＝能整备）
   *
   * 与 `refitStartBases` 同一组判据、同一顺序：能整备的基地在那里出入口，
   * 不行的这里给一句"为什么"（15.1A / 15.1C / 15.1B·12.3a / 14.2a）——
   * 入口按老口径不出现，但玩家不能看不出原因。
   */
  function refitBlockReasonAt(baseId: string): string | null {
    if (phase.value !== 'aircraftRefit') return null
    const base = ownAirBases.value.find((item) => item.id === baseId)
    if (base === undefined) return null
    if (refitDoneBaseIds.value.includes(base.id)) return '15.1A：本阶段该基地已整备过'
    if (base.inUnnegatedEnemyZoc === true) return '15.1C：未抵消的敌方 ZOC 内不可整备'
    if (airInactiveAtBase.value(base.id).length === 0) return '15.1：该基地没有非激活飞机可整备'
    if (refitSelectLimitAt(base.id) === 0)
      return '14.2a：激活堆叠已满（上限 4 + 等级），没有整备名额'
    if (airRefitPayDumps.value(base.id).length === 0)
      return '15.1B / 12.3a：该基地够不到可付款的补给站（1T）'
    return null
  }

  /** C9：本阶段已缩减过的基地（15.4；视图用） */
  const reducedBases = computed(() =>
    ownAirBases.value.filter((base) => reducedBaseIds.value.includes(base.id)),
  )

  /** C9 第 1 步（14.2f-A/B）：宣布任务并分配飞机（含起飞基地归属与航程校验） */
  function beginAirMissionNow(): boolean {
    if (!airMissionDomain.canReplace()) return false
    if (refuseWhileSettling('宣布空军任务')) return false
    if (
      ports.specialPending.value !== null ||
      (supplyState.value !== null && !supplyState.value.finished) ||
      refitBase.value !== null
    ) {
      airError.value = { rule: '14.2f', reason: 'completePendingSettlementBeforeAirMission' }
      pushLog('warning', '先完成当前特殊位移、补给付款或整备，再宣布空军任务', '14.2f')
      return false
    }
    // 14.2e：任务按**环节**分派（移动环节：低空扫射/空运/空投/基地转移/战机扫荡；轰炸环节：空军轰炸/运输破坏）
    if (!requireAction('air.mission', '宣布空军任务')) return false
    /*
     * 14.2e / 10.0 第二段：任务种类必须属于当前环节（UI 已按环节过滤，这里堵绕过界面的旁路）。
     * 移动环节宣布普通轰炸 ⇒ 直接拒，不留到轰炸结算才失败。
     */
    const missionSegmentKind = ports.airMissionSegmentKind.value
    if (
      missionSegmentKind === null ||
      missionSegmentOf(airMissionKind.value) !== missionSegmentKind
    ) {
      airError.value = {
        rule: '14.2e',
        reason: `missionKindOutsideSegment:${airMissionKind.value}`,
      }
      pushLog(
        'warning',
        `14.2e：${airMissionKindLabel(airMissionKind.value)}不属于本环节，请先切换任务类型`,
        '14.2e',
      )
      return false
    }
    const target = airTargetHex.value
    if (target === null) {
      pushLog('warning', '请先填任务格（14.2f-B）', '14.2f-B')
      return false
    }
    const aircraft = airMissionAirUnits.value
    if (aircraft.length === 0) {
      pushLog('warning', '请先勾选参战飞机（14.2f-A）', '14.2f-A')
      return false
    }
    // 14.9a/14.9e（T15）：多起点/多基地分装按逐机货单与各机起点处理，不再整组拒绝。
    const carriesCargo =
      airMissionKind.value === 'air_transport' || airMissionKind.value === 'air_drop'
    const cargo: AirMissionCargo[] = []
    for (
      let index = 0;
      index < (carriesCargo ? Math.max(0, Math.trunc(airInputs.value.cargoSpT)) : 0);
      index += 1
    )
      cargo.push({ id: `sp:${index + 1}`, kind: 'sp', t: 1 })
    for (const unitId of carriesCargo ? airInputs.value.cargoUnitIds : []) {
      const unit = units.value.find((entry) => entry.instanceId === unitId)
      if (unit === undefined) {
        airError.value = { rule: '14.9a', reason: `cargoUnitMissing:${unitId}` }
        pushLog('warning', '所选货物单位已不存在，请重新选择货物', '14.9a')
        return false
      }
      cargo.push({
        id: `unit:${unitId}`,
        kind: 'unit',
        isCombat: unit.isCombat,
        // 14.9c（第五批批 C 切片 2）：单位货物须**移动模式**、且**步行 MP ≤ 10**
        // 使用移动面的印刷MA、机动类型和RE；不得用战斗面步行MA代替移动面轮式MA。
        mode: canonicalMode(unit.mode),
        ma: unit.faces.move.ma,
        re: unit.re,
        mobility: unit.faces.move.mobility,
        side: unit.side,
        sourceHex: { ...unit.hex },
      })
    }
    const unitLoad = acceptAir(airUnitTransit.prepare(cargo), '单位装载计划')
    if (unitLoad === null) return false
    const moving = moveInteraction.value
    const handoff = acceptAir(
      checkAirTransportMovementHandoff({
        cargoUnitIds: unitLoad.items.map((item) => item.unit.instanceId),
        movingUnitIds:
          moving === null || moving.finished || moving.steps.length === 0
            ? []
            : moving.unitIds.filter((id) =>
                units.value.some((unit) => unit.instanceId === id && !unit.movementEnded),
              ),
      }),
      '地面移动交接',
    )
    if (handoff === null) return false
    const data = acceptAir(
      beginAirInteraction({
        side: airActingSide.value,
        phase: phase.value,
        kind: airMissionKind.value,
        targetHex: target,
        flyingAllowed: airInputs.value.flyingAllowed,
        weatherNormal: airInputs.value.weatherNormal,
        /*
         * 专规 1.5：受限飞行 = **天气允许飞行但天气不正常**（能飞，只是受限）
         * ⇒ 仅移动阶段可执行任务（反应 / 进击不可）。两者是不同的事，不得互相替代。
         */
        weatherLimited: airInputs.value.flyingAllowed && !airInputs.value.weatherNormal,
        /*
         * 专规 1.4a：驻在图外空军盒的飞机**从对应列入场**，剩余航程 = 印刷航程 − 20/30 格
         * （用户 2026-10-30 口径）。判据在引擎 `assignAirMission`，这里只把事实交过去。
         */
        aircraft: aircraft.map((plane) =>
          toAirMissionAircraftView(
            plane,
            airBoxMembers.value.includes(plane.instanceId)
              ? { edgeCol: airBoxEdgeColumn(plane.side), rangeCost: airBoxRangeHexes(plane.side) }
              : null,
          ),
        ),
        bases: airBases.value,
        cargo,
        // 14.9a/14.9e（T14）：显式逐机货单；null 时由引擎确定性自动分配。
        ...(carriesCargo && airInputs.value.cargoByAircraft !== null
          ? { cargoByAircraft: airInputs.value.cargoByAircraft }
          : {}),
        // 14.10b：空投战斗单位须有计划（格 / 制定回合 / 执行回合）
        ...(airMissionKind.value === 'air_drop'
          ? {
              airdropPlan: {
                targetHex: target,
                plannedTurn: airInputs.value.airdropPlannedTurn,
                scheduledTurn: airInputs.value.airdropScheduledTurn,
                currentTurn: turn.value,
              },
            }
          : {}),
      }),
      '宣布任务',
    )
    if (data === null) return false
    /*
     * 14.9a/14.9e（T15）：按逐机货单与各机起点分装补给。
     * 每架机只从**自己的起点格/离图盒**扣 SP；同一格的多架机需求先合并，避免重复算一份库存。
     */
    const supplyOrigins = new Map<
      string,
      { hex?: HexRef; offMap: boolean; box?: string; requestedT: number }
    >()
    for (const entry of data.assignment.cargoByAircraft) {
      const spT = entry.cargoIds.filter((id) => id.startsWith('sp:')).length
      if (spT === 0) continue
      const origin = data.assignment.origins.find((item) => item.aircraftId === entry.aircraftId)
      if (origin === undefined) continue
      const box = airActingSide.value
      const key = origin.fromOffMapBox === true ? `box:${box}` : `hex:${hexLabel(origin.baseHex)}`
      const current = supplyOrigins.get(key)
      if (current === undefined)
        supplyOrigins.set(
          key,
          origin.fromOffMapBox === true
            ? { offMap: true, box, requestedT: spT }
            : { hex: { ...origin.baseHex }, offMap: false, requestedT: spT },
        )
      else current.requestedT += spT
    }
    const spCargoT = cargo.filter((item) => item.kind === 'sp').length
    // 14.9（T16）：图外盒库存也是合法装货来源；地图内仍只认同格库存。
    const offMapSources = Object.entries(offMapSupplyStocks.value).flatMap(([key, holdings]) => {
      const [side, box] = key.split(':')
      if (side !== 'axis' && side !== 'soviet') return []
      return [
        {
          id: `offmap:${key}`,
          side: side as Side,
          offMap: true,
          box: box ?? '',
          ...holdings,
        },
      ]
    })
    const supplyLoad =
      spCargoT === 0
        ? { manifest: null, debits: [] }
        : acceptAir(
            planAirSupplyLoad({
              side: airActingSide.value,
              requestedT: spCargoT,
              origins: [...supplyOrigins.values()],
              sources: [...spDumps.value, ...offMapSources],
            }),
            '装载空运补给',
          )
    if (supplyLoad === null) return false
    const transportStates = new Map<string, AirUnitTransportState>()
    for (const { unit } of unitLoad.items) {
      const budget = acceptAir(
        planAirUnitTransport({
          kind: airMissionKind.value === 'air_drop' ? 'air_drop' : 'air_transport',
          phase: movementPhaseOf(phase.value),
          mode: unit.mode,
          ma: unit.faces.move.ma,
          spentMp: unit.mpSpent,
          previous: unit.airTransportThisPhase,
        }),
        '空运地面移动额度',
      )
      if (budget === null) return false
      transportStates.set(unit.instanceId, budget.transport)
    }
    if (!airUnitTransit.load(unitLoad)) {
      airError.value = { rule: '14.9a', reason: 'airUnitLoadPlanChanged' }
      return false
    }
    for (const { unit } of unitLoad.items)
      unit.airTransportThisPhase = transportStates.get(unit.instanceId)!
    groundMovement.markIrreversible('空军任务（14.2f）')
    if (
      handoff.detachMovement ||
      moving?.unitIds.some((id) => unitLoad.items.some((item) => item.unit.instanceId === id))
    )
      clearMoveInteraction()
    airMissionDomain.start(data)
    // 引擎与库存校验全部成功后，一次性扣账；失败的宣布不会消耗库存。
    const mapDebits = new Map(
      supplyLoad.debits
        .filter((debit) => debit.offMap !== true)
        .map((debit) => [debit.id, debit.after]),
    )
    spDumps.value = spDumps.value.flatMap((dump) => {
      const after = mapDebits.get(dump.id)
      return after === undefined ? [dump] : after.sp + after.t === 0 ? [] : [{ ...dump, ...after }]
    })
    const offMapDebits = supplyLoad.debits.filter((debit) => debit.offMap === true)
    if (offMapDebits.length > 0) {
      const next = { ...offMapSupplyStocks.value }
      for (const debit of offMapDebits)
        next[`${debit.side ?? airActingSide.value}:${debit.box ?? ''}`] = debit.after
      offMapSupplyStocks.value = next
    }
    airSupply.load(supplyLoad)
    if (unitLoad.items.length > 0)
      recordSettlement({
        action: 'airUnitLoad',
        rule: '14.9a',
        data: {
          items: unitLoad.items.map((item) => ({
            id: item.cargoId,
            sourceHex: item.sourceHex,
            spentMp: item.unit.mpSpent,
            transport: item.unit.airTransportThisPhase,
          })),
        },
      })
    if (supplyLoad.manifest !== null)
      recordSettlement({
        action: 'airSupplyLoad',
        rule: '14.9a',
        data: { manifest: supplyLoad.manifest, debits: supplyLoad.debits },
      })
    const assignment = data.assignment
    pushLog(
      'info',
      `宣布任务（14.2f-A）：${airMissionKindLabel(data.kind)} → ${hexLabel(target)}；参战 ${assignment.aircraftIds.length} 架` +
        `（最远 ${assignment.maxDistanceHexes} 格${assignment.allWithinShortRange ? '，全在 10 格内 ⇒ 14.7c 短程修正' : ''}）` +
        (assignment.cargoCapacity > 0 ? `；总运力 ${assignment.cargoCapacity} T` : '') +
        (airTransportProfiles.value.length === 0
          ? ''
          : `；逐机飞法 ${airTransportProfiles.value
              .map(
                (item) =>
                  `${item.aircraftId} 档 ${item.profile}${item.capacityMultiplier === 2 ? '（容量×2）' : ''}`,
              )
              .join('、')}（14.9e）`),
      assignment.rule,
    )
    // ⑭ 接线：空军任务宣布与分配（14.2f-A/B）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airMission',
      rule: assignment.rule,
      data: {
        stage: 'declare',
        kind: data.kind,
        targetHex: { ...target },
        aircraftIds: [...assignment.aircraftIds],
        maxDistanceHexes: assignment.maxDistanceHexes,
        allWithinShortRange: assignment.allWithinShortRange,
        cargoCapacity: assignment.cargoCapacity,
      },
    })
    return true
  }

  /**
   * C9 第 2 步（14.2f-C / 14.3 / 14.3e）：空战环节 + **逐轮推进**
   *
   * ★ 归属权：只有任务格内有**敌方**空军基地、且双方在该格都有**激活**飞机时才会发生空战（14.3）；
   * 参战名单由**盘面上实际摆在该格的飞机**推出（不再手工填数字）。
   * 发生空战时立即按 14.3e 逐轮结算（B 点名 → C 掷骰 → 每对一轮直至一方清空），
   * 返航者回基地转**非激活**（14.1c），损失骰命中者扣 1 点军力（14.1b）。
   */
  /**
   * 14.3e-B：把逐轮点名整理成引擎的 `picks` 参数
   *
   * · 下标＝轮次；某轮某侧没点 ⇒ **不给该字段**（引擎按 ACV 最高自动取，14.3e-B 的缺省口径）；
   * · 第 1 轮的守方点位沿用 `namedDefenderId`（14.5 拦截那处"任务方指定迎战机"是同一件事的
   *   另一个入口，两处指向同一架才不会被玩家看成两套）；
   * · 一行都没点 ⇒ 连 `picks` 都不给（保持修前的全自动行为，纯粹不再多传一个空数组）。
   */
  function airCombatPicksPayload():
    | { picks: { attackerAircraftId?: string; defenderAircraftId?: string }[] }
    | Record<string, never> {
    const rows = airInputs.value.airCombatPicks
    const named = airInputs.value.namedDefenderId
    if (rows.every((row) => row.attackerAircraftId === null && row.defenderAircraftId === null)) {
      return named === null ? {} : { picks: [{ defenderAircraftId: named }] }
    }
    return {
      picks: rows.map((row, index) => ({
        ...(row.attackerAircraftId === null ? {} : { attackerAircraftId: row.attackerAircraftId }),
        ...(row.defenderAircraftId === null
          ? index === 0 && named !== null
            ? { defenderAircraftId: named }
            : {}
          : { defenderAircraftId: row.defenderAircraftId }),
      })),
    }
  }

  function confirmAirCombatNow(): boolean {
    const state = airState.value
    if (state === null) return false
    const target = airTargetHex.value
    if (target === null) {
      pushLog('warning', '请先填任务格（14.2f-B）', '14.2f-B')
      return false
    }
    const enemy = enemySide.value
    const friendlyAircraft = airMissionFlyingUnits.value
    const enemyAircraft = airUnitsInHex(target, enemy)
    const enemyAirBaseInHex = airBases.value.some(
      (base) => base.side === enemy && sameHex(base.hex, target),
    )
    const data = acceptAir(
      declareAirCombatStep(state, {
        friendlyAircraft: friendlyAircraft.map((plane) => toAirMissionAircraftView(plane)),
        enemyActiveCount: enemyAircraft.length,
        enemyCanInitiate: enemyAircraft.some((air) => air.canInitiateAirCombat),
        enemyAirBaseInHex,
      }),
      '空战环节',
    )
    if (data === null) return false
    let next = data.state
    const combat = next.combat
    if (combat === null) {
      airState.value = next
      return true
    }
    if (!combat.occurs) {
      airState.value = next
      pushLog('info', `空战环节（14.2f-C）：${combat.roles.detail}`, combat.roles.rule)
      // ⑭ 接线：空战环节未发生（14.3）入会话日志（本笔不掷骰）
      recordSettlement({
        action: 'airCombat',
        rule: combat.roles.rule,
        data: { occurs: false, detail: combat.roles.detail },
      })
      return true
    }

    // 14.3e：逐轮推进（骰面逐轮现掷；种子化 RNG 存于 state.rng）
    const roles = combat.roles
    if (roles.attackerSide === null || roles.defenderSide === null) {
      airState.value = next
      return true
    }
    const ours = roles.attackerSide === airActingSide.value
    const attackerViews = (ours ? friendlyAircraft : enemyAircraft).map((plane) =>
      toAirMissionAircraftView(plane),
    )
    const defenderViews = (ours ? enemyAircraft : friendlyAircraft).map((plane) =>
      toAirMissionAircraftView(plane),
    )
    // ⑭ 接线：drawAir2d6 / drawAir1d6 只回报数字（不改它们）⇒ 先记下掷骰前的骰源，
    // 按同一颗 PRNG 逐轮复算出骰面（14.3e 每对一轮：2 骰 + 1 损失骰）供会话日志复算。
    // 教学模式可走既有的「裁判骰覆写」入口钉住某一课的骰面（覆写时不记 rolls，同 interceptDie）。
    const overrideDice = airInputs.value.airCombatDice
    const rngBefore = rng.value
    const dice: { die: number; lossDie: number }[] = []
    const rolls: DiceRoll[] = []
    if (overrideDice !== null) {
      dice.push(...overrideDice.map((item) => ({ die: item.die, lossDie: item.lossDie })))
    } else {
      const roundBudget = Math.max(1, attackerViews.length + defenderViews.length)
      for (let index = 0; index < roundBudget; index += 1)
        dice.push({ die: drawAir2d6(), lossDie: drawAir1d6() })
      let cursor = rngBefore
      for (let index = 0; index < dice.length; index += 1) {
        const dieDraw = roll2d6(cursor)
        cursor = dieDraw.rng
        rolls.push(dieDraw.value)
        const lossDraw = roll1d6(cursor)
        cursor = lossDraw.rng
        rolls.push(lossDraw.value)
      }
    }
    const resolved = acceptAir(
      resolveAirCombatRounds({
        attackerSide: roles.attackerSide,
        attackerAircraft: attackerViews,
        defenderAircraft: defenderViews,
        // 14.3e-B：逐轮点名（见 airCombatPicksPayload；未点名 ⇒ 引擎按 ACV 最高自动取）
        ...airCombatPicksPayload(),
        dice,
      }),
      '空战逐轮',
    )
    if (resolved === null) return false

    // 应用战果：返航者回基地转非激活（14.1c，其 hex 本来就是基地格）；损失骰命中者扣军力（14.1b）
    for (const round of resolved.rounds) {
      for (const id of [...round.returnedAttackerIds, ...round.returnedDefenderIds])
        setAirStatus(id, 'inactive')
      for (const id of round.stepLossIds) applyAirStepLoss(id)
    }
    next = { ...next, airCombat: resolved }
    airState.value = next
    for (const round of resolved.rounds)
      pushLog(round.stepLossIds.length > 0 ? 'warning' : 'info', round.detail, '14.3e')
    pushLog('info', resolved.detail, resolved.rule)
    // ⑭ 接线：空战逐轮（14.3e）入会话日志；rolls＝逐轮的 2 骰 + 1 损失骰（按实际掷骰顺序）
    recordSettlement({
      action: 'airCombat',
      rule: resolved.rule,
      rolls,
      data: {
        occurs: true,
        rounds: resolved.rounds.length,
        detail: resolved.detail,
      },
    })
    return true
  }

  /** C9：该格内某方的**全部**飞机（9.14f 按每架飞机掷夺取表） */
  /**
   * 专规 1.4a：该机是否驻在**地图外空军盒**里（盒即基地，图上没有它的位置）
   *
   * 本作不为盒内飞机另存坐标：`hex` 保留原位只为"回盒再出场"方便（见
   * `setAirInBoxMembership`），所以**凡按格判定"这里有哪几架飞机"都必须过这一层**。
   */
  function isAirInOffMapBox(air: ConsoleAirUnit): boolean {
    return airBoxMembers.value.includes(air.instanceId)
  }

  /** 专规 1.4a：**在图上**的飞机（盒内驻机不算：它们在盒里，不在任何一格） */
  const onMapAirUnits = computed<ConsoleAirUnit[]>(() =>
    airUnits.value.filter((air) => !isAirInOffMapBox(air)),
  )

  function airUnitsAt(hex: HexRef, side: Side): ConsoleAirUnit[] {
    return onMapAirUnits.value.filter((air) => air.side === side && sameHex(air.hex, hex))
  }

  /** 一个候选格的盘面事实（目标候选与"这一格能发什么任务"共用，避免两套判据） */
  function airTargetFactsAt(ref: HexRef): AirTargetHexFacts {
    const side = airActingSide.value
    return {
      hex: ref,
      enemyGroundUnit: units.value.some((unit) => unit.side !== side && sameHex(unit.hex, ref)),
      enemyFacility: airBases.value.some((base) => base.side !== side && sameHex(base.hex, ref)),
      enemyActiveAircraft: onMapAirUnits.value.some(
        (air) =>
          air.side !== side && air.airStatus === 'active' && air.steps > 0 && sameHex(air.hex, ref),
      ),
      enemyAirBase: airBases.value.some((base) => base.side !== side && sameHex(base.hex, ref)),
      friendlyAirBase: airBases.value.some((base) => base.side === side && sameHex(base.hex, ref)),
      rail: ports.railMoveFacts.value.hasRail(ref),
    }
  }

  /** 这架飞机的**机型**能否执行该任务（14.7–14.10；激活态/环节/航程另判，见 `airPlaneCanPerformKind`） */
  function airTypeCanPerformKind(air: ConsoleAirUnit, kind: AirMissionKind): boolean {
    switch (kind) {
      case 'barrage':
      case 'trainbusting':
        return air.canBarrage && (air.barrageStrength ?? 0) > 0
      case 'hip_shoot':
        return air.canHipShoot
      case 'air_transport':
      case 'air_drop':
        return air.transportCapacity > 0
      case 'fighter_sweep':
        return air.canInitiateAirCombat
      default:
        return false
    }
  }

  /** 这架飞机是否有能力执行该任务类型（14.7–14.10；环节与航程另判） */
  function airPlaneCanPerformKind(air: ConsoleAirUnit, kind: AirMissionKind): boolean {
    if (air.airStatus !== 'active' || air.missionsFlownThisPhase > 0) return false
    return airTypeCanPerformKind(air, kind)
  }

  /**
   * 14.2f-B **目标侧入口判据**：这一格现在能不能作为该任务类型的目标
   *
   * = 环节允许（`airMissionKindChoices`）∩ 目标类型合法（14.6–14.10）∩ 至少一架可出动飞机够得到。
   * 用户 2026-11-12：所有主动任务都从目标右键发起，菜单项不满足就整项不出现。
   */
  function canAirMissionTarget(kind: AirMissionKind, hex: HexRef): boolean {
    if (!ports.airMissionKindChoices.value.some((choice) => choice.key === kind)) return false
    if (!airMissionTargetTypeAllowed(kind, airTargetFactsAt(hex))) return false
    /*
     * 10.0b：低空扫射必须有**正确观察员**（与右键入口 `hipShootEntryEligible` 同一判据）。
     * 修前这里不判，AI / 目标候选会给出结算时必被 10.0b 拒的格 ⇒ 任务宣布后卡在结算步。
     */
    if (kind === 'hip_shoot' && !ports.barrageFacts.value.hasSpotter(hex)) return false
    const side = airActingSide.value
    const planes = airUnits.value.filter(
      (air) => air.side === side && airPlaneCanPerformKind(air, kind),
    )
    return planes.some((air) => airDistanceFromRealBase(air, hex) <= air.rangeHexes)
  }

  /**
   * 14.2f-B：**任务目标格的候选集**（用户 2026-11-12 口径 —— 地图高亮点选，不再手输格号）
   *
   * 两个条件的交集，全部在引擎侧统一算（`airMissionTargetCandidates`）：
   *   ① 任务对象类型合法（14.6–14.10，见引擎 `airMissionTargetTypeAllowed`）；
   *   ② 至少一架可参战机从**当前位置/出发基地**够得到（14.2d / 专规 1.4a）。
   * 输入只取地图格（`mapLayers.hexes`）—— 图外空军盒不是格，1.4 也禁止对盒内战斗，
   * 故它永远不会出现在候选里，UI 只渲染这个结果。
   */
  const airMissionTargetCandidates = computed<HexRef[]>(() => {
    const kind = airMissionKind.value
    if (kind === null) return []
    const selected = airMissionAirUnits.value
    const planes =
      selected.length > 0
        ? selected
        : ports.airMissionJoinChoices.value
            .filter((choice) => choice.disabledReason === null)
            .map((choice) => choice.air)
    if (planes.length === 0) return []
    const facts: AirTargetHexFacts[] = mapLayers.hexes.map((hex) =>
      airTargetFactsAt({ col: hex.col, row: hex.row }),
    )
    return engineAirMissionTargetCandidates({
      kind,
      hexes: facts,
      /*
       * 14.2d：参战机各自从**自己的出发格**飞到任务格，距离按各自航程算。
       * 已勾选编队时必须**每一架都够得到**（否则点选后才发现某架超程 = 高亮骗人）；
       * 尚未勾机时按"至少有一架可参战机够得到"，因为玩家可以据此挑机。
       */
      reachable: (hex) =>
        selected.length > 0
          ? planes.every((air) => airDistanceFromRealBase(air, hex) <= air.rangeHexes)
          : planes.some((air) => airDistanceFromRealBase(air, hex) <= air.rangeHexes),
    })
  })

  /**
   * 专规 1.4a：该机**从它真正的基地**飞到目标格的格数
   *
   * 图上的飞机，基地＝所在格（14.1a）；驻在**图外空军盒**的飞机，基地＝盒本身
   * ⇒ 距离＝「盒到连接列（苏 62 / 轴 1）的固定航程 20/30」＋「连接列到目标格的列差」，
   * 与引擎 `assignAirMission` 的入场模型**同源**（起点取「连接列 × 目标行」，同一行格距即列差）。
   *
   * ★ 修（2026-11-01）：修前这里直接用 `air.hex`（盒内飞机保留的原位格），
   *   于是任务面板会把"能出击的盒内飞机"标成 14.1 够不到（或被反向误放行）。
   */
  function airDistanceFromRealBase(air: ConsoleAirUnit, hex: HexRef): number {
    if (!isAirInOffMapBox(air)) return airRangeFromBase(air, hex)
    return (
      hexDistance({ col: airBoxEdgeColumn(air.side), row: hex.row }, hex) +
      airBoxRangeHexes(air.side)
    )
  }

  /** C9：该格内某方的**激活**飞机（14.1a/14.3：非激活飞机不参加空战） */
  function airUnitsInHex(hex: HexRef, side: Side): ConsoleAirUnit[] {
    return airUnitsAt(hex, side).filter((air) => air.airStatus === 'active' && air.steps > 0)
  }

  /**
   * C9 第 5 步（14.2f-F / 14.10d）：空运/空投的成功检定
   *
   * 表 17-4 的两列由**目标格事实**决定：`Friendly` ＝本阶段开始时该格有己方单位；
   * `Clear` ＝ Open/Village，或任何含空军基地的格（`airTransportTerrainIsClosed`）。
   * 单位货物成功 ⇒ 置于空投格且本阶段移动结束；失败 ⇒ 被摧毁（14.10d）。
   */
  function resolveAirCargoNow(): boolean {
    return airCargoResolution.resolveAirCargoNow()
  }

  /** 14.9/14.10：已验证的货物计划统一提交；规则与限额不在这里重新计算。 */
  function applyAirCargoDelivery(
    state: AirInteractionState,
    result: AirCargoResolution,
    plan: AirCargoUnloadPlan,
  ): void {
    const target = state.targetHex
    airSupply.settle(
      result.items
        .filter((item) => item.kind === 'sp' && item.fate === 'destroyed')
        .map((item) => item.id),
      'lost',
    )
    for (const item of result.items) {
      if (item.kind !== 'unit') continue
      const unit = airUnitTransit.find(item.id)
      if (unit === undefined) continue // 提交前已由流程域核对完整性。
      if (item.fate === 'destroyed') {
        airUnitTransit.lose([item.id])
        eliminateEntry(unit, '14.10d', `${unit.name} 空投失败，被摧毁（14.10d）`)
        continue
      }
      if (item.fate === 'retained') {
        pushLog('info', `${unit.name} 未卸载，留在机上退运；保留空运阶段移动限制`, '14.9d/f')
        continue
      }
      airUnitTransit.land([item.id], target, 'delivered')
      if (state.kind === 'air_drop') {
        unit.movementEnded = true
        unit.airDropExemptTurn = turn.value
      }
      noteUnitEnteredHex(unit, target)
      pushLog(
        'success',
        `${unit.name} 抵达 ${hexLabel(target)}`,
        state.kind === 'air_drop' ? '14.10d' : '14.9d',
      )
    }
    if (plan.deliveredSpT > 0)
      addSpAtHex({ hex: target, side: state.side, sp: 0, t: plan.deliveredSpT, source: plan.rule })
    if (plan.consumedT > 0)
      ports.airUnloadLedger.value = {
        ...ports.airUnloadLedger.value,
        [`${state.side}:${hexLabel(target)}`]: airUnloadedTAt(target, state.side) + plan.consumedT,
      }
    airSupply.settle(plan.deliveredIds, 'delivered')
  }

  /**
   * C9：空军基地被夺取（9.14f，表 17-6）
   *
   * 「可攻击单位进入有敌方基地的格 ⇒ 基地被夺取且**可立即使用**；**无论天气**都要为格内**每架飞机**
   *   掷基地夺取表（+2 该机 Active；+2 由**战后推进**夺取）；幸存飞机**必须**转移到**距离 2 倍内**的
   *   任意友方空军基地并**变为非激活**；若 2 倍距离内没有友方基地则**摧毁**这些飞机。」
   *
   * ★ 归属权：夺取方＝该基地归属方的对手；基地算子翻面即改归属（此后本方才能使用它）。
   * 本动作由界面按钮声明「敌方可攻击单位已进入该格」（9.14 的统一前提）。
   */
  function captureAirBaseNow(
    baseId: string,
    /** 9.14f：是否由**战后推进**夺取（+2 DRM）。缺省取界面输入 */
    byAdvance: boolean = airInputs.value.baseCaptureByAdvance,
  ): boolean {
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    const enteringSide: Side = base.side === 'axis' ? 'soviet' : 'axis'
    // 专规 1.4a：盒内驻机不在该基地格上 ⇒ 不参与基地夺取的飞机处置
    const planes = onMapAirUnits.value.filter(
      (air) => air.side === base.side && sameHex(air.hex, base.hex),
    )
    const inputs = airInputs.value
    const rngBefore = rng.value
    const result = acceptAir(
      resolveSpecialCombat({
        hex: base.hex,
        enteringSide,
        attackCapableUnitEnters: true,
        phase: phase.value,
        objects: [
          {
            id: base.id,
            kind: 'airBase',
            hex: base.hex,
            owner: base.side,
            level: base.isAirstrip === true ? 0 : base.level,
            ...(base.isAirstrip === true ? { isAirstrip: true } : {}),
          },
        ],
        aircraft: planes.map((air) => ({
          id: air.instanceId,
          active: air.airStatus === 'active',
          roll2d6: inputs.baseCaptureDice ?? drawAir2d6(),
        })),
        capturedByAdvanceAfterCombat: byAdvance,
        aircraftEscape: {
          // 14.11：幸存者可转移到**距离 2 倍内**的任意**友方**空军基地
          // ★ 被夺取的这个基地此刻尚未翻面，必须按 id 排除，否则飞机会「留在原地」而免于处置
          friendlyBases: (side) =>
            airBases.value
              .filter((item) => item.side === side && item.id !== base.id)
              .map((item) => item.hex),
          canTransferTo: (aircraftId, baseHexTo) => {
            const air = airUnits.value.find((item) => item.instanceId === aircraftId)
            if (air === undefined) return false
            return resolveBaseTransfer({
              isFighter: isFighterAircraft(air.aircraftType),
              rangeHexes: air.rangeHexes,
              distanceHexes: hexDistance(air.hex, baseHexTo),
            }).ok
          },
          /*
           * 专规 1.4a：图外空军盒是**永远存在**的空军基地（用户 2026-10-30 口径：
           * 「不可能没有空军基地，因为至少有图外的」）⇒ 图上 2 倍航程内无处可去时，
           * 射程够 20/30 格就回盒，连盒都够不着才摧毁。判据与 `planOffMapAirBoxFlight` 同源。
           */
          offMapBox: (aircraftId: string) => {
            const air = airUnits.value.find((item) => item.instanceId === aircraftId)
            if (air === undefined) return null
            const flight = planOffMapAirBoxFlight({
              side: air.side,
              rangeHexes: air.rangeHexes,
            })
            if (!flight.ok) return null
            return { col: airBoxEdgeColumn(air.side), row: air.hex.row }
          },
        },
      }),
      '基地夺取（9.14f）',
    )
    if (result === null) return false

    // ⑭ 接线：drawAir2d6 只回报数字（不改它）⇒ 按掷骰前骰源逐机复算表 17-6 的骰面
    const rolls: DiceRoll[] = []
    if (inputs.baseCaptureDice === null) {
      let cursor = rngBefore
      for (let index = 0; index < planes.length; index += 1) {
        const derived = roll2d6(cursor)
        cursor = derived.rng
        rolls.push(derived.value)
      }
    }
    // 基地翻面（归属改为进入方）——此后只有该方才能用它（14.1a/14.1c/15.1/15.4）
    const baseUnit = units.value.find((unit) => unit.instanceId === baseId)
    if (baseUnit !== undefined) baseUnit.side = enteringSide
    // 逐机：先按表 17-6 施加军力损失，再转移/摧毁
    for (const item of result.aircraft) {
      if (item.stepLoss) applyAirStepLoss(item.id)
      const air = airUnits.value.find((entry) => entry.instanceId === item.id)
      if (air === undefined) continue
      if (item.fate === 'destroyed') {
        airUnits.value = airUnits.value.filter((entry) => entry.instanceId !== item.id)
        airMissionAirIds.value = airMissionAirIds.value.filter((id) => id !== item.id)
        pushLog('danger', `${air.name} 无处可转（2 倍距离内无友方基地）⇒ 摧毁（9.14f）`, '9.14f')
        continue
      }
      /*
       * 专规 1.4a：这次"转移"是**飞回图外空军盒**（盒即基地、容量无限）
       * ⇒ 只落盒成员账本并转非激活，**不改 `hex`**（盒没有地图格，改 hex 会把它摆在图上）。
       */
      if (item.toOffMapBox === true) {
        setAirInBoxMembership(air.instanceId, true)
        air.airStatus = 'inactive'
        pushLog(
          'warning',
          `${air.name} 无处转场 ⇒ 飞回图外空军盒并转非激活（9.14f / 专规 1.4a）`,
          '专规 1.4a',
        )
        continue
      }
      if (item.hex !== null) {
        air.hex = { ...item.hex }
        air.airStatus = 'inactive'
        pushLog('warning', `${air.name} 转移至 ${hexLabel(item.hex)} 并转非激活（9.14f）`, '9.14f')
      }
    }
    pushLog(
      'danger',
      `${hexLabel(base.hex)} 空军基地被 ${enteringSide === 'axis' ? '轴心国' : '苏联'}夺取（9.14f）；` +
        `格内 ${planes.length} 架飞机已按表 17-6 处置`,
      '9.14f',
    )
    // ⑭ 接线：空军基地夺取（9.14f / 表 17-6）入会话日志；rolls＝逐机夺取表骰
    recordSettlement({
      action: 'airBaseCapture',
      rule: '9.14f',
      rolls,
      data: {
        baseHex: { ...base.hex },
        enteringSide,
        byAdvance,
        aircraft: result.aircraft.map((item) => ({
          id: item.id,
          fate: item.fate,
          stepLoss: item.stepLoss,
          hex: item.hex === null ? null : { ...item.hex },
        })),
      },
    })
    return true
  }
  /* ── B2-2b：货物损失 / 防空结算 / 任务执行前半（2026-11-21 从 facade 迁入） ── */

  /**
   * 14.4f/14.4g：该任务**此刻**的货物容量（T）
   *
   * 按**仍在任务里的飞机**逐机重算：减损者取减损面印值（14.4f「减少后的数值」），
   * 并沿用分配时算定的距离档位（14.9e-C 的容量翻倍按各机在 `origins` 里的距离判定）。
   * 被防空摧毁的飞机已移出任务名单，故它的容量自然消失 —— 这正是 14.4g 的触发条件。
   */
  const airMissionCargoCapacityNow = computed(() => airMissionRosterNow.value?.activeCapacityT ?? 0)

  /** 14.4g：待玩家选择的**货物损失**（容量因防空变小、有超出部分时才落值） */
  const airCargoLossPending = ref<{
    rule: string
    capacityAfter: number
    allowedT: number
    excessT: number
    detail: string
  } | null>(null)

  function queueAirCargoLoss(capacityAfter: number, rule: string): void {
    const state = airState.value
    if (state === null || (state.kind !== 'air_transport' && state.kind !== 'air_drop')) return
    const plan = planCargoLoss({
      cargo: state.assignment.cargo.map((item) => ({ id: item.id, t: airCargoTransportT(item) })),
      capacityAfter,
    })
    if (plan.ok && plan.data.excessT > 0) {
      airCargoLossPending.value = {
        capacityAfter,
        allowedT: plan.data.allowedT,
        excessT: plan.data.excessT,
        detail: plan.data.detail,
        rule,
      }
      pushLog('warning', `${plan.data.detail}；请先确认货物损失`, rule)
    }
  }

  /** 14.4g：玩家勾选要摧毁的货物件 */
  const airCargoLossPicked = ref<string[]>([])

  /** 14.4g：勾选/取消一件要摧毁的货物 */
  function toggleAirCargoLossPick(cargoId: string): void {
    airCargoLossPicked.value = airCargoLossPicked.value.includes(cargoId)
      ? airCargoLossPicked.value.filter((id) => id !== cargoId)
      : [...airCargoLossPicked.value, cargoId]
  }

  /**
   * 14.4g：**落盘货物损失**（把选中的货物从任务货物清单里移除）
   *
   * 判据走引擎（`validateCargoLossChoice`：摧毁量必须覆盖超出部分）；
   * 提交在途账本、单位淘汰及任务清单，避免仍能退回已损失的货物。
   */
  function confirmAirCargoLossNow(): boolean {
    const state = airState.value
    const pending = airCargoLossPending.value
    if (state === null || pending === null) return false
    const cargo = state.assignment.cargo.map((item) => ({
      id: item.id,
      t: airCargoTransportT(item),
    }))
    const verdict = validateCargoLossChoice({
      cargo,
      capacityAfter: pending.capacityAfter,
      destroyedIds: airCargoLossPicked.value,
    })
    if (!verdict.ok) {
      pushLog('danger', `货物损失被拒：${verdict.reason}（${verdict.rule}）`, verdict.rule)
      return false
    }
    const destroyed = new Set(airCargoLossPicked.value)
    const unitLossIds = state.assignment.cargo
      .filter((item) => item.kind === 'unit' && destroyed.has(item.id))
      .map((item) => item.id)
    const lostUnits = airUnitTransit.lose(unitLossIds)
    if (lostUnits === null) {
      airError.value = { rule: pending.rule, reason: 'airCargoLossUnitMissing' }
      return false
    }
    airSupply.settle([...destroyed], 'lost')
    for (const unit of lostUnits)
      eliminateEntry(unit, pending.rule, `${unit.name} 作为运输货物损失（${pending.rule}）`)
    const kept = state.assignment.cargo.filter((item) => !destroyed.has(item.id))
    airState.value = {
      ...state,
      assignment: {
        ...state.assignment,
        cargo: kept,
        // 14.9a/14.9e（T14）：货单与实际在途货物保持同步，避免 F 步再结算已摧毁货物。
        cargoByAircraft: state.assignment.cargoByAircraft.map((entry) => ({
          ...entry,
          cargoIds: entry.cargoIds.filter((id) => !destroyed.has(id)),
        })),
      },
      cargo: null,
    }
    pushLog(
      'success',
      `${pending.rule}：${verdict.data.detail}；余下 ${String(kept.length)} 件货物继续本任务`,
      pending.rule,
    )
    // ⑭ 接线：货物损失（14.4g）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airCargoLoss',
      rule: pending.rule,
      data: {
        capacityAfter: pending.capacityAfter,
        allowedT: pending.allowedT,
        excessT: pending.excessT,
        destroyedIds: [...destroyed],
        destroyedT: verdict.data.destroyedT,
        remaining: kept.map((item) => item.id),
        detail: verdict.data.detail,
      },
    })
    airCargoLossPending.value = null
    airCargoLossPicked.value = []
    return true
  }

  /** 14.9a / 14.9e（T14）：本任务是否已有可确定损失归属的逐机货单。 */
  function hasCargoOwnership(state: AirInteractionState): boolean {
    return state.assignment.cargo.length > 0 && state.assignment.cargoByAircraft.length > 0
  }

  /** C9 第 4 步（14.2f-E / 14.4）：防空应答（对手掷骰；命中则按 14.4f 的任务损失表定承受者） */
  function resolveFlakNow(): boolean {
    const state = airState.value
    if (state === null) return false
    if (
      state.step !== 'flak' ||
      (state.interception?.declared && state.interception.combat === null)
    ) {
      airError.value = { rule: '14.2f-E', reason: 'airFlakStepNotReady' }
      return false
    }
    if (airMissionFlyingUnits.value.length === 0) {
      const skipped = acceptAir(skipEmptyAirMissionFlak(state), '中止任务跳过防空')
      if (skipped === null) return false
      airState.value = skipped.state
      if (airMissionRosterNow.value?.liveCapacityT === 0 && !hasCargoOwnership(state))
        queueAirCargoLoss(0, '14.1b')
      pushLog('info', '没有活动任务机，跳过防空并处理退运或货物损失', '14.2f-E')
      return true
    }
    /*
     * 14.1c / 14.9e：部分承运机中止时**不再拒在 E 步** ——
     * 中止机自载的货随它退运，幸存机继续投送各自货单里的货（见 `planAirCargoContinuation`
     * 的 `returningCargoIds`）；旧档没有逐机货单时按整组退运，不猜归属。
     */
    if (
      state.assignment.cargo.length > 0 &&
      airMissionRosterNow.value?.liveCapacityT === 0 &&
      !hasCargoOwnership(state)
    )
      queueAirCargoLoss(0, '14.1b')
    const inputs = airInputs.value
    const inPatrolZone = airTargetInEnemyPatrolZone.value
    // 14.1b/14.4f：任务损失表的 W/S 按**当前面**轰炸值选（减损机用减损面值）
    const missionAircraft = airMissionFlyingUnits.value.map((air) => ({
      id: air.instanceId,
      barrageStrength: airBarrageStrengthOf(air),
    }))
    // ⑭ 接线：drawAir2d6 / drawAir1d6 只回报数字（不改它们）⇒ 记下掷骰前的骰源，按同法复算骰面
    let diceCursor = rng.value
    const die2d6 = inputs.flakDie ?? drawAir2d6()
    const rolls: DiceRoll[] = []
    if (inputs.flakDie === null) {
      const derived = roll2d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }
    const lossDie = inputs.lossDie ?? drawAir1d6()
    if (inputs.lossDie === null) {
      const derived = roll1d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }
    /*
     * 14.4f：4 机行的 W/S（损失骰 5/6）在轰炸值并列时，原文让飞机所有方自选；
     * 本作改为**随机**（用户 2026-11-13）：只在确实并列时抽 1 骰，骰面走固定种子 RNG（可重放）。
     */
    let tieBreakDie: number | undefined
    if (missionAircraft.length >= 4 && lossDie >= 5) {
      const strengths = missionAircraft.map((plane) => plane.barrageStrength)
      const extreme = lossDie === 5 ? Math.min(...strengths) : Math.max(...strengths)
      if (strengths.filter((value) => value === extreme).length > 1) {
        const derived = roll1d6(diceCursor)
        diceCursor = derived.rng
        rolls.push(derived.value)
        tieBreakDie = derived.value.faces[0] ?? 1
      }
    }
    const data = acceptAir(
      resolveFlakStep(state, {
        inEnemyPatrolZone: inPatrolZone,
        missionHasFighter: airMissionHasFighter.value,
        missionAircraft,
        targetHasHQ: inputs.targetHasHQ,
        targetAirBaseLevel: airTargetBaseLevel.value,
        // 15.2F：简易机场不能提供任何防空值（14.4e 的基地那一项由 15.0b-B 的唯一实现给出）
        targetBaseIsAirstrip: airTargetBaseIsAirstrip.value,
        printedFlakValue: inputs.printedFlakValue,
        // 14.4e：运输破坏在敌方巡逻区内再 +1（与同组修正累计）
        ...(state.kind === 'trainbusting' && inPatrolZone
          ? { trainbustingInPatrolZone: true }
          : {}),
        die2d6,
        lossDie,
        ...(tieBreakDie === undefined ? {} : { tieBreakDie }),
      }),
      '防空',
    )
    if (data === null) return false
    airState.value = data.state
    // 14.4f：命中 ⇒ 该任务机损失 1 点军力
    if (data.flak.hit && data.flak.lossAircraftId !== null)
      applyAirStepLoss(data.flak.lossAircraftId)
    /*
     * 14.4g：**运输任务的货容量因防空变化 ⇒ 重算可用装载量、摧毁超出部分（由玩家选择）**。
     *   · 容量按**此刻仍在任务的飞机**重算（被摧毁的已移出、减损的取减损面印值）；
     *   · 取整按**有利于货物存留**（`planCargoLoss` 的 `ceil`，即 14.9b 明写的例外）；
     *   · 有超出部分 ⇒ 落一个**待决**，玩家选完之前 14.2f-F 的货物检定不许进行。
     */
    if (data.flak.hit) {
      /*
       * 14.9a / 14.9e（T14）：有逐机货单且确有承运机被摧毁时，损失归属已由分单确定，
       * 不需要玩家再选 14.4g 的超额货损；由 F 步结算按 `lostCargoIds` 一次性结清。
       */
      const destroyedCarriers = airMissionRosterNow.value?.destroyedIds ?? []
      if (hasCargoOwnership(state) && destroyedCarriers.length > 0)
        pushLog(
          'warning',
          `逐机货单：${String(destroyedCarriers.length)} 架承运机被毁，其货物按确定损失结算（14.9e）`,
          '14.9e',
        )
      else queueAirCargoLoss(airMissionCargoCapacityNow.value, '14.4g')
    } else if (airMissionRosterNow.value?.liveCapacityT === 0 && !hasCargoOwnership(state))
      queueAirCargoLoss(0, '14.1b')
    pushLog(data.flak.hit ? 'warning' : 'info', data.flak.detail, data.flak.rule)
    // ⑭ 接线：防空应答（14.4e / 14.4f）入会话日志；rolls＝2 骰 + 1 损失骰
    recordSettlement({
      action: 'airFlak',
      rule: data.flak.rule,
      rolls,
      data: {
        kind: state.kind,
        inEnemyPatrolZone: inPatrolZone,
        die2d6,
        lossDie,
        hit: data.flak.hit,
        lossAircraftId: data.flak.lossAircraftId,
        detail: data.flak.detail,
      },
    })
    return true
  }

  /** C9 第 5 步（14.2f-F）：记录任务本身的结果（如 C7 的轰炸结论） */
  /**
   * B29a：**任务格改成点地图选**（14.2f-B；第 12 处"待点格"）
   *
   * 用户 2026-11-12：候选＝**任务对象类型合法**（14.6–14.10）∩ **参战机航程可达**（14.2d / 1.4a），
   * 由引擎统一算（`airMissionTargetCandidates`）；不再允许手输格号。图外盒不在候选内。
   */
  function beginAirTargetHexPickNow(): void {
    const kind = airMissionKind.value
    /*
     * 还没定任务类型时（target-first 入口：先点格再开会话）无法算"类型合法"，
     * 退回落点即任意格；定了类型后一律走类型 ∩ 航程的候选集。
     */
    const candidates = kind === null ? ('any' as const) : airMissionTargetCandidates.value
    if (kind !== null && candidates.length === 0)
      pushLog(
        'warning',
        '没有合法目标格：任务类型要求的对象与参战机航程没有交集（14.2f-B）',
        '14.2f-B',
      )
    beginHexPick({
      label:
        kind === null ? '空军任务的目标格' : `空军任务的目标格（${airMissionKindLabel(kind)}）`,
      rule: '14.2f-B',
      // 候选＝类型合法 ∩ 航程可达（引擎统一算）；UI 只负责高亮与接收点击
      candidates,
      /*
       * K16：这里必须写**实际目标** `airTargetHex`（`beginAirMissionNow` 与预检都读它）。
       * 修前只写显示用的 `airInputs.targetHexText` ⇒ 改格后仍按旧格结算（静默打错目标）。
       */
      apply: (hex) => setAirTargetFromText(hexTextOf(hex)),
    })
  }

  /**
   * 14.2f：**选任务类型即"宣布 + 自动结算到面板 2（任务结算）"**
   *
   * 用户口径（2026-11-15 修订；原始 2026-09-16 #3 只要求"自动结算到战果"）：
   *   选任务（右键）→ 选飞机发起（面板 1）→ 结算 14.5 拦截与 14.3 空战及损失
   *   （按是否发生弹出，空战双方点名）→ 结算防空（自动）→ **结算任务（面板 2，玩家点）**
   *   → 返航（面板 3）。
   *
   * 修前：发起后整链一次跑到返航，面板 2 从不渲染，空战/防空结果只落日志。
   * 现在：空战真的发生 ⇒ 停在 ② 空战面板；有合格拦截机 ⇒ 停在 ③ 拦截应答；
   *   防空自动掷；**停在面板 2**，由玩家点「结算任务」再进返航。
   *
   * ★ 不替玩家做表态：14.5 的拦截宣布、14.3e-B 的点名迎战机、14.9/14.10 的货物仍读面板输入。
   * ★ 条件不足时**如实说缺什么**（先点名参战机 / 先选任务格），不静默什么都不做。
   */
  function runAirMissionNow(): boolean {
    if (airState.value === null) {
      if (airMissionAirIds.value.length === 0) {
        pushLog('warning', '先点名参战飞机（14.2a/14.2d：在基地格内勾选）', '14.2a')
        return false
      }
      if (airTargetHex.value === null) {
        pushLog('warning', '先选任务格（14.2f-B：点地图上的目标格）', '14.2f-B')
        return false
      }
      if (!beginAirMissionNow()) return false
    }
    if (airState.value === null) return false
    /*
     * ② 空战（14.2f-C / 14.3）：该格真的打起来 ⇒ 停在面板 ②，
     * 双方点名（14.3e-B）后由玩家点「结算空战并继续」，不在这里替玩家掷骰。
     */
    if (airState.value.step === 'airCombat' && previewAirCombatRoles()) return true
    return autoResolveAirMissionNow()
  }

  /**
   * 14.2f-C：先把"会不会打、谁攻谁守"算出来并落进 `airState.combat`（**不掷骰、不挪步**）。
   *
   * `declareAirCombatStep` 本身是"声明并继续"——它顺手把 step 推到 interception；
   * 而面板 ② 的入口判据是 `step === 'airCombat' && combat?.occurs` ⇒ 若照抄它，面板 ② 永不出现。
   * 这里只取它的 combat 结论，步留在 airCombat，等玩家点「结算空战并继续」再由
   * `confirmAirCombatNow()` 重新声明并掷骰。
   */
  function previewAirCombatRoles(): boolean {
    const state = airState.value
    const target = airTargetHex.value
    if (state === null || target === null) return false
    const enemyAircraft = airUnitsInHex(target, enemySide.value)
    const data = acceptAir(
      declareAirCombatStep(state, {
        friendlyAircraft: airMissionFlyingUnits.value.map((plane) =>
          toAirMissionAircraftView(plane),
        ),
        enemyActiveCount: enemyAircraft.length,
        enemyCanInitiate: enemyAircraft.some((air) => air.canInitiateAirCombat),
        enemyAirBaseInHex: airBases.value.some(
          (base) => base.side === enemySide.value && sameHex(base.hex, target),
        ),
      }),
      '空战环节',
    )
    if (data === null) return false
    airState.value = { ...data.state, step: 'airCombat' }
    return data.state.combat?.occurs === true
  }

  /**
   * 把骰子与查表连跑到**下一个需要玩家表态的步**：
   * ② 空战（面板）→ ③ 拦截应答（面板）→ 防空（自动）→ **⑤ 任务结算（面板 2，停）**。
   * 返航自动补完只对 `hip_shoot`（14.1c 缺省即起飞基地）生效。
   */
  function autoResolveAirMissionNow(): boolean {
    const state = airState.value
    if (state === null) return false
    if (state.step === 'airCombat' && !confirmAirCombatNow()) return false
    if (airState.value?.step === 'interception') {
      /*
       * K3：拦截方的「是否宣布拦截」是**真实决策**（14.5：不强制）。
       * 修前自动连跑立刻按默认 `interceptDeclared=false` 跳过该步 ⇒ 14.5 这一支永远走不到。
       * 有合格拦截机时**停在 D 步**，由面板记录应答后再次调用本函数继续。
       */
      if (airInterceptorCandidates.value.length > 0 && !airInputs.value.interceptDeclared)
        return true
      if (!declareInterceptionNow()) return false
      if (airState.value?.interception?.declared === true && !resolveInterceptionCombatNow()) {
        return false
      }
    }
    if (airState.value?.step === 'flak' && !resolveFlakNow()) return false
    /*
     * ⑤ 任务结算（14.2f-F，面板 2）：**停在这里**，不替玩家点「结算任务」。
     * 对地任务的轰炸链、受损分配、空运/空投货物都在 `settleAirMissionNow` 里跑
     * （G① 的"任务结算真的进轰炸引擎"仍成立，只是触发者从自动连跑改成面板按钮）。
     */
    if (airState.value?.step === 'resolveMission') {
      /*
       * 14.2f-E 例外：任务机全被防空击落/中止 ⇒ 没有战果可结算，弹一块空面板没有意义，
       * 直接按"任务中止"收束（与修前一致）。
       */
      if (airMissionFlyingUnits.value.length === 0 && barrageState.value === null) {
        return finishAbortedAirMission()
      }
      return true
    }
    /*
     * 14.2f-E/G：任务机全被防空击落/中止（返航名单为空）⇒ 没有三选一可做，
     * 直接收束到 done，不停在空的返航步；hip_shoot 的缺省返航也在这里补完。
     */
    if (!finishAutomaticAirReturn()) return false
    return airState.value?.step === 'returnToBase' || airState.value?.step === 'done'
  }

  /**
   * ★ 条 13（A2）：低空扫射（hip_shoot）**全自动到返航并变非激活**。
   *   干净扫射（无拦截/无防空损失、战果落定）的返航目的地缺省即起飞基地（14.1c 合法）⇒
   *   自动补完返航步（`completeAirReturnNow` ⇒ 逐机转非激活），不必玩家再点一次「返航」。
   *   若返航确需玩家决策（起飞基地已不可用等）⇒ `completeAirReturnNow` 返 false，停在 returnToBase。
   *   barrage（14.7b 空军轰炸）**不在此列**——仍停 returnToBase 供核对（沿用既有 G① 口径）。
   *
   * 2026-11-15：面板 2 的「结算任务」不再经 `autoResolveAirMissionNow` ⇒ 这两条
   *   在 `settleAirMissionNow` 收尾时也要跑一次，否则会多出一个空的返航步。
   */
  function finishAutomaticAirReturn(): boolean {
    if (airState.value?.step !== 'returnToBase') return true
    // 14.2f-E/G：没有返航机 ⇒ 不停在空的返航步
    if (airMissionReturnChoices.value.length === 0) return completeAirReturnNow()
    if (airState.value?.kind !== 'hip_shoot') return true
    return completeAirReturnNow()
  }

  /** 14.2f-E：任务机全失 ⇒ 记"任务中止"，不弹空的任务结算面板，直接收束到 done */
  function finishAbortedAirMission(): boolean {
    airInputs.value = {
      ...airInputs.value,
      missionNote: '任务机已中止或被摧毁，没有执行对地任务',
    }
    // 轰炸宣布被引擎拒 ⇒ 没有可结算的战果；置位后 `airMissionResultReady` 放行，
    // 否则 `confirmAirMissionNow` 会因「等一场永不存在的轰炸」而失败，状态死在结算步
    airMissionAbortPending.value = true
    if (!confirmAirMissionNow()) {
      airMissionAbortPending.value = false
      return false
    }
    if (!finishAutomaticAirReturn()) return false
    return airState.value?.step === 'returnToBase' || airState.value?.step === 'done'
  }

  /* ── B2-2c：空军轰炸任务 / 任务结算 / 中止与返航收尾（2026-11-21 从 facade 迁入） ── */
  /**
   * 14.7b / 10.2：**空军轰炸任务**在 14.2f-F（结算任务）步入轰炸结算链
   *
   * 条文依据：10.2a「空军单位**需要放置在目标上**来结算它们的轰炸」；10.0 的通用流程
   * （加总轰炸值 → 定纵列 → 目标玩家选地形横移 → 2 骰 → 结算）对空军轰炸同样适用；
   * 10.2b 短程 +1 列；**10.2c 空军轰炸没有补给消耗**；14.7「最多四个飞机可以参与同一次轰炸」
   * （超限由引擎的 `barrageEligibility` 拦）。
   *
   * ★ 做法：**复用炮兵那条交互链**（`barrageState`：宣布 → 付款 → 横移 → 骰 → 战果），
   *   只把 kind 设成 `'air'`、参炸机对齐到本任务已宣布的编成 —— 于是"结果真的落 CRT"
   *   与炮兵走同一条路径，不另造第二套结算。
   * ★ 闸门照旧留给引擎/统一闸门：本函数只对齐盘面事实，宣布是否合法由 `beginBarrageNow` 判。
   */
  function beginAirBarrageNow(): boolean {
    const state = airState.value
    const target = airTargetHex.value
    if (state === null || target === null) {
      pushLog('warning', '空军轰炸：请先选定任务格（14.2f-B）', '14.2f-B')
      return false
    }
    if (state.step !== 'resolveMission') {
      pushLog(
        'warning',
        `空军轰炸在 14.2f 的 F 步（结算任务）进行，当前步：${state.step}（14.2f-F）`,
        '14.2f-F',
      )
      return false
    }
    if (airMissionFlyingUnits.value.length === 0) {
      airError.value = { rule: '14.7', reason: 'noActiveMissionAircraft' }
      return false
    }
    /*
     * 14.7b / 14.7d：**空军轰炸与低空扫射**都走 10.2 的轰炸结算（10.0 的通用流程）——
     *   空军轰炸（14.7b）：10.2a 飞机放在目标上结算、10.2c **无补给消耗**、14.7 最多 4 机；
     *   低空扫射（14.7d）：**单机**（14.7d-B）+ 正确观察员（10.0b）+ 不得运输破坏（14.7d-D）。
     * 两者都把 kind 设成 `'air'` 并复用炮兵那条交互链（宣布 → 付款 → 横移 → 骰 → 战果）。
     */
    if (state.kind !== 'barrage' && state.kind !== 'hip_shoot' && state.kind !== 'trainbusting') {
      pushLog(
        'warning',
        `该任务不是空军轰炸（${airMissionKindLabel(state.kind)}）⇒ 不需要轰炸结算（14.7b）`,
        '14.7b',
      )
      return false
    }
    const existing = barrageState.value
    if (
      existing !== null &&
      airMissionDomain.ownsBarrage(existing) &&
      existing.kind === 'air' &&
      sameHex(existing.targetHex, target) &&
      existing.units.every((unit) => state.assignment.aircraftIds.includes(unit.unitId))
    )
      return true
    /*
     * 上一趟任务**已结算**的轰炸仍留在 `barrageState` 里 ⇒ `barrageAirUnits` 会读它的旧 `units`：
     * 新任务会带着旧飞机去宣布（`unitAlreadyBarraged`，10.0e-B），或把旧机算进本次参炸。
     * 那不归本趟任务 ⇒ 先收掉再开新场。本趟任务自己的轰炸（含未结算）不进这个分支。
     */
    if (existing !== null && existing.finished) clearBarrage()
    if (!canReplaceBarrage()) return false
    //
    // ★ 批 A 切片 2：对齐的是**轰炸目标格**，不再去改"战斗目标" ——
    //   空军轰炸借战斗工具的选定是修前的耦合（对局台没有工具时就点不出来）。
    ports.barragePickHex.value = { ...target }
    barrageKind.value = 'air'
    if (state.kind === 'trainbusting') barrageTargetKind.value = 'trainbusting'
    barrageUnitIds.value = []
    barrageAirIds.value = airMissionFlyingUnits.value.map((air) => air.instanceId)
    // 14.7d：低空扫射的标记随任务类型带入（10.0b 的观察员仍由面板声明）
    barrageInputs.value = { ...barrageInputs.value, hipShoot: state.kind === 'hip_shoot' }
    if (!beginBarrageNow()) return false
    const started = barrageState.value
    if (started === null) return false
    airMissionDomain.bindBarrage(started)
    return true
  }

  /**
   * 10.0 / 10.2：把**轰炸交互链**一次跑完（宣布 → 补给 → 横移 → 骰 → 战果）
   *
   * 只服务"自动连跑"的调用方（空军任务的 14.2f-F 步）：每一步的拒绝都会立刻返回 false 并把原因留在
   * `barrageError` 与日志里，绝不吞掉。**横移**（10.0a）是**目标玩家**的选择 ⇒ 自动连跑取
   * "不横移"（合法选择之一）；要自己选横移仍走轰炸面板的逐步按钮（验证页）。
   */
  function runBarrageChainNow(): boolean {
    for (let guard = 0; guard < 8; guard += 1) {
      const step = barrageState.value?.step
      if (step === undefined || barrageState.value?.finished === true) break
      const advanced =
        step === 'supply'
          ? confirmBarrageSupplyStep()
          : step === 'shifts'
            ? confirmBarrageShiftsStep()
            : step === 'dice'
              ? rollBarrageDiceStep()
              : step === 'outcome'
                ? confirmBarrageOutcomeStep()
                : false
      if (!advanced) return false
    }
    return barrageState.value?.finished === true
  }

  function airMissionResultReady(state: AirInteractionState): boolean {
    if (['barrage', 'hip_shoot', 'trainbusting'].includes(state.kind)) {
      // 14.2f-E：任务机全失，或轰炸宣布已被引擎拒（中止）⇒ 没有对地战果可等
      if (airMissionFlyingUnits.value.length === 0 || airMissionAbortPending.value) return true
      const barrage = barrageState.value
      if (
        barrage === null ||
        !airMissionDomain.ownsBarrage(barrage) ||
        !barrage.finished ||
        barrage.outcome === undefined ||
        !sameHex(barrage.targetHex, state.targetHex) ||
        barrage.kind !== 'air'
      ) {
        airError.value = { rule: '14.2f-F', reason: 'barrageOutcomePending' }
        pushLog('warning', '先完成本任务的轰炸结果，再确认返航', '14.2f-F')
        return false
      }
    }
    if ((state.kind === 'air_transport' || state.kind === 'air_drop') && state.cargo === null) {
      airError.value = { rule: '14.2f-F', reason: 'cargoOutcomePending' }
      pushLog('warning', '先完成货物检定和落盘，再确认返航', '14.2f-F')
      return false
    }
    return true
  }
  function confirmAirMissionNow(): boolean {
    const state = airState.value
    const aborted = airMissionAbortPending.value
    const ok = airMissionDomain.confirmAirMissionNow()
    airMissionAbortPending.value = false
    if (ok && state !== null && (airMissionFlyingUnits.value.length === 0 || aborted))
      recordAbortedAirBarrage(state)
    return ok
  }

  /**
   * 14.2f-F：面板 2 的**唯一决定**。对地三类若战果链还没跑完、空运/空投货物还没落盘，
   * 这里先补跑（10.2c：空军对地无补给消耗），再记录任务结算。
   */
  function settleAirMissionNow(): boolean {
    const state = airState.value
    if (state === null) return false
    if ((state.kind === 'air_transport' || state.kind === 'air_drop') && state.cargo === null) {
      if (!resolveAirCargoNow()) return false
    }
    const ground =
      state.kind === 'barrage' || state.kind === 'hip_shoot' || state.kind === 'trainbusting'
    if (ground && airMissionFlyingUnits.value.length === 0) {
      // 14.2f-E：任务机全被防空击落/中止 ⇒ 没有对地战果，如实记到任务结果里
      airInputs.value = {
        ...airInputs.value,
        missionNote: '任务机已中止或被摧毁，没有执行对地任务',
      }
    } else if (ground) {
      const barrage = barrageState.value
      const owns =
        barrage !== null &&
        airMissionDomain.ownsBarrage(barrage) &&
        barrage.kind === 'air' &&
        sameHex(barrage.targetHex, state.targetHex)
      const finished = barrage !== null && owns && barrage.finished && barrage.outcome !== undefined
      if (barrage !== null && owns && !barrage.finished) {
        /*
         * 10.0a：战果链停在「目标方分配损失」⇒ 面板 2 里那块选择分完再点一次「结算任务」；
         * 没分够就如实拒绝（不要静默重开会把已选的损失冲掉）。
         */
        if (ports.barrageLossRequired.value > 0 && !ports.barrageLossReady.value) {
          airError.value = { rule: '10.0a', reason: 'barrageLossPending' }
          pushLog('warning', '先给目标方分配完军力损失，再结算任务', '10.0a')
          return false
        }
        if (!confirmBarrageLossNow()) return false
        if (!runBarrageChainNow()) return false
      } else if (!finished) {
        // 轰炸宣布被引擎拒（如 10.0b 观察员不合法）⇒ 任务按中止处理并返航，
        // 否则任务态永远停在结算步：`cancelAir` 与环节推进都会以 14.1c 拒绝（状态不一致）
        if (!beginAirBarrageNow()) return finishAbortedAirMission()
        if (!runBarrageChainNow()) return false
        // 刚停在受损分配 ⇒ 停在面板 2（选完损失再点「结算任务」）
        if (barrageState.value?.finished !== true) return false
      }
      /*
       * 14.2f-F 的"任务结果"由**轰炸结论**填（G①：不能是空备注框，
       * 否则日志每次都是「（未填结果）」）。
       */
      const done = barrageState.value
      const summary =
        done?.outcome === undefined
          ? `${airMissionKindLabel(state.kind)}：轰炸已结算`
          : `${airMissionKindLabel(state.kind)}：列 ${done.table.initialColumn} → ${done.finalColumn}；${done.outcome.value.detail}`
      airInputs.value = { ...airInputs.value, missionNote: summary }
    }
    if (!confirmAirMissionNow()) return false
    // 14.2f-G：低空扫射的返航缺省即起飞基地（14.1c）⇒ 自动补完，不多出一个空返航步
    return finishAutomaticAirReturn()
  }

  /** 10.0e / 14.7d：中止的轰炸也算尝试；低空扫射不占目标格额度。 */
  function recordAbortedAirBarrage(state: AirInteractionState): void {
    if (!['barrage', 'hip_shoot', 'trainbusting'].includes(state.kind)) return
    if (state.kind !== 'hip_shoot')
      barragedHexesThisPhase.value = [
        ...new Set([...barragedHexesThisPhase.value, hexLabel(state.targetHex)]),
      ]
    barragedUnitIdsThisPhase.value = [
      ...new Set([...barragedUnitIdsThisPhase.value, ...state.assignment.aircraftIds]),
    ]
  }

  /** 14.1c / 14.9f：留存货物按逐机货单回到各自返航基地，提交前核对完整性。 */
  function completeAirCargoReturn(
    state: AirInteractionState,
    completed: AirInteractionState,
    stayedIds: readonly string[],
  ): boolean {
    const retained = new Set(
      state.cargo?.items.filter((item) => item.fate === 'retained').map((item) => item.id) ?? [],
    )
    const cargo = state.assignment.cargo.filter((item) => retained.has(item.id))
    const carriers = state.assignment.origins
      .filter((origin) => {
        const plane = airUnits.value.find((air) => air.instanceId === origin.aircraftId)
        return plane !== undefined && transportCapacityOf(plane) > 0
      })
      .map((origin) => ({
        aircraftId: origin.aircraftId,
        offMap: origin.fromOffMapBox === true,
        baseHex: { ...origin.baseHex },
        ...(origin.fromOffMapBox === true ? { offMapBox: state.side } : {}),
      }))
    const plan = acceptAir(
      planRetainedCargoReturn({
        cargo,
        targetHex: state.targetHex,
        returns: completed.returns,
        stayedIds,
        carriers,
        cargoByAircraft: state.assignment.cargoByAircraft,
      }),
      '货物退运',
    )
    if (plan === null) {
      pushLog('warning', '留存货物无法归属到返航飞机；请确认逐机货单与各机返航基地', '14.9')
      return false
    }
    const unitCargo = cargo.filter((item) => item.kind === 'unit')
    const unitIds = unitCargo.map((item) => item.id)
    if (!airUnitTransit.canLand(unitIds)) {
      airError.value = { rule: '14.9', reason: 'retainedCargoUnitMissing' }
      return false
    }
    if (
      airUnitCargoManifest.value.some(
        (item) => item.fate === 'aboard' && !unitIds.includes(item.cargoId),
      )
    ) {
      airError.value = { rule: '14.9', reason: 'unsettledAirUnitCargo' }
      return false
    }
    /*
     * 14.9a/14.9e（T15）：不再要求共同基地 —— 每架机只带回自载留存货物：
     * SP 加回该机返航基地，单位货物落在该基地；留场飞机的留存货物落目标格。
     */
    const spIdsOf = (aircraftId: string): string[] =>
      (
        state.assignment.cargoByAircraft.find((entry) => entry.aircraftId === aircraftId)
          ?.cargoIds ?? []
      ).filter((id) => retained.has(id) && id.startsWith('sp:'))
    const settledSp = new Set<string>()
    const returnedUnits: string[] = []
    for (const allocation of plan.allocations) {
      const { destination } = allocation
      if (destination === null) continue
      if (allocation.offMap) {
        const spIds = spIdsOf(allocation.aircraftId)
        airSupply.returnRemaining(destination, spIds, allocation.box ?? state.side)
        spIds.forEach((id) => settledSp.add(id))
        continue
      }
      const spIds = spIdsOf(allocation.aircraftId)
      if (allocation.unitIds.length > 0) {
        const returning = allocation.unitIds.map((id) => airUnitTransit.find(id)!)
        if (!airUnitTransit.land(allocation.unitIds, destination, 'returned')) return false
        for (const unit of returning) noteUnitEnteredHex(unit, destination)
        returnedUnits.push(...allocation.unitIds)
      }
      if (spIds.length > 0) {
        airSupply.returnRemaining(destination, spIds)
        spIds.forEach((id) => settledSp.add(id))
      }
      if (allocation.t > 0)
        ports.airUnloadLedger.value = {
          ...ports.airUnloadLedger.value,
          [`${state.side}:${hexLabel(destination)}`]:
            airUnloadedTAt(destination, state.side) + allocation.t,
        }
    }
    const unreturnedSp = cargo
      .filter((item) => item.kind === 'sp' && !settledSp.has(item.id))
      .map((item) => item.id)
    if (unreturnedSp.length > 0) {
      airError.value = { rule: '14.9', reason: 'retainedCargoSpUnassigned' }
      return false
    }
    recordSettlement({
      action: 'airCargoReturn',
      rule: '14.9',
      data: {
        ids: cargo.map((item) => item.id),
        allocations: plan.allocations.map((allocation) => ({
          aircraftId: allocation.aircraftId,
          destination: allocation.destination,
          t: allocation.t,
        })),
        unitIds: returnedUnits,
        t: plan.unloadT,
      },
    })
    return true
  }

  /** C9 第 6 步（14.2f-G / 14.1c）：返航（逐机指定目的地，须是**本方**基地且在航程内） */
  function completeAirReturnNow(): boolean {
    return airMissionDomain.completeAirReturnNow()
  }

  return {
    airActive,
    airMissionKind,
    airTargetHex,
    airMissionAirIds,
    airMissionAbortPending,
    airSupply,
    airSupplyManifest,
    airUnitTransit,
    airUnitCargoManifest,
    airMissionDomain,
    airState,
    airError,
    airCargoResolution,
    airCargoUnloadReceipt,
    airCargoUnloadChoices,
    airInputs,
    refitDoneBaseIds,
    refitTargetBaseId,
    refitStage,
    transferBaseId,
    transferMode,
    transferFromBox,
    transferSelectedIds,
    reducedBaseIds,
    airstripBaseIds,
    lastRefit,
    lastTransfer,
    lastReduction,
    airActingSide,
    enemySide,
    allAirViews,
    ownAirUnits,
    airBases,
    ownAirBases,
    airTransportProfiles,
    airOverLimitAircraftInactive,
    airMissionAirUnits,
    airMissionRosterNow,
    airMissionFlyingUnits,
    airMissionReturnOrigins,
    airMissionReturnChoices,
    airReturnSelectionLabel,
    airReturnChosen,
    airCombatAttackerPlanes,
    airCombatDefenderPlanes,
    airCombatRoundBudget,
    airInterceptionDefender,
    toggleAirCargoUnit,
    airCargoUnitChoices,
    airMissionHasFighter,
    airChecklist,
    airTargetInEnemyPatrolZone,
    airInterceptionResponse,
    airInterceptorCandidates,
    airTargetBaseLevel,
    airTargetBaseIsAirstrip,
    airEnemyAtTarget,
    capturableEnemyAirBases,
    airPatrolZoneHexes,
    airEnemyPatrolZoneHexes,
    airInactiveAtBase,
    airRefitPayDumps,
    airReductionCandidates,
    refitDoneBases,
    refitBase,
    refitCandidates,
    refitSelectedIds,
    refitSelectLimitAt,
    refitSelectLimit,
    refitPayDumps,
    refitPayNeedT,
    transferBase,
    transferCandidates,
    airDistanceToBox,
    canTransferAirToBox,
    transferBoxReady,
    transferBaseCandidates,
    transferHasBoxOption,
    transferHasBaseOption,
    canTransferAirToBaseNow,
    beginTransferNow,
    toggleTransferAircraft,
    cancelTransferNow,
    completeTransferToBaseNow,
    refitStartBases,
    refitAirbaseHexes,
    refitBlockReasonAt,
    reducedBases,
    beginAirMissionNow,
    airCombatPicksPayload,
    confirmAirCombatNow,
    isAirInOffMapBox,
    onMapAirUnits,
    airUnitsAt,
    airTargetFactsAt,
    airTypeCanPerformKind,
    airPlaneCanPerformKind,
    canAirMissionTarget,
    airMissionTargetCandidates,
    airDistanceFromRealBase,
    airUnitsInHex,
    resolveAirCargoNow,
    applyAirCargoDelivery,
    captureAirBaseNow,
    airMissionCargoCapacityNow,
    airCargoLossPending,
    airCargoLossPicked,
    toggleAirCargoLossPick,
    confirmAirCargoLossNow,
    hasCargoOwnership,
    resolveFlakNow,
    beginAirTargetHexPickNow,
    runAirMissionNow,
    autoResolveAirMissionNow,
    // B2-2c：区外仍引用，共 5 项
    // confirmAirMissionNow / completeAirReturnNow：16748 / 16749 与 store 公开面各 1 处
    // beginAirBarrageNow / settleAirMissionNow：store 公开面；recordAbortedAirBarrage：16758
    confirmAirMissionNow,
    completeAirReturnNow,
    beginAirBarrageNow,
    settleAirMissionNow,
    recordAbortedAirBarrage,
  }
}

export type AirDomain = ReturnType<typeof createAirDomain>
