import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useHotseatStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 批 G（用户 2026-11-16）：**初设飞机按激活分两栏**
 *
 * 口径：一型里既有激活又有未激活时，显示两栏（栏头写状态），栏内仍是算子阵列；
 * 点「激活」栏的算子就落激活那一枚（不再只是挨个按计划顺序落）。
 * 没有对应状态就不显示那一栏。
 */

function stores() {
  setActivePinia(createPinia())
  useHotseatStore().setMode('solo')
  const setup = useSetupStore()
  setup.selectScenario('1')
  return { setup, workbench: useWorkbenchStore() }
}

describe('批 G：飞机按激活态分栏（store 计数与按栏落位）', () => {
  it('★ 计数与计划同源：激活 + 未激活 = 该型剩余枚数', () => {
    const { setup } = stores()
    const row = setup
      .airPlanOf('soviet')!
      .placements.find(
        (item) => item.statuses.includes('active') && item.statuses.includes('inactive'),
      )!
    expect(row, '剧本 1 苏军应有"半未激活"的机型').toBeDefined()
    const counts = setup.airStatusCounts('soviet', row.entryIndex)
    expect(counts.active + counts.inactive).toBe(row.count)
    expect(counts.active).toBe(row.statuses.filter((status) => status === 'active').length)
    expect(counts.inactive).toBe(row.statuses.filter((status) => status === 'inactive').length)
  })

  it('★ 从「激活」栏点算子 ⇒ 落的是激活那一枚（即使计划里下一枚本来是未激活）', () => {
    const { setup, workbench } = stores()
    const row = setup
      .airPlanOf('soviet')!
      .placements.find(
        (item) =>
          item.statuses.includes('active') &&
          item.statuses.includes('inactive') &&
          item.statuses[0] === 'inactive' &&
          item.candidates.length > 0,
      )!
    expect(row, '需要一个"先未激活、后激活"且基地已就位的机型').toBeDefined()
    const before = setup.airStatusCounts('soviet', row.entryIndex)
    const unitCount = workbench.airUnits.length

    expect(setup.beginAirPlacement('soviet', row.entryIndex, 'active')).toBe(true)
    expect(setup.placeAtHex(row.candidates[0]!)).toBe(true)

    expect(workbench.airUnits.length).toBe(unitCount + 1)
    expect(workbench.airUnits.at(-1)?.airStatus).toBe('active')
    const after = setup.airStatusCounts('soviet', row.entryIndex)
    expect(after.active).toBe(before.active - 1)
    expect(after.inactive).toBe(before.inactive)
  })

  it('★ 某一状态已落满 ⇒ 该栏不再可点（begin 如实拒绝，不留空入口）', () => {
    const { setup } = stores()
    const row = setup
      .airPlanOf('soviet')!
      .placements.find(
        (item) =>
          item.statuses.filter((status) => status === 'active').length === 0 &&
          item.candidates.length > 0,
      )
    if (row === undefined) return // 剧本 1 若没有"全未激活"的苏军机型，本条不适用
    expect(setup.beginAirPlacement('soviet', row.entryIndex, 'active')).toBe(false)
  })
})

describe('批 G：界面（源码守卫）', () => {
  it('★ 两栏渲染：栏头状态 + 算子阵列；旧的「机型 · 激活态」文字已删', () => {
    const source = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    // 2026-11-19 初设队列改版：同一状态跨机型平铺（算子上就能认出机型），栏头口径不变
    expect(source).toContain('airStatusSections')
    expect(source).toContain("label: '激活'")
    expect(source).toContain("label: '未激活'")
    expect(source).toContain('queue__air-col-head')
    expect(source).toContain('v-for="chip in group.chips"')
    expect(source).toContain('pickAir(chip.item, group.status)')
    expect(source).toContain('setup.beginAirPlacement(item.side, item.entryIndex, status)')
    expect(source).not.toContain('airCardText')
    expect(source).not.toContain('airStatusText')
  })
})
