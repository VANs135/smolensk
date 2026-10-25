import { arrivalsAxis, arrivalsSoviet, rulesConstants } from '@/data'
import { isArrivalTurnOf } from '../turn-driver'
import type { HexRef, Side } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'
import { hexesWithin } from '../hex-geometry'
import { isEntryLShutDown, isSouthSourcesShutDown } from './timing'

/**
 * 到达表执行（通规 13.6 / 1.6a ← 专规 1.6 / 2.1 / 3.1 / 2.1a / 2.3c / 2.4）
 *
 * ## 条文索引
 *   - **13.6 增援**：「增援是通过**抵达表**或可变增援表而进入游戏的新单位。在友方增援阶段中，
 *     它们会被放置在**它们的入场格**中。玩家**不能延迟**增援单位的进入……增援的飞机会在
 *     **任意友方空军基地**处，以**激活**状态到达。」
 *   - **13.6b**：增援可以以任何主动模式进入；**可以放置在有敌方 ZOC 的格中**；也可通过铁路抵达
 *     （忽略 13.3e 通常要求的「登车」）；**若地图边缘的入场格被敌方单位阻挡，增援可以放置在
 *     最近的且未被阻挡的地图边缘格内**。
 *   - **13.6c**：编内卡车抵达时是装载 SP 的；其他运输点数只有与 SP 在该回合抵达同一地点时才装载 SP 抵达。
 *     （本作到达卡表头另明写：「All types of Transport Points arrive loaded with SP.」）
 *   - **1.6a Removals**：被 Arrival Chart 要求「Removed」的单位（或一个 factors 完全相同的单位）
 *     **立即**移出游戏，**不论处境**（在 dead pile、被包围也算）；出图不需燃油（不进行实际移动），
 *     但必须补足 internal stocks（从下一次 Supply Table 增援中扣除）。
 *   - **专规 2.1 / 3.1 落点**：Supply Table 的 SP 放「可卸货城市格（每格 1 SP，用免费 Rail Cap，
 *     须本方可轨距通路）+ 其余放地图边缘补给源格」；**Pax / Eq / special repls / breakout returns
 *     抵达任何能直接抽取 trace supply 的 HQ，或任一地图边缘补给源格**。
 *   - **专规 2.1a**：Entry L 于 19 July 关闭；Entry E 及以西所有南缘源于 19 August 关闭（永久）。
 *   - **专规 2.3c / 2.4**：方面军预备队三批（2 SP + 编制转化 + 两次免费重建，**必须当即领取**）；
 *     慢动员按表 2-2 逐日释放被锁的师。
 *
 * ## 设计口径
 *   - 本模块把到达卡解析成**投放需求**（`ArrivalUnitDemand`），再按注入的地图事实
 *     （入口格 / 空军基地 / HQ / 边缘补给源）算出**落点**；引擎不持有地图，故事实一律注入。
 *   - **不做「到达卡条目 → 算子记录」的映射**：本作工程数据库未落该映射，引擎不臆造
 *     —— 由操作台的裁判按到达卡清单选算子落盘（`ArrivalUnitDemand` 已带番号/母类/印值供核对）。
 *   - 数值只取自 `rules-constants.json` 与到达卡数据（`arrivals-*.json`），无硬编码。
 */

/* ────────────────────────────── 日期规范化 ────────────────────────────── */

const MONTHS: readonly string[] = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/**
 * 到达卡的日期文本 → `{ month, day }`
 *
 * 卡面日期写法不统一（`8 July` / `12 Jul 41` / `1 Sep 41`），故先规范化再与 ISO 日期比对。
 */
export function normalizeArrivalDate(text: string): { month: number; day: number } | null {
  const match = /^(\d{1,2})\s+([A-Za-z]+)/.exec(text.trim())
  if (match === null) return null
  const day = Number(match[1])
  const token = match[2]!.toLowerCase()
  const month = MONTHS.findIndex((name) => name.startsWith(token.slice(0, 3)))
  if (month < 0) return null
  return { month: month + 1, day }
}

/** ISO 日期 → `{ month, day }`；非法格式返回 null */
export function isoMonthDay(iso: string): { month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (match === null) return null
  return { month: Number(match[2]), day: Number(match[3]) }
}

/**
 * 到达卡日期文本 → **ISO 日期**
 *
 * 本作全部日程都在 1941 年（卡面只写月日，个别写两位年号）⇒ 年份由卡面缺省补 1941。
 * 归到执行回合的判据见 `timingArrivalTurnOf`（`turn-driver.arrivalTurnOf` 的再导出）。
 */
export function arrivalDateIso(text: string): string | null {
  const parsed = normalizeArrivalDate(text)
  if (parsed === null) return null
  return `1941-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`
}

/* ────────────────────────────── 投放需求 ────────────────────────────── */

/** 落点类别（照到达卡的分栏与 2.1 / 3.1 的落点条文） */
export type ArrivalPlacement =
  /** 指定入口字母（如 `Entry K` / `Entry I or J` / `B or C`） */
  | { kind: 'entryHex'; letters: readonly string[]; label: string }
  /** 地理参照（`w/i 3 of 60.34`：以锚点格为圆心的半径内） */
  | { kind: 'geographic'; anchor: HexRef; radiusHexes: number; label: string }
  /** `North Edge, east of 32.xx`（北缘 32 列以东的入口格） */
  | { kind: 'northEdgeEastOf'; col: number; label: string }
  /** 任一友方空军基地（13.6：飞机以激活状态到达） */
  | { kind: 'anyAirbase'; label: string }
  /** `Any west edge hexes`（轴方 RR Eng Bn 入场卡原文） */
  | { kind: 'anyWestEdge'; label: string }
  /** 能直接抽取 trace supply 的 HQ，或任一地图边缘补给源格（2.1 / 3.1：Pax/Eq/special repls/回归） */
  | { kind: 'hqOrEdgeSource'; label: string }
  /** 直接进死亡堆 */
  | { kind: 'deadPile'; label: string }

