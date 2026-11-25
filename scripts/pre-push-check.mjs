/**
 * push 前门禁：跑与 CI 完全相同的 `npm run check`。
 *
 * 由 `.git/hooks/pre-push` 调用（钩子内容见 scripts/install-hooks.mjs）。
 * 钩子只在本地存在，不属于版本库内容，因此换机器后要跑一次 `npm run hooks:install`
 * （`npm install` 的 prepare 也会自动装）。
 *
 * 逃生口（明知要推、且已自行跑过门禁时）：
 *   SKIP_PRE_PUSH_CHECK=1 git push
 * 或在钩子层面整体绕过：
 *   git push --no-verify
 */

import { spawnSync } from 'node:child_process'

const skip = process.env.SKIP_PRE_PUSH_CHECK === '1'
if (skip) {
  console.warn('[pre-push] 已设置 SKIP_PRE_PUSH_CHECK=1，跳过门禁')
  process.exit(0)
}

console.log(
  '[pre-push] 跑 npm run check（全量一轮约 10 分钟）；急推用 SKIP_PRE_PUSH_CHECK=1 git push',
)

// Windows 上 npm 是 .cmd，必须经 shell 解析；参数是常量，无注入面
const result = spawnSync('npm', ['run', 'check'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error) {
  console.error('[pre-push] 无法启动 npm：', result.error.message)
  process.exit(1)
}

if (result.status !== 0) {
  console.error('[pre-push] 门禁未通过，push 已中止（未推送任何东西）')
  process.exit(result.status ?? 1)
}

console.log('[pre-push] 门禁通过，继续推送')
