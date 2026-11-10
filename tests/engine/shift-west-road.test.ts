import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { directionOf, hexsideOf } from '@/engine/hex-geometry'
import { shiftWestDestination } from '@/engine/rules'

/**
 * ch10「抽中的师必须沿道路向所列位置西移三格」——**算法**口径（用户 2026-11-10 裁定）
 *
 * · 每步只在西向两邻（SW / NW，列 −1）里选，且须图内、且该格边在地图数据的 `edges.road` 上；
 * · 道路在中间断掉 ⇒ 停在能走到的最后一格，`exact=false`，**不按几何回退、不视为有道路**；
 * · 无西向 road 边（如 8.08）⇒ 原地不动，`walked=0`。
 */

const ROAD_SIDES: ReadonlySet<string> = new Set(
  mapLayers.edges
    .filter((edge) => edge.road !== undefined)
    .map((edge) => hexsideOf(edge.a, edge.b)?.key)
    .filter((key): key is string => key !== undefined),
)

/** 真实地图的 road 谓词（与 store 接线同一把键） */
function hasRoadEdge(a: HexRef, b: HexRef): boolean {
  const side = hexsideOf(a, b)
  return side !== null && ROAD_SIDES.has(side.key)
}

const hex = (col: number, row: number): HexRef => ({ col, row })
const text = (value: HexRef): string => `${value.col}.${value.row}`

describe('ch10 西移：沿 edges.road 连续西移三格', () => {
  it('4.18 沿 secondary 走三步到 1.19，path 含起点且每步临路', () => {
    const result = shiftWestDestination(hex(4, 18), 3, hasRoadEdge)
    expect(result.path.map(text)).toEqual(['4.18', '3.19', '2.18', '1.19'])
    expect(text(result.hex)).toBe('1.19')
    expect(result.walked).toBe(3)
    expect(result.exact).toBe(true)
    for (let index = 1; index < result.path.length; index += 1) {
      expect(hasRoadEdge(result.path[index - 1]!, result.path[index]!)).toBe(true)
    }
  })

  it('实图另两条路链：4.25 → 1.26、15.25 → 12.24', () => {
    const quarter = shiftWestDestination(hex(4, 25), 3, hasRoadEdge)
    expect(quarter.path.map(text)).toEqual(['4.25', '3.25', '2.25', '1.26'])
    expect(quarter.exact).toBe(true)

    const seventh = shiftWestDestination(hex(15, 25), 3, hasRoadEdge)
    expect(seventh.path.map(text)).toEqual(['15.25', '14.24', '13.24', '12.24'])
    expect(seventh.exact).toBe(true)
  })

  it('8.08 无 road 边 ⇒ 留在原格，walked=0、exact=false（不按几何回退）', () => {
    const result = shiftWestDestination(hex(8, 8), 3, hasRoadEdge)
    expect(text(result.hex)).toBe('8.8')
    expect(result.walked).toBe(0)
    expect(result.exact).toBe(false)
    expect(result.path.map(text)).toEqual(['8.8'])
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

  it('道路中途断掉 ⇒ 停在能走到的最后一格，exact=false', () => {
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
