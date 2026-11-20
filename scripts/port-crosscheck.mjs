/**
 * 纯语法端口核对（不依赖类型检查器）
 *
 * port-report.mjs 走符号解析，快、类型准，但已被证实会漏收个别引用
 * （例：createAirMissionDomain 实参里的 setAirStatus / markAirMissionFlown / pushLog）。
 * 本脚本只做一件事：把区间内的标识符引用，与「整个 setup 体里声明的名字」做差集，
 * 得到一份不依赖符号解析的端口名单，用来跟 port-report 的结果对拍。
 *
 * 用法：node scripts/port-crosscheck.mjs --start 2416 --end 2549
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const FILE = path.join(ROOT, 'src/stores/workbench.ts')

const args = process.argv.slice(2)
const getArg = (k) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : undefined
}
const START = Number(getArg('--start'))
const END = Number(getArg('--end'))
if (!Number.isFinite(START) || !Number.isFinite(END)) {
  console.error('需要 --start 与 --end')
  process.exit(1)
}

const src = fs.readFileSync(FILE, 'utf8')
const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

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

/** 绑定模式里的名字（含解构、默认值、rest） */
function bindingNames(node, out) {
  if (node === undefined) return out
  if (ts.isIdentifier(node)) out.push(node.text)
  else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const el of node.elements) {
      if (ts.isBindingElement(el)) bindingNames(el.name, out)
    }
  } else if (ts.isParameter(node)) bindingNames(node.name, out)
  return out
}

/** 一个顶层语句声明了哪些名字 */
function declaredNames(stmt, out) {
  if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) out.push(stmt.name.text)
  else if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) bindingNames(d.name, out)
  } else if (
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt) ||
    ts.isClassDeclaration(stmt)
  ) {
    if (stmt.name !== undefined) out.push(stmt.name.text)
  }
  return out
}

const allDeclared = new Map() // name -> 首次声明行
for (const stmt of setupBody.statements) {
  for (const n of declaredNames(stmt, [])) if (!allDeclared.has(n)) allDeclared.set(n, lineOf(stmt))
}

const inRange = (n) => {
  const l = lineOf(n)
  return l >= START && l <= END
}

const declaredInRange = new Set()
for (const stmt of setupBody.statements) {
  if (!inRange(stmt)) continue
  for (const n of declaredNames(stmt, [])) declaredInRange.add(n)
}

/** 区间内的值引用（跳过属性名、对象字面量的键、成员名） */
const refs = new Map() // name -> Set<line>
function walk(node) {
  if (ts.isPropertyAccessExpression(node)) {
    walk(node.expression)
    return
  }
  if (
    ts.isPropertyAssignment(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    if (!ts.isIdentifier(node.name)) walk(node.name)
    if (ts.isPropertyAssignment(node)) walk(node.initializer)
    else if (node.body !== undefined) walk(node.body)
    if (node.parameters !== undefined) for (const p of node.parameters) walk(p)
    return
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    const line = lineOf(node)
    if (line >= START && line <= END) {
      const set = refs.get(node.name.text) ?? new Set()
      set.add(line)
      refs.set(node.name.text, set)
    }
    return
  }
  if (ts.isIdentifier(node)) {
    const line = lineOf(node)
    if (line >= START && line <= END) {
      const set = refs.get(node.text) ?? new Set()
      set.add(line)
      refs.set(node.text, set)
    }
    return
  }
  node.forEachChild(walk)
}
for (const stmt of setupBody.statements) if (inRange(stmt)) walk(stmt)

const ports = []
const external = []
for (const [name, lines] of refs) {
  if (declaredInRange.has(name)) continue
  const decl = allDeclared.get(name)
  if (decl === undefined) external.push([name, [...lines].join(',')])
  else ports.push([decl, name, lines.size, [...lines].join(',')])
}
ports.sort((a, b) => a[0] - b[0])

console.log(`\n=== 语法端口（facade 本地声明）${ports.length} 项 —— ${START}..${END} ===`)
for (const [line, name, count, at] of ports) {
  const kind = 'local'
  console.log(
    `  ${String(line).padStart(6)}  ${kind.padEnd(10)}  ${name.padEnd(32)} refs=${count}  @${at}`,
  )
}
console.log(`\n=== 未在 setup 体内声明（真·外部）${external.length} 项 ===`)
for (const [name, at] of external) console.log(`  ${name.padEnd(32)} @${at}`)
