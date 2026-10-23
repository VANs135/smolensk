import {
  aircraft,
  markers,
  rulesConstants,
  scenarioSetup,
  scenarios,
  unitsAxis,
  unitsSoviet,
} from '@/data'
import type { DeepReadonly, HexRef, ScenarioAirSetupPolicy, SetupEntry, Side } from '@/data'

import { hexDistance, hexesWithin, isOnMap, sameHex } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import type { AirStatus } from '../state-types'
import { DEAD_PILE_RULE } from './containers'
import { isWithinStackingLimit } from './movement'
import { isPanzerGroupConstraintLifted } from './timing'
import { panzerGroupRulesActive } from './panzer-groups'
import { scenarioTurnRange } from './victory'

/**
 * 初设与开局流程（W7 C14）
 *
 * ## 这一层做什么
 *   把「开局前双方按剧本页逐格摆放」这件事变成可查看、可校验、可落盘的**计划**：
 *     · **剧本选择**：定剧本，并解出该剧本的**初设源**（剧本 1–2 / 3–4 / 5–6 共用初设，见 `inherits`）；
 *     · **编制抽取**：编队抽签（ch10 / ch11）——抽签本身在 C12 的剧本抽取盒里做，
 *       本模块只把「抽中后的处置」（西移 / Move Mode / Mtr↔Aufk / Krd·Aufk 入死亡堆）
 *       译成落盘参数（`face: 'move'`、死亡堆投放等），供状态层执行；
 *     · **卡车满载指定**：建制内卡车（organic truck）开局「满载 / 空载」由剧本页明示（Setup Note C）；
 *     · **SP 归属划分**：地图内 SP 的归属（12.1d）+ 轴方 SP 须归属某装甲集群（Setup Note F / 3.4b）；
 *     · **自动初设**：按剧本页逐格清单把**战斗单位与非战斗单位**逐条落位（只按数据里的显式
 *       算子链接 `unitId` 落子，**不靠名字猜**）；
 *     · **玩家自定义初设**：剧本页留给玩家的自由项——「w/i X hexes（指定格若干格内）」
 *       「Stacked with any … HQs（任一指挥部同格）」「At any air bases（任意空军基地）」；
 *     · **飞机初设**：位置（与空军基地同格）+ 初始激活态 + `*` 减损机型。
 *
 * ## 规则依据（逐条落字符串，CODE_SPEC §3.6）
 *   - **通规 IV Set Up Notes**：A（`w/i X` 定义、堆叠可在半径内散开）、C（与 SP 同堆叠的运输点可
 *     满载/空载；未与 SP 同堆叠者一律空载，除剧本另述）、D（建制内卡车**只有剧本明示**才满载）、
 *     E（飞机默认 Active）、F（不得超堆叠）、G（默认满编，剧本注记的减损为例外）、
 *     H（范围含边界）、I（不得设于按常规移动无法进入的格）、J（单位/编队标记/HQ 一律 unfueled）、
 *     K（死亡堆与增援用索引卡）；
 *   - **专规 Setup Notes**：A（剧本指定首回合天气与布设/先动方）、C（剧本页说明卡车空/满）、
 *     D（`w/i X` 的多军力单位可部署拆分单位）、F（开局地图内 SP 须在初设期归属装甲集群）；
 *   - **12.1d**（SP 归属：谁带上图即谁拥有，缴获另按 9.14b）、**3.4b**（轴方 SP 均分与归属）、
 *     **13.2h**（满载面记法「F」）、**14.1a**（飞机与空军基地同格、Active/Inactive 两态）、
 *     **13.5**（死亡堆）。
 *
 * ## 硬纪律（不得无中生有）
 *   1. 一切条目来自 `scenario-setup.json`（1155 条，源库逐格清单），**不自行编造位置**；
 *   2. 棋子落位只认条目里的 `unitId` 链接（Z2 建立）；链接缺失或放置方式不认识的条目
 *      **原样记入 `dataGaps`**，不猜不补；
 *   3. 事实靠注入：本方 HQ 格、空军基地格、格内既有 RE、可进入性判定由调用方给出
 *      （引擎不持盘面，CODE_SPEC §2）；缺事实时**只报缺口**，不代替玩家决定；
 *   4. 本模块**不掷骰**（编队抽签的随机性在 C12 的抽取盒里用 `engine/rng.ts` 完成）、
 *      **不写状态**（产出计划，落盘在 store）。
 */

/* ────────────────────────────── 规则出处常量 ────────────────────────────── */

/** 通规「IV Set Up Notes」（初设通则） */
export const SETUP_RULE = 'IV'
/** 专规「Setup Notes」（剧本级初设注记） */
export const SETUP_NOTES_RULE = 'Setup Notes'
/** 通规 IV-A：`w/i X` 的含义（在给定位置**或**其 X 格内；堆叠可在半径内散开） */
export const WITHIN_RULE = 'IV-A'
/** 通规 IV-C/D：运输点与建制内卡车的初始载荷 */
export const LOAD_RULE = 'IV-C'
/** 通规 IV-E：飞机默认 Active */
export const AIR_ACTIVE_RULE = 'IV-E'
/** 通规 IV-F：不得超堆叠初设 */
export const STACKING_RULE = 'IV-F'
/** 通规 IV-I：不得设于常规移动无法进入的格 */
export const ENTERABILITY_RULE = 'IV-I'
/** 专规 1.4a / 14.1a：飞机与空军基地同格 */
export const AIR_BASE_SITE_RULE = '14.1a'
/** 12.1d：SP 归属 */
export const SP_OWNERSHIP_RULE = '12.1d'
/** 3.4b + Setup Note F：轴方 SP 须归属装甲集群 */
export const PANZER_GROUP_SP_RULE = '3.4b'
/** 13.2h：满载面记法 */
export const TRUCK_LOAD_RULE = '13.2h'

/** 装甲集群（3.4）：轴方 SP 归属的两选一 */
export const SETUP_PANZER_GROUPS = ['guderian', 'hoth'] as const
export type SetupPanzerGroup = (typeof SETUP_PANZER_GROUPS)[number]

/* ────────────────────────────── 放置类别 ────────────────────────────── */

/**
 * 放置类别（由数据里的 `placementType` 中文文案映射而来，映射不了即 `unknown`）
 *
 * 文案全集（源库 `placement_note.kinds` 与逐条 `placement_type`）：
 *   固定格号 / 固定格号（±1 格，带 †）/ 多点位（每处各一份）/ 死亡堆 /
 *   自由放置（任一指挥部同格）/ 自由放置（任意空军基地）/
 *   条件放置（指定格附近若干格内）/ 空军机队（按空军基地部署，初设不标具体格）/ 未标位置
 */
export const SETUP_PLACEMENT_KINDS = [
  /** 固定格号：按印刷格号落位 */
  'fixed',
  /** 固定格号（±N 格，带 †）：在所列位置 N 格内（IV-A / 剧本 3–7 的 † 注记） */
  'fixedTolerant',
  /** 多点位（每处各一份）：所列每个格各一份 */
  'multiHex',
  /** 死亡堆（13.5） */
  'deadPile',
  /** 自由放置（任一指挥部同格）：须与某一个本方 HQ 同格 */
  'anyHq',
  /** 条件放置（指定格附近若干格内）：`w/i X hexes of …` */
  'radius',
  /** 自由放置（任意空军基地）：非飞机条目也可能出现（本作仅飞机） */
  'airbaseFree',
  /** 空军机队：按空军基地部署，初设不标具体格（14.1a） */
  'airFleet',
  /** 未标位置 / 未识别文案 ⇒ 记缺口 */
  'unknown',
] as const
export type SetupPlacementKind = (typeof SETUP_PLACEMENT_KINDS)[number]

/** 该放置类别是否**可由引擎直接落位**（无需玩家定夺） */
const AUTOMATIC_PLACEMENTS: readonly SetupPlacementKind[] = [
  'fixed',
  'fixedTolerant',
  'multiHex',
  'deadPile',
]

/** 该放置类别需要**玩家在候选格里选** */
export const CHOICE_PLACEMENTS: readonly SetupPlacementKind[] = [
  'anyHq',
  'radius',
  'airbaseFree',
  'airFleet',
]

