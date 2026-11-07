import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import { mapLayers } from '@/data'

import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { computeReachableHexes, createMapFacts } from '@/engine/rules'
import type { MapFacts, MoveContext, MoveUnitView } from '@/engine/rules'

/**
 * A 闸门：可达格 BFS 的**计算量**上界（确定性计数，不看机器快慢）
 *
 * 改造前每次迈步都全量扫 `units`、每次取费都重复查同一格的 `terrainsAt`、
 * 同一条格边被正反两向反复查 `crossingBetween` ⇒ 下面三条断言必红。
 * 改造后：单位索引与 ZOC 覆盖格一次算定、地图事实按格/按边记忆化 ⇒ 三条必绿。
 */

const INTERIOR: HexRef = (() => {
  for (const hex of mapLayers.hexes) {
    if (hex.col < 12 || hex.col > 40 || hex.row < 12 || hex.row > 24) continue
    const here: HexRef = { col: hex.col, row: hex.row }
    if (HEX_DIRECTIONS.every((direction) => isOnMap(neighbor(here, direction)))) return here
  }
  throw new Error('地图上找不到全邻居的内部格')
})()

const keyOf = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 无序格边键（与引擎 `hexsideOf` 同口径：同一对格只有一条边） */
const edgeKeyOf = (a: HexRef, b: HexRef): string => [keyOf(a), keyOf(b)].sort().join('|')

function unit(over: Partial<MoveUnitView> & { id: string }): MoveUnitView {
  return {
    side: 'axis',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: INTERIOR,
    mobility: 'leg',
    ma: 6,
    re: 2,
    mode: 'combat',
    orientation: 'combat',
    dg: false,
    exploit: false,
    releasedFromReserve: false,
    fuelled: true,
    mpLockedThisPhase: false,
    ...over,
  }
}

const UNITS: MoveUnitView[] = [
  unit({ id: 'a', hex: INTERIOR }),
  unit({ id: 'b', hex: neighbor(INTERIOR, 'NE') }),
  unit({ id: 'c', side: 'soviet' as Side, hex: neighbor(INTERIOR, 'SW') }),
]

/** 计数的 units 数组（`for..of` / `some` / `find` 都按索引读取，故都能计到） */
function countingUnits(units: MoveUnitView[]): {
  units: readonly MoveUnitView[]
  reads: () => number
} {
  let reads = 0
  const proxy = new Proxy(units, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1
      return Reflect.get(target, prop, receiver)
    },
  })
  return { units: proxy as readonly MoveUnitView[], reads: () => reads }
}

/** 计数的地图事实：记录调用次数 + 去重数（两者相等 ⇔ 没有重复查询） */
function countingMap(inner: MapFacts): {
  map: MapFacts
  terrainsCalls: () => number
  terrainsDistinct: () => number
  crossingCalls: () => number
  crossingDistinct: () => number
} {
  let terrainsCalls = 0
  let crossingCalls = 0
  const terrainsSeen = new Set<string>()
  const crossingSeen = new Set<string>()
  return {
    map: {
      onMap: (hex) => inner.onMap(hex),
      terrainsAt: (hex) => {
        terrainsCalls += 1
        terrainsSeen.add(keyOf(hex))
        return inner.terrainsAt(hex)
      },
      crossingBetween: (a, b) => {
        crossingCalls += 1
        crossingSeen.add(edgeKeyOf(a, b))
        return inner.crossingBetween(a, b)
      },
    },
    terrainsCalls: () => terrainsCalls,
    terrainsDistinct: () => terrainsSeen.size,
    crossingCalls: () => crossingCalls,
    crossingDistinct: () => crossingSeen.size,
  }
}

describe('可达格 BFS 的计算量上界（A）', () => {
  it('单位按索引查一次，不随步数全量重扫', () => {
    const counted = countingUnits(UNITS)
    const context: MoveContext = {
      phase: 'movement',
      activeSide: 'axis',
      map: createMapFacts(),
      units: counted.units,
    }
    const result = computeReachableHexes(context, 'a')
    expect(result.ok).toBe(true)
    // 放宽到 20×单位数：只允许「建索引那几趟 + 定位单位」，任何按步全量扫描都会超
    expect(counted.reads()).toBeLessThanOrEqual(UNITS.length * 20)
  })

  it('同一格的地形只查一次；同一条格边只查一次', () => {
    const counted = countingMap(createMapFacts())
    const context: MoveContext = {
      phase: 'movement',
      activeSide: 'axis',
      map: counted.map,
      units: UNITS,
    }
    const result = computeReachableHexes(context, 'a')
    expect(result.ok).toBe(true)
    expect(counted.terrainsCalls()).toBe(counted.terrainsDistinct())
    expect(counted.crossingCalls()).toBe(counted.crossingDistinct())
  })
})
