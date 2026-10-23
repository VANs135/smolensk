import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import {
  VictoryDataError,
  axisVictoryCities,
  checkTurnEndVictory,
  checkTurnStartVictory,
  controlOfHex,
  evaluateDecisiveVictory,
  evaluateFinalVictory,
  isScenarioFinalTurn,
  listedVictoryHexes,
  parseVictoryHexText,
  scenarioLastTurn,
  scenarioTurnRange,
  sovietVictoryCities,
  summarizeVictoryControl,
  victoryThresholdsFor,
  type VictoryControlLookup,
} from '@/engine/rules'

/**
 * 胜利判定（Smolensk 专规 5.0 / 5.0a / 5.0b / 5.0c）
 *
 * 条文要点（表 4-1 / 表 4-2b）：
 *   - 5.0a 最终：苏 = Vyazma、Rzhev + 所列格 ≥7；轴 = 五城**全部格** + 所列格 ≥6；否则 Draw；
 *   - 5.0b 提前决胜（19 Aug 起任一回合**开始**）：苏 ≥9、轴五城 + ≥8；
 *   - 剧本 2/4 明文例外：苏 ≥6 / 轴 ≥7，且清单以 Krichev 27.05、Demidov 32.25
 *     取代 Pusii 48.25、Spas Demyansk 52.09；
 *   - 5.0c 控制：格内有 **Attack-Capable** 单位 ⇒ 该方控制；空格 ⇒ **最后**在场的方控制。
 */

/** 由「格 → 控制方」映射造一个控制查询（未列出的格视为无人控制） */
function control(map: Record<string, Side>): VictoryControlLookup {
  return (hex: HexRef) => map[`${hex.col}.${hex.row}`] ?? null
}

const key = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 清单里是否含该格（按坐标比对，避开「行号补零」的书写差异） */
function hasHex(hexes: readonly HexRef[], col: number, row: number): boolean {
  return hexes.some((hex) => hex.col === col && hex.row === row)
}

/** 把一组格指派给某一方 */
function assign(hexes: readonly HexRef[], side: Side): Record<string, Side> {
  return Object.fromEntries(hexes.map((hex) => [key(hex), side]))
}

/** 全部五城格（轴方） */
const AXIS_CITY_HEXES: readonly HexRef[] = axisVictoryCities().flatMap((city) => [...city.hexes])
/** 全部两城格（苏方） */
const SOVIET_CITY_HEXES: readonly HexRef[] = sovietVictoryCities().flatMap((city) => [
  ...city.hexes,
])

/** 通用清单 11 格 */
const LISTED = listedVictoryHexes('1')

describe('5.0c：控制判定', () => {
  it('5.0c：格内有可攻击单位 ⇒ 该方控制（优先于「最后在场方」）', () => {
    const hex = { col: 36, row: 13 }
    expect(controlOfHex({ hex, attackCapableSide: 'soviet', lastControllingSide: 'axis' })).toBe(
      'soviet',
    )
  })

  it('5.0c：空格 ⇒ 由**最后一个**曾在该格的单位所属方控制', () => {
    const hex = { col: 36, row: 13 }
    expect(controlOfHex({ hex, attackCapableSide: null, lastControllingSide: 'axis' })).toBe('axis')
  })

  it('5.0c：从未被任何一方占据的格 ⇒ 无人控制（null，不计入任何一方）', () => {
    expect(
      controlOfHex({
        hex: { col: 36, row: 13 },
        attackCapableSide: null,
        lastControllingSide: null,
      }),
    ).toBeNull()
  })
})

