import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { holdingsToT } from '@/engine/rules'
import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, combatRecord, placeGround, sealTraceSupplyByZoc } from '../flows/sop-harness'

/**
 * A3 第十五批：12.6c「吃图上补给」的批量取整额度不能跨**付款来源**借用
 *
 * 条文（OCS v4.3 txt:1948-1952）：「每消耗 1T，就可以为最多 2RE 的战斗单位提供追溯补给
 * （前提是**单位在补给站的拖取或投递距离内**）。所有小数向上取整」。1T 是从某个补给站**实际消耗**
 * 的 SP；因此「本批已喂过多少 RE」的额度属于付过款的那一组补给站，不能让另一座站一分不扣
 * 却让第二个单位免于断补（12.6d）。仓库里的交互链已按同一补给站记账（`oosFedReByDump`），
 * D 段此前按**全阶段全局**累计 RE，形成跨来源的免费供养。
 *
 * 本文件用真实工作台的补给站、拖取网络与付款入口核对来源和去向，不靠手改库存数字代替付款。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/**
 * 距 CORE_HEX 格距 ≥12 的图内格：轮式 5MP 直拖不可达（12.3a），且盘面无 HQ ⇒ 无 12.3b 投递支
 *
 * ★ 该格的**断补**由 `sealTraceSupplyByZoc` 现场卡断（12.3d），不是靠地形死角：
 *   13.3c 派生的卸货格会自动成为 12.6a② 的源，光看"距离远"在本实现下喂不饱也断不了。
 *   纯"离路 5 轮式 MP 之外"的构造暂时不可用——追溯补给缺 5MP 上限的缺陷已单独登记。
 */
const FAR_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const grid = Math.max(Math.abs(hex.col - CORE_HEX.col), Math.abs(hex.row - CORE_HEX.row))
    return grid >= 12
  })
  if (found === undefined) throw new Error('地图上找不到距 CORE_HEX ≥12 格的格')
  return { col: found.col, row: found.row }
})()

/** 摆一枚 1RE / 1 step 的断补战斗单位，取 store 内的响应式代理 */
function placeCombat(store: ReturnType<typeof newStore>, id: string, hex: HexRef) {
  placeGround(store, combatRecord('axis'), hex, 'axis', id)
  const unit = store.units.find((item) => item.instanceId === id)
  if (unit === undefined) throw new Error(`单位 ${id} 不在盘面上`)
  unit.re = 1
  unit.steps = 1
  unit.hasTraceSupply = false
  return unit
}