/** 到达卡的投放需求（一条 = 到达卡上的一个条目） */
export interface ArrivalUnitDemand {
  side: Side
  /** ISO 日期（由卡面日期规范化而来） */
  date: string
  /** 卡面原文串（保真；供裁判逐个核对） */
  raw: string
  /** 分栏标签（`Entry K` / `w/i 3 of 60.34` / `Any Airbase` …） */
  label: string
  /** 条目类别（卡面/结构化视图给出） */
  kind: 'unit' | 'hq' | 'aircraft' | 'transportPoint' | 'sp' | 'airbase' | 'unclassified'
  name: string | null
  designation: string | null
  parentType: string | null
  factors: string | null
  /** 条目数量（`2x IL.2` ⇒ 2；缺省 1） */
  count: number
  /**
   * **编成条目的部件名**（`19 Pz Div (I-27 Pz, II-27 Pz, …)` ⇒ 那几枚的名字；非编成条目为空数组）
   *
   * 卡面把"多枚算子共同到场"写成一个条目。投放侧据此逐枚解析记录（§5-A）；
   * 解析不出唯一记录时不猜——整条交裁判手工逐枚摆入。
   */
  formationComponents: readonly string[]
  /** 13.6 / 到达卡：`-N step(s)` ⇒ 到场即带损的军力数 */
  stepsLost: number
  /** 13.6c / 卡头：运输点数**满载 SP** 入场 */
  loadedWithSp: boolean
  placement: ArrivalPlacement
  rule: string
  detail: string
}

/** 到达卡的强制移除（1.6a） */
export interface ArrivalRemoval {
  side: Side
  date: string
  raw: string
  rule: '1.6a'
  detail: string
}

/** 一日的到达计划 */
export interface ArrivalPlan {
  side: Side
  date: string
  /** 当日到达卡上的投放需求 */
  units: readonly ArrivalUnitDemand[]
  /** 1.6a 强制移除 */
  removals: readonly ArrivalRemoval[]
  /** 当日按 2.1a 关闭的补给源（供界面提示） */
  shutdowns: readonly string[]
  /** 卡面上的规则提示原文（照录） */
  notes: readonly string[]
  rule: string
  detail: string
}

/* ────────────────────────────── 解析 ────────────────────────────── */

/** 取该方的到达卡数据 */
function arrivalsDataOf(side: Side) {
  return side === 'axis' ? arrivalsAxis : arrivalsSoviet
}

/** 解析分栏标签订为落点 */
export function parseArrivalPlacement(label: string): ArrivalPlacement | null {
  const text = label.trim()

  const airbase = /^any\s+airbase$/i.exec(text)
  if (airbase !== null) return { kind: 'anyAirbase', label: text }

  const westEdge = /^any\s+west\s+edge/i.exec(text)
  if (westEdge !== null) return { kind: 'anyWestEdge', label: text }

  const northEdge = /north\s+edge.*east\s+of\s+(\d{1,2})/i.exec(text)
  if (northEdge !== null) return { kind: 'northEdgeEastOf', col: Number(northEdge[1]), label: text }

  const geographic = /w\/i\s+(\d{1,2})\s+of\s+(\d{1,2})\.(\d{1,2})/i.exec(text)
  if (geographic !== null) {
    return {
      kind: 'geographic',
      radiusHexes: Number(geographic[1]),
      anchor: { col: Number(geographic[2]), row: Number(geographic[3]) },
      label: text,
    }
  }

  // 入口字母：`Entry K` / `Entry I or J` / `A / D or E` / `B or C`
  const letters = /[A-L]/g
  const stripped = text.replace(/^entry\s+/i, '')
  const found = stripped.match(letters)
  if (found !== null && found.length > 0 && /^[A-L][\sA-Lor/|]*$/i.test(stripped)) {
    return { kind: 'entryHex', letters: [...new Set(found)], label: text }
  }

  return null
}

/**
 * 编成条目的**部件名**：括号里以逗号分隔的每一项（去掉卡面附带的说明性尾巴）
 *
 * 只认「括号里有逗号」的形态，且**丢掉非部件**的片段（`; one is -1 step`、`each -1 step` 之类）——
 * 那些是卡面批注，不是算子名。
 */
export function arrivalComponentNames(raw: string): readonly string[] {
  const inner = /\(([^)]*)\)/.exec(raw)
  if (inner === null) return []
  const body = inner[1] ?? ''
  if (!body.includes(',')) return []
  return body
    .split(',')
    .map((part) => part.replace(/;.*$/, '').trim())
    .filter((part) => part !== '' && !/^(each|one|two|three)\b/i.test(part))
}