describe('5.0c / 表 4-2：所列格清单（两套，按剧本号选用）', () => {
  it('5.0c：通用清单为 11 处，含 Pusii 48.25 与 Spas Demyansk 52.09', () => {
    expect(LISTED).toHaveLength(11)
    expect(hasHex(LISTED, 36, 13)).toBe(true) // Pochinok
    expect(hasHex(LISTED, 48, 25)).toBe(true) // Pusii
    expect(hasHex(LISTED, 52, 9)).toBe(true) // Spas Demyansk
    expect(LISTED[0]).toEqual({ col: 36, row: 13 })
  })

  it('5.0c / 剧本 2·4：专属清单为 11 处，以 Krichev 27.05、Demidov 32.25 取代 Pusii、Spas Demyansk', () => {
    const s2 = listedVictoryHexes('2')
    expect(s2).toHaveLength(11)
    expect(hasHex(s2, 27, 5)).toBe(true) // Krichev
    expect(hasHex(s2, 32, 25)).toBe(true) // Demidov
    expect(hasHex(s2, 48, 25)).toBe(false)
    expect(hasHex(s2, 52, 9)).toBe(false)
    // 其余 9 项与通用清单相同
    const shared = LISTED.filter(
      (hex) => !(hex.col === 48 && hex.row === 25) && !(hex.col === 52 && hex.row === 9),
    )
    expect(shared.every((hex) => hasHex(s2, hex.col, hex.row))).toBe(true)
    // 剧本 4 沿用同一清单
    expect(listedVictoryHexes('4')).toEqual(s2)
    // 其余剧本用通用清单
    for (const id of ['1', '3', '5', '6', '7']) {
      expect(listedVictoryHexes(id)).toEqual(LISTED)
    }
  })

  it('5.0c：文本格号解析（`27.05 Krichev` / `36.13`）；非法串返回 null', () => {
    expect(parseVictoryHexText('27.05 Krichev')).toEqual({ col: 27, row: 5 })
    expect(parseVictoryHexText('36.13')).toEqual({ col: 36, row: 13 })
    expect(parseVictoryHexText('Krichev')).toBeNull()
    expect(parseVictoryHexText('')).toBeNull()
  })
})

describe('5.0a：五城与两城（城市可能跨多格）', () => {
  it('5.0a：轴方五城 = Smolensk / Vitebsk / Orsha / Mogilev / Bobruysk（共 7 格）', () => {
    const cities = axisVictoryCities()
    expect(cities.map((city) => city.name)).toEqual([
      'Bobruysk',
      'Mogilev',
      'Orsha',
      'Vitebsk',
      'Smolensk',
    ])
    // Vitebsk 与 Smolensk 各占 2 格（19.27+19.28 / 34.17+34.18）
    expect(cities.find((city) => city.name === 'Vitebsk')?.hexes.map(key)).toEqual([
      '19.27',
      '19.28',
    ])
    expect(cities.find((city) => city.name === 'Smolensk')?.hexes.map(key)).toEqual([
      '34.17',
      '34.18',
    ])
    expect(AXIS_CITY_HEXES).toHaveLength(7)
  })

  it('5.0a：苏方两城 = Vyazma 56.20 / Rzhev 60.34', () => {
    expect(sovietVictoryCities().map((city) => `${city.name}@${key(city.hexes[0]!)}`)).toEqual([
      'Vyazma@56.20',
      'Rzhev@60.34',
    ])
    expect(SOVIET_CITY_HEXES).toHaveLength(2)
  })
})

describe('5.0a / 5.0b / 剧本 2·4：阈值', () => {
  it('5.0a：标准剧本 1/3/5/6/7 ⇒ 苏 ≥7、轴 ≥6；5.0b ⇒ 苏 ≥9、轴 ≥8', () => {
    for (const id of ['1', '3', '5', '6', '7']) {
      const thresholds = victoryThresholdsFor(id)
      expect(thresholds.final).toMatchObject({ sovietListedHexes: 7, axisListedHexes: 6 })
      expect(thresholds.decisive).toMatchObject({ sovietListedHexes: 9, axisListedHexes: 8 })
    }
  })

  it('剧本 2·4 明文例外：苏 ≥6、轴 ≥7，且规则未给其 5.0b 档', () => {
    for (const id of ['2', '4']) {
      const thresholds = victoryThresholdsFor(id)
      expect(thresholds.final).toMatchObject({ sovietListedHexes: 6, axisListedHexes: 7 })
      expect(thresholds.decisive).toBeNull()
    }
  })
})

