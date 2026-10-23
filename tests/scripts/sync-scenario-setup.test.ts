import { describe, expect, it } from 'vitest'

import {
  parseHexRefSafe,
  parseHexRefs,
  toSetupEntry,
  toSetupNotes,
  toSubordinate,
} from '../../scripts/sync-scenario-setup.mjs'

/** toSetupEntry 输出的断言视图 */
interface EntryOut {
  scenarioId: string
  side: string
  kind: string
  count: number
  locationKind?: string
  locationRefs?: { col: number; row: number }[]
  stepPenalty?: number
  setupMode?: string
  coLocated?: string[]
  subordinates?: Record<string, unknown>[]
}

/**
 * sync-scenario-setup.mjs 转换核心单测（A8）
 *
 * 覆盖：格号解析与原文标签放行、nullish 字段省略、减损/移动模式/共存标签搬运、编队下属映射。
 */
describe('sync-scenario-setup 转换核心', () => {
  it('格号解析：正则命中才解析，原文标签返回 null', () => {
    expect(parseHexRefSafe('2.02')).toEqual({ col: 2, row: 2 })
    expect(parseHexRefSafe('1.19')).toEqual({ col: 1, row: 19 })
    expect(parseHexRefSafe('死亡堆')).toBeNull()
    expect(parseHexRefSafe('w/i 3 hexes of 34.17')).toBeNull()
  })

  it('格号清单解析：混合输入只保留可解析项', () => {
    expect(parseHexRefs(['34.17', '34.18'])).toEqual([
      { col: 34, row: 17 },
      { col: 34, row: 18 },
    ])
    expect(parseHexRefs(['死亡堆'])).toEqual([])
    expect(parseHexRefs(undefined)).toEqual([])
  })

  it('条目映射：核心字段 camelCase、nullish 省略、格号解析', () => {
    const out = toSetupEntry({
      scenario_id: '1',
      side: 'axis',
      group_label: 'hex 2.02',
      location_kind: 'hex',
      location: '2.02',
      kind: 'sp',
      name: null,
      count: 5,
      raw: '5 SP',
      factors: null,
      designation: null,
      parent_type: null,
      placement_type: '固定格号',
      placement_note: null,
      nation: '德国',
      location_hexes: ['2.02'],
      co_located: ['airbase', 'formation', 'sp', 'transport_point'],
    }) as unknown as EntryOut

    expect(out.scenarioId).toBe('1')
    expect(out.kind).toBe('sp')
    expect(out.count).toBe(5)
    expect(out.locationRefs).toEqual([{ col: 2, row: 2 }])
    expect(out.coLocated).toEqual(['airbase', 'formation', 'sp', 'transport_point'])
    // nullish 字段不进产物
    expect(out).not.toHaveProperty('name')
    expect(out).not.toHaveProperty('factors')
    expect(out).not.toHaveProperty('stepPenalty')
  })

  it('条目映射：减损与移动模式初设原样搬运', () => {
    const out = toSetupEntry({
      scenario_id: '1',
      side: 'soviet',
      group_label: 'hex 30.29',
      location_kind: 'hex',
      location: '30.29',
      kind: 'unit',
      name: '12-2-2 Inf Div 55',
      count: 1,
      raw: '12-2-2 Inf Div (55; -1 step)',
      placement_type: '固定格号',
      nation: '苏联',
      location_hexes: ['30.29'],
      step_penalty: 1,
      step_penalty_note: '剧本注记：该单位以减损状态设置（-1 step）',
      setup_mode: 'move',
    }) as unknown as EntryOut

    expect(out.stepPenalty).toBe(1)
    expect(out.setupMode).toBe('move')
  })

  it('编队下属映射：is_organic_truck → isOrganicTruck', () => {
    const out = toSubordinate({
      component: '1 Aufk',
      name: '3 Pz Div 1 Aufk',
      establishment: null,
      raw: '1 Aufk',
      is_organic_truck: true,
      location_kind: 'dead_pile',
      location: '死亡堆',
    })
    expect(out.component).toBe('1 Aufk')
    expect(out.isOrganicTruck).toBe(true)
    expect(out.locationKind).toBe('dead_pile')
    expect(out.establishment).toBeUndefined()
  })

  it('语义注记：placement_note / marker_notes / nation_note 归一', () => {
    const out = toSetupNotes({
      key: 'scenario_id + location + name + 序号',
      placement_note: { kinds: ['固定格号', '死亡堆'], multiplicity: 'count 为单位数' },
      marker_notes: { '†': 'can setup within 1 hex of the listed location' },
      nation_note: '德国 405 / 苏联 748',
      quantity_note: '数量注记以独立条目记录',
    })
    expect(out.entryKey).toBe('scenario_id + location + name + 序号')
    expect(out.placementKinds).toEqual(['固定格号', '死亡堆'])
    expect(out.multiplicity).toBe('count 为单位数')
    expect((out.markerNotes as Record<string, string>)['†']).toContain('within 1 hex')
    expect(out.nationNote).toBe('德国 405 / 苏联 748')
    expect(out.quantityNote).toBe('数量注记以独立条目记录')
  })
})
