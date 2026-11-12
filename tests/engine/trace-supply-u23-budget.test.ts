import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import {
  canDirectDraw,
  canDrawFromDump,
  canThrowViaHQ,
  formationTraceTradeoff,
  hasTraceSupply,
  traceSourcesFor,
  type BaseSourceKind,
  type ExtenderView,
  type SupplyMobility,
  type ThrowHqView,
  type TraceSupplyFacts,
} from '@/engine/rules'

/**
 * U23（原 G8）：追溯补给 `单位 → 12.6a 源` 的距离上限
 *
 * 用户 2026-11-12 裁定 D1=A：抽象与具象一致 ⇒ 单位到源按 12.3a 的 **5 点轮式 MP**
 * （道路照常计费、不免费）；经 HQ 按 12.3b 印值投递。两条铁律：
 *   ① **源是终点**——到达源即止，不存在"越过源继续沿路免费走"；
 *   ② **路网不能当源**——与源连通的路网不是补给源，不能被无限取用。
 *
 * ★ 本文件是**先红用例**：现状 `baseSourcesFor` / `reachableFrom` 是无界洪泛，
 *   V1/V2/V3(6MP)/V4/V5/V6(直接支/孤立延补队)/V9/V10 应红；V6(已回连延补队)/V7/V8 应绿。
 *   实现由 `trace-supply.ts` 统一改，转绿前不要提交。
 */

const SIDE: Side = 'axis'
const MOBILITY: SupplyMobility = 'truck'

const h = (row: number): HexRef => ({ col: 36, row })

const key = (hex: HexRef): string => `${hex.col}.${hex.row}`

const source = (row: number, kind: BaseSourceKind = 'edgeRail') => ({
  hex: h(row),
  side: SIDE,
  kind,
})

const extender = (row: number, rangeMp = 5): ExtenderView => ({
  hex: h(row),
  side: SIDE,
  mobility: MOBILITY,
  rangeMp,
})

const dump = (row: number) => ({ hex: h(row), side: SIDE })

const throwHq = (row: number, throwRangeMp = 5): ThrowHqView => ({
  hex: h(row),
  side: SIDE,
  mode: 'combat',
  mobility: MOBILITY,
  throwRangeMp,
  throwMobility: MOBILITY,
})

interface FactsOptions {
  sources?: readonly { hex: HexRef; kind: BaseSourceKind }[]
  extenders?: readonly ExtenderView[]
  throwHqs?: readonly ThrowHqView[]
  dumps?: readonly { hex: HexRef }[]
  enemyZoc?: readonly HexRef[]
  enemyCombat?: readonly HexRef[]
  /** 一步的 MP；数字表示每步同价，函数表示按边计费 */
  cost?: number | ((from: HexRef, to: HexRef) => number | null)
}

/** 一条 row 递增的走廊（col 36），只实现测试需要的语义 */
function factsOf(options: FactsOptions = {}): TraceSupplyFacts {
  const zoc = new Set((options.enemyZoc ?? []).map(key))
  const enemy = new Set((options.enemyCombat ?? []).map(key))
  const { cost = 1 } = options
  return {
    onMap: (hex) => hex.col === 36 && hex.row >= 0 && hex.row < 200,
    sourcesFor: (side) =>
      side === SIDE ? (options.sources ?? []).map(({ hex, kind }) => ({ hex, kind })) : [],
    extendersFor: (side) => (side === SIDE ? (options.extenders ?? []) : []),
    throwHqsFor: (side) => (side === SIDE ? (options.throwHqs ?? []) : []),
    dumpsFor: (side) => (side === SIDE ? (options.dumps ?? []).map((item) => item.hex) : []),
    hasEnemyCombatUnit: (hex, side) => side === SIDE && enemy.has(key(hex)),
    inEnemyZoc: (hex, side) => side === SIDE && zoc.has(key(hex)),
    stepCost: (from, to) => (typeof cost === 'number' ? cost : cost(from, to)),
  }
}

const canTrace = (facts: TraceSupplyFacts, row: number): boolean =>
  hasTraceSupply(facts, { hex: h(row), side: SIDE, mobility: MOBILITY }).ok

const sourceCount = (facts: TraceSupplyFacts, row: number): number =>
  traceSourcesFor(facts, { hex: h(row), side: SIDE, mobility: MOBILITY }).length

