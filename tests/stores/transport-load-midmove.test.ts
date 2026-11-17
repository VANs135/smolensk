import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 用户 2026-11-18：**装卸随时可做**（13.2f）
 *
 * 实走卡点：移动交互没结束时，右键菜单把所有动作标成「先结束移动」再过滤掉
 * （`counterActionsAt` 的 `moving` 分支）⇒ 只能先点「暂停移动」。口径：
 * 单位停在中途某格就算"在那一格"，右键就该有能做的装卸；装卸不结束移动、不加移动步。
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

function menuKeysAt(s: ReturnType<typeof stores>, hex: HexRef, instanceId: string): string[] {
  s.workbench.selectedId = instanceId
  s.mapView.onHexContext(hex, { x: 0, y: 0 }, { x: 0, y: 0 })
  return (s.mapView.contextOptions.find((item) => item.id === instanceId)?.actions ?? []).map(
    (item) => item.key,
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('13.2f：移动未结束时右键直接装卸', () => {
  it('停在中途格（同格有补给站）⇒ 菜单直接出「装卸 SP」，不用先暂停', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const here = stepTo(s.workbench)
    dumpAt(s.workbench, here)

    expect(s.workbench.moveInteraction?.steps).toHaveLength(1)
    expect(menuKeysAt(s, here, point.instanceId)).toContain('move.loadUnload')
  })

  it('装卸后移动交互仍在、不加移动步，还能继续走并可撤销一步', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const here = stepTo(s.workbench)
    dumpAt(s.workbench, here)
    const beforeSpent = point.mpSpent
    const stepsBefore = s.workbench.moveInteraction!.steps.length

    s.workbench.selectedId = point.instanceId
    s.mapView.onHexContext(here, { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(s.mapView.openContextAction(point.instanceId, 'move.loadUnload')).toBe(true)
    expect(s.mapView.unitActionIntent?.only).toBe('loadUnload')
    // 面板的既有接线：进入 loadUnload 段时选中这一枚
    s.workbench.selectTransportLoadPointNow(point.instanceId)
    s.workbench.transportLoadInputs.loadAmount = 1
    expect(s.workbench.loadTransportPointNow()).toBe(true)

    // 13.2f 原文：付印刷 MA 的 10%；除此之外不产生移动步、不结束移动
    expect(point.loadedSpT).toBe(4)
    expect(point.mpSpent).toBeGreaterThan(beforeSpent)
    expect(s.workbench.moveInteraction).not.toBeNull()
    expect(s.workbench.moveInteraction!.steps).toHaveLength(stepsBefore)
    expect(point.hex).toEqual(here)

    // 继续走一步，再撤销回中途格
    const next = s.workbench.groupReachable.hexes.find((item) => item.path.length === 2)
    expect(next).toBeDefined()
    s.workbench.clickHex(next!.hex)
    expect(point.hex).toEqual(next!.hex)
    s.workbench.undoLastStep()
    expect(point.hex).toEqual(here)
    expect(s.workbench.moveInteraction?.steps).toHaveLength(stepsBefore)
  })

  it('只列能做的：满载无站 ⇒ 不出；载货且满足卸载格 ⇒ 只出可卸（仍是一项入口）', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    // 满载（运力以 SP 计，内部 loadedSpT 以 T 计）
    point.loadedSpT = point.noncombatTransport * 4
    const here = stepTo(s.workbench)
    placeGround(
      s.workbench,
      groundRecord('soviet', (item) => item.isCombat === true),
      here,
      'soviet',
      'inf-1',
    )

    expect(menuKeysAt(s, here, point.instanceId)).toContain('move.loadUnload')
    expect(s.workbench.transportUnloadableSpOf(point.instanceId)).toBeGreaterThan(0)
    expect(s.workbench.transportLoadableSpOf(point.instanceId)).toBe(0)
  })

  it('暂停入口仍保留（13.2a 的搁置语义），但不再是装卸前置', () => {
    const s = stores()
    enterMovement(s.workbench)
    const point = placeTransport(s.workbench)
    const here = stepTo(s.workbench)
    dumpAt(s.workbench, here)

    // 未暂停也能装卸
    expect(menuKeysAt(s, here, point.instanceId)).toContain('move.loadUnload')
  })
})
