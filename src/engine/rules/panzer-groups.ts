import type { HexRef } from '@/data'

import { HEX_DIRECTIONS, neighbor } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import { PANZER_GROUP_CONSTRAINT_END } from './timing'

/**
 * 装甲集群分界线与补给分配（Smolensk 专规 3.4 / 3.4a / 3.4b）
 *
 * ## 条文原文（ch03 引录，源 = Smolensk_Rules_v1.1 §3.4）
 *   「多单位编队（装甲、摩托化、骑兵师）分属 Guderian 的 **2nd Panzer Group** 与 Hoth 的
 *     **3rd Panzer Group**……**仅适用于 19 August 前，且只约束多单位编队**（步兵师与独立单位完全不受限）。」
 *
 *   - **3.4a Dividing Line**：「从 **19.19 到 62.23** 的多轨铁路线大体向东延伸，为两装甲集群分界。
 *     Guderian 的多单位编队应保持在该线**上或南**，Hoth 的应保持**上或北**。满足以下任一条件，
 *     即在任意相位末**对多单位编队的一个单位投 DG**：① 与另一装甲集群的单位**同堆叠或相邻**；
 *     ② 位于分界线『错误一侧』且处于 **Orsha 以东**的格（**19.xx 以西的格不受分界线约束**）。」
 *   - **3.4b Supply Restrictions**：「轴心国必须把 Supply Table 增援**平均分给** Guderian 与 Hoth，
 *     **奇数点归 Guderian**（例：得 7 SP → Hoth 3、Guderian 4）。『错误』装甲集群的 SP **不能**
 *     用于支付多单位编队的**燃油、战斗或轰炸**成本；除此之外 SP 使用不受限。
 *     开局地图内 SP 按 Setup Note F 分配；**所有新到的轴心国 SP 必须立即归属某一装甲集群**。」
 *
 * ## 实现口径（不臆造的边界）
 *   - 分界线端点取自产品数据 `map-config.json → panzerGroupBoundary`（[[19.19, 62.23]]）；
 *     **线本身由数据派生**：`panzerGroupBoundaryPath()` 沿 `map-layers` 的**多轨铁路**格边推路径
 *     （实测 45 格，与 §17.87 手工打出的逐格一致）——**渲染与判据共用这一条路径**。
 *     判「上（北）/下（南）」时取该列上路径的行区间（铁路在同一列可能上下摆，如 38.18 → 38.19）；
 *     落在区间内视为「**在线上**」（3.4a 允许「上或南」「上或北」，故线上两侧都合规）。
 *     调用方**没带路径**时退回两端点之间的列线性插值（旧口径，只服务旧夹具与纯函数单测）。
 *   - 「19.xx 以西的格不受分界线约束」的阈值取自分界线**起点列**（19）——同样是数据派生，不写死数字。
 *   - 「Orsha 以东」由调用方注入 Orsha 格（产品数据里 Orsha = 18.18，城市名 `Orsha`）。
 *   - 本模块**不写状态**：返回「该给哪个编队投 DG」的义务，由调用方在相位末落地。
 */

/** 两个装甲集群（3.4：Guderian = 2nd Panzer Group / Hoth = 3rd Panzer Group） */
export const PANZER_GROUPS = ['guderian', 'hoth'] as const
export type PanzerGroup = (typeof PANZER_GROUPS)[number]

/** 3.4b：错误集群的 SP 不得支付的用途（燃油 / 战斗 / 轰炸） */
export const PANZER_GROUP_FORBIDDEN_PURPOSES = ['fuel', 'combat', 'barrage'] as const
export type PanzerGroupSpPurpose = (typeof PANZER_GROUP_FORBIDDEN_PURPOSES)[number]

/** 3.4b：奇数点归 Guderian */
export const ODD_SP_TO_GUDERIAN = true

/**
 * 3.4：约束失效日（19 August 起不再适用）
 *
 * 值取自 `rules-constants.smolensk.panzerGroupConstraintEnd`（唯一实现在 `timing.ts`）。
 */

