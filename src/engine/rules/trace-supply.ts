import { rulesConstants } from '@/data'
import type { HexRef, Side } from '@/data'

import { areAdjacent, HEX_DIRECTIONS, isOnMap, neighbor, sameHex } from '../hex-geometry'
import { createMapFacts, type MapFactsSource } from './map-facts'
import type { MapFacts } from './move-types'
import type { BaseMode } from './modes'
import { DIRECT_DRAW_RANGE_MP, TRACE_T_PER_TWO_RE } from './supply'
import { selectMovementTerrain, type MobilityType } from './terrain'
import { projectsZoc, type ZocSource } from './zoc'

/**
 * 补给追溯（B10，OCS 12.0 章）
 *
 * 「能用 trace 的地方就能用 combat，反之不成立」——本模块只管**追溯补给**这条抽象补给线；
 * 战斗补给成本（9.5/12.4）与补给站爆破（12.11a）见 supply.ts；燃料（12.5）见 fuel.ts。
 * 损耗表（12.8b）不在本作数据内，故本模块**只做断补标记与解除**（12.6d/12.8a），不掷损耗。
 *
 * ## 条文索引（中文规则书 12.0 章）
 *   - 12.0    只有**战斗单位**需要补给；非战斗单位、空军、海军永不消耗 SP、永不需要追溯补给
 *   - 12.1b   dump＝任何含 SP 的地点（SP 不必卸载即可用）
 *   - 12.3a   Direct Draw：单位须在补给站的 **5 MP** 内，或与补给站相邻（12.3c）。
 *             计数始终用**轮式 MP**（例外：投递距离为步行/履带的 HQ 用对应类型）
 *   - 12.3b   Throwing Via HQ：HQ 从 dump 拖取后向**印值投递距离**内前送；
 *             (A) 只投递即用补给 (B) 可投任意数量友军 (C) 战略模式 HQ **不能**投递
 *             (D) HQ 不得把别的 HQ 投递给它的补给**再投递**（但可用于满足自身需求）
 *   - 12.3c   相邻即可：只要补给能到**单位的相邻格**，单位即可获得（不论地形，哪怕禁入地形）
 *   - 12.3d   补给路径＝一个假想非战斗单位逐格移动：可穿敌方非战斗单位/舰船/飞机，
 *             **绝不能穿敌方战斗单位**；用卡车 MP 时，未抵消的敌方 ZOC 阻挡**进入或离开**该格；
 *             一律按**正常**地形成本计（忽略泥泞/积雪与运输破坏的额外消耗，但可享受天气降低的消耗）
 *   - 12.6a   补给源三种：① 允许增援入场的地图边缘铁路格 + 专规列出的源；② 火车卸货格（13.3c）；
 *             ③ 与火车卸货格或补给源相连的**延补队**（12.7）
 *   - 12.6b   补给源格内有未抵消的敌方 ZOC ⇒ 不能从该源获得追溯补给（4.5b 可抵消）
 *   - 12.6c   吃图上补给：每 **1 T** 喂**最多 2 RE**，小数**向上取整**（6.5 RE → 4 T）；
 *             只有在**没有**追溯补给时才可吃；且**永不被强迫**吃
 *   - 12.6d   不能追溯且不吃图上补给 ⇒ 标记断补并掷损耗（12.8）
 *   - 12.6e   战略模式单位不允许吃图上补给，必须在该时有追溯补给的格内结束移动（另见 5.8b）
 *   - 12.6f   多单位编队的所有战斗单位须 trace 到**同一个 HQ**或**直接拖取同一个补给源**；
 *             做不到时，选一部分「免费」，其余吃图上补给否则断补
 *   - 12.7a   延补队唯一作用＝创造**新的追溯补给取用点**；不能运 SP、不增加拖取/投递距离
 *   - 12.7b   延补队有距离（MP）＝距后方被连接格的最远距离；永远放在连接的前方
 *   - 12.7c   延补队可与延补队连接成「锁链」
 *   - 12.7d   生成：同格 5 点**同型**运输点数消耗**一半 MA**；生成时该格必须能连上补给来源
 *   - 4.5b    抵消：格内有己方战斗单位即抵消该格敌方 ZOC
 *   - 5.8b    战略模式单位必须在拥有追溯补给的格内结束移动（本模块提供桥接函数）
 *
 * ## 设计口径
 *   - **纯函数 + 视图输入**：补给源、HQ、延补队、dump、单位与 ZOC 全由 `TraceSupplyFacts` 注入；
 *     默认实现从 map-layers.json + 调用方给出的清单建索引（与 B7 的 map-facts.ts 同思路）；
 *   - **不许愿**：数据里没有的数值（延补队距离、补给源清单、HQ 投递距离与颜色）一律由调用方入参，
 *     本模块只裁定规则，不发明数字；一切常量取自 rules-constants.json；
 *   - **12.7a-B/C 的铁路线特例不建模**：那需要铁路网络数据（13.3）；需要时由调用方把由此产生的
 *     火车卸货格并入 `sources`（kind='detrainable'），本模块不臆造铁路连通性。
 */

/* ────────────────────────────── 常量（唯一来源 rules-constants.json） ────────────────────────────── */

/** 图上补给：每份覆盖的 RE 数（12.6c；与 supply.ts 的 TRACE_T_PER_TWO_RE 成对使用） */
export const TRACE_RE_PER_T = rulesConstants.supply.traceRePerT

/* 12.7d 的「消耗一半 MA」常量只有一处：`extender.ts` 的 `EXTENDER_FLIP_MA_FRACTION`
 * （本模块原有的同名副本 `EXTENDER_CREATION_MA_FRACTION` 随 `extenderCreationCost` 一并删除）。 */

/* ────────────────────────────── 词表 ────────────────────────────── */

/**
 * 补给路径的机动类型（12.3a：计数始终用轮式 MP，例外见 12.3b；12.7b：延补队自带距离与类型）
 *
 * 复用 TEC 的 MobilityType，不另造词表（CODE_SPEC §5）。
 */
export type SupplyMobility = MobilityType

/**
 * 追溯补给源种类
 *
 *   - `edgeRail`        12.6a① 允许增援入场的地图边缘铁路格
 *   - `supplySourceHex` 12.6a① 专规列出的补给源格（专规 2.1/3.1；含图外盒的接图边格）
 *   - `detrainable`     12.6a② 火车卸货格（13.3c）
 *   - `extender`        12.6a③ 延补队（12.7）
 *   - `hqThrow`         12.3b/12.6 经指挥部投递（HQ 自身能拖取 dump 或自身有追溯补给）
 */
export type TraceSourceKind =
  'edgeRail' | 'supplySourceHex' | 'detrainable' | 'extender' | 'hqThrow'

/** 基础补给源种类（12.6a①②③；不含 HQ 投递） */
export type BaseSourceKind = Exclude<TraceSourceKind, 'hqThrow'>

/** 统一结论（ok 或带条文号的失败） */
export type SupplyVerdict =
  | { ok: true; rule: string; detail?: string }
  | { ok: false; rule: string; reason: string; detail?: string }

/** 追溯失败原因码 */
export type TraceFailReason =
  /** 该格不在图内（图外盒请改传入其接图边格） */
  | 'offMap'
  /** 找不到任何可用补给源（12.6a） */
  | 'noSource'
  /** 有源，但源格处于未抵消的敌方 ZOC 或被敌方战斗单位占据（12.6b / 12.6） */
  | 'sourceBlocked'

/** 追溯补给结论（成功时给出所连的源） */
export type TraceVerdict =
  | { ok: true; rule: string; source: { hex: HexRef; kind: TraceSourceKind } }
  | { ok: false; rule: string; reason: TraceFailReason }

/* ────────────────────────────── 事实（注入） ────────────────────────────── */

/** 补给事实所需的最小单位视图（字段名照 state-types / move-types，不复制字段全集） */
export interface TraceSupplyUnitView {
  id: string
  side: Side
  /** 图上位置；不在图上为 null */
  hex: HexRef | null
  /** 是否战斗单位（12.0：只有战斗单位需要 trace；4.5b：只有战斗单位能抵消敌方 ZOC） */
  isCombat: boolean
  /** 是否可攻击（4.5 ZOC 投射三条件之一） */
  attackCapable?: boolean
  /** 是否处于战斗模式（4.5；由 modes.exertsZoc 裁定后传入，勿传原始模式字段） */
  inCombatMode?: boolean
  /** 是否有追溯补给（4.5：断补单位不投射 ZOC）；缺省视为 true */
  hasTraceSupply?: boolean
}

