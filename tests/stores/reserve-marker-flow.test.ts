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

describe('5.7 / 5.4a 归并：不同起点各走 1/4 MA 进同格 ⇒ 自动腾出一格额度', () => {
  /**
   * 用户 2026-11-06 场景：两处预备单位各走 1/4 MA 归并到同一格后，是否由一枚标记覆盖
   * （＝腾出一枚额度），以及同段内尚未开拔的单位能否立刻用这枚腾出的额度。
   *
   * 原文：5.7「预备模式单位在本方常规移动阶段可移动 1/4 MA」；5.4a「玩家可以用**一个**预备标记
   * 表示**堆叠中一部分单位全部处于预备模式**」（portion 以堆叠/格为界 ⇒ 同格即一枚）；
   * 5.4「各单位/堆叠在**开始移动那一刻**改模式」⇒ 尚未开拔的单位在本段稍后仍可转入。
   * 4.8a「单位在**移动过程中**可以暂时超堆叠」⇒ 归并本身不因堆叠被拒，超堆叠只在环节末结算。
   */
  it('★ 两格各转预备（占 2）→ 各走 1/4 MA 归并同格（占 1）→ 第 5 个未开拔单位同段转入成功（上限 4）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('3')).toBe(true) // 苏方 4 枚（setup.reserveMarkers）
    store.setActiveSide('soviet')

    const a = place(store, leg('soviet'), START, 'soviet', 'a1')
    store.clickHex(START)
    store.switchUnitMode('reserve')
    store.cancelMovePick()
    expect(a.mode.mode).toBe('reserve')

    // 用该单位自己的可到达范围挑归并目标（不猜地形，确保目标在 1/4 MA 之内）
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    const probe = store.groupReachable.hexes[0]
    expect(probe).toBeDefined()
    expect(store.abortMoveNow()).toBe(true)
    const T = probe!.hex
    expect(hexKey(T)).not.toBe(hexKey(START))

    const b = place(store, leg('soviet'), T, 'soviet', 'b1')
    store.clickHex(T)
    store.switchUnitMode('reserve')
    store.cancelMovePick()
    expect(b.mode.mode).toBe('reserve')

    const c1: HexRef = { col: 50, row: 30 }
    const c2: HexRef = { col: 48, row: 28 }
    for (const [hex, id] of [
      [c1, 'c1'],
      [c2, 'c2'],
    ] as const) {
      const unit = place(store, leg('soviet'), hex, 'soviet', id)
      store.clickHex(hex)
      store.switchUnitMode('reserve')
      store.cancelMovePick()
      expect(unit.mode.mode).toBe('reserve')
    }
    expect(store.reservedHexes('soviet')).toHaveLength(4)

    // 上限已满：第 5 个**新格**被拒
    const eHex: HexRef = { col: 46, row: 26 }
    const e = place(store, leg('soviet'), eHex, 'soviet', 'e1')
    store.clickHex(eHex)
    store.switchUnitMode('reserve')
    expect(e.mode.mode).toBe('combat')
    store.cancelMovePick()

    // a 走 1/4 MA 进入 b 所在格（归并；4.8a 允许移动中暂时超堆叠）
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    store.clickHex(T)
    expect(a.hex).toEqual(T)
    expect(a.mpSpent).toBeGreaterThan(0)
    store.finishMove()
    expect(hasMarker(a.mode, 'reserve')).toBe(true)
    expect(hasMarker(b.mode, 'reserve')).toBe(true)

    // 同格两枚预备 ⇒ 只占 1 格；a 的起点格腾出 ⇒ 占用 4 → 3
    expect(store.reservedHexes('soviet')).toHaveLength(3)
    expect(store.reservedHexes('soviet')).toContain(hexKey(T))

    // 同段内还有尚未开拔的单位 ⇒ 5.4 时机仍在窗口内；额度已腾出 ⇒ 可以转入
    store.clickHex(eHex)
    store.switchUnitMode('reserve')
    expect(e.mode.mode).toBe('reserve')
    expect(store.reservedHexes('soviet')).toHaveLength(4)
  })
})
