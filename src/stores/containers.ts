import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import {
  auxCards,
  markers,
  rulesConstants,
  scenarioSetup,
  scenarios,
  unitsAxis,
  unitsSoviet,
} from '@/data'
import type { Side } from '@/data'
import { pickIndex, roll1d6 } from '@/engine/rng'
import { createId } from '@/shared'
import {
  ALARM_MIX_RULE,
  alarmMixRows,
  allBoxViews,
  applyModeSwitch,
  axisDrawPool,
  boxOfRegion,
  planAirBoxActivate,
  planOffMapAirBoxFlight,
  planBreakdownTake,
  planEdgeBoxMove,
  planFormationBoxHide,
  planFormationBoxReveal,
  deriveDrawComposition,
  planScenarioDraw,
  planSpecialReplDraw,
  shiftWestDestination,
  planTurnMarkerAdvance,
  railCapPositionValid,
  railCapTrackView,
  scenarioDrawBoxView,
  setupSourceOf,
  turnTrackView,
  weatherTrackView,
  type BoxHolding,
  type BoxKind,
  type BoxUnitView,
  type BoxView,
  type BreakdownPoolSlot,
  type EdgeBoxId,
  type ScenarioDrawBoxView,
  type ScenarioDrawGroup,
} from '@/engine/rules'
import type { BreakdownCreateRequest } from '@/engine/rules'

import { useGameSessionStore } from './session'
import { useWorkbenchStore } from './workbench'
import {
  counterImageUrlOf,
  toConsoleUnit,
  unitChoices,
  isAirDeadPileEntry,
} from './workbench-model'
import type { ConsoleAirUnit, ConsoleUnit, DeadPileEntry } from './workbench-model'

/**
 * 记录轨与容器管理（W7 C12）的操作台
 *
 * ## 分工（与其它 store 的边界）
 *   · **引擎**（`engine/rules/containers.ts`）判规则、出名册与计划，不写状态、不掷骰；
 *   · **本 store** 持「盒的账本」与记录轨标记，负责**掷骰（走 rng.ts，种子化可重放）**、
 *     把计划落到盘面（调用操作台的既有动作），并把结论写进操作台日志；
 *   · **操作台**（`workbench.ts`）才拥有算子本体（图上的 `units` / `deadPile` / `airUnits`）。
 *
 * ## 权威值来自哪里
 *   · 回合 / 天气 / 铁路容量：有会话时取**会话记录**（整局流程的权威值），否则退回本 store 的标记账本；
 *   · 死亡堆：直接读操作台的 `deadPile`（C12 不另立一份）；
 *   · 拆分单位盒：盒内存量优先取操作台的 `breakdownPool` 账本（1.8a / 20.0g），
 *     没有账本时才退回「1.8a 上限 − 图上枚数」；
 *   · 抽取盒的**候选池**由引擎按数据给（1.6c 的 12-2-2/11-1-1/10-0-1、剧本抽签的池成员）。
 *
 * ## 数据缺口（如实暴露，不猜）
 *   · 单位库未标注 2.3a 的 Alarm 单位（3× 2-1-3 / 5× 3-1-1 / 7× (2)-2-2）⇒
 *     面板提供 `alarmUnitIds` 手输口，空即按规则「该项作废」；
 *   · `formations.json` 的下属标签与单位库命名不同口径 ⇒ 编队组成（哪个单位是某师的
 *     Mtr 团 / Aufk 营）由面板按算子选择注入。
 */

/** 6.4：本作地面条件恒为 good（专规 1.5） */
const GROUND_ALWAYS_GOOD = 'good' as const

/**
 * B31：盒内一枚（＝引擎的 `BoxHolding` ＋ 贴图 URL）
 *
 * 为什么要带图：用户口径 #12「盒里的算子要显示**贴图**」——而组件拿 `unitId` 拼文件名是错的
 * （那是**实例 id**，不是图档名），故由投影这一层用 `counterImageUrlOf` 算好（与地图同一条选图实现）。
 */
export interface BoxHoldingView extends BoxHolding {
  /** 贴图 URL（null ＝ 取不到图 ⇒ 组件退回一个空位，不臆造文件名） */
  imageUrl: string | null
}

/** 卡上一个分区（含该分区里摆着的算子） */
export interface AuxCardRegionView {
  id: string
  label: string
  /** 分区类型（数据侧 `aux-cards.json` 的 `boxKind`） */
  kind: string
  /** 卡面像素矩形（渲染侧按显示尺寸等比缩放） */
  rect: { x: number; y: number; w: number; h: number }
  /** 规则出处（来自 `REGION_OF_BOX`） */
  rule: string
  /** 该分区里摆着的算子（引擎名册的 `BoxHolding`＋B31 算好的贴图 URL） */
  units: readonly BoxHoldingView[]
  /**
   * B31c：该分区此刻是否**被标记**（运力记录轨：当前容量所在的那一格）
   *
   * 只给"记录轨"类分区用；盒类分区恒缺省（false）。
   */
  active?: boolean
  /** 留空的原因（null = 正常铺开） */
  note: string | null
}

/** 一张辅助卡（卡面 + 分区 + 区内容物） */
export interface AuxCardView {
  id: string
  side: Side | null
  name: string
  boxKind: string
  /** 卡面图档名（URL 由渲染侧编码） */
  image: string
  imageSize: { w: number; h: number }
  regions: readonly AuxCardRegionView[]
}

