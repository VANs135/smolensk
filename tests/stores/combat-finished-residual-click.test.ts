import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import { hexCanvasPoint } from '@/render/map-layout'
import {
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 用户实测（2026-11-15，优先级高于 C 段）：
 * 「用一支单位突袭 19.27，攻方全灭；此后防御方已腾空的那格进不去（后续移动其它部队时）」
 *
 * ## 根因（实点取证：live 页面 workbench/mapView 状态）
 *   · 9.2 流程收束后 `combatState` 仍非 null（`finished=true`、`step` 刻意停在 `advance`），
 *     `battleTarget` 也仍在 ⇒ `combatAdvanceHex` 与 `combatRetreatPlans` 继续按**旧战斗**给出：
 *       - `combatAdvanceHex` = 防御格（该格确实已空）；
 *       - `combatRetreatPlans` 仍含守方的 `option.retreatHexes=1` 计划 ⇒ `retreatUnit` 非 null。
 *   · `map-view.onHexClick` 的模态分派**不判 finished**：
 *     先命中「撤退落点」（3907），否则命中「战后推进格」（3912），两者都 `consumed = true`，
 *     于是这一击永远到不了 `workbench.clickHex → tryMoveTo`。
 *   · 结果：已收束那场战斗的**防御格**对后续所有地图点击都是一口"黑洞"，玩家观感＝该格进不去。
 *     攻方全灭只是让"防御格腾空 + 战斗收束"同时成立的最常见局面（守方撤退同样会触发）。
 *
 * 本用例钉的就是这条：收束后，用**地图点击路径**（不是 store.clickHex）把另一支部队走进防御格。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}
type Stores = ReturnType<typeof newStores>

const mapFacts = createMapFacts()

function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  const result = selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  })
  return result.ok
}

/** 六邻皆图内且可作防御格的格 */
const DEFENDER_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    if (defenseTerrainChoices(ref).length === 0) return false
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到「六邻皆图内且可作防御格」的格')
  return { col: found.col, row: found.row }
})()

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)) {
      continue
    }
    if (canEnter('leg', candidate, DEFENDER_HEX)) return candidate
  }
  throw new Error('防御格没有「步兵可进入」的图内邻格')
})()

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

function place(
  workbench: Stores['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  workbench.units.push(unit)
  return unit
}

function goToMovementStep(workbench: Stores['workbench']): void {
  const index = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'movement.modeAndMovement',
  )
  if (index >= 0) workbench.setSegmentStepIndex(index)
}

/** 弱突袭者：单军力、印刷战斗值 ≤ 2（会被强守方在损失步一把打光） */
const weakMover = () =>
  pickRecord(
    'axis',
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 99) <= 2 &&
      (record.steps?.total ?? 1) <= 1,
  )

/** 强守方：印刷战斗值 ≥ 20 */
const strongDefender = () =>
  pickRecord(
    'soviet',
    (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) >= 20,
  )

function declareSupplyForBoth(workbench: Stores['workbench']): void {
  if (!workbench.spDumps.some((dump) => dump.id === 'sd-axis'))
    workbench.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  if (!workbench.spDumps.some((dump) => dump.id === 'sd-soviet'))
    workbench.spDumps.push({
      id: 'sd-soviet',
      hex: { ...DEFENDER_HEX },
      side: 'soviet',
      sp: 8,
      t: 0,
    })
  for (const entry of workbench.combatSupplyDumps) {
    if (workbench.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) workbench.pickCombatSupplyDump(entry.side, dump.id)
  }
}

/** 走完 9.2 的补给 → AR → 地形 → 奇袭 → 掷骰 */
function driveCombatSteps(workbench: Stores['workbench']): void {
  let declared = false
  let guard = 0
  while (guard < 16) {
    guard += 1
    const state = workbench.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      if (!declared) {
        declareSupplyForBoth(workbench)
        declared = true
      }
      if (!workbench.confirmCombatSupply()) break
      continue
    }
    if (state.step === 'declareAr') {
      if (workbench.combatInputs.attackerArUnitId === null) {
        workbench.combatInputs.attackerArUnitId = workbench.combatAttackers[0]?.instanceId ?? null
      }
      if (!workbench.declareCombatArStep('attacker')) break
      if (workbench.combatInputs.defenderArUnitId === null) {
        workbench.combatInputs.defenderArUnitId = workbench.battleDefenders[0]?.instanceId ?? null
      }
      if (!workbench.declareCombatArStep('defender')) break
      continue
    }
    if (state.step === 'declareTerrain') {
      if (!workbench.declareCombatTerrainStep()) break
      continue
    }
    if (state.step === 'surprise') {
      if (!workbench.rollCombatSurprise()) break
      if (workbench.combatAwaitingShiftDie) workbench.rollCombatShiftDie()
      continue
    }
    if (state.step === 'battleDice') {
      if (!workbench.rollCombatDice()) break
      continue
    }
    break
  }
}

