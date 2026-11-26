import { describe, expect, it } from 'vitest'

import { AI_TRAIN_VERSION } from '@/ai/training/contract'
import { createTrainingEnv } from '@/ai/training/env'

/**
 * 训练环境 S1 回归
 *
 * 只做 `Intro` 的开局 reset / 一步 advance / 再 reset：
 * 不跑完整对局，不进入 `ai-selfplay` 的慢路径。
 */
describe('TrainingEnv', () => {
  it('reset 产出训练观测，且同 seed 两次 reset 字节一致', () => {
    const env = createTrainingEnv({ scenarioId: 'Intro', seed: 20261126 })
    const first = env.reset()
    expect(first.version).toBe(AI_TRAIN_VERSION)
    expect(first.scenarioId).toBe('Intro')
    expect(first.entities.length).toBeGreaterThan(0)
    expect(env.done).toBe(false)

    const second = env.reset()
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(env.steps).toBe(0)
  })

  it('step 推进后可用 observe 取到同源观测；reset 恢复干净局', () => {
    const env = createTrainingEnv({ scenarioId: 'Intro', seed: 20261126 })
    const initial = env.reset()
    const step = env.step({ kind: 'advance' })
    expect(step.done).toBe(false)
    expect(step.info.actionKey).toBe('advance')
    expect(step.observation.version).toBe(AI_TRAIN_VERSION)
    expect(env.steps).toBe(1)
    expect(JSON.stringify(env.observe())).toBe(JSON.stringify(step.observation))

    const reset = env.reset()
    expect(JSON.stringify(reset)).toBe(JSON.stringify(initial))
    expect(env.steps).toBe(0)
  })

  it('maxSteps 截断不依赖会话终止', () => {
    const env = createTrainingEnv({ scenarioId: 'Intro', seed: 20261126, maxSteps: 1 })
    env.reset()
    const step = env.step({ kind: 'wait', reason: '训练截断用例' })
    expect(step.done).toBe(true)
    expect(step.info.truncated).toBe(true)
    expect(() => env.step({ kind: 'advance' })).toThrow(/reset/)
  })

  it('候选表键唯一，且至少给出可执行的 advance', () => {
    const env = createTrainingEnv({ scenarioId: 'Intro', seed: 20261126 })
    env.reset()
    const candidates = env.candidates()
    expect(candidates.length).toBeGreaterThan(0)
    const keys = candidates.map((candidate) => candidate.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const candidate of candidates) {
      expect(candidate.key).toBe(env.actionKey(candidate.action))
    }
    const advance = candidates.find((candidate) => candidate.family === 'advance')
    expect(advance).toBeDefined()
    if (advance === undefined) return
    const result = env.step(advance.action)
    expect(result.info.ok).toBe(true)
  })
})
