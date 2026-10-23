import type { HexRef, Side } from '@/data'

import { HEX_DIRECTIONS, neighbor } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import type { GamePhase } from '../state-types'
import { SP_TO_T } from './supply'
import {
  assessUnitSupply,
  canEatOffTheMap,
  canThrowViaHQ,
  countSupplyDistanceToAny,
  drawableDumpsFor,
  eatingOffTheMapCostT,
  supplyReachableHexes,
  supplyPath,
  traceSourcesFor,
  type SupplyMobility,
  type SupplyReachableHex,
  type TraceSupplyFacts,
  type UnitSupplyAssessment,
} from './trace-supply'
import type { BaseMode } from './modes'

/**
 * 补给交互与 SP 管理（C8，OCS 12.0 章）
 *
 * 覆盖用户要求的四条交互链：**追溯与投递可视化** · **SP 拆分合并** · **拖取与投递选择** ·
 * **断补处置**。判定一律委托 `trace-supply.ts`（12.3/12.6/12.7 的唯一实现），本模块只负责
 * 玩家输入的形状、顺序与可视化数据；引擎不写状态（以 patches / 结论交还状态层）。
 *
 * ## 条文要点（逐句落实现）
 *   - **12.1a**「玩家可以将**同一格内**的 SP 拆分或加总，用等额的 SP 算子像『找零钱』一样进行替换。
 *     玩家可以进一步将 SP 拆分为**补给指示物 (T)**……**1SP 等于 4T**，反之 1T 等于 1/4SP。」
 *     「玩家需要**尽可能将 T 并为 SP**，以便减少堆叠。」「SP 和 T 除了数额不同，其他都是一样的。」
 *   - **12.1b** 任何含 SP 的位置（未装载或装在运输点数上）都是**补给站**（dump）。
 *   - **12.3（重要提示）**「在玩家任何需要补给（追溯补给、燃料、战斗、建造、补充部队储备，或飞机整备）
 *     的时候，都需要使用**直接拖取和指挥部投递中的同一种相同机制**进行补给。拖取、投递或追溯补给
 *     本身**不需要使用燃料**。」
 *   - **12.3a 直接拖取**「单位必须在一个补给站的 **5MP 内**，或单位在补给站的**相邻格**内（12.3c）。
 *     在需要补给时，可从该距离内的**一个或多个**补给站拖取所需补给。」「在计算单位到补给站的距离时，
 *     始终要使用**轮式 MP**。（例外：对于投递距离为步行或履带的**指挥部**，则使用对应的移动类型）」
 *   - **12.3b 指挥部投递**「能够从补给站拖取 SP 的指挥部（根据 12.3a），可以将其他单位所需补给传递至
 *     更远处，距离以它**印刷的投递距离**为准。」A) 「指挥部只能投递**需要立即被使用**的补给。（如果是要
 *     将补给站移动到新的地点，则需要某种形式的运输才行）」C) 「**战略模式**下的指挥部不能投递补给。」
 *     D) 「指挥部**不能**将另一个指挥部投递给它的补给，再『重新投递』给其他单位。」
 *   - **12.3c 相邻即可**「无论地形如何（即使是禁入地形），只要补给能到达单位的**相邻格**，那么单位就可以
 *     获得补给。」
 *   - **12.3d 沿补给路径的移动**「视为一个假象的**非战斗单位**沿着一条补给路径逐格移动」——故路径与距离
 *     共用一套取费与阻断（`trace-supply` 的 `stepMp`）。
 *   - **12.3e** 存储区域中的单位视同在该格（拖取同理）。
 *   - **12.6a** 补给源三种：边缘铁路格（＋专规其他源）／火车卸货格（13.3c）／含**延补队**且该延补队
 *     连到卸货格或补给源的格。
 *   - **12.6c 吃图上补给**「每消耗 **1T**，就可以为最多 **2RE** 的战斗单位提供追溯补给（前提是单位在
 *     补给站的拖取或投递距离内）。所有小数**向上取整**；例如，6.5 的 RE 需消耗 4T。」
 *     「**只有在没有追溯补给的情况下**，单位才能『吃图上补给』。」另见 12.6e（战略模式不允许）。
 *   - **12.6d**「不能『追溯补给线』，也不能『吃图上补给』，则会被标记为**断补**，并进行损耗掷骰（12.8）。」
 *   - **12.6e** 战略模式的单位**不允许**吃图上补给；战略模式的指挥部**不能**投递补给。
 */

/* ────────────────────────────── 12.1a SP / T 拆分与加总 ────────────────────────────── */

/** 1 SP 等于 4 T（12.1a） */
export const T_PER_SP = SP_TO_T

