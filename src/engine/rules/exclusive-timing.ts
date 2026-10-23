import { rulesConstants } from '@/data'
import type { HexRef, Side } from '@/data'

import { succeed, type RuleOutcome } from '../result-types'
import { isEntryLShutDown, isRailCapBoosted, isSouthSourcesShutDown } from './timing'

/**
 * 专规时点与补给源状态（Smolensk 专规 1.2 / 1.5 / 1.6c / 2.1a / 2.3c / 2.3e / 2.4 / 3.3c / 3.4 / 3.6 / 5.0b）
 *
 * ## 条文依据（逐条给出）
 *   - **1.2 铁路容量**：苏 2→3、轴 0→1，提升日 **19 July**（含勘误：剧本 3/5/7 初值已为 1）；
 *   - **2.1a 补给源关闭**：**Entry L 于 19 July**；**Entry E 及以西所有南缘源于 19 August** 永久关闭；
 *   - **1.6c 特殊补员**：**19 August 起停止**；
 *   - **3.3c 可变撤离**：**19 August 起**每个轴方增援阶段掷；
 *   - **3.6 随机事件**：**19 July – 15 August（含）**每个轴方增援阶段掷；
 *   - **3.4 装甲集群约束**：**19 August 前**生效（含 3.4a/3.4b）；
 *   - **2.3e 苏军作战限制**：**8 月 1 日回合之前**不得用战略模式、不得修环形工事；
 *   - **2.3c 方面军预备队**：**22 July / 1 Aug / 1 Sep** 三批，必须当即领取；
 *   - **2.4 慢动员**：解锁日 **12 / 15 / 19 / 22 July**（表 2-2）；
 *   - **5.0b 提前决胜检查**：**19 August 起**；
 *   - **1.5 天气**：每回合 Pre-Turn 掷（首回合按剧本指定）。
 *
 * ## 设计口径
 *   - 本模块把「什么时候发生什么」集中成**一张日历**，供界面提示与集成测试对账；
 *   - 单点的判据仍以 `timing.ts` 的谓词为唯一实现（本模块只做汇总与补给源状态派生），避免两处口径。
 */

/** 专规时点条目 */
export interface ExclusiveTimingEntry {
  /** ISO 日期 */
  date: string
  /** 机器可读的时点类别 */
  kind:
    | 'railCapBoost'
    | 'supplyShutdownEntryL'
    | 'supplyShutdownSouthWestOfE'
    | 'specialReplEnd'
    | 'variableExitStart'
    | 'randomEventStart'
    | 'randomEventEnd'
    | 'panzerGroupConstraintEnd'
    | 'sovietOperationalLimitsEnd'
    | 'earlyDecisionStart'
    | 'frontalReserves'
    | 'slowMobilizationUnlock'
  rule: string
  detail: string
}

