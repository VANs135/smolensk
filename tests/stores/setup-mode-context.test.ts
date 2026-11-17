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
 * IV-B：初设右键换模式（用户 2026-11-18）
 *
 * 初设按**布设方**轮流操作；右键要作用于当前布设方，不能被"观察方＝行动方"挡住。
 * 预备模式只在剧本有可用预备标记且未被禁时出现；不可用项不出现。
 */

const START = { col: 57, row: 35 }

function place(
  store: ReturnType<typeof useWorkbenchStore>,
  side: 'axis' | 'soviet',
  id: string,
  hex = START,
) {
  const record = unitChoices(side).find(
    (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
  )
  if (record === undefined) throw new Error('单位库没有可用的徒步单位')
  const unit = toConsoleUnit({ record, instanceId: id, hex, side, face: 'combat' })
  store.units.push(unit)
  return unit
}

function openOn(hex = START) {
  const mapView = useMapViewStore()
  mapView.onHexContext(hex, hexCanvasPoint(hex), { x: 100, y: 100 }, 1)
  return mapView
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('初设右键按布设方出模式菜单', () => {
  it('★ 观察方停在另一方时，当前布设方右键仍出「初设模式」', () => {
    const setup = useSetupStore()
    setup.finished = false
    const workbench = useWorkbenchStore()
    useGameSessionStore().setScenarioId('1')
    workbench.initialSetupInProgress = true
    workbench.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    setup.setupSideCursor = 'soviet'
    place(workbench, 'soviet', 's1')
    const mapView = openOn()
    expect(mapView.popup?.variant).toBe('context')
    const actions = mapView.contextOptions.flatMap((group) => group.actions)
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every((action) => action.key.startsWith('setup.mode.'))).toBe(true)
  })

  it('★ 剧本禁止初设预备（剧本 3）⇒ 菜单里没有预备项', () => {
    const setup = useSetupStore()
    setup.finished = false
    const workbench = useWorkbenchStore()
    useGameSessionStore().setScenarioId('3')
    workbench.initialSetupInProgress = true
    workbench.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    setup.setupSideCursor = 'axis'
    place(workbench, 'axis', 'a1')
    const mapView = openOn()
    const actions = mapView.contextOptions.flatMap((group) => group.actions)
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.some((action) => action.key === 'setup.mode.reserve')).toBe(false)
  })

  it('★ 有可切换项时不写挡因（挡因只在空菜单时出）', () => {
    const setup = useSetupStore()
    setup.finished = false
    const workbench = useWorkbenchStore()
    useGameSessionStore().setScenarioId('1')
    workbench.initialSetupInProgress = true
    workbench.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    setup.setupSideCursor = 'axis'
    const unit = place(workbench, 'axis', 'a1')
    expect(workbench.setupSwitchableModesOf(unit.instanceId).length).toBeGreaterThan(0)
    expect(workbench.setupModeBlockNote(unit.instanceId)).toBeNull()
  })
})
