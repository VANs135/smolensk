import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { holdingsToT } from '@/engine/rules'
import {
  allowedActionsOf,
  needsFuelOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

import { CORE_HEX, combatRecord, placeGround } from '../flows/sop-harness'

/**
 * H④（用户 2026-09-19 口径）：**D 段两步** —— ①恢复部队储备（12.10e）②补给检定（12.6 → 12.6c/12.6d → 12.8），
 * 并**删掉原先多出来的「加油」环节**。
 *
 * 用户原话：「规则里补给阶段没有具体环节，但应该是这样两步：1.恢复部队储备：要为有 low/exhausted
 * 标志的单位恢复部队储备（12.10e） 2.补给检定：确定哪些单位无法追溯补给线（12.6）。它们可以选择
 * 吃地图上的 SP 补给（12.6c）或者被放置断补标志。之后，检定所有断补单位堆叠的损耗（12.8）。」
 * 以及：「里面在补给阶段有燃料环节，但是燃料环节不应该存在，未加油单位是在移动前加油，现在已经做好了」。
 *
 * 规则的支撑：12.10e-A「各单位必须尽可能地恢复部队储备……将 SP 用于恢复部队储备的**优先级更高**」、
 * 12.10e-B「只要是低下或耗尽单位可拖取，或可投递 SP 至这些单位的补给站，均需要按规则去恢复」、
 * 12.5c「在**发生燃料消耗的任何阶段**，单位都应在燃料消耗时支付」。
 *
 * 本文件钉三件事：
 *   ① 两环的 id/次序，以及两环**各自**放行哪些动作族（12.10e vs 12.6/12.8 不串门）；
 *   ② 12.10e-A 的优先次序被**强制**：第二环里落盘恢复被拒、账本一字未动（回到第一环才可落盘）；
 *   ③ 12.5c：D 段付燃料被拒且账本不动，**同时** C/E/G 的移动环节照旧可付（删环节不能把那条路也删掉）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 该环的动作族查询（行动方＝本方，与界面调用同一入口） */
const gateOf = (segment: string) =>
  allowedActionsOf({ phase: 'supply', segment, role: 'active', side: 'axis' })

describe('H④：D 段两环（恢复部队储备 → 补给检定）', () => {
  it('★ 两环的 id/次序与各自的动作族（12.10e / 12.6 / 12.8 不串门）', () => {
    const store = newStore()
    store.setPhase('supply')
    expect(store.playerSegmentSteps.map((step) => step.id)).toEqual([
      'supply.recovery',
      'supply.check',
    ])
    expect(store.segmentStep?.label).toContain('恢复部队储备')

    const first = gateOf('supply.recovery')
    const second = gateOf('supply.check')
    // ① 恢复（12.10e）＋ 12.10e-B 的拖取/投递（12.3a·b，与 12.6 同源）
    expect(first.has('supply.recovery')).toBe(true)
    expect(first.has('supply.draw')).toBe(true)
    // 12.8a 的损耗属第二环（判定完才有断补堆叠）
    expect(first.has('supply.attrition')).toBe(false)
    // ② 追溯判定 + 吃图上补给/投递（supply.draw）＋ 断补损耗（supply.attrition）
    expect(second.has('supply.draw')).toBe(true)
    expect(second.has('supply.attrition')).toBe(true)
    expect(second.has('supply.recovery')).toBe(false)
    // 12.5c：两环都不付燃料（燃料在消耗时刻付 ⇒ C/E/G 的移动环节）
    for (const set of [first, second]) expect(set.has('supply.fuel')).toBe(false)
  })

  it('★ 12.10e-A 的优先次序被强制：补给检定环里落盘恢复**被拒**、账本一字未动', () => {
    const store = newStore()
    store.setPhase('supply')
    const low = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    low.internalStocks = 'low' // 恢复价 2T（12.10e）
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 2, t: 0 })
    // 总计划 12.1–12.2 在两环都可用（它是投影＋算账，不落盘）
    expect(store.planSupplyPhaseNow()).toBe(true)
    expect(store.supplyPhasePlan?.internalStocks.recoveries).toHaveLength(1)

    // 先跳到第二环（补给检定）
    expect(store.setSegmentStepIndex(1)).toBe(true)
    expect(store.segmentStep?.id).toBe('supply.check')
    const before = holdingsToT(store.spDumps[0]!)
    expect(store.applySupplyPhaseRecoveryNow()).toBe(false)
    expect(store.actionRefusal?.rule).toBe('12.10e')
    expect(low.internalStocks).toBe('low')
    expect(holdingsToT(store.spDumps[0]!)).toBe(before)

    // 回到第一环 ⇒ 同一动作可以落盘（12.10e-C：扣 2T、标记摘掉）
    expect(store.setSegmentStepIndex(0)).toBe(true)
    expect(store.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(low.internalStocks).toBeNull()
    expect(holdingsToT(store.spDumps[0]!)).toBe(before - 2)
  })

  it('★ 12.5c：D 段付燃料被拒（账本不动），C/E/G 的移动环节照旧可付', () => {
    const store = newStore()
    store.setPhase('supply')
    const tank = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
    // 选中它（取子清单＝受益集），再试图付油
    store.beginMovePick(CORE_HEX, [tank.instanceId])
    store.payFuel()
    expect(tank.fuelled).toBe(false)
    expect(holdingsToT(store.spDumps[0]!)).toBe(16) // 一字未动
    expect(store.actionRefusal?.rule).toBe('12.5')
    // 话术要指路：只能在 C/E/G 的**移动环节**付（12.5a/12.5f：开拔前必须已付）
    // —— 闸门把"能在哪做"翻成环节名（`sopStepById` 的 label），故这里认「模式与移动」
    expect(store.actionRefusal?.reason ?? '').toContain('模式与移动')

    // 反空转：删掉 D 段的加油环节**不能**把移动环节那条路也删掉
    const inMovement = allowedActionsOf({
      phase: 'movement',
      segment: 'movement.modeAndMovement',
      role: 'active',
    })
    expect(inMovement.has('supply.fuel')).toBe(true)
  })

  it('★ 两环都允许 1.7/21.10 的补给缓存 Forage（原口径：只在 D 段）', () => {
    const store = newStore()
    store.setPhase('supply')
    for (const segment of ['supply.recovery', 'supply.check']) {
      expect(gateOf(segment).has('exclusive.forage')).toBe(true)
    }
  })

  it('★ 12.5a：徒步/非耗油单位不进"待加油"集合（删了加油环节后，判据仍在 `needsFuelOf`）', () => {
    /*
     * 修前 D 段有个加油环节，它的参与判据里写着「该单位不需要燃料 ⇒ 不可参与（12.5a）」。
     * H④ 删掉那个环节后，这条判据的**唯一出处**变成付款侧的过滤：`fuelPendingUnits`（用 `needsFuelOf`）。
     * 本用例把它钉在这里，免得"删环节"顺手把"谁需要油"的判断也删掉。
     */
    const store = newStore()
    store.setPhase('supply')
    const records = unitChoices('axis')
    const leg = records.find((record) => {
      // 判据用被测代码同源的 `needsFuelOf`（不猜记录字段的形状）：先转成操作台算子再筛
      const probe = toConsoleUnit({ record, instanceId: 'probe', hex: CORE_HEX, side: 'axis' })
      return probe.isCombat && !needsFuelOf(probe)
    })
    expect(leg, '单位库里应有徒步战斗单位').toBeDefined()
    const legUnit = placeGround(store, leg!, CORE_HEX, 'axis', 'leg1')
    store.beginMovePick(CORE_HEX, [legUnit.instanceId])
    expect(store.fuelPendingUnits.map((unit) => unit.instanceId)).not.toContain('leg1')
    expect(store.fuelPaymentDue).toBe(false)
  })
})
