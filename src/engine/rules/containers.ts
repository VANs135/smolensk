import { markers, rulesConstants, scenarios, formations } from '@/data'
import type { HexRef, Side, UnitSide } from '@/data'

import { isOnMap, neighbor } from '../hex-geometry'

import { fail, succeed, type RuleOutcome } from '../result-types'
import type { AirStatus, FlightWeather, GamePhase, GroundWeather, UnitKind } from '../state-types'
import {
  isFreeSpecialReplEligible,
  specialReplRoll,
  type SpecialReplResult,
} from '../tables/supply-repl'
import {
  airBoxRangeHexes,
  airBoxRefitCapacity,
  airBoxRules,
  canEnterEdgeBox,
  edgeBoxConnection,
  edgeBoxRules,
  type AirBoxRules,
  type EdgeBoxConnection,
  type EdgeBoxId,
  type EdgeBoxRules,
  type RefitCapacity,
} from './air-mission'
import { planBreakdownCreate, type BreakdownCreateRequest } from './breakdown'
import { breakdownPoolLimits, breakdownPoolTotal, railCapacitiesOn } from './exclusive-timing'
import { isRailCapBoosted, isSpecialReplAvailable } from './timing'
import { specialReplRebuildRows } from './variable-repl'

/**
 * 记录轨与容器管理（W7 C12）
 *
 * ## 这一层做什么
 *   把「桌面上摆着的那些**轨**与**盒**」变成可查看、可操作、且**与规则一一对应**的数据：
 *     · **记录轨**：回合轨（Turn Record Track）、天气标记、铁路容量轨（13.3b / 专规 1.2）；
 *     · **容器**：死亡堆、拆分单位盒、1.6c 特殊补员抽取盒、剧本抽取盒、
 *       地图外空军盒（1.4a）、边缘盒（1.4b）、编队收纳盒（13.7 / 3.6f）。
 *   每个盒给出**名册（BoxView）**与**操作计划（planXxx）**；名册供界面铺开，
 *   计划交给状态层落盘（引擎不写状态，CODE_SPEC §3.1）。
 *
 * ## 硬纪律（不得无中生有）
 *   1. **数值全部来自数据**：轨位数与刻度取自 `markers.json`，容量取自 `rules-constants.json`，
 *      拆解单位上限取自 `1.8a counterLimits`，特殊补员表取自 `charts-supply-repl.json`；
 *      本模块**不含任何规则数字字面量**。
 *   2. **不掷骰**：抽取类操作由调用方用 `engine/rng.ts` 掷骰并把结果传入；
 *      本模块只按规则**判候选池、判资格、给出抽中后的落点**（种子化重放的唯一入口在 rng.ts）。
 *   3. **数据缺口如实标注**：凡规则书要求、但当前数据里查不到的（例如单位库未标注 2.3a Alarm 单位、
 *      剧本原文未逐条列出被抽中的编队、编队下属标签与单位库命名不同口径），
 *      一律进 `dataGaps` 或要求调用方注入，**绝不猜**。
 *   4. **复用既有判定**：地图外盒与边缘盒的静态规则走 `air-mission.ts`（`airBoxRules` / `edgeBoxRules`
 *      / `canEnterEdgeBox`），拆分的创建判定走 `breakdown.ts`（`planBreakdownCreate`），
 *      重建表走 `rebuild.ts`，**不另立第二份口径**。
 *
 * ## 盒的美工接口
 *   `BoxView.artwork` 为可选图档（`BoxArtwork`）；数据侧落在 `markers.json` 的
 *   `containers.artwork[boxId]`（键＝盒 id）。缺省即 null ⇒ 界面退化为纯文字盒。
 */

/* ────────────────────────────── 盒的美工与名册 ────────────────────────────── */

/**
 * 盒子美工接口（W7 C12）
 *
 * 「留接口让以后可以让每个盒都有图片美工」：本作数据尚未提供盒图，故**全部为可选**；
 * 数据侧键为盒 id（见 `boxArtwork()`），拿到即用，拿不到就渲染纯文字盒 —— 不影响任何规则判定。
 */
export interface BoxArtwork {
  /** 图档键（对应静态资源；null = 该盒无图） */
  imageKey: string | null
  /** 建议渲染尺寸（像素；缺省由界面按列宽决定） */
  widthPx?: number
  heightPx?: number
  /** 盒面分栏数（如空军盒的 Active / Inactive 两栏） */
  columns?: number
  note?: string
}

/** 盒内分栏（空军盒按 14.1a 的 Active / Inactive 分栏；其余盒恒单栏） */
export interface BoxSection {
  id: string
  label: string
  /** 依据规则号 */
  rule: string
}

/** 盒内的一枚（单位）；`sectionId` 指明落在哪一栏 */
export interface BoxHolding {
  /** 单位实例 id（无实例时为静态库 id） */
  unitId: string
  /** 显示名（缺省由界面按 id 兜底） */
  name?: string
  side: UnitSide
  sectionId: string
  /** 分组（剧本抽取盒按抽取组；编队盒按编队） */
  groupId?: string
  /** 附加说明（如「返场 −1 军力」「被抽中西移 3 格」） */
  note?: string
}

/** 盒的类别 */
export type BoxKind =
  /** 13.5 死亡堆 */
  | 'deadPile'
  /** 1.8a + 20.0g 拆分单位盒（算子池） */
  | 'breakdownBox'
  /** 1.6c 特殊补员抽取盒 */
  | 'specialReplBox'
  /** 剧本抽取盒（编队抽签 / 子单位抽取） */
  | 'scenarioDrawBox'
  /** 13.7 + 3.6f 编队收纳盒（收纳下属以制造迷雾） */
  | 'formationBox'
  /** 1.4a 地图外空军盒 */
  | 'airBox'
  /** 1.4b 边缘盒 */
  | 'edgeBox'

/** 盒的名册（界面直接铺开；不做任何规则计算） */
export interface BoxView {
  id: string
  kind: BoxKind
  name: string
  /** 该盒的规则依据 */
  rule: string
  /** 归属方（通用盒为 null） */
  side: Side | null
  sections: readonly BoxSection[]
  holdings: readonly BoxHolding[]
  /** 容量上限（null = 无限，如 1.4a 的图外空军盒） */
  capacity: number | null
  artwork: BoxArtwork | null
  /** 面向玩家的要点（规则原文摘句，便于对着规则书核对） */
  notes: readonly string[]
  /** **数据缺口**：规则要求但数据未给出、须由调用方注入的项 */
  dataGaps: readonly string[]
}

/** 盒内一枚单位的最小视图（全部字段由调用方从单位库/运行实例给出） */
export interface BoxUnitView {
  id: string
  name?: string
  side: UnitSide
  kind?: UnitKind
  /** 兵种（units-*.json branch）：1.6c 的 Aufk/Krd 判定、20.0 的类型判定用 */
  branch?: string
  /** 番号（如 `10 Aufk`）：供界面显示与人工核对 */
  designation?: string
  /** 13.5b：当前军力 / 印值军力 */
  steps?: number
  printedSteps?: number
  /** 1.6c 免费重建资格（`isFreeSpecialReplEligible`）用的印值三项 */
  attack?: number
  ar?: number
  ma?: number
  /** 20.0g：国籍（拆分单位池归属） */
  nationality?: string
  /** 13.5c：AR 后有黄点 ⇒ 永久不可重建 */
  rebuildable?: boolean
  /** 13.5b：是否拆分单位（被毁返回资源池） */
  isBreakdown?: boolean
  /** 14.1a：空军激活状态（空军盒分栏用） */
  airStatus?: AirStatus | null
  /** 专规 1.6 Notes：机型代号（F 用 Ftr、T/S/Tpt 用 Tac） */
  aircraftType?: string | null
  /** 13.7：所属多单位编队 */
  formationId?: string | null
  /** 1.6c：该单位对应的重建表行键（数据缺口 ⇒ 由调用方注入） */
  rebuildType?: string
}

/** 盒内单位的落点（状态层据此落盘） */
export interface BoxPatch {
  unitId: string
  /** 落到哪个盒；null = 回到图上 */
  to: BoxKind | null
  /** 回到图上时的落点格（对象坐标；缺省表示由调用方决定） */
  hex?: { col: number; row: number }
  /** 军力变化（如 1.6c 免费重建返场 −1 军力） */
  steps?: number
  /** 模式变化（如 S3 的 Move Mode 抽签） */
  mode?: 'combat' | 'move'
  note: string
}

/** 读盒图（数据侧 `markers.json` 的 `containers.artwork[boxId]`；缺省 null） */
export function boxArtwork(boxId: string): BoxArtwork | null {
  const table = markers.containers.artwork
  if (table === undefined) return null
  const entry = table[boxId]
  if (entry === undefined) return null
  return {
    imageKey: entry.imageKey,
    ...(entry.widthPx === undefined ? {} : { widthPx: entry.widthPx }),
    ...(entry.heightPx === undefined ? {} : { heightPx: entry.heightPx }),
    ...(entry.columns === undefined ? {} : { columns: entry.columns }),
    ...(entry.note === undefined ? {} : { note: entry.note }),
  }
}

/** 单栏盒的栏 id */
export const MAIN_SECTION = 'main'

/* ────────────────────────────── 辅助卡分区 ↔ 盒（B12） ────────────────────────────── */

/**
 * 辅助卡**分区**（`aux_cards.json` 的 `box_kind`）↔ 盒名册**盒/栏**的对应
 *
 * 两个词表各有出处、都必须留着：
 *   · `BoxRegionKind`（数据侧，`src/data/schema/aux-cards.schema.ts`）＝**卡面上画出来的分区**，
 *     由用户在标定工具里框定（6 卡 / 15 分区），带卡面像素矩形；
 *   · `BoxKind` + `sectionId`（本模块）＝**引擎名册**里的盒与栏（空军盒按 14.1a 分 Active/Inactive）。
 * 界面要"把盒内算子摆进真实分区"，就得知道哪个分区装哪个盒/哪一栏 ⇒ 这张表是唯一的对应处。
 *
 * `sectionId: null` ＝ 该分区不对应任何盒的栏（例如"标记存放"装的是 3.6 的**标记**、
 * 不是名册里的单位；界面照别处画或先空着，不臆造）。
 */
export const REGION_OF_BOX: Readonly<
  Record<string, { boxKind: BoxKind; sectionId: string | null; rule: string }>
