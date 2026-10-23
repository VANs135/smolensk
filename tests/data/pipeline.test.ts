import { describe, expect, it } from 'vitest'

import { bootstrapData, DATA_VERSION, DataError, validateData } from '@/data'
import { UnitsDataSchema } from '@/data/schema'

const compliant = {
  meta: { version: DATA_VERSION },
  units: [
    { id: 'de-pz-3', side: 'axis', status: 'classified' },
    {
      id: 'su-rifle-186',
      side: 'soviet',
      status: 'valued',
      factors: { combat: { attack: 4, ar: 3, ma: 4 } },
    },
  ],
}

describe('validateData', () => {
  it('合规数据通过校验', () => {
    const data = validateData(compliant, UnitsDataSchema, 'units-axis.json')
    expect(data.units).toHaveLength(2)
  })

  it('校验失败抛出 DataError，message 可定位到字段（JSON Pointer）', () => {
    const bad = {
      meta: { version: DATA_VERSION },
      units: [{ id: 'de-pz-3', side: 'west', status: 'classified' }],
    }
    let caught: unknown
    try {
      validateData(bad, UnitsDataSchema, 'units-axis.json')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DataError)
    if (caught instanceof DataError) {
      expect(caught.source).toBe('units-axis.json')
      expect(caught.message).toContain('/units/0/side')
      expect(caught.issues.length).toBeGreaterThan(0)
    }
  })

  it('缺失必填字段时路径指向缺失字段本身', () => {
    const bad = { meta: { version: DATA_VERSION }, units: [{ side: 'axis' }] }
    expect(() => validateData(bad, UnitsDataSchema, 'units-axis.json')).toThrow(/units\/0\/id/)
  })

  it('版本不匹配抛出 DataError（指向 /meta/version）', () => {
    const stale = { meta: { version: '9.9.9' }, units: [] }
    let caught: unknown
    try {
      validateData(stale, UnitsDataSchema, 'units-axis.json')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DataError)
    if (caught instanceof DataError) {
      expect(caught.message).toContain('版本不匹配')
      expect(caught.message).toContain('9.9.9')
    }
  })

  it('版本缺失同样判定不匹配', () => {
    const noVersion = { meta: {}, units: [] }
    expect(() => validateData(noVersion, UnitsDataSchema, 'units-axis.json')).toThrow(/版本不匹配/)
  })
})

describe('bootstrapData', () => {
  it('校验并深度冻结返回只读数据', () => {
    const frozen = bootstrapData(compliant, UnitsDataSchema, 'units-axis.json')
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.units)).toBe(true)
    expect(Object.isFrozen(frozen.units[0])).toBe(true)
  })
})
