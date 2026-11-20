// 重新生成解构迁移清单（当前坐标）
//
// 为什么要有这个脚本：`docs/specs/2026-11-20-workbench解构/migration.csv` 里的行号是
// 「动手之前」的快照。每搬完一批，facade 都会缩短上千行，其余分节的坐标全部漂移——
// 照旧坐标去切下一批会切错位置。所以坐标必须可复现地重算，而不是手抄。
//
// 用法：node scripts/migration-report.mjs [--out docs/specs/.../migration.csv]
//
// 输出列：section, section_title, function, kind, line, inbound_sections_count, inbound_from_sections
//   - section 由 `/* ──── 标题 ──── */` 形态的分节注释划分（-1 = 首个分节之前的核心区）
//   - inbound 是**真实调用边**（CallExpression 经类型检查器解析到本文件的函数声明），
//     不是「名字出现过」的近似；注释里的类型名不会污染统计
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

const FILE = 'src/stores/workbench.ts'
const SRC = readFileSync(FILE, 'utf8')
const sf = ts.createSourceFile(FILE, SRC, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

const program = ts.createProgram({
  rootNames: [FILE],
  options: { noEmit: true, skipLibCheck: true },
})
const checker = program.getTypeChecker()
const sfC = program.getSourceFile(FILE) ?? sf

const lineOf = (node) => (node ? sfC.getLineAndCharacterOfPosition(node.getStart(sfC)).line + 1 : 0)

// ---- 分节：缩进 2 的 `/* ─── 标题 ─── */`（至少 8 个横线才算分节）----
const headers = []
SRC.split('\n').forEach((text, i) => {
  const trimmed = text.trim()
  if (!/^\/\*\s*[─]{8,}/u.test(trimmed) || !trimmed.endsWith('*/')) return
  const bars = trimmed.replace(/^\/\*/, '').replace(/\*\/$/, '')
  const title = bars.replace(/[─]/gu, '').trim()
  if (title) headers.push({ line: i + 1, title })
})
const sectionOf = (line) => {
  let idx = -1
  for (let i = 0; i < headers.length; i++) if (headers[i].line <= line) idx = i
  return idx
}
const titleOf = (idx) => (idx < 0 ? '核心区（分节之前）' : headers[idx].title)

// ---- setup 顶层声明 ----
let setup = null
const findSetup = (n) => {
  if (setup) return
  if (
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === 'defineStore'
  ) {
    const fn = n.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
    if (fn?.body && ts.isBlock(fn.body)) setup = fn.body
  }
  n.forEachChild(findSetup)
}
findSetup(sfC)

const decls = [] // {name, kind, line, section}
const byName = new Map()
for (const st of setup.statements) {
  const line = lineOf(st)
  if (ts.isFunctionDeclaration(st) && st.name) {
    const rec = { name: st.name.text, kind: 'function', line, section: sectionOf(line), node: st }
    decls.push(rec)
    byName.set(rec.name, rec)
  } else if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue
      const isFn =
        d.initializer &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
      const rec = {
        name: d.name.text,
        kind: isFn ? 'const-fn' : 'const',
        line,
        section: sectionOf(line),
        node: d,
      }
      decls.push(rec)
      if (isFn && !byName.has(rec.name)) byName.set(rec.name, rec)
    }
  }
}

// ---- 调用边：caller 所在分节 -> callee 所在分节 ----
const inbound = new Map() // callee name -> Set(section)
const walk = (node, currentSection) => {
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    if (ts.isIdentifier(callee)) {
      const sym = checker.getSymbolAtLocation(callee)
      const target = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
      const d = target?.declarations?.[0]
      if (d && d.getSourceFile().fileName.endsWith('workbench.ts')) {
        const name = target.name
        const calleeLine = lineOf(d)
        // 只统计本文件内的函数级调用
        if (byName.has(name) && calleeLine > 0) {
          const from = currentSection
          const to = sectionOf(calleeLine)
          if (from !== to) {
            if (!inbound.has(name)) inbound.set(name, new Set())
            inbound.get(name).add(from)
          }
        }
      }
    }
  }
  node.forEachChild((c) => walk(c, currentSection))
}
for (const st of setup.statements) walk(st, sectionOf(lineOf(st)))

// ---- 输出 ----
const rows = decls.map((r) => {
  const from = [...(inbound.get(r.name) ?? [])].sort((a, b) => a - b)
  return {
    section: r.section,
    section_title: titleOf(r.section),
    function: r.name,
    kind: r.kind,
    line: r.line,
    inbound_sections_count: from.length,
    inbound_from_sections: from.join('|'),
  }
})
rows.sort((a, b) => a.line - b.line)

const outIdx = process.argv.indexOf('--out')
const OUT =
  outIdx > 0 ? process.argv[outIdx + 1] : 'docs/specs/2026-11-20-workbench解构/migration.csv'
const esc = (v) => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const header =
  'section,section_title,function,kind,line,inbound_sections_count,inbound_from_sections'
const text = [header, ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\n') + '\n'
writeFileSync(OUT, text, 'utf8')

const fnOnly = rows.filter((r) => r.kind === 'function')
const perSection = new Map()
for (const r of fnOnly) perSection.set(r.section, (perSection.get(r.section) ?? 0) + 1)
console.log(`写入 ${OUT}`)
console.log(
  `行 ${rows.length}（function ${fnOnly.length} / const ${rows.length - fnOnly.length}）；分节 ${headers.length}`,
)
console.log(
  [...perSection]
    .sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `${s}:${n}`)
    .join(' '),
)
