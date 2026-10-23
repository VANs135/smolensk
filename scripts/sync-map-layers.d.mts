/**
 * sync-map-layers.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const MAP_LAYERS_VERSION: string

export function parseHexRef(hexId: string): { col: number; row: number }

export interface HexRaw {
  col: number
  row: number
  terrain: string
  terrains_present?: readonly string[]
  movement_terrain?: string
  city_hex?: boolean
  city_name?: string | null
  city_level?: string | null
  city_role?: string | null
  entry_letter?: string | null
  supply_source?: boolean
}

export interface EdgeRaw {
  hex_a: string
  hex_b: string
  edge_terrain?: string
  river_class?: string
  road_present?: boolean
  road_subclass?: string
  rail_present?: boolean
  /** 源库的轨数：single / multi（用户逐段口述裁定；13.3a 全程多轨减半） */
  rail_track?: string | null
  // 轨距不是逐格字段：DB 已删 rail_gauge 列（Y4 去冗余），改由产物顶层 railGauge 承载
  bridge?: boolean
}

export interface FacilityRaw {
  kind?: string
  hex_id: string
  level?: number
  permanent?: boolean
  cannot_reduce?: boolean
}

export function toHexLayer(item: HexRaw): Record<string, unknown>
export function toEdgeLayer(edge: EdgeRaw): Record<string, unknown>
export function toHedgehogLayer(item: FacilityRaw): Record<string, unknown>

/**
 * 印刷永久工事的人工改判排除项（B0①）
 *
 * 权威源仍含这些格，故须在脚本里显式排除，否则重跑会把它们恢复回来。
 */
export const PRINTED_HEDGEHOG_EXCLUSIONS: readonly string[]

/**
 * 印刷永久工事清单（纯函数）：源库条目 → 产物记录，剔除人工改判项
 *
 * @throws Error 排除项在源库中已不存在时（说明权威源已修正，排除项应删除）
 */
export function selectPrintedHedgehogs(items: readonly FacilityRaw[]): Record<string, unknown>[]

/**
 * 图边终止标注（offMapStub）：至少一端不在图内即标 true
 *
 * @param edges     已映射的格边记录（含 a / b）
 * @param onMapKeys 图内格键集合（`"列.行"`）
 */
export function markOffMapStubs(
  edges: readonly Record<string, unknown>[],
  onMapKeys: ReadonlySet<string>,
): Record<string, unknown>[]

export function buildMapLayers(arg: {
  hexes: readonly unknown[]
  edges: readonly unknown[]
  hedgehogs: readonly unknown[]
  /** 印刷轨距（全局值，专规 1.2）；自 rules.json exclusive_rules_smolensk.rail_gauge 派生 */
  railGauge?: 'broad' | 'standard'
}): Record<string, unknown>
