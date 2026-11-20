import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { barrageTableMeta, createMapFacts, selectMovementTerrain } from '@/engine/rules'
import {
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  actionGateOf,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'
import { readStoreSource } from '../shared/store-source'

/**
 * 21.10 Shells 的 **store 级接线**：付款、降档、撤销与「必须 HQ 投递」。
 *
 * 引擎层账目（2T/枚、溢出作废、混付）在 `tests/engine/supply-cache-shells.test.ts`；
 * 这里只钉「workbench 是否真的按这套账扣/退」，故用真实地图与单位库走完整流程。
 */

function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const mapFacts = createMapFacts()

function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  return selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  }).ok
}

const TARGET_HEX: HexRef = (() => {
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

const FIRING_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)) {
      continue
    }
    if (canEnter('leg', candidate, TARGET_HEX)) return candidate
  }
  throw new Error('目标格没有可进入的图内邻格')
})()

/** 找一门「初始列成本 ≥ 3T」的火炮，便于用 1 枚 Shells 触发降档 */
function artilleryRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find((record) => {
    if (record.isCombat !== true) return false
    const value = record.factors?.combat?.barrage ?? 0
    if (value <= 0) return false
    return barrageTableMeta({ target: 'combatUnits', valueRange: value }).costT >= 3
  })
  if (found === undefined) throw new Error('轴心国单位库中没有成本 ≥ 3T 的火炮')
  return found
}

function defenderRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('soviet').find((record) => record.isCombat === true)
  if (found === undefined) throw new Error('苏联单位库中没有战斗单位')
  return found
}

function setup(store: ReturnType<typeof newStore>) {
  store.setPhase('combat')
  goToActionStep(store, 'barrage.declare')
  const artillery = toConsoleUnit({
    record: artilleryRecord(),
    instanceId: 'art-shells',
    hex: FIRING_HEX,
    side: 'axis',
  })
  store.units.push(artillery)
  const defender = toConsoleUnit({
    record: defenderRecord(),
    instanceId: 'def-shells',
    hex: TARGET_HEX,
    side: 'soviet',
  })
  store.units.push(defender)
  store.battleTarget = { hex: TARGET_HEX, defenderIds: [defender.instanceId] }
  store.setBarrageActive(true)
  store.toggleBarrageUnit(artillery.instanceId)
  return { artillery, defender }
}

function withEmptyDump(store: ReturnType<typeof newStore>): string {
  const id = `shells-dump-${store.spDumps.length}`
  store.spDumps.push({ id, hex: FIRING_HEX, side: 'axis', sp: 0, t: 0 })
  expect(store.pickBarrageSupplyDump(id)).toBe(true)
  return id
}

describe('21.10 Shells 付款接线（store）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('1 枚 Shells + 0 SP：额度 2T ⇒ 降档到 8–11 列，抵 2T、0 浪费、0 SP', () => {
    const store = newStore()
    setup(store)
    store.supplyCacheHoldings.axis = 1
    expect(store.beginBarrageNow()).toBe(true)
    const fullCost = store.barrageState!.table.costT
    expect(fullCost).toBeGreaterThanOrEqual(3)

    withEmptyDump(store)
    // 21.10 只允许「HQ 投递」的炮击；此处置位（真实流程由 pickBarrageSupplyDump 依 HQ 可达性推导）
    store.barrageInputs.fromSameHq = true
    store.barrageShellMarkers = 1

    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.barrageState?.step).toBe('shifts')
    // 成本取降档后的初始列，轰炸值压到列上界
    expect(store.barrageState?.table.costT).toBe(2)
    expect(store.barrageState?.table.columnLabel).toBe('8-11')
    expect(store.barrageState?.totalValue).toBe(11)
    expect(store.supplyCacheHoldings.axis).toBe(0)
    expect(store.spDumps[0]).toMatchObject({ sp: 0, t: 0 })
    expect(store.barragePaidSupply).toMatchObject({ markers: 1, wasteT: 0, t: 0 })
  })

  it('撤销：Shells 原数退回（尚未掷骰 ⇒ 视同未使用）', () => {
    const store = newStore()
    setup(store)
    store.supplyCacheHoldings.axis = 1
    expect(store.beginBarrageNow()).toBe(true)
    withEmptyDump(store)
    store.barrageInputs.fromSameHq = true
    store.barrageShellMarkers = 1

    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.supplyCacheHoldings.axis).toBe(0)
    store.cancelOpsBarrage()
    expect(store.supplyCacheHoldings.axis).toBe(1)
  })

  it('未按 HQ 投递（fromSameHq=false）用 Shells ⇒ 拒绝，账本不动', () => {
    const store = newStore()
    setup(store)
    store.supplyCacheHoldings.axis = 1
    expect(store.beginBarrageNow()).toBe(true)
    withEmptyDump(store)
    store.barrageInputs.fromSameHq = false
    store.barrageShellMarkers = 1

    expect(store.confirmBarrageSupplyStep()).toBe(false)
    expect(store.barrageError?.rule).toBe('21.10')
    expect(store.barrageError?.reason).toBe('shellsRequireHqThrow')
    expect(store.supplyCacheHoldings.axis).toBe(1)
  })

  it('降档重建 table 时同步套用剧本级折扣（Intro 德军 −2T 不被抹掉）', () => {
    const source = readStoreSource()
    expect(source).toContain('barrageTableWithScenarioRule(')
    expect(source).toContain('side: state.side')
  })
})
