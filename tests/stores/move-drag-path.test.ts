import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { hexCanvasPoint, hexLineBetween } from '@/render/map-layout'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 用户 2026-11-18 走查：移动操作的两条分支
 *
 * ① 待开拔时点到「可进入、且格内有己方单位」的邻格，应**走进那一格**；
 *    现在被堆叠命中先吃掉，变成把那一格的堆叠选出来。
 * ② 选中堆叠后按住算子沿自选路径拖到目的地：沿途每格都必须合法；
 *    任一段不可进入就不移动并报「无法通行」及原因；成功则按实际路径扣 MP、可逐步撤销。
 *
 * 口径：拖拽与点目标格共用同一套引擎判据（`planStep`／`commitStep`），不另起一套。
 */

const START: HexRef = { col: 36, row: 13 }

type Workbench = ReturnType<typeof useWorkbenchStore>
type MapView = ReturnType<typeof useMapViewStore>

function newStores(): { workbench: Workbench; mapView: MapView } {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 徒步战斗单位（能走、能战斗；6.1 的移动主体） */
function combatRecord() {
  const found = unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )
  if (found === undefined) throw new Error('轴心单位库中没有徒步战斗单位')
  return found
}

function place(workbench: Workbench, instanceId: string, hex: HexRef = START) {
  const unit = toConsoleUnit({ record: combatRecord(), instanceId, hex, side: 'axis' })
  workbench.units.push(unit)
  return unit
}

/** 选一摞但**不开拔**（movePick 待定；复现①的状态） */
function pickAt(workbench: Workbench, hex: HexRef = START): void {
  workbench.setActiveSide('axis')
  workbench.setPhase('movement')
  workbench.clickHex(hex)
  expect(workbench.movePick).not.toBeNull()
}

/** 一步可达的邻格 */
function oneStepNode(workbench: Workbench, steps = 2) {
  const node = workbench.groupReachable.hexes.find((item) => item.path.length === steps)
  if (node === undefined) throw new Error(`可到达范围里没有 ${steps - 1} 步可达的格`)
  return node
}

/** 某单位在本场移动里已扣的 MP（按每一步的引擎账汇总） */
function spentOf(workbench: Workbench, unitId: string): number {
  return (workbench.moveInteraction?.steps ?? []).reduce(
    (sum, step) => sum + (step.costById[unitId] ?? 0),
    0,
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('① 可进入格优先按落点处理', () => {
  it('待开拔时点己方占位的可达邻格：走进去，不换选那一格', () => {
    const { workbench, mapView } = newStores()
    const mover = place(workbench, 'a1')
    pickAt(workbench)
    const target = oneStepNode(workbench)
    // 目标格里有另一支己方单位（不在取子清单里）
    const resident = place(workbench, 'a2', target.hex)

    mapView.onHexClick(target.hex, { x: 0, y: 0 }, hexCanvasPoint(target.hex), 1)

    expect(mover.hex).toEqual(target.hex)
    expect(workbench.moveInteraction?.steps).toHaveLength(1)
    // 不是把那一格的堆叠选出来
    expect(mapView.stackSelection).not.toContain(resident.instanceId)
    expect(workbench.movePick?.hex).not.toEqual(target.hex)
  })

  it('不可达的己方占位格仍然只是换选（没有待定落点时不改口径）', () => {
    const { workbench, mapView } = newStores()
    place(workbench, 'a1')
    pickAt(workbench)
    const far: HexRef = { col: 1, row: 1 }
    const resident = place(workbench, 'a2', far)

    mapView.onHexClick(far, { x: 0, y: 0 }, hexCanvasPoint(far), 1)

    expect(workbench.movePick?.hex).toEqual(far)
    expect(mapView.stackSelection).toEqual([resident.instanceId])
    expect(workbench.moveInteraction).toBeNull()
  })
})

describe('② 拖拽沿实际路径落子', () => {
  it('待开拔时拖两段：沿路径落子，按实际步数记账，撤销回退一步', () => {
    const { workbench, mapView } = newStores()
    const unit = place(workbench, 'a1')
    pickAt(workbench)
    const node = oneStepNode(workbench, 3)
    const path = node.path

    expect(mapView.dropMovingCounterAt(unit.instanceId, node.hex, { x: 0, y: 0 }, path)).toBe(true)

    expect(unit.hex).toEqual(node.hex)
    expect(workbench.moveInteraction?.steps).toHaveLength(2)
    expect(workbench.movePick).toBeNull()

    workbench.undoLastStep()
    expect(unit.hex).toEqual(path[1])
    expect(workbench.moveInteraction?.steps).toHaveLength(1)
  })

  it('终点可达但拖入的中段不可进入：整次不动，并报「无法通行」', () => {
    const { workbench, mapView } = newStores()
    const unit = place(workbench, 'a1')
    pickAt(workbench)
    const node = oneStepNode(workbench, 3)
    const [start, mid, end] = node.path
    // 中段格放敌人：终点仍可从别处绕到，但玩家拖过的这一段不可进入
    workbench.units.push(
      toConsoleUnit({ record: combatRecord(), instanceId: 'e1', hex: mid!, side: 'soviet' }),
    )

    expect(
      mapView.dropMovingCounterAt(unit.instanceId, end!, { x: 0, y: 0 }, [start!, mid!, end!]),
    ).toBe(true)

    expect(unit.hex).toEqual(START)
    expect(workbench.moveInteraction).toBeNull()
    expect(workbench.movePick).not.toBeNull()
    expect(workbench.moveBlocked?.reason).toContain('无法通行')
  })

  it('拖拽与点击同一目标格：判据与扣费一致', () => {
    const { workbench, mapView } = newStores()
    const byDrag = place(workbench, 'a1')
    pickAt(workbench)
    const target = oneStepNode(workbench, 3)
    expect(
      mapView.dropMovingCounterAt(byDrag.instanceId, target.hex, { x: 0, y: 0 }, target.path),
    ).toBe(true)
    const dragSteps = workbench.moveInteraction!.steps.length
    const dragMp = spentOf(workbench, byDrag.instanceId)

    const second = newStores()
    const byClick = place(second.workbench, 'a1')
    pickAt(second.workbench)
    second.workbench.clickHex(target.hex)

    expect(second.workbench.moveInteraction?.steps.length).toBe(dragSteps)
    expect(second.workbench.moveInteraction?.steps.map((step) => step.to)).toEqual(
      workbench.moveInteraction!.steps.map((step) => step.to),
    )
    expect(spentOf(second.workbench, byClick.instanceId)).toBe(dragMp)
  })
})

describe('拖动路径几何', () => {
  it('逐格补全为相邻格序列，且端点不变', () => {
    const path = hexLineBetween(START, { col: START.col + 2, row: START.row })
    expect(path[0]).toEqual(START)
    expect(path.at(-1)).toEqual({ col: START.col + 2, row: START.row })
    for (let index = 1; index < path.length; index += 1) {
      const a = path[index - 1]!
      const b = path[index]!
      expect(Math.abs(a.col - b.col) <= 1 && Math.abs(a.row - b.row) <= 1).toBe(true)
    }
  })
})
