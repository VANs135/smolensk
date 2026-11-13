import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { groundRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * 9.5b：补给步的"减员"只作用于**本场编成**，且改名单后 AR 预选必须跟着走
 *
 * 9.5b 是"付不出全额 ⇒ **减少参战单位**"（原文：reduce the number of attacking units），
 * 不是重新组编成（9.1 已经锁定）。修前 `toggleCombatSupplyAttacker` 对任何己方算子都放行：
 *   · 点一枚**不在编成里**的单位 ⇒ 被加进 `combatAttackerIds`，面板/AR 候选都把它当参战，
 *     提交补给时才被引擎以 9.5b `attackerNotInComposition` 拒绝——一个"能点但必然被拒"的假入口；
 *   · 减掉**当前 AR 预选**那枚 ⇒ `attackerArUnitId` 仍指向离场者，AR 屏没有金框、点「宣布」被 9.6 拒。
 * 口径：减员只认编成；名单一变，AR 预选回到新名单里的默认值（B30 的同一判据）。
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

const attackerRecord = () =>
  groundRecord(
    'axis',
    (record) =>
      record.isCombat === true && record.attackCapable === true && (record.steps?.total ?? 1) >= 2,
  )

const defenderRecord = () =>
  groundRecord(
    'soviet',
    (record) =>
      record.isCombat === true && record.attackCapable === true && (record.steps?.total ?? 1) >= 2,
  )

type Store = ReturnType<typeof newConsole>

/** 两个攻方在编成里，第三枚同格但**不入编成**（用于验证减员不得"加人"） */
function setupBattle(store: Store): void {
  store.resetAll(11)
  store.setPhase('combat')
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'combat.combat')
  if (index < 0 || !store.setSegmentStepIndex(index)) throw new Error('进入战斗环节失败')
  placeGround(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  placeGround(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a2')
  placeGround(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a3')
  placeGround(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')

  // 点名 a1、a2 ⇒ 编成＝{a1,a2}；a3 同格但不参战（9.1b 可取堆叠一部分）
  store.toggleCombatAttacker('a1')
  store.toggleCombatAttacker('a2')
  store.clickHex(DEFENDER_HEX)
  expect(store.beginCombatNow()).toBe(true)
  expect([...(store.combatState?.composition.attackerIds ?? [])].sort()).toEqual(['a1', 'a2'])
}

function declareAttackerSource(store: Store): void {
  store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

describe('9.5b：补给步减员的一致性', () => {
  it('减员不得把**编成外**的单位加进来（点了必然被 9.5b 拒）', () => {
    const store = newConsole()
    setupBattle(store)
    expect(store.combatState?.step).toBe('combatSupply')

    store.toggleCombatSupplyAttacker('a3')
    expect(store.combatAttackerIds).not.toContain('a3')
    expect(store.combatAttackers.map((unit) => unit.instanceId).sort()).toEqual(['a1', 'a2'])
  })

  it('减掉当前 AR 预选 ⇒ AR 预选改为新名单里的默认值，宣布不被 9.6 拒', () => {
    const store = newConsole()
    setupBattle(store)
    const defaultAr = store.combatInputs.attackerArUnitId
    expect(defaultAr).not.toBeNull()

    store.toggleCombatSupplyAttacker(defaultAr!)
    expect(store.combatAttackerIds).not.toContain(defaultAr)
    // ★ 关键：预选必须跟着新名单走（不再指向离场者）
    expect(store.combatInputs.attackerArUnitId).not.toBe(defaultAr)
    expect(store.combatAttackerIds).toContain(store.combatInputs.attackerArUnitId)

    declareAttackerSource(store)
    expect(store.confirmCombatSupply()).toBe(true)
    expect(store.combatState?.step).toBe('declareAr')
    // 不手改预选，直接宣布 ⇒ 通过（修前指向离场者，9.6 拒绝）
    expect(store.declareCombatArStep('attacker')).toBe(true)
  })
})
