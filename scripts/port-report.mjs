// 端口报告：给定 facade 里的一段行区间，算出"要切成独立切片还欠多少外部符号"
//
// 为什么需要：解构每一批的第一件事都是估端口规模（端口越大，切片的接口越脏）。
// B1 手写了三个一次性脚本才得到 51 项；本文件把它固定下来，后续批次同一条命令。
//
// 做法：用类型检查器做**符号级**解析（不是"名字出现过"的正则近似）——
//   ① 找到 `defineStore(..., () => { … })` 的 setup 函数体；
//   ② 只扫区间内的语句，收集标识符引用（区分 value 位 / type 位，跳过属性名）；
//   ③ 每个引用的符号，若它的所有声明**都不在区间内**，就是外部依赖 = 端口；
//   ④ 按来源分组，facade 本地的（= 需要做成 port）与外部模块的（= 直接 import）分开列。
//
// 用法：
//   node scripts/port-report.mjs --start 17391 --end 17950
//   node scripts/port-report.mjs --start 2416 --end 2592 --file src/stores/workbench.ts
//   node scripts/port-report.mjs --start … --end … --json out.json
//
// 判据：端口 > 40 就别切这一批（见 docs/specs/2026-11-20-workbench解构/spec.md §6）。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = fs.existsSync('package.json') ? process.cwd() : 'D:/OCS/smolensk'
const ts = createRequire(path.join(ROOT, 'package.json'))('typescript')

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const FILE = path.resolve(ROOT, opt('file', 'src/stores/workbench.ts'))
const START = Number(opt('start', '0'))
const END = Number(opt('end', '0'))
const JSON_OUT = opt('json', null)
if (!START || !END) {
  console.error(
    '用法：node scripts/port-report.mjs --start <行> --end <行> [--file …] [--json out]',
  )
  process.exit(2)
}

const cfg = ts.getParsedCommandLineOfConfigFile(
  path.join(ROOT, 'tsconfig.json'),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) =>
      console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n')),
  },
)
const program = ts.createProgram({ rootNames: [FILE], options: { ...cfg.options, noEmit: true } })
const checker = program.getTypeChecker()
const sf = program.getSourceFile(FILE)
const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
const inRange = (node) => {
  const line = lineOf(node)
  return line >= START && line <= END
}

/** 区间内出现过的标识符引用；key = 符号名@首次出现行 */
const refs = new Map()
function addRef(node, typeCtx) {
  const sym = checker.getSymbolAtLocation(node)
  if (sym === undefined) return
  const target = (sym.flags & ts.SymbolFlags.Alias) === 0 ? sym : checker.getAliasedSymbol(sym)
  const line = lineOf(node)
  const key = `${target.name}@${line}`
  const entry = refs.get(key) ?? {
    name: target.name,
    decls: target.declarations ?? [],
    isType: false,
  }
  entry.isType ||= typeCtx
  refs.set(key, entry)
}

function walk(node, typeCtx) {
  // `a.b` 只算 `a`（b 是属性，不是作用域里的符号）
  if (ts.isPropertyAccessExpression(node)) {
    walk(node.expression, typeCtx)
    return
  }
  if (ts.isIdentifier(node)) {
    addRef(node, typeCtx)
    return
  }
  if (ts.isQualifiedName(node)) {
    addRef(node.left, true)
    return
  }
  if (ts.isPropertyAssignment(node)) {
    if (ts.isComputedPropertyName(node.name)) walk(node.name.expression, false)
    walk(node.initializer, typeCtx)
    return
  }
  if (ts.isTypeNode(node)) {
    node.forEachChild((child) => walk(child, true))
    return
  }
  node.forEachChild((child) => walk(child, typeCtx))
}

