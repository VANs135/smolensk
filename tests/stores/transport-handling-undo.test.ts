import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 13.2f：装卸也是"一步"——撤销要把 MP 与载荷一起退回
 *
 * 用户 2026-11-18 实走口径：「装完继续走、装完撤销（MP 与载荷都要回退）」。
 * 修前 `undoLastStep()` 只认识移动步，装卸只写结算日志、不进撤销账 ⇒
 * 快速撤销只能退走步，装卸的 MP / SP 留在原地。
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

function dumpAt(workbench: Workbench, hex: HexRef, sp = 4, id = 'd1') {
  workbench.spDumps.push({ id, hex: { ...hex }, side: 'soviet', sp, t: 0 })
  return id
}

function dumpHoldings(workbench: Workbench, id: string): { sp: number; t: number } {
  const dump = workbench.spDumps.find((item) => item.id === id)
  if (dump === undefined) throw new Error('dump missing')
  return { sp: dump.sp, t: dump.t }
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

/** 走一步（待开拔 → 点可达邻格） */
function stepTo(workbench: Workbench, hex: HexRef = START): HexRef {
  workbench.clickHex(hex)
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

describe('13.2f：装卸撤销', () => {
  it('移动交互中装载后撤销：MP、载荷、补给站一起退回，移动步不动', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const here = stepTo(s.workbench)
    const dumpId = dumpAt(s.workbench, here, 4)
    const spBefore = dumpHoldings(s.workbench, dumpId)
    const mpBefore = point.mpSpent
    const stepsBefore = s.workbench.moveInteraction!.steps.length

    loadOne(s.workbench, point.instanceId)
    expect(point.loadedSpT).toBe(4)
    expect(point.mpSpent).toBeGreaterThan(mpBefore)
    expect(dumpHoldings(s.workbench, dumpId)).toEqual({ sp: 3, t: 0 })

    expect(s.workbench.undoTransportHandlingNow()).toBe(true)
    expect(point.loadedSpT).toBe(0)
    expect(point.mpSpent).toBe(mpBefore)
    expect(dumpHoldings(s.workbench, dumpId)).toEqual(spBefore)
    expect(s.workbench.moveInteraction?.steps).toHaveLength(stepsBefore)
    expect(point.hex).toEqual(here)
  })

  it('没有移动交互（停在起点装载）也能撤销', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const dumpId = dumpAt(s.workbench, START, 4)
    const mpBefore = point.mpSpent

    loadOne(s.workbench, point.instanceId)
    expect(point.loadedSpT).toBe(4)
    expect(s.workbench.moveInteraction).toBeNull()

    expect(s.workbench.undoTransportHandlingNow()).toBe(true)
    expect(point.loadedSpT).toBe(0)
    expect(point.mpSpent).toBe(mpBefore)
    expect(dumpHoldings(s.workbench, dumpId)).toEqual({ sp: 4, t: 0 })
  })

  it('先装卸再走一步：撤销先退走步，再退装卸（按发生顺序）', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const dumpId = dumpAt(s.workbench, START, 4)
    const mpBefore = point.mpSpent

    loadOne(s.workbench, point.instanceId)
    // 装完从起点开拔（选中 → 再走一步）
    s.workbench.clickHex(START)
    const next = s.workbench.groupReachable.hexes.find((item) => item.path.length === 2)
    expect(next).toBeDefined()
    s.workbench.clickHex(next!.hex)
    expect(point.hex).toEqual(next!.hex)
    const mpAfterMove = point.mpSpent

    // 最近一步是移动：装卸撤销让位
    expect(s.workbench.undoTransportHandlingNow()).toBe(false)
    s.workbench.undoLastStep()
    expect(point.hex).toEqual(START)
    expect(point.loadedSpT).toBe(4)

    expect(s.workbench.undoTransportHandlingNow()).toBe(true)
    expect(point.loadedSpT).toBe(0)
    expect(point.mpSpent).toBe(mpBefore)
    expect(dumpHoldings(s.workbench, dumpId)).toEqual({ sp: 4, t: 0 })
    expect(mpAfterMove).toBeGreaterThan(mpBefore)
  })

  it('卸载后撤销：载荷、MP、落下的补给一并回退', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    // 卸载需要同格有友方战斗单位
    placeGround(
      s.workbench,
      groundRecord('soviet', (item) => item.isCombat === true),
      START,
      'soviet',
      'inf-1',
    )
    point.loadedSpT = 8
    const mpBefore = point.mpSpent
    s.workbench.selectTransportLoadPointNow(point.instanceId)
    s.workbench.transportLoadInputs.unloadAmount = 1
    expect(s.workbench.unloadTransportPointNow()).toBe(true)
    expect(point.loadedSpT).toBe(4)
    expect(point.mpSpent).toBeGreaterThan(mpBefore)

    expect(s.workbench.undoTransportHandlingNow()).toBe(true)
    expect(point.loadedSpT).toBe(8)
    expect(point.mpSpent).toBe(mpBefore)
    // 卸载新建的那本补给站整条回退（12.2a 接力锁同快照回退，见实现）
    expect(
      s.workbench.spDumps.find((item) => item.hex.col === START.col && item.hex.row === START.row),
    ).toBeUndefined()
  })
})
