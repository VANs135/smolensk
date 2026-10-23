import { describe, expect, it } from 'vitest'

import {
  FUEL_FORMATION_SP,
  FUEL_HQ_SP,
  FUEL_SINGLE_UNIT_T,
  actionNeedsFuel,
  computeFuelCost,
  fuelCanUseInternalStocks,
  fuelExpiresAt,
  fuelExpiresOnPhaseChange,
  hqFuelCoverage,
  reinforcementFuelNeeded,
  requiresFuelToSpendMp,
} from '@/engine/rules'

/**
 * 燃料补给（OCS 12.5 / 12.5a–g）测试
 *
 * 断言全部照中文规则书条款；数值取自 rules-constants.json（编队 1 SP / HQ 1 SP / 单单位 1 T）。
 */

describe('12.5a：需要燃料的单位', () => {
  it('轮式/履带 MP 的**战斗单位**需要；步行、卡车等非战斗单位不需要', () => {
    expect(requiresFuelToSpendMp({ isCombat: true, mobility: 'truck' })).toBe(true)
    expect(requiresFuelToSpendMp({ isCombat: true, mobility: 'track' })).toBe(true)
    expect(requiresFuelToSpendMp({ isCombat: true, mobility: 'leg' })).toBe(false)
    expect(requiresFuelToSpendMp({ isCombat: false, mobility: 'truck' })).toBe(false)
  })
})

describe('12.5b：需要燃料的行动', () => {
  it('只有移动与突袭需要；攻击/防御/轰炸/撤退/战后推进不需要', () => {
    expect(actionNeedsFuel('move')).toBe(true)
    expect(actionNeedsFuel('overrun')).toBe(true)
    for (const action of [
      'attack',
      'defend',
      'barrage',
      'retreat',
      'advanceAfterCombat',
    ] as const) {
      expect(actionNeedsFuel(action)).toBe(false)
    }
  })
})

describe('12.5c：三种加油方法', () => {
  it('A) 编队法：1 SP，且持续到下一个友方清理阶段并翻编队标记', () => {
    const cost = computeFuelCost({ method: 'formation', commonSource: true })
    expect(cost).toEqual({
      ok: true,
      sp: FUEL_FORMATION_SP,
      t: 0,
      duration: 'untilNextFriendlyCleanUp',
      marker: 'formationMarker',
      rule: '12.5c-A',
    })
  })

  it('A) 编队法：未共用同一 HQ/补给站时不可用（规则要求改走单单位法）', () => {
    expect(computeFuelCost({ method: 'formation', commonSource: false })).toMatchObject({
      ok: false,
      rule: '12.5c-A',
    })
  })

  it('B) HQ 法：1 SP（已含 HQ 自身与其投递距离内的独立单位），置 HQ 燃料标记', () => {
    expect(computeFuelCost({ method: 'hq' })).toEqual({
      ok: true,
      sp: FUEL_HQ_SP,
      t: 0,
      duration: 'untilNextFriendlyCleanUp',
      marker: 'hqFuelMarker',
      rule: '12.5c-B',
    })
  })

  it('C) 单单位法：每单位 1 T，只在本阶段有效且无需标记', () => {
    expect(computeFuelCost({ method: 'singleUnit', unitsNeedingFuel: 5 })).toEqual({
      ok: true,
      sp: 0,
      t: FUEL_SINGLE_UNIT_T * 5,
      duration: 'currentPhaseOnly',
      marker: 'none',
      rule: '12.5c-C',
    })
    expect(computeFuelCost({ method: 'singleUnit', unitsNeedingFuel: 0 })).toMatchObject({
      ok: false,
      rule: '12.5c-C',
    })
  })
})

describe('12.5d：燃料到期时点', () => {
  it('编队法/HQ 法持续到下一个友方清理阶段；单单位法只本阶段', () => {
    expect(fuelExpiresAt('formation')).toBe('untilNextFriendlyCleanUp')
    expect(fuelExpiresAt('hq')).toBe('untilNextFriendlyCleanUp')
    expect(fuelExpiresAt('singleUnit')).toBe('currentPhaseOnly')
  })

  it('12.5c-C：只有单单位法在**换阶段**时失效（编队法/HQ 法要留到本方清理阶段）', () => {
    expect(fuelExpiresOnPhaseChange('singleUnit')).toBe(true)
    expect(fuelExpiresOnPhaseChange('formation')).toBe(false)
    expect(fuelExpiresOnPhaseChange('hq')).toBe(false)
  })
})

describe('12.5e：HQ 法的覆盖约定', () => {
  it('投递距离须在移动前一次性确定，且每阶段只允许一个投递位置', () => {
    const coverage = hqFuelCoverage([10, 7])
    expect(coverage.rule).toBe('12.5e')
    expect(coverage.countBeforeMovement).toBe(true)
    expect(coverage.singleThrowLocationPerPhase).toBe(true)
    expect(coverage.throwRangeHexes).toEqual([10, 7])
  })
})

describe('12.5f / 12.5g', () => {
  it('12.5f：增援部署不需要燃料，但移动离开入场格就需要（抵达回合无免费燃料）', () => {
    expect(reinforcementFuelNeeded({ stillInEntryHex: true })).toEqual({
      needsFuel: false,
      rule: '12.5f',
    })
    expect(reinforcementFuelNeeded({ stillInEntryHex: false })).toEqual({
      needsFuel: true,
      rule: '12.5f',
    })
  })

  it('12.5g：部队储备不能用于燃料补给', () => {
    expect(fuelCanUseInternalStocks()).toBe(false)
  })
})
