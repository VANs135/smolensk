import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * B40（12.6f / 13.7a）：**多单位编队的追溯补给必须同源**
 *
 * 原文：**12.6f**「多单位编队中的所有战斗单位需要追溯补给线到**同一个**指挥部，或直接拖取**同一个**补给来源。
 *   如果无法做到这一点，则应选择该编队中的一部分单位进行『免费』的追溯补给，而编队中其他单位则必须使用
 *   图上补给，不然其他单位就会断补。」（13.7a 的补给那一条与之同义）
 *
 * ★ 修前病灶：引擎 `formationTraceTradeoff`（`src/engine/rules/trace-supply.ts:1158`）**零调用**
 *   —— 编队各单位各判各的，这条规则在盘面上**从不发生**（§17.73 取证）。
 *
 * 测法边界：本组只问"**编队内是否被同源取舍排除**"（把 `hasTraceSupply` 当观察点），
 *   不覆盖"玩家之后是否用 12.6c 吃图上补给把它救回来"（那条由 `planOutOfSupply` / `eatOffTheMap` 的既有组覆盖）。
 *   夹具用**同格各放一座补给站**的方式制造"两个来源"，避免依赖地形造价。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/**
 * 两处**相距很远**的内圈格（相隔 30 列 —— 远超追溯补给线的可达范围）
 *
 * ★ 这个距离是本组的**测法要点**，第一版夹具连踩两次：
 *   ① 两格**相邻**时，两座补给站互相都在 12.3a 的直拖范围内 ⇒ 两个单位都能拖到"两座" ⇒ 判成同源；
 *   ② 相隔 8 列**仍然不够** —— 追溯网络（12.6a）的可达范围比 5 MP 直拖长得多，两格照样互通；
 *   相隔 30 列后，每个单位**只**连得到自己那一座 ⇒ 才是真正的"两个来源"。
 */
const [HEX_A, HEX_B] = (() => {
  for (const hex of mapLayers.hexes) {
    if (hex.col < 8 || hex.row < 10 || hex.col > 24 || hex.row > 24) continue
    const a: HexRef = { col: hex.col, row: hex.row }
    const far = mapLayers.hexes.find((item) => item.col === a.col + 30 && item.row === a.row)
    if (far !== undefined) return [a, { col: far.col, row: far.row }] as const
  }
  throw new Error('地图上找不到相距 30 列的内圈两格')
})()

/** 同编队的两个战斗单位（数据里带同一个 `formation`，**定死**） */
const PAIR = (() => {
  const byFormation = new Map<string, ReturnType<typeof unitChoices>>()
  for (const record of unitChoices('axis')) {
    if (record.isCombat !== true) continue
    const formation = record.formation
    if (typeof formation !== 'string') continue
    const list = byFormation.get(formation) ?? []
    list.push(record)
    byFormation.set(formation, list)
  }
  for (const [, list] of byFormation) {
    if (list.length >= 2) return [list[0]!, list[1]!] as const
  }
  throw new Error('单位库里找不到同编队的两个战斗单位')
})()

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B40：12.6f 编队追溯补给的同源取舍', () => {
  it('★ 同编队两个单位都在补给网内 ⇒ 全组照旧获追溯补给，且**不**误报 12.6f', () => {
    const store = newStore()
    store.setPhase('movement')
    store.units.push(
      toConsoleUnit({ record: PAIR[0], instanceId: 'f-1', hex: HEX_A, side: 'axis' }),
      toConsoleUnit({ record: PAIR[1], instanceId: 'f-2', hex: HEX_B, side: 'axis' }),
    )
    expect(PAIR[0].formation).toBe(PAIR[1].formation) // 自检：两枚确属同一编队

    for (const unit of store.units) expect(unit.hasTraceSupply).toBe(true)
    expect(store.log.some((line) => line.text.includes('未 trace 到同一来源'))).toBe(false)
  })

  it('★ 同编队两个单位**同一格**（同一来源）⇒ 同样全组获追溯补给', () => {
    const store = newStore()
    store.setPhase('movement')
    store.units.push(
      toConsoleUnit({ record: PAIR[0], instanceId: 'f-1', hex: HEX_A, side: 'axis' }),
      toConsoleUnit({ record: PAIR[1], instanceId: 'f-2', hex: HEX_A, side: 'axis' }),
    )
    for (const unit of store.units) expect(unit.hasTraceSupply).toBe(true)
    expect(store.log.some((line) => line.text.includes('12.6f'))).toBe(false)
  })

  it('★ 不在编队里的单位（独立单位）不受 12.6f 约束，也不会触发它的告警', () => {
    const store = newStore()
    store.setPhase('movement')
    const loners = unitChoices('axis').filter(
      (record) => record.isCombat === true && (record.formation ?? null) === null,
    )
    store.units.push(
      toConsoleUnit({ record: loners[0]!, instanceId: 'l-1', hex: HEX_A, side: 'axis' }),
      toConsoleUnit({ record: loners[1]!, instanceId: 'l-2', hex: HEX_B, side: 'axis' }),
    )
    for (const unit of store.units) expect(unit.hasTraceSupply).toBe(true)
    expect(store.log.some((line) => line.text.includes('12.6f'))).toBe(false)
  })

  it('★ 源码守卫：接线在 store 这一侧（分组键＝`unit.formation`，判据给引擎的唯一实现）', () => {
    const source = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(source).toContain('function formationTraceDeniedIds')
    expect(source).toContain('const formation = unit.formation')
    expect(source).toContain('formationTraceTradeoff(supplyFacts.value, {')
    expect(source).toContain(
      '(traceCoverageHas(covered, unit.hex) && !denied.has(unit.instanceId))',
    )
  })
})
