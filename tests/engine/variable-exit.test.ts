import { describe, expect, it } from 'vitest'

import {
  rollVariableExit,
  variableExitFormationOf,
  VARIABLE_EXIT_TABLE,
} from '@/engine/rules/variable-exit'
import { VARIABLE_EXIT_START } from '@/engine/rules/timing'

describe('3.3c 可变撤离表', () => {
  it('开始日之前 ⇒ skipped（不掷结果）', () => {
    const result = rollVariableExit(1, '1941-08-01')
    expect(result.kind).toBe('skipped')
    expect(result.active).toBe(false)
    expect(result.removedUnit).toBeUndefined()
  })

  it('开始日当天起 ⇒ 1 命中 SS Reich (all)', () => {
    const result = rollVariableExit(1, VARIABLE_EXIT_START)
    expect(result.kind).toBe('remove')
    expect(result.active).toBe(true)
    expect(result.removedUnit).toBe('SS Reich')
    expect(result.description).toBe(VARIABLE_EXIT_TABLE['1'])
  })

  it('6 命中 14 Mtr (all)', () => {
    const result = rollVariableExit(6, '1941-09-01')
    expect(result.kind).toBe('remove')
    expect(result.removedUnit).toBe('14 Mtr')
  })

  it.each([2, 3, 4, 5])('2–5（骰面 %i）⇒ reroll，不移除任何编队', (die) => {
    const result = rollVariableExit(die, '1941-09-01')
    expect(result.kind).toBe('reroll')
    expect(result.removedUnit).toBeUndefined()
  })

  it('骰面值越界 ⇒ RangeError', () => {
    expect(() => rollVariableExit(0, '1941-09-01')).toThrow(RangeError)
    expect(() => rollVariableExit(7, '1941-09-01')).toThrow(RangeError)
  })
})

describe('3.3c 战役称谓 → 编队代号（精确查表）', () => {
  it('SS Reich → SS-R', () => {
    expect(variableExitFormationOf('SS Reich')).toBe('SS-R')
  })

  it('14 Mtr → 14MTR', () => {
    expect(variableExitFormationOf('14 Mtr')).toBe('14MTR')
  })

  it('未知称谓 ⇒ null（不猜）', () => {
    expect(variableExitFormationOf('14th Motorized')).toBeNull()
    expect(variableExitFormationOf('SS Reich (all)')).toBeNull()
    expect(variableExitFormationOf('')).toBeNull()
  })
})
