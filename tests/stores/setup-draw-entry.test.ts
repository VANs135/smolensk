import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 用户 2026-11-11（体检 A 组；同日追加）：
 *   · 抽取编队入口**唯一**在地图左上角「初设」栏（`DecisionQueue`）；初设面板与容器窗只读
 *     （同一动作不得两处可点）；
 *   · 过期文案（「选剧本时已自动抽取」「点图给落点」「尚未接线」）不得回填。
 */

function read(relative: string): string {
  return readFileSync(relative, 'utf8')
}

describe('抽取编队入口唯一 + 过期文案', () => {
  it('唯一可点入口在地图左上角「初设」栏：可见条件复用 setupDrawEntryVisible', () => {
    const queue = read('src/components/game/DecisionQueue.vue')
    expect(queue).toContain('setup.setupDrawEntryVisible')
    expect(queue).toContain('setup.executeSetupDraws()')
    expect(queue).toContain('抽取编队')
  })

  it('初设面板与容器窗只读：不再挂第二个可点的抽取按钮', () => {
    const panel = read('src/components/setup/SetupPanel.vue')
    expect(panel).not.toContain('setup.executeSetupDraws()')
    expect(panel).toContain('地图左上角「初设」栏')
    const containers = read('src/components/containers/ContainersPanel.vue')
    expect(containers).not.toContain('setup.executeSetupDraws()')
    expect(containers).toContain('地图左上角「初设」栏')
  })

  it('过期文案已删：自动抽取 / 点图给落点 / 尚未接线', () => {
    expect(read('src/components/setup/SetupPanel.vue')).not.toContain('选剧本时已自动抽取')
    expect(read('src/components/setup/SetupPanel.vue')).not.toContain('再点地图给落点')
    const supply = read('src/components/supply/SupplyPanel.vue')
    expect(supply).not.toContain('尚未接线')
    expect(supply).not.toContain('运输点数作为铁路货物')
  })
})
