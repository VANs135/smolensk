/**
 * 网格标定数据同步脚本（A3 产出 map-config.json）
 *
 * 数据源（斯摩棱斯克工程数据库，2026-09-12 标定完成）：
 *   - map_hexes.json：2156 格（含半格/图外格）；meta.calibration 提供 VERIFIED 几何公式：
 *       x = 112.5 + (col−1)·94.905 ;  y = 3947.5 − row·109.584 − (col 偶 ? 54.792 : 0)
 *     工厂对全量 on-map 格逐格重算 center_px 与数据比对（容差 0.21px），超差即退出——
 *     保证 geometry 参数与标定底层一致，而非凭印象填数。
 *   - entry_hexes.json：入口字母（A–L）→ 格号（人工目检录入；一字母可对应多格）
 *   - rules.json：victory.listed_hexes（5.0c 通用 11 格）与 guderian_hoth.boundary（3.4a 分界线）
 *
 * 坐标约定：本作单幅地图、编号无字母前缀，印刷编号即 列.行；程序坐标一律 { col, row }。
 * rowDecode：程序行 = 印刷行（恒等，已由 hex_id ↔ 行列逐格校核证明），输出空表以表明无需转换。
 *
 * 运行：node scripts/sync-map-config.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

/** 与数据管线 DATA_VERSION 保持一致的产物版本 */
export const MAP_CONFIG_VERSION = '0.4.0'

/** 标定公式参数（来源 map_hexes meta.calibration，VERIFIED） */
export const CALIBRATION = {
  hexWidthPx: 94.905,
  hexHeightPx: 109.584,
  originX: 112.5,
  originY: 3947.5,
  /** 偶数列在 y 方向的半格偏移（= hexHeightPx / 2） */
  evenColumnOffsetPx: 54.792,
}

/** 按标定公式重算某格的格心像素（flat-top、偶数列下移半格） */
export function centerByCalibration(col, row) {
  const x = CALIBRATION.originX + (col - 1) * CALIBRATION.hexWidthPx
  const y =
    CALIBRATION.originY -
    row * CALIBRATION.hexHeightPx -
    (col % 2 === 0 ? CALIBRATION.evenColumnOffsetPx : 0)
  return [x, y]
}

/** 全量校核：on-map 完整格逐格重算 center_px（容差 eps），返回差异样本 */
export function verifyCalibration(items, eps = 0.21) {
  const errors = []
  for (const item of items) {
    if (!item.on_map || item.state !== 'full') continue
    const expected = centerByCalibration(item.col, item.row)
    const [x, y] = item.center_px ?? [Number.NaN, Number.NaN]
    if (Math.abs(x - expected[0]) > eps || Math.abs(y - expected[1]) > eps) {
      errors.push({ hex: item.hex_id, actual: item.center_px, expected })
      if (errors.length >= 5) break
    }
  }
  return errors
}

/** "36.13" / "19.19" → { col, row }（本作无字母前缀） */
export function parseHexRef(hexId) {
  const [col, row] = hexId.split('.').map(Number)
  if (!Number.isInteger(col) || !Number.isInteger(row)) throw new Error(`无法解析格号：${hexId}`)
  return { col, row }
}

/** 由 map_hexes items 求行列范围（含半格/图外格） */
export function computeBounds(items) {
  let colStart = Number.POSITIVE_INFINITY
  let colEnd = Number.NEGATIVE_INFINITY
  let rowStart = Number.POSITIVE_INFINITY
  let rowEnd = Number.NEGATIVE_INFINITY
  for (const item of items) {
    colStart = Math.min(colStart, item.col)
    colEnd = Math.max(colEnd, item.col)
    rowStart = Math.min(rowStart, item.row)
    rowEnd = Math.max(rowEnd, item.row)
  }
  return { colStart, colEnd, rowStart, rowEnd }
}

