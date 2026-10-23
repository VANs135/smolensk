/**
 * 算子图档同步（把权威库引用的 PNG 拷进 `public/counters/`）
 *
 * ★权威数据源（只读）：
 *   D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\{units.json,aircraft.json}
 *   D:\OCS\OCS斯摩棱斯克素材\图片素材库\**\*.png
 *
 * 产物：
 *   public/counters/axis/    轴心算子图
 *   public/counters/soviet/  苏军算子图
 *   public/counters/markers/ 中立算子（SP / 空军基地 / 环形工事…）与各种贴图
 *
 * ## 为什么按**文件名**而不用库里的 `front_paths`
 *   库里的 `*_paths` 是历史快照，素材库重排过目录（如内务部/警戒那几个算子），
 *   按路径拷会有约 10 个文件找不到；而**文件名在整个素材库内唯一**（657 个不重名），
 *   故先给素材库建「文件名 → 绝对路径」索引，再按文件名取图，重排目录也不会漏。
 *
 * ## 运行
 *   node scripts/sync-counters.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 素材库根（只读） */
export const ASSET_ROOT = 'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库'
/** 权威工程库目录 */
export const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'

/** 贴图子目录（模式标记 / 环形工事等级） */
export const TEXTURE_DIR_NAME = '各种贴图'

/**
 * 官方标记子目录（B18+：控制标记 / 回合标记 / 天气标记 / 补给缓存…）
 *
 * 这些是**规则标记**而不是算子：单位库/飞机库都不引用它们（所以按库记录拷图不会带上），
 * 但它们一样要进 `public/counters/markers/` 才能被渲染层取到（`markerTextureUrl`）。
 * ★ 与 `各种贴图` 有同名文件（如 `Neutral_SP_*`）时，**同名同内容**，后拷的覆盖前者不影响契约。
 */
export const OFFICIAL_MARKER_DIR_NAME = '官方标记'

/** 只有 valued 以上才进运行期（与 sync-units 同一契约） */
const LOADABLE = new Set(['valued', 'verified'])

/** 阵营 → public 子目录：中立算子（side='both'）归入 markers */
export function countersDirOfSide(side) {
  if (side === 'axis') return 'axis'
  if (side === 'soviet') return 'soviet'
  return 'markers'
}

/**
 * 由权威库记录算出「要拷哪些图、放到哪个子目录」（纯函数，便于单测）
 *
 * @param groundItems units.json 的 items
 * @param aircraftItems aircraft.json 的 items
 * @returns `{ file, dir, kind }[]`（按 file 去重排序）
 */
export function selectCounterAssets(groundItems, aircraftItems) {
  const out = new Map()
  const take = (item, kind) => {
    if (!LOADABLE.has(item.fill_stage)) return
    const dir = countersDirOfSide(item.side)
    const images = item.images ?? {}
    for (const file of [images.front, images.back]) {
      if (typeof file !== 'string' || file === '') continue
      if (!out.has(file)) out.set(file, { file, dir, kind })
    }
  }
  for (const item of groundItems) take(item, 'ground')
  for (const item of aircraftItems) take(item, 'air')
  return [...out.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/** 递归收集某目录下的 PNG 文件名 → 绝对路径（忽略下划线开头的备份目录） */
export function indexPngByName(root) {
  const index = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (extname(entry.name).toLowerCase() !== '.png') continue
      // 同名冲突保留先遇到的（素材库内实测唯一）
      if (!index.has(entry.name)) index.set(entry.name, full)
    }
  }
  walk(root)
  return index
}

/** 主流程：建索引 → 按文件名拷图 → 贴图并入 markers */
function main() {
  const cwd = dirname(fileURLToPath(import.meta.url))
  const outDir = join(cwd, '..', 'public', 'counters')
  const read = (name) => JSON.parse(readFileSync(join(DB_DIR, name), 'utf8'))

  const units = read('units.json')
  const aircraft = read('aircraft.json')
  const index = indexPngByName(ASSET_ROOT)
  const wanted = selectCounterAssets(units.items, aircraft.items)

  const report = { copied: {}, missing: [] }
  for (const asset of wanted) {
    const source = index.get(asset.file)
    const targetDir = join(outDir, asset.dir)
    mkdirSync(targetDir, { recursive: true })
    if (source === undefined) {
      report.missing.push(asset.file)
      continue
    }
    copyFileSync(source, join(targetDir, asset.file))
    report.copied[asset.dir] = (report.copied[asset.dir] ?? 0) + 1
  }

  // 各种贴图（模式标记 / 环形工事等级）→ markers
  const markerDir = join(outDir, 'markers')
  mkdirSync(markerDir, { recursive: true })
  let textures = 0
  for (const dirName of [TEXTURE_DIR_NAME, OFFICIAL_MARKER_DIR_NAME]) {
    const dir = join(ASSET_ROOT, dirName)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (extname(name).toLowerCase() !== '.png') continue
      copyFileSync(join(dir, name), join(markerDir, basename(name)))
      textures += 1
    }
  }

  console.log(
    `算子图：${wanted.length} 个文件名 ⇒ 已拷 axis=${report.copied.axis ?? 0} soviet=${report.copied.soviet ?? 0} markers=${report.copied.markers ?? 0}`,
  )
  console.log(`贴图与官方标记：${textures} 个 ⇒ public/counters/markers/`)
  if (report.missing.length > 0) {
    console.log(`⚠ 缺图 ${report.missing.length} 个：${report.missing.slice(0, 8).join('、')}`)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
