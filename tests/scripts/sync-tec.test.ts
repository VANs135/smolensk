import { describe, expect, it } from 'vitest'

import {
  buildTecData,
  CITY_FEATURES,
  findTecDifferences,
  parseAttack,
  parseMp,
  sameKeys,
  TEC_DATA_VERSION,
  TEC_LEGEND,
} from '../../scripts/sync-tec.mjs'
import type { RuntimeFeature, TecRow } from '../../scripts/sync-tec.mjs'

/**
 * sync-tec.mjs 转换核心单测（A7.1 收尾）
 *
 * 覆盖：MP / 倍率解析全分支、人工裁定（城市 hexProperty、Swamp 攻方专有、note 继承）、
 * 行到 feature 的结构化转换、一致性护栏的拒绝行为。
 * 注意：本文件的 import 只触达纯函数（脚本含主流程守卫，被 import 时不执行 IO）。
 */

const SAMPLE_ROWS: readonly TecRow[] = [
  {
    feature: 'Open',
    combat_line: 'Open',
    track: 1,
    truck: 1,
    leg: 1,
    armor: '[x2]',
    mech: '[x2]',
    other: 'x1',
  },
  {
    feature: 'Swamp',
    combat_line: 'Very Close',
    track: 'P',
    truck: 'P',
    leg: 3,
    armor: 'x1/2*',
    mech: 'x1/2*',
    other: 'x1*',
  },
  {
    feature: 'Village',
    combat_line: 'Close',
    track: 'ot',
    truck: 'ot',
    leg: 'ot',
    armor: 'x1',
    mech: 'x1',
    other: 'x1',
  },
  {
    feature: 'Minor River',
    combat_line: 'ot',
    track: '+3',
    truck: '+5',
    leg: '+1',
    armor: '[x1/2]',
    mech: '[x1/2]',
    other: '[x1/2]',
  },
  {
    feature: 'Major River',
    combat_line: 'ot',
    track: 'P',
    truck: 'P',
    leg: 'All',
    armor: '[x1/4]*',
    mech: '[x1/3]*',
    other: '[x1/2]*',
  },
]

function featureOf(
  dataset: ReturnType<typeof buildTecData>,
  name: string,
): RuntimeFeature | undefined {
  return dataset.tec.features.find((f) => f.feature === name)
}

describe('parseMp（MP 单元格）', () => {
  it('数字 → fixed；分数 → 定点小数', () => {
    expect(parseMp(1)).toEqual({ kind: 'fixed', value: 1 })
    expect(parseMp('1/2')).toEqual({ kind: 'fixed', value: 0.5 })
  })

  it('P / ot / All 为无值标记；+N 为跨河追加', () => {
    expect(parseMp('P')).toEqual({ kind: 'prohibited' })
    expect(parseMp('ot')).toEqual({ kind: 'otherTerrain' })
    expect(parseMp('All')).toEqual({ kind: 'all' })
    expect(parseMp('+3')).toEqual({ kind: 'delta', value: 3 })
  })

  it('非法值抛错（不静默）', () => {
    expect(() => parseMp('X')).toThrow(/无法解析 MP/)
  })
})

describe('parseAttack（倍率单元格）', () => {
  it('xN 与分数、方括号（攻方专有）', () => {
    expect(parseAttack('x1', 'Open')).toEqual({
      kind: 'multiplier',
      mult: [1, 1],
      attackerOnly: false,
    })
    expect(parseAttack('[x2]', 'Open')).toEqual({
      kind: 'multiplier',
      mult: [2, 1],
      attackerOnly: true,
    })
    expect(parseAttack('x1/2', 'Forest')).toEqual({
      kind: 'multiplier',
      mult: [1, 2],
      attackerOnly: false,
    })
  })

  it("星号不改变 attackerOnly；'ot' → otherTerrain", () => {
    expect(parseAttack('x1/2*', 'Forest')).toEqual({
      kind: 'multiplier',
      mult: [1, 2],
      attackerOnly: false,
    })
    expect(parseAttack('ot', 'Road')).toEqual({ kind: 'otherTerrain' })
  })

  it('人工裁定：Swamp 的倍率按图源视为攻方专有（DB 文本层漏方括号）', () => {
    expect(parseAttack('x1/2*', 'Swamp')).toEqual({
      kind: 'multiplier',
      mult: [1, 2],
      attackerOnly: true,
    })
  })

  it('非法值抛错', () => {
    expect(() => parseAttack('y3', 'Open')).toThrow(/无法解析倍率/)
  })
})

