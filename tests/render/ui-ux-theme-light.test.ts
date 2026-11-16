import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 主题改浅（用户 2026-11-17）
 *
 * 口径：
 *   · 默认浅色（暖灰 / 米色底 + 深色文字），深色保留为可切换主题；
 *   · 对话框 / 面板 / 浮层 / 按钮 / 提示条 / 状态标记走同一套 `--color-command-*` 令牌；
 *   · 地图配色（地形 / 铁路 / 算子底 / 高亮 / 图层色）保持不动，只改界面外壳。
 *
 * 测法边界：源码形态守卫（与既有 render 守卫一致），像素仍靠人眼验收。
 */

const read = (path: string): string => readFileSync(path, 'utf8')

function blockOf(css: string, selector: string): string {
  const start = css.indexOf(selector)
  expect(start, `找不到选择器 ${selector}`).toBeGreaterThan(-1)
  const open = css.indexOf('{', start)
  const end = css.indexOf('}', open)
  return css.slice(open, end)
}

describe('主题改浅：默认浅色 + 深色可切换', () => {
  it('`:root` 的界面令牌默认是浅色（暖灰 / 米色），深色只挂在 data-theme=dark', () => {
    const tokens = read('src/styles/tokens.css')
    const root = blockOf(tokens, ':root {')
    expect(root).toContain('--color-command-bg: #f2efe7')
    expect(root).toContain('--color-command-ink: #26231e')
    expect(root).not.toContain('#101820')

    const dark = blockOf(tokens, ":root[data-theme='dark'] {")
    expect(dark).toContain('--color-command-bg: #101820')
    expect(dark).toContain('--color-command-ink: #eef5f6')
    expect(dark).toContain('color-scheme: dark')
  })

  it('`.theme-command` 不再写死深色，按钮与语义底色都有令牌', () => {
    const css = read('src/styles/base.css')
    const group = blockOf(css, '.theme-command {')
    expect(group).toContain('--color-on-accent: var(--color-command-on-accent)')
    expect(group).toContain('--color-accent-2: var(--color-command-accent-solid)')
    expect(group).toContain('--color-info-bg: var(--color-command-info-bg)')
    expect(group).not.toContain('color-scheme: dark')
  })

  it('按钮不再硬编码浅字 / 深色 hover，统一走令牌', () => {
    const button = read('src/components/base/BaseButton.vue')
    expect(button).not.toContain('#f6f4ee')
    expect(button).not.toContain('#3a5240')
    expect(button).not.toContain('#75271d')
    expect(button).toContain('var(--color-on-accent)')
    expect(button).toContain('var(--color-accent-2-hover)')
    expect(button).toContain('var(--color-danger-hover)')
  })

  it('对局台的令牌组与主题切换入口都在（单入口）', () => {
    const view = read('src/views/GameTableView.vue')
    expect(view).toContain('useThemeStore,')
    expect(view).toContain('const theme = useThemeStore()')
    expect(view).toContain("theme.mode === 'dark'")
    expect(view).toContain('theme.setMode(')
    expect(view).toContain('深色界面')
    expect(view).not.toContain('color-scheme: dark')
  })

  it('顶栏按钮不再用写死的白色叠加层', () => {
    const app = read('src/App.vue')
    expect(app).not.toContain('rgb(255 255 255')
  })

  it('状态标记的底衬也走令牌（DG / 停 角标）', () => {
    const popover = read('src/components/game/MapActionPopover.vue')
    const flag = blockOf(popover, '.chip__flag {')
    expect(flag).toContain('background: var(--color-ink)')
    expect(flag).toContain('color: var(--color-panel)')
    expect(flag).not.toContain('rgb(32 30 26')
  })

  it('地图本身的配色保持不动（地形 / 高亮 / 算子底）', () => {
    const layer = read('src/render/token-layer.ts')
    expect(layer).toContain("axis: '#7a2b2b'")
    expect(layer).toContain("select: '#e0b64a'")
    expect(layer).toContain("lossBadge: '#8c2f22'")
  })
})
