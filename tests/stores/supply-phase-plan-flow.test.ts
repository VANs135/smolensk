import { describe, expect, it } from 'vitest'

import { holdingsToT } from '@/engine/rules'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'
import { createPinia, setActivePinia } from 'pinia'

import { CORE_HEX, combatRecord, placeGround } from '../flows/sop-harness'

/**
 * D 段**补给阶段总计划**（12.1–12.2 骨架）与其中两步的落盘：
 *   · **12.10e 部队储备强制恢复**（本段第一步，且**不是选项**——「要将标记为低下或耗尽的单位的
 *     部队储备进行恢复」）；
 *   · **12.11a 销毁补给站**（只在移动环节、每阶段每站一次、运输点数不能以此摧毁）。
 *
 * 计划本身的**顺序**由引擎给死（12.10e-A：恢复优先于以 SP 代 trace），本文件只钉：
 * ① 计划能载入且五项齐备；② 恢复按 12.10e 落盘（含 12.10e-C 的浪费）且**只能从己方补给站扣**；
 * ③ 销毁走的阶段闸与次数闸；④ 不勾"自愿吃图上补给"时喂食为空（12.6c 永不强迫）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

describe('C8b：D 段补给阶段总计划（12.1–12.2）', () => {
  it('载入计划 ⇒ 五项结论齐备，且恢复优先于喂食（12.10e-A）', () => {
    const store = newStore()
    store.setPhase('supply')
    placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    expect(store.planSupplyPhaseNow()).toBe(true)
    const plan = store.supplyPhasePlan
    expect(plan).not.toBeNull()
    // ① 恢复 ② 评估 ③ 喂食 ④ 断补标记 ⑤ 损耗义务
    expect(plan).toHaveProperty('internalStocks')
    expect(plan).toHaveProperty('assessments')
    expect(plan).toHaveProperty('feeding')
    expect(plan).toHaveProperty('outOfSupply')
    expect(plan).toHaveProperty('attritionDuty')
  })

  it('12.6c：不勾"自愿吃图上补给" ⇒ 喂食为空（游戏说明：**永不强迫**）', () => {
    const store = newStore()
    store.setPhase('supply')
    const unit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    // 12.6c 的"吃图上补给"吃的是**图上**的 SP ⇒ 该格必须有可拖到的补给站
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
    store.planSupplyPhaseNow()
    expect(store.supplyPhasePlan?.feeding).toEqual([])

    store.supplyPhaseInputs = {
      ...store.supplyPhaseInputs,
      eatOffTheMap: { [unit.instanceId]: true },
    }
    store.planSupplyPhaseNow()
    // 勾了就会有该单位的条目（是否付得起由引擎按剩余 T 判）
    expect(store.supplyPhasePlan?.feeding.map((item) => item.unitId)).toContain(unit.instanceId)
  })

  it('可用 T 被**己方可达站的实有量**夹住（不存在凭空可用的池子）', () => {
    const store = newStore()
    store.setPhase('supply')
    /*
     * ★ 契约变更（第五批批 B 切片 3，**收紧不是放宽**）：池从"己方**全部**补给站"改为
     *   "**参与者的可达站并集**"（12.10e 的"可通过直接拖取或从指挥部投递"）——没有参与者
     *   （无待恢复、无勾选喂食的单位）时池恒为 0，故本用例先摆一个待恢复单位作前提。
     */
    const low = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    low.internalStocks = 'low'
    expect(store.supplyPhaseAvailableCap).toBe(0)
    store.supplyPhaseInputs = { ...store.supplyPhaseInputs, availableT: 99 }
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 1, t: 0 })
    expect(store.supplyPhaseAvailableCap).toBe(4) // 1 SP = 4 T（12.1a）
    store.spDumps.push({ id: 'd2', hex: { ...CORE_HEX }, side: 'soviet', sp: 8, t: 0 })
    expect(store.supplyPhaseAvailableCap).toBe(4) // 只算己方
    // 声明量超过实有量 ⇒ 引擎拿到的是实有量（可核对计划里的剩余 T）
    store.planSupplyPhaseNow()
    expect(store.supplyPhasePlan?.remainingT).toBeLessThanOrEqual(4)
  })
})

