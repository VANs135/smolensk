import { describe, expect, it } from 'vitest'

import { chartsTables, rulesConstants } from '@/data'

/**
 * 通规 v4.3 图表页 2 = **印表逐格核对**（2026-11-01）
 *
 * 判据来源：`v4.3 Charts (final)-2 1000.png`（OCS v4.3 Charts and Tables 第 2 页）。
 * 本文件核对：**Capture Table (9.14b/c)** / **Attrition Table (12.8b)** /
 * **Surprise (9.8)** / **Dump Blowing (12.11a)** / **Combat Supply (9.5)**。
 *
 * ★ Attrition 的印表格子印的是**骰点阈值**（不是结果名）：
 *   | Action Rating | 5 | 4 | 3 | 2 | 1 | 0 |
 *   | No Loss   | 2-8  | 2-7  | 2-5  | 2-3  | 2    | -    |
 *   | -1 Step   | 9-10 | 8-9  | 6-7  | 4-5  | 3-4  | 2-3  |
 *   | -2 Steps  | 11   | 10   | 8-9  | 6-7  | 5-6  | 4-5  |
 *   | -4 Steps  | 12   | 11   | 10-11| 8-9  | 7-8  | 6-7  |
 *   | -All Steps| 13+  | 12+  | 12+  | 10+  | 9+   | 8+   |
 *   而工程库把同一张表**展开成 12 行**（行＝骰点 2…12 与 13+）⇒ 本文件用上面的阈值反推 12 行，
 *   与数据逐格比对（已验算：两者完全等价）。
 */

describe('Capture Table（9.14b / 9.14c）', () => {
  it('6 行 × 3 列（Dump / Trucks / Wagons）逐格照印表', () => {
    const table = chartsTables.tables.find((item) => item.id === 'capture')
    expect(table).toBeDefined()
    expect(table!.columns).toEqual([
      'Dump (on ground)',
      'Trucks (and loaded SPs)',
      'Wagons (and loaded SPs)',
    ])
    expect(table!.rows).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(table!.grid).toEqual([
      ['0', '0', '0'],
      ['25', '0', '0'],
      ['25', '25', '25'],
      ['50', '50', '50'],
      ['50', '50', '75'],
      ['75', '75', '100'],
    ])
  })
})

describe('Attrition Table（12.8b）：12 行展开与印表阈值等价', () => {
  /** 印表原文（格子＝骰点阈值），列序 AR 5→0 */
  const PRINTED_THRESHOLDS: readonly (readonly [string, readonly string[]])[] = [
    ['No Loss', ['2-8', '2-7', '2-5', '2-3', '2', '-']],
    ['-1 Step', ['9-10', '8-9', '6-7', '4-5', '3-4', '2-3']],
    ['-2 Steps', ['11', '10', '8-9', '6-7', '5-6', '4-5']],
    ['-4 Steps', ['12', '11', '10-11', '8-9', '7-8', '6-7']],
    ['-All Steps', ['13+', '12+', '12+', '10+', '9+', '8+']],
  ]

  /** 该骰点是否落在印表的这一格里（'2-8' / '11' / '13+' / '-'） */
  function hits(cell: string, die: number): boolean {
    if (cell === '-') return false
    if (cell.endsWith('+')) return die >= Number(cell.slice(0, -1))
    const [lo, hi] = cell.split('-')
    const low = Number(lo)
    const high = hi === undefined ? low : Number(hi)
    return die >= low && die <= high
  }

  it('★ 骰点 2…13+ × AR 5…0 的每一格 = 印表阈值反推的结果', () => {
    const table = chartsTables.tables.find((item) => item.id === 'attrition')
    expect(table).toBeDefined()
    // 列序必须是印表的 AR 5 4 3 2 1 0
    expect(table!.columns).toEqual(['5', '4', '3', '2', '1', '0'])
    expect(table!.rows).toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13+'])

    const dice = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    // 每个 (骰点, AR 列) 扫五个阈值行，取第一个落中的结果
    const derived = dice.map((die) =>
      [0, 1, 2, 3, 4, 5].map((col) => {
        const row = PRINTED_THRESHOLDS.find(([, cells]) => hits(cells[col] ?? '-', die))
        if (row === undefined)
          throw new Error(`印表里 dice=${String(die)} 的 AR 列 ${String(col)} 没有对应结果`)
        return row[0]
      }),
    )
    expect(table!.grid).toEqual(derived)
  })

  it('修正：格中断补军力 ≥5 时 +3', () => {
    expect(rulesConstants.supply.attritionDrm).toEqual({ minSteps: 5, modifier: 3 })
  })
})

describe('Surprise（9.8）', () => {
  it('常规战斗 10+/6-9/≤5，突袭 9+/7-8/≤6（守方在环形工事 −1）', () => {
    const table = chartsTables.tables.find((item) => item.id === 'surprise')
    expect(table).toBeDefined()
    expect(table!.rows).toEqual(['regular', 'overrun'])
    expect(table!.columns).toEqual(['defenderSurprise', 'noSurprise', 'attackerSurprise'])
    expect(table!.grid).toEqual([
      ['<=5', '6-9', '>=10'],
      ['<=6', '7-8', '>=9'],
    ])
    expect(rulesConstants.combat.hedgehogSurpriseDrm).toBe(-1)
  })
})

describe('Dump Blowing（12.11a）', () => {
  it('1 → 25% / 2-3 → 50% / 4-5 → 75% / 6 → 100%', () => {
    expect(rulesConstants.supply.dumpBlowPct).toMatchObject({
      '1': 25,
      '2-3': 50,
      '4-5': 75,
      '6': 100,
    })
  })
})

describe('Combat Supply（9.5）', () => {
  it('攻方 1T/攻击军力；守方 2T/场（≤1 RE 时 1T）；1 SP = 4 T', () => {
    expect(rulesConstants.supply.combatAttackerTPerStep).toBe(1)
    expect(rulesConstants.supply.combatDefenderT).toBe(2)
    expect(rulesConstants.supply.combatDefenderMinT).toBe(1)
    expect(rulesConstants.supply.spToT).toBe(4)
  })
})