/** 基础补给源格（12.6a①②） */
export interface TraceSupplySourceView {
  hex: HexRef
  side: Side
  kind: BaseSourceKind
}

/** 延补队视图（12.7b：`rangeMp` 为印值距离，用 `extenderRangeMpOf(unit)` 从印值 MA 取得） */
export interface ExtenderView {
  hex: HexRef
  side: Side
  /** 该延补队的机动类型（12.7b/12.3d：步行/履带的延补队不受敌方 ZOC 影响） */
  mobility: SupplyMobility
  /** 12.7b：距后方被连接格的最远距离（MP）；本作卡车延补队＝20 轮式 MP、马车延补队＝10 */
  rangeMp: number
}

/** 可投递的指挥部视图（12.3b） */
export interface ThrowHqView {
  hex: HexRef
  side: Side
  /** 模式（12.3b-C：战略模式的 HQ 不能投递） */
  mode: BaseMode
  /** HQ 自身的机动类型（其自身的补给路径按此类型计，12.3d） */
  mobility: SupplyMobility
  /** 印值投递距离（MP，12.3b） */
  throwRangeMp: number
  /** 投递距离的颜色所示机动类型（3.1a/12.3b） */
  throwMobility: SupplyMobility
  /** 该 HQ 是否由别的 HQ 投递获得补给（12.3b-D：不可转投） */
  receivedByThrow?: boolean
}

/** 建事实所需的原始素材（默认取产品数据 map-layers.json 作地图） */
export interface TraceSupplyFactsSource {
  /** 地图（6.2 地形成本与图内判定）；缺省取 map-layers.json */
  map?: MapFactsSource
  /** 基础补给源格（12.6a①②） */
  sources?: readonly TraceSupplySourceView[]
  /** 延补队（12.7） */
  extenders?: readonly ExtenderView[]
  /** 可投递的指挥部（12.3b） */
  throwHqs?: readonly ThrowHqView[]
  /** 含 SP 的格（dump，12.1b） */
  dumps?: readonly { hex: HexRef; side: Side }[]
  /** 单位视图（4.5b 抵消、12.3d 敌方战斗单位阻断、ZOC 投射） */
  units?: readonly TraceSupplyUnitView[]
}

/**
 * 补给事实提供者
 *
 * 把「补给源在哪、谁能挡路、走一步多少 MP」从补给逻辑里分出去：
 * 供给模块只消费语义化查询，默认实现见 `createTraceSupplyFacts`。
 */
export interface TraceSupplyFacts {
  /** 是否在图内（判据同引擎 isOnMap） */
  onMap(hex: HexRef): boolean
  /** 该方的基础补给源格（12.6a①②） */
  sourcesFor(side: Side): readonly { hex: HexRef; kind: BaseSourceKind }[]
  /** 该方的延补队（12.7） */
  extendersFor(side: Side): readonly { hex: HexRef; mobility: SupplyMobility; rangeMp: number }[]
  /** 该方可投递的指挥部（12.3b） */
  throwHqsFor(side: Side): readonly ThrowHqView[]
  /** 该方的 dump 格（12.1b；12.6c 吃图上补给、12.3a 拖取用） */
  dumpsFor(side: Side): readonly HexRef[]
  /** 12.3d：该格是否有**敌方战斗单位**（阻断一切路径，也使该格不能作源） */
  hasEnemyCombatUnit(hex: HexRef, side: Side): boolean
  /** 12.3d/4.5b：该格是否处于**未被抵消**的敌方 ZOC（阻挡卡车 MP 路径的进入与离开） */
  inEnemyZoc(hex: HexRef, side: Side): boolean
  /** 12.3d：正常地形成本下的一步 MP（含 6.2a 道路优先）；不可通行 → null */
  stepCost(from: HexRef, to: HexRef, mobility: SupplyMobility): number | null
}

