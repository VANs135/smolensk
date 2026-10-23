import { describe, expect, it } from 'vitest'

import {
  arrivalsAxis,
  arrivalsSoviet,
  formations,
  mapLayers,
  scenarioSetup,
  scenarios,
} from '@/data'
import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'

/**
 * A8 剧本与到达表数据基线（scenarios.json / scenario-setup.json / arrivals-*.json）
 *
 * 断言以源库（scenarios.json / setup_index.json / arrivals.json）与专规数值为准，
 * 覆盖：剧本旋钮与继承、共识开关与可选规则、胜利条件、初设条目分类、到达日期块与判定表。
 */
describe('B50：3.4b 是 4.1a 的可选项（共识清单）', () => {
  it('开场共识清单里含「装甲集群 SP 归属约束」（文本与引擎常量**同源**）', () => {
    // 引擎按**条目文本**查共识结论；数据里改了字而常量没跟着改 ⇒ 这里红，而不是功能静默失效
    expect(scenarios.agreedOptions.items).toContain(PANZER_GROUP_OPTION_ITEM)
  })

  it('可选项条目在**末位**（既有题号按 index 记日志 ⇒ 不得插队）', () => {
    const items = scenarios.agreedOptions.items
    expect(items[items.length - 1]).toBe(PANZER_GROUP_OPTION_ITEM)
  })
})
describe('剧本库 scenarios.json', () => {
  it('共 7 个剧本（入门剧本 Vitebsk 按裁定推迟，不计入）', () => {
    expect(scenarios.scenarios).toHaveLength(7)
    expect(scenarios.scenarios.map((s) => s.id)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  })

  it('剧本 1：19 回合、德军先行、开局轴 0 / 苏 2 铁路容量（专规 1.2）', () => {
    const s = scenarios.scenarios.find((x) => x.id === '1')!
    expect(s.name).toBe('Smolensk Campaign')
    expect(s.turns).toBe(19)
    expect(s.firstPlayer).toBe('axis')
    expect(s.setupFirst).toBe('soviet')
    expect(s.firstWeather).toBe('normal')
    expect(s.setup.railCap).toEqual({ axis: 0, soviet: 2 })
    expect(s.setup.reserveMarkers).toEqual({ axis: 14, soviet: 0 })
    expect(s.setup.supplyCache).toBe(2)
    expect(s.setup.constructionMarkers).toBe(3)
    expect(s.setup.organicTrucks.mode).toBe('all_loaded')
  })

  it('剧本 3：15 回合、苏军先行、铁路容量 1/3（SmolenskErrata）、卡车自选 4 辆满载', () => {
    const s = scenarios.scenarios.find((x) => x.id === '3')!
    expect(s.turns).toBe(15)
    expect(s.firstPlayer).toBe('soviet')
    expect(s.setup.railCap).toEqual({ axis: 1, soviet: 3 })
    expect(s.setup.reserveMarkers).toEqual({ axis: 14, soviet: 4 })
    expect(s.setup.constructionMarkers).toBe(0)
    expect(s.setup.organicTrucks).toMatchObject({ mode: 'choose_loaded', count: 4 })
    expect(s.daggerRule).toBeTruthy()
  })

  it('剧本 5：Reserve 7/6；剧本 7：卡车全部空载且须掷可变撤离', () => {
    const s5 = scenarios.scenarios.find((x) => x.id === '5')!
    expect(s5.setup.reserveMarkers).toEqual({ axis: 7, soviet: 6 })
    const s7 = scenarios.scenarios.find((x) => x.id === '7')!
    expect(s7.setup.organicTrucks.mode).toBe('all_unloaded')
    expect(s7.variableExitRequired).toBe(true)
  })

  it('共用初设的剧本以 inherits 指向被继承剧本（2→1、4→3、6→5）', () => {
    const byId = new Map(scenarios.scenarios.map((s) => [s.id, s]))
    expect(byId.get('2')!.inherits).toBe('1')
    expect(byId.get('4')!.inherits).toBe('3')
    expect(byId.get('6')!.inherits).toBe('5')
    expect(byId.get('1')!.inherits).toBeUndefined()
  })

  it('共用初设双向留痕：剧本 1 sharedSetupWith [2]、hasSetup true', () => {
    const s1 = scenarios.scenarios.find((x) => x.id === '1')!
    expect(s1.sharedSetupWith).toEqual(['2'])
    expect(s1.hasSetup).toBe(true)
  })

  it('剧本页初设栏原文按方保留（Rail Cap 0 at start / Reserve Markers 14 available）', () => {
    const s1 = scenarios.scenarios.find((x) => x.id === '1')!
    expect(s1.setupInfo?.['axis']?.['Rail Cap']).toBe('0 at start')
    expect(s1.setupInfo?.['axis']?.['Reserve Markers']).toBe('14 available')
    expect(s1.setupInfo?.['soviet']?.['Rail Cap']).toBe('2 at start')
  })

  it('专规 1.2 初设换轨：7 个剧本全部登记 `Converted Axis Rails` 走线原文', () => {
    /*
     * 剧本页原文（`Converted Axis Rails: A to B`）。缺这一项 ⇒ 轴方在整局里**没有任何**标准轨铁路，
     * 而专规 1.2 明言轴方只能使用标准轨铁路 ⇒ 轴方的铁路补给与运货全废。
     */
    const expected: Record<string, string[]> = {
      '1': ['01.03 to 2.02'],
      '2': ['01.03 to 2.02'],
      '3': ['01.03 to 2.02', '01.19 to 4.18', '01.07 to 4.07'],
      '4': ['01.03 to 2.02', '01.19 to 4.18', '01.07 to 4.07'],
      '5': ['01.03 to 2.02', '01.19 to 24.19', '01.07 to 24.06'],
      '6': ['01.03 to 2.02', '01.19 to 24.19', '01.07 to 24.06'],
      '7': ['01.03 to 2.02', '01.19 to 34.18', '01.07 to 38.05', '15.10 to 18.18'],
    }
    for (const [id, runs] of Object.entries(expected)) {
      const scenario = scenarios.scenarios.find((x) => x.id === id)!
      expect(scenario.setup?.convertedAxisRails?.runs).toEqual(runs)
      // 规则依据与读法必须写清（不能只有裸端点）
      expect(scenario.setup?.convertedAxisRails?.rule).toContain('专规 1.2')
    }
  })

  it('专规 1.2 初设换轨：每条走线都是「列.行 to 列.行」，且端点都在铁路图上', () => {
    const railHexes = new Set<string>()
    for (const edge of mapLayers.edges) {
      if (edge.rail !== true) continue
      railHexes.add(`${edge.a.col}.${edge.a.row}`)
      railHexes.add(`${edge.b.col}.${edge.b.row}`)
    }
    let runs = 0
    for (const scenario of scenarios.scenarios) {
      for (const text of scenario.setup?.convertedAxisRails?.runs ?? []) {
        runs += 1
        const parts = text.split(' to ')
        expect(parts, `${scenario.id} ${text}`).toHaveLength(2)
        for (const part of parts) {
          expect(part, `${scenario.id} ${text}`).toMatch(/^\d{1,2}\.\d{1,2}$/)
          const [col, row] = part.split('.').map((n) => Number(n))
          expect(railHexes.has(`${col}.${row}`), `${scenario.id} ${text} 端点 ${part}`).toBe(true)
        }
      }
    }
    expect(runs).toBe(18)
  })

  it('每剧本携带生效补给源（按首回合日期；含入场满载与放置规则）', () => {
    const s1 = scenarios.scenarios.find((x) => x.id === '1')!
    expect(s1.supplySources?.firstTurn).toBe('8 Jul 41')
    expect(s1.supplySources!.sovietLive.length).toBeGreaterThan(0)
    expect(s1.supplySources!.axisLive).toContain('1.03')
    expect(s1.supplySources?.enteringLoaded).toContain('满载')
  })

  it('剧本 6：补给源 20.35 于 19 July 关闭（2.1a），以对象记录', () => {
    const s6 = scenarios.scenarios.find((x) => x.id === '6')!
    const closed = s6.supplySources!.sovietClosed
    const entry = closed.find((c) => typeof c === 'object' && c.hexId === '20.35')
    expect(entry).toBeDefined()
    expect(typeof entry).toBe('object')
  })

  it('共识开关默认值：5 项（1.4 / 4.9e / 2.4 / 4.1–4.3 / 3.4b 可选项）', () => {
    // B50（用户 2026-09-17）：「3.4b 是可选，做到共识里面」⇒ 清单第 5 项＝装甲集群 SP 归属约束
    expect(scenarios.agreedOptions.items).toHaveLength(5)
    expect(scenarios.agreedOptions.note).toContain('一致同意')
    expect(scenarios.agreedOptions.items[4]).toContain('3.4b')
  })

  it('初设规则注记：SP 归属按 Setup Note F 归属装甲集群（3.4）', () => {
    expect(scenarios.setupNotes.spOwnership).toContain('装甲集群')
    expect(scenarios.setupNotes.newSpAssignment).toContain('新到')
  })

  it('可选规则 / 房规 4.1a–4.3 共 7 条', () => {
    expect(Object.keys(scenarios.optionalRules).sort()).toEqual([
      '4.1a',
      '4.1b',
      '4.1c',
      '4.2a',
      '4.2b',
      '4.2c',
      '4.3',
    ])
  })

  it('胜利条件：通用格 11 + 剧本 2/4 专用格 11（5.0a / 5.0b）', () => {
    expect(scenarios.victory.listedHexes).toHaveLength(11)
    expect(scenarios.victory.scenario2HexList).toHaveLength(11)
    expect(scenarios.victory.listedHexes[0]).toContain('36.13')
  })

  it('胜利条件字段为 camelCase（sovietWin / axisWin / rule）', () => {
    expect(scenarios.victory.final?.sovietWin).toContain('Vyazma')
    expect(scenarios.victory.final?.axisWin).toContain('Smolensk')
    expect(scenarios.victory.final?.rule).toBe('5.0a')
  })

  it('加载结果为深度冻结', () => {
    expect(Object.isFrozen(scenarios)).toBe(true)
    expect(Object.isFrozen(scenarios.scenarios)).toBe(true)
    expect(Object.isFrozen(scenarios.scenarios[0])).toBe(true)
  })
})

describe('初设索引 scenario-setup.json', () => {
  it('共 1155 条，剧本归属为 1 / 3 / 5 / 7', () => {
    expect(scenarioSetup.entries).toHaveLength(1155)
    expect([...new Set(scenarioSetup.entries.map((e) => e.scenarioId))].sort()).toEqual([
      '1',
      '3',
      '5',
      '7',
    ])
  })

  it('阵营分布：德国 407 / 苏联 748', () => {
    const axis = scenarioSetup.entries.filter((e) => e.side === 'axis')
    const soviet = scenarioSetup.entries.filter((e) => e.side === 'soviet')
    expect(axis).toHaveLength(407)
    expect(soviet).toHaveLength(748)
  })

  it('条目类别齐备（含数量注记 sp / airbase / transport_point）', () => {
    const count = (kind: string) => scenarioSetup.entries.filter((e) => e.kind === kind).length
    expect(count('unit')).toBe(680)
    expect(count('sp')).toBe(97)
    expect(count('formation')).toBe(96)
    expect(count('aircraft')).toBe(89)
    expect(count('hq')).toBe(78)
    expect(count('transport_point')).toBe(58)
    expect(count('airbase')).toBe(48)
    expect(count('extender')).toBe(9)
  })

  it('减损条目带 stepPenalty（-1 step → 1）', () => {
    const entry = scenarioSetup.entries.find((e) => e.raw === '12-2-2 Inf Div (55; -1 step)')!
    expect(entry.stepPenalty).toBe(1)
    expect(entry.stepPenaltyNote).toContain('减损')
  })

  it('† 条目带放置容差（剧本 3：轴方师可在所列格 ±1 格内）', () => {
    const entry = scenarioSetup.entries.find(
      (e) => e.scenarioId === '3' && e.raw === '20-4-3 Inf Div (167; -1 step) †',
    )!
    expect(entry.placementTolerance).toBe('listed ±1 hex')
    expect(entry.placementToleranceNote).toContain('within 1 hex')
  })

  it('格号位置解析为坐标；原文标签（死亡堆/任意基地）不解析', () => {
    const hexed = scenarioSetup.entries.find(
      (e) => e.locationKind === 'hex' && e.location === '2.02',
    )!
    expect(hexed.locationRefs).toEqual([{ col: 2, row: 2 }])
    const deadPile = scenarioSetup.entries.find((e) => e.locationKind === 'dead_pile')!
    expect(deadPile.locationRefs).toBeUndefined()
  })

  it('编队条目展开下属（kind=formation）', () => {
    const formation = scenarioSetup.entries.find((e) => e.kind === 'formation' && e.subordinates)!
    expect(formation.subordinates!.length).toBeGreaterThan(0)
    expect(formation.subordinates![0]).toHaveProperty('isOrganicTruck')
  })

  it('携带语义注记（放置类别 / 标记说明 / 数量注记）', () => {
    expect(scenarioSetup.notes.placementKinds.length).toBeGreaterThanOrEqual(5)
    expect(scenarioSetup.notes.markerNotes['†']).toContain('within 1 hex')
    expect(scenarioSetup.notes.quantityNote).toContain('数量注记')
  })

  it('加载结果为深度冻结', () => {
    expect(Object.isFrozen(scenarioSetup.entries)).toBe(true)
    expect(Object.isFrozen(scenarioSetup.entries[0])).toBe(true)
  })
})

describe('到达表 arrivals-axis / arrivals-soviet', () => {
  it('轴心 12 个日期块、苏联 14 个日期块', () => {
    expect(arrivalsAxis.side).toBe('axis')
    expect(arrivalsAxis.blocks).toHaveLength(12)
    expect(arrivalsSoviet.side).toBe('soviet')
    expect(arrivalsSoviet.blocks).toHaveLength(14)
  })

  it('日期块含入口 → 单位原文串（不映射 id）', () => {
    const block = arrivalsAxis.blocks.find((b) => b.date === '12 Jul 41')!
    expect(Object.keys(block.entries)).toContain('Entry K')
    expect(block.entries['Entry K']).toContain('3 Truck Points (loaded with SP)')
    expect(block.remove).toContain('Ju.87b')
  })

  it('条目数无截断：入口条目总数 轴 69 / 苏 85；19 Aug 移除块 23 条', () => {
    const entriesTotal = (data: typeof arrivalsAxis): number =>
      data.blocks.reduce(
        (sum, b) => sum + Object.values(b.entries).reduce((n, list) => n + list.length, 0),
        0,
      )
    expect(entriesTotal(arrivalsAxis)).toBe(69)
    expect(entriesTotal(arrivalsSoviet)).toBe(85)
    const aug19 = arrivalsAxis.blocks.find((b) => b.date === '19 Aug 41')!
    expect(aug19.remove).toHaveLength(23)
  })

  it('两套视图标签逐块一致（原文串 keys ↔ 结构化 labels）', () => {
    for (const data of [arrivalsAxis, arrivalsSoviet]) {
      for (const block of data.blocks) {
        const dbKeys = Object.keys(block.entries).sort()
        const labels = (block.groups ?? []).map((g) => g.label).sort()
        expect(labels).toEqual(dbKeys)
      }
    }
  })

  it('轴方携带可变撤离表（3.3c）与随机事件表（3.6）', () => {
    expect(arrivalsAxis.variableExit?.starts).toBe('19 August')
    expect(Object.keys(arrivalsAxis.variableExit!.table).sort()).toEqual(['1', '2-5', '6'])
    expect(arrivalsAxis.randomEvents?.period).toContain('19 July')
    expect(arrivalsAxis.randomEvents!.table['5-9']).toBe('Supply Train')
  })

  it('苏方携带特殊补员表（1.6c），且不误带可变撤离/随机事件', () => {
    expect(arrivalsSoviet.specialRepl?.period).toContain('19 August')
    expect(arrivalsSoviet.specialRepl!.table).toHaveProperty('1-2')
    expect(arrivalsSoviet.variableExit).toBeUndefined()
    expect(arrivalsSoviet.randomEvents).toBeUndefined()
  })

  it('日期块另带结构化单位视图（roster 展开：轴 90 / 苏 117 条）', () => {
    const count = (side: typeof arrivalsAxis): number =>
      side.blocks.reduce(
        (sum, b) => sum + (b.groups ?? []).reduce((n, g) => n + g.units.length, 0),
        0,
      )
    expect(count(arrivalsAxis)).toBe(90)
    expect(count(arrivalsSoviet)).toBe(117)
  })

  it('结构化单位含印值/番号/已损失军力（stepsLost）', () => {
    const units = arrivalsAxis.blocks.flatMap((b) => (b.groups ?? []).flatMap((g) => g.units))
    expect(units.some((u) => u.factors !== undefined)).toBe(true)
    expect(units.some((u) => u.designation !== undefined)).toBe(true)
    expect(units.some((u) => u.stepsLost !== undefined)).toBe(true)
  })

  it('携带勘误与数据质量备注，并按方拆分归属裁定（轴 7 / 苏 2）', () => {
    expect(arrivalsAxis.errataApplied).toHaveLength(6)
    expect(arrivalsAxis.dataQualityNotes).toHaveLength(5)
    expect(arrivalsAxis.resolvedAssignments).toHaveLength(7)
    expect(arrivalsSoviet.resolvedAssignments).toHaveLength(2)
    // 裁定含被取代的旧读法（读栏留痕）
    expect(arrivalsAxis.resolvedAssignments!.some((r) => r.supersededReadings.length > 0)).toBe(
      true,
    )
  })

  it('加载结果为深度冻结', () => {
    expect(Object.isFrozen(arrivalsAxis.blocks)).toBe(true)
    expect(Object.isFrozen(arrivalsSoviet.blocks[0])).toBe(true)
  })
})

describe('编队库 formations.json', () => {
  it('共 17 个多单位编队（13.7）', () => {
    expect(formations.formations).toHaveLength(17)
  })

  it('每条登记双方口径代号与下属组成', () => {
    const f = formations.formations.find((x) => x.formationId === '1 Cav Div')!
    expect(f.side).toBe('axis')
    expect(f.formationCode).toBe('1CAV')
    expect(f.subordinates).toContain('I-1 Cav')
    expect(f.sources).toContain('S1·axis')
  })

  it('算子库代号 ↔ 剧本口径名一一对应（1.Mot ↔ 1 Mtr Div、3PZ ↔ 3 Pz Div）', () => {
    const byCode = new Map(formations.formations.map((f) => [f.formationCode, f.formationId]))
    expect(byCode.get('1.Mot')).toBe('1 Mtr Div')
    expect(byCode.get('3PZ')).toBe('3 Pz Div')
  })

  it('byLocation 记录各剧本初设分布；加载为深度冻结', () => {
    const f = formations.formations.find((x) => x.formationId === '1 Cav Div')!
    expect(Object.keys(f.byLocation)).toContain('14.04')
    expect(Object.isFrozen(formations.formations)).toBe(true)
    expect(Object.isFrozen(formations.formations[0])).toBe(true)
  })
})