function tonsOf(store: ReturnType<typeof newStore>, id: string): number {
  const dump = store.spDumps.find((item) => item.id === id)
  if (dump === undefined) throw new Error(`补给站 ${id} 不存在`)
  return holdingsToT({ sp: dump.sp, t: dump.t })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('12.6c：D 段按实际付款来源分组取整，不跨来源借用已付费额度', () => {
  it('两个单位分别由两座互不可达的补给站供给 ⇒ 各自付 1T，两站都对得上账', () => {
    const store = newStore()
    store.setPhase('supply')
    const a = placeCombat(store, 'a', CORE_HEX)
    const b = placeCombat(store, 'b', FAR_HEX)
    // 12.3d：两处都真断补（敌方 ZOC 卡断），不是靠地形死角
    sealTraceSupplyByZoc(store, CORE_HEX, 'axis', true)
    sealTraceSupplyByZoc(store, FAR_HEX)
    store.spDumps.push({ id: 'near', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 1 })
    store.spDumps.push({ id: 'far', hex: { ...FAR_HEX }, side: 'axis', sp: 0, t: 1 })
    store.supplyPhaseInputs = {
      availableT: 0,
      eatOffTheMap: { [a.instanceId]: true, [b.instanceId]: true },
    }

    expect(store.planSupplyPhaseNow()).toBe(true)
    // 12.6c：两座站各起一批 ⇒ 各 1RE 各付 1T（修前全局累计 ⇒ [1, 0]，第二名免费）
    expect(store.supplyPhasePlan!.feeding.map((item) => item.costT)).toEqual([1, 1])
    expect(store.applySupplyPhaseFeedingNow()).toBe(true)

    expect(a.hasTraceSupply).toBe(false)
    expect(b.hasTraceSupply).toBe(false)
    expect(a.sustainedBySpecialSupplyTurn).toBe(store.turn)
    expect(b.sustainedBySpecialSupplyTurn).toBe(store.turn)
    // 资源有来源也有去向：两站各扣 1T，没有隔空转移，也没有不扣款就解除断补
    expect(tonsOf(store, 'near')).toBe(0)
    expect(tonsOf(store, 'far')).toBe(0)
    expect(store.supplyPhasePlan!.attritionDuty).toEqual([])

    // 重复提交不重复付款、不重复摘标
    expect(store.applySupplyPhaseFeedingNow()).toBe(true)
    expect(tonsOf(store, 'near')).toBe(0)
    expect(tonsOf(store, 'far')).toBe(0)
  })

  it('两单位共用同一座站 ⇒ 仍按 12.6c 批量取整，合计只付 1T', () => {
    const store = newStore()
    store.setPhase('supply')
    const a = placeCombat(store, 'a', CORE_HEX)
    const b = placeCombat(store, 'b', CORE_HEX)
    sealTraceSupplyByZoc(store, CORE_HEX, 'axis', true)
    store.spDumps.push({ id: 'shared', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 1 })
    store.supplyPhaseInputs = {
      availableT: 0,
      eatOffTheMap: { [a.instanceId]: true, [b.instanceId]: true },
    }

    expect(store.planSupplyPhaseNow()).toBe(true)
    expect(store.supplyPhasePlan!.feeding.map((item) => item.costT)).toEqual([1, 0])
    expect(store.applySupplyPhaseFeedingNow()).toBe(true)
    expect(a.hasTraceSupply).toBe(false)
    expect(b.hasTraceSupply).toBe(false)
    expect(a.sustainedBySpecialSupplyTurn).toBe(store.turn)
    expect(b.sustainedBySpecialSupplyTurn).toBe(store.turn)
    expect(tonsOf(store, 'shared')).toBe(0)
  })

  it('★ B1 12.1c：0/0 的条目不再是站 ⇒ b 连「吃图上补给」的资格都没有（12.6c 要求站在拖取/投递距离内）', () => {
    const store = newStore()
    store.setPhase('supply')
    const a = placeCombat(store, 'a', CORE_HEX)
    const b = placeCombat(store, 'b', FAR_HEX)
    // 12.3d：两处都真断补（敌方 ZOC 卡断），不是靠地形死角
    sealTraceSupplyByZoc(store, CORE_HEX, 'axis', true)
    sealTraceSupplyByZoc(store, FAR_HEX)
    store.spDumps.push({ id: 'near', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 1 })
    /*
     * 12.1b / 12.1c（用户 2026-11-24 裁定）：**补给站用完后不能算站点**。
     * 修前这里用「远站存在但分文没有（0 SP + 0 T）」造"该组预算为 0"；B1 之后这种情形不存在——
     * 空条目不进 `supplyFacts`，`canEatOffTheMap`（12.6c：要求站落在拖取/投递距离内）随之否决，
     * 故 b 不会得到 `affordable: false` 的供养行，而是**直接**承担损耗（12.8a）。
     * 账本条目本身仍保留（退款/撤销/界面显示"已用尽"）。
     */
    store.spDumps.push({ id: 'far', hex: { ...FAR_HEX }, side: 'axis', sp: 0, t: 0 })
    store.supplyPhaseInputs = {
      availableT: 0,
      eatOffTheMap: { [a.instanceId]: true, [b.instanceId]: true },
    }

    // 空条目不是站：不进 12.6 的事实
    expect(store.supplyFacts.dumpsFor('axis')).toEqual([CORE_HEX])

    expect(store.planSupplyPhaseNow()).toBe(true)
    // 只有 a 有资格吃图上补给（b 没有可用的站）
    expect(store.supplyPhasePlan!.feeding.map((item) => item.unitId)).toEqual([a.instanceId])
    expect(store.applySupplyPhaseFeedingNow()).toBe(true)
    // a 被喂饱（续命，不写 hasTraceSupply）；b 没有站 ⇒ 仍断补
    expect(a.hasTraceSupply).toBe(false)
    expect(a.sustainedBySpecialSupplyTurn).toBe(store.turn)
    expect(b.hasTraceSupply).toBe(false)
    expect(b.sustainedBySpecialSupplyTurn ?? null).not.toBe(store.turn)
    expect(tonsOf(store, 'near')).toBe(0)
    expect(tonsOf(store, 'far')).toBe(0)
    expect(store.supplyPhasePlan!.attritionDuty.map((duty) => duty.unitIds)).toEqual([
      [b.instanceId],
    ])
  })

  it('12.10e-A：恢复与供养额度取自同一组可达站，付款后账本守恒', () => {
    const store = newStore()
    store.setPhase('supply')
    const unit = placeCombat(store, 'a', CORE_HEX)
    unit.internalStocks = 'low'
    // 12.3d：断补由敌方 ZOC/敌占卡断构造（不靠地形死角）
    sealTraceSupplyByZoc(store, CORE_HEX, 'axis', true)
    store.spDumps.push({ id: 'shared', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 3 })
    store.supplyPhaseInputs = {
      availableT: 0,
      eatOffTheMap: { [unit.instanceId]: true },
    }

    expect(store.planSupplyPhaseNow()).toBe(true)
    expect(store.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(unit.internalStocks).toBeNull()
    expect(tonsOf(store, 'shared')).toBe(1) // 3T − 2T 恢复
    expect(store.applySupplyPhaseFeedingNow()).toBe(true)
    expect(unit.hasTraceSupply).toBe(false)
    expect(unit.sustainedBySpecialSupplyTurn).toBe(store.turn)
    expect(tonsOf(store, 'shared')).toBe(0) // 再付 1T 供养，同一站对得上账
  })
})
