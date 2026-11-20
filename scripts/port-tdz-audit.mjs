/**
 * port-tdz-audit.mjs —— 拆域期间的"装配点前读值"审计
 *
 * 拆域的唯一运行时陷阱是 TDZ：`const airDomain = createAirDomain({ units, phase, … })`
 * 会把实参**立刻求值**。所以每个按值传进去的名字必须是
 *   ① `function` 声明（提升，写在多晚都能传），或
 *   ② `const`/`let`/`computed` 且声明在装配点**之前**。
 * 违反这条的写法在 typecheck 里是绿的、单测里也只是偶发（要看 store 是否真的被实例化），
 * 所以单独做一条审计。
 *
 * 用法：node scripts/port-tdz-audit.mjs [--file src/stores/workbench.ts]
 */
import fs from 'node:fs'
import process from 'node:process'

const argv = process.argv.slice(2)
const fileArgIdx = argv.indexOf('--file')
const file = fileArgIdx >= 0 ? argv[fileArgIdx + 1] : 'src/stores/workbench.ts'
const lines = fs.readFileSync(file, 'utf8').split('\n')

/** 找 `const X = createXxxDomain({ … })` 的所有装配点 */
const sites = []
for (let i = 0; i < lines.length; i++) {
  const m = /^\s*const (\w+) = (create\w+Domain)\(\{/.exec(lines[i])
  if (m) sites.push({ line: i + 1, varName: m[1], factory: m[2] })
}

/** 取实参名（跳过 `get x() {}` 访问器） */
function argsOf(siteLine) {
  const names = []
  for (let i = siteLine; i < lines.length; i++) {
    const raw = lines[i]
    if (i > siteLine - 1 && /^\s*\}\)/.test(raw)) break
    if (/^\s*get (\w+)/.test(raw)) continue
    const m = /^\s+(\w+),\s*$/.exec(raw)
    if (m) names.push(m[1])
  }
  return names
}

/** 声明种类与行号（只看 facade 顶层两格缩进） */
function declOf(name) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (new RegExp(`^  (?:async )?function ${name}\\b`).test(l))
      return { kind: 'function', line: i + 1 }
    if (new RegExp(`^  const ${name}\\s*(?::|=[^=])`).test(l)) {
      return { kind: l.includes('= computed') ? 'computed' : 'const', line: i + 1 }
    }
    if (new RegExp(`^  let ${name}\\s*(?::|=[^=])`).test(l)) return { kind: 'let', line: i + 1 }
  }
  return { kind: '外部/未找到', line: -1 }
}

let problems = 0
for (const site of sites) {
  const args = argsOf(site.line)
  const late = []
  for (const n of args) {
    const d = declOf(n)
    if (d.line > site.line && d.kind !== 'function') late.push(`${n}（${d.kind} @${d.line}）`)
  }
  console.log(
    `${site.factory} @${site.line}：按值 ${args.length} 项，` +
      (late.length
        ? `★ ${late.length} 项晚于装配点且非函数 ⇒ 建 store 即 ReferenceError`
        : '全部安全'),
  )
  for (const l of late) console.log(`   · ${l}`)
  problems += late.length
}
console.log(problems === 0 ? '通过' : `★ 共 ${problems} 处 TDZ 风险`)
process.exit(problems === 0 ? 0 : 1)