/** 计数类条目（不指向具体棋子，按「类型 + 格号 + 数量」记录） */
const COUNT_KINDS = ['sp', 'transport_point', 'airbase'] as const
type CountKind = (typeof COUNT_KINDS)[number]

/* ────────────────────────────── 文案 → 类别/半径 ────────────────────────────── */

/** 数据层条目是深度只读的（`bootstrapData` 冻结），故入参一律按只读取用 */
type EntryRow = DeepReadonly<SetupEntry>

/**
 * 印刷格号文本（`列.行`，行补零两位：`2.02` / `34.17`）
 *
 * 仅用于失败详情与账本的可读性；业务坐标一律 `{ col, row }`（CODE_SPEC §4）。
 */
export function setupHexLabel(hex: HexRef): string {
  return `${hex.col}.${String(hex.row).padStart(2, '0')}`
}

/** `setupHexLabel` 的逆：`'2.02'` → `{ col: 2, row: 2 }`；不合法返回 null */
export function parseSetupHexText(text: string): HexRef | null {
  const match = /^\s*(\d+)\s*\.\s*(\d+)\s*$/.exec(text)
  if (match?.[1] === undefined || match[2] === undefined) return null
  return { col: Number(match[1]), row: Number(match[2]) }
}

/** `placementType` 中文文案 → 放置类别（顺序敏感：先判带括号的细分，再判大类） */
export function setupPlacementOfText(placementType: string): SetupPlacementKind {
  const text = placementType.trim()
  if (text.startsWith('固定格号') && text.includes('†')) return 'fixedTolerant'
  if (text.startsWith('固定格号')) return 'fixed'
  if (text.startsWith('多点位')) return 'multiHex'
  if (text.startsWith('死亡堆')) return 'deadPile'
  if (text.startsWith('条件放置')) return 'radius'
  if (text.includes('任一指挥部同格')) return 'anyHq'
  if (text.includes('任意空军基地')) return 'airbaseFree'
  if (text.includes('空军机队')) return 'airFleet'
  return 'unknown'
}

/**
 * 「w/i X」的 X（格数）；解析不出即 null
 *
 * 原文写法（剧本页与容差注记）：
 *   `w/i 3 hexes of 34.17 or 34.18`（Setup Note D 的 w/i 定义见 IV-A）、
 *   `Axis divisions marked with a cross (†) can setup within 1 hex of the listed location`、
 *   `listed ±1 hex`。
 */
export function parseSetupRadius(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const patterns = [/w\/i\s+(\d+)\s*hex/i, /within\s+(\d+)\s*hex/i, /±\s*(\d+)\s*hex/i]
  for (const pattern of patterns) {
    const match = pattern.exec(raw)
    if (match?.[1] !== undefined) {
      const value = Number(match[1])
      if (Number.isInteger(value) && value >= 0) return value
    }
  }
  return null
}

/* ────────────────────────────── 剧本初设源 ────────────────────────────── */

/** 该剧本的初设源（1–2 / 3–4 / 5–6 共用初设） */
export interface SetupSource {
  scenarioId: string
  source: string
  via: 'own' | 'inherits' | 'shared'
  detail: string
}

/** 条目里出现过的剧本号（源库只有 1/3/5/7 有初设条目） */
function entryScenarioIds(): readonly string[] {
  const ids = new Set<string>()
  for (const entry of scenarioSetup.entries) ids.add(entry.scenarioId)
  return [...ids]
}

/** 有初设条目的剧本号集合（模块内复用） */
const ENTRY_SCENARIOS = new Set(entryScenarioIds())

/**
 * 解出该剧本的**初设源**
 *
 * 顺序：本体有条目 → 本体；否则 `inherits` 指向的剧本有条目 → 该剧本；
 * 否则「与本剧本共用初设」的剧本（`sharedSetupWith` 反查）→ 该剧本；都没有 ⇒ 记缺口。
 */
export function setupSourceOf(scenarioId: string): SetupSource {
  const scenario = scenarios.scenarios.find((item) => item.id === scenarioId)
  if (scenario === undefined) {
    return { scenarioId, source: scenarioId, via: 'own', detail: `剧本库中没有剧本 ${scenarioId}` }
  }
  if (ENTRY_SCENARIOS.has(scenarioId)) {
    return {
      scenarioId,
      source: scenarioId,
      via: 'own',
      detail: `剧本 ${scenarioId} 本体含初设条目（剧本页逐格清单）`,
    }
  }
  const inherited = scenario.inherits
  if (inherited !== undefined && ENTRY_SCENARIOS.has(inherited)) {
    return {
      scenarioId,
      source: inherited,
      via: 'inherits',
      detail: `剧本 ${scenarioId} 初设同剧本 ${inherited}（契约字段 inherits；剧本页原文「Setup and Special Scenario Rules are the same as in Scenario ${inherited}」）`,
    }
  }
  const shared = scenarios.scenarios.find(
    (item) => item.sharedSetupWith?.includes(scenarioId) === true && ENTRY_SCENARIOS.has(item.id),
  )
  if (shared !== undefined) {
    return {
      scenarioId,
      source: shared.id,
      via: 'shared',
      detail: `剧本 ${scenarioId} 与剧本 ${shared.id} 共用初设（契约字段 sharedSetupWith）`,
    }
  }
  return {
    scenarioId,
    source: scenarioId,
    via: 'own',
    detail: `剧本 ${scenarioId} 在初设索引（scenario-setup.json）中没有条目 ⇒ 初设清单缺失（数据缺口）`,
  }
}

/* ────────────────────────────── 棋子与条目视图 ────────────────────────────── */

/** 条目展开出的**一枚棋子**（编队条目展开到各下属） */
export interface SetupPieceRef {
  /** 算子库 / 空军库 / 编队库 id（Z2 链接；null = 计数类条目不指向棋子） */
  unitId: string | null
  unitIdKind: string | null
  name: string
  /** 编队内的分量代号（如 '1 Aufk'；非编队条目为 null） */
  component: string | null
  /** 是否为建制内卡车（organic truck；由编队下属标记） */
  isOrganicTruck: boolean
  /** 该棋子的减损军力数（条目级减损对所有棋子生效） */
  stepPenalty: number | null
}

/** 初设条目视图（界面铺表用；一切判定都由引擎给出） */
export interface SetupEntryView {
  /** 在 `setupEntryViews()` 结果里的下标（可回溯到源条目） */
  index: number
  scenarioId: string
  side: Side
  kind: SetupEntry['kind']
  name: string | null
  raw: string
  /** 数量：单位数 / SP 点数 / 运输点数 / 基地数（=1，等级另在 raw） */
  count: number
  placement: SetupPlacementKind
  placementText: string
  /** IV-A 的 X（格）；无即 null */
  radius: number | null
  /** 所列格（印刷格号解析结果；可 0/1/2 个） */
  anchors: readonly HexRef[]
  /** 所列格原文 */
  hexTexts: readonly string[]
  unitId: string | null
  unitIdKind: string | null
  linkBasis: string | null
  /** 初设减损军力数（IV-G 的例外：剧本明示 −N step） */
  stepPenalty: number | null
  stepPenaltyNote: string | null
  /** 以移动模式面初设（剧本明示 'in Move Mode'） */
  setupMode: string | null
  /** † 容差原文 */
  toleranceText: string | null
  /** 同格共存的条目类别（数量注记与所在格单位关联） */
  coLocated: readonly string[]
  /** 展开出的棋子（kind=formation 时逐下属；计数类为空） */
  pieces: readonly SetupPieceRef[]
  /** 是否可**直接自动落位**（无需玩家定夺） */
  automatic: boolean
  /** 规则出处（IV-A / 剧本页 / 13.5 …） */
  rule: string
}

/** 条目 → 展开的棋子 */
function piecesOf(entry: EntryRow): readonly SetupPieceRef[] {
  const subordinates = entry.subordinates ?? []
  if (entry.kind === 'formation' && subordinates.length > 0) {
    return subordinates.map((sub) => ({
      unitId: sub.unitId ?? null,
      unitIdKind: sub.unitId === null || sub.unitId === undefined ? null : 'unit',
      name: sub.name,
      component: sub.component,
      isOrganicTruck: sub.isOrganicTruck === true,
      stepPenalty: entry.stepPenalty ?? null,
    }))
  }
  if (entry.unitId === null || entry.unitId === undefined) return []
  return [
    {
      unitId: entry.unitId,
      unitIdKind: entry.unitIdKind ?? null,
      name: entry.name ?? entry.raw,
      component: null,
      isOrganicTruck: false,
      stepPenalty: entry.stepPenalty ?? null,
    },
  ]
}

