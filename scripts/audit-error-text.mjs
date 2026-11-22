/**
 * 拒绝原因文案门禁
 *
 * 三件事，任一条不过即 exit 1（`npm run audit:error-text`）：
 *   1. **码要真实**：文案表里的每一项，键必须是 `src/engine` / `src/stores` 里
 *      `fail(rule, reason)` 真在用到的码（防表里留旧码、改错码）；
 *   2. **条款号要真实**：每条文案括号里写的条款号必须存在于
 *      `scripts/data/clause-index.json`（通规 / 专规原文抽取）；不存在的号
 *      （如幽灵号 `1.25`）一律报错——这是 2026-11-23 一轮返工的根因；
 *   3. **前缀要归属正确**：文案里写了「专规 1.2」就必须是专规号，写「通规 13.3e」
 *      就必须是通规号，不得把专规号冠成通规、或反之。
 *
 * 未映射的码只统计、不报错（文案分批补，`--fail-unmapped` 才据此失败）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src'
const TEXT_FILES = ['src/engine/rules/rule-error-text.ts', 'src/engine/rules/rule-code-text.ts']
const INDEX = JSON.parse(readFileSync('scripts/data/clause-index.json', 'utf8'))
const GEN = new Set(INDEX.genOnly)
const SPEC = new Set(INDEX.specOnly)
const BOTH = new Set(INDEX.both)
const ALL = new Set([...GEN, ...SPEC, ...BOTH])

const walk = (p) =>
  statSync(p).isFile()
    ? /\.ts$/.test(p)
      ? [p]
      : []
    : readdirSync(p).flatMap((n) => walk(join(p, n)))

/* ── 1. 收集代码里真在用的码 ──
 * 两种写出方式都要收：`fail(rule, 'code')` 与炮击链路的字面对象 `{ rule, reason: 'code' }`。
 */
const FAIL =
  /fail\(\s*(?:'([^']*)'|[A-Za-z_][A-Za-z0-9_.]*)\s*,\s*(?:'([^']+)'|`([^`]+)`|([A-Za-z_][A-Za-z0-9_.]*))/g
/* `reason: 'x',` / `reason: 'x' }` 才算拒绝码；`reason: 'a' | 'b'` 是类型联合值，不是码 */
const REASON = /reason:\s*'([^']+)'\s*[,}]/g
const used = new Map()
/** 全源码拼接：判「这个码在代码里出现过吗」用子串，不用调用形态
 *  （`fail(cond ? 'a' : 'b', code)` 这类三目第一参、`reason: \`code:${id}\`` 这类模板串，
 *   靠正则解析调用结构一定会漏；码名唯一且够长，子串判定的误判风险可忽略） */
let allSource = ''
for (const f of [...walk(`${ROOT}/engine`), ...walk(`${ROOT}/stores`)]) {
  const src = readFileSync(f, 'utf8')
  allSource += src
  for (const m of src.matchAll(FAIL)) {
    let code = m[2] ?? m[3] ?? ''
    if (code === '' && m[4]) continue
    code = code.split('${')[0].replace(/:\s*$/, '')
    if (code) used.set(code, (used.get(code) ?? 0) + 1)
  }
  for (const m of src.matchAll(REASON)) {
    const code = m[1].split('${')[0].replace(/:\s*$/, '')
    if (code) used.set(code, (used.get(code) ?? 0) + 1)
  }
}

/* ── 2. 读文案表 ── */
const entries = []
for (const file of TEXT_FILES) {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    const m = line.match(/^\s{2}(\w+):\s*'([^']*)',?\s*$/)
    if (m) {
      entries.push({ file, line: i + 1, code: m[1], text: m[2] })
      return
    }
    /* 长文案按 prettier 换行成 `key:` + 下一行字符串，必须一并收，否则会漏判成「未映射」 */
    const head = line.match(/^\s{2}(\w+):\s*$/)
    if (head) {
      const next = lines[i + 1] ?? ''
      const s = next.match(/^\s*'([^']*)',?\s*$/)
      if (s) entries.push({ file, line: i + 1, code: head[1], text: s[1] })
    }
  })
}

