/**
 * 通用数学工具（src/shared 纯工具）
 *
 * 注意：引擎侧的掷骰、攻防比取整等规则计算不在这里，规则取整语义见引擎，
 * 此处只放与规则无关的通用数值函数。
 */

/** 将值夹在 [min, max] 区间内（闭区间） */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 按指定小数位数四舍五入 */
export function roundTo(value: number, digits = 0): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 按指定小数位数向下取整 */
export function floorTo(value: number, digits = 0): number {
  const factor = 10 ** digits
  return Math.floor(value * factor) / factor
}

/** 求数值之和；忽略非有限元素（空数组时为 0） */
export function sum(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0)
}

/** 求平均值；空数组或全为非有限值时返回 null */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const total = sum(values)
  return total / values.length
}