/** 条目的规则出处（按类别与放置方式给出可回溯的条款号） */
function ruleOfEntry(entry: EntryRow, placement: SetupPlacementKind): string {
  if (placement === 'deadPile') return DEAD_PILE_RULE
  if (placement === 'anyHq') return WITHIN_RULE
  if (placement === 'radius') return WITHIN_RULE
  if (placement === 'fixedTolerant') return WITHIN_RULE
  if (entry.kind === 'aircraft') return AIR_BASE_SITE_RULE
  return SETUP_RULE
}

/** 单条条目 → 视图 */
function toEntryView(entry: EntryRow, index: number): SetupEntryView {
  const placement = setupPlacementOfText(entry.placementType)
  const radius =
    parseSetupRadius(entry.location) ??
    parseSetupRadius(entry.placementNote) ??
    parseSetupRadius(entry.placementTolerance)
  return {
    index,
    scenarioId: entry.scenarioId,
    side: entry.side as Side,
    kind: entry.kind,
    name: entry.name ?? null,
    raw: entry.raw,
    count: entry.count,
    placement,
    placementText: entry.placementType,
    radius,
    anchors: (entry.locationRefs ?? []) as readonly HexRef[],
    hexTexts: entry.locationHexes ?? [],
    unitId: entry.unitId ?? null,
    unitIdKind: entry.unitIdKind ?? null,
    linkBasis: entry.linkBasis ?? null,
    stepPenalty: entry.stepPenalty ?? null,
    stepPenaltyNote: entry.stepPenaltyNote ?? null,
    setupMode: entry.setupMode ?? null,
    toleranceText: entry.placementTolerance ?? null,
    coLocated: entry.coLocated ?? [],
    pieces: piecesOf(entry),
    automatic: AUTOMATIC_PLACEMENTS.includes(placement),
    rule: ruleOfEntry(entry, placement),
  }
}

/**
 * 该剧本（经初设源解析）的全部初设条目视图；`side` 为 null 时双方都给
 *
 * ★ `index` 是**剧本内稳定序号**（在全量条目上的下标）——按 `side` 过滤不会改变既有条目的下标，
 *   故 `SetupPlan` 用 `entryIndex` 回指时，无论从哪里取视图都对得上。
 */
export function setupEntryViews(
  scenarioId: string,
  side: Side | null = null,
): readonly SetupEntryView[] {
  const { source } = setupSourceOf(scenarioId)
  const rows: SetupEntryView[] = []
  let index = 0
  for (const entry of scenarioSetup.entries) {
    if (entry.scenarioId !== source) continue
    const view = toEntryView(entry, index)
    index += 1
    if (side !== null && entry.side !== side) continue
    rows.push(view)
  }
  return rows
}

/* ────────────────────────────── 候选格 ────────────────────────────── */

/**
 * 候选格的**盘面事实**（全部注入；引擎不持盘面）
 *
 * 缺哪一项，就只报对应缺口（不代替玩家决定、也不臆造位置）。
 */
export interface SetupCandidateFacts {
  /** 本方 HQ 所在格（`Stacked with any … HQs` 的候选；4.8b D 的「指挥部」同义） */
  hqHexes?: readonly HexRef[]
  /** 本方空军基地格（14.1a：飞机算子停在其空军基地格） */
  airBaseHexes?: readonly HexRef[]
  /** IV-I：该格是否可按常规移动进入（缺省只校验「在地图上」） */
  canEnter?: (hex: HexRef) => boolean
  /** IV-F：该格当前已有的 RE 合计（缺省不校验超堆叠） */
  existingRe?: (hex: HexRef) => number
}

/** 去重 + 稳定排序（距离锚格近者先；同距按列、行） */
function uniqueOrdered(hexes: readonly HexRef[], anchor: HexRef | null): HexRef[] {
  const seen: HexRef[] = []
  for (const hex of hexes) {
    if (!seen.some((item) => sameHex(item, hex))) seen.push(hex)
  }
  const origin = anchor ?? seen[0] ?? { col: 0, row: 0 }
  return seen.sort(
    (a, b) => hexDistance(origin, a) - hexDistance(origin, b) || a.col - b.col || a.row - b.row,
  )
}

/**
 * 条目的候选格（IV-A：`w/i X` 含所列格与其 X 格内；† 容差同理）
 *
 * 候选一律经 **IV-I** 过滤（在图上 + 调用方给出的 `canEnter`），故界面直接拿它当选项即可。
 * 返回空数组表示**该条目的候选不可解**（缺事实或放置方式不认识），调用方据此报缺口。
 */
export function setupCandidates(
  entry: SetupEntryView,
  facts: SetupCandidateFacts = {},
): readonly HexRef[] {
  const anchor = entry.anchors[0] ?? null
  switch (entry.placement) {
    case 'fixed':
    case 'multiHex':
      return filterEnterable(uniqueOrdered(entry.anchors, anchor), facts)
    case 'fixedTolerant':
    case 'radius': {
      // 无锚格或半径解析不出 ⇒ 不可解（不猜）
      if (anchor === null || entry.radius === null) return []
      const pool: HexRef[] = []
      for (const start of entry.anchors) {
        pool.push(...hexesWithin(start, entry.radius, { onMapOnly: true }))
      }
      return filterEnterable(uniqueOrdered(pool, anchor), facts)
    }
    case 'anyHq':
      return filterEnterable(uniqueOrdered(facts.hqHexes ?? [], null), facts)
    case 'airbaseFree':
    case 'airFleet':
      return filterEnterable(uniqueOrdered(facts.airBaseHexes ?? [], null), facts)
    case 'deadPile':
    case 'unknown':
      return []
    default:
      return []
  }
}

/** IV-I：候选格筛选（在图上 + 可按常规移动进入） */
function filterEnterable(hexes: readonly HexRef[], facts: SetupCandidateFacts): readonly HexRef[] {
  return hexes.filter((hex) => {
    if (!isOnMap(hex)) return false
    if (facts.canEnter === undefined) return true
    return facts.canEnter(hex)
  })
}

/* ────────────────────────────── 单条放置校验 ────────────────────────────── */

export interface SetupPlacementRequest {
  entry: SetupEntryView
  /** 玩家（或自动初设）选定的目标格 */
  targetHex: HexRef
  facts?: SetupCandidateFacts
}

/** 单条放置的结论 */
export interface SetupPlacementDecision {
  hex: HexRef
  /** 该次放置是否落在「自由项」上（true = 玩家自选，false = 按剧本页固定格） */
  freeChoice: boolean
  rule: string
  detail: string
}

/** 条目里各棋子 RE 之和（IV-F 堆叠上限只计战斗单位；非战斗单位的 reSize 在库中为 0） */
function reOfEntry(entry: SetupEntryView): number {
  let total = 0
  for (const piece of entry.pieces) {
    if (piece.unitId === null) continue
    const record = piece.unitIdKind === 'aircraft' ? undefined : findUnitRecord(piece.unitId)
    total += record?.reSize ?? 0
  }
  return total
}

/**
 * 单条条目的放置校验（玩家自定义初设与自动初设**共用**）
 *
 * 逐条对照：
 *   · **IV-A**：目标格须在候选集内（`w/i X` 含边界，† 容差同理）；
 *   · **IV-I**：须在地图上，且（若调用方给了 `canEnter`）可按常规移动进入；
 *   · **IV-F**：不得超堆叠（若调用方给了 `existingRe`；上限取 4.8 的 10 RE）。
 */
