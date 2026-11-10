import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * 13.2a：运输点数的「暂停 / 继续」
 *
 * 原文：「运输点数可以移动、**暂停移动**并使用它装载的部分补给、**然后继续移动**。……
 * 有两个重要的限制：运输点数**必须在另一个单位移动之前完成它的移动**，而之后会产生的
 * 战斗或轰炸补给消耗则永远不能以这种方式预付。」
 *
 * 本文件钉住四件事：
 *   ① **「结束移动」＝完成**：已结束的实例不得再进"未动完"、不得再有开拔入口、不得再占配额
 *      （用户 2026-11-10 实机 #15——修前点「结束移动」被当成"暂停"，其它单位永远开拔不了）；
 *   ② 13.2a 的「暂停」是**显式动作**（`pauseTransportMove`）：同一阶段内可**继续**，MP 累计；
 *   ③ 暂停期间「另一个单位」不得开拔（13.2a 的那条限制）；
 *   ④ 普通单位不享受这条例外（6.1g 的"本轮已结束"照旧）。
 * 「用装载的 SP 付款」走 12.1b 的 `carriedSpDumps`（暂停时该点数的 SP 就在它当前格）。
 */

const START: HexRef = { col: 57, row: 35 }

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 3.3b / 9.14c：运输点数＝非战斗、带运力点数的算子（本作用 `noncombatKind === 'transport_point'`） */
const transportPoint = () =>
  unitChoices('axis').find((record) => record.noncombatKind === 'transport_point')!

const armor = () =>
  unitChoices('axis').find(
    (record) =>
      record.classes?.movementClass === 'tracked' && (record.factors?.combat?.ma ?? 0) >= 8,
  )!

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side: 'axis', face: 'combat' })
  store.units.push(unit)
  return unit
}

/** 开拔并走一步（返回走了哪一格） */
function beginAndStep(store: ReturnType<typeof newStore>, unit: ConsoleUnit): HexRef {
  store.clickHex(unit.hex)
  expect(store.confirmMovePick()).toBe(true)
  const node = store.groupReachable.hexes[0]
  expect(node).toBeDefined()
  store.clickHex(node!.hex)
  expect(store.moveBlocked).toBeNull()
  return node!.hex
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('13.2a 运输点数：结束 / 暂停与继续', () => {
  it('★ #15：结束移动＝完成，别的单位可立即开拔（不再记"暂停"）', () => {
    const store = newStore()
    const point = place(store, transportPoint(), START, 'tp')
    const tank = place(store, armor(), { col: 57, row: 34 }, 'a1')
    store.setUnitFuelled(tank.instanceId, true)
    beginAndStep(store, point)
    store.finishMove()
    expect(point.movementEnded).toBe(true)
    // 修前：pausedIds 把运输点数记成"暂停"⇒ 别的单位开拔被 13.2a 拦住（#15）
    expect(store.log.some((entry) => entry.rule === '13.2a')).toBe(false)
    store.clickHex(tank.hex)
    expect(store.confirmMovePick()).toBe(true)
  })

  it('★ #15：已结束的运输点数没有开拔入口，也不能再开始移动', () => {
    const store = newStore()
    const point = place(store, transportPoint(), START, 'tp')
    beginAndStep(store, point)
    store.finishMove()
    expect(point.movementEnded).toBe(true)

    // 点它 ⇒ 不建立取子清单（界面因此没有「开始移动」按钮）
    store.clickHex(point.hex)
    expect(store.movePick).toBeNull()
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
  })

  it('★ 显式暂停后同一阶段内可继续，且 MP 累计（不是重新给一份 MA）', () => {
    const store = newStore()
    const point = place(store, transportPoint(), START, 'tp')
    beginAndStep(store, point)
    const afterFirst = point.mpSpent
    expect(afterFirst).toBeGreaterThan(0)

    // 13.2a：运输点数「暂停移动并使用它装载的部分补给」——显式动作
    expect(store.pauseTransportMove()).toBe(true)
    expect(point.movementEnded).toBe(true)

    // 继续：同一阶段内再次开拔，6.1g 的"本轮已结束"对它让路
    store.clickHex(point.hex)
    expect(store.confirmMovePick()).toBe(true)
    expect(point.movementEnded).toBe(false)
    const node = store.groupReachable.hexes[0]
    expect(node).toBeDefined()
    store.clickHex(node!.hex)
    expect(store.moveBlocked).toBeNull()
    // 累计：继续之后的总耗 MP 一定大于暂停时的那一笔
    expect(point.mpSpent).toBeGreaterThan(afterFirst)
  })

  it('★ 暂停期间「另一个单位」不得开拔（13.2a：必须先完成它的移动）', () => {
    const store = newStore()
    const point = place(store, transportPoint(), START, 'tp')
    const tank = place(store, armor(), { col: 57, row: 34 }, 'a1')
    beginAndStep(store, point)
    expect(store.pauseTransportMove()).toBe(true)
    expect(point.movementEnded).toBe(true)

    store.clickHex(tank.hex)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveBlocked).not.toBeNull()
    expect(store.moveBlocked!.rule).toBe('13.2a')

    // 让运输点数继续并走完剩余移动后，别的单位才放行（此处只验证"继续"这一半）
    store.clickHex(point.hex)
    expect(store.confirmMovePick()).toBe(true)
  })

  it('对照：普通单位结束移动后没有开拔入口，也不能续走（6.1g 不变）', () => {
    const store = newStore()
    const tank = place(store, armor(), START, 'a1')
    store.setUnitFuelled(tank.instanceId, true)
    beginAndStep(store, tank)
    store.finishMove()
    expect(tank.movementEnded).toBe(true)

    // #15：结束的实例被剔出取子池 ⇒ 不再出现「开始移动」，也不会走到引擎的 6.1g 拒绝
    store.clickHex(tank.hex)
    expect(store.movePick).toBeNull()
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
  })

  it('★ 暂停时装载的 SP 就是它当前格的补给来源（12.1b，用于"暂停时付款"）', () => {
    const store = newStore()
    const point = place(store, transportPoint(), START, 'tp')
    point.loadedSpT = 4 // 1 SP（12.1a：SP_TO_T = 4）
    beginAndStep(store, point)
    expect(store.pauseTransportMove()).toBe(true)
    const carried = store.allSpDumps.find((dump) => dump.id === `unit:${point.instanceId}`)
    expect(carried).toBeDefined()
    expect(carried!.hex).toEqual(point.hex)
    expect(carried!.sp).toBe(1)
  })
})
