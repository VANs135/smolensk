import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import { SP_TO_T } from '@/engine/rules'
import { useMapViewStore, useSetupStore, useWorkbenchStore, type SetupPlacing } from '@/stores'

/**
 * B11：初设**决策队列**（待你决定 · 四堆叠）与**逐枚落位**
 *
 * 用户口径⑨：「地图左上角的框（地面 / 非战斗 / 飞机 / 卡车各一堆叠，点开可多选）→ 选中单位时高亮可放格 →
 * 点地图格**落一个**（**同型多枚时逐个落**，数量角标递减到 0 才关卡片）」；
 * 卡车：「卡片上直接选「满载 1F / 空载 1」（13.2h），落子即记 `loadedSpT`」。
 *
 * 备忘两条（本批修）：
 *   · **#1** 放飞机后数量不减 + 报「调用方未提供 airBaseHexes」；
 *   · **#2** 同种单位多个会**一起**放进地图，不能分开放不同格。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

/** 决策队列里某一堆 */
const stackOf = (
  queue: readonly { key: string; count: number; items: readonly SetupPlacing[] }[],
  key: string,
) => queue.find((stack) => stack.key === key)!

describe('B11：初设落位的**地图点击**通路（用户 2026-09-16 报告：点高亮格无反应）', () => {
  /**
   * 为什么单开一组：原来所有用例都直接调 `setup.placeAtHex(hex)`（store 动作），
   * **没有一条走地图的点击分派**（`mapView.onHexClick`）——于是 B18a/B24 那道手势闸门把
   * 地图上的指针事件整段吞掉时（用户报告：地图拖不动、点高亮格无反应），全套用例照样全绿。
   * 本组按**用户实际路径**走一遍：队列里点一项开始落位 → 点地图高亮格 → 算子真的上盘。
   */
  it('★ 开始落位后**经地图点击**（`onHexClick`）⇒ 算子真的落到那一格，且落满即收卡片', () => {
    setActivePinia(createPinia())
    const setup = useSetupStore()
    const workbench = useWorkbenchStore()
    const mapView = useMapViewStore()
    setup.selectScenario('1')

    // 地面堆里找一条"自选格"的初设项（有候选格的那种）
    const ground = stackOf(setup.decisionQueue, 'ground')
    const item = ground.items.find((entry) => entry.kind === 'self')
    expect(item).toBeDefined()
    expect(setup.beginSelfPlacement(item!.entryIndex)).toBe(true)

    const placing = setup.placing
    expect(placing).not.toBeNull()
    const before = workbench.units.length
    const hex = placing!.candidates[0]!
    // 地图点击的唯一入口（视图层的 pointerup 最终调的就是它）
    mapView.onHexClick(hex)

    expect(workbench.units.length).toBe(before + 1)
    const placed = workbench.units[workbench.units.length - 1]!
    expect(`${placed.hex.col}.${placed.hex.row}`).toBe(`${hex.col}.${hex.row}`)
  })

  it('★ 候选格之外的点仍交回常规分派（不会被初设静默吃掉）', () => {
    setActivePinia(createPinia())
    const setup = useSetupStore()
    const workbench = useWorkbenchStore()
    const mapView = useMapViewStore()
    setup.selectScenario('1')
    const ground = stackOf(setup.decisionQueue, 'ground')
    const item = ground.items.find((entry) => entry.kind === 'self')!
    expect(setup.beginSelfPlacement(item.entryIndex)).toBe(true)

    const placing = setup.placing!
    const candidates = new Set(placing.candidates.map((hex) => `${hex.col}.${hex.row}`))
    const mapLayersHex = mapLayers.hexes.find((hex) => !candidates.has(`${hex.col}.${hex.row}`))
    expect(mapLayersHex).toBeDefined()
    const before = workbench.units.length
    mapView.onHexClick({ col: mapLayersHex!.col, row: mapLayersHex!.row })
    // 没落在候选格 ⇒ 不落子（并给一行"不是候选格"的记要），落位态保持
    expect(workbench.units.length).toBe(before)
    expect(setup.placing).not.toBeNull()
  })
})

