/**
 * 批 5：右键子菜单点击展开、工具条去重、突围返场点地图选格（源码守卫）
 *
 * 用户口径（2026-11-15）：
 *   ① 右键子菜单改为**点击展开并保持**（不再悬停展开、移出即收）；
 *   ② 地图工具条里滑杆与 −/+ 重复，只留一套；
 *   ③ 突围返场不再手打格号，点地图选格。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('批 5：右键子菜单 / 工具条 / 突围返场', () => {
  it('右键子菜单点击展开并保持，不再靠 hover', () => {
    const popover = read('src/components/game/MapActionPopover.vue')
    expect(popover).toContain('function toggleGroup')
    expect(popover).toContain('openGroup')
    expect(popover).toContain('@click="toggleGroup')
    expect(popover).not.toContain('.context-group:hover > .context-group__submenu')
    expect(popover).not.toContain(':focus-within > .context-group__submenu')
  })

  it('地图工具条只保留 −/+ 一套缩放控件', () => {
    const canvas = read('src/components/map/MapCanvas.vue')
    expect(canvas).toContain('aria-label="缩小"')
    expect(canvas).toContain('aria-label="放大"')
    expect(canvas).not.toContain('type="range"')
    expect(canvas).not.toContain('mapcanvas__slider')
    expect(canvas).not.toContain('onScaleInput')
  })

  it('突围返场改为点地图选格，不再手输格号', () => {
    const breakout = read('src/components/breakout/BreakoutPanel.vue')
    expect(breakout).toContain('beginHexPick')
    expect(breakout).toContain('deployBreakoutReturnNow')
    expect(breakout).not.toContain('returnHexText')
    expect(breakout).not.toContain('placeholder="列.行"')
  })
})
