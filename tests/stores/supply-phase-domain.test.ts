import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createTraceSupplyFacts, holdingsToT, resolveAttrition } from '@/engine/rules'
import { createSupplyPhaseDomain, type SupplyPhasePorts } from '@/stores/supply-phase'
import { allowedActionsOf, toConsoleUnit, type ConsoleUnit } from '@/stores/workbench-model'
import type { SpDump } from '@/stores/supply-types'
import { CORE_HEX, combatRecord } from '../flows/sop-harness'

/** 独立实例使用真实单位和规则，付款/骰源只在端口处记录。 */
function domainFixture(count = 1) {
  const units = ref<ConsoleUnit[]>(
    Array.from({ length: count }, (_, index) =>
      toConsoleUnit({
        record: combatRecord('axis'),
        instanceId: `u${index}`,
        hex: CORE_HEX,
        side: 'axis',
      }),
    ),
  )
  const dumps = ref<SpDump[]>([{ id: 'd', side: 'axis', hex: CORE_HEX, sp: 2, t: 0 }])
  const step = ref('supply.recovery')
  const canPay = ref(true)
  const pay = vi.fn((_unit: ConsoleUnit, amount: number): string | null => {
    const dump = dumps.value[0]!
    if (!canPay.value || holdingsToT(dump) < amount) return null
    const left = holdingsToT(dump) - amount
    dump.sp = Math.floor(left / 4)
    dump.t = left % 4
    return 'd'
  })
  const roll = vi.fn(() => 9)
  const refresh = vi.fn(() => 0)
  const enterCheck = vi.fn(() => {
    step.value = 'supply.check'
    return true
  })
  const ports: SupplyPhasePorts = {
    units: () => units.value,
    activeSide: () => 'axis',
    facts: () => createTraceSupplyFacts({ dumps: dumps.value }),
    step: () => step.value,
    enterCheck,
    requireAction: (key) =>
      allowedActionsOf({ phase: 'supply', segment: step.value, role: 'active', side: 'axis' }).has(
        key,
      ),
    actionAllowedNow: (key) =>
      allowedActionsOf({ phase: 'supply', segment: step.value, role: 'active', side: 'axis' }).has(
        key,
      ),
    deliverableDumpsFor: () => dumps.value,
    payFromSideDumps: (amount) => pay(units.value[0]!, amount),
    payFromUnitReachableDumps: pay,
    markTraceSupply(id, ready) {
      units.value.find((unit) => unit.instanceId === id)!.hasTraceSupply = ready
    },
    markSustainedBySpecialSupply: vi.fn(),
    refreshTraceSupply: refresh,
    eliminateEntry(unit) {
      units.value = units.value.filter((item) => item.instanceId !== unit.instanceId)
    },
    pushLog: vi.fn(),
    recordSettlement: vi.fn(() => true),
    rollDice: roll,
  }
  const domain = createSupplyPhaseDomain(ports)
  const key = `${CORE_HEX.col}.${CORE_HEX.row}`
  return {
    domain,
    units,
    dumps,
    step,
    canPay,
    pay,
    roll,
    refresh,
    enterCheck,
    key,
    log: ports.pushLog,
  }
}

