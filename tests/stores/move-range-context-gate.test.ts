import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { hexCanvasPoint } from '@/render/map-layout'
import {
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 可走范围只在**移动环节**投出（用户 2026-11-18）
 *
 * 两条同源缺陷：
 *   ① A 段整备点堆叠/单位仍出现可走格；
 *   ② 初设左键点单位/堆叠出现移动力范围（初设只做选中与堆叠显示）。
 * 收口方式：`groupReachable` 与 `overlay.reachable` 共用一个「移动语境」判据
 * （初始初设不投；非移动环节不投），不在一处写一遍。
 */

const START = { col: 57, row: 35 }

function place(store: ReturnType<typeof useWorkbenchStore>, id = 'u1') {
  const record = unitChoices('axis').find(
    (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
  )
  if (record === undefined) throw new Error('单位库没有可用的徒步单位')
  const unit = toConsoleUnit({ record, instanceId: id, hex: START, side: 'axis', face: 'combat' })
  store.units.push(unit)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('初设期不得投移动力范围', () => {
  it('★ 点格内空白（摊开堆叠）不建待开拔集，也不画可走格', () => {
    const setup = useSetupStore()
    setup.finished = false
    const workbench = useWorkbenchStore()
    useGameSessionStore().setScenarioId('1')
    workbench.initialSetupInProgress = true
    workbench.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    place(workbench)
    const mapView = useMapViewStore()
    const center = hexCanvasPoint(START)
    // 点在格内空白（靠六角边缘）⇒ 走「摊开堆叠」那条路
    mapView.onHexClick(START, { x: 100, y: 100 }, { x: center.x, y: center.y + 42 }, 1)
    expect(workbench.movePick).toBeNull()
    expect(workbench.groupReachable.hexes).toEqual([])
    expect(mapView.overlay.reachable).toEqual([])
  })

  it('★ 初设中即使残留待开拔集，也不投可走格', () => {
    const setup = useSetupStore()
    setup.finished = false
    const workbench = useWorkbenchStore()
    workbench.initialSetupInProgress = true
    workbench.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    const unit = place(workbench)
    workbench.movePick = { hex: START, ids: [unit.instanceId] }
    const mapView = useMapViewStore()
    expect(workbench.groupReachable.hexes).toEqual([])
    expect(mapView.overlay.reachable).toEqual([])
  })
})

describe('整备段不得投移动力范围', () => {
  it('★ A 段即使残留未结束的移动交互，也不画可走格', () => {
    useSetupStore().finished = true
    const workbench = useWorkbenchStore()
    workbench.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    const unit = place(workbench)
    workbench.setPhase('aircraftRefit')
    workbench.moveInteraction = {
      unitIds: [unit.instanceId],
      start: { ...START },
      steps: [],
      finished: false,
    }
    const mapView = useMapViewStore()
    expect(workbench.movementStepNow).toBe(false)
    expect(workbench.groupReachable.hexes).toEqual([])
    expect(mapView.overlay.reachable).toEqual([])
  })
})

describe('移动环节照常投出（防过度收口）', () => {
  it('★ C 段待开拔时有可走格，overlay 与 groupReachable 同源', () => {
    useSetupStore().finished = true
    const workbench = useWorkbenchStore()
    workbench.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    const unit = place(workbench)
    workbench.setPhase('movement')
    expect(workbench.movementStepNow).toBe(true)
    workbench.beginMovePick(START, [unit.instanceId])
    expect(workbench.groupReachable.hexes.length).toBeGreaterThan(0)
    const mapView = useMapViewStore()
    expect(mapView.overlay.reachable.length).toBe(workbench.groupReachable.hexes.length)
  })
})
