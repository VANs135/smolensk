import { describe, expect, it } from 'vitest'

import type { AiCombatSnapshot } from '@/ai/policy'
import { combatSupplyCandidates } from '@/ai/training/candidates'

function combatSupply(overrides: Partial<AiCombatSnapshot> = {}): AiCombatSnapshot {
  return {
    state: { step: 'combatSupply', finished: false },
    defenderHex: { col: 10, row: 10 },
    adjacentDefenderHexes: [],
    attackerDumpIds: [],
    defenderDumpIds: [],
    attackerSupplyConfirmed: false,
    defenderSupplyConfirmed: false,
    attackerStocksApplicable: false,
    defenderStocksApplicable: false,
    requirement: null,
    optionLadder: [],
    optionCapacity: 0,
    retreatPlans: [],
    triedDefenderHexes: [],
    ...overrides,
  }
}

describe('combatSupply 候选：付不出时必须有 combatSkip 出口', () => {
  it('图上无站且不能动储备 ⇒ 只给放弃战斗', () => {
    expect(combatSupplyCandidates(combatSupply())).toEqual([{ kind: 'combatSkip' }])
  })

  it('有站 ⇒ 三条补给落法 + 放弃战斗；不把必拒的组合当成唯一动作', () => {
    const candidates = combatSupplyCandidates(
      combatSupply({ attackerDumpIds: ['dump-a'], defenderDumpIds: ['dump-d'] }),
    )
    expect(candidates.map((action) => action.kind)).toEqual([
      'combatSupply',
      'combatSupply',
      'combatSupply',
      'combatSkip',
    ])
    expect(candidates[0]).toMatchObject({
      kind: 'combatSupply',
      side: 'advance',
      attackerDumpId: 'dump-a',
      defenderDumpId: 'dump-d',
    })
  })

  it('只有部队储备可用 ⇒ 仍给补给候选，并标 internalStocks', () => {
    const candidates = combatSupplyCandidates(
      combatSupply({ attackerStocksApplicable: true, defenderStocksApplicable: true }),
    )
    expect(candidates[0]).toMatchObject({
      kind: 'combatSupply',
      side: 'advance',
      attackerDumpId: null,
      defenderDumpId: null,
      attackerUsesInternalStocks: true,
      defenderUsesInternalStocks: true,
    })
    expect(candidates.at(-1)).toEqual({ kind: 'combatSkip' })
  })
})
