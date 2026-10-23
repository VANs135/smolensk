import { describe, expect, it } from 'vitest'

import { mapConfig, mapLayers } from '@/data'
import type { HexRef } from '@/data'

import {
  areAdjacent,
  directionOf,
  HEX_BOUNDS,
  HEX_DIRECTIONS,
  hexDistance,
  hexesWithin,
  hexsideOf,
  isNorthEdge,
  isOnMap,
  isSouthEdge,
  isWestEdge,
  neighbor,
  neighbors,
  onMapNeighbors,
  oppositeDirection,
  sameHex,
} from '@/engine/hex-geometry'
import type { HexDirection } from '@/engine/hex-geometry'

/**
 * 六角格几何与距离（B6）测试
 *
 * 几何约定不是假设出来的：邻格表由源库 map_edges.json 的 6662 条边（带 dir_a）归纳，
 * 本文件用**产物真实格边**（map-layers.edges）与**全图逐格自检**反向验证。
 */

describe('几何契约与方向词表', () => {
  it('标定为平顶 + even-q（邻格表的前提）', () => {
    expect(mapConfig.orientation).toBe('flat')
    expect(mapConfig.offset).toBe('even-q')
  })

  it('方向词表取自源库 dir_a（六个方向）', () => {
    expect([...HEX_DIRECTIONS]).toEqual(['N', 'NE', 'SE', 'S', 'SW', 'NW'])
  })

  it('bounds 是矩形外框（列 1–62 / 行 0–35），不等于图内格集合', () => {
    expect(HEX_BOUNDS).toEqual({ colStart: 1, colEnd: 62, rowStart: 0, rowEnd: 35 })
    // 矩形格数 > 图内格数：四边削角，矩形内有 76 格在图外（map_hexes.meta.off_map_count）
    const rectCells =
      (HEX_BOUNDS.colEnd - HEX_BOUNDS.colStart + 1) * (HEX_BOUNDS.rowEnd - HEX_BOUNDS.rowStart + 1)
    expect(rectCells - mapLayers.hexes.length).toBe(76)
  })
})

describe('邻格与方向（偶列 / 奇列分叉）', () => {
  it('偶列的六向增量', () => {
    const from = { col: 36, row: 13 } // 偶列
    expect(neighbor(from, 'N')).toEqual({ col: 36, row: 14 })
    expect(neighbor(from, 'NE')).toEqual({ col: 37, row: 14 })
    expect(neighbor(from, 'SE')).toEqual({ col: 37, row: 13 })
    expect(neighbor(from, 'S')).toEqual({ col: 36, row: 12 })
    expect(neighbor(from, 'SW')).toEqual({ col: 35, row: 13 })
    expect(neighbor(from, 'NW')).toEqual({ col: 35, row: 14 })
  })

  it('奇列的六向增量（左右斜向少一行）', () => {
    const from = { col: 37, row: 13 } // 奇列
    expect(neighbor(from, 'N')).toEqual({ col: 37, row: 14 })
    expect(neighbor(from, 'NE')).toEqual({ col: 38, row: 13 })
    expect(neighbor(from, 'SE')).toEqual({ col: 38, row: 12 })
    expect(neighbor(from, 'S')).toEqual({ col: 37, row: 12 })
    expect(neighbor(from, 'SW')).toEqual({ col: 36, row: 12 })
    expect(neighbor(from, 'NW')).toEqual({ col: 36, row: 13 })
  })

  it('源库实边样例对账：1.1|1.2 的 dir_a = N', () => {
    // 源库 map_edges 首条：hex_a "1.1" → hex_b "1.2"，dir_a "N"
    expect(neighbor({ col: 1, row: 1 }, 'N')).toEqual({ col: 1, row: 2 })
    expect(directionOf({ col: 1, row: 1 }, { col: 1, row: 2 })).toBe('N')
  })

  it('directionOf 是 neighbor 的逆：六个方向 × 两种列奇偶都往返一致', () => {
    for (const from of [
      { col: 36, row: 13 },
      { col: 37, row: 13 },
    ]) {
      for (const direction of HEX_DIRECTIONS) {
        expect(directionOf(from, neighbor(from, direction))).toBe(direction)
      }
    }
  })

  it('directionOf：同格与非邻格都返回 null', () => {
    expect(directionOf({ col: 36, row: 13 }, { col: 36, row: 13 })).toBeNull()
    expect(directionOf({ col: 36, row: 13 }, { col: 38, row: 13 })).toBeNull()
    expect(directionOf({ col: 36, row: 13 }, { col: 36, row: 15 })).toBeNull()
  })

  it('neighbors 返回六向；areAdjacent 对称；sameHex 判定同格', () => {
    const hex = { col: 36, row: 13 }
    expect(neighbors(hex)).toHaveLength(6)
    const target = neighbor(hex, 'NE')
    expect(areAdjacent(hex, target)).toBe(true)
    expect(areAdjacent(target, hex)).toBe(true)
    expect(areAdjacent(hex, { col: 36, row: 15 })).toBe(false)
    expect(sameHex(hex, { col: 36, row: 13 })).toBe(true)
    expect(sameHex(hex, target)).toBe(false)
  })
})