describe('B11：决策队列的四堆叠', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    stores.setup.selectScenario('1')
  })

  it('按 地面 / 非战斗 / 飞机 / 卡车 分成四堆，且每堆的枚数是"还剩几枚"之和', () => {
    const queue = stores.setup.decisionQueue
    expect(queue.map((stack) => stack.key)).toEqual(['ground', 'supply', 'air', 'truck'])

    for (const stack of queue) {
      const expected = stack.items.reduce((total, item) => total + item.remaining, 0)
      expect(stack.count, `${stack.key} 的枚数与卡片之和不一致`).toBe(expected)
    }
    // 反空转：剧本 1 的这四堆都不是空的（地面/非战斗/飞机必有；卡车按剧本页）
    expect(stackOf(queue, 'ground').items.length).toBeGreaterThan(0)
    expect(stackOf(queue, 'supply').items.length).toBeGreaterThan(0)
    expect(stackOf(queue, 'air').items.length).toBeGreaterThan(0)
  })

  it('每张卡片都带 total / placed / remaining（界面据此画数量角标，不自己算）', () => {
    for (const stack of stores.setup.decisionQueue) {
      for (const item of stack.items) {
        expect(item.total).toBeGreaterThan(0)
        expect(item.placed).toBeGreaterThanOrEqual(0)
        expect(item.placed + item.remaining).toBe(item.total)
      }
    }
  })

  it('基地已在图上 ⇒ 飞机卡片不被阻塞；**基地不在图上** ⇒ 给出"先落空军基地"的原因（备忘 #1）', () => {
    const { setup, workbench } = stores
    const airItems = stackOf(setup.decisionQueue, 'air').items
    expect(airItems.every((item) => item.blockedReason === null)).toBe(true)

    // 把苏方空军基地从盘上撤掉（模拟"基地这一项还没落位"）
    workbench.units = workbench.units.filter(
      (unit) => !(unit.side === 'soviet' && unit.noncombatKind === 'air_base'),
    )
    const sovietAir = stackOf(setup.decisionQueue, 'air').items.filter(
      (item) => item.side === 'soviet',
    )
    expect(sovietAir.length).toBeGreaterThan(0)
    expect(sovietAir.every((item) => item.blockedReason?.includes('先落本方空军基地'))).toBe(true)
    // 轴心国的基地还在 ⇒ 轴心国的飞机不受影响
    const axisAir = stackOf(setup.decisionQueue, 'air').items.filter((item) => item.side === 'axis')
    expect(axisAir.every((item) => item.blockedReason === null)).toBe(true)
  })
})