> = {
  dead_pile: { boxKind: 'deadPile', sectionId: MAIN_SECTION, rule: '13.5' },
  breakdown_pool: { boxKind: 'breakdownBox', sectionId: MAIN_SECTION, rule: '1.8a / 20.0g' },
  formation_draw: { boxKind: 'scenarioDrawBox', sectionId: MAIN_SECTION, rule: '13.7' },
  special_repl_division_pool: {
    boxKind: 'specialReplBox',
    sectionId: MAIN_SECTION,
    rule: '1.6c',
  },
  // 专规 2.3a 的警戒单位：数据侧同样落在特补盒的抽取池里（上限 3/5/7 见单位库 `alarmLimit`）
  alarm_pool: { boxKind: 'specialReplBox', sectionId: MAIN_SECTION, rule: '专规 2.3a' },
  air_box_active: { boxKind: 'airBox', sectionId: 'active', rule: '14.1a' },
  air_box_inactive: { boxKind: 'airBox', sectionId: 'inactive', rule: '14.1a' },
  edge_box_northeast: { boxKind: 'edgeBox', sectionId: 'northeast', rule: '1.4b / 6.1b' },
  edge_box_southeast: { boxKind: 'edgeBox', sectionId: 'southeast', rule: '1.4b / 6.1b' },
  markers: { boxKind: 'deadPile', sectionId: null, rule: '3.6' },
}

/** 取某分区装的是哪个盒的哪一栏（查不到返回 null，调用方据此如实留空） */
export function boxOfRegion(
  regionKind: string,
): { boxKind: BoxKind; sectionId: string | null; rule: string } | null {
  return REGION_OF_BOX[regionKind] ?? null
}

/** 单位 → 盒内一枚 */
function toHolding(
  unit: BoxUnitView,
  sectionId: string,
  extra?: { groupId?: string; note?: string },
): BoxHolding {
  return {
    unitId: unit.id,
    ...(unit.name === undefined ? {} : { name: unit.name }),
    side: unit.side,
    sectionId,
    ...(extra?.groupId === undefined ? {} : { groupId: extra.groupId }),
    ...(extra?.note === undefined ? {} : { note: extra.note }),
  }
}

/* ────────────────────────────── 记录轨：回合轨 / 天气 / 铁路容量 ────────────────────────────── */

/** 轨上的一枚标记 */
export interface TrackMarker {
  markerId: string
  markerName: string
  /** 图档（缺省 null ⇒ 界面用文字） */
  imageKey: string | null
  /** 轨位（回合轨 = 回合号；铁路容量轨 = 容量点数） */
  position: number
  side: Side | null
  /** 面向玩家的说明 */
  detail: string
}

/** 按标记库取标记（ruleClass 单一来源 `markers.json`） */
function markerByRule(
  ruleClass: string,
  side?: Side,
): { id: string; name: string; front: string | null } | null {
  const found = markers.markers.find(
    (marker) => marker.ruleClass === ruleClass && (side === undefined || marker.side === side),
  )
  if (found === undefined) return null
  return { id: found.id, name: found.name, front: found.front ?? null }
}

/** 记录轨视图所需的盘面事实（结构式注入，避免依赖完整 Records） */
export interface TurnRecordFacts {
  /** 当前回合号（1 起；回合轨共 19 格） */
  turn: number
  weather: { air: FlightWeather; ground: GroundWeather }
  /** 双方当前铁路容量（13.3b） */
  railCapacity: Record<Side, number>
}

/** 回合轨视图（OCS 2.2 Turn End：推进 Turn Record 标记） */
export interface TurnTrackView {
  rule: string
  /** 轨格（markers.json 的 19 个半周） */
  slots: readonly { turn: number; date: string }[]
  currentTurn: number
  markers: readonly TrackMarker[]
}

/** 3.6d：回合与阶段标记（OCS 2.2 Turn End 推进） */
export const TURN_TRACK_RULE = '2.2'

/** 回合轨视图：19 格 + 当前格上的回合标记 */
export function turnTrackView(facts: TurnRecordFacts): TurnTrackView {
  const marker = markerByRule('3.6d')
  const slot = markers.turnTrack.find((item) => item.turn === facts.turn)
  return {
    rule: TURN_TRACK_RULE,
    slots: markers.turnTrack.map((item) => ({ turn: item.turn, date: item.date })),
    currentTurn: facts.turn,
    markers:
      marker === null
        ? []
        : [
            {
              markerId: marker.id,
              markerName: marker.name,
              imageKey: marker.front,
              position: facts.turn,
              side: null,
              detail:
                `回合标记：T${facts.turn}` +
                (slot === undefined ? '（不在轨上：回合号超出 1–19）' : `｜${slot.date}`),
            },
          ],
  }
}

/**
 * 2.2 Turn End：推进回合标记
 *
 * 「推进 Turn Record 标记，回到开头」——回合末把标记移到下一格。
 * 这里是**纯计划**：只校验目标回合在轨上（1–19），状态由调用方落盘。
 */
export function planTurnMarkerAdvance(
  facts: TurnRecordFacts,
  toTurn: number,
): RuleOutcome<{ fromTurn: number; toTurn: number; date: string; detail: string }> {
  const slot = markers.turnTrack.find((item) => item.turn === toTurn)
  if (slot === undefined)
    return fail(TURN_TRACK_RULE, `turnTrackOutOfRange:${toTurn}(1-${markers.turnTrack.length})`)
  if (toTurn <= facts.turn)
    return fail(TURN_TRACK_RULE, `turnMarkerMustMoveForward:${facts.turn}->${toTurn}`)
  return succeed(TURN_TRACK_RULE, {
    fromTurn: facts.turn,
    toTurn,
    date: slot.date,
    detail: `回合标记 T${facts.turn} → T${toTurn}（${slot.date}）：推进 Turn Record 标记（2.2 Turn End）`,
  })
}

/** 天气轨视图（专规 1.5 / OCS 3.6c 的 Weather markers） */
export interface WeatherTrackView {
  rule: string
  air: FlightWeather
  ground: GroundWeather
  markers: readonly TrackMarker[]
  /** 受限飞行的后果摘要（专规 1.5） */
  note: string
}

/** 1.5 / 3.6c：天气标记与天气表 */
export const WEATHER_TRACK_RULE = '1.5'

/**
 * 3.6c 的天气标记（数据 `markers.json` 里 `Ground` / `Flight` 两枚；本作无算子）
 *
 * 本作天气由**天气表**给出（专规 1.5），标记库里的两枚只作展示，故这里按名称取。
 */
function weatherMarkers(): readonly { id: string; name: string; front: string | null }[] {
  return markers.markers
    .filter((marker) => marker.ruleClass === '3.6c')
    .map((marker) => ({ id: marker.id, name: marker.name, front: marker.front ?? null }))
}

/** 天气轨视图：当前空中/地面条件 + 天气标记 */
export function weatherTrackView(facts: TurnRecordFacts): WeatherTrackView {
  const trackMarkers: TrackMarker[] = weatherMarkers().map((marker) => ({
    markerId: marker.id,
    markerName: marker.name,
    imageKey: marker.front,
    position: facts.turn,
    side: null,
    detail:
      marker.name === 'Ground'
        ? `地面条件：${facts.weather.ground === 'good' ? '良好（本作恒为 good，1.5）' : facts.weather.ground}`
        : `空中条件：${facts.weather.air === 'normal' ? '正常飞行' : '受限飞行（反应/进击段禁飞、禁低空扫射，1.5）'}`,
  }))
  return {
    rule: WEATHER_TRACK_RULE,
    air: facts.weather.air,
    ground: facts.weather.ground,
    markers: trackMarkers,
    note:
      facts.weather.air === 'normal'
        ? '空中条件 normal：无额外限制（1.5）'
        : '空中条件 limited：反应与进击阶段禁止空军任务，且禁止低空扫射（1.5）',
  }
}

/** 铁路容量轨视图（13.3b / 专规 1.2 表 1-1） */
export interface RailCapTrackView {
  rule: string
  /** 主轨刻度（1–maxMain）与副轨（0–maxSub T） */
  maxMain: number
  maxSub: number
  boostDate: string
  boosted: boolean
  sides: readonly {
    side: Side
    /** 当前值（盘面事实） */
    current: number
    /** 升级日之后的容量（专规 1.2） */
    boostTo: number
    /** 数据给的当日容量（`railCapacitiesOn`，用于核对） */
    onDate: number
    marker: TrackMarker | null
  }[]
}

/** 13.3b / 专规 1.2：铁路容量记录轨 */
export const RAIL_CAP_TRACK_RULE = '13.3b'

/**
 * 铁路容量轨视图
 *
 * 刻度取自 `markers.json.railCap`（主轨 1–10 + 副轨 0–3T），
 * 升级日与升级后容量取自 `rules-constants.json`（专规 1.2），
 * 当前值取盘面事实（`facts.railCapacity`），并给出「按日期应有的值」供核对。
 */
export function railCapTrackView(facts: TurnRecordFacts, date: string): RailCapTrackView {
  const track = markers.railCap
  const onDate = railCapacitiesOn(date)
  const sides: RailCapTrackView['sides'] = (['axis', 'soviet'] as const).map((side) => {
    const marker = markerByRule('13.3b', side)
    return {
      side,
      current: facts.railCapacity[side],
      boostTo: track.boostTo[side],
      onDate: onDate[side],
      marker:
        marker === null
          ? null
          : {
              markerId: marker.id,
              markerName: marker.name,
              imageKey: marker.front,
              position: facts.railCapacity[side],
              side,
              detail:
                `${side === 'axis' ? '轴心国' : '苏联'}铁路容量标记：当前 ${facts.railCapacity[side]}` +
                `｜按日期（${date}）应为 ${onDate[side]}`,
            },
    }
  })
  return {
    rule: RAIL_CAP_TRACK_RULE,
    maxMain: track.maxMain,
    maxSub: track.maxSub,
    boostDate: track.boostDate,
    boosted: isRailCapBoosted(date),
    sides,
  }
}

/**
 * 13.3b：铁路容量标记的轨位
 *
 * 容量值即轨位（`MarkerTrackRef.position`）；本函数只做「值 → 轨位」的合法性判定：
 * 主轨 1–maxMain，副轨 0–maxSub（T）。
 */
export function railCapPositionValid(value: number): boolean {
  const track = markers.railCap
  return Number.isInteger(value) && value >= 0 && value <= track.maxMain + track.maxSub
}

/* ────────────────────────────── 死亡堆（13.5） ────────────────────────────── */

/** 13.5 / 13.5a / 13.5b / 13.5c：死亡堆与重建 */
export const DEAD_PILE_RULE = '13.5'

