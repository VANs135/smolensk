import { describe, expect, it } from 'vitest'

import { chartsCrt } from '@/data'
import {
  HEDGEHOG_SURPRISE_DRM,
  clampColumnIndex,
  resolveSurprise,
  surpriseColumnShift,
  surpriseRangeMatches,
} from '@/engine/tables'

/**
 * 奇袭表（9.8）测试
 *
 * 权威来源：英文原版 `OCS_Chartsv4.3.pdf`（经 `ocs-rules-v43` ch17 表 17-8 转录）：
 *   - Overrun Attack：9 or more → 攻方奇袭；6 or less → 守方奇袭
 *   - Regular Attack：10 or more → 攻方奇袭；5 or less → 守方奇袭
 *   - DRM：−1 if defender in Hedgehog（任意等级）
 * 「如果发生奇袭，则掷一枚骰子，并将战斗表上的最终攻防比纵列进行若干列的横移。
 *   向右横移表示攻击方奇袭，向左横移表示防御方奇袭。」（9.8）
 */

describe('9.8 奇袭表：常规战斗的阈值（≥10 攻方 / ≤5 守方）', () => {
  it('未修正掷骰：10–12 攻方奇袭、6–9 无、2–5 守方奇袭', () => {
    expect(resolveSurprise({ die: 12, arDifferential: 0, attackType: 'regular' }).side).toBe(
      'attacker',
    )
    expect(resolveSurprise({ die: 10, arDifferential: 0, attackType: 'regular' }).side).toBe(
      'attacker',
    )
    for (const die of [6, 7, 8, 9])
      expect(resolveSurprise({ die, arDifferential: 0, attackType: 'regular' }).side).toBeNull()
    for (const die of [2, 3, 4, 5])
      expect(resolveSurprise({ die, arDifferential: 0, attackType: 'regular' }).side).toBe(
        'defender',
      )
  })

  it('9.6 的 AR 差直接作为修正（规则书例：AR5 突袭 AR0，掷 8 → 修正 13 ⇒ 攻方奇袭）', () => {
    const lookup = resolveSurprise({ die: 8, arDifferential: 5, attackType: 'overrun' })
    expect(lookup.modifiedDice).toBe(13)
    expect(lookup.side).toBe('attacker')
  })

  it('突袭用另一行：≥9 攻方、≤6 守方、7–8 无', () => {
    expect(resolveSurprise({ die: 9, arDifferential: 0, attackType: 'overrun' }).side).toBe(
      'attacker',
    )
    for (const die of [7, 8])
      expect(resolveSurprise({ die, arDifferential: 0, attackType: 'overrun' }).side).toBeNull()
    expect(resolveSurprise({ die: 6, arDifferential: 0, attackType: 'overrun' }).side).toBe(
      'defender',
    )
    // 同一掷骰在两种攻击类型下可以不同：8 → 常规「无」、突袭「无」；6 → 常规「守方」、突袭「守方」
    expect(resolveSurprise({ die: 9, arDifferential: 0, attackType: 'regular' }).side).toBeNull()
  })

  it('9.8：守方在环形工事内（任意等级）→ 掷骰 −1', () => {
    expect(HEDGEHOG_SURPRISE_DRM).toBe(-1)
    // 掷 6 本无奇袭；−1 后为 5 ⇒ 守方奇袭
    expect(
      resolveSurprise({
        die: 6,
        arDifferential: 0,
        attackType: 'regular',
        defenderInHedgehog: true,
      }).side,
    ).toBe('defender')
    // 掷 10 本为攻方奇袭；−1 后为 9 ⇒ 无奇袭
    expect(
      resolveSurprise({
        die: 10,
        arDifferential: 0,
        attackType: 'regular',
        defenderInHedgehog: true,
      }).side,
    ).toBeNull()
  })

  it('骰值越界与非法攻击类型不静默', () => {
    expect(() =>
      resolveSurprise({ die: 1, arDifferential: 0, attackType: 'regular' }),
    ).toThrowError(/2–12/)
    expect(() =>
      resolveSurprise({ die: 7, arDifferential: 0, attackType: 'nope' as 'regular' }),
    ).toThrowError(/无攻击类型行/)
  })

  it('区间解析：<=N / N-M / >=N', () => {
    expect(surpriseRangeMatches('<=5', 5)).toBe(true)
    expect(surpriseRangeMatches('<=5', 6)).toBe(false)
    expect(surpriseRangeMatches('6-9', 6)).toBe(true)
    expect(surpriseRangeMatches('6-9', 10)).toBe(false)
    expect(surpriseRangeMatches('>=10', 10)).toBe(true)
    expect(surpriseRangeMatches('>=10', 9)).toBe(false)
  })
})

describe('9.8 / 9.1g 横移：方向、骰值与夹取', () => {
  it('攻方奇袭向右（正）、守方奇袭向左（负）、未奇袭不横移', () => {
    expect(surpriseColumnShift({ side: 'attacker', shiftDie: 3 }).shift).toBe(3)
    expect(surpriseColumnShift({ side: 'defender', shiftDie: 6 }).shift).toBe(-6)
    expect(surpriseColumnShift({ side: null }).shift).toBe(0)
  })

  it('发生奇袭却没给横移骰 ⇒ 报错（不静默取 0）', () => {
    expect(() => surpriseColumnShift({ side: 'attacker' })).toThrowError(/横移骰/)
    expect(() => surpriseColumnShift({ side: 'defender', shiftDie: 7 })).toThrowError(/横移骰/)
  })

  it('9.1g：横移超出表范围时用最后一列可用纵列', () => {
    const columns = chartsCrt.crt.terrainColumns.Open ?? []
    expect(columns.length).toBeGreaterThan(6)
    // 规则书例：1:12 的攻击（初始列＝最左列）向右横移 6 列
    const leftmost = 0
    expect(clampColumnIndex(leftmost + 6, columns.length)).toMatchObject({
      index: 6,
      clamped: false,
      rule: '9.1g',
    })
    // 从最右列继续向右 ⇒ 夹回最右列
    const rightmost = columns.length - 1
    expect(clampColumnIndex(rightmost + 3, columns.length)).toMatchObject({
      index: rightmost,
      clamped: true,
    })
    // 向左同理
    expect(clampColumnIndex(-4, columns.length)).toMatchObject({ index: 0, clamped: true })
  })
})
