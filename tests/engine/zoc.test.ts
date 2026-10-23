import { describe, expect, it } from 'vitest'

import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import { isInEnemyZoc, projectsZoc, zocEntryEffect, zocHexes } from '@/engine/rules'
import type { ZocSource } from '@/engine/rules'

/**
 * 控制区 ZOC 判定测试（4.5 / 4.5a / 4.5b）
 *
 * 条文出处：中文规则书 4.5 / 4.5a / 4.5b
 *   - 投射：**战斗模式下的**可攻击单位，且未被标记为断补（4.5）
 *   - 范围：六个相邻格，不论那些格的地形与格边（4.5）
 *   - 抵消：格内友方战斗单位可抵消（4.5b；代价是该单位本阶段起不得再消耗 MP）
 *   - 后果：轮式须停止或突袭，徒步/履带不受影响（4.5a-A）
 *
 * 注：「是否处于战斗模式」由 modes.exertsZoc 裁定（含进击保留基础模式 5.9c、
 * DG 不是战斗模式 5.4a、预备释放后回基础模式 5.7b），本文件只校验三条件的合成。
 */

/** 投射 ZOC 的基准单位（处于战斗模式 + 可攻击 + 有追溯补给） */
const SOURCE: ZocSource = {
  hex: { col: 36, row: 13 },
  side: 'axis',
  attackCapable: true,
  inCombatMode: true,
  hasTraceSupply: true,
}

describe('ZOC 投射条件（4.5）', () => {
  it('可攻击 + 处于战斗模式 + 有追溯补给 → 投射', () => {
    expect(projectsZoc(SOURCE)).toBe(true)
  })

  it('条件任一不满足即不投射（不可攻击 / 非战斗模式 / 断补）', () => {
    expect(projectsZoc({ ...SOURCE, attackCapable: false })).toBe(false)
    // 非战斗模式涵盖：移动模式、预备、战略、DG（均由 modes.exertsZoc 折成 false）
    expect(projectsZoc({ ...SOURCE, inCombatMode: false })).toBe(false)
    expect(projectsZoc({ ...SOURCE, hasTraceSupply: false })).toBe(false)
  })
})

describe('敌方 ZOC 范围（4.5：六个相邻格，不论地形与格边）', () => {
  const source = SOURCE
  const enemy = 'axis' as const

  it('六个相邻格都在敌方 ZOC 内（含越界方向，判定只问相邻）', () => {
    for (const direction of HEX_DIRECTIONS) {
      expect(isInEnemyZoc(neighbor(source.hex, direction), enemy, [source])).toBe(true)
    }
  })

  it('投射单位所在格本身不是敌方 ZOC', () => {
    expect(isInEnemyZoc(source.hex, enemy, [source])).toBe(false)
  })

  it('相隔两格（非相邻）不在敌方 ZOC 内', () => {
    for (const direction of HEX_DIRECTIONS) {
      const twoAway = neighbor(neighbor(source.hex, direction), direction)
      expect(isInEnemyZoc(twoAway, enemy, [source])).toBe(false)
    }
  })

  it('同方单位不构成「敌方」ZOC', () => {
    expect(isInEnemyZoc(neighbor(source.hex, 'N'), 'soviet', [source])).toBe(false)
  })

  it('不投射的敌方单位（断补 / 非战斗模式 / 不可攻击）不构成 ZOC', () => {
    const target = neighbor(source.hex, 'N')
    expect(isInEnemyZoc(target, enemy, [{ ...source, hasTraceSupply: false }])).toBe(false)
    expect(isInEnemyZoc(target, enemy, [{ ...source, inCombatMode: false }])).toBe(false)
    expect(isInEnemyZoc(target, enemy, [{ ...source, attackCapable: false }])).toBe(false)
  })
})

describe('ZOC 抵消（4.5b）', () => {
  it('格内有己方战斗单位即抵消该格敌方 ZOC（任何模式皆可，且该单位不必投射 ZOC）', () => {
    const target = neighbor(SOURCE.hex, 'NE')
    expect(isInEnemyZoc(target, 'axis', [SOURCE])).toBe(true)
    expect(isInEnemyZoc(target, 'axis', [SOURCE], { friendlyCombatUnitInHex: true })).toBe(false)
  })
})

describe('某方 ZOC 覆盖格集合（4.5）', () => {
  it('内部格：单个投射单位覆盖其六个图内邻格', () => {
    const covered = zocHexes([SOURCE], 'axis')
    expect(covered).toHaveLength(6)
    for (const direction of HEX_DIRECTIONS) {
      expect(covered).toContainEqual(neighbor(SOURCE.hex, direction))
    }
  })

  it('地图角落：越界与削角方向都被裁掉（1.31 是左下角半格，只剩 2 格）', () => {
    const corner: ZocSource = { ...SOURCE, hex: { col: 1, row: 31 } }
    expect(zocHexes([corner], 'axis')).toHaveLength(2)
  })

  it('只收本方的投射单位，且同一格被多单位覆盖只出现一次', () => {
    const other: ZocSource = { ...SOURCE, hex: { col: 40, row: 13 }, side: 'soviet' }
    const covered = zocHexes([SOURCE, other], 'axis')
    expect(covered).toHaveLength(6) // other 属苏方，不参与轴方 ZOC
    expect(covered).not.toContainEqual(other.hex)

    const stack: ZocSource[] = [SOURCE, { ...SOURCE, hex: { col: 36, row: 14 } }]
    const merged = zocHexes(stack, 'axis')
    const deduped = new Set(merged.map((hex) => `${hex.col}.${hex.row}`))
    expect(merged.length).toBe(deduped.size)
  })
})

describe('进入敌方 ZOC 的移动后果（4.4b）', () => {
  it('轮式须停止或突袭；徒步与履带不受影响', () => {
    expect(zocEntryEffect('truck')).toBe('mustStopOrOverrun')
    expect(zocEntryEffect('leg')).toBe('unaffected')
    expect(zocEntryEffect('track')).toBe('unaffected')
  })
})
