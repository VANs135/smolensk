import { describe, it } from 'vitest'

import { expectFullTurnSmoke, runFullTurnSmoke } from './full-turn-smoke-harness'

/**
 * P9：剧本 2–7 各自一条完整的「一个回合」冒烟
 *
 * 每条用例独立 `it`，失败标题直接给出剧本号；驱动与判据与剧本 1 共用
 * `full-turn-smoke-harness.ts`（awaiting 应答、损耗分摊落盘、连续多轮不变才判死锁）。
 * 4 继承 3、6 继承 5 的初设/增援差异由各自剧本数据走真实加载路径，不共享夹具状态。
 */
describe('P9：剧本 2–7 完整一回合端到端冒烟', () => {
  it('剧本 2 Short Campaign：A→H 走到第 2 回合', async () => {
    expectFullTurnSmoke(await runFullTurnSmoke('2'))
  }, 60000)

  it('剧本 3 Late July Start：A→H 走到第 2 回合', async () => {
    expectFullTurnSmoke(await runFullTurnSmoke('3'))
  }, 60000)

  it('剧本 4 1st Counteroffensive（继承 3）：A→H 走到第 2 回合', async () => {
    expectFullTurnSmoke(await runFullTurnSmoke('4'))
  }, 60000)

  it('剧本 5 Early August Start：A→H 走到第 2 回合', async () => {
    expectFullTurnSmoke(await runFullTurnSmoke('5'))
  }, 60000)

  it('剧本 6 2nd Counteroffensive（继承 5）：A→H 走到第 2 回合', async () => {
    expectFullTurnSmoke(await runFullTurnSmoke('6'))
  }, 60000)

  it('剧本 7 3rd Counteroffensive：A→H 走到第 2 回合', async () => {
    expectFullTurnSmoke(await runFullTurnSmoke('7'))
  }, 60000)
})
