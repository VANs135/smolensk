/**
 * 交互收口 12 号：补给阶段浮层可收起
 *
 * 原状：右上角固定 364px、常驻不收起，D 段整块压在地图上。
 * 口径：给一个明确的展开/收起入口，收起后只剩右上角小条，不挡地图。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const panel = readFileSync('src/components/supply/SupplyPhasePanel.vue', 'utf8')

describe('12 号：补给浮层', () => {
  it('有收起态与展开/收起按钮', () => {
    expect(panel).toContain('const collapsed = ref(false)')
    expect(panel).toContain('phase-panel--collapsed')
    expect(panel).toContain(':aria-expanded="!collapsed"')
    expect(panel).toContain('@click.stop="collapsed = !collapsed"')
  })

  it('收起后不渲染正文，并取消固定宽度', () => {
    expect(panel).toContain('<div v-if="!collapsed" class="phase-panel__body">')
    expect(panel).toContain('.phase-panel--collapsed {')
    expect(panel).toContain('width: auto;')
  })
})
