import { describe, expect, it } from 'vitest'

import { createId, createUuid } from '@/shared'

describe('createId', () => {
  it('包含给定前缀', () => {
    expect(createId('toast')).toMatch(/^toast-/)
  })

  it('同进程内唯一（连续生成 1000 个无重复）', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createId('u')))
    expect(ids.size).toBe(1000)
  })
})

describe('createUuid', () => {
  it('符合 UUID v4 格式', () => {
    const uuid = createUuid()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('每次生成不同', () => {
    const a = createUuid()
    const b = createUuid()
    expect(a).not.toBe(b)
  })
})
