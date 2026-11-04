import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 专规 2.4 慢动员的 **store 端到端**（真实到达卡、真实单位库）
 *
 * 核对三件事：
 * - 30/28/24 集团军的师**到场即锁定**，归属来自到达卡分组（单位库没有集团军字段）；
 * - 解锁只作用于**玩家指定**的那一枚，且必须仍被锁、属于该集团军；
 * - 同日重复解锁不会重复拿到表 2-2 的配额。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const pickSovietDivision = () => {
  const record = unitChoices('soviet').find((item) => /Div/i.test(item.vassalName ?? ''))
  if (record === undefined) throw new Error('苏军单位库中没有师级记录')
  return record
}

describe('专规 2.4：慢动员（store 流程）', () => {
  it('2.4：12 Jul 到达的 30th 集团军师到场即锁定并带归属', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    if (plan === null) throw new Error('12 Jul 应有到达计划')
    const index = plan.units.findIndex((unit) => unit.slowMobilizationArmy === '30th')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(store.placeArrivalNow(index, pickSovietDivision().id)).toBe(true)

    const arrived = store.units.filter((unit) => unit.slowMobilizationArmy === '30th')
    expect(arrived.length).toBeGreaterThan(0)
    expect(arrived.every((unit) => unit.locked)).toBe(true)
  })

  it('2.4：解锁只作用于玩家选中的师，当日配额用尽后第三枚被拒', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    if (plan === null) throw new Error('12 Jul 应有到达计划')
    const indices: number[] = []
    plan.units.forEach((unit, index) => {
      if (unit.slowMobilizationArmy === '30th') indices.push(index)
    })
    expect(indices.length).toBeGreaterThanOrEqual(3)
    const record = pickSovietDivision()
    for (const index of indices) {
      expect(store.placeArrivalNow(index, record.id)).toBe(true)
    }

    const lockedIds = store.units
      .filter((unit) => unit.slowMobilizationArmy === '30th' && unit.locked)
      .map((unit) => unit.instanceId)
    expect(lockedIds.length).toBeGreaterThanOrEqual(3)

    // 12 Jul 表 2-2 只给 30th 两个配额
    expect(store.unlockSlowMobilizationNow(lockedIds[0]!)).toBe(true)
    expect(store.unlockSlowMobilizationNow(lockedIds[1]!)).toBe(true)
    expect(store.unlockSlowMobilizationNow(lockedIds[2]!)).toBe(false)

    const unlocked = store.units.filter(
      (unit) => unit.slowMobilizationArmy === '30th' && !unit.locked,
    )
    expect(unlocked.map((unit) => unit.instanceId).sort()).toEqual(
      [lockedIds[0]!, lockedIds[1]!].sort(),
    )
  })

  it('2.4：没有到达卡集团军归属的算子不能按表解锁（不按番号前缀猜）', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(2)
    store.setPhase('reinforcement')
    const unit = toConsoleUnit({
      record: pickSovietDivision(),
      instanceId: 'ru-unverifiable',
      hex: { col: 1, row: 26 },
      side: 'soviet',
    })
    unit.locked = true
    store.units.push(unit)

    expect(store.unlockSlowMobilizationNow('ru-unverifiable')).toBe(false)
    expect(unit.locked).toBe(true)
  })
})
