/**
 * 地图图层数据同步脚本（A4 产出 map-layers.json）
 *
 * 数据源（斯摩棱斯克工程数据库，2026-09-12 标定/判读封版）：
 *   - map_hexes.json：逐格地形（terrain / terrains_present / movement_terrain）、
 *     城市（city_hex / city_name / city_level / city_role）、入口字母与补给源标记
 *   - map_edges.json：格边（6662 条封版）——河流（edge_terrain + river_class）、
 *     道路（road_present + road_subclass：Secondary Road / Track）、
 *     铁路（rail_present；轨数 rail_track：single / multi）、桥梁（bridge）
 *     ★ 单/多轨**按格边导出**（`multiTrack: true`，125/360 条铁路格边为多轨；其余一律单轨）：
 *       13.3a 的「全程多轨减半」判在格边上，故产物必须携带该位——2026-09-15 起由引擎
 *       `createRailGraph#isMultiTrackEdge` 消费（此前只导出 `rail: true`，减半条款无从生效）。
 *   - 图边终止（offMapStub）**不由源库旗标搬运**，而由图内格清单判定（见 markOffMapStubs）：
 *     源库 off_map_stub 只覆盖「图面矩形之外」的一端，会漏掉矩形内削角处的边（实测 81 条）。
 *   - rules.json exclusive_rules_smolensk.rail_gauge：**轨距是全局值**（专规 1.2：苏仅宽轨／轴仅标准轨）。
 *     DB 侧已在 Y4 去冗余中删掉逐格 rail_gauge 列
 *     （map_edges.meta.field_merge_20260913.derivations.轨距：全库同值，只保留一份），
 *     故本脚本改从规则取一次、写在产物顶层 railGauge；逐格的运行期轨距由引擎按 13.3f 换轨维护。
 *   - map_facilities.json：地图印刷永久工事（printed_hedgehog × 57，level 全 1，苏联，不可降低）
 *     2026-09-14 目检改判：36.18 该格无印刷工事，已从本作产物删除（原 59 → 现 58）。
 *     2026-09-15 像素复核改判：7.8 该格原图无工事符号，已删除（58 → 现 57）。
 *     权威源 map_facilities.json 仍含该条，故本脚本以 `PRINTED_HEDGEHOG_EXCLUSIONS` 显式排除
 *     （若不排除，重跑会把它恢复；排除项失效时脚本会抛错提示，见该常量注释）。
 *     剧本归属账本（scenarios.json → setup.printedHedgehogOwners.axisOwned）已同步移除该格。
 *
 * 运行时只保留"有意义"的格边（河/路/铁/桥任一），并统一为 { col, row } 坐标
 * （本作无字母前缀约定）；城市/入口等分散字段并入 per-hex 记录。
 * 胜利格、入口字母、分界线端点已在 map-config.json（A3），本文件不重复。
 *
 * 运行：node scripts/sync-map-layers.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

import { decideOverwrite, refusalLines } from './overwrite-guard.mjs'

/** 与数据管线 DATA_VERSION 保持一致的产物版本 */
export const MAP_LAYERS_VERSION = '0.4.0'

/** "36.13" → { col, row }（本作无字母前缀） */
export function parseHexRef(hexId) {
  const [col, row] = hexId.split('.').map(Number)
  if (!Number.isInteger(col) || !Number.isInteger(row)) throw new Error(`无法解析格号：${hexId}`)
  return { col, row }
}

/** map_hexes 单条 → 运行时 per-hex 记录（城市/入口/补给源合并） */
export function toHexLayer(item) {
  const entry = {
    col: item.col,
    row: item.row,
    terrain: item.terrain,
    terrainsPresent: item.terrains_present?.length ? item.terrains_present : [item.terrain],
    movementTerrain: item.movement_terrain ?? item.terrain,
  }
  if (item.city_hex === true || item.city_name) {
    entry.city = {
      ...(item.city_name ? { name: item.city_name } : {}),
      ...(item.city_level ? { level: item.city_level } : {}),
      ...(item.city_role ? { role: item.city_role } : {}),
    }
  }
  if (item.entry_letter) entry.entryLetter = item.entry_letter
  if (item.supply_source === true) entry.supplySource = true
  return entry
}

/** map_edges 单条 → 运行时格边记录（仅保留有要素的边） */
export function toEdgeLayer(edge) {
  const entry = { ...orderedEnds(edge.hex_a, edge.hex_b) }
  if (edge.edge_terrain === 'river') entry.river = edge.river_class === 'major' ? 'major' : 'minor'
  else if (edge.edge_terrain === 'lake') entry.river = 'lake'
  if (edge.road_present)
    entry.road = edge.road_subclass === 'Secondary Road' ? 'secondary' : 'track'
  if (edge.rail_present) {
    entry.rail = true // 轨距是全局值，见 railGauge／专规 1.2
    // 13.3a：单/多轨来自源库 rail_track（用户逐段口述裁定）；只写「多轨」一侧，缺省＝单轨
    if (edge.rail_track === 'multi') entry.multiTrack = true
  }
  if (edge.bridge === true) entry.bridge = true
  return entry
}

