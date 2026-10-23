import { describe, expect, it } from 'vitest'

import {
  ATTRITION_DRM,
  attritionColumnIndex,
  attritionDrmFor,
  attritionLookup,
  parseAttritionCell,
} from '@/engine/tables'

/**
 * 损耗表取表（12.8b / 12.8c）测试
 *
 * 权威来源：英文原版 `OCS_Chartsv4.3.pdf`（经 `ocs-rules-v43` ch17 表 17-13 转录）：
 *
 * | AR 5 | 4 | 3 | 2 | 1 | 0 | 结果 |
 * |---|---|---|---|---|---|---|
 * | 2–8 | 2–7 | 2–5 | 2–3 | 2 | – | No Loss |
 * | 9–10 | 8–9 | 6–7 | 4–5 | 3–4 | 2–3 | −1 Step |
 * | 11 | 10 | 8–9 | 6–7 | 5–6 | 4–5 | −2 Steps |
 * | 12 | 11 | 10–11 | 8–9 | 7–8 | 6–7 | −4 Steps |
 * | 13+ | 12+ | 12+ | 10+ | 9+ | 8+ | −All Steps |
 *
 * 掷骰修正：**格中断补军力 ≥5 时 +3**。
 * 下面把上表的**区间**独立重录一遍，逐格与数据文件比对，防止将来改动数据时区间被写错。
 */

/** 每列的行区间 → 结果（steps 或 all） */
type RowRange = { min: number; max: number; steps: number | 'all' }

const EXPECTED: Record<number, RowRange[]> = {
  5: [
    { min: 2, max: 8, steps: 0 },
    { min: 9, max: 10, steps: 1 },
    { min: 11, max: 11, steps: 2 },
    { min: 12, max: 12, steps: 4 },
    { min: 13, max: Number.POSITIVE_INFINITY, steps: 'all' },
  ],
  4: [
    { min: 2, max: 7, steps: 0 },
    { min: 8, max: 9, steps: 1 },
    { min: 10, max: 10, steps: 2 },
    { min: 11, max: 11, steps: 4 },
    { min: 12, max: Number.POSITIVE_INFINITY, steps: 'all' },
  ],
  3: [
    { min: 2, max: 5, steps: 0 },
    { min: 6, max: 7, steps: 1 },
    { min: 8, max: 9, steps: 2 },
    { min: 10, max: 11, steps: 4 },
    { min: 12, max: Number.POSITIVE_INFINITY, steps: 'all' },
  ],
  2: [
    { min: 2, max: 3, steps: 0 },
    { min: 4, max: 5, steps: 1 },
    { min: 6, max: 7, steps: 2 },
    { min: 8, max: 9, steps: 4 },
    { min: 10, max: Number.POSITIVE_INFINITY, steps: 'all' },
  ],
  1: [
    { min: 2, max: 2, steps: 0 },
    { min: 3, max: 4, steps: 1 },
    { min: 5, max: 6, steps: 2 },
    { min: 7, max: 8, steps: 4 },
    { min: 9, max: Number.POSITIVE_INFINITY, steps: 'all' },
  ],
  0: [
    // AR 0 无「无损失」档（原文为 –）：任何掷骰结果都要掉军力
    { min: 2, max: 3, steps: 1 },
    { min: 4, max: 5, steps: 2 },
    { min: 6, max: 7, steps: 4 },
    { min: 8, max: Number.POSITIVE_INFINITY, steps: 'all' },
  ],
}

function expectedFor(ar: number, roll: number): number | 'all' {
  const ranges = EXPECTED[ar]
  if (ranges === undefined) throw new Error(`测试夹具缺 AR ${ar}`)
  for (const range of ranges) {
    if (roll >= range.min && roll <= range.max) return range.steps
  }
  throw new Error(`AR ${ar} 的区间未覆盖掷骰 ${roll}`)
}

describe('损耗表（12.8b）：逐格与英文原版一致', () => {
  it('AR 5/4/3/2/1/0 × 掷骰 2–12 全部命中（无 +3 修正）', () => {
    for (const ar of [5, 4, 3, 2, 1, 0]) {
      for (let die = 2; die <= 12; die += 1) {
        const lookup = attritionLookup(die, ar, 0)
        const expected = expectedFor(ar, die)
        if (expected === 'all') expect(lookup.result).toEqual({ kind: 'allSteps' })
        else expect(lookup.result).toEqual({ kind: 'steps', steps: expected })
      }
    }
  })

  it('列位夹取：AR > 5 取 5 列，AR < 0 取 0 列（表头最高档为 5）', () => {
    expect(attritionColumnIndex(5)).toBe(0)
    expect(attritionColumnIndex(6)).toBe(0)
    expect(attritionColumnIndex(0)).toBe(5)
    expect(attritionColumnIndex(-3)).toBe(5)
  })

  it('12.8b 掷骰修正：格中断补军力 ≥5 时 +3（否则 0）', () => {
    expect(ATTRITION_DRM).toEqual({ minSteps: 5, modifier: 3 })
    expect(attritionDrmFor(4)).toBe(0)
    expect(attritionDrmFor(5)).toBe(3)
    const noDrm = attritionLookup(12, 5, 4)
    expect(noDrm.drm).toBe(0)
    expect(noDrm.modifiedDice).toBe(12)
    expect(noDrm.result).toEqual({ kind: 'steps', steps: 4 }) // AR5 / 12 → −4
    const withDrm = attritionLookup(12, 5, 5)
    expect(withDrm.drm).toBe(3)
    expect(withDrm.modifiedDice).toBe(15) // 夹取到 13+ 行
    expect(withDrm.result).toEqual({ kind: 'allSteps' })
  })

  it('结果解析：No Loss / −N Steps / −All Steps', () => {
    expect(parseAttritionCell('No Loss')).toEqual({ kind: 'steps', steps: 0 })
    expect(parseAttritionCell('-1 Step')).toEqual({ kind: 'steps', steps: 1 })
    expect(parseAttritionCell('-2 Steps')).toEqual({ kind: 'steps', steps: 2 })
    expect(parseAttritionCell('-4 Steps')).toEqual({ kind: 'steps', steps: 4 })
    expect(parseAttritionCell('-All Steps')).toEqual({ kind: 'allSteps' })
    expect(() => parseAttritionCell('???')).toThrowError(/无法解析损耗格值/)
  })

  it('骰值越界与非有限 AR 报错（不静默）', () => {
    expect(() => attritionLookup(1, 3, 0)).toThrowError(/2–12/)
    expect(() => attritionLookup(13, 3, 0)).toThrowError(/2–12/)
    expect(() => attritionColumnIndex(Number.POSITIVE_INFINITY)).toThrowError(/有限数/)
  })
})