/** 卡面条目类别 → 需求类别 */
function demandKindOf(rosterKind: string | undefined, raw: string): ArrivalUnitDemand['kind'] {
  if (rosterKind === 'hq') return 'hq'
  // 编成条目（`19 Pz Div (I-27 Pz, …)`）是**若干枚算子共同到场**，按算子需求走投放（逐枚，见 `formationComponents`）
  if (rosterKind === 'formation') return 'unit'
  if (rosterKind === 'unit') {
    return /(Truck|Wagon|Mule)\s+Point/i.test(raw) ? 'transportPoint' : 'unit'
  }
  if (/Airbase/i.test(raw)) return 'airbase'
  if (/Points?\b/i.test(raw)) return 'transportPoint'
  if (/^SP\b|\d+\s*SP\b/i.test(raw)) return 'sp'
  return 'unclassified'
}

/** `2x IL.2` / `3 Truck Points` / `4-2-3 NKVD Inf Rgt` 的数量 */
function countOf(raw: string, rosterCount: number | undefined): number {
  if (typeof rosterCount === 'number' && rosterCount > 0) return rosterCount
  const match = /^(\d+)\s*x?\s+/i.exec(raw.trim())
  if (match !== null) {
    const value = Number(match[1])
    // `4-2-3 Inf Div` 的 4 是战斗值，不是数量 ⇒ 仅在带 `x` 或后接地名/点数时取数量
    if (/^(\d+)\s*x\s/i.test(raw) || /^\d+\s+(Truck|Wagon|Mule|Reserve|SP|Airbase)/i.test(raw))
      return value
  }
  return 1
}

/** 到达卡结构化条目（groups[].units[]）的最小视图 */
interface RosterItem {
  raw: string
  factors?: string
  count?: number
  kind?: string
  name?: string
  designation?: string
  parentType?: string
  stepsLost?: number
  locationKind?: string
  location?: string
}

/**
 * 执行一日的到达表（13.6 / 1.6a / 专规 2.1a）
 *
 * 产出**投放需求**与**强制移除**；具体落到哪一格由 `resolveArrivalPlacement` 按注入的地图事实算出。
 */
export function planArrivals(input: { side: Side; date: string }): RuleOutcome<ArrivalPlan> {
  const { side, date } = input
  const data = arrivalsDataOf(side)
  if (isoMonthDay(date) === null) return fail('13.6', `invalidDate:${date}`)

  /*
   * 13.6 / 专规 2.3c：日程归位走 `arrivalTurnOf`（**轨上第一个 ≥ 卡面日期的回合**）。
   *
   * ★ 回合轨日期已于 2026-09-15 按用户裁定修正（8 月/9 月首回合＝1 日）⇒ 到货卡的 26 块
   *   **逐条精确命中**，归位对既有日程是恒等映射；保留它是为了确定性（口径只有一处）。
   *   背景与证据见 `turn-driver.arrivalTurnOf` 的注释。
   */
  const blocks = data.blocks.filter((block) => {
    const scheduled = arrivalDateIso(block.date)
    return scheduled !== null && isArrivalTurnOf(scheduled, date)
  })

  const units: ArrivalUnitDemand[] = []
  const removals: ArrivalRemoval[] = []
  const notes: string[] = []
  const shutdowns: readonly string[] = shutdownsFor(side, date)

  for (const block of blocks) {
    for (const note of block.notes ?? []) notes.push(note)
    for (const raw of block.remove ?? []) {
      removals.push({
        side,
        date,
        raw,
        rule: '1.6a',
        detail: `${raw}：按到达卡**立即**移出游戏（1.6a：不论处境，含死亡堆与包围中；出图不耗燃油，但须补足部队储备并从下次 Supply Table 中扣除）`,
      })
    }
    for (const raw of block.deadPile ?? []) {
      removals.push({
        side,
        date,
        raw,
        rule: '1.6a',
        detail: `${raw}：按到达卡**直接进入死亡堆**（1.6a 的到达卡用法）`,
      })
    }

    const groups = block.groups ?? []
    for (const group of groups) {
      const placement = parseArrivalPlacement(group.label)
      if (placement === null) continue
      for (const item of group.units as readonly RosterItem[]) {
        units.push(buildDemand({ side, date, placement, item }))
      }
    }

    // 无结构化视图时退化为按分栏标签 + 原文串（仍可执行，只是没有番号/印值细节）
    if (groups.length === 0) {
      for (const [label, raws] of Object.entries(block.entries)) {
        const placement = parseArrivalPlacement(label)
        if (placement === null) continue
        for (const raw of raws) units.push(buildDemand({ side, date, placement, item: { raw } }))
      }
    }

    // 独立子块：Any Airbase / Any west edge / 死亡堆
    for (const raw of block.anyAirbase ?? []) {
      units.push(
        buildDemand({
          side,
          date,
          placement: { kind: 'anyAirbase', label: 'Any Airbase' },
          item: { raw },
        }),
      )
    }
    for (const raw of block.anyWestEdge ?? []) {
      units.push(
        buildDemand({
          side,
          date,
          placement: { kind: 'anyWestEdge', label: 'Any west edge hexes' },
          item: { raw },
        }),
      )
    }
    for (const raw of block.deadPile ?? []) {
      units.push(
        buildDemand({
          side,
          date,
          placement: { kind: 'deadPile', label: 'Dead Pile' },
          item: { raw },
        }),
      )
    }
  }

  const aircraft = units.filter((unit) => unit.kind === 'aircraft').length
  return succeed('13.6', {
    side,
    date,
    units,
    removals,
    shutdowns,
    notes,
    rule: '13.6',
    detail:
      `${side === 'axis' ? '轴心' : '苏联'}方 ${date} 到达表：投放需求 ${units.length} 条` +
      `（其中空中 ${aircraft} 条，落点为任一友方空军基地且以激活状态到达）、强制移除 ${removals.length} 条` +
      (shutdowns.length === 0 ? '' : `；当日生效的补给源关闭：${shutdowns.join('、')}（2.1a）`),
  })
}

