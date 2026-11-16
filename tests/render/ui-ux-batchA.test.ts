/**
 * 交互收口 批 A：收纳盒标记格去手输、去双入口、条款号进 `?`
 *
 * 用户口径（2026-11-16）：能点地图解决的不做下拉/手输；同一功能单入口；窗内不放描述文字；
 * 条款号收进 `?`。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('批 A：收纳盒标记格', () => {
  it('标记格只剩「点地图选格」一个入口，不再手输列.行', () => {
    const panel = read('src/components/containers/ContainersPanel.vue')
    expect(panel).not.toContain('v-model="workbench.formationMarkerHexText"')
    expect(panel).toContain('workbench.beginFormationMarkerHexPickNow()')
  })

  it('死亡堆返场落点同样只剩地图入口，不再手输', () => {
    const panel = read('src/components/containers/ContainersPanel.vue')
    expect(panel).not.toContain('v-model="workbench.deadPileReturnHexText"')
    expect(panel).toContain('workbench.beginDeadPileReturnHexPickNow()')
  })

  it('条款号与说明收进 ?，不再铺在标题/提示/按钮文案里', () => {
    // 只看可见模板：HTML 注释与 JSDoc 都允许保留条款号
    const panel = read('src/components/containers/ContainersPanel.vue')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(panel).not.toContain('编队收纳盒（13.7 / 3.6f')
    expect(panel).not.toContain('点选要收纳的图上单位（13.7')
    expect(panel).not.toContain('收纳进盒（13.7')
    expect(panel).toContain('<RuleTip rule="13.7"')
  })
})
