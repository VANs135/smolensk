import { rulesConstants } from '@/data'
import type { Side } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'
import type { MovementSegmentPhase } from './modes'

/**
 * 延补队（12.7 / 9.14d）——运输点数面 ↔ 延补队面 双向转换
 *
 * 本模块只做**判定与计划**（纯函数）：引擎不写状态，实际换 recordId/翻面由状态层落盘。
 *
 * ## 条文索引（中文规则书 / OCS 12.7 / 9.14d）
 *   - 12.7a  在**移动阶段**（三个移动环节），合计≥5点**同类型**运输点数被移动到同一格后，
 *            可选把其中 5 点转换为对应类型的延补队。**翻面消耗该延补队自身 MA 的一半**
 *            （`rules-constants.supply.extenderCreationMaFraction`，默认 0.5）。
 *            「同类型」＝都为卡车（`transport_kind === 'truck'`）或都为马车/骡子（`'wagon'`）。
 *   - 12.7d  延补队不能移动；玩家可在移动阶段**主动翻面**（消耗一半 MA）变回 5 点运输点数面。
 *            翻面后立即可移动（运输点数面不受 12.7 的禁动约束）。
 *   - 9.14d  被动崩溃：敌方战斗单位进入含己方延补队的格 → 必须崩溃，位移到其**特殊拖取距离**内
 *            且有追溯补给的格（敌方 ZOC / 禁入地形均无影响），并翻面到运输点数面（见 supply-phase.ts）。
 *   - 9.14d 末段：若无合法落点，留在原格翻面并按 9.14c 接受夺取判定。
 *
 * ## 数据前提
 *   - 运输点数（`noncombatKind = 'transport_point'`）：按 `noncombatDetails.transport` 标点数，
 *     `noncombatDetails.transportKind` 标类型（`truck` / `wagon`）；
 *   - 延补队（`noncombatKind = 'supply_extender'`）：按 `classes.movementClass` 区分 truck / wagon，
 *     `factors.combat.ma` 即其 MA（20 = truck，10 = wagon）。
 *   两类算子都是独立 record —— 转换本质是**替换 recordId**（不是翻面标记）。
 *   引擎把「换哪个 record」留给状态层，只产具体的替换计划。
 *
 * ## 运输点数是「点数」而非「算子」（本模块的核心口径）
 *   通用运输点数（`transport_point`，印值 1–5）是**具象化的点数**，玩家可**任意拆分**：
 *   格内 3 点卡车 + 3 点卡车要建 1 个延补队时，**只需 5 点**，剩 1 点仍留在该格
 *   （而不是把两枚算子整吃掉）。故本模块的产出不是「换掉哪几枚算子」而是：
 *     · `consumedPoints` = 5 × 队数（真正的消耗，12.7a 的阈值）；
 *     · `swaps`          = 需要从格内移走的原算子（其点数和 ≥ 消耗，差额即余量）；
 *     · `leftoverPoints` = 余量点数；`leftoverPlacement` = 余量应放回的**面额拆分**。
 *   **编内卡车**（`organic_truck`）不属此列：它是部队建制内的卡车，不能与延补队互转、
 *   也不参与 5 点凑数（5.7f 只给它「可进入预备模式」这一条例外）。
 */

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 12.7a：转换为延补队所需的**运输点数**阈值（默认 5） */
export const EXTENDER_REQUIRED_POINTS = rulesConstants.supply.extenderTransportPoints

/** 12.7a/d：翻面消耗的 MA 分数（默认 0.5，即一半） */
export const EXTENDER_FLIP_MA_FRACTION = rulesConstants.supply.extenderCreationMaFraction

/** 可发生转换/翻面的移动环节（12.7a：移动阶段含三个移动环节） */
export const EXTENDER_SEGMENTS: readonly MovementSegmentPhase[] = [
  'movement',
  'reaction',
  'exploitation',
]

/* ────────────────────────────── 类型 ────────────────────────────── */

/** 运输点数类型（12.7a：同类型判定） */
export type TransportKind = 'truck' | 'wagon'