/** 格的规范键（仅模块内部索引；业务坐标一律 { col, row }，CODE_SPEC §4） */
function hexKey(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

/** 对方阵营 */
function enemySide(side: Side): Side {
  return side === 'axis' ? 'soviet' : 'axis'
}

/**
 * 12.3d：一步的补给计费
 *
 * 「始终按『正常』地形的 MP 消耗计算（以夏季/晴朗条件为准），忽略所有临时的恶劣地面条件
 *   以及通过运输破坏区域产生的额外 MP 消耗」——TEC 基础值即正常成本，故本函数只读 TEC，
 *   天气抬高与运输破坏的额外成本不在此处（17.0c/14.8 另行判定，且对补给路径一律忽略）。
 * 沿路照常享受 6.2a 的道路优先（那是地形属性，不是天气）。
 */
function supplyStepCost(
  map: MapFacts,
  from: HexRef,
  to: HexRef,
  mobility: SupplyMobility,
): number | null {
  const crossing = map.crossingBetween(from, to)
  const followingRoad = (crossing?.routes ?? []).length > 0
  const result = selectMovementTerrain({
    terrainsPresent: map.terrainsAt(to),
    mobility,
    crossing,
    followingRoad,
  })
  if (!result.ok) return null
  return result.totalMp
}

/**
 * 由原始素材建事实（默认地图取 map-layers.json）
 *
 * ZOC 投射与 4.5b 抵消一律交给现有 zoc.ts，避免两处判据漂移：
 *   - 投射 = 可攻击 ∧ 战斗模式 ∧ 非断补（4.5）；
 *   - 抵消 = 格内有己方战斗单位（不论模式，4.5b）。
 */
export function createTraceSupplyFacts(source: TraceSupplyFactsSource = {}): TraceSupplyFacts {
  const map = createMapFacts(source.map)
  const units = source.units ?? []
  const sources = source.sources ?? []
  const extenders = source.extenders ?? []
  const throwHqs = source.throwHqs ?? []
  const dumps = source.dumps ?? []

  const zocSources: ZocSource[] = []
  const combatUnitHexes: { hex: HexRef; side: Side }[] = []
  for (const unit of units) {
    if (unit.hex === null) continue
    if (unit.isCombat) combatUnitHexes.push({ hex: unit.hex, side: unit.side })
    zocSources.push({
      hex: unit.hex,
      side: unit.side,
      attackCapable: unit.attackCapable ?? false,
      inCombatMode: unit.inCombatMode ?? false,
      hasTraceSupply: unit.hasTraceSupply ?? true,
    })
  }

  /*
   * ★ H③（性能）：把两个"逐格判据"从**每次询问线性扫全表**改成**建一次索引**。
   *   12.3d 的搜索按「每个被访问格 × 6 邻格」调用这两个判据，而修前它们各自扫一遍全部战斗单位 /
   *   全部 ZOC 源 —— 真实盘面（216 枚算子）上一次 8 MP 查询要比较 **36 万次**格坐标
   *   （实测单次 37 ms、`drawableDumpsFor` 一次 602 ms、点一下需加油的单位整链 2.5 s）。
   *   索引与原判据**逐字等价**（判据本身没改，只是把"每次重算"换成"建一次"）：
   *     · `combatByHex`：格 → 该格的参战方（原判据 `combatUnitHexes.some(同格 ∧ 异方)`）；
   *     · `zocBySide`：方 → 该方 ZOC 覆盖的格（原判据 `areAdjacent(source.hex, hex)` 的六邻枚举；
   *       **刻意不过滤图外**，与原 `areAdjacent` 的口径逐格一致）。
   *   事实对象本身是不可变投影：盘面一变，调用方（store 的 `supplyFacts`）会重建事实。
   */
  const combatByHex = new Map<string, Side[]>()
  for (const item of combatUnitHexes) {
    const key = hexKey(item.hex)
    const sides = combatByHex.get(key)
    if (sides === undefined) combatByHex.set(key, [item.side])
    else if (!sides.includes(item.side)) sides.push(item.side)
  }
  const zocBySide = new Map<Side, Set<string>>()
  for (const source of zocSources) {
    if (!projectsZoc(source)) continue
    let covered = zocBySide.get(source.side)
    if (covered === undefined) {
      covered = new Set<string>()
      zocBySide.set(source.side, covered)
    }
    for (const direction of HEX_DIRECTIONS) covered.add(hexKey(neighbor(source.hex, direction)))
  }
  /** 该方的 dump 格（12.1b；按方缓存：`drawableDumpsFor` 会为每座站反复取这张表） */
  const dumpsBySide = new Map<Side, HexRef[]>()
  for (const item of dumps) {
    const list = dumpsBySide.get(item.side)
    if (list === undefined) dumpsBySide.set(item.side, [item.hex])
    else list.push(item.hex)
  }

  return {
    onMap: (hex) => isOnMap(hex),
    sourcesFor: (side) =>
      sources
        .filter((item) => item.side === side)
        .map((item) => ({ hex: item.hex, kind: item.kind })),
    extendersFor: (side) =>
      extenders
        .filter((item) => item.side === side)
        .map((item) => ({ hex: item.hex, mobility: item.mobility, rangeMp: item.rangeMp })),
    throwHqsFor: (side) => throwHqs.filter((item) => item.side === side),
    dumpsFor: (side) => dumpsBySide.get(side) ?? [],
    hasEnemyCombatUnit: (hex, side) => {
      const sides = combatByHex.get(hexKey(hex))
      return sides !== undefined && sides.some((item) => item !== side)
    },
    inEnemyZoc: (hex, side) => {
      // 4.5b：格内有己方战斗单位即抵消（不论该单位是否投射 ZOC、是否处于战斗模式）
      const friendlies = combatByHex.get(hexKey(hex))
      if (friendlies !== undefined && friendlies.includes(side)) return false
      return zocBySide.get(enemySide(side))?.has(hexKey(hex)) === true
    },
    stepCost: (from, to, mobility) => supplyStepCost(map, from, to, mobility),
  }
}

/* ────────────────────────────── 距离计数（12.3a/12.3b/12.7b 共用） ────────────────────────────── */

/**
 * 12.3d：一步是否可走
 *
 * 阻断三条：① 图外；② 目标格有敌方战斗单位（「绝不能穿越包含敌方战斗单位的格」）；
 * ③ 用**卡车 MP** 时，未抵消的敌方 ZOC 格「阻挡**进入该格或离开该格**」的补给路径
 * （步行/履带路径不受影响）。
 */
function stepMp(
  facts: TraceSupplyFacts,
  side: Side,
  mobility: SupplyMobility,
  from: HexRef,
  to: HexRef,
): number | null {
  if (!facts.onMap(to)) return null
  if (facts.hasEnemyCombatUnit(to, side)) return null
  if (mobility === 'truck' && (facts.inEnemyZoc(to, side) || facts.inEnemyZoc(from, side)))
    return null
  return facts.stepCost(from, to, mobility)
}

/**
 * 12.3c：`hex` 自身及其六邻格
 *
 * 「只要补给能到达**单位的相邻格**，单位即可获得补给」——故一切 draw/throw 距离的终点集合
 * 都是「单位格或其任一相邻格」。
 */
function selfAndNeighbors(hex: HexRef): HexRef[] {
  return [hex, ...HEX_DIRECTIONS.map((direction) => neighbor(hex, direction))]
}

/** 有界最短补给消耗的返回 */
export type SupplyDistanceResult =
  { ok: true; mp: number } | { ok: false; reason: 'offMap' | 'unreachable' }

/**
 * 有界 Dijkstra（12.3d 的**唯一**搜索实现）
 *
 * 每步取费为正，故最短路即玩家会选的那条；取费与阻断一律经 `stepMp`（同一条文口径）。
 * `stopAt` 给出后命中其中任一格即停（多目标查询的提前返回）；不给则收齐整片预算内区域
 * （C8 的投递/拖取**可视化**需要整片区域）。同时返回前驱表供 `supplyPath` 回溯。
 *
 * ★ H③（性能）：取最小改**二叉堆**。修前每弹一格都重扫整张 `best`（含已 settle 的条目），
 *   一次 8 MP 查询在真实盘面上是「访问格数 × 全表」的平方关系 —— 实测单次 37 ms、
 *   用户点一下需加油的单位要 2.5 s。堆的**弹出顺序与修前逐字相同**：按 `(MP, 首次入表序号)`
 *   取最小（修前的线性扫描在 `best` 的插入序里取第一个最小），故等费路径的前驱链不变
 *   ⇒ `supplyPath` 返回的路径与修前一致（12.3d 只规定"最省"，未规定等费取哪条；
 *      这里刻意保序，避免路径类断言无谓漂移）。
 */
interface SearchEntry {
  /** 格键（`列.行`） */
  key: string
  /** 该键**当前**的最省消耗（陈旧条目会与 `best` 不符而被跳过） */
  mp: number
  /** 首次入表序号（等费时的稳定次序，与修前的 `best` 插入序等价） */
  seq: number
  /** 该格的坐标（免去每次弹出再拆键） */
  hex: HexRef
}

function runDijkstra(
  facts: TraceSupplyFacts,
  input: {
    from: HexRef
    side: Side
    mobility: SupplyMobility
    maxMp: number
    /** 命中其中任一格即停止（键为 `列.行`） */
    stopAt?: ReadonlySet<string>
  },
): { best: Map<string, number>; prev: Map<string, string> } {
  const { from, side, mobility, maxMp } = input
  const startKey = hexKey(from)
  const best = new Map<string, number>([[startKey, 0]])
  const prev = new Map<string, string>()
  const settled = new Set<string>()
  /** 键 → 首次入表序号（只增不改：等费次序按"谁先被探索到"） */
  const seqOf = new Map<string, number>([[startKey, 0]])
  let nextSeq = 1
  // 小顶堆（按 `mp`，同 `mp` 按 `seq`）；`mp` 变小时压入新条目，旧条目弹出时按 `best` 判陈旧
  const heap: SearchEntry[] = [{ key: startKey, mp: 0, seq: 0, hex: from }]
  const less = (a: SearchEntry, b: SearchEntry): boolean =>
    a.mp !== b.mp ? a.mp < b.mp : a.seq < b.seq
  const push = (entry: SearchEntry): void => {
    heap.push(entry)
    let index = heap.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (!less(heap[index]!, heap[parent]!)) break
      const swap = heap[parent]!
      heap[parent] = heap[index]!
      heap[index] = swap
      index = parent
    }
  }
  const pop = (): SearchEntry | undefined => {
    const top = heap[0]
    const last = heap.pop()
    if (top === undefined || last === undefined) return top
    if (heap.length === 0) return top
    heap[0] = last
    let index = 0
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if (left < heap.length && less(heap[left]!, heap[smallest]!)) smallest = left
      if (right < heap.length && less(heap[right]!, heap[smallest]!)) smallest = right
      if (smallest === index) break
      const swap = heap[smallest]!
      heap[smallest] = heap[index]!
      heap[index] = swap
      index = smallest
    }
    return top
  }

  for (;;) {
    const current = pop()
    if (current === undefined) break
    if (settled.has(current.key)) continue
    // 陈旧条目：该键已被更省的路取代（此时 `best` 里是更小的值）
    if (best.get(current.key) !== current.mp) continue
    if (current.mp > maxMp) break
    if (current.key !== startKey && input.stopAt?.has(current.key) === true) break
    settled.add(current.key)
    for (const direction of HEX_DIRECTIONS) {
      const next = neighbor(current.hex, direction)
      const step = stepMp(facts, side, mobility, current.hex, next)
      if (step === null) continue
      const candidate = current.mp + step
      if (candidate > maxMp) continue
      const key = hexKey(next)
      const existing = best.get(key)
      if (existing !== undefined && candidate >= existing) continue
      best.set(key, candidate)
      prev.set(key, current.key)
      let seq = seqOf.get(key)
      if (seq === undefined) {
        seq = nextSeq
        nextSeq += 1
        seqOf.set(key, seq)
      }
      push({ key, mp: candidate, seq, hex: next })
    }
  }
  return { best, prev }
}

/** `列.行` → 格坐标 */
function hexFromKey(key: string): HexRef {
  const [col, row] = key.split('.').map(Number)
  return { col: col!, row: row! }
}

/**
 * 到**任一目标格**的有界最短补给消耗（Dijkstra）
 *
 * 计数一律用调用方给的机动类型（12.3a：默认轮式 MP；12.3b：投递距离颜色所示类型）。
 */
