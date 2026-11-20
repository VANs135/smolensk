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
import { airCargoTransportT } from '@/engine/rules/air-cargo'
import { airMissionRoster } from '@/engine/rules/air-mission-roster'
import type { RuleOutcome } from '@/engine/result-types'
import type { AirStatus, RngState } from '@/engine/state-types'
import {
  airTransportProfile,
  airTransportTerrainIsClosed,
  holdingsToT,
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
  type PanzerGroup,
  type SpHoldings,
} from '@/engine/rules'
import type { AirCargoUnloadPlan } from '@/engine/rules/air-cargo-unload'
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
  }
}

export type AirDomain = ReturnType<typeof createAirDomain>
