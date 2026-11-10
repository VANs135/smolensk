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
 * 修前：面板只有一个手打格号的输入框，按钮文案写着"点地图选格后放置"但根本没有地图点选流程；
 * `placePendingReplNow` 也不校落点 ⇒ 表现为"补员放不下去"，或能摆到永远用不了的地方。
 * 现在：候选与判据都在 store（`replPlacementCandidateHexes`），面板只调 `beginReplPlaceHexPickNow`。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格（落点与 HQ 都放这里，避免邻格越界影响 ZOC 判定） */
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

function placeHq(store: ReturnType<typeof newStore>): void {
  const record = unitChoices('axis').find((item) => (item.specialized ?? []).includes('hq'))
  if (record === undefined) throw new Error('轴方单位库里没有指挥部')
  store.units.push(toConsoleUnit({ record, instanceId: 'hq-1', hex: HEX, side: 'axis' }))
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

describe('13.5a：补员落点', () => {
  it('有战斗面 HQ ⇒ 候选非空，点格即可放置并落账', () => {
    const store = newStore()
    rollRepls(store)
    expect(store.replPending).toMatchObject({ pax: 2, eq: 1 })

    // 没有 HQ 时先给出可见原因（不是静默失败）
    expect(store.replPlacementBlockedReason).not.toBeNull()
    expect(store.beginReplPlaceHexPickNow()).toBe(false)
    expect(store.replPlacementBlockedReason).toContain('13.5a')

    placeHq(store)
    expect(store.replPlacementBlockedReason).toBeNull()
    expect(store.replPlacementCandidateHexes).toContainEqual(HEX)

    // 进待点态 ⇒ 候选就是 13.5a 的合法格
    expect(store.beginReplPlaceHexPickNow()).toBe(true)
    expect(store.hexPickView?.candidates).toContainEqual(HEX)

    expect(store.placePendingReplNow(HEX)).toBe(true)
    expect(store.replPending).toEqual({ pax: 0, eq: 0 })
    expect(store.units.filter((unit) => unit.replKind === 'pax')).toHaveLength(2)
    expect(store.units.filter((unit) => unit.replKind === 'eq')).toHaveLength(1)
    expect(store.replHoldings).toMatchObject({ pax: 2, eq: 1 })
  })

  it('落点不在 13.5a 的合法格 ⇒ 拒绝并给出原因，待放置态保留', () => {
    const store = newStore()
    rollRepls(store)
    placeHq(store)

    // 图外格不是候选
    expect(store.placePendingReplNow({ col: 999, row: 999 })).toBe(false)
    expect(store.replPending).toMatchObject({ pax: 2, eq: 1 })
    expect(store.units.filter((unit) => unit.replKind != null)).toHaveLength(0)
    expect(store.log.some((entry) => entry.text.includes('13.5a'))).toBe(true)
  })

  it('面板只显示「拿到什么」：骰面 / 表名 / 盘面账本数字不上屏', () => {
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
