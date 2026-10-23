/**
 * 类型守卫集合（src/shared 纯工具，无业务逻辑）
 */

/** 是否为字符串 */
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 是否为有限数字（排除 NaN / Infinity） */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 是否为普通对象（非 null、非数组、非函数） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
}

/** 是否为布尔值 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/** 是否为非空字符串（去首尾空白后仍有内容） */
export function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0
}

/** 是否为非负整数（含 0） */
export function isNonNegativeInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0
}