/** 死亡堆视图（每方一个；内容由调用方给出） */
export function deadPileView(input: {
  side: Side
  units: readonly BoxUnitView[]
  /** 盒 id（美工查表用；缺省 `dead-pile-<side>`） */
  boxId?: string
}): BoxView {
  const boxId = input.boxId ?? `dead-pile-${input.side}`
  const holdings = input.units.map((unit) =>
    toHolding(unit, MAIN_SECTION, {
      note:
        unit.rebuildable === false
          ? 'AR 后有黄点 ⇒ 永久不可重建（13.5c）'
          : unit.isBreakdown === true
            ? '拆分单位被毁 ⇒ 返回资源池，不重建（13.5b）'
            : undefined,
    }),
  )
  return {
    id: boxId,
    kind: 'deadPile',
    name: `${input.side === 'axis' ? '轴心国' : '苏联'}死亡堆`,
    rule: DEAD_PILE_RULE,
    side: input.side,
    sections: [{ id: MAIN_SECTION, label: '阵亡/待重建', rule: DEAD_PILE_RULE }],
    holdings,
    capacity: null,
    artwork: boxArtwork(boxId),
    notes: [
      '13.5a：从死亡堆重建须由补员在**友方战斗模式 HQ 2 格内**的同格进行，且该格不在敌方 ZOC 内',
      '13.5c：AR 后有黄点的单位（`rebuildable = false`）被毁即永久移除，不可重建',
      '13.5b：拆分单位被摧毁后返回资源池，不重建',
      '1.6c：19 August 前每回合可经「特殊补员」免费重建死亡堆内的师（返场 −1 军力），不花 Pax/Eq',
    ],
    dataGaps: [],
  }
}

/**
 * 1.6c：可从死亡堆**免费重建**的师池
 *
 * 表 1-3：「12-2-2 / 11-1-1 / 10-0-1 步兵（或民兵）师随机重建，返场 −1 step」；
 * 资格判定走数据层 `charts-supply-repl.json` 的 `freeSpecialReplFactors`
 * （`isFreeSpecialReplEligible`），**13-3-3 之类永不由此重建** —— 由数据直接排除，
 * 不在本模块另写黑名单。
 */
export function freeSpecialReplPool(units: readonly BoxUnitView[]): readonly BoxUnitView[] {
  return units.filter((unit) => {
    if (unit.isBreakdown === true) return false
    if (unit.kind === 'air') return false
    if (unit.attack === undefined || unit.ar === undefined || unit.ma === undefined) return false
    return isFreeSpecialReplEligible(unit.attack, unit.ar, unit.ma)
  })
}

/* ────────────────────────────── 1.6c 特殊补员抽取盒 ────────────────────────────── */

/** 1.6c：特殊补员（免费重建） */
export const SPECIAL_REPL_RULE = '1.6c'

/** 特殊补员抽取盒视图 */
export interface SpecialReplBoxView extends BoxView {
  /** 当日是否仍可掷特殊补员（19 August 起停止） */
  active: boolean
  endDate: string
  /** 苏方每次两项、轴方每次一项（表 1-3） */
  drawsPerTurn: number
  /** 各方的抽取项说明（表 1-3 原文） */
  items: readonly string[]
  /** 当前死亡堆内的免费重建师池 */
  divisionCandidates: readonly string[]
  /** 重建表里标 `special` 的行键（1.6c 的两类单位） */
  specialRows: readonly string[]
}

/**
 * 特殊补员抽取盒视图（表 1-3）
 *
 * 苏方每次两项：① 免费重建师（死亡堆内 12-2-2/11-1-1/10-0-1）；② Supply Cache 或任一 Alarm 单位。
 * 轴方每次一项：Supply Cache 或任一 Aufk/Krd 营。
 * 「19 August 起停止」的日期取自 `rules-constants.json.smolensk.specialReplEndDate`。
 */
export function specialReplBoxView(input: {
  side: Side
  date: string
  deadPile: readonly BoxUnitView[]
}): SpecialReplBoxView {
  const boxId = `special-repl-${input.side}`
  const endDate = rulesConstants.smolensk.specialReplEndDate
  // 1.6c 的日期闸门只有一处实现（`timing.isSpecialReplAvailable`）——此处不再自算 `date < endDate`
  const active = isSpecialReplAvailable(input.date)
  const divisionCandidates = freeSpecialReplPool(input.deadPile).map((unit) => unit.id)
  const specialRows = specialReplRebuildRows(input.side)
  const soviet = input.side === 'soviet'

  const items = soviet
    ? [
        '① 12-2-2 / 11-1-1 / 10-0-1 步兵（或民兵）师随机重建，返场 −1 军力（1.6c 表 1-3）',
        '② Supply Cache，或死亡堆中任一 Alarm 单位（2.3a 混编上限：3× 2-1-3 坦克营 / 5× 3-1-1 民兵团 / 7× (2)-2-2 反坦克团，按算子类型计）',
      ]
    : ['① Supply Cache，或死亡堆中任一 Aufk（装甲侦察）营 / Krd（摩托化侦察）营（1.6c 表 1-3）']

  return {
    id: boxId,
    kind: 'specialReplBox',
    name: `${soviet ? '苏联' : '轴心国'}特殊补员抽取盒`,
    rule: SPECIAL_REPL_RULE,
    side: input.side,
    sections: [
      { id: MAIN_SECTION, label: '死亡堆内可抽取', rule: SPECIAL_REPL_RULE },
      { id: 'second', label: '第二项（Supply Cache / 特种营）', rule: SPECIAL_REPL_RULE },
    ],
    holdings: divisionCandidates.flatMap((id) =>
      input.deadPile
        .filter((unit) => unit.id === id)
        .map((unit) => toHolding(unit, MAIN_SECTION, { note: '可免费重建（返场 −1 军力，1.6c）' })),
    ),
    capacity: null,
    artwork: boxArtwork(boxId),
    notes: [
      `特殊补员**不可保存**：掷骰即用，用不掉即作废（1.6 表 1-6）`,
      active
        ? `当前仍在 19 August 之前：可掷特殊补员（1.6c）`
        : `${endDate} 起特殊补员停止（1.6c）`,
      `重建表内标 special 的行（数据 charts-supply-repl.json）：${specialRows.join('、') || '（无）'}`,
      `2.3a 的 Alarm 单位已在单位库标注（\`alarmLimit\`：3 / 5 / 7），上限按**算子类型**计`,
    ],
    /*
     * 2.3a 的数据缺口已补齐（2026-09-16）：单位库三条警戒算子带 `alarmLimit`，
     * 引擎/面板不再需要「未标注 ⇒ 由调用方注入」的提示。此处保留空数组以维持视图结构。
     */
    dataGaps: [],
    active,
    endDate,
    drawsPerTurn: soviet ? 2 : 1,
    items,
    divisionCandidates,
    specialRows,
  }
}

/** 1.6c 抽取的输入（骰点与抽签结果由调用方给出；引擎不掷骰） */
export interface SpecialReplDrawInput {
  side: Side
  /** 当日日期（ISO；≥ `specialReplEndDate` 即停止） */
  date: string
  /** 1 骰骰面（1–6；由调用方用 rng 掷出） */
  die: number
  /** 死亡堆内单位（含印值三项与战斗类型） */
  deadPile: readonly BoxUnitView[]
  /**
   * 2.3a Alarm 单位的 id 清单
   *
   * 单位库三条警戒算子已带 `alarmLimit`（2026-09-16 起）⇒ 调用方通常直接用
   * 「`alarmLimit !== undefined` 的记录 id」填充本字段；传入空数组仍表示「本局无可用 Alarm 单位」，
   * 按表 1-3 的脚注，该项目**作废**（ch01 完整示例原文）。
   */
  alarmUnitIds?: readonly string[]
  /** 2.3a 的每型混编上限（`{ [unitId]: limit }`；来自数据字段 `alarmLimit`，缺省视为不受限） */
  alarmQuotas?: readonly AlarmQuota[]
  /** 各型 Alarm 单位**目前在场**的枚数（地图 + 死亡堆 + 待入场；缺省 0） */
  alarmInPlay?: Readonly<Record<string, number>>
  /** 抽定的免费重建师（由调用方从 `divisionCandidates` 中用 rng 抽定；缺省 = 无候选） */
  chosenDivisionId?: string | null
  /** 第二项的选择：`cache` 取补给缓存、`alarm` 取 Alarm 单位；缺省按掷骰结果自动取 */
  secondChoice?: 'cache' | 'alarm'
}

/** 1.6c 抽取结论 */
export interface SpecialReplDrawPlan {
  rule: string
  /** 掷表结果（`charts-supply-repl.json` 的 specialRepl 段） */
  table: SpecialReplResult
  /** 固定项：免费重建师（无候选 ⇒ null） */
  division: { unitId: string; stepsAfter: number; detail: string } | null
  /** 第二项 */
  second:
    | { kind: 'supplyCache'; detail: string }
    | { kind: 'alarm'; unitId: string; inDeadPile: boolean; detail: string }
    | { kind: 'void'; reason: string; detail: string }
  /** 候选池（供界面显示与复算核对） */
  pools: {
    divisionCandidates: readonly string[]
    alarmCandidates: readonly string[]
    /** 2.3a 的混编核算（每型的上限/在场/余量；未提供上限时为空数组） */
    alarmMix: readonly AlarmMixRow[]
  }
  patches: readonly BoxPatch[]
  dataGaps: readonly string[]
  detail: string
}

/**
 * 1.6c：结算一次特殊补员抽取
 *
 * 判定顺序照表 1-3 与 ch01 的完整示例：
 *   ① 日期（19 August 起停止）→ ② 掷表（1 骰）→ ③ 固定项「师随机重建」：只在**死亡堆**内、
 *      且通过 `isFreeSpecialReplEligible` 的池中抽取，返场 **−1 军力**；
 *   ④ 第二项：苏方看掷骰结果（1-2 = 补给缓存；3-6 = Alarm 单位），轴方同样按表；
 *      若该项所指单位**死亡堆内没有**，则**该项作废**（规则原文）。
 */
