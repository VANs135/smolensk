import { describe, expect, it } from 'vitest'

import { arrivalsAxis, arrivalsSoviet } from '@/data'
import {
  isFreeSpecialReplEligible,
  replTableRoll,
  specialReplRoll,
  supplyTableRoll,
} from '@/engine/tables/supply-repl'
import {
  ACTIONS_BY_PHASE,
  checkTiming,
  getRailCap,
  planArrivals,
  rollVariableExit,
  stackingObligations,
} from '@/engine/rules'
import { isRailCapBoosted, isSpecialReplAvailable } from '@/engine/rules/timing'

/**
 * 环节 Ⓑ：**增援**（B 段）——专规 1.2 / 1.6b / 1.6c / 2.1 / 3.1 / 3.3c / 13.6
 *
 * B 段按 2.2 流程表**没有地形动作**（许可动作集为空）：其内容全是到货与掷表——
 * 补员表与补给表（1.6b）、特殊补员（1.6c，19 Aug 前）、可变撤离（3.3c，19 Aug 起）、
 * 铁路容量按日提升（1.2）；且 13.6 明令**增援阶段不查超堆叠**。
 * 单独运行：`npx vitest run tests/flows/20-phase-b-reinforcement.test.ts`
 */

describe('Ⓑ 2.2 / 13.6：B 段的闸门与例外', () => {
  it('2.2：B 段只做「到达投放 / 重建 / 合并」，不含地形动作', () => {
    // 13.6 / 2.1 / 3.1 到达投放、13.5a 重建、13.9 合并
    expect([...ACTIONS_BY_PHASE.reinforcement]).toEqual(['arrival', 'rebuild', 'consolidate'])
    for (const action of ['move', 'barrage', 'attack', 'refit', 'engineer'] as const) {
      const violations = checkTiming({
        action,
        side: 'axis',
        activeSide: 'axis',
        phase: 'reinforcement',
        date: '1941-07-12',
      })
      expect(violations.map((item) => item.reason)).toContain('actionNotInSegment')
    }
  })

  it('13.6：增援阶段**不查超堆叠**（其余阶段/环节结束时才查 4.8a）', () => {
    // 同一格 20 RE 战斗单位：增援阶段无义务
    expect(stackingObligations({ col: 36, row: 13 }, 20, 'reinforcement')).toEqual([])
    // 到了移动阶段就产生摧毁义务（4.8a：上限 10 RE）
    const obligations = stackingObligations({ col: 36, row: 13 }, 20, 'movement')
    expect(obligations.map((item) => item.rule)).toContain('4.8a')
    expect(obligations[0]?.reason).toBe('overstackAtSegmentEnd')
  })
})

describe('Ⓑ 1.6b：补员表与补给表（2d6；19 Aug 起 −1）', () => {
  it('1.6b 补给表：同一骰面在 19 Aug 前后取不同档（轴 2–3 ⇒ 3 SP → 1 SP）', () => {
    expect(supplyTableRoll('axis', false, 2)).toBe(3)
    expect(supplyTableRoll('axis', true, 2)).toBe(1)
    // 苏方档位不同（2–3 ⇒ 5 SP → 3 SP）
    expect(supplyTableRoll('soviet', false, 2)).toBe(5)
    expect(supplyTableRoll('soviet', true, 2)).toBe(3)
  })

  it('1.6b 补给表：档位随骰面单调不减（11–12 为最高档）', () => {
    const before = [2, 4, 6, 9, 11].map((roll) => supplyTableRoll('axis', false, roll))
    expect(before).toEqual([3, 5, 7, 9, 11])
    for (let index = 1; index < before.length; index += 1)
      expect(before[index]!).toBeGreaterThan(before[index - 1]!)
  })

  it('1.6b 补员表：19 Aug 起掷骰 −1（同骰面落到更低一行）', () => {
    // 轴方：有效值 7 或以下 ⇒ 全 0；8 ⇒ 1 Pax；9 ⇒ 1 Ftr + 1 Pax
    expect(replTableRoll('axis', 7)).toMatchObject({ ftr: 0, tac: 0, pax: 0, eq: 0 })
    expect(replTableRoll('axis', 8)).toMatchObject({ pax: 1 })
    expect(replTableRoll('axis', 9)).toMatchObject({ ftr: 1, pax: 1 })
    // 19 Aug 起原始骰 9 的有效值 8 ⇒ 只剩 1 Pax（-1 DRM 由调用方施加）
    expect(replTableRoll('axis', 9 - 1)).toMatchObject({ ftr: 0, pax: 1 })
    // 苏方档位不同：有效 9 ⇒ 1 Ftr + 2 Pax
    expect(replTableRoll('soviet', 9)).toMatchObject({ ftr: 1, pax: 2 })
  })
})

