import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { mapLayers, type HexRef, type Side } from '@/data'
import {
  engineerCapableHqAt,
  railSupplyPath,
  type EngineerHqFacts,
  type RailSupplyFacts,
} from '@/engine/rules'

const at = (row: number): HexRef => ({ col: 36, row })

/**
 * 13.3c① 的第二半句：「or Engineer-Capable HQ (13.8a)」
 *
 * 本夹具只放一条 36.0–36.3 的铁路走廊、无村庄/城市，故卸货格**只能**来自
 * `hasPortOrEngineerHqAt`；这样测的就是"港口/工程 HQ 这一条事实"本身。
 */
function facts(hasPortOrEngineerHqAt?: (hex: HexRef, side: Side) => boolean): RailSupplyFacts {
  const rows = [0, 1, 2, 3]
  return {
    terrainsPresentAt: () => [],
    isControlledBy: (_hex, side) => side === 'axis',
    isRailHex: (hex) => hex.col === 36 && rows.includes(hex.row),
    railGaugeUsable: () => true,
    railNeighbors: (hex) => {
      if (hex.col !== 36 || !rows.includes(hex.row)) return []
      return rows.filter((row) => Math.abs(row - hex.row) === 1).map((row) => at(row))
    },
    inUnnegatedEnemyZoc: () => false,
    baseSourceHexes: (side) => (side === 'axis' ? [at(0)] : []),
    extenderLinks: () => [],
    extenderConnectsBack: () => false,
    hasPortOrEngineerHqAt,
  }
}

describe('13.3c①：港口 / 工程 HQ 使铁路格可卸货', () => {
  it('13.3c：工程 HQ 所在铁路格（无村庄/城市）⇒ 火车卸货格', () => {
    const path = railSupplyPath(
      facts((hex) => hex.row === 2),
      'axis',
    )
    expect(path.railReachableHexes.map((item) => item.row)).toEqual([0, 1, 2, 3])
    expect(path.detrainableHexes.map((item) => item.row)).toEqual([2])
  })

  it('13.3c：工程 HQ 只对**本方**成立（同一格对敌方不成立）', () => {
    // 事实按「本方」给出：轴方查得到、苏方查不到（实际注入点即 `__(hex, side)`）
    const path = railSupplyPath(
      facts((_hex, side) => side === 'axis'),
      'soviet',
    )
    expect(path.detrainableHexes).toEqual([])
  })

  it('13.3c：既无村庄/城市、也无港口/工程 HQ ⇒ 仍不可卸货（不得凭空放行）', () => {
    const path = railSupplyPath(facts(), 'axis')
    expect(path.railReachableHexes.map((item) => item.row)).toEqual([0, 1, 2, 3])
    expect(path.detrainableHexes).toEqual([])
  })

  it('13.3c①「港口」半条：本作无港口地形（用户裁定 2026-11-05）⇒ 恒不可卸货', () => {
    // 判定依据：`map-layers.json` 无 `Port` 条目、专规无港口条文
    // ⇒ 港口一路恒 false 属**预期**；若剧本日后加入港口格，必须重新走裁定（待审批表 ⑰ 已裁定区）
    expect(mapLayers.hexes.filter((hex) => (hex.terrainsPresent ?? []).includes('Port'))).toEqual(
      [],
    )
  })
})

describe('13.3c① / 5.5b / 13.8a：Engineer-Capable HQ 的判据', () => {
  const hq = (over: Partial<EngineerHqFacts> = {}): EngineerHqFacts => ({
    side: 'axis',
    hex: at(2),
    isCombat: true,
    mode: { mode: 'combat', orientation: 'combat', dg: false, exploit: false },
    specialized: ['hq'],
    ...over,
  })

  it('13.3c：同格、本方、战斗模式的指挥部 ⇒ true', () => {
    expect(engineerCapableHqAt([hq()], at(2), 'axis')).toBe(true)
  })

  it('13.3c：移动模式的指挥部不算（5.5b：须在战斗模式才能执行工程职能）', () => {
    expect(
      engineerCapableHqAt(
        [hq({ mode: { mode: 'move', orientation: 'move', dg: false, exploit: false } })],
        at(2),
        'axis',
      ),
    ).toBe(false)
  })

  it('13.3c + 13.8a 例外：DG 但朝向战斗面的指挥部仍算（5.10e）', () => {
    expect(
      engineerCapableHqAt(
        [hq({ mode: { mode: 'combat', orientation: 'combat', dg: true, exploit: false } })],
        at(2),
        'axis',
      ),
    ).toBe(true)
  })

  it('13.3c + 13.8a 例外反面：DG 但朝向移动面的指挥部不算（5.10e）', () => {
    expect(
      engineerCapableHqAt(
        [hq({ mode: { mode: 'move', orientation: 'move', dg: true, exploit: false } })],
        at(2),
        'axis',
      ),
    ).toBe(false)
  })

  it('13.3c：敌方指挥部不算', () => {
    expect(engineerCapableHqAt([hq({ side: 'soviet' })], at(2), 'axis')).toBe(false)
  })

  it('13.3c：非指挥部（如工兵/Pioneer/铁路修理）不算（13.8 首段）', () => {
    expect(engineerCapableHqAt([hq({ specialized: ['pioneer'] })], at(2), 'axis')).toBe(false)
    expect(engineerCapableHqAt([hq({ specialized: ['rail_repair'] })], at(2), 'axis')).toBe(false)
  })

  it('13.3c：只认同格（异格不算）', () => {
    expect(engineerCapableHqAt([hq({ hex: at(1) })], at(2), 'axis')).toBe(false)
  })
})

describe('接线守卫：store 必须把该事实注入铁路补给事实', () => {
  it('13.3c：workbench.ts 传入 hasPortOrEngineerHqAt 且使用 engineerCapableHqAt', () => {
    const text = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(text).toContain('hasPortOrEngineerHqAt:')
    expect(text).toContain('engineerCapableHqAt(')
  })
})
