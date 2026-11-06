import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { hasMarker } from '@/engine/rules'
import { createMemoryStorage } from '@/shared'
import {
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 5.4a / 5.7：预备额度在**真实模式切换流程**里的占用（按格计）
 *
 * 口径（原文 + 用户 2026-11-06 裁定）：
 *   - 5.4a「玩家可以用一个预备标记（4.8b），表示**堆叠中一部分单位全部处于预备模式**」
 *     ⇒ 一枚标记＝**一个格子**里处于预备模式的那部分单位；同格多枚只占 1 格；
 *   - **转入预备的那一刻即占**（原文「完成 25% 的移动后，才需要放置该标记」是实体版
 *     省标记的宽容条款；电子版由程序校验，用户裁定进入即占）；
 *   - 释放后标记**留在未释放的单位上**（5.7b「先释放一个……再决定是否释放其他预备」）
 *     ⇒ 该格只要还有预备单位就仍占额度；
 *   - 剧本 `setup.reserveMarkers` 给几枚 ＝ 能同时保持几个格子处于预备；**没给就是 0**
 *     ⇒ 该方完全没有预备权（进入即拒）。
 *
 * 剧本指派：1 轴 14 / 苏 0；2 轴 14 / 苏 0；3 轴 14 / 苏 4；5 轴 7 / 苏 6（`scenarios.json`）。
 */

const START: HexRef = { col: 57, row: 35 }
const hexKey = (hex: HexRef): string => `${String(hex.col)}.${String(hex.row)}`

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

describe('5.4a 预备额度：转入即占、按格计', () => {
  it('★ 0 MP（完全没动）也能转入预备，且在切换那一刻就占 1 格', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const unit = place(store, leg('axis'), START, 'axis', 'a1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    expect(unit.mode.mode).toBe('reserve')
    // 转入即占（不等"迈出第一步"）；占用＝该单位所在格
    expect(store.reservedHexes('axis')).toEqual([hexKey(START)])
  })

  it('★ 同批同格的两枚只占 1 格（5.4a「堆叠中一部分单位」）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const a = place(store, leg('axis'), START, 'axis', 'a1')
    const b = place(store, leg('axis'), START, 'axis', 'b1')
    store.beginMovePick(START, [a.instanceId, b.instanceId])
    store.switchUnitMode('reserve')
    expect(a.mode.mode).toBe('reserve')
    expect(b.mode.mode).toBe('reserve')
    expect(store.reservedHexes('axis')).toEqual([hexKey(START)])
    store.cancelMovePick()
  })

  it('★ 剧本 2 苏方 0 枚 ⇒ 转入预备在切换那一刻就被拒（含 0 MP）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('2')).toBe(true)
    store.setActiveSide('soviet')
    const unit = place(store, leg('soviet'), START, 'soviet', 's1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    // 被拒 ⇒ 模式未变、没有占格（不留半截状态）
    expect(unit.mode.mode).toBe('combat')
    expect(store.reservedHexes('soviet')).toEqual([])
    expect(store.log.some((entry) => entry.rule === '5.4a')).toBe(true)
  })

  it('对照：同一苏方单位在剧本 3（苏方 4 枚）里可以转入并占 1 格', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('3')).toBe(true)
    store.setActiveSide('soviet')
    const unit = place(store, leg('soviet'), START, 'soviet', 's1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    expect(unit.mode.mode).toBe('reserve')
    expect(store.reservedHexes('soviet')).toEqual([hexKey(START)])
  })
})