export function planSetupPlacement(
  request: SetupPlacementRequest,
): RuleOutcome<SetupPlacementDecision> {
  const { entry, targetHex } = request
  const facts = request.facts ?? {}
  if (entry.placement === 'deadPile') {
    return fail(SETUP_RULE, `setupEntryGoesToDeadPile:${entry.raw}`)
  }
  if (entry.placement === 'unknown') {
    return fail(SETUP_RULE, `setupPlacementUnknown:${entry.placementText}`)
  }

  // IV-I：目标格须在图上、且（若调用方给了 canEnter）可按常规移动进入
  if (!isOnMap(targetHex)) {
    return fail(ENTERABILITY_RULE, `setupHexOffMap:${setupHexLabel(targetHex)}`)
  }
  if (facts.canEnter !== undefined && !facts.canEnter(targetHex)) {
    return fail(ENTERABILITY_RULE, `setupHexNotEnterable:${setupHexLabel(targetHex)}`)
  }

  const candidates = setupCandidates(entry, facts)
  if (candidates.length === 0) {
    return fail(
      SETUP_RULE,
      `setupCandidatesUnavailable:${entry.placement === 'anyHq' ? 'hqHexes' : 'airBaseHexes'}`,
    )
  }
  if (!candidates.some((hex) => sameHex(hex, targetHex))) {
    const allowed = candidates.slice(0, 6).map(setupHexLabel).join('、')
    return fail(
      WITHIN_RULE,
      `setupHexOutOfRange:${setupHexLabel(targetHex)}（可在 ${allowed}${candidates.length > 6 ? ' 等' : ''}）`,
    )
  }

  if (facts.existingRe !== undefined) {
    const total = facts.existingRe(targetHex) + reOfEntry(entry)
    if (!isWithinStackingLimit(total)) {
      return fail(STACKING_RULE, `setupOverStacked:${setupHexLabel(targetHex)}:${total}RE`)
    }
  }

  const freeChoice = CHOICE_PLACEMENTS.includes(entry.placement)
  const hexText = setupHexLabel(targetHex)
  return succeed(entry.rule, {
    hex: { ...targetHex },
    freeChoice,
    rule: entry.rule,
    detail: freeChoice
      ? `${entry.raw} ⇒ ${hexText}（自由项：须与对手共享候选范围，${WITHIN_RULE}）`
      : `${entry.raw} ⇒ ${hexText}（按剧本页清单）`,
  })
}

/* ────────────────────────────── 单位库查询 ────────────────────────────── */

/** 按 id 找地面算子记录（中性算子 side='both'，故两个库都查） */
export function findUnitRecord(unitId: string) {
  return (
    unitsAxis.units.find((unit) => unit.id === unitId) ??
    unitsSoviet.units.find((unit) => unit.id === unitId)
  )
}

/** 按 id 找空军记录 */
export function findAircraftRecord(aircraftId: string) {
  return aircraft.aircraft.find((item) => item.aircraftId === aircraftId)
}

/* ────────────────────────────── 通用计数算子拆分 ────────────────────────────── */

/**
 * 把总点数拆成**可用的算子面额**（大面额优先；12.1c 通用 dump / 13.2 运输点均可自由拆合）
 *
 * 用途：初设账本里的「5 SP」「4 Truck Points」要落到盘面上就得选算子。
 * 面额一律从**算子库**取（SP 有 1/2/3/4/5/10/15，运输点有 1..5 且 `splittable`），
 * 不在引擎里写死面额表；拆不出（总点数不是整数或面额全为 0）即返回 null，由调用方如实报缺口。
 */
export function breakdownCounterValues(
  total: number,
  denominations: readonly number[],
): number[] | null {
  if (!Number.isInteger(total) || total < 0) return null
  const values = [
    ...new Set(denominations.filter((value) => Number.isInteger(value) && value > 0)),
  ].sort((a, b) => b - a)
  if (values.length === 0) return total === 0 ? [] : null
  const picked: number[] = []
  let rest = total
  for (const value of values) {
    while (rest >= value) {
      picked.push(value)
      rest -= value
    }
  }
  return rest === 0 ? picked : null
}

/* ────────────────────────────── 自动初设计划 ────────────────────────────── */

/** 一枚自动落位的棋子 */
export interface SetupPiecePlacement {
  /** 源条目下标（可回溯；见 `setupEntryViews()`） */
  entryIndex: number
  kind: SetupEntry['kind']
  unitId: string | null
  unitIdKind: string | null
  name: string
  component: string | null
  isOrganicTruck: boolean
  /** 落位格（null = 直接进死亡堆） */
  hex: HexRef | null
  hexText: string | null
  /** 是否进死亡堆（13.5） */
  toDeadPile: boolean
  side: Side
  /** 减损后的**剩余军力**（null = 按印值；IV-G 的剧本明示例外） */
  steps: number | null
  /** 以移动模式面初设（剧本明示，或编队抽签的 Move-Mode 组） */
  face: 'move' | null
  detail: string
  rule: string
}

/** 计数类非战斗单位的账本条目（SP / 运输点 / 空军基地） */
export interface SetupLedgerEntry {
  entryIndex: number
  kind: CountKind
  hex: HexRef
  hexText: string
  side: Side
  /** 数量：SP 点数 / 运输点数 / 空军基地数 */
  count: number
  /** 运输点类别（truck / wagon；仅 transport_point） */
  transportKind: 'truck' | 'wagon' | null
  /** 空军基地等级（仅 airbase；取自原文 'Level N Airbase'） */
  level: number | null
  /** 12.1d：SP 与运输点算子为双方通用，**归属＝带上图的一方** */
  owner: Side
  detail: string
  rule: string
}

/** 须玩家定夺的一条（自由项） */
export interface SetupChoice {
  entryIndex: number
  placement: SetupPlacementKind
  side: Side
  name: string
  raw: string
  count: number
  radius: number | null
  anchors: readonly HexRef[]
  /** 候选格（IV-A / IV-I 过滤后；空 = 缺盘面事实） */
  candidates: readonly HexRef[]
  /** 为何须玩家定夺 */
  reason: string
  rule: string
}

/** 自动初设计划（剧本页清单 → 落位计划） */
export interface SetupPlan {
  scenarioId: string
  source: SetupSource
  /** 可直接落位的棋子 */
  pieces: readonly SetupPiecePlacement[]
  /** 计数类非战斗单位（SP / 运输点 / 空军基地） */
  ledger: readonly SetupLedgerEntry[]
  /** 须玩家定夺的自由项 */
  choices: readonly SetupChoice[]
  counts: { pieces: number; ledger: number; choices: number }
  dataGaps: readonly string[]
  detail: string
}

/** 基数（军力）查询：命中印值即用作减损基数 */
function printedStepsOf(unitId: string | null, unitIdKind: string | null): number | null {
  if (unitId === null) return null
  if (unitIdKind === 'aircraft') {
    const record = findAircraftRecord(unitId)
    return record?.steps ?? null
  }
  const record = findUnitRecord(unitId)
  return record?.steps?.total ?? null
}

/** 运输点原文 → 类别（`4 Truck Points` ⇒ truck；`2 Wagon Points` ⇒ wagon） */
export function setupTransportKindOf(raw: string): 'truck' | 'wagon' | null {
  if (/truck/i.test(raw)) return 'truck'
  if (/wagon/i.test(raw)) return 'wagon'
  return null
}

/** 空军基地原文 → 等级（`Level 2 Airbase` ⇒ 2；解析不出退到 fallback） */
export function setupAirbaseLevelOf(raw: string, fallback: number): number {
  const match = /level\s*(\d+)/i.exec(raw)
  return match?.[1] === undefined ? fallback : Number(match[1])
}

/**
 * 自动初设计划（专规 Setup Notes + 通规 IV Set Up Notes）
 *
 * 把剧本页逐格清单翻成「可直接落位的棋子 + 计数类账本 + 须玩家定夺的自由项」：
 *   · **可直接落位**：`固定格号` / `多点位（每处各一份）` / `死亡堆`，以及带 † 的容差条目
 *     （先按**所列格**落位，玩家仍可在容差内调整——见 `planSetupPlacement`）；
 *   · **须玩家定夺**：`w/i X hexes`（IV-A）、`Stacked with any … HQs`、`At any air bases`（14.1a）；
 *   · **计数类**：SP / 运输点 / 空军基地按「类型 + 格号 + 数量」入账（12.1d 定归属）。
 *
 * 不认识放置方式、缺 `unitId` 链接、缺锚格/半径的条目**一律进 `dataGaps`**，不猜。
 */
