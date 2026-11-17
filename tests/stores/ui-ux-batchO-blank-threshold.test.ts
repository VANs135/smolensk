import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { hexCanvasPoint } from '@/render/map-layout'
import { IN_HEX_GROUND_CAPACITY } from '@/render/stack-fan'
import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import {
  airBaseRecord,
  combatRecord,
  fighterRecord,
  groundRecord,
  placeAir,
  placeGround,
} from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 堆叠与格内显示（用户 2026-11-18）
 *
 * ① 点空白：格内地面**能完整显示**（不重叠）的枚数 ≤ 4 ⇒ 整堆全选、不开窗；
 *    > 4 ⇒ 摊开堆叠窗，默认全选战斗单位 + 编内卡车。
 * ③ 飞机不进地面堆叠；点空军基地 / 整备段点格 ⇒ 摊开**飞机堆叠窗**。
 */

const HEX: HexRef = { col: 15, row: 10 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  workbench.setPhase('movement')
  const mapView = useMapViewStore()
  useHotseatStore().setViewerSide('axis')
  return { workbench, mapView }
}

function placeInf(workbench: Workbench, id: string, hex: HexRef = HEX) {
  placeGround(workbench, combatRecord('axis'), hex, 'axis', id)
}

function placeTruck(workbench: Workbench, id: string, hex: HexRef = HEX) {
  const record = groundRecord('axis', (item) => item.noncombatKind === 'organic_truck')
  placeGround(workbench, record, hex, 'axis', id)
}

/** 点格内**空白**：格心在新排布里落在两枚之间，不会被算子的命中热区吃掉 */
function clickBlank(mapView: ReturnType<typeof useMapViewStore>): void {
  mapView.onHexClick(HEX, { x: 10, y: 10 }, hexCanvasPoint(HEX), 1)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('① 点空白的阈值＝能完整摆下的枚数', () => {
  it('≤ 4 枚：整堆全选，不开堆叠窗', () => {
    const { workbench, mapView } = stores()
    for (const id of ['a1', 'a2', 'a3']) placeInf(workbench, id)

    clickBlank(mapView)

    expect(IN_HEX_GROUND_CAPACITY).toBe(4)
    expect(mapView.popup).toBeNull()
    expect([...(workbench.movePick?.ids ?? [])].sort()).toEqual(['a1', 'a2', 'a3'])
    expect([...mapView.stackSelection].sort()).toEqual(['a1', 'a2', 'a3'])
  })

  it('恰好 4 枚地面（含编内卡车）：仍全选、不开窗；卡车不进默认集（沿用现有口径）', () => {
    const { workbench, mapView } = stores()
    for (const id of ['a1', 'a2', 'a3']) placeInf(workbench, id)
    placeTruck(workbench, 'truck')

    clickBlank(mapView)

    expect(mapView.popup).toBeNull()
    expect([...(workbench.movePick?.ids ?? [])].sort()).toEqual(['a1', 'a2', 'a3'])
  })

  it('> 4 枚：摊开堆叠窗，默认全选战斗单位 + 编内卡车', () => {
    const { workbench, mapView } = stores()
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) placeInf(workbench, id)
    placeTruck(workbench, 'truck')

    clickBlank(mapView)

    expect(mapView.popup).not.toBeNull()
    expect(mapView.popup?.hex).toEqual(HEX)
    expect([...(workbench.movePick?.ids ?? [])].sort()).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'a5',
      'truck',
    ])
  })

  it('阈值与扇面/页号无关：把该格翻到别的页后，5 枚仍走开窗分支', () => {
    const { workbench, mapView } = stores()
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) placeInf(workbench, id)
    mapView.expandStackAt(HEX)
    mapView.expandedStack = { hex: HEX, page: 1 }
    // 翻到第 1 页后该页只剩 1 枚（画在格心），要点空白需避开它
    const center = hexCanvasPoint(HEX)
    mapView.onHexClick(HEX, { x: 10, y: 10 }, { x: center.x, y: center.y + 50 }, 1)

    expect(mapView.popup).not.toBeNull()
    expect((workbench.movePick?.ids ?? []).length).toBe(5)
  })
})

describe('③ 飞机不进地面堆叠，基地/整备开飞机窗', () => {
  it('点空军基地格空白 ⇒ 飞机堆叠窗（airFocus），地面仍全选', () => {
    const { workbench, mapView } = stores()
    for (const id of ['a1', 'a2']) placeInf(workbench, id)
    placeGround(workbench, airBaseRecord(1), HEX, 'axis', 'base-1')
    placeAir(workbench, fighterRecord('axis'), HEX, 'axis', 'f1')

    clickBlank(mapView)

    expect(mapView.popup?.airFocus).toBe(true)
    expect((mapView.popupContent?.airUnits ?? []).map((air) => air.instanceId)).toEqual(['f1'])
    expect([...(workbench.movePick?.ids ?? [])].sort()).toEqual(['a1', 'a2'])
  })

  it('整备段点格 ⇒ 同一张飞机堆叠窗（带 15.1 整备入口）', () => {
    const { workbench, mapView } = stores()
    for (const id of ['a1', 'a2']) placeInf(workbench, id)
    placeGround(workbench, airBaseRecord(1), HEX, 'axis', 'base-1')
    placeAir(workbench, fighterRecord('axis'), HEX, 'axis', 'f1')
    workbench.setPhase('aircraftRefit')

    clickBlank(mapView)

    expect(mapView.popup?.airFocus).toBe(true)
    expect((mapView.popupContent?.airUnits ?? []).map((air) => air.instanceId)).toEqual(['f1'])
  })

  it('飞机 chip 可选中：进 14.2 的任务飞机名单', () => {
    const { workbench, mapView } = stores()
    placeGround(workbench, airBaseRecord(1), HEX, 'axis', 'base-1')
    placeAir(workbench, fighterRecord('axis'), HEX, 'axis', 'f1')
    mapView.openPopup(HEX, 0, 0, 'content', { airFocus: true })

    expect(mapView.selectStackChip('f1')).toBe(true)
    expect([...workbench.airMissionAirIds]).toContain('f1')
  })

  it('整备段的飞机 chip 不抢 15.1 的勾选（点 chip 只由复选框管）', () => {
    const { workbench, mapView } = stores()
    placeGround(workbench, airBaseRecord(1), HEX, 'axis', 'base-1')
    placeAir(workbench, fighterRecord('axis'), HEX, 'axis', 'f1')
    workbench.setPhase('aircraftRefit')
    mapView.openPopup(HEX, 0, 0, 'content', { airFocus: true })

    expect(mapView.selectStackChip('f1')).toBe(false)
    expect([...workbench.airMissionAirIds]).toEqual([])
  })
})