/** 分界线（由产品数据 map-config.panzerGroupBoundary 注入） */
export interface PanzerGroupBoundary {
  /** 西端（19.19） */
  west: HexRef
  /** 东端（62.23） */
  east: HexRef
  /**
   * ★ 批 F 切片 1（照 3.4a 原文）：**沿线走的多轨铁路折线**（`west → … → east` 的格序列）
   *
   * 原文：「分界线为 **19.19 → 62.23** 的**多轨铁路线**」⇒ 线**不是直线**，判据也不该按列线性插值
   * （铁路在 ±1 行内摆动，直线口径会判错若干格）。
   * 由 `panzerGroupBoundaryPath()` 从 `map-layers` 的多轨格边推出 —— **同一条路径同时喂渲染与判据**。
   * 缺省（`undefined`）时退回直线插值：仅用于"没带路径"的调用点（旧夹具 / 纯函数单测）。
   */
  path?: readonly HexRef[]
}

/** 专规 3.4：推路径所需的最小事实（多轨铁路格边；由调用方注入） */
export interface BoundaryPathFacts {
  isMultiTrackRail(a: HexRef, b: HexRef): boolean
}

/**
 * 专规 3.4：**沿多轨铁路从西端到东端的路径**（BFS；不连通即 null）
 *
 * 数据实测：全图多轨格 128 个、度数以 2 为主（链状），只有 18.18 / 19.19 / 19.28 三处度数 3
 * ⇒ 从 19.19 到 62.23 的**最短路就是那条铁路线**，共 **45 格**（与 §17.87 手工打出的路径逐格一致）。
 * ★ 不把 45 格写死在代码里：路径是**数据派生**的（地图改了路径跟着改），测试负责钉住"恰是这 45 格"。
 */
export function panzerGroupBoundaryPath(input: {
  from: HexRef
  to: HexRef
  facts: BoundaryPathFacts
}): HexRef[] | null {
  const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
  const start = key(input.from)
  const end = key(input.to)
  const previous = new Map<string, string | null>([[start, null]])
  const queue: HexRef[] = [{ ...input.from }]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (key(current) === end) break
    for (const direction of HEX_DIRECTIONS) {
      const next = neighbor(current, direction)
      if (previous.has(key(next))) continue
      if (!input.facts.isMultiTrackRail(current, next)) continue
      previous.set(key(next), key(current))
      queue.push(next)
    }
  }
  if (!previous.has(end)) return null
  const path: HexRef[] = []
  for (let node: string | null = end; node !== null; node = previous.get(node) ?? null) {
    const parts = node.split('.')
    path.push({ col: Number(parts[0]), row: Number(parts[1]) })
  }
  return path.reverse()
}

/** 相对分界线的位置（3.4a：「上或北」＝ north，「上或南」＝ south） */
export type BoundarySide = 'north' | 'south' | 'onLine'

/**
 * 3.4a：该格在分界线的哪一侧
 *
 * ★ 批 F 切片 1（照原文）：**分界线是多轨铁路线**，故判据分两支 ——
 *   · 给了 `path`（生产路径：`panzerGroupBoundaryPath` 推出的 45 格）⇒ **按折线判**：
 *     取该**列**上路径所占的行区间（铁路可能在同一列上下摆，如 38.18 → 38.19）；
 *     行号**高于区间上沿** ⇒ north、**低于下沿** ⇒ south、**落在区间内** ⇒ onLine
 *     （3.4a 允许 Guderian「上或南」、Hoth「上或北」⇒ 线上两侧都合规）。
 *     该列没有路径格（路径跳过某一列）⇒ 用**左右最近的两个路径列**线性插值（与旧口径同法，只在这一支用）。
 *   · 没给 `path`（旧夹具 / 纯函数调用点）⇒ 退回两端点之间的**列线性插值**（B37 的旧口径）。
 */
