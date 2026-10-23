/**
 * 补给 / 补员 / 特殊补员 / 重建费用数据同步脚本（A7.3）
 *
 * 数据源：斯摩棱斯克工程数据库 smolensk_charts_db.json（supply_tables / repl_tables /
 * special_repl / rebuild_charts，均按英文原版核对）。
 * 规则补充来源：Smolensk_Rules_v1.1.txt（1.6b / 1.6c / 13.5 与重建表语义）。
 * 产物：src/data/charts-supply-repl.json
 *
 * 运行：node scripts/sync-supply-repl.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { format, resolveConfig } from 'prettier'

const DB_PATH = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库\\charts.json'
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')

const DATA_VERSION = '0.4.0'
const SOURCE_NOTE =
  'smolensk_charts_db.json（2026-09-10 按英文原版核对）+ Smolensk_Rules_v1.1（1.6b/1.6c）'

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const tables = db.tables

/* ── 补给表（1.6b）：2d6 → SP；19 Aug 起取 late 档 ───────── */
function buildSupplySide(side) {
  const source = tables.supply_tables[side]
  return {
    rows: source.roll,
    spBefore19Aug: source.early_before_19_aug,
    spFrom19Aug: source.late_from_19_aug,
  }
}

/* ── 补员表（Repl Table，1.6b）：2d6 → Ftr/Tac/Pax/Eq；19 Aug 起掷骰 -1 ── */
function buildReplSide(side) {
  const source = tables.repl_tables[side]
  const columns = ['Ftr', 'Tac', 'Pax', 'Eq']
  // 行主序网格 [rows][4]：按行定位后取列；'-' 表示该格无补员，数值化为 0
  const grid = source.rows.map((_, rowIndex) =>
    columns.map((column) => {
      const value = source[column][rowIndex]
      return value === '-' ? 0 : Number(value)
    }),
  )
  return {
    rows: source.rows,
    columns,
    grid,
    drmFrom19Aug: -1,
  }
}

/* ── 特殊补员表（1.6c）：掷 1 骰；结果映射为事件种类 ──────── */
const SPECIAL_REPL_KINDS = {
  soviet: { '1-2': 'division_caches', '3-6': 'division_alarm' },
  axis: { '1-4': 'supply_cache', '5-6': 'aufk_krd' },
}

function buildSpecialReplRows(side) {
  return Object.entries(tables.special_repl[side]).map(([range, label]) => {
    const [dieFrom, dieTo] = range.split('-').map(Number)
    return { dieFrom, dieTo: dieTo ?? dieFrom, resultKind: SPECIAL_REPL_KINDS[side][range], label }
  })
}

/* ── 重建费用表（13.5c）：单位类型 → 费用/途径 ────────────── */
/** 解析重建费用标签 → 结构化条目（保留原文以对账） */
function parseRebuildEntry(label) {
  if (label === 'No Rebuild') return { kind: 'none' }
  if (label.includes('Special (1.6c)')) return { kind: 'special' }
  if (label === 'return to pool') return { kind: 'pool' }
  if (label.startsWith('only via Repl Table')) return { kind: 'replOnly' }
  if (/^\s*see\s+OCS/i.test(label)) return { kind: 'regulation', label }

  const cost = [...label.matchAll(/(\d+)\s*x\s*(Eq|Pax)/gi)].map((match) => ({
    resource: match[2].toLowerCase(),
    amount: Number(match[1]),
  }))
  if (cost.length === 0) return { kind: 'regulation', label }
  return { kind: 'normal', cost }
}

function buildRebuildSide(side) {
  return Object.entries(tables.rebuild_charts[side]).map(([unitType, label]) => ({
    unitType,
    rebuild: parseRebuildEntry(label),
    sourceLabel: label,
  }))
}

/* ── 免费特殊补员资格因素（1.6c）：仅 12-2-2 / 11-1-1 / 10-0-1 型步兵/民兵师 ── */
const FREE_SPECIAL_REPL_FACTORS = [
  { attack: 12, ar: 2, ma: 2 },
  { attack: 11, ar: 1, ma: 1 },
  { attack: 10, ar: 0, ma: 1 },
]

const output = {
  meta: {
    version: DATA_VERSION,
    description:
      '补给表(1.6b) / 补员表(1.6b) / 特殊补员表(1.6c) / 重建费用表(13.5c)：' +
      '19 Aug 起补给与补员掷骰 -1、特殊补员停止；freeSpecialReplFactors 为 1.6c 免费重建资格（仅 12-2-2/11-1-1/10-0-1 型）',
    source: [SOURCE_NOTE],
  },
  supply: { axis: buildSupplySide('axis'), soviet: buildSupplySide('soviet') },
  repl: { axis: buildReplSide('axis'), soviet: buildReplSide('soviet') },
  specialRepl: { axis: buildSpecialReplRows('axis'), soviet: buildSpecialReplRows('soviet') },
  rebuild: { axis: buildRebuildSide('axis'), soviet: buildRebuildSide('soviet') },
  freeSpecialReplFactors: FREE_SPECIAL_REPL_FACTORS,
}

const file = join(OUT_DIR, 'charts-supply-repl.json')
// 与其余同步脚本一致：以项目 .prettierrc 格式化后落盘（重跑不产生格式漂移，format:check 恒绿）
const config = await resolveConfig(file)
const formatted = await format(JSON.stringify(output, null, 2) + '\n', {
  ...config,
  parser: 'json',
})
writeFileSync(file, formatted, 'utf8')

console.log(
  `written charts-supply-repl.json（supply/repl ×2、specialRepl ×2、rebuild axis ${output.rebuild.axis.length} 条 / soviet ${output.rebuild.soviet.length} 条）`,
)
