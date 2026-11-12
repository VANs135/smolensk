import { describe, expect, it } from 'vitest'

import { mapConfig, mapLayers, scenarios } from '@/data'

/**
 * 专规 2.1 / 3.1（用户 2026-11-12 裁定）：**补给源**与**入场字母**是两套判据
 *
 * ## 原文（Smolensk_Rules_v1.1 p.3）
 *   2.1「Map-edge hexes **east of 12.xx** where **any type of road or railroad enters the map**
 *        are Soviet supply sources. Examples are 13.01, 37.35, and 62.16.」
 *   3.1「Map-edge hexes **west of 10.xx** where **any type of road or railroad enters the map**
 *        are Axis supply sources. Examples are 1.03, 1.26, and 4.00 (but not 11.33!)」
 *
 * ## 判据
 *   补给源只看「本侧图边 + 有任意道路或铁路入图」；`map-config.entryHexes` 的字母段只回答
 *   「增援从哪进图」。故 `42.35`（苏）/ `4.00`（轴）是**源**但不是**入口字母**；
 *   `8.00` 两种身份重叠（源 + Entry F）。
 */

const keyOf = (hex: { col: number; row: number }): string => `${hex.col}.${hex.row}`
const entryHexes = (letter: string): string[] => (mapConfig.entryHexes?.[letter] ?? []).map(keyOf)
const allEntryHexes = new Set(
  Object.values(mapConfig.entryHexes ?? {}).flatMap((list) => list.map(keyOf)),
)
const railEdges = new Set(
  mapLayers.edges
    .filter((edge) => edge.rail === true)
    .map((edge) => [keyOf(edge.a), keyOf(edge.b)].sort().join('|')),
)

describe('专规 2.1 / 3.1：补给源与入场字母分属两套判据', () => {
  it('42.35 是苏方补给源（col 42 在 12.xx 以东、北缘有铁路入图），但不是入场字母', () => {
    for (const scenario of scenarios.scenarios)
      expect(scenario.supplySources?.sovietLive ?? [], String(scenario.id)).toContain('42.35')
    expect(allEntryHexes.has('42.35')).toBe(false)
    // 同列真正带字母的是 E = 42.00（防把两者混为一谈）
    expect(entryHexes('E')).toContain('42.0')
    // 产品数据的铁路格边：42.34–42.35（线端落在北图边）
    expect(railEdges.has('42.34|42.35')).toBe(true)
  })

  it('4.00 是轴方补给源（3.1 原文举例），但不是入场字母', () => {
    for (const scenario of scenarios.scenarios)
      expect(scenario.supplySources?.axisLive ?? [], String(scenario.id)).toContain('4.00')
    expect(allEntryHexes.has('4.0')).toBe(false)
    // 产品数据的铁路格边：3.1–4.00（线端落在南图边）
    expect(railEdges.has('3.1|4.0')).toBe(true)
  })

  it('8.00 既是轴方补给源，也是 Entry F（两种身份可重叠）', () => {
    for (const scenario of scenarios.scenarios)
      expect(scenario.supplySources?.axisLive ?? [], String(scenario.id)).toContain('8.00')
    expect(entryHexes('F')).toEqual(['8.0'])
  })
})

/**
 * U18（2026-11-13）：东南支线 `36.24…42.35` 的 15 格
 *
 * 地图事实：这 15 格通过铁路格边连成**一个独立分量**，与主网没有任何铁路边；
 * `42.35` 落在图边第 35 行（六邻格缺 `41.36`/`42.36`），有铁路自图边入图，
 * 因此按 2.1 它是苏方补给源，也是这条支线的入图端。
 * ⇒ 支线应随 `42.35` 这个 seed 进苏方进场铁路网；**不是漏边，不补边，不加字母入口**。
 */
describe('U18：东南 15 格是已入图的独立印刷分量', () => {
  const BRANCH = [
    '36.24',
    '36.25',
    '37.26',
    '38.26',
    '39.27',
    '39.28',
    '40.28',
    '40.29',
    '40.30',
    '40.31',
    '41.32',
    '41.33',
    '42.33',
    '42.34',
    '42.35',
  ]

  function railComponent(start: string): string[] {
    const adjacency = new Map<string, Set<string>>()
    for (const edge of mapLayers.edges) {
      if (edge.rail !== true) continue
      const a = keyOf(edge.a)
      const b = keyOf(edge.b)
      if (!adjacency.has(a)) adjacency.set(a, new Set())
      if (!adjacency.has(b)) adjacency.set(b, new Set())
      adjacency.get(a)!.add(b)
      adjacency.get(b)!.add(a)
    }
    const seen = new Set([start])
    const queue = [start]
    while (queue.length > 0) {
      const current = queue.pop()!
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    return [...seen].sort()
  }

  it('42.35 的铁路分量恰为 15 格，与主网无铁路格边', () => {
    expect(railComponent('42.35')).toEqual([...BRANCH].sort())
    // 两端：36.24 是印刷断头，42.35 是图边入图端
    expect(BRANCH).toContain('36.24')
    expect(BRANCH).toContain('42.35')
  })

  it('42.35 是图边格（第 35 行，缺 41.36/42.36 两邻）且为苏方 2.1 源', () => {
    const present = new Set(mapLayers.hexes.map(keyOf))
    expect(present.has('42.35')).toBe(true)
    expect(present.has('41.36')).toBe(false)
    expect(present.has('42.36')).toBe(false)
    for (const scenario of scenarios.scenarios)
      expect(scenario.supplySources?.sovietLive ?? [], String(scenario.id)).toContain('42.35')
    expect(allEntryHexes.has('42.35')).toBe(false)
  })
})