describe('格边与反向方向', () => {
  it('反向方向成对且自反（N↔S / NE↔SW / SE↔NW）', () => {
    for (const direction of HEX_DIRECTIONS) {
      expect(oppositeDirection(oppositeDirection(direction))).toBe(direction)
      expect(oppositeDirection(direction)).not.toBe(direction)
    }
    expect(oppositeDirection('N')).toBe('S')
    expect(oppositeDirection('NE')).toBe('SW')
    expect(oppositeDirection('SE')).toBe('NW')
  })

  it('反向方向与 neighbor 自洽：走两步反向回到起点（偶列 / 奇列各测一遍）', () => {
    for (const from of [
      { col: 36, row: 13 },
      { col: 37, row: 13 },
    ]) {
      for (const direction of HEX_DIRECTIONS) {
        expect(neighbor(neighbor(from, direction), oppositeDirection(direction))).toEqual(from)
      }
    }
  })

  it('格边由无序两端唯一确定：两端互换得同一把钥匙', () => {
    const a = { col: 36, row: 13 }
    const b = neighbor(a, 'NE') // 偶列 NE → (37,14)
    const ab = hexsideOf(a, b)
    const ba = hexsideOf(b, a)
    expect(ab).not.toBeNull()
    expect(ba).not.toBeNull()
    expect(ab?.key).toBe('36.13|37.14')
    expect(ba?.key).toBe(ab?.key)
    // 规范化：两端按格号字符串字典序，a 端在前
    const [first, second] = ab!.key.split('|')
    expect(first! < second!).toBe(true)
  })

  it('非相邻格不构成格边（含同格与隔两格）', () => {
    expect(hexsideOf({ col: 36, row: 13 }, { col: 36, row: 13 })).toBeNull()
    expect(hexsideOf({ col: 36, row: 13 }, { col: 38, row: 13 })).toBeNull()
    expect(hexsideOf({ col: 36, row: 13 }, { col: 36, row: 15 })).toBeNull()
  })

  it('产物全部格边都能取到唯一键，正反两向一致且无重复', () => {
    const keys = new Set<string>()
    for (const edge of mapLayers.edges) {
      const forward = hexsideOf(edge.a, edge.b)
      const backward = hexsideOf(edge.b, edge.a)
      expect(forward).not.toBeNull()
      expect(backward?.key).toBe(forward?.key)
      keys.add(forward!.key)
    }
    expect(mapLayers.edges.length).toBeGreaterThan(0)
    expect(keys.size).toBe(mapLayers.edges.length)
  })
})

