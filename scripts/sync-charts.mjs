/**
 * 图表数据同步脚本（A7.1）
 *
 * 数据源：斯摩棱斯克工程数据库 charts.json（2026-09-10 已按英文原版
 * OCS_Chartsv4.3.pdf 逐格核对）。
 * 产物：
 *   - src/data/charts-crt.json   CRT（9.9）：15 骰行 × 4 地形列位 × 13 列，195 格矩阵
 *   - src/data/charts-tables.json 轰炸表(10.0a) / 对设施表(10.0c) / 夺取表(9.14b/c) /
 *     防空任务损失表(14.4f) / 奇袭表(9.8) / 损耗表(12.8b)
 *
 * ## 门禁加固 B0① 的两处特殊处理
 *   - 后两表（`surprise` / `attrition`）**无法由源库形状直接生成**：`tables.surprise` 是
 *     `{status, rule, roll, overrun, regular, drm, shift}` 的异形对象、`tables.attrition_table`
 *     是 `{No Loss: [...]}` 的行主序而非网格，直接喂 `buildGridTable` 会抛错。
 *     故它们**自既有产物按原顺序保留**，并在保留后断言其存在（否则 `tables/lookup.ts`
 *     `findTable` 会在运行期抛 TableLookupError）。
 *   - 落盘前过 `overwrite-guard`：与既有产物不一致即拒绝写入（本工程非 git 仓库）。
 *
 * 运行：node scripts/sync-charts.mjs [--force]
 * 产物 JSON 由 src/data/index.ts 经管线校验 + 深度冻结后供引擎取表。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

import { decideOverwrite, refusalLines } from './overwrite-guard.mjs'

/** 与数据管线 DATA_VERSION 保持一致的产物版本 */
export const CHARTS_VERSION = '0.4.0'

/** 源库版本注记（写进产物 meta.source） */
export const SOURCE_NOTE =
  'smolensk_charts_db.json（2026-09-10 按英文原版 OCS_Chartsv4.3.pdf 逐格核对）'

/** 脚本无法再生成、须自既有产物保留的表（B0①）；消费方见 `tables/lookup.ts` */
export const PRESERVED_TABLE_IDS = ['surprise', 'attrition']

/**
 * 源库 `tables.crt` → charts-crt.json（纯函数）
 *
 * `cell_matrix` 在源库中以行标签为键（对象），按 `dice_rows` 顺序转为行主序数组。
 */
export function buildChartsCrt(crtSource) {
  return {
    meta: {
      version: CHARTS_VERSION,
      description:
        'CRT（9.9）：' +
        `${crtSource.dice_rows.length} 骰行 × ${Object.keys(crtSource.columns_by_terrain).length} 地形列位 × 13 列，` +
        '矩阵 195 格；掷骰 = 2d6 + 攻方行动值 - 守方行动值 - 守方工事等级',
      source: [SOURCE_NOTE],
    },
    crt: {
      id: 'crt',
      diceRows: crtSource.dice_rows,
      terrainColumns: crtSource.columns_by_terrain,
      matrix: crtSource.dice_rows.map((rowLabel) => crtSource.cell_matrix[rowLabel]),
      resultCodes: crtSource.result_codes,
    },
  }
}

/** 行主序网格：rows 标注 × columns 标注 → grid */
export function buildGridTable(id, tableSource) {
  const table = {
    id,
    columns: tableSource.columns,
    rows: Object.keys(tableSource.rows),
    grid: Object.values(tableSource.rows).map((row) => row.map(String)),
  }
  // 源库无 cost 时不写该键（与既有产物逐字节一致）
  if ('cost_t' in tableSource) table.cost = tableSource.cost_t
  return table
}

/** 防空任务损失表：3 行（2/3/4 机） × 6 列（骰 1–6） */
export function buildFlakMissionLoss(tableSource) {
  const aircraftRows = ['2 aircraft', '3 aircraft', '4 aircraft']
  return {
    id: 'flak-mission-loss',
    idNote: '防空击落后的损失归属：掷 1 骰决定哪架受击；W=最弱（按轰炸值） S=最强（14.4f）',
    columns: ['1', '2', '3', '4', '5', '6'],
    rows: aircraftRows,
    grid: aircraftRows.map((label) => tableSource[label]),
  }
}

/**
 * 源库 `tables` → charts-tables.json（纯函数）
 *
 * `existing` = 既有产物；提供时按**既有顺序**合并，把手写表插回原位，使重跑幂等。
 * 合并后断言手写表齐全——缺表即抛错（宁可脚本失败，也不要产出读不出的数据）。
 *
 * @throws Error 手写表缺失时
 */
export function buildChartsTables(tables, existing = null) {
  const generated = [
    buildGridTable('barrage', tables.barrage_table),
    buildGridTable('barrage-vs-facility', tables.barrage_vs_facility),
    buildGridTable('capture', tables.capture_table),
    buildFlakMissionLoss(tables.flak.mission_loss_table),
  ]

  const previousTables = existing?.tables ?? []
  const generatedById = new Map(generated.map((table) => [table.id, table]))
  const previousById = new Map(previousTables.map((table) => [table.id, table]))

  const merged = []
  for (const previous of previousTables) merged.push(generatedById.get(previous.id) ?? previous)
  for (const table of generated) if (!previousById.has(table.id)) merged.push(table)

  const missing = PRESERVED_TABLE_IDS.filter((id) => !merged.some((table) => table.id === id))
  if (missing.length > 0)
    throw new Error(
      `[sync-charts] 手写表缺失：${missing.join('、')}。` +
        '这两张表无法由 charts.json 生成，须先在既有 charts-tables.json 中恢复，或在脚本中补生成分支。',
    )

  return {
    meta: {
      version: CHARTS_VERSION,
      description:
        '判定表集：轰炸表(10.0a) / 对设施轰炸表(10.0c) / 夺取表(9.14b/c) / 防空任务损失表(14.4f) / 损耗表(12.8b)；' +
        '每表 rows×columns×grid，cost 为弹药/成本行（如有）',
      source: [SOURCE_NOTE],
    },
    tables: merged,
  }
}

/* ── 主流程（仅直接运行本脚本时执行；被 import 时只暴露纯函数） ── */
async function main() {
  const DB_PATH = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库\\charts.json'
  const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')
  const force = process.argv.includes('--force')

  const tables = JSON.parse(readFileSync(DB_PATH, 'utf8')).tables

  const outputs = [
    ['charts-crt.json', buildChartsCrt(tables.crt)],
    [
      'charts-tables.json',
      buildChartsTables(tables, readExisting(join(OUT_DIR, 'charts-tables.json'))),
    ],
  ]

  for (const [file, content] of outputs) {
    const out = join(OUT_DIR, file)
    const existingText = existsSync(out) ? readFileSync(out, 'utf8') : null
    // 以项目 .prettierrc 格式化后落盘（重跑不产生格式漂移，format:check 恒绿）
    const config = await resolveConfig(out)
    const formatted = await format(JSON.stringify(content, null, 2) + '\n', {
      ...config,
      parser: 'json',
    })

    const decision = decideOverwrite({ nextText: formatted, existingText, force })
    if (!decision.ok) {
      for (const line of refusalLines({ outFile: out, preserved: PRESERVED_TABLE_IDS }))
        console.error(line)
      process.exit(1)
    }
    writeFileSync(out, formatted, 'utf8')
    console.log(`written ${file}（${formatted.length} 字节 · ${decision.reason}）`)
  }
}

/** 读既有产物（不存在则 null） */
function readExisting(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