describe('5.0a / 5.0b：回合时点', () => {
  it('回合区间：首回合号 + 回合数 − 1（各剧本逐一核对）', () => {
    expect(scenarioTurnRange('1')).toMatchObject({ firstTurn: 1, lastTurn: 19, dataNote: null })
    expect(scenarioTurnRange('3')).toMatchObject({ firstTurn: 5, lastTurn: 19 })
    expect(scenarioTurnRange('5')).toMatchObject({ firstTurn: 10, lastTurn: 19 })
    expect(scenarioTurnRange('6')).toMatchObject({ firstTurn: 10, lastTurn: 14 })
    expect(scenarioTurnRange('7')).toMatchObject({ firstTurn: 15, lastTurn: 19 })
  })

  it('剧本 2/4：末回合 = 第 8 回合，且印的「1 Aug 41」**正是**该回合 ⇒ 无自检提示', () => {
    for (const id of ['2', '4']) {
      const range = scenarioTurnRange(id)
      expect(range.lastTurn).toBe(8)
      // ★ 2026-09-15 回合轨修正后（8 月首回合＝1 日），印值与算得的末回合**一致** ⇒ dataNote 为空
      expect(range.dataNote).toBeNull()
    }
    expect(scenarioLastTurn('2')).toBe(8)
  })

  it('7 个剧本的首末回合印值与回合轨**逐条一致**（无任何数据自检提示）', () => {
    for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
      expect(scenarioTurnRange(id).dataNote, `剧本 ${id}`).toBeNull()
    }
  })

  it('5.0a：最终回合判定（到末回合或已过 ⇒ true）', () => {
    expect(isScenarioFinalTurn('1', 18)).toBe(false)
    expect(isScenarioFinalTurn('1', 19)).toBe(true)
    expect(isScenarioFinalTurn('2', 8)).toBe(true)
  })

  it('未知剧本 ⇒ 报数据自检失败（不静默兜底）', () => {
    expect(() => scenarioTurnRange('99')).toThrow(VictoryDataError)
  })
})

