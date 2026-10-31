import { describe, expect, it } from 'vitest'

import { chartsSupplyRepl } from '@/data'

/**
 * 补给表 / 补员表 / 特殊补员表 = **印表逐格核对**（2026-10-31）
 *
 * 判据来源：`Smolensk Supply & Repl.png`（游戏里由 `panel-scans.json` 的 `supply-repl` 在 supply 屏显示）。
 * 印表原文要点：
 *   · 补给表分 **Early / Late** 两档，表下注明「"Early" is before 19 August / "Late" is on or after 19 August」；
 *   · 补员表下注明「**-1 to rolls on or after 19 August**」；
 *   · 特殊补员（1.6c）：「**Prior to 19 August**, each turn roll a die to check for "free" rebuilds」，
 *     苏方 1-2 = Div & Cache、3-6 = Div & Alarm；轴方 1-4 = Cache、5-6 = Aufk/Krd；
 *     骰面下方印的三枚师算子正是 `12-2-2 / 11-1-1 / 10-0-1`（= 1.6c「免费重建师」的印值资格）。
 *
 * 为什么钉住：这三张表是**每一回合的发钱/发补员**的唯一依据（1.6b / 12.10），
 * 数据错一格就是每回合都错，而且不会报错。行序与格子照印表原样比。
 */

describe('补给表（1.6b）：Early / Late 两档照印表', () => {
  it('轴心国：Early 3/5/7/9/11，Late 1/2/3/4/5', () => {
    expect(chartsSupplyRepl.supply.axis.rows).toEqual(['2-3', '4-5', '6-8', '9-10', '11-12'])
    expect(chartsSupplyRepl.supply.axis.spBefore19Aug).toEqual([3, 5, 7, 9, 11])
    expect(chartsSupplyRepl.supply.axis.spFrom19Aug).toEqual([1, 2, 3, 4, 5])
  })

  it('苏联：Early 5/7/9/11/13，Late 3/4/5/6/7', () => {
    expect(chartsSupplyRepl.supply.soviet.rows).toEqual(['2-3', '4-5', '6-8', '9-10', '11-12'])
    expect(chartsSupplyRepl.supply.soviet.spBefore19Aug).toEqual([5, 7, 9, 11, 13])
    expect(chartsSupplyRepl.supply.soviet.spFrom19Aug).toEqual([3, 4, 5, 6, 7])
  })
})

describe('补员表（1.6b）：Ftr / Tac / Pax / Eq 四列照印表', () => {
  it('轴心国：7 or less / 8 / 9 / 10 / 11-12，19 Aug 起 −1', () => {
    const table = chartsSupplyRepl.repl.axis
    expect(table.rows).toEqual(['7 or less', '8', '9', '10', '11-12'])
    expect(table.columns).toEqual(['Ftr', 'Tac', 'Pax', 'Eq'])
    expect(table.grid).toEqual([
      [0, 0, 0, 0], // 7 or less：- - - -
      [0, 0, 1, 0], // 8：- - 1 -
      [1, 0, 1, 0], // 9：1 - 1 -
      [1, 1, 2, 1], // 10：1 1 2 1
      [2, 1, 2, 1], // 11-12：2 1 2 1
    ])
    expect(table.drmFrom19Aug).toBe(-1)
  })

  it('苏联：6 or less / 7-8 / 9 / 10 / 11-12，19 Aug 起 −1', () => {
    const table = chartsSupplyRepl.repl.soviet
    expect(table.rows).toEqual(['6 or less', '7-8', '9', '10', '11-12'])
    expect(table.columns).toEqual(['Ftr', 'Tac', 'Pax', 'Eq'])
    expect(table.grid).toEqual([
      [0, 0, 0, 0], // 6 or less：- - - -
      [0, 0, 1, 0], // 7-8：- - 1 -
      [1, 0, 2, 1], // 9：1 - 2 1
      [1, 1, 2, 1], // 10：1 1 2 1
      [2, 1, 2, 1], // 11-12：2 1 2 1
    ])
    expect(table.drmFrom19Aug).toBe(-1)
  })
})

describe('特殊补员表（1.6c）：骰面分区照印表', () => {
  it('苏方：1-2 = 师 & 补给缓存；3-6 = 师 & Alarm 单位', () => {
    expect(chartsSupplyRepl.specialRepl.soviet).toEqual([
      { dieFrom: 1, dieTo: 2, resultKind: 'division_caches', label: 'Division & Supply Cache' },
      { dieFrom: 3, dieTo: 6, resultKind: 'division_alarm', label: 'Division & Alarm unit' },
    ])
  })

  it('轴方：1-4 = 补给缓存；5-6 = Aufk/Krd 营', () => {
    expect(chartsSupplyRepl.specialRepl.axis).toEqual([
      { dieFrom: 1, dieTo: 4, resultKind: 'supply_cache', label: 'Supply Cache' },
      { dieFrom: 5, dieTo: 6, resultKind: 'aufk_krd', label: 'Aufk/Krd battalion' },
    ])
  })

  it('1.6c 的免费重建师资格 = 印在骰面下方的那三型（12-2-2 / 11-1-1 / 10-0-1）', () => {
    expect(chartsSupplyRepl.freeSpecialReplFactors).toEqual([
      { attack: 12, ar: 2, ma: 2 },
      { attack: 11, ar: 1, ma: 1 },
      { attack: 10, ar: 0, ma: 1 },
    ])
  })
})