/** 单枚运输点数算子的聚合输入 */
export interface TransportPointEntry {
  id: string
  kind: TransportKind
  points: number
  /**
   * 12.7d：该算子是否**载有 SP**
   *
   * 「装载的运输点数**不能**切换为延补队（它必须先卸载）。」
   * ⇒ 本模块把它**先滤掉**（不参与凑数），并由 `planConvertTransportToExtender` 明确拒绝，
   *   免得"移走算子"把车上的 SP 一起弄丢。
   */
  loaded?: boolean
}

/**
 * 12.7a / 5.7f：该算子是否算**通用运输点数**（可与延补队互转）
 *
 * 通用运输点数 = `noncombatKind === 'transport_point'`（点数 1–5，**可任意拆分**）。
 * **编内卡车**（`organic_truck`）不算：它是部队建制内的卡车，不能与延补队互转、
 * 也不参与 5 点凑数（5.7f 只给它「可进入预备模式」这一条例外）。
 * 供状态层筛选「哪些算子可以进本模块的 `entries`」。
 */
export function isConvertibleTransportPoint(unit: {
  noncombatKind?: string | null
  transportKind?: string | null
}): boolean {
  return (
    unit.noncombatKind === 'transport_point' &&
    (unit.transportKind === 'truck' || unit.transportKind === 'wagon')
  )
}

/** 延补队算子 record 信息（供状态层查找替换目标） */
export interface ExtenderRecordRef {
  /** 轴心方 truck 延补队的 recordId */
  axisTruckExtenderId: string
  /** 轴心方 wagon 延补队的 recordId */
  axisWagonExtenderId: string
  /** 苏军 truck 延补队的 recordId */
  sovietTruckExtenderId: string
  /** 苏军 wagon 延补队的 recordId */
  sovietWagonExtenderId: string
  /**
   * 延补队翻面后对应的 5 点运输点数 recordId
   *
   * 玩家/剧本初设通常用 ax/su-transport-truck-5 与 wagon-5（5 点），
   * 但引擎**不写死 id** —— 由状态层按 record 搜索「transport_point + transport=5」给入。
   */
  /** truck 5 点运输点的 recordId */
  truckTransportRecordId: string
  /** wagon 5 点运输点的 recordId */
  wagonTransportRecordId: string
}

/* ────────────────────────────── 12.7a 运输点数 → 延补队 ────────────────────────────── */

/** 把一组 transport_point 按类型分组聚合点数 */
export function aggregateTransportPoints(entries: readonly TransportPointEntry[]): {
  truck: number
  wagon: number
} {
  const truck = entries.filter((e) => e.kind === 'truck').reduce((sum, e) => sum + e.points, 0)
  const wagon = entries.filter((e) => e.kind === 'wagon').reduce((sum, e) => sum + e.points, 0)
  return { truck, wagon }
}

/**
 * 12.7a / 12.7d：某型运输点数里**能参与凑数**的点数（装载者除外）与**被挡在门外**的点数
 *
 * 「装载的运输点数**不能**切换为延补队（它**必须先卸载**）」（12.7d）⇒ 装载者**不参与凑数**。
 * `canConvertTransportToExtender`（判"能建几队"）与 `planConvertTransportToExtender`（产替换计划）
 * **共用本函数**：两处若各写一遍，同一格会出现"判定说能建、计划说不够"的自相矛盾。
 */
function convertibleOf(
  entries: readonly TransportPointEntry[],
  kind: TransportKind,
): { points: number; loadedPoints: number } {
  const sameKind = entries.filter((entry) => entry.kind === kind)
  const usable = sameKind.filter((entry) => entry.loaded !== true)
  return {
    points: usable.reduce((sum, entry) => sum + entry.points, 0),
    loadedPoints: sameKind
      .filter((entry) => entry.loaded === true)
      .reduce((sum, entry) => sum + entry.points, 0),
  }
}