describe('地理朝向（★ 用户裁定 2026-09-13：上北下南左西右东）', () => {
  /** 由标定公式导出的「北向度」与「东向度」（越大越靠北 / 越靠东） */
  const northing = (hex: HexRef): number =>
    hex.row * mapConfig.geometry.hexHeightPx +
    (hex.col % 2 === 0 ? mapConfig.geometry.hexHeightPx / 2 : 0)
  const easting = (hex: HexRef): number => (hex.col - 1) * mapConfig.geometry.hexWidthPx

  /** 按城市名取全部格（Smolensk / Vitebsk 为双格城市） */
  const cityHexes = (name: string): HexRef[] =>
    mapLayers.hexes
      .filter((hex) => hex.city?.name === name)
      .map((hex) => ({ col: hex.col, row: hex.row }))
  const city = (name: string): HexRef => {
    const found = cityHexes(name)
    expect(found.length).toBeGreaterThan(0)
    return found[0]!
  }

  it('标定半格错位 = 六角格高的一半（even-q 的几何根据）', () => {
    // 标定公式的 (偶列 ? 54.792 : 0) 必须等于 hexHeightPx / 2，否则奇偶列错位与格子尺寸不自洽
    expect(mapConfig.geometry.hexHeightPx / 2).toBeCloseTo(54.792, 3)
  })

  it('真实地名锚点：行号增大 = 向北（维捷布斯克在莫吉廖夫以北、莫吉廖夫在斯摩棱斯克以南）', () => {
    const mogilev = city('Mogilev')
    const vitebsk = cityHexes('Vitebsk') // 双格城市取最南的一格比较
    const smolensk = city('Smolensk')
    const bobruysk = city('Bobruysk')
    const minimumRow = (list: HexRef[]): number => Math.min(...list.map((hex) => hex.row))
    expect(minimumRow(vitebsk)).toBeGreaterThan(mogilev.row)
    expect(mogilev.row).toBeLessThan(smolensk.row)
    expect(bobruysk.row).toBeLessThan(mogilev.row)
  })

  it('真实地名锚点：列号增大 = 向东（维亚济马/勒热夫在斯摩棱斯克以东，莫吉廖夫在西）', () => {
    const smolensk = city('Smolensk')
    expect(city('Vyazma').col).toBeGreaterThan(smolensk.col)
    expect(city('Rzhev').col).toBeGreaterThan(smolensk.col)
    expect(city('Mogilev').col).toBeLessThan(smolensk.col)
    expect(city('Bobruysk').col).toBeLessThan(smolensk.col)
  })

  it('方向语义与标定几何一致：N/NE/NW 更北，S/SE/SW 更南，NE/SE 更东，NW/SW 更西', () => {
    for (const from of [
      { col: 36, row: 13 },
      { col: 37, row: 13 },
    ]) {
      for (const direction of ['N', 'NE', 'NW'] as const) {
        expect(northing(neighbor(from, direction))).toBeGreaterThan(northing(from))
      }
      for (const direction of ['S', 'SE', 'SW'] as const) {
        expect(northing(neighbor(from, direction))).toBeLessThan(northing(from))
      }
      for (const direction of ['NE', 'SE'] as const) {
        expect(easting(neighbor(from, direction))).toBeGreaterThan(easting(from))
      }
      for (const direction of ['NW', 'SW'] as const) {
        expect(easting(neighbor(from, direction))).toBeLessThan(easting(from))
      }
      // 正南北恒为同列，正东西不存在（六角格无 E/W 方向）
      expect(neighbor(from, 'N').col).toBe(from.col)
      expect(neighbor(from, 'S').col).toBe(from.col)
    }
  })
})

