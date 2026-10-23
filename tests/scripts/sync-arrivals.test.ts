import { describe, expect, it } from 'vitest'

import {
  toBlock,
  toRandomEvents,
  toResolvedAssignment,
  toRosterGroup,
  toRosterUnit,
  toSpecialRepl,
  toVariableExit,
} from '../../scripts/sync-arrivals.mjs'

/** toBlock 输出的断言视图 */
interface BlockOut {
  date: string
  entries: Record<string, string[]>
  notes?: string[]
  anyAirbase?: string[]
  remove?: string[]
  deadPile?: string[]
  anyWestEdge?: string[]
}

/** 判定表输出的断言视图 */
interface VariableExitOut {
  starts: string
  rollIn?: string
  table: Record<string, string>
}
interface RandomEventsOut {
  period: string
  table: Record<string, string>
  airResult?: string
  supplyTrain?: string
  option4_1b?: string
}
interface SpecialReplOut {
  period: string
  table: Record<string, string>
}

/**
 * sync-arrivals.mjs 转换核心单测（A8）
 *
 * 覆盖：日期块 snake→camelCase、空数组省略、判定表拆分（特殊补员 period 与骰面键混排）。
 */
describe('sync-arrivals 转换核心', () => {
  it('日期块：entries 原样保留，空数组字段省略', () => {
    const out = toBlock({
      date: '8 Jul 41',
      notes: ['Axis Rail Cap is 0 at start.'],
      entries: {},
      any_airbase: [],
      remove: [],
      dead_pile: [],
      any_west_edge: [],
    }) as unknown as BlockOut

    expect(out.date).toBe('8 Jul 41')
    expect(out.notes).toEqual(['Axis Rail Cap is 0 at start.'])
    expect(out.entries).toEqual({})
    expect(out.anyAirbase).toBeUndefined()
    expect(out.deadPile).toBeUndefined()
  })

  it('日期块：非空字段按 camelCase 搬运', () => {
    const out = toBlock({
      date: '12 Jul 41',
      entries: { 'Entry K': ['5th Corps HQ'] },
      remove: ['Ju.87b'],
      any_airbase: ['1x Bf.109e-7'],
      dead_pile: ['He.111'],
      any_west_edge: ['X'],
    }) as unknown as BlockOut

    expect(out.entries['Entry K']).toEqual(['5th Corps HQ'])
    expect(out.remove).toEqual(['Ju.87b'])
    expect(out.anyAirbase).toEqual(['1x Bf.109e-7'])
    expect(out.deadPile).toEqual(['He.111'])
    expect(out.anyWestEdge).toEqual(['X'])
  })

  it('可变撤离表：starts + rollIn + table', () => {
    const out = toVariableExit({
      starts: '19 August',
      roll_in: 'Axis Reinforcement Phase',
      table: { '1': 'remove SS Reich (all)' },
    }) as unknown as VariableExitOut
    expect(out.starts).toBe('19 August')
    expect(out.rollIn).toBe('Axis Reinforcement Phase')
    expect(out.table).toEqual({ '1': 'remove SS Reich (all)' })
  })

  it('随机事件表：period + table + 三个可选注记', () => {
    const out = toRandomEvents({
      period: '19 July - 15 August',
      table: { '5-9': 'Supply Train' },
      air_result: 'become Inactive',
      supply_train: '2 SP extra',
      option_4_1b: 'both 8 and 12 July',
    }) as unknown as RandomEventsOut
    expect(out.period).toBe('19 July - 15 August')
    expect(out.table['5-9']).toBe('Supply Train')
    expect(out.airResult).toBe('become Inactive')
    expect(out.supplyTrain).toBe('2 SP extra')
    expect(out.option4_1b).toBe('both 8 and 12 July')
  })

  it('特殊补员表：period 与骰面键混排 → 拆出 table', () => {
    const out = toSpecialRepl({
      period: 'before 19 August, each turn, roll one die',
      '1-2': 'Division & Supply Cache',
      '3-6': 'Division & Alarm unit',
    }) as unknown as SpecialReplOut
    expect(out.period).toContain('before 19 August')
    expect(out.table).toEqual({
      '1-2': 'Division & Supply Cache',
      '3-6': 'Division & Alarm unit',
    })
    expect(Object.keys(out.table)).not.toContain('period')
  })

  it('结构化到达单位：snake → camelCase，nullish 省略', () => {
    const out = toRosterUnit({
      raw: '20-4-3 Inf Div (17, 31; two are -1 step)',
      factors: '20-4-3',
      count: 1,
      kind: 'unit',
      name: '17 Inf Div',
      designation: '17',
      parent_type: 'Inf Div',
      steps_lost: 1,
      location_kind: 'entry',
      location: 'Entry I or J',
    })
    expect(out).toEqual({
      raw: '20-4-3 Inf Div (17, 31; two are -1 step)',
      factors: '20-4-3',
      count: 1,
      kind: 'unit',
      name: '17 Inf Div',
      designation: '17',
      parentType: 'Inf Div',
      stepsLost: 1,
      locationKind: 'entry',
      location: 'Entry I or J',
    })
  })

  it('结构化单位：无 steps_lost 时不产生该字段', () => {
    const out = toRosterUnit({ raw: '5th Corps HQ', kind: 'hq' })
    expect(out).toEqual({ raw: '5th Corps HQ', kind: 'hq' })
    expect(out).not.toHaveProperty('stepsLost')
  })

  it('结构化分组：label + units', () => {
    const out = toRosterGroup({ label: 'Entry K', entries: [{ raw: '5th Corps HQ' }] })
    expect(out.label).toBe('Entry K')
    const units = out.units as Record<string, unknown>[]
    expect(units).toHaveLength(1)
    expect(units[0]!.raw).toBe('5th Corps HQ')
  })

  it('归属裁定：superseded_readings → supersededReadings', () => {
    const out = toResolvedAssignment({
      items: ['7th Corps HQ'],
      resolved: '15 Jul 41 / Entry I or J',
      superseded_readings: ['8 Jul 41 / Entry I or J（PDF 文本层）'],
      basis: '逐栏核对',
    })
    expect(out.resolved).toBe('15 Jul 41 / Entry I or J')
    expect(out.supersededReadings).toEqual(['8 Jul 41 / Entry I or J（PDF 文本层）'])
    expect(out.basis).toBe('逐栏核对')
  })
})