describe('5.4a + 5.7b 上限＝可同时预备的格数、部分释放与归还（剧本 5 轴方 7 枚）', () => {
  /** 摆满 7 格：START 两枚共 1 格 + 6 个单枚格 */
  function fillQuota(store: ReturnType<typeof newStores>['workbench']) {
    const a = place(store, leg('axis'), START, 'axis', 'a1')
    const b = place(store, leg('axis'), START, 'axis', 'b1')
    store.beginMovePick(START, [a.instanceId, b.instanceId])
    store.switchUnitMode('reserve')
    store.cancelMovePick()
    for (let index = 0; index < 6; index += 1) {
      const hex: HexRef = { col: 55 - index * 2, row: 35 }
      const unit = place(store, leg('axis'), hex, 'axis', `x${String(index)}`)
      store.clickHex(hex)
      store.switchUnitMode('reserve')
      expect(store.reservedHexes('axis')).toHaveLength(index + 2)
      expect(unit.mode.mode).toBe('reserve')
    }
    return { a, b }
  }

  it('★ 第 8 个**新格**被拒（5.4a）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('5')).toBe(true)
    fillQuota(store)
    expect(store.reservedHexes('axis')).toHaveLength(7)

    const extraHex: HexRef = { col: 43, row: 35 }
    const extra = place(store, leg('axis'), extraHex, 'axis', 'x6')
    store.clickHex(extraHex)
    store.switchUnitMode('reserve')
    expect(extra.mode.mode).toBe('combat')
    expect(store.reservedHexes('axis')).toHaveLength(7)
  })

  it('★ 同格已有预备 ⇒ 上限已满也能再转入，且不增加占用', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('5')).toBe(true)
    fillQuota(store)
    expect(store.reservedHexes('axis')).toHaveLength(7)

    // START 上第 3 枚：该格已在预备中 ⇒ 额度不变（不是"每组各占一枚"）
    const c = place(store, leg('axis'), START, 'axis', 'c1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    expect(c.mode.mode).toBe('reserve')
    expect(store.reservedHexes('axis')).toHaveLength(7)
  })

  it('★ 部分释放不归还该格；最后一枚释放后该格归还', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('5')).toBe(true)
    const { a, b } = fillQuota(store)
    const extraHex: HexRef = { col: 43, row: 35 }
    const extra = place(store, leg('axis'), extraHex, 'axis', 'x6')

    // 5.7b：先释放 a（同格 b 仍留在预备）⇒ 标记留在 b 上，该格仍占
    a.mode = { ...a.mode, releasedFromReserve: true }
    expect(hasMarker(a.mode, 'reserve')).toBe(false)
    expect(hasMarker(b.mode, 'reserve')).toBe(true)
    expect(store.reservedHexes('axis')).toHaveLength(7)

    store.clickHex(extraHex)
    store.switchUnitMode('reserve')
    expect(extra.mode.mode).toBe('combat')
    expect(store.reservedHexes('axis')).toHaveLength(7)

    // b 也释放 ⇒ START 不再有预备单位，该格归还；第 8 个新格可以转入
    b.mode = { ...b.mode, releasedFromReserve: true }
    expect(hasMarker(b.mode, 'reserve')).toBe(false)
    expect(store.reservedHexes('axis')).toHaveLength(6)
    store.clickHex(extraHex)
    store.switchUnitMode('reserve')
    expect(extra.mode.mode).toBe('reserve')
    expect(store.reservedHexes('axis')).toHaveLength(7)
  })
})

describe('5.4a 读档往返（额度由 units 派生，无需重放日志）', () => {
  it('★ 存档 → 读档，预备格仍被占用', () => {
    const { workbench: store, game } = newStores()
    // 剧本要在开局前选定；存档还需要存储适配器与完整会话（与既有存读档用例同款）
    expect(game.setScenarioId('3')).toBe(true)
    game.setSaveStorage(createMemoryStorage())
    game.startGame()
    store.setPhase('movement')
    store.setActiveSide('soviet')
    const unit = place(store, leg('soviet'), START, 'soviet', 's1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    expect(store.reservedHexes('soviet')).toEqual([hexKey(START)])
    expect(unit.mode.mode).toBe('reserve')
    expect(game.saveNow()).toBe(true)
    expect(game.loadNow()).toBe(true)

    expect(store.reservedHexes('soviet')).toEqual([hexKey(START)])
    expect(store.units[0]!.mode.mode).toBe('reserve')
    expect(hasMarker(store.units[0]!.mode, 'reserve')).toBe(true)
  })
})
