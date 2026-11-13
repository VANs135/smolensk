import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { railEntrySupplySources } from '@/engine/rules/exclusive-timing'
import type { SupplyShutdownFacts } from '@/engine/rules/exclusive-timing'

/**
 * 12.6a①（用户 2026-11-13 裁定）：铁路补给源
 *   = 允许增援入场的图边铁路格 ∪ 专规/剧本点名的其它源
 *
 * 判据不另立字母清单；2.1a 的关闭照旧生效，且关闭**不把源转归对方**。
 */

const L: HexRef = { col: 20, row: 35 }
const E: HexRef[] = [
  { col: 42, row: 0 },
  { col: 43, row: 1 },
  { col: 44, row: 0 },
]

/** 与 store 的 SHUTDOWN_FACTS 同构；南缘按「没有图内南邻」简化成 row === 0 */
const FACTS: SupplyShutdownFacts = {
  entryLHexes: [L],
  entryEHexes: E,
  isSouthEdge: (hex) => hex.row === 0,
}

/** 字母入场表（`map-config.entryHexes` 同构） */
const ENTRY = {
  axis: { K: [{ col: 1, row: 26 }], J: [{ col: 1, row: 19 }] },
  soviet: { L: [L], A: [{ col: 62, row: 33 }] },
} as const

const RAIL = new Set(['1.19', '62.33', '20.35'])

const call = (input: {
  side: 'axis' | 'soviet'
  date: string
  extras?: readonly HexRef[]
  entry?: Readonly<Record<string, readonly HexRef[] | undefined>>
  rail?: ReadonlySet<string>
}): HexRef[] =>
  railEntrySupplySources({
    side: input.side,
    date: input.date,
    entryHexes: input.entry ?? ENTRY[input.side],
    extraSources: input.extras ?? [],
    isRailHex: (hex) => (input.rail ?? RAIL).has(`${hex.col}.${hex.row}`),
    facts: FACTS,
  })

describe('12.6a① 铁路补给源判据', () => {
  it('图边铁路入场格默认为源（J=1.19；剧本其它源为空）', () => {
    expect(call({ side: 'axis', date: '1941-07-08' })).toEqual([{ col: 1, row: 19 }])
  })

  it('非铁路入场格不算源（K=1.26 无铁路边）', () => {
    expect(call({ side: 'axis', date: '1941-07-08', entry: { K: [{ col: 1, row: 26 }] } })).toEqual(
      [],
    )
  })

  it('剧本额外源生效（4.00 这类无字母的源并入，且与入场格去重）', () => {
    expect(
      call({
        side: 'axis',
        date: '1941-07-08',
        extras: [
          { col: 4, row: 0 },
          { col: 1, row: 19 },
          { col: 4, row: 0 },
        ],
      }),
    ).toEqual([
      { col: 4, row: 0 },
      { col: 1, row: 19 },
    ])
  })

  it('2.1a 关闭后该入场格不再提供源（L=20.35：19 July 起为空）', () => {
    expect(call({ side: 'soviet', date: '1941-07-18' })).toEqual([
      { col: 62, row: 33 },
      { col: 20, row: 35 },
    ])
    expect(call({ side: 'soviet', date: '1941-07-19' })).toEqual([{ col: 62, row: 33 }])
  })

  it('关闭不转归对方：苏方 L 关闭后，轴方名单里不会出现 20.35', () => {
    const axis = call({ side: 'axis', date: '1941-08-19' })
    expect(axis).toEqual([{ col: 1, row: 19 }])
    expect(axis).not.toContainEqual(L)
  })
})