/* ── 3. 校验 ── */
const problems = []
const seen = new Map()
for (const e of entries) {
  if (seen.has(e.code))
    problems.push(
      `${e.file}:${e.line} 码 ${e.code} 与 ${seen.get(e.code)} 重复（合并后会互相覆盖）`,
    )
  else seen.set(e.code, `${e.file}:${e.line}`)
}
const CLAUSE_IN_PAREN = /[（(]([^（）()]+)[）)]/g
const CLAUSE_TOKEN = /\d+\.\d+[a-z]?/g

for (const e of entries) {
  if (!allSource.includes(e.code))
    problems.push(`${e.file}:${e.line} 表里留了代码没用到的码 ${e.code}`)

  for (const paren of e.text.matchAll(CLAUSE_IN_PAREN)) {
    for (const t of paren[1].matchAll(CLAUSE_TOKEN)) {
      if (!ALL.has(t[0]))
        problems.push(`${e.file}:${e.line} ${e.code} 引用了不存在的条款号 ${t[0]}`)
    }
  }

  for (const m of e.text.matchAll(/(通规|专规)\s*(\d+\.\d+[a-z]?)/g)) {
    const [, kind, num] = m
    const ok = kind === '专规' ? SPEC.has(num) || BOTH.has(num) : GEN.has(num) || BOTH.has(num)
    if (!ok) problems.push(`${e.file}:${e.line} ${e.code} 把 ${num} 标成了${kind}，归属不符`)
  }
}

/* ── 4. 覆盖率 ──
 * 分四类：装了文案 / 内联中文（`ruleErrorTextOf` 原样返回，本就有人话）/
 * 前缀兜底（`notAt*`、`wrongPhaseFor*`）/ 真未映射（只剩「本次操作被规则拒绝」）。
 */
const mapped = new Set(entries.map((e) => e.code))
/** `ruleErrorTextOf` 查表前先按 `:` 截断，覆盖统计也必须按主键比对（`xxx:ar3` → `xxx`） */
const headOf = (c) => c.split(':')[0]
const cjkInline = [...used.keys()].filter(
  (c) => !mapped.has(headOf(c)) && /[\u4e00-\u9fa5]/.test(c),
)
const prefixFallback = [...used.keys()].filter(
  (c) => !mapped.has(headOf(c)) && (c.startsWith('wrongPhaseFor') || c.startsWith('notAt')),
)
/* 不是「拒绝」的 reason：`succeed(…, reason: 'ok')` 的成功标记，以及落点标记（专规 2.1/3.6 的
 * freeRail / supplyTrain / edgeSource）——它们不面向用户提示失败，补文案没有意义 */
const NON_FAILURE = new Set(['ok', 'freeRail', 'supplyTrain', 'edgeSource'])

const unmapped = [...used.keys()].filter(
  (c) =>
    !mapped.has(headOf(c)) &&
    !cjkInline.includes(c) &&
    !prefixFallback.includes(c) &&
    !NON_FAILURE.has(headOf(c)),
)

console.log(`文案条目 ${entries.length}（表 ${TEXT_FILES.length} 个文件）`)
console.log(
  `代码用到的失败码 ${used.size}（调用 ${[...used.values()].reduce((a, b) => a + b, 0)} 次）`,
)
console.log(`  已装文案 ${mapped.size}`)
console.log(`  内联中文 ${cjkInline.length}（原样返回，已能说清）`)
console.log(`  前缀兜底 ${prefixFallback.length}`)
console.log(`  真未映射 ${unmapped.length}`)

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} 处问题：`)
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}
if (process.argv.includes('--fail-unmapped') && unmapped.length > 0) {
  console.error(`\n✗ 仍有 ${unmapped.length} 个码没有文案：${unmapped.slice(0, 20).join(', ')}`)
  process.exit(1)
}
console.log('\n✓ 文案与条款号一致')
