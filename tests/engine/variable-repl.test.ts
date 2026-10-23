import { describe, expect, it } from 'vitest'

import { replTableRoll, supplyTableRoll } from '@/engine/tables/supply-repl'
import {
  planRandomEvent,
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
      specialDie: 1,
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
    // 19 Aug 起不再掷特殊补员
    expect(late.data.special).toBeNull()
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

describe('1.6c：特殊补员（19 Aug 前每回合，免费重建）', () => {
  it('1.6c：苏方 1–2 ⇒ 随机师 + 补给缓存；3–6 ⇒ 随机师 + 任一 Alarm 单位', () => {
    const caches = planVariableReinforcement({
      side: 'soviet',
      date: '1941-07-12',
      supplyDice: 7,
      replDice: 7,
      specialDie: 2,
    })
    expect(caches.ok).toBe(true)
    if (!caches.ok) return
    expect(caches.data.special).toMatchObject({
      freeDivisionRebuild: true,
      supplyCache: true,
      freeAlarmOrRecon: false,
    })

    const alarm = planVariableReinforcement({
      side: 'soviet',
      date: '1941-07-12',
      supplyDice: 7,
      replDice: 7,
      specialDie: 5,
    })
    if (!alarm.ok) return
    expect(alarm.data.special).toMatchObject({
      freeDivisionRebuild: true,
      supplyCache: false,
      freeAlarmOrRecon: true,
    })
  })

  it('1.6c：轴方 1–4 ⇒ 补给缓存；5–6 ⇒ 任一 Aufk / Krd 营（3.3a）', () => {
    const cache = planVariableReinforcement({
      side: 'axis',
      date: '1941-07-19',
      supplyDice: 7,
      replDice: 7,
      specialDie: 3,
    })
    if (!cache.ok) return
    expect(cache.data.special).toMatchObject({ supplyCache: true, freeAlarmOrRecon: false })

    const recon = planVariableReinforcement({
      side: 'axis',
      date: '1941-07-19',
      supplyDice: 7,
      replDice: 7,
      specialDie: 6,
    })
    if (!recon.ok) return
    expect(recon.data.special).toMatchObject({ freeAlarmOrRecon: true })
  })

  it('1.6c：19 Aug 前未给特殊补员骰即拒（该掷骰是必做项）', () => {
    const missing = planVariableReinforcement({
      side: 'soviet',
      date: '1941-07-12',
      supplyDice: 7,
      replDice: 7,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('specialReplDieRequired:1941-07-12')
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
      specialDie: 1,
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
      specialDie: 1,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('randomEventDieRequired:1941-07-19')
  })

  it('4.1b（可选）：8 Jul 与 12 Jul 自动发生 Supply Train', () => {
    expect(planRandomEvent({ date: '1941-07-08', option4_1b: true })).toMatchObject({
      kind: 'supplyTrain',
      sp: 2,
    })
    expect(planRandomEvent({ date: '1941-07-12', option4_1b: true })).toMatchObject({
      kind: 'supplyTrain',
    })
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
