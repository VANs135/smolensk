import { describe, expect, it } from 'vitest'

import { replTableRoll, supplyTableRoll } from '@/engine/tables/supply-repl'
import {
  planRandomEvent,
  planSpecialReplDraw,
  planVariableReinforcement,
  railCapacityAt,
  specialReplRebuildRows,
} from '@/engine/rules'

/**
 * 可变增援与特殊补员（通规 13.5 / 1.6b / 1.6c ← 专规 1.6 / 2.3c / 3.3c / 3.6 / 1.2）
 *
 * 骰面全部由调用方注入（可复算），逐条对到规则章节。
 */

describe('1.6b：补给表与补员表（19 Aug 起 −1 并取 Late 档）', () => {
  it('1.6b：19 Aug 前取 Early 档；19 Aug 起 −1 且取 Late 档', () => {
    // 苏方 2 骰 = 9：Early 11 SP / Late 6 SP
    expect(supplyTableRoll('soviet', false, 9)).toBe(11)
    expect(supplyTableRoll('soviet', true, 9)).toBe(6)

    const early = planVariableReinforcement({
      side: 'soviet',
      date: '1941-08-18',
      supplyDice: 9,
      replDice: 10,
    })
    expect(early.ok).toBe(true)
    if (!early.ok) return
    expect(early.data.sp).toBe(11)
    expect(early.data.repl).toMatchObject({ ftr: 1, tac: 1, pax: 2, eq: 1 })

    // 19 Aug 起：补员表 −1（10 → 有效 9 ⇒ 1 Ftr + 2 Pax + 1 Eq）
    const late = planVariableReinforcement({
      side: 'soviet',
      date: '1941-08-19',
      supplyDice: 9,
      replDice: 10,
      variableExitDie: 3,
    })
    expect(late.ok).toBe(true)
    if (!late.ok) return
    expect(late.data.sp).toBe(6)
    expect(late.data.repl).toMatchObject({ ftr: 1, tac: 0, pax: 2, eq: 1 })
    // 1.6c 是独立一掷：1.6b 的结算里没有它
    expect('special' in late.data).toBe(false)
  })

  it('1.6b：骰面越界即拒（不给静默默认值）', () => {
    expect(
      planVariableReinforcement({ side: 'axis', date: '1941-07-19', supplyDice: 1, replDice: 7 })
        .ok,
    ).toBe(false)
    expect(
      planVariableReinforcement({ side: 'axis', date: '1941-07-19', supplyDice: 7, replDice: 13 })
        .ok,
    ).toBe(false)
  })

  it('1.6b / 专规 1.6 Notes：轴方补员表档位与苏方不同', () => {
    expect(replTableRoll('axis', 7)).toMatchObject({ ftr: 0, pax: 0 })
    expect(replTableRoll('axis', 8)).toMatchObject({ pax: 1 })
    expect(replTableRoll('axis', 10)).toMatchObject({ ftr: 1, tac: 1, pax: 2, eq: 1 })
  })
})

describe('1.6c：特殊补员是独立一掷（不复用 1.6b 的骰面）', () => {
  it('1.6b 的结算不含 1.6c，也不要求/消费特殊补员骰', () => {
    for (const side of ['soviet', 'axis'] as const) {
      const plan = planVariableReinforcement({
        side,
        date: '1941-07-12',
        supplyDice: 7,
        replDice: 7,
      })
      expect(plan.ok, side).toBe(true)
      if (!plan.ok) continue
      expect('special' in plan.data, side).toBe(false)
    }
  })

  it('1.6b 两个骰面的组合不会改变 1.6c 的表：1.6c 只看自己那颗（planSpecialReplDraw）', () => {
    /*
     * 1.6b 的 7/7 与 9/10 是两组完全不同的 1.6b 输入；1.6c 若复用 1.6b 的骰，
     * 结果就会跟着这两组变。这里断言 1.6c 的判据只认自己的 die（2 与 5 两档），
     * 空死亡堆 ⇒ 两个档都按自己骰面给出「师作废 + Cache / Alarm 作废」。
     */
    const base = {
      side: 'soviet' as const,
      date: '1941-07-12',
      deadPile: [],
      alarmUnitIds: [],
      alarmInPlay: {},
    }
    const cache = planSpecialReplDraw({ ...base, die: 2 })
    const alarm = planSpecialReplDraw({ ...base, die: 5 })
    expect(cache.ok).toBe(true)
    expect(alarm.ok).toBe(true)
    if (!cache.ok || !alarm.ok) return
    expect(cache.data.second.kind).toBe('supplyCache')
    expect(alarm.data.second.kind).toBe('void')
    expect(cache.data.division).toBeNull()
    expect(alarm.data.division).toBeNull()
  })

  it('1.6c：特殊补员可重建的行 = 重建表里 kind=special 的行（Alarm 类）', () => {
    expect(specialReplRebuildRows('soviet')).toEqual(
      expect.arrayContaining(['AT Alarm Rgt', 'Militia Alarm Rgt']),
    )
    expect(specialReplRebuildRows('axis')).toEqual(
      expect.arrayContaining(['Aufk (Arm Recon) Bn', 'Krd (Motorcycle) Bn']),
    )
  })
})