export function planSpecialReplDraw(input: SpecialReplDrawInput): RuleOutcome<SpecialReplDrawPlan> {
  const endDate = rulesConstants.smolensk.specialReplEndDate
  if (input.date >= endDate) return fail(SPECIAL_REPL_RULE, `specialReplStoppedFrom:${endDate}`)
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 6)
    return fail(SPECIAL_REPL_RULE, `specialReplDieOutOfRange:${input.die}`)

  const table = specialReplRoll(input.side, input.die)
  const divisionCandidates = freeSpecialReplPool(input.deadPile).map((unit) => unit.id)
  const alarmUnitIds = input.alarmUnitIds ?? []
  /*
   * 2.3a 的混编上限（3 / 5 / 7，按**算子类型**计）：只在还有余量时该型才能从死亡堆返场。
   * 未提供 `alarmQuotas`（或某型未列）⇒ 该型不受限（旧调用方与单测仍按老语义工作）。
   */
  const alarmMix = alarmMixRows({
    quotas: input.alarmQuotas ?? [],
    inPlay: input.alarmInPlay ?? {},
  })
  // 2.3a 的 Alarm 单位同样只能在**死亡堆**里找（ch01 完整示例：dead pile 没有可用 Alarm ⇒ 作废）
  const inDeadPile = input.deadPile.filter((unit) => alarmUnitIds.includes(unit.id))
  const alarmPool = inDeadPile.filter((unit) => alarmHasRoom(alarmMix, unit.id))
  const atMixLimit = inDeadPile.length > 0 && alarmPool.length === 0
  const dataGaps =
    alarmUnitIds.length > 0 && (input.alarmQuotas ?? []).length === 0
      ? ['未提供 2.3a 的混编上限（alarmQuotas）⇒ 本次不校验上限；上限来自单位库的 alarmLimit 字段']
      : []

  const patches: BoxPatch[] = []
  let division: SpecialReplDrawPlan['division'] = null
  /*
   * ★ 固定项「一个步兵（或民兵）师」是**苏方专属**（1.6c：「**The Soviets always get one
   *   infantry (or militia) division**…」）；轴方的两项是「补给缓存 / Aufk·Krd 营」，
   *   **不重建师**。故这里必须按方判定——否则若轴方死亡堆里恰好躺着同印值的师，
   *   会被误当成"特殊补员师"返场（规则没给轴方这种做法）。
   */
  if (input.side === 'soviet' && divisionCandidates.length > 0) {
    const chosen = input.chosenDivisionId ?? divisionCandidates[0] ?? null
    if (chosen === null || !divisionCandidates.includes(chosen))
      return fail(SPECIAL_REPL_RULE, `specialReplDivisionNotInPool:${String(chosen)}`)
    const unit = input.deadPile.find((item) => item.id === chosen)
    const stepsAfter = Math.max(1, (unit?.printedSteps ?? unit?.steps ?? 1) - 1)
    division = {
      unitId: chosen,
      stepsAfter,
      detail: `${chosen} 免费重建返场（−1 军力 ⇒ ${stepsAfter}）：从死亡堆取出（1.6c）`,
    }
    patches.push({
      unitId: chosen,
      to: null,
      steps: stepsAfter,
      note: '1.6c 免费重建：从死亡堆返场，−1 军力',
    })
  }

  // 第二项：按表 1-3 的掷骰结果
  let second: SpecialReplDrawPlan['second']
  const wantsCache =
    input.secondChoice === 'cache' ||
    (input.secondChoice === undefined &&
      (table.kind === 'division_caches' || table.kind === 'supply_cache'))
  if (wantsCache) {
    second = {
      kind: 'supplyCache',
      detail: `Supply Cache +1（1.6c / 专规 1.7：本作标准规则，双方每剧本开局各 2 枚）`,
    }
  } else if (alarmPool.length === 0) {
    second = {
      kind: 'void',
      reason:
        alarmUnitIds.length === 0
          ? 'noAlarmUnitsInData'
          : atMixLimit
            ? 'alarmMixLimitReached'
            : 'noAlarmUnitInDeadPile',
      detail: atMixLimit
        ? `Alarm 单位项作废：死亡堆里的 Alarm 单位各型都已到 2.3a 的混编上限（${alarmMix
            .map((row) => `${row.unitId} ${row.inPlay}/${row.limit}`)
            .join('、')}）`
        : 'Alarm 单位项作废：死亡堆中无可用 Alarm 单位（1.6c 表 1-6：dead pile 无单位即无重建；ch01 完整示例）',
    }
  } else {
    const chosenAlarm = alarmPool[0]!
    second = {
      kind: 'alarm',
      unitId: chosenAlarm.id,
      inDeadPile: true,
      detail:
        `${chosenAlarm.id} 作 Alarm 单位返场（2.3a；本次不可保存，1.6 表 1-6）` +
        `；该单位对应重建表行：${alarmSpecialRows(input.side).join('、') || '（未登记）'}`,
    }
    patches.push({ unitId: chosenAlarm.id, to: null, note: '1.6c：Alarm 单位从死亡堆返场' })
  }

  const detail = [
    `1.6c 特殊补员（${input.side === 'axis' ? '轴心国' : '苏联'}，${input.date}，1 骰 ${input.die} ⇒ ${table.label}）`,
    division === null ? '固定项「师随机重建」：死亡堆内无合格师 ⇒ 无重建' : division.detail,
    second.detail,
  ].join('；')

  return succeed(SPECIAL_REPL_RULE, {
    rule: SPECIAL_REPL_RULE,
    table,
    division,
    second,
    pools: { divisionCandidates, alarmCandidates: alarmPool.map((unit) => unit.id), alarmMix },
    patches,
    dataGaps,
    detail,
  })
}

/** 1.6c：该方重建表内标 special 的行键（Aufk/Krd 营 或 Alarm 类） */
function alarmSpecialRows(side: Side): readonly string[] {
  return specialReplRebuildRows(side)
}

/* ───────────────────────── 专规 2.3a：警戒单位的混编上限 ───────────────────────── */

/** 2.3a 的规则号（复核与留痕用） */
export const ALARM_MIX_RULE = '专规 2.3a'

/** 一个警戒（Alarm）算子类型的在场配额（按类型计，同型可同时在场多枚） */
export interface AlarmQuota {
  unitId: string
  /** 2.3a 的混编上限（3 / 5 / 7） */
  limit: number
}

/** 2.3a 混编核算的一行结论 */
export interface AlarmMixRow {
  unitId: string
  limit: number
  /** 目前在场的枚数（地图 + 死亡堆 + 待入场，由调用方按盘面事实给） */
  inPlay: number
  /** 余量（可再返场几枚；0 = 已满编） */
  remaining: number
  /** 是否超出 2.3a 的混编上限 */
  over: boolean
}

/**
 * 专规 2.3a：**警戒单位的混编上限核算**（纯函数）
 *
 * 规则原文：「The mix of Alarm units is strictly limited: three 2-1-3 tank battalions,
 * five 3-1-1 militia regiments, and seven (2)-2-2 anti-tank regiments.」⇒ 上限按**算子类型**计，
 * 同型可以同时在场多枚（这点与「该算子只有一枚」的普通单位不同）。
 *
 * 本函数只做核算（不掷骰、不改状态）：调用方给「每个类型的在场枚数」与「数据里的上限」，
 * 得到每型的余量与是否超编 —— 供入场校验、面板显示与测试断言使用。
 */
export function alarmMixRows(input: {
  quotas: readonly AlarmQuota[]
  /** 各型在场枚数（缺省 0） */
  inPlay: Readonly<Record<string, number>>
}): AlarmMixRow[] {
  return input.quotas.map((quota) => {
    const inPlay = Math.max(0, Math.trunc(input.inPlay[quota.unitId] ?? 0))
    const remaining = Math.max(0, quota.limit - inPlay)
    return {
      unitId: quota.unitId,
      limit: quota.limit,
      inPlay,
      remaining,
      over: inPlay > quota.limit,
    }
  })
}

/** 2.3a：是否仍可返场该型警戒算子（余量 > 0；未知类型视为不受限） */
export function alarmHasRoom(rows: readonly AlarmMixRow[], unitId: string): boolean {
  const row = rows.find((item) => item.unitId === unitId)
  return row === undefined ? true : row.remaining > 0
}

/* ────────────────────────────── 拆分单位盒（1.8a / 20.0g） ────────────────────────────── */

/** 1.8a（上限）+ 20.0g（算子池）：拆分单位盒 */
export const BREAKDOWN_BOX_RULE = '1.8a'

/** 拆分单位盒的一档（按 AR 分档，照 1.8a 表 1-4） */
export interface BreakdownPoolSlot {
  ar: number
  /** 1.8a：该档算子总数上限 */
  limit: number
  /** 图上的该档拆分单位数（盘面事实） */
  onMap: number
  /** 盒内可用数（优先取调用方给的账本；无账本时 = limit − onMap） */
  inBox: number
  /** 数据是否越界（onMap > limit） */
  overLimit: boolean
}

/** 拆分单位盒视图 */
export interface BreakdownBoxView extends BoxView {
  slots: readonly BreakdownPoolSlot[]
  /** 盒内可用的拆分单位（`units-*.json` 里 branch/specialized 含 breakdonw 的单位，按 AR 归入档位） */
  available: readonly BoxUnitView[]
}

/**
 * 拆分单位盒视图（1.8a 上限 + 20.0g 算子池 + 13.5b 回池）
 *
 * 「1.8a 拆解单位受固定数量上限约束」（表 1-4：轴 28× AR4 + 2× AR5；苏 6× AR2 + 2× AR3）；
 * 「20.0g 同一国籍的所有多军力单位使用相同的拆分单位算子池」⇒ 盒＝池，取用＝
 * `planBreakdownCreate`（20.0 / 20.0a–g），被毁＝返回池（13.5b）。
 */
export function breakdownBoxView(input: {
  side: Side
  /** 该方算子库里属于拆分单位的枚（`branch: 'breakdown'` 或 `specialized: ['breakdown']`） */
  breakdownUnits: readonly BoxUnitView[]
  /** 图上该方的拆分单位（按 AR 分档计数用） */
  onMap: readonly BoxUnitView[]
  /**
   * 盒内存量账本（按 AR 分档；**状态层给的实测存量**）
   *
   * 给了就以它为准（状态层的账本可能已因取用/回池变动）；没给才退回「1.8a 上限 − 图上枚数」。
   */
  remaining?: readonly { ar: number; count: number }[]
}): BreakdownBoxView {
  const boxId = `breakdown-${input.side}`
  const slots: BreakdownPoolSlot[] = breakdownPoolLimits(input.side).map((entry) => {
    const onMap = input.onMap.filter((unit) => unit.ar === entry.ar).length
    const ledger = input.remaining?.find((item) => item.ar === entry.ar)?.count
    const inBox = Math.max(0, ledger ?? entry.count - onMap)
    return { ar: entry.ar, limit: entry.count, onMap, inBox, overLimit: onMap > entry.count }
  })
  // 盒内可用＝按 AR 档各取前 `inBox` 枚（1.8a 的档位上限；同一档的算子同质，取哪一枚不影响判定）
  const available: BoxUnitView[] = []
  for (const slot of slots) {
    const ofSlot = input.breakdownUnits.filter((unit) => unit.ar === slot.ar)
    available.push(...ofSlot.slice(0, slot.inBox))
  }

  return {
    id: boxId,
    kind: 'breakdownBox',
    name: `${input.side === 'axis' ? '轴心国' : '苏联'}拆分单位盒`,
    rule: BREAKDOWN_BOX_RULE,
    side: input.side,
    sections: [{ id: MAIN_SECTION, label: '盒内可用拆分单位', rule: BREAKDOWN_BOX_RULE }],
    holdings: available.map((unit) =>
      toHolding(unit, MAIN_SECTION, {
        note: unit.ar === undefined ? undefined : `AR ${unit.ar}`,
      }),
    ),
    capacity: breakdownPoolTotal(input.side),
    artwork: boxArtwork(boxId),
    notes: [
      '1.8a 表 1-4：轴心国 28× AR4 + 2× AR5 团；苏军 6× AR2 + 2× AR3 团（固定数量上限）',
      '20.0g：同一国籍共用一个拆分单位算子池（轴心国盟国各有独立池，不可与德方互换）',
      '20.0：由多军力单位拆分其中 1 点军力创建（最后一点军力永远不能创建），不消耗 MP（20.0e）',
      '13.5b：拆分单位被摧毁后**返回资源池**，不重建',
    ],
    // 盒内存量是**计数**（1.8a 的固定上限），而算子库只登记有限的拆分单位**型别**（同型别多枚，
    // 不再逐枚建记录）⇒ 两者数量不同是正常的，但必须说清楚，免得把「列出的枚数」当成「盒内存量」。
    dataGaps:
      available.length === slots.reduce((sum, slot) => sum + slot.inBox, 0)
        ? []
        : [
            `盒内存量按 1.8a 计数（共 ${slots.reduce((sum, slot) => sum + slot.inBox, 0)} 枚），` +
              `而单位库只登记 ${available.length} 个拆分单位型别（同型别多枚不再逐枚建记录）⇒ 名册列出的是型别，存量以上表为准`,
          ],
    slots,
    available,
  }
}

