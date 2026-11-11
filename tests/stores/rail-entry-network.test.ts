import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 铁路网归属（专规 2.1 / 3.1；用户 2026-11-11 裁定）
 *
 *   · 可放置铁路格＝**从本方进场铁路出发、按连通性可达的那张网**，不是全图铁路；
 *   · 不存在交叉可用 / 共用段：原文没有「转换规矩」的铁路，整段自然归其中一方；
 *   · 多轨与单轨只差 13.3c 的运量费用，不参与归属；
 *   · 补给列车（3.6）是德军事件 ⇒ 只取德军那张网。
 */
const label = (hex: HexRef): string => `${hex.col}.${hex.row}`
const labels = (hexes: readonly HexRef[]): string[] => hexes.map(label).sort()

function boot(): ReturnType<typeof useWorkbenchStore> {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  store.setScenarioId('1')
  store.seedConvertedRailsNow()
  return store
}

/** 在 2.2（剧本 1 轴军可用铁路的城格）摆一个轴方战斗单位，让 13.3c 控制判据成立 */
function holdAxisCity(store: ReturnType<typeof useWorkbenchStore>): HexRef {
  const record = unitChoices('axis').find(
    (item) => item.isCombat === true && item.attackCapable === true,
  )
  if (record === undefined) throw new Error('轴方单位库里没有战斗单位')
  const hex = { col: 2, row: 2 }
  store.units.push(
    toConsoleUnit({ record, instanceId: 'rail-hold', hex: { ...hex }, side: 'axis' }),
  )
  return hex
}

describe('进场铁路网：种子与两网分离', () => {
  it('种子＝本方字母入场段 ∩ 铁路 ∩ 当日开放（不是任意声明格）', () => {
    const store = boot()
    // 1.3 / 1.7 / 1.19 / 8.0 是轴方 K–F 字母入场段里的铁路格；
    // 4.0 虽在旧 live 清单里，但不在 K–F 段内，按 2026-11-11 裁定不再算图边；
    // 轨距不可用者（8.0）在 BFS 第一步被 13.3f 拦下，但仍属"进场铁路"种子清单。
    expect(labels(store.entryRailSeedsBySide.axis)).toEqual(['1.19', '1.3', '1.7', '8.0'])
    expect(store.entryRailSeedsBySide.soviet.length).toBeGreaterThan(0)
    const axisNet = new Set(labels(store.railSupplyBySide.axis.railReachableHexes))
    expect(axisNet.has('1.3')).toBe(true)
    const sovietNet = new Set(labels(store.railSupplyBySide.soviet.railReachableHexes))
    for (const seed of store.entryRailSeedsBySide.soviet)
      expect(sovietNet.has(label(seed))).toBe(true)
  })

  it('★ 手工声明一条边缘铁路也不能给本方"造"出一张网（取消共用/交叉概念）', () => {
    const store = boot()
    // 56.20（Vyazma）在苏军网深处：旧实现会把它当德军种子，顺势把苏军铁路喂给德军
    store.supplySourceDecls.push({
      id: 'fake-axis-entry',
      hex: { col: 56, row: 20 },
      side: 'axis',
      kind: 'edgeRail',
    })
    expect(labels(store.entryRailSeedsBySide.axis)).not.toContain('56.20')
    expect(labels(store.railSupplyBySide.axis.railReachableHexes)).not.toContain('56.20')
  })

  it('两网互不冒充：交集为空（无共用段）', () => {
    const store = boot()
    const axisNet = new Set(labels(store.railSupplyBySide.axis.railReachableHexes))
    const shared = labels(store.railSupplyBySide.soviet.railReachableHexes).filter((hex) =>
      axisNet.has(hex),
    )
    expect(shared).toEqual([])
  })

  it('2.1a：关停日期过后，已关闭的进场铁路不再作种子（Entry L = 20.35）', () => {
    const store = boot()
    const beforeAxis = labels(store.entryRailSeedsBySide.axis)
    const beforeSoviet = labels(store.entryRailSeedsBySide.soviet)
    // 剧本 1 开局 8 Jul：Entry L（20.35）仍在
    expect(beforeSoviet).toContain('20.35')
    store.setTurn(20)
    expect(store.date >= '1941-08-19').toBe(true)
    const afterSoviet = labels(store.entryRailSeedsBySide.soviet)
    expect(afterSoviet).not.toContain('20.35')
    expect(afterSoviet.every((hex) => beforeSoviet.includes(hex))).toBe(true)
    // 本剧本的德军 live 清单没有「南缘 + E 以西」的铁路源（1.3 / 1.7 / 1.19 / 4.0 / 8.0 都不是南缘）
    expect(labels(store.entryRailSeedsBySide.axis)).toEqual(beforeAxis)
  })
})

describe('3.6 补给列车：只取德军那张网', () => {
  it('★ 当前视角是苏军时，候选仍取德军网（不用苏军铁路冒充）', () => {
    const store = boot()
    const city = holdAxisCity(store)
    expect(labels(store.railSupplyBySide.axis.railReachableHexes)).toContain(label(city))
    expect(labels(store.railSupplyBySide.soviet.railReachableHexes)).not.toContain(label(city))

    expect(labels(store.supplyTrainPlacementHexes)).toEqual([label(city)])

    store.setActiveSide('soviet')
    expect(labels(store.supplyTrainPlacementHexes)).toEqual([label(city)])
    // 落点入口也拒绝非德军视角（3.6 是德军事件）
    expect(store.placeSupplyTrainSpNow(city)).toBe(false)
  })
})