/** 转换候选：某格同方运输点数中能凑出几个延补队 */
export interface ConvertOption {
  kind: TransportKind
  /** 能凑出几个延补队（每队 5 点） */
  count: number
  /** 该类型运输点数合计（每换 1 队消耗 5 点，取整到队数×5） */
  totalPoints: number
  /** 剩余点数（换完 count 队后剩的） */
  remainder: number
  /** 12.7a：转换代价 —— 新延补队自身 MA 的一半（每队） */
  costMaPerTeam: number
  rule: '12.7a'
}

/**
 * 12.7a：判定某格某方的运输点数能否转换为延补队
 *
 * 「将运输点数转换为延补队只能在该玩家的**移动阶段**中进行……将合计至少 5 点运输点数
 *   移动到同一格中后，即可将这些运输点数转换为延补队。此操作消耗 **1/2 的 MA**。」
 *
 * @param phase       当前移动环节（三个移动环节可；其他阶段返回 wrongPhase）
 * @param entries     该格当前方的运输点算子（已聚合类型与点数）
 * @param truckMa     truck 类型延补队的 MA（默认 20）
 * @param wagonMa     wagon 类型延补队的 MA（默认 10）
 */
export function canConvertTransportToExtender(input: {
  phase: MovementSegmentPhase
  entries: readonly TransportPointEntry[]
  truckMa?: number
  wagonMa?: number
}): RuleOutcome<{ options: ConvertOption[] }> {
  if (!EXTENDER_SEGMENTS.includes(input.phase)) {
    return fail('12.7a', 'wrongSegment')
  }
  const options: ConvertOption[] = []
  const truckMa = input.truckMa ?? 20
  const wagonMa = input.wagonMa ?? 10
  const threshold = EXTENDER_REQUIRED_POINTS
  // 12.7d：装载中的运输点数**不参与凑数**（必须先卸载）——与 `planConvertTransportToExtender` 同一处口径
  const truck = convertibleOf(input.entries, 'truck')
  const wagon = convertibleOf(input.entries, 'wagon')

  if (truck.points >= threshold) {
    const count = Math.floor(truck.points / threshold)
    options.push({
      kind: 'truck',
      count,
      totalPoints: count * threshold,
      remainder: truck.points - count * threshold,
      costMaPerTeam: truckMa * EXTENDER_FLIP_MA_FRACTION,
      rule: '12.7a',
    })
  }
  if (wagon.points >= threshold) {
    const count = Math.floor(wagon.points / threshold)
    options.push({
      kind: 'wagon',
      count,
      totalPoints: count * threshold,
      remainder: wagon.points - count * threshold,
      costMaPerTeam: wagonMa * EXTENDER_FLIP_MA_FRACTION,
      rule: '12.7a',
    })
  }
  if (options.length === 0) {
    /*
     * 12.7d：装载者**不参与凑数**。若"把它们也算进来就够" ⇒ 报 12.7d，
     * 让玩家知道拦路的是"没卸载"而不是笼统的"点数不够"（与 `planConvertTransportToExtender` 同一口径）。
     */
    const blockedByLoaded = [truck, wagon].some(
      (group) => group.loadedPoints > 0 && group.points + group.loadedPoints >= threshold,
    )
    if (blockedByLoaded) return fail('12.7d', 'loadedMustUnloadFirst')
    return fail('12.7a', 'insufficientPoints')
  }
  return succeed('12.7a', { options })
}

/**
 * 12.7a：产出替换计划 —— 哪组运输点算子要被换掉、余量怎么留（纯函数，状态层负责落盘）
 *
 * 「运输点数是可任意拆分的点数」这一口径见模块头：**只消耗 5 × 队数**，
 * 差额（`leftoverPoints`）由状态层按 `leftoverPlacement` 的面额放回原格。
 * 例：格内 3 + 3 点卡车要建 1 队 ⇒ 移走两枚（6 点）、消耗 5 点、**留 1 点**。
 */
