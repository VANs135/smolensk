import { describe, expect, it } from 'vitest'

import type { AiCombatSnapshot } from '@/ai/policy'
import { combatDeclareArCandidates } from '@/ai/training/candidates'

function declareAr(overrides: Partial<AiCombatSnapshot> = {}): AiCombatSnapshot {
  return {
    state: { step: 'declareAr', finished: false },
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

describe('9.6 宣布行动值候选：先换人、再宣布', () => {
  it('攻方只有一枚可选 ⇒ 不给空转的换人候选，只给宣布', () => {
    expect(
      combatDeclareArCandidates(
        declareAr({
          arOptions: {
            attacker: [{ unitId: 'a1', label: 'A1（AR5）', selected: true }],
            defender: [{ unitId: 'd1', label: 'D1（AR2）', selected: true }],
          },
        }),
      ),
    ).toEqual([{ kind: 'combatDeclareAr', side: 'attacker' }])
  })

  it('攻方两枚、已预选一枚 ⇒ 列出另一枚 + 宣布（不重复列已选中的）', () => {
    expect(
      combatDeclareArCandidates(
        declareAr({
          arOptions: {
            attacker: [
              { unitId: 'a1', label: 'A1（AR5）', selected: true },
              { unitId: 'a2', label: 'A2（AR3）', selected: false },
            ],
            defender: [{ unitId: 'd1', label: 'D1（AR2）', selected: true }],
          },
        }),
      ),
    ).toEqual([
      { kind: 'combatArUnit', side: 'attacker', unitId: 'a2' },
      { kind: 'combatDeclareAr', side: 'attacker' },
    ])
  })

  it('攻方已宣布 ⇒ 轮到守方，候选池换成守方清单（已按专规 2.3b 收窄）', () => {
    expect(
      combatDeclareArCandidates(
        declareAr({
          state: { step: 'declareAr', finished: false, declaredAttackerArUnitId: 'a1' },
          arOptions: {
            attacker: [{ unitId: 'a1', label: 'A1（AR5）', selected: true }],
            defender: [
              { unitId: 'd1', label: 'D1（AR2）', selected: true },
              { unitId: 'd2', label: 'D2（AR4）', selected: false },
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: 'combatArUnit', side: 'defender', unitId: 'd2' },
      { kind: 'combatDeclareAr', side: 'defender' },
    ])
  })

  it('不在 declareAr 步 / 已结束 ⇒ 一条都不给', () => {
    expect(
      combatDeclareArCandidates(declareAr({ state: { step: 'losses', finished: false } })),
    ).toEqual([])
    expect(combatDeclareArCandidates(declareAr({ state: null }))).toEqual([])
  })
})
