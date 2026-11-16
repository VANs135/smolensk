import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { hexCanvasPoint } from '@/render/map-layout'
import { useSetupStore, useMapViewStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * D1（用户 2026-11-17 实走）：**非移动段点单位＝只读查看**
 *
 * 实走现场：D 补给段点一枚己方单位（只想逐单位检查），状态条却回
 * 「2.2 这一步被拒：D 补给段没有移动环节，不能移动」——不打开堆叠/详情。
 * 口径：规则拒绝只在**真的有动作意图**时出现；只看一眼不该吃一条红字。
 */

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

const LEG = () =>
  groundRecord(
    'axis',
    (record) => record.isCombat === true && record.classes?.movementClass === 'leg',
  )

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('D1：补给段点单位只读查看', () => {
  it('单击单位令牌：开堆叠/详情，不发「D 补给段没有移动环节」', () => {
    const { workbench, mapView } = newStores()
    workbench.setActiveSide('axis')
    workbench.setPhase('supply')
    placeGround(workbench, LEG(), CORE_HEX, 'axis', 'd1-a')
    const before = workbench.log.length

    const center = hexCanvasPoint(CORE_HEX)
    mapView.onHexClick(CORE_HEX, undefined, { x: center.x, y: center.y })

    expect(workbench.moveBlocked).toBeNull()
    expect(workbench.movePick).toBeNull()
    expect(mapView.popup?.hex).toEqual(CORE_HEX)
    const fresh = workbench.log.slice(0, workbench.log.length - before)
    expect(fresh.some((line) => line.text.includes('没有移动环节'))).toBe(false)
  })

  it('双击单位令牌同样只读：不建移动工具、不发拒绝', () => {
    const { workbench, mapView } = newStores()
    workbench.setActiveSide('axis')
    workbench.setPhase('supply')
    placeGround(workbench, LEG(), CORE_HEX, 'axis', 'd1-b')

    const center = hexCanvasPoint(CORE_HEX)
    const consumed = mapView.onHexDoubleClick(CORE_HEX, { x: center.x, y: center.y }, 1)

    expect(consumed).toBe(true)
    expect(workbench.moveBlocked).toBeNull()
    expect(workbench.movePick).toBeNull()
    expect(mapView.popup?.hex).toEqual(CORE_HEX)
  })
})