export interface ExtenderSwapIn {
  /** 原运输点算子 id（要被替换掉） */
  transportUnitId: string
  /** 该算子贡献的运输点数 */
  points: number
}
export interface ConvertToExtenderPlan {
  rule: '12.7a'
  kind: TransportKind
  /** 新延补队的 recordId（状态层按 side+kind 查找后传入） */
  newRecordId: string
  /** 本次转换**消耗**的运输点数（恒 = 5 × extenderCount，12.7a 的阈值） */
  consumedPoints: number
  /** 本次转换产出几个延补队（= count） */
  extenderCount: number
  /** 本次转换合计要移走的原运输点算子 */
  swaps: ExtenderSwapIn[]
  /** `swaps` 的点数合计（= consumedPoints + leftoverPoints） */
  removedPoints: number
  /** 12.7a：可任意拆分的点数 ⇒ 减法后余下、**仍留在原格**的点数 */
  leftoverPoints: number
  /** 余量的建议面额拆分（各面额一枚运输点算子；空数组 = 无余量） */
  leftoverPlacement: number[]
  /** 12.7a：本次转换合计消耗的 MA（count × costMaPerTeam） */
  totalCostMa: number
  detail: string
}

export function planConvertTransportToExtender(input: {
  kind: TransportKind
  count: number
  entries: readonly TransportPointEntry[]
  newRecordId: string
  truckMa?: number
  wagonMa?: number
}): RuleOutcome<ConvertToExtenderPlan> {
  if (input.count <= 0) return fail('12.7a', 'countMustBePositive')
  /*
   * 12.7d：「装载的运输点数**不能**切换为延补队（它必须先卸载）。」
   * ⇒ 装载者**先滤掉**（不参与凑数）；口径与 `canConvertTransportToExtender` 共用 `convertibleOf`
   *   （两处各写一遍会出现"判定说能建、计划说不够"的自相矛盾）。
   */
  const need = EXTENDER_REQUIRED_POINTS * input.count
  const group = convertibleOf(input.entries, input.kind)
  const candidates = input.entries.filter((e) => e.kind === input.kind && e.loaded !== true)
  if (group.points < need) {
    // 12.7d：若"把装载者也算进来就够" ⇒ 报 12.7d（拦路的是"没卸载"，不是笼统的"点数不够"）
    if (group.loadedPoints > 0 && group.points + group.loadedPoints >= need)
      return fail('12.7d', 'loadedMustUnloadFirst')
    return fail('12.7a', 'notEnoughPoints')
  }

  // 12.7a：点数可任意拆分 ⇒ 选「点数和最小且 ≥ 消耗量」的那组算子移走，余量最小。
  // （3+3 要 5 点时移走两枚 6 点、留 1 点；而 5+3 要 5 点时只移走那枚 5 点、留 3 点。）
  const swaps = minimalSumSubset(candidates, need)
  const removedPoints = swaps.reduce((s, t) => s + t.points, 0)
  const leftoverPoints = removedPoints - need

  const ma = input.kind === 'truck' ? (input.truckMa ?? 20) : (input.wagonMa ?? 10)
  const cost = input.count * ma * EXTENDER_FLIP_MA_FRACTION
  return succeed('12.7a', {
    rule: '12.7a',
    kind: input.kind,
    newRecordId: input.newRecordId,
    consumedPoints: need,
    extenderCount: input.count,
    swaps,
    removedPoints,
    leftoverPoints,
    leftoverPlacement: decomposeTransportPoints(leftoverPoints),
    totalCostMa: cost,
    detail:
      `用 ${input.kind === 'truck' ? '卡车' : '马车'}运输点数建 ${input.count} 个延补队：` +
      `消耗 ${need} 点（移走 ${swaps.length} 枚共 ${removedPoints} 点` +
      `${leftoverPoints > 0 ? `，余 ${leftoverPoints} 点留格` : '，无余'}），` +
      `消耗 ${cost} MA`,
  })
}

/**
 * 在候选集上找「点数和最小且 ≥ target」的子集（同一和时取枚数最少的一组）
 *
 * 候选数很小（同格同类型的运输点算子 ≤ 10），枚举 2^n 可行。
 */
