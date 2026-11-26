import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * P6 / UI6-b：布局收敛的**源码守卫**（仓库不挂组件渲染测试）
 *
 * 只钉真实缺口与既成事实：
 *   ① 按 H 折叠右栏时，根节点带折叠态类，grid 收成单列 ⇒ 320px 空槽被回收；
 *   ② `aside` 的 `v-show` 入口保留（折叠入口不变）；
 *   ③ 地图视口不回退：`72vh` / `min-height: 360px`；
 *   ④ 托盘两段默认折叠（`null` = 都收起、同时只展开一段）；
 *   ⑤ 不新增调试标识（`console.log` / `data-debug`）。
 */
describe('P6：折叠右栏回收列宽（源码守卫）', () => {
  it('GameTableView：地图伸展填满折叠抽屉释放的空间', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).toMatch(/\.gt__workspace\s*\{[^}]*display:\s*flex/s)
    expect(game).toMatch(/\.gt__main\s*\{[^}]*flex:\s*1\s+1\s+auto/s)
  })

  it('GameTableView：aside 折叠入口保留', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).toContain('v-show="!hotkeys.panelCollapsed"')
  })

  it('MapCanvas：地图视口未回退', () => {
    const canvas = readFileSync('src/components/map/MapCanvas.vue', 'utf8')
    expect(canvas).toContain('height: 72vh')
    expect(canvas).toContain('min-height: 360px')
  })

  it('盒入口：左栏盒组是唯一入口，底部不再有托盘（也不再占地图高度）', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    // 2026-11-26（用户 v5）：托盘整条删除 ⇒ 组件不再挂、样式不再留
    expect(game).not.toContain('BottomTray')
    expect(game).not.toContain('.gt__tray-dock')
    // 盒入口＝左栏一盒一枚，点开走 BoxCard 浮窗
    expect(game).toContain('gt__rail-box')
    expect(game).toContain('containers.setPopupCard(card.id)')
    // 地图不再让位给托盘：`.gt__main` 里只有地图这一件事
    expect(game).not.toContain('gt__tray-dock')
  })

  it('P2：左栏不越过模态层闸门（≤ --z-panel: 200）', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).not.toMatch(/\.gt__rail\s*\{[^}]*z-index:\s*calc\(var\(--z-panel\)\s*\+\s*10\)/s)
    expect(game).toMatch(/\.gt__rail\s*\{[^}]*z-index:\s*var\(--layer-shell\)/s)
  })

  it('P2：会话框默认位给右上角缩放簇让开 40px', () => {
    const dock = readFileSync('src/components/map/MapDock.vue', 'utf8')
    expect(dock).toMatch(/\.dock\s*\{[^}]*right:\s*calc\(var\(--space-3\)\s*\+\s*40px\)/s)
  })

  it('无调试标识', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).not.toContain('console.log')
    expect(game).not.toContain('data-debug')
  })
})
