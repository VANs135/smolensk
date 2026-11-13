import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { actionGateOf, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 用户 2026-11-13：突袭会话期间不再铺移动范围与突袭紫环
 *
 * 范围层的唯一数据源是 `groupReachable`；常规战斗没有 `moveInteraction` 所以天然为空，
 * 而突袭必须保留 interaction（3MP 记账 / K5 锚 / 8.1e 收束后继续走），故按 `combatState`
 * 早退。收束后 `clearCombat()` 置空 ⇒ 范围自动恢复；常规战斗仍是基线空。
 */

const ATTACKER_HEX: HexRef = { col: 20, row: 10 }
const DEFENDER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(ATTACKER_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
    )
      return candidate
  }
  throw new Error('起点没有图内邻格')
})()

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}
type Store = ReturnType<typeof newStore>
type UnitRecord = ReturnType<typeof unitChoices>[number]

function place(
  store: Store,
  record: UnitRecord,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
) {
  const unit = toConsoleUnit({ record, instanceId, hex: { ...hex }, side })
  store.units.push(unit)
  return unit
}
function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: UnitRecord) => boolean,
): UnitRecord {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}
const legRecord = () =>
  pickRecord(
    'axis',
    (record) =>
      record.id === 'ax-infantry-ge-78-inf-div' &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg',
  )
const weakDefender = () =>
  pickRecord(
    'soviet',
    (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) <= 2,
  )

function goToMovementStep(store: Store): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index >= 0) store.setSegmentStepIndex(index)
}