export function countSupplyDistanceToAny(
  facts: TraceSupplyFacts,
  input: {
    from: HexRef
    targets: readonly HexRef[]
    side: Side
    mobility: SupplyMobility
    maxMp?: number
  },
): SupplyDistanceResult {
  const { from, side, mobility } = input
  const maxMp = input.maxMp ?? Number.POSITIVE_INFINITY
  if (!facts.onMap(from)) return { ok: false, reason: 'offMap' }
  const wanted = new Set(input.targets.filter((hex) => facts.onMap(hex)).map(hexKey))
  if (wanted.size === 0) return { ok: false, reason: 'offMap' }
  if (wanted.has(hexKey(from))) return { ok: true, mp: 0 }

  const { best } = runDijkstra(facts, { from, side, mobility, maxMp, stopAt: wanted })
  let bestMp = Number.POSITIVE_INFINITY
  for (const key of wanted) {
    const mp = best.get(key)
    if (mp !== undefined) bestMp = Math.min(bestMp, mp)
  }
  if (bestMp === Number.POSITIVE_INFINITY || bestMp > maxMp)
    return { ok: false, reason: 'unreachable' }
  return { ok: true, mp: bestMp }
}

/** 到**指定格**的有界最短补给消耗（`countSupplyDistanceToAny` 的单目标特例） */
export function countSupplyDistance(
  facts: TraceSupplyFacts,
  input: { from: HexRef; to: HexRef; side: Side; mobility: SupplyMobility; maxMp?: number },
): SupplyDistanceResult {
  return countSupplyDistanceToAny(facts, {
    from: input.from,
    targets: [input.to],
    side: input.side,
    mobility: input.mobility,
    ...(input.maxMp === undefined ? {} : { maxMp: input.maxMp }),
  })
}

/* ────────────────────────────── 可视化原语（C8：追溯与投递可视化） ────────────────────────────── */

/** 预算内可达的一格（含到该格的补给消耗 MP） */
export interface SupplyReachableHex {
  hex: HexRef
  mp: number
}

/**
 * 一次 Dijkstra 求出**预算内可达的全部格**
 *
 * 供界面画出「指挥部投递覆盖 / 补给站拖取覆盖」。取费与阻断与单点查询**共用 `stepMp`**
 * （12.3d：不穿敌方战斗单位格；卡车 MP 时未抵消敌方 ZOC 阻挡进出；按夏季/晴朗正常地形计）。
 * 返回按 MP 升序，便于界面分层着色。
 */
export function supplyReachableHexes(
  facts: TraceSupplyFacts,
  input: { from: HexRef; side: Side; mobility: SupplyMobility; maxMp: number },
): SupplyReachableHex[] {
  if (!facts.onMap(input.from)) return []
  const { best } = runDijkstra(facts, {
    from: input.from,
    side: input.side,
    mobility: input.mobility,
    maxMp: input.maxMp,
  })
  const reachable: SupplyReachableHex[] = []
  for (const [key, mp] of best) {
    if (mp <= input.maxMp) reachable.push({ hex: hexFromKey(key), mp })
  }
  return reachable.sort((a, b) => a.mp - b.mp)
}

/**
 * 12.3d：从补给源到目标格的**最省路径**（含起点与终点）
 *
 * 「任何一种补给路径都会视为一个假象的**非战斗单位**沿着一条补给路径逐格移动，以此来计量距离」
 * ⇒ 路径即 Dijkstra 的前驱链。不可达（或超出 `maxMp`）返回 null。
 */
export function supplyPath(
  facts: TraceSupplyFacts,
  input: { from: HexRef; to: HexRef; side: Side; mobility: SupplyMobility; maxMp?: number },
): HexRef[] | null {
  const maxMp = input.maxMp ?? Number.POSITIVE_INFINITY
  if (!facts.onMap(input.from) || !facts.onMap(input.to)) return null
  const fromKey = hexKey(input.from)
  const toKey = hexKey(input.to)
  if (fromKey === toKey) return [input.from]

  const { best, prev } = runDijkstra(facts, {
    from: input.from,
    side: input.side,
    mobility: input.mobility,
    maxMp,
    stopAt: new Set([toKey]),
  })
  const mp = best.get(toKey)
  if (mp === undefined || mp > maxMp) return null

  const path: HexRef[] = [input.to]
  let cursor = toKey
  while (cursor !== fromKey) {
    const parent = prev.get(cursor)
    if (parent === undefined) return null
    path.push(hexFromKey(parent))
    cursor = parent
  }
  return path.reverse()
}

/**
 * 12.3a / 12.3c：能否**直接拖取**（Direct Draw）
 *
 * 「单位须在补给站的 **5 MP** 内，或单位在补给站的相邻格内（12.3c）」——二者满足其一即可。
 * 这是纯数值判定；要按地图算距离请用 `canDrawFromDump`。
 */
export function canDirectDraw(input: {
  distanceMp: number
  adjacentToDump?: boolean
}): SupplyVerdict {
  if (input.distanceMp <= DIRECT_DRAW_RANGE_MP)
    return {
      ok: true,
      rule: '12.3a',
      detail: `${input.distanceMp} MP ≤ ${DIRECT_DRAW_RANGE_MP} MP`,
    }
  if (input.adjacentToDump === true)
    return { ok: true, rule: '12.3c', detail: '与补给站相邻即足够' }
  return {
    ok: false,
    rule: '12.3a',
    reason: 'directDrawOutOfRange',
    detail: `${input.distanceMp} MP > ${DIRECT_DRAW_RANGE_MP} MP，且不与 dump 相邻`,
  }
}

/**
 * 12.3a + 12.3c：该格**逐个** dump 的直接拖取结论（含距离、路径与「相邻即可」）
 *
 *   - 距离从 **dump 格**出发，终点取「该格或其任一相邻格」（12.3c），无上限地算（供界面显示真实距离）；
 *   - 可用判据 = `canDirectDraw`：`≤ 5 MP`（12.3a）**或**「该格与 dump 相邻」（12.3c，
 *     此时不论地形、哪怕中间是禁入地形）；
 *   - 计数机动类型：**始终用轮式 MP**（12.3a）；`mobility` 仅在 12.3a 的例外情形下传入——
 *     「对于投递距离为步行或履带的**指挥部**，则使用对应的移动类型」（即 `hq.throwMobility`）。
 *
 * 12.3b 的「HQ 先按 12.3a 从补给站拖取 SP」也走本函数（把 `hex` 换成 HQ 所在格）。
 */
export interface DrawableDump {
  hex: HexRef
  /** 到「该格或其相邻格」的最省消耗（MP）；不可达为 null */
  distanceMp: number | null
  /** 12.3d：最省路径（含起终点）；不可达为 null */
  path: HexRef[] | null
  /** 12.3c：是否靠「相邻即可」成立（终点为该格的相邻格而非其自身） */
  viaAdjacency: boolean
  ok: boolean
  rule: string
  /** 不通过时的原因码 */
  reason?: string
  detail: string
}

export function drawableDumpsFor(
  facts: TraceSupplyFacts,
  input: { hex: HexRef; side: Side; mobility?: SupplyMobility },
): DrawableDump[] {
  const mobility = input.mobility ?? 'truck'
  const targets = selfAndNeighbors(input.hex)
  return facts.dumpsFor(input.side).map((dump) => {
    // 有界搜索（12.3a 的 5 MP）：只展开够得着的区域，避免整图 Dijkstra 拖慢界面
    const distance = countSupplyDistanceToAny(facts, {
      from: dump,
      targets,
      side: input.side,
      mobility,
      maxMp: DIRECT_DRAW_RANGE_MP,
    })
    // 12.3c：补给够到该格的相邻格即可——dump 自身就在相邻格（或同格）时，地形一概不论
    const adjacent = areAdjacent(dump, input.hex) || sameHex(dump, input.hex)
    const verdict = canDirectDraw({
      distanceMp: distance.ok ? distance.mp : Number.POSITIVE_INFINITY,
      adjacentToDump: adjacent,
    })
    const endpoint = distance.ok ? nearestTarget(facts, dump, targets, input.side, mobility) : null
    return {
      hex: dump,
      distanceMp: distance.ok ? distance.mp : null,
      path:
        endpoint === null
          ? null
          : supplyPath(facts, {
              from: dump,
              to: endpoint,
              side: input.side,
              mobility,
              maxMp: DIRECT_DRAW_RANGE_MP,
            }),
      // 12.3c：路径终点若是该格的相邻格（而非其自身），即为「相邻即可」成立
      viaAdjacency:
        endpoint === null ? adjacent && !sameHex(dump, input.hex) : !sameHex(endpoint, input.hex),
      ok: verdict.ok,
      rule: verdict.rule,
      ...(verdict.ok ? {} : { reason: verdict.reason }),
      detail: verdict.ok
        ? `可直接拖取（${verdict.rule}）：${verdict.detail ?? ''}`
        : `过远（${verdict.rule}）：${verdict.detail ?? verdict.reason}`,
    }
  })
}

