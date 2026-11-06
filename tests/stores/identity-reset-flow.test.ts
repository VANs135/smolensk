import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * A1：身份（阵营）切换时的**状态重置**
 *
 * ## 条文依据
 *   - 2.2 流程表：先手方走完 A–H 后由**后手方重复上述步骤**（角色互换）；
 *   - 6.1b：MA 是**一个阶段**可消耗的额度 ⇒ 换方必须全体归零；
 *   - 5.7b：`releasedFromReserve` 只表示「本阶段刚释放」，换阶段即失效；
 *   - 12.5c-C：单单位法的燃料「只在当前阶段有效」⇒ 换方失效；
 *   - 14.2e：飞机「每个阶段只能执行一次任务」⇒ 换方归零。
 *
 * ## 测法边界
 *   只钉**换方路径**（`switchSide`）的重置结果；不测界面渲染。手动 U0 切方与
 *   正式推进换方共用同一清零点（`resetMovementTracking` / watch → `resetPhase`）。
 */

const AT: HexRef = { col: 1, row: 1 }

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('A1：换方不继承上一方的阶段状态', () => {
  it('★ 换方后：MP 账本 / 移动结束 / 释放旗标 / 单单位燃料 / 飞机任务次数全部归零', () => {
    const store = newStore()
    store.setScenarioId('1')

    const record = unitChoices('axis').find(
      (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
    )
    if (record === undefined) throw new Error('单位库没有轴方徒步战斗单位')
    const unit = toConsoleUnit({
      record,
      instanceId: 'axis-leg',
      hex: AT,
      side: 'axis',
      face: 'combat',
    })
    store.units.push(unit)

    unit.mpSpent = 2
    unit.movementEnded = true
    unit.mpLockedThisPhase = true
    unit.mode = { ...unit.mode, releasedFromReserve: true }
    unit.fuelled = true
    unit.fuelMethod = 'singleUnit'

    const aircraft = store.airUnits[0]
    if (aircraft !== undefined) aircraft.missionsFlownThisPhase = 1

    expect(store.activeSide).toBe('axis')
    store.switchSide()
    expect(store.activeSide).toBe('soviet')

    const after = store.units.find((item) => item.instanceId === unit.instanceId)
    expect(after?.mpSpent).toBe(0)
    expect(after?.movementEnded).toBe(false)
    expect(after?.mpLockedThisPhase).toBe(false)
    expect(after?.mode.releasedFromReserve).toBe(false)
    expect(after?.fuelled).toBe(false)
    expect(after?.fuelMethod).toBe(null)
    expect(store.airUnits.every((air) => air.missionsFlownThisPhase === 0)).toBe(true)
  })

  it('换段同样归零（setPhase 与换方共用同一清零点）', () => {
    const store = newStore()
    store.setScenarioId('1')
    const record = unitChoices('axis').find(
      (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
    )
    if (record === undefined) throw new Error('单位库没有轴方徒步战斗单位')
    const unit = toConsoleUnit({
      record,
      instanceId: 'axis-leg-2',
      hex: AT,
      side: 'axis',
      face: 'combat',
    })
    store.units.push(unit)
    unit.mpSpent = 3
    unit.movementEnded = true

    store.setPhase('reinforcement')
    expect(store.phase).toBe('reinforcement')
    const after = store.units.find((item) => item.instanceId === unit.instanceId)
    expect(after?.mpSpent).toBe(0)
    expect(after?.movementEnded).toBe(false)
  })
})
