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
 * 5.4a / 5.7：预备额度在**真实模式切换流程**里的占用与归还
 *
 * 口径（原文 + 用户 2026-11-06 裁定）：
 *   - 5.4a「玩家可以用一个预备标记（4.8b），表示**堆叠中一部分单位全部处于预备模式**」
 *     ⇒ 计量单位是**标记（覆盖组）**，同组只占一枚；
 *   - **转入预备的那一刻即占额度**（原文「完成 25% 的移动后，才需要放置该标记」是实体版
 *     省标记的宽容条款；电子版由程序校验，用户裁定进入即占）；
 *   - 组内**部分释放**（5.7b「release a unit … before deciding to release other Reserves」）
 *     **不归还**；整组走空（5.7b / 5.7d / 5.10c）才归还；
 *   - 上限取剧本初设 `setup.reserveMarkers`（5.4a「严格限制」）。
 *
 * 剧本指派：1 轴 14 / 苏 0；2 轴 14 / 苏 0；3 轴 14 / 苏 4；5 轴 7 / 苏 6（`scenarios.json`）。
 */

const START: HexRef = { col: 57, row: 35 }

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

describe('5.4a 预备额度：转入即占（电子版由程序校验）', () => {
  it('★ 0 MP（完全没动）也能转入预备，且在切换那一刻就占一枚', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const unit = place(store, leg('axis'), START, 'axis', 'a1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    expect(unit.mode.mode).toBe('reserve')
    // 转入即占（不再等到"迈出第一步"）
    expect(store.reserveMarkerGroups).toHaveLength(1)
    expect(store.reserveMarkerGroups[0]!.unitIds).toEqual([unit.instanceId])
    expect(store.reserveMarkerGroups[0]!.side).toBe('axis')
  })

  it('★ 同批转入的两枚共占一枚（堆叠中一部分单位）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const a = place(store, leg('axis'), START, 'axis', 'a1')
    const b = place(store, leg('axis'), START, 'axis', 'b1')
    store.beginMovePick(START, [a.instanceId, b.instanceId])
    store.switchUnitMode('reserve')
    expect(a.mode.mode).toBe('reserve')
    expect(b.mode.mode).toBe('reserve')
    expect(store.reserveMarkerGroups).toHaveLength(1)
    expect(store.reserveMarkerGroups[0]!.unitIds).toEqual([a.instanceId, b.instanceId])
    store.cancelMovePick()
  })

  it('★ 剧本 2 苏方 0 枚 ⇒ 转入预备在切换那一刻就被拒（5.4a）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('2')).toBe(true)
    store.setActiveSide('soviet')
    const unit = place(store, leg('soviet'), START, 'soviet', 's1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    // 被拒 ⇒ 模式未变、账本为空（不留半截状态）
    expect(unit.mode.mode).toBe('combat')
    expect(store.reserveMarkerGroups).toHaveLength(0)
  })

  it('对照：同一苏方单位在剧本 3（苏方 4 枚）里可以转入并占一枚', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('3')).toBe(true)
    store.setActiveSide('soviet')
    const unit = place(store, leg('soviet'), START, 'soviet', 's1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    expect(unit.mode.mode).toBe('reserve')
    expect(store.reserveMarkerGroups).toHaveLength(1)
  })
})

describe('5.4a + 5.7b 并发达上限、部分释放与归还（剧本 5 轴方 7 枚）', () => {
  /** 摆 7 组：START 两枚共一组 + 6 个单枚组 */
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
      expect(store.reserveMarkerGroups).toHaveLength(index + 2)
      expect(unit.mode.mode).toBe('reserve')
    }
    return { a, b }
  }

  it('★ 第 8 组被拒（5.4a）；部分释放不归还，整组走空才归还', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('5')).toBe(true)
    const { a, b } = fillQuota(store)
    expect(store.reserveMarkerGroups).toHaveLength(7)

    // 第 8 组：池已空 ⇒ 拒转（模式不变、账本不增）
    const extraHex: HexRef = { col: 43, row: 35 }
    const extra = place(store, leg('axis'), extraHex, 'axis', 'x6')
    store.clickHex(extraHex)
    store.switchUnitMode('reserve')
    expect(extra.mode.mode).toBe('combat')
    expect(store.reserveMarkerGroups).toHaveLength(7)

    // 5.7b：组内**部分释放**合法（原文「release a unit … before deciding to release other
    // Reserves」）。释放流程本身另有模式用例；这里只造"释放后"的状态，验证**额度不归还**：
    // 引擎用 `releasedFromReserve` 表示"本阶段已释放"，`hasMarker` 随即不再认为它占预备。
    a.mode = { ...a.mode, releasedFromReserve: true }
    expect(hasMarker(a.mode, 'reserve')).toBe(false)
    expect(hasMarker(b.mode, 'reserve')).toBe(true)
    // 该组仍占着那一枚 ⇒ 额度未归还，第 8 组再试仍被拒
    store.clickHex(extraHex)
    store.switchUnitMode('reserve')
    expect(extra.mode.mode).toBe('combat')
    expect(store.reserveMarkerGroups).toHaveLength(7)

    // 最后一名成员也释放 ⇒ 整组走空，额度归还
    b.mode = { ...b.mode, releasedFromReserve: true }
    expect(hasMarker(b.mode, 'reserve')).toBe(false)
    store.clickHex(extraHex)
    store.switchUnitMode('reserve')
    expect(extra.mode.mode).toBe('reserve')
    // 账本保留走空的老条目，但占用数回到上限内（新组是第 8 条）
    expect(store.reserveMarkerGroups).toHaveLength(8)
  })
})

describe('5.4a 读档往返（不新增存档字段，从 session.log 反推）', () => {
  it('★ 存档 → 清空内存账本 → 读档，额度占用恢复', () => {
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
    const groupId = store.reserveMarkerGroups[0]!.id
    expect(game.saveNow()).toBe(true)

    // 模拟"新进程"：内存账本清空，只剩存盘
    store.reserveMarkerGroups = []
    expect(game.loadNow()).toBe(true)

    expect(store.reserveMarkerGroups).toHaveLength(1)
    expect(store.reserveMarkerGroups[0]!.id).toBe(groupId)
    expect(store.reserveMarkerGroups[0]!.unitIds).toEqual([unit.instanceId])
    expect(store.units[0]!.mode.mode).toBe('reserve')
  })
})