describe('B11：逐枚落位（备忘 #2：同型多枚可分放不同格）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    stores.setup.selectScenario('1')
  })

  it('★ 同型多枚：一次点一格只落**一枚**，落满才关卡片（可落在不同格）', () => {
    const { setup, workbench } = stores
    // 找一条"棋子类且 count>1"的自由项（如「2x 26-1-1 Arty Bde」）
    // ★ 第六批条 26（S4）：SP 现在也以实际量计（total>1），故用 category 排除计数类
    const multi = setup.decisionQueue
      .flatMap((stack) => stack.items)
      .find((item) => item.kind === 'self' && item.category === 'ground' && item.total > 1)
    expect(multi, '剧本 1 应有同型多枚的棋子类自由项').toBeDefined()
    const entryIndex = multi!.entryIndex
    const total = multi!.total
    const candidates = multi!.candidates
    expect(candidates.length).toBeGreaterThanOrEqual(2)

    const before = workbench.units.length
    // 第一枚：落在候选格 A
    expect(setup.beginSelfPlacement(entryIndex)).toBe(true)
    expect(setup.placeAtHex(candidates[0]!)).toBe(true)
    expect(workbench.units.length).toBe(before + 1)
    // 卡片还开着（进度 1/total），不是"整条落完"
    expect(setup.placing?.remaining).toBe(total - 1)
    expect(setup.placing?.placed).toBe(1)

    // 其余枚：落在候选格 B（**不同格**——这正是备忘 #2 要的）
    const secondHex = candidates.find(
      (hex) => hex.col !== candidates[0]!.col || hex.row !== candidates[0]!.row,
    )!
    expect(setup.placeAtHex(secondHex)).toBe(true)
    expect(workbench.units.length).toBe(before + total)

    // 落满 ⇒ 卡片关闭，且该项从队列里消失
    expect(setup.placing).toBeNull()
    const stillPending = setup.decisionQueue
      .flatMap((stack) => stack.items)
      .some((item) => item.kind === 'self' && item.entryIndex === entryIndex)
    expect(stillPending).toBe(false)

    // 两枚确实落在**不同格**
    const placedUnits = workbench.units.slice(before)
    expect(placedUnits).toHaveLength(total)
    const hexKeys = new Set(placedUnits.map((unit) => `${unit.hex.col}.${unit.hex.row}`))
    expect(hexKeys.size).toBe(2)
  })

  it('★ 计数类（SP）按量计：total＝实际 SP 量；默认一次点完（落 all remaining），账本正确', () => {
    const { setup } = stores
    const sp = setup.decisionQueue
      .flatMap((stack) => stack.items)
      .find((item) => item.kind === 'self' && item.raw.includes('SP'))!
    // 第六批条 26（S4）：SP 以**实际量**计，不再是写死的 1
    expect(sp.total).toBeGreaterThan(1)

    expect(setup.beginSelfPlacement(sp.entryIndex)).toBe(true)
    // 默认 chunk＝剩余量 ⇒ 一次点完
    expect(setup.placing?.chunk).toBe(sp.total)
    const target = sp.candidates[0]!
    expect(setup.placeAtHex(target)).toBe(true)
    expect(setup.placing).toBeNull()
    // 账本：该格同方有一条 dump，points ＝ 总量（面的拆分由 countersFor 做）
    const dump = setup.spDumps.find(
      (item) => item.hex.col === target.col && item.hex.row === target.row && item.side === sp.side,
    )
    expect(dump).toBeDefined()
    expect(dump?.points).toBe(sp.total)
  })
})

describe('B11：飞机逐枚落位（备忘 #1：放进机场后数量要减）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    stores.setup.selectScenario('1')
  })

  it('★ 一次点一格只落**一枚**飞机；落满才从队列消失', () => {
    const { setup, workbench } = stores
    const row = setup.decisionQueue
      .flatMap((stack) => stack.items)
      .find((item) => item.kind === 'air' && item.total > 1)
    expect(row, '剧本 1 应有 2 枚以上的机型').toBeDefined()
    const { entryIndex, side, total } = row!

    const airBefore = workbench.airUnits.length
    expect(setup.beginAirPlacement(side, entryIndex)).toBe(true)
    expect(setup.placeAtHex(row!.candidates[0]!)).toBe(true)

    expect(workbench.airUnits.length).toBe(airBefore + 1)
    // ★ 关键：数量**减了**（修前一次落满、或直接静默不动）
    expect(setup.placing?.placed).toBe(1)
    expect(setup.placing?.remaining).toBe(total - 1)
    const queueRow = setup.decisionQueue
      .flatMap((stack) => stack.items)
      .find((item) => item.kind === 'air' && item.entryIndex === entryIndex && item.side === side)!
    expect(queueRow.remaining).toBe(total - 1)

    // 再落一枚（可以落在别的基地格）⇒ 进度继续
    const other = row!.candidates.find(
      (hex) => hex.col !== row!.candidates[0]!.col || hex.row !== row!.candidates[0]!.row,
    )
    const hexToUse = other ?? row!.candidates[0]!
    expect(setup.placeAtHex(hexToUse)).toBe(true)
    expect(workbench.airUnits.length).toBe(airBefore + 2)
    if (total === 2) {
      expect(setup.placing).toBeNull()
      expect(
        setup.decisionQueue
          .flatMap((stack) => stack.items)
          .some((item) => item.kind === 'air' && item.entryIndex === entryIndex),
      ).toBe(false)
    }
  })

  it('基地不在图上时，开始放飞机就被拒且**原因指向 14.1a**（不再报"调用方未提供"）', () => {
    const { setup, workbench } = stores
    workbench.units = workbench.units.filter((unit) => unit.noncombatKind !== 'air_base')

    const airItem = setup.decisionQueue
      .flatMap((stack) => stack.items)
      .find((item) => item.kind === 'air')!
    const ok = setup.beginAirPlacement(airItem.side, airItem.entryIndex)
    expect(ok).toBe(false)
    expect(setup.lastAction?.ok).toBe(false)
    expect(setup.lastAction?.detail).toContain('先落本方空军基地')
  })
})

