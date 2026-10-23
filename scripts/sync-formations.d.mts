/**
 * sync-formations.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const FORMATIONS_VERSION: string

/** 单条编队：snake → camelCase */
export function toFormation(item: Record<string, unknown>): Record<string, unknown>

/** 组装运行时 formations.json */
export function buildFormations(input: {
  formationsDb: Record<string, unknown>
}): Record<string, unknown>
