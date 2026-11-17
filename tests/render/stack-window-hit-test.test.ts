import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * 堆叠窗内右键无效（用户 2026-11-18 实机，真实 CDP 鼠标事件复现）
 *
 * 复现过程（不是单测桩）：
 *   1. 固定开窗（1600 宽地图、点 3.25 的 7 枚堆叠）⇒ `.popover` 出现 7 个 chip；
 *   2. 取第一个 chip 的中心点做命中测试：修前 `elementFromPoint` 返回
 *      `NAV.gt__rail`（左侧指令栏），不是 chip —— 小窗贴边开在指令栏下面；
 *   3. 真实右键（`Input.dispatchMouseEvent` mousePressed/mouseReleased，button=right）
 *      落在指令栏上，`popup.variant` 仍是 `content`、`contextOptions` 为 0 ⇒ 菜单出不来。
 *
 * 根因：地图小窗层级是 `--layer-map-popup(20)`，指令栏/托盘是 `--layer-shell(30)`；
 * 小窗锚点按视口夹取，贴边时会横跨到指令栏下面，真实指针事件被上层吃掉。
 * 不是没绑 `contextmenu`、也不是菜单目标错（摊开态/HQ/编内卡车/飞机同一绑定）。
 *
 * 修法：小窗按**地图可视区**夹取（不压指令栏/托盘），层级维持原口径不变。
 */
describe('堆叠窗右键：小窗落在地图可视区内', () => {
  it('★ MapPopover 支持可用区夹取（默认整窗，传了就夹在地图里）', () => {
    const src = read('src/components/map/MapPopover.vue')
    expect(src).toContain(
      'bounds?: { left: number; right: number; top: number; bottom: number } | null',
    )
    expect(src).toContain('area.left')
    expect(src).toContain('area.bottom')
    // 层级口径不变：仍在地图内层级，不压右栏/流程条
    expect(src).toContain('z-index: var(--layer-map-popup)')
  })

  it('★ 堆叠窗与右键菜单都按地图矩形夹取', () => {
    const src = read('src/components/game/MapActionPopover.vue')
    expect(src).toContain("document.querySelector('.mapcanvas')")
    expect(src.match(/:bounds="mapArea"/g)?.length).toBe(2)
  })

  it('★ 芯片仍绑定到该枚自己的 id（右键入口未被改动）', () => {
    const src = read('src/components/game/MapActionPopover.vue')
    expect(src).toContain('@contextmenu.prevent.stop="onChipContext($event, unit.id)"')
    expect(src).toContain('@contextmenu.prevent.stop="onChipContext($event, air.instanceId)"')
  })
})
