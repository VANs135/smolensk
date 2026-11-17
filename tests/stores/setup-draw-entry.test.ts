import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 用户 2026-11-18：剧本页的抽签是纯机械动作 ⇒ 完成初设时**自动执行**，
 * 全程序不再有「抽取编队」按钮入口；初设面板与容器窗都只读。
 */

function read(relative: string): string {
  return readFileSync(relative, 'utf8')
}

describe('抽取编队：自动执行 + 不再有按钮', () => {
  it('地图左上角「初设」栏不再有「抽取编队」按钮；确认初设走 startGameNow 自动抽取', () => {
    const queue = read('src/components/game/DecisionQueue.vue')
    expect(queue).not.toContain('抽取编队')
    expect(queue).not.toContain('setup.drawSetupEffectsNow(')
    expect(queue).not.toContain('setup.setupDrawEntryVisible')
    expect(queue).toContain('setup.startGameNow()')
  })

  it('初设面板与容器窗只读：没有可点抽取按钮，也不再指向「初设」栏按钮', () => {
    const panel = read('src/components/setup/SetupPanel.vue')
    expect(panel).not.toContain('setup.drawSetupEffectsNow(')
    expect(panel).not.toContain('抽取编队')
    expect(panel).toContain('自动抽取')
    const containers = read('src/components/containers/ContainersPanel.vue')
    expect(containers).not.toContain('setup.drawSetupEffectsNow(')
    expect(containers).not.toContain('抽取入口在地图左上角')
  })

  it('过期文案已删：自动抽取 / 点图给落点 / 尚未接线', () => {
    expect(read('src/components/setup/SetupPanel.vue')).not.toContain('选剧本时已自动抽取')
    expect(read('src/components/setup/SetupPanel.vue')).not.toContain('再点地图给落点')
    const supply = read('src/components/supply/SupplyPanel.vue')
    expect(supply).not.toContain('尚未接线')
    expect(supply).not.toContain('运输点数作为铁路货物')
  })
})
