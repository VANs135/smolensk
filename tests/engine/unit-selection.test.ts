import { describe, expect, it } from 'vitest'

import { buildUnitSelectionSet } from '@/engine/rules/unit-selection'

describe('通用可选单位清单（用户裁定⑦）', () => {
  it('空输入 ⇒ 三份清单都空', () => {
    const set = buildUnitSelectionSet([])
    expect(set.eligibleIds).toEqual([])
    expect(set.hexes).toEqual([])
    expect(set.byHex).toEqual([])
  })

  it('全部不可选 ⇒ 不给任何格高亮', () => {
    const set = buildUnitSelectionSet([
      { id: 'a', col: 3, row: 5, eligible: false, reason: '不符合条件' },
      { id: 'b', col: 3, row: 5, eligible: false, reason: '不符合条件' },
    ])
    expect(set.eligibleIds).toEqual([])
    expect(set.hexes).toEqual([])
    expect(set.byHex).toEqual([])
  })

  it('同格混选 ⇒ 只列可选子集（不可选者不出现）', () => {
    const set = buildUnitSelectionSet([
      { id: 'ok-1', col: 3, row: 5, eligible: true },
      { id: 'no-1', col: 3, row: 5, eligible: false, reason: '印值不同' },
      { id: 'ok-2', col: 3, row: 5, eligible: true },
    ])
    expect(set.eligibleIds).toEqual(['ok-1', 'ok-2'])
    expect(set.hexes).toEqual([{ col: 3, row: 5 }])
    expect(set.byHex).toEqual([{ col: 3, row: 5, ids: ['ok-1', 'ok-2'] }])
  })

  it('跨格 ⇒ 每格各自一组，按 row、col 升序', () => {
    const set = buildUnitSelectionSet([
      { id: 'c', col: 9, row: 4, eligible: true },
      { id: 'a', col: 2, row: 7, eligible: true },
      { id: 'b', col: 5, row: 4, eligible: true },
      { id: 'x', col: 1, row: 2, eligible: false },
    ])
    expect(set.eligibleIds).toEqual(['c', 'a', 'b'])
    expect(set.hexes).toEqual([
      { col: 5, row: 4 },
      { col: 9, row: 4 },
      { col: 2, row: 7 },
    ])
    expect(set.byHex.map((group) => group.ids)).toEqual([['b'], ['c'], ['a']])
  })

  it('重复 id ⇒ 只算一次', () => {
    const set = buildUnitSelectionSet([
      { id: 'a', col: 1, row: 1, eligible: true },
      { id: 'a', col: 1, row: 1, eligible: true },
    ])
    expect(set.eligibleIds).toEqual(['a'])
    expect(set.byHex).toEqual([{ col: 1, row: 1, ids: ['a'] }])
  })
})
