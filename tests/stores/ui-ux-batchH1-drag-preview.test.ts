import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { hexCanvasPoint } from '@/render/map-layout'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 批 H1 / H2：**地图内拖动落子 + 只读悬停预览**（用户 2026-11-16）
 *
 * H1 口径：拖一枚**本次移动中的**算子到地图内的格 = 点该格（一步落子）；
 *   拖到图外盒仍走既有盒逻辑；拖放失败的原因必须与点击一致（`moveBlocked`）。
 * H2 口径：悬停只**读**引擎已算好的可到达范围与单步预览，给出「累计 / 本步 MP」；
 *   不写移动步、不改单位、不改选中集合，也不改变取子清单。
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

/** 选一摞并开拔（与面板同一条链：clickHex → confirmMovePick） */
function beginMove(workbench: Workbench, unitHex: HexRef = START) {
  workbench.setActiveSide('axis')
  workbench.setPhase('movement')
  const unit = place(workbench, 'a1', unitHex)
  workbench.clickHex(unitHex)
  expect(workbench.confirmMovePick()).toBe(true)
  return unit
}

function oneStepNode(workbench: Workbench) {
  const node = workbench.groupReachable.hexes.find((item) => item.path.length === 2)
  if (node === undefined) throw new Error('可到达范围里没有一步可达的格')
  return node
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('H1：拖动本次移动中的算子到格 = 点该格', () => {
  it('拖到一步可达格：单位落位、记一步（与点击同一条链）', () => {
    const { workbench, mapView } = newStores()
    const unit = beginMove(workbench)
    const target = oneStepNode(workbench)

    expect(mapView.dropMovingCounterAt(unit.instanceId, target.hex, { x: 0, y: 0 })).toBe(true)

    expect(unit.hex).toEqual(target.hex)
    expect(workbench.moveInteraction!.steps).toHaveLength(1)
    expect(workbench.moveInteraction!.steps[0]!.to).toEqual(target.hex)
  })

  it('不在移动中的算子拖不动：返回 false 且盘面不变', () => {
    const { workbench, mapView } = newStores()
    beginMove(workbench)
    const other = place(workbench, 'a2', { col: 37, row: 13 })
    const before = JSON.stringify(workbench.units)

    expect(
      mapView.dropMovingCounterAt(other.instanceId, { col: 35, row: 13 }, { x: 0, y: 0 }),
    ).toBe(false)
    expect(JSON.stringify(workbench.units)).toBe(before)
    expect(workbench.moveInteraction!.steps).toHaveLength(0)
  })

  it('拖到不可达格：不落位，原因与点击同一格一致', () => {
    const { workbench, mapView } = newStores()
    const unit = beginMove(workbench)
    const far: HexRef = { col: 1, row: 1 }

    expect(mapView.dropMovingCounterAt(unit.instanceId, far, { x: 0, y: 0 })).toBe(true)
    expect(unit.hex).toEqual(START)
    expect(workbench.moveInteraction!.steps).toHaveLength(0)
    expect(workbench.moveBlocked).not.toBeNull()
    const byDrop = { ...workbench.moveBlocked! }

    // 点击同一格：同样的拒绝原因（拖放失败必须与点击说同一句话）
    workbench.moveBlocked = null
    workbench.clickHex(far)
    expect(workbench.moveBlocked).toEqual(byDrop)
  })

  it('只有本次移动中的算子可作拖动源；结束后不再可拖', () => {
    const { workbench, mapView } = newStores()
    const unit = beginMove(workbench)
    const center = hexCanvasPoint(START)

    expect(mapView.counterForMoveDragAt(START, center, 1)?.id).toBe(unit.instanceId)
    const idle = place(workbench, 'a2', { col: 37, row: 13 })
    expect(
      mapView.counterForMoveDragAt({ col: 37, row: 13 }, hexCanvasPoint({ col: 37, row: 13 }), 1),
    ).toBeNull()
    expect(idle.instanceId).not.toBe(unit.instanceId)

    workbench.finishMove()
    expect(mapView.counterForMoveDragAt(START, center, 1)).toBeNull()
  })
})

describe('H2：悬停预览只读', () => {
  it('给出累计 / 本步 MP，且不动任何状态', () => {
    const { workbench } = newStores()
    beginMove(workbench)
    const target = oneStepNode(workbench)
    const beforeUnits = JSON.stringify(workbench.units)
    const beforeSteps = workbench.moveInteraction!.steps.length
    const beforeSelected = workbench.selectedId
    const beforePick = JSON.stringify(workbench.movePick)

    const text = workbench.hoverPreviewAt(target.hex)

    expect(text).toContain('累计')
    expect(text).toContain(`${target.mpSpent} MP`)
    expect(text).toContain('本步')
    expect(JSON.stringify(workbench.units)).toBe(beforeUnits)
    expect(workbench.moveInteraction!.steps).toHaveLength(beforeSteps)
    expect(workbench.selectedId).toBe(beforeSelected)
    expect(JSON.stringify(workbench.movePick)).toBe(beforePick)
    // 预览不自带悬停写入：读之前之后 `hoverHex` 不变
    expect(workbench.hoverHex).toBeNull()
  })

  it('没有移动交互 / 非可达格时不给预览', () => {
    const { workbench } = newStores()
    expect(workbench.hoverPreviewAt(START)).toBeNull()

    beginMove(workbench)
    expect(workbench.hoverPreviewAt({ col: 1, row: 1 })).toBeNull()
    expect(workbench.hoverPreviewAt(null)).toBeNull()
  })
})