describe('图内判定与图内邻格', () => {
  it('isOnMap：图内格为真（含上/下边缘半格）', () => {
    expect(isOnMap({ col: 36, row: 13 })).toBe(true)
    expect(isOnMap({ col: 62, row: 35 })).toBe(true)
    expect(isOnMap({ col: 1, row: 31 })).toBe(true) // 下边缘半格
    expect(isOnMap({ col: 2, row: 0 })).toBe(true) // 上边缘半格
  })

  it('isOnMap：上/下边缘与西南角的半格属正常图内格（★ 用户裁定：半个格子也算正常格）', () => {
    // 62 个半格分布在：偶数列 2–62 第 0 行（31）、偶数列 12–62 第 35 行（26）、奇数列 1–9 第 31 行（5）
    for (const halfHex of [
      { col: 2, row: 0 },
      { col: 62, row: 0 },
      { col: 12, row: 35 },
      { col: 62, row: 35 },
      { col: 1, row: 31 },
      { col: 9, row: 31 },
    ]) {
      expect(isOnMap(halfHex)).toBe(true)
      expect(onMapNeighbors(halfHex).length).toBeGreaterThan(0)
    }
  })

  it('isOnMap：bounds 矩形内确无该格的削角处为假（奇数列第 0 行 / 偶数列行 31–35 / 奇数列 1–9 行 32–35）', () => {
    expect(isOnMap({ col: 1, row: 0 })).toBe(false) // 奇数列无第 0 行（该列第 0 行是空白，非半格）
    expect(isOnMap({ col: 3, row: 0 })).toBe(false)
    expect(isOnMap({ col: 61, row: 0 })).toBe(false)
    expect(isOnMap({ col: 1, row: 32 })).toBe(false) // 西南角半格 1.31 之上的行
    expect(isOnMap({ col: 2, row: 31 })).toBe(false) // 偶数列到行 30 为止
    expect(isOnMap({ col: 10, row: 35 })).toBe(false)
    // 对照：同列的半格本身是在图内的
    expect(isOnMap({ col: 1, row: 31 })).toBe(true)
  })

  it('isOnMap：矩形外为假（图外盒 / 边缘盒一侧）', () => {
    expect(isOnMap({ col: 0, row: 0 })).toBe(false)
    expect(isOnMap({ col: 63, row: 0 })).toBe(false)
    expect(isOnMap({ col: 1, row: -1 })).toBe(false)
    expect(isOnMap({ col: 1, row: 36 })).toBe(false)
  })

  it('图内格集合与产物格清单完全一致（2156 格，无多无少）', () => {
    for (const hex of mapLayers.hexes) {
      expect(isOnMap({ col: hex.col, row: hex.row })).toBe(true)
    }
    let counted = 0
    for (let col = HEX_BOUNDS.colStart; col <= HEX_BOUNDS.colEnd; col += 1) {
      for (let row = HEX_BOUNDS.rowStart; row <= HEX_BOUNDS.rowEnd; row += 1) {
        if (isOnMap({ col, row })) counted += 1
      }
    }
    expect(counted).toBe(mapLayers.hexes.length)
  })

  it('内部格有 6 个图内邻格；削角格 / 半格被地图边界裁掉', () => {
    expect(onMapNeighbors({ col: 36, row: 13 })).toHaveLength(6)
    expect(onMapNeighbors({ col: 2, row: 2 })).toHaveLength(6)
    // 1.31 是左下角半格：只有 1.30（S）与 2.30（SE）在图内，其余方向都是削角或图外
    expect(
      onMapNeighbors({ col: 1, row: 31 })
        .map((entry) => `${entry.hex.col}.${entry.hex.row}`)
        .sort(),
    ).toEqual(['1.30', '2.30'])
    // 2.0 是上边缘半格：只朝下三向有图内邻格
    expect(onMapNeighbors({ col: 2, row: 0 })).toHaveLength(3)
    // 62.35 是右上角：只有 61.35（NW）与 62.34（S）
    expect(onMapNeighbors({ col: 62, row: 35 })).toHaveLength(2)
  })
})