describe('buildTecData（行 → 运行时结构）', () => {
  it('元数据与固定键集合正确（版本对齐数据管线）', () => {
    const data = buildTecData(SAMPLE_ROWS)
    expect(data.meta.version).toBe(TEC_DATA_VERSION)
    expect(data.tec.id).toBe('tec')
    expect(data.tec.mobilityModes).toEqual(['track', 'truck', 'leg'])
    expect(data.tec.combatLines).toEqual(['Open', 'Close', 'Very Close', 'Extr Close'])
    expect(Object.keys(data.tec.legend)).toEqual(Object.keys(TEC_LEGEND))
  })

  it('格内地形与 MP 各分支（Open：fixed；Swamp：prohibited；河流：delta/all）', () => {
    const data = buildTecData(SAMPLE_ROWS)
    const open = featureOf(data, 'Open')!
    expect(open.kind).toBe('hex')
    expect(open.mp.truck).toEqual({ kind: 'fixed', value: 1 })
    expect(open.attack.armor).toEqual({ kind: 'multiplier', mult: [2, 1], attackerOnly: true })

    const swamp = featureOf(data, 'Swamp')!
    expect(swamp.mp.track).toEqual({ kind: 'prohibited' })
    expect(swamp.mp.leg).toEqual({ kind: 'fixed', value: 3 })
    expect(swamp.attack.armor).toEqual({ kind: 'multiplier', mult: [1, 2], attackerOnly: true })

    const river = featureOf(data, 'Major River')!
    expect(river.kind).toBe('hexside')
    expect(river.mp.truck).toEqual({ kind: 'prohibited' })
    expect(river.mp.leg).toEqual({ kind: 'all' })
    expect(river.attack.mech).toEqual({ kind: 'multiplier', mult: [1, 3], attackerOnly: true })
  })

  it('城市为整格属性（hexProperty），星号地形亦为整格属性', () => {
    const data = buildTecData(SAMPLE_ROWS)
    expect(featureOf(data, 'Village')!.hexProperty).toBe(true)
    expect(CITY_FEATURES.has('Minor City')).toBe(true)
    expect(featureOf(data, 'Swamp')!.hexProperty).toBe(true)
    expect(featureOf(data, 'Major River')!.hexProperty).toBe(true)
    expect(featureOf(data, 'Open')!.hexProperty).toBeUndefined()
  })

  it('note 从既有产物继承（人工说明不丢失）', () => {
    const existing: readonly RuntimeFeature[] = [
      {
        feature: 'Swamp',
        kind: 'hex',
        combatLine: 'Very Close',
        hexProperty: true,
        mp: {
          track: { kind: 'prohibited' },
          truck: { kind: 'prohibited' },
          leg: { kind: 'fixed', value: 3 },
        },
        attack: {
          armor: { kind: 'multiplier', mult: [1, 2], attackerOnly: true },
          mech: { kind: 'multiplier', mult: [1, 2], attackerOnly: true },
          other: { kind: 'multiplier', mult: [1, 1], attackerOnly: true },
        },
        note: '人工说明：Track/Truck 列 P → 必须沿路进入',
      },
    ]
    const data = buildTecData(SAMPLE_ROWS, existing)
    expect(featureOf(data, 'Swamp')!.note).toBe('人工说明：Track/Truck 列 P → 必须沿路进入')
  })
})

describe('findTecDifferences（一致性护栏）', () => {
  it('同源生成两次 → 无差异', () => {
    const a = buildTecData(SAMPLE_ROWS)
    const b = buildTecData(SAMPLE_ROWS)
    expect(findTecDifferences(a, b)).toEqual([])
  })

  it('MP 数值被篡改 → 报 features 差异', () => {
    const a = buildTecData(SAMPLE_ROWS)
    const b = buildTecData(SAMPLE_ROWS)
    const tampered: RuntimeFeature[] = b.tec.features.map((f, index) =>
      index === 0 ? { ...f, hexProperty: true } : { ...f },
    )
    const diffs = findTecDifferences(a, { ...b, tec: { ...b.tec, features: tampered } })
    expect(diffs.length).toBeGreaterThan(0)
    expect(diffs[0]).toMatch(/features/)
  })

  it('legend 不同 → 报 legend 差异', () => {
    const a = buildTecData(SAMPLE_ROWS)
    const b = { ...a, tec: { ...a.tec, legend: { ...a.tec.legend, prohibited: '自定义' } } }
    expect(findTecDifferences(a, b)).toContain('legend 与现有产物不一致')
  })

  it('existing 缺失 → 视为不一致（护栏拒绝静默放行）', () => {
    const a = buildTecData(SAMPLE_ROWS)
    expect(findTecDifferences(a, undefined).length).toBeGreaterThan(0)
  })

  it('sameKeys 对键序敏感（契约逐字段严格）', () => {
    expect(sameKeys({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
    expect(sameKeys({ a: 1 }, { a: 2 })).toBe(false)
  })
})
