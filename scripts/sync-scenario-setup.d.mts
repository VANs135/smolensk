/**
 * sync-scenario-setup.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const SCENARIO_SETUP_VERSION: string

/** '2.02' → { col: 2, row: 2 }；非格号原文标签返回 null */
export function parseHexRefSafe(text: unknown): { col: number; row: number } | null

/** 位置格号清单 → 可解析的坐标引用 */
export function parseHexRefs(hexes: readonly string[] | undefined): { col: number; row: number }[]

/** 编队下属：snake → camelCase */
export function toSubordinate(sub: Record<string, unknown>): Record<string, unknown>

/** 单条初设条目：snake → camelCase */
export function toSetupEntry(item: Record<string, unknown>): Record<string, unknown>

/** 初设索引语义注记（源 meta） */
export function toSetupNotes(meta: Record<string, unknown>): Record<string, unknown>

/** 组装运行时 scenario-setup.json */
export function buildScenarioSetup(input: {
  setupIndexDb: Record<string, unknown>
}): Record<string, unknown>