/** 1.2 / 1.6c / 2.1a / 2.3c / 2.3e / 2.4 / 3.3c / 3.4 / 3.6 / 5.0b：专规时点日历 */
export function exclusiveTimingCalendar(): readonly ExclusiveTimingEntry[] {
  const smolensk = rulesConstants.smolensk
  const entries: ExclusiveTimingEntry[] = [
    {
      date: smolensk.railCapBoostDate,
      kind: 'railCapBoost',
      rule: '1.2',
      detail: `铁路容量提升：轴 ${smolensk.railCapBefore.axis}→${smolensk.railCapAfter.axis}、苏 ${smolensk.railCapBefore.soviet}→${smolensk.railCapAfter.soviet}`,
    },
    {
      date: smolensk.supplyShutdown.entryL,
      kind: 'supplyShutdownEntryL',
      rule: '2.1a',
      detail: 'Entry L 永久关闭（不再产出补给源、不再作入场点）',
    },
    {
      date: smolensk.supplyShutdown.southSources,
      kind: 'supplyShutdownSouthWestOfE',
      rule: '2.1a',
      detail: 'Entry E 及以西所有南缘补给源永久关闭',
    },
    {
      date: smolensk.specialReplEndDate,
      kind: 'specialReplEnd',
      rule: '1.6c',
      detail: '特殊补员停止（19 August 及以后不再掷 1.6c）',
    },
    {
      date: smolensk.variableExitStart,
      kind: 'variableExitStart',
      rule: '3.3c',
      detail: '可变撤离开始：每个轴方增援阶段掷 1 骰，直到 SS Reich 或 14 Mtr 被移除',
    },
    {
      date: smolensk.randomEventFrom,
      kind: 'randomEventStart',
      rule: '3.6',
      detail: '轴方随机事件开始（每个轴方增援阶段掷 2 骰）',
    },
    {
      date: smolensk.randomEventTo,
      kind: 'randomEventEnd',
      rule: '3.6',
      detail: '轴方随机事件结束（含本日；此后改由 3.3c 可变撤离接管）',
    },
    {
      date: smolensk.panzerGroupConstraintEnd,
      kind: 'panzerGroupConstraintEnd',
      rule: '3.4',
      detail: '装甲集群分界线与 SP 平分约束失效（Guderian & Hoth 仅 19 August 前生效）',
    },
    {
      date: smolensk.sovietStratModeFrom,
      kind: 'sovietOperationalLimitsEnd',
      rule: '2.3e',
      detail: '苏军作战限制结束：可用战略模式、可修建环形工事',
    },
    {
      date: smolensk.earlyDecisionStart,
      kind: 'earlyDecisionStart',
      rule: '5.0b',
      detail: '提前决胜检查开始',
    },
  ]

  for (const batch of smolensk.frontalReserves.batches) {
    entries.push({
      date: batch.date,
      kind: 'frontalReserves',
      rule: '2.3c',
      detail:
        `方面军预备队第 ${batch.date} 批：${batch.sp} SP ＋ 编制转化（${batch.convertFrom} → ${batch.convertTo}）` +
        ` ＋ 两次免费重建（${batch.freeRebuilds.join('、')}）——**必须当即领取**`,
    })
  }

  for (const row of smolensk.slowMobilization.table) {
    entries.push({
      date: row.date,
      kind: 'slowMobilizationUnlock',
      rule: '2.4',
      detail: `第 ${row.army} 集团军解锁 ${row.unlockDivisions} 个师（玩家在锁定师中自选）`,
    })
  }

  return entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/** 该日生效的专规时点（按日历过滤） */
export function timingsOn(date: string): readonly ExclusiveTimingEntry[] {
  return exclusiveTimingCalendar().filter((entry) => entry.date === date)
}

/* ────────────────────────────── 补给源状态（2.1a / 3.1） ────────────────────────────── */

/** 补给源关闭的判据事实（地图事实由调用方注入） */
export interface SupplyShutdownFacts {
  /** Entry L 的图格（产品数据 map-config.entryHexes.L） */
  entryLHexes: readonly HexRef[]
  /** Entry E 的图格（产品数据 map-config.entryHexes.E） */
  entryEHexes: readonly HexRef[]
  /**
   * 该格是否位于**南缘**
   *
   * ★ 契约是「**没有图内南邻**」，不是「行号最小」：奇数列没有第 0 行（最小行为 1），
   *   按 `row === bounds.rowStart` 判定会漏掉 13.01 / 29.01 这类南缘源。
   *   引擎侧唯一实现见 `hex-geometry.isSouthEdge`。
   */
  isSouthEdge(hex: HexRef): boolean
}

/** 单个补给源的状态 */
export interface SupplySourceStatus {
  hex: HexRef
  side: Side
  /** 该源当日是否仍产出补给 */
  open: boolean
  /** 关闭依据（未关闭为 null） */
  closedBy: 'entryL' | 'southWestOfEntryE' | null
  rule: '2.1a' | '2.1 / 3.1'
  detail: string
}

/**
 * 专规 2.1a：该格是否属「Entry E 及以西」的南缘源
 *
 * 条文为「**Entry E 及以西**所有南缘来源」——「及以西」**含 Entry E 本体**：
 * 数据侧 `supply_sources.json` 给 42.00 / 43.01 / 44.00 三格打了 19 August 的
 * `shutdown` 标记，故判据须覆盖 E 的最大列而不是小于最小列
 * （旧实现用 `hex.col < minCol`，把 E 本体整组漏掉，三格永不关闭）。
 */
export function isWestOfEntryE(hex: HexRef, facts: SupplyShutdownFacts): boolean {
  if (facts.entryEHexes.length === 0) return false
  const maxCol = Math.max(...facts.entryEHexes.map((item) => item.col))
  return facts.isSouthEdge(hex) && hex.col <= maxCol
}

/**
 * 2.1a：逐条给出补给源当日是否仍开放
 *
 * - **Entry L 于 19 July 关闭**；
 * - **Entry E 及以西所有南缘源于 19 August 关闭**；
 * - 本作 2.1a 只约束**苏方**（轴方补给源在 3.1 里没有对应的关闭条款）。
 */
export function supplySourceStatuses(input: {
  side: Side
  date: string
  sources: readonly HexRef[]
  facts: SupplyShutdownFacts
}): readonly SupplySourceStatus[] {
  const same = (a: HexRef, b: HexRef): boolean => a.col === b.col && a.row === b.row
  return input.sources.map((hex) => {
    if (input.side !== 'soviet') {
      return {
        hex,
        side: input.side,
        open: true,
        closedBy: null,
        rule: '2.1 / 3.1',
        detail: `${hex.col}.${hex.row}：轴方补给源无关闭条款（3.1）`,
      }
    }
    const isEntryL = input.facts.entryLHexes.some((item) => same(item, hex))
    if (isEntryL && isEntryLShutDown(input.date)) {
      return {
        hex,
        side: input.side,
        open: false,
        closedBy: 'entryL',
        rule: '2.1a',
        detail: `${hex.col}.${hex.row}（Entry L）：自 ${rulesConstants.smolensk.supplyShutdown.entryL} 起永久关闭（2.1a）`,
      }
    }
    if (isWestOfEntryE(hex, input.facts) && isSouthSourcesShutDown(input.date)) {
      return {
        hex,
        side: input.side,
        open: false,
        closedBy: 'southWestOfEntryE',
        rule: '2.1a',
        detail: `${hex.col}.${hex.row}：Entry E 及以西的南缘源，自 ${rulesConstants.smolensk.supplyShutdown.southSources} 起永久关闭（2.1a）`,
      }
    }
    return {
      hex,
      side: input.side,
      open: true,
      closedBy: null,
      rule: '2.1 / 3.1',
      detail: `${hex.col}.${hex.row}：开放（2.1 / 3.1）`,
    }
  })
}

/** 2.1a：当日仍开放的补给源 */
export function openSupplySources(input: {
  side: Side
  date: string
  sources: readonly HexRef[]
  facts: SupplyShutdownFacts
}): RuleOutcome<readonly HexRef[]> {
  const statuses = supplySourceStatuses(input)
  const open = statuses.filter((item) => item.open).map((item) => item.hex)
  return succeed('2.1a', open)
}

/** 1.2：当日铁路容量（轴/苏）——汇总入口，值取自 rules-constants */
export function railCapacitiesOn(date: string): { axis: number; soviet: number } {
  const table = isRailCapBoosted(date)
    ? rulesConstants.smolensk.railCapAfter
    : rulesConstants.smolensk.railCapBefore
  return { axis: table.axis, soviet: table.soviet }
}

/**
 * 1.8a：拆解单位（拆分团）的算子上限
 *
 * 产品数据（工程库 rules.json → counter_limits）：
 *   轴「28x AR4 + 2x AR5 regiments」、苏「6x AR2 + 2x AR3 regiments」。
 * 供操作台默认填充拆分单位池存量（避免由裁判逐次手输）。
 */
export interface BreakdownPoolEntry {
  ar: number
  count: number
}

/** 1.8a：某方的拆分单位池上限（按 AR 分档） */
export function breakdownPoolLimits(side: Side): readonly BreakdownPoolEntry[] {
  return side === 'axis'
    ? rulesConstants.smolensk.counterLimits.axisBreakdown
    : rulesConstants.smolensk.counterLimits.sovietBreakdown
}

/** 1.8a：某方拆分单位池的**总存量**（各 AR 档之和） */
export function breakdownPoolTotal(side: Side): number {
  return breakdownPoolLimits(side).reduce((sum, entry) => sum + entry.count, 0)
}

/**
 * 3.5 说明：建造标记的初始枚数**不由本模块给出**
 *
 * 3.5 的初设枚数是**剧本数据**（`scenarios.setup.constructionMarkers`：剧本 1/2 = 3、其余 = 0），
 * 按「剧本 > 专规」的层级由剧本层落值，避免在此另立一处判据。
 */

/** 5.0b：该日是否需要进行提前决胜检查 */
export function earlyDecisionCheckDue(date: string): boolean {
  return date >= rulesConstants.smolensk.earlyDecisionStart
}
