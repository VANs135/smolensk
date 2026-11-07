import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { areAdjacent } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * P5（UI4/UI5 反馈缺口）：对局台的**移动额度投影**（`moveBudgetRows`）
 *
 * 钉住三件事：
 *   ① 未开始移动 ⇒ 空表（界面没什么可显示）；
 *   ② 开拔后逐单位给出 `{ instanceId, availableMa, spent, remaining, ended }`，
 *      且 `spent` 与单位自身的 `mpSpent` **同源**、`remaining = availableMa − spent`；
 *   ③ 走一步后 `spent` 增、`remaining` 减，恒等式仍成立（6.1h 不取整）。
 *
 * 额度判据来自引擎 `availableMaOf`，本投影不另立规则 ⇒ 断言只需复算同一个减法。
 */

const START: HexRef = { col: 36, row: 13 }

function newStore() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 取一个满足条件的单位库记录（找不到即测试失败，避免静默用错夹具） */
function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
  face: 'combat' | 'move' = 'combat',
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face })
  store.units.push(unit)
  return unit
}

const legCombat = () =>
  pickRecord(
    'axis',
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )

describe('P5：移动额度投影（moveBudgetRows）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('没有移动时会话 ⇒ 投影为空表', () => {
    place(store, legCombat(), START, 'axis', 'a1')
    expect(store.moveBudgetRows).toEqual([])
  })

  it('开拔后逐单位给出可用 / 已耗 / 剩余（剩余＝可用−已耗，6.1h 不取整）', () => {
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)

    const rows = store.moveBudgetRows
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.instanceId).toBe(unit.instanceId)
    expect(row.availableMa).toBeGreaterThan(0)
    expect(row.spent).toBe(unit.mpSpent)
    expect(row.remaining).toBe(row.availableMa - row.spent)
    expect(row.ended).toBe(false)
  })

  it('走一步 ⇒ spent 增、remaining 减，且 remaining 恒等于 availableMa − spent', () => {
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)

    const before = store.moveBudgetRows[0]!
    const node = store.groupReachable.hexes.find((item) => areAdjacent(START, item.hex))
    expect(node).toBeDefined()

    store.clickHex(node!.hex)

    const after = store.moveBudgetRows[0]!
    expect(after.availableMa).toBe(before.availableMa)
    expect(after.spent).toBe(unit.mpSpent)
    expect(after.spent).toBeGreaterThan(before.spent)
    expect(after.remaining).toBeLessThan(before.remaining)
    // 6.1h：不取整 —— 精确到浮点，不做任何 Math.floor / Math.round
    expect(after.remaining).toBe(after.availableMa - after.spent)
  })
})
