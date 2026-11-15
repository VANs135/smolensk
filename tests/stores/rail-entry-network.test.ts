import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

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
  it('种子＝本侧图边补给源 ∩ 铁路 ∩ 当日开放（2.1/3.1 地理判据，不是字母段）', () => {
    const store = boot()
    // 轴（3.1：西于 10.xx 且有道路/铁路入图）：有铁路的源是 1.03 / 1.07 / 1.19 / 4.00 / 8.00。
    // ★ 4.0 没有字母，旧口径（字母入场段）把它排除；按 2.1/3.1 原文它是源，必须在种子里。
    // 轨距不可用者（8.0 为宽轨）在铁路供应 BFS 第一步被 13.3f 拦下，但仍属"进场铁路"种子清单。
    expect(labels(store.entryRailSeedsBySide.axis)).toEqual(['1.19', '1.3', '1.7', '4.0', '8.0'])
    // 苏（2.1：东于 12.xx 且有道路/铁路入图）：42.35 在北缘、col 42、有铁路入图，无字母也是源。
    expect(labels(store.entryRailSeedsBySide.soviet)).toContain('42.35')
    expect(store.entryRailSeedsBySide.soviet.length).toBeGreaterThan(0)
    // 地理判据本身：轴 col < 10、苏 col > 12
    for (const hex of store.entryRailSeedsBySide.axis) expect(hex.col).toBeLessThan(10)
    for (const hex of store.entryRailSeedsBySide.soviet) expect(hex.col).toBeGreaterThan(12)
    const axisNet = new Set(labels(store.railSupplyBySide.axis.railReachableHexes))
    expect(axisNet.has('1.3')).toBe(true)
    const sovietNet = new Set(labels(store.railSupplyBySide.soviet.railReachableHexes))
    for (const seed of store.entryRailSeedsBySide.soviet)
      expect(sovietNet.has(label(seed))).toBe(true)
  })

  /**
   * U18（2026-11-13）：东南支线 `36.24…42.35` 15 格
   *
   * 地图事实：这 15 格自成一条**印刷铁路分量**（与主网无铁路格边相连），
   * 北端 `42.35` 位于图边第 35 行且是苏方 2.1 补给源 ⇒ 它就是这条支线的入图端，
   * 支线应作为苏方进场铁路网的一部分可达。不是漏边，也不需要新增字母入口。
   */
  it('U18：东南 15 格从 42.35 入苏方网（独立印刷分量，不补边）', () => {
    const store = boot()
    const branch = [
      '36.24',
      '36.25',
      '37.26',
      '38.26',
      '39.27',
      '39.28',
      '40.28',
      '40.29',
      '40.30',
      '40.31',
      '41.32',
      '41.33',
      '42.33',
      '42.34',
      '42.35',
    ]
    expect(labels(store.entryRailSeedsBySide.soviet)).toContain('42.35')
    const sovietNet = new Set(labels(store.railSupplyBySide.soviet.railReachableHexes))
    for (const hex of branch) expect(sovietNet.has(hex), hex).toBe(true)
    // 南端 36.24 是印刷断头，再往西南没有铁路格（36.3 不是铁路格）
    expect(sovietNet.has('36.3')).toBe(false)
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

/**
 * 13.3e-1 / 13.6b：**入场格不是移动阶段的通用登车格**
 *
 * 原文 13.3e-1：「货物登车时，货物必须位于不在敌方 ZOC 内的一个**可火车卸货**的铁路格(13.3c)。
 *   通过铁路移动的单位必须处于移动模式……**如果增援和新的 SP 的抵达格包含一条铁路(13.6b)，
 *   则它们可以在‘地图外’登车。**」
 * ⇒ 「地图外登车」的主语是**增援与新 SP**（13.6b 同）。普通单位在移动阶段站在入场格上，
 *   仍须满足 13.3c 可卸货格；入场格本身不是登车格（用户 2026-11-13 裁定：读法乙不成立）。
 */
describe('13.6b：入场格登车只属增援/新 SP，不是移动阶段的通用登车权', () => {
  it('★ 剧本 5：普通轴方单位在 J=1.19（非可卸货格）移动阶段铁路运输 ⇒ 拒', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    store.setScenarioId('5')
    store.setTurn(10)
    store.seedConvertedRailsNow()
    store.setPhase('movement')

    const entry = { col: 1, row: 19 }
    // 前提：该格已换标准轨（轴方可用），但**不是** 13.3c 可卸货格
    expect(store.isRailGaugeUsableAt(entry, 'axis')).toBe(true)
    expect(
      store.railSupplyBySide.axis.detrainableHexes.some(
        (hex) => hex.col === entry.col && hex.row === entry.row,
      ),
    ).toBe(false)

    const record = groundRecord('axis', (item) => item.isCombat === true)
    const unit = placeGround(store, record, entry, 'axis', 'entry-entrain')
    unit.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
    unit.raw = unit.faces.move
    unit.mpSpent = 0
    store.selectedId = unit.instanceId
    store.railMoveInputs = { toHexText: '18.18', spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit'), store.railMoveError?.reason ?? '').toBe(false)
    expect(store.railMoveError?.reason ?? '').toContain('entrainHexNotDetrainable:1.19')
    expect(unit.hex).toEqual(entry)
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
