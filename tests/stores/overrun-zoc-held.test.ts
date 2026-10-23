import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * 批 F·F2（条 17）：突袭强行进入敌方 ZOC 的格后，4.5a 标记「须再突袭或停、不得离开」。
 *
 * 用真实地图与真实单位库（不造数）；4.5a 标记来自 `settleOverrunMove` 里
 * 对进入格的 `inEnemyZocAt` 判定（引擎不改，只置事实标记供 UI 提示）。
 */

const DEFENDER_HEX: HexRef = (() => {
  for (const hex of mapLayers.hexes) {
    const onMapNeighbors = HEX_DIRECTIONS.filter((direction) => {
      const neighborHex = neighbor({ col: hex.col, row: hex.row }, direction)
      return (
        isOnMap(neighborHex) &&
        mapLayers.hexes.some((item) => item.col === neighborHex.col && item.row === neighborHex.row)
      )
    })
    if (onMapNeighbors.length === 6) return { col: hex.col, row: hex.row }
  }
  throw new Error('地图上找不到「六邻皆图内」的格')
})()

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
    ) {
      return candidate
    }
  }
  throw new Error('防御格没有图内邻格')
})()

function place(
  store: ReturnType<typeof useWorkbenchStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex: { ...hex }, side })
  store.units.push(unit)
  return unit
}

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

const overrunMover = () =>
  pickRecord(
    'axis',
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 20 &&
      (record.steps?.total ?? 0) >= 4,
  )
const weakDefender = () =>
  pickRecord(
    'soviet',
    (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) <= 2,
  )
const anySoviet = () => pickRecord('soviet', (record) => record.isCombat === true)

function goToMovementStep(store: ReturnType<typeof useWorkbenchStore>): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index >= 0) store.setSegmentStepIndex(index)
}

