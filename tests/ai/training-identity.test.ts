import { describe, expect, it } from 'vitest'

import { createAiMemory, runAiStep, snapshotOf, type AiContext } from '@/ai/driver'
import { AI_ACTION_KINDS, isAiAction, type AiAction } from '@/ai/policy'
import { canonicalActionKeyOf, IDENTITY_ACTION_IDS } from '@/ai/training/action-key'
import { createTrainingIdentity } from '@/ai/training/identity'
import { trainingObservationOf } from '@/ai/training/serialize'
import type { AiStepRecord } from '@/ai/trace'

import { fresh } from '../flows/flow-harness'

/**
 * 训练投影的跨进程复现用例
 *
 * 只跑开局后的十几步：不跑完整对局，不触发 `ai-selfplay` 的 4–5 分钟慢测。
 * 这里钉的是**训练数据的可复现性**，不是 AI 策略强弱：
 * 1. canonical action key 必须把同 kind 不同参数区分开；
 * 2. 快照里的原始 instanceId / dump.id 不得进入训练观测；
 * 3. 同 seed 两套独立 Pinia 的动作 key 与观测字节一致。
 */

const SEED = 20261126

function startIntro(seed: number): AiContext {
  const ctx = fresh()
  ctx.w.seed = seed
  expect(ctx.setup.enterSetup('Intro')).toBe(true)
  expect(ctx.setup.presetSelfSetupNow().remaining).toBe(0)
  expect(ctx.setup.startGameNow()).toBe(true)
  if (ctx.setup.setupDrawEntryVisible) expect(ctx.setup.drawSetupEffectsNow()).toBe(true)
  expect(ctx.setup.startGameNow()).toBe(true)
  return { workbench: ctx.w, session: ctx.g, setup: ctx.setup }
}

function keyOf(action: AiAction, ctx: AiContext): string {
  const identity = createTrainingIdentity(ctx)
  return canonicalActionKeyOf(action, identity.actionIds)
}

describe('canonical action key', () => {
  it('同 kind 的带参动作必须可区分', () => {
    const a = keyOf(
      { kind: 'airMission', target: { col: 1, row: 2 }, aircraftId: 'air-a' },
      startIntro(SEED),
    )
    const b = keyOf(
      { kind: 'airMission', target: { col: 1, row: 3 }, aircraftId: 'air-a' },
      startIntro(SEED),
    )
    const c = keyOf(
      { kind: 'airMission', target: { col: 1, row: 2 }, aircraftId: 'air-b' },
      startIntro(SEED),
    )
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)

    const optionsA = keyOf(
      { kind: 'combatOptions', retreatHexes: 1, lossPoints: 0, ignoreOptions: false },
      startIntro(SEED),
    )
    const optionsB = keyOf(
      { kind: 'combatOptions', retreatHexes: 2, lossPoints: 0, ignoreOptions: false },
      startIntro(SEED),
    )
    expect(optionsA).not.toBe(optionsB)
    expect(optionsA).toBe('combatOptions:1:0:0')
  })

  it('动作全集都能产出 key，且不因未覆盖分支退回泛 kind', () => {
    const ctx = startIntro(SEED)
    const samples: AiAction[] = [
      { kind: 'airMission', target: null, aircraftId: null },
      { kind: 'barrageOutcome', losses: [] },
      { kind: 'combatRetreatPaths', paths: [] },
      { kind: 'combatSupply', side: 'advance', attackerDumpId: null, defenderDumpId: null },
      { kind: 'attritionApply', key: 'x', allocation: [] },
      { kind: 'refitBase', baseId: 'b', aircraftIds: [], dumpId: 'd' },
      { kind: 'rebuild', unitId: 'u', mode: 'dead', hex: null },
    ]
    for (const action of samples) {
      expect(isAiAction(action)).toBe(true)
      expect(keyOf(action, ctx)).toContain(action.kind)
    }
    expect(AI_ACTION_KINDS.length).toBeGreaterThan(30)
  })
})

describe('训练观测的 ID 归一化', () => {
  it('原始实例 id / 补给站 id 不出现在训练观测或动作 key 里', () => {
    const ctx = startIntro(SEED)
    const identity = createTrainingIdentity(ctx)
    const snap = snapshotOf(ctx, createAiMemory(), 'both')
    const observation = trainingObservationOf(snap, identity)
    const json = JSON.stringify(observation)

    const rawUnitIds = ctx.workbench.units.map((unit) => unit.instanceId)
    const rawDumpIds = ctx.workbench.allSpDumps.map((dump) => dump.id)
    for (const raw of [...rawUnitIds, ...rawDumpIds]) {
      expect(json).not.toContain(raw)
    }

    const unit = ctx.workbench.units.find((item) => item.side === 'axis')
    expect(unit).toBeDefined()
    if (unit === undefined) return
    const key = canonicalActionKeyOf(
      { kind: 'moveBegin', unitId: unit.instanceId },
      identity.actionIds,
    )
    expect(key).toContain(identity.stableOf(unit.instanceId))
    expect(key).not.toContain(unit.instanceId)
  })

  it('同 seed 两套独立 Pinia：前 12 步 canonical key 与观测一致', () => {
    const run = (): { keys: string[]; observations: string[] } => {
      const ctx = startIntro(SEED)
      const memory = createAiMemory()
      const identity = createTrainingIdentity(ctx)
      const keys: string[] = []
      const observations: string[] = []
      for (let index = 0; index < 12; index += 1) {
        let record: AiStepRecord | null = null
        const result = runAiStep(ctx, {
          memory,
          control: 'both',
          onStep: (step) => {
            record = step
          },
        })
        identity.refresh()
        if (record !== null) {
          const current: AiStepRecord = record
          keys.push(canonicalActionKeyOf(current.act, identity.actionIds))
          observations.push(JSON.stringify(trainingObservationOf(current.obs, identity)))
        } else {
          keys.push(result.intent)
          observations.push('')
        }
        if (result.intent === 'none' || result.intent === 'wait' || ctx.session.terminated) break
      }
      return { keys, observations }
    }

    const first = run()
    const second = run()
    expect(first.keys.length).toBeGreaterThan(0)
    expect(second.keys).toEqual(first.keys)
    expect(second.observations).toEqual(first.observations)
  })
})

describe('运行时 key 兼容', () => {
  it('identity resolver 保持原样，旧 actionKeyOf 不被训练改造影响', () => {
    expect(IDENTITY_ACTION_IDS.unit('u-a')).toBe('u-a')
    expect(IDENTITY_ACTION_IDS.dump('sp-a')).toBe('sp-a')
  })
})