/** 损失先吃；守方选项**全部用撤退**（让防御格腾空） */
function driveResolutionDefenderRetreats(workbench: Stores['workbench']): void {
  let guard = 0
  while (guard < 12) {
    guard += 1
    const state = workbench.combatState
    if (state === null || state.finished) break
    if (state.step === 'losses') {
      if (!workbench.confirmCombatLosses()) break
      continue
    }
    if (state.step === 'options') {
      const requirement = workbench.combatRequirement!
      const isAttacker = state.resolution.stage === 'attackerOptions'
      const units = isAttacker ? workbench.combatAttackers : workbench.battleDefenders
      const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
      if (isAttacker) {
        // 攻方全灭时不该到这一屏；到了说明本种子前提不成立
        workbench.combatInputs.optionRetreatHexes = 0
        workbench.combatInputs.optionLossPoints = Math.min(requirement.options, capacity)
      } else {
        workbench.combatInputs.optionRetreatHexes = requirement.options
        workbench.combatInputs.optionLossPoints = 0
      }
      if (!workbench.confirmCombatOptions()) break
      continue
    }
    break
  }
}

function driveToAdvanceStep(workbench: Stores['workbench']): void {
  driveCombatSteps(workbench)
  driveResolutionDefenderRetreats(workbench)
  if (workbench.combatState?.step === 'retreat') {
    for (const plan of workbench.combatRetreatPlans) {
      for (const row of plan.units) {
        const dest = row.destinations[0]
        if (dest === undefined) continue
        workbench.setRetreatDestinationNow(row.unitId, dest.hex)
      }
    }
    expect(workbench.confirmCombatRetreats()).toBe(true)
  }
}

/** 摆一枚弱突袭者并开始移动，返回可突袭的目标格 */
function placeWeakOverrun(workbench: Stores['workbench']): HexRef {
  const mover = place(workbench, weakMover(), ATTACKER_HEX, 'axis', 'ov1')
  workbench.setPhase('movement')
  goToMovementStep(workbench)
  workbench.setTool('move')
  workbench.setFuelPool(0, 60)
  workbench.clickHex(mover.hex)
  expect(workbench.confirmMovePick()).toBe(true)
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(ATTACKER_HEX, direction)
    const defender = place(workbench, strongDefender(), candidate, 'soviet', `d-${candidate.col}`)
    if (workbench.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
      return candidate
    }
    workbench.units = workbench.units.filter((unit) => unit.instanceId !== defender.instanceId)
  }
  throw new Error('起点周围找不到满足 8.1 的突袭目标格')
}

describe('9.2 收束后的残留：防御格不得继续吞掉地图点击（用户 2026-11-15 实测）', () => {
  let stores: Stores

  beforeEach(() => {
    stores = newStores()
  })

  it('突袭攻方全灭、守方撤退腾空 ⇒ 后续部队点该格必须真的走进去（不是被推进/撤退分派吞掉）', () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      stores = newStores()
      const { workbench, mapView } = stores
      // 弱突袭者对强守方：扫种子，取一局 CRT 在损失步把攻方打光的骰序
      workbench.resetAll(seed)
      const target = placeWeakOverrun(workbench)
      expect(workbench.overrunNow(target)).toBe(true)
      driveToAdvanceStep(workbench)
      // 前提不成立（攻方未全灭 / 防御格没腾空）⇒ 换种子
      if (workbench.units.some((unit) => unit.instanceId === 'ov1')) continue
      if (workbench.combatDefendingHexCleared !== true) continue
      expect(workbench.combatState?.step).toBe('advance')
      expect(workbench.confirmCombatAdvance()).toBe(true)
      expect(workbench.combatState?.finished).toBe(true)

      /*
       * 残留证据（收束后仍按旧战斗给「撤退落点 / 推进格」）：
       *   这两项任一为真时，map-view 的模态分派会在 `clickHex` 之前吃掉点击。
       */
      expect(workbench.combatAdvanceHex).not.toBeNull()
      expect(workbench.combatRetreatPlans.length).toBeGreaterThan(0)

      // 另一支部队：从原攻击格出发，沿**真实地图点击**走进去
      goToMovementStep(workbench)
      workbench.setTool('move')
      const follower = place(
        workbench,
        pickRecord(
          'axis',
          (record) =>
            record.isCombat === true &&
            record.classes?.movementClass === 'leg' &&
            (record.factors?.combat?.ma ?? 0) >= 4,
        ),
        ATTACKER_HEX,
        'axis',
        'probe',
      )
      workbench.beginMovePick(ATTACKER_HEX, [follower.instanceId])
      expect(workbench.confirmMovePick()).toBe(true)
      expect(
        workbench.groupReachable.hexes.some(
          (item) => item.hex.col === target.col && item.hex.row === target.row,
        ),
      ).toBe(true)

      const center = hexCanvasPoint(target)
      mapView.onHexClick(target, undefined, { x: center.x, y: center.y })

      expect({ hex: follower.hex, blocked: workbench.moveBlocked }).toEqual({
        hex: target,
        blocked: null,
      })
      return
    }
    throw new Error('80 个种子里没有「攻方全灭 + 守方撤退腾空」的骰序')
  })
})
