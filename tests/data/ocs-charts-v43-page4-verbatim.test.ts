import { describe, expect, it } from 'vitest'

import { chartsTables, rulesConstants } from '@/data'

/**
 * 通规 v4.3 图表页 4 = **印表逐格核对**（2026-11-01）
 *
 * 判据来源：`v4.3 Charts (final)-4 1000.png`。
 * 本文件核对 **Barrage Table (10.0a)**（含 `Cost` 行）、**Barrage vs Facility (10.0c)**（含 `Cost` 行）、
 * **Density Shifts**（10.0a 表左）、**Additional Shifts**（10.0a 表下）。
 */

describe('Barrage Table（10.0a）', () => {
  it('列头 11 档 + 骰行 2…12（11 行），与印表一致', () => {
    const table = chartsTables.tables.find((item) => item.id === 'barrage')
    expect(table).toBeDefined()
    expect(table!.columns).toEqual([
      '1 or less',
      '2',
      '3-4',
      '5-7',
      '8-11',
      '12-16',
      '17-24',
      '25-40',
      '41-68',
      '69-116',
      '117+',
    ])
    expect(table!.rows).toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
    expect(table!.grid).toHaveLength(11)
    for (const row of table!.grid) expect(row).toHaveLength(11)
  })

  it('Cost 行：1T 1T 2T 2T 2T 3T 3T 4T 6T 8T 10T', () => {
    const table = chartsTables.tables.find((item) => item.id === 'barrage')
    expect(table!.cost).toEqual([1, 1, 2, 2, 2, 3, 3, 4, 6, 8, 10])
  })

  it('首行（骰 2）与末行（骰 12）照印表', () => {
    const table = chartsTables.tables.find((item) => item.id === 'barrage')!
    // 骰 2：除 69-116 / 117+ 为 DG 外全为 `-`
    expect(table.grid[0]).toEqual(['-', '-', '-', '-', '-', '-', '-', '-', '-', 'DG', 'DG'])
    // 骰 12：DG 1/2 1/2 1/2 1/2 1 1 1 1 2 3
    expect(table.grid[10]).toEqual(['DG', '1/2', '1/2', '1/2', '1/2', '1', '1', '1', '1', '2', '3'])
  })
})

describe('Barrage vs Facility（10.0c）', () => {
  it('列头 8 档、6 骰行、Cost 行照印表', () => {
    const table = chartsTables.tables.find((item) => item.id === 'barrage-vs-facility')
    expect(table).toBeDefined()
    expect(table!.columns).toEqual([
      '1 or less',
      '2',
      '3-4',
      '5-10',
      '11-20',
      '21-40',
      '41-80',
      '81+',
    ])
    expect(table!.rows).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(table!.cost).toEqual([1, 1, 1, 1, 2, 4, 6, 8])
    // 骰 1 行：… 41-80 `(5)`、81+ `1 (5)`
    expect(table!.grid[0]).toEqual(['-', '-', '-', '-', '-', '-', '(5)', '1 (5)'])
    // 骰 6 行：(6) * (5) 1 * (5) 1 * (4) 1 * (4) 2 * (4) 2 * (3) 2 * (3)
    expect(table!.grid[5]).toEqual([
      '(6)',
      '* (5)',
      '1 * (5)',
      '1 * (4)',
      '1 * (4)',
      '2 * (4)',
      '2 * (3)',
      '2 * (3)',
    ])
  })
})

describe('Density Shifts（10.0a 表左）', () => {
  it('Left 1（≤1 RE）/ None（>1–3）/ Right 1（>3–4）/ Right 2（>4–5）/ Right 3（>5–6）/ Right 4（>6）', () => {
    expect(rulesConstants.barrage.densityShifts).toEqual([
      { maxRe: 1, shift: -1 },
      { maxRe: 3, shift: 0 },
      { maxRe: 4, shift: 1 },
      { maxRe: 5, shift: 2 },
      { maxRe: 6, shift: 3 },
      { maxRe: null, shift: 4 },
    ])
  })
})

describe('Additional Shifts（10.0a 表下）', () => {
  it('环形工事 −1（任一级）／Close·Very Close −1／Extr Close −2／无观察员 −3／战略模式 +3／全机 10 格内 +1', () => {
    const shifts = rulesConstants.barrage.columnShifts
    expect(shifts.hedgehogAnyLevel).toBe(-1)
    expect(shifts.terrainByCombatLine['Close']).toBe(-1)
    expect(shifts.terrainByCombatLine['Very Close']).toBe(-1)
    expect(shifts.terrainByCombatLine['Extr Close']).toBe(-2)
    expect(shifts.terrainByCombatLine['Open']).toBe(0)
    expect(rulesConstants.barrage.noSpotterShiftLeft).toBe(3)
    expect(shifts.stratModeInHex).toBe(3)
    expect(shifts.allAircraftInShortRange).toBe(1)
    expect(rulesConstants.barrage.shortRangeHexes).toBe(10)
  })

  it('`[1/2]` 的三个"直接判 DG"条件都在（10.0a）：三级以上环形工事 / 空·舰火力 / 无正确观察员', () => {
    expect(rulesConstants.barrage.bracketHedgehogMinLevel).toBe(3)
    // 1/2 掷取整骰：4-6 损 1 步并 DG
    expect(rulesConstants.barrage.halfResultStepLossMinDie).toBe(4)
  })
})