/** 12.1b：一个补给站（dump）的持仓 */
export interface SpHoldings {
  /** 整 SP 数 */
  sp: number
  /** 补给指示物数（T） */
  t: number
}

/** 12.1a：把持仓折算为 T 总额（「SP 与 T 除数额外完全一样」） */
export function holdingsToT(holdings: SpHoldings): number {
  return holdings.sp * T_PER_SP + holdings.t
}

/** 12.1a：把 T 总额折算为持仓，**尽可能并为 SP**（余数留作 T） */
export function tToHoldings(totalT: number): SpHoldings {
  return { sp: Math.floor(totalT / T_PER_SP), t: totalT % T_PER_SP }
}

/** 12.1a：持仓是否已是「尽量并为 SP」的形式（T < 4） */
export function isNormalizedHoldings(holdings: SpHoldings): boolean {
  return holdings.t < T_PER_SP
}

/**
 * 12.1a：**加总**（把 T 尽可能并为 SP，减少堆叠）
 *
 * 「玩家需要尽可能将 T 并为 SP，以便减少堆叠」⇒ T 达 4 的倍数即并为等额 SP。
 */
export function planSpMerge(input: { holdings: SpHoldings }): RuleOutcome<{
  holdings: SpHoldings
  rule: string
  detail: string
}> {
  const { sp, t } = input.holdings
  if (!Number.isInteger(sp) || !Number.isInteger(t) || sp < 0 || t < 0)
    return fail('12.1a', `invalidHoldings:${sp}/${t}`)
  const merged = tToHoldings(holdingsToT(input.holdings))
  return succeed('12.1a', {
    holdings: merged,
    rule: '12.1a',
    detail:
      merged.sp === sp && merged.t === t
        ? `持仓已是「尽量并为 SP」形式（${merged.sp} SP + ${merged.t} T）`
        : `加总：${sp} SP + ${t} T ⇒ ${merged.sp} SP + ${merged.t} T（12.1a：尽可能并为 SP）`,
  })
}

/**
 * 12.1a：**拆分**（把 `spToSplit` 个整 SP 找零为 T）
 *
 * 「用等额的 SP 算子像『找零钱』一样进行替换」⇒ 拆分**不改变总额**，只是换零钱
 * （示例 1：为支付 1T 燃料把 1SP 翻到 3T 一面）。
 */
export function planSpSplit(input: {
  holdings: SpHoldings
  /** 要拆成 T 的整 SP 数（0 表示不拆） */
  spToSplit: number
}): RuleOutcome<{ holdings: SpHoldings; tAdded: number; rule: string; detail: string }> {
  const { sp, t } = input.holdings
  if (!Number.isInteger(input.spToSplit) || input.spToSplit < 0)
    return fail('12.1a', `invalidSplitCount:${input.spToSplit}`)
  if (input.spToSplit > sp) return fail('12.1a', `notEnoughSp:${input.spToSplit}>${sp}`)
  const tAdded = input.spToSplit * T_PER_SP
  return succeed('12.1a', {
    // 拆分后**不再**自动并回：玩家此刻正需要零钱（10.1b / 12.5 的 T 支付）
    holdings: { sp: sp - input.spToSplit, t: t + tAdded },
    tAdded,
    rule: '12.1a',
    detail:
      input.spToSplit === 0
        ? `未拆分（持仓 ${sp} SP + ${t} T）`
        : `拆分 ${input.spToSplit} SP ⇒ +${tAdded} T（12.1a：1 SP = ${T_PER_SP} T；可用支付零钱）`,
  })
}

/** 一次 SP 支付的结果 */
export interface SpPayment {
  /** 支付后的来源持仓（**已规范化**：T 满 4 并为 SP） */
  holdingsAfter: SpHoldings
  /** 实际支付的 T 数 */
  paidT: number
  /** 是否必须拆分整 SP 才够支付零钱 */
  splitNeeded: boolean
  rule: string
  detail: string
}

/**
 * 12.1a：为支付 `wantT` 点而**拆分 + 扣除**，并把余额并回 SP
 *
 * 这是所有补给支付（12.3 拖取/投递、12.5 燃料、12.4 战斗、建造、整备）的**统一扣款入口**：
 * 先看手上 T 是否够，不够则把一个整 SP 找零（示例 1 的做法），扣完后按「尽可能并为 SP」并回。
 */
