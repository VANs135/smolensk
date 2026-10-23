import { describe, expect, it } from 'vitest'

import { formatInteger, formatPercent, pad2, truncate } from '@/shared'

describe('formatInteger', () => {
  it('千分位分组', () => {
    expect(formatInteger(12345678)).toBe('12,345,678')
    expect(formatInteger(42)).toBe('42')
  })
})

describe('formatPercent', () => {
  it('按小数位输出百分号', () => {
    expect(formatPercent(0.1234)).toBe('12.3%')
    expect(formatPercent(0.1234, 2)).toBe('12.34%')
  })
})

describe('truncate', () => {
  it('超出长度时加省略号', () => {
    expect(truncate('斯摩棱斯克战役', 4)).toBe('斯摩棱斯…')
    expect(truncate('短文本', 10)).toBe('短文本')
    expect(truncate('任意', 0)).toBe('')
  })
})

describe('pad2', () => {
  it('补足两位', () => {
    expect(pad2(3)).toBe('03')
    expect(pad2(12)).toBe('12')
  })
})
