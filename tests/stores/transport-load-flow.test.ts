import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 13.2f：运输点数的**装载 / 卸载 SP**（store 级）
 *
 * 条文：
 *   · 「运输点数在一个格内装载/卸载任意数量的 SP 时，需支付它**印刷 MA 的 10%**（45MA 的卡车 ⇒ 5MP）。」
 *   · 「运输点数必须与**补给站**位于同一格中才能装载 SP」「运输点数可在**任何格**内装载」。
 *   · 「卸载只能在包含**友方战斗单位、港口、空军基地或已经有已卸载的补给站**的格内。」
 *   · **13.2g-A**：编内卡车**永远无法**在地图上卸载它们的 SP。
 *
 * ★ 修前 `validateTransportPointLoad` / `validateTransportPointUnload` **零消费**，
 *   而且「运输点装着多少 SP」**根本没有状态**（`specialObjectsAt` 里 `loadedSpT` 恒写 0）
 *   ⇒ 9.14 的夺取表从运输点算子上夺取到的 SP 恒为 0，13.6c 的「到货满载 SP」也只是一句提示。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

const HEX = { col: 15, row: 10 }

/** 摆一个**运输点数**算子（13.2：本作单位库里的 `transport_point`）；13.2g 的编内卡车只有轴方有 */
function placeTransportPoint(
  store: Workbench,
  instanceId = 'tp-1',
  organic = false,
  side: 'axis' | 'soviet' = 'soviet',
) {
  const record = groundRecord(side, (item) =>
    organic ? item.noncombatKind === 'organic_truck' : item.noncombatKind === 'transport_point',
  )
  const unit = placeGround(store, record, HEX, side, instanceId)
  return unit
}
/** 12.1b：在该格放一座己方补给站 */
function dumpHere(store: Workbench, sp = 4) {
  store.spDumps.push({ id: 'd1', hex: { ...HEX }, side: 'soviet', sp, t: 0 })
  return store.spDumps[0]!
}

describe('13.2f：装载 SP', () => {
  it('同格有补给站 ⇒ 装载成功：站上扣 SP、点数记「已载」、支付印刷 MA 的 10% MP', () => {
    const store = newStore()
    const point = placeTransportPoint(store)
    const dump = dumpHere(store, 4)
    store.transportLoadInputs = { pointId: point.instanceId, amount: 2 }
    const printedMa = point.raw.ma
    expect(printedMa).toBeGreaterThan(0)

    expect(store.loadTransportPointNow()).toBe(true)
    // 站上少了 2 SP（8 T）
    const after = store.spDumps.find((item) => item.id === dump.id)!
    expect(after.sp + after.t / 4).toBe(2)
    // 点数上记了 2 SP
    expect(point.loadedSpT).toBe(8)
    // 13.2f：支付印刷 MA 的 10%（按 6.1a 计入本阶段已耗 MP）
    const expected = Math.max(0, Math.ceil(printedMa * 0.1 - 0.0001))
    expect(point.mpSpent).toBe(expected)
    expect(store.transportLoadError).toBeNull()
  })

  it('同格**没有**补给站 ⇒ 拒（13.2f：装载要求与补给站同格）', () => {
    const store = newStore()
    const point = placeTransportPoint(store)
    store.transportLoadInputs = { pointId: point.instanceId, amount: 1 }
    expect(store.loadTransportPointNow()).toBe(false)
    expect(store.transportLoadError).toMatchObject({
      rule: '13.2f',
      reason: 'loadRequiresDumpInHex',
    })
    expect(point.loadedSpT).toBe(0)
    expect(point.mpSpent).toBe(0)
  })

  it('站上的 SP 不够 ⇒ 拒，且账本与点数都不动', () => {
    const store = newStore()
    const point = placeTransportPoint(store)
    const dump = dumpHere(store, 1)
    store.transportLoadInputs = { pointId: point.instanceId, amount: 3 }
    expect(store.loadTransportPointNow()).toBe(false)
    expect(store.transportLoadError?.reason).toBe('loadNotPayable')
    expect(store.spDumps.find((item) => item.id === dump.id)!.sp).toBe(1)
    expect(point.loadedSpT).toBe(0)
  })
})

