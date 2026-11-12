import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { createGameSeed, RNG_ALGORITHM, TEST_FIXED_SEED } from '@/engine/rng'
import { useGameSessionStore, useWorkbenchStore } from '@/stores'

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), game: useGameSessionStore() }
}

/** E4：新局种子（测试固定 / 生产随机）与「开局后锁定」 */
describe('E4：种子可复现与锁定（B2）', () => {
  it('测试环境的默认新局种子固定为 TEST_FIXED_SEED', () => {
    expect(TEST_FIXED_SEED).toBe(20260913)
    expect(createGameSeed()).toBe(TEST_FIXED_SEED)
  })

  it('开局前可改种子；开局后拒绝，且不动会话 RNG', () => {
    const { workbench, game } = newStores()
    expect(workbench.setSeed(12345)).toBe(true)
    expect(workbench.seed).toBe(12345)

    expect(game.setScenarioId('1')).toBe(true)
    expect(game.startGame(workbench.seed)).toBe(true)
    const before = game.session?.state.rng

    expect(workbench.setSeed(999)).toBe(false)
    expect(workbench.seed).toBe(12345)
    expect(game.session?.state.rng).toEqual(before)
    expect(workbench.log.some((entry) => entry.text.includes('对局进行中不能改种子'))).toBe(true)
  })

  it('种子必须为正整数；非法值不落盘', () => {
    const { workbench } = newStores()
    expect(workbench.setSeed(0)).toBe(false)
    expect(workbench.setSeed(Number.NaN)).toBe(false)
    expect(workbench.seed).toBe(TEST_FIXED_SEED)
  })

  it('日志头写种子 / 算法 / 数据契约，且重复调用只留一条', () => {
    const { workbench, game } = newStores()
    expect(workbench.setSeed(777)).toBe(true)
    expect(game.setScenarioId('1')).toBe(true)
    expect(game.startGame(workbench.seed)).toBe(true)

    workbench.recordLogHeader()
    workbench.recordLogHeader()
    const headers = workbench.log.filter((entry) => entry.text.startsWith('本局种子：'))
    expect(headers).toHaveLength(1)
    expect(headers[0]?.text).toContain('777')
    expect(headers[0]?.text).toContain(RNG_ALGORITHM)
    expect(headers[0]?.text).toContain('数据契约')
  })
})
