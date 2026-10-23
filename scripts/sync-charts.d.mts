/**
 * sync-charts.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const CHARTS_VERSION: string
export const SOURCE_NOTE: string

/** 脚本无法再生成、须自既有产物保留的表（B0①）；消费方见 tables/lookup.ts */
export const PRESERVED_TABLE_IDS: readonly string[]

/** 源库 tables.crt → charts-crt.json */
export function buildChartsCrt(crtSource: Record<string, unknown>): Record<string, unknown>

/** 行主序网格表 */
export function buildGridTable(
  id: string,
  tableSource: Record<string, unknown>,
): Record<string, unknown>

/** 防空任务损失表：3 行 × 6 列 */
export function buildFlakMissionLoss(tableSource: Record<string, unknown>): Record<string, unknown>

/**
 * 源库 tables → charts-tables.json
 *
 * @throws Error 手写表（surprise / attrition）在合并后仍缺失时
 */
export function buildChartsTables(
  tables: Record<string, unknown>,
  existing?: Record<string, unknown> | null,
): Record<string, unknown>