/** 组装一条投放需求 */
function buildDemand(input: {
  side: Side
  date: string
  placement: ArrivalPlacement
  item: RosterItem
}): ArrivalUnitDemand {
  const { side, date, placement, item } = input
  const raw = item.raw
  let kind = demandKindOf(item.kind, raw)
  if (kind === 'unclassified' && placement.kind === 'anyAirbase') kind = 'aircraft'
  if (kind === 'unit' && /IL\.2|MiG|SB\.|Yak|LaGG|Pe\.|Ju\.|Bf\.|He\.|Fw\./i.test(raw)) {
    kind = 'aircraft'
  }

  const count = countOf(raw, item.count)
  const stepsLost = Math.max(0, Math.trunc(item.stepsLost ?? 0))
  // 编成条目的部件名（只有 rosterKind === 'formation' 才算；`20-4-3 Inf Div (5, 35; …)` 那种点名**不是**编成）
  const formationComponents = item.kind === 'formation' ? arrivalComponentNames(raw) : []
  // 13.6c：运输点满载 SP 入场；其余依卡头「All types of Transport Points arrive loaded with SP.」
  const loadedWithSp = kind === 'transportPoint' || /loaded with SP/i.test(raw)

  const rule = kind === 'aircraft' ? '13.6' : placement.kind === 'deadPile' ? '1.6a' : '13.6'
  return {
    side,
    date,
    raw,
    label: placement.label,
    kind,
    name: item.name ?? null,
    designation: item.designation ?? null,
    parentType: item.parentType ?? null,
    factors: item.factors ?? null,
    count,
    formationComponents,
    stepsLost,
    loadedWithSp,
    placement,
    rule,
    detail:
      `${raw}：数量 ${count}` +
      (stepsLost > 0 ? `，到场即带损 ${stepsLost} step（到达卡 -${stepsLost} step）` : '') +
      (loadedWithSp ? '，满载 SP 入场（13.6c）' : '') +
      `；落点 ${describePlacement(placement)}`,
  }
}

/**
 * 13.6：该条目**应当投放几枚算子**
 *
 * 修前 `count` 只写进了 `detail` 文案、**投放侧从不读**：卡面写 `2x ...`（两枚一模一样的算子）
 * 时，界面只能放一枚，且放完即被"已投放"账本挡住 ⇒ 另一半永远进不了场。
 *
 * 只有**同型复制**才是多枚：
 * - `2x 26-2-2 Arty Grp` / `2x 2-1-3 Alarm Tk Bn` / `2x 26-1-1 Arty Bde` ⇒ 2 枚；
 * - 但卡面在括号里**逐枚点名**的（`2x Corps HQ (9, 12)`：第 9 与第 12 军部是两枚**不同**算子）
 *   ⇒ 不是复制，仍按一枚算（裁判各挑各的记录分别投放，13.6 不臆造"哪两枚"）；
 * - 运输点数/补给点（`3 Truck Points`）的"3"是**运力点数**而不是枚数（13.6c）⇒ 恒 1 枚；
 * - 编成条目（`19 Pz Div (I-27 Pz, …)`）由数枚**不同**算子共同到场，本函数也返回 1
 *   （其逐枚投放需要「条目→多枚记录」的映射数据，属 §5-A 剩余项，不由本函数臆造）。
 */
export function arrivalCopiesOf(demand: ArrivalUnitDemand): number {
  if (demand.kind !== 'unit' && demand.kind !== 'hq' && demand.kind !== 'aircraft') return 1
  if (!/^\d+\s*x\s/i.test(demand.raw.trim())) return 1
  // 括号里有逗号 ⇒ 卡面在逐枚点名（不同算子），不能拿同一枚复制
  if (/\([^)]*,[^)]*\)/.test(demand.raw)) return 1
  return Math.max(1, Math.min(demand.count, MAX_ARRIVAL_COPIES))
}

/** 一次投放最多复制几枚（防数据错写成 `99x` 时把盘面刷爆） */
export const MAX_ARRIVAL_COPIES = 8

/** 落点描述（日志与界面用） */
export function describePlacement(placement: ArrivalPlacement): string {
  switch (placement.kind) {
    case 'entryHex':
      return `入口 ${placement.letters.join(' / ')}（13.6；若被敌方阻挡则取最近的未被阻挡边缘格，13.6b）`
    case 'geographic':
      return `以 ${placement.anchor.col}.${placement.anchor.row} 为圆心 ${placement.radiusHexes} 格内（地理参照）`
    case 'northEdgeEastOf':
      return `北缘 ${placement.col} 列以东的入口格`
    case 'anyAirbase':
      return '任一**友方空军基地**（13.6：飞机以激活状态到达）'
    case 'anyWestEdge':
      return '西缘任意格（入场卡原文）'
    case 'hqOrEdgeSource':
      return '能直接抽取追溯补给的 HQ，或任一地图边缘补给源格（2.1 / 3.1）'
    case 'deadPile':
      return '死亡堆（1.6a）'
  }
}