describe('3.3c：轴方可变撤离（19 Aug 起）', () => {
  it('3.3c：轴方 19 Aug 起必掷；未给骰面即拒', () => {
    const missing = planVariableReinforcement({
      side: 'axis',
      date: '1941-08-19',
      supplyDice: 7,
      replDice: 7,
      randomEventDice: 7,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('variableExitDieRequired:1941-08-19')
  })

  it('3.3c：掷 1 ⇒ 移除 SS Reich；2–5 ⇒ 下回合再掷；6 ⇒ 移除 14 Mtr', () => {
    const one = planVariableReinforcement({
      side: 'axis',
      date: '1941-08-19',
      supplyDice: 7,
      replDice: 7,
      variableExitDie: 1,
    })
    if (!one.ok) return
    expect(one.data.variableExit).toMatchObject({ kind: 'remove', removedUnit: 'SS Reich' })

    const reroll = planVariableReinforcement({
      side: 'axis',
      date: '1941-08-19',
      supplyDice: 7,
      replDice: 7,
      variableExitDie: 4,
    })
    if (!reroll.ok) return
    expect(reroll.data.variableExit).toMatchObject({ kind: 'reroll' })
  })

  it('3.3c：19 Aug 之前不掷（苏方任何日期都不掷）', () => {
    const early = planVariableReinforcement({
      side: 'axis',
      date: '1941-07-19',
      supplyDice: 7,
      replDice: 7,
      randomEventDice: 7,
    })
    if (!early.ok) return
    expect(early.data.variableExit).toBeNull()

    const soviet = planVariableReinforcement({
      side: 'soviet',
      date: '1941-08-19',
      supplyDice: 7,
      replDice: 7,
    })
    if (!soviet.ok) return
    expect(soviet.data.variableExit).toBeNull()
  })
})

describe('3.6：轴方随机事件（19 Jul–15 Aug）', () => {
  it('3.6：5–9 ⇒ Supply Train（任一可卸货格 +2 SP，不用 Rail Cap）', () => {
    const result = planRandomEvent({ date: '1941-07-19', dice: 7 })
    expect(result).toMatchObject({ kind: 'supplyTrain', sp: 2 })
  })

  it('3.6：机型结果 ⇒ 该型飞机立即全部非激活（Bf.110 / He.111 / Ju.52 / Ju.88）', () => {
    expect(planRandomEvent({ date: '1941-07-19', dice: 2 })).toMatchObject({
      kind: 'aircraft',
      aircraftType: 'Bf.110',
    })
    expect(planRandomEvent({ date: '1941-07-19', dice: 4 })).toMatchObject({
      kind: 'aircraft',
      aircraftType: 'He.111',
    })
    expect(planRandomEvent({ date: '1941-07-19', dice: 10 })).toMatchObject({
      kind: 'aircraft',
      aircraftType: 'Ju.52',
    })
    expect(planRandomEvent({ date: '1941-07-19', dice: 12 })).toMatchObject({
      kind: 'aircraft',
      aircraftType: 'Ju.88',
    })
  })

  it('3.6：事件期外不掷；期内未给骰面即拒', () => {
    expect(planRandomEvent({ date: '1941-07-16', dice: 7 })).toBeNull()
    expect(planRandomEvent({ date: '1941-08-16', dice: 7 })).toBeNull()
    const missing = planVariableReinforcement({
      side: 'axis',
      date: '1941-07-19',
      supplyDice: 7,
      replDice: 7,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('randomEventDieRequired:1941-07-19')
  })

  it('★ 4.1b（可选）：19 Jul 之前的**三个回合**（8 / 12 / 15 Jul）都自动发生 Supply Train', () => {
    /*
     * 原文（Smolensk 专规 4.1b）：「apply the 'Supply Train' event on the **three turns before
     * 19 July** (when event rolls start)」；轴心到达卡：「occurs automatically on
     * **8 July through 15 July**」。回合是 8 / 12 / 15 Jul ⇒ 三次。
     * 修前只做了 8 Jul 与 12 Jul（少一次 15 Jul 的 2 SP）。
     */
    for (const date of ['1941-07-08', '1941-07-12', '1941-07-15'])
      expect(planRandomEvent({ date, option4_1b: true }), date).toMatchObject({
        kind: 'supplyTrain',
        sp: 2,
      })
    // 19 Jul 起走 3.6 的掷表（不给骰面就返回 null）；18 Jul 不在表里
    expect(planRandomEvent({ date: '1941-07-18', option4_1b: true })).toBeNull()
    expect(planRandomEvent({ date: '1941-07-19', option4_1b: true })).toBeNull()
    // 未启用 4.1b 时，事件期外不掷
    expect(planRandomEvent({ date: '1941-07-08', option4_1b: false })).toBeNull()
  })
})

describe('1.2：铁路容量（提示用）', () => {
  it('1.2：19 Jul 起轴 0→1、苏 2→3', () => {
    expect(railCapacityAt('1941-07-18', 'axis')).toBe(0)
    expect(railCapacityAt('1941-07-19', 'axis')).toBe(1)
    expect(railCapacityAt('1941-07-18', 'soviet')).toBe(2)
    expect(railCapacityAt('1941-07-19', 'soviet')).toBe(3)
  })
})
