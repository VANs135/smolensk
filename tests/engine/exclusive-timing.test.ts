import { describe, expect, it } from 'vitest'

import { mapConfig, rulesConstants, scenarios } from '@/data'
import { isSouthEdge } from '@/engine/hex-geometry'
import {
  breakdownPoolLimits,
  breakdownPoolTotal,
  earlyDecisionCheckDue,
  exclusiveTimingCalendar,
  isWestOfEntryE,
  openSupplySources,
  railCapacitiesOn,
  supplySourceStatuses,
  timingsOn,
  type SupplyShutdownFacts,
} from '@/engine/rules'

/**
 * 专规时点与补给源状态（Smolensk 专规 1.2 / 1.6c / 2.1a / 2.3c / 2.3e / 2.4 / 3.3c / 3.4 / 3.6 / 5.0b）
 *
 * 本文件核对「什么时候发生什么」这张日历，以及 2.1a 的补给源关闭判定；
 * 单点判据的唯一实现仍以 `timing.ts` 的谓词为准（本模块只做汇总与状态派生）。
 */

/** 产品数据 map-config.entryHexes（Entry L = 20.35；Entry E = 42.00 / 43.01 / 44.00） */
const FACTS: SupplyShutdownFacts = {
  entryLHexes: [{ col: 20, row: 35 }],
  entryEHexes: [
    { col: 42, row: 0 },
    { col: 43, row: 1 },
    { col: 44, row: 0 },
  ],
  // 南缘用**引擎真实实现**（没有图内南邻），不用 `row === 0`：
  // 奇数列没有第 0 行（最小行为 1），后者会漏掉 13.01 / 29.01 这类南缘源。
  isSouthEdge,
}

describe('专规时点日历', () => {
  it('1.2：铁路容量提升日为 19 July，且给出容量前后值', () => {
    const entry = exclusiveTimingCalendar().find((item) => item.kind === 'railCapBoost')
    expect(entry?.date).toBe('1941-07-19')
    expect(entry?.rule).toBe('1.2')
    expect(entry?.detail).toContain('轴 0→1')
  })

  it('2.1a：Entry L 于 19 July、Entry E 及以西南缘于 19 August 永久关闭', () => {
    const calendar = exclusiveTimingCalendar()
    expect(calendar.find((item) => item.kind === 'supplyShutdownEntryL')?.date).toBe('1941-07-19')
    expect(calendar.find((item) => item.kind === 'supplyShutdownSouthWestOfE')?.date).toBe(
      '1941-08-19',
    )
  })

  it('1.6c / 3.3c / 3.6 / 3.4 / 2.3e / 5.0b：各时点与规则出处', () => {
    const byKind = new Map(exclusiveTimingCalendar().map((item) => [item.kind, item]))
    expect(byKind.get('specialReplEnd')).toMatchObject({ date: '1941-08-19', rule: '1.6c' })
    expect(byKind.get('variableExitStart')).toMatchObject({ date: '1941-08-19', rule: '3.3c' })
    expect(byKind.get('randomEventStart')).toMatchObject({ date: '1941-07-19', rule: '3.6' })
    expect(byKind.get('randomEventEnd')).toMatchObject({ date: '1941-08-15', rule: '3.6' })
    expect(byKind.get('panzerGroupConstraintEnd')).toMatchObject({
      date: '1941-08-19',
      rule: '3.4',
    })
    expect(byKind.get('sovietOperationalLimitsEnd')).toMatchObject({
      date: '1941-08-01',
      rule: '2.3e',
    })
    expect(byKind.get('earlyDecisionStart')).toMatchObject({ date: '1941-08-19', rule: '5.0b' })
  })

  it('2.3c / 2.4：方面军预备队三批与慢动员解锁逐条入历', () => {
    const calendar = exclusiveTimingCalendar()
    const reserves = calendar.filter((item) => item.kind === 'frontalReserves')
    expect(reserves.map((item) => item.date)).toEqual(['1941-07-22', '1941-08-01', '1941-09-01'])
    for (const entry of reserves) expect(entry.detail).toContain('必须当即领取')

    const unlocks = calendar.filter((item) => item.kind === 'slowMobilizationUnlock')
    expect(unlocks.length).toBe(rulesConstants.smolensk.slowMobilization.table.length)
    expect(unlocks[0]?.date).toBe('1941-07-12')
    expect(unlocks[0]?.rule).toBe('2.4')
  })

  it('日历按日期升序（供界面顺扫）', () => {
    const dates = exclusiveTimingCalendar().map((item) => item.date)
    expect([...dates]).toEqual([...dates].sort())
  })

  it('timingsOn：只返回该日生效的条目', () => {
    const onJuly19 = timingsOn('1941-07-19').map((item) => item.kind)
    expect(onJuly19).toContain('railCapBoost')
    expect(onJuly19).toContain('supplyShutdownEntryL')
    expect(onJuly19).toContain('randomEventStart')
    expect(onJuly19).toContain('slowMobilizationUnlock')
    // 7 月 8 日（首回合）没有任何固定时点
    expect(timingsOn('1941-07-08')).toEqual([])
  })
})

