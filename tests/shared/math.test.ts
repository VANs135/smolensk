import { describe, expect, it } from 'vitest'

import { clamp, floorTo, mean, roundTo, sum } from '@/shared'

describe('clamp', () => {
  it('夹在闭区间内', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(42, 0, 10)).toBe(10)
  })
})

describe('roundTo / floorTo', () => {
  it('按指定小数位取整', () => {
    expect(roundTo(1.2345, 2)).toBe(1.23)
    expect(roundTo(1.2355, 2)).toBe(1.24)
    expect(floorTo(1.2399, 2)).toBe(1.23)
  })
})

describe('sum / mean', () => {
  it('求和（空数组为 0，忽略非有限值）', () => {
    expect(sum([])).toBe(0)
    expect(sum([1, 2, 3])).toBe(6)
    expect(sum([1, Number.NaN, 3])).toBe(4)
  })

  it('求平均（空数组返回 null）', () => {
    expect(mean([])).toBeNull()
    expect(mean([2, 4])).toBe(3)
  })
})