/**
 * 20.0 / 20.0a–g：从拆分单位盒**取用**一枚（创建拆分单位）
 *
 * 本函数是 `planBreakdownCreate` 的「盒内取用」包装：先按 1.8a 的档位上限核对盒内存量，
 * 再交给既有的 20.0 判定（类型 / 时机 / 军力 / AR 方向 / 标记模式 / 池），**不另写规则**。
 */
export function planBreakdownTake(input: {
  side: Side
  /** 母单位（含 AR / 军力 / 战斗类型 / 标记模式） */
  parent: BreakdownCreateRequest['parent']
  /** 取用的拆分单位 */
  breakdown: BreakdownCreateRequest['breakdown']
  /** 20.0a：创建时机 */
  timing: BreakdownCreateRequest['timing']
  /** 专规 2.4：母单位是否被 Slow Mobilization 锁定 */
  locked?: boolean
  /** 盒内存量（`breakdownBoxView().slots`；按 AR 档取） */
  slots: readonly BreakdownPoolSlot[]
}): RuleOutcome<{
  rule: string
  /** 取用后该档盒内存量 */
  inBoxAfter: number
  parentStepsAfter: number
  detail: string
}> {
  const ar = input.breakdown.ar
  const slot = input.slots.find((item) => item.ar === ar)
  if (slot === undefined) return fail(BREAKDOWN_BOX_RULE, `breakdownSlotNotInCounterLimits:ar${ar}`)
  const inBox = slot.inBox
  const created = planBreakdownCreate({
    parent: input.parent,
    breakdown: input.breakdown,
    timing: input.timing,
    poolCount: inBox,
    ...(input.locked === undefined ? {} : { locked: input.locked }),
  })
  if (!created.ok) return created
  return succeed(created.rule, {
    rule: created.rule,
    inBoxAfter: inBox - created.data.count,
    parentStepsAfter: created.data.parentStepsAfter,
    detail: `${created.data.detail}；盒内存量 AR${ar}：${inBox} → ${inBox - created.data.count}（1.8a）`,
  })
}

/* ────────────────────────────── 剧本抽取盒（编队抽签） ────────────────────────────── */

/** 剧本抽取盒的规则出处（ch10 Formation Chit Draw / ch11 各剧本表） */
export const SCENARIO_DRAW_RULE = '剧本页·编队抽签'

/** 抽取组（一个剧本一般两组：A 组与 B 组） */
export interface ScenarioDrawGroup {
  kind: 'shiftWest' | 'moveMode' | 'mtrAufkSwap' | 'deadPileKrd' | 'deadPileAufk'
  count: number
  /** shiftWest 的西移格数（ch10 例：3 格） */
  shiftHexes?: number
  label: string
  rule: string
  effect: string
}

/** 剧本抽取盒视图 */
export interface ScenarioDrawBoxView extends BoxView {
  scenarioId: string
  /** 入杯总数（规则书给出的池规模） */
  poolSize: number
  /** 池成员（`formations.json`：该剧本的轴方装甲/摩托化多单位编队） */
  pool: readonly { formationId: string; formationCode: string }[]
  groups: readonly ScenarioDrawGroup[]
  /** 规则原文（`scenarios.json` 的 formationDrawRaw） */
  raw: string
  /** 'No Counterattack' 选项下每组只抽几个（ch10） */
  reducedCount: number | null
}

/** 剧本的编排抽取参数（`scenarios.json.setup.formationDraw`；结构化自规则书） */
function formationDrawOf(scenarioId: string): {
  pool: number
  groups: readonly ScenarioDrawGroup[]
  reducedCount: number | null
  raw: string
  note: string
} | null {
  const own = scenarios.scenarios.find((scenario) => scenario.id === scenarioId)
  const shared = scenarios.scenarios.find(
    (scenario) =>
      scenario.setup.formationDraw !== undefined && scenario.sharedSetupWith?.includes(scenarioId),
  )
  const holder = own?.setup.formationDraw !== undefined ? own : shared
  const block = holder?.setup.formationDraw
  if (block === undefined) return null
  return {
    pool: block.pool,
    groups: block.groups.map((group) => ({
      kind: group.kind,
      count: group.count,
      ...(group.shiftHexes === undefined ? {} : { shiftHexes: group.shiftHexes }),
      label: group.label,
      rule: group.rule,
      effect: group.effect,
    })),
    reducedCount: block.reducedCount ?? null,
    raw: block.raw,
    note: block.note ?? '',
  }
}

/**
 * 剧本抽取盒视图（编队抽签）
 *
 * 池成员按数据推导：`formations.json` 中该剧本（`sources` 含 `S<id>·axis`）的**装甲/摩托化师**
 * （`formationId` 以 `Pz Div` / `Mtr Div` 结尾；骑兵师不入杯）。该口径与规则书给出的池规模
 * 一致（剧本 1 = 12、剧本 3/5 = 14），测试里作交叉核对。
 */
export function scenarioDrawBoxView(scenarioId: string): ScenarioDrawBoxView {
  const info = scenarios.scenarios.find((scenario) => scenario.id === scenarioId)
  const block = formationDrawOf(scenarioId)
  const pool = axisDrawPool(scenarioId)
  const boxId = `scenario-draw-${scenarioId}`
  const dataGaps: string[] = []
  if (block === null) {
    dataGaps.push(
      `剧本 ${scenarioId} 的初设数据未登记编队抽取参数（scenarios.json.setup.formationDraw）⇒ 视为无抽取`,
    )
  } else if (block.pool !== pool.length) {
    dataGaps.push(
      `池规模与数据不一致：规则书给定 ${block.pool}，按 formations.json 推导为 ${pool.length}（列入数据缺口，不擅自改判）`,
    )
  }
  dataGaps.push(
    '规则原文未逐条列出被抽中的编队 ⇒ 抽取结果须由调用方用 rng 在池内抽定（引擎不掷骰、不预设名单）',
  )
  return {
    id: boxId,
    kind: 'scenarioDrawBox',
    name: `${info?.name ?? scenarioId} 编队抽取盒`,
    rule: SCENARIO_DRAW_RULE,
    side: 'axis',
    sections: [
      { id: 'pool', label: '入杯池（抽签前）', rule: SCENARIO_DRAW_RULE },
      { id: 'drawn', label: '已抽中（由抽签决定）', rule: SCENARIO_DRAW_RULE },
    ],
    // 池成员本身不是「盒内单位」（它们是编队标记），故 holdings 为空；
    // 抽取结果由状态层记录后再由界面按 `pool` 回填显示。
    holdings: [],
    capacity: block?.pool ?? 0,
    scenarioId,
    poolSize: block?.pool ?? 0,
    pool,
    groups: block?.groups ?? [],
    raw: block?.raw ?? '',
    reducedCount: block?.reducedCount ?? null,
    artwork: boxArtwork(boxId),
    notes: [
      block?.note === undefined || block.note === '' ? '' : block.note,
      "'No Counterattack' 选项：A/B 两组各只抽 2 个（ch10）",
      '抽取结果对初设的三种处置：沿道路西移 3 格 / 全部战斗单位以 Move Mode 初设 / 与死亡堆互换（Mtr↔Aufk）或把某营加入死亡堆',
    ].filter((note) => note !== ''),
    dataGaps,
  }
}

/** 剧本抽取池：该剧本的轴方装甲/摩托化多单位编队（不含骑兵师） */
export function axisDrawPool(
  scenarioId: string,
): readonly { formationId: string; formationCode: string }[] {
  const key = `S${scenarioId}·axis`
  return formations.formations
    .filter(
      (formation) =>
        formation.side === 'axis' &&
        (formation.sources ?? []).includes(key) &&
        (formation.formationId.endsWith('Pz Div') || formation.formationId.endsWith('Mtr Div')),
    )
    .map((formation) => ({
      formationId: formation.formationId,
      formationCode: formation.formationCode,
    }))
}

/** 抽取结果的处置计划 */
export interface ScenarioDrawPlan {
  rule: string
  scenarioId: string
  group: ScenarioDrawGroup
  /** 抽中的编队 */
  drawn: readonly string[]
  /** 落入死亡堆的单位（B 组互换的 Mtr 团、S5 的 Krd/Aufk 营） */
  deposits: readonly BoxPatch[]
  /** 从死亡堆返场的单位（B 组互换的 Aufk 营） */
  returns: readonly BoxPatch[]
  /** 须转为 Move Mode 的编队（S3/S4 的 A 组） */
  moveModeFormations: readonly string[]
  /** 须沿道路西移的编队与格数（S1/S2 的 A 组） */
  shiftWest: readonly { formationId: string; hexes: number }[]
  /** 落点（shiftWest 由调用方按地图道路给出） */
  destinations: readonly { formationId: string; hex: { col: number; row: number } }[]
  detail: string
}

/**
 * 抽签处置所需的编队组成事实
 *
 * ★ 原先这里是**数据缺口**（"编队组成在数据里没有可靠映射 ⇒ 由调用方注入"，即让玩家手输单位 id）。
 *   实际上 `scenario-setup.json` 的初设行**已经有**这个映射（编队行 + 每个下属的 `unitId` 与落点），
 *   故现在由 `deriveDrawComposition` 自动推出（用户 2026-09-18 报告第 5 条：「编队抽取还是没有实现」
 *   —— 手输 unit id 等于没实现）。本接口保留：调用方仍可显式覆盖（验证页/裁判）。
 */
export interface DrawCompositionFacts {
  /** 该编队中「摩托化团」的单位 id（B 组互换用） */
  mtrRegimentUnitId?: string
  /** 该编队中「装甲侦察（Aufk）营」的单位 id（B 组互换用） */
  aufkBattalionUnitId?: string
  /** 该编队中「摩托化侦察（Krd）营」的单位 id（S5 A 组用） */
  krdBattalionUnitId?: string
  /** 该编队的全部参战单位 id（S3 A 组 Move Mode 用） */
  combatUnitIds?: readonly string[]
  /** shiftWest 的落点（由调用方按地图道路推出） */
  shiftHex?: { col: number; row: number }
}