export function boundarySideOf(hex: HexRef, boundary: PanzerGroupBoundary): BoundarySide {
  const path = boundary.path
  if (path !== undefined && path.length >= 2) return sideOfPath(hex, path)
  const span = boundary.east.col - boundary.west.col
  if (span === 0)
    return hex.row > boundary.west.row ? 'north' : hex.row < boundary.west.row ? 'south' : 'onLine'
  const t = (hex.col - boundary.west.col) / span
  const lineRow = boundary.west.row + t * (boundary.east.row - boundary.west.row)
  const delta = hex.row - lineRow
  if (Math.abs(delta) < 0.5) return 'onLine'
  // 行号增大＝向北（CODE_SPEC 坐标约定）
  return delta > 0 ? 'north' : 'south'
}

/** 折线口径的判据（`boundarySideOf` 的分支）：该列上路径的行区间，区间内＝在线上 */
function sideOfPath(hex: HexRef, path: readonly HexRef[]): BoundarySide {
  const rowsHere = path.filter((item) => item.col === hex.col).map((item) => item.row)
  if (rowsHere.length > 0) {
    const min = Math.min(...rowsHere)
    const max = Math.max(...rowsHere)
    if (hex.row > max) return 'north'
    if (hex.row < min) return 'south'
    return 'onLine'
  }
  /*
   * 该列没有路径格：取**左右最近的**路径列，按列线性插值（只在折线支的这一种情形下用；
   * 端点以西 / 以东的格按端点行号外推，与原口径一致）。
   */
  const west = path.filter((item) => item.col < hex.col).at(-1) ?? path[0]!
  const east = path.find((item) => item.col > hex.col) ?? path.at(-1)!
  const span = east.col - west.col
  if (span === 0) return hex.row > west.row ? 'north' : hex.row < west.row ? 'south' : 'onLine'
  const lineRow = west.row + ((hex.col - west.col) / span) * (east.row - west.row)
  const delta = hex.row - lineRow
  if (Math.abs(delta) < 0.5) return 'onLine'
  return delta > 0 ? 'north' : 'south'
}

/** 3.4a：分界线判据的**生效范围**（19.xx 以西的格不受约束；且须在 Orsha 以东） */
export interface DividingLineScope {
  boundary: PanzerGroupBoundary
  /** Orsha 格（产品数据：城市名 Orsha） */
  orshaHex: HexRef
}

/**
 * 3.4a：该格是否落在分界线判据的生效范围内
 *
 * 「位于分界线『错误一侧』且处于 **Orsha 以东**的格（**19.xx 以西的格不受分界线约束**）」
 * ⇒ 生效当且仅当：**列 ≥ 分界线起点列**（数据派生，= 19）且 **列 > Orsha 列**。
 */
export function inDividingLineScope(hex: HexRef, scope: DividingLineScope): boolean {
  return hex.col >= scope.boundary.west.col && hex.col > scope.orshaHex.col
}

/** 多单位编队的一个单位（3.4a 逐单位判「同堆叠/相邻」） */
export interface PanzerGroupUnitView {
  id: string
  /** 所属装甲集群（独立单位 / 步兵师不属任何集群 ⇒ 不参与 3.4） */
  group: PanzerGroup | null
  /** 是否属**多单位编队**（3.4：只约束多单位编队；步兵师与独立单位不受限） */
  inMultiUnitFormation: boolean
  hex: HexRef
}

/** 3.4a：相位末的分界线义务 */
export interface DividingLineObligation {
  group: PanzerGroup
  /** 需要投 DG 的单位（编队内任选一个，故给出编队内全部合格单位供选） */
  unitIds: readonly string[]
  /** 触发条件（机器可读） */
  reason: 'crossGroupStackedOrAdjacent' | 'wrongSideOfLineEastOfOrsha'
  rule: string
  detail: string
}

/**
 * 3.4a：相位末的分界线义务
 *
 * 对每个**多单位编队**逐条判两条触发条件（与另一集群同堆叠/相邻；错误一侧且 Orsha 以东），
 * 命中即在**该编队内**给出一个单位的 DG 义务（3.4a：「对多单位编队的一个单位投 DG」）。
 *
 * @param adjacent 两格是否相邻（注入 `areAdjacent`，引擎不重复实现几何）
 */
