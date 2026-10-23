import { describe, expect, it } from 'vitest'

import {
  HAND_WRITTEN_SETUP_KEYS,
  mergeHandWrittenSetup,
  parseCount,
  parseOrganicTrucks,
  toClosedSource,
  toFirstWeather,
  toScenario,
  toSupplySources,
  toVictory,
} from '../../scripts/sync-scenarios.mjs'

/** toScenario 输出的断言视图（仅为测试收敛类型） */
interface ScenarioOut {
  id: string
  firstWeather: string
  inherits?: string
  setup: {
    railCap: { axis: number; soviet: number }
    reserveMarkers: { axis: number; soviet: number }
    supplyCache: number
    constructionMarkers: number
    organicTrucks: { mode: string; count?: number; raw: string }
    weatherFirstTurnRaw: string
    formationDrawRaw?: string
    options?: Record<string, unknown>
    source?: string[]
  }
  variableExitRequired?: boolean
  daggerRule?: string
}

/**
 * sync-scenarios.mjs 转换核心单测（A8）
 *
 * 覆盖：天气原文映射、数量文本解析、卡车满载方式三分支、初设选项结构化与继承。
 * 注意：只触达纯函数（脚本含主流程守卫，被 import 时不执行 IO）。
 */
describe('sync-scenarios 转换核心', () => {
  it('首回合天气原文 → 契约枚举', () => {
    expect(toFirstWeather('Normal Flight')).toBe('normal')
    expect(toFirstWeather('Limited Flight')).toBe('restricted')
    expect(() => toFirstWeather('Unknown')).toThrow()
  })

  it('数量文本解析：「每方各 2 枚」→ 2', () => {
    expect(parseCount('每方各 2 枚')).toBe(2)
    expect(() => parseCount('无数字')).toThrow()
  })

  it('卡车满载方式三分支', () => {
    expect(parseOrganicTrucks('德军全部满载')).toEqual({ mode: 'all_loaded', raw: '德军全部满载' })
    expect(parseOrganicTrucks('德军全部空载')).toEqual({
      mode: 'all_unloaded',
      raw: '德军全部空载',
    })
    expect(parseOrganicTrucks('德军自选 4 辆满载，其余空载')).toEqual({
      mode: 'choose_loaded',
      count: 4,
      raw: '德军自选 4 辆满载，其余空载',
    })
    expect(() => parseOrganicTrucks('无法识别')).toThrow()
  })

  it('初设选项结构化：同剧本继承 → inherits，编队抽取单独成字段，其余原文进 options', () => {
    const out = toScenario({
      id: 2,
      name: 'Short Campaign',
      first_turn: '8 Jul 41',
      last_turn: '1 Aug 41',
      turns: 8,
      first_player: 'axis',
      setup_first: 'soviet',
      weather_start: 'Normal Flight',
      setup_choices: { same_as: 1, formation_draw: '抽 4 个', note: '初设同剧本 1' },
      setup_numbers: {
        rail_cap: { axis: 0, soviet: 2 },
        reserve_markers: { axis: 14, soviet: 0 },
        supply_cache: '每方各 2 枚',
        construction_markers: 3,
        organic_trucks: '德军全部满载',
        weather_first_turn: 'Normal Flight on 8 July',
        source: '剧本页',
      },
    }) as unknown as ScenarioOut

    expect(out.id).toBe('2')
    expect(out.firstWeather).toBe('normal')
    expect(out.inherits).toBe('1')
    expect(out.setup.supplyCache).toBe(2)
    expect(out.setup.railCap).toEqual({ axis: 0, soviet: 2 })
    expect(out.setup.organicTrucks.mode).toBe('all_loaded')
    expect(out.setup.formationDrawRaw).toBe('抽 4 个')
    expect(out.setup.options).toEqual({ note: '初设同剧本 1' })
    expect(out.setup.source).toEqual(['剧本页'])
  })

  it('须掷可变撤离的两个来源都能识别（setup_numbers.variable_exit / 选项注记）', () => {
    const base = {
      id: 7,
      name: 'X',
      first_turn: '26 Aug 41',
      last_turn: '8 Sep 41',
      turns: 5,
      first_player: 'soviet',
      setup_first: 'axis',
      weather_start: 'Normal Flight',
      setup_choices: { note: '须掷可变撤离' },
      setup_numbers: {
        rail_cap: { axis: 1, soviet: 3 },
        reserve_markers: { axis: 7, soviet: 6 },
        supply_cache: '每方各 2 枚',
        construction_markers: 0,
        organic_trucks: '德军全部空载',
        weather_first_turn: 'Normal Flight on 26 Aug',
      },
    }
    expect((toScenario(base) as unknown as ScenarioOut).variableExitRequired).toBe(true)
  })

  it('补给源 snake → camelCase', () => {
    const out = toSupplySources({
      rule: '2.1',
      first_turn: '8 Jul 41',
      soviet_live: ['13.01'],
      soviet_closed: [],
      axis_live: ['1.03'],
      axis_closed: [],
      entering_loaded: '满载入场',
      entrain_off_map: '可登车',
    })
    expect(out.firstTurn).toBe('8 Jul 41')
    expect(out.sovietLive).toEqual(['13.01'])
    expect(out.axisLive).toEqual(['1.03'])
    expect(out.enteringLoaded).toBe('满载入场')
    expect(out.entrainOffMap).toBe('可登车')
  })

  it('关闭补给源条目：格号串原样，对象转 camelCase', () => {
    expect(toClosedSource('20.35')).toBe('20.35')
    expect(
      toClosedSource({ hex_id: '20.35', hex_id_user: '20.35', date: '19 July', rule: '2.1a' }),
    ).toEqual({ hexId: '20.35', hexIdUser: '20.35', date: '19 July', rule: '2.1a' })
  })

  it('胜利条件：final 内层键归一到 camelCase', () => {
    const out = toVictory({
      final: { soviet_win: 'S', axis_win: 'A', else: 'draw', rule: '5.0a' },
      decisive: { from: 'x', soviet: 'S', axis: 'A', rule: '5.0b' },
      scenarios_2_and_4: { soviet: 'S', axis: 'A', rule: 'scenario 2/4' },
      control: 'hex contains an attack-capable unit',
      listed_hexes: ['36.13 Pochinok'],
      scenario_2_hex_list: ['27.05 Krichev'],
    })
    expect(out.final).toEqual({ sovietWin: 'S', axisWin: 'A', else: 'draw', rule: '5.0a' })
    expect(out.scenarios2And4).toEqual({ soviet: 'S', axis: 'A', rule: 'scenario 2/4' })
    expect(out.listedHexes).toEqual(['36.13 Pochinok'])
    expect(out.scenario2HexList).toEqual(['27.05 Krichev'])
  })
})

