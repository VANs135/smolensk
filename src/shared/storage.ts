/**
 * 键值存储适配器（src/shared 纯工具）
 *
 * 用途：给存档提供「一个能存取字符串的地方」，把浏览器 API 与业务解耦——
 *   - 浏览器里用 `localStorage`（见 `browserStorage()`）；
 *   - 测试与无 localStorage 的环境用 `createMemoryStorage()`；
 *   - 引擎层（src/engine）**不得**引用本文件（它碰浏览器 API，见 CODE_SPEC §2 的依赖方向）。
 *
 * 本文件不含任何规则逻辑，也不做序列化（序列化在 `engine/save-file.ts`）。
 */

/** 键值存储的最小接口（`localStorage` 的子集） */
export interface KeyValueStorage {
  /** 取键值；不存在返回 null */
  getItem(key: string): string | null
  /** 写入键值 */
  setItem(key: string, value: string): void
  /** 删除键（键不存在不报错） */
  removeItem(key: string): void
}

/** 内存实现（测试与无 localStorage 环境；不落盘、进程结束即消失） */
export function createMemoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

/**
 * 取浏览器 `localStorage`；**不可用即返回 null**（不抛错、不兜底）
 *
 * 三种不可用情形：非浏览器环境（无 `globalThis.localStorage`，如 Vitest 的 node 环境）、
 * 隐私模式拒写（`setItem` 抛异常）、配额耗尽。
 * 探测方式：写入并删除一个哨兵键——只有真的能写，才把存储交出去。
 */
export function browserStorage(): KeyValueStorage | null {
  try {
    const storage = globalThis.localStorage as KeyValueStorage | undefined
    if (storage === undefined) return null
    const probe = '__smolensk_storage_probe__'
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return storage
  } catch {
    return null
  }
}
