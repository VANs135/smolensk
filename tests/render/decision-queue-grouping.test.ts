import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * P4 / UI1-b：初设队列**三组**（必做事项 / 可自主放弃项 / 已完成项）的**源码守卫**
 *
 * 本仓库不挂组件渲染测试 ⇒ 分组标题、计数来源、已完成列表的稳定 key 用源码断言钉住；
 * 真实点图/换手路径由既有 store 用例与人眼验收承担。
 *
 * 硬约束：组件只读 store 投影，**不得写完成标记**（不出现 `completed.value`）；
 * 既有落位入口（分方游标 / 算子图 / 卡车点选 / 完成初设）一个都不许丢。
 */
describe('P4 UI1-b：初设队列按必做/可放弃/已完成分组（源码守卫）', () => {
  const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')

  it('★ 三个分组标题都在，计数一律取 store 投影（组件不自己数）', () => {
    expect(queue).toContain('必做事项')
    expect(queue).toContain('可自主放弃项')
    expect(queue).toContain('已完成项')
    expect(queue).toContain('setup.requiredSetupIssues.length')
    expect(queue).toContain('setup.omittablePlacements.length')
    expect(queue).toContain('setup.completedPlacements.length')
  })

  it('★ 已完成列表用稳定 key（`placement.key`），算子图/名称/方标/进度逐条显示', () => {
    expect(queue).toContain('v-for="placement in setup.completedPlacements"')
    expect(queue).toContain(':key="placement.key"')
    expect(queue).toContain('placement.imageUrl')
    expect(queue).toContain('placement.label')
    expect(queue).toContain('placement.placed')
    expect(queue).toContain('placement.total')
  })

  it('★ 组件不写完成标记（只读盘面与既有台账）', () => {
    expect(queue).not.toContain('completed.value')
  })

  it('★ 既有入口仍在：分方游标 / 算子图 / 卡车点选 / 完成初设', () => {
    expect(queue).toContain('setup.sideQueue')
    expect(queue).toContain('item.imageUrl')
    expect(queue).toContain('setup.confirmSideSetup()')
    expect(queue).toContain('setup.beginTruckPick()')
    expect(queue).toContain('setup.startGameNow()')
    // 卡车装载已改地图点选，卡片上不得再出现勾选入口
    expect(queue).not.toContain('setup.toggleTruckFull(')
  })
})
