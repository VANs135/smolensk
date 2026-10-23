/**
 * 深度冻结：引擎数据只读保证
 *
 * 规则数值表经管线冻结后交付给引擎，防止任何模块在运行时改写常量——
 * 冻结在严格模式下（本项目 ESM 恒为严格模式）的修改会直接抛 TypeError。
 * 类型层用 DeepReadonly 静态拦截，运行层用 Object.freeze 兜底。
 */

/** 映射类型：递归只读（适用于纯 JSON 数据：object / array / primitive / null） */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

/** 递归冻结对象/数组；纯 JSON 数据无环，无需维护已冻结集合 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value as DeepReadonly<T>
}