function minimalSumSubset(
  entries: readonly TransportPointEntry[],
  target: number,
): ExtenderSwapIn[] {
  const n = entries.length
  if (n === 0) return []
  const limit = 1 << n
  let best: { count: number; sum: number; picked: ExtenderSwapIn[] } | null = null
  for (let mask = 1; mask < limit; mask += 1) {
    let sum = 0
    let count = 0
    const picked: ExtenderSwapIn[] = []
    for (let i = 0; i < n; i += 1) {
      if ((mask & (1 << i)) === 0) continue
      sum += entries[i]!.points
      count += 1
      picked.push({ transportUnitId: entries[i]!.id, points: entries[i]!.points })
    }
    if (sum < target) continue
    if (best === null || sum < best.sum || (sum === best.sum && count < best.count)) {
      best = { count, sum, picked }
    }
  }
  return best?.picked ?? []
}

/**
 * 把余量点数拆成运输点算子的面额（1–5）
 *
 * 通用运输点数的面额齐全（1/2/3/4/5），故贪心取大面额即可：余 1–5 点 ⇒ 一枚；
 * 余 6 点 ⇒ 5 + 1；以此类推。
 */
function decomposeTransportPoints(points: number): number[] {
  const faces: number[] = []
  let rest = points
  while (rest > 0) {
    const face = Math.min(EXTENDER_REQUIRED_POINTS, rest)
    faces.push(face)
    rest -= face
  }
  return faces
}

/* ────────────────────────────── 12.7d / 9.14d 延补队翻面 ────────────────────────────── */

/** 延补队翻面 → 5 点运输点数（状态层据此落盘） */
export interface ExtenderFlipPlan {
  /** 新的运输点数 recordId（状态层按 kind 查找 5 点运输点 record 后传入） */
  newRecordId: string
  /** 翻面代价（12.7d：自身 MA × 0.5；9.14d 被动崩溃不消耗） */
  costMa: number
  /** true＝玩家主动翻面（12.7d，需消耗 MA）；false＝9.14d 被动崩溃，代价 0 */
  playerInitiated: boolean
  rule: '12.7d' | '9.14d'
  detail: string
}

/**
 * 12.7d / 9.14d：延补队翻面为 5 点运输点数的计划
 *
 * - 12.7d 玩家主动翻面：**移动环节内**、消耗一半 MA；
 * - 9.14d 被动崩溃（敌方战斗单位进入）：**任意环节**、无 MA 代价（崩溃代价是位移而非消耗）。
 */
export function planFlipExtenderToTransport(input: {
  phase: MovementSegmentPhase
  kind: TransportKind
  /** 延补队自身 MA（取 combat 面印值） */
  extenderMa: number
  transportRecordId: string
  /** 玩家主动翻面（12.7d）还是被动崩溃（9.14d） */
  playerInitiated: boolean
}): RuleOutcome<ExtenderFlipPlan> {
  if (input.playerInitiated && !EXTENDER_SEGMENTS.includes(input.phase)) {
    return fail('12.7d', 'wrongSegment')
  }
  const costMa = input.playerInitiated ? input.extenderMa * EXTENDER_FLIP_MA_FRACTION : 0
  return succeed(input.playerInitiated ? '12.7d' : '9.14d', {
    newRecordId: input.transportRecordId,
    costMa,
    playerInitiated: input.playerInitiated,
    rule: input.playerInitiated ? '12.7d' : '9.14d',
    detail: input.playerInitiated
      ? `主动翻面：延补队 → 5 点${input.kind === 'truck' ? '卡车' : '马车'}（消耗 ${costMa} MA，12.7d）`
      : `被动崩溃翻面：延补队 → 5 点${input.kind === 'truck' ? '卡车' : '马车'}（无代价，9.14d）`,
  })
}

/** 由 side + kind 选择延补队 recordId（供状态层查找 record 后调用 plan 函数） */
export function pickExtenderRecordId(
  side: Side,
  kind: TransportKind,
  ref: ExtenderRecordRef,
): string {
  if (side === 'axis') return kind === 'truck' ? ref.axisTruckExtenderId : ref.axisWagonExtenderId
  return kind === 'truck' ? ref.sovietTruckExtenderId : ref.sovietWagonExtenderId
}
