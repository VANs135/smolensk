import { describe, expect, it } from 'vitest'

import { actingSideFor, phaseTransition } from '@/engine/game-lifecycle'
import type { GamePhase, Records } from '@/engine/state-types'

/**
 * A1：阶段生命周期（2.2 / 6.3a / 7.0a）
 *
 * ## 条文依据
 *   - 2.2：「后手玩家重复上述步骤，角色互换」⇒ 换方必须被识别为**一次阶段变化**，
 *     否则 store 的阶段级账本（MP / 轰炸 / 攻击 / 整备…）会跨方继承；
 *   - 2.2 Turn End：回合推进后 `activeSide` / `firstPlayer` 一并清空；
 *   - 6.3a / 7.0a：E 反应段由**非行动方**行动 ⇒ `actingSideFor` 返回对手方。
 *
 * ## 测法边界
 *   只测纯函数判定；store 的实际清零点由 `tests/stores/identity-reset-flow.test.ts` 钉住。
 */

function createRecords(overrides: Partial<Records> = {}): Records {
  return {
    turn: 1,
    phase: 'aircraftRefit',
    preTurnSegment: null,
    activeSide: 'axis',
    firstPlayer: 'axis',
    weather: { air: 'normal', ground: 'good' },
    railCapacity: { axis: 0, soviet: 2 },
    markerTracks: {},
    victoryLocations: [],
    ...overrides,
  }
}

describe('A1：phaseTransition 判定', () => {
  it('★ 只有行动方变化（先手 cleanUp → 后手 aircraftRefit）也算 changed', () => {
    const previous = createRecords({
      phase: 'cleanUp',
      activeSide: 'axis',
      firstPlayer: 'axis',
    })
    const current = createRecords({
      phase: 'aircraftRefit',
      activeSide: 'soviet',
      firstPlayer: 'axis',
    })
    const plan = phaseTransition(previous, current)
    expect(plan.changed).toBe(true)
    expect(plan.turnChanged).toBe(false)
  })

  it('同回合同方同阶段 ⇒ changed=false，不触发任何重置', () => {
    const plan = phaseTransition(createRecords(), createRecords())
    expect(plan.changed).toBe(false)
    expect(plan.turnChanged).toBe(false)
    expect(plan.refreshTrace).toBe(false)
  })

  it('回合变化 ⇒ changed 与 turnChanged 均为真', () => {
    const plan = phaseTransition(createRecords(), createRecords({ turn: 2, activeSide: null }))
    expect(plan.changed).toBe(true)
    expect(plan.turnChanged).toBe(true)
  })

  it('追溯补给只在进入移动 / 补给时刷新（12.6 / 12.8e）', () => {
    for (const phase of [
      'aircraftRefit',
      'reinforcement',
      'reaction',
      'combat',
      'exploitation',
    ] as const) {
      expect(phaseTransition(createRecords(), createRecords({ phase })).refreshTrace, phase).toBe(
        false,
      )
    }
    for (const phase of ['movement', 'supply'] as const) {
      expect(phaseTransition(createRecords(), createRecords({ phase })).refreshTrace, phase).toBe(
        true,
      )
    }
  })

  it('B 段自动环节键按「回合|方|段」区分（双方各掷各的）', () => {
    const axis = phaseTransition(
      createRecords({ phase: 'aircraftRefit', activeSide: 'soviet', firstPlayer: 'axis' }),
      createRecords({ phase: 'reinforcement', activeSide: 'axis', firstPlayer: 'axis' }),
    )
    expect(axis.reinforcementKey).toBe('1|axis|reinforcement')
    const soviet = phaseTransition(
      createRecords({ phase: 'cleanUp', activeSide: 'axis', firstPlayer: 'axis' }),
      createRecords({ phase: 'reinforcement', activeSide: 'soviet', firstPlayer: 'axis' }),
    )
    expect(soviet.reinforcementKey).toBe('1|soviet|reinforcement')
  })
})

describe('A1：actingSideFor（6.3a / 7.0a）', () => {
  const cases: readonly {
    phase: GamePhase
    active: 'axis' | 'soviet'
    expected: 'axis' | 'soviet' | null
  }[] = [
    { phase: 'reaction', active: 'axis', expected: 'soviet' },
    { phase: 'reaction', active: 'soviet', expected: 'axis' },
    { phase: 'movement', active: 'axis', expected: 'axis' },
    { phase: 'combat', active: 'soviet', expected: 'soviet' },
    { phase: 'aircraftRefit', active: 'axis', expected: 'axis' },
  ]

  it('E 反应段永远是**非行动方**；其余段是行动方', () => {
    expect(actingSideFor({ phase: 'reaction', activeSide: null })).toBe(null)
    for (const item of cases) {
      expect(actingSideFor({ phase: item.phase, activeSide: item.active }), item.phase).toBe(
        item.expected,
      )
    }
  })
})
