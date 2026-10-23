import { describe, expect, it } from 'vitest'

import {
  checkDefenderArChoice,
  defenderMayIgnoreOptionsUnderNkvd,
  forcedDefenderArCandidates,
  forcedDefenderOptionChoice,
  isNkvdBorderRegiment,
  nkvdArRequired,
  nkvdDefenderOptionOverride,
  NKVD_BORDER_CAPABILITY,
  type NkvdDefenseUnitView,
} from '@/engine/rules'

/**
 * NKVD 边防团（Smolensk 专规 2.3b）
 *
 * 「被攻击时**必须**担任行动值单位；代价是**所有防御选项都须当作损失吃下**
 *   （包括本可因攻方撤退而抵消的选项）。」
 */

/** 工程数据库 special_abilities 的原文标签（units.json：38 / 86 / 105 NKVD Bdr Rgt） */
const NKVD: NkvdDefenseUnitView = {
  id: 'nkvd-38',
  specialAbilities: [NKVD_BORDER_CAPABILITY],
}
const RIFLE: NkvdDefenseUnitView = { id: 'rifle-17', specialAbilities: ['no_hip_shoots'] }
const PLAIN: NkvdDefenseUnitView = { id: 'plain-1' }

describe('2.3b：判据（数据层能力标签，不按番号/国别推定）', () => {
  it('2.3b：能力标签 `nkvd_border_forced_roll` 即为 NKVD 边防团', () => {
    expect(NKVD_BORDER_CAPABILITY).toBe('nkvd_border_forced_roll')
    expect(isNkvdBorderRegiment(NKVD)).toBe(true)
    expect(isNkvdBorderRegiment(RIFLE)).toBe(false)
    expect(isNkvdBorderRegiment(PLAIN)).toBe(false)
  })

  it('2.3b：普通 NKVD（如 NKVD Mot Inf Rgt）不带该标签 ⇒ 不受 2.3b 约束', () => {
    // 工程库中 `su-motorized-ru-1-nkvd-mot-inf-rgt` 的 capabilities_raw = ["nkvd"]，
    // 但 special_abilities 为空 ⇒ 不是「边防团」，不触发强制担任行动值
    expect(isNkvdBorderRegiment({ id: 'nkvd-mot', specialized: ['nkvd'] })).toBe(false)
  })

  it('2.3b：堆叠内有多个边防团时，全部候选（其中之一担任即可）', () => {
    const defenders = [RIFLE, NKVD, { id: 'nkvd-86', specialAbilities: [NKVD_BORDER_CAPABILITY] }]
    expect(nkvdArRequired(defenders)).toBe(true)
    expect(forcedDefenderArCandidates(defenders).map((unit) => unit.id)).toEqual([
      'nkvd-38',
      'nkvd-86',
    ])
    expect(nkvdArRequired([RIFLE, PLAIN])).toBe(false)
  })
})

describe('2.3b：守方行动值单位的选择（9.6 的守方一步）', () => {
  it('2.3b：选了边防团 ⇒ 通过且标记 forced', () => {
    const outcome = checkDefenderArChoice([RIFLE, NKVD], 'nkvd-38')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.data.forced).toBe(true)
  })

  it('2.3b：堆叠内有边防团却选了别的单位 ⇒ 拒（原因码含候选）', () => {
    const outcome = checkDefenderArChoice([RIFLE, NKVD], 'rifle-17')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.rule).toBe('2.3b')
      expect(outcome.reason).toBe('nkvdMustBeArUnit:rifle-17∉[nkvd-38]')
    }
  })

  it('2.3b：堆叠内没有边防团 ⇒ 不施加约束（forced=false）', () => {
    const outcome = checkDefenderArChoice([RIFLE, PLAIN], 'rifle-17')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.data.forced).toBe(false)
  })
})

describe('2.3b：守方选项全部吃成损失', () => {
  it('2.3b：全部选项点当作军力损失、撤退格数恒为 0', () => {
    expect(forcedDefenderOptionChoice(3)).toMatchObject({
      retreatHexes: 0,
      lossPoints: 3,
      rule: '2.3b',
    })
    expect(forcedDefenderOptionChoice(0)).toMatchObject({ lossPoints: 0 })
    expect(forcedDefenderOptionChoice(-1)).toMatchObject({ lossPoints: 0 })
  })

  it('2.3b：NKVD 担任行动值单位时 9.10c 的「忽略选项」权利**不适用**', () => {
    expect(defenderMayIgnoreOptionsUnderNkvd()).toBe(false)
  })

  it('2.3b：一步裁定 —— 只有「边防团且它正是宣布的行动值单位」才强制覆盖', () => {
    const forced = nkvdDefenderOptionOverride({
      defenderArUnitId: 'nkvd-38',
      defenders: [RIFLE, NKVD],
      optionPoints: 2,
    })
    expect(forced).toMatchObject({ lossPoints: 2, retreatHexes: 0 })

    // 未选边防团（非法，但覆盖函数不做合法性判定 ⇒ 返回 null，由 9.6 的校验负责拦下）
    expect(
      nkvdDefenderOptionOverride({
        defenderArUnitId: 'rifle-17',
        defenders: [RIFLE, NKVD],
        optionPoints: 2,
      }),
    ).toBeNull()
    // 堆叠内没有边防团
    expect(
      nkvdDefenderOptionOverride({
        defenderArUnitId: 'rifle-17',
        defenders: [RIFLE],
        optionPoints: 2,
      }),
    ).toBeNull()
  })
})
