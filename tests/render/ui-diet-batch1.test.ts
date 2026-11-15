import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 界面收尾·批 1 守卫：主题与外壳
 *
 * 用户 2026-11-15 口径：
 *   · 深色界面的弹窗 / Toast / 待答窗统一到深色令牌；
 *   · 首页底部不留色带（壳层撑满视口）；
 *   · 字号回到整档（面板正文 14 / 次要 12）。
 *
 * 测法边界：本仓库不挂组件渲染测试，故这里钉**源码形态**（与既有 render 守卫一致）；
 * 像素与手感仍靠人眼验收。
 */

const read = (path: string): string => readFileSync(path, 'utf8')

describe('批 1：主题与外壳', () => {
  it('首页壳层是纵向 flex，首页能撑满视口（消除底部色带）', () => {
    const app = read('src/App.vue')
    const start = app.indexOf('.shell__body--full {')
    expect(start).toBeGreaterThan(-1)
    const block = app.slice(start, app.indexOf('}', start))
    expect(block).toContain('display: flex')
    expect(block).toContain('flex-direction: column')
  })

  it('深色令牌组存在，并覆盖面板 / 文字 / 规则线 / 语义色', () => {
    const css = read('src/styles/base.css')
    expect(css).toContain('.theme-command {')
    expect(css).toContain('--color-panel: var(--color-command-panel)')
    expect(css).toContain('--color-ink: var(--color-command-ink)')
    expect(css).toContain('--color-muted: var(--color-command-muted)')
    expect(css).toContain('--color-rule: var(--color-command-line)')
  })

  it('对话框 / Toast / 待答窗都挂深色令牌组', () => {
    expect(read('src/components/base/BaseDialog.vue')).toContain('theme-command')
    expect(read('src/components/base/ToastItem.vue')).toContain('theme-command')
    expect(read('src/components/session/QuestionPrompt.vue')).toContain('theme-command')
  })

  it('字号基线回到整档：sm=14px、xs=12px', () => {
    const tokens = read('src/styles/tokens.css')
    expect(tokens).toContain('--text-sm: 0.875rem')
    expect(tokens).toContain('--text-xs: 0.75rem')
  })
})
