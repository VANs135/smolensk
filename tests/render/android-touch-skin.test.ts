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

  it('横屏适配（用户 2026-11-19「横屏太大」）：断点含 orientation，且横屏再压一档', () => {
    // 断点从只看 max-width 改为「窄屏或横屏」：横屏宽 1280 不再退回桌面竖排导航
    expect(css).toContain('@media (max-width: 1024px), (orientation: landscape)')
    // 所有横屏覆盖仍锁在 android 平台，桌面/手机浏览器横屏不受影响
    expect(css).toContain('@media (orientation: landscape)')
    // 横屏紧凑：导航降到 52px、FAB 44px、教学卡隐藏介绍段
    expect(css).toContain('--android-nav-height: calc(52px + var(--safe-bottom))')
    expect(css).toContain('width: 44px')
    expect(css).toContain('.tut__card .tut__intro')
    expect(css).toContain('display: none')
    // 竖屏专属的「教学卡下移 200px」已加 portrait 限定，横屏不再中招
    expect(css).toContain('(orientation: portrait)')
  })

  it('去白框 + 初设单排横向带 + 按钮精简（用户 2026-11-19）', () => {
    // 深色玻璃 HUD 变量（去白框、地图上可读）
    expect(css).toContain('--glass-bg:')
    expect(css).toContain('--glass-ink:')
    expect(css).toContain('background-color: var(--glass-bg)')
    // 面板字色就地重映射（流程条小字也要提亮）
    expect(css).toContain('--color-muted: var(--glass-ink-dim)')
    // 初设待落项 → 单排横向带：flex + overflow-x:auto + 不换行 + max-content
    expect(css).toContain("html[data-platform='android'] .queue__sections,")
    expect(css).toContain('overflow-x: auto')
    expect(css).toContain('flex-wrap: nowrap')
    expect(css).toContain('width: max-content')
    // 按钮精简：次要动作收进「更多」details
    expect(css).toContain('.queue__more-toggle')
    expect(queue).toContain('const androidUi = isAndroidPlatform()')
    expect(queue).toContain('class="queue__more"')
    expect(queue).toContain(':open="!androidUi"')
    // 桌面仍平铺：summary 默认隐藏、details display:contents
    expect(queue).toContain('.queue__more {\n  display: contents;\n}')
  })
})
