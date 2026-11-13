import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { actionGateOf, type ActionKey } from '@/stores'
import { groundRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * 9.12g：**防御格未空 ⇒ 没有"战后推进"这件事**
 *
 * 原文：「如果**所有**防御方单位都被摧毁或撤退，则攻击单位就可以进入防御方所在格。」
 * 反过来说：守方还留在防御格里时，"推进"根本不存在 —— 引擎 `resolveAdvanceAfterCombat`
 * 在 `defendingHexCleared === false` 时直接返回 `advanceUnitIds: []`（**静默忽略**传入的勾选）。
 *
 * 但修前面板仍把"付过补给"的攻方做成可点的推进按钮（`combatAdvanceChoices` 不看清空与否）：
 * 玩家勾了几枚、点确认，战斗照常结束、单位却原地不动 —— 与 D 段抓到的"假入口"同一类。
 * 判据必须与地图推进格同源：**推进格为 null（未清空 / 攻方已撤 / 专规 1.1b 禁入）就一枚都不给**。
 */

const DEFENDER_HEX: HexRef = (() => {
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

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      return candidate
  }
  throw new Error('防御格没有图内邻格')
})()

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

type Store = ReturnType<typeof newConsole>

/** 种子 2 下打得出一场"守方留在原地"的战斗（防御格未空、无撤退需求） */
const SEED_DEFENDER_STAYS = 2

function setupBattle(store: Store): void {
  store.resetAll(SEED_DEFENDER_STAYS)
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  placeGround(
    store,
    groundRecord(
      'axis',
      (record) =>
        record.isCombat === true &&
        record.attackCapable === true &&
        (record.steps?.total ?? 1) >= 2,
    ),
    ATTACKER_HEX,
    'axis',
    'a1',
  )
  placeGround(
    store,
    groundRecord(
      'soviet',
      (record) =>
        record.isCombat === true &&
        record.attackCapable === true &&
        (record.steps?.total ?? 1) >= 2,
    ),
    DEFENDER_HEX,
    'soviet',
    'd1',
  )
  store.clickHex(ATTACKER_HEX)
  store.clickHex(DEFENDER_HEX)
  expect(store.beginCombatNow()).toBe(true)
  store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  store.spDumps.push({ id: 'sd-soviet', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

/** 九步走到推进步（选项一律用军力损失满足 ⇒ 守方不撤 ⇒ 防御格保持非空） */
function driveToAdvance(store: Store): void {
  let guard = 0
  while (guard < 20) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
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

describe('9.12g：防御格未空 ⇒ 推进候选一枚都不出现', () => {
  it('守方留在防御格：`combatAdvanceHex` 为 null ⇒ `combatAdvanceChoices` 必须为空', () => {
    const store = newConsole()
    setupBattle(store)
    driveToAdvance(store)

    // 前提：确实走到推进步，且守方没有离开该格
    expect(store.combatState?.step).toBe('advance')
    expect(store.combatDefendingHexCleared).toBe(false)
    expect(store.combatAdvanceHex).toBeNull()

    // 候选事实仍在（这些单位确实付了补给）——但"能不能推"由清空与否先决
    expect(store.combatAdvanceCandidates.length).toBeGreaterThan(0)
    // ★ 关键：地图上不铺推进格 ⇒ 面板也不得给可点的推进按钮
    expect(store.combatAdvanceChoices).toEqual([])

    // 收束：不推进直接结束（引擎本来就会忽略勾选，这里确保没有"点了没用"的错觉）
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState?.finished).toBe(true)
  })
})
