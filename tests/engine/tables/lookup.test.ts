import { describe, expect, it } from 'vitest'

import {
  matchRowIndex,
  resolveLabelColumnIndex,
  resolveNumericColumnIndex,
  TableLookupError,
  toNumericRange,
} from '@/engine/tables'

describe('toNumericRange 标签解析', () => {
  it('支持精确值 / 区间 / 有界 / 无界', () => {
    expect(toNumericRange('4')).toEqual({ min: 4, max: 4 })
    expect(toNumericRange('3-4')).toEqual({ min: 3, max: 4 })
    expect(toNumericRange('1 or less')).toEqual({ min: Number.NEGATIVE_INFINITY, max: 1 })
    expect(toNumericRange('15 or more')).toEqual({ min: 15, max: Number.POSITIVE_INFINITY })
    expect(toNumericRange('117+')).toEqual({ min: 117, max: Number.POSITIVE_INFINITY })
  })

  it('非数值标签返回 null（odds/类别列）', () => {
    expect(toNumericRange('1:2')).toBeNull()
    expect(toNumericRange('Dump (on ground)')).toBeNull()
    expect(toNumericRange('2 aircraft')).toBeNull()
  })
})

describe('行列解析', () => {
  it('按数值匹配行标（区间命中）', () => {
    const rows = ['1 or less', '2', '3-4', '5-7']
    expect(matchRowIndex(rows, 0, 't')).toBe(0)
    expect(matchRowIndex(rows, 2, 't')).toBe(1)
    expect(matchRowIndex(rows, 4, 't')).toBe(2)
    expect(matchRowIndex(rows, 7, 't')).toBe(3)
  })

  it('行标未命中抛 TableLookupError', () => {
    expect(() => matchRowIndex(['2', '4'], 3, 't')).toThrow(TableLookupError)
  })

  it('数值列越界时夹取到最近边界列', () => {
    const columns = ['1 or less', '2', '3-4', '117+']
    expect(resolveNumericColumnIndex(columns, 0, 't')).toBe(0)
    expect(resolveNumericColumnIndex(columns, 3, 't')).toBe(2)
    expect(resolveNumericColumnIndex(columns, 200, 't')).toBe(3) // 超过 117+ → 末列
  })

  it('类别列按标签精确匹配', () => {
    const columns = ['Dump (on ground)', 'Trucks (and loaded SPs)']
    expect(resolveLabelColumnIndex(columns, 'Trucks (and loaded SPs)', 't')).toBe(1)
    expect(() => resolveLabelColumnIndex(columns, 'Tanks', 't')).toThrow(TableLookupError)
  })
})
