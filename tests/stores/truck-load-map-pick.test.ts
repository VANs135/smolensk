import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 第六批批 S 切片 2（条 2）：**卡车装载改地图点选**
 *
 * 用户口径（第六批条 2）：「**地图上高亮可装载卡车，点击即装载**，去掉核验按钮」。
 *
 * 修前的病灶：卡车只在**决策队列的卡片**上给一个勾选框（＋一个"核验卡车装载"按钮）——
 *   同型卡车几十辆同名同图，玩家在列表里**认不出是哪一辆**，只能靠行号；而他真正要回答的是
 *   "图上这一辆装不装"。故改为：地图高亮编内卡车 → 点一辆即切换满载 → 选够剧本页要求的
 *   辆数时**自动落账**（不再要玩家再点一次"核验"）。
 *
 * 条文：13.2h（编内卡车满载＝载 1 SP）、专规 Setup Note C、IV-D「只有剧本页明示才满载」
 *   —— `all_loaded` / `all_unloaded` 两种模式**不由玩家决定**（初设自动落账），
 *   只有 `choose_loaded` 才进点选；本文件用剧本 3（自选 4 辆）驱动。
 *
 * ## 测法边界（如实交代）
 *   · 用真实剧本与真实单位库；盘面来自 `selectScenario('3')` 的自动初设；
 *   · 只钉**点选这一层**（高亮格 / 点即切换 / 选够自动落账）；
 *     装载名单的**引擎核对**（`planTruckFullLoad`）在 `tests/stores/setup-flow.test.ts`。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

/** 某辆编内卡车当前的所在格（盘面事实） */
function truckHex(
  workbench: ReturnType<typeof newStores>['workbench'],
  instanceId: string,
): HexRef {
  const unit = workbench.units.find((item) => item.instanceId === instanceId)
  if (unit === undefined) throw new Error(`盘面上没有这辆卡车：${instanceId}`)
  return { col: unit.hex.col, row: unit.hex.row }
}

describe('第六批 S2：卡车装载的地图点选（条 2）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('前提自检：剧本 3 是 `choose_loaded`（自选 4 辆）⇒ 卡车进点选队列', () => {
    const { setup } = stores
    setup.selectScenario('3')
    expect(setup.truckLoadMode).toBe('choose_loaded')
    expect(setup.requiredFullTrucks).toBe(4)
    expect(setup.setupTrucks.length).toBeGreaterThanOrEqual(4)
  })

  it('★ 非 `choose_loaded` 的剧本 ⇒ 开不了点选（已自动落账，不再问玩家）', () => {
    const { setup } = stores
    setup.selectScenario('1') // 「德军全部满载」
    expect(setup.truckLoadMode).toBe('all_loaded')
    expect(setup.beginTruckPick()).toBe(false)
    expect(setup.truckPickActive).toBe(false)
    expect(setup.truckPickHexes).toHaveLength(0)
  })

  it('★ 开启点选 ⇒ 高亮的**就是**编内卡车所在格', () => {
    const { setup, workbench } = stores
    setup.selectScenario('3')
    expect(setup.beginTruckPick()).toBe(true)
    expect(setup.truckPickActive).toBe(true)
    expect(setup.truckPickHexes).toHaveLength(setup.setupTrucks.length)
    const expected = setup.setupTrucks
      .map((truck) => truckHex(workbench, truck.instanceId))
      .map((hex) => `${hex.col}.${hex.row}`)
    expect(new Set(setup.truckPickHexes.map((hex) => `${hex.col}.${hex.row}`))).toEqual(
      new Set(expected),
    )
  })

  it('★ 点一辆卡车即装载；再点同一辆即卸下（无需"取消"入口）', () => {
    const { setup, workbench } = stores
    setup.selectScenario('3')
    expect(setup.beginTruckPick()).toBe(true)
    const first = setup.setupTrucks[0]!
    const hex = truckHex(workbench, first.instanceId)

    expect(setup.pickTruckAtHex(hex)).toBe(true)
    expect(setup.effectiveFullTruckIds).toContain(first.instanceId)

    // 再点 ⇒ 卸下（数量角标与名单同步回退）
    expect(setup.pickTruckAtHex(hex)).toBe(true)
    expect(setup.effectiveFullTruckIds).not.toContain(first.instanceId)
  })

  it('★ 选够剧本页要求的辆数 ⇒ **自动落账**（去掉了"核验"按钮）', () => {
    const { setup, workbench } = stores
    setup.selectScenario('3')
    expect(setup.beginTruckPick()).toBe(true)
    const required = setup.requiredFullTrucks ?? 0
    for (const truck of setup.setupTrucks.slice(0, required)) {
      expect(setup.pickTruckAtHex(truckHex(workbench, truck.instanceId))).toBe(true)
    }
    // 13.2h：满载＝载 1 SP ⇒ 盘面上的 `loadedSpT` 已写（1 SP = loadedSpT>0）
    expect(setup.truckLoadSummary.done).toBe(true)
    for (const truck of setup.setupTrucks.slice(0, required)) {
      const unit = workbench.units.find((item) => item.instanceId === truck.instanceId)
      expect(unit?.loadedSpT ?? 0).toBeGreaterThan(0)
    }
  })

  it('点空格 ⇒ 被点选消费（不开常规小窗），并记下"那不是卡车格"', () => {
    const { setup } = stores
    setup.selectScenario('3')
    expect(setup.beginTruckPick()).toBe(true)
    const occupied = new Set(setup.truckPickHexes.map((hex) => `${hex.col}.${hex.row}`))
    const empty: HexRef = { col: 1, row: 1 }
    expect(occupied.has(`${empty.col}.${empty.row}`)).toBe(false)
    expect(setup.pickTruckAtHex(empty)).toBe(true)
    // `record()` 把失败原因写进 `detail`（界面回显那一栏）
    expect(setup.lastAction?.ok).toBe(false)
    expect(setup.lastAction?.detail).toContain('notATruckHex')
  })

  it('源码守卫：卡片上的勾选框与"核验"按钮已去掉，地图侧接上点选', () => {
    const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    expect(queue).not.toContain('核验卡车装载')
    expect(queue).not.toContain('setup.toggleTruckFull(')
    expect(queue).toContain('setup.beginTruckPick()')
    const view = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(view).toContain('setup.pickTruckAtHex(hex)')
    expect(view).toContain('setup.truckPickHexes')
  })
})
