import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { isReplUnit, replRecordOf, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 用户 2026-11-10 实机 #8：**移动只按玩家点选的集合走，不得自动扩堆叠**
 *
 * 现场：移动栏只选了 900 摩步旅，移动准备窗却显示「当前选中：Ge Pax Repl」，
 * 同格的补员算子也被收进待开拔。
 *
 * 判据（6.1f「取子」/ 8.1h「未勾选者留在格内」）：
 *   · 开拔集＝玩家点选/勾选的那些实例，任何路径都不得把未选中的同格算子塞进来；
 *   · 补员算子（13.5，`replKind !== null`）不在可开拔池里 ⇒ 不能被顺手带走；
 *   · 它仍可按 §5-D ③ 用自己的入口单独移动（`beginMoveFor([repl])`），本文件不改那条链。
 */
const HEX: HexRef = { col: 36, row: 13 }

type Store = ReturnType<typeof useWorkbenchStore>

/** 徒步战斗单位（能走、能战斗；6.1 的移动主体，且不触发 12.5a 加油） */
function combatRecord() {
  const found = unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.ma ?? 0) >= 2,
  )
  if (found === undefined) throw new Error('轴心单位库中没有徒步战斗单位')
  return found
}

function place(store: Store, record: ReturnType<typeof unitChoices>[number], instanceId: string) {
  const unit = toConsoleUnit({ record, instanceId, hex: HEX, side: 'axis' })
  store.units.push(unit)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('#8：点选集合＝开拔集合，不自动扩堆叠', () => {
  it('只选摩步旅：同格的补员算子不得被带进开拔集', () => {
    const store = useWorkbenchStore()
    store.setActiveSide('axis')
    store.setPhase('movement')
    const brigade = place(store, combatRecord(), 'b1')
    const repl = place(store, replRecordOf('axis', 'pax')!, 'r1')
    expect(isReplUnit(repl)).toBe(true)

    // 点这一格 ⇒ 取子清单只应有战斗单位
    store.clickHex(HEX)
    expect(store.movePick?.ids).toEqual([brigade.instanceId])
    expect(store.movePickChoices.some((unit) => isReplUnit(unit))).toBe(false)

    // 任何把补员算子塞进选中集的路径（地图点枚 / 堆叠窗 chip）都必须被裁掉
    store.setMovePickIds([brigade.instanceId, repl.instanceId])
    expect(store.movePick?.ids).toEqual([brigade.instanceId])
    store.toggleMovePick(repl.instanceId)
    expect(store.movePick?.ids).toEqual([brigade.instanceId])

    // 开拔的实例集合＝点选集合
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual([brigade.instanceId])
  })
})