export function planAutoSetup(input: {
  scenarioId: string
  facts?: SetupCandidateFacts
}): RuleOutcome<SetupPlan> {
  const scenario = scenarios.scenarios.find((item) => item.id === input.scenarioId)
  if (scenario === undefined) {
    return fail(SETUP_RULE, `scenarioNotFound:${input.scenarioId}`)
  }
  const source = setupSourceOf(input.scenarioId)
  const facts = input.facts ?? {}
  const views = setupEntryViews(input.scenarioId)

  const pieces: SetupPiecePlacement[] = []
  const ledger: SetupLedgerEntry[] = []
  const choices: SetupChoice[] = []
  const gaps: string[] = []

  if (views.length === 0) gaps.push(source.detail)

  for (const entry of views) {
    // ① 放置方式不认识 ⇒ 记缺口（不猜）
    if (entry.placement === 'unknown') {
      gaps.push(`条目「${entry.raw}」的放置方式「${entry.placementText}」未识别 ⇒ 须人工判读`)
      continue
    }

    // ② 自由项（`w/i X` / 任一指挥部 / 任意空军基地）⇒ 交玩家定夺，候选格一并给出
    if (!entry.automatic) {
      const candidates = filterEnterable(setupCandidates(entry, facts), facts)
      const reason =
        entry.placement === 'anyHq'
          ? '剧本页只要求「与任一本方指挥部同格」⇒ 由玩家在本方 HQ 格中选定'
          : entry.placement === 'radius'
            ? `剧本页「${entry.placementText}」⇒ 玩家可在 ${entry.radius ?? '?'} 格范围内任选（${WITHIN_RULE} 含边界）`
            : entry.placement === 'fixedTolerant'
              ? `剧本页 † 注记：可在所列位置 ${entry.radius ?? '?'} 格内初设`
              : '剧本页只要求「放在任意空军基地」⇒ 由玩家在本方空军基地格中选定（14.1a）'
      if (candidates.length === 0) {
        gaps.push(
          entry.placement === 'anyHq'
            ? `条目「${entry.raw}」需要本方 HQ 格作为候选 ⇒ 调用方未提供 hqHexes`
            : entry.placement === 'airbaseFree' || entry.placement === 'airFleet'
              ? `条目「${entry.raw}」需要本方空军基地格作为候选 ⇒ 调用方未提供 airBaseHexes`
              : `条目「${entry.raw}」的候选格不可解（缺锚格或半径）`,
        )
      }
      choices.push({
        entryIndex: entry.index,
        placement: entry.placement,
        side: entry.side,
        name: entry.name ?? entry.raw,
        raw: entry.raw,
        count: entry.count,
        radius: entry.radius,
        anchors: entry.anchors,
        candidates,
        reason,
        rule: entry.rule,
      })
      continue
    }

    // 自动落位的目标格：`多点位（每处各一份）` ⇒ 所列每格各一份；其余 ⇒ 所列首格
    const toDeadPile = entry.placement === 'deadPile'
    const targets = toDeadPile
      ? [null]
      : entry.placement === 'multiHex'
        ? [...entry.anchors]
        : entry.anchors.slice(0, 1)
    const resolvedTargets = targets.filter((hex) => hex !== null || toDeadPile)
    if (resolvedTargets.length === 0) {
      gaps.push(
        `条目「${entry.raw}」是固定格号但格号解析不出（原文：${entry.hexTexts.join('、') || '无'}）`,
      )
      continue
    }

    // ③ 计数类非战斗单位（SP / 运输点 / 空军基地）：按「类型 + 格号 + 数量」入账（12.1d 定归属）
    if ((COUNT_KINDS as readonly string[]).includes(entry.kind)) {
      const kind = entry.kind as CountKind
      const transportKind = kind === 'transport_point' ? setupTransportKindOf(entry.raw) : null
      const level = kind === 'airbase' ? setupAirbaseLevelOf(entry.raw, entry.count) : null
      for (const target of resolvedTargets) {
        const hex = target as HexRef
        const label = setupHexLabel(hex)
        ledger.push({
          entryIndex: entry.index,
          kind,
          hex: { ...hex },
          hexText: label,
          side: entry.side,
          count: entry.count,
          transportKind,
          level,
          owner: entry.side,
          detail:
            kind === 'sp'
              ? `${entry.count} SP @ ${label}（${SP_OWNERSHIP_RULE}：带上图的一方即拥有者）`
              : kind === 'transport_point'
                ? `${entry.count} ${transportKind === 'wagon' ? 'Wagon' : 'Truck'} Point(s) @ ${label}（${LOAD_RULE}：与 SP 同堆叠者方可满载，剧本另述除外）`
                : `Level ${level} Airbase @ ${label}（13.8d：每格至多 1 座）`,
          rule: kind === 'sp' ? SP_OWNERSHIP_RULE : entry.rule,
        })
      }
      continue
    }

    // ④ 棋子（含编队下属展开；`count` = 该型算子枚数，编队条目为 1）
    if (entry.pieces.length === 0) {
      gaps.push(`条目「${entry.raw}」没有算子库链接（unitId）⇒ 须人工配子`)
      continue
    }
    const copies = entry.kind === 'formation' ? 1 : Math.max(entry.count, 1)
    for (const target of resolvedTargets) {
      const hex = target as HexRef | null
      for (const piece of entry.pieces) {
        const printed = printedStepsOf(piece.unitId, piece.unitIdKind)
        const penalty = piece.stepPenalty ?? 0
        const steps = printed !== null && penalty > 0 ? Math.max(printed - penalty, 0) : null
        for (let copy = 0; copy < copies; copy += 1) {
          pieces.push({
            entryIndex: entry.index,
            kind: entry.kind,
            unitId: piece.unitId,
            unitIdKind: piece.unitIdKind,
            name: piece.name,
            component: piece.component,
            isOrganicTruck: piece.isOrganicTruck,
            hex: hex === null ? null : { ...hex },
            hexText: hex === null ? null : setupHexLabel(hex),
            toDeadPile,
            side: entry.side,
            steps,
            face: entry.setupMode === 'move' ? 'move' : null,
            detail: toDeadPile
              ? `${piece.name} ⇒ 死亡堆（${DEAD_PILE_RULE}）${penalty > 0 ? `；以减损状态入堆（−${penalty} step）` : ''}`
              : `${piece.name} ⇒ ${hex === null ? '' : setupHexLabel(hex)}${penalty > 0 ? `；以减损状态初设（−${penalty} step，剧本明示）` : ''}${entry.setupMode === 'move' ? '；以移动模式面初设（剧本明示）' : ''}`,
            rule: entry.rule,
          })
        }
      }
    }
  }

  // † 容差是**剧本 3/5/7** 的注记：本剧本条目里出现 † 时，把源库注记一并带出（便于界面提示）
  if (views.some((entry) => entry.placement === 'fixedTolerant')) {
    for (const [key, value] of Object.entries(scenarioSetup.notes.markerNotes)) {
      if (key.startsWith('†')) gaps.push(`${key}：${value}`)
    }
  }

  const counts = { pieces: pieces.length, ledger: ledger.length, choices: choices.length }
  return succeed(SETUP_RULE, {
    scenarioId: input.scenarioId,
    source,
    pieces,
    ledger,
    choices,
    counts,
    dataGaps: gaps,
    detail:
      `剧本 ${input.scenarioId} 初设源＝剧本 ${source.source}（${source.via}）：` +
      `自动落位 ${counts.pieces} 枚棋子 + ${counts.ledger} 条计数账本；` +
      `${counts.choices} 条须玩家定夺（${WITHIN_RULE} 的自由项）`,
  })
}

/* ────────────────────────────── 卡车满载指定 ────────────────────────────── */

export interface TruckLoadRequest {
  scenarioId: string
  /** 该剧本初设里的建制内卡车实例（调用方按盘面注入：来源＝编队下属 isOrganicTruck） */
  trucks: readonly { instanceId: string; unitId: string; name?: string }[]
  /** 玩家指定「满载」的实例 id */
  fullInstanceIds: readonly string[]
}

export interface TruckLoadPlan {
  rule: string
  /** 剧本页规定的满载方式（`scenarios.json` → `setup.organicTrucks`） */
  mode: 'all_loaded' | 'all_unloaded' | 'choose_loaded'
  /** 剧本页要求的满载辆数 */
  requiredFull: number
  full: readonly string[]
  empty: readonly string[]
  /** 13.2h：满载面记法（正面 `${运力}F`，背面为运力数字） */
  notation: { fullFace: string; emptyFace: string }
  detail: string
}

