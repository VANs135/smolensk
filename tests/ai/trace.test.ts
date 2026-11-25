import { describe, expect, it } from 'vitest'

import { createAiMemory, runAiStep, snapshotOf, type AiContext } from '@/ai/driver'
import { AI_ACTION_KINDS, AI_ACTION_KINDS_COVERED, isAiAction, type AiAction } from '@/ai/policy'
import { AI_IO_VERSION, serializeObservation, type AiStepRecord } from '@/ai/trace'

import { fresh } from '../flows/flow-harness'

/**
 * AI 训练接口的回归（2026-11-25）
 *
 * 钉住三件事：
 * 1. `AI_ACTION_KINDS` 与 `AiAction` 联合**不漏项**（编译期 + 运行时双保险）；
 * 2. 外部策略（`decider`）结构非法时回退脚本策略并标记 `fellBack`，不影响正常步骤；
 * 3. `snapshotOf` 导出、`serializeObservation` 可 JSON 化（`can` 转排序数组）、`onStep` 有记录。
 *
 * 只在开局阶段跑十几步：不跑完整回合，避免变成慢测。
 */

const SEED = 20261125

/**
 * `instanceId` 形如 `u-mwvvfrsr-co`（前缀 + `Date.now()` 的 36 进制 + 序号），跨进程不稳定。
 * 序列比对时把它折成 `<id>`：只比"谁在哪一格做了什么"，不比具体实例。
 */
const ID_TOKEN = /^[a-z]+-[0-9a-z]+-[0-9a-z]+$/

function normalizeIntent(intent: string): string {
  return intent
    .split(':')
    .map((part) => (ID_TOKEN.test(part) ? '<id>' : part))
    .join(':')
}

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

/** 跑 `steps` 步，返回「回合|阶段|环节|行动方|动作」序列（不含 instanceId，跨进程可比） */
function trace(ctx: AiContext, steps: number, onStep?: (record: AiStepRecord) => void): string[] {
  const memory = createAiMemory()
  const out: string[] = []
  for (let index = 0; index < steps; index += 1) {
    const result = runAiStep(ctx, {
      memory,
      control: 'both',
      ...(onStep === undefined ? {} : { onStep }),
    })
    out.push(
      `${String(result.turn)}|${result.phase}|${result.segment}|${result.side}|${normalizeIntent(result.intent)}`,
    )
    if (result.intent === 'none' || result.intent === 'wait' || ctx.session.terminated) break
  }
  return out
}

describe('AI 动作全集与判型', () => {
  it('AI_ACTION_KINDS 覆盖 AiAction 的每一个 kind（漏项即编译失败）', () => {
    type MissingKinds = Exclude<AiAction['kind'], (typeof AI_ACTION_KINDS)[number]>
    const missingKinds: MissingKinds[] = []
    const covered: [MissingKinds] extends [never] ? true : never = true
    expect(covered).toBe(true)
    expect(AI_ACTION_KINDS_COVERED).toBe(true)
    expect(missingKinds).toEqual([])
    expect(new Set(AI_ACTION_KINDS).size).toBe(AI_ACTION_KINDS.length)
  })

  it('isAiAction 只判结构：未知 kind / 非对象一律拒绝', () => {
    expect(isAiAction({ kind: 'advance' })).toBe(true)
    expect(
      isAiAction({ kind: 'combatOptions', retreatHexes: 1, lossPoints: 0, ignoreOptions: false }),
    ).toBe(true)
    expect(isAiAction({ kind: 'bogus' })).toBe(false)
    expect(isAiAction({})).toBe(false)
    expect(isAiAction(null)).toBe(false)
    expect(isAiAction('advance')).toBe(false)
  })
})

describe('观测导出与序列化', () => {
  it('snapshotOf 可导出，serializeObservation 可 JSON 化且 can 为排序数组', () => {
    const ctx = startIntro(SEED)
    const snap = snapshotOf(ctx, createAiMemory(), 'both')
    const serialized = serializeObservation(snap)
    expect(AI_IO_VERSION).toBe(1)
    expect(Array.isArray(serialized.can)).toBe(true)
    const can = serialized.can as string[]
    expect([...can].sort((a, b) => a.localeCompare(b))).toEqual(can)
    expect(() => JSON.stringify(serialized)).not.toThrow()
    expect(serialized.turn).toBe(snap.turn)
    expect(serialized.phase).toBe(snap.phase)
  })
})

describe('外部策略注入', () => {
  it('decider 返回非动作 ⇒ 回退脚本策略并标记 fellBack', () => {
    // 同一颗种子开两局：一局纯脚本，一局挂一个永远返回 null 的 decider
    const plain = startIntro(SEED)
    const plainStep = runAiStep(plain, { memory: createAiMemory(), control: 'both' })

    const broken = startIntro(SEED)
    const brokenStep = runAiStep(broken, {
      memory: createAiMemory(),
      control: 'both',
      decider: () => null as unknown as AiAction,
    })

    expect(brokenStep.fellBack).toBe(true)
    expect(normalizeIntent(brokenStep.intent)).toBe(normalizeIntent(plainStep.intent))
    expect(plainStep.fellBack).toBeUndefined()
  })

  it('decider 抛异常也回退，不把异常抛出驱动', () => {
    const ctx = startIntro(SEED)
    const result = runAiStep(ctx, {
      memory: createAiMemory(),
      control: 'both',
      decider: () => {
        throw new Error('boom')
      },
    })
    expect(result.fellBack).toBe(true)
    expect(result.intent).not.toBe('none')
  })
})

describe('逐步回调与同种子确定性', () => {
  it('onStep 收到记录（act / obs / intent 齐全，obs 可序列化）', () => {
    const ctx = startIntro(SEED)
    const records: AiStepRecord[] = []
    trace(ctx, 8, (record) => records.push(record))
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(typeof record.intent).toBe('string')
      expect(isAiAction(record.act)).toBe(true)
      expect(record.side === 'axis' || record.side === 'soviet').toBe(true)
      expect(() => JSON.stringify(serializeObservation(record.obs))).not.toThrow()
    }
  })

  it('同种子两次：前 12 步的「回合|阶段|环节|行动方|动作」序列一致（实例 id 归一后）', () => {
    const first = trace(startIntro(SEED), 12)
    const second = trace(startIntro(SEED), 12)
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })
})
