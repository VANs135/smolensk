import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { combatRecord, groundRecord, label, newConsole, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'
import { CORE_HEX } from '../flows/sop-harness'

/**
 * 用户 2026-11-20：撤销不能只管初设，要收成**全局一个共用入口**
 *   · 同一个动作、同一套「最近一笔可撤操作」语义；
 *   · 覆盖所有不涉及掷骰检定的操作（移动步、装卸、建造标记、换轨、建造、加油/整备……）；
 *   · 本段掷过骰 ⇒ 统一拒绝并给出原因；
 *   · 跨族顺序必须严格：移动 → 装卸 → 撤销 → 再撤销，先退装卸、再退移动。
 */

const START: HexRef = { col: 15, row: 10 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  useHotseatStore().setViewerSide('soviet')
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
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

function placeTransport(workbench: Workbench, id = 'tp-1') {
  const record = groundRecord(
    'soviet',
    (item) =>
      item.noncombatKind === 'transport_point' && (item.noncombatDetails?.transport ?? 0) >= 2,
  )
  return placeGround(workbench, record, START, 'soviet', id)
}

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

describe('共用撤销入口：按发生顺序退最近一笔', () => {
  it('★ 移动一步 → 装载 SP → 撤销：先退装卸，再撤一次才退移动', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const here = stepOnce(s.workbench)
    s.workbench.spDumps.push({ id: 'd1', hex: { ...here }, side: 'soviet', sp: 4, t: 0 })
    const mpBeforeLoad = point.mpSpent
    loadOne(s.workbench, point.instanceId)
    expect(point.loadedSpT).toBe(4)

    // 第一撤：退装卸（SP 回站、载荷归零、装卸所付 MP 一并退回），位置不变
    expect(s.workbench.undoLastOperationNow()).toBe(true)
    expect(point.loadedSpT).toBe(0)
    expect(point.hex).toEqual(here)
    expect(point.mpSpent).toBe(mpBeforeLoad)
    expect(s.workbench.spDumps.find((item) => item.id === 'd1')).toMatchObject({ sp: 4, t: 0 })

    // 第二撤：退移动步，回到起点、MP 归零
    expect(s.workbench.undoLastOperationNow()).toBe(true)
    expect(point.hex).toEqual(START)
    expect(point.mpSpent).toBe(0)
    expect(s.workbench.moveInteraction?.steps).toHaveLength(0)

    // 账已清空
    expect(s.workbench.canUndoOperation).toBe(false)
    expect(s.workbench.undoLastOperationNow()).toBe(false)
  })

  it('结束移动（=提交）后，统一入口不再退移动', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const here = stepOnce(s.workbench)
    s.workbench.finishMove()
    const before = { hex: { ...point.hex }, mp: point.mpSpent }

    expect(s.workbench.canUndoOperation).toBe(false)
    expect(s.workbench.undoLastOperationNow()).toBe(false)
    expect(point.hex).toEqual(before.hex)
    expect(point.mpSpent).toBe(before.mp)
    expect(point.hex).toEqual(here)
  })
})

describe('共用撤销入口：掷骰封账', () => {
  it('★ 本段掷过骰后统一拒绝，任何族都不动盘面', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const here = stepOnce(s.workbench)
    s.workbench.spDumps.push({ id: 'd1', hex: { ...here }, side: 'soviet', sp: 4, t: 0 })
    loadOne(s.workbench, point.instanceId)
    const before = { hex: { ...point.hex }, mp: point.mpSpent, load: point.loadedSpT }

    s.workbench.recordSettlement({
      action: 'combat',
      rule: '9.2',
      rolls: [{ count: 1, faces: [3], total: 3 }],
    })

    expect(s.workbench.canUndoOperation).toBe(false)
    expect(s.workbench.undoLastOperationNow()).toBe(false)
    expect(point.hex).toEqual(before.hex)
    expect(point.mpSpent).toBe(before.mp)
    expect(point.loadedSpT).toBe(before.load)
    expect(s.workbench.spDumps.find((item) => item.id === 'd1')?.sp).toBe(3)
    expect(s.workbench.log[0]?.text).toContain('掷骰')
  })
})

describe('共用撤销入口：快照族（建造标记）', () => {
  it('★ 放置建造标记后撤销 ⇒ 枚数与标记落位一起还原', () => {
    setActivePinia(createPinia())
    const workbench = newConsole()
    workbench.setPhase('movement')
    placeGround(workbench, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    expect(workbench.constructionMarkers).toBe(3)
    expect(workbench.useConstructionMarkerNow('bridge', label(CORE_HEX))).toBe(true)
    expect(workbench.constructionMarkers).toBe(2)
    expect(workbench.constructionMarkerPieces).toHaveLength(1)

    expect(workbench.canUndoOperation).toBe(true)
    expect(workbench.undoLastOperationNow()).toBe(true)
    expect(workbench.constructionMarkers).toBe(3)
    expect(workbench.constructionMarkerPieces).toHaveLength(0)

    // 只有这一笔；再撤就空了
    expect(workbench.undoLastOperationNow()).toBe(false)
  })
})