/** 剧本初设行的最小子集（调用方从 `scenario-setup.json` 取；引擎不读数据文件） */
export interface DrawSetupRowView {
  /** 该行的种类（只取 `formation` —— 编队行；单枚单位行不进本推导） */
  kind: string
  /** 行主键（编队行＝编队 id，如 `3 Pz Div`） */
  unitId?: string | null
  /** 落点种类：`hex`（图上）/ `dead_pile`（死亡堆） */
  locationKind?: string | null
  /** 图上落点（`列.行`；死亡堆行为空） */
  locationHexes?: readonly string[]
  /** 该行的下属（编队行才有；`unitId` 为空表示该分量未链到算子库） */
  subordinates?: readonly {
    /** 下属分量名（如 `3 Inf` / `1 Aufk` / `3 Krd`） */
    component: string
    /** 该分量在单位库里的单位 id（这就是"可靠映射"） */
    unitId?: string | null
    /** 该分量自己的落点种类 */
    locationKind?: string | null
  }[]
}

/** 自动推出的编队组成（`deriveDrawComposition` 的结论） */
export interface DerivedDrawComposition {
  formationId: string
  /** 该编队**图上**的单位（`locationKind === 'hex'`） */
  onMapUnitIds: readonly string[]
  /** 该编队**死亡堆**里的单位 */
  deadPileUnitIds: readonly string[]
  /** 摩托化团（B 组互换的"Mtr"；图上） */
  mtrRegimentUnitId: string | null
  /** 装甲侦察营（B 组互换的"死亡堆里的 Aufk"；**取死亡堆里的那一个**） */
  aufkBattalionUnitId: string | null
  /** 摩托化侦察营（S5 的 Krd；图上） */
  krdBattalionUnitId: string | null
  /** 图上部分的首个落点（返场/西移的参照格）；没有则 null */
  anchorHex: { col: number; row: number } | null
  /** 一句人话（写进台账与日志） */
  note: string
}

/** 单位 id 末段 → 兵种（本作工程库的命名口径；数据核对见回执） */
const MTR_PATTERN = /mot/i
const AUFK_PATTERN = /arm-rec|aufk/i
const KRD_PATTERN = /-mc$|-mc-|krd/i

/**
 * 从**初设索引**推出编队组成（用户 2026-09-18 报告第 5 条：编队抽取要真正可用）
 *
 * 依据（`scenario-setup.json` 的编队行）：
 *   · 每行是一个剧本的初设条目，编队行带 `subordinates`，每个下属**直接给出单位库 unitId 与落点**
 *     （如 `3 Pz Div` 的图上部分是 `11.03` 的 3 Krd / I-6 Pz / III-6 Pz / **3 Inf** / 394 Inf / 75 Arty / Truck，
 *      死亡堆部分是 `1 Aufk` / II-6 Pz）⇒ 「哪个单位是这个师的 Mtr 团 / Aufk 营」**有**可靠映射。
 *   · 规则 ch10 的 B 组互换要「**开局在死亡堆里的** Aufk 营」⇒ 本函数只在**死亡堆那部分**里找 Aufk。
 *
 * 选择口径（原文未指名是哪一个团，如实登记在 `note` 里）：
 *   · **Mtr 团**：图上、unitId 含 `mot` 的下属；多个时**优先与师番号同号者**（`3 Pz Div` ⇒ `3 Inf`），否则取第一个；
 *   · **Krd 营**（S5）：图上、unitId 含 `-mc`（摩托化侦察连/营）的下属；
 *   · **Aufk 营**：**死亡堆**里、unitId 含 `arm-rec` 的下属。
 * 缺任何一项即 `fail`（绝不猜）——调用方据此如实报"这一组按数据落不了盘"。
 */
export function deriveDrawComposition(input: {
  rows: readonly DrawSetupRowView[]
  formationId: string
}): RuleOutcome<DerivedDrawComposition> {
  const rows = input.rows.filter(
    (row) => row.kind === 'formation' && row.unitId === input.formationId,
  )
  if (rows.length === 0)
    return fail(SCENARIO_DRAW_RULE, `formationNotFoundInSetup:${input.formationId}`)

  const parts = rows
    .flatMap((row) => row.subordinates ?? [])
    // 未链到算子库的分量（`unitId === null`）不进推导：抽签要的是**能落到盘面**的单位
    .filter(
      (part): part is { component: string; unitId: string; locationKind?: string | null } =>
        typeof part.unitId === 'string' && part.unitId.length > 0,
    )
  if (parts.length === 0)
    return fail(SCENARIO_DRAW_RULE, `formationHasNoSubordinates:${input.formationId}`)

  const onMap = parts.filter((part) => part.locationKind === 'hex')
  const dead = parts.filter((part) => part.locationKind === 'dead_pile')
  const number = input.formationId.split(' ')[0] ?? ''
  const pickSameNumbered = (
    candidates: readonly { component: string; unitId: string }[],
  ): { component: string; unitId: string } | null => {
    const sameNumber = candidates.find((part) => part.component.startsWith(`${number} `))
    return sameNumber ?? candidates[0] ?? null
  }

  const mtr = pickSameNumbered(onMap.filter((part) => MTR_PATTERN.test(part.unitId)))
  const krd = pickSameNumbered(onMap.filter((part) => KRD_PATTERN.test(part.unitId)))
  // 12.5 之外不相关：Aufk 必须是**死亡堆里**的那个（ch10 原文：「开局在 Dead Pile 里的 Aufk 营」）
  const aufk = pickSameNumbered(dead.filter((part) => AUFK_PATTERN.test(part.unitId)))

  const anchorText =
    rows.flatMap((row) => row.locationHexes ?? []).find((text) => text.includes('.')) ?? null
  const anchorHex =
    anchorText === null
      ? null
      : (() => {
          const [col, row] = anchorText.split('.').map(Number)
          return Number.isFinite(col) && Number.isFinite(row) ? { col: col!, row: row! } : null
        })()

  const note =
    `${input.formationId}（初设自动推）：Mtr=${mtr?.component ?? '—'}` +
    `${mtr === null ? '' : `（${mtr.unitId}）`}；` +
    `Aufk（死亡堆）=${aufk?.component ?? '—'}${aufk === null ? '' : `（${aufk.unitId}）`}；` +
    `Krd=${krd?.component ?? '—'}${krd === null ? '' : `（${krd.unitId}）`}；` +
    `图上 ${String(onMap.length)} 枚 / 死亡堆 ${String(dead.length)} 枚` +
    `${anchorHex === null ? '' : `；图上落点 ${anchorText!}`}`

  return succeed(SCENARIO_DRAW_RULE, {
    formationId: input.formationId,
    onMapUnitIds: onMap.map((part) => part.unitId),
    deadPileUnitIds: dead.map((part) => part.unitId),
    mtrRegimentUnitId: mtr?.unitId ?? null,
    aufkBattalionUnitId: aufk?.unitId ?? null,
    krdBattalionUnitId: krd?.unitId ?? null,
    anchorHex,
    note,
  })
}

/**
 * ch10「沿道路西移 N 格」的落点（★ 用户裁定 2026-10-25：**视为那个格子有道路**）
 *
 * 原文（ch10 A 组）："4 that must shift three hexes west of listed location, following road.
 * (For instance, from 11.03 to 9.01.)" —— 给的是**算法**加一例，不是落点清单：
 *   · 起点＝**所列位置**（剧本页的初设格号 ⇒ 数据里有：`scenario-setup.json`，
 *     如 `3 Pz Div` 的 `11.03`）；
 *   · 终点＝沿道路往西走 N 格（示例 `11.03 → 9.01`）。
 * 而地图数据的道路边（`map-layers.edges` 的 `road`）**未覆盖**该区域（11.03 周边 0 条路）
 * ⇒ 用户裁定"视为那个格子有道路就行"：按几何**沿 SW（西南）方向**逐格走 N 步。
 *   为什么 SW：示例的列 −2、行 −2（向西**且向南**）与 SW 的方向倾向一致；
 *   全程 SW 得 `8.01`（与示例的 `9.01` 差一格，是道路拐弯所致）⇒ 回执里如实写明，
 *   玩家可在初设明细里照剧本卡改。
 * 走不通（图外）时改走 NW（仍是向西）；都走不通就停在能到的最远格（**不猜、不越图**）。
 */
export function shiftWestDestination(
  from: HexRef,
  steps: number,
): { hex: HexRef; walked: number; exact: boolean } {
  const total = Math.max(0, Math.trunc(steps))
  let current: HexRef = { col: from.col, row: from.row }
  let walked = 0
  for (let step = 0; step < total; step += 1) {
    const sw = neighbor(current, 'SW')
    if (isOnMap(sw)) {
      current = { col: sw.col, row: sw.row }
      walked += 1
      continue
    }
    const nw = neighbor(current, 'NW')
    if (isOnMap(nw)) {
      current = { col: nw.col, row: nw.row }
      walked += 1
      continue
    }
    break
  }
  return { hex: current, walked, exact: walked === total }
}

/**
 * 剧本抽取的处置（编队抽签结果落地）
 *
 * 三种处置照规则书：
 *   · `shiftWest`（S1/S2 A 组）：沿道路向所列位置**西移 3 格**（落点须由调用方按地图给出）；
 *   · `moveMode`（S3/S4 A 组）：抽中师的**全部战斗单位以 Move Mode 初设**；
 *   · `mtrAufkSwap`（S1/S2/S3/S4 B 组）：抽中师的一个**摩托化团进入死亡堆**，
 *     而"**开局在死亡堆里的** Aufk 营"**返场**（ch10 原文：Mtr 死、Aufk 活）；
 *   · `deadPileKrd` / `deadPileAufk`（S5/S6）：抽中师的 Krd / Aufk 营**加入死亡堆**。
 *
 * 编队组成（哪个单位是这个师的 Mtr 团 / Aufk 营）在数据里**没有**可靠映射
 * （`formations.json` 的下属标签与单位库命名不同口径）⇒ 由调用方按 `facts` 注入，
 * 缺失即失败（绝不猜）。
 */