/** 专规 2.1a：当日生效的补给源关闭 */
export function shutdownsFor(side: Side, date: string): readonly string[] {
  const out: string[] = []
  if (side === 'soviet') {
    if (isEntryLShutDown(date)) out.push('Entry L')
    if (isSouthSourcesShutDown(date)) out.push('Entry E 及以西所有南缘源')
  }
  return out
}

/* ────────────────────────────── 落点解算（注入地图事实） ────────────────────────────── */

/** 落点解算所需的地图与盘面事实（由调用方注入；引擎不持有地图） */
export interface ArrivalPlacementFacts {
  /** 入口字母 → 该入口在图上的格（map-config 的 entryHexes） */
  entryHexes(letter: string): readonly HexRef[]
  /** 13.6b：该格是否被**敌方单位**阻挡（被阻挡则改最近的未被阻挡的边缘格） */
  isBlocked(hex: HexRef): boolean
  /** 13.6b：从给定格出发，最近的**未被阻挡的地图边缘格** */
  nearestOpenEdgeHex(from: HexRef): HexRef | null
  /** 13.6：该方当前可用的友方空军基地格 */
  friendlyAirBaseHexes(): readonly HexRef[]
  /** 2.1 / 3.1：能以**直接拖取**取得追溯补给的友方 HQ 格 */
  directDrawHqHexes(): readonly HexRef[]
  /** 2.1 / 3.1：地图边缘补给源格 */
  edgeSupplySourceHexes(): readonly HexRef[]
  /** 西缘格（轴方 RR Eng Bn 的「Any west edge hexes」） */
  westEdgeHexes(): readonly HexRef[]
  /**
   * `North Edge, east of 32.xx` 的判据：该格是否位于**北缘**
   *
   * 本作的朝向裁定为「行号增大＝向北」（见 CODE_SPEC 坐标约定），故「北缘」由调用方按地图给出，
   * 引擎不写死行号。
   */
  isNorthEdge(hex: HexRef): boolean
}

/** 落点解算结论 */
export interface ArrivalPlacementResult {
  status: 'placed' | 'fallbackEdge' | 'entryShutDown' | 'noHex' | 'noAirbase' | 'noHq' | 'deadPile'
  hex: HexRef | null
  rule: string
  detail: string
}

/**
 * 13.6：**该落点声明允许哪些格**（卡面口径 ⇒ 候选；与 `resolveArrivalPlacement` 同源）
 *
 * ★ 用户 2026-10-25 实测 BUG①：「放增援的时候可以任意放，没按剧本要求做好限制」——
 *   修前界面给的是"任意格"（`candidates: 'any'`），于是入场卡写 `Entry K` 的条目能被摆到地图另一头。
 *   现在"落点由谁定"改成**卡面定范围**：13.6 的原文就是「放置在它们的**入场格**中」，
 *   13.6b 另给了唯一的退路（入场格被敌方阻挡 ⇒ 最近的未被阻挡边缘格）。
 *
 * 返回空数组＝该条目**没有可放的格**（进死亡堆 / 无基地 / 无可用入口）⇒ 调用方应说明原因，
 * 而不是退回"任意格"（不猜）。
 */
export function arrivalPlacementCandidates(
  placement: ArrivalPlacement,
  facts: ArrivalPlacementFacts,
): readonly HexRef[] {
  switch (placement.kind) {
    case 'deadPile':
      return []

    case 'anyAirbase':
      return facts.friendlyAirBaseHexes()

    case 'anyWestEdge':
      return facts.westEdgeHexes()

    case 'hqOrEdgeSource': {
      const hqs = facts.directDrawHqHexes()
      // 2.1 / 3.1：有"可直接拖取"的 HQ 就只落在那些 HQ；没有才退到边缘补给源格
      return hqs.length > 0 ? hqs : facts.edgeSupplySourceHexes()
    }

    case 'geographic':
      return hexesWithin(placement.anchor, placement.radiusHexes, { onMapOnly: true })

    case 'northEdgeEastOf':
      return facts
        .edgeSupplySourceHexes()
        .filter((hex) => facts.isNorthEdge(hex) && hex.col >= placement.col)

    case 'entryHex': {
      const open: HexRef[] = []
      const blockedFirst: HexRef[] = []
      for (const letter of placement.letters) {
        const candidates = facts.entryHexes(letter)
        if (candidates.length === 0) continue
        const free = candidates.filter((hex) => !facts.isBlocked(hex))
        if (free.length > 0) {
          open.push(...free)
          continue
        }
        // 13.6b：该入口全被敌方单位阻挡 ⇒ 最近的未被阻挡边缘格（唯一的合法退路）
        const fallback = facts.nearestOpenEdgeHex(candidates[0]!)
        if (fallback !== null) blockedFirst.push(fallback)
      }
      return open.length > 0 ? open : blockedFirst
    }
  }
}

/**
 * 把一个落点声明解算成具体格（13.6 / 13.6b / 专规 2.1a）
 *
 * - 入口格被敌方阻挡 ⇒ 取**最近的未被阻挡的地图边缘格**（13.6b）；
 * - 该入口已按 2.1a 关闭 ⇒ `entryShutDown`（不得在该处入场，须改走仍开放的入口）；
 * - 飞机 ⇒ 任一友方空军基地；无基地即 `noAirbase`；
 * - Pax/Eq/特殊补员/回归 ⇒ 能直接拖取的 HQ，否则边缘补给源格；都没有即 `noHq`。
 */
