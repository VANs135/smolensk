import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSetupStore, useWorkbenchStore, type SetupPlacing } from '@/stores'

/**
 * P4 / UI1-b：**已完成项**的只读投影（初设队列第三组）
 *
 * 用户口径（计划 §4.3）：「初设按『必做事项、可自主放弃项、已完成项』分组；
 * 完成数来自**实际名单和盘面**，**不新增 UI 完成标记**」。
 *
 * 本文件钉住：
 *   ① `completedPlacements` 只从既有事实（`completed` 台账 / 盘上算子）投影，读它不改盘面；
 *   ② 一条 self 项**落满**后真的收进投影，字段与队列条目同源（key / side / label / placed / total / imageUrl）；
 *   ③ 已完成与待落位**互斥**（同一条目不会同时出现在两处）。
 *
 * 测法边界（如实）：按剧本 1 真实夹具跑；`selectScenario` 会连带跑自动初设与 ch10 抽签，
 * 抽签已自动摆位的西移师按"盘面既成事实"也会进已完成组 ⇒ 初始断言取"不含待落位项"，不断言空数组。
 */
const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

/** 由待落位条目推出"若它完成，投影里的 key"（仅用于互斥断言） */
const keyOf = (item: SetupPlacing): string =>
  item.kind === 'shift'
    ? `shift:${item.formationId ?? ''}`
    : item.kind === 'air'
      ? `air:${item.side}:${item.entryIndex}`
      : `self:${item.entryIndex}`

describe('P4 UI1-b：已完成项只读投影（`setup.completedPlacements`）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    stores.setup.selectScenario('1')
  })

  it('★ 初始：已完成项不含任何待落位项（两组互斥），且未落位的 self 项不在已完成里', () => {
    const { setup } = stores
    const pendingKeys = new Set(setup.pendingPlacement.map(keyOf))
    for (const done of setup.completedPlacements) {
      expect(pendingKeys.has(done.key), `${done.key} 同时出现在已完成与待落位`).toBe(false)
    }
    // 反空转的一半：待落位的 self 条目一条都不许提前混进已完成
    const unplacedSelfKeys = setup.pendingPlacement
      .filter((item) => item.kind === 'self')
      .map((item) => `self:${item.entryIndex}`)
    expect(unplacedSelfKeys.length).toBeGreaterThan(0)
    for (const key of unplacedSelfKeys) {
      expect(setup.completedPlacements.some((done) => done.key === key)).toBe(false)
    }
  })

  it('★ 只读语义：连续读取内容一致，且不改盘面 / 不改待落位清单', () => {
    const { setup, workbench } = stores
    const units = workbench.units.length
    const airUnits = workbench.airUnits.length
    const pending = JSON.stringify(setup.pendingPlacement)
    const first = JSON.stringify(setup.completedPlacements)
    // 读两次（中间不带任何动作）⇒ 内容完全一致
    expect(JSON.stringify(setup.completedPlacements)).toBe(first)
    expect(JSON.stringify(setup.pendingPlacement)).toBe(pending)
    expect(workbench.units.length).toBe(units)
    expect(workbench.airUnits.length).toBe(airUnits)
  })

  it('★ 一条 self 项落满 ⇒ 收进已完成：key 以 self: 开头，方/名/进度/图档与队列条目一致', () => {
    const { setup } = stores
    const all = setup.decisionQueue.flatMap((stack) => stack.items)
    // 优先挑"一次就落满"的项（多枚项另有既有逐枚用例，本用例只要"落满即完成"）
    const item =
      all.find(
        (entry) => entry.kind === 'self' && entry.candidates.length > 0 && entry.total === 1,
      ) ?? all.find((entry) => entry.kind === 'self' && entry.candidates.length > 0)
    expect(item, '剧本 1 应有可落位的 self 条目').toBeDefined()

    expect(setup.beginSelfPlacement(item!.entryIndex)).toBe(true)
    let guard = 0
    while (setup.placing !== null && guard < item!.total + 2) {
      const candidates = setup.placing.candidates
      expect(candidates.length).toBeGreaterThan(0)
      // 逐枚落在不同候选格（多枚项也不撞同一格的堆叠上限）
      expect(setup.placeAtHex(candidates[guard % candidates.length]!)).toBe(true)
      guard += 1
    }
    expect(setup.placing, '落满即收卡片').toBeNull()

    const done = setup.completedPlacements.find((row) => row.key === `self:${item!.entryIndex}`)
    expect(done, '落满的 self 条目应出现在 completedPlacements').toBeDefined()
    expect(done!.key.startsWith('self:')).toBe(true)
    expect(done!.kind).toBe('self')
    expect(done!.side).toBe(item!.side)
    expect(done!.label).toBe(item!.label)
    expect(done!.placed).toBe(item!.total)
    expect(done!.total).toBe(item!.total)
    expect(done!.imageUrl).toBe(item!.imageUrl)
    expect(done!.category).toBe(item!.category)

    // 已完成与待落位互斥：它已不在 pendingPlacement
    expect(
      setup.pendingPlacement.some(
        (row) => row.kind === 'self' && row.entryIndex === item!.entryIndex,
      ),
    ).toBe(false)
    expect(
      setup.completedPlacements.filter((row) => row.key === `self:${item!.entryIndex}`),
    ).toHaveLength(1)
  })
})
