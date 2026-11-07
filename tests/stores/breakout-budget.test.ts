import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'

import type * as EngineRules from '@/engine/rules'
import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'

/**
 * B 闸门：突围段（12.8e-A 路径洪泛）的**计算量**上界（确定性计数）
 *
 * 改造前每个候选做两趟全图洪泛，每格才去查地形/格边 ⇒ 同一格/同一条边被反复查
 * （`terrainsAt` / `crossingBetween` 的调用次数远大于去重数）。改造后一次求值内
 * 按格/按边记忆化 ⇒ 调用次数 == 去重数。断言不看机器快慢。
 */

const counters = vi.hoisted(() => ({
  terrains: 0,
  crossing: 0,
  terrainsSeen: new Set<string>(),
  crossingSeen: new Set<string>(),
  reset(): void {
    this.terrains = 0
    this.crossing = 0
    this.terrainsSeen.clear()
    this.crossingSeen.clear()
  },
}))

vi.mock('@/engine/rules', async (importOriginal) => {
  const actual = await importOriginal<typeof EngineRules>()
  const keyOf = (hex: { col: number; row: number }): string => `${hex.col}.${hex.row}`
  const edgeKeyOf = (a: { col: number; row: number }, b: { col: number; row: number }): string =>
    [keyOf(a), keyOf(b)].sort().join('|')
  return {
    ...actual,
    createMapFacts: () => {
      const inner = actual.createMapFacts()
      return {
        onMap: (hex: { col: number; row: number }) => inner.onMap(hex),
        terrainsAt: (hex: { col: number; row: number }) => {
          counters.terrains += 1
          counters.terrainsSeen.add(keyOf(hex))
          return inner.terrainsAt(hex)
        },
        crossingBetween: (a: { col: number; row: number }, b: { col: number; row: number }) => {
          counters.crossing += 1
          counters.crossingSeen.add(edgeKeyOf(a, b))
          return inner.crossingBetween(a, b)
        },
      }
    },
  }
})

import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'
import { isTransportUnit } from '@/stores/workbench-model'

const INTERIOR: HexRef = (() => {
  for (const hex of mapLayers.hexes) {
    if (hex.col < 12 || hex.col > 40 || hex.row < 12 || hex.row > 24) continue
    const here: HexRef = { col: hex.col, row: hex.row }
    const ok = HEX_DIRECTIONS.every((direction) => {
      const next = neighbor(here, direction)
      return mapLayers.hexes.some((item) => item.col === next.col && item.row === next.row)
    })
    if (ok) return here
  }
  throw new Error('地图上找不到全邻居的内部格')
})()

const at = (index: number, from: HexRef = INTERIOR): HexRef =>
  neighbor(from, HEX_DIRECTIONS[index]!)

const combats = (side: Side) =>
  unitChoices(side).filter((record) => record.isCombat === true && (record.steps?.total ?? 1) <= 1)
const transports = (side: Side) => unitChoices(side).filter((record) => isTransportUnit(record))

/** 摆一个「无追踪友军」的盘面：两趟洪泛都会跑满全图，等价于最坏计算量 */
function armLonelyBreakout(): ReturnType<typeof useWorkbenchStore> {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  store.setActiveSide('axis')
  store.setPhase('movement')
  const specs: { id: string; hex: HexRef; side: Side; truck?: boolean; transport?: boolean }[] = [
    { id: 'truck-lonely', hex: INTERIOR, side: 'axis', truck: true },
    { id: 'leg-lonely', hex: at(2), side: 'axis' },
    { id: 'e-near', hex: at(0), side: 'soviet' },
    { id: 'e-far', hex: at(3, at(4)), side: 'soviet' },
    { id: 'noise', hex: at(4), side: 'axis', transport: true },
  ]
  for (const spec of specs) {
    const record = spec.transport
      ? transports('axis')[0]!
      : spec.side === 'axis'
        ? combats('axis')[0]!
        : combats('soviet')[0]!
    const unit = toConsoleUnit({ record, instanceId: spec.id, hex: spec.hex, side: spec.side })
    if (spec.truck === true) unit.faces.move.mobility = 'truck'
    store.units.push(unit)
  }
  for (const unit of store.units) void unit.hasTraceSupply
  return store
}

describe('突围洪泛的计算量上界（B）', () => {
  it('地形按格只查一次、格边按边只查一次', () => {
    const store = armLonelyBreakout()
    // 先清零，再改动依赖字段触发 computed 重算（否则读到的是摆盘期间已算好的缓存值）
    counters.reset()
    for (const unit of store.units) unit.hasTraceSupply = false
    const candidates = store.breakoutCandidates
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    expect(counters.terrains).toBeGreaterThan(0)
    expect(counters.terrains).toBe(counters.terrainsSeen.size)
    expect(counters.crossing).toBe(counters.crossingSeen.size)
  })
})
