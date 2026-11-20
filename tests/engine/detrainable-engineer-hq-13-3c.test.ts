import { describe, expect, it } from 'vitest'

import { mapLayers, type HexRef, type Side } from '@/data'
import {
  engineerCapableHqAt,
  railSupplyPath,
  type EngineerHqFacts,
  type RailSupplyFacts,
} from '@/engine/rules'
import { readStoreSource } from '../shared/store-source'

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
    enemyOccupies: () => false,
    isRailHex: (hex) => hex.col === 36 && rows.includes(hex.row),
    railGaugeUsable: () => true,
    railEdgeUsable: () => true,
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

/**
 * U17（用户 2026-11-13 批准）：装车/运货用的卸货格 = 同 13.3c 过滤、BFS 只走铁路边、**不接延补队**。
 *
 * 夹具：铁路 36.0–36.2 与 36.4–36.5 两段，2–4 之间无铁路边；延补队放在 36.4，回连 36.2。
 * ⇒ 补给追溯把 36.4 接进铁路网（36.4 是村庄 ⇒ 可卸货）；
 *   但货物/免费铁运不得借延补队跳接，36.4 必须**不算**可卸货格。
 */
describe('U17：货物卸货格不接延补队（2.1/3.1 免费铁运专用）', () => {
  const railRows = [0, 1, 2, 4, 5]
  const cargoFacts: RailSupplyFacts = {
    ...facts(),
    isRailHex: (hex) => hex.col === 36 && railRows.includes(hex.row),
    railNeighbors: (hex) => {
      if (hex.col !== 36) return []
      const edges: Record<number, number[]> = { 0: [1], 1: [0, 2], 2: [1], 4: [5], 5: [4] }
      return (edges[hex.row] ?? []).map((row) => at(row))
    },
    terrainsPresentAt: (hex) => (hex.col === 36 && hex.row === 4 ? ['Village'] : []),
    extenderLinks: () => [{ hex: at(4), rangeMp: 2, mobility: 'leg' }],
    extenderConnectsBack: ({ extenderHex, hex }) => extenderHex.row === 4 && hex.row === 2,
  }

  it('补给追溯：延补队把 36.4 接进铁路网 ⇒ 36.4 是卸货格', () => {
    const supply = railSupplyPath(cargoFacts, 'axis')
    expect(supply.detrainableHexes.map((hex) => hex.row)).toEqual([4])
  })

  it('货物/免费铁运：cargoOnly 不接延补队 ⇒ 36.4 不是卸货格（不得放宽）', () => {
    const cargo = railSupplyPath(cargoFacts, 'axis', { cargoOnly: true })
    expect(cargo.detrainableHexes).toEqual([])
    expect(cargo.railReachableHexes.map((hex) => hex.row)).toEqual([0, 1, 2])
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
    const text = readStoreSource()
    expect(text).toContain('hasPortOrEngineerHqAt:')
    expect(text).toContain('engineerCapableHqAt(')
  })
})
