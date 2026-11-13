import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { collectSetupGaps } from '@/engine/rules/setup-effects'
import { useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 专规 4.3：苏军拆分单位池按剧本派生
 *
 * 原文：印量 6×AR2 + 2×AR3；「two AR2 breakdowns are already deployed, which leaves
 * 4x AR2 and 2x AR3 available」——已在场的 AR2 拆团要从池里扣掉。
 *
 * 剧本 5/6 原文提到的那两枚已部署 AR2 拆团在工程数据里没有坐标（未登记），
 * 故这两剧本按 0 枚在场计，池仍是 6×AR2 + 2×AR3；缺口另行登记，不用示例坐标顶。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

describe('专规 4.3：拆分单位池按剧本扣掉已在场的 AR2 拆团', () => {
  it.each([
    // [剧本, 已在场 AR2 拆团, 池总存量 = 2×AR3 + 可用 AR2]
    ['1', 2, 6],
    ['2', 2, 6], // 与 1 共用初设
    ['3', 1, 7],
    ['4', 1, 7], // 与 3 共用初设
    ['5', 0, 8], // 原文两枚已部署，但数据无坐标 ⇒ 缺口，不从池里扣
    ['6', 0, 8], // 与 5 共用初设
    ['7', 0, 8],
  ])('剧本 %s：在场 %i 枚 AR2 ⇒ 池存量 %i', (scenarioId, onMapAr2, expectedPool) => {
    const { setup, workbench } = newStores()
    expect(setup.selectScenario(scenarioId)).toBe(true)
    expect(workbench.breakdownPool.su).toBe(expectedPool)
    // AR2 可用量 = 池总量 − 2×AR3；锁住用户口径的 4 / 5 / 6
    expect((workbench.breakdownPool.su ?? 0) - 2).toBe(6 - onMapAr2)
  })

  it('轴军池仍按印量（本批只改苏军 AR2 的剧本派生）', () => {
    const { setup, workbench } = newStores()
    expect(setup.selectScenario('1')).toBe(true)
    expect(workbench.breakdownPool.ax).toBe(30)
  })

  it('剧本 5/6：两枚已部署 AR2 拆团无坐标 ⇒ 登记初设缺口（不臆造坐标）', () => {
    for (const scenarioId of ['5', '6']) {
      const gap = collectSetupGaps(scenarioId).find(
        (item) => item.field === 'breakdownPool.ar2OnMap',
      )
      expect(gap).toBeDefined()
      expect(gap?.action).toBe('skip+default')
    }
  })
})
