/**
 * workbench-air.ts —— C9 空军域（解构 B2-1：状态 + 派生）
 *
 * 为什么先只搬"状态 + 派生"：空军的 26 个 ref 住在 workbench.ts 的 2416–2592，而它的动作
 * 分散在 17k–23k 五段里。先让 `airDomain` 拥有状态，B2-2 搬动作时就不用再把状态当端口。
 *
 * 端口 25 项，两种接法：
 *   · 按值（20 项）：声明在建域点（≈2593）之前，或是有提升的函数声明；
 *   · 晚绑定（5 项）：`zocOnlySupplyFacts`/`onMapAirUnits`/`airCargoLossPending`/
 *     `segmentGateQuery`/`constructionMarkerPieces` 声明在 4192–27836 之间，facade 用
 *     `get` 访问器传进来，切片里一律写成 `ports.x.value` —— 只在 computed 求值时读取，
 *     避免建 store 时撞 TDZ（§12.3 记录过一次同源事故）。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { createAirCargoResolutionDomain } from './air-cargo-resolution'
import { createAirMissionDomain } from './air-mission'
import { createAirSupplyDomain } from './air-supply'
import { createAirUnitTransitDomain } from './air-unit-transit'
import type { SettlementRecordInput } from './workbench-core'
import type { createSupplyFacts } from './workbench-model'
import {
  createAirInputs,
  hexLabel,
  isFighterAircraft,
  terrainsAt,
  toAirBaseView,
  toAirMissionAircraftView,
  type ActionGateQuery,
  type AirInputs,
  type ConsoleAirUnit,
  type ConsoleUnit,
  type WorkbenchLogEntry,
} from './workbench-model'
import type { HexRef, Side } from '@/data'
import { sameHex } from '@/engine/hex-geometry'
import { hexDistance } from '@/engine/hex-geometry'
import { planOffMapAirBoxFlightFromHex } from '@/engine/rules/air-mission'
import { isAirTransportableUnit } from '@/engine/rules/air-cargo'
import { canUseTransport } from '@/engine/rules/modes'
import { airCombatRatingOf, parseHexPath } from './workbench-model'
import type { ActionKey, ConsolePhase } from './workbench-model'
import { airCargoTransportT } from '@/engine/rules/air-cargo'
import { airMissionRoster } from '@/engine/rules/air-mission-roster'
import type { RuleOutcome } from '@/engine/result-types'
import type { AirStatus, RngState } from '@/engine/state-types'
import {
  activeAircraftInBase,
  activeStackingLimitOf,
  airInteractionChecklist,
  airDistanceToOffMapBox,
  airTransportProfile,
  drawableDumpsFor,
  inPatrolZoneOf,
  patrolZoneHexes,
  planInterceptionResponse,
  airTransportTerrainIsClosed,
  holdingsToT,
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
  type InterceptionResponse,
  type BaseTransferPlan,
  type PanzerGroup,
  type SpHoldings,
} from '@/engine/rules'
import type { AirCargoUnloadPlan } from '@/engine/rules/air-cargo-unload'
import type { SpDump } from './supply-types'
import type { Derivation } from '@/engine/derivation'

/** © 空军的端口。20 项按值、5 项晚绑定（见文件头）。 */
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
  applyAirCargoDelivery: (
    state: AirInteractionState,
    result: AirCargoResolution,
    plan: AirCargoUnloadPlan,
  ) => void
  airMissionResultReady: (state: AirInteractionState) => boolean
  completeAirCargoReturn: (
    state: AirInteractionState,
    completed: AirInteractionState,
    stayedIds: readonly string[],
  ) => boolean
  constructionMarkerAirBaseId: (pieceId: string) => string
  /** ── 以下 5 项晚绑定（facade 用 getter 传入，切片里写 ports.x） ── */
  zocOnlySupplyFacts: ComputedRef<ReturnType<typeof createSupplyFacts>>
  onMapAirUnits: ComputedRef<ConsoleAirUnit[]>
  airCargoLossPending: Ref<{
    rule: string
    capacityAfter: number
    allowedT: number
    excessT: number
    detail: string
  } | null>
  segmentGateQuery: ComputedRef<ActionGateQuery>
  constructionMarkerPieces: Ref<{ id: string; kind: 'bridge' | 'airStrip'; hex: HexRef }[]>
  phase: ComputedRef<ConsolePhase>
  airBoxMembers: Ref<string[]>
  isAirInOffMapBox: (air: ConsoleAirUnit) => boolean
  airUnitsAt: (hex: HexRef, side: Side) => ConsoleAirUnit[]
  airDistanceFromRealBase: (air: ConsoleAirUnit, hex: HexRef) => number
  airUnitsInHex: (hex: HexRef, side: Side) => ConsoleAirUnit[]
  hqDeliveryDumpKeys: (side: Side, beneficiaries: readonly { hex: HexRef }[]) => Set<string>
  actionAllowedNow: (key: ActionKey) => boolean
  isConstructionMarkerAirBaseId: (id: string) => boolean
  /** ── 以下 2 项晚绑定（声明在 3849/3911，晚于建域点） ── */
  allSpDumps: ComputedRef<SpDump[]>
  supplyFacts: ComputedRef<ReturnType<typeof createSupplyFacts>>
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
    applyAirCargoDelivery,
    airMissionResultReady,
    completeAirCargoReturn,
    phase,
    airBoxMembers,
    isAirInOffMapBox,
    airUnitsAt,
    airDistanceFromRealBase,
    airUnitsInHex,
    hqDeliveryDumpKeys,
    actionAllowedNow,
    isConstructionMarkerAirBaseId,
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
    lossPending: () => ports.airCargoLossPending.value !== null,
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
    ports.onMapAirUnits.value.map((plane) => toAirMissionAircraftView(plane)),
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
    const aircraft = ports.onMapAirUnits.value.filter(
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
      return ports.onMapAirUnits.value.filter(
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
  }
}

export type AirDomain = ReturnType<typeof createAirDomain>
