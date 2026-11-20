import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores/workbench'

/**
 * ★ 公开面基线（解构安全网）：`useWorkbenchStore()` 返回对象的**键名**就是组件与其它 store 的契约。
 *
 * 背景：`src/stores/workbench.ts` 有 1,013 个公开键、`return` 字面量 1,155 行。
 * 解构（`docs/specs/2026-11-20-workbench解构/`）要把 707 个函数搬到多个切片，最后按域拼装 return —
 * 任何一个键**改名或漏掉**，组件侧只会得到静默 `undefined`，测试与类型都抓不到。这条测试负责抓。
 *
 * 三条纪律：
 *   ① **允许新增**，但必须显式更新基线（见下方重生成命令）——保证"新增"是有人在意的；
 *   ② **禁止静默删除或改名**：缺失键直接红，报出具体键名；
 *   ③ 基线文件必须非空且无重复，防止有人手滑清空文件让测试变空转。
 *
 * 重新生成基线（只在"确认要改动公开面"时执行，并把结果随改动的 commit 一起提交）：
 *   UPDATE_WORKBENCH_SURFACE=1 npx vitest run tests/stores/workbench-public-surface.test.ts
 */

const SNAPSHOT = new URL('./fixtures/workbench-public-surface.snapshot.json', import.meta.url)

/**
 * pinia 自身挂在 store 上的内建成员 —— 实测多出来的是
 * `$state` / `$patch` / `$subscribe` …（`$` 前缀）与 `_p` / `_customProperties` / `_hmrPayload` / `_hotUpdate`（`_` 前缀），
 * 它们不属于业务公开面，必须全部滤掉；否则基线会随 pinia 版本漂移。
 */
const PINIA_INTERNAL = /^[$_]/u

function loadBaseline(): string[] {
  try {
    const raw = readFileSync(SNAPSHOT, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function publicKeysOf(store: Record<string, unknown>): string[] {
  return Object.keys(store)
    .filter((key) => !PINIA_INTERNAL.test(key))
    .sort()
}

function saveBaseline(keys: string[]): void {
  const path = fileURLToPath(SNAPSHOT)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, 'utf8')
}

describe('workbench 公开面（解构安全网）', () => {
  it('键集与基线逐项一致：新增要显式更新基线，删改直接红', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore() as unknown as Record<string, unknown>
    const keys = publicKeysOf(store)

    if (process.env.UPDATE_WORKBENCH_SURFACE === '1') {
      saveBaseline(keys)
      console.log(`[公开面] 已写入基线：${keys.length} 个键`)
    }

    const baseline = loadBaseline()
    const missing = baseline.filter((key) => !keys.includes(key))
    const added = keys.filter((key) => !baseline.includes(key))

    expect({ missing, added }).toEqual({ missing: [], added: [] })
    expect(keys.length).toBe(baseline.length)
  })

  it('基线文件非空且无重复键', () => {
    const baseline = loadBaseline()
    expect(baseline.length).toBeGreaterThan(0)
    expect(new Set(baseline).size).toBe(baseline.length)
  })
})
