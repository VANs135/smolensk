import { mapConfig, mapLayers } from '@/data'
import type { HexRef } from '@/data'

/**
 * 六角格几何与距离（B6）
 *
 * 几何约定的唯一来源是**地图标定数据**与**源库格边数据**，本模块不自行假设：
 *   - `map-config.json`：orientation = `flat`（平顶六角）、offset = `even-q`（偶数列偏移）、
 *     bounds = 列 1–62 / 行 0–35（标定封版，**矩形外框**；图内实为 2156 格，矩形内 76 格在图外）；
 *   - **邻格与方向表**由源库 `map_edges.json` 的 6662 条边（每条带 `dir_a`）**全量归纳**，
 *     并用同一批边复算验证（方向与 Δ 同时吻合 6662 条、不吻合 0 条）；
 *   - 方向词表 `N/NE/SE/S/SW/NW` 取自源库 `dir_a` 的取值集合，不另造名称（CODE_SPEC §5）。
 *
 * **朝向约定（★ 用户裁定 2026-09-13：上北下南左西右东）**：
 *   行号增大 = **向北**，列号增大 = **向东**。故本模块的方向语义为：
 *     `N` 行 +1 ｜ `S` 行 −1 ｜ `NE`/`SE` 列 +1 ｜ `NW`/`SW` 列 −1；
 *   跨列方向的**行**增量取决于起始列奇偶（even-q 半格错位），但「北/南」的地理含义不变。
 *   两条独立证据：
 *     ① 标定公式 `y = 3947.5 − row·109.584 − (偶列 ? 54.792 : 0)`（y 越小越靠北）；
 *     ② 真实地名锚点——维捷布斯克(19.27) 在莫吉廖夫(15.10) 以北、维亚济马(56.20) 与
 *        勒热夫(60.34) 在斯摩棱斯克(34.17) 以东、博布鲁伊斯克(2.2) 在西南（见测试用例）。
 *
 * **距离计数约定**：源库未见「是否含起点/终点」的条文，故本模块只给**几何步数**
 * （两格间最短格数）。各规则章节的计数方式（12.3b 投递距离、13.4 炮兵射程、
 * 10.2b 近距 10 格、12.8e 突围 15 格等）由调用方按所属条款施加，本模块不替其决定。
 */

/** 六角格方向（源库 map_edges 的 dir_a 词表） */
export const HEX_DIRECTIONS = ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const

/** 方向类型 */
export type HexDirection = (typeof HEX_DIRECTIONS)[number]

/** 坐标增量 [Δ列, Δ行] */
type Delta = readonly [number, number]

/**
 * 邻格增量表（平顶 + even-q）
 *
 * 归纳结论：`N`/`S` 恒为 ±1 行；跨列时 Δ 行取决于**起始列奇偶**——
 * 偶列与奇列的半格偏移方向相反（这正是 even-q 的含义）。
 * 例：从偶列的 NE 落 (列+1, 行+1)，从奇列的 NE 落 (列+1, 行+0)。
 */
const NEIGHBOR_DELTAS: Record<HexDirection, { even: Delta; odd: Delta }> = {
  N: { even: [0, 1], odd: [0, 1] },
  NE: { even: [1, 1], odd: [1, 0] },
  SE: { even: [1, 0], odd: [1, -1] },
  S: { even: [0, -1], odd: [0, -1] },
  SW: { even: [-1, 0], odd: [-1, -1] },
  NW: { even: [-1, 1], odd: [-1, 0] },
}

/**
 * 地图范围（含端点），取自 map-config 的标定 bounds
 *
 * 注意：bounds 是**矩形外框**，不等于「图内格集合」——地图四边是削角的，
 * 矩形内有 76 格在图外（见 isOnMap）。bounds 只用于快速排除与坐标编码。
 */
export const HEX_BOUNDS = mapConfig.bounds

/** 行跨度（isOnMap 数值编码用） */
const ROW_SPAN = HEX_BOUNDS.rowEnd - HEX_BOUNDS.rowStart + 1

/**
 * 图内格集合（内部索引）
 *
 * 地图**不是矩形**：`map_hexes.meta.off_map_count = 76`，即 bounds 矩形内有 76 格在图外——
 *   - 奇数列（1/3/5/…/61）没有第 0 行；
 *   - 偶数列（2–10）没有行 31–35；
 *   - 奇数列（1–9）没有行 32–35。
 * 而**上/下边缘与西南角的 62 个半格**（源库 half_hexes.json，`on_map` 全为 true）是
 * **正常图内格**（★ 用户裁定 2026-09-13：半个格子也视为正常格子），已随格清单进入本集合，
 * 不得因其「只印了半个六角形」而判为图外。
 * 故「图内」只认**格清单**（map-layers.hexes，2156 格，含那 62 个半格）。
 * 索引 = `(col-colStart)·ROW_SPAN + (row-rowStart)`（数值编码，不引入字符串坐标键，CODE_SPEC §4）；
 * 越界坐标在查表前已被 bounds 拦掉，故不会与图内索引相撞。
 */
