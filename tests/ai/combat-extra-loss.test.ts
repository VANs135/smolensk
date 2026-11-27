import { describe, expect, it } from 'vitest'

import type { AiCombatSnapshot } from '@/ai/policy'
import { combatExtraLossCandidates } from '@/ai/training/candidates'

function retreat(overrides: Partial<AiCombatSnapshot> = {}): AiCombatSnapshot {
  return {
    state: { step: 'retreat', finished: false, declaredAttackerArUnitId: 'a1' },
    defenderHex: { col: 10, row: 10 },
    adjacentDefenderHexes: [],
    attackerDumpIds: [],
    defenderDumpIds: [],
    attackerSupplyConfirmed: true,
    defenderSupplyConfirmed: true,
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

describe('9.12e 撤退额外损失承受者候选', () => {
  it('预演给了候选、没选 ⇒ 列出每一枚可承受的 DG 单位', () => {
    expect(
      combatExtraLossCandidates(
        retreat({
          extraLoss: {
            points: 1,
            choices: [
              { unitId: 'd2', label: 'D2（AR4）', selected: true },
              { unitId: 'd3', label: 'D3（AR2）', selected: false },
            ],
          },
        }),
      ),
    ).toEqual([{ kind: 'combatExtraLossTaker', unitId: 'd3' }])
  })

  it('已选中的那枚不再列（点了不变＝空转）', () => {
    expect(
      combatExtraLossCandidates(
        retreat({
          extraLoss: {
            points: 1,
            choices: [
              { unitId: 'd2', label: 'D2（AR4）', selected: false },
              { unitId: 'd3', label: 'D3（AR2）', selected: true },
            ],
          },
        }),
      ),
    ).toEqual([{ kind: 'combatExtraLossTaker', unitId: 'd2' }])
  })

  it('落点没选齐（store 预演为 null）⇒ 一条都不给', () => {
    expect(combatExtraLossCandidates(retreat())).toEqual([])
  })
})