export function planSpPayment(input: {
  holdings: SpHoldings
  wantT: number
}): RuleOutcome<SpPayment> {
  if (!Number.isInteger(input.wantT) || input.wantT < 0)
    return fail('12.1a', `invalidAmountT:${input.wantT}`)
  const total = holdingsToT(input.holdings)
  if (total < input.wantT) return fail('12.1a', `insufficientSpHoldings:${input.wantT}>${total}`)

  const splitNeeded = input.holdings.t < input.wantT
  // 扣款后**规范化**：12.1a「尽可能将 T 并为 SP」
  const holdingsAfter = tToHoldings(total - input.wantT)
  return succeed('12.1a', {
    holdingsAfter,
    paidT: input.wantT,
    splitNeeded,
    rule: '12.1a',
    detail:
      `支付 ${input.wantT} T` +
      (splitNeeded ? `（需拆分整 SP 找零）` : '') +
      ` ⇒ 余额 ${holdingsAfter.sp} SP + ${holdingsAfter.t} T`,
  })
}

/* ────────────────────────────── 12.3 / 12.6 补给来源（可视化） ────────────────────────────── */

/** 补给来源类别（12.3 拖取/投递；12.6a 追溯源；12.6c 吃图上补给） */
export type SupplySourceKind = 'dump' | 'hqThrow' | 'baseSource' | 'extender' | 'eatOffTheMap'

/** 一个可用于该单位的补给来源（含距离与路径，供界面可视化） */
export interface SupplySourceOption {
  kind: SupplySourceKind
  /** 来源格；吃图上补给为 null（来源即目标格本身） */
  hex: HexRef | null
  /**
   * 12.3d：该来源到单位的**最省路径**（含起点与终点；12.3c 的「相邻即可」若使终点为相邻格，则终点即该邻格）
   *
   * 吃图上补给或不可达时为 null。
   */
  path: HexRef[] | null
  /** 到单位的补给消耗（MP）；不可达为 null */
  distanceMp: number | null
  /** 12.3c：是否靠「相邻即可」成立（终点为单位相邻格而非单位格） */
  viaAdjacency: boolean
  /** 是否可用 */
  ok: boolean
  rule: string
  /** 不通过时的原因码 */
  reason?: string
  detail: string
}

/** 12.3b：可投递的指挥部视图见 `trace-supply#ThrowHqView`（本模块只消费，不另立一份） */

/**
 * 12.3a / 12.3b / 12.3c：算出该单位的**全部可用补给来源**（含距离与路径）
 *
 * 顺序与口径：
 *   ① **直接拖取**（12.3a）：对每个 dump 求「dump → 单位格或其任一相邻格」的最短轮式 MP（12.3c），
 *      5 MP 内或相邻即成立；
 *   ② **指挥部投递**（12.3b）：对每个 HQ 用其**印刷投递距离**与**投递颜色所示机动类型**计数，
 *      并施加 12.3b-C（战略模式不可投递）与 12.3b-D（不可转投）；
 *   ③ **追溯来源**（12.6a）：`traceSourcesFor` 给出的基础源 / 火车卸货格 / 延补队结论（已含 12.7）；
 *   ④ **吃图上补给**（12.6c）：仅在没有追溯补给时才可用（12.6e：战略模式不允许）。
 *
 * 「可以从该距离内的**一个或多个**补给站拖取」⇒ 本函数返回**全部**来源，供玩家自选或组合。
 */