/** 取「该格或其相邻格」中距 `from` 最近的那个（与 `countSupplyDistanceToAny` 的最短口径一致） */
function nearestTarget(
  facts: TraceSupplyFacts,
  from: HexRef,
  targets: readonly HexRef[],
  side: Side,
  mobility: SupplyMobility,
): HexRef | null {
  let best: { hex: HexRef; mp: number } | null = null
  for (const target of targets) {
    const distance = countSupplyDistance(facts, {
      from,
      to: target,
      side,
      mobility,
      maxMp: DIRECT_DRAW_RANGE_MP,
    })
    if (!distance.ok) continue
    if (best === null || distance.mp < best.mp) best = { hex: target, mp: distance.mp }
  }
  return best?.hex ?? null
}

/**
 * 12.3a + 12.3c：该格能否从该方 dump 直接拖取（`drawableDumpsFor` 的聚合结论）
 *
 * 逐 dump 判据见 `drawableDumpsFor`；本函数只回答「有没有任何一个 dump 够得着」。
 */
export function canDrawFromDump(
  facts: TraceSupplyFacts,
  input: { hex: HexRef; side: Side; mobility?: SupplyMobility },
): SupplyVerdict {
  if (facts.dumpsFor(input.side).length === 0) return { ok: false, rule: '12.3a', reason: 'noDump' }
  const drawable = drawableDumpsFor(facts, input).filter((dump) => dump.ok)
  if (drawable.length === 0) return { ok: false, rule: '12.3a', reason: 'directDrawOutOfRange' }
  const best = drawable.reduce((a, b) =>
    (a.distanceMp ?? Number.POSITIVE_INFINITY) <= (b.distanceMp ?? Number.POSITIVE_INFINITY)
      ? a
      : b,
  )
  return {
    ok: true,
    rule: best.rule,
    detail: best.distanceMp === null ? '相邻即足够（12.3c）' : `${best.distanceMp} MP`,
  }
}

/**
 * 12.3b：能否由 HQ 投递（Throwing Via HQ）——纯数值判定
 *
 * @param distanceMp 从 HQ 到**目标单位或目标相邻格**的消耗（12.3c，由 `countSupplyDistanceToAny` 算出）
 */
export function canThrowViaHQ(input: {
  hqMode: BaseMode
  distanceMp: number
  throwRangeMp: number
  /** 该 HQ 自身是否由别的 HQ 投递获得补给（12.3b-D：不可转投） */
  receivedByThrow?: boolean
}): SupplyVerdict {
  if (input.hqMode === 'strat') return { ok: false, rule: '12.3b-C', reason: 'stratHqCannotThrow' }
  if (input.receivedByThrow === true)
    return { ok: false, rule: '12.3b-D', reason: 'hqCannotReThrow' }
  if (input.distanceMp > input.throwRangeMp)
    return {
      ok: false,
      rule: '12.3b',
      reason: 'outOfThrowRange',
      detail: `${input.distanceMp} MP > 投递距离 ${input.throwRangeMp} MP`,
    }
  return { ok: true, rule: '12.3b' }
}

/* ────────────────────────────── 12.6 追溯补给 ────────────────────────────── */

/** 12.0：该单位是否需要追溯补给（只有战斗单位需要） */
export function requiresTraceSupply(unit: { isCombat: boolean }): boolean {
  return unit.isCombat
}

/** 该源格本身是否可用（12.6b：源格内有未抵消敌方 ZOC ⇒ 不可用；12.3d：敌战斗单位占格亦然） */
function sourceUsable(facts: TraceSupplyFacts, side: Side, hex: HexRef): boolean {
  if (!facts.onMap(hex)) return false
  if (facts.hasEnemyCombatUnit(hex, side)) return false
  return !facts.inEnemyZoc(hex, side)
}

/**
 * 12.7b：延补队的距离＝其**印值 MA**（单位 MP）
 *
 * 延补队印在 5 点运输点算子的背面（12.7），其距离就是该算子印的 MA：
 * 本作**卡车延补队为 20 点轮式 MP**（`su-extender-truck` / `ax-extender-truck`，MA 20、truck）、
 * **马车延补队为 10 点**（`*-extender-wagon`，MA 10、leg）——取自单位库，不另造数字。
 */
export function extenderRangeMpOf(unit: { ma: number }): number {
  if (!Number.isFinite(unit.ma) || unit.ma < 0)
    throw new RangeError(`[extender] 印值 MA 非法：${unit.ma}`)
  return unit.ma
}

/**
 * 12.7g：延补队回连时同样适用「相邻即可」（12.3c）
 *
 * 「与所有其他与补给有关的功能相同，延补队可使用『相邻即可』规则」⇒ 从被连接格（补给源 /
 * 火车卸货格 / 已可用延补队）出发，能在延补队距离内到达**延补队格或其任一相邻格**即算连上。
 */
function connectsBack(
  facts: TraceSupplyFacts,
  side: Side,
  extender: { hex: HexRef; mobility: SupplyMobility; rangeMp: number },
  target: HexRef,
): boolean {
  return countSupplyDistanceToAny(facts, {
    from: target,
    targets: selfAndNeighbors(extender.hex),
    side,
    mobility: extender.mobility,
    maxMp: extender.rangeMp,
  }).ok
}

/**
 * 12.7 / 12.7c：该方可用的延补队
 *
 * 延补队只提供**新的 trace 取用点**（12.7a），其自身必须回连到「基础补给源」或**已可用的延补队**
 * （12.7a-A / 12.7c 的锁链），回连距离按其自身距离（12.7b）与机动类型计，且适用 12.7g 的「相邻即可」。
 * 迭代至不动点：每轮把能回连到已知可用点的延补队并入，直到不再增加。
 */
function usableExtenders(
  facts: TraceSupplyFacts,
  side: Side,
): { hex: HexRef; mobility: SupplyMobility; rangeMp: number }[] {
  const all = facts.extendersFor(side)
  const usable: { hex: HexRef; mobility: SupplyMobility; rangeMp: number }[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const extender of all) {
      if (usable.some((item) => sameHex(item.hex, extender.hex))) continue
      if (!sourceUsable(facts, side, extender.hex)) continue
      const targets: HexRef[] = [
        ...facts
          .sourcesFor(side)
          .filter((s) => sourceUsable(facts, side, s.hex))
          .map((s) => s.hex),
        ...usable.map((item) => item.hex),
      ]
      const connected = targets.some((target) => connectsBack(facts, side, extender, target))
      if (connected) {
        usable.push(extender)
        changed = true
      }
    }
  }
  return usable
}

/** 从起点出发的**无界**可达集合（12.6：trace 只看连通性，无距离上限） */
function reachableFrom(
  facts: TraceSupplyFacts,
  side: Side,
  mobility: SupplyMobility,
  start: HexRef,
): Set<string> {
  return floodFrom(facts, side, mobility, [start])
}

/**
 * 从**多个起点**出发的无界洪泛（12.6 的连通性连通分量）
 *
 * 与 `reachableFrom` 同一套判据（`stepMp`），只是起点可以是整批源——
 * 这样「该格能否连到某源」变成**一次洪泛**而不是每个查询各洪泛一遍。
 */
function floodFrom(
  facts: TraceSupplyFacts,
  side: Side,
  mobility: SupplyMobility,
  starts: readonly HexRef[],
): Set<string> {
  const seen = new Set<string>()
  const queue: HexRef[] = []
  for (const start of starts) {
    if (!facts.onMap(start)) continue
    const key = hexKey(start)
    if (seen.has(key)) continue
    seen.add(key)
    queue.push(start)
  }
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const direction of HEX_DIRECTIONS) {
      const next = neighbor(current, direction)
      const key = hexKey(next)
      if (seen.has(key)) continue
      if (stepMp(facts, side, mobility, current, next) === null) continue
      seen.add(key)
      queue.push(next)
    }
  }
  return seen
}

/**
 * **反向**洪泛：求出「能沿**正向**走到起点集合」的全部格
 *
 * ★ 为什么不能用正向洪泛：`supplyStepCost` 的取费取决于**被进入格**的地形与判据，
 *   故该连通性**有方向**——例如轮式「从沼泽沿非道路离开」合法，而「从开阔进入沼泽」被禁入
 *   （与 6.1d 的互逆性是同一族问题：进入与被进入的成本不对称）。
 *   逐格查询 `hasTraceSupply` 走的是「**单位 → 源**」的正向路径（12.6），
 *   故覆盖集必须沿**反向边**洪泛（判 `next → current` 是否可走）才能与它等价——
 *   正向洪泛会漏掉那类"出得来、进不去"的格（真实地图上实测 9 格）。
 */
