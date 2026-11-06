import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { actionGateOf, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'
import type { ConsoleUnit } from '@/stores'

/**
 * A5-02 / A5-05 / A5-06：20.0 的其余判定在 **store 接线层**是否成立。
 * 20.0c 由"创建时复制母单位当前状态"结构性保证，20.0d 已由 `turn-victory-absorb-flow` 覆盖。
 */

const HEX: HexRef = { col: 34, row: 17 }

function newStore() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function parentRecord() {
  const found = unitChoices('soviet').find(
    (record) =>
      record.isCombat === true &&
      record.classes?.combatClass === 'other' &&
      record.factors?.combat?.ar === 2 &&
      (record.steps?.total ?? 1) >= 2 &&
      record.specialized?.includes('breakdown') !== true,
  )
  if (found === undefined) throw new Error('单位库里找不到 AR2 / 2 军力的 other 类型师')
  return found
}

function place(workbench: ReturnType<typeof useWorkbenchStore>): ConsoleUnit {
  const unit = toConsoleUnit({
    record: parentRecord(),
    instanceId: 'test-parent-20-0',
    hex: HEX,
    side: 'soviet',
  })
  workbench.units.push(unit)
  return unit
}

function enterMoveOrder(workbench: ReturnType<typeof useWorkbenchStore>): void {
  workbench.setActiveSide('soviet')
  const allowed = actionGateOf('move.order')
    .where.filter((item) => item.phase === workbench.phase)
    .map((item) => item.segment)
  const index = workbench.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error('该段没有允许 move.order 的环节')
  if (!workbench.setSegmentStepIndex(index)) throw new Error('进入环节失败')
}

describe('A5-02/05/06：20.0 其余条款（store 接线）', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let parent: ConsoleUnit

  beforeEach(() => {
    workbench = newStore()
    parent = place(workbench)
  })

  it('20.0a：只进环节、未开「开始移动」窗口 ⇒ 拒绝并给 20.0a', () => {
    enterMoveOrder(workbench) // 刻意不调用 beginMoveFor
    const ok = workbench.createBreakdownNow(
      parent.instanceId,
      'su-breakdown-russian-3-2-2-breakdown',
    )
    expect(ok).toBe(false)
    expect(workbench.log[0]?.rule).toBe('20.0a')
    expect(parent.steps).toBe(parentRecord().steps?.total ?? 0)
  })

  it('20.0e：创建的拆分单位本阶段未耗 MP（可在当阶段移动）', () => {
    enterMoveOrder(workbench)
    expect(workbench.beginMoveFor([parent.instanceId])).toBe(true)
    const ok = workbench.createBreakdownNow(
      parent.instanceId,
      'su-breakdown-russian-3-2-2-breakdown',
    )
    expect(ok).toBe(true)
    const created = workbench.units.find((unit) => unit.instanceId !== parent.instanceId)
    expect(created?.mpSpent).toBe(0)
  })

  it('20.0g：本方清单里没有他方拆分子 ⇒ 按 20.0g 拒绝', () => {
    enterMoveOrder(workbench)
    expect(workbench.beginMoveFor([parent.instanceId])).toBe(true)
    const ok = workbench.createBreakdownNow(
      parent.instanceId,
      'ax-breakdown-german-4-4-3-breakdown',
    )
    expect(ok).toBe(false)
    expect(workbench.log[0]?.rule).toBe('20.0g')
    expect(workbench.units.length).toBe(1)
  })
})
