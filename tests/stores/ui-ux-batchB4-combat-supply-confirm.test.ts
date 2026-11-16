import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { actionGateOf, type ActionKey, type ConsolePhase } from '@/stores'

import { CORE_HEX, NEAR_HEX, combatRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * B4（用户 2026-11-17）：战斗补给的逐方确认必须先看「有没有付款来源」
 *
 * 现场：攻方来源仍是「—」时点「确认攻方补给」，按钮立刻变「已确认攻方 · 改」；
 * 直到点「进入行动值」才报「战斗补给不足：先在地图上点补给站付足攻方所需的 T」。
 * 口径：来源为「—」且未勾储备（守方为「已声明支付」却无来源）时，**确认这一步就拒绝**，
 * 并说明本场需要多少 T、去哪里付款；不能先显示已确认再把错误推给下一步。
 */

function goToActionStep(
  store: {
    phase: ConsolePhase
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

/** 一枚轴心攻方（CORE_HEX）与一枚苏联守方（NEAR_HEX），走到「战斗补给」步 */
function atCombatSupply() {
  const store = newConsole()
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'a1')
  placeGround(store, combatRecord('soviet'), NEAR_HEX, 'soviet', 'd1')
  store.clickHex(NEAR_HEX)
  if (!store.combatAttackerIds.includes('a1')) store.toggleCombatAttacker('a1')
  expect(store.beginCombatNow()).toBe(true)
  expect(store.combatState?.step).toBe('combatSupply')
  return store
}

/** 声明一座本方的足量补给站（12.4：直接拖取/投递都行） */
function declareDump(store: ReturnType<typeof newConsole>, side: 'attacker' | 'defender'): void {
  const hex = side === 'attacker' ? CORE_HEX : NEAR_HEX
  const dumpSide = side === 'attacker' ? 'axis' : 'soviet'
  store.spDumps.push({ id: `sd-${side}`, hex: { ...hex }, side: dumpSide, sp: 8, t: 0 })
  const dumps = store.combatSupplyDumps.find((entry) => entry.side === side)?.dumps ?? []
  const dump = dumps[0]
  expect(dump, `${side} 应能点到刚放的补给站`).toBeTruthy()
  expect(store.pickCombatSupplyDump(side, dump!.id)).toBe(true)
}

const attackerRequiredT = (store: ReturnType<typeof newConsole>): number =>
  store.combatAttackers.reduce((sum, unit) => sum + unit.steps, 0)

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B4：战斗补给逐方确认先验来源', () => {
  it('攻方来源「—」⇒ 确认被拒，并说明还需多少 T、去哪里付款', () => {
    const store = atCombatSupply()
    expect(store.combatInputs.attackerAvailableT).toBe(0)

    expect(store.confirmCombatSupplySide('attacker')).toBe(false)
    expect(store.combatInputs.supplyConfirmed.attacker).toBe(false)
    expect(store.combatError?.rule).toBe('12.4')
    const line = store.combatErrorLine ?? ''
    expect(line).toContain('攻方战斗补给')
    expect(line).toContain(`${attackerRequiredT(store)}`)
    expect(line).toContain('补给站')
    expect(store.log.some((entry) => entry.rule === '12.4' && entry.kind === 'warning')).toBe(true)
  })

  it('点过补给站后再确认 ⇒ 通过，且旧红字被清掉（不残留）', () => {
    const store = atCombatSupply()
    expect(store.confirmCombatSupplySide('attacker')).toBe(false)
    expect(store.combatError).not.toBeNull()

    declareDump(store, 'attacker')
    expect(store.confirmCombatSupplySide('attacker')).toBe(true)
    expect(store.combatInputs.supplyConfirmed.attacker).toBe(true)
    expect(store.combatError).toBeNull()
  })

  it('守方已声明支付但来源「—」⇒ 同样在确认这一步被拒', () => {
    const store = atCombatSupply()
    declareDump(store, 'attacker')
    expect(store.confirmCombatSupplySide('attacker')).toBe(true)

    store.combatInputs = { ...store.combatInputs, defenderProvides: true }
    expect(store.confirmCombatSupplySide('defender')).toBe(false)
    expect(store.combatInputs.supplyConfirmed.defender).toBe(false)
    const line = store.combatErrorLine ?? ''
    expect(line).toContain('守方')
    expect(line).toContain('补给站')
  })

  it('守方选择不支付（9.5-B）⇒ 无来源也允许确认', () => {
    const store = atCombatSupply()
    declareDump(store, 'attacker')
    expect(store.confirmCombatSupplySide('attacker')).toBe(true)

    store.combatInputs = { ...store.combatInputs, defenderProvides: false }
    expect(store.confirmCombatSupplySide('defender')).toBe(true)
    expect(store.combatInputs.supplyConfirmed.defender).toBe(true)
  })
})
