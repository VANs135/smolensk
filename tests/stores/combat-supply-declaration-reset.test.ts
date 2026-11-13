import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { groundRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * 12.4：**战斗补给的来源声明属于"本场战斗"**
 *
 * 声明的账本有两份：`combatSupplyDumpIds`（界面显示/候选）与 `combatSupplyDumpPicks`（真正付款用的
 * 多源清单）。修前 `clearCombat()` 只清前者、`beginGroundAttack()` 只把 `attackerAvailableT` 归零，
 * 于是**上一场的来源留在 picks 里**：
 *   · 面板「攻方来源」显示上一场点过的站（看起来像本场已声明）；
 *   · 但可用量已归零 ⇒ `confirmCombatSupply()` 以 12.4 `attackSupplyNotFull` 拒绝；
 *   · 再点同一座站也救不回来（`pickCombatSupplyDump` 对已在 picks 里的 id 是幂等的，可用量仍是 0）。
 * 连续突袭（8.1a 允许同一移动里多次）就会踩到：第二场开打即"来源显示着、却付不出"。
 *
 * 口径：一场战斗开始时**没有任何已声明来源**；一场战斗结束时声明随之作废。
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

type Store = ReturnType<typeof newConsole>

function goToActionStep(store: Store, segment: string): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === segment)
  if (index < 0) throw new Error(`本段没有环节 ${segment}`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${segment}）`)
}

function declareSources(store: Store): void {
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

describe('12.4：战斗补给来源不得跨战斗残留', () => {
  it('放弃战斗（clearCombat）⇒ 已声明的来源一并作废', () => {
    const store = newConsole()
    store.resetAll(11)
    store.setPhase('combat')
    goToActionStep(store, 'combat.combat')
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
    declareSources(store)
    expect(store.combatSupplyDumpIds.attacker).toBe('sd-axis')
    expect(store.combatSupplyDumpPicks.attacker).toEqual(['sd-axis'])

    // 尚未提交补给 ⇒ 允许放弃；放弃＝本场交互状态全清（含来源声明）
    store.cancelCombat()
    expect(store.combatState).toBeNull()
    expect(store.combatSupplyDumpIds).toEqual({ attacker: null, defender: null })
    expect(store.combatSupplyDumpPicks).toEqual({ attacker: [], defender: [] })
  })

  it('连续突袭：第二场开局没有"上一场的来源"（12.4 才能按本场真实声明付款）', () => {
    const store = newConsole()
    store.resetAll(11)
    const mover = placeGround(
      store,
      groundRecord(
        'axis',
        (record) =>
          record.classes?.movementClass === 'leg' &&
          record.attackCapable === true &&
          (record.factors?.combat?.attack ?? 0) >= 20 &&
          (record.steps?.total ?? 0) >= 4,
      ),
      ATTACKER_HEX,
      'axis',
      'ov1',
    )
    store.setPhase('movement')
    goToActionStep(store, 'movement.modeAndMovement')
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.clickHex(mover.hex)
    expect(store.confirmMovePick()).toBe(true)

    const firstTarget = (() => {
      for (const direction of HEX_DIRECTIONS) {
        const candidate = neighbor(ATTACKER_HEX, direction)
        if (
          !isOnMap(candidate) ||
          !mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
        )
          continue
        placeGround(
          store,
          groundRecord(
            'soviet',
            (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) <= 2,
          ),
          candidate,
          'soviet',
          'ovd1',
        )
        if (
          store.overrunTargets.some(
            (hint) => hint.hex.col === candidate.col && hint.hex.row === candidate.row,
          )
        )
          return candidate
        store.units = store.units.filter((unit) => unit.instanceId !== 'ovd1')
      }
      throw new Error('起点周围找不到满足 8.1 的突袭目标格')
    })()

    expect(store.overrunNow(firstTarget)).toBe(true)
    store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
    store.spDumps.push({ id: 'sd-soviet', hex: { ...firstTarget }, side: 'soviet', sp: 8, t: 0 })
    declareSources(store)
    store.confirmCombatSupply()
    store.combatInputs.attackerArUnitId = store.combatAttackers[0]?.instanceId ?? null
    store.declareCombatArStep('attacker')
    store.combatInputs.defenderArUnitId = store.battleDefenders[0]?.instanceId ?? null
    store.declareCombatArStep('defender')
    store.declareCombatTerrainStep()
    store.rollCombatSurprise()
    if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
    store.rollCombatDice()
    // 损失/选项一路用军力损失满足，走到推进步（突袭自动推进后即收束）
    let guard = 0
    while (guard < 12 && store.combatState !== null && store.combatState.finished !== true) {
      guard += 1
      const state = store.combatState
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
    expect(store.combatState?.finished).toBe(true)

    /*
     * 第二场：与第一场结束格相邻再摆一个弱守方。
     * 夹具允许：把已耗 MP 归零，模拟"MA 足够、再突袭一次"的单位（8.1a 允许同一移动多次突袭）。
     */
    mover.mpSpent = 0
    const secondTarget = (() => {
      for (const direction of HEX_DIRECTIONS) {
        const candidate = neighbor(firstTarget, direction)
        if (
          !isOnMap(candidate) ||
          !mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
        )
          continue
        if (
          store.units.some(
            (unit) => unit.hex.col === candidate.col && unit.hex.row === candidate.row,
          )
        )
          continue
        placeGround(
          store,
          groundRecord(
            'soviet',
            (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) <= 2,
          ),
          candidate,
          'soviet',
          'ovd2',
        )
        if (
          store.overrunTargets.some(
            (hint) => hint.hex.col === candidate.col && hint.hex.row === candidate.row,
          )
        )
          return candidate
        store.units = store.units.filter((unit) => unit.instanceId !== 'ovd2')
      }
      throw new Error('第二场没有满足 8.1 的突袭目标格')
    })()

    expect(store.overrunNow(secondTarget)).toBe(true)
    // ★ 关键：第二场开局没有已声明的来源（上一场的 sd-axis / sd-soviet 不得残留）
    expect(store.combatSupplyDumpIds).toEqual({ attacker: null, defender: null })
    expect(store.combatSupplyDumpPicks).toEqual({ attacker: [], defender: [] })
    expect(store.combatInputs.attackerAvailableT).toBe(0)

    // 按本场真实声明再付款 ⇒ 12.4 通过（修前 picks 已含旧站且可用量 0 ⇒ attackSupplyNotFull）
    declareSources(store)
    expect(store.combatSupplyDumpPicks.attacker).toEqual(['sd-axis'])
    expect(store.confirmCombatSupply()).toBe(true)
  }, 30_000)
})
