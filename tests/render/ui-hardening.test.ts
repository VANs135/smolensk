import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 界面硬伤整改的**源码守卫**（2026-11-25）
 *
 * 仓库不挂浏览器挂载测试 ⇒ 运行时观感（重叠 / 裁字 / 对比度）在源码形态上钉死：
 *   · UI-1 当前步：品牌红底 + `on-accent` 浅字（不再"绿底压红字"）；
 *   · UI-2 通知条：从顶栏下方 72px 起，宿主本身不吃指针；
 *   · UI-3 空军选机提示：允许换行，不裁字；
 *   · P2-3 决策栈按钮：可点高度 ≥32px；
 *   · P2-7 深色主按钮：提亮后与浅字仍 ≥4.5:1。
 *
 * 真正的像素级回归（截图比对）留给 `scripts/ui-regression.mjs`；这里只防"改回去"。
 */
const read = (path: string): string => readFileSync(path, 'utf8')

/** 相对亮度（WCAG 2.x；`#rrggbb` 入参） */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function ratio(a: string, b: string): number {
  const [light, dark] = luminance(a) > luminance(b) ? [a, b] : [b, a]
  return (luminance(light) + 0.05) / (luminance(dark) + 0.05)
}

describe('界面硬伤：源码守卫', () => {
  it('UI-1 当前步不再是「绿底压红字」', () => {
    const strip = read('src/components/session/FlowStrip.vue')
    const block = strip.slice(strip.indexOf("[aria-current='step']"))
    expect(block).toContain('background: var(--color-accent)')
    expect(block).toContain('color: var(--color-on-accent)')
    expect(block).not.toContain('background: var(--color-accent-2)')
  })

  it('UI-2 通知条从顶栏下方起，且宿主不吃指针', () => {
    const toast = read('src/components/base/ToastHost.vue')
    // 顶栏 ≈ 64px；20px 时正好压在存档按钮上
    expect(toast).toMatch(/\.toast-host\s*\{[^}]*top:\s*72px/s)
    expect(toast).toMatch(/\.toast-host\s*\{[^}]*pointer-events:\s*none/s)
    expect(toast).toMatch(/\.toast-host > \*\s*\{[^}]*pointer-events:\s*auto/s)
  })

  it('UI-3 空军选机提示允许换行（不再 nowrap + ellipsis 裁字）', () => {
    const queue = read('src/components/game/DecisionQueue.vue')
    const block = queue.slice(queue.indexOf('.queue__air-pickbar .queue__hint'))
    // 注释里会写"修前是 nowrap" ⇒ 先把注释剥掉再判规则体
    const rule = block.slice(0, block.indexOf('}')).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rule).toContain('white-space: normal')
    expect(rule).not.toContain('nowrap')
    expect(rule).not.toContain('text-overflow')
  })

  it('P2-3 决策栈按钮可点高度 ≥32px', () => {
    const queue = read('src/components/game/DecisionQueue.vue')
    expect(queue).not.toContain('min-height: 24px')
    expect(queue).toMatch(/\.queue__stack-btn\s*\{[^}]*min-height:\s*32px/s)
  })

  it('P2-7 深色主按钮提亮后，浅字仍 ≥4.5:1', () => {
    const css = read('src/styles/tokens.css')
    const dark = css.slice(css.indexOf(":root[data-theme='dark']"))
    const solid = dark.match(/--color-command-accent-solid:\s*(#[0-9a-f]{6})/)?.[1]
    const onAccent = dark.match(/--color-command-on-accent:\s*(#[0-9a-f]{6})/)?.[1]
    expect(solid).toBeTruthy()
    expect(onAccent).toBeTruthy()
    expect(ratio(solid!, onAccent!)).toBeGreaterThanOrEqual(4.5)
  })

  // UI-6（2026-11-26 实机复核）：左栏 z 高于待答遮罩后，教学卡若还钉 left:12 会被栏背裁掉首字
  it('UI-6 教学卡让开左栏宽度（不被左栏压掉首字）', () => {
    const guide = read('src/components/tutorial/TutorialGuide.vue')
    const block = guide.slice(guide.indexOf('.tut__card {'))
    const rule = block.slice(0, block.indexOf('}')).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rule).toContain('left: calc(var(--command-rail) + 12px)')
    expect(rule).toContain('var(--command-rail)')
    expect(rule).not.toMatch(/left:\s*12px/)
  })

  // UI-7（2026-11-26 用户，v5 口径）：左栏一律纯图标、盒组压在最上、栏底 存档→设置→撤销；
  // 下方托盘整条删除（盒入口只有左栏这一处，不再有第二条）
  it('UI-7 左栏：纯图标居中、盒组在最上、栏底存档→设置→撤销，且不再有底部托盘', () => {
    const table = read('src/views/GameTableView.vue')
    // 盒组：单字分组（轴/苏/共）＋ 一盒一枚，点开走 BoxCard 浮窗（不另做抽屉式盒窗）
    expect(table).toContain('gt__rail-group')
    expect(table).toContain('boxRailGroups')
    expect(table).toContain('containers.setPopupCard(card.id)')
    // 盒组必须排在抽屉列之前（「压在最上」）
    expect(table.indexOf('boxRailGroups')).toBeLessThan(table.indexOf('gt__rail-main'))
    // 抽屉列排除设置；栏底三枚按 存档 / 设置 / 撤销 排
    expect(table).toContain("drawers.filter((item) => item.id !== 'settings')")
    const save = table.indexOf('aria-label="存档 / 读档"')
    const settings = table.indexOf('table-drawer-settings')
    const undo = table.indexOf('gt__rail-undo')
    expect(save).toBeGreaterThan(0)
    expect(settings).toBeGreaterThan(save)
    expect(undo).toBeGreaterThan(settings)
    // 一律纯图标 ⇒ 按钮居中（既不是 icon 上字下，也不再是左靠的文字列）
    const rule = table.slice(
      table.indexOf('.gt__rail-button {'),
      table.indexOf('.gt__rail-button {' + 900),
    )
    expect(rule).toContain('flex-direction: row')
    expect(rule).toContain('justify-content: center')
    expect(rule).not.toContain('justify-content: flex-start')

    // 下方不留栏：托盘整条删除（组件不再挂、样式也清掉）
    expect(table).not.toContain('BottomTray')
    expect(table).not.toContain('.gt__tray-dock')
    // 顶栏右上回主页面的是「☰ 主菜单」
    const app = read('src/App.vue')
    expect(app).toContain('主菜单')
    expect(app).toContain('shell__menu-mark')
  })
})