export function planScenarioDraw(input: {
  scenarioId: string
  group: ScenarioDrawGroup
  /** 抽中的编队 id（由调用方用 rng 在池内抽定） */
  drawnFormationIds: readonly string[]
  /** 每个抽中编队的组成事实 */
  facts: Record<string, DrawCompositionFacts>
}): RuleOutcome<ScenarioDrawPlan> {
  const box = scenarioDrawBoxView(input.scenarioId)
  const group = input.group
  if (input.drawnFormationIds.length !== group.count)
    return fail(
      SCENARIO_DRAW_RULE,
      `drawCountMismatch:${input.drawnFormationIds.length}≠${group.count}`,
    )
  for (const id of input.drawnFormationIds) {
    if (!box.pool.some((entry) => entry.formationId === id))
      return fail(SCENARIO_DRAW_RULE, `formationNotInDrawPool:${id}`)
  }

  const deposits: BoxPatch[] = []
  const returns: BoxPatch[] = []
  const moveModeFormations: string[] = []
  const shiftWest: { formationId: string; hexes: number }[] = []
  const destinations: { formationId: string; hex: { col: number; row: number } }[] = []

  for (const formationId of input.drawnFormationIds) {
    const fact = input.facts[formationId]
    if (fact === undefined)
      return fail(SCENARIO_DRAW_RULE, `drawCompositionFactsMissing:${formationId}`)
    switch (group.kind) {
      case 'shiftWest': {
        if (fact.shiftHex === undefined)
          return fail(SCENARIO_DRAW_RULE, `shiftWestDestinationMissing:${formationId}`)
        shiftWest.push({ formationId, hexes: group.shiftHexes ?? 1 })
        destinations.push({ formationId, hex: fact.shiftHex })
        break
      }
      case 'moveMode': {
        if ((fact.combatUnitIds ?? []).length === 0)
          return fail(SCENARIO_DRAW_RULE, `moveModeUnitIdsMissing:${formationId}`)
        moveModeFormations.push(formationId)
        for (const unitId of fact.combatUnitIds ?? []) {
          deposits.push({
            unitId,
            to: null,
            mode: 'move',
            note: 'S3/S4 A 组：全部战斗单位以 Move Mode 初设',
          })
        }
        break
      }
      case 'mtrAufkSwap': {
        const mtr = fact.mtrRegimentUnitId
        const aufk = fact.aufkBattalionUnitId
        if (mtr === undefined || aufk === undefined)
          return fail(SCENARIO_DRAW_RULE, `swapUnitsMissing:${formationId}`)
        deposits.push({ unitId: mtr, to: 'deadPile', note: '编队抽签 B 组：摩托化团进入死亡堆' })
        returns.push({ unitId: aufk, to: null, note: '编队抽签 B 组：死亡堆中的装甲侦察营返场' })
        break
      }
      case 'deadPileKrd': {
        const krd = fact.krdBattalionUnitId
        if (krd === undefined) return fail(SCENARIO_DRAW_RULE, `krdBattalionMissing:${formationId}`)
        deposits.push({ unitId: krd, to: 'deadPile', note: 'S5/S6 A 组：摩托化侦察营加入死亡堆' })
        break
      }
      case 'deadPileAufk': {
        const aufk = fact.aufkBattalionUnitId
        if (aufk === undefined)
          return fail(SCENARIO_DRAW_RULE, `aufkBattalionMissing:${formationId}`)
        deposits.push({ unitId: aufk, to: 'deadPile', note: 'S5/S6 B 组：装甲侦察营加入死亡堆' })
        break
      }
    }
  }

  const parts = [
    `剧本 ${input.scenarioId} 编队抽签（${group.label}，${group.rule}）：抽中 ${input.drawnFormationIds.join('、')}`,
    group.effect,
  ]
  if (returns.length > 0)
    parts.push(`从死亡堆返场 ${returns.map((patch) => patch.unitId).join('、')}`)
  return succeed(SCENARIO_DRAW_RULE, {
    rule: SCENARIO_DRAW_RULE,
    scenarioId: input.scenarioId,
    group,
    drawn: [...input.drawnFormationIds],
    deposits,
    returns,
    moveModeFormations,
    shiftWest,
    destinations,
    detail: parts.join('；'),
  })
}

/* ────────────────────────────── 地图外空军盒（1.4a） ────────────────────────────── */

/** 1.4a：地图外空军盒 */
export const AIR_BOX_RULE = '1.4a'

/** 空军盒视图（Active / Inactive 两栏） */
export interface AirBoxView extends BoxView {
  rangeHexes: number
  edgeRow: number
  rules: AirBoxRules
  /**
   * 1.4a：盒内**整备额度**（容量无限 / 费用 0T）
   *
   * 取 `airBoxRefitCapacity()`——与图上基地的 `refitCapacity({isAirBox:false})` 同一实现的另一分支，
   * 而不是把 `infiniteCapacity` / `freeRefitPerTurn` 两个布尔各自解读一遍。
   */
  refit: RefitCapacity
  /** 可激活（免费整备）与不可激活的原因 */
  activation: { activatable: boolean; freeRefitPerTurn: boolean; infiniteCapacity: boolean }
  activeCount: number
  inactiveCount: number
}

/**
 * 地图外空军盒视图（专规 1.4a）
 *
 * 「每方一个，基数无限；箱内任意数量飞机**每回合免费 refit**，并有 extra SP 可经空运任务飞入」。
 * ⇒ 分栏按 14.1a 的 Active / Inactive；「可激活」恒为真（盒内免费整备，且盒不在图上、不受 15.1C 的
 * EZOC 限制）；航程取 `airBoxRangeHexes`（苏 20 / 轴 30），边缘行取 `markers.json.containers.airBoxes`。
 */
export function airBoxView(input: { side: Side; aircraft: readonly BoxUnitView[] }): AirBoxView {
  const boxId = `${input.side}-air-box`
  const data = markers.containers.airBoxes.find((box) => box.side === input.side)
  const rules = airBoxRules()
  const active = input.aircraft.filter((unit) => unit.airStatus === 'active')
  const inactive = input.aircraft.filter((unit) => unit.airStatus !== 'active')
  return {
    id: boxId,
    kind: 'airBox',
    name: `${input.side === 'axis' ? '轴心国 Luftwaffe Box' : '苏联 Red Air Force Box'}`,
    rule: AIR_BOX_RULE,
    side: input.side,
    sections: [
      { id: 'active', label: 'Active（可执行任务）', rule: '14.1a' },
      { id: 'inactive', label: 'Inactive（须整备）', rule: '14.1a' },
    ],
    holdings: [
      ...active.map((unit) => toHolding(unit, 'active')),
      ...inactive.map((unit) => toHolding(unit, 'inactive', { note: '待免费整备（1.4a）' })),
    ],
    capacity: null,
    artwork: boxArtwork(boxId),
    notes: [
      '1.4a：盒内**基数无限**，任意数量飞机**每回合免费整备**（无需 SP、无 15.1C 的 EZOC 限制）',
      `1.4a：飞入地图的航程 —— 苏方 Red Air Force Box ↔ 62.xx 行 = ${airBoxRangeHexes('soviet')} 格；轴方 Luftwaffe Box ↔ 01.xx 行 = ${airBoxRangeHexes('axis')} 格`,
      '1.4：地图外盒内**永远不允许战斗或轰炸**',
      '1.4a：盒内「extra SP」只能经**空运任务**飞入地图（不能走铁路容量，1.6b Notes）',
      '14.1a：只有 Active 飞机能执行任务；任务结束回到基地并转为 Inactive',
    ],
    dataGaps: [],
    rangeHexes: airBoxRangeHexes(input.side),
    edgeRow: data?.edgeRow ?? 0,
    rules,
    // 1.4a：盒内整备额度（容量无限 / 0T）——与图上基地同源（`refitCapacity` 的 isAirBox 分支）
    refit: airBoxRefitCapacity(),
    activation: {
      activatable: rules.freeRefitPerTurn && rules.infiniteCapacity,
      freeRefitPerTurn: rules.freeRefitPerTurn,
      infiniteCapacity: rules.infiniteCapacity,
    },
    activeCount: active.length,
    inactiveCount: inactive.length,
  }
}

/**
 * 1.4a：盒内免费整备（Inactive → Active）
 *
 * 「箱内任意数量飞机每回合免费 refit」⇒ 一次性把盒内 Inactive 全部翻为 Active，不消耗 SP。
 * 与之对照：**图上**空军基地的整备受 15.1C 约束（EZOC 内不可整备、每基地 1T、可整备 2×等级架），
 * 故「可激活 / 不可激活」在图上基地才可能出现；本盒恒可激活。
 */
export function planAirBoxActivate(input: {
  side: Side
  aircraft: readonly BoxUnitView[]
}): RuleOutcome<{ activations: readonly string[]; detail: string }> {
  const inactive = input.aircraft.filter((unit) => unit.airStatus !== 'active')
  if (inactive.length === 0)
    return succeed(AIR_BOX_RULE, { activations: [], detail: '盒内没有 Inactive 飞机（无需整备）' })
  return succeed(AIR_BOX_RULE, {
    activations: inactive.map((unit) => unit.id),
    detail:
      `1.4a：盒内免费整备 ${inactive.length} 架（${inactive.map((unit) => unit.id).join('、')}）⇒ Active；` +
      `不消耗 SP、不受 15.1C 的 EZOC 限制（盒不在图上）`,
  })
}

/* ────────────────────────────── 边缘盒（1.4b） ────────────────────────────── */

/** 1.4b：边缘盒 */
export const EDGE_BOX_RULE = '1.4b'

/** 边缘盒视图 */
export interface EdgeBoxView extends BoxView {
  /** 连接的边缘（northAndEast / southAndEast） */
  connection: EdgeBoxConnection
  rules: EdgeBoxRules
}

/**
 * 边缘盒视图（专规 1.4b）
 *
 * 「仅苏军地面单位可用；Movement Phase 内于地图边缘补给源格与箱之间以 1 MP 或 Rail Cap 往来；
 * 这是地面单位唯一被允许的地图外移动；Reaction / Exploitation 不得进出，撤退也不行；
 * 箱内只有 trace supply，图上单位不能从箱内取 SP 或 trace；进入即停；离箱按 1T/单位免费供油」。
 */
export function edgeBoxView(input: { box: EdgeBoxId; units: readonly BoxUnitView[] }): EdgeBoxView {
  const boxId = `edge-${input.box}`
  const data = markers.containers.edgeBoxes.find((box) => box.id === boxId)
  const rules = edgeBoxRules()
  return {
    id: boxId,
    kind: 'edgeBox',
    name: data?.name ?? (input.box === 'northeast' ? 'Northeast Box' : 'Southeast Box'),
    rule: EDGE_BOX_RULE,
    side: 'soviet',
    sections: [{ id: MAIN_SECTION, label: '盒内单位', rule: EDGE_BOX_RULE }],
    holdings: input.units.map((unit) => toHolding(unit, MAIN_SECTION)),
    capacity: null,
    artwork: boxArtwork(boxId),
    notes: [
      '1.4b：**仅苏方地面单位**可用；只在**移动阶段**进出（反应/进击阶段不得进出，撤退也不行）',
      `1.4b：进入费用 ${rules.entryMp} MP，或改用铁路容量（1 点）`,
      '1.4b：进入即须**停止移动**；离开时按「1T/单位」**免费**加注燃料（不耗 SP）',
      '1.4b：盒内只有 trace supply —— **图上单位不得**从盒内取 SP 或追溯补给',
      `1.4b 连接：${edgeBoxConnection(input.box) === 'northAndEast' ? '北、东边缘所有苏军补给源' : '南、东边缘所有苏军补给源'}`,
    ],
    dataGaps: [],
    connection: edgeBoxConnection(input.box),
    rules,
  }
}

