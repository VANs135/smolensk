/**
 * TEC 数据同步脚本（A7.1 收尾；消除 charts-tec.json 的唯一"无脚本可再生成"单点）
 *
 * 数据源：斯摩棱斯克工程数据库 charts.json -> tables.tec（status: image_verified；
 * 2026-09-10 已按英文原版 OCS_Chartsv4.3.pdf 与 Smolensk TEC 图逐格重排键名）。
 * 产物：src/data/charts-tec.json（经管线校验 + 深度冻结后供 engine/rules/terrain.ts 消费）。
 *
 * 转换规则（与 2026-09-11 人工产物逐字段对齐，保证可复现）：
 *   - MP：'1' → fixed；'P' → prohibited；'ot' → otherTerrain；'All' → all；
 *          '+3' → delta；'1/2' → fixed(0.5)
 *   - 倍率：'[x#]' 方括号 → attackerOnly；'x1/2*' 星号 → 该地形带格子属性（hexProperty）
 *   - kind：路/河/湖 → hexside；其余 → hex（9.3b 候选集只认 hex）
 *   - legend：原文四条映射为语义键并沿用人工产物的中文括注（9.4d / 9.1f）
 * 人工裁定层（2026-09-11 产物，脚本显式复现）：
 *   - 城市/村庄为整格属性（CITY_FEATURES → hexProperty）
 *   - Swamp 倍率按图源 [x1/2]* 视为攻方专有（DB 文本层漏方括号）
 *   - feature 的 note 从既有产物继承，不凭空生成
 *
 * 护栏（findTecDifferences）：先与现有产物逐字段比对，不一致即拒绝覆盖（退出码 1）——
 * 保证"可再生成且不静默漂移"。转换核心为纯函数并导出，供 tests/scripts/sync-tec.test.ts 单测。
 *
 * 运行：node scripts/sync-tec.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

/** 与数据管线 DATA_VERSION 保持一致的产物版本 */
export const TEC_DATA_VERSION = '0.4.0'

/** 格边地形（永不进 9.3b 候选集） */
export const HEXSIDE_FEATURES = new Set([
  'Secondary Road',
  'Track',
  'Railroad',
  'Minor River',
  'Major River',
  'Lake/Blocked',
])

/**
 * 人工裁定 1（2026-09-11 产物）：城市/村庄视为整格属性（hexProperty），
 * 与图例 * 同义但源自"符号覆盖整格"——见 terrain.ts CITY_TERRAINS 的 spillover 例外。
 */
export const CITY_FEATURES = new Set(['Village', 'Minor City', 'Major City'])

/**
 * 人工裁定 2（2026-09-11 产物）：Swamp 的倍率在图源上印作 [x1/2]*（方括号→攻方专有），
 * DB 文本层丢失方括号；以产物为准，故此处补作攻方专有。
 */
export const ATTACKER_ONLY_EXTRA = new Set(['Swamp'])

/** legend：语义键 + 原文英文 + 中文括注（继承 2026-09-11 人工产物文本） */
export const TEC_LEGEND = {
  multiplier:
    '[x#] Attack times the multiple in brackets; Defend at x1（攻方乘括号内倍率；守方恒为 x1，见 9.4d）',
  prohibited: 'P Movement Prohibited（禁止该类机动通过）',
  hexProperty:
    '* 格子属性：移动为 P 的单位必须沿路才能进入并攻击该格（OCS 9.1f）。适用于整格，含 Other 列',
  otherTerrain: 'ot Dependent on other terrain in hex（取决于格内其他地形；本身不产生独立数值）',
}

/**
 * 解析 MP 单元格
 *
 * - 数字 → fixed；'P' → prohibited；'ot' → otherTerrain；'All' → all
 * - '+N' → delta（跨河追加）；'a/b' → fixed 分数；其余抛错
 */
export function parseMp(value) {
  if (typeof value === 'number') return { kind: 'fixed', value }
  if (value === 'P') return { kind: 'prohibited' }
  if (value === 'ot') return { kind: 'otherTerrain' }
  if (value === 'All') return { kind: 'all' }
  if (value.startsWith('+')) return { kind: 'delta', value: Number(value.slice(1)) }
  const fraction = value.match(/^(\d+)\/(\d+)$/)
  if (fraction) return { kind: 'fixed', value: Number(fraction[1]) / Number(fraction[2]) }
  throw new Error(`无法解析 MP 值：${value}`)
}

/**
 * 解析倍率单元格
 *
 * 方括号 '[x#]' → attackerOnly；尾部 '*' 表示该地形带格子属性（由调用方决定 hexProperty）；
 * 'ot' → otherTerrain；剩余 'xN' / 'xN/M' → multiplier；其余抛错。
 */
export function parseAttack(raw, feature) {
  if (raw === 'ot') return { kind: 'otherTerrain' }
  const hasStar = raw.endsWith('*')
  let body = hasStar ? raw.slice(0, -1) : raw
  let attackerOnly = body.startsWith('[') && body.endsWith(']')
  if (attackerOnly) body = body.slice(1, -1)
  if (!attackerOnly && ATTACKER_ONLY_EXTRA.has(feature)) attackerOnly = true
  const match = body.match(/^x(\d+)(?:\/(\d+))?$/)
  if (!match) throw new Error(`无法解析倍率值：${raw}`)
  return {
    kind: 'multiplier',
    mult: [Number(match[1]), match[2] ? Number(match[2]) : 1],
    attackerOnly,
  }
}