export function resolveArrivalPlacement(
  placement: ArrivalPlacement,
  facts: ArrivalPlacementFacts,
): ArrivalPlacementResult {
  switch (placement.kind) {
    case 'deadPile':
      return { status: 'deadPile', hex: null, rule: '1.6a', detail: '直接进入死亡堆（1.6a）' }

    case 'anyAirbase': {
      const bases = facts.friendlyAirBaseHexes()
      if (bases.length === 0)
        return {
          status: 'noAirbase',
          hex: null,
          rule: '13.6',
          detail: '该方没有友方空军基地，飞机无法以激活状态到达（13.6）',
        }
      return {
        status: 'placed',
        hex: bases[0]!,
        rule: '13.6',
        detail: `任一友方空军基地（共 ${bases.length} 处候选；13.6：以激活状态到达）`,
      }
    }

    case 'anyWestEdge': {
      const hexes = facts.westEdgeHexes()
      if (hexes.length === 0)
        return { status: 'noHex', hex: null, rule: '13.6', detail: '地图上没有西缘格' }
      return {
        status: 'placed',
        hex: hexes[0]!,
        rule: '13.6',
        detail: `西缘任意格（共 ${hexes.length} 处候选，入场卡原文）`,
      }
    }

    case 'hqOrEdgeSource': {
      const hqs = facts.directDrawHqHexes()
      if (hqs.length > 0)
        return {
          status: 'placed',
          hex: hqs[0]!,
          rule: '2.1',
          detail: `能直接抽取追溯补给的 HQ（共 ${hqs.length} 处候选；2.1 / 3.1）`,
        }
      const edges = facts.edgeSupplySourceHexes()
      if (edges.length > 0)
        return {
          status: 'placed',
          hex: edges[0]!,
          rule: '2.1',
          detail: `地图边缘补给源格（无可用 HQ ⇒ 退到边缘源格；共 ${edges.length} 处候选）`,
        }
      return {
        status: 'noHq',
        hex: null,
        rule: '2.1',
        detail: '既无「可直接拖取追溯补给的 HQ」也无边缘补给源格，无法投放（2.1 / 3.1）',
      }
    }

    case 'geographic': {
      return {
        status: 'placed',
        hex: placement.anchor,
        rule: '13.6',
        detail: `以 ${placement.anchor.col}.${placement.anchor.row} 为圆心 ${placement.radiusHexes} 格内任选（地理参照）`,
      }
    }

    case 'northEdgeEastOf': {
      const hexes = facts
        .edgeSupplySourceHexes()
        .filter((hex) => facts.isNorthEdge(hex) && hex.col >= placement.col)
      if (hexes.length === 0)
        return {
          status: 'noHex',
          hex: null,
          rule: '13.6',
          detail: `北缘 ${placement.col} 列以东没有可用的边缘格`,
        }
      return {
        status: 'placed',
        hex: hexes[0]!,
        rule: '13.6',
        detail: `北缘 ${placement.col} 列以东的边缘格（共 ${hexes.length} 处候选）`,
      }
    }

    case 'entryHex': {
      for (const letter of placement.letters) {
        const candidates = facts.entryHexes(letter)
        if (candidates.length === 0) continue
        const open = candidates.find((hex) => !facts.isBlocked(hex))
        if (open !== undefined) {
          return {
            status: 'placed',
            hex: open,
            rule: '13.6',
            detail: `入口 ${letter}：${open.col}.${open.row}（13.6：按入场格放置）`,
          }
        }
        // 13.6b：该入口的所有格都被敌方单位阻挡 ⇒ 取最近的未被阻挡边缘格
        const fallback = facts.nearestOpenEdgeHex(candidates[0]!)
        if (fallback !== null) {
          return {
            status: 'fallbackEdge',
            hex: fallback,
            rule: '13.6b',
            detail:
              `入口 ${letter} 被敌方单位阻挡 ⇒ 改投最近的未被阻挡边缘格 ${fallback.col}.${fallback.row}` +
              `（13.6b）`,
          }
        }
      }
      return {
        status: 'noHex',
        hex: null,
        rule: '13.6b',
        detail: `入口 ${placement.letters.join(' / ')} 无可用的入场格，也没有可用的边缘格（13.6b）`,
      }
    }
  }
}

/* ────────────────────────────── 专规 2.1 / 3.1：免费铁运落点 ────────────────────────────── */

/**
 * 专规 2.1 / 3.1 + 通规 13.3c：**免费铁运**的候选格（**可卸载城市格**）
 *
 * 原文（源库 `rules.json → exclusive_rules_smolensk.free_rail_cap_sp.rule_text_free_rail`）：
 * 「**1 SP of Supply Table arrivals can be placed in each detrainable city hex using 'free' Rail Cap.
 *   The hexes must have valid rail movement paths (per OCS 13.3e) via broad gauge rails [Soviet] /
 *   standard gauge rails [Axis]. The rest of the SP is put in map-edge supply source hexes.**」
 * ⇒ ① 只有**补给表到货**的 SP 能用免费铁运；② 每格**最多 1 SP**；③ 只限**可卸载城市格**
 *    （13.3c 的运行时结论，且是其中的**城市**格 —— 村庄不在内）；④ **不扣铁路运量**（13.3b 的运量另算）；
 *    ⑤ 其余 SP 放**图边补给源格**。
 */
export interface FreeRailCandidate {
  hex: HexRef
  name: string
}