/** 找到 setup 体 */
const setupBody = (() => {
  let found = null
  const visit = (node) => {
    if (found !== null) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'defineStore'
    ) {
      const fn = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
      if (fn !== undefined && ts.isBlock(fn.body)) found = fn.body
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return found
})()
if (setupBody === null) {
  console.error('找不到 defineStore 的 setup 函数体')
  process.exit(1)
}

/** ① 区间内的本地声明 ② 扫描引用 */
const local = []
/** 跨越 END 的语句：区间在函数体中间截断 ⇒ 会把它的局部变量误算成端口 */
const straddling = []
for (const stmt of setupBody.statements) {
  const s = lineOf(stmt)
  const e = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1
  if (s <= END && e > END) {
    const name =
      ts.isFunctionDeclaration(stmt) && stmt.name !== undefined
        ? stmt.name.text
        : ts.isVariableStatement(stmt)
          ? stmt.declarationList.declarations
              .map((d) => (ts.isIdentifier(d.name) ? d.name.text : '?'))
              .join(',')
          : '（非声明语句）'
    straddling.push(`${name} ${s}–${e}`)
  }
  if (!inRange(stmt)) continue
  if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined)
    local.push({ name: stmt.name.text, kind: 'function' })
  else if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) local.push({ name: d.name.text, kind: 'const' })
    }
  } else if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
    local.push({ name: stmt.name.text, kind: 'type' })
  }
  walk(stmt, false)
}

/** ③ 汇总外部依赖 */
const external = new Map()
for (const r of refs.values()) {
  if (r.decls.length === 0) continue // 真全局（Math / Object …）
  const allInside = r.decls.every((d) => d.getSourceFile() === sf && inRange(d))
  if (allInside) continue
  const d = r.decls[0]
  const fromFile = path.relative(ROOT, d.getSourceFile().fileName).replaceAll('\\', '/')
  const entry = external.get(r.name) ?? {
    name: r.name,
    fromFile,
    declLine: lineOf(d),
    kind: '?',
    isType: false,
    refs: 0,
  }
  entry.refs++
  entry.isType ||= r.isType
  if (ts.isFunctionDeclaration(d)) entry.kind = 'function'
  else if (ts.isVariableDeclaration(d)) entry.kind = 'const'
  else if (ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d)) entry.kind = 'type'
  else if (ts.isImportSpecifier(d) || ts.isImportClause(d)) entry.kind = 'import'
  else if (ts.isParameter(d) || ts.isBindingElement(d)) entry.kind = 'binding'
  external.set(r.name, entry)
}

const own = FILE.replaceAll('\\', '/').replace(`${ROOT.replaceAll('\\', '/')}/`, '')
const facade = [...external.values()].filter((e) => e.fromFile === own)
const modules = [...external.values()].filter((e) => e.fromFile !== own)

const sortByLine = (a, b) => a.declLine - b.declLine
facade.sort(sortByLine)
modules.sort((a, b) =>
  a.fromFile === b.fromFile ? a.declLine - b.declLine : a.fromFile.localeCompare(b.fromFile),
)

console.log(
  `${own} :${START}-${END}  本地声明 ${local.length} 个（function ${local.filter((x) => x.kind === 'function').length} / const ${local.filter((x) => x.kind === 'const').length}）`,
)
if (straddling.length > 0) {
  console.warn(
    `\n⚠ 区间在 ${straddling.length} 处函数体中间截断，截断处内部的局部变量会被误算成端口：`,
  )
  for (const s of straddling) console.warn(`    ${s}`)
  console.warn(
    '  ⇒ 把 --end 收到分节边界（或该函数最后一个 } 之后）再测，否则端口数偏高、不可用。\n',
  )
}
console.log(
  `\n=== 端口（facade 本地，需做成 ports）${facade.length} 项 ${facade.length > 40 ? '⚠ 超过 40 阈值，再拆一刀' : ''} ===`,
)
for (const e of facade) {
  console.log(
    `  ${String(e.declLine).padStart(6)}  ${(e.kind + (e.isType ? '/T' : '')).padEnd(11)} ${e.name.padEnd(30)} refs=${e.refs}`,
  )
}
console.log(`\n=== 直接 import（外部模块）${modules.length} 项 ===`)
for (const e of modules) {
  console.log(
    `  ${e.fromFile.padEnd(44)} ${String(e.declLine).padStart(6)}  ${(e.kind + (e.isType ? '/T' : '')).padEnd(11)} ${e.name}`,
  )
}

if (JSON_OUT !== null) {
  fs.writeFileSync(
    path.resolve(ROOT, JSON_OUT),
    `${JSON.stringify({ file: own, start: START, end: END, ports: facade, imports: modules, local }, null, 2)}\n`,
  )
  console.log(`\n已写入 ${JSON_OUT}`)
}
