import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { isRailHexAt, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 13.5 / 13.5a：**待放置补员的落点**
 *
 * 用户 2026-11-11 改判：初次摆放候选收窄到 2.1 的「能直接拖取追溯补给的 HQ / 图边补给源格」，
 * 不再是「全图 − 敌方占据」；但仍不套 13.5a 的
 * 「战斗面 HQ 2 格内、非敌方 ZOC」；只排除地图外与已被敌方占据的格。13.5a 只约束**重建**。
 * 判据分成两条策略：`replInitialPlacementHexes`（初次）与 `rebuildReplPlacementHexes`（重建）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/**
 * 六邻皆图内、且**格内无铁路**的格
 *
 * 无铁路是给「断补 HQ」那条用例用的：13.3c 派生的卸货格也是 12.6a② 源，
 * 若 HEX 恰是卸货格，围死它也仍按「源在脚下」判成有补给。
 */
const HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return (
      !isRailHexAt(ref) &&
      HEX_DIRECTIONS.every((direction) => {
        const candidate = neighbor(ref, direction)
        return (
          isOnMap(candidate) &&
          mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
        )
      })
    )
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内、且无铁路的格')
  return { col: found.col, row: found.row }
})()

/** 与 `HEX` 相邻的敌方格（同时把 `HEX` 罩进敌方 ZOC） */
const ENEMY_HEX: HexRef = neighbor(HEX, HEX_DIRECTIONS[0])

const keyOf = (hex: HexRef): string => `${hex.col}.${hex.row}`

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
  it('没有 HQ ⇒ 初次摆放收窄到图边补给源格（不再全图）；敌 ZOC 不额外限制', () => {
    const store = newStore()
    rollRepls(store)
    expect(store.replPending).toMatchObject({ pax: 2, eq: 1 })
    expect(store.replPlacementBlockedReason).toBeNull()

    // 放一个敌人到邻格：证明候选取自补给源、不再按"躲避 ZOC"或"全图"来算
    placeEnemyNextTo(store)
    const sources = store.openSupplySourceHexes.map((item) => `${item.col}.${item.row}`)
    const candidates = store.replInitialPlacementHexes.map((item) => `${item.col}.${item.row}`)
    expect(candidates).toEqual(sources)
    expect(candidates).not.toContain(`${HEX.col}.${HEX.row}`)

    const placeHex = store.replInitialPlacementHexes[0]!
    expect(store.beginReplPlaceHexPickNow()).toBe(true)
    expect(store.hexPickView?.candidates).toContainEqual(placeHex)

    expect(store.placePendingReplNow(placeHex)).toBe(true)
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

  it('专规 2.1/3.1：只有「能直接拖取追溯补给」的 HQ 才作落点（断补 HQ 被排除）', () => {
    const hqRecord = unitChoices('axis').find((item) => item.specialized?.includes('hq') === true)
    if (hqRecord === undefined) throw new Error('轴方单位库里没有 HQ')
    const enemyRecord = unitChoices('soviet').find((item) => item.isCombat === true)
    if (enemyRecord === undefined) throw new Error('苏方单位库里没有战斗单位')

    // ① 与剧本图边补给源同格 ⇒ 源在脚下，直接拖取成立 ⇒ 该格是候选
    const connected = newStore()
    rollRepls(connected)
    const sourceHex = connected.openSupplySourceHexes[0]!
    connected.units.push(
      toConsoleUnit({ record: hqRecord, instanceId: 'hq-1', hex: sourceHex, side: 'axis' }),
    )
    expect(connected.replInitialPlacementHexes.map(keyOf)).toContain(keyOf(sourceHex))

    // ② 内陆军 HQ 被六个敌方战斗单位围死 ⇒ 断补 ⇒ 不作落点，退回图边补给源格
    const cut = newStore()
    rollRepls(cut)
    cut.units.push(toConsoleUnit({ record: hqRecord, instanceId: 'hq-1', hex: HEX, side: 'axis' }))
    HEX_DIRECTIONS.forEach((direction, index) => {
      cut.units.push(
        toConsoleUnit({
          record: enemyRecord,
          instanceId: `e${String(index)}`,
          hex: neighbor(HEX, direction),
          side: 'soviet',
        }),
      )
    })
    expect(cut.replInitialPlacementHexes.map(keyOf)).not.toContain(keyOf(HEX))
    expect(cut.replInitialPlacementHexes.map(keyOf)).toEqual(cut.openSupplySourceHexes.map(keyOf))
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
