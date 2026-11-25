/**
 * 安装仓库内的 git 钩子（目前只有 pre-push）。
 *
 * 为什么要有这个脚本：`.git/hooks/*` 不入库，手写一次换机器就丢；
 * 这里把钩子的内容作为代码放进 scripts/，`npm install`（prepare）自动装回。
 *
 * 幂等：内容没变化就不重写；CI 上直接跳过（沙箱不需要钩子）。
 */

import { execSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

if (process.env.CI) {
  console.log('[hooks] CI 环境，跳过安装')
  process.exit(0)
}

/** 钩子正文：交给 node 跑 scripts/pre-push-check.mjs，逻辑与文案都在那边 */
const HOOK_BODY = `#!/bin/sh
# 由 scripts/install-hooks.mjs 生成，请勿手改（改动请改 scripts/pre-push-check.mjs）
exec node "$(git rev-parse --show-toplevel)/scripts/pre-push-check.mjs"
`

let hookPath
try {
  hookPath = resolve(
    execSync('git rev-parse --git-path hooks/pre-push', { encoding: 'utf8' }).trim(),
  )
} catch {
  console.warn('[hooks] 当前目录不是 git 仓库，跳过安装')
  process.exit(0)
}

const dir = dirname(hookPath)
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

const current = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : ''
if (current === HOOK_BODY) {
  console.log('[hooks] pre-push 已是最新')
  process.exit(0)
}

writeFileSync(hookPath, HOOK_BODY, { mode: 0o755 })
// Windows 没有执行位，chmod 静默；Git for Windows 按脚本内容识别
try {
  chmodSync(hookPath, 0o755)
} catch {
  /* 忽略 */
}
console.log(`[hooks] 已安装 pre-push -> ${hookPath}`)
