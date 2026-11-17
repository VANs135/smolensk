import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import type { HexRef } from '@/data'
import { hexCanvasPoint } from '@/render/map-layout'
import {
  toConsoleUnit,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  unitChoices,
} from '@/stores'

/**
 * 用户 2026-11-18 确认的三条口径（扫描待定项）
 *
 * ① 点画布空白：先退「选格」，再退「待开拔」，并清掉选择环；**不**顺手关战斗/补给面板。
 * ② 落点/拖拽被拒的文案逐项中文：界面不得漏出 `notEnoughMp` 这类内部码。
 * ③ Esc / 切方 / 切段 / 拖拽取消之后，选择环不得留在旧单位上。
 */

const HEX: HexRef = { col: 15, row: 10 }

type Workbench = ReturnType<typeof useWorkbenchStore>
type MapView = ReturnType<typeof useMapViewStore>

function stores(): { workbench: Workbench; mapView: MapView } {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  workbench.setPhase('movement')
  return { workbench, mapView: useMapViewStore() }
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

function place(workbench: Workbench, id: string, hex: HexRef = HEX) {
  const unit = toConsoleUnit({ record: combatRecord(), instanceId: id, hex, side: 'axis' })
  workbench.units.push(unit)
  return unit
}

function pickAt(workbench: Workbench, hex: HexRef = HEX): void {
  workbench.clickHex(hex)
  expect(workbench.movePick).not.toBeNull()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('① 点画布空白：先退选格，再退待开拔', () => {
  it('有待点格时只退选格，不动待开拔', () => {
    const { workbench, mapView } = stores()
    place(workbench, 'a1')
    pickAt(workbench)
    workbench.beginHexPick({
      label: '随便点一格',
      rule: '测试',
      candidates: 'any',
      apply: () => true,
    })

    expect(mapView.cancelBlankPick()).toBe(true)
    expect(workbench.hexPickView).toBeNull()
    expect(workbench.movePick).not.toBeNull()
  })

  it('没有待点格时退待开拔，并清掉地图选择环', () => {
    const { workbench, mapView } = stores()
    place(workbench, 'a1')
    place(workbench, 'a2')
    mapView.expandStackAt(HEX)
    expect(mapView.stackSelection.length).toBeGreaterThan(0)

    expect(mapView.cancelBlankPick()).toBe(true)
    expect(workbench.movePick).toBeNull()
    expect(mapView.stackSelection).toEqual([])
  })

  it('不顺手关掉已经打开的战斗面板（只清移动这边的选择）', () => {
    const { mapView } = stores()
    // 没有移动选择、也没有待点格 ⇒ 空白点击不应把 popup 收掉
    mapView.openPopup(HEX, 10, 10)
    expect(mapView.popup).not.toBeNull()
    expect(mapView.cancelBlankPick()).toBe(false)
    expect(mapView.popup).not.toBeNull()
  })
})

describe('② 落点/拖拽被拒文案：逐项中文，不漏内部码', () => {
  const INTERNAL =
    /notEnoughMp|prohibited|enemyOccupied|outsidePlayArea|notAdjacent|destinationOffMap|stackingLimit|reciprocity/

  it('拖拽路径中段敌占：报「敌占」而不是 enemyOccupied', () => {
    const { workbench, mapView } = stores()
    const mover = place(workbench, 'a1')
    pickAt(workbench)
    const node = workbench.groupReachable.hexes.find((item) => item.path.length === 3)
    expect(node).toBeDefined()
    const [start, mid, end] = node!.path
    workbench.units.push(
      toConsoleUnit({ record: combatRecord(), instanceId: 'e1', hex: mid!, side: 'soviet' }),
    )

    mapView.dropMovingCounterAt(mover.instanceId, end!, { x: 0, y: 0 }, [start!, mid!, end!])

    const text = workbench.moveBlocked?.reason ?? ''
    expect(text).toContain('无法通行')
    expect(text).not.toMatch(INTERNAL)
    expect(text).toMatch(/敌占|敌方/)
  })

  it('拖拽到不可进入的远格：报中文原因，不漏内部码', () => {
    const { workbench, mapView } = stores()
    const mover = place(workbench, 'a1')
    pickAt(workbench)
    // 选一个可达范围之外的图上格：previewStep 会给出引擎原因
    const far: HexRef = { col: HEX.col + 6, row: HEX.row + 6 }
    mapView.dropMovingCounterAt(mover.instanceId, far, { x: 0, y: 0 }, [HEX, far])

    const text = workbench.moveBlocked?.reason ?? ''
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(INTERNAL)
  })
})

describe('③ 选择环随取消一起消失', () => {
  it('Esc 取消移动会话后，地图选择环清空', () => {
    const { workbench, mapView } = stores()
    place(workbench, 'a1')
    place(workbench, 'a2')
    mapView.onHexClick(HEX, { x: 0, y: 0 }, hexCanvasPoint(HEX), 1)
    expect(mapView.stackSelection.length).toBeGreaterThan(0)

    mapView.cancelSession()

    expect(mapView.stackSelection).toEqual([])
  })

  it('切方/切段后选择环清空', async () => {
    const { workbench, mapView } = stores()
    place(workbench, 'a1')
    place(workbench, 'a2')
    mapView.expandStackAt(HEX)
    expect(mapView.stackSelection.length).toBeGreaterThan(0)

    workbench.setPhase('supply')
    await nextTick()
    expect(mapView.stackSelection).toEqual([])
  })
})