export function supplySourceOptions(
  facts: TraceSupplyFacts,
  input: {
    unit: {
      id: string
      side: Side
      hex: HexRef
      isCombat: boolean
      re: number
      /** 12.6e：战略模式不允许吃图上补给 */
      mode?: BaseMode
    }
    /** 12.3a：拖取计数始终用轮式 MP；仅在 12.3a 的例外情形（HQ 投递距离为步行/履带）才另给 */
    mobility?: SupplyMobility
    /** 该单位是否由某 HQ 投递获得补给（12.3b-D：不可转投） */
    thrownByHq?: boolean
  },
): SupplySourceOption[] {
  const side = input.unit.side
  const mobility = input.mobility ?? 'truck'
  const options: SupplySourceOption[] = []
  // 12.3c：终点集合 = 单位格及其六邻格（「只要补给能到达单位的相邻格」）
  const targets = [input.unit.hex, ...neighborsOf(input.unit.hex)]

  // 12.6a：本格的追溯结论只算一次（② 判 HQ 投递资格、③ 列基础来源、④ 判能否吃图上补给共用）
  const traceSources = traceSourcesFor(facts, { hex: input.unit.hex, side, mobility })

  // ① 12.3a 直接拖取（12.3a：5 MP 内；12.3c：或与补给站**相邻**即可——相邻不看 MP）
  for (const dump of drawableDumpsFor(facts, { hex: input.unit.hex, side, mobility })) {
    options.push({
      kind: 'dump',
      hex: dump.hex,
      path: dump.path,
      distanceMp: dump.distanceMp,
      viaAdjacency: dump.viaAdjacency,
      ok: dump.ok,
      rule: dump.rule,
      ...(dump.ok ? {} : { reason: dump.reason }),
      detail: dump.detail,
    })
  }

  // ② 12.3b 指挥部投递
  //
  // 口径与 12.6 的 `traceSourcesFor` **完全一致**：一个 HQ 能否给该单位投递，就是「该单位能否
  // 从它那里得到追溯补给」的同一组前置——12.3b 要求 HQ **自身能从补给站拖取 SP**（或自身已有
  // 追溯补给），且不受 12.3b-C（战略模式）与 12.3b-D（不可转投）限制，且在投递距离内。
  // 为此以 `traceSourcesFor` 的 hqThrow 结论为准（避免两处判据漂移），另用 `canThrowViaHQ`
  // 只负责给出被拒的**具体条文与原因**。
  const throwingHqKeys = new Set(
    traceSources.filter((source) => source.kind === 'hqThrow').map((source) => hexKey(source.hex)),
  )
  for (const hq of facts.throwHqsFor(side)) {
    // 有界搜索（投递距离）：只展开投递距离内的区域，避免整图 Dijkstra 拖慢界面
    const distance = countSupplyDistanceToAny(facts, {
      from: hq.hex,
      targets,
      side,
      // 12.3b：用投递距离**颜色所示**的机动类型计数
      mobility: hq.throwMobility,
      maxMp: hq.throwRangeMp,
    })
    const verdict = canThrowViaHQ({
      hqMode: hq.mode,
      distanceMp: distance.ok ? distance.mp : Number.POSITIVE_INFINITY,
      throwRangeMp: hq.throwRangeMp,
      ...(hq.receivedByThrow === undefined ? {} : { receivedByThrow: hq.receivedByThrow }),
    })
    const supplied = throwingHqKeys.has(hexKey(hq.hex))
    const ok = verdict.ok && supplied
    const reason = verdict.ok ? 'hqNotSupplied' : verdict.reason
    const reached = distance.ok
      ? pathToUnitWithin(facts, {
          from: hq.hex,
          side,
          mobility: hq.throwMobility,
          targetHex: input.unit.hex,
          maxMp: hq.throwRangeMp,
        })
      : null
    options.push({
      kind: 'hqThrow',
      hex: hq.hex,
      path: reached?.path ?? null,
      distanceMp: distance.ok ? distance.mp : null,
      viaAdjacency: reached?.viaAdjacency ?? false,
      ok,
      rule: ok ? '12.3b' : verdict.ok ? '12.3b' : verdict.rule,
      ...(ok ? {} : { reason }),
      detail: ok
        ? `指挥部投递（12.3b）：投递距离 ${hq.throwRangeMp} MP，本次耗 ${distance.ok ? distance.mp : '?'} MP`
        : verdict.ok
          ? '指挥部自身未获得补给（12.3b）：须先能从补给站拖取 SP'
          : `指挥部不可投递（${verdict.rule}）：${verdict.reason}`,
    })
  }

  // ③ 12.6a 追溯基础来源（含 12.7 延补队；**不含** HQ 投递——② 已逐个列出全部 HQ）
  for (const source of traceSources) {
    if (source.kind === 'hqThrow') continue
    options.push({
      kind: source.kind === 'extender' ? 'extender' : 'baseSource',
      hex: source.hex,
      path: null,
      distanceMp: null,
      viaAdjacency: false,
      ok: true,
      rule: '12.6a',
      detail: `可追溯至 ${source.kind}（12.6a）`,
    })
  }

  // ④ 12.6c 吃图上补给（**仅在没有追溯补给时**；12.6e 战略模式不允许）
  const hasTrace = traceSources.length > 0
  const eat = hasTrace
    ? { ok: false as const, rule: '12.6c', reason: 'onlyWhenNoTraceSupply' }
    : canEatOffTheMap(facts, {
        hex: input.unit.hex,
        side,
        mobility,
        ...(input.unit.mode === undefined ? {} : { unitMode: input.unit.mode }),
        ...(input.thrownByHq === undefined ? {} : { thrownByHq: input.thrownByHq }),
      })
  options.push({
    kind: 'eatOffTheMap',
    hex: null,
    path: null,
    distanceMp: null,
    viaAdjacency: false,
    ok: eat.ok,
    rule: '12.6c',
    ...(eat.ok ? {} : { reason: eat.reason }),
    detail: eat.ok
      ? `可吃图上补给（12.6c）：每 1T 覆盖最多 2RE，不足 2RE 向上取整`
      : `不可吃图上补给（12.6c）：${eat.reason}`,
  })

  return options
}

function sameHex(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}