const ON_MAP_CELLS: ReadonlySet<number> = new Set(
  mapLayers.hexes.map(
    (hex) => (hex.col - HEX_BOUNDS.colStart) * ROW_SPAN + (hex.row - HEX_BOUNDS.rowStart),
  ),
)

/**
 * 几何契约自检（导入期执行）
 *
 * 邻格表按「平顶 + even-q」归纳；若标定改成别的朝向/偏移，必须重做归纳表，
 * 故在此直接拒绝，避免静默算错邻居（宁可在导入期炸，也不在结算里错）。
 */
if (mapConfig.orientation !== 'flat' || mapConfig.offset !== 'even-q') {
  throw new Error(
    `[hex-geometry] 不支持的网格标定：orientation=${mapConfig.orientation}、offset=${mapConfig.offset}；` +
      '本邻格表按 flat + even-q 归纳，换标定须重新归纳',
  )
}

/** 列奇偶（列号可能为负，故取模后归一） */
function isEvenColumn(col: number): boolean {
  return ((col % 2) + 2) % 2 === 0
}

/** 两格是否同一格 */
export function sameHex(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}

/** 是否在标定矩形外框内（仅作前置排除，不代表该格存在） */
function isWithinBounds(hex: HexRef): boolean {
  return (
    hex.col >= HEX_BOUNDS.colStart &&
    hex.col <= HEX_BOUNDS.colEnd &&
    hex.row >= HEX_BOUNDS.rowStart &&
    hex.row <= HEX_BOUNDS.rowEnd
  )
}

/**
 * 是否在**图内**（图外盒、边缘盒与矩形内的削角空洞都不算）
 *
 * 判据是**格清单**而不是 bounds 矩形：地图四边削角，矩形内的 76 格在图外
 * （map_hexes.meta.off_map_count = 76）。用矩形判定的旧实现会把 1.0、3.0、1.32 等
 * 图外格当成图内格，使 onMapNeighbors / hexesWithin / ZOC 覆盖越到图外。
 */
export function isOnMap(hex: HexRef): boolean {
  if (!isWithinBounds(hex)) return false
  return ON_MAP_CELLS.has(
    (hex.col - HEX_BOUNDS.colStart) * ROW_SPAN + (hex.row - HEX_BOUNDS.rowStart),
  )
}

/**
 * 图上**所有**格（枚举用：候选落点遍历 / 覆盖层全图扫）
 *
 * 直接按 `HEX_BOUNDS` 矩形逐格探 `isOnMap`（地图四边削角，矩形内 76 格在图外，
 * 故不能用纯矩形，必须逐格判 `isOnMap`）。返回顺序为列主序、行递增。
 */
export function allMapHexes(): HexRef[] {
  const out: HexRef[] = []
  for (let col = HEX_BOUNDS.colStart; col <= HEX_BOUNDS.colEnd; col += 1) {
    for (let row = HEX_BOUNDS.rowStart; row <= HEX_BOUNDS.rowEnd; row += 1) {
      const hex = { col, row }
      if (isOnMap(hex)) out.push(hex)
    }
  }
  return out
}

/**
 * 是否位于**南缘**（该格没有图内南邻）
 *
 * ★ 不能写成 `row === bounds.rowStart`：**奇数列没有第 0 行**（最小行为 1，已用
 * `map-layers.hexes` 逐格核实），故 13.01 / 29.01 这类南缘格会被漏掉。
 * 供专规 2.1a「Entry E 及以西的南缘补给源关闭」使用。
 */
export function isSouthEdge(hex: HexRef): boolean {
  return !isOnMap({ col: hex.col, row: hex.row - 1 })
}

/** 指定方向的邻格（**不做边界判定**；图外也可能返回，配合 isOnMap 使用） */
export function neighbor(hex: HexRef, direction: HexDirection): HexRef {
  const delta = isEvenColumn(hex.col)
    ? NEIGHBOR_DELTAS[direction].even
    : NEIGHBOR_DELTAS[direction].odd
  return { col: hex.col + delta[0], row: hex.row + delta[1] }
}

/** 六向邻格（含方向标签，不做边界过滤；顺序同 HEX_DIRECTIONS） */
export function neighbors(hex: HexRef): { direction: HexDirection; hex: HexRef }[] {
  return HEX_DIRECTIONS.map((direction) => ({ direction, hex: neighbor(hex, direction) }))
}

/** 图内六向邻格（过滤越界） */
export function onMapNeighbors(hex: HexRef): { direction: HexDirection; hex: HexRef }[] {
  return neighbors(hex).filter((entry) => isOnMap(entry.hex))
}

/**
 * 是否位于**北缘**（没有图内北邻）
 *
 * N 的增量对两种列奇偶都是 `[0, +1]`，故判据可直接看 `(col, row+1)`。
 *
 * ★ 不要用「行号 ≥ 上界 − 1」这类近似：实测在本作地图上它会**多算 52 格**
 *   （所有第 34 行都有第 35 行的北邻）并**漏掉 10 格**真北缘
 *   （`1.31 / 2.30 / … / 10.30`——西北削角处北界实际落在 30/31 行）。
 */
export function isNorthEdge(hex: HexRef): boolean {
  return !isOnMap(neighbor(hex, 'N'))
}

