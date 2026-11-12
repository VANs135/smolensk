import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  availableMaOf,
  movementPhaseOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * M5 / R1（U4 裁定＝A）的定向用例：**9.5b 补给步减员后按新名单收束**
 *
 * 原文与口径：
 *   · 9.5b「（付不出全额时）可**减少参战单位**」；
 *   · 8.0「如果该防御方撤退或被摧毁，**所有攻击单位**都必须进入该格（无需额外的移动消耗）」；
 *   · 8.1g/h「只有进行突袭的单位才能与突袭中的堆叠一同移动」「其他不参与突袭的友方单位**可以**
 *     位于发起突袭的格内……影响 4.8a，但不参与，结果对其没有影响」；
 *   · 用户 2026-11-12 裁定：堆叠中未参与这次突袭的单位视同 6.1f「移动中放下」——
 *     留在出发格、本次移动结束；**不扣 3 MP、不进防御格**，9.5b 减员后按**新名单**走。
 *
 * 本用例钉住三件事：
 *   ① 被减掉的单位不扣 3 MP（`mpSpent` 不变）、不进入防御格（`hex` 不变）；
 *   ② 它按 6.1f 被放下（`movementEnded === true`）；
 *   ③ 结算后的剩余 MP 按**新名单**重算（取参突者最小值，而不是宣布时的名单）。
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

type Store = ReturnType<typeof useWorkbenchStore>
type UnitRecord = ReturnType<typeof unitChoices>[number]

function place(
  store: Store,
  record: UnitRecord,
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
  predicate: (record: UnitRecord) => boolean,
): UnitRecord {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/**
 * 参突者 A：78 步兵师（leg / atk 20 / MA 4 / 4 步）——减员后**只剩它**，
 * 故“按新名单重算”的剩余 MP 应取它的额度（4 → 扣 3 后 1）。
 */
const strongMover = () =>
  pickRecord(
    'axis',
    (record) =>
      record.id === 'ax-infantry-ge-78-inf-div' &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg',
  )

/** 参突者 B：5 步兵师（leg / atk 20 / MA 3 / 4 步）——在补给步被减掉 */
const reducedMover = () =>
  pickRecord(
    'axis',
    (record) =>
      record.id === 'ax-infantry-ge-5-inf-div' &&
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

/** 九步推进；`beforeSupply` 在首次确认战斗补给**之前**执行一次（这里用来做 9.5b 减员） */
function driveCombatSteps(store: Store, beforeSupply?: () => void): void {
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
        beforeSupply?.()
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

/** 损失优先（军力不够时才改用撤退），把结算推到撤退 / 推进步 */
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

function sameHex(a: HexRef | null | undefined, b: HexRef): boolean {
  return a !== null && a !== undefined && a.col === b.col && a.row === b.row
}

describe('M5 / R1：9.5b 减员后按新名单收束（U4＝A）', () => {
  let store: Store

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useWorkbenchStore()
    store.resetAll(11)
  })

  it('被减掉者不扣 3MP、不进防御格、按 6.1f 放下；剩余 MP 按新名单重算', () => {
    const first = place(store, strongMover(), ATTACKER_HEX, 'axis', 'ov1')
    const second = place(store, reducedMover(), ATTACKER_HEX, 'axis', 'ov2')
    // 复算“按新名单”的期望值：只剩 ov1（MA 4，未耗 MP）⇒ 扣 3 后应为 1
    const maBefore = availableMaOf(first, movementPhaseOf('movement'))
    expect(maBefore).toBe(4)
    expect(availableMaOf(second, movementPhaseOf('movement'))).toBe(3)

    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    // 同一格的整堆叠一起开拔（地图上「摊开即默认全选」的同一入口）
    store.beginMovePick(ATTACKER_HEX, [first.instanceId, second.instanceId])
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction).not.toBeNull()
    // 两枚都在本次移动里，且默认全部参突（8.1g 的“不勾选＝全参突”）
    expect(store.overrunSplitNow?.participantIds.sort()).toEqual([
      first.instanceId,
      second.instanceId,
    ])

    // 找一处满足 8.1 的相邻敌方格
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
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        target = candidate
        break
      }
      store.units = store.units.filter((unit) => unit.instanceId !== defender.instanceId)
    }
    if (target === null) throw new Error('起点周围找不到满足 8.1 的突袭目标格')
    const targetHex = target

    expect(store.overrunNow(targetHex)).toBe(true)
    expect(store.combatState?.attackType).toBe('overrun')
    // 宣布时两人都在编成里
    expect([...(store.combatState?.composition.attackerIds ?? [])].sort()).toEqual([
      first.instanceId,
      second.instanceId,
    ])

    // 9.5b：补给步把第二枚减掉（只留 ov1 参战）
    driveCombatSteps(store, () => store.toggleCombatSupplyAttacker(second.instanceId))
    expect([...(store.combatState?.composition.attackerIds ?? [])]).toEqual([first.instanceId])

    driveResolutionLossFirst(store)
    if (store.combatState?.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
    }
    // 突袭的推进是强制项（9.12g-D），撤退收束后自动进入并收束
    expect(store.combatState?.finished).toBe(true)
    expect(store.combatDefendingHexCleared).toBe(true)

    // ① 参战者进入防御格并扣 3 MP（进格本身免费）
    expect(sameHex(first.hex, targetHex)).toBe(true)
    expect(first.mpSpent).toBe(3)
    expect(first.movementEnded).toBe(false)

    // ② 被减掉者：留在出发格、MP 不变、按 6.1f 放下
    expect(sameHex(second.hex, ATTACKER_HEX)).toBe(true)
    expect(second.mpSpent).toBe(0)
    expect(second.movementEnded).toBe(true)
    expect(
      store.moveUnits.find((unit) => unit.instanceId === second.instanceId)?.movementEnded,
    ).toBe(true)

    // ③ 剩余 MP 按新名单重算：只有 ov1（4 MP）⇒ 扣 3 后剩 1；
    //    若沿用宣布名单（含 MA 3 的 ov2），会错写成“剩余 0 MP”。
    const detail = store.log
      .filter((line) => line.rule === '8.0')
      .map((line) => line.text)
      .join('\n')
    expect(detail).toContain(`剩余 ${maBefore - 3} MP`)
    expect(detail).not.toContain('剩余 0 MP')
  }, 30_000)
})
