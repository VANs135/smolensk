import { describe, expect, it } from 'vitest'

import { chartsTec } from '@/data'

/**
 * TEC 数据契约测试
 *
 * 判据：charts-tec.json 经管线校验 + 深度冻结后可被引擎索引；
 * 关键单元格（Swamp 的 P/星号、Major River 的 All、Minor River 的 +5）与
 * 已实物核对的规则书/Air Bases 表页一致。
 */
describe('charts-tec.json TEC 表', () => {
  it('表头与枚举完整', () => {
    expect(chartsTec.tec.id).toBe('tec')
    expect(chartsTec.tec.mobilityModes).toEqual(['track', 'truck', 'leg'])
    expect(chartsTec.tec.attackerTypes).toEqual(['armor', 'mech', 'other'])
    expect(chartsTec.tec.combatLines).toEqual(['Open', 'Close', 'Very Close', 'Extr Close'])
    expect(Object.keys(chartsTec.tec.legend)).toHaveLength(4)
  })

  it('13 行地形：7 格内 + 6 格边', () => {
    const features = chartsTec.tec.features
    expect(features).toHaveLength(13)
    expect(features.filter((f) => f.kind === 'hex').map((f) => f.feature)).toEqual([
      'Open',
      'Woods',
      'Forest',
      'Swamp',
      'Village',
      'Minor City',
      'Major City',
    ])
    expect(features.filter((f) => f.kind === 'hexside').map((f) => f.feature)).toEqual([
      'Secondary Road',
      'Track',
      'Railroad',
      'Minor River',
      'Major River',
      'Lake/Blocked',
    ])
  })

  it('MP 值与原表一致', () => {
    const byName = new Map(chartsTec.tec.features.map((f) => [f.feature, f]))
    const mp = (name: string, mobility: 'track' | 'truck' | 'leg') => byName.get(name)!.mp[mobility]

    expect(mp('Open', 'track')).toEqual({ kind: 'fixed', value: 1 })
    expect(mp('Woods', 'track')).toEqual({ kind: 'fixed', value: 2 })
    expect(mp('Woods', 'truck')).toEqual({ kind: 'fixed', value: 3 })
    expect(mp('Forest', 'track')).toEqual({ kind: 'fixed', value: 3 })
    expect(mp('Forest', 'truck')).toEqual({ kind: 'fixed', value: 4 })
    expect(mp('Forest', 'leg')).toEqual({ kind: 'fixed', value: 2 })
    expect(mp('Swamp', 'track')).toEqual({ kind: 'prohibited' })
    expect(mp('Swamp', 'leg')).toEqual({ kind: 'fixed', value: 3 })
    expect(mp('Village', 'leg')).toEqual({ kind: 'otherTerrain' })
    expect(mp('Secondary Road', 'track')).toEqual({ kind: 'fixed', value: 0.5 })
    expect(mp('Minor River', 'truck')).toEqual({ kind: 'delta', value: 5 })
    expect(mp('Minor River', 'leg')).toEqual({ kind: 'delta', value: 1 })
    expect(mp('Major River', 'leg')).toEqual({ kind: 'all' })
    expect(mp('Lake/Blocked', 'leg')).toEqual({ kind: 'prohibited' })
  })

  it('Combat Line 与原表一致', () => {
    const byName = new Map(chartsTec.tec.features.map((f) => [f.feature, f]))
    expect(byName.get('Open')!.combatLine).toBe('Open')
    expect(byName.get('Woods')!.combatLine).toBe('Close')
    expect(byName.get('Forest')!.combatLine).toBe('Close')
    expect(byName.get('Swamp')!.combatLine).toBe('Very Close')
    expect(byName.get('Village')!.combatLine).toBe('Close')
    expect(byName.get('Minor City')!.combatLine).toBe('Very Close')
    expect(byName.get('Major City')!.combatLine).toBe('Extr Close')
    // 格边地形不产生独立战斗线
    for (const name of [
      'Secondary Road',
      'Track',
      'Railroad',
      'Minor River',
      'Major River',
      'Lake/Blocked',
    ]) {
      expect(byName.get(name)!.combatLine).toBe('ot')
    }
  })

  it('倍率的括号与星号（9.4d / 9.1f）', () => {
    const byName = new Map(chartsTec.tec.features.map((f) => [f.feature, f]))

    // Open 的 [x2] 带方括号 → 仅攻方
    expect(byName.get('Open')!.attack.armor).toEqual({
      kind: 'multiplier',
      mult: [2, 1],
      attackerOnly: true,
    })
    // Forest 的 x1/2 不带括号 → 攻防同用
    expect(byName.get('Forest')!.attack.armor).toEqual({
      kind: 'multiplier',
      mult: [1, 2],
      attackerOnly: false,
    })
    // Major City 的 [x1/3] 用约分形式存，避免 1/3 的浮点损失
    expect(byName.get('Major City')!.attack.armor).toEqual({
      kind: 'multiplier',
      mult: [1, 3],
      attackerOnly: false,
    })
    // 星号：格子属性出现在 Swamp / Major River / Lake-Blocked
    expect(byName.get('Swamp')!.hexProperty).toBe(true)
    expect(byName.get('Major River')!.hexProperty).toBe(true)
    expect(byName.get('Lake/Blocked')!.hexProperty).toBe(true)
    expect(byName.get('Open')!.hexProperty).toBeUndefined()
  })

  it('不变量：格内地形必有独立战斗线，格边地形必为 ot', () => {
    for (const f of chartsTec.tec.features) {
      if (f.kind === 'hex') expect(f.combatLine).not.toBe('ot')
      else expect(f.combatLine).toBe('ot')
    }
  })
})