/**
 * 卡车满载指定（通规 IV-C/D + 13.2h + 专规 Setup Note C）
 *
 * 规则原文：
 *   · 通规 **IV-D**：`Organic Trucks start "full" only if a scenario explicitly states that they do.`；
 *   · 专规 **Setup Note C**：`Special Scenario Rules will say if organic trucks are Empty or Full.`；
 *   · **13.2h**：`Some games have Transport Points that have an "F" in a yellow box on one side …`
 *     ⇒ 满载面记作「运力 + F」，空载面只有运力数字。
 *
 * 剧本页明示（已结构化在 `scenarios.json`）：
 *   · 剧本 1：`The Axis organic trucks all setup Full.` ⇒ 全部满载；
 *   · 剧本 3：`Four Axis organic trucks (player's choice) are Full at start. The rest setup Empty.`；
 *   · 剧本 5：`Two Axis organic trucks (player's choice) are Full at start. The rest setup Empty.`；
 *   · 剧本 7：`Axis organic trucks all setup Empty.`
 */
export function planTruckFullLoad(request: TruckLoadRequest): RuleOutcome<TruckLoadPlan> {
  const scenario = scenarios.scenarios.find((item) => item.id === request.scenarioId)
  if (scenario === undefined) return fail(LOAD_RULE, `scenarioNotFound:${request.scenarioId}`)
  const spec = scenario.setup.organicTrucks
  const ids = request.trucks.map((truck) => truck.instanceId)
  const known = new Set(ids)

  for (const id of request.fullInstanceIds) {
    if (!known.has(id)) return fail(LOAD_RULE, `truckLoadUnknownInstance:${id}`)
  }
  if (new Set(request.fullInstanceIds).size !== request.fullInstanceIds.length) {
    return fail(LOAD_RULE, 'truckLoadDuplicateInstance')
  }

  const requiredFull =
    spec.mode === 'all_loaded'
      ? request.trucks.length
      : spec.mode === 'all_unloaded'
        ? 0
        : (spec.count ?? 0)

  if (request.fullInstanceIds.length !== requiredFull) {
    return fail(
      LOAD_RULE,
      spec.mode === 'all_loaded'
        ? `truckLoadMismatch:expectAllLoaded:${requiredFull}≠${request.fullInstanceIds.length}`
        : spec.mode === 'all_unloaded'
          ? `truckLoadMismatch:expectAllUnloaded:0≠${request.fullInstanceIds.length}`
          : `truckLoadMismatch:expectChooseLoaded:${requiredFull}≠${request.fullInstanceIds.length}`,
    )
  }

  // 13.2h：满载面 = 运力 + 'F'；运力取自算子库（本作建制内卡车 1 点）
  const transportValue = request.trucks
    .map((truck) => findUnitRecord(truck.unitId)?.noncombatDetails?.transport ?? null)
    .find((value) => value !== null && value !== undefined)
  const capacity = transportValue ?? 1

  const full = [...request.fullInstanceIds]
  const empty = ids.filter((id) => !full.includes(id))
  return succeed(LOAD_RULE, {
    rule: TRUCK_LOAD_RULE,
    mode: spec.mode,
    requiredFull,
    full,
    empty,
    notation: { fullFace: `${capacity}F`, emptyFace: `${capacity}` },
    detail:
      `建制内卡车满载指定（${LOAD_RULE} / ${TRUCK_LOAD_RULE}）：剧本页「${spec.raw}」⇒ ` +
      `须满载 ${requiredFull} 辆、空载 ${empty.length} 辆；满载面记作 ${capacity}F、空载面记作 ${capacity}`,
  })
}

/* ────────────────────────────── SP 归属划分 ────────────────────────────── */

export interface SupplyDumpRef {
  /** dump 标识（调用方按盘面给，如 `sp:2.02`） */
  id: string
  hex: HexRef
  /** 带上图的一方（12.1d 的归属方） */
  side: Side
  points: number
}

export interface SupplyOwnershipRequest {
  scenarioId: string
  dumps: readonly SupplyDumpRef[]
  /** 轴方 dump → 装甲集群（Setup Note F：分界线仅作参考，归属由玩家自定） */
  assignments?: Readonly<Record<string, SetupPanzerGroup>>
  /**
   * 4.1a 可选：本局共识是否采纳了 3.4b 的约束（**必填**；判据见 `panzerGroupRulesActive`）
   *
   * 用户 2026-09-17 口径：未采纳 ⇒ 初设**不要求**逐一点名装甲集群（也不填默认归属）。
   */
  agreedByConsensus: boolean
}

export interface SupplyOwnershipEntry {
  id: string
  hex: HexRef
  side: Side
  points: number
  owner: Side
  panzerGroup: SetupPanzerGroup | null
  detail: string
}

export interface SupplyOwnershipPlan {
  rule: string
  entries: readonly SupplyOwnershipEntry[]
  /** 本剧本是否适用 3.4b 的「SP 须归属装甲集群」 */
  requiresPanzerGroup: boolean
  detail: string
}

/**
 * 该剧本首回合日期（ISO；取自回合轨）——3.4b 的时点判据用它
 *
 * 3.4b 原文：`At the start of a scenario, SP must be divided per Setup Note 'F' (p. 5).`
 * 而 3.4/3.4a 的约束在 19 August 起失效（`rules-constants.panzerGroupConstraintEnd`）。
 */
export function scenarioFirstTurnDate(scenarioId: string): string | null {
  const range = scenarioTurnRange(scenarioId)
  return markers.turnTrack.find((entry) => entry.turn === range.firstTurn)?.date ?? null
}

/** 该剧本是否适用「SP 须归属装甲集群」（首回合早于 19 August） */
export function requiresPanzerGroupSpAssignment(scenarioId: string): boolean {
  const date = scenarioFirstTurnDate(scenarioId)
  if (date === null) return false
  // ★ 口径唯一（M2③）：解除日判据只在 `timing.ts#isPanzerGroupConstraintLifted` 一处；
  //   本处**不再**直接比 `panzerGroupConstraintEnd`（此前三处各自比较，改解除日会漏改）
  return !isPanzerGroupConstraintLifted(date)
}

/**
 * SP 归属划分（12.1d + Setup Note F + 3.4b）
 *
 * 规则原文：
 *   · **12.1d**：`The generic SP counters are common to both players, so it is important that players
 *     keep track of who owns what. An SP belongs to (and can only be used by) the player who brought
 *     it onto the map unless it has been captured (see 9.14b).` ⇒ 初设期**归属＝带上图的一方**；
 *   · **Setup Note F**：`When using 3.4b (part of "Guderian & Hoth"), on-map SP should be assigned to
 *     a Pz Grp during setup. Use the Dividing Line as a guide, but the player can freely decide
 *     ownership of dumps.`；
 *   · **3.4b**：`At the start of a scenario, SP must be divided per Setup Note 'F' (p. 5).`，
 *     且「来自『错误』装甲集群的 SP 不能用于多单位编队的燃料/战斗/轰炸费用」。
 *
 * ⇒ 本模块只做**归属登记与归属完备性校验**：轴方地图内 dump 在适用 3.4b 的剧本里必须逐一点名装甲集群，
 *   未点名即拒绝（`spOwnershipMissing:<id>`）；苏方无需装甲集群（3.4b 只约束轴方）。
 */
