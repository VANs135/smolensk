import { describe, expect, it } from 'vitest'

import { expectFullTurnSmoke, runFullTurnSmoke } from './full-turn-smoke-harness'

/**
 * P9：剧本 1 的**端到端一回合冒烟**（引擎 + store 驱动，不依赖点击）
 *
 * 初设落位 → A 整备 → B 增援 → C 移动 → D 补给 → E 反应 → F 战斗 → G 进击 → H 清理 → 第 2 回合
 * 这条链在 store 层能不能**自己走完**，且中途不出现「没有合法动作、阶段也不前进」的卡死。
 * 驱动与判据见 `full-turn-smoke-harness.ts`（剧本 2–7 共用同一口径）。
 */
describe('P9：剧本 1 完整一回合端到端冒烟', () => {
  it('初设后从 A 段走到第 2 回合，全程无死锁', async () => {
    const result = await runFullTurnSmoke('1')
    expect(result.stalls, `卡在：${result.stalls.join(' / ')}`).toEqual([])
    expectFullTurnSmoke(result)
  }, 60000)
})