/**
 * 是否位于**西缘**（NW 与 SW 两个方向都没有图内邻格）
 *
 * ★ 错位六角格**没有「同行西邻」**（见 `NEIGHBOR_DELTAS` 的 SW/NW 两行），
 *   故不能用「列号 ≤ 某个小值」判定：实测本作地图上 `col <= 4` 会**多算 93 格**
 *   并**漏掉 4 格**真西缘（`11.32…11.35`——西北削角处西界由 1 列东移到 11 列）。
 */
export function isWestEdge(hex: HexRef): boolean {
  return !isOnMap(neighbor(hex, 'NW')) && !isOnMap(neighbor(hex, 'SW'))
}

/** 由起点到终点解析方向；两者不相邻时返回 null（方向名字与源库 dir_a 一致） */
export function directionOf(from: HexRef, to: HexRef): HexDirection | null {
  for (const direction of HEX_DIRECTIONS) {
    if (sameHex(neighbor(from, direction), to)) return direction
  }
  return null
}

/** 两格是否相邻（互为六向邻格） */
export function areAdjacent(a: HexRef, b: HexRef): boolean {
  return directionOf(a, b) !== null
}

/** 相反方向（N↔S / NE↔SW / SE↔NW）；同一条格边在两侧格上的表述 */
const OPPOSITE_DIRECTIONS: Record<HexDirection, HexDirection> = {
  N: 'S',
  S: 'N',
  NE: 'SW',
  SW: 'NE',
  SE: 'NW',
  NW: 'SE',
}

/** 反向方向解析（方向解析的一部分；与 neighbor 一致：`neighbor(neighbor(h,d), 反(d)) === h`） */
export function oppositeDirection(direction: HexDirection): HexDirection {
  return OPPOSITE_DIRECTIONS[direction]
}

/**
 * 格边（两相邻格共用的那条边）
 *
 * 一条格边由**无序的两端**唯一确定：同一格边从两端看方向相反（见 oppositeDirection）。
 * `key` 沿用工程库 `edge_key` 的写法 `"hexA|hexB"`（格号 `列.行`，按**字符串字典序**排序），
 * 便于用同一把钥匙索引 map-layers.json 的 edges（其 a/b 未必按此序存放）。
 *
 * 注意：`key` 是**静态地图数据的索引键**，不是状态里的坐标键——状态坐标一律对象 { col, row }（CODE_SPEC §4）。
 */
export interface Hexside {
  /** 规范化标识 `"c1.r1|c2.r2"`（字符串字典序，与工程库 edge_key 同规） */
  key: string
  /** 字典序在前的一端 */
  a: HexRef
  /** 字典序在后的一端 */
  b: HexRef
}

/** 格号文本（`列.行`）；仅供格边标识使用，状态与业务坐标一律用 { col, row } */
function hexId(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

/** 两格间的格边；两格不相邻时返回 null（不存在的边不造键） */
export function hexsideOf(a: HexRef, b: HexRef): Hexside | null {
  if (!areAdjacent(a, b)) return null
  const idA = hexId(a)
  const idB = hexId(b)
  return idA < idB ? { key: `${idA}|${idB}`, a, b } : { key: `${idB}|${idA}`, a: b, b: a }
}

/**
 * 偏移坐标 → 立方坐标
 *
 * 变换由上述邻格表**反解**得到，并由测试全量自检：
 * 六个方向的邻居在立方坐标下都必须恰为 1 步（`hexDistance === 1`）。
 */
function toCube(hex: HexRef): { x: number; y: number; z: number } {
  const x = hex.col
  const z = hex.row - (hex.col + (hex.col & 1)) / 2
  return { x, y: -x - z, z }
}

/** 立方坐标 → 偏移坐标（toCube 的逆变换） */
function fromCube(cube: { x: number; y: number; z: number }): HexRef {
  const col = cube.x
  return { col, row: cube.z + (col + (col & 1)) / 2 }
}

/** 两格之间的最短格数（几何步数；计数约定由调用方按规则章节施加） */
export function hexDistance(a: HexRef, b: HexRef): number {
  const ca = toCube(a)
  const cb = toCube(b)
  return (Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y) + Math.abs(ca.z - cb.z)) / 2
}

/** 半径内全部格（含中心；按 距离 → 列 → 行 排序，保证确定性） */
export function hexesWithin(
  center: HexRef,
  radius: number,
  options: { onMapOnly?: boolean } = {},
): HexRef[] {
  if (!Number.isInteger(radius) || radius < 0) {
    throw new RangeError(`半径须为 ≥0 的整数，收到 ${radius}`)
  }

  const base = toCube(center)
  const found: HexRef[] = []
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = Math.max(-radius, -dx - radius); dy <= Math.min(radius, -dx + radius); dy += 1) {
      const hex = fromCube({ x: base.x + dx, y: base.y + dy, z: base.z - dx - dy })
      if (options.onMapOnly === true && !isOnMap(hex)) continue
      found.push(hex)
    }
  }

  return found.sort(
    (p, q) => hexDistance(center, p) - hexDistance(center, q) || p.col - q.col || p.row - q.row,
  )
}