/**
 * 1.4b：边缘盒进出资格
 *
 * 直接复用 `canEnterEdgeBox`（专规 1.4b 的四项同时成立），本函数只补上「盒」的语境说明。
 */
export function planEdgeBoxMove(input: {
  side: Side
  phase: GamePhase
  unitKind: UnitKind
  fromSupplySourceHex: boolean
  direction: 'enter' | 'exit'
  /** 进入时是否改用铁路容量（1.4b：1 MP 或 Rail Cap） */
  useRailCap?: boolean
}): RuleOutcome<{ rule: string; entryMp: number; exitFuelsFree: boolean; detail: string }> {
  const check = canEnterEdgeBox({
    side: input.side,
    phase: input.phase,
    unitKind: input.unitKind,
    fromSupplySourceHex: input.fromSupplySourceHex,
  })
  if (!check.ok) return check
  const rules = edgeBoxRules()
  return succeed(EDGE_BOX_RULE, {
    rule: EDGE_BOX_RULE,
    entryMp: input.useRailCap === true ? 0 : rules.entryMp,
    exitFuelsFree: rules.exitFuelsFree,
    detail:
      (input.direction === 'enter'
        ? `进入边缘盒：${input.useRailCap === true ? '消耗 1 点铁路容量' : `消耗 ${rules.entryMp} MP`}，进入即停止移动（1.4b）`
        : `离开边缘盒：按「1T/单位」免费加注燃料（不耗 SP，1.4b）`) + '；撤退不得进出（1.4b）',
  })
}

/* ────────────────────────────── 编队收纳盒（13.7 / 3.6f） ────────────────────────────── */

/** 13.7 + 3.6f：编队标记与编队收纳盒 */
export const FORMATION_BOX_RULE = '13.7'

/** 编队盒视图 */
export interface FormationBoxView extends BoxView {
  formationId: string
  formationCode: string
  /** 图上的编队标记（3.6f） */
  marker: { markerId: string; markerName: string; imageKey: string | null } | null
  /** 收纳在盒内（图上只余标记）的单位 */
  hiddenIds: readonly string[]
  /** 仍在图上的所属单位（13.7：至少一个须与标记同格） */
  onMapIds: readonly string[]
}

/**
 * 3.6f 编队标记（标记库命名：轴方 `<编号>.<兵种> Draw`，苏方 `<编号> <兵种> Div`）
 *
 * 名字口径由数据给定（`markers.json`），此处只做「编队 → 其标记」的**匹配**：
 * 取编队名的前两段（编号 + 兵种，如 `10 Mtr` / `3 Pz` / `SS-R Mtr`），
 * 按轴/苏两种命名各试一次；匹配不到即返回 null（界面按 `dataGaps` 如实提示，不硬凑）。
 */
function formationMarkerOf(
  side: Side,
  formationId: string,
): { id: string; name: string; front: string | null } | null {
  const tokens = formationId.split(' ')
  const number = tokens[0] ?? ''
  const kind = tokens[1] ?? ''
  const candidates = markers.markers.filter(
    (marker) => marker.ruleClass === '3.6f' && marker.side === side,
  )
  const found = candidates.find((marker) => {
    if (number === '' || kind === '') return false
    // 轴方：`10.Mtr Draw`（或带 `Ge ` 前缀的 `Ge 1.Cav`）；苏方：`1 Mtr Div`
    if (side === 'axis')
      return (
        marker.name.startsWith(`${number}.${kind}`) ||
        marker.name.startsWith(`Ge ${number}.${kind}`)
      )
    return marker.name.startsWith(`${number} ${kind}`)
  })
  if (found === undefined) return null
  return { id: found.id, name: found.name, front: found.front ?? null }
}

/**
 * 编队收纳盒视图（13.7 编队标记 + 专规 3.6f）
 *
 * 「13.7 Formation Marker：**离图表示多单位编队**、降低堆叠密度；有 normal/fueled 两面；
 * **至少一个所属单位须与其同格**（除作 Fueling 提示外）」⇒ 本盒＝收纳多单位编队的下属单位，
 * 图上只留标记（**迷雾效果**：对手只看到标记，看不到盒内构成）。
 */
export function formationBoxView(input: {
  formationId: string
  side: Side
  /** 该编队全部所属单位 */
  members: readonly BoxUnitView[]
  /** 其中仍在图上的（至少一个须与标记同格） */
  onMapIds: readonly string[]
}): FormationBoxView {
  const formation = formations.formations.find((item) => item.formationId === input.formationId)
  const boxId = `formation-${input.formationId}`
  // 3.6f：编队标记（正面普通 / 背面已加油）
  const marker = formationMarkerOf(input.side, input.formationId)
  const hidden = input.members.filter((unit) => !input.onMapIds.includes(unit.id))
  return {
    id: boxId,
    kind: 'formationBox',
    name: `${formation?.formationId ?? input.formationId} 编队盒`,
    rule: FORMATION_BOX_RULE,
    side: input.side,
    sections: [{ id: MAIN_SECTION, label: '盒内（对手不可见 · 迷雾）', rule: FORMATION_BOX_RULE }],
    holdings: hidden.map((unit) => toHolding(unit, MAIN_SECTION, { groupId: input.formationId })),
    capacity: null,
    artwork: boxArtwork(boxId),
    notes: [
      '13.7：编队标记**离图表示多单位编队**，降低堆叠密度；有 normal / fueled 两面',
      '13.7：**至少一个所属单位须与标记同格**（除作 Fueling 提示外）',
      '13.7a：同一多单位编队的不同部分必须 trace 到同一 HQ / 同一 direct-draw 源',
      '3.6f：编队标记随所属多单位编队；标记在图上，构成对对手隐藏（迷雾）',
    ],
    dataGaps:
      marker === null
        ? [`标记库中未找到 ${input.formationId} 的 3.6f 编队标记（markers.json）`]
        : [],
    formationId: input.formationId,
    formationCode: formation?.formationCode ?? '',
    marker:
      marker === null
        ? null
        : { markerId: marker.id, markerName: marker.name, imageKey: marker.front },
    hiddenIds: hidden.map((unit) => unit.id),
    onMapIds: [...input.onMapIds],
  }
}

/**
 * 13.7：把编队下属**收纳进盒**（图上只留标记）
 *
 * 校验唯一硬约束：「至少一个所属单位须与标记同格」。工具条上的 `markerHex` 与
 * `unitHexes` 由调用方按盘面给出；收纳后若图上没有任何所属单位与标记同格，即拒绝。
 */
export function planFormationBoxHide(input: {
  formationId: string
  /** 标记所在格 */
  markerHex: { col: number; row: number }
  /** 收纳**之后**仍在图上的所属单位（id → 所在格） */
  remainingOnMap: readonly { unitId: string; hex: { col: number; row: number } }[]
  /** 本次收纳的单位 id */
  hideUnitIds: readonly string[]
}): RuleOutcome<{ hidden: readonly string[]; detail: string }> {
  if (input.hideUnitIds.length === 0) return fail(FORMATION_BOX_RULE, 'nothingToHide')
  const withMarker = input.remainingOnMap.filter(
    (entry) => entry.hex.col === input.markerHex.col && entry.hex.row === input.markerHex.row,
  )
  if (withMarker.length === 0) return fail(FORMATION_BOX_RULE, 'atLeastOneUnitMustStackWithMarker')
  return succeed(FORMATION_BOX_RULE, {
    hidden: [...input.hideUnitIds],
    detail:
      `13.7：${input.hideUnitIds.length} 个下属单位收纳进 ${input.formationId} 编队盒（图上只留标记，构成迷雾）；` +
      `标记格（${input.markerHex.col}.${input.markerHex.row}）仍有 ${withMarker.length} 个所属单位同格 —— 满足 13.7 的硬约束`,
  })
}

/**
 * 13.7：把盒内单位**放回图上**
 *
 * 放出即恢复可见；落点仍须满足「至少一个所属单位与标记同格」的既有不变量（放出不破坏它）。
 */
export function planFormationBoxReveal(input: {
  formationId: string
  releaseUnitIds: readonly string[]
}): RuleOutcome<{ released: readonly string[]; detail: string }> {
  if (input.releaseUnitIds.length === 0) return fail(FORMATION_BOX_RULE, 'nothingToRelease')
  return succeed(FORMATION_BOX_RULE, {
    released: [...input.releaseUnitIds],
    detail: `${input.formationId}：${input.releaseUnitIds.length} 个单位从编队盒放回图上（恢复可见）`,
  })
}

/* ────────────────────────────── 全部盒（供界面一次铺开） ────────────────────────────── */

/** 一次列出全部盒的名册（顺序即界面展示顺序） */
export function allBoxViews(input: {
  /** 当前剧本（剧本抽取盒用） */
  scenarioId: string
  /** 各盒内容（由调用方按盘面给出；缺省即空盒） */
  deadPile: Record<Side, readonly BoxUnitView[]>
  breakdownUnits: Record<Side, readonly BoxUnitView[]>
  breakdownOnMap: Record<Side, readonly BoxUnitView[]>
  aircraftInBox: Record<Side, readonly BoxUnitView[]>
  edgeBoxUnits: Record<EdgeBoxId, readonly BoxUnitView[]>
  formationBoxes: readonly {
    formationId: string
    side: Side
    members: readonly BoxUnitView[]
    onMapIds: readonly string[]
  }[]
  date: string
}): readonly BoxView[] {
  const views: BoxView[] = []
  for (const side of ['axis', 'soviet'] as const) {
    views.push(deadPileView({ side, units: input.deadPile[side] }))
    views.push(
      breakdownBoxView({
        side,
        breakdownUnits: input.breakdownUnits[side],
        onMap: input.breakdownOnMap[side],
      }),
    )
    views.push(specialReplBoxView({ side, date: input.date, deadPile: input.deadPile[side] }))
    views.push(airBoxView({ side, aircraft: input.aircraftInBox[side] }))
  }
  views.push(edgeBoxView({ box: 'northeast', units: input.edgeBoxUnits.northeast }))
  views.push(edgeBoxView({ box: 'southeast', units: input.edgeBoxUnits.southeast }))
  views.push(scenarioDrawBoxView(input.scenarioId))
  for (const formation of input.formationBoxes) {
    views.push(
      formationBoxView({
        formationId: formation.formationId,
        side: formation.side,
        members: formation.members,
        onMapIds: formation.onMapIds,
      }),
    )
  }
  return views
}
