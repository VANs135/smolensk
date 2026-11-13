import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * K5：移动撤销链的**不可逆边界**
 *
 * 判据（用户 2026-11-12 裁定）：一步可撤销 ⇔ 它只改动了 `before` 快照能还原的运行态。
 * 快照之外一旦落盘（突袭的 9.5 补给 + 战损/撤退/推进、9.14 特战、1.4b 入盒……），
 * 撤销链必须在该步**之前**截断——否则会把位置与 MP 退回去，战损/补给却留着，盘面两头不一致。
 *
 * 本文件钉两件事：
 *   ① 突袭收束后：`canUndoStep === false`，再点「撤销一步」位置/MP/步数都不动，并给出 6.1 原因；
 *   ② 普通走格：`canUndoStep === true`，撤销仍照旧还原位置与 MP（不误伤合法回退）。
 */

const ATTACKER_HEX: HexRef = { col: 20, row: 10 }

const DEFENDER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(ATTACKER_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
    ) {
      return candidate
    }
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

const mover = () =>
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

function driveCombatSteps(store: Store): void {
  let declared = false
  let guard = 0
  while (guard < 16) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      if (!declared) {
        if (!store.spDumps.some((dump) => dump.id === 'k5-axis'))
          store.spDumps.push({ id: 'k5-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
        if (!store.spDumps.some((dump) => dump.id === 'k5-soviet'))
          store.spDumps.push({
            id: 'k5-soviet',
            hex: { ...DEFENDER_HEX },
            side: 'soviet',
            sp: 8,
            t: 0,
          })
        for (const entry of store.combatSupplyDumps) {
          if (store.combatSupplyDumpIds[entry.side] !== null) continue
          const dump = entry.dumps[0]
          if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
        }
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

function driveResolutionLossFirst(store: Store): void {
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

/** 摆好 78 师 + 弱守方，按地图高亮入口发起突袭并一路走到收束 */
function settleOverrun(store: Store) {
  const attacker = place(store, mover(), ATTACKER_HEX, 'axis', 'k5-a1')
  const defender = place(store, weakDefender(), DEFENDER_HEX, 'soviet', 'k5-d1')
  expect(defender.side).toBe('soviet')

  store.setPhase('movement')
  goToMovementStep(store)
  store.setTool('move')
  store.setFuelPool(0, 60)
  store.beginMovePick(ATTACKER_HEX, [attacker.instanceId])
  expect(store.confirmMovePick()).toBe(true)
  expect(store.overrunTargets.some((hint) => hexDistance(hint.hex, DEFENDER_HEX) === 0)).toBe(true)

  expect(store.overrunNow(DEFENDER_HEX)).toBe(true)
  driveCombatSteps(store)
  driveResolutionLossFirst(store)
  if (store.combatState?.step === 'retreat') {
    for (const plan of store.combatRetreatPlans) {
      for (const row of plan.units)
        expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
    }
    expect(store.confirmCombatRetreats()).toBe(true)
  }
  expect(store.combatState?.finished).toBe(true)
  return { attacker, defender }
}

describe('K5：撤销链在不可逆步之前截断', () => {
  let store: Store

  beforeEach(() => {
    store = newStore()
    store.resetAll(11)
  })

  it('普通走格：canUndoStep=true，撤销仍还原位置与 MP', () => {
    const unit = place(store, mover(), ATTACKER_HEX, 'axis', 'k5-m1')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.beginMovePick(ATTACKER_HEX, [unit.instanceId])
    expect(store.confirmMovePick()).toBe(true)

    const destination = store.groupReachable.hexes[0]
    expect(destination).toBeDefined()
    store.clickHex(destination!.hex)
    expect(store.moveInteraction?.steps).toHaveLength(1)
    expect(unit.mpSpent).toBeGreaterThan(0)
    expect(store.canUndoStep).toBe(true)
    expect(store.undoBlockedReason).toBeNull()

    store.undoLastStep()
    expect(unit.hex).toEqual(ATTACKER_HEX)
    expect(unit.mpSpent).toBe(0)
    expect(store.moveInteraction?.steps).toHaveLength(0)
  })

  it('突袭收束后：撤销一步消失（canUndoStep=false），强制撤也不动位置/MP', () => {
    const { attacker } = settleOverrun(store)

    // 突袭步已进 interaction（kind=overrun），3 MP 已记账
    const steps = store.moveInteraction?.steps ?? []
    expect(steps).toHaveLength(1)
    expect(steps[0]!.kind).toBe('overrun')
    expect(attacker.hex).toEqual(DEFENDER_HEX)
    expect(attacker.mpSpent).toBe(3)

    // K5：边界锚在收束点之后 ⇒ 按钮态为「不可撤」并给出原因
    expect(store.canUndoStep).toBe(false)
    expect(store.undoBlockedReason).toBe(
      '移动已触发突袭战斗（8.0/9.2），只能撤销此后尚未产生额外结算的步骤',
    )

    // 就算绕过按钮直接调 store，也必须拒绝：位置 / MP / 步数一律不动
    store.undoLastStep()
    expect(attacker.hex).toEqual(DEFENDER_HEX)
    expect(attacker.mpSpent).toBe(3)
    expect(store.moveInteraction?.steps).toHaveLength(1)
    expect(store.log[0]?.text).toContain('只能撤销此后尚未产生额外结算的步骤')
  })

  it('放弃本次移动：普通移动可放弃（整次还原并退出会话）', () => {
    const unit = place(store, mover(), ATTACKER_HEX, 'axis', 'k5-m2')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.beginMovePick(ATTACKER_HEX, [unit.instanceId])
    expect(store.confirmMovePick()).toBe(true)
    store.clickHex(store.groupReachable.hexes[0]!.hex)

    expect(store.canAbortMove).toBe(true)
    expect(store.abortMoveNow()).toBe(true)
    expect(store.moveInteraction).toBeNull()
    expect(unit.hex).toEqual(ATTACKER_HEX)
    expect(unit.mpSpent).toBe(0)
  })

  it('放弃本次移动：突袭收束后不可放弃，Esc 分支改走 finishMove 收束且不回滚', () => {
    const { attacker } = settleOverrun(store)

    expect(store.canAbortMove).toBe(false)
    // 绕过按钮直调也必须拒（不还原盘面、不退出）
    expect(store.abortMoveNow()).toBe(false)
    expect(store.moveInteraction).not.toBeNull()
    expect(attacker.hex).toEqual(DEFENDER_HEX)
    expect(attacker.mpSpent).toBe(3)

    // map-view 的 Esc / 会话 × 分支：不可放弃 ⇒ finishMove() 收束退出（会话 finished），但绝不回滚
    store.finishMove()
    expect(store.moveInteraction?.finished).toBe(true)
    expect(attacker.hex).toEqual(DEFENDER_HEX)
    expect(attacker.mpSpent).toBe(3)
    expect(attacker.movementEnded).toBe(true)
  })

  it('放弃本次移动：1.4b 入盒（无步可锚）也算不可放弃', () => {
    const unit = place(store, mover(), ATTACKER_HEX, 'axis', 'k5-b1')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.beginMovePick(ATTACKER_HEX, [unit.instanceId])
    expect(store.confirmMovePick()).toBe(true)
    // 一步都还没走，但盒内已落盘：floor 已在 0 以上 ⇒ 整次回滚必须拒
    store.sealEdgeBoxTransferNow(unit.instanceId)
    expect(store.moveInteraction?.steps).toHaveLength(0)
    expect(store.canAbortMove).toBe(false)
    expect(store.abortMoveNow()).toBe(false)
  })
})
