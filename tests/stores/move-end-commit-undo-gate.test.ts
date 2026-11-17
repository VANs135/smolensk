import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 用户 2026-11-18 实走缺陷：
 *   ① 走一段 →「结束移动」→ 关掉移动窗，单位自动回到起点、MP 回满（等于免费重走）；
 *   ② 若移动的是运输点数并装了 SP，回滚后 SP 仍留在车上 ⇒ 装载白拿；
 *   ③ 经过任何掷骰结算后，「撤销一步 / 放弃本次移动」必须直接不可用。
 *
 * 口径：结束移动即提交；关窗只关窗，不动单位位置与 MP；装卸与移动同一本账；
 *       本步/本段只要掷过骰，撤销入口不再出现，强行调用也不改盘面。
 */

const START: HexRef = { col: 15, row: 10 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  useHotseatStore().setViewerSide('soviet')
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

function placeTransport(workbench: Workbench, id = 'tp-1') {
  const record = groundRecord(
    'soviet',
    (item) =>
      item.noncombatKind === 'transport_point' && (item.noncombatDetails?.transport ?? 0) >= 2,
  )
  return placeGround(workbench, record, START, 'soviet', id)
}

function placeInfantry(workbench: Workbench, id = 'inf-1') {
  return placeGround(
    workbench,
    groundRecord('soviet', (item) => item.isCombat === true),
    START,
    'soviet',
    id,
  )
}

function enterMovement(workbench: Workbench): void {
  workbench.setActiveSide('soviet')
  workbench.setPhase('movement')
  const index = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'movement.modeAndMovement',
  )
  expect(index).toBeGreaterThanOrEqual(0)
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
}

/** 开拔并走一步，返回落点 */
function stepOnce(workbench: Workbench): HexRef {
  workbench.clickHex(START)
  const node = workbench.groupReachable.hexes.find((item) => item.path.length === 2)
  if (node === undefined) throw new Error('可到达范围里没有一步可达的格')
  workbench.clickHex(node.hex)
  expect(workbench.moveInteraction?.steps).toHaveLength(1)
  return node.hex
}

function loadOne(workbench: Workbench, instanceId: string): void {
  workbench.selectTransportLoadPointNow(instanceId)
  workbench.transportLoadInputs.loadAmount = 1
  expect(workbench.loadTransportPointNow()).toBe(true)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('结束移动即提交，关窗不得回滚', () => {
  it('普通单位：结束移动后关窗，位置与 MP 都不动，会话收起', () => {
    const s = stores()
    enterMovement(s.workbench)
    const unit = placeInfantry(s.workbench)
    const here = stepOnce(s.workbench)
    const mpAfterStep = unit.mpSpent
    expect(mpAfterStep).toBeGreaterThan(0)

    s.workbench.finishMove()
    expect(unit.hex).toEqual(here)
    expect(s.workbench.canUndoStep).toBe(false)
    expect(s.workbench.canAbortMove).toBe(false)

    expect(s.mapView.cancelSession()).toBe(true)
    expect(unit.hex).toEqual(here)
    expect(unit.mpSpent).toBe(mpAfterStep)
    expect(s.workbench.moveInteraction).toBeNull()
    expect(s.workbench.log[0]?.text).not.toContain('取消本次移动')
  })

  it('运输点数：结束移动后关窗，装载的 SP、MP、位置一起保留', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const here = stepOnce(s.workbench)
    s.workbench.spDumps.push({ id: 'd1', hex: { ...here }, side: 'soviet', sp: 4, t: 0 })
    loadOne(s.workbench, point.instanceId)
    const mpAfterLoad = point.mpSpent
    expect(point.loadedSpT).toBe(4)

    s.workbench.finishMove()
    expect(s.mapView.cancelSession()).toBe(true)

    expect(point.hex).toEqual(here)
    expect(point.mpSpent).toBe(mpAfterLoad)
    expect(point.loadedSpT).toBe(4)
    expect(s.workbench.spDumps.find((item) => item.id === 'd1')).toMatchObject({ sp: 3, t: 0 })
    expect(s.workbench.moveInteraction).toBeNull()
  })
})

describe('撤销闸门：经过掷骰结算后不可撤销', () => {
  it('本段掷过骰后，后续移动步也不能撤销，强行撤销不动盘面', () => {
    const s = stores()
    enterMovement(s.workbench)
    const unit = placeInfantry(s.workbench)
    stepOnce(s.workbench)

    s.workbench.recordSettlement({
      action: 'combat',
      rule: '9.2',
      rolls: [{ count: 1, faces: [3], total: 3 }],
    })

    const second = s.workbench.groupReachable.hexes.find((item) => item.path.length === 2)
    expect(second).toBeDefined()
    s.workbench.clickHex(second!.hex)
    expect(s.workbench.moveInteraction?.steps.length).toBe(2)

    const hexBefore = { ...unit.hex }
    const mpBefore = unit.mpSpent
    expect(s.workbench.canUndoStep).toBe(false)
    expect(s.workbench.undoBlockedReason).toContain('掷骰')
    expect(s.workbench.canAbortMove).toBe(false)

    s.workbench.undoLastStep()
    expect(unit.hex).toEqual(hexBefore)
    expect(unit.mpSpent).toBe(mpBefore)
    expect(s.workbench.moveInteraction?.steps.length).toBe(2)
  })

  it('本段掷过骰后，放弃本次移动也不可用，强行调用不回滚', () => {
    const s = stores()
    enterMovement(s.workbench)
    const unit = placeInfantry(s.workbench)
    const here = stepOnce(s.workbench)
    s.workbench.recordSettlement({
      action: 'supplyRoll',
      rule: '12.6',
      rolls: [{ count: 2, faces: [2, 5], total: 7 }],
    })
    const mpBefore = unit.mpSpent

    expect(s.workbench.canAbortMove).toBe(false)
    expect(s.workbench.abortMoveNow()).toBe(false)
    expect(unit.hex).toEqual(here)
    expect(unit.mpSpent).toBe(mpBefore)
  })
})