describe('Ⓑ 1.6c：特殊补员与免费重建（19 Aug 前每回合）', () => {
  it('1.6c：特殊补员表掷 1 骰出事件；19 Aug 起停止', () => {
    expect(specialReplRoll('soviet', 1)).toMatchObject({ kind: 'division_caches' })
    expect(specialReplRoll('soviet', 2)).toMatchObject({ kind: 'division_caches' })
    expect(specialReplRoll('soviet', 3)).toMatchObject({ kind: 'division_alarm' })
    expect(specialReplRoll('axis', 1)).toMatchObject({ kind: 'supply_cache' })
    expect(specialReplRoll('axis', 6)).toMatchObject({ kind: 'aufk_krd' })

    expect(isSpecialReplAvailable('1941-08-18')).toBe(true)
    expect(isSpecialReplAvailable('1941-08-19')).toBe(false)
  })

  it('1.6c：免费重建资格只给 12-2-2 / 11-1-1 / 10-0-1 三型', () => {
    expect(isFreeSpecialReplEligible(12, 2, 2)).toBe(true)
    expect(isFreeSpecialReplEligible(11, 1, 1)).toBe(true)
    expect(isFreeSpecialReplEligible(10, 0, 1)).toBe(true)
    // 13-3-3 等其余型「never rebuilt this way」
    expect(isFreeSpecialReplEligible(13, 3, 3)).toBe(false)
    expect(isFreeSpecialReplEligible(12, 2, 3)).toBe(false)
  })
})

describe('Ⓑ 3.3c：轴方可变撤离（19 Aug 起每回合掷 1 骰）', () => {
  it('3.3c：19 Aug 之前不执行（skipped）', () => {
    const early = rollVariableExit(1, '1941-08-18')
    expect(early).toMatchObject({ kind: 'skipped', active: false })
  })

  it('3.3c：1 ⇒ 整队移除 SS Reich；2–5 ⇒ 下回合再掷；6 ⇒ 整队移除 14 Mtr', () => {
    expect(rollVariableExit(1, '1941-08-19')).toMatchObject({
      kind: 'remove',
      removedUnit: 'SS Reich',
      active: true,
    })
    expect(rollVariableExit(3, '1941-08-19')).toMatchObject({ kind: 'reroll', active: true })
    expect(rollVariableExit(5, '1941-08-19')).toMatchObject({ kind: 'reroll', active: true })
    expect(rollVariableExit(6, '1941-08-19')).toMatchObject({
      kind: 'remove',
      removedUnit: '14 Mtr',
      active: true,
    })
  })

  it('3.3c：骰面越界即抛错（不给静默默认值）', () => {
    expect(() => rollVariableExit(0, '1941-08-19')).toThrow(RangeError)
    expect(() => rollVariableExit(7, '1941-08-19')).toThrow(RangeError)
  })
})

describe('Ⓑ 1.2：铁路容量按日提升（轴 0→1、苏 2→3）', () => {
  it('1.2：19 Jul 起容量提升；此前取旧值', () => {
    expect(getRailCap('1941-07-18', 'axis')).toBe(0)
    expect(getRailCap('1941-07-18', 'soviet')).toBe(2)
    expect(getRailCap('1941-07-19', 'axis')).toBe(1)
    expect(getRailCap('1941-07-19', 'soviet')).toBe(3)
    expect(isRailCapBoosted('1941-07-18')).toBe(false)
    expect(isRailCapBoosted('1941-07-19')).toBe(true)
  })
})

describe('Ⓑ 2.1 / 3.1：到货卡数据（arrivals-*.json）', () => {
  it('2.1/3.1：双方到货卡都覆盖到 1 Sep，且 19 Aug 之后仍有到货（与 1.2 提升日无冲突）', () => {
    const axisDates = arrivalsAxis.blocks.map((block) => block.date)
    const sovietDates = arrivalsSoviet.blocks.map((block) => block.date)
    expect(axisDates[0]).toBe('8 Jul 41')
    expect(axisDates.at(-1)).toBe('1 Sep 41')
    expect(axisDates).toContain('19 Aug 41')
    expect(sovietDates).toContain('19 Aug 41')
    expect(sovietDates.at(-1)).toBe('1 Sep 41')
    // 到货卡按日期排序且日期不重复
    expect(new Set(axisDates).size).toBe(axisDates.length)
    expect(new Set(sovietDates).size).toBe(sovietDates.length)
  })

  it('3.3c / 3.6 / 1.6c：到货卡携带各自的掷表（轴方可变撤离 + 特殊补员）', () => {
    // 轴方携带可变撤离表（3.3c）
    expect(arrivalsAxis.variableExit?.table?.['1']).toContain('SS Reich')
    // 苏方携带特殊补员表（1.6c）
    expect(Object.keys(arrivalsSoviet.specialRepl?.table ?? {})).not.toHaveLength(0)
  })

  it('13.6 / 1.6a：B 段的到达表执行把当日卡面解析成投放需求与强制移除', () => {
    const outcome = planArrivals({ side: 'axis', date: '1941-07-12' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.units.length).toBeGreaterThan(0)
    expect(outcome.data.removals.map((item) => item.raw)).toContain('Ju.87b')
    // 19 Aug 的苏方大移除（1.6a：立即移出，不论处境）
    const bigRemoval = planArrivals({ side: 'soviet', date: '1941-08-19' })
    if (!bigRemoval.ok) return
    expect(bigRemoval.data.removals.length).toBeGreaterThan(10)
    expect(bigRemoval.data.shutdowns).toEqual(['Entry L', 'Entry E 及以西所有南缘源'])
  })

  it('13.5 / 13.9：重建与合并的时机都在 B 增援段（其它段一律被拒）', () => {
    // ACTIONS_BY_PHASE 是唯一时机权威（见 00-sop-backbone 的段闸用例）
    expect([...ACTIONS_BY_PHASE.reinforcement]).toEqual(['arrival', 'rebuild', 'consolidate'])
    expect([...ACTIONS_BY_PHASE.movement]).not.toContain('rebuild')
    expect([...ACTIONS_BY_PHASE.exploitation]).not.toContain('consolidate')
  })
})
