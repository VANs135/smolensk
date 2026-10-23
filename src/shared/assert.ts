/**
 * 断言工具（src/shared 纯工具）
 *
 * 开发期断言失败即抛出；生产构建默认剔除（vite 标识 __DEV__ 可在此扩展）。
 */

/**
 * 断言条件为真，否则抛出错误。
 * 抛错信息用于定位引擎/UI 的不变量破坏，必须足够具体。
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[assert] ${message}`)
  }
}

/**
 * 穷尽检查：用于 switch 全分支处理后的兜底。
 * 走到这里说明类型联合中有未处理分支，属于编译期契约的运行时护栏。
 */
export function assertNever(value: never): never {
  throw new Error(`[assertNever] 未预期的分支: ${String(value)}`)
}
