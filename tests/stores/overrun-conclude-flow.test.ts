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
 * 批 A 切片 1：**突袭的收束**（8.0 / 8.1a / 8.1f / 9.12g-D）端到端
 *
 * 病灶（用户 2026-09-17 晚报 + 本轮复现）：
 *   · **参突方阵亡那一路没有用例**：既有 `combat-interaction-flow` 的突袭组只覆盖"攻方存活"
 *     （其注释亦写「低攻值单位会在损失步直接阵亡，覆盖不到该分支」）；
 *   · `finishMove()` 在 `overrunContext !== null` 时**只记一行日志就 return** ⇒ 玩家点「结束移动 / 收束」
 *     在界面上**毫无反应**（会话框挡住日志时更是如此），这一步既没有可见拒绝、也没有出路提示。
 *
 * ## 测法边界（如实交代）
 *   · 用**真实地图与真实单位库**：弱突袭者（印刷战斗值 ≤ 2）对强守方（≥ 20），种子 1 下 CRT 在
 *     损失步把攻方打光 —— 这条路是**真实引擎判据**跑出来的，不是手工改状态；
 *   · 本组**只钉两件事**：① 攻方阵亡后收束必须走通且留痕；② 「结束移动」在突袭未收束时**不得静默**
 *     （可见拒绝 + 明确出路），且战斗一结束就必须放行。
 *     **不覆盖**：9.12g-A「有候选但无人合格」这条分支在本作数据下无法自然构造（需要 0-MA 战斗单位），
 *     留待有该数据时再钉（已登记）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const mapFacts = createMapFacts()

/** 与 `createBattleFacts.canEnterForAttack` 同口径的 9.1f 探针 */
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

/** 攻击格：防御格的一个图内邻格，且步兵可进入（9.1f） */
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

function goToMovementStep(store: ReturnType<typeof newStore>): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index >= 0) store.setSegmentStepIndex(index)
}

/** 弱突袭者：印刷战斗值 ≤ 2（会被强守方在损失步打光） */
const weakMover = () =>
  pickRecord(
    'axis',
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 99) <= 2,
  )

/** 强守方：印刷战斗值 ≥ 20 */
const strongDefender = () =>
  pickRecord(
    'soviet',
    (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) >= 20,
  )

