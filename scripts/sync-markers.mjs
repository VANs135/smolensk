/**
 * 标记与记录轨数据同步脚本（A6）
 *
 * 数据源：斯摩棱斯克工程数据库（2026-09-11/12 重构后）：
 *   - markers.json：47 件保留标记（rule_class 已按 3.6/5.0c/13.3/15.0/16.0/专规 1.7 分类）
 *   - charts.json weather.turn_track.derived_turn_dates：19 回合半周日号轨
 *   - rules.json exclusive_rules_smolensk：off_map（空军盒/边缘盒）与 rail_gauge（铁路容量）
 * 产物：src/data/markers.json
 * 运行：node scripts/sync-markers.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')

const DATA_VERSION = '0.4.0'
const read = (name) => JSON.parse(readFileSync(join(DB_DIR, name), 'utf8'))
const markersDb = read('markers.json')
const chartsDb = read('charts.json')
const rulesDb = read('rules.json')
const smolensk = rulesDb.exclusive_rules_smolensk

/* ── 标记：仅保留 include 的记录 ─────────────────────────── */
const MARKERS = markersDb.items
  .filter((item) => item.include)
  .map((item) => ({
    id: item.marker_id,
    name: item.vassal_name,
    side: item.side, // axis / soviet / neutral
    ruleClass: item.rule_class,
    classLabel: item.class_label,
    front: item.images?.front ?? null,
  }))

/* ── 回合轨（半周日号，19 回合） ─────────────────────────── */
const MONTHS = { Jul: '07', Aug: '08', Sep: '09' }
/** '8 Jul' → '1941-07-08' */
function toIsoDate(label) {
  const [day, month] = label.split(' ')
  const monthNum = MONTHS[month]
  if (!monthNum) throw new Error(`无法解析日期标签：${label}`)
  return `1941-${monthNum}-${String(Number(day)).padStart(2, '0')}`
}

const TURN_TRACK = Object.entries(chartsDb.tables.weather.turn_track.derived_turn_dates)
  .map(([turn, label]) => ({ turn: Number(turn), date: toIsoDate(label) }))
  .sort((a, b) => a.turn - b.turn)

/* ── 铁路容量轨（13.3b / 专规 1.2） ──────────────────────── */
const RAIL_CAP = {
  maxMain: 10, // 主轨 1–10 档（范围文档）
  maxSub: 3, // 副轨 0–3T
  initial: { axis: 0, soviet: 2 }, // 专规 1.2：轴 0 / 苏 2
  boostDate: '1941-07-19',
  boostTo: { axis: 1, soviet: 3 },
}

/* ── 容器：死亡堆 / 边缘盒 / 空军盒（1.4a / 1.4b） ───────── */
const airBoxes = [
  {
    id: 'axis-air-box',
    side: 'axis',
    rangeHexes: smolensk.off_map.air_boxes.axis_range_hexes,
    edgeRow: 1,
  },
  {
    id: 'soviet-air-box',
    side: 'soviet',
    rangeHexes: smolensk.off_map.air_boxes.soviet_range_hexes,
    edgeRow: 62,
  },
]
const edgeBoxes = smolensk.off_map.edge_boxes.names.map((name) => ({
  id: name === 'Northeast Box' ? 'edge-northeast' : 'edge-southeast',
  name,
  traceSupply: smolensk.off_map.edge_boxes.contains_trace_supply,
}))

const output = {
  meta: {
    version: DATA_VERSION,
    description:
      '标记库（rule_class 按 3.6 / 5.0c / 13.3 / 15.0 / 16.0 / 专规 1.7）+ 记录轨（回合轨 19 半周 / 铁路容量轨 1–10+0–3T）+ 容器（死亡堆 / 边缘盒 / 空军盒）初始结构',
    source: [
      'markers.json（2026-09-11 重构：47 件保留，含清理留痕）',
      'charts.json weather.turn_track（19 回合日号轨）',
      'rules.json exclusive_rules_smolensk（off_map / rail_gauge）',
    ],
  },
  markers: MARKERS,
  turnTrack: TURN_TRACK,
  railCap: RAIL_CAP,
  containers: {
    deadPile: { axis: [], soviet: [] },
    edgeBoxes,
    airBoxes,
  },
}

const file = join(OUT_DIR, 'markers.json')
writeFileSync(file, JSON.stringify(output, null, 2) + '\n', 'utf8')
console.log(
  `written markers.json（标记 ${MARKERS.length} · 回合轨 ${TURN_TRACK.length} · 边缘盒 ${edgeBoxes.length} · 空军盒 ${airBoxes.length}）`,
)