describe('5.0a：最终评估', () => {
  it('5.0a：苏控 Vyazma + Rzhev 且 ≥7 所列格 ⇒ 苏军胜', () => {
    const map = { ...assign(SOVIET_CITY_HEXES, 'soviet'), ...assign(LISTED.slice(0, 7), 'soviet') }
    const result = evaluateFinalVictory({ scenarioId: '1', controlOf: control(map) })
    expect(result.outcome).toBe('soviet')
    expect(result.winner).toBe('soviet')
    expect(result.rule).toBe('5.0a')
    expect(result.summary.listedBySide.soviet).toBe(7)
    expect(result.summary.sovietCitiesAllHeld).toBe(true)
  })

  it('5.0a：苏军只有 6 个所列格（标准剧本）⇒ 未达标 ⇒ Draw', () => {
    const map = { ...assign(SOVIET_CITY_HEXES, 'soviet'), ...assign(LISTED.slice(0, 6), 'soviet') }
    const result = evaluateFinalVictory({ scenarioId: '1', controlOf: control(map) })
    expect(result.outcome).toBe('draw')
    expect(result.winner).toBeNull()
  })

  it('5.0a：剧本 2 用特例阈值（苏 ≥6）⇒ 同样 6 格即苏军胜', () => {
    const s2Listed = listedVictoryHexes('2')
    const map = {
      ...assign(SOVIET_CITY_HEXES, 'soviet'),
      ...assign(s2Listed.slice(0, 6), 'soviet'),
    }
    expect(evaluateFinalVictory({ scenarioId: '2', controlOf: control(map) }).outcome).toBe(
      'soviet',
    )
  })

  it('5.0a：轴控五城**全部格** + ≥6 所列格 ⇒ 轴心胜', () => {
    const map = { ...assign(AXIS_CITY_HEXES, 'axis'), ...assign(LISTED.slice(0, 6), 'axis') }
    const result = evaluateFinalVictory({ scenarioId: '1', controlOf: control(map) })
    expect(result.outcome).toBe('axis')
    expect(result.summary.axisCitiesAllHeld).toBe(true)
    expect(result.summary.listedBySide.axis).toBe(6)
  })

  it('5.0a：五城缺任意**一格**（Smolensk 只控 34.18）⇒ 轴心条件不成立', () => {
    const partial = AXIS_CITY_HEXES.filter((hex) => key(hex) !== '34.17')
    const map = { ...assign(partial, 'axis'), ...assign(LISTED.slice(0, 8), 'axis') }
    const result = evaluateFinalVictory({ scenarioId: '1', controlOf: control(map) })
    expect(result.summary.axisCitiesAllHeld).toBe(false)
    expect(result.outcome).toBe('draw')
    expect(result.summary.axisCities.find((city) => city.name === 'Smolensk')?.held).toBe(false)
  })

  it('5.0a：轴控五城但只有 5 个所列格（<6）⇒ Draw', () => {
    const map = { ...assign(AXIS_CITY_HEXES, 'axis'), ...assign(LISTED.slice(0, 5), 'axis') }
    expect(evaluateFinalVictory({ scenarioId: '1', controlOf: control(map) }).outcome).toBe('draw')
  })

  it('5.0c：空格由最后在场方控制 ⇒ 撤走部队不改变控制（计数不变）', () => {
    const map = { ...assign(SOVIET_CITY_HEXES, 'soviet'), ...assign(LISTED.slice(0, 7), 'soviet') }
    // 该格现无可攻击单位，但最后在场方为苏方 ⇒ 5.0c 仍算苏控
    const summary = summarizeVictoryControl({
      scenarioId: '1',
      controlOf: (hex) => (map[key(hex)] === 'soviet' ? 'soviet' : null),
    })
    expect(summary.listedBySide.soviet).toBe(7)
  })
})

describe('5.0b：提前决胜（任一回合开始，19 August 起）', () => {
  it('5.0b：19 August 之前不做检查（ongoing）', () => {
    const map = { ...assign(SOVIET_CITY_HEXES, 'soviet'), ...assign(LISTED, 'soviet') }
    const result = evaluateDecisiveVictory({
      scenarioId: '1',
      date: '1941-08-15',
      controlOf: control(map),
    })
    expect(result.outcome).toBe('ongoing')
    expect(result.detail).toContain('早于 5.0b 的起始日')
  })

  it('5.0b：19 August 起苏控两城 + ≥9 ⇒ 苏军达成 Decisive（游戏立即结束）', () => {
    const map = { ...assign(SOVIET_CITY_HEXES, 'soviet'), ...assign(LISTED.slice(0, 9), 'soviet') }
    const result = evaluateDecisiveVictory({
      scenarioId: '1',
      date: '1941-08-19',
      controlOf: control(map),
    })
    expect(result.outcome).toBe('soviet')
    expect(result.rule).toBe('5.0b')
    expect(result.detail).toContain('游戏立即结束')
  })

  it('5.0b：苏只有 8 个所列格（<9）⇒ 未达成 ⇒ 游戏继续', () => {
    const map = { ...assign(SOVIET_CITY_HEXES, 'soviet'), ...assign(LISTED.slice(0, 8), 'soviet') }
    const result = evaluateDecisiveVictory({
      scenarioId: '1',
      date: '1941-08-22',
      controlOf: control(map),
    })
    expect(result.outcome).toBe('ongoing')
    expect(result.detail).toContain('游戏继续')
  })

  it('5.0b：轴控五城 + ≥8 ⇒ 轴心达成 Decisive', () => {
    const map = { ...assign(AXIS_CITY_HEXES, 'axis'), ...assign(LISTED.slice(0, 8), 'axis') }
    const result = evaluateDecisiveVictory({
      scenarioId: '1',
      date: '1941-08-19',
      controlOf: control(map),
    })
    expect(result.outcome).toBe('axis')
  })

  it('5.0b：剧本 2/4 属 5.0a 明文例外 ⇒ 不做提前决胜检查', () => {
    const map = {
      ...assign(SOVIET_CITY_HEXES, 'soviet'),
      ...assign(listedVictoryHexes('2'), 'soviet'),
    }
    const result = evaluateDecisiveVictory({
      scenarioId: '2',
      date: '1941-08-19',
      controlOf: control(map),
    })
    expect(result.outcome).toBe('ongoing')
    expect(result.thresholds).toBeNull()
    expect(result.detail).toContain('明文例外')
  })
})

