import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HexRef } from '@/data'
import { hexCanvasPoint } from '@/render/map-layout'
import {
  toConsoleUnit,
  unitChoices,
  useHotkeyStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 批 H3 / H4（用户 2026-11-16）
 *
 * H3：**双击算子＝常用动作**（画布此前没有 dblclick）
 *   · 徒步/战斗单位：直接取子（跳过堆叠窗），落点高亮由 M1 的预演范围给；
 *   · 本次移动中的算子：双击＝结束本次移动（与 Enter 同源）；
 *   · 空格/敌方：不抢这一击。
 * H4：**Enter 才推进环节**，但只在「没有待决选择、没有进行中的移动交互」时：
 *   · 移动中 ⇒ 结束移动；
 *   · 有取子/点格/铁路待确认/初设落位等待决 ⇒ 保持不动（不误跳段）；
 *   · 两者都没有 ⇒ 走既有的 `advanceSegmentNow`（不新写规则）。
 */

const START: HexRef = { col: 36, row: 13 }

type Workbench = ReturnType<typeof useWorkbenchStore>

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

function place(store: Workbench, instanceId = 'a1', hex: HexRef = START) {
  const unit = toConsoleUnit({ record: combatRecord(), instanceId, hex, side: 'axis' })
  store.units.push(unit)
  return unit
}

function beginMove(store: Workbench) {
  store.setActiveSide('axis')
  store.setPhase('movement')
  const unit = place(store)
  store.clickHex(START)
  expect(store.confirmMovePick()).toBe(true)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('H3：双击算子直接进入常用动作', () => {
  it('画布真的接了 dblclick，并把格 / 世界坐标 / 比例交给上层', () => {
    const canvas = readFileSync(
      new URL('../../src/components/map/MapCanvas.vue', import.meta.url),
      'utf8',
    )
    expect(canvas).toContain('@dblclick=')
    expect(canvas).toContain('hexDblClick')
    const view = readFileSync(new URL('../../src/views/GameTableView.vue', import.meta.url), 'utf8')
    expect(view).toContain('@hex-dbl-click=')
    expect(view).toContain('mapView.onHexDoubleClick(')
  })

  it('双击己方战斗单位：直接取子（等于省掉堆叠窗这一层）', () => {
    const workbench = useWorkbenchStore()
    const mapView = useMapViewStore()
    workbench.setActiveSide('axis')
    workbench.setPhase('movement')
    const unit = place(workbench)

    expect(mapView.onHexDoubleClick(START, hexCanvasPoint(START), 1)).toBe(true)
    expect(workbench.movePick?.hex).toEqual(START)
    expect(workbench.movePick?.ids).toEqual([unit.instanceId])
  })

  it('双击本次移动中的算子：结束本次移动', () => {
    const workbench = useWorkbenchStore()
    const mapView = useMapViewStore()
    beginMove(workbench)
    expect(workbench.activeMoveUnits).toHaveLength(1)

    expect(mapView.onHexDoubleClick(START, hexCanvasPoint(START), 1)).toBe(true)
    expect(workbench.activeMoveUnits).toHaveLength(0)
  })

  it('双击空格：不抢这一击', () => {
    const workbench = useWorkbenchStore()
    const mapView = useMapViewStore()
    workbench.setActiveSide('axis')
    workbench.setPhase('movement')
    expect(
      mapView.onHexDoubleClick({ col: 1, row: 1 }, hexCanvasPoint({ col: 1, row: 1 }), 1),
    ).toBe(false)
  })
})

describe('H4：Enter 只在没有待决 / 没有移动交互时推进', () => {
  const pressEnter = () =>
    useHotkeyStore().handleKeydown({ key: 'Enter', target: null, preventDefault: () => undefined })

  it('有取子清单（待决选择）⇒ 保持不动，不推进', () => {
    const workbench = useWorkbenchStore()
    workbench.setActiveSide('axis')
    workbench.setPhase('movement')
    place(workbench)
    workbench.clickHex(START)
    expect(workbench.movePick).not.toBeNull()
    const advance = vi.spyOn(workbench, 'advanceSegmentNow')

    expect(pressEnter()).toBe(false)
    expect(advance).not.toHaveBeenCalled()
  })

  it('移动进行中 ⇒ Enter 结束移动，不推进', () => {
    const workbench = useWorkbenchStore()
    beginMove(workbench)
    const advance = vi.spyOn(workbench, 'advanceSegmentNow')

    expect(pressEnter()).toBe(true)
    expect(workbench.activeMoveUnits).toHaveLength(0)
    expect(advance).not.toHaveBeenCalled()
  })

  it('无待决、无移动 ⇒ 走既有 advanceSegmentNow', () => {
    const workbench = useWorkbenchStore()
    const setup = useSetupStore()
    setup.finished = true
    const advance = vi
      .spyOn(workbench, 'advanceSegmentNow')
      .mockReturnValue({ steps: 1, stoppedBy: 'player', driver: 'player' } as never)

    expect(pressEnter()).toBe(true)
    expect(advance).toHaveBeenCalledTimes(1)
  })

  it('初设未收束 ⇒ 不推进（初设本身就是待决）', () => {
    const workbench = useWorkbenchStore()
    const advance = vi.spyOn(workbench, 'advanceSegmentNow')

    expect(pressEnter()).toBe(false)
    expect(advance).not.toHaveBeenCalled()
  })
})