describe('B11：卡车装载决定（13.2h）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    stores.setup.selectScenario('1')
  })

  it('★ 只有 choose_loaded 才把卡车列进队列：剧本 1（脚本全满载）不列，剧本 3（自选 4 辆）才列', () => {
    const { setup } = stores
    const truckStack = stackOf(setup.decisionQueue, 'truck')
    const decisions = setup.truckDecisions
    expect(decisions.length).toBeGreaterThan(0)
    expect(setup.requiredFullTrucks).not.toBeNull()

    /*
     * B38（用户口径 #8：「初设时的编队卡车如果默认全满载则不需要玩家选择」）：
     * 剧本 1 明示"全部满载" ⇒ 脚本说了算，**不进队列**（原先一律列出，玩家被白问一遍）。
     */
    expect(setup.truckLoadMode).toBe('all_loaded')
    expect(truckStack.items).toEqual([])

    // 剧本 3：明示"玩家自选 4 辆满载" ⇒ 才把卡车列出来问
    setup.selectScenario('3')
    expect(setup.truckLoadMode).toBe('choose_loaded')
    const chosen = stackOf(setup.decisionQueue, 'truck')
    expect(chosen.items.length).toBeGreaterThan(0)
    expect(chosen.items.every((item) => item.kind === 'truck')).toBe(true)
  })

  it('勾选满载并核验 ⇒ `loadedSpT` 按 13.2h 记账（满载 1 SP / 空载 0），且**不足数即被拒**', () => {
    const { setup, workbench } = stores
    /*
     * B38：这条要的是"玩家自选"的剧本（choose_loaded）——全满载/全空载的剧本已由脚本决定、
     * 不问玩家（见上一条）。剧本 3 明示"自选 4 辆满载"。
     */
    setup.selectScenario('3')
    const required = setup.requiredFullTrucks
    expect(required).not.toBeNull()
    const trucks = setup.truckDecisions
    expect(required!).toBeGreaterThan(0)
    expect(trucks.every((item) => !item.full)).toBe(true)

    const loadedSpT = (instanceId: string): number =>
      workbench.units.find((item) => item.instanceId === instanceId)!.loadedSpT

    // 13.2h / 专规 Setup Note C：**恰好**剧本页要求的辆数满载才放行
    const fullOnes = trucks.slice(0, required!)
    const emptyOnes = trucks.slice(required!)
    for (const item of fullOnes) setup.toggleTruckFull(item.instanceId, true)
    expect(setup.designateTrucks()).toBe(true)

    // ★ 满载＝1 SP、空载＝0：**这笔账真的落到盘上了**（修前 `setupTrucks` 拿的是记录 id，
    //   `find` 永远找不到算子 ⇒ 满载标记一次都没写进 `loadedSpT`）
    for (const item of fullOnes) expect(loadedSpT(item.instanceId)).toBe(SP_TO_T)
    for (const item of emptyOnes) expect(loadedSpT(item.instanceId)).toBe(0)

    // 少一辆满载 ⇒ 引擎按剧本要求拒（核验真的在管事，不是个摆设）
    setup.toggleTruckFull(fullOnes[0]!.instanceId, false)
    expect(setup.designateTrucks()).toBe(false)
    expect(setup.lastAction?.ok).toBe(false)
  })
})
