import { describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'

/**
 * 专规 3.1：轴方补给源的数据符合性
 *
 * ## 原文（Smolensk_Rules_v1.1 p.3）
 *   「Map-edge hexes **west of 10.xx** where **any type of road or railroad enters the map**
 *    are Axis supply sources. Examples are **1.03, 1.26, and 4.00** (but **not 11.33**!)」
 *
 * ## 实现口径
 *   本条在工程库以**数据即判据**落地：`scenarios.json → supplySources.axisLive` 直接列出
 *   合规格（7 个剧本同一清单），`workbench.ts` 的 `scenarioSupplySourceHexes` 原样消费；
 *   没有 `isAxisSupplySource(hex)` 之类的运行时判据（地图边数据不足以对全部源格复算"道路/铁路入图"，
 *   见下）。故本文件钉**数据面**：示例必须在、排除格必须不在、全部格须在图边且列号在 10 以西。
 *
 * ## 测法边界
 *   - 「道路或铁路入图」一轴：`map-layers.json` 的格边数据只对部分西/北缘格记了 `offMapStub`
 *     （1.03、4.00、8.00 等源格在图层里没有边记录）⇒ **不做全量复算**，不臆造缺失数据；
 *   - 「西于 10.xx」按字面取 `col < 10`（10.xx 本身不是"以西"）；数据最大列号为 8，两种读法都满足。
 */

const key = (col: number, row: number): string => `${col}.${row}`

/** 剧本 1 的清单（7 个剧本同值；下方逐剧本比较） */
const DOCUMENTED_AXIS_SOURCES = ['1.03', '1.04', '1.07', '1.12', '1.19', '1.26', '4.00', '8.00']

const inside = new Set(mapLayers.hexes.map((hex) => key(hex.col, hex.row)))

/** 地图边缘格：至少缺一个六邻（与 workbench 的 `mapEdgeHexes` 同一判据） */
function isMapEdge(col: number, row: number): boolean {
  return HEX_DIRECTIONS.some((direction) => {
    const adjacent = neighbor({ col, row }, direction)
    return !inside.has(key(adjacent.col, adjacent.row))
  })
}

describe('专规 3.1：轴方补给源（数据面）', () => {
  it('7 个剧本的 axisLive 是同一份合规清单', () => {
    for (const scenario of scenarios.scenarios) {
      expect(scenario.supplySources?.axisLive ?? [], scenario.id).toEqual(DOCUMENTED_AXIS_SOURCES)
    }
  })

  it('原文举的三个例子都在清单里', () => {
    const list = scenarios.scenarios[0]?.supplySources?.axisLive ?? []
    for (const example of ['1.03', '1.26', '4.00']) {
      expect(list, example).toContain(example)
    }
  })

  it('★ 11.33 不是轴方补给源（原文括注排除，且该格确实在地图上）', () => {
    const list = scenarios.scenarios[0]?.supplySources?.axisLive ?? []
    expect(list).not.toContain('11.33')
    // 非空断言：该格若不在图上，「排除」就变成空话
    expect(inside.has('11.33')).toBe(true)
  })

  it('每个源格都在地图边缘，且列号在 10.xx 以西', () => {
    for (const text of DOCUMENTED_AXIS_SOURCES) {
      const [col, row] = text.split('.').map(Number)
      expect(col!, text).toBeLessThan(10)
      expect(isMapEdge(col!, row!), text).toBe(true)
    }
  })
})
