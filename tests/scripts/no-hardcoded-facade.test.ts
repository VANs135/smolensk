/**
 * 元测试：测试里不许再硬编码 `src/stores/workbench.ts`
 *
 * 背景：解构把实现搬进 `workbench-*.ts` 之后，"源码守卫型"测试若只读 facade，
 * 会因为"文件里没有这段字"假红（B2-1b 的 `action-wiring`、B2-2a 的
 * `single-implementation` 都踩过）。统一走 `tests/shared/store-source.ts`
 * 的 `readStoreSource()`：facade + 全部切片，新增切片自动纳入。
 *
 * 白名单只留三类：
 *   ① store-source.ts —— 聚合读取器本身；
 *   ② workbench-public-surface.test.ts —— 公开面基线，必须实例化真实 store；
 *   ③ action-wiring.test.ts —— 有意按文件顺序扫（切片先、facade 后，防抢到转发壳）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const ALLOWED = new Set([
  'tests/shared/store-source.ts',
  'tests/stores/workbench-public-surface.test.ts',
  'tests/stores/action-wiring.test.ts',
  'tests/scripts/no-hardcoded-facade.test.ts',
])

const LITERAL = 'src/stores/workbench.ts'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('解构守卫：测试不得硬编码 facade 路径', () => {
  it('出现 `src/stores/workbench.ts` 一律改用 readStoreSource()（白名单除外）', () => {
    const offenders: string[] = []
    for (const file of walk('tests')) {
      const rel = relative(process.cwd(), file).replace(/\\/g, '/')
      if (ALLOWED.has(rel)) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes(LITERAL)) offenders.push(`${rel}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
