/**
 * 重建条款号索引（供 `audit-error-text` 判「号是否真实 / 归属对不对」）
 *
 * 用法：
 *   node scripts/gen-clause-index.mjs <通规txt> <专规txt>
 *
 * 判据（2026-11-23 踩过的坑都写在过滤里）：
 *   - 只收**行首标题号**和**括号内 /「见」后的引用号**，正文里裸奔的数字不算；
 *   - 丢掉坐标（小节带前导零：01.03 / 2.02 / 4.00）与数值（后跟 % s 倍 px…）；
 *   - 章号、节号越界即丢（专规章号只到 5，避免把数值 8.2 当条款）；
 *   - 已知伪号（1.25 / 2.5 …）显式剔除。
 *
 * 输出 `scripts/data/clause-index.json`：两边都有 → `both`；只有一侧 → `*Only`。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [genPath, specPath] = process.argv.slice(2)
if (!genPath || !specPath) {
  console.error('用法：node scripts/gen-clause-index.mjs <通规txt> <专规txt>')
  process.exit(1)
}

const FAKE = new Set(['1.25', '2.5', '4.00', '2.02', '1.03', '1.07', '1.12', '1.19', '1.26'])
/** 初设表里的地图格坐标（章号小、混过越界过滤），逐条注明出处 */
const COORD = new Set(['2.18', '3.12'])
/** 原文确有、但抽取规则拿不到的（双栏混排 / 标题被正文挤到行中），逐条注明出处 */
const MANUAL_ADD = [
  {
    num: '5.0c',
    side: 'spec',
    why: '专规 5.0c Victory Locations and Control（标题行被左栏正文挤到行中）',
  },
  {
    num: '3.5',
    side: 'spec',
    why: '专规 3.5 Construction Markers（标题夹在双栏正文中，全文仅 L254 提到一次）',
  },
]

const NUM = /\d{1,2}\.\d{1,2}[a-z]?/g
const UNIT_AFTER = /^\s*(%|s\b|sec|px|em|rem|倍|in\b|m\b|km|mm|cm|度|格|hex)/i
const BAD_BEFORE = /(×|=|＝|≈|~|\/|#)$/

function harvest(path, maxChapter) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const head = new Set()
  const ref = new Set()
  for (const line of lines) {
    for (const m of line.matchAll(NUM)) {
      const num = m[0]
      if (FAKE.has(num) || COORD.has(num)) continue
      const [ch, rest] = num.split('.')
      if (/^0\d/.test(ch)) continue // 前导零章号必是格坐标（01.19 / 04.00），条文没有 0 章
      if (Number(ch) > maxChapter || Number(rest.replace(/[a-z]$/, '')) > 20) continue
      if (/^0\d/.test(rest)) continue // 坐标小节（01.03 / 04.00 / 2.02）；`0a`、`0c` 这类是真条款，不能误杀
      const before = line.slice(Math.max(0, m.index - 2), m.index)
      const after = line.slice(m.index + num.length, m.index + num.length + 6)
      if (!after.trim()) continue
      const lead = line.slice(0, m.index).trim()
      const atHead = lead === '' || lead === '•' || lead === '√' || lead === '-' || lead === '*'
      const inParen = /[（(]\s*$/.test(before)
      const afterSee = /(见|参见|根据|据|按|规则|rule|see)\s*$/.test(
        line.slice(Math.max(0, m.index - 8), m.index),
      )
      if (BAD_BEFORE.test(before) || UNIT_AFTER.test(after)) continue
      if (atHead) head.add(num)
      else if (inParen || afterSee) ref.add(num)
    }
  }
  return new Set([...head, ...ref])
}

const gen = harvest(genPath, 20)
const spec = harvest(specPath, 5)
/* 专规侧补「双栏原件里标题被正文挤到行中」的那批：清单由 gen-spec-clauses.mjs 产出并人工复核 */
let specCount = 0
try {
  const specClauses = JSON.parse(readFileSync('scripts/data/spec-clauses.json', 'utf8'))
  for (const c of specClauses.clauses) {
    spec.add(c.num)
    specCount++
  }
} catch {
  /* 清单尚未生成时按原抽取结果构建 */
}
for (const add of MANUAL_ADD) (add.side === 'spec' ? spec : gen).add(add.num)
/* 通规清洗版里仍有少量标题被行内正文顶掉（如 `10.1b补给消耗`），逐条注明出处补齐 */
const GEN_MANUAL_ADD = [
  { num: '10.1b', why: '通规 10.1b 补给消耗（_ocs_v43_clean.txt L1643，标题前有正文）' },
  {
    num: '21.10',
    why:
      '通规 21.10 补给缓存（21.0 可选规则整节；clean 文本在 20.0g 处截断，21 章正文未入库，' +
      '但目录 L30 有“21.0 可选规则”、正文 L2737 有“远距离可选规则 (21.4)”可证该章存在）。' +
      '本作由专规 1.7 把 21.10 定为标准规则，代码只用到这一条',
  },
]
for (const add of GEN_MANUAL_ADD) gen.add(add.num)

const sortNum = (a, b) => {
  const [ac, ar] = a.split('.')
  const [bc, br] = b.split('.')
  return Number(ac) - Number(bc) || ar.localeCompare(br, 'en', { numeric: true })
}
const both = [...gen].filter((n) => spec.has(n)).sort(sortNum)
const genOnly = [...gen].filter((n) => !spec.has(n)).sort(sortNum)
const specOnly = [...spec].filter((n) => !gen.has(n)).sort(sortNum)

writeFileSync(
  'scripts/data/clause-index.json',
  JSON.stringify(
    {
      meta: {
        note: '由 scripts/gen-clause-index.mjs 从原文抽取；改规则书后重跑，勿手改号',
        sources: [genPath.replace(/\\/g, '/'), specPath.replace(/\\/g, '/')],
        method:
          '行首标题号 + 括号/「见」引用号；剔除坐标、数值、越界章号；专规侧并入 gen-spec-clauses.mjs 复核过的标题清单',
        specClauses: { file: 'scripts/data/spec-clauses.json', count: specCount },
        manualAdds: MANUAL_ADD,
        counts: {
          gen: genOnly.length + both.length,
          spec: specOnly.length + both.length,
          both: both.length,
        },
      },
      genOnly,
      specOnly,
      both,
    },
    null,
    1,
  ) + '\n',
  'utf8',
)
console.log(
  `通规 ${genOnly.length + both.length} / 专规 ${specOnly.length + both.length} / 双义 ${both.length}`,
)
