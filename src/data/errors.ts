import type { ZodIssue } from 'zod'

/**
 * 数据加载错误（统一定位）
 *
 * - source：出错数据文件标识（如 `units-axis.json`）
 * - message：预格式化，校验失败时逐条列出「JSON Pointer 字段路径: 原因」，
 *   校验失败可精确定位到字段（如 `/units/2/factors/combat/ar`）。
 */

/** 把 zod issue.path 渲染为 JSON Pointer：/units/0/factors/combat/ar（按 RFC 6901 转义 ~ 与 /） */
export function formatIssuePath(path: readonly (string | number)[]): string {
  const escaped = path.map((segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1'))
  return `/${escaped.join('/')}`
}

/** 单条 issue 的人类可读行：`/meta/version: Invalid literal value...` */
export function formatIssue(issue: ZodIssue): string {
  return `${formatIssuePath(issue.path)}: ${issue.message}`
}

/** 全部 issue 成段：标题 + 每条一行 */
export function formatIssues(issues: readonly ZodIssue[]): string {
  const lines = issues.map(formatIssue)
  return `校验失败 ${lines.length} 处：\n${lines.map((line) => `  - ${line}`).join('\n')}`
}

/** 数据加载统一错误类型 */
export class DataError extends Error {
  /** 出错数据文件标识 */
  readonly source: string
  /** 原始 zod issue 列表（无 issue 时为空数组） */
  readonly issues: readonly ZodIssue[]

  constructor(source: string, message: string, issues: readonly ZodIssue[] = []) {
    super(`[${source}] ${message}`)
    this.name = 'DataError'
    this.source = source
    this.issues = issues
  }
}