function declareSupplyForBoth(store: ReturnType<typeof newStore>): void {
  if (!store.spDumps.some((dump) => dump.id === 'sd-axis'))
    store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  if (!store.spDumps.some((dump) => dump.id === 'sd-soviet'))
    store.spDumps.push({ id: 'sd-soviet', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

/** 走完 9.2 的补给 → AR → 地形 → 奇袭 → 掷骰 */
function driveCombatSteps(store: ReturnType<typeof newStore>): void {
  let declared = false
  let guard = 0
  while (guard < 16) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      if (!declared) {
        declareSupplyForBoth(store)
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

/** 结算第 8 步：损失优先（军力不够时才用撤退），使攻方在损失步被打光 */
function driveResolutionLossFirst(store: ReturnType<typeof newStore>): void {
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

/** 走到「结算完选项」，并把撤退步也走完（若需要），返回是否已到推进步 */
function driveToAdvanceStep(store: ReturnType<typeof newStore>): void {
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

/** 摆一枚弱突袭者并开始移动，返回可突袭的目标格 */
function placeWeakOverrun(store: ReturnType<typeof newStore>): HexRef {
  const mover = place(store, weakMover(), ATTACKER_HEX, 'axis', 'ov1')
  store.setPhase('movement')
  goToMovementStep(store)
  store.setTool('move')
  store.setFuelPool(0, 60)
  // 条 10（批 M）：点格只建取子清单，开拔交由「开始移动」按钮
  store.clickHex(mover.hex)
  expect(store.confirmMovePick()).toBe(true)
  expect(store.moveInteraction).not.toBeNull()
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(ATTACKER_HEX, direction)
    const defender = place(
      store,
      strongDefender(),
      candidate,
      'soviet',
      `d-${String(candidate.col)}`,
    )
    if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
      return candidate
    }
    store.units = store.units.filter((unit) => unit.instanceId !== defender.instanceId)
  }
  throw new Error('起点周围找不到满足 8.1 的突袭目标格')
}

describe('批 A 切片 1：突袭的收束（8.0 / 8.1a / 8.1f）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
    // 种子 1：弱突袭者对强守方时，CRT 在损失步把攻方打光（本条正是要覆盖这一路）
    store.resetAll(1)
  })

  it('8.0/9.12g-D：**参突者阵亡**后仍能收束 —— 推进候选人空 ⇒ 照常收束、留痕、移动不再挂人', () => {
    const target = placeWeakOverrun(store)
    expect(store.overrunNow(target)).toBe(true)
    expect(store.combatState?.attackType).toBe('overrun')

    driveToAdvanceStep(store)

    // 攻方确实已阵亡（本用例的前提，先钉住它，否则后面断言会失去意义）
    expect(store.units.some((unit) => unit.instanceId === 'ov1')).toBe(false)
    expect(store.combatState?.step).toBe('advance')
    // 8.0 末句：防御方未离开该格 ⇒ 不进格；无人可推 ⇒ 候选人空、但推进对突袭是**强制**语义
    expect(store.combatDefendingHexCleared).toBe(false)
    expect(store.combatAdvanceCandidates).toHaveLength(0)
    expect(store.combatAdvanceMandatory).toBe(true)

    // 收束：必须成功（题面「无法推进」在这一路应当表现为"无人可推 ⇒ 直接收束"，不是卡住）
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState?.finished).toBe(true)
    expect(store.overrunContext).toBeNull()
    // 移动交互不得留下"还在移动"的幽灵（参突者已不在盘面 ⇒ 就地收束）
    expect(store.moveInteraction === null || store.moveInteraction.finished).toBe(true)
    expect(store.activeMoveUnits).toHaveLength(0)
    // 留痕：日志里能看出"参突者已不在盘面 ⇒ 无需记账"
    expect(store.log.some((line) => line.text.includes('参突单位已不在盘面'))).toBe(true)
  })

  /*
   * ★ 2026-09-18 二次修（用户报「点的是战斗框里的『确认推进并收束』：会话框一直在，点其它格子还是这个会话框」）：
   *   病灶是**推进成功后界面仍显示推进块** —— 引擎把 `step` 留在 `advance`（只把 `finished` 置真），
   *   而就近小窗按 `combatState?.step` 渲染（**不看 finished**）⇒ 那个块与「确认推进并收束」按钮**永远挂着**，
   *   再点一次只是把同一笔推进又跑一遍（幂等、界面无变化）⇒ 看起来"点了没反应"。
   *   修法：store 暴露"**仍在进行中的**战斗步"（已收束 ⇒ null），界面只读它；引擎语义（step 不提前改写）不动。
   */
  it('战斗已收束 ⇒ **界面不得再显示该步**（combatLiveStep 为 null，而引擎的 step 仍留在 advance）', () => {
    const target = placeWeakOverrun(store)
    expect(store.overrunNow(target)).toBe(true)
    driveToAdvanceStep(store)
    /*
     * ★ 契约变更（H①，2026-09-19，**不是放宽**）：本条现场是"参突者阵亡 ⇒ 推进候选人空"，
     *   而 9.12g-D 说推进是「**如果有的话**」⇒ 现在**在撤退步就自动收束**（修前会停在推进步、
     *   由玩家点一次"确认推进并收束"）⇒ 界面从一开始就没有可渲染的步。
     */
    expect(store.combatState?.finished).toBe(true)
    expect(store.combatLiveStep).toBeNull()

    // 收束之后再点一次仍然幂等（引擎语义不变：`step` 不提前改写）
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState?.finished).toBe(true)
    expect(store.combatState?.step).toBe('advance')
    expect(store.combatLiveStep).toBeNull()
  })

  it('8.1a/8.1f：突袭未收束时「结束移动」**不得静默**；放弃突袭后必须放行', () => {
    const target = placeWeakOverrun(store)
    expect(store.overrunNow(target)).toBe(true)
    // 战斗停在补给步（还没走完 9.2）⇒ 此时点「结束移动」
    expect(store.combatState?.finished).toBe(false)
    expect(store.moveBlocked).toBeNull()

    store.finishMove()

    // ① **可见**拒绝：写进 moveBlocked（对局台的 ActionFeedbackStrip 会显示它），且移动仍在进行
    expect(store.moveBlocked).not.toBeNull()
    expect(store.moveBlocked?.rule).toBe('8.1a')
    expect(store.moveInteraction).not.toBeNull()
    expect(store.moveInteraction?.finished).toBe(false)

    // ② 给出出路：放弃本场突袭后，「结束移动」必须真的生效
    store.cancelCombat()
    expect(store.overrunContext).toBeNull()
    store.finishMove()
    expect(store.moveInteraction === null || store.moveInteraction.finished).toBe(true)
    expect(store.moveBlocked).toBeNull()
  })
})
