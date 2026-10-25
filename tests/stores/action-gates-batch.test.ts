import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, combatRecord, placeGround } from '../flows/sop-harness'

/**
 * ★ 用户 2026-10-25「继续补约 48 个缺口」——**行为**验证（不是源码守卫）
 *
 * 挑几个"修前任何环节都能点"的入口，逐个证明：不在该环节 ⇒ 整笔拒绝且盘面不动。
 * 分类账在 `action-wiring.test.ts`（结构），这里管"真的拦住了"。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 切到某段的某环 */
function enter(
  store: ReturnType<typeof newStore>,
  phase: 'movement' | 'reinforcement' | 'supply' | 'combat',
  stepId: string,
): void {
  store.setPhase(phase)
  const index = store.playerSegmentSteps.findIndex((step) => step.id === stepId)
  expect(index, `${phase} 段没有 ${stepId} 这一环`).toBeGreaterThanOrEqual(0)
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

describe('12.5c 加注：与付燃料同一道闸（只在 C/E/G 的移动环节）', () => {
  it('不在移动环节 ⇒ 改不动「已加注」标记', () => {
    const store = newStore()
    const unit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    expect(unit.fuelled).toBeFalsy()

    // A 段（整备）：12.5c 的"燃料消耗时支付"还没到
    enter(store, 'reinforcement', 'reinforcement.arrival')
    store.setUnitFuelled('u1', true)
    expect(store.units.find((item) => item.instanceId === 'u1')?.fuelled).toBeFalsy()

    // C 段移动环节 ⇒ 放行
    enter(store, 'movement', 'movement.modeAndMovement')
    store.setUnitFuelled('u1', true)
    expect(store.units.find((item) => item.instanceId === 'u1')?.fuelled).toBe(true)
  })
})

describe('15.3 修建空军基地：只能在移动阶段（且须有工程兵）', () => {
  it('不在移动环节 ⇒ 直接拒（连工程兵都不查）', () => {
    const store = newStore()
    store.constructionInputs = {
      ...store.constructionInputs,
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
    }
    enter(store, 'reinforcement', 'reinforcement.arrival')
    expect(store.buildAirstripNow()).toBe(false)
    expect(store.airBases.some((base) => base.hex.col === CORE_HEX.col)).toBe(false)
  })
})

describe('1.6a 永久移出：入口在到达卡侧（B 增援·到货）', () => {
  it('不在到货环节 ⇒ 算子留在图上', () => {
    const store = newStore()
    placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')

    enter(store, 'movement', 'movement.modeAndMovement')
    store.removeForeverNow('u1')
    expect(store.units.some((unit) => unit.instanceId === 'u1')).toBe(true)

    enter(store, 'reinforcement', 'reinforcement.arrival')
    store.removeForeverNow('u1')
    expect(store.units.some((unit) => unit.instanceId === 'u1')).toBe(false)
    expect(store.removedForever.some((unit) => unit.instanceId === 'u1')).toBe(true)
  })
})

describe('12.8b 损耗骰：只在 D 段的补给检定环节', () => {
  it('在 C 段掷 ⇒ 拒（不进结果账）', () => {
    const store = newStore()
    const unit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    unit.hasTraceSupply = false
    store.setPhase('supply')
    store.planSupplyPhaseNow()
    const key = `${CORE_HEX.col}.${CORE_HEX.row}`

    enter(store, 'movement', 'movement.modeAndMovement')
    expect(store.rollAttritionNow(key, 7)).toBe(false)
    expect(store.attritionResults[key]).toBeUndefined()

    enter(store, 'supply', 'supply.check')
    expect(store.rollAttritionNow(key, 7)).toBe(true)
    expect(store.attritionResults[key]).toBeDefined()
  })
})
