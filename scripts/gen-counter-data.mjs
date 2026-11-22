/**
 * 算子图档内联：把 `public/counters/{axis,soviet,markers}/*.png` 压成 WebP data URI，
 * 写进 `src/data/counter-data.ts`。
 *
 * ## 为什么要内联
 *   部署平台对**文件数**有上限，发布包里 900+ 张算子图会撞限；内联后这些图不再以独立
 *   文件出现。`counterImageUrl()` 命中内联表就直出 data URI，未命中仍回落到
 *   `public/counters/...png` 静态路径（两种来源都可用，渲染层无需分支）。
 *
 * ## 产物格式
 *   `export const COUNTER_DATA: Record<string, string>`，键 `dir/文件名`，值 `data:image/webp;base64,…`
 *   顺序：`axis` → `soviet` → `markers`，目录内按文件名 code-unit 排序（与既有产物一致）。
 *
 * ## 编码参数（★ 与既有产物**逐字节一致**，改动前先确认渲染观感与体积）
 *   WebP quality=92 / alphaQuality=100 / effort=6，尺寸不缩放（源图 70×70）
 *
 * ## 运行
 *   node scripts/gen-counter-data.mjs            # 重新生成
 *   node scripts/gen-counter-data.mjs --check    # 只校验：产物与源图不一致则退出码 1
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

/** 仓库根 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 源图目录（顺序即产物顺序） */
const COUNTER_DIRS = ['axis', 'soviet', 'markers']
/** 产物路径 */
const OUT_FILE = 'src/data/counter-data.ts'
/** 编码参数（与既有产物逐字节一致） */
const WEBP_OPTIONS = { quality: 92, alphaQuality: 100, effort: 6 }

/** 产物文件头（含「自动生成」标记，防止手改） */
const HEADER =
  '/* 自动生成：将 counters 图档内联为 WebP data URI，避免部署图片数量超限。源目录 public/counters */\n' +
  'export const COUNTER_DATA: Record<string, string> = {\n'

/** 列出某目录下的算子图文件名（跳过 `.gitkeep` 等非 png） */
function pngsOf(dir) {
  const abs = join(ROOT, 'public', 'counters', dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((name) => name.endsWith('.png'))
    .sort()
}

/** 生成 `COUNTER_DATA` 的整份源码文本 */
async function buildSource() {
  const lines = []
  let count = 0
  for (const dir of COUNTER_DIRS) {
    for (const file of pngsOf(dir)) {
      const png = join(ROOT, 'public', 'counters', dir, file)
      const webp = await sharp(png).webp(WEBP_OPTIONS).toBuffer()
      const url = `data:image/webp;base64,${webp.toString('base64')}`
      lines.push(`  "${dir}/${file}": '${url}',`)
      count++
    }
  }
  return { text: `${HEADER}${lines.join('\n')}\n}\n`, count }
}

const check = process.argv.includes('--check')
const { text, count } = await buildSource()
const outPath = join(ROOT, OUT_FILE)
const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''

if (check) {
  if (current === text) {
    console.log(`内联表已是最新（${count} 张图档）`)
    process.exit(0)
  }
  // 指出第一处不一致的键，便于定位
  const a = current.split('\n')
  const b = text.split('\n')
  const at = a.findIndex((line, i) => line !== b[i])
  console.error(`内联表与源图不一致（${count} 张图档），第一处差异在第 ${at + 1} 行：`)
  console.error(`  产物: ${String(a[at]).slice(0, 80)}`)
  console.error(`  应然: ${String(b[at]).slice(0, 80)}`)
  console.error('请运行 `node scripts/gen-counter-data.mjs` 重新生成。')
  process.exit(1)
}

writeFileSync(outPath, text, 'utf8')
console.log(
  `已生成 ${OUT_FILE}（${count} 张图档 / ${(text.length / 1024 / 1024).toFixed(2)} MB 源码）`,
)
