import { mapLayers } from '@/data'

import { hexsideOf, isOnMap } from '../hex-geometry'
import type { MapFacts } from './move-types'
import type { HexsideCrossing } from './terrain'

/**
 * 地图事实提供者（B7 移动模块用）
 *
 * 把 map-layers.json 的字段形状收敛成移动模块需要的两个语义化查询：
 *   ① 格内地形集合（6.2d 取最贵 / 6.2a 沿路时忽略）
 *   ② 两格之间的格边（6.2b 追加费 / 6.2c 禁入 / 桥）
 * 以及图内判定（与引擎 isOnMap 同源，避免两处判据漂移）。
 *
 * 网格只建一次：格索引与「规范化格边键 → 格边」索引（键由 hex-geometry.hexsideOf 给出，
 * 与产物的 a/b 归一规则一致，故双向查同一把钥匙）。
 */

/** 创建 MapFacts 所需的最小数据结构（DeepReadonly 的 mapLayers 可直接传入） */
export interface MapFactsSource {
  hexes: readonly { col: number; row: number; terrainsPresent: readonly string[] }[]
  edges: readonly {
    a: { col: number; row: number }
    b: { col: number; row: number }
    /** 河/湖：minor / major / lake */
    river?: string
    /** 道路等级：secondary / track */
    road?: string
    /** 是否有铁路 */
    rail?: boolean
    /**
     * 专规 3.4：是否**多轨**铁路（分界线「沿多轨铁路线」的路径判据）
     *
     * 源库 `map_edges.rail_track`，用户逐段口述裁定；全图 1547 边里铁路 360、**多轨 125**。
     */
    multiTrack?: boolean
  }[]
}

/* TEC 地形名（与 charts-tec.json 的 features 名一致；工程库侧为缩写，此处做一次映射） */
const RIVER_TERRAIN: Record<string, string> = {
  minor: 'Minor River',
  major: 'Major River',
  lake: 'Lake/Blocked',
}
const ROAD_TERRAIN: Record<string, string> = {
  secondary: 'Secondary Road',
  track: 'Track',
}
const RAILROAD_TERRAIN = 'Railroad'

/** 格键（模块内部索引用；业务坐标仍一律 { col, row }，CODE_SPEC §4） */
function hexKey(col: number, row: number): string {
  return `${col}.${row}`
}

/** 工程库格边 → 引擎 crossing（与 map-edges-contract.test.ts 的翻译规则一致） */
function toCrossing(edge: MapFactsSource['edges'][number]): HexsideCrossing | null {
  const river = edge.river === undefined ? null : (RIVER_TERRAIN[edge.river] ?? null)
  const routes: string[] = []
  if (edge.road !== undefined) {
    const road = ROAD_TERRAIN[edge.road]
    if (road !== undefined) routes.push(road)
  }
  if (edge.rail === true) routes.push(RAILROAD_TERRAIN)
  if (river === null && routes.length === 0) return null
  return { river, routes }
}

/**
 * 由地图图层建 MapFacts
 *
 * @param source 默认取产品数据 map-layers.json（已通过 Zod 校验并深度冻结）
 */
export function createMapFacts(source: MapFactsSource = mapLayers): MapFacts {
  const terrains = new Map<string, readonly string[]>()
  for (const hex of source.hexes) terrains.set(hexKey(hex.col, hex.row), hex.terrainsPresent)

  const edges = new Map<string, HexsideCrossing>()
  for (const edge of source.edges) {
    const side = hexsideOf(edge.a, edge.b)
    if (side === null) continue // 数据异常（非相邻对）不静默成边
    const crossing = toCrossing(edge)
    if (crossing !== null) edges.set(side.key, crossing)
  }

  return {
    onMap: (hex) => isOnMap(hex),
    terrainsAt: (hex) => terrains.get(hexKey(hex.col, hex.row)) ?? [],
    crossingBetween: (a, b) => {
      const side = hexsideOf(a, b)
      if (side === null) return null
      return edges.get(side.key) ?? null
    },
  }
}

/** 专规 3.4：**多轨铁路格边**的查询（分界线路径的唯一事实来源） */
export interface MultiTrackRailFacts {
  isMultiTrackRail(a: { col: number; row: number }, b: { col: number; row: number }): boolean
}

/**
 * 由地图图层建「多轨铁路」事实（专规 3.4 的分界线路径用）
 *
 * 与 `createMapFacts` 同一份 `map-layers.json`（同一把格边键），只是把 `multiTrack` 这一位取出来。
 * 单独一个工厂而不是塞进 `MapFacts`：只有分界线要它，塞进去会让移动模块多背一个无关字段。
 */
export function createMultiTrackRailFacts(source: MapFactsSource = mapLayers): MultiTrackRailFacts {
  const multiTrack = new Set<string>()
  for (const edge of source.edges) {
    if (edge.multiTrack !== true) continue
    const side = hexsideOf(edge.a, edge.b)
    if (side === null) continue // 数据异常（非相邻对）不静默成边
    multiTrack.add(side.key)
  }
  return {
    isMultiTrackRail: (a, b) => {
      const side = hexsideOf(a, b)
      if (side === null) return false
      return multiTrack.has(side.key)
    },
  }
}