describe('5.0a / 5.0b：回合开始与回合结束的检查入口', () => {
  it('回合开始检查＝5.0b（19 Aug 前 ongoing，19 Aug 起给结论）', () => {
    const map = { ...assign(AXIS_CITY_HEXES, 'axis'), ...assign(LISTED.slice(0, 8), 'axis') }
    expect(
      checkTurnStartVictory({ scenarioId: '1', date: '1941-08-15', controlOf: control(map) })
        .outcome,
    ).toBe('ongoing')
    expect(
      checkTurnStartVictory({ scenarioId: '1', date: '1941-08-19', controlOf: control(map) })
        .outcome,
    ).toBe('axis')
  })

  it('回合结束检查：未到最终回合 ⇒ ongoing；到最终回合 ⇒ 5.0a 终局判定', () => {
    const map = { ...assign(SOVIET_CITY_HEXES, 'soviet'), ...assign(LISTED.slice(0, 7), 'soviet') }
    const before = checkTurnEndVictory({ scenarioId: '1', turn: 18, controlOf: control(map) })
    expect(before.outcome).toBe('ongoing')
    expect(before.detail).toContain('不是剧本 1 的最终回合')

    const at = checkTurnEndVictory({ scenarioId: '1', turn: 19, controlOf: control(map) })
    expect(at.outcome).toBe('soviet')
    expect(at.rule).toBe('5.0a')
  })

  it('短剧本：剧本 2 的最终回合为第 8 回合（末日 2 Aug）', () => {
    const map = {
      ...assign(AXIS_CITY_HEXES, 'axis'),
      ...assign(listedVictoryHexes('2').slice(0, 7), 'axis'),
    }
    expect(checkTurnEndVictory({ scenarioId: '2', turn: 7, controlOf: control(map) }).outcome).toBe(
      'ongoing',
    )
    expect(checkTurnEndVictory({ scenarioId: '2', turn: 8, controlOf: control(map) }).outcome).toBe(
      'axis',
    )
  })
})

describe('5.0c：控制汇总', () => {
  it('5.0c：逐城给出是否「全部格」被控制（跨格城市）', () => {
    const map = { ...assign(['34.18', '34.17'].map(parseVictoryHexTextToHex), 'axis') }
    const summary = summarizeVictoryControl({ scenarioId: '1', controlOf: control(map) })
    expect(summary.axisCities.find((city) => city.name === 'Smolensk')).toMatchObject({
      held: true,
    })
    expect(summary.axisCities.find((city) => city.name === 'Orsha')).toMatchObject({ held: false })
    expect(summary.listedBySide).toEqual({ axis: 0, soviet: 0 })
    expect(summary.listedTotal).toBe(11)
  })
})

/** `34.18` → HexRef（测试内小工具，避免依赖文本解析语义） */
function parseVictoryHexTextToHex(text: string): HexRef {
  const parsed = parseVictoryHexText(text)
  if (parsed === null) throw new Error(`格号解析失败：${text}`)
  return parsed
}