describe('D段独立域：付款、待决损耗与阶段退出', () => {
  it('12.10e/12.6c：已结算恢复后重算供养不再次预留恢复费，实际喂食后不产生虚假损耗', () => {
    const a = domainFixture()
    a.units.value[0]!.internalStocks = 'low'
    a.units.value[0]!.re = 1
    a.units.value[0]!.steps = 1
    a.dumps.value[0]!.sp = 0
    a.dumps.value[0]!.t = 2
    a.domain.supplyPhaseInputs.value.eatOffTheMap.u0 = true
    expect(a.domain.planSupplyPhaseNow()).toBe(true)
    expect(a.domain.supplyPhasePlan.value!.internalStocks.spentT).toBe(2)
    expect(a.domain.supplyPhasePlan.value!.feeding[0]!.affordable).toBe(false)
    // 模拟恢复环节已经结算、仍为Low的合法恢复点；供养重算只消费当前盘面余量。
    a.domain.supplyRecoverySettled.value = true
    a.step.value = 'supply.check'
    expect(a.domain.planSupplyPhaseNow()).toBe(true)
    expect(a.domain.supplyPhasePlan.value!.internalStocks.spentT).toBe(0)
    expect(a.domain.supplyPhasePlan.value!.feeding[0]!.affordable).toBe(true)
    expect(a.domain.applySupplyPhaseFeedingNow()).toBe(true)
    expect(a.units.value[0]!.hasTraceSupply).toBe(true)
    expect(a.units.value[0]!.internalStocks).toBe('low')
    expect(a.domain.supplyPhasePlan.value!.attritionDuty).toEqual([])
    const calls = a.pay.mock.calls.length
    expect(a.domain.planSupplyPhaseNow()).toBe(true)
    expect(a.domain.applySupplyPhaseFeedingNow()).toBe(true)
    expect(a.pay).toHaveBeenCalledTimes(calls)
  })
  it('新阶段重置后重新执行恢复优先，不把上一阶段已结算状态延用', () => {
    const a = domainFixture()
    a.units.value[0]!.internalStocks = 'low'
    a.units.value[0]!.re = 1
    a.units.value[0]!.steps = 1
    a.domain.supplyRecoverySettled.value = true
    expect(a.domain.planSupplyPhaseNow()).toBe(true)
    expect(a.domain.supplyPhasePlan.value!.internalStocks.spentT).toBe(0)
    a.domain.reset()
    expect(a.domain.planSupplyPhaseNow()).toBe(true)
    expect(a.domain.supplyPhasePlan.value!.internalStocks.spentT).toBe(2)
  })
  it('12.10e：计划后来源余额减少，耗尽单位仍落实付得起的部分恢复，日志使用实际扣款', () => {
    const a = domainFixture(2)
    for (const unit of a.units.value) {
      unit.internalStocks = 'exhausted'
      unit.re = 1
      unit.steps = 1
    }
    expect(a.domain.planSupplyPhaseNow()).toBe(true)
    expect(a.domain.supplyPhasePlan.value!.internalStocks.spentT).toBe(8)
    a.dumps.value[0]!.sp = 0
    a.dumps.value[0]!.t = 2
    expect(a.domain.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(a.units.value[0]!.internalStocks).toBe('low')
    expect(a.units.value[1]!.internalStocks).toBe('exhausted')
    expect(holdingsToT(a.dumps.value[0]!)).toBe(0)
    expect(a.log).toHaveBeenCalledWith('success', expect.stringContaining('实际消耗 2 T'), '12.10e')
    const count = a.pay.mock.calls.length
    expect(a.domain.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(a.pay).toHaveBeenCalledTimes(count)
  })
  it('12.10e：部分恢复付款被拒，不能更新单位或报出计划消耗', () => {
    const a = domainFixture()
    a.units.value[0]!.internalStocks = 'exhausted'
    a.units.value[0]!.re = 1
    a.units.value[0]!.steps = 1
    expect(a.domain.planSupplyPhaseNow()).toBe(true)
    a.canPay.value = false
    expect(a.domain.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(a.units.value[0]!.internalStocks).toBe('exhausted')
    expect(holdingsToT(a.dumps.value[0]!)).toBe(8)
    expect(a.log).toHaveBeenCalledWith('success', expect.stringContaining('实际消耗 0 T'), '12.10e')
  })
  it.each(['low', 'exhausted'] as const)(
    '12.10e-C：不足且浪费1T时，先落实%s单位付得起的恢复，重复提交不再收费',
    (level) => {
      const a = domainFixture(2)
      for (const unit of a.units.value) {
        unit.internalStocks = level
        unit.steps = 1
        unit.re = 1
      }
      a.dumps.value[0]!.sp = 0
      a.dumps.value[0]!.t = 3
      expect(a.domain.planSupplyPhaseNow()).toBe(true)
      const plan = a.domain.supplyPhasePlan.value!.internalStocks
      expect(plan.wastedT).toBe(1)
      expect(plan.recoveries.length).toBeGreaterThan(0)
      expect(a.domain.applySupplyPhaseRecoveryNow()).toBe(true)
      for (const recovery of plan.recoveries)
        expect(
          a.units.value.find((unit) => unit.instanceId === recovery.unitId)!.internalStocks,
        ).toBe(recovery.to === 'ready' ? null : 'low')
      expect(holdingsToT(a.dumps.value[0]!)).toBe(0)
      const calls = a.pay.mock.calls.length
      expect(a.domain.applySupplyPhaseRecoveryNow()).toBe(true)
      expect(a.pay).toHaveBeenCalledTimes(calls)
    },
  )
  it('12.10e：独立实例不串账；重复恢复只付款一次，重置保留绑定的状态容器', () => {
    const a = domainFixture(),
      b = domainFixture()
    a.units.value[0]!.internalStocks = 'low'
    expect(a.domain.planSupplyPhaseNow()).toBe(true)
    expect(a.domain.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(a.domain.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(a.pay).toHaveBeenCalledTimes(1)
    expect(b.pay).not.toHaveBeenCalled()
    expect(b.domain.supplyRecoverySettled.value).toBe(false)
    const ledger = a.domain.supplyRecoverySettled
    a.domain.reset()
    expect(a.domain.supplyRecoverySettled).toBe(ledger)
    expect(ledger.value).toBe(false)
    expect(a.domain.supplyPhasePlan.value).toBeNull()
  })

  it('12.6/12.8：计划后付款失败的单位仍进入实际损耗名单', () => {
    const a = domainFixture()
    a.step.value = 'supply.check'
    a.domain.supplyPhaseInputs.value.eatOffTheMap.u0 = true
    expect(a.domain.planSupplyPhaseNow()).toBe(true)
    expect(a.domain.supplyPhasePlan.value!.feeding[0]!.affordable).toBe(true)
    a.canPay.value = false
    expect(a.domain.applySupplyPhaseFeedingNow()).toBe(true)
    expect(a.units.value[0]!.hasTraceSupply).toBe(false)
    expect(a.domain.supplyPhasePlan.value!.attritionDuty[0]!.unitIds).toEqual(['u0'])
  })

  it('12.8b：等待玩家选损失时保留义务和骰面，清空/重算计划不能绕过损耗', () => {
    const a = domainFixture(2)
    a.step.value = 'supply.check'
    // 使用真实单位行动值，选一个产生部分损失而非全灭的表项。
    const bestAr = Math.max(...a.units.value.map((unit) => unit.raw.ar))
    const steps = a.units.value.reduce((sum, unit) => sum + unit.steps, 0)
    const die = Array.from({ length: 11 }, (_, index) => index + 2).find((value) => {
      const loss = resolveAttrition({ die: value, bestAr, oosSteps: steps }).losses
      return loss.kind === 'steps' && loss.steps > 0 && loss.steps < steps
    })!
    expect(die).toBeDefined()
    a.roll.mockReturnValue(die)
    expect(a.domain.settleForExit()).toBe(false)
    const duties = structuredClone(
      a.domain.supplyPhasePlan.value!.attritionDuty.map((duty) => ({
        ...duty,
        hex: { ...duty.hex },
        unitIds: [...duty.unitIds],
      })),
    )
    a.domain.clearSupplyPhasePlan()
    expect(a.domain.supplyPhasePlan.value?.attritionDuty).toEqual(duties)
    expect(a.domain.settleForExit()).toBe(false)
    a.domain.planSupplyPhaseNow()
    expect(a.domain.supplyPhasePlan.value!.attritionDuty).toEqual(duties)
    expect(a.domain.settleForExit()).toBe(false)
    expect(a.roll).toHaveBeenCalledTimes(1)
    const left = a.domain.attritionResults.value[a.key]!.losses
    expect(left.kind).toBe('steps')
    let remaining = left.kind === 'steps' ? left.steps : 0
    for (const unit of a.units.value) {
      const loss = Math.min(remaining, unit.steps)
      a.domain.setAttritionAllocation(a.key, unit.instanceId, loss)
      remaining -= loss
    }
    expect(a.domain.applyAttritionNow(a.key)).toBe(true)
    expect(a.domain.settleForExit()).toBe(true)
    expect(a.domain.applyAttritionNow(a.key)).toBe(true)
    expect(a.refresh).toHaveBeenCalledTimes(1)
  })

  it('2.2：整段退出依次结清恢复与供养，重试不重复切环或付款', () => {
    const a = domainFixture()
    a.units.value[0]!.internalStocks = 'low'
    a.domain.supplyPhaseInputs.value.eatOffTheMap.u0 = true
    expect(a.domain.settleForExit(true)).toBe(true)
    expect(a.domain.supplyRecoverySettled.value).toBe(true)
    expect(a.domain.supplyFeedingSettled.value).toBe(true)
    expect(a.units.value[0]!.internalStocks).toBeNull()
    expect(a.units.value[0]!.hasTraceSupply).toBe(true)
    expect(a.pay).toHaveBeenCalledTimes(2)
    expect(a.domain.settleForExit(true)).toBe(true)
    expect(a.pay).toHaveBeenCalledTimes(2)
    expect(a.enterCheck).toHaveBeenCalledTimes(1)
  })
})
