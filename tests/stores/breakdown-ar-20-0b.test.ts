import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { actionGateOf, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'
import type { ConsoleUnit } from '@/stores'

/**
 * 20.0b：创建拆分单位时，母单位只能创建 **AR ≤ 自己** 的拆分单位。
 *
 * ★ 红→绿（A5-01）：修前 `createBreakdownNow` 把拆分子视图从母单位复制并令 `ar = parent.raw.ar`，
 *   于是「拆分子 AR > 母单位 AR」永远判不出来。修后按**所选拆分记录**的印值 AR 判。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function someHex(): HexRef {
  return { col: 34, row: 17 }
}

/** 苏方「其他」类型的多军力师（AR 2、2 军力）：20.0 可拆的唯一类型 */
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

function place(workbench: ReturnType<typeof useWorkbenchStore>, instanceId: string): ConsoleUnit {
  const unit = toConsoleUnit({
    record: parentRecord(),
    instanceId,
    hex: someHex(),
    side: 'soviet',
  })
  workbench.units.push(unit)
  return unit
}

/** 把母单位推进到 20.0a 的「开始移动」事件（唯一开窗入口） */
function startMoving(workbench: ReturnType<typeof useWorkbenchStore>, instanceId: string): void {
  workbench.setActiveSide('soviet')
  const allowed = actionGateOf('move.order')
    .where.filter((item) => item.phase === workbench.phase)
    .map((item) => item.segment)
  const index = workbench.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error('该段没有允许 move.order 的环节')
  if (!workbench.setSegmentStepIndex(index)) throw new Error('进入环节失败')
  if (!workbench.beginMoveFor([instanceId])) throw new Error('开始移动失败')
}

describe('A5-01 / 20.0b：创建拆分单位按所选算子的 AR 判定', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let parent: ConsoleUnit

  beforeEach(() => {
    workbench = newStore()
    parent = place(workbench, 'test-parent-ar2')
    startMoving(workbench, parent.instanceId)
  })

  it('AR3 的拆分子不能由 AR2 的母单位创建（红：修前会放行）', () => {
    const beforeSteps = parent.steps
    const beforePool = workbench.breakdownPool.su ?? 0
    const beforeUnits = workbench.units.length

    const ok = workbench.createBreakdownNow(
      parent.instanceId,
      'su-breakdown-russian-3-3-3-breakdown',
    )

    expect(ok).toBe(false)
    expect(workbench.log[0]?.rule).toBe('20.0b')
    expect(parent.steps).toBe(beforeSteps)
    expect(workbench.breakdownPool.su).toBe(beforePool)
    expect(workbench.units.length).toBe(beforeUnits)
  })

  it('AR2 的拆分子可由 AR2 的母单位创建（绿）', () => {
    const beforeSteps = parent.steps
    const beforePool = workbench.breakdownPool.su ?? 0
    const beforeUnits = workbench.units.length

    const ok = workbench.createBreakdownNow(
      parent.instanceId,
      'su-breakdown-russian-3-2-2-breakdown',
    )

    expect(ok).toBe(true)
    expect(parent.steps).toBe(beforeSteps - 1)
    expect(workbench.breakdownPool.su).toBe(beforePool - 1)
    expect(workbench.units.length).toBe(beforeUnits + 1)
    const created = workbench.units.find((unit) => unit.specialized.includes('breakdown'))
    expect(created?.re).toBe(1)
  })
})
