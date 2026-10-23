/**
 * overwrite-guard.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export type OverwriteDecision =
  | { ok: true; reason: 'firstWrite' | 'unchanged' | 'forced' }
  | { ok: false; reason: 'outputWouldChange' }

export function decideOverwrite(input: {
  nextText: string
  existingText: string | null
  force?: boolean
}): OverwriteDecision

export function refusalLines(input: { outFile: string; preserved?: readonly string[] }): string[]

export function mergeKeepingOrder(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown>
