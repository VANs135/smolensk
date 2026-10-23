import { describe, expect, it } from 'vitest'

import {
  checkSecurityNeeds,
  removalAllowedNow,
  removalReasonOf,
  type SecurityCheckCityView,
} from '@/engine/rules'

/**
 * 治安需求（Smolensk 专规 3.3b，轴方）
 *
 * 条文（ch03 引录）：「轴心国控制的城市格（按 5.0c 定义）应由一个 **Attack-Capable** 单位占据
 *   或被 **ZOC** 覆盖；否则在该格放一个苏军 **Trainbusting** 标记（代表游击队活动）。
 *   标记可在**任意相位**放置；在**任意 Clean Up Phase**，若安全需求满足或该城转为苏军控制则移除。」
 */

/** 城市格视图的构造夹具（只给判据需要的字段，避免顺手塞入无关事实） */
function city(
  overrides: Partial<SecurityCheckCityView> & { col: number; row: number },
): SecurityCheckCityView {
  return {
    hex: { col: overrides.col, row: overrides.row },
    controlledByAxis: true,
    occupiedByAttackCapable: false,
    coveredByAxisZoc: false,
    hasTrainbusting: false,
    ...overrides,
  }
}

describe('3.3b：治安需求的放置判定', () => {
  it('3.3b：轴控城市既无「可攻击单位占据」也无「轴方 ZOC」且无标记 ⇒ 需放一枚', () => {
    const outcome = checkSecurityNeeds([city({ col: 36, row: 13 })])
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.rule).toBe('3.3b')
      expect(outcome.data.placeAt).toEqual([{ col: 36, row: 13 }])
      expect(outcome.data.removeAt).toEqual([])
    }
  })

  it('3.3b：由可攻击单位占据 ⇒ 需求满足（不再放标记）', () => {
    const outcome = checkSecurityNeeds([city({ col: 36, row: 13, occupiedByAttackCapable: true })])
    if (outcome.ok) expect(outcome.data.placeAt).toEqual([])
  })

  it('3.3b：被轴方 ZOC 覆盖 ⇒ 需求满足（不再放标记）', () => {
    const outcome = checkSecurityNeeds([city({ col: 36, row: 13, coveredByAxisZoc: true })])
    if (outcome.ok) expect(outcome.data.placeAt).toEqual([])
  })

  it('3.3b：需求未满足但该格已有标记 ⇒ 不重复放置', () => {
    const outcome = checkSecurityNeeds([city({ col: 36, row: 13, hasTrainbusting: true })])
    if (outcome.ok) {
      expect(outcome.data.placeAt).toEqual([])
      expect(outcome.data.removeAt).toEqual([])
    }
  })

  it('3.3b：非轴控城市不属于「占城税」范围（未轴控且无标记 ⇒ 什么都不做）', () => {
    const outcome = checkSecurityNeeds([city({ col: 36, row: 13, controlledByAxis: false })])
    if (outcome.ok) {
      expect(outcome.data.placeAt).toEqual([])
      expect(outcome.data.removeAt).toEqual([])
    }
  })
})

describe('3.3b：标记的移除判定（任意 Clean Up Phase）', () => {
  it('3.3b：需求已满足（驻兵 / ZOC）且有标记 ⇒ 需移除', () => {
    const outcome = checkSecurityNeeds([
      city({ col: 36, row: 13, hasTrainbusting: true, occupiedByAttackCapable: true }),
      city({ col: 18, row: 18, hasTrainbusting: true, coveredByAxisZoc: true }),
    ])
    if (outcome.ok) {
      expect(outcome.data.removeAt).toEqual([
        { col: 36, row: 13 },
        { col: 18, row: 18 },
      ])
    }
  })

  it('3.3b：该城转为苏军控制 ⇒ 需移除其标记', () => {
    const outcome = checkSecurityNeeds([
      city({ col: 36, row: 13, controlledByAxis: false, hasTrainbusting: true }),
    ])
    if (outcome.ok) expect(outcome.data.removeAt).toEqual([{ col: 36, row: 13 }])
  })

  it('3.3b：移除只在 H 清理段进行（其它阶段不移除）', () => {
    expect(removalAllowedNow('cleanUp')).toBe(true)
    for (const phase of [
      'aircraftRefit',
      'reinforcement',
      'movement',
      'supply',
      'reaction',
      'combat',
      'exploitation',
    ]) {
      expect(removalAllowedNow(phase)).toBe(false)
    }
  })

  it('3.3b：移除理由可读化（需求满足 / 转苏控；不该移除时为 null）', () => {
    expect(
      removalReasonOf(city({ col: 1, row: 1, hasTrainbusting: true, coveredByAxisZoc: true })),
    ).toBe('securityNeedsMet')
    expect(removalReasonOf(city({ col: 1, row: 1, controlledByAxis: false }))).toBe(
      'citySovietControlled',
    )
    expect(removalReasonOf(city({ col: 1, row: 1 }))).toBeNull()
  })
})