function driveCombatSteps(store: ReturnType<typeof useWorkbenchStore>): void {
  let declared = false
  let guard = 0
  while (guard < 16) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      if (!declared) {
        if (!store.spDumps.some((dump) => dump.id === 'sd-axis'))
          store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
        if (!store.spDumps.some((dump) => dump.id === 'sd-soviet'))
          store.spDumps.push({
            id: 'sd-soviet',
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
      if (store.combatInputs.attackerArUnitId === null) {
        store.combatInputs.attackerArUnitId = store.combatAttackers[0]?.instanceId ?? null
      }
      if (!store.declareCombatArStep('attacker')) break
      if (store.combatInputs.defenderArUnitId === null) {
        store.combatInputs.defenderArUnitId = store.battleDefenders[0]?.instanceId ?? null
      }
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

function driveResolutionLossFirst(store: ReturnType<typeof useWorkbenchStore>): void {
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

describe('批 F·F2（条 17）：突袭进敌方 ZOC ⇒ 4.5a 标记', () => {
  let store: ReturnType<typeof useWorkbenchStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useWorkbenchStore()
    store.resetAll(11)
  })

  /** 把守方摆在起点相邻且满足 8.1 的格上，并在其旁再摆一枚苏军 ⇒ 防御格处于敌方 ZOC */
  function placeDefenderForZocOverrun(): HexRef {
    const mover = place(store, overrunMover(), ATTACKER_HEX, 'axis', 'ov1')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.clickHex(mover.hex)
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction).not.toBeNull()

    for (const direction of HEX_DIRECTIONS) {
      const candidate = neighbor(ATTACKER_HEX, direction)
      if (
        !isOnMap(candidate) ||
        !mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
      ) {
        continue
      }
      const defender = place(store, weakDefender(), candidate, 'soviet', 'ovd')
      // 防御格旁再摆一枚苏军 ⇒ 防御格处于敌方 ZOC（4.5a 的来源）
      for (const d2 of HEX_DIRECTIONS) {
        const witness = neighbor(candidate, d2)
        if (
          isOnMap(witness) &&
          mapLayers.hexes.some((w) => w.col === witness.col && w.row === witness.row) &&
          !(
            (witness.col === ATTACKER_HEX.col && witness.row === ATTACKER_HEX.row) ||
            (witness.col === candidate.col && witness.row === candidate.row)
          )
        ) {
          place(store, anySoviet(), witness, 'soviet', 'ovz')
          break
        }
      }
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        return candidate
      }
      // 该格不满足 8.1 ⇒ 收回（含见证苏军）
      store.units = store.units.filter(
        (unit) => unit.instanceId !== defender.instanceId && unit.instanceId !== 'ovz',
      )
    }
    throw new Error('起点周围找不到满足 8.1 的突袭目标格')
  }

  it('突袭强行进入敌方 ZOC 格 ⇒ overrunZocHeld 标记该格（4.5a：须再突袭或停）', () => {
    const target = placeDefenderForZocOverrun()
    expect(store.overrunNow(target)).toBe(true)
    expect(store.combatState?.attackType).toBe('overrun')

    driveCombatSteps(store)
    driveResolutionLossFirst(store)
    if (store.combatState?.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
    }
    // 突袭推进步（8.0 进入）由其收束；进入格在敌方 ZOC ⇒ 4.5a 标记
    if (!store.confirmCombatAdvance()) {
      store.clearAdvanceNow()
      expect(store.confirmCombatAdvance()).toBe(true)
    }
    expect(store.combatState?.finished).toBe(true)
    expect(store.overrunContext).toBeNull()

    // 4.5a 标记：进入格处于敌方 ZOC ⇒ 须再突袭或停
    expect(store.overrunZocHeld).not.toBeNull()
    expect(store.overrunZocHeld).toEqual(target)
  }, 30_000)

  it('对照：突袭进入非 ZOC 格（见证苏军在不相邻的第二环）⇒ 不标 4.5a', () => {
    const mover = place(store, overrunMover(), ATTACKER_HEX, 'axis', 'ov1')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.clickHex(mover.hex)
    expect(store.confirmMovePick()).toBe(true)

    let target: HexRef | null = null
    for (const direction of HEX_DIRECTIONS) {
      const candidate = neighbor(ATTACKER_HEX, direction)
      if (
        !isOnMap(candidate) ||
        !mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
      ) {
        continue
      }
      const defender = place(store, weakDefender(), candidate, 'soviet', 'ovd')
      // 见证苏军摆在「不相邻的第二环」⇒ 防御格不处于敌方 ZOC（进入格也就不在 ZOC）
      let witnessPlaced = false
      for (const d1 of HEX_DIRECTIONS) {
        const ring1 = neighbor(candidate, d1)
        if (
          !isOnMap(ring1) ||
          !mapLayers.hexes.some((w) => w.col === ring1.col && w.row === ring1.row)
        ) {
          continue
        }
        for (const d2 of HEX_DIRECTIONS) {
          const ring2 = neighbor(ring1, d2)
          if (
            isOnMap(ring2) &&
            mapLayers.hexes.some((w) => w.col === ring2.col && w.row === ring2.row) &&
            hexDistance(candidate, ring2) >= 2
          ) {
            place(store, anySoviet(), ring2, 'soviet', 'ovz')
            witnessPlaced = true
            break
          }
        }
        if (witnessPlaced) break
      }
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        target = candidate
        break
      }
      store.units = store.units.filter(
        (unit) => unit.instanceId !== defender.instanceId && unit.instanceId !== 'ovz',
      )
    }
    expect(target, '应找到满足 8.1 的相邻守方').not.toBeNull()

    expect(store.overrunNow(target!)).toBe(true)
    driveCombatSteps(store)
    driveResolutionLossFirst(store)
    if (store.combatState?.step === 'retreat') {
      // 守方撤退 ⇒ 离开防御格 ⇒ 攻方按 8.0 进入（进入格不在 ZOC ⇒ 不标 4.5a）
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
      expect(store.confirmCombatAdvance()).toBe(true)
    }
    // 守方未离格（持有）⇒ 8.0 不满足、无法进入 ⇒ 同样不标 4.5a（两种情形 flag 都应为 null）
    expect(store.overrunZocHeld).toBeNull()
  }, 30_000)
})