/** 深比较（JSON 语义：键序不同视为不同，适合本场景的逐字段契约） */
export function sameKeys(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 单条 DB 行 → 运行时 feature
 *
 * hexProperty = 星号（图例 *）∪ 城市（整格属性）；note 继承既有产物的人工说明。
 */
function toFeature(row, hasProperty, existingFeature) {
  return {
    feature: row.feature,
    kind: HEXSIDE_FEATURES.has(row.feature) ? 'hexside' : 'hex',
    combatLine: row.combat_line,
    ...(hasProperty ? { hexProperty: true } : {}),
    mp: { track: parseMp(row.track), truck: parseMp(row.truck), leg: parseMp(row.leg) },
    attack: {
      armor: parseAttack(row.armor, row.feature),
      mech: parseAttack(row.mech, row.feature),
      other: parseAttack(row.other, row.feature),
    },
    ...(existingFeature && existingFeature.note ? { note: existingFeature.note } : {}),
  }
}

/**
 * 构建运行时 charts-tec.json 结构（纯函数）
 *
 * @param rows DB tables.tec.rows（含 feature / combat_line / track / truck / leg / armor / mech / other）
 * @param existingFeatures 既有产物的 features（作为人工 note 的继承来源；可省略）
 */
export function buildTecData(rows, existingFeatures = []) {
  const existingByFeature = new Map(existingFeatures.map((f) => [f.feature, f]))
  const features = rows.map((row) => {
    const hasStar = ['armor', 'mech', 'other'].some((key) => row[key].endsWith('*'))
    const hasProperty = hasStar || CITY_FEATURES.has(row.feature)
    return toFeature(row, hasProperty, existingByFeature.get(row.feature))
  })
  return {
    meta: {
      version: TEC_DATA_VERSION,
      description:
        'Terrain Effects Chart（地形效果表 TEC）：格内/格边地形 → Combat Line（选表行）/ 三种机动的 MP / 攻方倍率',
      source: [
        'smolensk_charts_db.json -> tec（status: image_verified；原键名整体右移一格已于 2026-09-10 按英文原版 OCS_Chartsv4.3.pdf 与 Smolensk TEC 图逐格重排）',
        '规则书内页与 Air Bases 表页 Docling 提取（两份一致）',
        'skills/smolensk-rules/chapters/ch06-terrain-effects-chart.md（四源交叉校验记录）',
      ],
    },
    tec: {
      id: 'tec',
      name: 'Terrain Effects Chart',
      mobilityModes: ['track', 'truck', 'leg'],
      attackerTypes: ['armor', 'mech', 'other'],
      combatLines: ['Open', 'Close', 'Very Close', 'Extr Close'],
      legend: TEC_LEGEND,
      features,
    },
  }
}

/**
 * 一致性护栏：与现有产物逐字段比对，返回差异描述数组（空数组 = 一致）
 */
export function findTecDifferences(next, existing) {
  const diffs = []
  if (!sameKeys(next.tec.features, existing?.tec?.features)) {
    diffs.push('features 与现有产物不一致')
    if (existing?.tec?.features) {
      const max = Math.max(next.tec.features.length, existing.tec.features.length)
      for (let i = 0; i < max; i += 1) {
        if (!sameKeys(next.tec.features[i], existing.tec.features[i])) {
          diffs.push(
            `  features[${i}]: 现有 ${JSON.stringify(existing.tec.features[i])} / 脚本 ${JSON.stringify(next.tec.features[i])}`,
          )
        }
      }
    }
  }
  if (!sameKeys(next.tec.legend, existing?.tec?.legend)) diffs.push('legend 与现有产物不一致')
  if (!sameKeys(next.tec.mobilityModes, existing?.tec?.mobilityModes)) {
    diffs.push('mobilityModes 与现有产物不一致')
  }
  return diffs
}

/* ── 主流程（仅直接运行本脚本时执行；被 import 时只暴露纯函数） ── */
async function main() {
  const DB_PATH = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库\\charts.json'
  const cwd = dirname(fileURLToPath(import.meta.url))
  const OUT_FILE = join(cwd, '..', 'src', 'data', 'charts-tec.json')

  const charts = JSON.parse(readFileSync(DB_PATH, 'utf8'))
  const existing = JSON.parse(readFileSync(OUT_FILE, 'utf8'))
  const next = buildTecData(charts.tables.tec.rows, existing.tec.features)

  const diffs = findTecDifferences(next, existing)
  if (diffs.length > 0) {
    console.error('TEC 转换与现有产物不一致，拒绝覆盖：')
    for (const line of diffs) console.error(line)
    process.exit(1)
  }

  // 以项目 .prettierrc 格式化后落盘（保证幂等：重跑不产生格式漂移，format:check 恒绿）
  const text = JSON.stringify(next, null, 2) + '\n'
  const config = await resolveConfig(OUT_FILE)
  const formatted = await format(text, { ...config, parser: 'json' })
  writeFileSync(OUT_FILE, formatted, 'utf8')
  console.log(
    `written charts-tec.json（features ${next.tec.features.length}，与既有产物一致，version ${TEC_DATA_VERSION}）`,
  )
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
