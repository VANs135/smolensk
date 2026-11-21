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
import path from 'node:path'
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

/** 取实参名（跳过 `get x() {}` 访问器；含 core/board/helpers 之类对象束的成员） */
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
/**
 * 端口宽度棘轮（A5）：
 *   每个 `workbench-*.ts` 切片的 `*Ports` / `*Deps` 接口成员数，与基线比对：
 *     · 已有基线 ⇒ **只许降不许升**；
 *     · 超过 40 项 ⇒ 必须列进 `over40Exempt`（拆分后删除豁免）。
 *   基线文件：docs/specs/2026-11-20-workbench解构/port-width-baseline.json
 *   重新生成（只应在"确认拆分/收口后"执行）：node scripts/port-tdz-audit.mjs --write-baseline
 */
const STORE_DIR = path.dirname(path.resolve(file))
const BASELINE_PATH = path.join(
  ROOT_DIR(),
  'docs/specs/2026-11-20-workbench解构/port-width-baseline.json',
)
const WIDTH_HARD_LIMIT = 40

function ROOT_DIR() {
  // 以 package.json 所在目录为准（与 port-report 同口径）
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  return process.cwd()
}

/** 数接口成员：只看两格缩进的 `name:` / `name(` / `readonly name:` */
function interfaceWidths(text) {
  const lines = text.split('\n')
  const widths = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^export interface (\w+(?:Ports|Deps))\s*\{/.exec(lines[i])
    if (!m) continue
    let count = 0
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\}/.test(lines[j])) break
      if (/^\s{2}(?:readonly )?[A-Za-z_$][\w$]*\??\s*[:(]/.test(lines[j])) count += 1
    }
    widths.push({ name: m[1], count })
  }
  return widths
}

function widthEntries() {
  const entries = []
  for (const name of fs.readdirSync(STORE_DIR)) {
    if (!/^workbench-.*\.ts$/.test(name)) continue
    const text = fs.readFileSync(path.join(STORE_DIR, name), 'utf8')
    for (const w of interfaceWidths(text)) entries.push({ file: name, ...w })
  }
  return entries
}

const entries = widthEntries()
const writeBaseline = argv.includes('--write-baseline')
if (writeBaseline) {
  const existing = fs.existsSync(BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    : { over40Exempt: ['workbench-air.ts', 'workbench-barrage.ts'] }
  const files = {}
  for (const e of entries) files[e.file] = e.count
  const payload = {
    note: '端口宽度棘轮：只许降不许升。超过 40 项的切片须列进 over40Exempt，并在拆分后删除豁免。',
    over40Exempt: existing.over40Exempt ?? [],
    files,
  }
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
  // 生成物必须同时是 prettier-clean，否则 `npm run check` 会在 format:check 步红
  const { format, resolveConfig } = await import('prettier')
  const prettierCfg = (await resolveConfig(BASELINE_PATH)) ?? {}
  const text = await format(JSON.stringify(payload), { ...prettierCfg, filepath: BASELINE_PATH })
  fs.writeFileSync(BASELINE_PATH, text, 'utf8')
  console.log(`已写入宽度基线：${path.relative(ROOT_DIR(), BASELINE_PATH)}`)
}

const baseline = fs.existsSync(BASELINE_PATH)
  ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  : { over40Exempt: ['workbench-air.ts', 'workbench-barrage.ts'], files: {} }
const exempt = new Set(baseline.over40Exempt ?? [])

console.log('—— 端口宽度（棘轮）——')
for (const e of entries) {
  const base = baseline.files?.[e.file]
  const over = e.count > WIDTH_HARD_LIMIT && !exempt.has(e.file)
  if (base !== undefined && e.count > base) {
    console.log(`   ★ ${e.file} / ${e.name}：${base} → ${e.count}（宽度增长）`)
    problems += 1
  } else if (over) {
    console.log(
      `   ★ ${e.file} / ${e.name}：${e.count} 项（超过 ${WIDTH_HARD_LIMIT} 红线且未豁免）`,
    )
    problems += 1
  } else {
    console.log(
      `   ${e.file} / ${e.name}：${e.count} 项` +
        (e.count > WIDTH_HARD_LIMIT ? '（豁免中，拆分后须删除豁免）' : ''),
    )
  }
}

console.log(problems === 0 ? '通过' : `★ 共 ${problems} 处问题（TDZ 或端口宽度）`)
process.exit(problems === 0 ? 0 : 1)