function floodIncoming(
  facts: TraceSupplyFacts,
  side: Side,
  mobility: SupplyMobility,
  starts: readonly HexRef[],
): Set<string> {
  const seen = new Set<string>()
  const queue: HexRef[] = []
  for (const start of starts) {
    if (!facts.onMap(start)) continue
    const key = hexKey(start)
    if (seen.has(key)) continue
    seen.add(key)
    queue.push(start)
  }
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const direction of HEX_DIRECTIONS) {
      const next = neighbor(current, direction)
      // ★ 图内判定必须在这里补：正查走的是 `stepMp(next, current)`，其 `onMap` 只看 `to`（＝current），
      //   故反向洪泛若不自己判，会把图外格（如奇数列的第 0 行、西北削角）也算进覆盖集。
      if (!facts.onMap(next)) continue
      const key = hexKey(next)
      if (seen.has(key)) continue
      // 反向边：`next → current` 可走 ⇒ next 能沿正向走到 current，进而走到源
      if (stepMp(facts, side, mobility, next, current) === null) continue
      seen.add(key)
      queue.push(next)
    }
  }
  return seen
}

/**
 * 12.7b / 12.7g：延补队能否**回连**到某个已连接的格（距离以 **MP** 计，含「相邻即可」）
 *
 * ★ 这是 12.7b 拖取距离的**唯一实现**。铁路补给线（`rail-supply`）必须调用本函数，
 *   而**不得**自持 `hexDistance ≤ rangeMp` 那套**格数**口径——同一条规则两种口径时，
 *   在地形成本 > 1 MP/格（山地、沼泽、河）的地方会给出**相反**的结论。
 */
export function extenderConnectsBack(
  facts: TraceSupplyFacts,
  input: {
    extenderHex: HexRef
    /** 被连接的格（补给源 / 火车卸货格 / 已可用的延补队） */
    hex: HexRef
    side: Side
    mobility: SupplyMobility
    /** 12.7b：延补队距离＝其印值 MA（MP） */
    rangeMp: number
  },
): boolean {
  return connectsBack(
    facts,
    input.side,
    { hex: input.extenderHex, mobility: input.mobility, rangeMp: input.rangeMp },
    input.hex,
  )
}

/**
 * 12.6：该方**有追溯补给的格集合**（一次算好，之后每格 O(1) 成员判定）
 *
 * ## 为什么需要它
 * 「该格能否连到补给源」是**连通性**问题（12.6 只看连通性、无距离上限），而
 * `traceSourcesFor` 是**逐格**查询：每个格都要洪泛一遍全图。9.14d 的崩溃候选约 1200 格
 * ⇒ 1200 次全图洪泛，实测 5 秒以上（与"45 MA 的移动范围一点就出"的差别就在这个方向）。
 * 本函数把方向反转：从**全部源**出发一次洪泛即得整张集合。
 *
 * ## 与原逐格查询的等价性（★ 必须用**反向边**洪泛）
 * `baseSourcesFor` 的判据是 `reachableFrom(hex).has(source.hex)`，即「hex 沿**正向**能走到某源」。
 * ★ 而 `supplyStepCost` 的取费取决于**被进入格**的地形与判据，故该连通性**有方向**：
 *   轮式「从沼泽沿非道路离开」合法，却「从开阔进入沼泽」被禁入（与 6.1d 互逆性同族的问题）。
 *   所以覆盖集必须用 `floodIncoming`（判 `next → current` 可走）在**反向边**上洪泛，
 *   不能用正向洪泛——否则会漏掉那类"出得来、进不去"的格（真实地图上实测 9 格）。
 * 机动类型影响判据（12.3d：轮式受未抵消敌 ZOC 阻挡），故按 `(side, mobility)` 各算一份。
 * **测试须逐格断言本集合与 `hasTraceSupply` 结论一致**——那是防止两套口径漂移的闸门。
 *
 * ## 与逐格查询的一致性由测试把关
 * 逐格查询会把**起点无条件计入**（`reachableFrom` 先 seed 起点），反向洪泛则要求"存在一条能走到源的
 * 正向路径"。两者在「该格本身有敌方战斗单位」时也**一致**（那种格的单位走不出去，但按上述 seed 语义
 * 逐格查询同样报"有补给"；实战中该格不可能有己方单位，故无害）——
 * 该结论由 `trace-supply.test.ts` 的等价性用例（含敌占格变体）直接断言，不靠推理。
 *
 * ## 覆盖两类源
 *   - **基础源 ①②③ + 已连上的延补队（12.7）**：`floodIncoming`（源集合与 `baseSourcesFor` 同口径）；
 *   - **12.3b 的 HQ 投递**：每个 HQ 一次**有界**搜索（预算＝其印值投递距离、机动类型按投递颜色），
 *     并按 **12.3c**「单位格**或其相邻格**」把该区域**膨胀一格**。
 *     （投递方向是「HQ → 单位」，与逐格查询同向，故直接用正向区域。）
 */
export function traceCoverageHexes(
  facts: TraceSupplyFacts,
  input: { side: Side; mobility: SupplyMobility },
): Set<string> {
  const { side, mobility } = input
  const origins: HexRef[] = [
    ...facts
      .sourcesFor(side)
      .filter((source) => sourceUsable(facts, side, source.hex))
      .map((source) => source.hex),
    // 12.7：已连上的延补队本身即「可用的基础源」（与 baseSourcesFor 同口径）
    ...usableExtenders(facts, side).map((extender) => extender.hex),
  ]
  const covered = floodIncoming(facts, side, mobility, origins)

  // 12.3b + 12.3c：HQ 投递覆盖（含「相邻即可」）
  for (const hq of facts.throwHqsFor(side)) {
    if (!hqCanThrow(facts, hq)) continue
    const region = supplyReachableHexes(facts, {
      from: hq.hex,
      side,
      mobility: hq.throwMobility,
      maxMp: hq.throwRangeMp,
    })
    for (const item of region) {
      covered.add(hexKey(item.hex))
      // 12.3c「单位格**或其相邻格**」；相邻格同样只取图内（与逐格查询的 onMap 前置一致）
      for (const direction of HEX_DIRECTIONS) {
        const neighbour = neighbor(item.hex, direction)
        if (facts.onMap(neighbour)) covered.add(hexKey(neighbour))
      }
    }
  }
  return covered
}

/** 12.6a①②③：该格可达的**基础**补给源（不含 HQ 投递） */
function baseSourcesFor(
  facts: TraceSupplyFacts,
  input: { hex: HexRef; side: Side; mobility: SupplyMobility },
): { hex: HexRef; kind: BaseSourceKind }[] {
  const { hex, side, mobility } = input
  const reachable = reachableFrom(facts, side, mobility, hex)
  const found: { hex: HexRef; kind: BaseSourceKind }[] = []
  for (const source of facts.sourcesFor(side)) {
    if (!sourceUsable(facts, side, source.hex)) continue
    if (!reachable.has(hexKey(source.hex))) continue
    found.push({ hex: source.hex, kind: source.kind })
  }
  for (const extender of usableExtenders(facts, side)) {
    if (!reachable.has(hexKey(extender.hex))) continue
    found.push({ hex: extender.hex, kind: 'extender' })
  }
  return found
}

/**
 * 12.3b：该 HQ 是否有资格投递追溯补给
 *
 * 「能够从补给站拖取 SP 的指挥部（根据 12.3a）」⇒ HQ 自身须能**直接拖取 dump**；
 * 或按 12.6 的分配机制，HQ 自身已有追溯补给（此时它相当于一个「可当火车卸货格用」的节点）。
 * 12.3b-C/D 的两条禁令在此先判。
 */
function hqCanThrow(facts: TraceSupplyFacts, hq: ThrowHqView): boolean {
  if (hq.mode === 'strat') return false
  if (hq.receivedByThrow === true) return false
  if (canDrawFromDump(facts, { hex: hq.hex, side: hq.side, mobility: hq.throwMobility }).ok)
    return true
  return baseSourcesFor(facts, { hex: hq.hex, side: hq.side, mobility: hq.mobility }).length > 0
}

/**
 * 12.6a：该方在该格能连到的**全部**补给源（基础源 ①②③ + 12.3b 的 HQ 投递）
 *
 * 结果按 `kind → 列 → 行` 升序（确定性）。空数组即「无追溯补给」。
 */
