import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { aircraft, scenarios, unitsAxis, unitsSoviet } from '@/data'
import type { HexRef, Side } from '@/data'
import {
  AIR_BASE_SITE_RULE,
  boundarySideOf,
  breakdownCounterValues,
  SETUP_RULE,
  findAircraftRecord,
  findUnitRecord,
  parseSetupHexText,
  planAirSetup,
  planAutoSetup,
  planSetupPlacement,
  planSupplyOwnership,
  planTruckFullLoad,
  requiresPanzerGroupSpAssignment,
  // B50（用户 2026-09-17）：3.4b 是 4.1a 的**可选项** ⇒ 初设的点名要求与默认归属都看共识
  panzerGroupRulesActive,
  PANZER_GROUP_OPTION_ITEM,
  SP_TO_T,
  setupEntryViews,
  setupCandidates,
  setupFlowFor,
  setupAirbaseLevelOf,
  setupHexLabel,
  setupSourceOf,
  setupTransportKindOf,
  type AirSetupPlan,
  type SetupCandidateFacts,
  type SetupEntryView,
  type SetupFlowStep,
  type SetupPanzerGroup,
  type SetupPlan,
  type SupplyDumpRef,
} from '@/engine/rules'
import { hexesWithin, isOnMap } from '@/engine/hex-geometry'
import { createId } from '@/shared'

import { useContainersStore } from './containers'
import { useGameSessionStore } from './session'
import { useWorkbenchStore } from './workbench'
import {
  counterImageUrlOf,
  isHqUnit,
  toConsoleAirUnit,
  toConsoleUnit,
  type ConsoleUnit,
} from './workbench-model'

/**
 * 初设与开局流程（W7 C14）的操作台
 *
 * ## 分工（与其它 store 的边界）
 *   · **引擎**（`engine/rules/setup.ts`）按剧本页清单判规则、出计划（自动落位 / 自由项 / 计数账本），
 *     不写状态、不掷骰；
 *   · **本 store** 持开局流程的进度与玩家输入（自由项落位、卡车满载名单、SP 装甲集群归属），
 *     把引擎计划**落到盘面**（调用操作台既有动作），并把结论写进操作台日志；
 *   · **操作台**（`workbench.ts`）才拥有算子本体（图上的 `units` / `deadPile` / `airUnits`）。
 *
 * ## 开局顺序（数据驱动，见 `setupFlowFor`）
 *   剧本选择 → 编制抽取（在 C12 的剧本抽取盒里抽） → 卡车满载指定 → SP 归属划分 →
 *   **自动初设**（把剧本页里已定格的战斗单位与非战斗单位逐条摆好） →
 *   飞机初设（位置 + 激活态 + `*` 减损） → 玩家自定义初设（`w/i X` / 任一指挥部 / 任意空军基地）。
 *
 * ## 盘面事实（引擎不持盘面，一律由本层注入）
 *   · `hqHexes`：本方 HQ 格（`Stacked with any … HQs` 的候选）；
 *   · `airBaseHexes`：本方空军基地格（14.1a：飞机与基地同格）；
 *   · 超堆叠与可进入性：暂按「在图上」处理（IV-F / IV-I 的完整判定要等 4.8 的 RE 与地形 TEC 接入，
 *     故本层只注入地图存在性；未接的部分如实不在日志里声称已校验）。
 */

/** 单条自由项的落位输入（entryIndex → 目标格文本） */
export type SetupChoiceInput = Record<number, string>

/**
 * 剧本选择项（B10 前置视图的一行）
 *
 * 全部字段**照抄** `scenarios.json`（不解释、不改写）；`selected` 是唯一的投影字段。
 */
export interface ScenarioChoice {
  id: string
  name: string
  /** 本剧本的回合数（回合轨上的跨度） */
  turns: number
  /** 首回合日期（原文写法，如 `8 Jul 41`） */
  firstTurn: string
  /** 末回合日期 */
  lastTurn: string
  /** 首回合先手（2.3：首回合由剧本指定，不掷骰） */
  firstPlayer: Side
  /** 与哪个剧本共用初设（空数组＝本剧本自带初设页） */
  sharedSetupWith: readonly string[]
  /** 本剧本页是否自带初设 */
  hasSetup: boolean
  /** 是否就是当前选中的剧本 */
  selected: boolean
}

/**
 * 「初设单位 box」里的分类（用户口径：飞机一类、SP/运输点一类、地面战斗单位与基地一类）
 */
export type SetupPlacingCategory = 'air' | 'supply' | 'ground'

/**
 * 初设里**待在地图上落位**的一项
 *
 * 四类：`self` = 剧本页只给了条件（`w/i N` / 任一指挥部）的地面项；`air` = 某一型飞机
 * （候选＝本方空军基地格）；`truck` = 需指定**满载 / 空载**的编内卡车（13.2h，不在图上落位，
 * 故 `candidates` 为空）；`shift` = ch10 抽中西移的那个师（落点按原文算法（沿道路西移 3 格）得出，道路数据不全 ⇒ 由玩家点地图给，
 * 候选＝原格 N 格半径内的图上格）。
 * 候选格一律来自引擎，故界面高亮的格一定合法。
 */
export interface SetupPlacing {
  kind: 'self' | 'air' | 'truck' | 'shift'
  entryIndex: number
  /**
   * ch10 西移项的**编队 id**（`kind === 'shift'` 时有值；该组抽中的师）
   *
   * ★ 为什么不用 `entryIndex`：西移的不是「剧本页某条初设项」，而是**抽签抽中的一个师**
   * （初设清单里没有这一条 ⇒ 没有 entryIndex 可指）。
   */
  formationId?: string
  /** 卡车的实例 id（`kind === 'truck'` 时有值） */
  instanceId?: string
  side: Side
  label: string
  /** 原文（自选格项用剧本页原文，飞机用机型 id） */
  raw: string
  /** 该条目的总枚数（**数量角标的分母**） */
  count: number
  /** 本项要落几枚（棋子类＝`count`，计数类与编队＝一次落完故为 1） */
  total: number
  /** 已落几枚（B11：同型多枚可**分放不同格** ⇒ 逐枚落位） */
  placed: number
  /** 还差几枚（`total - placed`；递减到 0 才关卡片） */
  remaining: number
  /**
   * 第六批条 26（S4）：**本次点地图要落多少**（仅 SP / 运输点有意义）
   *
   * · 计数类条目可分多次落在不同格 ⇒ 每次由玩家指定「这一下放几」（默认＝剩余量，即一次点完）；
   * · 棋子 / 飞机类恒为 1（一枚一枚落），此字段仅作信息。
   */
  chunk: number
  candidates: readonly HexRef[]
  /** 初设 box 的分类（仅用于分组显示） */
  category: SetupPlacingCategory
  /**
   * 第六批条 1（S1）：该项的**算子图档**（正面；无图即 null ⇒ 界面退回文字卡）
   *
   * 用户口径：初设队列要"**算子图阵列**"，不再是逐行文字（同名同图的一长串列表认不出谁是谁）。
   * 图档一律取自**数据**（单位库 / 飞机库 / 标记库）的 `images.front`，与地图渲染同一份来源；
   * 本 store 只做"这一项对应哪张图"的投影，不复制第二份图档表。
   */
  imageUrl: string | null
  /**
   * 该格/该型此刻**不能落位的原因**（null = 可以）
   *
   * 例：飞机条目在本方还没有空军基地时无处可放 ⇒ 提示"先落空军基地（14.1a）"，
   * 而不是让玩家点了一个没有候选的卡片、再看到一个"调用方未提供 airBaseHexes"的引擎缺口。
   */
  blockedReason: string | null
}

/** 条目类别 → 初设 box 分类（飞机 / SP 与运输点 / 地面与基地） */
function categoryOfEntry(kind: string): SetupPlacingCategory {
  if (kind === 'aircraft') return 'air'
  if (kind === 'sp' || kind === 'transport_point') return 'supply'
  return 'ground'
}

/**
 * 第六批条 1（S1）：**单位库记录 → 算子正面图档**
 *
 * 只用**数据**里已有的 `images.front`（与 `render/token-images` 同源），不另建图档表；
 * 查不到即 `null`（界面退回文字卡），绝不猜一个文件名。
 */
function imageUrlOfRecordId(unitId: string | null | undefined): string | null {
  if (unitId === null || unitId === undefined || unitId === '') return null
  const hit = [...unitsAxis.units, ...unitsSoviet.units].find((record) => record.id === unitId)
  return hit?.images?.front ?? null
}

/** 飞机库记录 → 算子正面图档（`air` 项用机型 id） */
function imageUrlOfAircraftId(aircraftId: string | null | undefined): string | null {
  if (aircraftId === null || aircraftId === undefined || aircraftId === '') return null
  const hit = aircraft.aircraft.find((record) => record.aircraftId === aircraftId)
  return hit?.images?.front ?? null
}

/** 决策队列的一堆叠（用户口径：地面 / 非战斗 / 飞机 / 卡车各一堆） */
export interface DecisionStack {
  key: SetupPlacingCategory | 'truck'
  label: string
  /** 这堆里**还剩多少枚**（数量角标之和；卡车按辆计） */
  count: number
  /** 这堆里的卡片（每项一张） */
  items: readonly SetupPlacing[]
}

/** 卡车装载决定（13.2h：编内卡车只有剧本页明示才满载） */
export interface TruckDecision {
  instanceId: string
  unitId: string
  name: string
  /** 当前是否标为满载（满载＝载 1 SP） */
  full: boolean
  /** 剧本要求的满载辆数（null = 本剧本无此项） */
  requiredFull: number | null
}