export function dividingLineObligations(input: {
  units: readonly PanzerGroupUnitView[]
  scope: DividingLineScope
  /** 3.4：仅 **19 August 前**生效 */
  date: string
  adjacent(a: HexRef, b: HexRef): boolean
  sameHex(a: HexRef, b: HexRef): boolean
}): readonly DividingLineObligation[] {
  if (input.date >= PANZER_GROUP_CONSTRAINT_END) return []

  const formations = new Map<PanzerGroup, PanzerGroupUnitView[]>()
  for (const unit of input.units) {
    if (unit.group === null || !unit.inMultiUnitFormation) continue
    const list = formations.get(unit.group)
    if (list === undefined) formations.set(unit.group, [unit])
    else list.push(unit)
  }

  const obligations: DividingLineObligation[] = []
  for (const [group, members] of formations) {
    const unitIds = members.map((unit) => unit.id)

    // 条件①：与**另一**装甲集群的单位同堆叠或相邻
    const other = input.units.filter(
      (unit) => unit.group !== null && unit.group !== group && unit.inMultiUnitFormation,
    )
    const crossGroup = members.some((mine) =>
      other.some(
        (theirs) => input.sameHex(mine.hex, theirs.hex) || input.adjacent(mine.hex, theirs.hex),
      ),
    )
    if (crossGroup) {
      obligations.push({
        group,
        unitIds,
        reason: 'crossGroupStackedOrAdjacent',
        rule: '3.4a',
        detail:
          `${group === 'guderian' ? 'Guderian' : 'Hoth'} 编队与另一装甲集群的单位**同堆叠或相邻**` +
          `（3.4a 条件①）⇒ 相位末须对该编队一个单位投 DG`,
      })
      continue
    }

    // 条件②：位于分界线「错误一侧」且处于 Orsha 以东（19.xx 以西不受约束）
    const allowed: BoundarySide = group === 'guderian' ? 'south' : 'north'
    const wrong = members.find((unit) => {
      if (!inDividingLineScope(unit.hex, input.scope)) return false
      const side = boundarySideOf(unit.hex, input.scope.boundary)
      return side !== 'onLine' && side !== allowed
    })
    if (wrong !== undefined) {
      obligations.push({
        group,
        unitIds,
        reason: 'wrongSideOfLineEastOfOrsha',
        rule: '3.4a',
        detail:
          `${wrong.id} 位于分界线「错误一侧」（${group === 'guderian' ? 'Guderian 须在线上或南' : 'Hoth 须在线上或北'}）` +
          `且处于 Orsha 以东 ⇒ 相位末须对该编队一个单位投 DG（3.4a 条件②；19.xx 以西不受约束）`,
      })
    }
  }
  return obligations
}

/**
 * 3.4b：Supply Table 到货在两大集群间的分配
 *
 * 「必须把 Supply Table 增援**平均分给** Guderian 与 Hoth，**奇数点归 Guderian**」
 * （例：7 SP ⇒ Hoth 3、Guderian 4）。
 */
export function splitSupplyTableSp(points: number): { hoth: number; guderian: number } {
  const total = Math.max(0, Math.trunc(points))
  const hoth = Math.floor(total / 2)
  const guderian = total - hoth // 奇数点归 Guderian（3.4b）
  return { hoth, guderian }
}

/**
 * 4.1a 可选规则在**开局共识清单**里的条目文本（★ 唯一常量）
 *
 * 「可选规则与房规」是专规 4.0 的共识项；3.4 族的可选项来自 4.1a「ignore 2.3e and/or 3.4」。
 * 用户 2026-09-17 口径：**3.4b 做成可选项**（默认不启用；启用了才在对局里出现相应界面）。
 *
 * ★ 这里写死文本是为了"有一处可对照"：数据侧 `scenarios.agreedOptions.items` 必须**原样包含**它，
 *   由 `tests/data/scenarios.test.ts` 钉住 —— 数据改字而常量没跟着改，测试会红，而不是功能静默失效。
 */
export const PANZER_GROUP_OPTION_ITEM = '装甲集群 SP 归属约束（3.4b，4.1a 可选）'

