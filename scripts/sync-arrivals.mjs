/**
 * 到达表同步脚本（A8 产出 arrivals-axis.json / arrivals-soviet.json）
 *
 * 数据源：斯摩棱斯克工程数据库 arrivals.json（按到达卡逐栏实物核对，status = verified）
 *   - axis：header / dates[12] / arrival_notes / variable_exit（3.3c）/ random_events（3.6）
 *   - soviet：header / dates[14] / arrival_notes / special_repl（1.6c）
 *
 * 日期块结构：date + notes + entries（入口 → 单位原文串）+ anyAirbase / remove / deadPile / anyWestEdge。
 * 单位**按原文搬运**，不做 id 映射（到达卡只印单位名与番号）。
 *
 * 运行：node scripts/sync-arrivals.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

/** 与数据管线 DATA_VERSION 保持一致的产物版本 */
export const ARRIVALS_VERSION = '0.4.0'

/** 到达卡单个日期块：snake → camelCase，空数组省略 */
export function toBlock(block) {
  const out = { date: block.date, entries: block.entries ?? {} }
  if (block.notes?.length) out.notes = block.notes
  if (block.any_airbase?.length) out.anyAirbase = block.any_airbase
  if (block.remove?.length) out.remove = block.remove
  if (block.dead_pile?.length) out.deadPile = block.dead_pile
  if (block.any_west_edge?.length) out.anyWestEdge = block.any_west_edge
  return out
}

/** 结构化到达单位（roster 展开）：snake → camelCase，nullish 省略 */
export function toRosterUnit(unit) {
  const out = { raw: unit.raw }
  if (unit.factors != null) out.factors = unit.factors
  if (unit.count != null) out.count = unit.count
  if (unit.kind != null) out.kind = unit.kind
  if (unit.name != null) out.name = unit.name
  if (unit.designation != null) out.designation = unit.designation
  if (unit.parent_type != null) out.parentType = unit.parent_type
  if (unit.steps_lost != null) out.stepsLost = unit.steps_lost
  if (unit.location_kind != null) out.locationKind = unit.location_kind
  if (unit.location != null) out.location = unit.location
  return out
}

/** 结构化到达分组 */
export function toRosterGroup(group) {
  return {
    label: group.label,
    units: (group.entries ?? []).map(toRosterUnit),
  }
}

/** 跨栏续排归属裁定：snake → camelCase */
export function toResolvedAssignment(record) {
  return {
    items: record.items ?? [],
    resolved: record.resolved,
    supersededReadings: record.superseded_readings ?? [],
    basis: record.basis,
  }
}

/** 可变撤离表（3.3c） */
export function toVariableExit(src) {
  return {
    starts: src.starts,
    ...(src.roll_in ? { rollIn: src.roll_in } : {}),
    table: src.table,
  }
}

/** 随机事件表（3.6） */
export function toRandomEvents(src) {
  return {
    period: src.period,
    table: src.table,
    ...(src.air_result ? { airResult: src.air_result } : {}),
    ...(src.supply_train ? { supplyTrain: src.supply_train } : {}),
    ...(src.option_4_1b ? { option4_1b: src.option_4_1b } : {}),
  }
}

/** 特殊补员表（1.6c）：period 与骰面键混排，需拆出 */
export function toSpecialRepl(src) {
  const table = {}
  for (const [key, value] of Object.entries(src)) {
    if (key !== 'period') table[key] = value
  }
  return { period: src.period, table }
}

/** 组装单方到达表（纯函数，供单测） */
export function buildArrivals({ arrivalsDb, side }) {
  const src = arrivalsDb[side]
  // roster 展开：同一来源的结构化单位名单，按日期与到达表对齐
  const rosterByDate = new Map(
    (arrivalsDb.roster_entries?.[side]?.dates ?? []).map((block) => [block.date, block]),
  )

  const out = {
    meta: {
      version: ARRIVALS_VERSION,
      description: `到达表（A8·${
        side === 'axis' ? '德' : '苏'
      }）：日期块（原文串）+ 结构化单位视图 + 该方到达规则备注与判定表`,
      source: [
        'arrivals.json（按到达卡逐栏实物核对，status = verified）',
        'arrivals.json roster_entries（同一来源的单位名单结构化展开）',
        ...(side === 'axis'
          ? ['rules.json exclusive_rules_smolensk.axis_special（variable_exit / random_events）']
          : ['rules.json exclusive_rules_smolensk.special_repls（1.6c）']),
      ],
    },
    side,
    header: src.header,
    blocks: src.dates.map((block) => {
      const entry = toBlock(block)
      const groups = rosterByDate.get(block.date)?.groups
      if (groups?.length) entry.groups = groups.map(toRosterGroup)
      return entry
    }),
  }

  if (src.arrival_notes?.length) out.notes = src.arrival_notes
  if (arrivalsDb.errata_applied?.length) out.errataApplied = arrivalsDb.errata_applied
  if (arrivalsDb.notes_on_data_quality?.length) {
    out.dataQualityNotes = arrivalsDb.notes_on_data_quality
  }
  const resolved = (arrivalsDb.resolved_assignments ?? []).filter((r) => r.side === side)
  if (resolved.length) out.resolvedAssignments = resolved.map(toResolvedAssignment)
  if (src.variable_exit) out.variableExit = toVariableExit(src.variable_exit)
  if (src.random_events) out.randomEvents = toRandomEvents(src.random_events)
  if (src.special_repl) out.specialRepl = toSpecialRepl(src.special_repl)

  return out
}

/* ── 主流程（仅直接运行本脚本时执行） ── */
async function main() {
  const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'
  const cwd = dirname(fileURLToPath(import.meta.url))
  const OUT_DIR = join(cwd, '..', 'src', 'data')
  const arrivalsDb = JSON.parse(readFileSync(join(DB_DIR, 'arrivals.json'), 'utf8'))

  for (const side of ['axis', 'soviet']) {
    const outFile = join(OUT_DIR, `arrivals-${side}.json`)
    const next = buildArrivals({ arrivalsDb, side })
    const text = JSON.stringify(next, null, 2) + '\n'
    const config = await resolveConfig(outFile)
    const formatted = await format(text, { ...config, parser: 'json' })
    writeFileSync(outFile, formatted, 'utf8')
    console.log(`written arrivals-${side}.json（日期块 ${next.blocks.length}）`)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
