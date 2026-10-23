/**
 * 通用格式化工具（src/shared 纯工具，不含规则语义）
 */

/** 千分位分组整数（zh-CN：12,345,678） */
export function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
}

/** 百分比（0.1234 -> "12.3%"）；digits 为小数位 */
export function formatPercent(value: number, digits = 1): string {
  const ratio = value * 100
  return `${ratio.toFixed(digits)}%`
}

/** 超出 maxLength 时以省略号截断 */
export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}…`
}

/** 补零：padStart(2) 的快捷命名（用于序号/回合显示统一两位） */
export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
