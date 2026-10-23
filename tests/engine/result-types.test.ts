import { describe, expect, it } from 'vitest'

import { assertNever } from '@/shared'

import { fail, isFailure, isSuccess, succeed } from '@/engine/result-types'
import type { PendingEffect, PendingKind, RuleFailure, RuleOutcome } from '@/engine/result-types'
import type { SessionLogEntry } from '@/engine/state-types'

/**
 * 结果对象与规则引用（B3）测试
 *
 * 校验统一结果形状的两条支路（成功 rule/data/pending、失败 reason/rule）、
 * 判别收窄，以及日志条目对结果形状的承载（CODE_SPEC §7 整局回归比对「结算结果与日志」）。
 */

/** 结果 → 人可读摘要（穷尽 switch：新增分支未处理即编译失败） */
function describeOutcome<T>(outcome: RuleOutcome<T>): string {
  switch (outcome.ok) {
    case true:
      return `成功（依据 ${outcome.rule}）`
    case false:
      return `失败（依据 ${outcome.rule}）：${outcome.reason}`
    default:
      return assertNever(outcome)
  }
}

describe('成功结果（rule / data / pending）', () => {
  it('succeed：ok=true，rule 与 data 原样，pending 缺省为空数组', () => {
    const outcome = succeed('9.9', { result: 'AL1o1 Do1', modifiedDice: 7 })
    expect(outcome.ok).toBe(true)
    expect(outcome.rule).toBe('9.9')
    expect(outcome.data).toEqual({ result: 'AL1o1 Do1', modifiedDice: 7 })
    expect(outcome.pending).toEqual([])
  })

  it('succeed：带待处理项（9.10 选项 / 9.12g 战后推进）', () => {
    const pending: PendingEffect[] = [
      { kind: 'option', unitIds: ['de-pz-3-krd'], rule: '9.10', note: '守方选择撤退或损失 1 军力' },
      { kind: 'advanceAfterCombat', unitIds: ['de-pz-3-krd'], rule: '9.12g' },
    ]
    const outcome = succeed('9.9', { result: 'Ao1 DL1o1' }, pending)
    expect(outcome.pending).toHaveLength(2)
    expect(outcome.pending[0]!.kind).toBe('option')
    expect(outcome.pending[0]!.unitIds).toEqual(['de-pz-3-krd'])
    expect(outcome.pending[1]!.rule).toBe('9.12g')
  })

  it('待处理项词表覆盖已登记的四个规则概念', () => {
    const kinds: PendingKind[] = ['option', 'advanceAfterCombat', 'dg', 'exploit']
    for (const kind of kinds) {
      const effect: PendingEffect = { kind, unitIds: [], rule: '5.10' }
      expect(effect.kind).toBe(kind)
    }
  })
})

describe('失败结果（reason / rule）', () => {
  it('fail：ok=false，只有 rule 与 reason（不带 data / pending）', () => {
    const outcome = fail('6.2', 'prohibited')
    expect(outcome.ok).toBe(false)
    expect(outcome.rule).toBe('6.2')
    expect(outcome.reason).toBe('prohibited')
    expect(outcome).not.toHaveProperty('data')
    expect(outcome).not.toHaveProperty('pending')
  })

  it('原因码为机器可读字符串（各模块自行登记词表）', () => {
    const outcome: RuleFailure = fail('6.2d', 'unknownTerrain')
    expect(typeof outcome.reason).toBe('string')
    expect(outcome.reason).not.toBe('')
  })
})

describe('判别收窄', () => {
  it('isSuccess / isFailure 互斥且可收窄类型', () => {
    const ok = succeed('12.6', { reachable: true })
    const ng = fail('12.6', 'noPath')

    expect(isSuccess(ok)).toBe(true)
    expect(isFailure(ok)).toBe(false)
    expect(isSuccess(ng)).toBe(false)
    expect(isFailure(ng)).toBe(true)

    // 收窄后各支路字段可访问
    if (isSuccess(ok)) expect(ok.data).toEqual({ reachable: true })
    if (isFailure(ng)) expect(ng.reason).toBe('noPath')
  })

  it('统一形状可穷举处理（switch ok）', () => {
    expect(describeOutcome(succeed('1.5', { air: 'normal' }))).toBe('成功（依据 1.5）')
    expect(describeOutcome(fail('16.0', 'noBuilder'))).toBe('失败（依据 16.0）：noBuilder')
  })
})

describe('日志条目结构（承载统一结果形状）', () => {
  it('战斗条目：回合/阶段/方/动作 + 掷骰 + 结果（含规则引用与待处理项）', () => {
    const entry: SessionLogEntry = {
      turn: 5,
      phase: 'combat',
      side: 'axis',
      action: 'combat',
      rolls: [{ count: 2, faces: [3, 4], total: 7 }],
      outcome: succeed('9.9', { result: 'AL1o1 Do1', modifiedDice: 7, odds: '3:1' }, [
        { kind: 'option', unitIds: ['ru-inf-55'], rule: '9.10' },
      ]),
    }

    expect(entry.turn).toBe(5)
    expect(entry.phase).toBe('combat')
    expect(entry.rolls[0]!.total).toBe(7)
    expect(entry.outcome.rule).toBe('9.9')
    expect(isSuccess(entry.outcome)).toBe(true)
    if (isSuccess(entry.outcome)) {
      expect(entry.outcome.pending[0]!.rule).toBe('9.10')
      expect(entry.outcome.data['modifiedDice']).toBe(7)
    }
  })

  it('失败也可入日志（同一形状，便于回归比对）', () => {
    const entry: SessionLogEntry = {
      turn: 2,
      phase: 'movement',
      side: 'soviet',
      action: 'move',
      rolls: [],
      outcome: fail('6.2d', 'prohibited'),
    }
    expect(entry.outcome.ok).toBe(false)
    expect(isFailure(entry.outcome)).toBe(true)
    expect(entry.outcome.rule).toBe('6.2d')
  })
})
