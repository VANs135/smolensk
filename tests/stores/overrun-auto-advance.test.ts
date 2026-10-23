import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ActionKey,
  type ConsoleUnit,
} from '@/stores'

/** 与 F 段流程测试同口径：进到本段允许该动作的环节 */
function goToActionStep(
  store: {
    phase: string
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

/**
 * 8.0 / 9.12g-D：**成功的突袭后必须战后推进**（批 F·F2 收口）
 *
 * 原文（通规 v4.3）：
 *   8.0「……如果该防御方撤退或被摧毁，**所有攻击单位都必须进入该格**（无需额外的移动消耗）。」
 *   9.12g-D「**成功的突袭后必须战后推进**。但常规战斗后并非必须如此，由拥有者玩家选择
 *     哪些攻击单位进行推进（如果有的话）。」
 *
 * ⇒ 推进对突袭是**规则强制项**、对常规战斗才是**玩家选项**。故撤退步收束后由 store 自动
 *   收推进步；玩家再点一次只是幂等（`confirmCombatAdvance` 对已收束的战斗直接报成功，
 *   不重复落盘）。
 *
 * 用真实地图与真实单位库（不造数）；对照组钉住「常规战斗**不**自动推进」（9.12g-D 末句）。
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

function place(
  store: Store,
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

/** 强突袭者：攻值够高，能把弱守方打退（⇒ 防御格清空，8.0 的进入前提成立） */
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

describe('8.0 / 9.12g-D：突袭后**必须**战后推进（自动收束）', () => {
  let store: Store

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useWorkbenchStore()
    store.resetAll(11)
  })

  /** 摆强突袭者 + 相邻弱守方，返回满足 8.1 的突袭目标格 */
  function placeStrongOverrun(): HexRef {
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
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        return candidate
      }
      store.units = store.units.filter((unit) => unit.instanceId !== defender.instanceId)
    }
    throw new Error('起点周围找不到满足 8.1 的突袭目标格')
  }

  /** 走完九步到撤退步收束；返回撤退是否已发生 */
  function driveToRetreatEnd(): void {
    driveCombatSteps(store)
    driveResolutionLossFirst(store)
    if (store.combatState?.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
    }
  }

  it('突袭成功（防御格清空）⇒ 撤退收束后**自动**推进，无需玩家点确认（8.0 / 9.12g-D）', () => {
    const target = placeStrongOverrun()
    expect(store.overrunNow(target)).toBe(true)
    expect(store.combatState?.attackType).toBe('overrun')

    driveToRetreatEnd()

    // 前提：防御方确实离开了该格（8.0「防御方撤退或被摧毁」）
    expect(store.combatDefendingHexCleared).toBe(true)
    // ★ 关键：不调 confirmCombatAdvance，战斗已收束（突袭推进是强制项，不留玩家选择）
    expect(store.combatState?.finished).toBe(true)
    expect(store.combatAdvanceMandatory).toBe(true)
    expect(store.combatLiveStep).toBeNull()
    // 8.0：所有攻击单位都必须进入该格
    const mover = store.units.find((unit) => unit.instanceId === 'ov1')
    expect(mover).toBeDefined()
    expect(sameHex(mover?.hex, target)).toBe(true)
    // 突袭已记账收束（3 MP 与进格都落回移动交互）
    expect(store.overrunContext).toBeNull()
    // 留痕：日志写明这是 9.12g-D 的强制推进
    expect(store.log.some((line) => line.rule === '9.12g-D')).toBe(true)
  }, 30_000)

  it('自动收束后再点一次「确认推进」⇒ 幂等且不重复落盘（单位仍在目标格、只一个）', () => {
    const target = placeStrongOverrun()
    expect(store.overrunNow(target)).toBe(true)

    driveToRetreatEnd()
    expect(store.combatState?.finished).toBe(true)

    const before = store.units.length
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState?.finished).toBe(true)
    // 二次调用不得把单位再挪一次 / 不得凭空多出单位
    expect(store.units.length).toBe(before)
    const movers = store.units.filter((unit) => unit.instanceId === 'ov1')
    expect(movers).toHaveLength(1)
    expect(sameHex(movers[0]?.hex, target)).toBe(true)
  }, 30_000)

  /*
   * 对照组（9.12g-D 末句）：「常规战斗后**并非必须如此**，由拥有者玩家选择哪些攻击单位进行
   * 推进（如果有的话）」⇒ 常规战斗**不得**自动推进，必须停在推进步等玩家决定。
   * 注：常规战斗停在推进步的契约在 tests/flows/60-phase-f-combat.test.ts 已钉（第 327 行
   *   `expect(store.combatState!.step).toBe('advance')`），本例另钉「不得自动收束」这一点。
   */
  it('对照：常规战斗**不**自动推进（9.12g-D 末句：由玩家选择）', () => {
    // 同一批单位，但走**常规战斗**（战斗阶段 + 宣告战斗），不是突袭
    place(store, overrunMover(), ATTACKER_HEX, 'axis', 'ov1')
    place(store, weakDefender(), DEFENDER_HEX, 'soviet', 'ovd')
    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    store.setFuelPool(0, 60)
    store.clickHex(ATTACKER_HEX)
    store.clickHex(DEFENDER_HEX)
    expect(store.beginCombatNow()).toBe(true)
    expect(store.combatState?.attackType).not.toBe('overrun')

    driveCombatSteps(store)
    driveResolutionLossFirst(store)
    if (store.combatState?.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          if (row.destinations[0] !== undefined)
            store.setRetreatDestinationNow(row.unitId, row.destinations[0].hex)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
    }

    // 先钉住本例确实走到了推进步（否则下面的断言会落空、对照失去意义）
    expect(store.combatState?.step).toBe('advance')
    expect(store.combatState?.finished).toBe(false)
    // ★ 常规战斗：停在推进步等玩家选（**未**自动收束）
    expect(store.combatAdvanceMandatory).toBe(false)
    // 玩家选「不推进」才收束
    store.combatInputs.advanceUnitIds = []
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState?.finished).toBe(true)
  }, 30_000)
})
