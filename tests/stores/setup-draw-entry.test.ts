import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 用户 2026-11-11（体检 A 组）：
 *   · 抽取编队入口**唯一**在「初设与开局」面板；容器窗只读（同一动作不得两处可点）；
 *   · 过期文案（「选剧本时已自动抽取」「点图给落点」「尚未接线」）不得回填。
 */

function read(relative: string): string {
  return readFileSync(relative, 'utf8')
}

describe('抽取编队入口唯一 + 过期文案', () => {
  it('初设面板有真正的按钮：可见条件复用 setupDrawEntryVisible，点击即 executeSetupDraws', () => {
    const panel = read('src/components/setup/SetupPanel.vue')
    expect(panel).toContain('v-if="setup.setupDrawEntryVisible"')
    expect(panel).toContain('setup.executeSetupDraws()')
    expect(panel).toContain('摆完初设单位后抽取')
  })

  it('容器窗只读：不再挂第二个可点的抽取按钮', () => {
    const panel = read('src/components/containers/ContainersPanel.vue')
    expect(panel).not.toContain('setup.executeSetupDraws()')
    expect(panel).toContain('抽取入口在「初设与开局」面板')
  })

  it('过期文案已删：自动抽取 / 点图给落点 / 尚未接线', () => {
    expect(read('src/components/setup/SetupPanel.vue')).not.toContain('选剧本时已自动抽取')
    expect(read('src/components/setup/SetupPanel.vue')).not.toContain('再点地图给落点')
    const supply = read('src/components/supply/SupplyPanel.vue')
    expect(supply).not.toContain('尚未接线')
    expect(supply).not.toContain('运输点数作为铁路货物')
  })
})