export const useContainersStore = defineStore('containers', () => {
  const workbench = useWorkbenchStore()
  const session = useGameSessionStore()

  /* ────────────────────────────── 账本（引擎不写状态） ────────────────────────────── */

  /**
   * 当前剧本（剧本抽取盒用）
   *
   * ★ 联调（**单一权威**）：剧本号的唯一权威是**会话 store**（`session.scenarioId`）；
   * 本处只做投影 ⇒ 换剧本 / 读档后抽取盒自动跟随（与 turn / weather / railCapacity 同一读法）。
   */
  const scenarioId = computed<string>(() => session.scenarioId)

  /** 回合标记账本（无会话时由本 store 持；2.2 Turn End 推进） */
  const markerTurn = ref<number>(1)

  /**
   * 按**当前剧本**取首回合空中条件（专规 1.5）
   *
   * ★ 联调：此前这里写死 `scenarios.scenarios[0]`（第一本剧本），选到别的剧本时会拿错天气。
   * 剧本号的唯一权威是会话 store，本处按它查表；查不到才退回「正常飞行」。
   */
  function initialWeatherAir(): 'normal' | 'limited' {
    const found = scenarios.scenarios.find((scenario) => scenario.id === session.scenarioId)
    return found?.firstWeather === 'restricted' ? 'limited' : 'normal'
  }

  /** 天气标记账本（无会话时由本 store 持；专规 1.5） */
  const weatherMarker = ref<'normal' | 'limited'>(initialWeatherAir())

  /** 铁路容量账本（无会话时由本 store 持；专规 1.2 的初始值） */
  const railCapacityLedger = ref<Record<Side, number>>({
    axis: markers.railCap.initial.axis,
    soviet: markers.railCap.initial.soviet,
  })

  /*
   * 专规 1.4a：**盒成员账本已迁到操作台**（`workbench.airBoxMembers`）。
   * 它决定任务航程（从对应列入场、先扣 20/30 格），并必须随盘面存档；
   * 记在这里时既读不到任务侧、也不进任何快照字段表。本 store 只读投影、写走操作台的入口。
   */
  const airBoxMembers = computed<readonly string[]>(() => workbench.airBoxMembers)

  /**
   * 边缘盒内的单位（1.4b）
   *
   * 单位在盒内即**不在图上**，故这里存**算子本体**（进入时从操作台 `units` 取出、离开时放回），
   * 与操作台的死亡堆同一思路：操作台只持盘面，盒内容由本 store 持。
   */
  const edgeBoxHeld = ref<Record<EdgeBoxId, ConsoleUnit[]>>({ northeast: [], southeast: [] })

  /** 编队收纳盒（编队 id → 归属方 + 全部成员 + 仍在图上的成员；13.7 / 3.6f） */
  const formationBoxes = ref<
    Record<string, { side: Side; memberIds: string[]; onMapIds: string[] }>
  >({})

  /** 剧本抽签结果（剧本 id → 各组抽中名单；由本 store 用 rng 抽定） */
  const drawResults = ref<
    Record<string, { kind: string; formationIds: string[]; detail: string }[]>
  >({})

  /**
   * ch10/ch11：本次抽签各编队的**西移落点**（编队 id → `列.行` 文本）
   *
   * 规则原文：「抽中的师必须沿道路向**所列位置**西移三格（例 11.03 → 9.01）」——
   * "所列位置"在**剧本卡**上，数据里没有 ⇒ 由玩家**点地图**给出（B27 通用待点格），
   * 引擎的 `planScenarioDraw` 收这个值当 `shiftHex`（缺它就按 `shiftWestDestinationMissing` 拒）。
   * ★ 修前面板**没有这个输入** ⇒ 剧本 1/2 的 A 组**永远落不了盘**（用户 9.17③a 的一部分）。
   */
  const drawShiftHexText = ref<Record<string, string>>({})

  /**
   * 抽签**落盘后的结果台账**（用户 9.17③a：「抽取的编队变化**自动列入初设**」）
   *
   * 每落一盘记一条：抽中的编队、本组处置、以及（西移组的）落点。
   * `setup` 只读它（`stores/setup.ts` 已 import 本 store ⇒ 不反向 import，避免成环），
   * 初设面板据此显示"这次抽签改了什么"。
   */
  const formationDrawOutcomes = ref<
    {
      groupKind: string
      groupLabel: string
      formationIds: readonly string[]
      detail: string
      /** shiftWest 组：编队 → 落点 `列.行` */
      destinations: readonly { formationId: string; hexText: string }[]
    }[]
  >([])

  /**
   * 2.3a 的警戒（Alarm）单位**配额**（来自单位库 `alarmLimit`：3 / 5 / 7）
   *
   * 2026-09-16 起数据已标注（此前是「单位库未标注 ⇒ 由裁判手输」的缺口）⇒ 这里从数据自动取，
   * 面板不再需要手输 id 清单。
   */
  const alarmQuotas = computed(() =>
    [...unitsAxis.units, ...unitsSoviet.units]
      .filter((record) => record.alarmLimit !== undefined)
      .map((record) => ({ unitId: record.id, limit: record.alarmLimit! })),
  )

  /**
   * 2.3a Alarm 单位清单（自动取自数据；保留可写是为了兼容裁判的临时覆盖）
   *
   * 空数组 = 「本局无可用 Alarm 单位」⇒ 按表 1-3 脚注第二项**作废**。
   */
  const alarmUnitIds = ref<string[] | null>(null)

  /** 生效的 Alarm id 清单（未手输时用数据里的配额表） */
  const effectiveAlarmUnitIds = computed<readonly string[]>(
    () => alarmUnitIds.value ?? alarmQuotas.value.map((quota) => quota.unitId),
  )

  /**
   * 2.3a 各型 Alarm 单位**目前的在场枚数**（地图 + 死亡堆；同型可多枚，故按实例计数）
   *
   * 「在场」取盘面事实：算子在地图上、或在死亡堆里，都算这局里已经用掉的那一枚配额。
   * （2.3a 的三种来源：开局在图上 / 开局在死亡堆 / 按到货表入场。）
   */
  const alarmInPlay = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    const ids = new Set(effectiveAlarmUnitIds.value)
    for (const unit of workbench.units)
      if (ids.has(unit.unitId)) counts[unit.unitId] = (counts[unit.unitId] ?? 0) + 1
    for (const entry of workbench.deadPile) {
      const unitId = (entry as { unitId?: string }).unitId
      if (unitId !== undefined && ids.has(unitId)) counts[unitId] = (counts[unitId] ?? 0) + 1
    }
    return counts
  })

  /** 2.3a 混编核算（每型的上限 / 在场 / 余量 / 是否超编）——面板显示与测试断言用 */
  const alarmMix = computed(() =>
    alarmMixRows({ quotas: alarmQuotas.value, inPlay: alarmInPlay.value }),
  )

  /** 2.3a 的规则号（与引擎唯一出处同源；面板把它显示在混编核算旁，便于复核） */
  const alarmMixRule = ALARM_MIX_RULE

  /** 最近一次操作结论（面板显示；带规则号） */
  const lastAction = ref<{ ok: boolean; rule: string; detail: string; scope: string } | null>(null)

  /* ────────────────────────────── 盘面事实 → 盒内单位视图 ────────────────────────────── */

  /** 全部地面单位记录（按 id 索引；取 13.5c 的可重建性与兵种） */
  const recordsById = computed(() => {
    const map = new Map<string, (typeof unitsAxis.units)[number]>()
    for (const record of [...unitsAxis.units, ...unitsSoviet.units]) map.set(record.id, record)
    return map
  })

  /** 操作台的一枚地面算子 → 盒内单位视图（只读；引擎判定所需的字段都在这里） */
  function toBoxUnit(unit: ConsoleUnit): BoxUnitView {
    const record = recordsById.value.get(unit.unitId)
    return {
      id: unit.instanceId,
      name: unit.name,
      side: unit.side,
      kind: 'ground',
      ...(record?.branch === undefined ? {} : { branch: record.branch }),
      steps: unit.steps,
      printedSteps: unit.printedSteps,
      // 1.6c 的免费重建资格按**战斗面印值**判定（12-2-2 之类即战斗面的 A-AR-MA）
      attack: unit.faces.combat.attack,
      ar: unit.faces.combat.ar,
      ma: unit.faces.combat.ma,
      ...(record?.rebuildable === undefined ? {} : { rebuildable: record.rebuildable }),
      isBreakdown: unit.specialized.includes('breakdown'),
    }
  }

  /** 拆分单位算子库（某方）：`branch: 'breakdown'` 的算子（1.8a / 20.0g） */
  function breakdownLibOf(side: Side): BoxUnitView[] {
    const records = side === 'axis' ? unitsAxis.units : unitsSoviet.units
    return records
      .filter((record) => record.branch === 'breakdown')
      .map((record) => {
        const ar = record.factors?.combat?.ar
        return {
          id: record.id,
          name: record.vassalName,
          side,
          kind: 'ground' as const,
          branch: record.branch,
          re: record.reSize,
          ...(typeof ar === 'number' ? { ar } : {}),
        }
      })
  }

  /** 操作台的飞机 → 盒内单位视图（1.4a 的分栏用 airStatus） */
  function toBoxAirUnit(air: ConsoleAirUnit): BoxUnitView {
    return {
      id: air.instanceId,
      name: air.name,
      side: air.side,
      kind: 'air',
      airStatus: air.airStatus,
      aircraftType: air.aircraftType,
    }
  }

  /** 死亡堆（按方） */
  const deadPileUnits = computed<Record<Side, BoxUnitView[]>>(() => {
    /*
     * 死亡堆**地面与空军共用**（用户裁定）：按条目判别字段分派到各自的视图转换，
     * 否则空军条目会被 `toBoxUnit` 当地面算子读取（它要读 `faces.combat` / `specialized` 等地面字段）。
     */
    const toEntryBox = (entry: DeadPileEntry): BoxUnitView =>
      isAirDeadPileEntry(entry) ? toBoxAirUnit(entry) : toBoxUnit(entry)
    return {
      axis: workbench.deadPile.filter((unit) => unit.side === 'axis').map(toEntryBox),
      soviet: workbench.deadPile.filter((unit) => unit.side === 'soviet').map(toEntryBox),
    }
  })

  /** 拆分单位算子库（双方；`branch: 'breakdown'`，1.8a / 20.0g） */
  const breakdownUnits = computed<Record<Side, BoxUnitView[]>>(() => ({
    axis: breakdownLibOf('axis'),
    soviet: breakdownLibOf('soviet'),
  }))

  /** 图上的拆分单位（按 AR 分档计数用） */
  const breakdownOnMap = computed<Record<Side, BoxUnitView[]>>(() => ({
    axis: workbench.units
      .filter((unit) => unit.side === 'axis' && unit.specialized.includes('breakdown'))
      .map(toBoxUnit),
    soviet: workbench.units
      .filter((unit) => unit.side === 'soviet' && unit.specialized.includes('breakdown'))
      .map(toBoxUnit),
  }))

  /** 拆分单位盒的账本（把操作台的 `breakdownPool` 总数按 1.8a 分档摊开；键 = 国籍前缀） */
  const breakdownLedger = computed<Record<Side, { ar: number; count: number }[]>>(() => {
    const prefix: Record<Side, string> = { axis: 'ax', soviet: 'su' }
    const build = (side: Side): { ar: number; count: number }[] => {
      const total = workbench.breakdownPool[prefix[side]] ?? 0
      const limits =
        rulesConstants.smolensk.counterLimits[side === 'axis' ? 'axisBreakdown' : 'sovietBreakdown']
      // 账本只有总数（操作台的 `breakdownPool` 以国籍为键）⇒ 按 1.8a 各档上限**依次灌满**，
      // 余数落在最后一档；这是账本口径下的如实摊派（面板上同时显示 1.8a 上限供核对）。
      let rest = total
      return limits.map((entry) => {
        const count = Math.max(0, Math.min(entry.count, rest))
        rest -= count
        return { ar: entry.ar, count }
      })
    }
    return { axis: build('axis'), soviet: build('soviet') }
  })

  /** 地图外空军盒成员（1.4a） */
  const aircraftInBox = computed<Record<Side, BoxUnitView[]>>(() => {
    const members = workbench.airUnits.filter((air) =>
      workbench.airBoxMembers.includes(air.instanceId),
    )
    return {
      axis: members.filter((air) => air.side === 'axis').map(toBoxAirUnit),
      soviet: members.filter((air) => air.side === 'soviet').map(toBoxAirUnit),
    }
  })

  /** 边缘盒成员（1.4b；仅苏方地面单位） */
  const edgeBoxUnits = computed<Record<EdgeBoxId, BoxUnitView[]>>(() => ({
    northeast: edgeBoxHeld.value.northeast.map(toBoxUnit),
    southeast: edgeBoxHeld.value.southeast.map(toBoxUnit),
  }))

  /** 编队收纳盒的成员（按操作台盘面回填名字） */
  const formationBoxInputs = computed(() =>
    Object.entries(formationBoxes.value).map(([formationId, box]) => ({
      formationId,
      side: box.side,
      members: box.memberIds
        .map(
          (id) =>
            workbench.units.find((unit) => unit.instanceId === id) ??
            workbench.deadPile.find((unit) => unit.instanceId === id),
        )
        .filter((unit): unit is ConsoleUnit => unit !== undefined)
        .map(toBoxUnit),
      onMapIds: box.onMapIds,
    })),
  )

  /* ────────────────────────────── 记录轨（查看 + 操作） ────────────────────────────── */

  /** 权威回合：有会话取会话，否则取本 store 的标记 */
  const turn = computed(() => session.records?.turn ?? markerTurn.value)
  /** 权威天气：有会话取会话，否则取本 store 的标记 */
  const weather = computed(
    () => session.records?.weather ?? { air: weatherMarker.value, ground: GROUND_ALWAYS_GOOD },
  )
  /** 权威铁路容量：有会话取会话，否则取本 store 的账本 */
  const railCapacity = computed<Record<Side, number>>(
    () => session.records?.railCapacity ?? railCapacityLedger.value,
  )
  /** 当日日期（回合轨给出；超出轨范围取首/末） */
  const date = computed(() => {
    const slot = markers.turnTrack.find((item) => item.turn === turn.value)
    return slot?.date ?? markers.turnTrack[markers.turnTrack.length - 1]?.date ?? ''
  })

  /** 记录轨事实（引擎视图的输入） */
  const trackFacts = computed(() => ({
    turn: turn.value,
    weather: weather.value,
    railCapacity: railCapacity.value,
  }))

  const turnTrack = computed(() => turnTrackView(trackFacts.value))
  const weatherTrack = computed(() => weatherTrackView(trackFacts.value))
  const railCapTrack = computed(() => railCapTrackView(trackFacts.value, date.value))

  /** 2.2 Turn End：推进回合标记（有会话时不越权改流程，只做计划核对） */
  function advanceTurnMarker(): boolean {
    const next = turn.value + 1
    const plan = planTurnMarkerAdvance(trackFacts.value, next)
    if (!plan.ok) {
      lastAction.value = { ok: false, rule: plan.rule, detail: plan.reason, scope: '记录轨·回合轨' }
      workbench.pushLog('danger', `回合标记无法推进：${plan.reason}（${plan.rule}）`, plan.rule)
      return false
    }
    if (session.records === null) markerTurn.value = next
    lastAction.value = {
      ok: true,
      rule: plan.rule,
      detail: plan.data.detail,
      scope: '记录轨·回合轨',
    }
    workbench.pushLog('info', plan.data.detail, plan.rule)
    return true
  }

  /** 1.5：设定天气标记（受限 / 正常飞行） */
  function setWeatherMarker(air: 'normal' | 'limited'): void {
    weatherMarker.value = air
    const view = weatherTrackView({
      ...trackFacts.value,
      weather: { air, ground: GROUND_ALWAYS_GOOD },
    })
    lastAction.value = { ok: true, rule: view.rule, detail: view.note, scope: '记录轨·天气轨' }
    workbench.pushLog(
      'info',
      `天气标记 → ${air === 'normal' ? '正常飞行' : '受限飞行'}（${view.rule}）`,
      view.rule,
    )
  }

  /** 13.3b：设铁路容量标记（主轨 1–maxMain + 副轨 0–maxSub） */
  function setRailCapacity(side: Side, value: number): boolean {
    if (!railCapPositionValid(value)) {
      const reason = `railCapPositionOutOfTrack:${value}`
      lastAction.value = { ok: false, rule: '13.3b', detail: reason, scope: '记录轨·铁路容量轨' }
      workbench.pushLog('danger', `铁路容量轨位非法：${value}（13.3b）`, '13.3b')
      return false
    }
    if (session.records === null) {
      railCapacityLedger.value = { ...railCapacityLedger.value, [side]: value }
    }
    const expected = railCapTrack.value.sides.find((entry) => entry.side === side)?.onDate ?? value
    const detail =
      `${side === 'axis' ? '轴心国' : '苏联'}铁路容量标记 → ${value}（13.3b）；按日期（${date.value}）应为 ${expected}` +
      (expected === value ? '' : ' ⚠ 与日期不符（专规 1.2 的升级日）')
    lastAction.value = { ok: true, rule: '13.3b', detail, scope: '记录轨·铁路容量轨' }
    workbench.pushLog(expected === value ? 'info' : 'warning', detail, '13.3b')
    return true
  }

  /** 专规 1.2：按当日日期把双方容量设到表 1-1 的值（升级日前后各一套） */
  function applyRailCapacityForDate(): void {
    const view = railCapTrack.value
    for (const entry of view.sides) {
      if (session.records === null) {
        railCapacityLedger.value = { ...railCapacityLedger.value, [entry.side]: entry.onDate }
      }
    }
    const detail =
      `按 ${date.value} 重算：轴 ${view.sides[0]?.onDate ?? 0} / 苏 ${view.sides[1]?.onDate ?? 0}` +
      `（专规 1.2 表 1-1；升级日 ${view.boostDate}${view.boosted ? '，已生效' : '，未到'}）`
    lastAction.value = { ok: true, rule: '13.3b', detail, scope: '记录轨·铁路容量轨' }
    workbench.pushLog('info', detail, '13.3b')
  }

  /* ────────────────────────────── 容器名册（引擎视图） ────────────────────────────── */

  /** 全部盒的名册（与面板展示顺序一致） */
  const boxes = computed<readonly BoxView[]>(() =>
    allBoxViews({
      scenarioId: scenarioId.value,
      deadPile: deadPileUnits.value,
      breakdownUnits: breakdownUnits.value,
      breakdownOnMap: breakdownOnMap.value,
      aircraftInBox: aircraftInBox.value,
      edgeBoxUnits: edgeBoxUnits.value,
      formationBoxes: formationBoxInputs.value,
      date: date.value,
    }),
  )

  /** 取某个盒（kind + 归属方；剧本抽取盒与边缘盒用 id 取） */
  function boxOf(kind: BoxKind, side?: Side): BoxView | null {
    return (
      boxes.value.find(
        (view) => view.kind === kind && (side === undefined || view.side === side),
      ) ?? null
    )
  }

  /** 取某个盒（按 id） */
  function boxById(id: string): BoxView | null {
    return boxes.value.find((view) => view.id === id) ?? null
  }

  /* ────────────────────────────── 辅助卡卡面（B12） ────────────────────────────── */

  /**
   * 一张辅助卡的**投影**：卡面图 + 每个分区里摆着哪些算子
   *
   * 数据侧只有"分区矩形"（`aux-cards.json`），引擎侧只有"盒名册"（`boxes`）——
   * 本投影把两者按 `REGION_OF_BOX` 对接：**分区 → 盒/栏 → 该栏的算子**。
   * 于是 `BoxCard.vue` 只画被给的东西（卡面 + 矩形 + 每格里的算子），不自己解释规则。
   *
   * 三件事如实标注、不臆造：
   *   · 分区**没有对应盒/栏**（如"标记存放"装的是标记不是单位）⇒ `units: []` + `note` 说明；
   *   · 对应到盒但**该盒栏位取不到**（剧本未提供）⇒ 同样留空并给 `note`；
   *   · 每张卡的图档名照抄数据（URL 由渲染侧 `encodeURI` 编码）。
   */
  /** 当前展开的那一张辅助卡（用户口径④：**同时只展开一张**）*/
  const cardOpenId = ref<string | null>(null)

  /** 展开/收起某一张卡（同时只展开一张） */
  function toggleCardOpen(id: string): void {
    cardOpenId.value = cardOpenId.value === id ? null : id
    popupCardId.value = null
  }

  /* ────────────────────────── C-2：盒卡**弹出为浮窗**（用户口径 / 方案 §3 B35 步骤 8） ────────────────────────── */

  /**
   * 正在**浮窗**里看的那张卡（null＝没有浮窗）
   *
   * 与 `cardOpenId`（托盘里的"展开哪一张"）分开记：浮窗是"把卡面放大看"的临时视图，
   * 两者可以同时存在（托盘里展开着 A、浮窗里看 B），Esc 或点关闭只收浮窗。
   */
  const popupCardId = ref<string | null>(null)

  /** 打开 / 收起某张卡的浮窗 */
  function setPopupCard(id: string | null): void {
    popupCardId.value = id
  }

  /**
   * C-1：**当前展开的盒卡"管"哪些盒**（`boxKind` 集合；没展开卡 ⇒ `null`＝不过滤）
   *
   * 判据只来自数据（该卡的 `regions[].boxKind`）：展开"轴心死人堆"就只给死亡堆的动作，
   * 展开"轴心空军地图外盒"就只给空军盒的动作 —— 解决"展开任意卡都开同一套动作"的老毛病。
   * 没展开卡时返回 `null`（验证页/右栏那两份面板照旧全给，那是核对场景）。
   */
  const openCardBoxKinds = computed<readonly string[] | null>(() => {
    const id = cardOpenId.value
    if (id === null) return null
    const card = cardViews.value.find((item) => item.id === id)
    if (card === undefined) return null
    /*
     * ★ 修（2026-10-30）：这里原先直接返回 `region.kind`，而它是**数据侧的分区名**
     *   （`aux-cards.json` 的 `boxKind`：`dead_pile` / `air_box_active` / …）。
     *   面板 `showsBoxActions(kind)` 传的却是**引擎的盒名**（`BoxKind`：`deadPile` / `airBox` / …）
     *   ⇒ `['dead_pile'].includes('deadPile') === false`，**永不命中**。
     *   而对局台打开盒卡会话的唯一触发条件就是"展开着一张卡"（`map-view` 的 `containers` 会话），
     *   于是展开任何盒卡后**所有盒内动作都不渲染**：1.4a 移出盒与免费整备、1.4b 边缘盒进出、
     *   1.6c 特殊补员掷骰、13.7 收纳、20.0a 拆分取用、死亡堆返场——整个会话只剩只读清单。
     *
     * 口径：**两种键都收**——归一后的引擎盒名（给 `showsBoxActions('deadPile')` 这类调用），
     *   以及原始分区名（给 `showsBoxActions('markers')` 这类"按分区"的调用；
     *   注意 `markers` 在 `REGION_OF_BOX` 里映射到 `deadPile`，直接取引擎名会认错）。
     */
    const keys = new Set<string>()
    for (const region of card.regions) {
      keys.add(region.kind)
      const mapped = boxOfRegion(region.kind)
      if (mapped !== null) keys.add(mapped.boxKind)
    }
    return [...keys]
  })

  /** C-1：当前展开卡的名字（会话框标题用；没展开 ⇒ `null`） */
  const openCardName = computed<string | null>(() => {
    const id = cardOpenId.value
    if (id === null) return null
    return cardViews.value.find((item) => item.id === id)?.name ?? null
  })

  const cardViews = computed<readonly AuxCardView[]>(() =>
    auxCards.cards.map((card) => {
      const side = card.side === 'axis' || card.side === 'soviet' ? card.side : null
      return {
        id: card.id,
        side,
        name: card.name,
        boxKind: card.boxKind,
        image: card.image,
        imageSize: card.imageSize,
        regions: card.regions.map((region) => {
          const target = boxOfRegion(region.boxKind)
          /*
           * B31c：运力记录轨的分区（不属于任何盒）——按**当前容量**点灯
           * （"1SP"…"10SP" 与 railCapCell 相同者 active；副轨 0T–3T 暂无事实来源 ⇒ 不点灯）
           */
          if (region.boxKind === 'capacity_track') {
            const num = region.label.replace(/[^0-9]/g, '')
            return {
              id: region.id,
              label: region.label,
              kind: region.boxKind,
              rect: region.rect,
              rule: '专规 1.2',
              units: [],
              note: null,
              // 只有**主轨**（1SP–10SP）能对当前容量点灯：副轨 0T–3T 本作暂无"剩余吨位"这一事实
              active: region.label.endsWith('SP') && num !== '' && num === railCapCell.value,
            }
          }
          if (target === null) {
            return {
              id: region.id,
              label: region.label,
              kind: region.boxKind,
              rect: region.rect,
              rule: '—',
              units: [],
              note: '该分区装的是标记 / 非名册内容，暂不铺算子',
            }
          }
          if (target.sectionId === null) {
            /*
             * ★ 批 D 切片 2（用户 9.16 #15）：**标记存放盒不再是空的** ——
             *   专规 3.5 的建造标记（剧本 1/2 各 3 枚）就存在这个盒里，放置时才二选一（桥 / 简易机场）。
             *   修前这里一律给空数组 + 一句"不对应盒的栏"，于是"标记盒确实是空的"（族⑤ 的原话）。
             *   口径：**未放置的**才是盒里的内容（已放置的在图上，由 `constructionMarkerPieces` 渲染）；
             *   苏方卡如实说明"建造标记是轴方专规 3.5"。
             */
            if (region.boxKind === 'markers') {
              const axisSide = (side ?? workbench.activeSide) === 'axis'
              const remaining = axisSide ? workbench.constructionMarkers : 0
              return {
                id: region.id,
                label: region.label,
                kind: region.boxKind,
                rect: region.rect,
                rule: target.rule,
                units: Array.from({ length: remaining }, (_, index) => ({
                  unitId: `construction-marker:${index + 1}`,
                  name: '建造标记（放置时二选一：桥 13.8b / 简易机场 15.2）',
                  side: 'axis' as const,
                  sectionId: 'markers',
                  imageUrl: null,
                })),
                note: axisSide
                  ? remaining === 0
                    ? '本剧本没有建造标记（专规 3.5：剧本 1/2 各 3 枚，其余 0 枚）'
                    : '展开本卡即在会话框里「拾起并落位」（专规 3.5：轴方移动阶段、单位移动之前）'
                  : '建造标记是**轴方**专规 3.5 的内容 ⇒ 苏方此盒无此项',
              }
            }
            return {
              id: region.id,
              label: region.label,
              kind: region.boxKind,
              rect: region.rect,
              rule: target.rule,
              units: [],
              note: '该分区不对应盒的栏（见 §4.7 的分区说明）',
            }
          }
          const box = boxOf(target.boxKind, side ?? undefined)
          const units = (box?.holdings ?? [])
            .filter((holding) => holding.sectionId === target.sectionId)
            // B31：每枚带好贴图 URL（组件不再自己拼文件名）
            .map((holding) => ({ ...holding, imageUrl: holdingImageUrlOf(holding) }))
          return {
            id: region.id,
            label: region.label,
            kind: region.boxKind,
            rect: region.rect,
            rule: target.rule,
            units,
            note: box === null ? '本剧本没有这一个盒（或该方不适用）' : null,
          }
        }),
      }
    }),
  )

  /**
   * B31：盒内一枚算子的**贴图 URL**（用户口径 #12「盒里的算子要显示贴图」）
   *
   * 修前组件拿 `holding.unitId` 当图档名拼文件名 —— 而死亡堆 / 空军盒 / 边缘盒里那是**实例 id**，
   * 于是永远取不到图、只剩名字。这里按 **id 空间**逐个试：
   *   · 地面实例 → `counterImageUrlOf(unit)`（与地图同一条选图实现，自动选面）；
   *   · 飞机实例 → 同上（空军盒里的是飞机实例）；
   *   · 都不是（如拆分单位池的**库 id**）→ null（组件退回只写名字，不臆造文件名）。
   */
  function holdingImageUrlOf(holding: { unitId: string }): string | null {
    const ground = workbench.units.find((unit) => unit.instanceId === holding.unitId)
    if (ground !== undefined) return counterImageUrlOf(ground)
    const air = workbench.airUnits.find((item) => item.instanceId === holding.unitId)
    if (air !== undefined) return counterImageUrlOf(air)
    return null
  }

  /**
   * B31c：**双方共用**的卡（`side === null`，如运力记录轨）
   *
   * 与两侧的三张方别卡分开列：它的内容是"一条轨"，不属于任何一方。
   */
  const sharedCardViews = computed<readonly AuxCardView[]>(() =>
    cardViews.value.filter((card) => card.side === null),
  )

  /**
   * B31c：**运力记录轨的当前格**（专规 1.2 / 13.3b）
   *
   * 用户 2026-09-16：「运力标记显示在这上面，**会根据当前使用情况自动推格子**」。
   * 判据只有一处：引擎的 `railCapTrackView` 给出的**当前容量**（`current`，随日期与专规 1.2 的
   * 升级日变化），不是界面自己算的。
   * 主轨（`1SP`–`10SP`）＝铁路容量；副轨（`0T`–`3T`）本作暂无"剩余吨位"这一事实 ⇒ 不点灯（如实）。
   */
  const railCapCell = computed<string | null>(() => {
    const side = workbench.activeSide
    const row = railCapTrack.value.sides.find((item) => item.side === side)
    return row === undefined ? null : String(row.current)
  })

  /** 该方的卡（界面按方分组显示） */
  function cardViewsOf(side: Side): readonly AuxCardView[] {
    return cardViews.value.filter((card) => card.side === side)
  }

  /* ────────────────────────────── 掷骰（唯一入口 rng.ts） ────────────────────────────── */

  /** 掷 1 骰并推进操作台的 rng 游标（种子化可重放） */
  function rollDieOnce(): number {
    const draw = roll1d6(workbench.rng)
    workbench.rng = draw.rng
    workbench.drawCount += 1
    return draw.value.total
  }

  /** 在 `[0, size)` 中均匀抽一个下标（抽取盒用；无取模偏差） */
  function pickFrom(size: number): number {
    const draw = pickIndex(workbench.rng, size)
    workbench.rng = draw.rng
    workbench.drawCount += 1
    return draw.value
  }

  /* ────────────────────────────── 1.6c 特殊补员抽取 ────────────────────────────── */

  /**
   * 1.6c：结算一次特殊补员（苏方两项 / 轴方一项）
   *
   * 掷 1 骰 → 查特殊补员表 → 固定项「师随机重建」（在死亡堆的合格池里**用 rng 抽定**）
   * → 第二项（Supply Cache / 特种营）；无可用 ⇒ 作废。
   */
  function drawSpecialRepl(side: Side): boolean {
    /*
     * ★ 专规 1.6c 的**时机**（用户 2026-10-25「注意该操作时机」）：
     *   原文「Each turn **before 19 August**, the players also get to roll a die on their
     *   **Special Repl Table**…」——它发在**本方 B 增援段**的「特殊补员抽取」这一环
     *   （`ACTION_GATES['rein.specialRepl']` 的 `where` 只有
     *   `{ phase: 'reinforcement', segment: 'reinforcement.specialRepl' }`，且**双方都有**：
     *   「the players」＋ 13.6b 的掷表也在本方增援阶段）。
     *   「19 August 起停止」是**第二道**闸门，由引擎按日期判（`isSpecialReplAvailable` /
     *   `planSpecialReplDraw` 的 `specialReplStoppedFrom`）——两道闸门各管一件事，不互相替代。
     */
    if (!workbench.requireAction('rein.specialRepl', '特殊补员抽取')) return false
    /*
     * 1.6b 原文「A player rolls… during **his** Reinforcement Phase」⇒ 掷表的是**本方**自己的
     * 增援阶段。故这里再钉一条**同方**判据：不能在自己的 B 段里去掷**对方**的表
     * （盒卡与掷表入口都按方列出，但 store 是公开 API，这一条兜住"参数传错方"）。
     */
    if (side !== workbench.activeSide) {
      lastAction.value = {
        ok: false,
        rule: '1.6c',
        detail: `只能在**本方**的增援阶段掷表（当前行动方是 ${workbench.activeSide}）`,
        scope: '1.6c 特殊补员',
      }
      workbench.pushLog(
        'warning',
        `特殊补员只能在本方增援阶段掷表（当前行动方 ${workbench.activeSide}）`,
        '1.6c',
      )
      return false
    }
    const die = rollDieOnce()
    const dead = deadPileUnits.value[side]
    // 苏方固定项「随机重建一个师」：候选池由引擎按 1.6c 判定，抽哪一个用 rng 决定
    const candidates = planSpecialReplDraw({
      side,
      date: date.value,
      die,
      deadPile: dead,
      alarmUnitIds: effectiveAlarmUnitIds.value,
      alarmQuotas: alarmQuotas.value,
      alarmInPlay: alarmInPlay.value,
    })
    if (!candidates.ok) {
      lastAction.value = {
        ok: false,
        rule: candidates.rule,
        detail: candidates.reason,
        scope: '1.6c 特殊补员',
      }
      workbench.pushLog(
        'danger',
        `特殊补员被拒：${candidates.reason}（${candidates.rule}）`,
        candidates.rule,
      )
      return false
    }
    const divisionPool = candidates.data.pools.divisionCandidates
    const chosen =
      side === 'soviet' && divisionPool.length > 0
        ? (divisionPool[pickFrom(divisionPool.length)] ?? null)
        : null
    const planned = planSpecialReplDraw({
      side,
      date: date.value,
      die,
      deadPile: dead,
      alarmUnitIds: effectiveAlarmUnitIds.value,
      alarmQuotas: alarmQuotas.value,
      alarmInPlay: alarmInPlay.value,
      ...(chosen === null ? {} : { chosenDivisionId: chosen }),
    })
    if (!planned.ok) {
      lastAction.value = {
        ok: false,
        rule: planned.rule,
        detail: planned.reason,
        scope: '1.6c 特殊补员',
      }
      workbench.pushLog(
        'danger',
        `特殊补员被拒：${planned.reason}（${planned.rule}）`,
        planned.rule,
      )
      return false
    }
    /*
     * 落点：2.1 注「Pax, Eq, **special repls**, and breakout returns arrive at **any HQs able to get
     * trace supply (12.6a) by direct draw**, or else in **any map-edge supply source hexes**」
     * ⇒ 不能拿"当前选中的那一格"凑数（修前就是这么干的）。两者都没有 ⇒ **整笔拒绝**
     *   （规则没给这种落点，不许自行挑一格）。
     */
    const placement = workbench.replArrivalPlacement()
    const needsHex = planned.data.patches.some((patch) => patch.to === null)
    if (needsHex && placement.hex === null) {
      lastAction.value = {
        ok: false,
        rule: '2.1',
        detail: `特殊补员无处返场：${placement.detail}`,
        scope: '1.6c 特殊补员',
      }
      workbench.pushLog('danger', `特殊补员无处返场：${placement.detail}（2.1）`, '2.1')
      return false
    }
    const placementHex = placement.hex === null ? null : `${placement.hex.col}.${placement.hex.row}`
    for (const patch of planned.data.patches) {
      if (patch.to === null && placementHex !== null) {
        workbench.returnFromDeadPileNow({
          instanceId: patch.unitId,
          hexText: placementHex,
          ...(patch.steps === undefined ? {} : { steps: patch.steps }),
        })
      }
    }
    if (planned.data.second.kind === 'supplyCache') {
      workbench.addSupplyCacheNow(side)
    }
    lastAction.value = {
      ok: true,
      rule: planned.rule,
      detail: planned.data.detail,
      scope: '1.6c 特殊补员',
    }
    workbench.pushLog('success', planned.data.detail, planned.rule)
    return true
  }

  /** 返场落点：优先取操作台当前选中的格（没有则让裁判手工摆） */
  function newHexForReturn(): string | null {
    const selected = workbench.selectedUnit?.hex
    return selected === undefined ? null : `${selected.col}.${selected.row}`
  }

  /* ────────────────────────────── 拆分单位盒取用 ────────────────────────────── */

  /**
   * 20.0 / 20.0a–g：从盒里取一枚拆分单位给指定母单位（创建拆分单位）
   *
   * ★ 修（2026-10-30）：这里原先由**调用方**传 `timing`（面板写死 `'startMove'`），
   *   等于让界面替规则宣称"此刻正是开始移动"，引擎那道 20.0a 判据（`BREAKDOWN_CREATE_TIMINGS`
   *   只做枚举校验）就永远通过 ⇒ **任何环节**都能从盒里取拆分单位。
   *   20.0a 原文：「多军力单位在**开始移动、战后推进或战后撤退**时，可以创建一个或多个拆分单位。
   *   **只有在这些时机**才能创建拆分单位。」
   *   现在两件事都改由**事实**决定：
   *     ① 环节闸 `move.breakdown`（与 `createBreakdownNow` 同一道）；
   *     ② 时机取 store 的事件账本 `breakdownTimingOf`（由真实事件开窗），不在账本里即拒。
   */
  function takeBreakdown(input: { parentInstanceId: string; breakdownAr: number }): boolean {
    if (!workbench.requireAction('move.breakdown', '取用拆分单位')) return false
    const parentUnit = workbench.units.find((unit) => unit.instanceId === input.parentInstanceId)
    if (parentUnit === undefined) {
      lastAction.value = { ok: false, rule: '20.0', detail: '母单位不在图上', scope: '拆分单位盒' }
      return false
    }
    const timing = workbench.breakdownTimingOf(parentUnit.instanceId)
    if (timing === null) {
      const detail =
        `${parentUnit.name} 此刻不在 20.0a 的创建时机里` +
        '（只有「开始移动 / 战后推进 / 战后撤退」这三个时机能创建拆分单位）'
      lastAction.value = { ok: false, rule: '20.0a', detail, scope: '拆分单位盒' }
      workbench.pushLog('warning', detail, '20.0a')
      return false
    }
    const box = boxOf('breakdownBox', parentUnit.side)
    const slots = (box as { slots?: readonly BreakdownPoolSlot[] } | null)?.slots ?? []
    const parent: BreakdownCreateRequest['parent'] = {
      id: parentUnit.instanceId,
      side: parentUnit.side,
      nationality: parentUnit.side === 'axis' ? 'german' : 'soviet',
      classKind: parentUnit.combatClass,
      ar: parentUnit.faces.combat.ar,
      steps: parentUnit.steps,
      printedSteps: parentUnit.printedSteps,
      dg: parentUnit.mode.dg,
      internalStocks: parentUnit.internalStocks,
      mode: 'combat',
    }
    const breakdown: BreakdownCreateRequest['breakdown'] = {
      id: `breakdown-ar${input.breakdownAr}`,
      side: parentUnit.side,
      nationality: parent.nationality,
      classKind: 'other',
      ar: input.breakdownAr,
      steps: rulesConstants.breakdown.breakdownSteps,
      printedSteps: rulesConstants.breakdown.breakdownSteps,
      dg: parent.dg,
      internalStocks: parent.internalStocks,
      mode: parent.mode,
    }
    const plan = planBreakdownTake({
      side: parentUnit.side,
      parent,
      breakdown,
      // 时机来自事件账本（见函数开头的说明），不再由调用方自报
      timing,
      slots,
    })
    if (!plan.ok) {
      lastAction.value = { ok: false, rule: plan.rule, detail: plan.reason, scope: '拆分单位盒' }
      workbench.pushLog('danger', `拆分单位取用被拒：${plan.reason}（${plan.rule}）`, plan.rule)
      return false
    }
    /*
     * 20.0：取用 = **从盒里拿一枚算子摆到母单位所在格**。
     *
     * ★ 原先这里只做「母单位 −1 军力、池 −1」并打一句「拆出 1 个拆分单位」，
     *   盘面上却根本不出现算子（`units` 没变）——账扣了、子没出。
     * ★ 先在**扣账之前**确认算子库里有对应 AR 的拆分单位：否则会留下
     *   「账已扣、子落不下」的半截状态。
     */
    const record = unitChoices(parentUnit.side).find(
      (item) => item.branch === 'breakdown' && item.factors?.combat?.ar === input.breakdownAr,
    )
    if (record === undefined) {
      const detail = `算子库中没有 AR${input.breakdownAr} 的拆分单位（20.0g：同国籍池）`
      lastAction.value = { ok: false, rule: '20.0g', detail, scope: '拆分单位盒' }
      workbench.pushLog('danger', detail, '20.0g')
      return false
    }
    // 落盘：母单位 −1 军力、池 −1（20.0：如同战斗损失、不耗 MP），并**摆出拆分单位算子**
    parentUnit.steps = plan.data.parentStepsAfter
    const prefix = parentUnit.side === 'axis' ? 'ax' : 'su'
    workbench.breakdownPool = {
      ...workbench.breakdownPool,
      [prefix]: Math.max(0, (workbench.breakdownPool[prefix] ?? 0) - 1),
    }
    workbench.units.push(
      toConsoleUnit({
        record,
        instanceId: createId('brk'),
        hex: { ...parentUnit.hex },
        side: parentUnit.side,
      }),
    )
    lastAction.value = { ok: true, rule: plan.rule, detail: plan.data.detail, scope: '拆分单位盒' }
    workbench.pushLog('success', plan.data.detail, plan.rule)
    return true
  }

  /* ────────────────────────────── 剧本抽取盒（编队抽签） ────────────────────────────── */

  /** 该剧本的抽取盒视图（`BoxView` 是平铺接口，富字段取回 `ScenarioDrawBoxView`） */
  const scenarioDrawBox = computed<ScenarioDrawBoxView | null>(() => {
    const view = boxes.value.find((box) => box.kind === 'scenarioDrawBox')
    return (view as ScenarioDrawBoxView | undefined) ?? null
  })

  /**
   * 抽签：在池内用 rng 均匀抽 `count` 个编队（不重复）
   *
   * 规则原文只给「入杯名单＝池成员」与「抽几个」，未逐条列出抽中者 ⇒ 由本次抽签决定。
   *
   * ★ `poolScenarioId`（第六批 §6-A）：池**按初设源剧本**取（1–2 / 3–4 / 5–6 共用初设，
   *   而 `formations.json` 的 `sources` 只标在源剧本上 ⇒ 剧本 2 直接取池会是空的）；
   *   结果仍记在**当前剧本**名下（界面与 `pendingShiftWestPlacements` 都按当前剧本读）。
   */
  /**
   * ch10「4 **others**」/ ch11「5 **others**」：本剧本**其它组**已抽中的编队
   *
   * 原文是「抽 4 个…；**另**抽 4 个…」⇒ 一个师不能同时进两组（同一个师既西移三格又做
   * Mtr↔Aufk 互换是规则没写的效果）。修前各组各自从**整池**抽 ⇒ 实测 A/B 两组都抽到了
   * `29 Mtr Div`（重叠期望 ≈ 4×4/12 ≈ 1.3 个）。
   */
  function drawnByOtherGroups(kind: string): readonly string[] {
    const rows = drawResults.value[scenarioId.value] ?? []
    return rows.filter((row) => row.kind !== kind).flatMap((row) => row.formationIds)
  }

  function drawFormations(
    group: ScenarioDrawGroup,
    reduced = false,
    poolScenarioId?: string,
    /** 附加排除（调用方已知"这些不该再被抽到"） */
    exclude: readonly string[] = [],
  ): string[] {
    const excluded = new Set([...drawnByOtherGroups(group.kind), ...exclude])
    const pool = axisDrawPool(poolScenarioId ?? scenarioId.value)
      .map((entry) => entry.formationId)
      .filter((formationId) => !excluded.has(formationId))
    const count = reduced
      ? pool.length > 0
        ? Math.min(pool.length, Math.ceil(group.count / 2))
        : 0
      : group.count
    const remaining = [...pool]
    const drawn: string[] = []
    for (let index = 0; index < count && remaining.length > 0; index += 1) {
      const picked = pickFrom(remaining.length)
      const [formationId] = remaining.splice(picked, 1)
      if (formationId !== undefined) drawn.push(formationId)
    }
    const record = drawResults.value[scenarioId.value] ?? []
    drawResults.value = {
      ...drawResults.value,
      [scenarioId.value]: [
        ...record.filter((item) => item.kind !== group.kind),
        {
          kind: group.kind,
          formationIds: drawn,
          detail: `${group.label}：抽中 ${drawn.join('、')}`,
        },
      ],
    }
    const detail = `${scenarioId.value} 号剧本 ${group.label}：从 ${pool.length} 个入杯编队中抽中 ${drawn.join('、')}（${group.rule}）`
    lastAction.value = { ok: true, rule: group.rule, detail, scope: '剧本抽取盒' }
    workbench.pushLog('info', detail, '剧本页·编队抽签')
    return drawn
  }

  /** 该剧本某组已抽中的名单 */
  function drawnOf(group: ScenarioDrawGroup): string[] {
    return (
      drawResults.value[scenarioId.value]?.find((item) => item.kind === group.kind)?.formationIds ??
      []
    )
  }

  /**
   * ch10：**点地图选某个抽中编队的西移落点**（B27 通用待点格）
   *
   * 为什么由玩家给：原文只给"沿道路从所列位置西移三格"这个算法（例 11.03 → 9.01），
   *   所列位置数据里有（scenario-setup.json），但**道路拓扑未覆盖该区域**（11.03 周边 0 条 road 边）
   *   ⇒ 走不出那条路、算不出落点 ⇒ 由玩家照剧本卡给
   * （要看剧本卡的那张示意图）。候选给 `'any'`（合法性在**落盘时**由引擎按剧本卡口径判：
   * 只校验"给了落点"这一形状），与 B27 的二类口径一致。
   */
  function beginDrawShiftHexPickNow(formationId: string): void {
    workbench.beginHexPick({
      label: `西移落点（${formationId}）`,
      rule: 'ch10 Formation Chit Draw',
      candidates: 'any',
      apply: (hex) => {
        drawShiftHexText.value = {
          ...drawShiftHexText.value,
          [formationId]: `${hex.col}.${hex.row}`,
        }
        return true
      },
    })
  }

  /** 该编队已选的西移落点（无则 null） */
  function drawShiftHexOf(formationId: string): string | null {
    return drawShiftHexText.value[formationId] ?? null
  }

  /**
   * I②：该编队的**组成**一句人话（面板只读显示；判据在引擎 `deriveDrawComposition`）
   *
   * 推不出来时如实给"（组成推不出来：<原因>）"——不静默留空，也不替它猜。
   */
  function drawCompositionNoteOf(formationId: string): string {
    const derived = deriveFactsFor(formationId)
    return derived === null ? '（组成推不出来：见日志）' : derived.note
  }

  /**
   * 落盘抽签结果（三项处置）
   *
   * ★ 用户 2026-09-18 报告第 5 条起，`facts` **不再要求调用方注入**：缺哪个编队的组成就用
   *   `deriveFactsFor` 从**初设索引**自动推（判据在引擎 `deriveDrawComposition`）；
   *   传入的 facts 仍是**覆盖**（验证页/裁判用）。
   *   · shiftWest：抽中师沿道路西移 3 格（原文只给算法（沿道路西移 3 格，例 11.03 → 9.01）、道路拓扑数据未覆盖该区域 ⇒ 仍由玩家点地图给出）；
   *   · moveMode：把抽中师的**战斗**单位转为 Move Mode；
   *   · mtrAufkSwap / deadPileKrd / deadPileAufk：把指定单位送进死亡堆 / 从死亡堆返场
   *     （返场落点＝该编队初设行里的图上格号，不再写死）。
   */
  function applyDraw(
    group: ScenarioDrawGroup,
    facts: Record<
      string,
      {
        mtrRegimentUnitId?: string
        aufkBattalionUnitId?: string
        krdBattalionUnitId?: string
        combatUnitIds?: readonly string[]
        /** 调用方直接给的西移落点（`列.行`） */
        shiftHexText?: string
        /** 自动推出的图上落点（`列.行`；初设行的固定格号） */
        anchorHexText?: string
      }
    > = {},
  ): boolean {
    const drawn = drawnOf(group)
    if (drawn.length === 0) {
      lastAction.value = {
        ok: false,
        rule: group.rule,
        detail: '尚未抽签（请先抽签）',
        scope: '剧本抽取盒',
      }
      return false
    }
    /*
     * ★ 用户 2026-09-18 报告第 5 条：**组成不再要求调用方（玩家）注入** ——
     *   调用方没给某个编队的组成事实时，就从**初设索引**自动推出（`deriveFactsFor`；
     *   判据在引擎 `deriveDrawComposition`）。这样"抽签 → 落盘"是**一步到位**的动作，
     *   玩家不需要知道任何 unit id。
     */
    const factsOf = (formationId: string) =>
      facts[formationId] ?? deriveFactsFor(formationId)?.facts ?? null
    const derivedNotes: string[] = []
    /** 该编队图上落点（`列.行`）——返场单位就放回这里（用户第 5 条：落点按数据，不写死） */
    const anchorByUnitId = new Map<string, string>()
    const composed: Record<
      string,
      {
        mtrRegimentUnitId?: string
        aufkBattalionUnitId?: string
        krdBattalionUnitId?: string
        combatUnitIds?: readonly string[]
        shiftHex?: { col: number; row: number }
      }
    > = {}
    for (const formationId of drawn) {
      const fact = factsOf(formationId)
      if (fact === null) return false // deriveFactsFor 已写过 lastAction/日志
      /*
       * 返场落点：**无论组成是谁给的**，都先问一次初设索引（落点是初设行的属性，与"哪一枚单位"
       * 无关）——自动路径与"调用方注入组成"的验证路径都能拿到同一个落点；
       * 索引里没有（或该剧本没摆这个师）时退回调用方给的返场格（`newHexForReturn`），
       * 两者都没有就**不猜**（下面循环里如实报"请在初设里手动放置"）。
       */
      const derivedForAnchor = deriveFactsFor(formationId)
      if (derivedForAnchor !== null) {
        if (facts[formationId] === undefined) derivedNotes.push(derivedForAnchor.note)
        const anchorHexText = derivedForAnchor.facts.anchorHexText
        if (anchorHexText !== undefined) {
          for (const unitId of [
            fact.mtrRegimentUnitId,
            fact.aufkBattalionUnitId,
            fact.krdBattalionUnitId,
          ]) {
            if (unitId !== undefined) anchorByUnitId.set(unitId, anchorHexText)
          }
        }
      }
      const shiftHex = parseHexOf(fact.anchorHexText ?? '')
      composed[formationId] = {
        ...(fact.mtrRegimentUnitId === undefined
          ? {}
          : { mtrRegimentUnitId: fact.mtrRegimentUnitId }),
        ...(fact.aufkBattalionUnitId === undefined
          ? {}
          : { aufkBattalionUnitId: fact.aufkBattalionUnitId }),
        ...(fact.krdBattalionUnitId === undefined
          ? {}
          : { krdBattalionUnitId: fact.krdBattalionUnitId }),
        ...(fact.combatUnitIds === undefined ? {} : { combatUnitIds: fact.combatUnitIds }),
        ...(shiftHex === undefined ? {} : { shiftHex }),
      }
    }
    /*
     * ch10 的西移落点：调用方给了就用它，否则用玩家**点地图**选的那个（`drawShiftHexText`）——
     * 修前两处都没有 ⇒ 剧本 1/2 的 A 组必被引擎按 `shiftWestDestinationMissing` 拒。
     */
    const shiftHexFor = (formationId: string): ReturnType<typeof parseHexOf> =>
      composed[formationId]?.shiftHex ?? parseHexOf(drawShiftHexText.value[formationId] ?? '')
    const plan = planScenarioDraw({
      scenarioId: scenarioId.value,
      group: { ...group, count: drawn.length },
      drawnFormationIds: drawn,
      facts: Object.fromEntries(
        drawn.map((formationId) => {
          const fact = composed[formationId] ?? {}
          const shiftHex = shiftHexFor(formationId)
          return [
            formationId,
            {
              ...(fact.mtrRegimentUnitId === undefined
                ? {}
                : { mtrRegimentUnitId: fact.mtrRegimentUnitId }),
              ...(fact.aufkBattalionUnitId === undefined
                ? {}
                : { aufkBattalionUnitId: fact.aufkBattalionUnitId }),
              ...(fact.krdBattalionUnitId === undefined
                ? {}
                : { krdBattalionUnitId: fact.krdBattalionUnitId }),
              ...(fact.combatUnitIds === undefined ? {} : { combatUnitIds: fact.combatUnitIds }),
              ...(shiftHex === undefined ? {} : { shiftHex }),
            },
          ]
        }),
      ),
    })
    if (!plan.ok) {
      lastAction.value = { ok: false, rule: plan.rule, detail: plan.reason, scope: '剧本抽取盒' }
      workbench.pushLog('danger', `编队抽签落盘被拒：${plan.reason}（${plan.rule}）`, plan.rule)
      return false
    }
    for (const patch of plan.data.deposits) {
      if (patch.to === 'deadPile') workbench.sendToDeadPileNow(patch.unitId)
      if (patch.mode === 'move') setUnitMoveMode(patch.unitId)
    }
    for (const patch of plan.data.returns) {
      /*
       * 用户 2026-09-18 报告第 5 条：返场落点**按数据**给 —— 用它所属编队初设行里的图上落点
       * （如 `3 Pz Div` 的 `11.03`），而不是先前那个写死的 `1.03`。
       * 推不出落点时**不猜**：如实报"需在初设里手动放置"。
       */
      const anchorHexText = anchorByUnitId.get(patch.unitId) ?? newHexForReturn() ?? undefined
      if (anchorHexText === undefined) {
        workbench.pushLog(
          'warning',
          `编队抽签：${patch.unitId} 的**返场落点**推不出来（初设行没有图上格号）⇒ 未自动返场，请在初设里手动放置`,
          group.rule,
        )
        continue
      }
      workbench.returnFromDeadPileNow({ instanceId: patch.unitId, hexText: anchorHexText })
    }
    for (const note of derivedNotes)
      workbench.pushLog('info', `编队组成（自动推）：${note}`, 'ch10')
    /*
     * ★ 用户 9.17③a：把本次抽签的**变化**记进台账（初设面板据此显示；`setup` 只读它）——
     *   修前"抽取的编队变化没自动列入初设"：落盘只改了盘面，初设那边看不见发生了什么。
     */
    formationDrawOutcomes.value = [
      ...formationDrawOutcomes.value.filter((row) => row.groupKind !== group.kind),
      {
        groupKind: group.kind,
        groupLabel: group.label,
        formationIds: [...drawn],
        detail: plan.data.detail,
        destinations: plan.data.destinations.map((item) => ({
          formationId: item.formationId,
          hexText: `${item.hex.col}.${item.hex.row}`,
        })),
      },
    ]
    lastAction.value = { ok: true, rule: plan.rule, detail: plan.data.detail, scope: '剧本抽取盒' }
    workbench.pushLog('success', plan.data.detail, '剧本页·编队抽签')
    return true
  }

  /**
   * 专规 13.7 / ch10–ch11：**B 增援段「编队抽取（轴方）」环节的入口**
   *
   * ★ 批 E 切片 2（用户 9.17③a）：修前这个 SOP 环节**没有任何 store 入口**
   *   （`ACTION_KEYS_WITHOUT_STORE_ENTRY` 里挂着 `rein.formationDraw`，「store 里 formationDraw 全仓 0 处」）——
   *   走到 B 段「编队抽取」时玩家点不动任何东西，且该步在 `sop-segments` 里标着 `implemented: false`。
   *   现在把「抽签 → 落盘 → 回写初设台账」合成一次动作，闸门照 `ACTION_GATES` 判（B 段该环节、**仅轴方**）。
   */
  function drawAndApplyStepNow(
    group: ScenarioDrawGroup,
    facts: Record<
      string,
      {
        mtrRegimentUnitId?: string
        aufkBattalionUnitId?: string
        krdBattalionUnitId?: string
        combatUnitIds?: readonly string[]
        shiftHexText?: string
      }
    > = {},
    options?: { reduced?: boolean },
  ): boolean {
    if (!workbench.requireAction('rein.formationDraw', '编队抽取')) return false
    const drawn = drawFormations(group, options?.reduced === true)
    if (drawn.length === 0) {
      lastAction.value = {
        ok: false,
        rule: group.rule,
        detail: '抽取池里没有可抽的编队（12 个入杯编队由 formations.json 推导）',
        scope: '剧本抽取盒',
      }
      return false
    }
    return applyDraw(group, facts)
  }

  /**
   * ch10 / ch11：**初设源剧本的编队抽签组**
   *
   * 池成员只挂在源剧本上（`formations.json` 的 `sources` 只标 `S1·axis` / `S3·axis` / `S5·axis`），
   * 而剧本 2 / 4 / 6 是「与 1 / 3 / 5 共用初设」⇒ 抽签必须按**初设源**取池（否则池为空、抽不出来）。
   * 口径与 `setup.ts` 的初设源解析同一处（`setupSourceOf`）。
   */
  const setupDrawGroups = computed<readonly ScenarioDrawGroup[]>(() => {
    const sourceId = setupSourceOf(scenarioId.value).source
    return scenarioDrawBoxView(sourceId).groups
  })

  /**
   * 初设时的**自动抽签**（用户 2026-10-25：「初设里的德军抽取编队放置或替换单位，
   * 应该放在初设时自动抽取后给玩家初设」）
   *
   * 规则依据：ch10「Formation Chit Draw」/ ch11「Scenario 3–6 随机化」——这两处都是**开局前**
   * 的剧本随机化（抽中的师西移 / 以 Move Mode 初设 / 与死亡堆互换），属**初设**而非 B 增援段。
   * 故抽签在「选剧本 ⇒ 自动初设落盘」之后**自动**跑一次（骰走种子化 `rng`，与 B28「随机数一律
   * 自动结算」同一口径），随后：
   *   · **不依赖玩家落点**的组（moveMode / mtrAufkSwap / deadPileKrd / deadPileAufk）⇒ 当场落盘；
   *   · **西移组**（shiftWest）⇒ 只抽不落盘：原文只给算法（沿道路西移 3 格，例 11.03 → 9.01）、道路拓扑数据未覆盖该区域 ⇒ 交给玩家在初设里给
   *     （`pendingShiftWestPlacements` ⇒ 初设 box 的一项，见 `setup.ts`）。
   *
   * 幂等：某组已抽过（`drawResults` 里有该 kind）⇒ **保留既有抽取结果**，不重抽
   * （`selectScenario` / `ensureSetupLoaded` 可能被反复调用，重抽会让盘面与已落盘的处置对不上）。
   */
  function runSetupDrawsNow(): {
    ok: boolean
    /** 本次抽了几个组 / 落盘了几个组 */
    drawnGroups: number
    appliedGroups: number
    /** 抽中、但**仍在等玩家给落点**的西移编队 */
    pendingShift: readonly string[]
    detail: string
  } {
    const groups = setupDrawGroups.value
    if (groups.length === 0) {
      return {
        ok: true,
        drawnGroups: 0,
        appliedGroups: 0,
        pendingShift: [],
        detail: `剧本 ${scenarioId.value}（初设源 ${setupSourceOf(scenarioId.value).source}）的剧本页没有编队抽签条目 ⇒ 该步不适用`,
      }
    }
    const sourceId = setupSourceOf(scenarioId.value).source
    let drawnGroups = 0
    let appliedGroups = 0
    const pendingShift: string[] = []
    /** 已按「视为有道路」自动摆位的西移师（`原格 → 落点`） */
    const placedShift: string[] = []
    const failures: string[] = []

    for (const group of groups) {
      const already = drawnOf(group)
      const drawn = already.length > 0 ? already : drawFormations(group, false, sourceId)
      if (drawn.length === 0) {
        failures.push(`${group.label}：入杯池为空（formations.json 未推导出该剧本的装甲/摩托化师）`)
        continue
      }
      drawnGroups += 1
      /*
       * 西移组：**当场算落点并摆位**（★ 用户 2026-10-25「视为那个格子有道路就行」）
       *
       * 原文只给"沿道路从所列位置西移 N 格"这个算法（例 11.03 → 9.01），所列位置**数据里有**
       * （`scenario-setup.json`）⇒ 按"视为有道路"由引擎 `shiftWestDestination` 算落点，
       * 算出即摆（玩家不必再为抽签点地图）。算不出（该师没有图上格号 / 走不到）才留进
       * `pendingShift`，由玩家在初设里补（不猜）。
       */
      if (group.kind === 'shiftWest') {
        for (const formationId of drawn) {
          const derived = deriveFactsFor(formationId)
          const anchorText = derived?.facts.anchorHexText
          const anchor = anchorText === undefined ? undefined : parseHexOf(anchorText)
          const steps = group.shiftHexes ?? 0
          if (anchor === undefined || steps <= 0) {
            pendingShift.push(formationId)
            continue
          }
          const target = shiftWestDestination(anchor, steps)
          if (
            !setDrawShiftHexNow(formationId, `${target.hex.col}.${target.hex.row}`) ||
            !applyShiftWestOneNow(formationId)
          ) {
            pendingShift.push(formationId)
            continue
          }
          placedShift.push(
            `${formationId} ${anchorText ?? '—'} → ${target.hex.col}.${String(target.hex.row).padStart(2, '0')}${target.exact ? '' : `（只走了 ${String(target.walked)} 格：西边到图边了）`}`,
          )
        }
        continue
      }
      if (applyDraw(group)) appliedGroups += 1
      else failures.push(`${group.label}：${lastAction.value?.detail ?? '落盘被拒'}`)
    }

    const detail =
      `编队抽签（ch10 / ch11，初设自动）：${drawnGroups} 组已抽` +
      `（初设源 ${sourceId}）⇒ 落盘 ${appliedGroups} 组` +
      (placedShift.length > 0
        ? `；西移组按「视为有道路」自动摆位：${placedShift.join('、')}`
        : '') +
      (pendingShift.length > 0
        ? `；西移组 ${String(pendingShift.length)} 个师**算不出落点**，待玩家给：${pendingShift.join('、')}`
        : '') +
      (failures.length > 0 ? `；未成：${failures.join('；')}` : '')
    lastAction.value = {
      ok: failures.length === 0,
      rule: groups[0]?.rule ?? 'ch10',
      detail,
      scope: '初设·编队抽取',
    }
    workbench.pushLog(failures.length === 0 ? 'success' : 'warning', detail, 'ch10 / ch11')
    return { ok: failures.length === 0, drawnGroups, appliedGroups, pendingShift, detail }
  }

  /**
   * 用户 2026-09-18 报告第 5 条：**编队组成由初设索引自动推出**（不再让玩家手输 unit id）
   *
   * `scenario-setup.json` 的编队行里，每个下属都直接带单位库 `unitId` 与落点 ⇒
   * 「哪个单位是这个师的 Mtr 团 / 死亡堆里的 Aufk 营 / Krd 营」是**可推的**（判据在引擎
   * `deriveDrawComposition`，本函数只负责取行 + 把结论折成 `DrawCompositionFacts`）。
   * `combatUnitIds`（S3 的 Move Mode）取该编队**图上**的下属，且只收**战斗单位**
   * （非战斗的 Truck / 补给不转模式；判据用操作台算子自己的 `isCombat`）。
   */
  function deriveFactsFor(formationId: string): {
    facts: {
      mtrRegimentUnitId?: string
      aufkBattalionUnitId?: string
      krdBattalionUnitId?: string
      combatUnitIds?: readonly string[]
      anchorHexText?: string
    }
    note: string
    /** 该编队**图上**的单位（盘上实例 id；初设摆位要用全部，不筛战斗单位） */
    onMapInstanceIds: readonly string[]
  } | null {
    /*
     * ★ 第六批 §6-A：初设行按**初设源**取（1–2 / 3–4 / 5–6 共用初设，`scenario-setup.json` 的
     *   `scenarioId` 只标在源剧本上）⇒ 剧本 2 / 4 / 6 原先会"组成推不出来"（rows 为空）。
     */
    const rows = scenarioSetup.entries.filter(
      (entry) => entry.scenarioId === setupSourceOf(scenarioId.value).source,
    )
    const outcome = deriveDrawComposition({ rows, formationId })
    if (!outcome.ok) {
      lastAction.value = {
        ok: false,
        rule: outcome.rule,
        detail: outcome.reason,
        scope: '剧本抽取盒',
      }
      workbench.pushLog(
        'warning',
        `编队抽签：${formationId} 的组成**推不出来**（${outcome.reason}）—— 请核对初设索引（scenario-setup.json）`,
        outcome.rule,
      )
      return null
    }
    const data = outcome.data
    /*
     * ★ 库 id → **盘上实例 id**：初设落盘时每枚算子拿的是 `createId('u')` 生成的实例 id
     *   （`setup.ts`），而初设索引里记的是**单位库 id**（`ax-…`）。抽签的补丁（进/出死亡堆、
     *   转 Move Mode）走的都是**盘上实例 id** ⇒ 这里必须翻译一次；翻译不到的（该剧本没有摆上它）
     *   就如实剔掉，并写进 note（不猜、也不静默）。
     */
    const boardIdOf = (libraryId: string): string | null => {
      const onMap = workbench.units.find((unit) => unit.unitId === libraryId)
      if (onMap !== undefined) return onMap.instanceId
      // 死亡堆是**地面与空军共用**的（用户裁定）⇒ 只按地面条目比 `unitId`
      const dead = workbench.deadPile.find(
        (entry) => !isAirDeadPileEntry(entry) && entry.unitId === libraryId,
      )
      return dead === undefined ? null : dead.instanceId
    }
    const missing: string[] = []
    const translate = (libraryId: string | null): string | undefined => {
      if (libraryId === null) return undefined
      const boardId = boardIdOf(libraryId)
      if (boardId === null) missing.push(libraryId)
      return boardId ?? undefined
    }
    const mtrRegimentUnitId = translate(data.mtrRegimentUnitId)
    const aufkBattalionUnitId = translate(data.aufkBattalionUnitId)
    const krdBattalionUnitId = translate(data.krdBattalionUnitId)
    /** 该编队**图上**的单位（盘上实例 id；西移摆位要用全部，不筛战斗单位） */
    const onMapInstanceIds = data.onMapUnitIds
      .map((libraryId) => boardIdOf(libraryId))
      .filter((unitId): unitId is string => unitId !== null)
    const combatUnitIds = onMapInstanceIds.filter(
      (unitId) => workbench.units.find((unit) => unit.instanceId === unitId)?.isCombat === true,
    )
    return {
      facts: {
        ...(mtrRegimentUnitId === undefined ? {} : { mtrRegimentUnitId }),
        ...(aufkBattalionUnitId === undefined ? {} : { aufkBattalionUnitId }),
        ...(krdBattalionUnitId === undefined ? {} : { krdBattalionUnitId }),
        ...(combatUnitIds.length === 0 ? {} : { combatUnitIds }),
        // ch10 的西移落点：原文只给算法（沿道路西移 3 格，例 11.03 → 9.01）、道路拓扑数据未覆盖该区域 ⇒ 仍由玩家点地图给出（本函数不猜）
        ...(data.anchorHex === null
          ? {}
          : { anchorHexText: `${data.anchorHex.col}.${data.anchorHex.row}` }),
      },
      note:
        missing.length === 0
          ? data.note
          : `${data.note}；⚠ ${String(missing.length)} 枚未在盘上（${missing.join('、')}）⇒ 未纳入`,
      onMapInstanceIds,
    }
  }

  /**
   * I② 切片 2（用户 2026-09-18 报告第 5 条后半）：
   * **待玩家在初设里摆位**的编队抽取条目（ch10 的西移组）
   *
   * 「**应该调整位置的编队应该放入初设里让玩家设置位置**」⇒ B 段抽中"沿道路西移"的那些师，
   * 落点由玩家在**初设**里逐条给 `列.行`；给完就照此把该师**图上**的单位摆过去。
   * 落点存的是**同一份** `drawShiftHexText`（与"点地图选西移落点"共用）⇒ 两条入口不会各存一份。
   */
  const pendingShiftWestPlacements = computed<
    readonly {
      formationId: string
      /** 玩家给的落点（`列.行`；未给为 null） */
      hexText: string | null
      /** 该编队**图上**的单位（盘上实例 id） */
      unitIds: readonly string[]
      /** 该编队初设行的图上格号（给落点时的参照） */
      fromHexText: string | null
      /** 该组要求西移的格数（`shiftHexes`；ch10 写 3） */
      shiftHexes: number
    }[]
  >(() => {
    /*
     * ★ 数据源是**抽签结果**（不是"已落盘台账"）：西移组的落点必须**先给、后落盘**
     *   （引擎的 `planScenarioDraw` 缺落点就按 `shiftWestDestinationMissing` 拒）⇒
     *   若读台账，这个清单永远是空的（先有鸡还是先有蛋）。
     */
    const record = drawResults.value[scenarioId.value]?.find((item) => item.kind === 'shiftWest')
    if (record === undefined) return []
    const group = scenarioDrawBox.value?.groups.find((item) => item.kind === 'shiftWest')
    const shiftHexes = group?.shiftHexes ?? 0
    return record.formationIds.map((formationId) => {
      const derived = deriveFactsFor(formationId)
      return {
        formationId,
        hexText: drawShiftHexText.value[formationId] ?? null,
        unitIds: derived?.onMapInstanceIds ?? [],
        fromHexText: derived?.facts.anchorHexText ?? null,
        shiftHexes,
      }
    })
  })

  /** 玩家在初设里给某个西移编队写落点（`列.行`；格式非法即拒） */
  function setDrawShiftHexNow(formationId: string, hexText: string): boolean {
    if (parseHexOf(hexText) === undefined) {
      lastAction.value = {
        ok: false,
        rule: 'ch10',
        detail: `落点“${hexText}”不是“列.行”格式`,
        scope: '初设·编队抽取摆位',
      }
      return false
    }
    drawShiftHexText.value = { ...drawShiftHexText.value, [formationId]: hexText }
    lastAction.value = {
      ok: true,
      rule: 'ch10',
      detail: `${formationId} 的西移落点记为 ${hexText}`,
      scope: '初设·编队抽取摆位',
    }
    return true
  }

  /**
   * 照玩家给定的落点把西移编队的**图上单位**摆过去（初设里点「照此摆位」）
   *
   * 缺任一落点即**整笔拒绝**（用户口径的"不猜"）；落点与原初设格的**列差**若与 ch10 的
   * 「西移 N 格」不符，只**如实记一行提示**（原文只给算法（沿道路从所列位置西移 3 格，例 11.03 → 9.01）、道路拓扑数据未覆盖该区域，引擎不替它判对错）。
   */
  function applyShiftWestPlacementsNow(): boolean {
    const pending = pendingShiftWestPlacements.value
    if (pending.length === 0) {
      lastAction.value = {
        ok: false,
        rule: 'ch10',
        detail: '没有待摆位的编队（抽签在选剧本时已自动执行；本剧本可能没有西移组）',
        scope: '初设·编队抽取摆位',
      }
      return false
    }
    const missing = pending.filter((item) => item.hexText === null)
    if (missing.length > 0) {
      lastAction.value = {
        ok: false,
        rule: 'ch10',
        detail: `还缺 ${String(missing.length)} 个落点：${missing.map((item) => item.formationId).join('、')}`,
        scope: '初设·编队抽取摆位',
      }
      workbench.pushLog(
        'warning',
        `编队抽取摆位：缺落点（${missing.map((item) => item.formationId).join('、')}）⇒ 本次不改动任何算子`,
        'ch10',
      )
      return false
    }
    let moved = 0
    const notes: string[] = []
    for (const item of pending) {
      const placed = placeShiftWestItem(item)
      if (placed === null) continue
      moved += placed.moved
      if (placed.note !== null) notes.push(placed.note)
    }
    /*
     * 台账**补记/更新**西移组的落点（初设面板读它即可显示"抽中谁、摆到哪"）——
     * 走的是"先给落点、再落盘"的顺序，故这里可能是**第一次**写下该组（用 upsert，不假设已有行）。
     */
    noteShiftWestDestinations(
      pending.map((item) => ({ formationId: item.formationId, hexText: item.hexText! })),
    )
    lastAction.value = {
      ok: true,
      rule: 'ch10',
      detail: `照落点摆位：${String(pending.length)} 个师、${String(moved)} 枚算子`,
      scope: '初设·编队抽取摆位',
    }
    workbench.pushLog(
      'success',
      `编队抽取摆位（ch10）：${pending.map((item) => `${item.formationId} → ${item.hexText!}`).join('、')}；共 ${String(moved)} 枚`,
      'ch10',
    )
    for (const note of notes) workbench.pushLog('info', `编队抽取摆位提示：${note}`, 'ch10')
    return true
  }

  /**
   * 把**一个**西移编队按已记的落点摆过去（整笔与单条共用这一段）
   *
   * 落点与原初设格的**列差**若与 ch10 的「西移 N 格」不符，只**如实记一行提示**
   * （原文只给算法（沿道路从所列位置西移 3 格，例 11.03 → 9.01）、道路拓扑数据未覆盖该区域，引擎不替它判对错）。
   */
  function placeShiftWestItem(item: {
    formationId: string
    hexText: string | null
    unitIds: readonly string[]
    fromHexText: string | null
    shiftHexes: number
  }): { moved: number; note: string | null } | null {
    if (item.hexText === null) return null
    const hex = parseHexOf(item.hexText)
    if (hex === undefined) return null
    let moved = 0
    for (const instanceId of item.unitIds) {
      const unit = workbench.units.find((entry) => entry.instanceId === instanceId)
      if (unit === undefined) continue
      unit.hex = { ...hex }
      moved += 1
    }
    const from = item.fromHexText === null ? undefined : parseHexOf(item.fromHexText)
    const note =
      from !== undefined && from.col - hex.col !== item.shiftHexes
        ? `${item.formationId}：${item.fromHexText ?? '—'} → ${item.hexText} 的列差 ${String(from.col - hex.col)} ≠ ch10 的西移 ${String(item.shiftHexes)} 格（与剧本卡不符就改一下落点）`
        : null
    return { moved, note }
  }

  /** 台账 upsert：西移组的落点（同编队覆盖、其余保留 ⇒ 单条摆位不会抹掉已摆的） */
  function noteShiftWestDestinations(
    destinations: readonly { formationId: string; hexText: string }[],
  ): void {
    const existing = formationDrawOutcomes.value.find((row) => row.groupKind === 'shiftWest')
    if (existing === undefined) {
      formationDrawOutcomes.value = [
        ...formationDrawOutcomes.value,
        {
          groupKind: 'shiftWest',
          groupLabel:
            setupDrawGroups.value.find((group) => group.kind === 'shiftWest')?.label ??
            'A 组：沿道路西移',
          formationIds: pendingShiftWestPlacements.value.map((item) => item.formationId),
          detail: `沿道路西移 ${String(pendingShiftWestPlacements.value[0]?.shiftHexes ?? 0)} 格（落点由玩家在初设里给定）`,
          destinations: destinations.map((item) => ({ ...item })),
        },
      ]
      return
    }
    const merged = existing.destinations.map((item) => ({ ...item }))
    for (const entry of destinations) {
      const at = merged.findIndex((item) => item.formationId === entry.formationId)
      if (at === -1) merged.push({ ...entry })
      else merged[at] = { ...entry }
    }
    formationDrawOutcomes.value = formationDrawOutcomes.value.map((row) =>
      row.groupKind === 'shiftWest' ? { ...row, destinations: merged } : row,
    )
  }

  /**
   * 第六批 §6-A：**单条**西移摆位（初设 box 里点一格即用这个）
   *
   * 先记落点（ch10 的落点：原文只给算法（沿道路西移 3 格，例 11.03 → 9.01）、道路拓扑数据未覆盖该区域 ⇒ 只能由玩家给），再按它摆位并 upsert 台账。
   * 修前只有「整笔」入口（缺任一落点即整笔拒绝）⇒ 玩家在初设里给一个落点也摆不了一个师。
   */
  function applyShiftWestAtNow(formationId: string, hexText: string): boolean {
    if (!setDrawShiftHexNow(formationId, hexText)) return false
    return applyShiftWestOneNow(formationId)
  }

  /** 单条：按**已记**的落点摆位（落点缺失 / 不在待摆名单里即拒，不猜） */
  function applyShiftWestOneNow(formationId: string): boolean {
    const item = pendingShiftWestPlacements.value.find((entry) => entry.formationId === formationId)
    if (item === undefined) {
      lastAction.value = {
        ok: false,
        rule: 'ch10',
        detail: `${formationId} 不在待摆位名单里（本组没抽中它）`,
        scope: '初设·编队抽取摆位',
      }
      return false
    }
    if (item.hexText === null) {
      lastAction.value = {
        ok: false,
        rule: 'ch10',
        detail: `${formationId} 还没给西移落点`,
        scope: '初设·编队抽取摆位',
      }
      return false
    }
    const placed = placeShiftWestItem(item)
    if (placed === null) {
      lastAction.value = {
        ok: false,
        rule: 'ch10',
        detail: `${formationId} 的落点“${item.hexText}”不是“列.行”格式`,
        scope: '初设·编队抽取摆位',
      }
      return false
    }
    noteShiftWestDestinations([{ formationId, hexText: item.hexText }])
    lastAction.value = {
      ok: true,
      rule: 'ch10',
      detail: `${formationId} → ${item.hexText}：${String(placed.moved)} 枚算子`,
      scope: '初设·编队抽取摆位',
    }
    workbench.pushLog(
      'success',
      `编队抽取摆位（ch10）：${formationId} → ${item.hexText}；共 ${String(placed.moved)} 枚`,
      'ch10',
    )
    if (placed.note !== null) workbench.pushLog('info', `编队抽取摆位提示：${placed.note}`, 'ch10')
    return true
  }

  /** `列.行` → 对象坐标（非法即 undefined） */
  function parseHexOf(text: string): { col: number; row: number } | undefined {
    const match = text.trim().match(/^(\d+)\s*[.,]\s*(\d+)$/)
    if (match === null) return undefined
    return { col: Number(match[1]), row: Number(match[2]) }
  }

  /** 5.4 / 剧本初设：把单位换成 Move Mode（S3/S4 的 A 组处置；初设期由剧本直接指定，不走 5.4 的移动阶段校验） */
  function setUnitMoveMode(instanceId: string): void {
    const unit = workbench.units.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return
    unit.mode = applyModeSwitch(unit.mode, 'move', 'move')
    unit.raw = unit.faces[unit.mode.orientation]
    workbench.pushLog('info', `${unit.name} → Move Mode（剧本 Move-Mode 抽签）`, '5.4')
  }

  /* ────────────────────────────── 地图外空军盒（1.4a） ────────────────────────────── */

  /** 1.4a：盒内免费整备（Inactive → Active） */
  function activateAirBox(side: Side): boolean {
    const inBox = workbench.airUnits.filter(
      (air) => air.side === side && workbench.airBoxMembers.includes(air.instanceId),
    )
    const plan = planAirBoxActivate({ side, aircraft: inBox.map(toBoxAirUnit) })
    if (!plan.ok) {
      lastAction.value = { ok: false, rule: plan.rule, detail: plan.reason, scope: '地图外空军盒' }
      return false
    }
    for (const id of plan.data.activations) {
      const air = workbench.airUnits.find((item) => item.instanceId === id)
      if (air !== undefined) air.airStatus = 'active'
    }
    lastAction.value = {
      ok: true,
      rule: plan.rule,
      detail: plan.data.detail,
      scope: '地图外空军盒',
    }
    workbench.pushLog('info', plan.data.detail, plan.rule)
    return true
  }

  /** 1.4a：把飞机移入 / 移出地图外空军盒 */
  /**
   * 1.4a：飞机进出**地图外空军盒**
   *
   * ★ 修（2026-10-30）：修前只改盒成员、再打一句"（航程 20/30 格）"——**没有任何裁断**，
   *   等于免费瞬移，而且文案还假装费用已扣。原文给的是固定航程代价：
   *   苏方 Red Air Force Box ↔ 62.xx 行 = 20 格；轴方 Luftwaffe Box ↔ 01.xx 行 = 30 格
   *   ⇒ 印刷射程不足这个数就飞不进去（数据里的真实反例：`Ru I.153` 射程 15）。
   *   现在先按机型射程裁断，再改成员；不满足即拒并给规则号。
   */
  function setAirInBox(instanceId: string, inBox: boolean): boolean {
    const air = workbench.airUnits.find((item) => item.instanceId === instanceId)
    if (air === undefined) {
      lastAction.value = {
        ok: false,
        rule: '1.4a',
        detail: `图上找不到飞机 ${instanceId}`,
        scope: '地图外空军盒',
      }
      return false
    }
    const flight = planOffMapAirBoxFlight({ side: air.side, rangeHexes: air.rangeHexes })
    if (!flight.ok) {
      lastAction.value = {
        ok: false,
        rule: flight.rule,
        detail: flight.reason,
        scope: '地图外空军盒',
      }
      workbench.pushLog(
        'danger',
        `${air.name} ${inBox ? '飞入' : '飞出'}地图外空军盒被拒：${flight.reason}（专规 1.4a）`,
        flight.rule,
      )
      return false
    }
    workbench.setAirInBoxMembership(instanceId, inBox)
    lastAction.value = {
      ok: true,
      rule: '1.4a',
      detail: `${air.name} ${inBox ? '进入' : '离开'}地图外空军盒（1.4a：往返航程 ${flight.data.rangeCost} 格；盒内免费整备）`,
      scope: '地图外空军盒',
    }
    workbench.pushLog('info', lastAction.value.detail, '1.4a')
    return true
  }

  /* ────────────────────────────── 边缘盒（1.4b） ────────────────────────────── */

  /** 1.4b：把苏方地面单位移入 / 移出边缘盒（仅移动阶段、须在边缘补给源格） */
  function moveEdgeBox(input: {
    box: EdgeBoxId
    instanceId: string
    direction: 'enter' | 'exit'
    fromSupplySourceHex: boolean
    useRailCap?: boolean
  }): boolean {
    // 单位可能在图上（进入时）或在盒内（离开时）；两处都查
    const unit =
      workbench.units.find((item) => item.instanceId === input.instanceId) ??
      edgeBoxHeld.value[input.box].find((item) => item.instanceId === input.instanceId)
    if (unit === undefined) {
      lastAction.value = {
        ok: false,
        rule: '1.4b',
        detail: '单位既不在图上也不在这个边缘盒内',
        scope: '边缘盒',
      }
      return false
    }
    const plan = planEdgeBoxMove({
      side: unit.side,
      phase: workbench.phase,
      unitKind: 'ground',
      fromSupplySourceHex: input.fromSupplySourceHex,
      direction: input.direction,
      ...(input.useRailCap === undefined ? {} : { useRailCap: input.useRailCap }),
    })
    if (!plan.ok) {
      lastAction.value = { ok: false, rule: plan.rule, detail: plan.reason, scope: '边缘盒' }
      workbench.pushLog('danger', `边缘盒进出被拒：${plan.reason}（${plan.rule}）`, plan.rule)
      return false
    }
    const current = edgeBoxHeld.value[input.box]
    if (input.direction === 'enter') {
      const index = workbench.units.findIndex((item) => item.instanceId === input.instanceId)
      if (index < 0) {
        lastAction.value = { ok: false, rule: '1.4b', detail: '单位不在图上', scope: '边缘盒' }
        return false
      }
      const [moved] = workbench.units.splice(index, 1)
      if (moved === undefined) return false
      edgeBoxHeld.value = { ...edgeBoxHeld.value, [input.box]: [...current, moved] }
    } else {
      const held = current.find((item) => item.instanceId === input.instanceId)
      if (held === undefined) {
        lastAction.value = {
          ok: false,
          rule: '1.4b',
          detail: '该单位不在这个边缘盒内',
          scope: '边缘盒',
        }
        return false
      }
      edgeBoxHeld.value = {
        ...edgeBoxHeld.value,
        [input.box]: current.filter((item) => item.instanceId !== input.instanceId),
      }
      // 1.4b：从**地图边缘补给源格**重新入场（沿用进入时所在的格），离箱免费供油
      held.movementEnded = true
      workbench.units = [...workbench.units, held]
    }
    lastAction.value = { ok: true, rule: plan.rule, detail: plan.data.detail, scope: '边缘盒' }
    workbench.pushLog('info', `${unit.name} ${plan.data.detail}`, plan.rule)
    return true
  }

  /* ────────────────────────────── 编队收纳盒（13.7 / 3.6f） ────────────────────────────── */

  /** 13.7：把编队下属收纳进盒（图上只留标记，构成迷雾） */
  function hideInFormationBox(input: {
    formationId: string
    side: Side
    memberIds: readonly string[]
    onMapIds: readonly string[]
    markerHexText: string
    hideUnitIds: readonly string[]
  }): boolean {
    const markerHex = parseHexOf(input.markerHexText)
    if (markerHex === undefined) {
      lastAction.value = {
        ok: false,
        rule: '13.7',
        detail: '标记格格式应为「列.行」',
        scope: '编队收纳盒',
      }
      return false
    }
    const remaining = input.onMapIds
      .filter((id) => !input.hideUnitIds.includes(id))
      .map((id) => {
        const unit = workbench.units.find((item) => item.instanceId === id)
        return { unitId: id, hex: unit?.hex ?? { col: -1, row: -1 } }
      })
    const plan = planFormationBoxHide({
      formationId: input.formationId,
      markerHex,
      remainingOnMap: remaining,
      hideUnitIds: [...input.hideUnitIds],
    })
    if (!plan.ok) {
      lastAction.value = { ok: false, rule: plan.rule, detail: plan.reason, scope: '编队收纳盒' }
      workbench.pushLog('danger', `编队收纳被拒：${plan.reason}（${plan.rule}）`, plan.rule)
      return false
    }
    formationBoxes.value = {
      ...formationBoxes.value,
      [input.formationId]: {
        side: input.side,
        memberIds: [...input.memberIds],
        onMapIds: remaining.map((item) => item.unitId),
      },
    }
    lastAction.value = { ok: true, rule: plan.rule, detail: plan.data.detail, scope: '编队收纳盒' }
    workbench.pushLog('info', plan.data.detail, plan.rule)
    return true
  }

  /** 13.7：把盒内单位放回图上 */
  function revealFromFormationBox(formationId: string, releaseUnitIds: readonly string[]): boolean {
    const plan = planFormationBoxReveal({ formationId, releaseUnitIds })
    if (!plan.ok) {
      lastAction.value = { ok: false, rule: plan.rule, detail: plan.reason, scope: '编队收纳盒' }
      return false
    }
    const box = formationBoxes.value[formationId]
    if (box !== undefined) {
      formationBoxes.value = {
        ...formationBoxes.value,
        [formationId]: {
          ...box,
          onMapIds: [...new Set([...box.onMapIds, ...releaseUnitIds])],
        },
      }
    }
    lastAction.value = { ok: true, rule: plan.rule, detail: plan.data.detail, scope: '编队收纳盒' }
    workbench.pushLog('info', plan.data.detail, plan.rule)
    return true
  }

  /* ────────────────────────────── 剧本与重置 ────────────────────────────── */

  /**
   * 换剧本（重置抽签结果与标记账本）
   *
   * ★ 联调：剧本号写在**会话 store**（唯一权威）；被会话锁定（已开局）即整体拒绝，
   * 不做「剧本号没变、天气标记却按新剧本改」的半更新。
   */
  function setScenario(next: string): boolean {
    const found = scenarios.scenarios.find((scenario) => scenario.id === next)
    if (found === undefined) return false
    if (!session.setScenarioId(next)) return false
    weatherMarker.value = found.firstWeather === 'restricted' ? 'limited' : 'normal'
    lastAction.value = null
    return true
  }

  /** 重置本 store 的全部账本（不动操作台盘面） */
  function resetContainers(): void {
    markerTurn.value = 1
    weatherMarker.value = initialWeatherAir()
    railCapacityLedger.value = {
      axis: markers.railCap.initial.axis,
      soviet: markers.railCap.initial.soviet,
    }
    workbench.clearAirBoxMembers()
    edgeBoxHeld.value = { northeast: [], southeast: [] }
    formationBoxes.value = {}
    drawResults.value = {}
    lastAction.value = null
  }

  return {
    // 账本
    scenarioId,
    markerTurn,
    weatherMarker,
    railCapacityLedger,
    airBoxMembers,
    edgeBoxHeld,
    formationBoxes,
    drawResults,
    // 批 E 切片 2：抽签的西移落点（点地图写回）与"落盘后的变化"台账（`setup` 只读它回写初设）
    drawShiftHexText,
    drawShiftHexOf,
    drawCompositionNoteOf,
    pendingShiftWestPlacements,
    setDrawShiftHexNow,
    applyShiftWestPlacementsNow,
    // 第六批 §6-A：初设自动抽签 + 单条西移摆位（初设 box 里点一格即摆一个师）
    setupDrawGroups,
    runSetupDrawsNow,
    applyShiftWestAtNow,
    applyShiftWestOneNow,
    beginDrawShiftHexPickNow,
    formationDrawOutcomes,
    alarmUnitIds,
    effectiveAlarmUnitIds,
    alarmQuotas,
    alarmInPlay,
    alarmMix,
    alarmMixRule,
    lastAction,
    // 记录轨
    turn,
    weather,
    railCapacity,
    date,
    turnTrack,
    weatherTrack,
    railCapTrack,
    advanceTurnMarker,
    setWeatherMarker,
    setRailCapacity,
    applyRailCapacityForDate,
    // 容器
    // B12：辅助卡卡面（分区 + 区内容物）
    sharedCardViews,
    railCapCell,
    cardViews,
    cardViewsOf,
    openCardBoxKinds,
    openCardName,
    popupCardId,
    setPopupCard,
    cardOpenId,
    toggleCardOpen,
    boxes,
    boxOf,
    boxById,
    deadPileUnits,
    breakdownUnits,
    breakdownOnMap,
    breakdownLedger,
    aircraftInBox,
    edgeBoxUnits,
    scenarioDrawBox,
    // 操作
    drawSpecialRepl,
    takeBreakdown,
    drawFormations,
    drawnOf,
    applyDraw,
    // 批 E 切片 2：B 增援段「编队抽取（轴方）」的**唯一入口**（抽签 → 落盘 → 回写初设台账）
    drawAndApplyStepNow,
    activateAirBox,
    setAirInBox,
    moveEdgeBox,
    hideInFormationBox,
    revealFromFormationBox,
    setScenario,
    resetContainers,
    // 供面板复用的纯工具
    parseHexOf,
  }
})
