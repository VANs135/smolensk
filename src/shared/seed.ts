import { TEST_FIXED_SEED } from '@/engine/rng'

/**
 * 新局种子（E4）
 *
 * 属于**应用层策略**而非规则计算，故不放 `engine`（引擎不得触碰时钟 / 浏览器 API）。
 * 测试环境固定为 `TEST_FIXED_SEED`，保证"固定种子 ⇒ 固定骰序"的既有断言不漂移；
 * 生产环境取系统熵（`crypto.getRandomValues`，无 crypto 时退化到时间戳），
 * **不用 `Math.random`**（B2：禁不可复算的随机源）。
 */
export function createGameSeed(): number {
  if (import.meta.env.MODE === 'test') return TEST_FIXED_SEED
  const cryptoApi = globalThis.crypto
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === 'function') {
    const buffer = new Uint32Array(1)
    cryptoApi.getRandomValues(buffer)
    return ((buffer[0] ?? 0) % 2_000_000_000) + 1
  }
  return (Date.now() % 2_000_000_000) + 1
}
