import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 13.5 / 13.5a：**待放置补员的落点**
 *
 * 用户 2026-11-10 裁定：13.5 只说「把结果放置在地图上」，故**初次摆放**不套 13.5a 的
 * 「战斗面 HQ 2 格内、非敌方 ZOC」；只排除地图外与已被敌方占据的格。13.5a 只约束**重建**。
 * 判据分成两条策略：`replInitialPlacementHexes`（初次）与 `rebuildReplPlacementHexes`（重建）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格（避免邻格越界影响 ZOC 判定） */
const HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

/** 与 `HEX` 相邻的敌方格（同时把 `HEX` 罩进敌方 ZOC） */
const ENEMY_HEX: HexRef = neighbor(HEX, HEX_DIRECTIONS[0])

function placeEnemyNextTo(store: ReturnType<typeof newStore>): void {
  const record = unitChoices('soviet').find((item) => item.isCombat === true)
  if (record === undefined) throw new Error('苏方单位库里没有战斗单位')
  store.units.push(toConsoleUnit({ record, instanceId: 'e1', hex: ENEMY_HEX, side: 'soviet' }))
}

function rollRepls(store: ReturnType<typeof newStore>): void {
  store.setTurn(2)
  store.setPhase('reinforcement')
  store.variableReplInputs.autoRoll = false
  store.variableReplInputs.supplyDice = 9
  store.variableReplInputs.replDice = 10
  store.variableReplInputs.specialDie = 2
  expect(store.rollVariableReplNow()).toBe(true)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('13.5：补员初次摆放（不套 13.5a）', () => {
  it('没有 HQ 也能放；敌 ZOC 内的格不作限制', () => {
    const store = newStore()
    rollRepls(store)
    expect(store.replPending).toMatchObject({ pax: 2, eq: 1 })
    expect(store.replPlacementBlockedReason).toBeNull()

    // 放一个敌人到邻格：HEX 落入敌方 ZOC，但按 13.5 字面仍可初次摆放
    placeEnemyNextTo(store)
    expect(store.replInitialPlacementHexes).toContainEqual(HEX)

    expect(store.beginReplPlaceHexPickNow()).toBe(true)
    expect(store.hexPickView?.candidates).toContainEqual(HEX)

    expect(store.placePendingReplNow(HEX)).toBe(true)
    expect(store.replPending).toEqual({ pax: 0, eq: 0 })
    expect(store.units.filter((unit) => unit.replKind === 'pax')).toHaveLength(2)
    expect(store.units.filter((unit) => unit.replKind === 'eq')).toHaveLength(1)
    expect(store.replHoldings).toMatchObject({ pax: 2, eq: 1 })
  })

  it('被敌方单位占据的格与图外格不是候选 ⇒ 拒绝并给原因，待放置态保留', () => {
    const store = newStore()
    rollRepls(store)
    placeEnemyNextTo(store)

    expect(store.replInitialPlacementHexes).not.toContainEqual(ENEMY_HEX)
    expect(store.placePendingReplNow(ENEMY_HEX)).toBe(false)
    expect(store.placePendingReplNow({ col: 999, row: 999 })).toBe(false)
    expect(store.replPending).toMatchObject({ pax: 2, eq: 1 })
    expect(store.units.filter((unit) => unit.replKind != null)).toHaveLength(0)
    expect(store.log.some((entry) => entry.text.includes('13.5'))).toBe(true)
  })

  it('13.5a 的 HQ/ZOC 判据只留给重建（两条策略分开）', () => {
    const store = newStore()
    // 没有战斗面 HQ ⇒ 重建策略无候选，但初次摆放不受影响
    expect(store.rebuildReplPlacementHexes).toHaveLength(0)
    expect(store.replInitialPlacementHexes.length).toBeGreaterThan(0)
  })
})

describe('增援窗精简（源码守卫）', () => {
  it('只显示「拿到什么」：骰面 / 表名 / 盘面账本数字不上屏', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/reinforcement/ReinforcementPanel.vue'),
      'utf8',
    )
    expect(source).not.toContain('骰面自动（补给表')
    expect(source).not.toContain('盘面：Pax')
    expect(source).not.toContain('13.5 可保存的补员')
    // 放置入口只此一条（地图点选，不再是手打格号）
    expect(source).toContain('beginReplPlaceHexPickNow()')
    expect(source).not.toContain('replPlaceHexText')
  })
})
