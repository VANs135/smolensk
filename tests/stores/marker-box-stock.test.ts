import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  toConsoleUnit,
  unitChoices,
  useContainersStore,
  useGameSessionStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 标记盒存量（用户 2026-11-18）
 *
 * 口径：
 *   · 标记盒**只显示存量**（建造标记 + 预备标记），不加按钮；建造标记的使用入口在地图上
 *     （对有可用单位的格右键，专规 3.5）；
 *   · 预备标记按 5.4a 是**按格**占用，`reserveMarkerStatusOf` 直接由单位和剧本额度派生，
 *     与转入预备的闸门 `canEnterReserveMode` 同源；消耗（转入预备）当刻即减少。
 */

const START: HexRef = { col: 57, row: 35 }

const newStores = () => {
  setActivePinia(createPinia())
  return {
    containers: useContainersStore(),
    workbench: useWorkbenchStore(),
    game: useGameSessionStore(),
  }
}

const legRecord = () =>
  unitChoices('axis').find(
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )!

function place(
  store: ReturnType<typeof newStores>['workbench'],
  instanceId: string,
  hex: HexRef = START,
): ConsoleUnit {
  const unit = toConsoleUnit({ record: legRecord(), instanceId, hex, side: 'axis', face: 'combat' })
  store.units.push(unit)
  return unit
}

const markersRegion = (side: 'axis' | 'soviet') =>
  newStoresMarkers(side).regions.find((region) => region.kind === 'markers')!

function newStoresMarkers(side: 'axis' | 'soviet') {
  const containers = useContainersStore()
  const id = side === 'axis' ? 'axis-offboard' : 'soviet-offboard'
  return containers.cardViewsOf(side).find((card) => card.id === id)!
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('5.4a：预备标记在标记盒里可见，消耗即减少', () => {
  it('剧本 1 轴方 14 枚：盒里铺一枚贴图 + 角标 ×14；建造标记枚数不受影响', () => {
    const { workbench } = newStores()
    expect(useGameSessionStore().setScenarioId('1')).toBe(true)
    const region = markersRegion('axis')
    const construction = region.units.filter((unit) =>
      unit.unitId.startsWith('construction-marker:'),
    )
    const reserve = region.units.filter((unit) => unit.unitId === 'reserve-marker:axis')

    expect(construction).toHaveLength(workbench.constructionMarkers)
    expect(reserve).toHaveLength(1)
    expect(reserve[0]?.badge).toBe('×14')
    expect(reserve[0]?.name).toContain('预备标记')
  })

  it('★ 转入预备的那一刻：派生占用 +1，盒里角标立即从 ×14 变 ×13（同一份计数）', () => {
    const { workbench } = newStores()
    expect(useGameSessionStore().setScenarioId('1')).toBe(true)
    const unit = place(workbench, 'a1')
    workbench.clickHex(START)
    workbench.switchUnitMode('reserve')
    expect(unit.mode.mode).toBe('reserve')

    const status = workbench.reserveMarkerStatusOf('axis')
    expect(status).toEqual({ cap: 14, used: 1, remaining: 13 })
    // 显示与消耗同源：占用格数就是 reservedHexes 的长度
    expect(status.used).toBe(workbench.reservedHexes('axis').length)

    const reserve = markersRegion('axis').units.find(
      (item) => item.unitId === 'reserve-marker:axis',
    )
    expect(reserve?.badge).toBe('×13')
  })

  it('同格两枚转入预备只占 1 格 ⇒ 角标只减一次（5.4a「堆叠中一部分单位」）', () => {
    const { workbench } = newStores()
    expect(useGameSessionStore().setScenarioId('1')).toBe(true)
    const a = place(workbench, 'a1')
    const b = place(workbench, 'b1')
    workbench.beginMovePick(START, [a.instanceId, b.instanceId])
    workbench.switchUnitMode('reserve')
    expect(workbench.reserveMarkerStatusOf('axis').used).toBe(1)
    const reserve = markersRegion('axis').units.find(
      (item) => item.unitId === 'reserve-marker:axis',
    )
    expect(reserve?.badge).toBe('×13')
    workbench.cancelMovePick()
  })

  it('剧本 1 苏方 0 枚 ⇒ 标记盒不铺预备标记（没有预备权）', () => {
    newStores()
    expect(useGameSessionStore().setScenarioId('1')).toBe(true)
    const region = markersRegion('soviet')
    expect(region.units.some((unit) => unit.unitId.startsWith('reserve-marker:'))).toBe(false)
  })
})
