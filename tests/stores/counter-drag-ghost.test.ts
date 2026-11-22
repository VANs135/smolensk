import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { hexCanvasPoint } from '@/render/map-layout'
import { tokenImageUrl } from '@/render/token-images'
import {
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

import { counterKeyOf } from '../counter-url-helper'

/**
 * 拖动时算子本体跟手（用户 2026-11-18）
 *
 * 画布用**与盘面相同的选图入口**（`tokenImageUrl`）画拖动中的那一枚；
 * 拖动源把「这一次带走的整组 id」一并给出，多选时角标显示枚数。
 * 沿自选路径拖拽落位（`dropMovingCounterAt` 的 path 分支）不在本文件覆盖范围外改动。
 */

const START = { col: 57, row: 35 }

function place(store: ReturnType<typeof useWorkbenchStore>, ids: string[]) {
  const record = unitChoices('axis').find(
    (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
  )
  if (record === undefined) throw new Error('单位库没有可用的徒步单位')
  for (const id of ids)
    store.units.push(
      toConsoleUnit({ record, instanceId: id, hex: START, side: 'axis', face: 'combat' }),
    )
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('拖动算子跟手', () => {
  it('★ 移动环节的拖动源给出整组 id，覆盖层令牌有可绘制图片', () => {
    useSetupStore().finished = true
    const workbench = useWorkbenchStore()
    workbench.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    place(workbench, ['u1'])
    workbench.setPhase('movement')
    workbench.beginMovePick(START, ['u1'])
    const mapView = useMapViewStore()
    const source = mapView.counterForMoveDragAt(START, hexCanvasPoint(START), 1)
    expect(source).not.toBeNull()
    expect(source?.ids).toEqual(['u1'])
    const token = mapView.overlay.tokens.find((item) => item.id === 'u1')
    expect(token).toBeDefined()
    expect(counterKeyOf(tokenImageUrl(token!)!)).toMatch(/\.(png|jpg|webp)$/)
  })

  it('★ 初设 † 拖动源带的是选中整组（不是单枚）', () => {
    const setup = useSetupStore()
    const workbench = useWorkbenchStore()
    useGameSessionStore().setScenarioId('3')
    expect(setup.selectScenario('3')).toBe(true)
    const cursor = setup.setupSideCursor
    if (cursor !== null) useHotseatStore().setViewerSide(cursor)
    const tolerant = workbench.units.filter(
      (unit) => unit.side === cursor && setup.isStackDisperseUnit(unit.instanceId),
    )
    expect(tolerant.length).toBeGreaterThan(0)
    const unit = tolerant.find(
      (candidate) =>
        workbench.units.filter(
          (item) => item.hex.col === candidate.hex.col && item.hex.row === candidate.hex.row,
        ).length === 1,
    )
    expect(unit).toBeDefined()
    const mapView = useMapViewStore()
    mapView.stackSelection = [unit!.instanceId]
    const source = mapView.counterForMoveDragAt(unit!.hex, hexCanvasPoint(unit!.hex), 1)
    expect(source?.ids).toEqual([unit!.instanceId])
  })
})
