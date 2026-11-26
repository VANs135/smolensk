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
    expect(step.info.stateChanged).toBe(true)
    expect(step.info.noop).toBe(false)
    expect(step.observation.version).toBe(AI_TRAIN_VERSION)
    expect(env.steps).toBe(1)
    expect(JSON.stringify(env.observe())).toBe(JSON.stringify(step.observation))

    const reset = env.reset()
    expect(JSON.stringify(reset)).toBe(JSON.stringify(initial))
    expect(env.steps).toBe(0)
  })

  it('wait 被识别为 noop；连续空转达到上限即 stalled', () => {
    const env = createTrainingEnv({
      scenarioId: 'Intro',
      seed: 20261126,
      maxNoopSteps: 2,
    })
    env.reset()
    const first = env.step({ kind: 'wait', reason: '空转用例 1' })
    // `wait` 在 driver 里恒为 ok=false，但盘面没有任何变化，仍应计作空转。
    expect(first.info.ok).toBe(false)
    expect(first.info.noop).toBe(true)
    expect(first.info.stateChanged).toBe(false)
    expect(first.info.noopSteps).toBe(1)
    expect(first.done).toBe(false)

    const second = env.step({ kind: 'wait', reason: '空转用例 2' })
    expect(second.info.noop).toBe(true)
    expect(second.info.noopSteps).toBe(2)
    expect(second.info.stalled).toBe(true)
    expect(second.done).toBe(true)
    expect(() => env.step({ kind: 'advance' })).toThrow(/reset/)
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

  it('checkpoint/restore 回同一观测，且恢复后可继续 step', () => {
    const env = createTrainingEnv({ scenarioId: 'Intro', seed: 20261126 })
    const initial = env.reset()
    env.checkpoint()

    const moved = env.step({ kind: 'advance' })
    expect(moved.done).toBe(false)
    expect(env.steps).toBe(1)
    expect(JSON.stringify(env.observe())).not.toBe(JSON.stringify(initial))

    env.restoreCheckpoint()
    expect(env.steps).toBe(0)
    expect(env.done).toBe(false)
    expect(JSON.stringify(env.observe())).toBe(JSON.stringify(initial))

    const again = env.step({ kind: 'advance' })
    expect(again.info.actionKey).toBe('advance')
    expect(again.done).toBe(false)
  })

  it('checkpoint 可截断后恢复 done 标记', () => {
    const env = createTrainingEnv({ scenarioId: 'Intro', seed: 20261126, maxSteps: 1 })
    env.reset()
    env.checkpoint()
    const truncated = env.step({ kind: 'wait', reason: '训练截断用例' })
    expect(truncated.done).toBe(true)

    env.restoreCheckpoint()
    expect(env.done).toBe(false)
    expect(() => env.step({ kind: 'advance' })).not.toThrow()
  })
})