export function traceSourcesFor(
  facts: TraceSupplyFacts,
  input: { hex: HexRef; side: Side; mobility: SupplyMobility },
): { hex: HexRef; kind: TraceSourceKind }[] {
  const { hex, side } = input
  if (!facts.onMap(hex)) return []

  const found: { hex: HexRef; kind: TraceSourceKind }[] = baseSourcesFor(facts, input)
  // 12.3b：HQ 投递——终点取「单位格或其相邻格」（12.3c），距离用投递距离颜色所示机动类型
  const targets = selfAndNeighbors(hex)
  for (const hq of facts.throwHqsFor(side)) {
    if (!hqCanThrow(facts, hq)) continue
    const distance = countSupplyDistanceToAny(facts, {
      from: hq.hex,
      targets,
      side,
      mobility: hq.throwMobility,
      maxMp: hq.throwRangeMp,
    })
    if (distance.ok) found.push({ hex: hq.hex, kind: 'hqThrow' })
  }
  return found.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.hex.col - b.hex.col || a.hex.row - b.hex.row,
  )
}

/** 12.6：该方在该格是否有追溯补给（含失败原因） */
export function hasTraceSupply(
  facts: TraceSupplyFacts,
  input: { hex: HexRef; side: Side; mobility: SupplyMobility },
): TraceVerdict {
  if (!facts.onMap(input.hex)) return { ok: false, rule: '12.6', reason: 'offMap' }
  const first = traceSourcesFor(facts, input)[0]
  if (first !== undefined) return { ok: true, rule: '12.6a', source: first }
  // 区分「根本无源」与「有源但源格被敌方 ZOC/战斗单位占住」（12.6b）
  const blocked = [...facts.sourcesFor(input.side), ...facts.extendersFor(input.side)].some(
    (item) => !sourceUsable(facts, input.side, item.hex),
  )
  return {
    ok: false,
    rule: blocked ? '12.6b' : '12.6a',
    reason: blocked ? 'sourceBlocked' : 'noSource',
  }
}

/* ────────────────────────────── 12.6c 图上补给 ────────────────────────────── */

/**
 * 12.6c：吃图上补给的 T 数
 *
 * 「每消耗 1T，就可以为最多 2RE 的战斗单位提供追溯补给……所有小数向上取整；
 *   例如，6.5 的 RE 需消耗 4T。」
 */
export function eatingOffTheMapCostT(totalRe: number): number {
  if (totalRe <= 0) return 0
  return Math.ceil(totalRe / TRACE_RE_PER_T) * TRACE_T_PER_TWO_RE
}

/**
 * 12.6c：能否吃图上补给
 *
 * 前提是「单位在补给站的**拖取或投递**距离内」——拖取即 12.3a 的 5 MP（含 12.3c）；
 * 投递即某个有资格的 HQ（12.3b）在投递距离内。
 * 注意 12.6e：**战略模式单位不允许吃图上补给**，故 `unitMode` 为 `strat` 时直接否决。
 * 另注意 12.6c 的游戏说明：**永不强迫**单位吃图上补给，故本函数只回答「可否」。
 */
export function canEatOffTheMap(
  facts: TraceSupplyFacts,
  input: {
    hex: HexRef
    side: Side
    mobility: SupplyMobility
    /** 单位自身的模式（12.6e：战略模式不允许吃图上补给） */
    unitMode?: BaseMode
    /** 调用方已判定的投递可达性（可选，用于外部已解析的 HQ 情形） */
    thrownByHq?: boolean
  },
): SupplyVerdict {
  if (input.unitMode === 'strat')
    return { ok: false, rule: '12.6e', reason: 'stratCannotEatOffTheMap' }
  if (canDrawFromDump(facts, { hex: input.hex, side: input.side, mobility: input.mobility }).ok)
    return { ok: true, rule: '12.3a' }
  if (input.thrownByHq === true) return { ok: true, rule: '12.3b' }
  const targets = selfAndNeighbors(input.hex)
  for (const hq of facts.throwHqsFor(input.side)) {
    if (!hqCanThrow(facts, hq)) continue
    // 投递 SP 的 HQ 必须自己能从 dump 拖取（12.3b 前置：能够从补给站拖取 SP 的指挥部）
    if (!canDrawFromDump(facts, { hex: hq.hex, side: input.side, mobility: hq.throwMobility }).ok)
      continue
    const distance = countSupplyDistanceToAny(facts, {
      from: hq.hex,
      targets,
      side: input.side,
      mobility: hq.throwMobility,
      maxMp: hq.throwRangeMp,
    })
    if (distance.ok) return { ok: true, rule: '12.3b' }
  }
  return { ok: false, rule: '12.6c', reason: 'outOfSupplyRange' }
}

/* ────────────────────────────── 12.7 延补队生成 ────────────────────────────── */

/*
 * 12.7d：「生成时须与补给来源相连」这一条在下面（`canCreateExtenderAt`）；
 * **生成代价与两条禁令**（5 点同型、消耗一半 MA、编内卡车不可组建、装载者先卸载）的判据
 * **只有一处**：`extender.ts` 的 `canConvertTransportToExtender` + `planConvertTransportToExtender`
 * （两者共用 `convertibleOf` 的装载者滤除口径）。本模块原先另有一个 `extenderCreationCost`
 * （只能吃"一个聚合点数"、没有算子级信息）——同一件事的第二套实现 ⇒
 * 2026-09-18（批 F 切片 4②）**删除并收敛到上面那份**，见 §17.112。
 */

/**
 * 12.7d：能否在该格生成延补队
 *
 * 「延补队在生成时，如果此时它所在格无法与一个追溯补给的补给来源格相连，
 *   则不能在该格内生成延补队」⇒ 生成格必须能连到基础源（12.6a①②）或**已可用**的延补队。
 */
export function canCreateExtenderAt(
  facts: TraceSupplyFacts,
  input: { hex: HexRef; side: Side; mobility: SupplyMobility },
): SupplyVerdict {
  if (!facts.onMap(input.hex)) return { ok: false, rule: '12.7d', reason: 'offMap' }
  if (!sourceUsable(facts, input.side, input.hex))
    return { ok: false, rule: '12.7d', reason: 'hexInEnemyZoc' }
  const connected =
    baseSourcesFor(facts, { hex: input.hex, side: input.side, mobility: input.mobility }).length > 0
  if (!connected) return { ok: false, rule: '12.7d', reason: 'notConnectedToSource' }
  return { ok: true, rule: '12.7d' }
}

/* ────────────────────────────── 12.6f 编队同源 ────────────────────────────── */

/** 编队同源取舍结果 */
export interface FormationTraceResult {
  rule: string
  /** 全体同源时的该来源；不同源时为「覆盖最多」的那个来源（供玩家取舍） */
  commonSource: { hex: HexRef; kind: TraceSourceKind } | null
  /** 与该来源一致的编队单位（编队法可「免费」覆盖） */
  coveredUnitIds: string[]
  /** 不一致者：须吃图上补给，否则断补（12.6d） */
  uncoveredUnitIds: string[]
  /** 是否全体 trace 到同一来源（12.6f 的要求） */
  sameSource: boolean
}

/**
 * 12.6f：多单位编队取补的同源取舍
 *
 * 「多单位编队中的所有战斗单位需要追溯补给线到**同一个**指挥部，或直接拖取**同一个**补给来源。
 *   如果无法做到这一点，则应选择该编队中的一部分单位进行『免费』的追溯补给，
 *   而编队中其他单位则必须使用图上补给，不然其他单位就会断补。」
 * 故本函数给出：以「覆盖最多」的来源为共同来源时，哪些单位被覆盖、哪些须另行处理。
 * 平局按 `kind → 列 → 行` 取最小者（确定性）。
 */
export function formationTraceTradeoff(
  facts: TraceSupplyFacts,
  input: {
    side: Side
    mobility: SupplyMobility
    units: readonly { id: string; hex: HexRef | null }[]
  },
): FormationTraceResult {
  const { side, mobility } = input
  const perUnit = input.units.map((unit) => ({
    id: unit.id,
    sources: unit.hex === null ? [] : traceSourcesFor(facts, { hex: unit.hex, side, mobility }),
  }))

  const counts = new Map<string, { hex: HexRef; kind: TraceSourceKind; ids: string[] }>()
  for (const unit of perUnit) {
    for (const source of unit.sources) {
      const key = `${source.kind}|${hexKey(source.hex)}`
      const entry = counts.get(key)
      if (entry === undefined) counts.set(key, { ...source, ids: [unit.id] })
      else entry.ids.push(unit.id)
    }
  }

  const ranked = [...counts.values()].sort(
    (a, b) =>
      b.ids.length - a.ids.length ||
      a.kind.localeCompare(b.kind) ||
      a.hex.col - b.hex.col ||
      a.hex.row - b.hex.row,
  )
  const best = ranked[0] ?? null
  const coveredUnitIds = best?.ids ?? []
  const uncoveredUnitIds = perUnit
    .map((unit) => unit.id)
    .filter((id) => !coveredUnitIds.includes(id))

  return {
    rule: '12.6f',
    commonSource: best === null ? null : { hex: best.hex, kind: best.kind },
    coveredUnitIds,
    uncoveredUnitIds,
    sameSource: coveredUnitIds.length === perUnit.length && perUnit.length > 0,
  }
}

