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
const table = readFileSync('src/views/GameTableView.vue', 'utf8')
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

  it('初设队列在安卓壳里不接拖动', () => {
    expect(queue).toContain('isAndroidPlatform')
    expect(queue).toContain('if (isAndroidPlatform()) return')
  })

  it('窗口紧凑（用户 2026-11-19 第 1 条）：初设浮窗贴合内容、抽屉收高，不再占大屏', () => {
    // 初设窗口：内容驱动宽高（max-content + margin 居中），只留防溢出上限；
    // 居中不能用 transform（模板 inline transform:translate(dx,dy) 会覆盖它）
    expect(css).toContain("html[data-platform='android'] .queue {")
    expect(css).toContain('width: max-content')
    expect(css).toContain('margin-inline: auto')
    expect(css).toContain('max-height: 46%')
    // 横屏再压一档（原 62% 已收紧）
    expect(css).toContain('max-height: 52%')
    // 其它窗口：战况抽屉从 72% 收到 60%
    expect(css).toContain('max-height: 60%')
    expect(css).not.toContain('max-height: 72%')
    expect(css).not.toContain('max-height: 58%')
    // 按钮缩小且同排
    expect(css).toContain('.queue__actions .btn,')
    expect(css).toContain('height: 34px')
  })

  it('一键预设与确认同排常驻：动作列不再有「更多」折叠（用户 2026-11-19「不需要箭头呼出」）', () => {
    const actions = queue.indexOf('class="queue__actions"')
    const preset = queue.indexOf('@click="runPresetSetup()"')
    expect(actions).toBeGreaterThanOrEqual(0)
    // 预设按钮位于 actions 行内（常驻）
    expect(preset).toBeGreaterThan(actions)
    // 撤回 ↺ 改为图标、挪到棋桌左栏「设置」下方（2026-11-20 用户）
    expect(table).toContain('class="gt__rail-button gt__rail-undo"')
    // 「更多」折叠整个移除
    expect(queue).not.toContain('class="queue__more"')
    // 一键全落：无 onlySide 参数
    expect(queue).toContain('presetResult.value = setup.presetSelfSetupNow()')
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
    // 按钮精简：撤回 ↺ 改为图标，落在棋桌左栏（2026-11-20 用户「放到设置按钮下方」）
    expect(table).toContain('gt__rail-undo')
    // 「更多」details 已整体移除（撤回不再折进折叠）
    expect(queue).not.toContain('class="queue__more"')
    expect(queue).not.toContain('queue__more-toggle')
  })
})
