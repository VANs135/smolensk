import { rulesConstants } from '@/data'

/**
 * Smolensk 专规时点与容量常量（专规 1.0–5.0，含勘误覆盖）
 *
 * 日期统一 ISO（YYYY-MM-DD），可直接字符串比较与计算。
 */

/** 轴方空军盒任务射程 30 格（1.4a） */
export const AXIS_AIR_BOX_RANGE_HEXES = rulesConstants.smolensk.entryRangeAxisHexes

/** 苏方空军盒任务射程 20 格（1.4a） */
export const SOVIET_AIR_BOX_RANGE_HEXES = rulesConstants.smolensk.entryRangeSovietHexes

/** 边缘盒内可追溯补给（1.4b） */
export const EDGE_BOX_TRACE_SUPPLY = rulesConstants.smolensk.edgeBoxTraceSupply

/** 方面军预备队：每次 2 SP（2.3c，勘误覆盖） */
export const FRONTAL_RESERVES_SP = rulesConstants.smolensk.frontalReservesSp

/** 补给缓存：每方每剧本开局 2 枚（1.7） */
export const SUPPLY_CACHE_PER_SIDE = rulesConstants.smolensk.supplyCachePerSide

/** 随机事件期起（3.6：19 Jul–15 Aug，轴方增援阶段掷） */
export const RANDOM_EVENT_FROM = rulesConstants.smolensk.randomEventFrom

/** 随机事件期止 */
export const RANDOM_EVENT_TO = rulesConstants.smolensk.randomEventTo

/** 铁路容量提升日（1.2：轴 0→1、苏 2→3） */
export const RAIL_CAP_BOOST_DATE = rulesConstants.smolensk.railCapBoostDate

/** 可变撤离检查开始日（3.3c：19 Aug 起每回合掷） */
export const VARIABLE_EXIT_START = rulesConstants.smolensk.variableExitStart

/** 提前决胜检查开始日（5.0b） */
export const EARLY_DECISION_START = rulesConstants.smolensk.earlyDecisionStart

/** 特殊补员截止日（1.6c：19 Aug 起不再有） */
export const SPECIAL_REPL_END_DATE = rulesConstants.smolensk.specialReplEndDate

/** 古德里安与霍特约束失效日（3.4：19 Aug） */
export const PANZER_GROUP_CONSTRAINT_END = rulesConstants.smolensk.panzerGroupConstraintEnd

/** 补给源关闭：Entry L 于（2.1a） */
export const SUPPLY_SHUTDOWN_ENTRY_L = rulesConstants.smolensk.supplyShutdown.entryL

/** 补给源关闭：Entry E 及以西南缘于（2.1a） */
export const SUPPLY_SHUTDOWN_SOUTH_SOURCES = rulesConstants.smolensk.supplyShutdown.southSources

/** 天气掷骰：骰数 1（专规 1.5 / 图表 weather 表） */
export const WEATHER_DICE_COUNT = rulesConstants.smolensk.weather.dieCount

/** 天气掷骰：≤1 受限飞行 */
export const WEATHER_LIMITED_FLIGHT_MAX_DICE = rulesConstants.smolensk.weather.limitedFlightMaxDice

/** 天气掷骰：≥2 正常飞行 */
export const WEATHER_NORMAL_FLIGHT_MIN_DICE = rulesConstants.smolensk.weather.normalFlightMinDice

/** 地面天气恒好（本作无地面天气影响，专规 1.5） */
export const WEATHER_GROUND_ALWAYS_GOOD = rulesConstants.smolensk.weather.groundAlwaysGood

/* ── 日期工具函数 ── */

/** ISO 日期比较：a < b（早于） */
export function isBefore(a: string, b: string): boolean {
  return a < b
}

/** ISO 日期比较：a > b（晚于） */
export function isAfter(a: string, b: string): boolean {
  return a > b
}

/** ISO 日期比较：a 在 [from, to] 闭区间内 */
export function isInRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to
}

/** 是否到了铁路容量提升日（1.2） */
export function isRailCapBoosted(date: string): boolean {
  return date >= RAIL_CAP_BOOST_DATE
}

/** 是否到了可变撤离检查开始日（3.3c） */
export function isVariableExitActive(date: string): boolean {
  return date >= VARIABLE_EXIT_START
}

/** 是否到了装甲集群约束失效日（3.4） */
export function isPanzerGroupConstraintLifted(date: string): boolean {
  return date >= PANZER_GROUP_CONSTRAINT_END
}

/** 是否到了补给源 Entry L 关闭日（2.1a） */
export function isEntryLShutDown(date: string): boolean {
  return date >= SUPPLY_SHUTDOWN_ENTRY_L
}

/** 是否到了南方补给源关闭日（2.1a） */
export function isSouthSourcesShutDown(date: string): boolean {
  return date >= SUPPLY_SHUTDOWN_SOUTH_SOURCES
}

/** 特殊补员是否已失效（1.6c） */
export function isSpecialReplAvailable(date: string): boolean {
  return date < SPECIAL_REPL_END_DATE
}

/** 是否在随机事件期内（3.6：19 Jul–15 Aug，本作已失效） */
export function isInRandomEventPeriod(date: string): boolean {
  return isInRange(date, RANDOM_EVENT_FROM, RANDOM_EVENT_TO)
}