/** 免费铁运 / 3.6 补给列车 / 余额 的落点（一条 = 一个格） */
export interface FreeRailPlacement {
  hex: HexRef
  sp: number
  /** 这一笔的依据：免费铁运（2.1/3.1）／3.6 补给列车／图边补给源格（余额） */
  reason: 'freeRail' | 'supplyTrain' | 'edgeSource'
}

/** 免费铁运的落点计划 */
export interface FreeRailPlan {
  placements: readonly FreeRailPlacement[]
  /** 走免费铁运的 SP（＝勾选的格数，每格 1 SP） */
  freeSp: number
  /** 其余落到图边补给源格的 SP */
  edgeSp: number
  /** 3.6 Supply Train 给的额外 SP（不用 Rail Cap） */
  supplyTrainSp: number
  /**
   * 本笔消耗的铁路运量 —— **恒 0**
   *
   * 2.1/3.1 明写用「free Rail Cap」，3.6 明写「no Rail Cap used」⇒ 这一项是**判据的表达**，
   * 不是"还没算"：日后若给免费铁运加运量上限，这里就是唯一要改的地方。
   */
  railCapUsed: 0
  rule: string
  detail: string
}

/**
 * 专规 2.1 / 3.1 / 3.6：算出补给表到货 SP 的落点
 *
 * 判据全部取自原文（见 `FreeRailCandidate` 的摘录）：
 *   - 每格最多 1 SP（同一格勾两次 ⇒ 拒）；
 *   - 只能勾**候选格**（候选＝13.3c 可卸货格中的城市格；候选本身必须 ⊆ 注入的可卸货格 —— 接线守卫）；
 *   - 勾的数量不能超过当日到货 SP（否则是"多给了 SP"）；
 *   - 还有余额（`edgeSp > 0`）⇒ **必须**给定一个图边补给源格；余额为 0 时不需要；
 *   - 3.6 的 Supply Train（2 SP）落**任一可卸货格**（不限城市），也**不用 Rail Cap**。
 *
 * 本函数**只算落点**（哪个格几 SP）；落盘（12.1b 的账本条目）由调用方做。
 */
export function planFreeRailArrivals(input: {
  /** 1.6b 补给表当日到货 SP */
  sp: number
  /** 免费铁运候选（可卸载**城市**格；运行时结论由调用方按 13.3c 注入） */
  candidates: readonly FreeRailCandidate[]
  /** 运行期的 13.3c 可卸货格全集（用于校验候选与 3.6 的落点） */
  detrainableHexes: readonly HexRef[]
  /** 玩家勾选的格（每格 1 SP；允许为空＝全部走图边源） */
  picked: readonly HexRef[]
  /** 余额的落点：图边补给源格（`edgeSp === 0` 时可省略） */
  edgeHex: HexRef | null
  /** 本剧本本方的图边补给源格（2.1 / 3.1） */
  edgeSourceHexes: readonly HexRef[]
  /** 3.6 Supply Train 的额外 SP（缺省 0） */
  supplyTrainSp?: number
  /** 3.6 的落点：**任一可卸货格**（有额外 SP 时必须给） */
  supplyTrainHex?: HexRef | null
}): RuleOutcome<FreeRailPlan> {
  const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
  const sp = input.sp
  if (!Number.isInteger(sp) || sp < 0) return fail('2.1', `badArrivalSp:${sp}`)
  const supplyTrainSp = input.supplyTrainSp ?? 0
  if (!Number.isInteger(supplyTrainSp) || supplyTrainSp < 0)
    return fail('3.6', `badSupplyTrainSp:${supplyTrainSp}`)

  const detrainableKeys = new Set(input.detrainableHexes.map(key))
  const candidateKeys = new Set(input.candidates.map((item) => key(item.hex)))
  // 接线守卫：候选必须是「13.3c 可卸货格」——城市格的静态筛选不能替掉运行期判定（否则会摆到被敌占的城里）
  for (const candidate of input.candidates) {
    if (!detrainableKeys.has(key(candidate.hex)))
      return fail('2.1', `freeRailCandidateNotDetrainable:${key(candidate.hex)}`)
  }

  const placements: FreeRailPlacement[] = []
  const seen = new Set<string>()
  for (const hex of input.picked) {
    const text = key(hex)
    if (seen.has(text)) return fail('2.1', `duplicateFreeRailHex:${text}`)
    seen.add(text)
    if (!candidateKeys.has(text)) return fail('13.3c', `notDetrainableCityHex:${text}`)
    placements.push({ hex: { ...hex }, sp: 1, reason: 'freeRail' })
  }
  if (placements.length > sp)
    return fail('2.1', `freeRailExceedsArrivalSp:${String(placements.length)}>${String(sp)}`)

  const freeSp = placements.length
  const edgeSp = sp - freeSp
  if (edgeSp > 0) {
    if (input.edgeHex === null) return fail('2.1', 'edgeHexRequiredForRemainder')
    const edgeText = key(input.edgeHex)
    if (!input.edgeSourceHexes.some((hex) => key(hex) === edgeText))
      return fail('2.1', `notEdgeSupplySource:${edgeText}`)
    placements.push({ hex: { ...input.edgeHex }, sp: edgeSp, reason: 'edgeSource' })
  }

  if (supplyTrainSp > 0) {
    const trainHex = input.supplyTrainHex ?? null
    if (trainHex === null) return fail('3.6', 'supplyTrainHexRequired')
    const trainText = key(trainHex)
    if (!detrainableKeys.has(trainText))
      return fail('3.6', `supplyTrainHexNotDetrainable:${trainText}`)
    placements.push({ hex: { ...trainHex }, sp: supplyTrainSp, reason: 'supplyTrain' })
  }

  const edgeText = edgeSp > 0 && input.edgeHex !== null ? key(input.edgeHex) : '—'
  return succeed('2.1', {
    placements,
    freeSp,
    edgeSp,
    supplyTrainSp,
    railCapUsed: 0,
    rule: '2.1 / 3.1',
    detail:
      `免费铁运：${String(freeSp)} 格可卸载城市格各 1 SP（不扣铁路运量，2.1/3.1）` +
      (edgeSp > 0 ? `；其余 ${String(edgeSp)} SP 放图边补给源格 ${edgeText}` : '；无余额') +
      (supplyTrainSp > 0
        ? `；3.6 补给列车 ${String(supplyTrainSp)} SP 落 ${key(input.supplyTrainHex!)}（不用 Rail Cap）`
        : ''),
  })
}

