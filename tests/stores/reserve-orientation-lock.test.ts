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
 * A2 / 5.7a：进入预备模式后的**朝向锁**
 *
 * 原文：「进入预备模式时，单位可以翻面，使算子的任意面朝上。该朝向（朝向战斗模式或移动模式）
 * 在该玩家的下一个移动阶段之前无法再切换。」
 *
 * 判定点是引擎 `canFlipOrientation` 的 `enteredReserveThisTurn` 入参；
 * 本组用例钉住 store 是否把「本阶段刚进入预备」这一事实真正接进调用点。
 * 修前 `flipUnitOrientation` 只传 `{ state, phase }` ⇒ 刚转入预备即可再翻面（违反 5.7a）。
 */

const START: HexRef = { col: 57, row: 35 }

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), game: useGameSessionStore() }
}

function place(
  store: ReturnType<typeof newStores>['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex: START, side, face: 'combat' })
  store.units.push(unit)
  return unit
}

const legRecord = (side: 'axis' | 'soviet') => {
  const found = unitChoices(side).find(
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('A2 / 5.7a：预备朝向锁', () => {
  it('★ 本移动阶段内刚转入预备 ⇒ 不能再改朝向（5.7a）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const unit = place(store, legRecord('axis'), 'axis', 'a1')
    store.clickHex(START)
    store.switchUnitMode('reserve', 'move')
    expect(unit.mode.mode).toBe('reserve')
    expect(unit.mode.orientation).toBe('move')

    store.flipUnitOrientation()

    expect(unit.mode.orientation).toBe('move')
    expect(store.log.some((entry) => entry.rule === '5.7a')).toBe(true)
  })

  it('对照：上一阶段就已经在预备的单位可以改朝向', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const unit = place(store, legRecord('axis'), 'axis', 'a2')
    unit.mode = { mode: 'reserve', orientation: 'move', dg: false, exploit: false }
    store.clickHex(START)

    store.flipUnitOrientation()

    expect(unit.mode.orientation).toBe('combat')
    expect(store.log.some((entry) => entry.rule === '5.7a' && entry.kind === 'success')).toBe(true)
  })

  it('★ 换回合（resetMovementTracking）后解锁：新的移动阶段可以再翻面', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const unit = place(store, legRecord('axis'), 'axis', 'a3')
    store.clickHex(START)
    store.switchUnitMode('reserve', 'move')
    store.flipUnitOrientation()
    expect(unit.mode.orientation).toBe('move')

    store.setTurn(1)
    store.clickHex(START)
    store.flipUnitOrientation()

    expect(unit.mode.orientation).toBe('combat')
  })
})
