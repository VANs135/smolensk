import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 安卓触摸皮肤（2026-11-19）
 *
 * 仓库无组件挂载测试 ⇒ 钉源码形态：
 *   · 皮肤只在 Capacitor 安卓壳里命中（`html[data-platform='android']`），桌面不受影响；
 *   · Material 3 的 48dp 命中区、底部导航、底部 sheet、地图 FAB；
 *   · 初设队列在安卓里不再可拖（避免与地图平移抢手势）。
 */
const css = readFileSync('src/styles/android.css', 'utf8')
const main = readFileSync('src/main.ts', 'utf8')
const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
const platform = readFileSync('src/shared/platform.ts', 'utf8')

describe('安卓触摸皮肤', () => {
  it('只在 android 平台启用，且装配时先挂平台属性', () => {
    expect(css).toContain("html[data-platform='android']")
    expect(main).toContain('applyPlatformAttribute()')
    expect(platform).toContain('Capacitor.getPlatform()')
    expect(platform).toContain("return 'android'")
  })

  it('Material 3 尺度：48dp 命中区、底部导航、底部 sheet、地图 FAB', () => {
    expect(css).toContain('--control-height: 48px')
    expect(css).toContain('--android-nav-height')
    expect(css).toContain(".gt__rail-button[aria-expanded='true']")
    expect(css).toContain('--android-sheet-radius')
    expect(css).toContain('.gt__drawer::before')
    expect(css).toContain('.queue::before')
    expect(css).toContain('.mapcanvas--fill .mapcanvas__tools')
    expect(css).toContain('flex-direction: column')
  })

  it('安卓壳里初设队列固定为底部 sheet，不接拖动', () => {
    expect(queue).toContain('isAndroidPlatform')
    expect(queue).toContain('if (isAndroidPlatform()) return')
  })
})