export const useSetupStore = defineStore('setup', () => {
  const workbench = useWorkbenchStore()
  const containers = useContainersStore()
  const game = useGameSessionStore()

  /* ────────────────────────────── 状态（本 store 的账本） ────────────────────────────── */

  /**
   * 当前剧本（开局流程第一步）
   *
   * ★ 联调（**单一权威**）：剧本号的唯一权威是**会话 store**（`session.scenarioId`，未开局也存在）；
   * 本处只做投影 ⇒ 换剧本 / 读档后本面板、操作台、容器抽取盒同时跟随，不可能各存一份。
   */
  const scenarioId = computed<string>(() => game.scenarioId)

  /** 自动初设是否已落盘 */
  const applied = ref(false)

  /** 玩家自定义初设的落位选择：条目下标 → 格号文本 */
  const selfChoices = ref<SetupChoiceInput>({})

  /** 卡车满载指定（建制内卡车的实例 id） */
  const truckFullIds = ref<string[]>([])

  /** SP 装甲集群归属：dumpId → 集群（Setup Note F） */
  const spAssignments = ref<Record<string, SetupPanzerGroup>>({})

  /** SP dump 台账（自动初设落盘时从账本生成） */
  const spDumps = ref<SupplyDumpRef[]>([])

  /** 飞机落位：条目下标 → 基地格文本（14.1a） */
  const airChoices = ref<SetupChoiceInput>({})

  /** 各步骤是否已完成（开局流程进度） */
  const completed = ref<Record<string, boolean>>({})

  /** 最近一次动作结论（失败如实显示原因码） */
  const lastAction = ref<{ ok: boolean; rule: string; detail: string } | null>(null)

  /** 落盘时的数据缺口与提示（如实带出，不静默） */
  const notes = ref<string[]>([])

  /* ────────────────────────────── 派生（引擎结论） ────────────────────────────── */

  /** 初设条目视图（当前剧本；含初设源解析） */
  const entries = computed<readonly SetupEntryView[]>(() => setupEntryViews(scenarioId.value))

  /** 开盘流程步骤清单（哪一步适用本剧本，由引擎给） */
  const flow = computed<readonly SetupFlowStep[]>(() => setupFlowFor(scenarioId.value))

  /** 本方 HQ 格（4.8b D 的「指挥部」同义；由盘面推出） */
  function hqHexesOf(side: Side): HexRef[] {
    return workbench.units
      .filter((unit) => unit.side === side && isHqUnit(unit))
      .map((unit) => unit.hex)
  }

  /** 本方空军基地格（14.1a） */
  function airBaseHexesOf(side: Side): HexRef[] {
    return workbench.units
      .filter((unit) => unit.side === side && unit.noncombatKind === 'air_base')
      .map((unit) => unit.hex)
  }

  /** 注入给引擎的盘面事实（可指定按哪一方取 HQ / 空军基地） */
  function factsFor(side: Side | null = null): SetupCandidateFacts {
    if (side === null) return {}
    return { hqHexes: hqHexesOf(side), airBaseHexes: airBaseHexesOf(side) }
  }

  /** 自动初设计划（双方；盘面事实取双方的） */
  const plan = computed<SetupPlan | null>(() => {
    const facts: SetupCandidateFacts = {
      hqHexes: [...hqHexesOf('axis'), ...hqHexesOf('soviet')],
      airBaseHexes: [...airBaseHexesOf('axis'), ...airBaseHexesOf('soviet')],
    }
    const outcome = planAutoSetup({ scenarioId: scenarioId.value, facts })
    return outcome.ok ? outcome.data : null
  })

  /** 引擎在计划里记下的数据缺口（缺链接 / 缺事实 / 未识别放置方式） */
  const dataGaps = computed<readonly string[]>(() => plan.value?.dataGaps ?? [])

  /** 该方的飞机初设计划 */
  function airPlanOf(side: Side): AirSetupPlan | null {
    const outcome = planAirSetup({ scenarioId: scenarioId.value, side, facts: factsFor(side) })
    return outcome.ok ? outcome.data : null
  }

  /**
   * 初设里的建制内卡车（来源＝编队的 `isOrganicTruck` 下属）
   *
   * ★ B11 修正（13.2h 的"落子即记 `loadedSpT`"此前**根本没落到盘上**）：
   *   修前这里把 `piece.unitId`（**单位库记录 id**）同时当成 `instanceId` 用，
   *   而 `designateTrucks` 是按**盘上实例 id** 找算子的 ⇒ `find` 永远返回 undefined，
   *   满载标记一次都没写进 `loadedSpT`（测试还真绿，因为失败被 `if (unit !== undefined)` 吞掉了）。
   *   现在改成：先在盘上找出**单位记录属于计划里那些卡车**的算子，再取它们的**真实实例 id**。
   */
  const setupTrucks = computed(() => {
    const truckRecordIds = new Set(
      (plan.value?.pieces ?? [])
        .filter((piece) => piece.isOrganicTruck && piece.unitId !== null)
        .map((piece) => piece.unitId as string),
    )
    return workbench.units
      .filter((unit) => truckRecordIds.has(unit.unitId))
      .map((unit) => ({ instanceId: unit.instanceId, unitId: unit.unitId }))
  })

  /**
   * 须玩家定夺的**非飞机**自由项
   *
   * 飞机条目（`At any air bases`，14.1a）虽也属自由放置，但它的位置还要配**激活态与减损**，
   * 由「飞机初设」那一步专门处理 ⇒ 这里排除，避免同一件事在两处各说一遍。
   */
  const selfChoiceEntries = computed<readonly SetupEntryView[]>(() =>
    entries.value.filter((entry) => !entry.automatic && entry.kind !== 'aircraft'),
  )

  /** 该方须玩家定夺的自由项（不含飞机） */
  function choicesOf(side: Side): readonly SetupEntryView[] {
    return selfChoiceEntries.value.filter((entry) => entry.side === side)
  }

  /**
   * 某条自由项的候选格（按**该条目的所属方**注入盘面事实）
   *
   * 与引擎同一条路（`setupCandidates` + IV-I 过滤），故界面给出的选项一定落在合法范围内。
   */
  function candidatesOf(entryIndex: number): readonly HexRef[] {
    const entry = entries.value.find((view) => view.index === entryIndex)
    if (entry === undefined) return []
    return setupCandidates(entry, factsFor(entry.side))
  }

  /* ────────────────────────────── 地图点选放置（初设重做） ────────────────────────────── */

  /**
   * 当前正在地图上选落点的那一项（null = 不在放置中）
   *
   * 初设里**不能直接落位**的项都走这一条路：在「初设单位 box」里点一项 ⇒
   * 该项的候选格在地图上高亮 ⇒ 点其中一格即落位。候选格一律由引擎给
   * （`setupCandidates` / `planAirSetup` 的 `candidates`），本 store 只做校验与落盘。
   */
  const placing = ref<SetupPlacing | null>(null)

  /*
   * ── 逐枚落位的进度账本（B11，修备忘 #2）─────────────────────────────
   *
   * 用户口径⑨/备忘 #2：「同种单位有多个会**一起放进地图**，不能分开放不同格」——
   * 要求「点堆叠 ▸ 选一项 ▸ **逐个落子**，数量角标递减到 0 才关卡片」。
   * 故按条目（飞机按"某方某型"）记**已落几枚**，落位时只落一枚、进度 +1。
   */
  const placedSelfInstances = ref<Record<number, number>>({})
  const placedAirInstances = ref<Record<string, number>>({})

  /** 飞机进度键（同一型在两方都可能出现 ⇒ 带上阵营） */
  function airProgressKey(side: Side, entryIndex: number): string {
    return `${side}:${entryIndex}`
  }

  /**
   * 该条目要落**几枚 / 几点**
   *
   * · **SP / 运输点**（条 26 / S4）：以**实际量**计（`entry.count` 就是 SP 数 / 运输点数），
   *   且可分多次落在不同格（每次由 `placing.chunk` 决定这一下放多少）；
   * · **空军基地**：一座，返回 1；
   * · **编队**：一次落完整条，返回 1；
   * · **棋子类**（unit / hq / extender）且 `count > 1`：逐枚落，返回 `count`。
   */
  function selfInstanceTotalOf(entry: SetupEntryView): number {
    if (entry.kind === 'sp' || entry.kind === 'transport_point') return Math.max(1, entry.count)
    if (entry.kind === 'airbase' || entry.kind === 'formation') return 1
    return Math.max(1, entry.count)
  }

  /** 该条目已落几枚 */
  function selfPlacedOf(entryIndex: number): number {
    return placedSelfInstances.value[entryIndex] ?? 0
  }

  /** 开始在地图上放置一条**自选格**初设项（地面单位 / HQ / 运输点…） */
  function beginSelfPlacement(entryIndex: number): boolean {
    const entry = selfChoiceEntries.value.find((view) => view.index === entryIndex)
    if (entry === undefined) {
      return record({ ok: false, rule: SETUP_RULE, reason: `selfEntryNotFound:${entryIndex}` })
    }
    const candidates = candidatesOf(entryIndex)
    if (candidates.length === 0) {
      return record({ ok: false, rule: SETUP_RULE, reason: `noCandidates:${entryIndex}` })
    }
    const total = selfInstanceTotalOf(entry)
    const placed = selfPlacedOf(entryIndex)
    placing.value = {
      kind: 'self',
      entryIndex,
      side: entry.side,
      label: entry.name ?? entry.raw,
      raw: entry.raw,
      count: entry.count,
      total,
      placed,
      remaining: Math.max(0, total - placed),
      // 第六批条 26（S4）：计数类默认一次点完（chunk＝剩余）；棋子类恒 1
      chunk:
        entry.kind === 'sp' || entry.kind === 'transport_point' ? Math.max(0, total - placed) : 1,
      candidates: candidates.map((hex) => ({ col: hex.col, row: hex.row })),
      category: categoryOfEntry(entry.kind),
      // 第六批条 1（S1）：算子图阵列
      imageUrl: imageUrlOfEntry(entry),
      blockedReason: null,
    }
    lastAction.value = null
    return true
  }

  /** 开始在地图上放置**某一型飞机**（候选＝本方空军基地格） */
  function beginAirPlacement(side: Side, entryIndex: number): boolean {
    const airPlan = airPlanOf(side)
    const row = airPlan?.placements.find((item) => item.entryIndex === entryIndex)
    if (airPlan === null || row === undefined) {
      return record({ ok: false, rule: AIR_BASE_SITE_RULE, reason: `airRowNotFound:${entryIndex}` })
    }
    /*
     * ★ B11（修备忘 #1 的半个根因）：候选为空时**说清该怎么才能有候选**——
     *   飞机的候选＝**本方空军基地格**（14.1a），初设里基地本身也是一项；
     *   若基地还没落位，先前的提示会变成引擎的"调用方未提供 airBaseHexes"，把玩家引到数据问题上。
     */
    if (row.candidates.length === 0) {
      const reason =
        airBaseHexesOf(side).length === 0
          ? `先落本方空军基地，再放飞机（14.1a：飞机停在其空军基地格）`
          : `没有可用的空军基地格（14.1a）`
      return record({ ok: false, rule: AIR_BASE_SITE_RULE, reason })
    }
    const placed = placedAirInstances.value[airProgressKey(side, entryIndex)] ?? 0
    placing.value = {
      kind: 'air',
      entryIndex,
      side,
      label: row.name,
      raw: row.aircraftId,
      count: row.count,
      total: row.count,
      placed,
      remaining: Math.max(0, row.count - placed),
      chunk: 1,
      candidates: row.candidates.map((hex) => ({ col: hex.col, row: hex.row })),
      category: 'air',
      // 第六批条 1（S1）：机型图档
      imageUrl: imageUrlOfAircraftId(row.aircraftId),
      blockedReason: null,
    }
    lastAction.value = null
    return true
  }

  /** 取消地图点选（不改任何已落盘的东西） */
  /**
   * 第六批 §6-A：开始在地图上给**某个抽中西移的师**定落点（ch10）
   *
   * 与 `beginSelfPlacement` 不同：这一项的来源不是剧本页条目，而是**抽签结果**
   * （`containers.pendingShiftWestPlacements`）⇒ 以 `formationId` 为主键，没有 `entryIndex`。
   */
  function beginShiftPlacement(formationId: string): boolean {
    const item = containers.pendingShiftWestPlacements.find(
      (entry) => entry.formationId === formationId,
    )
    if (item === undefined) {
      return record({ ok: false, rule: SETUP_RULE, reason: `shiftEntryNotFound:${formationId}` })
    }
    const from = item.fromHexText === null ? null : parseSetupHexText(item.fromHexText)
    const candidates =
      from === null
        ? []
        : hexesWithin(from, Math.max(item.shiftHexes, 0), { onMapOnly: true }).filter(
            (hex) => hex.col <= from.col,
          )
    placing.value = {
      kind: 'shift',
      formationId,
      entryIndex: -1,
      side: 'axis',
      label: `${formationId}（ch10 西移 ${String(item.shiftHexes)} 格）`,
      raw: formationId,
      count: 1,
      total: 1,
      placed: 0,
      remaining: 1,
      chunk: 1,
      candidates,
      category: 'ground',
      imageUrl: item.unitIds[0] === undefined ? null : counterImageUrlOfUnit(item.unitIds[0]),
      blockedReason: null,
    }
    lastAction.value = null
    return true
  }

  /** ch10：把抽中西移的那个师摆到玩家点定的格（落点由玩家给，摆位由容器 store 落盘） */
  function placeShiftFormation(formationId: string | undefined, hex: HexRef): boolean {
    if (formationId === undefined) {
      return record({ ok: false, rule: SETUP_RULE, reason: 'shiftFormationIdMissing' })
    }
    if (!containers.applyShiftWestAtNow(formationId, setupHexLabel(hex))) {
      return record({
        ok: false,
        rule: 'ch10',
        reason: containers.lastAction?.detail ?? 'shiftPlacementRejected',
      })
    }
    completed.value = { ...completed.value, [`shift:${formationId}`]: true }
    placing.value = null
    return record({
      ok: true,
      rule: 'ch10',
      data: { detail: containers.lastAction?.detail ?? `${formationId} → ${setupHexLabel(hex)}` },
    })
  }

  function cancelPlacement(): void {
    placing.value = null
  }

  /**
   * 在地图上点了一格：若它在当前待放项的候选格内 ⇒ **落一枚**
   *
   * B11：同型多枚时**逐个落**（可落在不同格）——进度没到总数就**保持卡片打开**，
   * 数量角标递减到 0 才收起（用户口径⑨）。
   *
   * @returns 该次点击是否被初设流程消费（false ⇒ 交回常规的地图点击分派）
   */
  function placeAtHex(hex: HexRef): boolean {
    const current = placing.value
    if (current === null) return false
    /*
     * ★ ch10 西移项**不按候选校验**：原文只给算法（沿道路西移 3 格，例 11.03 → 9.01）、道路拓扑数据未覆盖该区域 ⇒ 候选只是「半径内的提示范围」，
     *   真正的口径是"玩家给一个格"（与 `containers.beginDrawShiftHexPickNow` 的 `candidates: 'any'`
     *   同一口径）⇒ 这里只校验在图上（IV-I 的一半），不给玩家添一层会被拒的框。
     */
    if (current.kind !== 'shift') {
      const hit = current.candidates.some(
        (candidate) => candidate.col === hex.col && candidate.row === hex.row,
      )
      if (!hit) {
        record({
          ok: false,
          rule: current.kind === 'air' ? AIR_BASE_SITE_RULE : SETUP_RULE,
          reason: `notSetupCandidate:${hex.col}.${hex.row}`,
        })
        return true
      }
    } else if (!isOnMap(hex)) {
      record({ ok: false, rule: SETUP_RULE, reason: `setupHexOffMap:${hex.col}.${hex.row}` })
      return true
    }
    const ok =
      current.kind === 'self'
        ? placeSelfOneInstance(current.entryIndex, hex, current.chunk)
        : current.kind === 'air'
          ? placeAirRowNow(current.entryIndex, hex, current.side)
          : placeShiftFormation(current.formationId, hex)
    if (!ok) return true
    // 还差就继续开着（换到别的格去落剩下的），落满即收
    const key =
      current.kind === 'air'
        ? (placedAirInstances.value[airProgressKey(current.side, current.entryIndex)] ?? 0)
        : selfPlacedOf(current.entryIndex)
    placing.value =
      key >= current.total
        ? null
        : {
            ...current,
            placed: key,
            remaining: current.total - key,
            // 下次默认点完剩余（玩家可再改 chunk）
            chunk: Math.max(0, current.total - key),
          }
    return true
  }

  /**
   * 第六批条 26（S4）：设定本次点地图要落的计数类量（SP / 运输点）
   *
   * 钳到 `[1, remaining]`；棋子类 / 飞机类无效（它们一枚一枚落，本函数不接）。
   */
  function setPlacingChunk(n: number): void {
    const current = placing.value
    if (current === null || current.kind !== 'self') return
    const clamped = Math.max(1, Math.min(Math.trunc(n), current.remaining))
    placing.value = { ...current, chunk: clamped }
  }

  /**
   * 当前计数类放置项的**可用面额**（≤ 剩余量）＋剩余量本身，供 UI 选择「这一下放几」
   *
   * · SP：取自算子库的全部 SP 面额（`spDenominations`）；
   * · 运输点：取自该方该类运输点的面额（`transportDenominations`）。
   * 两者都拼上 `remaining`，保证「一次点完」永远可选。
   */
  const placingChunkChoices = computed<number[]>(() => {
    const current = placing.value
    if (current === null || current.kind !== 'self') return []
    const entry = entries.value.find((view) => view.index === current.entryIndex)
    if (entry === undefined) return []
    if (entry.kind !== 'sp' && entry.kind !== 'transport_point') return []
    const denoms =
      entry.kind === 'sp'
        ? spDenominations()
        : transportDenominations(entry.side, setupTransportKindOf(entry.raw) ?? 'truck')
    const all = new Set<number>([...denoms, current.remaining])
    return [...all].filter((value) => value > 0 && value <= current.remaining).sort((a, b) => a - b)
  })

  /**
   * 14.1a：把某一型的**一枚**飞机落位到指定空军基地格（地图点选用）
   *
   * B11 两处修正：
   *   ① `side` 由调用方给出（**不再依赖 `placing.value`**）——先前从放置态里读，
   *      一旦直接调用（非地图点选路径）就静默 `return false`，正是备忘 #1「放进机场后数量不减」的一半；
   *   ② 每次只落**一枚**（按该型已落枚数取 `statuses`/`steps`），落满 `row.count` 才记完成。
   */
  function placeAirRowNow(entryIndex: number, hex: HexRef, side: Side): boolean {
    const airPlan = airPlanOf(side)
    const row = airPlan?.placements.find((item) => item.entryIndex === entryIndex)
    const recordAir = row === undefined ? undefined : findAircraftRecord(row.aircraftId)
    if (row === undefined || recordAir === undefined) {
      return record({ ok: false, rule: AIR_BASE_SITE_RULE, reason: `airRowNotFound:${entryIndex}` })
    }
    const key = airProgressKey(side, entryIndex)
    const index = placedAirInstances.value[key] ?? 0
    if (index >= row.count) {
      return record({
        ok: false,
        rule: AIR_BASE_SITE_RULE,
        reason: `airRowAlreadyPlaced:${entryIndex}`,
      })
    }
    const air = toConsoleAirUnit({
      aircraft: recordAir,
      instanceId: createId('a'),
      hex: { ...hex },
      side,
      airStatus: row.statuses[index] ?? 'inactive',
    })
    // IV-E / 剧本明示的减损：落到该型第 n 枚时取第 n 个 loss 值
    air.steps = row.steps[index] ?? air.steps
    workbench.airUnits.push(air)
    const placedNow = index + 1
    placedAirInstances.value = { ...placedAirInstances.value, [key]: placedNow }
    airChoices.value = { ...airChoices.value, [entryIndex]: setupHexLabel(hex) }
    if (placedNow >= row.count) {
      completed.value = { ...completed.value, [`air:${side}:${entryIndex}`]: true }
    }
    return record({
      ok: true,
      rule: AIR_BASE_SITE_RULE,
      data: {
        detail: `飞机落位：${row.name} 第 ${placedNow}/${row.count} 枚 → ${setupHexLabel(hex)}（14.1a）`,
      },
    })
  }

  /** 还剩几项没在地图上落位（飞机按「型」计；自选格项按「条」计） */
  const pendingPlacement = computed<readonly SetupPlacing[]>(() => {
    const items: SetupPlacing[] = []
    for (const entry of selfChoiceEntries.value) {
      if (completed.value[`self:${entry.index}`] === true) continue
      const total = selfInstanceTotalOf(entry)
      const placed = selfPlacedOf(entry.index)
      const candidates = candidatesOf(entry.index)
      items.push({
        kind: 'self',
        entryIndex: entry.index,
        side: entry.side,
        label: entry.name ?? entry.raw,
        raw: entry.raw,
        count: entry.count,
        total,
        placed,
        remaining: Math.max(0, total - placed),
        // 第六批条 26（S4）：计数类默认一次点完；棋子类恒 1
        chunk:
          entry.kind === 'sp' || entry.kind === 'transport_point' ? Math.max(0, total - placed) : 1,
        candidates,
        category: categoryOfEntry(entry.kind),
        // 第六批条 1（S1）：算子图阵列（查不到图 ⇒ null，界面退回文字卡）
        imageUrl: imageUrlOfEntry(entry),
        blockedReason:
          candidates.length === 0 ? '该条目的候选格暂不可解（缺锚格 / 半径 / 地图事实）' : null,
      })
    }
    for (const side of ['axis', 'soviet'] as const) {
      const planSide = airPlanOf(side)
      if (planSide === null) continue
      for (const row of planSide.placements) {
        if (completed.value[`air:${side}:${row.entryIndex}`] === true) continue
        const placed = placedAirInstances.value[airProgressKey(side, row.entryIndex)] ?? 0
        items.push({
          kind: 'air',
          entryIndex: row.entryIndex,
          side,
          label: row.name,
          raw: row.aircraftId,
          count: row.count,
          total: row.count,
          placed,
          remaining: Math.max(0, row.count - placed),
          chunk: 1,
          candidates: row.candidates,
          category: 'air',
          // 第六批条 1（S1）：机型图档
          imageUrl: imageUrlOfAircraftId(row.aircraftId),
          // ★ 备忘 #1：基地未落位时**说清前置**（14.1a 的候选＝本方空军基地格）
          blockedReason:
            row.candidates.length === 0
              ? airBaseHexesOf(side).length === 0
                ? '先落本方空军基地再放飞机（14.1a）'
                : '没有可用的空军基地格（14.1a）'
              : null,
        })
      }
    }
    /*
     * 第六批 §6-A：**ch10 西移组抽中的师**
     *
     * 抽签时已按「视为有道路」**自动算出落点并摆位**（`containers.runSetupDrawsNow`）
     * ⇒ 这里**只列自动摆不出来的**（该师没有图上格号 / 西边到图边了）—— 玩家不点任何东西，
     * 抽签带来的位置调整也已经落到盘上（修前：只在折叠明细里给个小输入框、还写着"先在 B 段抽签"）。
     * 自动摆好的那些仍可在「开局流程明细」里照剧本卡改（`containers.setDrawShiftHexNow`）。
     *
     * 候选＝**原格 N 格半径内且不更靠东**（ch10 是"沿道路西移 N 格"，路径长 N ⇒ 落点必在半径 N 内；
     * 这是从规则推得的**必要条件**，不是猜）。原格推不出（初设行没给图上格号）⇒ 候选为空并说清原因。
     */
    for (const item of containers.pendingShiftWestPlacements) {
      if (completed.value[`shift:${item.formationId}`] === true) continue
      // 已自动摆位（有落点）⇒ 不占待办；只有算不出来的才要玩家给
      if (item.hexText !== null) continue
      const from = item.fromHexText === null ? null : parseSetupHexText(item.fromHexText)
      const candidates =
        from === null
          ? []
          : hexesWithin(from, Math.max(item.shiftHexes, 0), { onMapOnly: true }).filter(
              (hex) => hex.col <= from.col,
            )
      items.push({
        kind: 'shift',
        formationId: item.formationId,
        entryIndex: -1,
        side: 'axis',
        label: `${item.formationId}（ch10 西移 ${String(item.shiftHexes)} 格）`,
        raw: item.formationId,
        count: 1,
        total: 1,
        placed: 0,
        remaining: 1,
        chunk: 1,
        candidates,
        category: 'ground',
        // 条 1（S1）：该师第一枚图上的算子作缩略图（与地图同一条选图实现）
        imageUrl: item.unitIds[0] === undefined ? null : counterImageUrlOfUnit(item.unitIds[0]),
        blockedReason:
          candidates.length === 0
            ? `该师的初设行没有图上格号 ⇒ 推不出候选范围（原格 ${item.fromHexText ?? '—'}）`
            : null,
      })
    }
    return items
  })

  /**
   * 本剧本要求的**满载卡车辆数**（`setup.organicTrucks`：13.2h / 专规 Setup Note C）
   *
   * `null` ＝ 本剧本没有这一项（不列进决策队列）；`0` ＝ 明示"全部空载"。
   * ★ 原先这条算法只在 `SetupPanel.vue` 里有一份（视图层），B11 把它搬进 store：
   *   决策队列与面板读同一份，不再两处各算一遍（面板那份待 B14/B17 收口时删）。
   */
  const requiredFullTrucks = computed<number | null>(() => {
    const spec = scenarios.scenarios.find((item) => item.id === scenarioId.value)?.setup
      .organicTrucks
    if (spec === undefined) return null
    if (spec.mode === 'all_loaded') return setupTrucks.value.length
    if (spec.mode === 'all_unloaded') return 0
    return spec.count ?? 0
  })

  /**
   * 卡车装载决定（13.2h / 专规 Setup Note C）
   *
   * 编内卡车**只有剧本页明示才满载**；满载＝载 1 SP（`loadedSpT`），空载＝0。
   * 与"在地图上落位"是两类决定，故单列一堆。
   */
  /**
   * B38（用户口径 #8）：**本剧本的卡车装载模式**（剧本页明示；数据缺省视为不适用）
   *
   *   · `all_loaded` / `all_unloaded` ⇒ **不由玩家决定**（脚本说了算）⇒ 不进决策队列、自动落盘；
   *   · `choose_loaded` ⇒ 玩家自选 N 辆满载（引擎核名单）。
   */
  const truckLoadMode = computed<'all_loaded' | 'all_unloaded' | 'choose_loaded' | null>(() => {
    const spec = scenarios.scenarios.find((item) => item.id === scenarioId.value)?.setup
      .organicTrucks
    return spec === undefined ? null : spec.mode
  })

  /**
   * B38：**实际要按满载记的卡车**（"生效名单"）
   *
   * 脚本明示全满载/全空载时**不看玩家的勾选**（玩家也没被问过）；只有 `choose_loaded` 才用
   * `truckFullIds`。落盘与引擎核对**都读这一份** ⇒ 界面上的勾选与盘上的 `loadedSpT` 不会两说。
   */
  const effectiveFullTruckIds = computed<readonly string[]>(() => {
    if (truckLoadMode.value === 'all_loaded')
      return setupTrucks.value.map((truck) => truck.instanceId)
    if (truckLoadMode.value === 'all_unloaded') return []
    return truckFullIds.value
  })

  /**
   * 13.2h / IV-D：**卡车装载的界面口径**（一处给全，组件不自己拼）
   *
   * `automatic` ＝ 剧本页明示（全满载 / 全空载）⇒ **不由玩家决定**：初设已自动落账，
   * 界面只给只读回执；只有 `choose_loaded` 才该出现勾选框与"核验"按钮。
   */
  const truckLoadSummary = computed<{
    mode: 'all_loaded' | 'all_unloaded' | 'choose_loaded' | null
    automatic: boolean
    /** 本剧本的建制内卡车总数 */
    total: number
    /** 按剧本（或按玩家勾选）应满载的辆数 */
    fullCount: number
    /** 剧本页原文（照录，不改写） */
    raw: string
    /** 13.2h 的装载名单是否已落账（`loadedSpT` 已写） */
    done: boolean
  }>(() => ({
    mode: truckLoadMode.value,
    automatic: truckLoadMode.value === 'all_loaded' || truckLoadMode.value === 'all_unloaded',
    total: setupTrucks.value.length,
    fullCount: effectiveFullTruckIds.value.length,
    raw:
      scenarios.scenarios.find((item) => item.id === scenarioId.value)?.setup.organicTrucks.raw ??
      '—',
    done: completed.value['truckLoad'] === true,
  }))

  const truckDecisions = computed<readonly TruckDecision[]>(() => {
    const required = requiredFullTrucks.value
    return setupTrucks.value.map((truck) => {
      const unit = workbench.units.find((item) => item.instanceId === truck.instanceId)
      return {
        instanceId: truck.instanceId,
        unitId: truck.unitId,
        name: unit?.name ?? truck.unitId,
        full: truckFullIds.value.includes(truck.instanceId),
        requiredFull: required,
      }
    })
  })

  /**
   * **待你决定的队列**（B11；用户口径⑨：地图左上「待你决定」，四堆叠）
   *
   * 四堆：**地面**（战斗单位与基地）/ **非战斗**（SP 与运输点）/ **飞机** / **卡车**（满载决定）。
   * 每堆给"还剩多少枚"（数量角标之和），每个卡片带 `remaining/total` 与阻塞原因——
   * 界面因此不必自己算任何东西（分层纪律：结论出自 store）。
   */
  const decisionQueue = computed<readonly DecisionStack[]>(() => {
    const pending = pendingPlacement.value
    const stackOf = (
      key: DecisionStack['key'],
      label: string,
      items: readonly SetupPlacing[],
    ): DecisionStack => ({
      key,
      label,
      count: items.reduce((total, item) => total + item.remaining, 0),
      items,
    })
    return [
      stackOf(
        'ground',
        '地面',
        pending.filter((item) => item.category === 'ground'),
      ),
      stackOf(
        'supply',
        '非战斗',
        pending.filter((item) => item.category === 'supply'),
      ),
      stackOf(
        'air',
        '飞机',
        pending.filter((item) => item.category === 'air'),
      ),
      stackOf(
        'truck',
        '卡车',
        truckDecisions.value
          /*
           * B38（用户口径 #8）：**只有 `choose_loaded` 才进队列** ——
           * 剧本明示"全满载/全空载"时不需要玩家做任何决定（原先一律列出，玩家被白问一遍）。
           */
          .filter((truck) => truck.requiredFull !== null && truckLoadMode.value === 'choose_loaded')
          .map((truck) => ({
            kind: 'truck' as const,
            entryIndex: -1,
            instanceId: truck.instanceId,
            side: activeSideForTruck(truck.instanceId),
            label: truck.name,
            raw: truck.unitId,
            count: 1,
            total: 1,
            placed: truck.full ? 1 : 0,
            remaining: truck.full ? 0 : 1,
            chunk: 1,
            candidates: [],
            category: 'ground' as const,
            blockedReason: null,
            // 第六批条 1（S1）：卡车按**实例**取图（与地图同一枚算子）
            imageUrl: counterImageUrlOfUnit(truck.instanceId),
          })),
      ),
    ]
  })

  /** 该卡车所属阵营（凡查不到就当轴心，仅用于界面着色；本项不参与任何判定） */
  function activeSideForTruck(instanceId: string): Side {
    return workbench.units.find((item) => item.instanceId === instanceId)?.side ?? 'axis'
  }

  /** 第六批条 1（S1）：盘面上某实例的算子图（与地图同一条选图实现） */
  function counterImageUrlOfUnit(instanceId: string): string | null {
    const unit = workbench.units.find((item) => item.instanceId === instanceId)
    return unit === undefined ? null : counterImageUrlOf(unit)
  }

  /* ────────────── 第六批条 1（S1）：初设的**分方游标**（先布设方在前） ────────────── */

  /**
   * 剧本规定的**先布设方**（`scenarios.json` 的 `setup.setupFirst`）
   *
   * ★ 它与 `firstPlayer`（**先行动方**）是两回事 —— 剧本 1 正是两者不同的那一局
   *   （先布设 ≠ 先走）⇒ 游标取 `setupFirst`，绝不拿 `firstPlayer` 顶替。
   */
  const setupFirstSide = computed<Side | null>(() => {
    const scenario = scenarios.scenarios.find((item) => item.id === scenarioId.value)
    // ★ `setupFirst` 在**剧本级**（与"先行动方"并列），不在 `setup` 子对象里
    return scenario?.setupFirst ?? null
  })

  /** 当前轮到哪一方布设（null = 不分方，队列仍是全量） */
  const setupSideCursor = ref<Side | null>(null)

  /** 各方是否已「确认布设完毕」 */
  const setupSideConfirmed = ref<Record<string, boolean>>({})

  /** 按剧本的先布设方**起游标**（换剧本时重开） */
  function armSetupSideCursor(): void {
    setupSideConfirmed.value = {}
    const first = setupFirstSide.value
    setupSideCursor.value = first ?? null
  }

  /**
   * 确认**当前方**布设完毕 ⇒ 游标移到还没确认的那一方；两方都确认 ⇒ 游标归位（队列恢复全量）
   *
   * 未落位的项**照旧按既有口径处理**（`finishSetup` 时才记为"本局移除"）——
   * 这里的"确认"只是**换手**，不是替玩家把剩下的项一笔勾销。
   */
  function confirmSideSetup(): boolean {
    const current = setupSideCursor.value
    if (current === null) {
      return record({ ok: false, rule: SETUP_RULE, reason: 'sideCursorNotArmed' })
    }
    setupSideConfirmed.value = { ...setupSideConfirmed.value, [current]: true }
    const other: Side = current === 'axis' ? 'soviet' : 'axis'
    const otherDone = setupSideConfirmed.value[other] === true
    setupSideCursor.value = otherDone ? null : other
    return record({
      ok: true,
      rule: SETUP_RULE,
      data: {
        detail: otherDone
          ? `双方布设均已确认（先布设方：${setupFirstSide.value === 'soviet' ? '苏联' : '轴心'}）`
          : `${current === 'axis' ? '轴心' : '苏联'}布设确认 ⇒ 轮到${other === 'axis' ? '轴心' : '苏联'}`,
      },
    })
  }

  /** 该方**还有**几项待定（含已方卡车；用于"这一方能不能确认"） */
  function sidePendingCount(side: Side): number {
    return decisionQueue.value.reduce(
      (total, stack) =>
        total +
        stack.items.filter(
          (item) => (item.instanceId ? activeSideForTruck(item.instanceId) : item.side) === side,
        ).length,
      0,
    )
  }

  /**
   * **按当前方过滤**的队列（条 1：队列按方过滤）
   *
   * ★ 游标未起（或两方都已确认）⇒ 返回**全量** `decisionQueue`：
   *   既有夹具与验证页都在读 `decisionQueue`，分方只是**界面的一层视图**，不改变那份数据。
   */
  const sideQueue = computed<readonly DecisionStack[]>(() => {
    const cursor = setupSideCursor.value
    if (cursor === null) return decisionQueue.value
    return decisionQueue.value.map((stack) => {
      const items = stack.items.filter((item) =>
        item.instanceId !== undefined
          ? activeSideForTruck(item.instanceId) === cursor
          : item.side === cursor,
      )
      return { ...stack, items, count: items.reduce((total, item) => total + item.remaining, 0) }
    })
  })

  /**
   * 第六批条 1（S1）：**初设条目 → 算子图档**
   *
   * 计数类（SP / 运输点）按**面额**取对应那一枚（它们本来就是"面额不同图不同"的算子）；
   * 其余按条目解析出的 `unitId`（取不到就用展开棋子的第一枚、再没有即 null）。
   */
  function imageUrlOfEntry(entry: SetupEntryView): string | null {
    if (entry.kind === 'sp') return findSpRecord(entry.count)?.images?.front ?? null
    if (entry.kind === 'transport_point') {
      const byTruck = findTransportRecord(entry.side, 'truck', entry.count)
      const hit = byTruck ?? findTransportRecord(entry.side, 'wagon', entry.count)
      return hit?.images?.front ?? null
    }
    return imageUrlOfRecordId(entry.unitId ?? entry.pieces[0]?.unitId ?? null)
  }

  /* ────────────────── 第六批条 2（S2）：卡车装载改**地图点选** ────────────────── */

  /**
   * 是否正在"点地图上的卡车指定满载"（13.2h / 专规 Setup Note C）
   *
   * 用户口径（第六批条 2）：「**地图上高亮可装载卡车，点击即装载**，去掉核验按钮」。
   * 修前是"卡车卡片上一个勾选框 + 一个核验按钮"——卡片上那张表里几十辆卡车长得一样
   * （同名同图），玩家只能靠行号认车；而他要问的其实是"**这辆**（图上的那辆）装不装"。
   */
  const truckPickActive = ref(false)

  /** 可点选的卡车（只有 `choose_loaded` 才由玩家决定；另两种模式已自动落账） */
  const truckPickRows = computed<readonly { instanceId: string; hex: HexRef; full: boolean }[]>(
    () => {
      if (truckLoadMode.value !== 'choose_loaded') return []
      const rows: { instanceId: string; hex: HexRef; full: boolean }[] = []
      for (const truck of setupTrucks.value) {
        const unit = workbench.units.find((item) => item.instanceId === truck.instanceId)
        if (unit === undefined) continue
        rows.push({
          instanceId: truck.instanceId,
          hex: { col: unit.hex.col, row: unit.hex.row },
          full: truckFullIds.value.includes(truck.instanceId),
        })
      }
      return rows
    },
  )

  /** 地图上要高亮的卡车所在格（供 `map-view` 的 `setupCandidates` 覆盖层） */
  const truckPickHexes = computed<readonly HexRef[]>(() =>
    truckPickRows.value.map((row) => ({ col: row.hex.col, row: row.hex.row })),
  )

  /** 开启地图点选（没有可点卡车 ⇒ 明确拒绝并说清原因，不让界面开一个空模式） */
  function beginTruckPick(): boolean {
    if (truckLoadMode.value !== 'choose_loaded') {
      return record({
        ok: false,
        rule: SETUP_RULE,
        reason: `truckPickNotApplicable:${truckLoadMode.value ?? 'none'}`,
      })
    }
    if (truckPickRows.value.length === 0) {
      return record({ ok: false, rule: SETUP_RULE, reason: 'noTruckToPick' })
    }
    placing.value = null
    truckPickActive.value = true
    lastAction.value = null
    return true
  }

  function cancelTruckPick(): void {
    truckPickActive.value = false
  }

  /**
   * 在地图上点了一格 ⇒ 该格有编内卡车就**切换**它的满载标记
   *
   * 满载＝载 1 SP（用户 2026-09-15 裁定）；点**已满载**的那一辆＝卸下（再点又装上），
   * 故不需要"取消"入口。选够剧本页要求的辆数时**自动落账**（`designateTrucks`），
   * 于是"核验按钮"这一层被去掉——玩家点完就完事。
   *
   * @returns 该次点击是否被卡车点选消费（false ⇒ 交回常规地图分派）
   */
  function pickTruckAtHex(hex: HexRef): boolean {
    if (!truckPickActive.value) return false
    const hit = truckPickRows.value.find(
      (row) => row.hex.col === hex.col && row.hex.row === hex.row,
    )
    if (hit === undefined) {
      record({
        ok: false,
        rule: SETUP_RULE,
        reason: `notATruckHex:${hex.col}.${hex.row}`,
      })
      return true
    }
    toggleTruckFull(hit.instanceId, !hit.full)
    const required = requiredFullTrucks.value
    const nowFull = truckFullIds.value.length
    if (required !== null && nowFull === required) {
      /*
       * 13.2h：选够即落账（原先这一步要玩家再点一下"核验"）。
       * 落账失败（例：名单与剧本页仍不符）不静默 ⇒ 停在"未落账"，界面上看得到原因。
       */
      designateTrucks()
    }
    return true
  }

  /** 初设是否已收束（玩家点了「开始游戏」） */
  const finished = ref(false)

  /**
   * 收束初设 ⇒ 进入第一阶段
   *
   * 未在地图上落位的项**视为从本局移除**（不算错、不补位）——这正是用户要的口径：
   * 「在初设 box 不设置的就视为从当前游戏中移除，不存在」。故此处只记一条留痕，不改盘面。
   */
  function finishSetup(): boolean {
    const remaining = pendingPlacement.value
    for (const item of remaining) {
      /*
       * ★ ch10 西移项**不适用**「未落位 ⇒ 本局移除」：它不是"放一个新单位"，而是把一个
       *   **已在图上**的师挪位置 ⇒ 没给落点就该**留在剧本页原格**（不施加未定的移动），
       *   移除一整个师是规则没写的效果（CODE_SPEC：不无中生有）。
       */
      if (item.kind === 'shift') {
        completed.value = { ...completed.value, [`shift:${item.formationId ?? ''}`]: true }
        notes.value = [
          ...notes.value,
          `西移落点未给 ⇒ ${item.label} 留在剧本页原格（ch10 的西移不施加）`,
        ]
        continue
      }
      if (item.kind === 'air') {
        completed.value = { ...completed.value, [`air:${item.side}:${item.entryIndex}`]: true }
      } else {
        completed.value = { ...completed.value, [`self:${item.entryIndex}`]: true }
      }
      notes.value = [
        ...notes.value,
        `未初设 ⇒ 本局移除：${item.side === 'axis' ? '轴心' : '苏联'}「${item.label}」（×${item.count}）`,
      ]
    }
    placing.value = null
    finished.value = true
    completed.value = { ...completed.value, start: true }
    return record({
      ok: true,
      rule: SETUP_RULE,
      data: {
        detail:
          remaining.length === 0
            ? '初设完成：全部项已落位 ⇒ 进入第一阶段'
            : `初设完成：${remaining.length} 项未落位（视为本局移除）⇒ 进入第一阶段`,
      },
    })
  }

  /**
   * 开始游戏（初设收束 ⇒ 开局 ⇒ 进入第一阶段）
   *
   * 用户口径：「全部设置完成后点击开始游戏进入第一个阶段」；「在初设 box 不设置的就视为从当前游戏中移除」。
   * 为避免玩家再跑别处去点「确认共识 / 步进」，本函数把三件事一次做完：
   *   ① `finishSetup()` 收束初设（未落位者记为本局移除）；
   *   ② 建会话并把共识勾选写成日志结论（默认全勾选，见 `resetAgreedChecklist`；专规 4.0 门禁）；
   *   ③ 推进到第一阶段（`preTurn` 的自动段）。
   */
  function startGameNow(): boolean {
    if (placing.value !== null) placing.value = null
    /*
     * B38（方案 §3 步骤 2 后半）：**先开局、再收初设**。
     *
     * 修前是"先 `finishSetup()` 再 `startGame()`" ⇒ 开局被拒（缺共识、盘面不合法…）时
     * 初设已经收束（`finished = true`），玩家**回不去改**了。现在只有开局成功才收束；
     * 被拒时留下原因、初设照旧可改（`finished` 仍为 false）。
     */
    if (game.session === null) {
      if (!game.startGame()) {
        return record({
          ok: false,
          rule: SETUP_RULE,
          reason: `startGameRejected:${game.error?.reason ?? ''}`,
        })
      }
      // 开局成功 ⇒ 此刻才收束初设（未落位者记为本局移除）
      if (!finished.value) finishSetup()
      // 专规 4.0：把共识勾选写成日志结论（默认全部不勾 ⇒ 可选规则一律不采用）
      if (!game.confirmAgreedChecklist()) {
        return record({
          ok: false,
          rule: game.error?.rule ?? '4.0',
          reason: game.error?.reason ?? 'consensusChecklistRejected',
        })
      }
    }
    // 已有会话（重进）时开局分支被跳过 ⇒ 这里补上收束；开局刚成功时它已是 no-op
    if (!finished.value) finishSetup()
    /*
     * ★ 第六批条 3（S3）：修前只走**单步推进**一次 ⇒ 玩家点「开始游戏」后停在
     *   `preTurn` 的**第一步之后**，还得自己再点几次才到 A 飞机整备段 ——
     *   「自动进行的阶段不需要玩家介入」（用户 2026-09-16 ⑩）在开局这一下就断了。
     *
     *   首回合的自动段是**两步**（天气 → 先手判定；先手由剧本指定 ⇒ 2.3 不发问），
     *   故这里改用会话的**连跑**（`advanceToNextStop`），一次落到**第一个玩家环节**
     *   ＝先手方的 A 飞机整备段（2.2）。
     *   ★ 待答（2.3 真的要玩家选先后手）时不硬闯：那一步交给玩家答完再点。
     */
    const outcome = game.advanceToNextStop()
    if (outcome.stoppedBy === 'refused' || outcome.stoppedBy === 'limit') {
      return record({
        ok: false,
        rule: game.error?.rule ?? SETUP_RULE,
        reason:
          outcome.stoppedBy === 'limit'
            ? 'autoAdvanceLimit'
            : (game.error?.reason ?? 'advanceRejected'),
      })
    }
    return record({
      ok: true,
      rule: SETUP_RULE,
      data: {
        detail:
          outcome.stoppedBy === 'question'
            ? `开始游戏：剧本 ${scenarioId.value} 初设收束 ⇒ 待玩家决定（2.3 先后手）`
            : `开始游戏：剧本 ${scenarioId.value} 初设收束 ⇒ 自动段连跑 ${outcome.steps} 步，` +
              `停在第一个玩家环节（2.2）`,
      },
    })
  }

  /** 本方的 SP 账本（12.1d：归属＝带上图的一方） */
  function spDumpsOf(side: Side): readonly SupplyDumpRef[] {
    return spDumps.value.filter((dump) => dump.side === side)
  }

  /*
   * ★ 批 F 切片 1：本处那份**直线版**分界线已删 —— 口径统一到 `workbench.panzerGroupBoundaryWithPath`
   *   （带多轨铁路折线；与段末义务判定、地图渲染**同一条线**）。理由见 `defaultPanzerGroupOf` 的注释。
   */

  /**
   * 3.4a / Setup Note F：轴方 dump 的装甲集群**默认归属**（按分界线判）
   *
   * 规则原文说「分界线仅作参考，归属由玩家自定」⇒ 这里给的是**默认值**（玩家可在初设面板改），
   * 目的是让「玩家不用为每个 dump 点名」；分界线以北 ⇒ Hoth，以南/线上 ⇒ Guderian
   * （与 3.4b「奇数点归 Guderian」同一偏置）。
   */
  function defaultPanzerGroupOf(hex: HexRef): SetupPanzerGroup {
    /*
     * ★ 批 F 切片 1：用 **workbench 那份带路径的分界线**（多轨铁路折线）——
     *   修前这里读的是本文件自己那份**直线版**，于是"初设默认归属"与"段末义务判定"
     *   拿两条不同的线去判（前者直线、后者折线）⇒ 同一个 dump 可能默认归 A、判义务时算 B。
     */
    const boundary = workbench.panzerGroupBoundaryWithPath
    if (boundary === null) return 'guderian'
    return boundarySideOf(hex, boundary) === 'north' ? 'hoth' : 'guderian'
  }
  /** 全部步骤是否走完（开局流程完成度） */
  const allDone = computed(() =>
    flow.value.filter((step) => step.applicable).every((step) => stepDone.value[step.id] === true),
  )

  /**
   * 批 E 切片 2（用户 9.17③a）：**抽签结果回写初设** —— 把 C12 抽取盒的落盘台账折成初设可读的行
   *
   * 「剧本特殊规则抽取的轴心编队，其**变化**没自动列入初设」是本条的病灶：修前落盘只改盘面
   * （Mtr→死亡堆、Aufk 返场、Move Mode），**初设这边看不见发生了什么**，玩家得自己记住。
   * 现在只读 `containers.formationDrawOutcomes`（方向：`setup` → `containers`，不反向 import ⇒ 不成环），
   * 在初设面板的「编制抽取」段如实显示：抽中了谁、本组处置是什么、（西移组的）落点在哪。
   */
  const formationDrawNotes = computed(() =>
    containers.formationDrawOutcomes.map((row) => ({
      groupKind: row.groupKind,
      groupLabel: row.groupLabel,
      formations: [...row.formationIds],
      detail: row.detail,
      destinations: row.destinations.map((item) => `${item.formationId} → ${item.hexText}`),
    })),
  )

  /** 该方已落位的飞机数（飞机初设的完成度判据） */
  function airPlacedCount(side: Side): number {
    return workbench.airUnits.filter((air) => air.side === side).length
  }

  /** 该方飞机条目是否都已落位 */
  function airDone(side: Side): boolean {
    const planSide = airPlanOf(side)
    if (planSide === null) return false
    const required = planSide.placements.reduce((sum, row) => sum + row.count, 0)
    return required > 0 && airPlacedCount(side) >= required
  }

  /**
   * 各步骤的完成度（供界面打勾；编制抽取的完成度**取自 C12 的剧本抽取盒账本**，不另立一份）
   */ const stepDone = computed<Record<string, boolean>>(() => {
    const source = scenarios.scenarios.find((item) => item.id === scenarioId.value)
    // 编队抽签的池与组取自**初设源**（1–2 / 3–4 / 5–6 共用初设）；账本取自 C12 的剧本抽取盒
    const sourceId = setupSourceOf(scenarioId.value).source
    const groups =
      scenarios.scenarios.find((item) => item.id === sourceId)?.setup.formationDraw?.groups ?? []
    const drawn = [
      ...(containers.drawResults[scenarioId.value] ?? []),
      ...(containers.drawResults[sourceId] ?? []),
    ]
    const selfTotal = selfChoiceEntries.value.length
    const selfPlaced = Object.keys(completed.value).filter((key) => key.startsWith('self:')).length
    return {
      scenario: source !== undefined,
      formationDraw: groups.every((group) => drawn.some((row) => row.kind === group.kind)),
      truckLoad: completed.value['truckLoad'] === true,
      spOwnership: completed.value['spOwnership'] === true,
      autoSetup: completed.value['autoSetup'] === true,
      airSetup: airDone('axis') && airDone('soviet'),
      selfSetup: selfTotal === 0 || selfPlaced >= selfTotal,
    }
  })

  /* ────────────────────────────── 动作 ────────────────────────────── */

  /** 记一次结论（成功/失败都留痕，失败带原因码） */
  function record(outcome: {
    ok: boolean
    rule: string
    reason?: string
    data?: { detail?: string }
  }): boolean {
    if (outcome.ok) {
      lastAction.value = { ok: true, rule: outcome.rule, detail: outcome.data?.detail ?? '' }
      workbench.pushLog('success', lastAction.value.detail, outcome.rule)
      return true
    }
    lastAction.value = { ok: false, rule: outcome.rule, detail: outcome.reason ?? '' }
    workbench.pushLog(
      'warning',
      `初设被拒（${outcome.rule}）：${outcome.reason ?? ''}`,
      outcome.rule,
    )
    return false
  }

  /**
   * 剧本选择（第一步；★ 全程序**唯一的剧本入口**）
   *
   * 用户口径：
   *   · 「选择了剧本就立刻自动初设」固定格号 / 死亡堆 / 多点位那些「无需玩家定夺」的单位；
   *   · 「剧本选择要绑定，留一个就行」⇒ 剧本号只写**一处**（会话 store，`game.setScenarioId`），
   *     操作台 / 容器抽取盒 / 本面板三处读的是**同一份投影**（见各自 `scenarioId` 的说明），
   *     故不存在「盘面是剧本 3、会话还是剧本 1」这类错配。
   *
   * 本函数剩下要做的两件事：① 让「随剧本重取的账本」跟着重取（操作台换轨 / 补给缓存 / 胜利格等
   * 与抽取盒的天气标记）；② 清盘面后自动落盘固定初设（不叠加、不残留上一剧本的算子）。
   */
  function selectScenario(next: string): boolean {
    // B50：换剧本 ⇒ SP 归属整套重来（默认归属的"填过就记账"也一并清空）
    defaultFilledIds.value = new Set()
    // 会话已开局时换剧本会被拒（2.2：避免流程与剧本错配）⇒ 原样报因，不改动任何一侧
    if (!game.setScenarioId(next)) {
      return record({
        ok: false,
        rule: game.error?.rule ?? '2.2',
        reason: game.error?.reason ?? 'scenarioLockedWhilePlaying',
      })
    }
    // 随剧本重取的账本（剧本号本身已由上一步写定，这里是各自的投影刷新）
    workbench.setScenarioId(next)
    containers.setScenario(next)
    resetInputs()
    lastAction.value = null
    notes.value = []
    placing.value = null
    finished.value = false
    // 第六批条 1（S1）：换剧本 ⇒ 分方游标按**新剧本的先布设方**重开
    armSetupSideCursor()
    cancelTruckPick()
    // 换剧本 = 重新开局 ⇒ 先清盘面，再自动落盘固定初设（不叠加、不残留上一剧本的算子）
    resetAll()
    runAutoSetup()
    /*
     * ★ 第六批 §6-A：**编队抽签在初设自动跑**（ch10「Formation Chit Draw」/ ch11 的剧本随机化
     *   都是**开局前**的随机化，不是 B 增援段的动作）。
     *   必须在 `runAutoSetup()` **之后**：三项处置（进死亡堆 / 转 Move Mode / Mtr↔Aufk 互换）
     *   改的是**盘上那几枚算子**，而实例 id 是自动初设这一步生成的。
     */
    runSetupDraws()
    return true
  }

  /**
   * ch10 / ch11：**初设自动抽签**（用户 2026-10-25 口径：「初设里的德军抽取编队放置或替换单位，
   * 应该放在初设时自动抽取后给玩家初设」）
   *
   * 判据与落盘全在容器 store（`containers.runSetupDrawsNow`），本处只负责：
   * 把结论写进本流程的回执与提示，并如实报失败（不静默）。
   */
  function runSetupDraws(): boolean {
    const result = containers.runSetupDrawsNow()
    if (result.drawnGroups === 0) return true // 本剧本没有编队抽签 ⇒ 不算错
    /*
     * ★ 成功时**不覆盖** `lastAction`：紧接着自动初设之后跑，那条回执（棋子数 / SP /
     *   卡车按剧本落账）正是玩家要看的"选剧本后发生了什么"，被抽签结论顶掉就看不见了
     *   （实测：`setup-truck-autoload-flow` 的"编内卡车按剧本自动落账"曾因此丢失）⇒
     *   抽签结论进 `notes`（面板的「数据缺口与提示」里逐条列出）。
     *   失败则**必须**顶上来写 `lastAction`：规则没落实是玩家该立刻看见的事。
     */
    notes.value = [...notes.value, result.detail]
    if (result.pendingShift.length > 0) {
      notes.value = [
        ...notes.value,
        `ch10 西移：${result.pendingShift.join('、')} 的落点＝沿道路从所列位置西移 N 格（ch10 写 3 格，例 11.03 → 9.01）⇒ 在「初设单位 box」的「地面单位与基地」里点一项、再点地图给落点`,
      ]
    }
    if (!result.ok) {
      return record({ ok: false, rule: 'ch10 / ch11', reason: result.detail })
    }
    return true
  }

  /** 清空本流程的玩家输入（不改盘面） */
  function resetInputs(): void {
    applied.value = false
    selfChoices.value = {}
    truckFullIds.value = []
    spAssignments.value = {}
    spDumps.value = []
    // 12.1b：账本是初设 SP 的用账之处 ⇒ 重置必须一并清空，否则旧剧本的补给站会残留
    workbench.clearSpDumps('初设输入重置')
    airChoices.value = {}
    completed.value = {}
  }

  /** 重置（含盘面：清空算子与飞机） */
  function resetAll(): void {
    workbench.units.splice(0, workbench.units.length)
    workbench.airUnits.splice(0, workbench.airUnits.length)
    workbench.deadPile.splice(0, workbench.deadPile.length)
    resetInputs()
  }

  /**
   * 首次进入对局台时按**当前剧本**自动做一次初设（进入页面即有盘面）
   *
   * 幂等：已落盘（`applied`）或已收束（`finished`）或盘上已有算子时一律跳过，
   * 故重复挂载 / 视图来回切换都不会叠加算子。
   */
  function ensureSetupLoaded(): boolean {
    if (applied.value || finished.value) return false
    if (workbench.units.length > 0 || workbench.airUnits.length > 0) return false
    return selectScenario(scenarioId.value)
  }

  /**
   * 剧本选择项（B10：前置「剧本 + 共识」视图的列表）
   *
   * 只做**投影**：名称与数值全部来自 `scenarios.json`，本处不解释、不改写。
   * 放在 store 里是为了让"选剧本"这件事只有一处口径（前置视图与操作台面板共用）。
   */
  const scenarioChoices = computed<readonly ScenarioChoice[]>(() =>
    scenarios.scenarios.map((item) => ({
      id: item.id,
      name: item.name,
      turns: item.turns,
      firstTurn: item.firstTurn,
      lastTurn: item.lastTurn,
      firstPlayer: item.firstPlayer,
      /** 与哪个剧本共用初设（共享初设的剧本只是回合范围不同，盘面同源） */
      sharedSetupWith: item.sharedSetupWith ?? [],
      /** 本剧本页是否自带初设（无初设页 ⇒ 用 `sharedSetupWith` 那一份） */
      hasSetup: item.hasSetup === true,
      /** 是否就是当前选中的剧本 */
      selected: item.id === scenarioId.value,
    })),
  )

  /**
   * 进入初设（B10：前置视图的「进入游戏」）
   *
   * 语义＝「按下这个按钮后，盘面应当已经是**这个剧本**的固定初设」：
   *   · 换了剧本 ⇒ `selectScenario`（清盘 + 按新剧本重跑自动初设，这是唯一会清盘的路径）；
   *   · 还是同一剧本 ⇒ 只保证"已加载"（`ensureSetupLoaded` 幂等）——
   *     **不重复清盘**，否则玩家从对局台退回前置视图再进来，初设进度就被抹掉了。
   *
   * ★ 这里**不建会话、不进 Pre-Turn**：进入游戏界面只是"开始初设"（用户口径⑨）；
   *   开局（写共识结论 + 建会话 + 进第一阶段）仍由初设收束时的「开始游戏」负责（`startGameNow`）。
   */
  function enterSetup(id: string): boolean {
    if (id !== scenarioId.value) return selectScenario(id)
    ensureSetupLoaded()
    return true
  }

  /** 取格子文本 → 坐标（无效即 null） */
  function hexOf(text: string): HexRef | null {
    return parseSetupHexText(text)
  }

  /**
   * 计数类非战斗单位 → 盘面算子（12.1c 通用 dump / 13.2 运输点：按面额拆算子）
   *
   * 面额一律取自算子库（SP 有 1/2/3/4/5/10/15；运输点有 1..5 且 `splittable`）；
   * 拆不出面额即**如实记缺口**，不硬塞一枚面额不符的算子。
   * SP 同时产出 `12.1d` 的归属台账（归属＝带上图的一方）。
   */
  function countersFor(input: {
    kind: string
    count: number
    hex: HexRef
    hexText: string
    side: Side
    transportKind: 'truck' | 'wagon' | null
    level: number | null
  }): { units: ConsoleUnit[]; dump: SupplyDumpRef | null; notes: string[] } {
    const units: ConsoleUnit[] = []
    const notes: string[] = []
    const place = (recordUnit: ReturnType<typeof findSpRecord>): void => {
      if (recordUnit === undefined) return
      units.push(
        toConsoleUnit({
          record: recordUnit,
          instanceId: createId('u'),
          hex: { ...input.hex },
          side: input.side,
        }),
      )
    }

    if (input.kind === 'sp') {
      const values = breakdownCounterValues(input.count, spDenominations())
      if (values === null) {
        notes.push(`${input.count} SP @ ${input.hexText} 拆不出面额 ⇒ 未落位`)
        return { units, dump: null, notes }
      }
      for (const value of values) place(findSpRecord(value))
      return {
        units,
        notes,
        dump: {
          id: `sp:${input.hexText}`,
          hex: { ...input.hex },
          side: input.side,
          points: input.count,
        },
      }
    }

    if (input.kind === 'transport_point') {
      const kind = input.transportKind ?? 'truck'
      const values = breakdownCounterValues(input.count, transportDenominations(input.side, kind))
      if (values === null) {
        notes.push(`${input.count} ${kind} Point(s) @ ${input.hexText} 拆不露面额 ⇒ 未落位`)
        return { units, dump: null, notes }
      }
      for (const value of values) place(findTransportRecord(input.side, kind, value))
      return { units, dump: null, notes }
    }

    // 空军基地（13.8d：每格至多 1 座；等级取自剧本页原文）
    const airbase = findAirbaseRecord(input.level ?? 1)
    if (airbase === undefined) {
      notes.push(`空军基地等级 ${input.level} @ ${input.hexText} 在算子库里找不到 ⇒ 未落位`)
      return { units, dump: null, notes }
    }
    place(airbase)
    return { units, dump: null, notes }
  }

  /**
   * 自动初设（专规 Setup Notes + 通规 IV）
   *
   * 把剧本页里**已定格**的战斗单位与非战斗单位逐条落位：
   *   · 棋子按 `unitId` 配子（含编队下属展开、减损、Move Mode 面）；
   *   · 死亡堆条目直接进 `deadPile`（13.5）；
   *   · SP / 运输点 / 空军基地按面额拆成算子摆放（12.1c 通用 dump / 13.2 运输点）；
   *   · 自由项（`w/i X` / 任一指挥部 / 任意空军基地）**不在此落位**，留到下一步由玩家定夺。
   */
  function runAutoSetup(): boolean {
    const outcome = planAutoSetup({
      scenarioId: scenarioId.value,
      facts: {
        hqHexes: [...hqHexesOf('axis'), ...hqHexesOf('soviet')],
        airBaseHexes: [...airBaseHexesOf('axis'), ...airBaseHexesOf('soviet')],
      },
    })
    if (!outcome.ok) return record(outcome)
    const built = outcome.data

    const placedUnits: ConsoleUnit[] = []
    const deadPileUnits: ConsoleUnit[] = []
    const notesLocal: string[] = []
    const skippedAircraft: string[] = []

    // ① 棋子（地面算子；飞机另有 14.1a 的落位步骤）
    for (const piece of built.pieces) {
      if (piece.unitId === null) continue
      if (piece.unitIdKind === 'aircraft') {
        // 死亡堆里的飞机（13.5）：记入手册，不落到地面算子堆
        skippedAircraft.push(`${piece.name}（${piece.toDeadPile ? '死亡堆' : '待飞机初设'}）`)
        continue
      }
      const recordUnit = findUnitRecord(piece.unitId)
      if (recordUnit === undefined) {
        notesLocal.push(`算子库找不到 ${piece.unitId}（条目「${piece.name}」）⇒ 未落位`)
        continue
      }
      const hex = piece.hex ?? { col: 0, row: 0 }
      const unit = toConsoleUnit({
        record: recordUnit,
        instanceId: createId('u'),
        hex,
        side: piece.side,
        ...(piece.face === 'move' ? { face: 'move' as const } : {}),
      })
      if (piece.steps !== null) unit.steps = piece.steps
      if (piece.toDeadPile) deadPileUnits.push(unit)
      else placedUnits.push(unit)
    }

    // ② 计数类非战斗单位（SP / 运输点 / 空军基地）：按面额拆算子
    const ledgerUnits: ConsoleUnit[] = []
    const dumps: SupplyDumpRef[] = []
    for (const row of built.ledger) {
      const built2 = countersFor({
        kind: row.kind,
        count: row.count,
        hex: row.hex,
        hexText: row.hexText,
        side: row.side,
        transportKind: row.transportKind,
        level: row.level,
      })
      ledgerUnits.push(...built2.units)
      notesLocal.push(...built2.notes)
      if (built2.dump !== null) dumps.push(built2.dump)
    }

    workbench.units.push(...placedUnits, ...ledgerUnits)
    workbench.deadPile.push(...deadPileUnits)
    spDumps.value = dumps
    // 12.1b / 12.1c：初设的 SP 位置就是补给站 ⇒ 整批落进 workbench 账本（整备付款、战斗补给、
    // 12.3a 拖取与追溯重判都读那本账；不落账就会出现「地图上有 SP 却付款补 0 处」）
    workbench.landSetupSpDumps(dumps)
    // 3.4b / Setup Note F：轴方 dump 的装甲集群**默认按分界线填好**（玩家不用逐个点名，仍可改）
    fillDefaultPanzerGroups(dumps)
    /*
     * 13.2h / 通规 IV-D / 专规 Setup Note C：**剧本页明示"全部满载 / 全部空载"时不由玩家决定**
     * ⇒ 初设当场按剧本把 `loadedSpT` 落盘。
     *
     * ★ 修前只有两个界面按钮能触发 `designateTrucks`（`DecisionQueue.vue` / `SetupPanel.vue`），
     *   而这类剧本的卡车**不进决策队列**（`decisionQueue` 只在 `choose_loaded` 时列它们）
     *   ⇒ 玩家不点那个按钮，剧本 1 的 12 辆车 `loadedSpT` 全是 0；而燃料来源只收 `loadedSpT > 0`
     *   （12.1b「含 SP 的位置即补给站」）⇒ **「编队从编队卡车加油」候选为空**（用户 2026-09-17 夜报的卡死路径）。
     *   现在"数据说全满载"与"账本里真有 SP"从此一致，且**不依赖任何玩家动作**。
     */
    let truckNote: string | null = null
    if (truckLoadMode.value === 'all_loaded' || truckLoadMode.value === 'all_unloaded') {
      const truckCount = setupTrucks.value.length
      const fullCount = effectiveFullTruckIds.value.length
      const ok = designateTrucks()
      truckNote = ok
        ? `编内卡车按剧本自动落账：${truckCount} 辆中满载 ${fullCount} 辆（13.2h 满载面记「运力 + F」）`
        : `编内卡车未能按剧本自动落账：${lastAction.value?.detail ?? '原因未知'}（请在对局前核对）`
      notesLocal.push(truckNote)
    }
    applied.value = true
    completed.value = { ...completed.value, autoSetup: true }
    notes.value = [
      ...built.dataGaps,
      ...notesLocal,
      ...(skippedAircraft.length > 0
        ? [
            `死亡堆/待定的飞机条目 ${skippedAircraft.length} 条：${skippedAircraft.join('、')}（13.5 / ${AIR_BASE_SITE_RULE}）`,
          ]
        : []),
    ]
    return record({
      ok: true,
      rule: outcome.rule,
      data: {
        detail:
          `自动初设落盘（剧本 ${scenarioId.value}，初设源剧本 ${built.source.source}）：` +
          `棋子 ${placedUnits.length} 枚 + 计数算子 ${ledgerUnits.length} 枚（SP ${dumps.length} 处）+ 死亡堆 ${deadPileUnits.length} 枚；` +
          `${built.choices.length} 条自由项留待玩家定夺` +
          (truckNote === null ? '' : `；${truckNote}`),
      },
    })
  }

  /** 玩家自定义初设：把一条自由项**整条**落到指定格（IV-A / IV-I 校验在引擎） */
  function placeSelfEntry(entryIndex: number, targetOverride?: HexRef): boolean {
    return placeSelfInternal(entryIndex, targetOverride, 'all')
  }

  /**
   * 落**一枚**（B11；同型多枚时可分放不同格——备忘 #2）
   *
   * 棋子类条目（`unit` / `hq` / `extender`）且 `count > 1`（如「2x 26-1-1 Arty Bde」）时：
   * 每次只落一枚，落满才记完成。**只在地图点选路径使用**；`placeSelfEntry`（面板整条落位）保持原语义。
   */
  function placeSelfOneInstance(entryIndex: number, hex: HexRef, chunk: number): boolean {
    return placeSelfInternal(entryIndex, hex, 'one', chunk)
  }

  /**
   * 落位的**唯一实现**（`placeSelfEntry` 与 `placeSelfOneInstance` 共用）
   *
   * @param mode `all` = 落完**剩余量**（面板按钮）；`one` = 只落 `chunk` 量（地图点选，可逐次分格）
   * @param chunk 仅 `one` 模式用：本次点地图要落多少（SP / 运输点）；棋子类恒为 1
   */
  function placeSelfInternal(
    entryIndex: number,
    targetOverride: HexRef | undefined,
    mode: 'all' | 'one',
    chunk = 1,
  ): boolean {
    const entry = entries.value.find((view) => view.index === entryIndex)
    if (entry === undefined) {
      lastAction.value = { ok: false, rule: 'IV', detail: `条目 ${entryIndex} 不存在` }
      return false
    }
    const text = selfChoices.value[entryIndex]
    // 地图点选时直接给目标格；否则读输入框里的格号文本
    const target = targetOverride ?? (text === undefined ? null : hexOf(text))
    if (target === null) {
      lastAction.value = { ok: false, rule: 'IV-A', detail: `请先填写合法格号（列.行）` }
      return false
    }
    const outcome = planSetupPlacement({ entry, targetHex: target, facts: factsFor(entry.side) })
    if (!outcome.ok) return record(outcome)

    // 落盘：计数类条目按面额拆算子（SP / 运输点 / 空军基地）；棋子按 `unitId` 配子
    const placed: ConsoleUnit[] = []
    const notesLocal: string[] = []
    const total = selfInstanceTotalOf(entry)
    const placedBefore = selfPlacedOf(entryIndex)
    const remaining = Math.max(0, total - placedBefore)
    // `one` 模式只落一枚 ⇒ 让下面棋子类的 copies 循环只跑一次（从第 placed 枚开始）
    const copiesWanted = mode === 'one' && total > 1 ? 1 : null
    // 本次实际落多少（计数类按量；棋子类恒 1）；用于进度账本与 dump 合并
    let advancedBy = 0
    if (entry.kind === 'sp' || entry.kind === 'transport_point') {
      // 条 26（S4）：SP / 运输点**按量**落盘，可分多格；同格同方合并进同一 dump（账本逐格合一）
      const amount = mode === 'one' ? Math.max(1, Math.min(chunk, remaining)) : remaining
      if (amount <= 0) {
        return record({ ok: false, rule: outcome.rule, reason: 'nothingToPlace' })
      }
      const built = countersFor({
        kind: entry.kind,
        count: amount,
        hex: target,
        hexText: setupHexLabel(target),
        side: entry.side,
        transportKind: entry.kind === 'transport_point' ? setupTransportKindOf(entry.raw) : null,
        level: null,
      })
      placed.push(...built.units)
      notesLocal.push(...built.notes)
      advancedBy = amount
      if (built.dump !== null) {
        // ★ 同格同方可合并：取既有 dump 累加 points（id 不变＝`sp:格`，不触发 §5-C 全局重映射）
        const existing = spDumps.value.find(
          (item) => item.id === built.dump!.id && item.side === built.dump!.side,
        )
        if (existing === undefined) spDumps.value = [...spDumps.value, built.dump]
        else {
          spDumps.value = spDumps.value.map((item) =>
            item.id === built.dump!.id && item.side === built.dump!.side
              ? { ...item, points: item.points + built.dump!.points }
              : item,
          )
        }
        // 12.1b：初设落的 SP 必须同时进 workbench 账本 —— 那里才是「付款/拖取/追溯」的用账之处
        workbench.landSetupSpDumps(spDumps.value)
      }
    } else if (entry.kind === 'airbase') {
      const built = countersFor({
        kind: entry.kind,
        count: entry.count,
        hex: target,
        hexText: setupHexLabel(target),
        side: entry.side,
        transportKind: null,
        level: setupAirbaseLevelOf(entry.raw, entry.count),
      })
      placed.push(...built.units)
      notesLocal.push(...built.notes)
      advancedBy = 1
    } else {
      for (const piece of entry.pieces) {
        if (piece.unitId === null) continue
        const recordUnit = findUnitRecord(piece.unitId)
        if (recordUnit === undefined) continue
        const copies = copiesWanted ?? (entry.kind === 'formation' ? 1 : Math.max(entry.count, 1))
        for (let copy = 0; copy < copies; copy += 1) {
          const unit = toConsoleUnit({
            record: recordUnit,
            instanceId: createId('u'),
            hex: { ...target },
            side: entry.side,
            ...(entry.setupMode === 'move' ? { face: 'move' as const } : {}),
          })
          // IV-G：剧本明示的**初设减损**（-N step）在此扣除（与 `runAutoSetup` 同一口径）
          const penalty = entry.stepPenalty ?? 0
          if (penalty > 0) unit.steps = Math.max(unit.steps - penalty, 0)
          placed.push(unit)
        }
      }
      advancedBy = placed.length
    }
    workbench.units.push(...placed)
    notes.value = [...notes.value, ...notesLocal]
    selfChoices.value = { ...selfChoices.value, [entryIndex]: setupHexLabel(target) }
    // 进度：计数类按**量**递增；棋子类按枚递增；落满才记完成
    const after = Math.min(total, placedBefore + advancedBy)
    placedSelfInstances.value = { ...placedSelfInstances.value, [entryIndex]: after }
    if (after >= total) completed.value = { ...completed.value, [`self:${entryIndex}`]: true }
    return record({
      ok: true,
      rule: outcome.rule,
      data: {
        detail:
          `自定义初设：${entry.raw} ⇒ ${setupHexLabel(target)}（${outcome.data.freeChoice ? '自由项' : '按清单'}，` +
          `${entry.rule}）；落位 ${placed.length} 枚（进度 ${after}/${total}）` +
          `${(entry.stepPenalty ?? 0) > 0 ? `（IV-G 减损 -${entry.stepPenalty} step）` : ''}`,
      },
    })
  }

  /** 记录一条自由项的选择（只写输入，不落盘） */
  function setSelfChoice(entryIndex: number, hexText: string): void {
    selfChoices.value = { ...selfChoices.value, [entryIndex]: hexText }
  }

  /**
   * 卡车满载指定（通规 IV-C/D + 13.2h + 专规 Setup Note C）
   *
   * 剧本页明示「全部满载 / 玩家自选 N 辆满载 / 全部空载」⇒ 由引擎核对名单，本层只记名单与日志。
   * ★ 用户 2026-09-15 裁定：**编内卡车满载＝载 1 SP**（「编内卡车全部只有 1 点运力」，
   *   印值两面为 1F-45（满载）/ 1-45（空载））⇒ 本层据名单把 `loadedSpT` 落盘，
   *   算子的**面**随之自动切到满载面（13.2h 印法；选图在 `render/token-images`）。
   */
  function designateTrucks(): boolean {
    const full = effectiveFullTruckIds.value
    const outcome = planTruckFullLoad({
      scenarioId: scenarioId.value,
      trucks: setupTrucks.value,
      fullInstanceIds: full,
    })
    if (!outcome.ok) return record(outcome)
    // 13.2h + 用户 2026-09-15 裁定：满载＝载 1 SP，空载＝0（面随之切换，见 render/token-images）
    for (const truck of setupTrucks.value) {
      const unit = workbench.units.find((item) => item.instanceId === truck.instanceId)
      if (unit !== undefined) unit.loadedSpT = full.includes(truck.instanceId) ? SP_TO_T : 0
    }
    completed.value = { ...completed.value, truckLoad: true }
    return record(outcome)
  }

  /** 切换某辆卡车的满载标记（不校验，校验在 `designateTrucks`） */
  function toggleTruckFull(instanceId: string, full: boolean): void {
    const next = new Set(truckFullIds.value)
    if (full) next.add(instanceId)
    else next.delete(instanceId)
    truckFullIds.value = [...next]
  }

  /** 3.4b 在本局是否生效（剧本首回合早于 19 August × 共识采纳 4.1a 的可选项） */
  function panzerGroupRulesOn(): boolean {
    return panzerGroupRulesActive({
      constraintApplies: requiresPanzerGroupSpAssignment(scenarioId.value),
      agreedByConsensus: game.agreedOptionAdoptedOf(PANZER_GROUP_OPTION_ITEM),
    })
  }

  /**
   * 3.4b / Setup Note F：给**轴方** dump 按分界线填上**默认**装甲集群归属（玩家仍可改）
   *
   * ★ 两处调用：自动初设落 SP 之后；以及**确认归属划分之前**——玩家可能先选剧本、后勾共识
   *   （勾选列表与初设面板同属开局前），只挂在自动初设那一处就会漏掉这个顺序。
   * ★ 3.4b 未启用（共识未采纳）时**不填**：此时引擎会以「本剧本不适用」拒绝任何非空归属。
   */
  /**
   * 已经按分界线填过默认归属的 dump id（**每个 dump 只填一次**）
   *
   * ★ 为什么需要它：确认归属划分时会再补一次默认（应付"先选剧本、后勾共识"的顺序），
   *   但玩家**故意清掉**某个站的归属之后（`setSpAssignment(id, null)`）不该被补回来 ——
   *   "默认只是默认，不是不可改"。故用这份集合把"没填过"与"填过又清掉"分开。
   * 换剧本即清空（SP 归属整套重来）。
   */
  const defaultFilledIds = ref<Set<string>>(new Set())

  function fillDefaultPanzerGroups(
    dumps: readonly { id: string; side: Side; hex: HexRef }[],
  ): void {
    if (!panzerGroupRulesOn()) return
    const defaults: Record<string, SetupPanzerGroup> = { ...spAssignments.value }
    const filled = new Set(defaultFilledIds.value)
    let changed = false
    for (const dump of dumps) {
      if (dump.side !== 'axis') continue
      if (filled.has(dump.id)) continue
      filled.add(dump.id)
      changed = true
      if (defaults[dump.id] === undefined) defaults[dump.id] = defaultPanzerGroupOf(dump.hex)
    }
    if (!changed) return
    defaultFilledIds.value = filled
    spAssignments.value = defaults
  }

  /** 记一条 SP 的装甲集群归属（Setup Note F：分界线仅作参考，归属由玩家自定） */
  function setSpAssignment(dumpId: string, group: SetupPanzerGroup | null): void {
    const next = { ...spAssignments.value }
    if (group === null) delete next[dumpId]
    else next[dumpId] = group
    spAssignments.value = next
  }

  /** SP 归属划分（12.1d + Setup Note F + 3.4b）：核验后记完成 */
  function confirmSpOwnership(): boolean {
    // ★ 先补默认归属：玩家可能是在自动初设之后才把 3.4b 那条共识勾上的
    fillDefaultPanzerGroups(spDumps.value)
    const outcome = planSupplyOwnership({
      scenarioId: scenarioId.value,
      dumps: spDumps.value,
      assignments: spAssignments.value,
      // B50：3.4b 未启用（共识未采纳）⇒ 引擎不再要求逐一点名（`requires` 由两轴合成）
      agreedByConsensus: game.agreedOptionAdoptedOf(PANZER_GROUP_OPTION_ITEM),
    })
    if (!outcome.ok) return record(outcome)
    completed.value = { ...completed.value, spOwnership: true }
    return record(outcome)
  }

  /** 记录某型飞机选择的基地格（14.1a） */
  function setAirChoice(entryIndex: number, hexText: string): void {
    airChoices.value = { ...airChoices.value, [entryIndex]: hexText }
  }

  /**
   * 飞机初设（通规 IV-E + 14.1a + 剧本页明文）
   *
   * 每型必须选一个本方空军基地格；激活态与减损由引擎按剧本页给（`planAirSetup`），
   * 本层只把飞机摆上去（Active 在上面、Inactive 在下面由渲染层按 `airStatus` 表现）。
   */
  function runAirSetup(side: Side): boolean {
    const outcome = planAirSetup({ scenarioId: scenarioId.value, side, facts: factsFor(side) })
    if (!outcome.ok) return record(outcome)
    const built = outcome.data

    const placed: { air: ReturnType<typeof toConsoleAirUnit> }[] = []
    const notesLocal: string[] = []
    for (const row of built.placements) {
      const text = airChoices.value[row.entryIndex]
      const hex = text === undefined ? null : hexOf(text)
      if (hex === null) {
        notesLocal.push(`机型「${row.name}」尚未指定空军基地格 ⇒ 未落位（${AIR_BASE_SITE_RULE}）`)
        continue
      }
      if (
        !row.candidates.some((candidate) => candidate.col === hex.col && candidate.row === hex.row)
      ) {
        notesLocal.push(
          `机型「${row.name}」所选格 ${setupHexLabel(hex)} 不是本方空军基地格 ⇒ 未落位`,
        )
        continue
      }
      const recordAir = findAircraftRecord(row.aircraftId)
      if (recordAir === undefined) {
        notesLocal.push(`空军专表找不到 ${row.aircraftId} ⇒ 未落位`)
        continue
      }
      for (let index = 0; index < row.count; index += 1) {
        const air = toConsoleAirUnit({
          aircraft: recordAir,
          instanceId: createId('a'),
          hex: { ...hex },
          side,
          airStatus: row.statuses[index] ?? 'inactive',
        })
        air.steps = row.steps[index] ?? air.steps
        placed.push({ air })
      }
    }

    workbench.airUnits.push(...placed.map((item) => item.air))
    notes.value = [...notes.value, ...built.dataGaps, ...notesLocal]
    return record({
      ok: true,
      rule: outcome.rule,
      data: {
        detail:
          `飞机初设（${side === 'axis' ? '轴心国' : '苏联'}）：落位 ${placed.length} 架；` +
          `剧本页政策 ${built.policy.policy}（${built.policy.statedInRules ? '明文' : '按 IV-E 默认'}）`,
      },
    })
  }

  /* ────────────────────────────── 算子库查询（面额/基地） ────────────────────────────── */

  /** 全部 SP 面额（取自算子库，不写死） */
  function spDenominations(): number[] {
    return [...unitsAxis.units, ...unitsSoviet.units]
      .filter((unit) => unit.noncombatKind === 'sp')
      .map((unit) => unit.noncombatDetails?.spValue ?? 0)
  }

  /** 该方该类运输点的可用面额（取自算子库） */
  function transportDenominations(side: Side, kind: 'truck' | 'wagon'): number[] {
    return unitsFor(side)
      .filter(
        (unit) =>
          unit.noncombatKind === 'transport_point' && unit.noncombatDetails?.transportKind === kind,
      )
      .map((unit) => unit.noncombatDetails?.transport ?? 0)
  }

  /** 按方取算子库 */
  function unitsFor(side: Side) {
    return side === 'axis' ? unitsAxis.units : unitsSoviet.units
  }

  /** 找指定面额的 SP 算子 */
  function findSpRecord(value: number) {
    return [...unitsAxis.units, ...unitsSoviet.units].find(
      (unit) => unit.noncombatKind === 'sp' && unit.noncombatDetails?.spValue === value,
    )
  }

  /** 找指定方 / 类别 / 面额的运输点算子 */
  function findTransportRecord(side: Side, kind: 'truck' | 'wagon', value: number) {
    return unitsFor(side).find(
      (unit) =>
        unit.noncombatKind === 'transport_point' &&
        unit.noncombatDetails?.transportKind === kind &&
        unit.noncombatDetails?.transport === value,
    )
  }

  /** 找指定等级的空军基地算子 */
  function findAirbaseRecord(level: number) {
    const all = [...unitsAxis.units, ...unitsSoviet.units]
    return (
      all.find(
        (unit) => unit.noncombatKind === 'air_base' && unit.noncombatDetails?.level === level,
      ) ?? all.find((unit) => unit.noncombatKind === 'air_base')
    )
  }

  return {
    // 状态
    scenarioId,
    applied,
    selfChoices,
    truckFullIds,
    spAssignments,
    spDumps,
    airChoices,
    completed,
    lastAction,
    notes,
    // 派生
    entries,
    flow,
    plan,
    stepDone,
    dataGaps,
    setupTrucks,
    selfChoiceEntries,
    choicesOf,
    candidatesOf,
    spDumpsOf,
    airPlanOf,
    airPlacedCount,
    airDone,
    allDone,
    // 批 E 切片 2：抽签结果**回写初设**（只读 C12 抽取盒的落盘台账；用户 9.17③a）
    formationDrawNotes,
    // B11：待你决定的队列（四堆叠）与逐枚落位
    placementProgress: placedSelfInstances,
    placedSelfInstances,
    placedAirInstances,
    placeSelfOneInstance,
    decisionQueue,
    truckDecisions,
    truckLoadMode,
    effectiveFullTruckIds,
    // 13.2h / IV-D：装载模式的界面口径（`automatic` ⇒ 只读回执，不给勾选）
    truckLoadSummary,
    requiredFullTrucks,
    // 第六批条 2（S2）：卡车装载的**地图点选**（去掉卡片勾选与核验按钮）
    truckPickActive,
    truckPickRows,
    truckPickHexes,
    beginTruckPick,
    cancelTruckPick,
    pickTruckAtHex,
    // 第六批条 1（S1）：分方游标（先布设方在前）与按方过滤的队列
    setupFirstSide,
    setupSideCursor,
    setupSideConfirmed,
    armSetupSideCursor,
    confirmSideSetup,
    sidePendingCount,
    sideQueue,
    // 初设 box（地图点选放置）
    placing,
    pendingPlacement,
    finished,
    beginSelfPlacement,
    beginAirPlacement,
    // 第六批 §6-A：ch10 西移编队的落点（抽签抽中的师，与自由项并列进初设 box）
    beginShiftPlacement,
    cancelPlacement,
    placeAtHex,
    setPlacingChunk,
    placingChunkChoices,
    finishSetup,
    startGameNow,
    // B10：前置「剧本 + 共识」视图
    scenarioChoices,
    enterSetup,
    // 动作
    selectScenario,
    ensureSetupLoaded,
    resetInputs,
    resetAll,
    runAutoSetup,
    // 第六批 §6-A：初设时的**自动编队抽签**（ch10 / ch11 属开局前的剧本随机化）
    runSetupDraws,
    setSelfChoice,
    placeSelfEntry,
    toggleTruckFull,
    designateTrucks,
    setSpAssignment,
    confirmSpOwnership,
    setAirChoice,
    runAirSetup,
  }
})
