/**
 * 架构扫描的**命令行入口**（`npm run check` 的第五关）
 *
 * 读全树文本 → 跑 `arch-scan.mjs` 的三项扫描 → 有结论即打印并 `exit 1`。
 * 三项之外还有一项**资产**闸门（库引用的算子图必须在 `public/counters/` 下）——
 * 那条口径复用 `sync-counters.mjs` 的纯函数，已经在 vitest 里（`tests/scripts/sync-counters.test.ts`）。
 *
 * 运行：`node scripts/check-arch.mjs`（或 `npm run arch`）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ZERO_CALL_WHITELIST,
  cssTokensOf,
  scanCssVariables,
  scanRuleLiterals,
  scanStaleWhitelist,
  scanZeroCallExports,
} from './arch-scan.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归收集指定扩展名的文件（跳过 node_modules/dist/release/backup） */
function collect(dir, extensions, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'release', 'backup', '.git'].includes(entry.name)) continue
      collect(join(dir, entry.name), extensions, acc)
      continue
    }
    if (extensions.some((ext) => entry.name.endsWith(ext))) acc.push(join(dir, entry.name))
  }
  return acc
}

/** 读成 `相对路径 → 文本`（相对路径统一用 `/`，与白名单键一致） */
function readSources(paths) {
  const map = new Map()
  for (const path of paths) {
    const key = path.replace(/\\/g, '/').replace(`${REPO_ROOT.replace(/\\/g, '/')}/`, '')
    map.set(key, readFileSync(path, 'utf8'))
  }
  return map
}

const styleSources = readSources([...collect(join(REPO_ROOT, 'src'), ['.vue', '.css'])])
const allSources = readSources([
  ...collect(join(REPO_ROOT, 'src'), ['.ts', '.vue']),
  ...collect(join(REPO_ROOT, 'tests'), ['.ts']),
  ...collect(join(REPO_ROOT, 'scripts'), ['.mjs', '.mts']),
])
const componentSources = new Map(
  [...styleSources].filter(([file]) => /^src\/(components|views)\//.test(file)),
)

// 变量定义取全树（组件 scoped 样式里也可能定义局部变量）
const defined = new Set()
for (const text of styleSources.values()) for (const name of cssTokensOf(text)) defined.add(name)

const issues = [
  ...scanRuleLiterals({ sources: componentSources }),
  ...scanCssVariables({ sources: styleSources, defined }),
  ...scanZeroCallExports({ sources: allSources, whitelist: ZERO_CALL_WHITELIST }),
  // B45：白名单**陈旧项**也要报（接线后应删除那一行，白名单才能随接线收敛）
  ...scanStaleWhitelist({ sources: allSources, whitelist: ZERO_CALL_WHITELIST }),
]

if (issues.length === 0) {
  console.log(
    `架构扫描通过：组件 ${componentSources.size} 个 / 样式 ${styleSources.size} 个 / 源码 ${allSources.size} 个` +
      `；CSS 变量 ${defined.size} 个；零调用白名单 ${ZERO_CALL_WHITELIST.length} 条`,
  )
} else {
  for (const item of issues)
    console.error(`${item.file}:${item.line}  [${item.kind}] ${item.detail}`)
  console.error(`架构扫描未通过：${issues.length} 条`)
  process.exit(1)
}
