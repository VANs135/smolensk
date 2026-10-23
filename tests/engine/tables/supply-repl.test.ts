import { describe, expect, it } from 'vitest'

import {
  isFreeSpecialReplEligible,
  rebuildLookup,
  replTableRoll,
  specialReplRoll,
  supplyTableRoll,
  TableLookupError,
} from '@/engine/tables'

/**
 * A7.3 补给/补员/特殊补员/重建费用取数黄金样本（数据源 charts-supply-repl.json）
 */

describe('supplyTableRoll（1.6b 补给表）', () => {
  it('轴方掷 2d6 按档返回 SP', () => {
    expect(supplyTableRoll('axis', false, 2)).toBe(3) // 2-3 → 3
    expect(supplyTableRoll('axis', false, 8)).toBe(7) // 6-8 → 7
    expect(supplyTableRoll('axis', false, 11)).toBe(11) // 11-12 → 11
  })

  it('19 Aug 起取晚档（数值整体下移）', () => {
    expect(supplyTableRoll('axis', true, 2)).toBe(1)
    expect(supplyTableRoll('axis', true, 11)).toBe(5)
    expect(supplyTableRoll('soviet', true, 8)).toBe(5)
    expect(supplyTableRoll('soviet', false, 8)).toBe(9)
  })
})

describe('replTableRoll（1.6b 补员表）', () => {
  it('轴方 11-12 → Ftr2/Tac1/Pax2/Eq1', () => {
    expect(replTableRoll('axis', 12)).toEqual({ ftr: 2, tac: 1, pax: 2, eq: 1, rowLabel: '11-12' })
  })

  it('苏方 9 → Ftr1/Pax2/Eq1，Tac0', () => {
    expect(replTableRoll('soviet', 9)).toEqual({ ftr: 1, tac: 0, pax: 2, eq: 1, rowLabel: '9' })
  })

  it('低段无补员（苏 6 or less → 全 0）', () => {
    expect(replTableRoll('soviet', 5)).toEqual({
      ftr: 0,
      tac: 0,
      pax: 0,
      eq: 0,
      rowLabel: '6 or less',
    })
  })

  it('落空掷骰抛错', () => {
    expect(() => replTableRoll('axis', 20)).toThrow(TableLookupError)
  })
})

describe('specialReplRoll（1.6c 特殊补员表）', () => {
  it('苏方 1-2 → 师+补给缓存；3-6 → 师+警报单位', () => {
    expect(specialReplRoll('soviet', 1).kind).toBe('division_caches')
    expect(specialReplRoll('soviet', 4).kind).toBe('division_alarm')
  })

  it('轴方 1-4 → 补给缓存；5-6 → Aufk/Krd 营', () => {
    expect(specialReplRoll('axis', 3).kind).toBe('supply_cache')
    expect(specialReplRoll('axis', 6).kind).toBe('aufk_krd')
  })

  it('保留卡面原文标签', () => {
    expect(specialReplRoll('soviet', 2).label).toBe('Division & Supply Cache')
  })
})

describe('rebuildLookup（13.5c 重建费用表）', () => {
  it('普通苏军步兵师军力：2x Pax（13-3-3 走通规正常手段）', () => {
    const entry = rebuildLookup('soviet', 'Infantry Div step')
    expect(entry).toEqual({ kind: 'normal', cost: [{ resource: 'pax', amount: 2 }] })
  })

  it('红标（NKVD）苏军师不可重建', () => {
    expect(rebuildLookup('soviet', 'Infantry Div (Red)')).toEqual({ kind: 'none' })
    expect(rebuildLookup('soviet', 'NKVD Border Rgt')).toEqual({ kind: 'none' })
  })

  it('轴方 Aufk/Krd 仅经 1.6c 途径', () => {
    expect(rebuildLookup('axis', 'Aufk (Arm Recon) Bn')).toEqual({ kind: 'special' })
  })

  it('德军 HQ：1x Eq + 1x Pax', () => {
    expect(rebuildLookup('axis', 'HQ (any size or type)')).toEqual({
      kind: 'normal',
      cost: [
        { resource: 'eq', amount: 1 },
        { resource: 'pax', amount: 1 },
      ],
    })
  })

  it('未登记类型返回 null', () => {
    expect(rebuildLookup('soviet', 'Magic Dragon Div')).toBeNull()
  })
})

describe('isFreeSpecialReplEligible（1.6c 免费资格）', () => {
  it('仅 12-2-2 / 11-1-1 / 10-0-1 三型可免费重建', () => {
    expect(isFreeSpecialReplEligible(12, 2, 2)).toBe(true)
    expect(isFreeSpecialReplEligible(11, 1, 1)).toBe(true)
    expect(isFreeSpecialReplEligible(10, 0, 1)).toBe(true)
  })

  it('13-3-3 型绝不走免费途径（走通规正常费用）', () => {
    expect(isFreeSpecialReplEligible(13, 3, 3)).toBe(false)
    expect(isFreeSpecialReplEligible(10, 1, 2)).toBe(false)
    expect(isFreeSpecialReplEligible(2, 1, 3)).toBe(false)
  })
})
