import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { hexCanvasPoint } from '@/render/map-layout'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * B3（用户 2026-11-17）：双击堆叠进入移动后，扇面立即收起
 *
 *   · 双击取子后 `expandedStack` 必须清空，后续点该格按新状态分派；
 *   · 双击不能把第二击在展开态里改过的选中集留下 —— 选中集要与取子清单一致。
 */

const START: HexRef = { col: 36, row: 13 }

function combatRecord() {
  const found = unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )
  if (!found) throw new Error('no axis leg combat unit')
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B3：双击堆叠收扇面', () => {
  it('双击进入移动后 expandedStack 清空，选中集回到取子清单', () => {
    const store = useWorkbenchStore()
    const mapView = useMapViewStore()
    store.setActiveSide('axis')
    store.setPhase('movement')
    const record = combatRecord()
    store.units.push(toConsoleUnit({ record, instanceId: 'a1', hex: START, side: 'axis' }))
    store.units.push(toConsoleUnit({ record, instanceId: 'a2', hex: START, side: 'axis' }))

    // 复现浏览器的两击：第一击摊开，第二击落在展开态里（会改选中集）
    mapView.onHexClick(START)
    mapView.onHexClick(START)
    expect(mapView.expandedStack).not.toBeNull()

    expect(mapView.onHexDoubleClick(START, hexCanvasPoint(START), 1)).toBe(true)
    expect(store.movePick).not.toBeNull()
    expect(store.movePick!.ids).toHaveLength(1)

    // 扇面必须收起：后续点该格不再被展开态接管
    expect(mapView.expandedStack).toBeNull()
    // 第二击的选中变化不能留下：选中集与真正取走的算子一致
    expect(mapView.stackSelection).toEqual(store.movePick!.ids)
  })
})
