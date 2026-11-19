import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 军事沙盘复古视觉（2026-11-19「全新安卓界面」）
 *
 * 仓库无组件挂载测试 ⇒ 钉源码形态：
 *   · 沙盘原色 --ops-* 是唯一颜色来源，入口页 --color-command-* 与对局 HUD --glass-* 全量重映射；
 *   · 令牌块用 `html[data-platform='android']:root` 压过 tokens.css 深色主题；
 *   · 画布底板色由平台注入：安卓填深色桌面、桌面端保持地图纸米白（零影响）。
 */
const css = readFileSync('src/styles/android.css', 'utf8')
const render = readFileSync('src/render/map-render.ts', 'utf8')
const canvas = readFileSync('src/components/map/MapCanvas.vue', 'utf8')

describe('安卓军事沙盘复古视觉', () => {
  it('沙盘原色是唯一来源，且令牌块优先级压过深色主题', () => {
    // 选择器带 :root（0,2,1）才能压过 tokens.css 的 :root[data-theme='dark']（0,2,0）
    expect(css).toContain("html[data-platform='android']:root {")
    for (const token of [
      '--ops-table:',
      '--ops-canvas:',
      '--ops-khaki:',
      '--ops-brass:',
      '--ops-oxide:',
      '--ops-steel:',
    ]) {
      expect(css).toContain(token)
    }
    expect(css).toContain('color-scheme: dark')
  })

  it('入口页与对局 HUD 全量重映射到沙盘色（消除浅色/深色分裂）', () => {
    // 入口页：主页/剧本/简报/弹窗读 --color-command-*
    expect(css).toContain('--color-command-bg: var(--ops-table)')
    expect(css).toContain('--color-command-ink: var(--ops-khaki)')
    expect(css).toContain('--color-command-teal: var(--ops-brass)')
    expect(css).toContain('--color-command-teal-bg: var(--ops-brass-soft)')
    expect(css).toContain('--color-command-axis: var(--ops-steel)')
    expect(css).toContain('--color-command-soviet: var(--ops-oxide)')
    // 对局 HUD：读 --glass-*
    expect(css).toContain('--glass-bg: rgb(34 39 31 / 0.92)')
    expect(css).toContain('--glass-ink: var(--ops-khaki)')
    expect(css).toContain('--glass-line: rgb(201 162 39 / 0.24)')
  })

  it('WCAG AA：主文字/次文字压深底的对比度达标', () => {
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ]
      const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (a: string, b: string): number => {
      const sorted = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
      return (sorted[0] + 0.05) / (sorted[1] + 0.05)
    }
    const canvasColor = '#22271f'
    expect(ratio('#e8dfc4', canvasColor)).toBeGreaterThanOrEqual(4.5) // 主文字
    expect(ratio('#b0a586', canvasColor)).toBeGreaterThanOrEqual(4.5) // 次文字
    expect(ratio('#c9a227', canvasColor)).toBeGreaterThanOrEqual(4.5) // 黄铜强调
    expect(ratio('#d47460', canvasColor)).toBeGreaterThanOrEqual(4.5) // 铁锈红
  })

  it('画布底板色由平台注入，桌面端零影响', () => {
    // 渲染层：新增可选 boardColor，缺省沿用地图纸米白
    expect(render).toContain('boardColor?: string')
    expect(render).toContain('ctx.fillStyle = options.boardColor ?? MAP_PALETTE.board')
    // 组件：仅安卓传深色，桌面传 undefined ⇒ 原观感不变
    expect(canvas).toContain("import { isAndroidPlatform } from '@/shared/platform'")
    expect(canvas).toContain("boardColor: isAndroidPlatform() ? '#141712' : undefined")
  })
})
