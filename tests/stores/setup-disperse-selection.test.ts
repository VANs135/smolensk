import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useGameSessionStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 初设 † 多选：范围高亮 + 一次拖动整组落位（用户 2026-11-18）
 *
 * 原文格整堆落位、超 10 RE 必做散开的既有逻辑不变；这里只把「选中的多枚」一次带走。
 */

const same = (a: HexRef, b: HexRef) => a.col === b.col && a.row === b.row

/** 真实剧本 1 的自动初设：找一组同格、同属 † 条目、且属于当前布设方的单位 */
function tolerantGroup() {
  setActivePinia(createPinia())
  const setup = useSetupStore()
  const workbench = useWorkbenchStore()
  useGameSessionStore().setScenarioId('3')
  expect(setup.selectScenario('3')).toBe(true)
  const cursor = setup.setupSideCursor
  expect(cursor).not.toBeNull()
  const byHex = new Map<string, string[]>()
  for (const unit of workbench.units) {
    if (unit.side !== cursor || !setup.isStackDisperseUnit(unit.instanceId)) continue
    const key = `${String(unit.hex.col)}.${String(unit.hex.row)}`
    byHex.set(key, [...(byHex.get(key) ?? []), unit.instanceId])
  }
  for (const ids of byHex.values()) if (ids.length >= 2) return { setup, workbench, ids }
  throw new Error(`剧本 3 初设里找不到同格两枚 † 单位（cursor=${cursor ?? 'null'}）`)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('初设多选 † 单位', () => {
  it('★ 选中集的允许落位格取并集，铺到地图候选上', () => {
    const { setup, ids } = tolerantGroup()
    const mapView = useMapViewStore()
    mapView.stackSelection = ids
    const union = setup.disperseCandidatesFor(ids)
    expect(union.length).toBeGreaterThan(0)
    expect(mapView.overlay.setupCandidates?.length).toBe(union.length)
  })

  it('★ 一次拖动把选中整组落到同一格，撤回一步整组回原格', () => {
    const { setup, workbench, ids } = tolerantGroup()
    const before = ids.map((id) => ({
      ...workbench.units.find((unit) => unit.instanceId === id)!.hex,
    }))
    const target = setup.disperseCandidatesFor(ids).find((hex) => !same(hex, before[0]!))
    expect(target).toBeDefined()
    const mapView = useMapViewStore()
    mapView.stackSelection = ids
    expect(mapView.dropMovingCounterAt(ids[0]!, target!)).toBe(true)
    const movedIds = ids.filter((id) => {
      const unit = workbench.units.find((item) => item.instanceId === id)
      return unit !== undefined && same(unit.hex, target!)
    })
    expect(movedIds.length).toBeGreaterThan(1)
    expect(setup.lastPlacement?.label).toContain('×')
    expect(setup.undoLastPlacementNow()).toBe(true)
    for (const [index, id] of ids.entries()) {
      const unit = workbench.units.find((item) => item.instanceId === id)
      expect(unit?.hex).toEqual(before[index])
    }
  })

  it('★ 选中集里只带当前布设方的 † 单位（拖动源同口径）', () => {
    const { setup, ids } = tolerantGroup()
    expect(setup.dispersableIdsAmong([...ids, 'not-a-unit'])).toEqual(ids)
  })
})
