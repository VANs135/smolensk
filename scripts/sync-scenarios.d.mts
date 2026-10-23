/**
 * sync-scenarios.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const SCENARIOS_VERSION: string

/** 天气原文 → 契约枚举 */
export function toFirstWeather(label: string): 'normal' | 'restricted'

/** '每方各 2 枚' → 2 */
export function parseCount(text: unknown): number

/** 卡车满载方式 */
export interface OrganicTrucks {
  mode: 'all_loaded' | 'all_unloaded' | 'choose_loaded'
  count?: number
  raw: string
}

export function parseOrganicTrucks(raw: string): OrganicTrucks

/** 关闭补给源条目：格号字符串 或 {hexId, hexIdUser?, date?, rule?} */
export type ClosedSource = string | { hexId: string }

export function toClosedSource(entry: Record<string, unknown> | string): ClosedSource

/** supply_sources（snake）→ camelCase */
export function toSupplySources(src: Record<string, unknown>): Record<string, unknown>

/** rules_scenarios 单条 → 剧本记录 */
export function toScenario(
  record: Record<string, unknown>,
  item?: Record<string, unknown>,
): Record<string, unknown>

/** 胜利条件：snake → camelCase */
export function toVictory(src: Record<string, unknown>): Record<string, unknown>

/** 组装运行时 scenarios.json */
export function buildScenarios(input: {
  scenariosDb: Record<string, unknown>
  rulesDb: Record<string, unknown>
}): Record<string, unknown>

/** `setup` 里脚本无法从权威库再生的手写块（B0①：必须合并保留） */
export const HAND_WRITTEN_SETUP_KEYS: readonly string[]

/** 把既有产物里的手写块合并回新产物（按剧本 id 对齐，按既有键序保持幂等） */
export function mergeHandWrittenSetup(
  next: Record<string, unknown>,
  existing: Record<string, unknown> | null,
): Record<string, unknown>
