/**
 * 编队（多单位编队 13.7）同步脚本（A8 产出 formations.json）
 *
 * 数据源：斯摩棱斯克工程数据库 formations.json（17 条）
 *   formation_id（剧本口径，如 '1 Mtr Div'）↔ formation_code（算子库口径，如 '1.Mot'）双向登记；
 *   by_location 为各剧本初设中该编队的分布（印刷格号 → 组成单位清单）。
 *
 * 运行：node scripts/sync-formations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

/** 与数据管线 DATA_VERSION 保持一致的产物版本 */
export const FORMATIONS_VERSION = '0.4.0'

/** 单条编队：snake → camelCase */
export function toFormation(item) {
  const out = {
    formationId: item.formation_id,
    side: item.side,
    formationCode: item.formation_code,
    subordinates: item.subordinates ?? [],
    byLocation: item.by_location ?? {},
    sources: item.sources ?? [],
  }
  if (item.formation_code_note != null) out.formationCodeNote = item.formation_code_note
  if (item.side_prev_by_name_rule != null) out.sidePrevByNameRule = item.side_prev_by_name_rule
  return out
}

/** 组装运行时 formations.json（纯函数，供单测） */
export function buildFormations({ formationsDb }) {
  return {
    meta: {
      version: FORMATIONS_VERSION,
      description:
        '编队库（A8）：17 个多单位编队（13.7）的双方口径代号、下属组成与各剧本初设分布（by_location）；另登记名称改判留痕',
      source: ['formations.json（formation_index + unit_groups.service_arm_matrix）'],
    },
    formations: formationsDb.items.map(toFormation),
  }
}

/* ── 主流程（仅直接运行本脚本时执行） ── */
async function main() {
  const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'
  const cwd = dirname(fileURLToPath(import.meta.url))
  const OUT_FILE = join(cwd, '..', 'src', 'data', 'formations.json')
  const formationsDb = JSON.parse(readFileSync(join(DB_DIR, 'formations.json'), 'utf8'))

  const next = buildFormations({ formationsDb })

  const text = JSON.stringify(next, null, 2) + '\n'
  const config = await resolveConfig(OUT_FILE)
  const formatted = await format(text, { ...config, parser: 'json' })
  writeFileSync(OUT_FILE, formatted, 'utf8')
  console.log(`written formations.json（编队 ${next.formations.length}）`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
