/**
 * sync-arrivals.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const ARRIVALS_VERSION: string

/** 到达卡单个日期块：snake → camelCase */
export function toBlock(block: Record<string, unknown>): Record<string, unknown>

/** 结构化到达单位（roster 展开）：snake → camelCase */
export function toRosterUnit(unit: Record<string, unknown>): Record<string, unknown>

/** 结构化到达分组 */
export function toRosterGroup(group: Record<string, unknown>): Record<string, unknown>

/** 跨栏续排归属裁定：snake → camelCase */
export function toResolvedAssignment(record: Record<string, unknown>): Record<string, unknown>

/** 可变撤离表（3.3c） */
export function toVariableExit(src: Record<string, unknown>): Record<string, unknown>

/** 随机事件表（3.6） */
export function toRandomEvents(src: Record<string, unknown>): Record<string, unknown>

/** 特殊补员表（1.6c） */
export function toSpecialRepl(src: Record<string, unknown>): Record<string, unknown>

/** 组装单方到达表 */
export function buildArrivals(input: {
  arrivalsDb: Record<string, unknown>
  side: 'axis' | 'soviet'
}): Record<string, unknown>
