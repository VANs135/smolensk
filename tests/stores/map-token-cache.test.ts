import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  toConsoleUnit,
  unitChoices,
  useHotseatStore,
  useMapViewStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 档2性能：地面令牌按单位缓存
 *
 * 1) 一枚换格 ⇒ 只有它自己的 token 对象换新，其余单位必须复用同一引用（视图层据此跳过重绘）；
 * 2) 选中环是外层状态 ⇒ 只给被选中的那枚套 wrapper，不能把所有 token 打回重算。
 */

const START = { col: 36, row: 13 }
const NEXT = { col: 37, row: 13 }

const legCombat = () =>
  unitChoices('axis').find(
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )!

const newStores = () => {
  setActivePinia(createPinia())
  return {
    workbench: useWorkbenchStore(),
    hotseat: useHotseatStore(),
    mapView: useMapViewStore(),
  }
}

describe('地图 token 单位级缓存', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    const record = legCombat()
    stores.workbench.units.push(
      toConsoleUnit({ record, instanceId: 'cache-a', hex: START, side: 'axis' }),
      toConsoleUnit({ record, instanceId: 'cache-b', hex: { col: 38, row: 13 }, side: 'axis' }),
    )
  })

  it('一枚换格：只换该枚 token，未动过的单位复用原对象', () => {
    const { workbench, mapView } = stores
    const before = mapView.overlay.tokens
    const aBefore = before.find((token) => token.id === 'cache-a')!
    const bBefore = before.find((token) => token.id === 'cache-b')!

    workbench.units[0]!.hex = { ...NEXT }

    const after = mapView.overlay.tokens
    const aAfter = after.find((token) => token.id === 'cache-a')!
    const bAfter = after.find((token) => token.id === 'cache-b')!
    expect(aAfter).not.toBe(aBefore)
    expect(aAfter.hex).toEqual(NEXT)
    expect(bAfter).toBe(bBefore)
  })

  it('只改选中环：被选中的一枚套 wrapper，其余保持原引用', () => {
    const { workbench, mapView } = stores
    const before = mapView.overlay.tokens
    const bBefore = before.find((token) => token.id === 'cache-b')!
    expect(before.find((token) => token.id === 'cache-a')!.selected).toBe(false)

    workbench.setPhase('movement')
    expect(workbench.beginMoveFor(['cache-a'])).toBe(true)

    const after = mapView.overlay.tokens
    expect(mapView.overlay.selectedIds).toEqual(['cache-a'])
    expect(after.find((token) => token.id === 'cache-a')!.selected).toBe(true)
    expect(after.find((token) => token.id === 'cache-b')).toBe(bBefore)
  })
})
