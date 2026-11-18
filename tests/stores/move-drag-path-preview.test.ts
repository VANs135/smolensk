import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 用户 2026-11-18：拖动移动时的**路径预览**
 *
 * 口径：与「沿自选路径拖拽落位」同一套判据（`planStep` / `commitStep` 的预演），
 * 只读——不写步、不动单位、不动取子清单；路径走不通时返回 ok=false，
 * 画布据此**不画落位终点**。
 */

const START: HexRef = { col: 36, row: 13 }

type Workbench = ReturnType<typeof useWorkbenchStore>
type MapView = ReturnType<typeof useMapViewStore>

function newStores(): { workbench: Workbench; mapView: MapView } {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

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

function pickAt(workbench: Workbench, hex: HexRef = START): void {
  workbench.setActiveSide('axis')
  workbench.setPhase('movement')
  workbench.clickHex(hex)
  expect(workbench.movePick).not.toBeNull()
}

function pathOf(workbench: Workbench, steps: number): HexRef[] {
  const node = workbench.groupReachable.hexes.find((item) => item.path.length === steps)
  if (node === undefined) throw new Error(`可到达范围里没有 ${steps - 1} 步可达的格`)
  return node.path
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('拖动路径预览：只读且与落位同判据', () => {
  it('★ 可达路径 ⇒ ok=true，盘面与移动账一动不动', () => {
    const { workbench, mapView } = newStores()
    place(workbench, 'a1')
    pickAt(workbench)
    const path = pathOf(workbench, 3)
    const beforeUnits = JSON.stringify(workbench.units)
    const beforePick = JSON.stringify(workbench.movePick)
    const beforeSteps = workbench.moveInteraction?.steps.length ?? 0
    const beforeBlocked = workbench.moveBlocked

    expect(mapView.previewMoveDragPath(path)).toEqual({ ok: true })

    expect(JSON.stringify(workbench.units)).toBe(beforeUnits)
    expect(JSON.stringify(workbench.movePick)).toBe(beforePick)
    expect(workbench.moveInteraction?.steps.length ?? 0).toBe(beforeSteps)
    expect(workbench.moveBlocked).toBe(beforeBlocked)
  })

  it('★ 中段被敌人占住 ⇒ ok=false（与落位同一拒绝原因），仍不写盘面', () => {
    const { workbench, mapView } = newStores()
    place(workbench, 'a1')
    pickAt(workbench)
    const [start, mid, end] = pathOf(workbench, 3)
    workbench.units.push(
      toConsoleUnit({ record: combatRecord(), instanceId: 'e1', hex: mid!, side: 'soviet' }),
    )
    const beforeUnits = JSON.stringify(workbench.units)

    const verdict = mapView.previewMoveDragPath([start!, mid!, end!])

    expect(verdict.ok).toBe(false)
    expect(workbench.moveInteraction).toBeNull()
    expect(JSON.stringify(workbench.units)).toBe(beforeUnits)
    expect(workbench.moveBlocked).toBeNull()
  })

  it('★ 没有待移动单位（未取子）⇒ ok=false，不抛错', () => {
    const { workbench, mapView } = newStores()

    expect(workbench.previewDraggedPath([START, { col: START.col + 1, row: START.row }]).ok).toBe(
      false,
    )
    // 画布在拖动开始时也只会给到起点一格
    expect(mapView.previewMoveDragPath([START]).ok).toBe(false)
    expect(mapView.previewMoveDragPath([]).ok).toBe(false)
  })

  it('★ 开拔后（已有移动交互）同样能预览续走的路径', () => {
    const { workbench, mapView } = newStores()
    place(workbench, 'a1')
    pickAt(workbench)
    const path = pathOf(workbench, 3)
    expect(workbench.confirmMovePick()).toBe(true)

    expect(mapView.previewMoveDragPath(path)).toEqual({ ok: true })
  })
})
