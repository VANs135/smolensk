/**
 * check-tdz.mjs —— 「装配点之前不许同步触达转发名」的机器闸
 *
 * 背景（spec §12.3 记过一次同源事故）：
 *   解构后 facade 里有一批 `const { pushLog, … } = core` / `= airDomain` 这样的解构绑定。
 *   它们和普通 `const` 一样有 TDZ。**若某个 `watch(..., { immediate: true })` 注册在
 *   这些解构之前**，Vue 会在建 store 那一刻执行回调 ⇒ 读到尚未初始化的绑定 ⇒ ReferenceError。
 *   现有代码没踩，但只是"还没踩"；靠人记住注释不可靠，所以做成脚本。
 *
 * 判据（只用顶层语句，避免函数体内的 `watch` 假阳性）：
 *   ① 找 `defineStore(..., () => { … })` 的 setup 函数体；
 *   ② 收集顶层 `const { … } = <local>` 的绑定名与行号（解构自本文件里的域对象）；
 *   ③ 收集顶层 `watch(...)` 且选项含 `immediate: true` 的调用；
 *   ④ 回调体里出现的标识符（跳过嵌套函数体、跳过属性名）若命中 ② 且行号早于绑定 ⇒ 失败。
 *
 * 用法：node scripts/check-tdz.mjs [--file src/stores/workbench.ts]
 */
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
const text = fs.readFileSync(FILE, 'utf8')
const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1

/** 找 defineStore 的 setup 函数体（第二个实参） */
function setupBody() {
  let found = null
  const visit = (node) => {
    if (
      found === null &&
      ts.isCallExpression(node) &&
      node.expression.getText(sf) === 'defineStore' &&
      node.arguments.length >= 2
    ) {
      const fn = node.arguments[1]
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) found = fn.body
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

const body = setupBody()
if (body === null || !ts.isBlock(body)) {
  console.error('check-tdz：没有找到 defineStore 的 setup 函数体')
  process.exit(1)
}

/** ② 顶层解构绑定：`const { a, b: c } = xxx` */
const bindings = new Map()
for (const st of body.statements) {
  if (!ts.isVariableStatement(st)) continue
  for (const decl of st.declarationList.declarations) {
    if (!ts.isObjectBindingPattern(decl.name)) continue
    if (decl.initializer === undefined || !ts.isIdentifier(decl.initializer)) continue
    const line = lineOf(decl.name.getStart())
    for (const el of decl.name.elements) {
      if (ts.isIdentifier(el.name))
        bindings.set(el.name.text, { line, from: decl.initializer.text })
    }
  }
}

/** ④ 回调体标识符：跳过嵌套函数体与属性名 */
function collectIdentifiers(node, out) {
  if (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return
  }
  if (ts.isPropertyAccessExpression(node)) {
    collectIdentifiers(node.expression, out)
    return
  }
  if (ts.isPropertyAssignment(node)) {
    collectIdentifiers(node.initializer, out)
    return
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    out.add(node.name.text)
    return
  }
  if (ts.isIdentifier(node)) {
    out.add(node.text)
    return
  }
  ts.forEachChild(node, (child) => collectIdentifiers(child, out))
}

/** ③ 顶层 immediate watch */
const problems = []
let watchCount = 0
for (const st of body.statements) {
  if (!ts.isExpressionStatement(st)) continue
  const call = st.expression
  if (!ts.isCallExpression(call) || call.expression.getText(sf) !== 'watch') continue

  const opts = call.arguments.find(
    (a) =>
      ts.isObjectLiteralExpression(a) &&
      a.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          p.name.getText(sf) === 'immediate' &&
          p.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ),
  )
  if (opts === undefined) continue
  const cb = call.arguments[1]
  if (cb === undefined || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) continue

  watchCount += 1
  const watchLine = lineOf(call.getStart())
  const names = new Set()
  collectIdentifiers(cb.body, names)

  const hits = []
  for (const name of names) {
    const b = bindings.get(name)
    if (b !== undefined && b.line > watchLine) hits.push(`${name}（绑定自 ${b.from} @${b.line}）`)
  }
  if (hits.length > 0) problems.push(`watch @${watchLine}：${hits.join('、')}`)
}

console.log(
  `check-tdz：${path.relative(ROOT, FILE)} 顶层解构 ${bindings.size} 个名 / immediate watch ${watchCount} 个`,
)
for (const p of problems) console.error(`   ★ ${p}`)
console.log(problems.length === 0 ? '通过' : `★ 共 ${problems.length} 个 watch 会在装配前撞 TDZ`)
process.exit(problems.length === 0 ? 0 : 1)
