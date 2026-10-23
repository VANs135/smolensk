/**
 * B12：把辅助卡卡面图从素材库拷进 `public/aux-cards/`
 *
 * 为什么单独一步：`sync-aux-cards.mjs` 只搬**分区元数据**（矩形坐标），卡面图从未进过产物目录
 * ⇒ `BoxCard.vue` 想画"真实卡面 + 分区"却没有图可画（只能退化成文字盒）。
 *
 * ★ B22 扩充：同一目录里的**印卡扫描图**（官方图表 v4.3 四页 / 补给与补员 / 双方重建表 /
 *   TEC 与地形图例 / 回合天气与铁路容量轨 / 变量与事件）也一并拷进来 —— 用户口径
 *   「盒还有表格可以直接用素材库里辅助卡图片」⇒ 表格屏直接显示原卡。
 *   数据侧来源：`src/data/panel-scans.json`（`scans[].image`）。
 *
 * ★ B26 修正（**本案实际断过一次**）：用户 2026-09-16 把素材整理进了子目录
 *   （`要放进游戏的\需要的表格\`、`要放进游戏的\需要的盒\`、`增援\`），而本脚本原先只 `readdirSync`
 *   根目录 ⇒ 再跑就变成"缺图 → exit 1"（实测）。现在改为**在候选目录里逐个找**：
 *   子目录优先、根目录兜底，布局怎么搬都不会静默失效。
 *
 * 命名沿用 `sync-counters.mjs` 的口径：**保留原文件名**（含空格与大写），URL 侧用
 * `encodeURIComponent` 编码 —— 与 `token-images.ts#COUNTERS_BASE` 同一套做法，
 * 不在这里发明第二套改名规则。
 *
 * 运行：node scripts/sync-aux-card-images.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 素材库里的卡面图根目录 */
export const AUX_CARD_SOURCE_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库\\地图及辅助卡'

/**
 * 卡面图的**候选目录**（按序查找第一个命中的）
 *
 * 对应用户 2026-09-16 的实际布局：`要放进游戏的\需要的表格\`（表格卡图）、
 * `要放进游戏的\需要的盒\`（盒卡面）、`增援\`（两张 OOA 卡）；根目录留着兜底（老布局不失效）。
 */
export const AUX_CARD_SOURCE_DIRS = [
  join(AUX_CARD_SOURCE_DIR, '要放进游戏的', '需要的表格'),
  join(AUX_CARD_SOURCE_DIR, '要放进游戏的', '需要的盒'),
  join(AUX_CARD_SOURCE_DIR, '增援'),
  AUX_CARD_SOURCE_DIR,
]

/** 产物目录（Vite 的 public ⇒ 运行期按 `/aux-cards/<文件名>` 取） */
export const AUX_CARD_OUT_DIR = 'aux-cards'

/**
 * 本作需要的卡面（数据侧 `aux-cards.json` + `panel-scans.json` 的 `image` 字段逐个对得上）
 *
 * 不写"目录里有什么就拷什么"：多拷的图会让产物目录与数据脱钩（数据侧没引用却在仓库里躺着的文件）。
 */
export function requiredCardImages(data, scans = { scans: [] }) {
  return [
    ...new Set([...data.cards.map((card) => card.image), ...scans.scans.map((scan) => scan.image)]),
  ].sort()
}

/** 在候选目录里找这张图（找不到返回 null） */
export function findCardImage(name, dirs = AUX_CARD_SOURCE_DIRS) {
  for (const dir of dirs) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return null
}

/** 候选目录里**实际存在**的文件名集合（供报告"目录里有但数据没要"这类偏差） */
export function availableCardImages(dirs = AUX_CARD_SOURCE_DIRS) {
  const found = new Set()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (name.toLowerCase().endsWith('.png')) found.add(name)
    }
  }
  return found
}

export function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const dataPath = join(here, '..', 'src', 'data', 'aux-cards.json')
  const scansPath = join(here, '..', 'src', 'data', 'panel-scans.json')
  const data = JSON.parse(readFileSync(dataPath, 'utf8'))
  const scans = JSON.parse(readFileSync(scansPath, 'utf8'))
  const outDir = join(here, '..', 'public', AUX_CARD_OUT_DIR)
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const wanted = requiredCardImages(data, scans)
  const copied = []
  const missing = []
  for (const name of wanted) {
    const from = findCardImage(name)
    if (from === null) {
      missing.push(name)
      continue
    }
    const to = join(outDir, name)
    const same = existsSync(to) && statSync(to).size === statSync(from).size
    if (!same) copyFileSync(from, to)
    copied.push(`${name}${same ? '（已是最新）' : ''}`)
  }

  console.log(
    `aux-cards 图档：数据侧需要 ${wanted.length} 张（盒卡 ${data.cards.length} + 印卡扫描 ${scans.scans.length}）`,
  )
  for (const line of copied) console.log('  · ' + line)
  for (const name of missing) console.log('  ✗ 缺图：' + name)
  if (missing.length > 0) process.exit(1)
}

const isMain = process.argv[1] && import.meta.url.endsWith('sync-aux-card-images.mjs')
if (isMain) main()