/**
 * 3.4b 在本局是否生效 —— **两轴都成立才算**（判据只此一处）
 *
 *   · `constraintApplies`：剧本/日期那一轴。工作台按**当前回合日**（19 August 前）判，
 *     初设按**剧本首回合日**（`setup.ts#requiresPanzerGroupSpAssignment`）判 —— 两处口径各自有自己的
 *     出处，这里不再重算，只把它们与共识相乘；
 *   · `agreedByConsensus`：专规 4.0 的共识那一轴（4.1a 是否采纳了本可选项）。
 *
 * ⇒ 未采纳 ⇒ 3.4b **不约束**（无待办、无付款限制、无归属界面）；采纳且日期在窗口内 ⇒ 照原文生效。
 */
export function panzerGroupRulesActive(input: {
  constraintApplies: boolean
  agreedByConsensus: boolean
}): boolean {
  return input.constraintApplies && input.agreedByConsensus
}

/**
 * 3.4b：该集群的 SP 能否支付这笔费用
 *
 * 「『错误』装甲集群的 SP **不能**用于支付多单位编队的**燃油、战斗或轰炸**成本；
 *   除此之外 SP 使用不受限。」
 * ⇒ 只有当**付费方 = 编队所属集群**时，这三类用途才合法；其它用途一律不受限。
 */
export function checkPanzerGroupSpPayment(input: {
  /** SP 归属的集群（或 null ＝ 尚未归属） */
  spGroup: PanzerGroup | null
  /** 受益编队所属的集群（独立单位 / 步兵师为 null ⇒ 不受限） */
  formationGroup: PanzerGroup | null
  /** 用途（燃油 / 战斗 / 轰炸 / 其它） */
  purpose: PanzerGroupSpPurpose | 'other'
  /** 3.4：仅 19 August 前生效 */
  date: string
  /** 是否属多单位编队（只约束多单位编队） */
  inMultiUnitFormation: boolean
  /** SP 是否尚未归属任何集群（3.4b：所有新到轴方 SP 必须立即归属某一装甲集群） */
  unassigned?: boolean
  /**
   * 4.1a 可选：本局共识是否采纳了 3.4b 的约束（**必填** —— 由 `panzerGroupRulesActive` 算出）
   *
   * ★ 用户 2026-09-17 口径：3.4b 是可选规则，未采纳即**不约束**（也不出现相应界面）。
   *   必填而不是缺省 true：让每个调用方都得表态，免得"忘了接线"被静默当成"规则生效"。
   */
  agreedByConsensus: boolean
}): RuleOutcome<{ restricted: false } | { restricted: true }> {
  // 4.1a：未采纳本可选项 ⇒ 3.4b 整条不生效（在日期判据之前退出，两条互不掩盖）
  if (!input.agreedByConsensus) return succeed('4.1a', { restricted: false })
  if (input.date >= PANZER_GROUP_CONSTRAINT_END) return succeed('3.4', { restricted: false })
  if (input.unassigned === true) return fail('3.4b', 'newSpMustBeAssignedToAPanzerGroup')
  if (!input.inMultiUnitFormation || input.formationGroup === null) {
    return succeed('3.4b', { restricted: false })
  }
  if (input.purpose === 'other') return succeed('3.4b', { restricted: false })
  if (input.spGroup === input.formationGroup) return succeed('3.4b', { restricted: false })
  return fail(
    '3.4b',
    `wrongPanzerGroupSp:${input.spGroup ?? 'unassigned'}≠${input.formationGroup}:${input.purpose}`,
  )
}

/**
 * 3.4：该集群的合规一侧（Guderian 在线上或南；Hoth 在线上或北）
 *
 * 供界面提示与测试断言使用。
 */
export function allowedSideOf(group: PanzerGroup): BoundarySide {
  return group === 'guderian' ? 'south' : 'north'
}

/** 3.4：步兵师与独立单位不受分界线约束（判据只按「是否多单位编队」） */
export function isExemptFromPanzerGroupRules(unit: {
  group: PanzerGroup | null
  inMultiUnitFormation: boolean
}): boolean {
  return unit.group === null || !unit.inMultiUnitFormation
}
