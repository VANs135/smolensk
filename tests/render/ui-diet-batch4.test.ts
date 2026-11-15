/**
 * 批 4：会话框的密度与层级（源码守卫）
 *
 * 用户口径（2026-11-15）：
 *   ① 会话框内层面板改扁平紧凑变体（去双框、去双层内边距，380px 宽下不挤）；
 *   ② 每步统一「步进头（如 补给 2/6）+ 一行当前决定 + 控件 + 唯一主按钮」；
 *   ③ 地图小窗回到地图内层级，不再压住右侧栏与流程条；
 *   ④ 面板标题与正文统一走字号档位，不再写死 1rem。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('批 4：会话框的密度与层级', () => {
  it('BasePanel 提供 Dock 用的扁平紧凑变体（去双框、去双层内边距）', () => {
    const panel = read('src/components/base/BasePanel.vue')
    expect(panel).toContain("import { PANEL_FLAT } from './panel-flat'")
    expect(panel).toContain('panel--flat')
    expect(panel).toContain('.panel--flat')
    expect(panel).toContain('background: transparent')
    expect(panel).toContain('border: 0')
  })

  it('MapDock 注入扁平变体，并给出「当前第几件 / 共几件」', () => {
    const dock = read('src/components/map/MapDock.vue')
    expect(dock).toContain('provide(PANEL_FLAT, true)')
    expect(dock).toContain('SESSION_STEP_PROGRESS')
    expect(dock).toContain('mapView.sessionSteps')
    expect(dock).toContain('total')
  })

  it('SessionStep 渲染步进头与一行当前决定', () => {
    const step = read('src/components/session/SessionStep.vue')
    expect(step).toContain('SESSION_STEP_PROGRESS')
    expect(step).toContain('step__count')
    expect(step).toContain('{{ progress.index }}/{{ progress.total }}')
    expect(step).toContain('step__decision')
    expect(step).toContain('{{ step.decision }}')
  })

  it('地图小窗回到地图内层级（--layer-map-popup），不再压住右栏与流程条', () => {
    const popover = read('src/components/map/MapPopover.vue')
    expect(popover).toContain('z-index: var(--layer-map-popup)')
    expect(popover).not.toContain('z-index: var(--z-dialog-top)')
  })

  it('面板标题与正文统一走字号档位，不写死 1rem', () => {
    const panel = read('src/components/base/BasePanel.vue')
    expect(panel).toContain('font-size: var(--text-lg)')
    expect(panel).toContain('font-size: var(--text-sm)')
    expect(panel).not.toContain('font-size: 1rem')
  })
})