export function planSupplyOwnership(
  request: SupplyOwnershipRequest,
): RuleOutcome<SupplyOwnershipPlan> {
  const scenario = scenarios.scenarios.find((item) => item.id === request.scenarioId)
  if (scenario === undefined)
    return fail(SP_OWNERSHIP_RULE, `scenarioNotFound:${request.scenarioId}`)

  // 3.4b 生效＝**剧本适用**（首回合早于 19 August）**且**共识采纳了 4.1a 这个可选项
  const requires = panzerGroupRulesActive({
    constraintApplies: requiresPanzerGroupSpAssignment(request.scenarioId),
    agreedByConsensus: request.agreedByConsensus,
  })
  const assignments = request.assignments ?? {}
  const known = new Set(request.dumps.map((dump) => dump.id))
  for (const id of Object.keys(assignments)) {
    if (!known.has(id)) return fail(PANZER_GROUP_SP_RULE, `spOwnershipUnknownDump:${id}`)
  }

  const entries: SupplyOwnershipEntry[] = []
  for (const dump of request.dumps) {
    const group = assignments[dump.id] ?? null
    if (requires && dump.side === 'axis' && group === null) {
      return fail(PANZER_GROUP_SP_RULE, `spOwnershipMissing:${dump.id}`)
    }
    if (!requires && group !== null) {
      return fail(
        PANZER_GROUP_SP_RULE,
        `spOwnershipNotApplicable:${dump.id}（本剧本首回合不早于 19 August ⇒ 3.4b 不适用）`,
      )
    }
    if (dump.side === 'soviet' && group !== null) {
      return fail(PANZER_GROUP_SP_RULE, `spOwnershipSovietGroupForbidden:${dump.id}`)
    }
    const groupText =
      group === null ? '无（苏方不适用 3.4b）' : group === 'guderian' ? 'Guderian' : 'Hoth'
    entries.push({
      id: dump.id,
      hex: { ...dump.hex },
      side: dump.side,
      points: dump.points,
      owner: dump.side,
      panzerGroup: group,
      detail: `${dump.points} SP @ ${setupHexLabel(dump.hex)} ⇒ 归属 ${dump.side}（${SP_OWNERSHIP_RULE}）；装甲集群：${groupText}`,
    })
  }

  const groupCount = entries.filter((entry) => entry.panzerGroup !== null).length
  return succeed(SP_OWNERSHIP_RULE, {
    rule: requires ? PANZER_GROUP_SP_RULE : SP_OWNERSHIP_RULE,
    entries,
    requiresPanzerGroup: requires,
    detail: requires
      ? `SP 归属（${SP_OWNERSHIP_RULE} + Setup Note F / ${PANZER_GROUP_SP_RULE}）：共 ${entries.length} 处 dump，` +
        `其中轴方已点名装甲集群 ${groupCount} 处（首回合 ${scenarioFirstTurnDate(request.scenarioId) ?? '未知'} 早于 ${rulesConstants.smolensk.panzerGroupConstraintEnd} ⇒ 3.4b 适用）`
      : `SP 归属（${SP_OWNERSHIP_RULE}）：共 ${entries.length} 处 dump；本剧本不适用 3.4b（首回合不早于 ${rulesConstants.smolensk.panzerGroupConstraintEnd}）`,
  })
}

/* ────────────────────────────── 飞机初设 ────────────────────────────── */

/** 机型名归一（去点、横线、空格并小写；'Bf-109e' / 'Bf.109e' ⇒ 'bf109e'） */
export function normalizeAircraftKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 该机型的减损标记是否命中（按归一名做后缀匹配，避免 'Bf.109e' 误配 'Bf.109e-7'） */
function isReducedType(aircraftId: string, name: string, reducedTypes: readonly string[]): boolean {
  const keys = reducedTypes.map(normalizeAircraftKey)
  const targets = [normalizeAircraftKey(aircraftId), normalizeAircraftKey(name)]
  return keys.some((key) => key !== '' && targets.some((target) => target.endsWith(key)))
}

/** 一型飞机的初设条目（位置 × 激活 × 减损） */
export interface AirSetupPlacement {
  entryIndex: number
  aircraftId: string
  name: string
  count: number
  /** 每枚的初始激活态（14.1a；顺序即同一机型的各枚，枚间可互换） */
  statuses: readonly AirStatus[]
  /** 每枚是否以减损状态初设（`*` = one unit begins reduced） */
  reduced: readonly boolean[]
  /** 每枚的初始军力（减损者 −1） */
  steps: readonly number[]
  /** 候选基地格（14.1a：飞机算子停在其空军基地格） */
  candidates: readonly HexRef[]
  detail: string
  rule: string
}

export interface AirSetupPlan {
  scenarioId: string
  side: Side
  policy: ScenarioAirSetupPolicyShape
  placements: readonly AirSetupPlacement[]
  dataGaps: readonly string[]
  detail: string
}

/** 该剧本该方的飞机初设政策（未述 ⇒ IV-E 默认全 Active） */
export function airSetupPolicyOf(scenarioId: string, side: Side): ScenarioAirSetupPolicyShape {
  const own = scenarios.scenarios.find((item) => item.id === scenarioId)?.setup.airSetup?.[side]
  if (own !== undefined) return normalizePolicy(own)
  const sourceId = setupSourceOf(scenarioId).source
  const inherited = scenarios.scenarios.find((item) => item.id === sourceId)?.setup.airSetup?.[side]
  if (inherited !== undefined) return normalizePolicy(inherited)
  return {
    policy: 'all_active',
    reducedTypes: [],
    statedInRules: false,
    raw: `${AIR_ACTIVE_RULE}：Aircraft always begin Active.（剧本页未述该方激活态）`,
  }
}

/** 归一后的飞机初设政策（`reducedTypes` 恒为数组，便于调用方安全遍历） */
export interface ScenarioAirSetupPolicyShape {
  policy: ScenarioAirSetupPolicy['policy']
  reducedTypes: readonly string[]
  statedInRules: boolean
  raw: string
}

/** 数据里的政策（`reducedTypes` 可缺省）→ 归一体 */
function normalizePolicy(
  policy: DeepReadonly<ScenarioAirSetupPolicy>,
): ScenarioAirSetupPolicyShape {
  return {
    policy: policy.policy,
    reducedTypes: policy.reducedTypes ?? [],
    statedInRules: policy.statedInRules,
    raw: policy.raw,
  }
}

/**
 * 飞机初设（通规 IV-E + 14.1a + 剧本页明文）
 *
 *   · **IV-E**：`Aircraft always begin Active.`（默认全激活）；
 *   · 剧本页明文覆盖：`All planes must begin Inactive.`（剧本 1 德军）/
 *     `Half of the counters of each plane type (…) must begin Inactive. Round fractions up.`
 *     （剧本 1 苏军、剧本 3/5/7 德军）⇒ 每型非激活枚数＝⌈枚数 ÷ 2⌉；
 *   · 剧本页 `"*" = one unit begins reduced` ⇒ 该型有一枚以**减损**状态初设（军力 −1）；
 *   · **14.1a**：飞机算子停在其**空军基地格**（Active 在基地算子上方、Inactive 在下方）
 *     ⇒ 位置候选＝本方空军基地格。
 */
