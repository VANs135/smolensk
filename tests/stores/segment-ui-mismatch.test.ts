import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import {
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * #5 / #6（用户 2026-11-10）：**环节与 UI 错配**
 *
 * ① 重建环节（B 段，13.5）点堆叠不得出现「开始移动」；
 * ② 突围环节（C 段，12.8e）点堆叠不得被「移动准备（6.1）」顶掉。
 *
 * 根因同一条：点堆叠在所有环节都走 `expandStackAt → beginMovePick`，修前无条件建取子。
 * 判据改为闸门 `move.order`（6.x 的三个移动环节）——与引擎同源。
 */

const INTERIOR: HexRef = (() => {
  for (const hex of mapLayers.hexes) {
    if (hex.col < 12 || hex.col > 40 || hex.row < 12 || hex.row > 24) continue
    const here: HexRef = { col: hex.col, row: hex.row }
    const open = HEX_DIRECTIONS.every((direction) => {
      const next = neighbor(here, direction)
      return mapLayers.hexes.some((item) => item.col === next.col && item.row === next.row)
    })
    if (open) return here
  }
  throw new Error('地图上找不到全邻居的内部格')
})()

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

type Stores = ReturnType<typeof newStores>

const combatRecord = () => unitChoices('axis').find((record) => record.isCombat === true)!

function place(
  store: Stores['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  instanceId: string,
) {
  const unit = toConsoleUnit({ record, instanceId, hex, side: 'axis' })
  store.units.push(unit)
  return unit
}

function goToStep(store: Stores['workbench'], id: string): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === id)
  expect(index).toBeGreaterThanOrEqual(0)
  expect(store.setSegmentStepIndex(index)).toBe(true)
  expect(store.segmentStep?.id).toBe(id)
}

describe('#6 突围环节：点堆叠不弹「开始移动」，本环节只认突围会话', () => {
  it('★ 突围环节点堆叠 ⇒ 不建取子、会话不是「移动准备」；开突围会话才是 breakout', () => {
    const { workbench, mapView } = newStores()
    const session = useGameSessionStore()
    // 12.8e 首回合豁免：与 advance-segment 用同一套"真能突围"的夹具
    const cutOff = toConsoleUnit({
      record: combatRecord(),
      instanceId: 'cut-off',
      hex: { col: 36, row: 13 },
      side: 'axis',
    })
    cutOff.hasTraceSupply = false
    workbench.units.push(cutOff)
    session.startGame()
    session.advanceToNextStop()
    session.advanceToNextStop()
    session.advanceToNextStop()
    expect(session.records?.phase).toBe('movement')
    workbench.units.find((unit) => unit.instanceId === 'cut-off')!.cutSinceTurn = workbench.turn - 1

    goToStep(workbench, 'movement.breakout')
    // 点堆叠仍会建"选择集"（各环节共用），但**不得**被当成移动准备
    expect(workbench.actionAllowedNow('move.order')).toBe(false)
    mapView.expandStackAt({ col: 36, row: 13 })
    expect(mapView.session?.kind ?? null).not.toBe('move')

    // 本环节自己的入口：突围会话照旧可开
    mapView.openBreakoutNow()
    expect(mapView.session?.kind).toBe('breakout')
  })
})

describe('#5 重建环节：点堆叠不弹「开始移动」', () => {
  it('★ 重建环节点堆叠 ⇒ 不建取子；会话仍是增援（重建与整编）', () => {
    const { workbench, mapView } = newStores()
    workbench.setActiveSide('axis')
    workbench.setPhase('reinforcement')
    place(workbench, combatRecord(), INTERIOR, 'r-1')
    goToStep(workbench, 'reinforcement.rebuild')

    // 堆叠窗的「开始移动」与移动会话共用 `move.order` 闸门 ⇒ 这里必须为假
    expect(workbench.actionAllowedNow('move.order')).toBe(false)
    mapView.expandStackAt(INTERIOR)
    expect(mapView.session?.kind).toBe('reinforce')
  })
})