/* ────────────────────────────── 专规 2.3c / 2.4 ────────────────────────────── */

/** 方面军预备队批次（专规 2.3c；数据源 rules-constants.smolensk.frontalReserves） */
export interface FrontalReservesBatch {
  date: string
  sp: number
  convertFrom: string
  convertTo: string
  freeRebuilds: readonly string[]
}

/**
 * 该日的方面军预备队批次（无则 null）
 *
 * ★ 归位走 `arrivalTurnOf`：三批的卡面日期（22 Jul / 1 Aug / 1 Sep）在**修正后的回合轨上**
 *   都是真实回合（第 5 / 8 / 17 回合）⇒ 归位即恒等；保留它是为了归位口径只有一处。
 */
export function frontalReservesBatch(date: string): FrontalReservesBatch | null {
  const batch = rulesConstants.smolensk.frontalReserves.batches.find((item) =>
    isArrivalTurnOf(item.date, date),
  )
  return batch === undefined ? null : batch
}

/**
 * 专规 2.3c：方面军预备队的领取
 *
 * 「到货**必须立刻使用**，不能保存」⇒ 本函数只返回当日批次内容，
 * 由调用方按 2.1 的落点条文投放 2 SP、执行编制转化（旧单位按 1.6a Removal 处理）并发两次免费重建
 * （一架 IL.2 ＋ 一个 HQ 或 artillery，玩家择一）。
 */
export function claimFrontalReserves(date: string): RuleOutcome<FrontalReservesBatch> {
  const batch = frontalReservesBatch(date)
  if (batch === null) return fail('2.3c', `noFrontalReservesAtDate:${date}`)
  return succeed('2.3c', batch)
}

/** 慢动员释放（专规 2.4 表 2-2） */
export interface SlowMobilizationUnlock {
  date: string
  army: '30th' | '28th' | '24th'
  /** 当日该集团军可**解锁**（转为可动）的师数 */
  unlockDivisions: number
}

/** 该日各集团军的解锁量（无则空数组；日程归位同上，走 `arrivalTurnOf`） */
export function slowMobilizationUnlocks(date: string): readonly SlowMobilizationUnlock[] {
  return rulesConstants.smolensk.slowMobilization.table.filter((row) =>
    isArrivalTurnOf(row.date, date),
  )
}

/**
 * 专规 2.4：Slow Mobilization 的锁定与解锁口径
 *
 * 「被锁的师**不能移动**（也不能拆出 breakdown）；解锁按表分批（玩家自选具体哪个师）」
 * ⇒ 解锁时由玩家在**被锁的师**中自选至多 `unlockDivisions` 个；本函数只给出数量与合法性。
 */
export function planSlowMobilization(input: {
  date: string
  army: '30th' | '28th' | '24th'
  /** 该集团军当前仍被锁的师数 */
  lockedDivisions: number
  /** 本次想把几个师解锁（玩家选择的数量） */
  unlockRequested: number
}): RuleOutcome<{ unlocked: number; remainingLocked: number; rule: string; detail: string }> {
  const quota = slowMobilizationUnlocks(input.date)
    .filter((row) => row.army === input.army)
    .reduce((sum, row) => sum + row.unlockDivisions, 0)
  if (quota === 0) return fail('2.4', `noUnlockQuota:${input.date}:${input.army}`)
  if (input.unlockRequested > quota)
    return fail('2.4', `unlockExceedsQuota:${input.unlockRequested}>${quota}`)
  if (input.unlockRequested > input.lockedDivisions)
    return fail('2.4', `unlockExceedsLocked:${input.unlockRequested}>${input.lockedDivisions}`)
  const unlocked = Math.max(0, Math.trunc(input.unlockRequested))
  return succeed('2.4', {
    unlocked,
    remainingLocked: input.lockedDivisions - unlocked,
    rule: '2.4',
    detail:
      `第 ${input.army} 集团军于 ${input.date} 解锁 ${unlocked} 个师` +
      `（当日配额 ${quota}，玩家在锁定师中自选；剩余锁定 ${input.lockedDivisions - unlocked} 个，2.4）`,
  })
}

/*
 * 1.6c 的日期闸门（「19 August 起停止」）**只有一处实现**：`timing.isSpecialReplAvailable`。
 * 消费方：`containers.specialReplBoxView`（盒的 active 旗标 → 面板按钮可用性）。
 * 本模块原先另有一个 `specialReplRollRequired` 只是它的同义转发（多一个公开名、零额外语义），已删。
 */
