import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { directionOf, hexsideOf } from '@/engine/hex-geometry'
import { shiftWestDestination } from '@/engine/rules'

/**
 * ch10「抽中的师必须沿道路向所列位置西移三格」——**算法**口径（用户 2026-11-10 裁定）
 *
 * · 每步只在西向两邻（SW / NW，列 −1）里选，且须图内、且该格边在地图数据的
 *   `edges.road` **或** `edges.rail` 上（用户裁定：铁路和道路都算路）；
 * · 路/铁在中间断掉 ⇒ 停在能走到的最后一格，`exact=false`，**不按几何回退、不视为有路**；
 * · 只连铁轨也合法（如 8.08 沿多轨铁路 → 5.8）。
 */

const ROAD_OR_RAIL_SIDES: ReadonlySet<string> = new Set(
  mapLayers.edges
    .filter((edge) => edge.road !== undefined || edge.rail === true)
    .map((edge) => hexsideOf(edge.a, edge.b)?.key)
    .filter((key): key is string => key !== undefined),
)

/** 真实地图的「道路类 ∪ 铁路」谓词（与 store 接线同一把键） */
function hasRoadOrRailEdge(a: HexRef, b: HexRef): boolean {
  const side = hexsideOf(a, b)
  return side !== null && ROAD_OR_RAIL_SIDES.has(side.key)
}

/** 地图上一条边的原始数据（两端无序） */
function edgeOf(a: HexRef, b: HexRef) {
  const side = hexsideOf(a, b)
  if (side === null) return undefined
  return mapLayers.edges.find((edge) => hexsideOf(edge.a, edge.b)?.key === side.key)
}

const hex = (col: number, row: number): HexRef => ({ col, row })
const text = (value: HexRef): string => `${value.col}.${value.row}`

describe('ch10 西移：沿「道路类 ∪ 铁路」连续西移三格', () => {
  it('4.18 先沿铁路再沿 secondary 走三步到 1.19，path 含起点且每步临路/铁', () => {
    const result = shiftWestDestination(hex(4, 18), 3, hasRoadOrRailEdge)
    expect(result.path.map(text)).toEqual(['4.18', '3.18', '2.18', '1.19'])
    expect(text(result.hex)).toBe('1.19')
    expect(result.walked).toBe(3)
    expect(result.exact).toBe(true)
    for (let index = 1; index < result.path.length; index += 1) {
      expect(hasRoadOrRailEdge(result.path[index - 1]!, result.path[index]!)).toBe(true)
    }
  })

  it('实图另两条路链：4.25 → 1.26、15.25 → 12.24', () => {
    const quarter = shiftWestDestination(hex(4, 25), 3, hasRoadOrRailEdge)
    expect(quarter.path.map(text)).toEqual(['4.25', '3.25', '2.25', '1.26'])
    expect(quarter.exact).toBe(true)

    const seventh = shiftWestDestination(hex(15, 25), 3, hasRoadOrRailEdge)
    expect(seventh.path.map(text)).toEqual(['15.25', '14.24', '13.24', '12.24'])
    expect(seventh.exact).toBe(true)
  })

  it('★ 只连铁轨的格子也算合法落点：8.08 沿多轨铁路 → 7.8 → 6.7 → 5.8', () => {
    const result = shiftWestDestination(hex(8, 8), 3, hasRoadOrRailEdge)
    expect(result.path.map(text)).toEqual(['8.8', '7.8', '6.7', '5.8'])
    expect(text(result.hex)).toBe('5.8')
    expect(result.walked).toBe(3)
    expect(result.exact).toBe(true)
    for (let index = 1; index < result.path.length; index += 1) {
      const edge = edgeOf(result.path[index - 1]!, result.path[index]!)
      expect(edge?.rail, text(result.path[index]!)).toBe(true)
      expect(edge?.road, text(result.path[index]!)).toBeUndefined()
    }
  })

  it('只走 SW / NW（列必须 −1），不跳到别的方向', () => {
    const result = shiftWestDestination(hex(20, 18), 3, () => true)
    expect(result.path).toHaveLength(4)
    for (let index = 1; index < result.path.length; index += 1) {
      const previous = result.path[index - 1]!
      const current = result.path[index]!
      expect(current.col).toBe(previous.col - 1)
      expect(['SW', 'NW']).toContain(directionOf(previous, current))
    }
  })

  it('路/铁中途断掉 ⇒ 停在能走到的最后一格，exact=false', () => {
    const allowed = new Set(['4.18|3.19', '3.19|2.18'])
    const broken = (a: HexRef, b: HexRef): boolean =>
      allowed.has(`${text(a)}|${text(b)}`) || allowed.has(`${text(b)}|${text(a)}`)
    const result = shiftWestDestination(hex(4, 18), 3, broken)
    expect(result.path.map(text)).toEqual(['4.18', '3.19', '2.18'])
    expect(text(result.hex)).toBe('2.18')
    expect(result.walked).toBe(2)
    expect(result.exact).toBe(false)
  })
})