/* ────────────────────────────── 12.6d/12.8a 断补标记与解除 ────────────────────────────── */

/** 单个单位的补给评估 */
export interface UnitSupplyAssessment {
  unitId: string
  /** 12.0：是否需要追溯补给（只有战斗单位需要） */
  required: boolean
  /** 3.2：该单位的团级当量（12.6c 的批量费率按 RE 合计取整，故结论里带上它） */
  re: number
  trace: TraceVerdict
  /** 12.6c：trace 失败时能否改吃图上补给 */
  canEatOffTheMap: boolean
  /** 12.6c：吃图上补给所需的 T（给了 `alreadyFedRe` 时是**本次增量**） */
  eatingCostT: number
  status: 'inSupply' | 'canEatOffTheMap' | 'outOfSupply' | 'notRequired'
  rule: string
}

/**
 * 评估单个单位的补给状态（12.6 / 12.6c / 12.6e）
 *
 * 顺序：是否需 trace（战斗单位）→ 12.6 追溯 → 失败则看 12.6c 的吃图上补给退路 → 否则断补。
 */
export function assessUnitSupply(
  facts: TraceSupplyFacts,
  unit: {
    id: string
    side: Side
    hex: HexRef | null
    isCombat: boolean
    re: number
    /** 单位自身模式（12.6e：战略模式不允许吃图上补给） */
    mode?: BaseMode
  },
  input: {
    mobility: SupplyMobility
    thrownByHq?: boolean
    /**
     * 12.6c：本环节**已从同一补给站喂过的 RE 总量**
     *
     * 条文「每消耗 1T，就可以为最多 2RE ……提供追溯补给；所有小数向上取整；
     * 例如，**6.5 的 RE 需消耗 4T**」——例中的 6.5 RE 只能是**一批单位合计**，
     * 故取整作用在批次总量上，不能逐单位各取整再相加。
     * 传本字段后，`eatingCostT` 给出的是**本次这一单位应付的增量**：
     *   `ceil((已喂 + 本单位 RE)/2) − ceil(已喂/2)`
     * 累计应付恰等于批量口径（逐单位相加 = 一次性批量）。
     */
    alreadyFedRe?: number
  },
): UnitSupplyAssessment {
  if (!requiresTraceSupply(unit))
    return {
      unitId: unit.id,
      required: false,
      re: unit.re,
      trace: { ok: false, rule: '12.0', reason: 'noSource' },
      canEatOffTheMap: false,
      eatingCostT: 0,
      status: 'notRequired',
      rule: '12.0',
    }

  const trace: TraceVerdict =
    unit.hex === null
      ? { ok: false, rule: '12.6', reason: 'offMap' }
      : hasTraceSupply(facts, { hex: unit.hex, side: unit.side, mobility: input.mobility })
  const eat =
    trace.ok || unit.hex === null
      ? { ok: false as const, rule: '12.6c', reason: 'alreadyTraced' }
      : canEatOffTheMap(facts, {
          hex: unit.hex,
          side: unit.side,
          mobility: input.mobility,
          ...(unit.mode === undefined ? {} : { unitMode: unit.mode }),
          ...(input.thrownByHq === undefined ? {} : { thrownByHq: input.thrownByHq }),
        })

  const status: UnitSupplyAssessment['status'] = trace.ok
    ? 'inSupply'
    : eat.ok
      ? 'canEatOffTheMap'
      : 'outOfSupply'
  return {
    unitId: unit.id,
    required: true,
    re: unit.re,
    trace,
    canEatOffTheMap: eat.ok,
    /*
     * 12.6c：取整作用在**批次 RE 总量**上，故成本取**增量**
     * （`已喂` 缺省 0 ⇒ 与旧行为一致：单个单位即整批）。
     */
    eatingCostT:
      eatingOffTheMapCostT((input.alreadyFedRe ?? 0) + unit.re) -
      eatingOffTheMapCostT(input.alreadyFedRe ?? 0),
    status,
    rule: trace.ok ? '12.6a' : eat.ok ? '12.6c' : '12.6d',
  }
}

/** 断补标记计划（12.6d 置标、12.8a/12.10 解除） */
export interface OutOfSupplyPlan {
  rule: string
  /** 需新置断补标记的单位实例 id（12.6d） */
  mark: string[]
  /** 需移除断补标记的单位实例 id（12.8a：下一个友方补给阶段重新判定为有追溯补给） */
  clear: string[]
}

/**
 * 12.6d / 12.8a：断补标记的放置与解除
 *
 * 「无法『获得追溯补给』或『吃图上补给』的友方堆叠会被标记为断补……在下一个友方补给阶段
 *   重新判定为拥有追溯补给之前，要一直保留断补标记。」
 * 吃图上补给是**可选**的（12.6c 游戏说明：永不强迫），故由 `eatOffTheMap(unitId)`（玩家决定）
 * 决定是否以吃代断；非战斗单位不参与本判定（12.0）。
 */
export function planOutOfSupply(input: {
  assessments: readonly UnitSupplyAssessment[]
  /** 当前已带断补标记的单位实例 id */
  alreadyOutOfSupply: readonly string[]
  /** 玩家选择：该单位本回合是否吃图上补给（缺省＝不吃） */
  eatOffTheMap?: (unitId: string) => boolean
}): OutOfSupplyPlan {
  const mark: string[] = []
  const clear: string[] = []
  for (const assessment of input.assessments) {
    if (!assessment.required) continue
    const wasMarked = input.alreadyOutOfSupply.includes(assessment.unitId)
    const fed = assessment.canEatOffTheMap && (input.eatOffTheMap?.(assessment.unitId) ?? false)
    if (assessment.status === 'inSupply' || fed) {
      if (wasMarked) clear.push(assessment.unitId)
      continue
    }
    if (!wasMarked) mark.push(assessment.unitId)
  }
  return { rule: '12.6d', mark, clear }
}

/* ────────────────────────────── 5.8b 桥接（供 MoveContext.traceSupplyAt） ────────────────────────────── */

/**
 * 覆盖集的**成员判定**
 *
 * 键格式由本模块自持（`col.row`），调用方不必知道拼法——避免"两处各拼一次键"的漂移。
 */
export function traceCoverageHas(coverage: ReadonlySet<string>, hex: HexRef): boolean {
  return coverage.has(hexKey(hex))
}

/**
 * 生成 `MoveContext.traceSupplyAt` 回调（5.8b/12.6e：战略模式单位须在有追溯补给的格结束移动）
 *
 * 该钩子只带 `(hex, side)`，不含单位，故机动类型由调用方按方指定
 * （12.3a：计数默认用轮式 MP，故缺省 `truck`）。
 *
 * ★ 实现走 `traceCoverageHexes`（**按方各算一次覆盖集，之后 O(1) 查表**），
 *   而不是逐格调 `hasTraceSupply`：后者每个格都洪泛一遍全图，
 *   在 9.14d 那种"上千候选逐格问"的场景下会到 5 秒级（见 `traceCoverageHexes` 的说明）。
 *   按方缓存，故同一份事实下反复调用只算一次。
 */
export function createTraceSupplyAt(
  facts: TraceSupplyFacts,
  options: { mobilityBySide?: (side: Side) => SupplyMobility } = {},
): (hex: HexRef, side: Side) => boolean {
  const mobilityOf = options.mobilityBySide ?? ((): SupplyMobility => 'truck')
  const coverageBySide = new Map<Side, Set<string>>()
  const coverageOf = (side: Side): Set<string> => {
    let coverage = coverageBySide.get(side)
    if (coverage === undefined) {
      coverage = traceCoverageHexes(facts, { side, mobility: mobilityOf(side) })
      coverageBySide.set(side, coverage)
    }
    return coverage
  }
  return (hex, side) => traceCoverageHas(coverageOf(side), hex)
}
