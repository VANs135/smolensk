/**
 * 初设索引同步脚本（A8 产出 scenario-setup.json）
 *
 * 数据源：斯摩棱斯克工程数据库 setup_index.json（1155 条，scenario_id ∈ {1,3,5,7}）
 * 只搬初设条目，不搬运行时状态。位置为印刷格号或原文标签
 * （『死亡堆』『At any air bases』『w/i 3 hexes of …』『Stacked with any … HQs』）。
 *
 * 数量注记（SP / 空军基地等级 / 运输点）为独立条目（kind = sp / airbase / transport_point），
 * 与同格单位通过 location 关联（coLocated）。
 *
 * 运行：node scripts/sync-scenario-setup.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

/** 与数据管线 DATA_VERSION 保持一致的产物版本（见 src/data/version.ts） */
export const SCENARIO_SETUP_VERSION = '0.4.0'

/** '2.02' → { col: 2, row: 2 }；非格号原文标签返回 null */
export function parseHexRefSafe(text) {
  const match = String(text).match(/^(\d+)\.(\d+)$/)
  if (!match) return null
  return { col: Number(match[1]), row: Number(match[2]) }
}

/** 位置格号清单 → 可解析的坐标引用 */
export function parseHexRefs(hexes) {
  const refs = []
  for (const hex of hexes ?? []) {
    const ref = parseHexRefSafe(hex)
    if (ref) refs.push(ref)
  }
  return refs
}

/** 编队下属：snake → camelCase（含 Z2 的 unit_id 链接） */
export function toSubordinate(sub) {
  const out = {
    component: sub.component,
    name: sub.name,
    raw: sub.raw,
    isOrganicTruck: sub.is_organic_truck === true,
  }
  if (sub.establishment != null) out.establishment = sub.establishment
  if (sub.location_kind != null) out.locationKind = sub.location_kind
  if (sub.location != null) out.location = sub.location
  if (sub.unit_id != null) out.unitId = sub.unit_id
  if (sub.link_basis != null) out.linkBasis = sub.link_basis
  return out
}

/** 单条初设条目：snake → camelCase，nullish 字段省略 */
export function toSetupEntry(item) {
  const locationHexes = item.location_hexes ?? []
  const out = {
    scenarioId: String(item.scenario_id),
    side: item.side,
    groupLabel: item.group_label,
    kind: item.kind,
    count: item.count,
    raw: item.raw,
    placementType: item.placement_type,
    nation: item.nation,
    locationHexes,
  }

  if (item.location_kind != null) out.locationKind = item.location_kind
  if (item.location != null) out.location = item.location
  if (item.name != null) out.name = item.name
  if (item.factors != null) out.factors = item.factors
  if (item.designation != null) out.designation = item.designation
  if (item.parent_type != null) out.parentType = item.parent_type
  if (item.placement_note != null) out.placementNote = item.placement_note
  if (item.placement_tolerance != null) out.placementTolerance = item.placement_tolerance
  if (item.placement_tolerance_note != null)
    out.placementToleranceNote = item.placement_tolerance_note
  if (item.step_penalty != null) out.stepPenalty = item.step_penalty
  if (item.step_penalty_note != null) out.stepPenaltyNote = item.step_penalty_note
  if (item.setup_mode != null) out.setupMode = item.setup_mode
  if (item.errata_move_mode != null) out.errataMoveMode = item.errata_move_mode
  if (item.errata_ref != null) out.errataRef = item.errata_ref
  if (item.corrected != null) out.corrected = item.corrected
  if (item.co_located?.length) out.coLocated = item.co_located
  // Z2（2026-09-13）：条目 → 算子库/空军库的**显式链接**，自动初设据此落子（不靠名字猜）
  if (item.unit_id != null) out.unitId = item.unit_id
  if (item.unit_id_kind != null) out.unitIdKind = item.unit_id_kind
  if (item.link_basis != null) out.linkBasis = item.link_basis
  if (item.subordinates?.length) out.subordinates = item.subordinates.map(toSubordinate)

  const refs = parseHexRefs(locationHexes)
  if (refs.length > 0) out.locationRefs = refs

  return out
}

/** 初设索引语义注记（源 meta：条目键 / 放置类别 / 标记说明 / 国别与数量注记） */
export function toSetupNotes(meta) {
  const placement = meta.placement_note ?? {}
  const out = {
    placementKinds: placement.kinds ?? [],
    markerNotes: meta.marker_notes ?? {},
  }
  if (meta.key) out.entryKey = meta.key
  if (placement.multiplicity) out.multiplicity = placement.multiplicity
  if (meta.nation_note) out.nationNote = meta.nation_note
  if (meta.quantity_note) out.quantityNote = meta.quantity_note
  return out
}

/** 组装运行时 scenario-setup.json（纯函数，供单测） */
export function buildScenarioSetup({ setupIndexDb }) {
  return {
    meta: {
      version: SCENARIO_SETUP_VERSION,
      description:
        '初设索引（A8）：逐条记录剧本 1/3/5/7 的单位位置、减损、移动模式初设、† 容差、勘误、算子链接（unitId）与数量注记（SP/基地/运输点）；只搬初设条目不搬运行时状态',
      source: ['setup_index.json（smolensk_unit_roster.json → scenarios[].groups 派生的初设条目）'],
    },
    notes: toSetupNotes(setupIndexDb.meta ?? {}),
    entries: setupIndexDb.items.map(toSetupEntry),
  }
}

/* ── 主流程（仅直接运行本脚本时执行） ── */
async function main() {
  const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'
  const cwd = dirname(fileURLToPath(import.meta.url))
  const OUT_FILE = join(cwd, '..', 'src', 'data', 'scenario-setup.json')
  const setupIndexDb = JSON.parse(readFileSync(join(DB_DIR, 'setup_index.json'), 'utf8'))

  const next = buildScenarioSetup({ setupIndexDb })

  const text = JSON.stringify(next, null, 2) + '\n'
  const config = await resolveConfig(OUT_FILE)
  const formatted = await format(text, { ...config, parser: 'json' })
  writeFileSync(OUT_FILE, formatted, 'utf8')
  console.log(`written scenario-setup.json（初设条目 ${next.entries.length}）`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