/** 由 entry_hexes items 聚合：字母 → 坐标列表（保序） */
export function buildEntryHexes(entryItems) {
  const grouped = new Map()
  for (const item of entryItems) {
    if (!item.letter) continue
    const list = grouped.get(item.letter) ?? []
    list.push({ col: item.col, row: item.row })
    grouped.set(item.letter, list)
  }
  return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

/** 解析 victory.listed_hexes：'36.13 Pochinok' → { col, row } */
export function parseVictoryLocations(listed) {
  return listed.map((entry) => parseHexRef(entry.trim().split(/\s+/)[0]))
}

/** 解析分界线端点：'… from 19.19 to 62.23' → [{…}, {…}] */
export function parseBoundary(description) {
  const match = description.match(/from\s+(\d+\.\d+)\s+to\s+(\d+\.\d+)/)
  if (!match) throw new Error(`无法解析分界线端点：${description}`)
  return [parseHexRef(match[1]), parseHexRef(match[2])]
}

/** 组装运行时 map-config.json 结构（纯函数，供单测） */
export function buildMapConfig({
  mapHexes,
  entryItems,
  listedHexes,
  boundary,
  orientation = 'flat',
  offset = 'even-q',
}) {
  const bounds = computeBounds(mapHexes)
  return {
    meta: {
      version: MAP_CONFIG_VERSION,
      description:
        '网格标定（A3）：行列范围 / 格心公式 / 奇偶列偏移 / rowDecode(恒等) / 入口字母 A–L / 胜利格 11 / 分界线端点；坐标约定 = 无字母前缀的 {col,row}',
      source: [
        'map_hexes.json（2026-09-12 标定，2156 格，几何公式 VERIFIED）',
        'entry_hexes.json（入口字母人工目检录入）',
        'rules.json victory.listed_hexes / guderian_hoth.boundary',
      ],
    },
    orientation,
    offset,
    bounds,
    geometry: {
      hexWidthPx: CALIBRATION.hexWidthPx,
      hexHeightPx: CALIBRATION.hexHeightPx,
      originX: CALIBRATION.originX,
      originY: CALIBRATION.originY,
    },
    // 印刷行 = 程序行（恒等）：无需二次转换，空表即"原样索引"
    rowDecode: {},
    entryHexes: buildEntryHexes(entryItems),
    victoryLocations: parseVictoryLocations(listedHexes),
    panzerGroupBoundary: [parseBoundary(boundary)],
  }
}

/* ── 主流程（仅直接运行本脚本时执行） ── */
async function main() {
  const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'
  const cwd = dirname(fileURLToPath(import.meta.url))
  const OUT_FILE = join(cwd, '..', 'src', 'data', 'map-config.json')
  const read = (name) => JSON.parse(readFileSync(join(DB_DIR, name), 'utf8'))

  const mapHexes = read('map_hexes.json')
  const entryHexes = read('entry_hexes.json')
  const rules = read('rules.json')
  const smolensk = rules.exclusive_rules_smolensk

  const errors = verifyCalibration(mapHexes.items)
  if (errors.length > 0) {
    console.error('标定公式与 map_hexes 数据不一致，拒绝生成：')
    for (const e of errors)
      console.error(
        `  ${e.hex}: 数据 ${JSON.stringify(e.actual)} ≠ 公式 ${JSON.stringify(e.expected)}`,
      )
    process.exit(1)
  }

  const next = buildMapConfig({
    mapHexes: mapHexes.items,
    entryItems: entryHexes.items,
    listedHexes: smolensk.victory.listed_hexes,
    boundary: smolensk.axis_special.guderian_hoth.boundary,
  })

  const text = JSON.stringify(next, null, 2) + '\n'
  const config = await resolveConfig(OUT_FILE)
  const formatted = await format(text, { ...config, parser: 'json' })
  writeFileSync(OUT_FILE, formatted, 'utf8')
  console.log(
    `written map-config.json（bounds ${next.bounds.colStart}.xx–${next.bounds.colEnd}.xx × ${next.bounds.rowStart}–${next.bounds.rowEnd} · 入口字母 ${Object.keys(next.entryHexes).length} · 胜利格 ${next.victoryLocations.length} · 公式全量校核通过）`,
  )
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
