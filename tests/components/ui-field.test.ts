import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 条 24 / §5-F：正式/验证模式的**落码守卫**。
 *
 * 仓库不打 DOM（`environment: 'node'`），故这里按"源码守卫"验证机制。
 * 真正的分模式渲染由 `UiField.vue` 里的 `uiMode === 'verify'` 分支承担：
 *   验证页 → 可编辑 `<input>`；正式界面 → 只读 `<span class="ui-field-readonly">`。
 */
const root = join(process.cwd())
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

describe('条 24：正式/验证模式门控', () => {
  it('UiField：验证页渲染 input、正式界面渲染只读 span', () => {
    const src = read('src/components/UiField.vue')
    expect(src).toMatch(/v-if="uiMode === 'verify'"/)
    expect(src).toMatch(/<input/)
    expect(src).toMatch(/v-else[^>]*class="ui-field-readonly"/)
    expect(src).toMatch(/useUiMode\(\)/)
  })

  it('全局样式提供 .ui-field-readonly（各面板的只读 span 复用）', () => {
    const css = read('src/styles/base.css')
    expect(css).toMatch(/\.ui-field-readonly\s*\{/)
  })

  it('两个宿主视图各自声明模式：对局台 formal / 验证页 verify', () => {
    expect(read('src/views/GameTableView.vue')).toMatch(/provideUiMode\(\s*'formal'\s*\)/)
    expect(read('src/views/WorkbenchView.vue')).toMatch(/provideUiMode\(\s*'verify'\s*\)/)
  })

  it('AirPanel：手输文本/数字已走 UiField 或双分支只读（不再有裸 input）', () => {
    const src = read('src/components/air/AirPanel.vue')
    // 采用门控
    expect(src).toMatch(/useUiMode\(\)/)
    // @change 类字段（任务格/返航格）走 v-if=verify + 只读 span
    expect(src).toMatch(/v-if="uiMode === 'verify'"/)
    expect(src.match(/class="ui-field-readonly"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    // 剩余 <input 只应是 checkbox（游戏动作），或落在 verify 分支内。
    // 逐行核对：凡以 `<input` 起头且非 checkbox 的，必须紧邻 v-if="uiMode === 'verify'"。
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*<input\b/.test(lines[i])) continue
      const block = lines.slice(i, i + 8).join('\n')
      const isCheckboxOrRadio = /type="(checkbox|radio)"/.test(block)
      if (isCheckboxOrRadio) continue
      // 文本/数字输入：其标签内（紧随的几行）应带 v-if="uiMode === 'verify'"
      const near = lines.slice(i, i + 4).join('\n')
      expect(near, `AirPanel 第 ${i + 1} 行的文本输入未门控：\n${block}`).toMatch(
        /v-if="uiMode === 'verify'"/,
      )
    }
  })
})
