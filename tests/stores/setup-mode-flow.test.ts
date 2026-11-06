import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { neighbors } from '@/engine/hex-geometry'
import { hasMarker } from '@/engine/rules'
import {
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * IV-B：初设阶段为指定单位/堆叠设定模式（store 级流程）
 *
 * 原文「Ground units can be set up in any desired mode. (Exception: ground units adjacent to
 * enemy Attack-Capable units cannot be set up in Reserve or Strat Mode.)」
 * ⇒ 初设可设 combat / move / reserve / strat；相邻敌方攻击力单位者不得设预备/战略；
 *   预备仍按 5.4a 的**按格额度**占用（剧本 3/4 另明禁初设预备）。
 *
 * UI 按用户要求不投入：只验证 store 动作可用、状态正确、模式在初设结束后保持。
 */

const START: HexRef = { col: 57, row: 35 }
const hexKey = (hex: HexRef): string => `${String(hex.col)}.${String(hex.row)}`

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), game: useGameSessionStore() }
}

type Store = ReturnType<typeof newStores>['workbench']

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
    (record) => record.classes?.movementClass === 'leg' && record.attackCapable === true,
  )

function place(
  store: Store,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face: 'combat' })
  store.units.push(unit)
  return unit
}

/** 选剧本 + 开局（让 `date` 取该剧本首回合），并手动进入初设阶段 */
function startSetup(store: Store, game: ReturnType<typeof newStores>['game'], scenario: string) {
  expect(game.setScenarioId(scenario)).toBe(true)
  expect(game.startGame()).toBe(true)
  store.initialSetupInProgress = true
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('IV-B：初设四种模式各设一次', () => {
  it('战斗 / 移动 / 预备 / 战略都可通过 store 动作设定', () => {
    const { workbench: store, game } = newStores()
    startSetup(store, game, '1')

    const a = place(store, leg('axis'), START, 'axis', 'a1')
    expect(store.setUnitModeAtSetup('strat', undefined, [a.instanceId])).toBe(true)
    expect(a.mode.mode).toBe('strat')
    // 5.8：战略模式朝向必须是移动面
    expect(a.mode.orientation).toBe('move')

    expect(store.setUnitModeAtSetup('combat', undefined, [a.instanceId])).toBe(true)
    expect(a.mode.mode).toBe('combat')
    expect(a.mode.orientation).toBe('combat')

    expect(store.setUnitModeAtSetup('move', undefined, [a.instanceId])).toBe(true)
    expect(a.mode.mode).toBe('move')
    expect(a.mode.orientation).toBe('move')

    expect(store.setUnitModeAtSetup('reserve', undefined, [a.instanceId])).toBe(true)
    expect(a.mode.mode).toBe('reserve')
    expect(hasMarker(a.mode, 'reserve')).toBe(true)
  })

  it('同格堆叠按一组设定：两枚都进入预备，只占 1 格（5.4a）', () => {
    const { workbench: store, game } = newStores()
    startSetup(store, game, '1')
    const a = place(store, leg('axis'), START, 'axis', 'a1')
    const b = place(store, leg('axis'), START, 'axis', 'b1')
    expect(store.setUnitModeAtSetup('reserve', undefined, [a.instanceId, b.instanceId])).toBe(true)
    expect(a.mode.mode).toBe('reserve')
    expect(b.mode.mode).toBe('reserve')
    expect(store.reservedHexes('axis')).toEqual([hexKey(START)])
  })

  it('非初设阶段调用被拒，且不改模式', () => {
    const { workbench: store, game } = newStores()
    startSetup(store, game, '1')
    store.initialSetupInProgress = false
    const a = place(store, leg('axis'), START, 'axis', 'a1')
    expect(store.setUnitModeAtSetup('move', undefined, [a.instanceId])).toBe(false)
    expect(a.mode.mode).toBe('combat')
    expect(store.log.some((entry) => entry.rule === 'IV-B')).toBe(true)
  })
})

describe('5.4a：初设进入预备即占额度', () => {
  it('剧本 2 苏方 0 枚 ⇒ 初设设预备即被拒', () => {
    const { workbench: store, game } = newStores()
    startSetup(store, game, '2')
    const unit = place(store, leg('soviet'), START, 'soviet', 's1')
    expect(store.setUnitModeAtSetup('reserve', undefined, [unit.instanceId])).toBe(false)
    expect(unit.mode.mode).toBe('combat')
    expect(store.reservedHexes('soviet')).toEqual([])
    expect(store.log.some((entry) => entry.rule === '5.4a')).toBe(true)
  })

  it('剧本 5 轴方 7 枚 ⇒ 第 8 个新格被拒，同格再放行', () => {
    const { workbench: store, game } = newStores()
    startSetup(store, game, '5')
    const first = place(store, leg('axis'), START, 'axis', 'a1')
    expect(store.setUnitModeAtSetup('reserve', undefined, [first.instanceId])).toBe(true)
    for (let index = 0; index < 6; index += 1) {
      const hex: HexRef = { col: 55 - index * 2, row: 35 }
      const unit = place(store, leg('axis'), hex, 'axis', `x${String(index)}`)
      expect(store.setUnitModeAtSetup('reserve', undefined, [unit.instanceId])).toBe(true)
      expect(store.reservedHexes('axis')).toHaveLength(index + 2)
    }
    expect(store.reservedHexes('axis')).toHaveLength(7)

    const extraHex: HexRef = { col: 43, row: 35 }
    const extra = place(store, leg('axis'), extraHex, 'axis', 'x6')
    expect(store.setUnitModeAtSetup('reserve', undefined, [extra.instanceId])).toBe(false)
    expect(extra.mode.mode).toBe('combat')

    // 同格（START）已有预备 ⇒ 满额也能再转入，且不增加占用
    const same = place(store, leg('axis'), START, 'axis', 'x7')
    expect(store.setUnitModeAtSetup('reserve', undefined, [same.instanceId])).toBe(true)
    expect(store.reservedHexes('axis')).toHaveLength(7)
  })

  it('剧本 3 / 4 明禁初设预备（ch11）', () => {
    for (const scenario of ['3', '4']) {
      const { workbench: store, game } = newStores()
      startSetup(store, game, scenario)
      const unit = place(store, leg('axis'), START, 'axis', 'a1')
      expect(store.setUnitModeAtSetup('reserve', undefined, [unit.instanceId])).toBe(false)
      expect(unit.mode.mode).toBe('combat')
      expect(store.log.some((entry) => entry.rule === 'ch11')).toBe(true)
    }
  })
})

describe('IV-B 例外：与敌方攻击力单位相邻', () => {
  it('相邻敌方攻击力单位 ⇒ 初设不得设预备/战略；战斗/移动仍可', () => {
    const { workbench: store, game } = newStores()
    startSetup(store, game, '1')
    const target = place(store, leg('axis'), START, 'axis', 'a1')
    // 用几何邻格（不猜地图地形；只校验邻接事实）
    const adjacent = neighbors(START)[0]!.hex
    place(store, leg('soviet'), adjacent, 'soviet', 's1')

    expect(store.setUnitModeAtSetup('reserve', undefined, [target.instanceId])).toBe(false)
    expect(target.mode.mode).toBe('combat')
    expect(store.setUnitModeAtSetup('strat', undefined, [target.instanceId])).toBe(false)
    expect(target.mode.mode).toBe('combat')
    expect(store.log.some((entry) => entry.rule === 'IV-B')).toBe(true)

    expect(store.setUnitModeAtSetup('combat', undefined, [target.instanceId])).toBe(true)
    expect(store.setUnitModeAtSetup('move', undefined, [target.instanceId])).toBe(true)
  })
})

describe('专规 2.3e：苏军 8 月 1 日前不得初设战略', () => {
  it('剧本 1（7 月 8 日）苏军战略被拒，轴方战略允许', () => {
    const { workbench: store, game } = newStores()
    startSetup(store, game, '1')
    const soviet = place(store, leg('soviet'), START, 'soviet', 's1')
    expect(store.setUnitModeAtSetup('strat', undefined, [soviet.instanceId])).toBe(false)
    expect(soviet.mode.mode).toBe('combat')

    const axis = place(store, leg('axis'), { col: 30, row: 20 }, 'axis', 'a1')
    expect(store.setUnitModeAtSetup('strat', undefined, [axis.instanceId])).toBe(true)
    expect(axis.mode.mode).toBe('strat')
  })

  it('剧本 5（8 月 8 日）苏军可初设战略', () => {
    const { workbench: store, game } = newStores()
    startSetup(store, game, '5')
    const soviet = place(store, leg('soviet'), START, 'soviet', 's1')
    expect(store.setUnitModeAtSetup('strat', undefined, [soviet.instanceId])).toBe(true)
    expect(soviet.mode.mode).toBe('strat')
  })
})

describe('初设结束后模式保持', () => {
  it('离开初设阶段、进入首个移动阶段后，模式与预备标记仍在', () => {
    const { workbench: store, game } = newStores()
    startSetup(store, game, '1')
    const unit = place(store, leg('axis'), START, 'axis', 'a1')
    expect(store.setUnitModeAtSetup('reserve', undefined, [unit.instanceId])).toBe(true)

    store.initialSetupInProgress = false
    store.setActiveSide('axis')
    store.setPhase('movement')

    expect(unit.mode.mode).toBe('reserve')
    expect(hasMarker(unit.mode, 'reserve')).toBe(true)
    expect(store.reservedHexes('axis')).toEqual([hexKey(START)])
  })
})
