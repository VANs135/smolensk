import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { scenarioTurnRange } from '@/engine/rules'
import {
  availableMaOf,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 专规 1.5 / 剧本 1–2 接线：`sovietFirstTurnMaFactor` + `moveContext` 注入 + 额度显示同一口径
 *
 * 原文「The Soviets are in disarray, so all of their ground units move at 1/2 MA on the first
 * turn. This can be further adjusted by mode effects (e.g., DG).」
 * ⇒ 仅剧本首回合、仅苏方地面单位，与模式折算相乘；回合前进后恢复。
 */

const START: HexRef = { col: 57, row: 35 }

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), game: useGameSessionStore() }
}

const leg = (side: 'axis' | 'soviet') => {
  const record = unitChoices(side).find(
    (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
  )
  if (record === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return record
}

function place(
  store: ReturnType<typeof newStores>['workbench'],
  side: 'axis' | 'soviet',
  instanceId: string,
) {
  const unit = toConsoleUnit({
    record: leg(side),
    instanceId,
    hex: START,
    side,
    face: 'combat',
  })
  store.units.push(unit)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('专规 1.5：首回合苏军地面单位 ×1/2', () => {
  it('剧本 1 首回合：苏军系数 0.5，轴方 1；引擎额度与显示一致', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    store.turn = scenarioTurnRange('1').firstTurn

    const soviet = place(store, 'soviet', 's1')
    const axis = place(store, 'axis', 'a1')
    expect(store.sovietFirstTurnMaFactor(soviet)).toBe(0.5)
    expect(store.sovietFirstTurnMaFactor(axis)).toBe(1)
    expect(availableMaOf(soviet, 'movement', store.sovietFirstTurnMaFactor(soviet))).toBe(
      soviet.raw.ma * 0.5,
    )
    expect(availableMaOf(axis, 'movement', store.sovietFirstTurnMaFactor(axis))).toBe(axis.raw.ma)
  })

  it('`moveContext` 的引擎视图已带上剧本系数（可达性/取费与界面同一份）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    store.turn = scenarioTurnRange('1').firstTurn
    place(store, 'soviet', 's1')
    const view = store.moveContext.units.find((item) => item.id === 's1')
    expect(view?.scenarioMaFactor).toBe(0.5)
  })

  it('与模式折算相乘：预备移动段 = MA × 1/4 × 1/2', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    store.turn = scenarioTurnRange('1').firstTurn
    const soviet = place(store, 'soviet', 's1')
    soviet.mode = { ...soviet.mode, mode: 'reserve', orientation: 'combat' }
    expect(availableMaOf(soviet, 'movement', store.sovietFirstTurnMaFactor(soviet))).toBe(
      soviet.raw.ma * 0.25 * 0.5,
    )
  })

  it('回合前进后恢复 1（只限首回合）', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('1')).toBe(true)
    const soviet = place(store, 'soviet', 's1')
    store.turn = scenarioTurnRange('1').firstTurn
    expect(store.sovietFirstTurnMaFactor(soviet)).toBe(0.5)
    store.turn = scenarioTurnRange('1').firstTurn + 1
    expect(store.sovietFirstTurnMaFactor(soviet)).toBe(1)
  })

  it('无该数据位的剧本（剧本 5）⇒ 系数 1', () => {
    const { workbench: store, game } = newStores()
    expect(game.setScenarioId('5')).toBe(true)
    store.turn = scenarioTurnRange('5').firstTurn
    const soviet = place(store, 'soviet', 's1')
    expect(store.sovietFirstTurnMaFactor(soviet)).toBe(1)
  })
})
