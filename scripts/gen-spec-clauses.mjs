/**
 * 重建专规条款号清单（`scripts/data/spec-clauses.json`）
 *
 * 用法：
 *   node scripts/gen-spec-clauses.mjs <专规txt>
 *
 * 为什么需要它：`gen-clause-index.mjs` 用「行首标题号」抓通规很准（通规有清洗版），
 * 但专规只有双栏原件——大量标题被左栏正文挤到行中（如 `3.5 Construction Markers`
 * 夹在两句正文之间），行首规则一条也抓不到，于是真实条款号（2.4 / 3.3d / 1.8a / 4.1a…）
 * 会被 `audit:error-text` 判成「不存在的号」，反而挡住正确文案。
 *
 * 判据：只认「号 + 首字母大写的英文标题」且标题不超过 6 个词、不含数字；
 * 正则拿不到的（标题被正文完全撞开）逐条写在 `MANUAL_ADD` 里并注明原文行号。
 * 每条输出都带原文行号与行内片段，便于复核来源。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const specPath = process.argv[2]
if (!specPath) {
  console.error('用法：node scripts/gen-spec-clauses.mjs <专规txt>')
  process.exit(1)
}

const CAND = /\b([1-5]\.\d{1,2}[a-z]?)\s*([A-Z][A-Za-z&'\- ]{2,40}?)(?:\.|\s{2,}|$)/g

/** 正则取不到的真条款（标题被双栏正文撞开），逐条附原文行号 */
const MANUAL_ADD = [
  {
    num: '2.4',
    title: 'Slow Mobilization',
    line: 199,
    snippet: '...Reducing 2.4 Slow Mobilization 3.2a Hip Shoots. Weather permitting,',
  },
  {
    num: '3.4',
    title: 'Guderian & Hoth',
    line: 247,
    snippet: '3.4 Guderian & Hoth • It is usually easy to remember which',
  },
  {
    num: '3.6',
    title: 'Random Events',
    line: 303,
    snippet: 'line and in a hex east of Orsha. Note 3.6 Random Events the historical underpin',
  },
  {
    num: '5.0',
    title: 'Victory Conditions',
    line: 334,
    snippet: '4.2 Try Some House Rules! 5.0 Victory Conditions Intro Scenario:',
  },
]

const lines = readFileSync(specPath, 'utf8').split(/\r?\n/)
const out = new Map()
lines.forEach((line, i) => {
  for (const m of line.matchAll(CAND)) {
    const num = m[1]
    const title = m[2].trim()
    if (/\d/.test(title)) continue // 标题里带数字 ⇒ 是正文句子，不是标题
    if (title.split(' ').length > 6) continue
    if (!out.has(num))
      out.set(num, { num, title, line: i + 1, snippet: line.slice(m.index, m.index + 60) })
  }
})
for (const m of MANUAL_ADD) if (!out.has(m.num)) out.set(m.num, m)

const clauses = [...out.values()].sort((a, b) => {
  const [ac, ar] = a.num.split('.')
  const [bc, br] = b.num.split('.')
  return Number(ac) - Number(bc) || ar.localeCompare(br, 'en', { numeric: true })
})

writeFileSync(
  'scripts/data/spec-clauses.json',
  JSON.stringify(
    {
      meta: {
        note: '专规条款号清单：从原文抽「号 + 英文标题」再人工复核补齐；改规则书后重跑并复核。',
        source: specPath.replace(/\\/g, '/'),
        count: clauses.length,
      },
      clauses,
    },
    null,
    1,
  ) + '\n',
  'utf8',
)
console.log(`专规条款 ${clauses.length}：${clauses.map((c) => c.num).join(' ')}`)