describe('U23-A：追溯 = 12.3a 的 5 点轮式 MP（单位 → 源）', () => {
  it('V1 沿路 20 格也不自动可供：道路只降费，不豁免 5MP', () => {
    const facts = factsOf({ sources: [source(0)], cost: 1 })
    // 旧实现是无界洪泛，20 格照样可供；裁定 A 下必须断
    expect(canTrace(facts, 20)).toBe(false)
    expect(sourceCount(facts, 20)).toBe(0)
  })

  it('V2 离路 3 格 × 2MP = 6MP：超过 5 点即断', () => {
    const facts = factsOf({ sources: [source(0)], cost: 2 })
    expect(canTrace(facts, 3)).toBe(false)
    expect(sourceCount(facts, 3)).toBe(0)
  })

  it('V3 边界：2+3=5MP 可供；1+1+4=6MP（含格边 +3）断', () => {
    const five = factsOf({
      sources: [source(0)],
      cost: (from) => (from.row === 0 ? 2 : from.row === 1 ? 3 : 1),
    })
    expect(canTrace(five, 2)).toBe(true)

    const six = factsOf({
      sources: [source(0)],
      cost: (from) => (from.row === 2 ? 4 : 1),
    })
    expect(canTrace(six, 3)).toBe(false)
  })

  it('V4 离路 4MP + 沿路 30 格（每格 0.5MP）：总距离 19MP，仍要断', () => {
    const facts = factsOf({
      sources: [source(0)],
      cost: (from) => (from.row < 4 ? 1 : 0.5),
    })
    expect(canTrace(facts, 34)).toBe(false)
    expect(sourceCount(facts, 34)).toBe(0)
  })

  it('V5 离路 3 + 上路 30 + 再离路 3：按整条路径累计 >5，断', () => {
    const facts = factsOf({
      sources: [source(0)],
      cost: (from) => (from.row < 3 || from.row >= 33 ? 1 : 0.5),
    })
    expect(canTrace(facts, 36)).toBe(false)
  })

  it('V6 延补队只创造新源点：已回连的可供，孤立的不供（12.7a 不增加距离）', () => {
    // 直接到基础源 6MP ⇒ 断（旧实现可供）
    expect(canTrace(factsOf({ sources: [source(0)] }), 6)).toBe(false)
    // 延补队在第 3 格（距源 3MP ≤ 印值 5）⇒ 新源点，单位距它 3MP ⇒ 可供
    expect(canTrace(factsOf({ sources: [source(0)], extenders: [extender(3)] }), 6)).toBe(true)
    // 延补队在第 9 格（距源 9MP > 印值 5）⇒ 不可用，单位仍无源 ⇒ 断
    expect(canTrace(factsOf({ sources: [source(0)], extenders: [extender(9)] }), 6)).toBe(false)
  })

  it('V7 不变量：12.3a 直拖 5MP、12.3b 投递印值边界保持原样（12.3c 相邻可再多 1 格）', () => {
    expect(canDirectDraw({ distanceMp: 5 }).ok).toBe(true)
    expect(canDirectDraw({ distanceMp: 6 }).ok).toBe(false)

    const facts = factsOf({ dumps: [dump(0)] })
    expect(canDrawFromDump(facts, { hex: h(5), side: SIDE, mobility: MOBILITY }).ok).toBe(true)
    // 12.3c：补给够到相邻格即可 ⇒ 第 6 格仍可（其相邻格第 5 格在 5MP 内）
    expect(canDrawFromDump(facts, { hex: h(6), side: SIDE, mobility: MOBILITY }).ok).toBe(true)
    expect(canDrawFromDump(facts, { hex: h(7), side: SIDE, mobility: MOBILITY }).ok).toBe(false)

    expect(canThrowViaHQ({ hqMode: 'combat', distanceMp: 5, throwRangeMp: 5 }).ok).toBe(true)
    expect(canThrowViaHQ({ hqMode: 'combat', distanceMp: 6, throwRangeMp: 5 }).ok).toBe(false)
    void throwHq(0)
  })

  it('V8 预算不替代 12.3d：未抵消敌方 ZOC 仍阻挡卡车路径（4.5b 抵消后才通）', () => {
    const blocked = factsOf({ sources: [source(0)], enemyZoc: [h(2)] })
    expect(canTrace(blocked, 4)).toBe(false)

    const negated = factsOf({ sources: [source(0)] })
    expect(canTrace(negated, 4)).toBe(true)
  })

  it('V9 12.6f 编队同源：5MP 内的 A 与 6MP 的 B 必须拆分', () => {
    const facts = factsOf({ sources: [source(0)] })
    const result = formationTraceTradeoff(facts, {
      side: SIDE,
      mobility: MOBILITY,
      units: [
        { id: 'va', hex: h(4) },
        { id: 'vb', hex: h(6) },
      ],
    })
    expect(result.coveredUnitIds).toEqual(['va'])
    expect(result.uncoveredUnitIds).toEqual(['vb'])
    expect(result.sameSource).toBe(false)
  })

  it('V10 13.3c 火车卸货格作为源：距该格 5MP 可供、6MP 断', () => {
    const facts = factsOf({ sources: [source(0, 'detrainable')] })
    expect(canTrace(facts, 5)).toBe(true)
    expect(canTrace(facts, 6)).toBe(false)
  })
})