describe('13.2f / 13.2g：卸载 SP', () => {
  it('格内有**友方战斗单位** ⇒ 卸载成功：点数减载、该格出现补给站账本', () => {
    const store = newStore()
    const point = placeTransportPoint(store)
    dumpHere(store, 4)
    store.transportLoadInputs = { pointId: point.instanceId, amount: 2 }
    expect(store.loadTransportPointNow()).toBe(true)

    // 换个格：格内放一名友方战斗单位 ⇒ 满足 13.2f 的卸载条件
    point.hex = { col: 15, row: 11 }
    const guardRecord = groundRecord('soviet', (item) => item.isCombat === true)
    placeGround(store, guardRecord, point.hex, 'soviet', 'guard-1')
    point.mpSpent = 0
    expect(store.unloadTransportPointNow()).toBe(true)
    expect(point.loadedSpT).toBe(0)
    // 卸载的 SP 落在该格
    const landed = store.spDumps.find(
      (item) => item.side === 'soviet' && item.hex.col === 15 && item.hex.row === 11,
    )
    expect(landed).not.toBeUndefined()
    expect(landed!.sp + landed!.t / 4).toBe(2)
    // 同样支付印刷 MA 的 10%
    const expected = Math.max(0, Math.ceil(point.raw.ma * 0.1 - 0.0001))
    expect(point.mpSpent).toBe(expected)
  })

  it('格内什么都不满足 ⇒ 拒（13.2f 的卸载条件）', () => {
    const store = newStore()
    const point = placeTransportPoint(store)
    dumpHere(store, 4)
    store.transportLoadInputs = { pointId: point.instanceId, amount: 1 }
    expect(store.loadTransportPointNow()).toBe(true)

    // 挪到一个空格的格（无友军、无港口/基地、无已卸载的站）
    point.hex = { col: 15, row: 13 }
    point.mpSpent = 0
    expect(store.unloadTransportPointNow()).toBe(false)
    expect(store.transportLoadError).toMatchObject({
      rule: '13.2f',
      reason: 'unloadRequirementsNotMet',
    })
    expect(point.loadedSpT).toBe(4)
  })

  it('13.2g-A：编内卡车永远不能在地图上卸载（即使格内条件都满足）', () => {
    // 编内卡车（`organic_truck`）在本作单位库里只有**轴方**有
    const store = newStore()
    const organic = placeTransportPoint(store, 'ot-1', true, 'axis')
    store.spDumps.push({ id: 'd-ax', hex: { ...HEX }, side: 'axis', sp: 4, t: 0 })
    store.transportLoadInputs = { pointId: organic.instanceId, amount: 1 }
    expect(store.loadTransportPointNow()).toBe(true)
    // 格内放友方战斗单位使 13.2f 的卸载条件成立
    const guardRecord = groundRecord('axis', (item) => item.isCombat === true)
    placeGround(store, guardRecord, HEX, 'axis', 'guard-1')
    organic.mpSpent = 0
    expect(store.unloadTransportPointNow()).toBe(false)
    expect(store.transportLoadError).toMatchObject({
      rule: '13.2g',
      reason: expect.stringContaining('organicTruckCannotUnload'),
    })
    expect(organic.loadedSpT).toBe(4)
  })

  it('卸得比载的多 ⇒ 拒', () => {
    const store = newStore()
    const point = placeTransportPoint(store)
    dumpHere(store, 4)
    store.transportLoadInputs = { pointId: point.instanceId, amount: 1 }
    expect(store.loadTransportPointNow()).toBe(true)
    const guardRecord = groundRecord('soviet', (item) => item.isCombat === true)
    placeGround(store, guardRecord, HEX, 'soviet', 'guard-1')
    store.transportLoadInputs = { pointId: point.instanceId, amount: 3 }
    expect(store.unloadTransportPointNow()).toBe(false)
    expect(store.transportLoadError?.reason.startsWith('unloadExceedsLoaded')).toBe(true)
  })
})

describe('13.2f：载量进入 9.14 的夺取事实', () => {
  it('`specialObjectsAt` 里的运输点带上**真实载量**（修前恒为 0）', () => {
    const store = newStore()
    const point = placeTransportPoint(store)
    dumpHere(store, 4)
    store.transportLoadInputs = { pointId: point.instanceId, amount: 2 }
    expect(store.loadTransportPointNow()).toBe(true)

    const objects = store.specialObjectsAt(HEX)
    const view = objects.find((item) => item.id === point.instanceId)
    expect(view).not.toBeUndefined()
    expect(view!.kind).toBe('transport')
    expect(view!.loadedSpT).toBe(8)
  })
})
