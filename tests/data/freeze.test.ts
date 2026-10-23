import { describe, expect, it } from 'vitest'

import { deepFreeze } from '@/data'

describe('deepFreeze', () => {
  it('递归冻结嵌套对象与数组', () => {
    const source = { a: { b: [1, 2, { c: 3 }] } }
    const frozen = deepFreeze(source)

    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.a)).toBe(true)
    expect(Object.isFrozen(frozen.a.b)).toBe(true)
    expect(Object.isFrozen(frozen.a.b[2])).toBe(true)
  })

  it('严格模式下对冻结对象的写入抛 TypeError', () => {
    const frozen = deepFreeze({ level: 1 })
    expect(() => {
      ;(frozen as { level: number }).level = 99
    }).toThrow(TypeError)
  })

  it('原始值与非对象按原样返回（不抛错）', () => {
    expect(deepFreeze(42)).toBe(42)
    expect(deepFreeze(null)).toBeNull()
    expect(deepFreeze('常量')).toBe('常量')
  })
})
