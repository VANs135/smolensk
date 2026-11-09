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
 * ②b（用户实测复现）— **突袭参战单位串号**
 *
 * 复现路：
 *   1. A 单位突袭结束；
 *   2. 用 B 堆叠突袭附近另一格；
 *   3. 结算里参战的却是 A 单位；
 *   4. 此后无法在该堆叠中改选其它单位。
 *
 * 病灶：`overrunParticipantIds`（8.1g 的参突勾选）在上一场突袭**收束后没有清空**。
 *   · `overrunStackHex` 仍按上一场的参突者取发起格 ⇒ B 的突袭从 A 的格子算；
 *   · `chosen` 仍是 A 的 id（若 A 已结束移动则被过滤成空 ⇒ 6.1g「没有仍在移动中的单位」）；
 *   · 界面按同一份 pin 列候选 ⇒ 在 B 的堆叠里改选不动。
 *
 * 本组只钉三件事：① 收束后参突 pin 与攻方名单清空；② B 再突袭时参战集合只有 B；
 * ③ 普通战斗/炮击不共用这两个选择器（不出现同串号）。
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

function declareSupplyForBoth(
  store: ReturnType<typeof newStore>,
  attackerHex: HexRef,
  defenderHex: HexRef,
): void {
  if (!store.spDumps.some((dump) => dump.id === 'sd-axis'))
    store.spDumps.push({ id: 'sd-axis', hex: { ...attackerHex }, side: 'axis', sp: 8, t: 0 })
  if (!store.spDumps.some((dump) => dump.id === 'sd-soviet'))
    store.spDumps.push({ id: 'sd-soviet', hex: { ...defenderHex }, side: 'soviet', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

/** 走完 9.2 的补给 → AR → 地形 → 奇袭 → 掷骰 */
function driveCombatSteps(
  store: ReturnType<typeof newStore>,
  attackerHex: HexRef,
  defenderHex: HexRef,
): void {
  let declared = false
  let guard = 0
  while (guard < 16) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      if (!declared) {
        declareSupplyForBoth(store, attackerHex, defenderHex)
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

/** 结算：损失优先（军力不够时才用撤退），随后处理撤退步 */
function driveResolution(store: ReturnType<typeof newStore>): void {
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
  if (store.combatState?.step === 'retreat') {
    for (const plan of store.combatRetreatPlans) {
      for (const row of plan.units) {
        store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)
      }
    }
    expect(store.confirmCombatRetreats()).toBe(true)
  }
}

function driveToAdvance(
  store: ReturnType<typeof newStore>,
  attackerHex: HexRef,
  defenderHex: HexRef,
): void {
  driveCombatSteps(store, attackerHex, defenderHex)
  driveResolution(store)
}

/** 摆一对并开始移动 A；若该格不是 8.1 突袭目标则返回 null（换下一对） */
function startOverrun(
  store: ReturnType<typeof newStore>,
  pair: Pair,
  attackerId: string,
  defenderId: string,
): ConsoleUnit | null {
  const mover = place(store, strongMover(), pair.attacker, 'axis', attackerId)
  place(store, weakDefender(), pair.defender, 'soviet', defenderId)
  store.setPhase('movement')
  goToMovementStep(store)
  store.setTool('move')
  store.setFuelPool(0, 60)
  store.clickHex(mover.hex)
  if (!store.confirmMovePick()) return null
  if (!store.overrunTargets.some((hint) => hexDistance(hint.hex, pair.defender) === 0)) {
    store.finishMove()
    store.units = store.units.filter(
      (unit) => unit.instanceId !== mover.instanceId && unit.instanceId !== defenderId,
    )
    return null
  }
  // ★ 复现用户路径：玩家先在「突袭参战」里勾过 A（这正是会被带到下一场的 pin）
  store.toggleOverrunParticipant(attackerId)
  return mover
}

describe('②b 突袭参战单位串号（用户实测复现）', () => {
  let store: ReturnType<typeof newStore>
  const pairs = pairCandidates()

  beforeEach(() => {
    store = newStore()
    store.resetAll(1)
  })

  it('A 突袭收束 ⇒ 参突 pin 与攻方选择清空（不得留给下一场）', () => {
    const pair = pairs[0]!
    const mover = startOverrun(store, pair, 'ov-a', 'def-a')
    expect(mover).not.toBeNull()
    expect(store.overrunParticipantIds).toContain('ov-a')

    expect(store.overrunNow(pair.defender)).toBe(true)
    driveToAdvance(store, pair.attacker, pair.defender)
    if (store.combatState?.step === 'advance') expect(store.confirmCombatAdvance()).toBe(true)

    expect(store.combatState?.finished).toBe(true)
    // 收束后：上一场的参突 pin / 攻方名单都不得残留
    expect(store.overrunParticipantIds).toEqual([])
    expect(store.combatAttackerIds).toEqual([])
    expect(store.combatTagalongIds).toEqual([])
  })

  it('A 突袭后，B 堆叠突袭另一格 ⇒ 参战集合只有 B（且可正常发起）', () => {
    const first = pairs[0]!
    const second = pairs.find(
      (pair) =>
        hexDistance(pair.defender, first.defender) >= 3 &&
        hexDistance(pair.attacker, first.attacker) >= 3,
    )
    expect(second).toBeDefined()

    expect(startOverrun(store, first, 'ov-a', 'def-a')).not.toBeNull()
    expect(store.overrunNow(first.defender)).toBe(true)
    driveToAdvance(store, first.attacker, first.defender)
    if (store.combatState?.step === 'advance') expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState?.finished).toBe(true)

    // 结束 A 的移动 / 清掉上一场战斗的显示态，再起 B 的一堆
    if (store.moveInteraction !== null && store.moveInteraction.finished !== true)
      store.finishMove()
    store.cancelCombat()
    expect(store.combatState).toBeNull()

    expect(startOverrun(store, second!, 'ov-b', 'def-b')).not.toBeNull()
    expect(store.overrunNow(second!.defender)).toBe(true)

    // ★ 用户要的判据：参战集合是 B，不是 A
    expect(store.combatState?.attackType).toBe('overrun')
    expect(store.combatAttackers.map((unit) => unit.instanceId)).toEqual(['ov-b'])
    expect(store.combatAttackers.some((unit) => unit.instanceId === 'ov-a')).toBe(false)
  })

  it('★ A 突袭结束（不点放弃）后直接起 B 突袭 ⇒ 窗口/参战集合只有 B', () => {
    const first = pairs[0]!
    const second = pairs.find(
      (pair) =>
        hexDistance(pair.defender, first.defender) >= 3 &&
        hexDistance(pair.attacker, first.attacker) >= 3,
    )
    expect(second).toBeDefined()

    expect(startOverrun(store, first, 'ov-a', 'def-a')).not.toBeNull()
    expect(store.overrunNow(first.defender)).toBe(true)
    driveToAdvance(store, first.attacker, first.defender)
    if (store.combatState?.step === 'advance') expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState?.finished).toBe(true)
    // ★ 关键：不清 combatState（玩家不会先点「放弃」再打下一场）
    if (store.moveInteraction !== null && store.moveInteraction.finished !== true)
      store.finishMove()

    expect(startOverrun(store, second!, 'ov-b', 'def-b')).not.toBeNull()
    expect(store.overrunNow(second!.defender)).toBe(true)

    expect(store.combatState?.attackType).toBe('overrun')
    expect(store.combatState?.finished).toBe(false)
    expect(store.combatState?.composition.attackerIds).toEqual(['ov-b'])
    expect(store.combatAttackers.map((unit) => unit.instanceId)).toEqual(['ov-b'])
  })

  it('★ 突袭中途放弃后再起一次 ⇒ 不残留上一场的进攻单位', () => {
    const first = pairs[0]!
    const second = pairs.find(
      (pair) =>
        hexDistance(pair.defender, first.defender) >= 3 &&
        hexDistance(pair.attacker, first.attacker) >= 3,
    )
    expect(second).toBeDefined()

    expect(startOverrun(store, first, 'ov-a', 'def-a')).not.toBeNull()
    expect(store.overrunNow(first.defender)).toBe(true)
    store.cancelCombat() // 尚未提交补给 ⇒ 允许放弃
    expect(store.combatState).toBeNull()
    expect(store.overrunParticipantIds).toEqual([])
    expect(store.combatAttackerIds).toEqual([])
    if (store.moveInteraction !== null && store.moveInteraction.finished !== true)
      store.finishMove()

    expect(startOverrun(store, second!, 'ov-b', 'def-b')).not.toBeNull()
    expect(store.overrunNow(second!.defender)).toBe(true)
    expect(store.combatState?.composition.attackerIds).toEqual(['ov-b'])
    expect(store.combatAttackers.map((unit) => unit.instanceId)).toEqual(['ov-b'])
  })

  it('普通战斗/炮击不共用突袭的参突 pin（不出现同串号）', () => {
    // 普通战斗的攻方选择器就是 `combatAttackerIds`；突袭的 pin 只服务 8.1g，不应被战斗读取
    const pair = pairs[0]!
    const mover = startOverrun(store, pair, 'ov-a', 'def-a')
    expect(mover).not.toBeNull()
    // 尚未发起突袭（只是勾选候选）⇒ 常规战斗的攻方名单里不应出现它
    expect(store.combatAttackerIds).toEqual([])
    // 炮击/轰炸有自己的一套参炸名单
    expect(store.barrageUnitIds).toEqual([])
  })
})