export function planAirSetup(input: {
  scenarioId: string
  side: Side
  facts?: SetupCandidateFacts
}): RuleOutcome<AirSetupPlan> {
  const scenario = scenarios.scenarios.find((item) => item.id === input.scenarioId)
  if (scenario === undefined) return fail(AIR_ACTIVE_RULE, `scenarioNotFound:${input.scenarioId}`)

  const policy = airSetupPolicyOf(input.scenarioId, input.side)
  const facts = input.facts ?? {}
  const candidates = filterEnterable(facts.airBaseHexes ?? [], facts)
  const gaps: string[] = []
  if (!policy.statedInRules) {
    gaps.push(
      `剧本 ${input.scenarioId} 的${input.side === 'axis' ? '轴心' : '苏联'}方剧本页未述飞机初始激活态 ⇒ 按 ${AIR_ACTIVE_RULE} 默认全 Active`,
    )
  }
  if (candidates.length === 0) {
    gaps.push(
      `未提供本方空军基地格（airBaseHexes）⇒ 飞机落位格须由玩家指定（${AIR_BASE_SITE_RULE}）`,
    )
  }

  const views = setupEntryViews(input.scenarioId, input.side).filter(
    (entry) => entry.kind === 'aircraft',
  )
  const placements: AirSetupPlacement[] = []
  const matchedReduced: string[] = []
  /** 位于死亡堆的飞机条目（13.5）：不进空军基地初设，由自动初设按死亡堆处理 */
  let deadPileAircraft = 0

  for (const entry of views) {
    if (entry.placement === 'deadPile') {
      deadPileAircraft += 1
      continue
    }
    if (entry.unitId === null) {
      gaps.push(`飞机条目「${entry.raw}」没有空军库链接（unitId）⇒ 须人工配子`)
      continue
    }
    const record = findAircraftRecord(entry.unitId)
    const name = record?.name ?? entry.unitId
    const printed = record?.steps ?? 2
    const count = entry.count
    const inactiveCount =
      policy.policy === 'all_inactive'
        ? count
        : policy.policy === 'half_inactive_round_up'
          ? Math.ceil(count / 2)
          : 0
    const statuses: AirStatus[] = Array.from({ length: count }, (_item, index) =>
      index < inactiveCount ? 'inactive' : 'active',
    )
    const reducedFlag = isReducedType(entry.unitId, name, policy.reducedTypes)
    if (reducedFlag) matchedReduced.push(entry.unitId)
    const reduced = Array.from({ length: count }, (_item, index) => reducedFlag && index === 0)
    const steps = reduced.map((flag) => (flag ? Math.max(printed - 1, 0) : printed))
    placements.push({
      entryIndex: entry.index,
      aircraftId: entry.unitId,
      name,
      count,
      statuses,
      reduced,
      steps,
      candidates,
      detail:
        `${count}× ${name} ⇒ 任意本方空军基地（${AIR_BASE_SITE_RULE}）；` +
        `初始激活 ${count - inactiveCount} 枚 / 非激活 ${inactiveCount} 枚` +
        `${reducedFlag ? `；其中 1 枚以减损状态初设（军力 ${printed} → ${printed - 1}）` : ''}`,
      rule: AIR_ACTIVE_RULE,
    })
  }

  for (const raw of policy.reducedTypes) {
    const key = normalizeAircraftKey(raw)
    const hit = placements.some((placement) =>
      [normalizeAircraftKey(placement.aircraftId), normalizeAircraftKey(placement.name)].some(
        (target) => target.endsWith(key),
      ),
    )
    if (!hit)
      gaps.push(`剧本页 \`*\` 标注的机型「${raw}」在本方初设条目里找不到对应机型 ⇒ 该减损不落子`)
  }

  return succeed(AIR_ACTIVE_RULE, {
    scenarioId: input.scenarioId,
    side: input.side,
    policy,
    placements,
    dataGaps: gaps,
    detail:
      `飞机初设（${AIR_ACTIVE_RULE} / ${AIR_BASE_SITE_RULE}）：剧本页原文「${policy.raw}」⇒ ` +
      `${placements.length} 个机型条目、命中减损机型 ${matchedReduced.length} 个；` +
      `政策 ${policy.policy}${policy.statedInRules ? '（规则书明文）' : '（按 IV-E 默认）'}` +
      (deadPileAircraft > 0
        ? `；另有 ${deadPileAircraft} 条飞机条目位于死亡堆（${DEAD_PILE_RULE}）⇒ 由自动初设按死亡堆处理，不进空军基地初设`
        : ''),
  })
}

/* ────────────────────────────── 开局流程步骤 ────────────────────────────── */

export interface SetupFlowStep {
  id:
    | 'scenario'
    | 'formationDraw'
    | 'truckLoad'
    | 'spOwnership'
    | 'autoSetup'
    | 'airSetup'
    | 'selfSetup'
  label: string
  rule: string
  /** 本剧本是否适用该步（不适用即跳过，不显示为待办） */
  applicable: boolean
  detail: string
}

/**
 * 开局流程步骤清单（W7 C14 的「初设与开局流程」）
 *
 * 顺序即协议：**剧本选择 → 编制抽取 → 卡车满载指定 → SP 归属划分 → 自动初设 → 飞机初设 → 玩家自定义初设**。
 * 其中「自动初设」先把剧本页里**已定格的**战斗单位与非战斗单位逐条摆好，
 * 之后才轮到玩家处理自由项（`w/i X` / 任一指挥部 / 任意空军基地）。
 *
 * 依据：专规 Setup Notes A（剧本指定布设方与先动方）、ch10/ch11（编队抽签）、
 * 通规 IV-A（自由项）、13.2h（卡车）、12.1d + 3.4b（SP 归属）、IV-E/14.1a（飞机）。
 */
export function setupFlowFor(scenarioId: string): readonly SetupFlowStep[] {
  const scenario = scenarios.scenarios.find((item) => item.id === scenarioId)
  const source = setupSourceOf(scenarioId)
  const draw = scenarios.scenarios.find((item) => item.id === source.source)?.setup.formationDraw
  const trucks = scenario?.setup.organicTrucks
  const requiresGroup = requiresPanzerGroupSpAssignment(scenarioId)
  const views = setupEntryViews(scenarioId)
  const aircraftCount = views.filter((entry) => entry.kind === 'aircraft').length
  const choiceCount = views.filter((entry) => !entry.automatic).length

  return [
    {
      id: 'scenario',
      label: '剧本选择',
      rule: SETUP_NOTES_RULE,
      applicable: true,
      detail:
        scenario === undefined
          ? `剧本库中没有剧本 ${scenarioId}`
          : `剧本 ${scenario.id}（${scenario.name}）：首回合 ${scenario.firstTurn}、共 ${scenario.turns} 回合、` +
            `先手 ${scenario.firstPlayer}、先布设 ${scenario.setupFirst}、首回合天气 ` +
            `${scenario.setup?.weatherFirstTurnRaw ?? scenario.firstWeather}（${SETUP_NOTES_RULE} A）`,
    },
    {
      id: 'formationDraw',
      label: '编制抽取（编队抽签）',
      rule: 'ch10/ch11',
      applicable: draw !== undefined,
      detail:
        draw === undefined
          ? `剧本 ${scenarioId} 的剧本页无编队抽签条目 ⇒ 跳过（数据来源：剧本 ${source.source}）`
          : `入杯 ${draw.pool} 个编队：${draw.groups.map((group) => `${group.label}×${group.count}`).join('；')}`,
    },
    {
      id: 'truckLoad',
      label: '卡车满载指定',
      rule: LOAD_RULE,
      applicable: trucks !== undefined,
      detail:
        trucks === undefined
          ? '本剧本无建制内卡车载荷规定（IV-D：未明示即空载）'
          : `剧本页「${trucks.raw}」⇒ 满载方式 ${trucks.mode}${trucks.count === undefined ? '' : `（${trucks.count} 辆）`}`,
    },
    {
      id: 'spOwnership',
      label: 'SP 归属划分',
      rule: SP_OWNERSHIP_RULE,
      applicable: true,
      detail: requiresGroup
        ? `轴方地图内 SP 须逐一点名装甲集群（Setup Note F / ${PANZER_GROUP_SP_RULE}）；苏方按 ${SP_OWNERSHIP_RULE} 归带上图的一方`
        : `SP 按 ${SP_OWNERSHIP_RULE} 归带上图的一方即可（本剧本首回合不早于 ${rulesConstPanelEnd()} ⇒ 3.4b 不适用）`,
    },
    {
      id: 'autoSetup',
      label: '自动初设（战斗单位 + 非战斗单位）',
      rule: SETUP_RULE,
      applicable: views.length > 0,
      detail:
        views.length === 0
          ? source.detail
          : `按剧本页逐格清单落位：${views.filter((entry) => entry.automatic).length} 条可直接落位条目，` +
            `另有 ${choiceCount} 条属自由项（留到下一步）`,
    },
    {
      id: 'airSetup',
      label: '飞机初设（位置 + 激活态 + 减损）',
      rule: AIR_ACTIVE_RULE,
      applicable: aircraftCount > 0,
      detail:
        aircraftCount === 0
          ? '本剧本初设条目里没有飞机条目'
          : `${aircraftCount} 条飞机条目：位置＝任意本方空军基地（${AIR_BASE_SITE_RULE}）；激活态与 \`*\` 减损按剧本页`,
    },
    {
      id: 'selfSetup',
      label: '玩家自定义初设（自由项）',
      rule: WITHIN_RULE,
      applicable: choiceCount > 0,
      detail:
        choiceCount === 0
          ? '本剧本初设没有留给玩家的自由项'
          : `${choiceCount} 条自由项：\`w/i X hexes\`（范围内任选，含边界）、\`Stacked with any … HQs\`、\`At any air bases\``,
    },
  ]
}

/** 19 August 的原文（提示用；数值来自 rules-constants） */
function rulesConstPanelEnd(): string {
  return `19 August（${rulesConstants.smolensk.panzerGroupConstraintEnd}）`
}