/** 格的规范键（仅模块内比较用；业务坐标一律 `{ col, row }`） */
function hexKey(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

/**
 * 12.3c：`hex` 的**六邻格**（不含自身）
 *
 * 「只要补给能到达单位的**相邻格**，那么单位就可以获得补给」⇒ 一切 draw/throw 距离与路径的
 * 终点集合都是「单位格 ＋ 其六邻格」。几何一律走 `hex-geometry` 的唯一实现。
 */
function neighborsOf(hex: HexRef): HexRef[] {
  return HEX_DIRECTIONS.map((direction) => neighbor(hex, direction))
}

/** 12.3c / 12.3d：到「单位格或其相邻格」的**最省**路径（含终点是否靠相邻成立） */
function pathToUnitWithin(
  facts: TraceSupplyFacts,
  input: { from: HexRef; targetHex: HexRef; side: Side; mobility: SupplyMobility; maxMp: number },
): { path: HexRef[]; viaAdjacency: boolean } | null {
  let best: { path: HexRef[]; viaAdjacency: boolean } | null = null
  for (const target of [input.targetHex, ...neighborsOf(input.targetHex)]) {
    const path = supplyPath(facts, {
      from: input.from,
      to: target,
      side: input.side,
      mobility: input.mobility,
      maxMp: input.maxMp,
    })
    if (path === null) continue
    // 与 `countSupplyDistanceToAny` 取同一目标（最短者），保证「界面画的路径」与「判定用的距离」一致
    if (best === null || path.length < best.path.length) {
      best = { path, viaAdjacency: !sameHex(target, input.targetHex) }
    }
  }
  return best
}

/**
 * 12.3b：某指挥部 / 补给站到某格的**投递/拖取覆盖范围**（供界面铺色）
 *
 * 「任何一种补给路径都会视为一个假象的非战斗单位沿着一条补给路径逐格移动」⇒ 覆盖范围即
 * `supplyReachableHexes` 的预算内区域（与单点判定共用同一 `stepMp`）。
 */
export function supplyCoverage(
  facts: TraceSupplyFacts,
  input: { from: HexRef; side: Side; mobility: SupplyMobility; maxMp: number },
): SupplyReachableHex[] {
  return supplyReachableHexes(facts, input)
}

/* ────────────────────────────── 12.3 拖取与投递选择 ────────────────────────────── */

/** 12.3：SP 的用途（「SP 会用于移动所需的燃料补给、战斗补给、飞机整备、补充部队储备、支付建造费用」） */
export type SupplyPurpose = 'fuel' | 'combat' | 'refit' | 'internalStocks' | 'build'

/** 一次拖取/投递的结算结论 */
export interface SupplyPickupPlan {
  /** 来源持仓变更后的值（交状态层落盘） */
  sourceAfter: SpHoldings
  /** 实际投递/拖取的 T 数 */
  deliveredT: number
  /** 用途 */
  purpose: SupplyPurpose
  rule: string
  detail: string
}

/**
 * 12.3：**拖取 / 投递选择**的结算
 *
 * 校验链：来源可用（12.3a/b/c）→ 12.3b-A（指挥部只能投递**需要立即被使用**的补给）→
 * 12.1a 支付（必要时找零）。「拖取、投递或追溯补给本身**不需要使用燃料**」⇒ 不产生燃料消耗。
 */
export function planSupplyPickup(input: {
  source: SupplySourceOption
  /** 来源当前持仓（12.1b：含 SP 的位置即补给站） */
  holdings: SpHoldings
  /** 本次要拖取/投递的 T 数（12.3a：「所需补给」） */
  amountT: number
  purpose: SupplyPurpose
  /** 12.3b-A：是否**立即使用**（把补给站搬到新地点需运输工具，不能靠投递搬家） */
  forImmediateUse?: boolean
}): RuleOutcome<SupplyPickupPlan> {
  if (!input.source.ok) return fail(input.source.rule, input.source.reason ?? 'sourceNotAvailable')
  // 12.1b：只有含 SP 的位置（补给站）或投递的指挥部才能被「拖取/投递」
  if (!isSpBearingSource(input.source.kind))
    return fail('12.3a', `sourceHasNoSp:${input.source.kind}`)
  if (input.amountT <= 0) return fail('12.3', `invalidAmountT:${input.amountT}`)
  // 12.3b-A：指挥部只能投递需要立即被使用的补给
  if (input.source.kind === 'hqThrow' && input.forImmediateUse === false)
    return fail('12.3b-A', 'hqThrowOnlyForImmediateUse')

  const payment = planSpPayment({ holdings: input.holdings, wantT: input.amountT })
  if (!payment.ok) return payment

  return succeed('12.3', {
    sourceAfter: payment.data.holdingsAfter,
    deliveredT: input.amountT,
    purpose: input.purpose,
    rule: '12.3',
    detail:
      `${input.source.kind === 'hqThrow' ? '指挥部投递' : '直接拖取'} ${input.amountT} T` +
      `（用途 ${purposeLabel(input.purpose)}；12.3：拖取/投递本身不耗燃料）` +
      `；来源余额 ${payment.data.holdingsAfter.sp} SP + ${payment.data.holdingsAfter.t} T`,
  })
}

/** 用途中文名（日志与界面） */
export function purposeLabel(purpose: SupplyPurpose): string {
  switch (purpose) {
    case 'fuel':
      return '燃料（12.5）'
    case 'combat':
      return '战斗补给（12.4）'
    case 'refit':
      return '飞机整备（15.1）'
    case 'internalStocks':
      return '补充部队储备（12.10）'
    case 'build':
      return '建造费用（13.8）'
  }
}

/**
 * 12.3a / 12.3b：该来源是否**含 SP**（只有含 SP 的位置才能被拖取/投递）
 *
 * 12.1b：「任何包含 SP 的位置（未装载或装在运输点数上）都是**补给站**」⇒ 拖取的来源只能是
 * **补给站**；投递的来源只能是**指挥部**（它从补给站拖取后再前送）。
 * 12.6a 的追溯来源（边缘铁路格 / 火车卸货格 / 延补队）只提供**追溯连通**（12.6 的「是否断补」），
 * 本身不存放 SP ⇒ 不能作为拖取/投递的来源（二者是两件事，勿混）。
 */
export function isSpBearingSource(kind: SupplySourceKind): boolean {
  return kind === 'dump' || kind === 'hqThrow'
}

/* ────────────────────────────── 12.6c / 12.6d 断补处置 ────────────────────────────── */

/** 断补处置的两种去向 */
export type OosAction = 'eatOffTheMap' | 'acceptOutOfSupply'

/** 断补处置结论 */
export interface OosResolution {
  action: OosAction
  /** 12.6c：吃图上补给消耗的 T（每 1T 覆盖最多 2RE，不足向上取整） */
  costT: number
  /** 12.6d：是否标记为**断补**（随后按 12.8 掷损耗骰） */
  markedOutOfSupply: boolean
  /** 来源持仓变更后的值（吃图上补给时；接受断补时原样返回） */
  holdingsAfter: SpHoldings
  rule: string
  detail: string
}

/**
 * 12.6c / 12.6d：**断补处置**
 *
 *   - `eatOffTheMap`：吃图上补给（12.6c）。「**只有在没有追溯补给的情况下**，单位才能『吃图上补给』」
 *     ⇒ 若评估结论是已在补给状态（`inSupply`）或不可吃（12.6e 战略模式），一律拒绝。
 *   - `acceptOutOfSupply`：接受断补（12.6d）⇒ 标记断补并由 12.8 掷损耗骰
 *     （「绝不会强迫单位『吃图上补给』……让被包围的单位『挨饿』也是一种不错的赌博」）。
 */
export function planOosResolution(input: {
  assessment: UnitSupplyAssessment
  action: OosAction
  holdings: SpHoldings
  /**
   * 12.6c：本环节**已从同一补给站喂过的 RE 总量**（批量费率取整用）
   *
   * 「每消耗 1T，就可以为最多 2RE……」的取整作用在批次总量上，故本字段使 `costT`
   * 成为**增量**：`ceil((已喂+本单位)/2) − ceil(已喂/2)`；累计应付恰等于批量口径。
   * 缺省 0 即"本次是这一批的第一个单位"。
   */
  alreadyFedRe?: number
}): RuleOutcome<OosResolution> {
  const { assessment } = input

  if (input.action === 'acceptOutOfSupply') {
    if (!assessment.required) return fail('12.0', 'unitDoesNotRequireTraceSupply')
    return succeed('12.6d', {
      action: 'acceptOutOfSupply',
      costT: 0,
      markedOutOfSupply: true,
      holdingsAfter: input.holdings,
      rule: '12.6d',
      detail: '标记为断补（12.6d）⇒ 须按 12.8 掷损耗骰',
    })
  }

  if (assessment.status === 'inSupply') return fail('12.6c', 'onlyWhenNoTraceSupply')
  if (!assessment.canEatOffTheMap) return fail('12.6c', 'cannotEatOffTheMap')

  /*
   * 12.6c：取整作用在**批次 RE 总量**上 ⇒ 本次收费＝批次费率之差（增量）。
   * 逐单位累计 = 一次性批量收费（例：6.5 RE ⇒ 4T），不会出现"逐单位各取整再相加"的偏多。
   */
  const fedBefore = input.alreadyFedRe ?? 0
  const batchCostT =
    eatingOffTheMapCostT(fedBefore + assessment.re) - eatingOffTheMapCostT(fedBefore)
  const costT = batchCostT
  const payment = planSpPayment({ holdings: input.holdings, wantT: costT })
  if (!payment.ok) return payment

  return succeed('12.6c', {
    action: 'eatOffTheMap',
    costT,
    markedOutOfSupply: false,
    holdingsAfter: payment.data.holdingsAfter,
    rule: '12.6c',
    detail:
      `吃图上补给（12.6c）：本批耗 ${costT} T（每 1T 覆盖最多 2RE；` +
      `本批累计 ${fedBefore + assessment.re} RE 按小数向上取整 ⇒ 累计 ${eatingOffTheMapCostT(fedBefore + assessment.re)} T）` +
      `；余额 ${payment.data.holdingsAfter.sp} SP + ${payment.data.holdingsAfter.t} T`,
  })
}

/* ────────────────────────────── 交互状态机（供界面分步引导） ────────────────────────────── */

/**
 * 补给检查的步骤 id
 *
 * 与 C6/C7 同规：`step` 表示**下一步待办**；`beginSupplyCheck` 完成判定后落在分支的第一步。
 * 分支由 12.6 的判定结论决定：有补给可拿 ⇒ `trace`（选来源 → 拖取/投递）；
 * 没有 ⇒ `oos`（吃图上补给 or 接受断补）。
 */
export const SUPPLY_STEP_IDS = ['assess', 'selectSource', 'pickup', 'resolveOos', 'done'] as const
export type SupplyStep = (typeof SUPPLY_STEP_IDS)[number]

/** 步骤中文名（供界面清单） */
export const SUPPLY_STEP_LABELS: Record<SupplyStep, string> = {
  assess: '判定补给状态（12.6）',
  selectSource: '选择来源（12.3a/b）',
  pickup: '拖取 / 投递（12.3）',
  resolveOos: '断补处置（12.6c/d）',
  done: '结束',
}

/** 补给交互的全部累积决策 */
export interface SupplyInteractionState {
  /** 下一步待办 */
  step: SupplyStep
  side: Side
  phase: GamePhase
  unitId: string
  unitHex: HexRef
  /** 12.6：单位补给状态评估（追溯 / 吃图上补给 / 断补） */
  assessment: UnitSupplyAssessment
  /** 分支：`trace`＝有补给可拿；`oos`＝只能吃图上补给或接受断补 */
  branch: 'trace' | 'oos'
  /** 12.3 / 12.6a：可用来源（含距离与路径，供界面可视化） */
  sources: SupplySourceOption[]
  /** 已选来源 */
  chosenSource?: SupplySourceOption
  /** 拖取/投递结论 */
  pickup?: SupplyPickupPlan
  /** 断补处置结论 */
  oos?: OosResolution
  finished: boolean
}

/** 该步骤是否**已到达**（`step` 为「下一步待办」，与 C6/C7 同语义） */
export function hasReachedSupplyStep(state: SupplyInteractionState, step: SupplyStep): boolean {
  return SUPPLY_STEP_IDS.indexOf(state.step) >= SUPPLY_STEP_IDS.indexOf(step)
}

/** 界面用的步骤清单 */
export function supplyStepChecklist(
  state: SupplyInteractionState,
): { step: SupplyStep; label: string; done: boolean }[] {
  return SUPPLY_STEP_IDS.map((step) => ({
    step,
    label: SUPPLY_STEP_LABELS[step],
    done: SUPPLY_STEP_IDS.indexOf(step) < SUPPLY_STEP_IDS.indexOf(state.step),
  }))
}

/**
 * 第 1 步：判定该单位的补给状态（12.6）并给出分支
 *
 * 分支判据**直接取 12.6 的判定结论**（不再另立一套「有没有可用来源」的判据）：
 *   - `inSupply`（12.6 追溯成立）⇒ `trace`：玩家可在来源清单里选一个来源拖取/投递 SP
 *     （12.3a 直接拖取 / 12.3b 指挥部投递），用于燃料、战斗、整备等；
 *   - `canEatOffTheMap` / `outOfSupply`（12.6c/12.6d）⇒ `oos`：走断补处置
 *     （12.6c 吃图上补给 或 12.6d 接受断补）。
 * 非战斗单位（12.0：只有战斗单位需要追溯补给）直接判为 `done`。
 *
 * `sources` 两支都给（供界面把「能拖到哪、投递覆盖到哪」画出来），`ok` 由引擎逐条裁定。
 */
export function beginSupplyCheck(input: {
  side: Side
  phase: GamePhase
  unit: {
    id: string
    side: Side
    hex: HexRef
    isCombat: boolean
    re: number
    mode?: BaseMode
  }
  facts: TraceSupplyFacts
  mobility?: SupplyMobility
  thrownByHq?: boolean
  /** 12.6c：本环节已从**同一补给站**喂过的 RE 总量（批量费率取整用，见 `assessUnitSupply`） */
  alreadyFedRe?: number
}): RuleOutcome<SupplyInteractionState> {
  const assessment = assessUnitSupply(
    input.facts,
    {
      id: input.unit.id,
      side: input.unit.side,
      hex: input.unit.hex,
      isCombat: input.unit.isCombat,
      re: input.unit.re,
      ...(input.unit.mode === undefined ? {} : { mode: input.unit.mode }),
    },
    {
      mobility: input.mobility ?? 'truck',
      ...(input.thrownByHq === undefined ? {} : { thrownByHq: input.thrownByHq }),
      ...(input.alreadyFedRe === undefined ? {} : { alreadyFedRe: input.alreadyFedRe }),
    },
  )

  if (!assessment.required) {
    return succeed('12.0', {
      step: 'done',
      side: input.side,
      phase: input.phase,
      unitId: input.unit.id,
      unitHex: input.unit.hex,
      assessment,
      branch: 'trace',
      sources: [],
      finished: true,
    })
  }

  const sources = supplySourceOptions(input.facts, {
    unit: input.unit,
    ...(input.mobility === undefined ? {} : { mobility: input.mobility }),
    ...(input.thrownByHq === undefined ? {} : { thrownByHq: input.thrownByHq }),
  })
  const branch: SupplyInteractionState['branch'] =
    assessment.status === 'inSupply' ? 'trace' : 'oos'

  return succeed(assessment.rule, {
    step: branch === 'trace' ? 'selectSource' : 'resolveOos',
    side: input.side,
    phase: input.phase,
    unitId: input.unit.id,
    unitHex: input.unit.hex,
    assessment,
    branch,
    sources,
    finished: false,
  })
}

/**
 * 第 2 步：选定一个来源（12.3a/b/c）
 *
 * 只做选择，不改状态。两条前置：来源必须可用（引擎已逐条裁定），且**必须含 SP**
 * （12.1b：拖取的来源只能是补给站；12.3b：投递的来源只能是指挥部）。
 */
export function chooseSupplySource(
  state: SupplyInteractionState,
  input: { index: number },
): RuleOutcome<{ state: SupplyInteractionState }> {
  if (state.step !== 'selectSource') return fail('12.3', `notAtSelectSourceStep:${state.step}`)
  const source = state.sources[input.index]
  if (source === undefined) return fail('12.3', `noSuchSupplySource:${input.index}`)
  if (!source.ok) return fail(source.rule, source.reason ?? 'sourceNotAvailable')
  if (!isSpBearingSource(source.kind)) return fail('12.3a', `sourceHasNoSp:${source.kind}`)
  return succeed('12.3', {
    state: { ...state, chosenSource: source, step: 'pickup' },
  })
}

/** 第 3 步：结算拖取/投递（12.3），产出来源持仓变更 */
export function confirmSupplyPickup(
  state: SupplyInteractionState,
  input: {
    holdings: SpHoldings
    amountT: number
    purpose: SupplyPurpose
    forImmediateUse?: boolean
  },
): RuleOutcome<{ state: SupplyInteractionState; pickup: SupplyPickupPlan }> {
  if (state.step !== 'pickup') return fail('12.3', `notAtPickupStep:${state.step}`)
  if (state.chosenSource === undefined) return fail('12.3', 'noSourceChosen')

  const plan = planSupplyPickup({
    source: state.chosenSource,
    holdings: input.holdings,
    amountT: input.amountT,
    purpose: input.purpose,
    ...(input.forImmediateUse === undefined ? {} : { forImmediateUse: input.forImmediateUse }),
  })
  if (!plan.ok) return plan

  return succeed(plan.data.rule, {
    state: { ...state, pickup: plan.data, step: 'done', finished: true },
    pickup: plan.data,
  })
}

/** 分支 B：断补处置（12.6c 吃图上补给 / 12.6d 接受断补） */
export function confirmOosResolution(
  state: SupplyInteractionState,
  input: {
    holdings: SpHoldings
    action: OosAction
    /** 12.6c：本环节已从同一补给站喂过的 RE 总量（批量费率取增量，见 `planOosResolution`） */
    alreadyFedRe?: number
  },
): RuleOutcome<{ state: SupplyInteractionState; resolution: OosResolution }> {
  if (state.step !== 'resolveOos') return fail('12.6', `notAtOosStep:${state.step}`)

  const plan = planOosResolution({
    assessment: state.assessment,
    action: input.action,
    holdings: input.holdings,
    ...(input.alreadyFedRe === undefined ? {} : { alreadyFedRe: input.alreadyFedRe }),
  })
  if (!plan.ok) return plan

  return succeed(plan.data.rule, {
    state: { ...state, oos: plan.data, step: 'done', finished: true },
    resolution: plan.data,
  })
}