/** 手写块合并的断言视图 */
interface MergedOut {
  scenarios: { id: string; setup: Record<string, unknown> }[]
}

/**
 * 手写块保留单测（门禁加固 B0①）
 *
 * `formationDraw` / `airSetup` / `printedHedgehogOwners` 三块**脚本无法从权威库再生**，
 * 引擎在消费它们（`rules/containers.ts`、`rules/setup.ts`、`stores/workbench.ts`）。
 * 脚本若盲写覆盖，这三块会静默消失——而 schema 里是 optional，校验不报错。
 */
describe('sync-scenarios 手写块保留', () => {
  const existing = {
    scenarios: [
      {
        id: '1',
        setup: {
          railCap: { axis: 1, soviet: 2 },
          formationDrawRaw: '抽 4 个',
          formationDraw: { draws: ['a'] },
          airSetup: { axis: 'active' },
          printedHedgehogOwners: { axisOwned: ['23.15'] },
          options: { note: '旧' },
        },
      },
    ],
  }

  it('三块手写内容在重跑后原样保留', () => {
    const merged = mergeHandWrittenSetup(
      {
        scenarios: [
          { id: '1', setup: { railCap: { axis: 1, soviet: 2 }, formationDrawRaw: '抽 4 个' } },
        ],
      },
      existing,
    ) as unknown as MergedOut

    expect(merged.scenarios[0]!.setup.formationDraw).toEqual({ draws: ['a'] })
    expect(merged.scenarios[0]!.setup.airSetup).toEqual({ axis: 'active' })
    expect(merged.scenarios[0]!.setup.printedHedgehogOwners).toEqual({ axisOwned: ['23.15'] })
    // options 属"其余原文保留"，同样随既有产物保留
    expect(merged.scenarios[0]!.setup.options).toEqual({ note: '旧' })
  })

  it('键序按既有产物（重跑后文本逐字节相同，护栏才判 unchanged）', () => {
    const merged = mergeHandWrittenSetup(
      { scenarios: [{ id: '1', setup: { railCap: { axis: 1, soviet: 2 } } }] },
      existing,
    ) as unknown as MergedOut
    expect(Object.keys(merged.scenarios[0]!.setup)).toEqual([
      'railCap',
      'formationDrawRaw',
      'formationDraw',
      'airSetup',
      'printedHedgehogOwners',
      'options',
    ])
  })

  it('脚本产出的值优先于既有值（railCap 等随权威库更新）', () => {
    const merged = mergeHandWrittenSetup(
      { scenarios: [{ id: '1', setup: { railCap: { axis: 9, soviet: 9 } } }] },
      existing,
    ) as unknown as MergedOut
    expect(merged.scenarios[0]!.setup.railCap).toEqual({ axis: 9, soviet: 9 })
  })

  it('首次生成（无既有产物）时原样返回', () => {
    const next = { scenarios: [{ id: '1', setup: { railCap: {} } }] }
    expect(mergeHandWrittenSetup(next, null)).toBe(next)
  })

  it('既有产物里没有的剧本不受影响', () => {
    const merged = mergeHandWrittenSetup(
      { scenarios: [{ id: '2', setup: { railCap: {} } }] },
      existing,
    ) as unknown as MergedOut
    expect(merged.scenarios[0]!.setup).toEqual({ railCap: {} })
  })

  it('保留清单是可审计的显式常量', () => {
    expect([...HAND_WRITTEN_SETUP_KEYS]).toEqual([
      'formationDraw',
      'airSetup',
      'printedHedgehogOwners',
      'convertedAxisRails',
    ])
  })
})
