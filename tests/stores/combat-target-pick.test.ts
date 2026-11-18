import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * 战斗环节的进攻目标选取（9.0/9.1）
 *
 * 用户口径：
 *   · 战斗环节选中堆叠中的单位后，要高亮**确实可以进攻**的敌方单位；
 *   · 一次选中多个堆叠时，高亮这些堆叠**共同**能进攻的目标（按堆叠取交集）；
 *   · 点目标格直接进入 9.2 结算流程，不再另找入口。
 */

const DEFENDER_HEX: HexRef = { col: 1, row: 1 }
/** 防御格的图内邻格（两格都与 DEFENDER_HEX 相邻） */
const STACK_A: HexRef = { col: 1, row: 2 }
const STACK_B: HexRef = { col: 2, row: 1 }

type Store = ReturnType<typeof useWorkbenchStore>
type UnitRecord = ReturnType<typeof unitChoices>[number]

function newStore(): Store {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function pick(side: 'axis' | 'soviet', predicate: (record: UnitRecord) => boolean): UnitRecord {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

const legAttacker = (): UnitRecord =>
  pick(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )

const defender = (): UnitRecord =>
  pick('soviet', (record) => record.isCombat === true && record.attackCapable === true)

function place(
  store: Store,
  record: UnitRecord,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 进入战斗段「战斗环节」（不切「打一仗」工具） */
function setupCombatSegment(store: Store): void {
  store.setPhase('combat')
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'combat.combat')
  if (index < 0) throw new Error('战斗段没有战斗环节')
  expect(store.setSegmentStepIndex(index)).toBe(true)
  store.setFuelPool(0, 20)
}

describe('战斗环节：可进攻目标高亮', () => {
  let store: Store

  beforeEach(() => {
    store = newStore()
  })

  it('战斗环节无需切工具即可高亮相邻敌方格（环节驱动）', () => {
    setupCombatSegment(store)
    place(store, legAttacker(), STACK_A, 'axis', 'a1')
    place(store, defender(), DEFENDER_HEX, 'soviet', 'd1')

    expect(store.combatAttackableHexes).toContainEqual(DEFENDER_HEX)
  })

  it('多堆叠取交集：某个已选堆叠无法进攻时，该目标不高亮', () => {
    setupCombatSegment(store)
    store.setTool('battle')
    place(store, legAttacker(), STACK_A, 'axis', 'a1')
    const blocked = place(store, legAttacker(), STACK_B, 'axis', 'b1')
    place(store, defender(), DEFENDER_HEX, 'soviet', 'd1')
    // 直接构造「两堆叠都已选」的现场；b1 是战略模式，整堆无法进攻（9.1e）
    blocked.mode = { ...blocked.mode, mode: 'strat' }
    store.combatAttackerIds = ['a1', 'b1']

    expect(store.combatAttackableHexes).not.toContainEqual(DEFENDER_HEX)
  })

  it('只选能进攻的那一堆时，目标重新高亮', () => {
    setupCombatSegment(store)
    place(store, legAttacker(), STACK_A, 'axis', 'a1')
    place(store, defender(), DEFENDER_HEX, 'soviet', 'd1')
    store.combatAttackerIds = ['a1']

    expect(store.combatAttackableHexes).toContainEqual(DEFENDER_HEX)
  })

  it('点目标格直接进入 9.2 结算（战斗环节内）', () => {
    setupCombatSegment(store)
    place(store, legAttacker(), STACK_A, 'axis', 'a1')
    place(store, defender(), DEFENDER_HEX, 'soviet', 'd1')

    store.clickHex(DEFENDER_HEX)

    expect(store.battleTarget?.hex).toEqual(DEFENDER_HEX)
    expect(store.combatState?.step).toBe('combatSupply')
  })
})