describe('M3③-1：12.10e 部队储备强制恢复', () => {
  it('低下/耗尽的单位在本阶段必须恢复：扣 T、档位回到 ready', () => {
    const store = newStore()
    store.setPhase('supply')
    const low = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    low.internalStocks = 'low'
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 2, t: 0 }) // 8 T
    store.planSupplyPhaseNow()
    expect(store.supplyPhasePlan?.internalStocks.recoveries).toHaveLength(1)

    const before = holdingsToT(store.spDumps[0]!)
    expect(store.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(low.internalStocks).toBeNull() // 恢复 ⇒ ready（标记摘掉）
    expect(holdingsToT(store.spDumps[0]!)).toBeLessThan(before)
  })

  it('已耗尽的单位在 T 只够"低"价时 ⇒ 只降到 low（12.10e-C）', () => {
    const store = newStore()
    store.setPhase('supply')
    const spent = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    spent.internalStocks = 'exhausted' // 完全恢复 4T；降为 low 需 2T
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 2 })
    store.planSupplyPhaseNow()
    const recovery = store.supplyPhasePlan!.internalStocks
    expect(recovery.recoveries).toEqual([
      { unitId: spent.instanceId, from: 'exhausted', to: 'low', costT: 2 },
    ])
    expect(store.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(spent.internalStocks).toBe('low')
    expect(holdingsToT(store.spDumps[0]!)).toBe(0)
  })

  it('T 充裕 ⇒ 完全恢复（12.10e-A：各单位必须**尽可能**恢复）', () => {
    const store = newStore()
    store.setPhase('supply')
    const spent = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    spent.internalStocks = 'exhausted'
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 }) // 16 T
    store.planSupplyPhaseNow()
    expect(store.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(spent.internalStocks).toBeNull() // 一次恢复到位
  })

  it('补给站不够 ⇒ 按 12.10e-C 消耗现有全部（该 T 被浪费），单位留在 low', () => {
    const store = newStore()
    store.setPhase('supply')
    const low = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    low.internalStocks = 'low' // 恢复价 2T
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 1 }) // 只有 1 T
    store.planSupplyPhaseNow()
    const recovery = store.supplyPhasePlan!.internalStocks
    // 12.10e-C：一个 T 直接浪费；单位恢复不了
    expect(recovery.recoveries).toEqual([])
    expect(recovery.spentT).toBe(1)
    expect(recovery.wastedT).toBe(1)
    expect(recovery.unmet).toEqual([low.instanceId])

    // 落盘：只扣「消耗」的 1 T（`spentT` 已含浪费，不得再加一遍）
    expect(store.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(low.internalStocks).toBe('low')
    expect(holdingsToT(store.spDumps[0]!)).toBe(0)
  })

  it('未载入计划就落盘 ⇒ 被拒（先算后落）', () => {
    const store = newStore()
    store.setPhase('supply')
    expect(store.applySupplyPhaseRecoveryNow()).toBe(false)
  })
})

describe('M3③-2：12.11a 销毁补给站', () => {
  const withDump = () => {
    const store = newStore()
    store.setPhase('movement') // 12.11a：只能在移动环节
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 3 })
    return store
  }

  it('移动环节内销毁：按掷骰百分比扣 SP（运输点数不受影响）', () => {
    const store = withDump()
    expect(store.destructDumpNow('d1', 16, 4)).toBe(true)
    const dump = store.spDumps[0]!
    expect(dump.sp + dump.t).toBeLessThan(16 + 3)
    expect(dump.t).toBe(3) // 12.11a：运输点数不能以此方式摧毁
    expect(store.dumpDestructionAttempts.d1).toBe(1)
  })

  it('每个阶段每站只能尝试一次（12.11a）', () => {
    const store = withDump()
    expect(store.destructDumpNow('d1', 4, 4)).toBe(true)
    expect(store.destructDumpNow('d1', 4, 4)).toBe(false)
  })

  it('换阶段即重新获得尝试权（12.11a：限额按**每个阶段**计，第五批 B1）', () => {
    const store = withDump()
    expect(store.destructDumpNow('d1', 4, 4)).toBe(true)
    // 换到另一段再回移动段 ⇒ 新阶段 ⇒ 同一站可再尝试（修前账本从不清零 ⇒ 每局一次 ⇒ 红）
    store.setPhase('combat')
    store.setPhase('movement')
    expect(store.destructDumpNow('d1', 4, 4), '新阶段应重新允许尝试').toBe(true)
  })

  it('非移动环节不得销毁（12.11a：只在移动、反应、进击阶段中的**移动环节**）', () => {
    const store = withDump()
    store.setPhase('supply')
    expect(store.destructDumpNow('d1', 4, 4)).toBe(false)
  })

  it('只能销毁己方补给站', () => {
    const store = withDump()
    store.setPhase('movement')
    store.spDumps.push({ id: 'enemy', hex: { ...CORE_HEX }, side: 'soviet', sp: 4, t: 0 })
    expect(store.destructDumpNow('enemy', 4, 4)).toBe(false)
  })

  it('只有运输点数的站 ⇒ 无可销毁（12.11a 末句）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.spDumps.push({ id: 'tp', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 6 })
    expect(store.destructDumpNow('tp', 4, 4)).toBe(false)
  })
})

/** 让未用到的导入显式落地（避免 lint 误报；同时说明夹具来自真实单位库） */
export const __fixture = { toConsoleUnit, unitChoices }
