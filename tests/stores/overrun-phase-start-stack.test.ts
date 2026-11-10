import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import {
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * P0-1（8.1）：参突单位须**在本环节开始时就同格堆叠**
 *
 * 原文：「参与的进攻单位必须在**阶段开始时**就堆叠在一起……」——修前 store 把
 * `startedStackedTogether` 恒传 `true`（相当于「只要此刻同格就行」），于是
 * 「本环节内才移动过来汇合」的堆叠也能发起突袭，违反 8.1。
 *
 * 口径（用户 2026-11-10 裁定）：按**环节开始时的起始格**与**当前堆叠**求交——
 * 全部参突者的环节起始格必须是同一格；只要有一枚是本环节内才汇合来的，整组突袭即拒。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const mapFacts = createMapFacts()

function canEnter(from: HexRef, to: HexRef): boolean {
  const result = selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility: 'leg',
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  })
  return result.ok
}

interface Pair {
  defender: HexRef
  attacker: HexRef
}

/** 防御格 + 其一个「图内、步兵可进入」的邻格 */
function pairCandidates(): Pair[] {
  const out: Pair[] = []
  for (const hex of mapLayers.hexes) {
    const defender = { col: hex.col, row: hex.row }
    if (defenseTerrainChoices(defender).length === 0) continue
    for (const direction of HEX_DIRECTIONS) {
      const attacker = neighbor(defender, direction)
      if (!isOnMap(attacker)) continue
      if (!mapLayers.hexes.some((item) => item.col === attacker.col && item.row === attacker.row))
        continue
      if (!canEnter(attacker, defender)) continue
      out.push({ defender, attacker })
      break
    }
  }
  return out
}

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 攻值最高的步兵（撑过高攻值列损失步，让突袭能正常收束） */
const strongMover = () => {
  const best = unitChoices('axis')
    .filter((record) => record.classes?.movementClass === 'leg' && record.attackCapable === true)
    .sort((a, b) => (b.factors?.combat?.attack ?? 0) - (a.factors?.combat?.attack ?? 0))[0]
  if (best === undefined) throw new Error('单位库中没有可进攻的 axis 步兵记录')
  return best
}

/** 防御值最低的苏军战斗单位（突袭目标，便于结算快速落定） */
const weakDefender = () => {
  const weakest = unitChoices('soviet')
    .filter((record) => record.isCombat === true)
    .sort((a, b) => (a.factors?.combat?.defense ?? 99) - (b.factors?.combat?.defense ?? 99))[0]
  if (weakest === undefined) throw new Error('单位库中没有 soviet 战斗单位记录')
  return weakest
}

function goToMovementStep(store: ReturnType<typeof newStore>): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index >= 0) store.setSegmentStepIndex(index)
}

describe('P0-1（8.1）参突单位须在环节开始时同格堆叠', () => {
  let store: ReturnType<typeof newStore>
  const pairs = pairCandidates()

  beforeEach(() => {
    store = newStore()
    store.resetAll(1)
  })

  /** 在同一格摆两枚进攻单位 + 一格守军，进入移动并用该格开拔 */
  function setup(pair: Pair, ids: [string, string]): ConsoleUnit[] {
    const movers = [
      place(store, strongMover(), pair.attacker, 'axis', ids[0]),
      place(store, strongMover(), pair.attacker, 'axis', ids[1]),
    ]
    place(store, weakDefender(), pair.defender, 'soviet', `def-${ids[0]}`)
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.clickHex(pair.attacker)
    // 6.1：两枚一起开拔（整堆叠）
    store.setMovePickAll()
    expect(store.confirmMovePick()).toBe(true)
    return movers
  }

  it('环节开始即同格 ⇒ 仍可突袭（回归，不被新闸门误伤）', () => {
    const pair = pairs[0]!
    const movers = setup(pair, ['ps-a', 'ps-b'])
    // 换段时 `resetMovementTracking` 已把两枚的环节起始格刷成当前格
    for (const unit of movers)
      expect(unit.phaseStartHex).toEqual({ col: pair.attacker.col, row: pair.attacker.row })
    expect(store.overrunTargets.some((hint) => hexDistance(hint.hex, pair.defender) === 0)).toBe(
      true,
    )
    expect(store.overrunNow(pair.defender)).toBe(true)
  })

  it('★ 本环节内才汇合（环节起始格不同）⇒ 拒绝突袭（8.1），且不建战斗', () => {
    const pair = pairs[0]!
    setup(pair, ['ps-a', 'ps-b'])
    // 模拟：第二枚是本环节内从别处走过来的（经 store 代理写，触发 computed 重算）
    const joiner = store.units.find((unit) => unit.instanceId === 'ps-b')!
    joiner.phaseStartHex = { col: pair.defender.col, row: pair.defender.row }
    expect(store.units.find((unit) => unit.instanceId === 'ps-b')?.phaseStartHex).toEqual({
      col: pair.defender.col,
      row: pair.defender.row,
    })
    expect(store.overrunNow(pair.defender)).toBe(false)
    expect(store.overrunTargets.some((hint) => hexDistance(hint.hex, pair.defender) === 0)).toBe(
      false,
    )
    expect(store.combatState).toBeNull()
    const latest = store.log[0]
    expect(latest?.rule).toBe('8.1')
    expect(latest?.text).toContain('8.1')
  })

  it('环节开始同格快照在换段时刷新（`resetMovementTracking`）', () => {
    const pair = pairs[0]!
    const unit = place(store, strongMover(), pair.attacker, 'axis', 'ps-c')
    unit.phaseStartHex = null
    const next = store.phase === 'movement' ? 'supply' : 'movement'
    store.setPhase(next)
    expect(store.units.find((item) => item.instanceId === 'ps-c')?.phaseStartHex).toEqual({
      col: pair.attacker.col,
      row: pair.attacker.row,
    })
  })
})
