import { createApp } from 'vue'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { bindUiMode, useUiMode } from '@/components/ui-mode'

/**
 * 条 24 / §5-F：**正式 / 验证模式开关**
 *
 * 为什么必须先有它：对局台（`GameTableView`）与引擎验证页（`WorkbenchView`）**共用同一批面板**，
 * 除 `VictoryPanel referee` 外没有任何区分 ⇒ 若直接删 63 处手输，验证页会一起被扣掉输入
 * （第六批 §5-F 原话）。故先落这一个开关：正式界面按它收起手输，验证页按它全部保留。
 *
 * 本文件钉三件事：
 *   ① **缺省偏保守**：宿主没声明模式 ⇒ `verify`（宁可多给一个输入框，也不能悄悄删掉裁判的手输退路）；
 *   ② **注入链路通**：`provideUiMode` 声明的那一支里 `useUiMode()` 拿得到，且只影响那一支；
 *   ③ **源码守卫**：两个宿主各自声明了自己的模式（对局台 formal / 验证页 verify）。
 */

/** 在有 provide 的上下文里取一次模式（`runWithContext`：不挂 DOM 也能验证注入链） */
const modeInContext = (mode?: 'formal' | 'verify'): string => {
  const app = createApp({})
  if (mode !== undefined) bindUiMode(app, mode)
  return app.runWithContext(() => useUiMode())
}

describe('条 24 / §5-F：正式 / 验证模式开关', () => {
  it('① 宿主**没声明** ⇒ verify（缺省保留手输，不悄悄删裁判退路）', () => {
    expect(modeInContext()).toBe('verify')
  })

  it('② 声明 formal ⇒ 该支拿到 formal（对局台：收起手输）', () => {
    expect(modeInContext('formal')).toBe('formal')
  })

  it('③ 声明 verify ⇒ 该支拿到 verify（验证页：保留全部输入）', () => {
    expect(modeInContext('verify')).toBe('verify')
  })

  it('④ 源码守卫：两个宿主各自声明了自己的模式', () => {
    const table = readFileSync('src/views/GameTableView.vue', 'utf8')
    const bench = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(table).toMatch(/provideUiMode\('formal'\)/)
    expect(bench).toMatch(/provideUiMode\('verify'\)/)
  })
})