describe('距离（几何步数）', () => {
  it('同格为 0；相邻恒为 1（全图逐格 × 六向自检）', () => {
    let checked = 0
    for (const hex of mapLayers.hexes) {
      const from = { col: hex.col, row: hex.row }
      expect(hexDistance(from, from)).toBe(0)
      for (const direction of HEX_DIRECTIONS) {
        expect(hexDistance(from, neighbor(from, direction))).toBe(1)
        checked += 1
      }
    }
    expect(checked).toBe(mapLayers.hexes.length * 6)
  })

  it('对称且符合已知例子（相隔两列、行差 0 → 2 步）', () => {
    expect(hexDistance({ col: 1, row: 0 }, { col: 3, row: 0 })).toBe(2)
    expect(hexDistance({ col: 3, row: 0 }, { col: 1, row: 0 })).toBe(2)
    expect(hexDistance({ col: 1, row: 1 }, { col: 1, row: 4 })).toBe(3)
  })

  it('产物真实格边（含图外终止边）全为邻格且距离为 1，方向可解析', () => {
    expect(mapLayers.edges.length).toBeGreaterThan(0)
    for (const edge of mapLayers.edges) {
      const a = edge.a
      const b = edge.b
      expect(areAdjacent(a, b)).toBe(true)
      expect(hexDistance(a, b)).toBe(1)
      expect(directionOf(a, b)).not.toBeNull()
      // 同一条格边从两端看方向相反
      expect(directionOf(b, a)).toBe(oppositeDirection(directionOf(a, b)!))
    }
  })
})

describe('半径内取格', () => {
  it('半径 0 只有中心；半径 1 共 7 格、半径 2 共 19 格', () => {
    const center = { col: 36, row: 13 }
    expect(hexesWithin(center, 0)).toEqual([center])
    expect(hexesWithin(center, 1)).toHaveLength(7)
    expect(hexesWithin(center, 2)).toHaveLength(19)
  })

  it('半径内的格都在给定距离内，且按距离升序', () => {
    const center = { col: 36, row: 13 }
    const within = hexesWithin(center, 3)
    const distances = within.map((hex) => hexDistance(center, hex))
    for (const distance of distances) expect(distance).toBeLessThanOrEqual(3)
    expect([...distances].sort((a, b) => a - b)).toEqual(distances)
  })

  it('onMapOnly 过滤图外格（含 bounds 矩形内的削角空洞）', () => {
    const corner = { col: 1, row: 31 } // 左下角半格：原始半径 1 = 7 格，图内只剩 3 格
    expect(hexesWithin(corner, 1)).toHaveLength(7)
    expect(hexesWithin(corner, 1, { onMapOnly: true })).toHaveLength(3)
    for (const hex of hexesWithin(corner, 2, { onMapOnly: true })) {
      expect(isOnMap(hex)).toBe(true)
    }
    // 空洞格（1.0 在矩形内但图外）不会被 onMapOnly 收进来
    const aroundNorth = hexesWithin({ col: 1, row: 1 }, 1, { onMapOnly: true })
    expect(aroundNorth.some((hex) => hex.col === 1 && hex.row === 0)).toBe(false)
  })

  it('半径 1 的图内取格 == 中心 + 六个图内邻格（neighbor 与立方坐标两套实现互证）', () => {
    for (const hex of mapLayers.hexes) {
      const center = { col: hex.col, row: hex.row }
      const expected = [center, ...onMapNeighbors(center).map((entry) => entry.hex)]
      const got = hexesWithin(center, 1, { onMapOnly: true })
      expect(got).toHaveLength(expected.length)
      for (const target of expected) expect(got).toContainEqual(target)
    }
  })

  it('半径非法即抛错', () => {
    expect(() => hexesWithin({ col: 1, row: 1 }, -1)).toThrow(RangeError)
    expect(() => hexesWithin({ col: 1, row: 1 }, 1.5)).toThrow(RangeError)
  })
})

/** 编译期辅助：方向联合可穷举（新增方向未处理即失败） */
const DIRECTION_LABELS: Record<HexDirection, string> = {
  N: '北',
  NE: '东北',
  SE: '东南',
  S: '南',
  SW: '西南',
  NW: '西北',
}

describe('方向标签完备', () => {
  it('六个方向都有标签', () => {
    expect(Object.keys(DIRECTION_LABELS).sort()).toEqual([...HEX_DIRECTIONS].sort())
  })
})