describe('2.1a：补给源关闭', () => {
  it('2.1a：「以西」= 南缘且列 ≤ Entry E 的最大列（44），**含 Entry E 本体**', () => {
    expect(isWestOfEntryE({ col: 8, row: 0 }, FACTS)).toBe(true)
    expect(isWestOfEntryE({ col: 41, row: 0 }, FACTS)).toBe(true)
    // ★ Entry E 本体属「Entry E 及以西」：数据侧 supply_sources 给这三格打了 19 August 的
    //   shutdown 标记，故必须关闭（旧实现用 `< minCol` 把整组漏掉）
    expect(isWestOfEntryE({ col: 42, row: 0 }, FACTS)).toBe(true)
    expect(isWestOfEntryE({ col: 43, row: 1 }, FACTS)).toBe(true)
    expect(isWestOfEntryE({ col: 44, row: 0 }, FACTS)).toBe(true)
    // 非南缘不算
    expect(isWestOfEntryE({ col: 8, row: 1 }, FACTS)).toBe(false)
    // E 以东的南缘源不算（剧本里的 51.01 / 56.00 / 58.00）
    expect(isWestOfEntryE({ col: 51, row: 1 }, FACTS)).toBe(false)
    expect(isWestOfEntryE({ col: 56, row: 0 }, FACTS)).toBe(false)
  })

  it('南缘判据：没有图内南邻（奇数列第 1 行也是南缘，偶数列第 1 行不是）', () => {
    // 偶数列有第 0 行
    expect(isSouthEdge({ col: 8, row: 0 })).toBe(true)
    expect(isSouthEdge({ col: 8, row: 1 })).toBe(false)
    // 奇数列没有第 0 行 ⇒ 其南缘是第 1 行（13.01 / 29.01 即此类）
    expect(isSouthEdge({ col: 13, row: 1 })).toBe(true)
    expect(isSouthEdge({ col: 13, row: 2 })).toBe(false)
    expect(isSouthEdge({ col: 29, row: 1 })).toBe(true)
  })

  it('产品数据：1941-08-19 各源按条款分别关闭，与权威库逐格 shutdown 期望一致', () => {
    const facts: SupplyShutdownFacts = {
      entryLHexes: (mapConfig.entryHexes?.L ?? []).map((hex) => ({ ...hex })),
      entryEHexes: (mapConfig.entryHexes?.E ?? []).map((hex) => ({ ...hex })),
      isSouthEdge,
    }
    const live =
      scenarios.scenarios.find((item) => item.id === '1')?.supplySources?.sovietLive ?? []
    const sources = live
      .map((text) => text.split('.').map(Number))
      .filter((pair) => pair.length === 2 && pair.every((n) => Number.isInteger(n)))
      .map(([col, row]) => ({ col: col ?? 0, row: row ?? 0 }))

    // 印刷格号：行号补足两位（13.01 而非 13.1）
    const label = (hex: { col: number; row: number }): string =>
      `${hex.col}.${String(hex.row).padStart(2, '0')}`
    const closedBy = (date: string, clause: string): string[] =>
      supplySourceStatuses({ side: 'soviet', date, sources, facts })
        .filter((item) => item.closedBy === clause)
        .map((item) => label(item.hex))
        .sort()

    // Entry L：19 July 起（与 2.1a 的另一条条款相互独立）
    expect(closedBy('1941-07-18', 'entryL')).toEqual([])
    expect(closedBy('1941-08-18', 'entryL')).toEqual(['20.35'])

    // Entry E 及以西南缘源：19 August 起 —— 7 格，含 Entry E 本体（42.00 / 43.01 / 44.00）
    // 与奇数列第 1 行的南缘源（13.01 / 29.01）；51.01 / 56.00 / 58.00 列号 > 44，不受影响
    expect(closedBy('1941-08-18', 'southWestOfEntryE')).toEqual([])
    expect(closedBy('1941-08-19', 'southWestOfEntryE')).toEqual([
      '13.01',
      '14.00',
      '20.00',
      '29.01',
      '42.00',
      '43.01',
      '44.00',
    ])
    // 两条条款合计 8 格关闭，其余 19 源仍开
    const all = supplySourceStatuses({ side: 'soviet', date: '1941-08-19', sources, facts })
    expect(all.filter((item) => !item.open)).toHaveLength(8)
    expect(all.filter((item) => item.open).map((item) => label(item.hex))).toContain('51.01')
    expect(all.filter((item) => item.open).map((item) => label(item.hex))).toContain('56.00')
  })

  it('2.1a：轴方补给源没有关闭条款（3.1）⇒ 恒为开放', () => {
    const statuses = supplySourceStatuses({
      side: 'axis',
      date: '1941-09-01',
      sources: [{ col: 1, row: 3 }],
      facts: FACTS,
    })
    expect(statuses[0]?.open).toBe(true)
    expect(statuses[0]?.closedBy).toBeNull()
  })

  it('2.1a：Entry L 在 19 July 前开放、当日起关闭', () => {
    const before = supplySourceStatuses({
      side: 'soviet',
      date: '1941-07-15',
      sources: [{ col: 20, row: 35 }],
      facts: FACTS,
    })
    expect(before[0]?.open).toBe(true)

    const on = supplySourceStatuses({
      side: 'soviet',
      date: '1941-07-19',
      sources: [{ col: 20, row: 35 }],
      facts: FACTS,
    })
    expect(on[0]).toMatchObject({ open: false, closedBy: 'entryL', rule: '2.1a' })
  })

  it('2.1a：Entry E 及以西南缘源在 19 August 前开放、当日起关闭', () => {
    const before = supplySourceStatuses({
      side: 'soviet',
      date: '1941-08-15',
      sources: [{ col: 8, row: 0 }],
      facts: FACTS,
    })
    expect(before[0]?.open).toBe(true)

    const after = supplySourceStatuses({
      side: 'soviet',
      date: '1941-08-19',
      sources: [{ col: 8, row: 0 }],
      facts: FACTS,
    })
    expect(after[0]).toMatchObject({ open: false, closedBy: 'southWestOfEntryE', rule: '2.1a' })
  })

  it('2.1a：openSupplySources 只保留仍开放的源（入口关闭 + 南缘关闭 + 仍在用的源）', () => {
    const outcome = openSupplySources({
      side: 'soviet',
      date: '1941-08-19',
      sources: [
        { col: 20, row: 35 }, // Entry L：已关
        { col: 8, row: 0 }, // Entry E 以西的南缘：已关
        { col: 62, row: 16 }, // 东方来源：仍开
      ],
      facts: FACTS,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.data).toEqual([{ col: 62, row: 16 }])
  })
})

describe('1.2 / 1.8a / 5.0b：容量与上限', () => {
  it('1.2：铁路容量在 19 July 提升（轴 0→1、苏 2→3）', () => {
    expect(railCapacitiesOn('1941-07-15')).toEqual({ axis: 0, soviet: 2 })
    expect(railCapacitiesOn('1941-07-19')).toEqual({ axis: 1, soviet: 3 })
  })

  it('1.8a：拆分单位算子池上限（工程库 counter_limits 原样）', () => {
    expect(breakdownPoolLimits('axis')).toEqual([
      { ar: 4, count: 28 },
      { ar: 5, count: 2 },
    ])
    expect(breakdownPoolLimits('soviet')).toEqual([
      { ar: 2, count: 6 },
      { ar: 3, count: 2 },
    ])
    expect(breakdownPoolTotal('axis')).toBe(30)
    expect(breakdownPoolTotal('soviet')).toBe(8)
  })

  it('5.0b：提前决胜检查自 19 August 起', () => {
    expect(earlyDecisionCheckDue('1941-08-15')).toBe(false)
    expect(earlyDecisionCheckDue('1941-08-19')).toBe(true)
  })
})