/**
 * 标注图边终止（`offMapStub`）
 *
 * 语义是**地理事实**（见 EdgeLayerSchema.offMapStub）：该格边至少有一端不在图内——
 * 包括 A–L 入口对应的西缘边，以及四边削角处通往图外格的边；这类格边引擎不得作为可进入格。
 *
 * 判据取**图内格清单**（map-layers.hexes），不搬源库的 `off_map_stub` 旗标：
 * 后者只覆盖「图面矩形之外」的一端（col 0 / row 36），会漏掉矩形内削角处的边
 * （实测：全库 6662 边中有 120 条端点在图外却未标 stub，其中 81 条是 map_edge 边）。
 * 判定与引擎 `isOnMap` 同源，故产物字段与引擎判据恒等（契约测试断言 ⇔）。
 *
 * @param edges      已映射的格边记录
 * @param onMapKeys  图内格键集合（`"列.行"`）
 */
export function markOffMapStubs(edges, onMapKeys) {
  return edges.map((edge) => {
    const a = `${edge.a.col}.${edge.a.row}`
    const b = `${edge.b.col}.${edge.b.row}`
    return onMapKeys.has(a) && onMapKeys.has(b) ? edge : { ...edge, offMapStub: true }
  })
}

/**
 * 规范化格边的两端（a / b）
 *
 * 格边是**无序**的一对相邻格：源库同一条边可能写成 `hex_a="1.1" hex_b="1.0"`，
 * 而工程库的 `edge_key` 一律按**格号字符串字典序**归一为 `"1.0|1.1"`。
 * 本函数照此归一，使产物满足 `a < b`（字符串序）且 `"a|b"` 恒等于源库 `edge_key`，
 * 从而与 EdgeLayerSchema 的契约注释一致、并让同一格边在产物中顺序唯一确定。
 */
function orderedEnds(hexA, hexB) {
  const [first, second] = hexA < hexB ? [hexA, hexB] : [hexB, hexA]
  return { a: parseHexRef(first), b: parseHexRef(second) }
}

/** map_facilities 单条 → 印刷永久工事记录 */
export function toHedgehogLayer(item) {
  const { col, row } = parseHexRef(item.hex_id)
  return {
    col,
    row,
    level: item.level,
    permanent: item.permanent === true,
    cannotReduce: item.cannot_reduce === true,
  }
}

/**
 * 印刷永久工事的**人工改判排除项**（门禁加固 B0①）
 *
 * 2026-09-14 目检改判：36.18 该格无印刷工事，已从本作产物删除（原 59 → 现 58）。
 * 2026-09-15 用户指出 7.08 也是错项（「之前修改数据库的遗漏项」）⇒ 按**地图像素**复核：
 *   7.8 的 `symbol_px.center_map_px = (703, 3051)`，在原图 `Smolensk-map-011717.png` 上裁出后
 *   只有沼泽、铁路与林地图案，**没有工事符号**；对照 58.35 / 15.11 / 20.7 三格都能看到
 *   红圈「1」的印刷工事符号（裁图见 `backup/2026-09-16-hedgehog-708/crops/hedgehog-px.png`）。
 *   ⇒ 从产物删除（58 → 现 57）。
 * 权威源 `map_facilities.json` **仍含这两条**，故必须在脚本里显式排除，否则重跑会把它们恢复
 * ——而剧本归属账本（`scenarios.json → setup.printedHedgehogOwners.axisOwned`）不含这两格，
 * 恢复后产物内部自相矛盾（地图多一处工事、归属账本没有它）。
 */
export const PRINTED_HEDGEHOG_EXCLUSIONS = ['36.18', '7.8']

/**
 * 印刷永久工事清单（纯函数）：源库条目 → 产物记录，剔除人工改判项
 *
 * @throws Error 排除项在源库中已不存在时——那说明权威源已被修正，
 *   此处的排除项已退化为"永不生效的死规则"，应当删掉而不是留着。
 */
export function selectPrintedHedgehogs(items) {
  const printed = items.filter((item) => item.kind === 'printed_hedgehog')
  const presentInSource = new Set(printed.map((item) => item.hex_id))

  const stale = PRINTED_HEDGEHOG_EXCLUSIONS.filter((hexId) => !presentInSource.has(hexId))
  if (stale.length > 0)
    throw new Error(
      `[sync-map-layers] 排除项在源库中已不存在：${stale.join('、')}。` +
        '若权威源已修正该格，请从 PRINTED_HEDGEHOG_EXCLUSIONS 删除该条。',
    )

  const excluded = new Set(PRINTED_HEDGEHOG_EXCLUSIONS)
  return printed.filter((item) => !excluded.has(item.hex_id)).map(toHedgehogLayer)
}

