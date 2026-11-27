import { describe, expect, it } from 'vitest'

import type { AiCombatSnapshot } from '@/ai/policy'
import { combatLossCandidates } from '@/ai/training/candidates'

function losses(overrides: Partial<AiCombatSnapshot> = {}): AiCombatSnapshot {
  return {
    state: { step: 'losses', finished: false },
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

describe('9.11a/c 损失分担候选：先改派、再确认', () => {
  it('没有「多受一点」的余地 ⇒ 只给确认（不造空转的改派条目）', () => {
    expect(
      combatLossCandidates(
        losses({
          lossPlan: {
            canonical: [
              { unitId: 'a1', steps: 1 },
              { unitId: 'a2', steps: 1 },
            ],
            swapChoices: [],
            takerId: null,
            ignored: 0,
          },
        }),
      ),
    ).toEqual([{ kind: 'combatLosses' }])
  })

  it('有人受 2 点、另有只受 1 点者 ⇒ 列出可改派的单位 + 确认', () => {
    expect(
      combatLossCandidates(
        losses({
          lossPlan: {
            canonical: [
              { unitId: 'a1', steps: 2 },
              { unitId: 'a2', steps: 1 },
            ],
            swapChoices: [{ unitId: 'a2', label: 'A2（AR3）' }],
            takerId: null,
            ignored: 0,
          },
        }),
      ),
    ).toEqual([{ kind: 'combatLossTaker', unitId: 'a2' }, { kind: 'combatLosses' }])
  })

  it('已改派 ⇒ 多给一条「回到规范分配」，且不重复列当前承受者', () => {
    expect(
      combatLossCandidates(
        losses({
          lossPlan: {
            canonical: [
              { unitId: 'a1', steps: 2 },
              { unitId: 'a2', steps: 1 },
            ],
            swapChoices: [
              { unitId: 'a2', label: 'A2（AR3）' },
              { unitId: 'a3', label: 'A3（AR2）' },
            ],
            takerId: 'a2',
            ignored: 0,
          },
        }),
      ),
    ).toEqual([
      { kind: 'combatLossTaker', unitId: null },
      { kind: 'combatLossTaker', unitId: 'a3' },
      { kind: 'combatLosses' },
    ])
  })

  it('快照没带 lossPlan（老夹具）⇒ 仍给确认，不报错', () => {
    expect(combatLossCandidates(losses())).toEqual([{ kind: 'combatLosses' }])
  })
})