/**
 * 地图边缘判据（专规 2.1a 的南缘 / 13.6 的北缘与西缘）
 *
 * 这三条判据都必须按**图内格清单**判「往某个方向还有没有图内邻格」，
 * 不能用「行号/列号 ≥ 某个值」之类的近似——本作地图四边削角且列错位，
 * 近似口径会同时多算与漏算（下面的断言就是这两类错的回归网）。
 */
describe('地图边缘判据（北缘 / 西缘 / 南缘）', () => {
  const hexes = mapLayers.hexes.map((hex) => ({ col: hex.col, row: hex.row }))
  const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

  it('北缘＝没有图内北邻：全图 62 格，行号落在 30/31/35', () => {
    const north = hexes.filter(isNorthEdge)
    expect(north).toHaveLength(62)
    expect([...new Set(north.map((hex) => hex.row))].sort((a, b) => a - b)).toEqual([30, 31, 35])
  })

  it('北缘含西北削角处（行 30/31），不含第 34 行（它们有第 35 行的北邻）', () => {
    // 削角处北界东移，故这些**行号较小**的格才是真北缘
    expect(isNorthEdge({ col: 1, row: 31 })).toBe(true)
    expect(isNorthEdge({ col: 2, row: 30 })).toBe(true)
    expect(isNorthEdge({ col: 10, row: 30 })).toBe(true)
    // 第 34 行有第 35 行的北邻 ⇒ 不是北缘（旧口径 `row >= 34` 会把 52 格全算进来）
    expect(isNorthEdge({ col: 36, row: 34 })).toBe(false)
    expect(isNorthEdge({ col: 62, row: 34 })).toBe(false)
    expect(isNorthEdge({ col: 62, row: 35 })).toBe(true)
    // 旧口径漏掉的正是削角处那 10 格
    expect(hexes.filter((hex) => isNorthEdge(hex) && hex.row < 34)).toHaveLength(10)
  })

  it('西缘＝NW 与 SW 都没有图内邻格（错位六角格没有「同行西邻」）：全图 35 格', () => {
    const west = hexes.filter(isWestEdge)
    expect(west).toHaveLength(35)
    // 西界沿第 1 列向下，到西北削角处东移到第 11 列
    expect([...new Set(west.map((hex) => hex.col))].sort((a, b) => a - b)).toEqual([1, 11])
    expect(west.filter((hex) => hex.col === 1)).toHaveLength(31)
    expect(
      west
        .filter((hex) => hex.col === 11)
        .map(label)
        .sort(),
    ).toEqual(['11.32', '11.33', '11.34', '11.35'])
  })

  it('西缘不含第 2–4 列（旧口径 `col <= 4` 多算 93 格、漏掉 11.32–11.35）', () => {
    expect(isWestEdge({ col: 4, row: 0 })).toBe(false)
    expect(isWestEdge({ col: 2, row: 0 })).toBe(false)
    expect(isWestEdge({ col: 3, row: 31 })).toBe(false)
    expect(isWestEdge({ col: 11, row: 32 })).toBe(true)
    expect(isWestEdge({ col: 12, row: 32 })).toBe(false)
  })

  it('南缘＝没有图内南邻：奇数列的南缘是第 1 行（它们没有第 0 行）', () => {
    expect(isSouthEdge({ col: 8, row: 0 })).toBe(true)
    expect(isSouthEdge({ col: 8, row: 1 })).toBe(false)
    expect(isSouthEdge({ col: 13, row: 1 })).toBe(true)
    expect(isSouthEdge({ col: 13, row: 2 })).toBe(false)
  })

  it('三条判据互不误伤：任一边缘格在图内，且边缘集合远小于矩形外框', () => {
    for (const hex of hexes) {
      if (isNorthEdge(hex) || isWestEdge(hex) || isSouthEdge(hex)) expect(isOnMap(hex)).toBe(true)
    }
    const total = hexes.filter(
      (hex) => isNorthEdge(hex) || isWestEdge(hex) || isSouthEdge(hex),
    ).length
    expect(total).toBeLessThan(hexes.length / 10) // 2156 格的边缘只占少数
  })
})