function declareSupplies(store: Store): void {
  if (!store.spDumps.some((dump) => dump.id === 'rh-axis'))
    store.spDumps.push({ id: 'rh-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  if (!store.spDumps.some((dump) => dump.id === 'rh-soviet'))
    store.spDumps.push({ id: 'rh-soviet', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

function driveCombat(store: Store): void {
  let declared = false
  let guard = 0
  while (guard < 16) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      if (!declared) {
        declareSupplies(store)
        declared = true
      }
      if (!store.confirmCombatSupply()) break
      continue
    }
    if (state.step === 'declareAr') {
      if (store.combatInputs.attackerArUnitId === null)
        store.combatInputs.attackerArUnitId = store.combatAttackers[0]?.instanceId ?? null
      if (!store.declareCombatArStep('attacker')) break
      if (store.combatInputs.defenderArUnitId === null)
        store.combatInputs.defenderArUnitId = store.battleDefenders[0]?.instanceId ?? null
      if (!store.declareCombatArStep('defender')) break
      continue
    }
    if (state.step === 'declareTerrain') {
      if (!store.declareCombatTerrainStep()) break
      continue
    }
    if (state.step === 'surprise') {
      if (!store.rollCombatSurprise()) break
      if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
      continue
    }
    if (state.step === 'battleDice') {
      if (!store.rollCombatDice()) break
      continue
    }
    break
  }
}

function driveResolution(store: Store): void {
  let guard = 0
  while (guard < 12) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'losses') {
      if (!store.confirmCombatLosses()) break
      continue
    }
    if (state.step === 'options') {
      const requirement = store.combatRequirement!
      const isAttacker = state.resolution.stage === 'attackerOptions'
      const units = isAttacker ? store.combatAttackers : store.battleDefenders
      const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
      if (requirement.options <= capacity) {
        store.combatInputs.optionRetreatHexes = 0
        store.combatInputs.optionLossPoints = requirement.options
      } else {
        store.combatInputs.optionRetreatHexes = requirement.options
        store.combatInputs.optionLossPoints = 0
      }
      if (!store.confirmCombatOptions()) break
      continue
    }
    break
  }
}

describe('突袭会话收起移动范围与紫环', () => {
  let store: Store

  beforeEach(() => {
    store = newStore()
    store.resetAll(29)
  })

  function setupMovingStack() {
    const attacker = place(store, legRecord(), ATTACKER_HEX, 'axis', 'rh-a1')
    place(store, weakDefender(), DEFENDER_HEX, 'soviet', 'rh-d1')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.beginMovePick(ATTACKER_HEX, [attacker.instanceId])
    expect(store.confirmMovePick()).toBe(true)
    return attacker
  }

  it('会话中：范围与紫环收起，但 moveInteraction 保留', () => {
    setupMovingStack()
    // 基线：进会话前两者都有
    expect(store.groupReachable.hexes.length).toBeGreaterThan(0)
    expect(store.overrunTargets.length).toBeGreaterThan(0)

    expect(store.overrunNow(DEFENDER_HEX)).toBe(true)
    expect(store.combatState).not.toBeNull()
    expect(store.moveInteraction).not.toBeNull()
    expect(store.groupReachable.hexes).toEqual([])
    expect(store.overrunTargets).toEqual([])
  })

  it('收束后：范围恢复（同一 interaction），紫环闸门随新堆叠恢复', () => {
    const attacker = setupMovingStack()
    expect(store.overrunNow(DEFENDER_HEX)).toBe(true)
    driveCombat(store)
    driveResolution(store)
    let guard = 0
    while (guard < 6) {
      guard += 1
      const state = store.combatState
      if (state === null || state.finished) break
      if (state.step === 'retreat') {
        for (const plan of store.combatRetreatPlans) {
          for (const row of plan.units)
            expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
        }
        if (!store.confirmCombatRetreats()) break
        continue
      }
      if (state.step === 'advance') {
        expect(store.confirmCombatAdvance()).toBe(true)
        continue
      }
      break
    }
    // 收束即恢复（面板仍可开着看结算，但 8.1e 的「继续移动」范围要回来）
    expect(store.combatState?.finished).toBe(true)
    expect(attacker.mpSpent).toBe(3)
    expect(store.moveInteraction).not.toBeNull()
    expect(store.groupReachable.hexes.length).toBeGreaterThan(0)

    // 紫环闸门确已释放：换一支满 MA 的堆叠贴着敌方格，overrunTargets 重新非空
    store.finishMove()
    const extraEnemy = HEX_DIRECTIONS.map((direction) => neighbor(ATTACKER_HEX, direction)).find(
      (hex) =>
        isOnMap(hex) &&
        hexDistance(hex, DEFENDER_HEX) === 1 &&
        hexDistance(hex, ATTACKER_HEX) === 1,
    )
    expect(extraEnemy).toBeDefined()
    place(store, weakDefender(), extraEnemy!, 'soviet', 'rh-d2')
    const fresh = place(store, legRecord(), ATTACKER_HEX, 'axis', 'rh-a2')
    store.beginMovePick(ATTACKER_HEX, [fresh.instanceId])
    expect(store.confirmMovePick()).toBe(true)
    expect(store.overrunTargets.length).toBeGreaterThan(0)
  })

  it('常规战斗基线：没有 interaction，两者恒为空', () => {
    store.setPhase('combat')
    // 走与推进段测试同一套「按动作门取环节」，避免硬编码环节 id
    const allowed = actionGateOf('combat.declare')
      .where.filter((item) => item.phase === store.phase)
      .map((item) => item.segment)
    const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
    expect(index).toBeGreaterThanOrEqual(0)
    expect(store.setSegmentStepIndex(index)).toBe(true)
    store.setTool('battle')
    store.setFuelPool(0, 20)
    place(store, legRecord(), ATTACKER_HEX, 'axis', 'rh-c1')
    place(
      store,
      pickRecord('soviet', (record) => record.isCombat === true),
      DEFENDER_HEX,
      'soviet',
      'rh-c2',
    )
    store.clickHex(ATTACKER_HEX)
    store.clickHex(DEFENDER_HEX)
    expect(store.beginCombatNow()).toBe(true)
    expect(store.combatState).not.toBeNull()
    expect(store.moveInteraction).toBeNull()
    expect(store.groupReachable.hexes).toEqual([])
    expect(store.overrunTargets).toEqual([])
  })
})
