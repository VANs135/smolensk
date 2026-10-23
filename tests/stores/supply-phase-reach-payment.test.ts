import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { holdingsToT } from '@/engine/rules'
import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, combatRecord, placeGround } from '../flows/sop-harness'

/**
 * 第五批 B3（docs/第五批修改方案.md 族 B3）：D 段的扣款按 **12.3a/12.3b 可达性**收口
 *
 * 病灶：`supplyPhaseAvailableCap`＝己方**全部**补给站的 T 合计（"全边池"），
 * `payFromSideDumps` 按站序从**全边**扣 ⇒ 前线单位恢复/喂食的 T 可以从千里之外的站扣
 * （SP 隔空转移）；站与该单位之间的拖取/投递可达性一概不问。
 *
 * 原文：
 *   · 12.10e「如果有了可用的 SP（**可通过直接拖取或从指挥部投递**），则要将……部队储备进行恢复」
 *     （txt:2111-2113）；12.10e-B「只要是低下或耗尽单位**可拖取，或可投递 SP 至这些单位**的补给站，
 *     均需要按规则去恢复」（txt:2124-2125）；12.10e-C「现有一些 SP，但不足以完全恢复……则消耗**现有的
 *     全部**补给。只有一个 T，则将直接被浪费掉」（txt:2128-2130）；
 *   · 12.6c 喂食同样「直接拖取和指挥部投递均可用于追溯补给的接收与分配」（12.3 重要提示 txt:1785-1788）。
 *
 * ★ 测法边界（如实）：夹具用**远站＋近站**两枚（远站按格距 ≥12 粗筛 ⇒ 轮式 5MP 不可达、图上有无 HQ 也不会有
 *   投递支）；远站在 `spDumps` 数组里**排在前面**（修前 `payFromSideDumps` 按数组序扣 ⇒ 必先中招）。
 *   单单位场景 ⇒ 并集池＝该单位可达集，断言是确定性的；**多单位共享同一站**的 overlap 边界
 *   （各自独立计池可能过订）在回执里如实登记，不在此用例范围。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 距 CORE_HEX 格距 ≥ 12 的图内格（轮式 5MP 一定够不着；也不受图边缘削角影响不了它） */
const FAR_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const grid = Math.max(Math.abs(hex.col - CORE_HEX.col), Math.abs(hex.row - CORE_HEX.row))
    return grid >= 12
  })
  if (found === undefined) throw new Error('地图上找不到距 CORE_HEX ≥12 格的格')
  return { col: found.col, row: found.row }
})()

/** 摆一枚战斗单位并取其**响应式代理**（直接改外面那个裸对象不触发 computed 失效） */
function placeCombat(store: ReturnType<typeof newStore>, id: string) {
  placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', id)
  const unit = store.units.find((item) => item.instanceId === id)
  if (unit === undefined) throw new Error(`单位 ${id} 不在盘面上`)
  return unit
}

const tonsOf = (store: ReturnType<typeof newStore>, id: string): number => {
  const dump = store.spDumps.find((item) => item.id === id)
  if (dump === undefined) throw new Error(`补给站 ${id} 不存在`)
  return holdingsToT({ sp: dump.sp, t: dump.t })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('第五批 B3：12.10e/12.6c 的 D 段扣款只走**该单位可达站**（12.3a/12.3b）', () => {
  it('12.10e-C：可达站只有 1T ⇒ 消耗那 1T（浪费）、单位仍 unmet；远站分文不动', () => {
    const store = newStore()
    store.setPhase('supply')
    const unit = placeCombat(store, 'u1')
    unit.internalStocks = 'low' // 恢复价 2T
    // 远站在数组序**前面**（修前按序扣款必先扣到它）
    store.spDumps.push({ id: 'far', hex: { ...FAR_HEX }, side: 'axis', sp: 4, t: 0 }) // 16T
    store.spDumps.push({ id: 'near', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 1 }) // 1T
    expect(store.planSupplyPhaseNow()).toBe(true)
    const recovery = store.supplyPhasePlan!.internalStocks
    // 12.10e-C：可得的 1T 不足以恢复 ⇒ 花光它（浪费）且单位 unmet
    expect(recovery.unmet).toEqual(['u1'])
    expect(recovery.spentT).toBe(1)
    expect(recovery.wastedT).toBe(1)

    expect(store.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(unit.internalStocks).toBe('low') // 未恢复
    expect(tonsOf(store, 'near')).toBe(0) // 那 1T 被浪费
    expect(tonsOf(store, 'far')).toBe(16) // 千里之外站**不动**（修前会被隔空扣 2T）
  })

  it('可达站充足 ⇒ 恢复成功且只扣近站；远站分文不动', () => {
    const store = newStore()
    store.setPhase('supply')
    const unit = placeCombat(store, 'u1')
    unit.internalStocks = 'low'
    store.spDumps.push({ id: 'far', hex: { ...FAR_HEX }, side: 'axis', sp: 4, t: 0 }) // 16T
    store.spDumps.push({ id: 'near', hex: { ...CORE_HEX }, side: 'axis', sp: 1, t: 0 }) // 4T
    expect(store.planSupplyPhaseNow()).toBe(true)
    expect(store.supplyPhasePlan!.internalStocks.recoveries.map((item) => item.unitId)).toEqual([
      'u1',
    ])

    expect(store.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(unit.internalStocks).toBe(null) // 恢复到 ready
    expect(tonsOf(store, 'near')).toBe(2) // 4T − 2T
    expect(tonsOf(store, 'far')).toBe(16) // 远站不动（修前按数组序被扣 2T）
  })

  it('12.6c 喂食同理：可达站不够 ⇒ 不喂、不扣、仍断补；远站分文不动', () => {
    const store = newStore()
    store.setPhase('supply')
    const unit = placeCombat(store, 'u1')
    unit.re = 6 // 喂食价 = ceil(6/2) = 3T
    store.spDumps.push({ id: 'far', hex: { ...FAR_HEX }, side: 'axis', sp: 4, t: 0 }) // 16T
    store.spDumps.push({ id: 'near', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 1 }) // 1T
    store.supplyPhaseInputs = {
      availableT: 0,
      eatOffTheMap: { [unit.instanceId]: true },
    }
    expect(store.planSupplyPhaseNow()).toBe(true)
    // 可达站只有 1T < 3T ⇒ 付不起（修前并集池 17T ⇒ affordable=true）
    expect(store.supplyPhasePlan!.feeding[0]?.affordable).toBe(false)

    expect(store.applySupplyPhaseFeedingNow()).toBe(true)
    expect(unit.hasTraceSupply).toBe(false) // 仍断补
    expect(tonsOf(store, 'near')).toBe(1) // 不喂不扣
    expect(tonsOf(store, 'far')).toBe(16) // 远站不动（修前被扣 3T）
    expect(store.log.some((entry) => (entry.text ?? '').includes('因 T 不足未喂'))).toBe(true)
  })
})
