// 条款号归属前缀门禁：注释里出现 1.x–5.x 的条款号时，必须同行带「通规 / 专规」前缀
//
// 背景：通规 v4.3 与 Smolensk 专规 v1.1 在 1.x–5.x 号段完全重叠，
// 裸写 `4.5` 无法判断是通规 ZOC 还是专规条目（见 docs/规则编号空间.md）。
//
// 用法：
//   node scripts/audit-clause-prefix.mjs            # 汇总 + 前 30 条（不阻断）
//   node scripts/audit-clause-prefix.mjs --all      # 全量列出
//   node scripts/audit-clause-prefix.mjs --fail     # 有命中即 exit 1（存量清理后并入 check）
//   node scripts/audit-clause-prefix.mjs src/engine # 指定扫描根（默认 src/engine/rules）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
const showAll = args.includes('--all')
const failMode = args.includes('--fail')
const rootArg = args.find((a) => !a.startsWith('--'))
const root = rootArg ?? 'src/engine/rules'

const CLAUSE = /(?<![\w.:])([1-5]\.\d{1,2}[a-h]?)(?![0-9])/g
const PREFIX = /专规[ ：]|通规[ ：]/
const COMMENT = /^\s*(\/\/|\*|\/\*)/
/** 文档流程/坐标/批次号等非条款号的典型写法 */
const NOISE = /§|方案|格号|坐标|bat|批次|Bobruysk|Mogilev|Orsha|Vyazma|Rzhev/
/** 明确是格号/数值、不是条款号的号 */
const NUM_SKIP = new Set(['2.5', '4.00', '2.02', '1.03', '1.07', '1.12', '1.19', '1.26'])

/** 逐号过滤：倍率（×1.5）、秒（2.5 s）、百分比、取整展示 */
const realNums = (line) =>
  [...line.matchAll(CLAUSE)]
    .filter((m) => {
      const pre = line.slice(Math.max(0, m.index - 4), m.index)
      if (/(×|=|＝|≈|~)\s*$/.test(pre)) return false
      if (/倍\s*$/.test(pre)) return false
      if (/^\s*(s|秒|%|倍)/.test(line.slice(m.index + m[1].length))) return false
      if (NUM_SKIP.has(m[1])) return false
      return true
    })
    .map((m) => m[1])

const walk = (p) => {
  const st = statSync(p)
  if (st.isFile()) return /\.(ts|vue)$/.test(p) ? [p] : []
  return readdirSync(p).flatMap((n) => walk(join(p, n)))
}

const files = walk(root)
const hits = []
for (const file of files) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!COMMENT.test(line) || PREFIX.test(line) || NOISE.test(line)) return
      const nums = realNums(line)
      if (!nums.length) return
      hits.push({
        file: relative(process.cwd(), file).replace(/\\/g, '/'),
        line: i + 1,
        nums,
        text: line.trim(),
      })
    })
}

const byFile = new Map()
for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1)

console.log(
  `扫描 ${files.length} 个文件，命中「裸条款号」注释 ${hits.length} 行，分布在 ${byFile.size} 个文件。`,
)
const limit = showAll ? hits.length : 30
for (const h of hits.slice(0, limit))
  console.log(`${h.file}:${h.line}  [${h.nums.join(',')}]  ${h.text.slice(0, 96)}`)
if (hits.length > limit) console.log(`…另有 ${hits.length - limit} 行（用 --all 查看）`)
console.log('\n按文件计数：')
;[...byFile.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}`))

if (failMode && hits.length > 0) {
  console.error(
    `\n✗ 条款号归属前缀门禁失败：${hits.length} 行裸写。写法应为「专规 4.5」或「通规 4.5」。`,
  )
  process.exit(1)
}
