import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 5.4a / 5.7：预备标记在**真实移动流程**里的计量与校验
 *
 * 原文两句：
 *   - 5.4a「玩家可以用一个预备标记（4.8b），表示**堆叠中一部分单位全部处于预备模式**」
 *     ⇒ 计量单位是**标记（覆盖组）**，同组只占一枚；
 *   - 5.4a「在这些单位**完成 25% 的移动后，才需要放置该预备标记**」
 *     ⇒ 切模式不收标记，**实际迈步时**才收；池空则这一步不合法。
 *
 * 上限取剧本初设 `setup.reserveMarkers`（5.4a「严格限制」）：剧本 1/2 为轴 14 / 苏 0
 * （`scenarios.json`），故苏方预备单位在剧本 2 里**不能**按预备 MA 迈步。
 */

const START: HexRef = { col: 57, row: 35 }
const BEYOND: HexRef = { col: 59, row: 34 }

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), game: useGameSessionStore() }
}

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/** MA≥8 的装甲（预备 MA＝8×¼＝2，恰好够走 2 MP 到 59.34） */
const armor = () =>
  pickRecord(
    'axis',
    (record) =>
      record.classes?.movementClass === 'tracked' && (record.factors?.combat?.ma ?? 0) >= 8,
  )

const leg = (side: 'axis' | 'soviet') =>
  pickRecord(
    side,
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )

function place(
  store: ReturnType<typeof newStores>['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face: 'combat' })
  store.units.push(unit)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('5.4a 预备标记：真实移动流程', () => {
  it('★ 切模式不占标记；实际迈步才占一枚（剧本 1 轴方 14 枚）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const unit = place(store, armor(), START, 'axis', 'a1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    expect(unit.mode.mode).toBe('reserve')
    // 5.4a：切到预备模式本身不收标记（"完成 25% 移动后才需要放置"）
    expect(store.reserveMarkerGroups).toHaveLength(0)

    store.setUnitFuelled(unit.instanceId, true)
    expect(store.confirmMovePick()).toBe(true)
    // 开拔本身仍不收（5.4a 说的是"完成移动后才需要放置"）
    expect(store.reserveMarkerGroups).toHaveLength(0)

    store.clickHex(BEYOND)
    expect(store.units[0]!.hex).toEqual(BEYOND)
    // 迈进第一步这一刻才为其组放置一枚
    expect(store.reserveMarkerGroups).toHaveLength(1)
    expect(store.reserveMarkerGroups[0]!.side).toBe('axis')
    expect(store.reserveMarkerGroups[0]!.unitIds).toEqual([unit.instanceId])
    // 移动中不重复收：同一组始终只占那一枚
    expect(store.reserveMarkerGroups).toHaveLength(1)
  })

  it('★ 同一次移动的整组预备单位共用一枚（堆叠中一部分单位）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const a = place(store, leg('axis'), START, 'axis', 'a1')
    const b = place(store, leg('axis'), START, 'axis', 'b1')
    store.beginMovePick(START, [a.instanceId, b.instanceId])
    store.switchUnitMode('reserve')
    expect(a.mode.mode).toBe('reserve')
    expect(b.mode.mode).toBe('reserve')
    expect(store.confirmMovePick()).toBe(true)
    const node = store.groupReachable.hexes[0]
    expect(node).toBeDefined()
    store.clickHex(node!.hex)
    // 整组一起迈出第一步 ⇒ 只收一枚，且单位集合是这一组
    expect(store.reserveMarkerGroups).toHaveLength(1)
    expect(store.reserveMarkerGroups[0]!.unitIds).toEqual([a.instanceId, b.instanceId])
  })

  it('★ 剧本 1/2 苏方 0 枚 ⇒ 苏方预备单位按预备 MA 迈步被拒（5.4a）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('2')).toBe(true)
    store.activeSide = 'soviet'
    const unit = place(store, leg('soviet'), START, 'soviet', 's1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    expect(unit.mode.mode).toBe('reserve')
    expect(store.confirmMovePick()).toBe(true)

    const node = store.groupReachable.hexes[0]
    expect(node).toBeDefined()
    const before = { ...unit.hex }
    store.clickHex(node!.hex)

    expect(store.moveBlocked).not.toBeNull()
    expect(store.moveBlocked!.rule).toBe('5.4a')
    // 拒绝是**整步**拒绝：单位仍在原格，账本未新增
    expect(store.units[0]!.hex).toEqual(before)
    expect(store.reserveMarkerGroups).toHaveLength(0)
  })

  it('对照：同一苏方单位在剧本 3（苏方 4 枚）里可以按预备 MA 迈步并占一枚', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('3')).toBe(true)
    store.activeSide = 'soviet'
    place(store, leg('soviet'), START, 'soviet', 's1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    expect(store.confirmMovePick()).toBe(true)
    const node = store.groupReachable.hexes[0]
    store.clickHex(node!.hex)
    expect(store.moveBlocked).toBeNull()
    expect(store.reserveMarkerGroups).toHaveLength(1)
    expect(store.units[0]!.hex).not.toEqual(START)
  })
})