/** 组装运行时 map-layers.json（纯函数，供单测） */
export function buildMapLayers({ hexes, edges, hedgehogs, railGauge }) {
  return {
    meta: {
      version: MAP_LAYERS_VERSION,
      description:
        '地图图层（A4）：逐格地形与城市 / 格边（河·路·铁·桥，铁路含单·多轨）/ 印刷永久工事（专规 1.3a 不可降低）；坐标 = 无字母前缀 {col,row}；轨距为全局值见 railGauge（专规 1.2）',
      source: [
        'map_hexes.json（2026-09-12 地形判读封版）',
        'map_edges.json（2026-09-12 河流/道路/铁路封版，6662 边）',
        'map_edges.json rail_track（2026-09-12/15 用户逐段口述的多轨走线 9 段 ⇒ multi 125 条，其余单轨；13.3a 全程多轨减半）',
        'map_facilities.json（printed_hedgehog × 57，用户目检）',
        // 与 PRINTED_HEDGEHOG_EXCLUSIONS 同源的改判溯源：两者必须一起改
        '2026-09-14 目检改判：删除 36.18 的印刷工事（59 → 58）；scenarios.json 归属账本同步移除该格',
        '2026-09-15 像素复核改判：删除 7.8 的印刷工事（58 → 57）；该格原图无工事符号（裁图见 backup/2026-09-16-hedgehog-708/）',
        'rules.json exclusive_rules_smolensk.rail_gauge（专规 1.2 轨距，全局值）',
      ],
    },
    /** 印刷轨距（全局，专规 1.2：本作地图铁路即苏方路网，开局全为宽轨）；逐格换轨见通规 13.3f */
    railGauge,
    hexes,
    edges,
    printedHedgehogs: hedgehogs,
  }
}

/* ── 主流程（仅直接运行本脚本时执行） ── */
async function main() {
  const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'
  const cwd = dirname(fileURLToPath(import.meta.url))
  const OUT_FILE = join(cwd, '..', 'src', 'data', 'map-layers.json')
  const read = (name) => JSON.parse(readFileSync(join(DB_DIR, name), 'utf8'))

  const mapHexes = read('map_hexes.json')
  const mapEdges = read('map_edges.json')
  const facilities = read('map_facilities.json')
  const rules = read('rules.json')

  // 轨距（专规 1.2）：苏仅宽轨／轴仅标准轨。本作地图铁路即苏方路网，故印刷轨距为宽轨。
  // 出图省：DB 已删逐格 rail_gauge 列（Y4 合并），此处自规则取一次作为全局开局值。
  const railGauge = /broad/.test(rules.exclusive_rules_smolensk?.rail_gauge?.soviet?.gauge ?? '')
    ? 'broad'
    : 'standard'

  const hexes = mapHexes.items.filter((item) => item.on_map === true).map(toHexLayer)
  // 图内格清单是「图内/图外」的唯一判据（地图四边削角，bounds 矩形不等于图内格集合）
  const onMapKeys = new Set(hexes.map((hex) => `${hex.col}.${hex.row}`))
  const edges = markOffMapStubs(
    mapEdges.items
      .map(toEdgeLayer)
      .filter(
        (e) =>
          e.river !== undefined || e.road !== undefined || e.rail === true || e.bridge === true,
      ),
    onMapKeys,
  )
  const hedgehogs = selectPrintedHedgehogs(facilities.items)

  const next = buildMapLayers({ hexes, edges, hedgehogs, railGauge })

  const text = JSON.stringify(next, null, 2) + '\n'
  const config = await resolveConfig(OUT_FILE)
  const formatted = await format(text, { ...config, parser: 'json' })

  const existingText = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : null
  const decision = decideOverwrite({
    nextText: formatted,
    existingText,
    force: process.argv.includes('--force'),
  })
  if (!decision.ok) {
    for (const line of refusalLines({
      outFile: OUT_FILE,
      preserved: PRINTED_HEDGEHOG_EXCLUSIONS.map((hexId) => `印刷工事人工改判排除 ${hexId}`),
    }))
      console.error(line)
    process.exit(1)
  }

  writeFileSync(OUT_FILE, formatted, 'utf8')
  console.log(
    `written map-layers.json（格 ${hexes.length} · 有要素格边 ${edges.length} · 印刷工事 ${hedgehogs.length} · ${decision.reason}）`,
  )
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
