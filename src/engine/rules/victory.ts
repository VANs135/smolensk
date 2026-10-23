import { mapConfig, mapLayers, markers, rulesConstants, scenarios } from '@/data'
import type { HexRef, Side } from '@/data'

import { normalizeArrivalDate } from './arrival'
import { earlyDecisionCheckDue } from './exclusive-timing'

/**
 * 胜利判定（Smolensk 专规 5.0 / 5.0a / 5.0b / 5.0c）
 *
 * ## 条文原文
 *   - **5.0a Final Victory Assessment**（表 4-1）：「**最终回合结束时**，按特定城市与 5.0c 所列格的
 *     控制判定。**苏联胜** = 控制 **Vyazma、Rzhev** 且控制所列格中**至少 7 个**；
 *     **轴心胜** = 控制 **Smolensk、Vitebsk、Orsha、Mogilev、Bobruysk 的全部格** 且控制所列格中
 *     **至少 6 个**；**否则 Draw**。」
 *   - **5.0b Early Decision Check**：「**任何回合开始**（**19 August 或之后**），若有一方达成
 *     Decisive Win 条件则游戏结束。**苏 Decisive** = Vyazma、Rzhev + 至少 **9** 个所列格；
 *     **轴 Decisive** = 上述五城全部格 + 至少 **8** 个所列格。」
 *   - **5.0c Victory Locations and Control**：「**控制** = 该格有一个 **Attack-Capable** 单位；
 *     若该格为空，则由**最后一个**曾在该格的单位所属方控制。」所列格清单（表 4-2，11 处）见
 *     `map-config.json → victoryLocations`。
 *   - **剧本 2 与 4 的明文例外**（表 4-2b / 技能 ch11 参考表）：改用
 *     「苏 ≥6 所列格 / 轴五城全部格 + ≥7 所列格」；且其 **listed hexes 清单不同** ——
 *     以 **Krichev 27.05、Demidov 32.25** 取代 5.0c 的 **Pusii 48.25、Spas Demyansk 52.09**，
 *     其余 9 项相同（见 `scenarios.json → victory.scenario2HexList`）。
 *
 * ## 数据来源与口径
 *   - **阈值**（7/6/9/8/6/7）与**适用剧本号**取自 `rules-constants.json → smolensk.victory`（唯一来源）；
 *     `scenarios.json → victory` 的散文条目是规则出处留痕，引擎不从中解析数字。
 *   - **所列格清单**：通用清单用产品数据 `map-config.victoryLocations`（结构化坐标）；
 *     剧本 2/4 清单用 `scenarios.victory.scenario2HexList`（原文含地名，故本模块解析其格号前缀）。
 *   - **五城 / 两城**：取自产品数据 `map-layers.json` 的 `city.role` ——
 *     `major_city_victory_condition`（= 2.2 Bobruysk / 15.10 Mogilev / 18.18 Orsha /
 *     19.27+19.28 Vitebsk / 34.17+34.18 Smolensk）与 `victory_objective`（= 56.20 Vyazma /
 *     60.34 Rzhev）。**城市可能跨多格**（Vitebsk、Smolensk 各 2 格），故「控制该城」=
 *     **其全部格**都被该方控制（5.0a 原文 all hexes of…）。
 *   - 本模块**不持盘面状态**：控制事实由调用方以 `controlOf(hex)` 注入（引擎不写状态）。
 */

/** 胜利条件总规则依据 */
export const VICTORY_RULE = '5.0'
/** 最终评估依据 */
export const FINAL_VICTORY_RULE = '5.0a'
/** 提前决胜依据 */
export const DECISIVE_VICTORY_RULE = '5.0b'
/** 控制定义依据 */
export const CONTROL_RULE = '5.0c'

/**
 * `map-layers.json` 的城市角色（5.0c 的两组胜利城市）
 *
 * 产品数据用 `city.role` 把「剧本胜利条件涉及的格」与「地形等级」分开记录
 * （工程库 `city_model.role_vs_terrain`：两者**不得互推**），本模块只读角色、不读等级。
 */
export const AXIS_VICTORY_CITY_ROLE = 'major_city_victory_condition'
/** 苏方胜利目标城（Vyazma / Rzhev）的角色标签 */
export const SOVIET_VICTORY_CITY_ROLE = 'victory_objective'

/** 数据自检失败（剧本号 / 首末回合 / 名单格号与产物数据不一致） */
export class VictoryDataError extends Error {
  constructor(message: string) {
    super(`[victory] ${message}`)
    this.name = 'VictoryDataError'
  }
}

/* ────────────────────────────── 5.0c：控制判定 ────────────────────────────── */

/**
 * 5.0c：一格的控制事实（由调用方从盘面推出）
 *
 * - `attackCapableSide`：格内**可攻击单位**的归属方（14.4c / 3.1：有攻击值即可攻击）；
 *   双方都有时由调用方裁定（本作同格异方单位不可能共存，故不在此判重）。
 * - `lastControllingSide`：该格**最后一个**曾有单位的所属方（空格时生效；格从未被占据则为 null）。
 */
export interface VictoryHexFacts {
  hex: HexRef
  attackCapableSide: Side | null
  lastControllingSide: Side | null
}

/** 5.0c：该格由谁控制（无可攻击单位 ⇒ 最后在场的方；从未被占据 ⇒ null＝无人控制） */
export function controlOfHex(facts: VictoryHexFacts): Side | null {
  return facts.attackCapableSide ?? facts.lastControllingSide
}

/** 控制查询（由调用方实现；引擎不持地图与盘面） */
export type VictoryControlLookup = (hex: HexRef) => Side | null

/* ────────────────────────────── 所列格与城市格 ────────────────────────────── */

/** 格键（`col.row`；与工程数据同规） */
function hexKey(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

/**
 * 5.0c / 剧本 2·4：文本格号 → HexRef
 *
 * `scenarios.victory` 的清单是原文串（`27.05 Krichev` / `36.13`），故只取**格号前缀**解析；
 * 解析不出即返回 null（调用方据此报数据自检失败，不做静默兜底）。
 */
export function parseVictoryHexText(text: string): HexRef | null {
  const token = text.trim().split(/\s+/)[0] ?? ''
  const match = /^(\d{1,2})\.(\d{1,2})$/.exec(token)
  if (match === null) return null
  return { col: Number(match[1]), row: Number(match[2]) }
}

/** 通用清单（5.0c 表 4-2 的 11 处；产品数据 map-config.victoryLocations） */
function standardListedHexes(): readonly HexRef[] {
  return (mapConfig.victoryLocations ?? []).map((hex) => ({ col: hex.col, row: hex.row }))
}

/** 剧本 2·4 专属清单（scenarios.victory.scenario2HexList；Scenario 4 沿用） */
function scenario2ListedHexes(): readonly HexRef[] {
  const list = scenarios.victory.scenario2HexList.map(parseVictoryHexText)
  const broken = list.some((hex) => hex === null)
  if (broken) {
    throw new VictoryDataError(
      'scenarios.victory.scenario2HexList 存在无法解析的格号（应为「列.行」前缀，如 `27.05 Krichev`）',
    )
  }
  return list.filter((hex): hex is HexRef => hex !== null)
}

/**
 * 5.0c / 剧本 2·4：本剧本的**所列格清单**（11 处）
 *
 * 剧本 2/4 使用专属清单（Krichev 27.05、Demidov 32.25 取代 Pusii、Spas Demyansk），
 * 其余剧本使用 5.0c 通用清单；两套清单**各 11 格**，按剧本号选用。
 */
export function listedVictoryHexes(scenarioId: string): readonly HexRef[] {
  return usesScenario2HexList(scenarioId) ? scenario2ListedHexes() : standardListedHexes()
}

/** 该剧本是否使用剧本 2·4 的专属清单（判据取自 rules-constants 的适用剧本号，不写死数字） */
function usesScenario2HexList(scenarioId: string): boolean {
  return (rulesConstants.smolensk.victory.scenario2And4.scenarios as readonly string[]).includes(
    scenarioId,
  )
}

/** 一个胜利城市（同名格归一组；双格城市如 Smolensk 34.17+34.18） */
export interface VictoryCityGroup {
  /** 地名（产品数据 `city.name`） */
  name: string
  /** 该城占据的全部格 */
  hexes: readonly HexRef[]
}

/** 按 `city.role` 收集城市格并按地名归组（组序＝产品数据出现序，保证可复现） */
function cityGroupsWithRole(role: string): readonly VictoryCityGroup[] {
  const groups: { name: string; hexes: HexRef[] }[] = []
  for (const hex of mapLayers.hexes) {
    if (hex.city?.role !== role) continue
    const name = hex.city.name ?? hexKey({ col: hex.col, row: hex.row })
    const existing = groups.find((group) => group.name === name)
    const ref = { col: hex.col, row: hex.row }
    if (existing === undefined) groups.push({ name, hexes: [ref] })
    else existing.hexes.push(ref)
  }
  return groups
}

/** 5.0a：轴方必须**全部格**控制的五城（Smolensk / Vitebsk / Orsha / Mogilev / Bobruysk） */
export function axisVictoryCities(): readonly VictoryCityGroup[] {
  return cityGroupsWithRole(AXIS_VICTORY_CITY_ROLE)
}

/** 5.0a：苏方必须**全部格**控制的两城（Vyazma / Rzhev） */
export function sovietVictoryCities(): readonly VictoryCityGroup[] {
  return cityGroupsWithRole(SOVIET_VICTORY_CITY_ROLE)
}

/** 5.0c / 5.0a：所有胜利条件涉及的格（11 所列格 + 五城格 + 两城格；去重） */
export function allVictoryConditionHexes(): readonly HexRef[] {
  const seen = new Set<string>()
  const result: HexRef[] = []
  const push = (hex: HexRef): void => {
    const key = hexKey(hex)
    if (seen.has(key)) return
    seen.add(key)
    result.push(hex)
  }
  for (const hex of standardListedHexes()) push(hex)
  for (const group of axisVictoryCities()) for (const hex of group.hexes) push(hex)
  for (const group of sovietVictoryCities()) for (const hex of group.hexes) push(hex)
  return result
}

/* ────────────────────────────── 阈值（5.0a / 5.0b / 剧本 2·4） ────────────────────────────── */

/** 一档阈值（数值唯一来源 rules-constants.smolensk.victory） */
export interface VictoryTier {
  /** 苏方须控制的所列格数 */
  sovietListedHexes: number
  /** 轴方须控制的所列格数 */
  axisListedHexes: number
  /** 该档适用的剧本号 */
  scenarios: readonly string[]
}

/** 某剧本的阈值集合 */
export interface VictoryThresholds {
  scenarioId: string
  /** 5.0a 最终评估（必然存在） */
  final: VictoryTier
  /**
   * 5.0b 提前决胜（可能为 null）
   *
   * 规则书的表 4-1 与技能 ch11 参考表**只为剧本 1/3/5/6/7 列出 5.0b**；
   * 剧本 2/4 是 5.0a 的**明文例外**（只给特例终局阈值），故此处为 null
   * ——引擎不替其臆造提前决胜数值（且这两个剧本最迟回合为 1 Aug，早于 5.0b 的起始日）。
   */
  decisive: VictoryTier | null
}

function tierFrom(data: {
  sovietListedHexes: number
  axisListedHexes: number
  scenarios: readonly string[]
}): VictoryTier {
  return {
    sovietListedHexes: data.sovietListedHexes,
    axisListedHexes: data.axisListedHexes,
    scenarios: [...data.scenarios],
  }
}

/** 5.0a / 5.0b / 剧本 2·4：本剧本的阈值（按数据里的适用剧本号选择） */
export function victoryThresholdsFor(scenarioId: string): VictoryThresholds {
  const data = rulesConstants.smolensk.victory
  const final = tierFrom(data.final)
  const special = tierFrom(data.scenario2And4)
  const decisiveAll = tierFrom(data.decisive)

  // 剧本 2·4 明文例外：改用它自己的终局阈值
  if (special.scenarios.includes(scenarioId)) {
    return { scenarioId, final: special, decisive: null }
  }
  if (!final.scenarios.includes(scenarioId)) {
    throw new VictoryDataError(
      `剧本 ${scenarioId} 不在 rules-constants.smolensk.victory 的任何适用剧本号内（final=${final.scenarios.join('/')}）`,
    )
  }
  return {
    scenarioId,
    final,
    // 5.0b 只列于 5.0a 标准剧本；未来若数据为某剧本单独加档，此处自然生效
    decisive: decisiveAll.scenarios.includes(scenarioId) ? decisiveAll : null,
  }
}

/* ────────────────────────────── 控制汇总与评估 ────────────────────────────── */

/** 一个城市当前是否被某方**全部格**控制 */
export interface CityControl {
  name: string
  hexes: readonly HexRef[]
  /** 5.0a：该城**全部格**都被该方控制 */
  held: boolean
}

/** 5.0c 的控制汇总（供判定与界面显示） */
export interface VictoryControlSummary {
  scenarioId: string
  /** 所列格总数（11） */
  listedTotal: number
  /** 各方控制的所列格数 */
  listedBySide: Record<Side, number>
  /** 轴方五城的逐城控制状态 */
  axisCities: readonly CityControl[]
  /** 苏方两城的逐城控制状态 */
  sovietCities: readonly CityControl[]
  /** 五城是否全被轴方控制（5.0a / 5.0b 的轴方前置条件） */
  axisCitiesAllHeld: boolean
  /** 两城是否全被苏方控制（5.0a / 5.0b 的苏方前置条件） */
  sovietCitiesAllHeld: boolean
}

/** 5.0c：汇总当前控制（所列格计数 + 两城/五城是否全格控制） */
export function summarizeVictoryControl(input: {
  scenarioId: string
  controlOf: VictoryControlLookup
}): VictoryControlSummary {
  const listed = listedVictoryHexes(input.scenarioId)
  const listedBySide: Record<Side, number> = { axis: 0, soviet: 0 }
  for (const hex of listed) {
    const side = input.controlOf(hex)
    if (side !== null) listedBySide[side] += 1
  }

  const cityStates = (groups: readonly VictoryCityGroup[], side: Side): CityControl[] =>
    groups.map((group) => ({
      name: group.name,
      hexes: group.hexes,
      held: group.hexes.length > 0 && group.hexes.every((hex) => input.controlOf(hex) === side),
    }))

  const axisCities = cityStates(axisVictoryCities(), 'axis')
  const sovietCities = cityStates(sovietVictoryCities(), 'soviet')

  return {
    scenarioId: input.scenarioId,
    listedTotal: listed.length,
    listedBySide,
    axisCities,
    sovietCities,
    axisCitiesAllHeld: axisCities.length > 0 && axisCities.every((city) => city.held),
    sovietCitiesAllHeld: sovietCities.length > 0 && sovietCities.every((city) => city.held),
  }
}

/** 判定层级 */
export type VictoryLevel = 'final' | 'decisive'

/**
 * 判定结果
 *
 * - `axis` / `soviet`：该方胜（`level='final'`）或达成提前决胜（`level='decisive'`）；
 * - `draw`：双方条件都不满足（**只可能出现在最终评估**，5.0a 原文 else draw）；
 * - `ongoing`：本次检查不产生结论（未到末回合 / 未到 19 Aug / 本剧本无该档判定）。
 */
export type VictoryOutcome = Side | 'draw' | 'ongoing'

/** 一次胜利评估的完整结论 */
export interface VictoryAssessment {
  level: VictoryLevel
  outcome: VictoryOutcome
  /** 胜方（draw / ongoing 为 null） */
  winner: Side | null
  rule: string
  /** 本档阈值 */
  thresholds: VictoryTier | null
  /** 控制汇总（判定的事实基础） */
  summary: VictoryControlSummary
  detail: string
}

/** 各方条件是否满足（苏：两城 + ≥N 所列格；轴：五城全部格 + ≥M 所列格） */
function conditionsMet(
  summary: VictoryControlSummary,
  tier: VictoryTier,
): { soviet: boolean; axis: boolean } {
  return {
    soviet: summary.sovietCitiesAllHeld && summary.listedBySide.soviet >= tier.sovietListedHexes,
    axis: summary.axisCitiesAllHeld && summary.listedBySide.axis >= tier.axisListedHexes,
  }
}

/**
 * 满足条件时的胜方
 *
 * 「双方同时满足」**不可能出现**：所列格共 11 处、每格只归一方的控制，
 * 而两档阈值之和都大于 11（5.0a 7+6=13、5.0b 9+8=17），故苏方达标即轴方必然不达标。
 *
 * - **双方都不满足**：5.0a 明文「否则 Draw」⇒ `neitherIsDraw = true`；5.0b 是「达成即结束」的检查，
 *   未达成即**游戏继续** ⇒ `neitherIsDraw = false`（返回 `ongoing`）。
 */
function outcomeOf(
  met: { soviet: boolean; axis: boolean },
  neitherIsDraw: boolean,
): VictoryOutcome {
  if (met.soviet) return 'soviet'
  if (met.axis) return 'axis'
  return neitherIsDraw ? 'draw' : 'ongoing'
}

/** 一段可读的条件描述（供界面/日志） */
function describeTier(tier: VictoryTier): string {
  return `苏：Vyazma + Rzhev + 所列格 ≥${tier.sovietListedHexes}；轴：五城全部格 + 所列格 ≥${tier.axisListedHexes}`
}

/**
 * 5.0a：**最终评估**（最终回合结束时）
 *
 * 「苏胜 = Vyazma、Rzhev + ≥7 所列格；轴胜 = 五城全部格 + ≥6 所列格；否则 Draw。」
 * 双方同时满足（理论冲突）时按 Draw 处理并写进 detail —— 5.0a 只给「否则 Draw」，
 * 未规定「两者皆满足」的取法，故不得替其臆造优先序。
 */
export function evaluateFinalVictory(input: {
  scenarioId: string
  controlOf: VictoryControlLookup
}): VictoryAssessment {
  const thresholds = victoryThresholdsFor(input.scenarioId)
  const summary = summarizeVictoryControl(input)
  const met = conditionsMet(summary, thresholds.final)
  // 5.0a：「否则 Draw」⇒ 双方都不满足时判 Draw（不同于 5.0b 的「未达成即继续」）
  const outcome = outcomeOf(met, true)
  return {
    level: 'final',
    outcome,
    winner: outcome === 'axis' || outcome === 'soviet' ? outcome : null,
    rule: FINAL_VICTORY_RULE,
    thresholds: thresholds.final,
    summary,
    detail:
      `最终评估（5.0a，剧本 ${input.scenarioId}，规则 ${describeTier(thresholds.final)}）：` +
      `苏控所列格 ${summary.listedBySide.soviet}/${summary.listedTotal}＋两城${summary.sovietCitiesAllHeld ? '全控' : '未全控'}；` +
      `轴控所列格 ${summary.listedBySide.axis}/${summary.listedTotal}＋五城${summary.axisCitiesAllHeld ? '全控' : '未全控'} ⇒ ` +
      (outcome === 'draw'
        ? 'Draw（双方条件均未满足）'
        : outcome === 'soviet'
          ? '苏军胜'
          : '轴心胜'),
  }
}

/**
 * 5.0b：**提前决胜检查**（任一回合**开始**，19 August 或之后）
 *
 * 未到起始日、或本剧本无 5.0b 档（剧本 2/4）⇒ `ongoing`（不产生结论）。
 * 判断与 5.0a 并列：两者条件都在，只是阈值不同（苏 9 / 轴 8）。
 */
export function evaluateDecisiveVictory(input: {
  scenarioId: string
  date: string
  controlOf: VictoryControlLookup
}): VictoryAssessment {
  const thresholds = victoryThresholdsFor(input.scenarioId)
  const summary = summarizeVictoryControl(input)

  if (thresholds.decisive === null) {
    return {
      level: 'decisive',
      outcome: 'ongoing',
      winner: null,
      rule: DECISIVE_VICTORY_RULE,
      thresholds: null,
      summary,
      detail: `剧本 ${input.scenarioId} 属 5.0a 明文例外（剧本 2·4 特例），规则未给其提前决胜阈值（5.0b）⇒ 本回合不做提前决胜检查`,
    }
  }

  const tier = thresholds.decisive
  if (!earlyDecisionCheckDue(input.date)) {
    return {
      level: 'decisive',
      outcome: 'ongoing',
      winner: null,
      rule: DECISIVE_VICTORY_RULE,
      thresholds: tier,
      summary,
      detail: `${input.date} 早于 5.0b 的起始日（${rulesConstants.smolensk.earlyDecisionStart}）⇒ 本回合不做提前决胜检查`,
    }
  }

  const met = conditionsMet(summary, tier)
  // 5.0b 是「达成即结束」的检查：未达成的两方 ⇒ 游戏继续（不判 Draw）
  const outcome = outcomeOf(met, false)
  return {
    level: 'decisive',
    outcome,
    winner: outcome === 'axis' || outcome === 'soviet' ? outcome : null,
    rule: DECISIVE_VICTORY_RULE,
    thresholds: tier,
    summary,
    detail:
      `提前决胜检查（5.0b，${input.date}，规则 ${describeTier(tier)}）：` +
      `苏控所列格 ${summary.listedBySide.soviet}、轴控所列格 ${summary.listedBySide.axis} ⇒ ` +
      (outcome === 'ongoing'
        ? '双方均未达成 Decisive Win ⇒ 游戏继续'
        : outcome === 'soviet'
          ? '苏军达成 Decisive Win ⇒ 游戏立即结束'
          : '轴心达成 Decisive Win ⇒ 游戏立即结束'),
  }
}

/* ────────────────────────────── 回合时点（5.0a / 5.0b） ────────────────────────────── */

/** 剧本的回合区间（末回合号驱动 5.0a 的检查时点） */
export interface ScenarioTurnRange {
  scenarioId: string
  /** 首回合号（由 firstTurn 文本对齐回合轨得出） */
  firstTurn: number
  /** 末回合号（= 首回合号 + 回合数 − 1） */
  lastTurn: number
  /**
   * 剧本数据自检发现的不一致（无则 null）
   *
   * 判据：`lastTurn` 文本在回合轨上的回合号 与 「首回合号 + 回合数 − 1」是否相等。
   * 本模块**以回合轨为准**（首回合 + 回合数共同定义区间），把不一致如实报出，不擅自改写产品数据。
   *
   * ★ 2026-09-15：回合轨日期修正（8/9 月首回合＝**1 日**）后，**7 个剧本全部一致** ⇒ 本字段
   *   当前恒为 null。它此前报的正是剧本 2/4（`lastTurn` 印作 `1 Aug 41`，而错轨把第 8 回合算成
   *   `1941-08-02`）——那处"不一致"其实是**轨道本身写错**，已从源数据修正（见 `arrivalTurnOf`）。
   */
  dataNote: string | null
}

/** 剧本日期文本（`8 Jul 41`）→ 回合号；对不上回合轨即报数据自检失败 */
function turnIndexOf(dateText: string, what: string): number {
  const monthDay = normalizeArrivalDate(dateText)
  if (monthDay === null) throw new VictoryDataError(`${what} 无法解析日期：${dateText}`)
  const index = markers.turnTrack.findIndex((entry) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.date)
    return (
      match !== null && Number(match[2]) === monthDay.month && Number(match[3]) === monthDay.day
    )
  })
  if (index < 0)
    throw new VictoryDataError(`${what}（${dateText}）在回合轨（markers.turnTrack）中不存在`)
  return index
}

/** 回合号（1 起）→ 该剧本里出现的日期文本（供自检提示用） */
function dateOfTurn(turn: number): string {
  return markers.turnTrack.find((entry) => entry.turn === turn)?.date ?? `第 ${turn} 回合`
}

/** 剧本回合区间（首回合号 + 回合数 − 1 = 末回合号；与 lastTurn 文本交叉核对后给出自检提示） */
export function scenarioTurnRange(scenarioId: string): ScenarioTurnRange {
  const scenario = scenarios.scenarios.find((item) => item.id === scenarioId)
  if (scenario === undefined) throw new VictoryDataError(`剧本库中没有剧本 ${scenarioId}`)

  const firstTurn = turnIndexOf(scenario.firstTurn, `剧本 ${scenarioId} 的 firstTurn`) + 1
  const lastTurn = firstTurn + scenario.turns - 1

  // lastTurn 文本只作交叉核对：对不上回合轨（如剧本 2/4 的 `1 Aug 41`）时如实记入 dataNote
  const monthDay = normalizeArrivalDate(scenario.lastTurn)
  const textIndex =
    monthDay === null
      ? -1
      : markers.turnTrack.findIndex((entry) => {
          const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.date)
          return (
            match !== null &&
            Number(match[2]) === monthDay.month &&
            Number(match[3]) === monthDay.day
          )
        })
  const dataNote =
    textIndex < 0 || textIndex + 1 !== lastTurn
      ? `剧本 ${scenarioId} 的 lastTurn 文本「${scenario.lastTurn}」与「firstTurn ${scenario.firstTurn} + ${scenario.turns} 回合」` +
        `推出的末回合（第 ${lastTurn} 回合 = ${dateOfTurn(lastTurn)}）不一致；本模块以回合轨（firstTurn + turns）为准`
      : null

  return { scenarioId, firstTurn, lastTurn, dataNote }
}

/** 剧本末回合号（5.0a 的检查时点） */
export function scenarioLastTurn(scenarioId: string): number {
  return scenarioTurnRange(scenarioId).lastTurn
}

/** 是否为该剧本的**最终回合**（5.0a 的检查时点） */
export function isScenarioFinalTurn(scenarioId: string, turn: number): boolean {
  return turn >= scenarioLastTurn(scenarioId)
}

/**
 * 回合**开始**检查（5.0b）
 *
 * 「任何回合开始（19 August 或之后）」⇒ 未到末回合时唯一的判定入口；
 * 到末回合时仍可先做提前决胜（达成即提前结束），再做 5.0a。
 */
export function checkTurnStartVictory(input: {
  scenarioId: string
  date: string
  controlOf: VictoryControlLookup
}): VictoryAssessment {
  return evaluateDecisiveVictory(input)
}

/**
 * 回合**结束**检查（5.0a）
 *
 * 只在最终回合结束时给出终局判定；未到末回合 ⇒ `ongoing`（5.0a 明文限定「最终回合结束时」）。
 */
export function checkTurnEndVictory(input: {
  scenarioId: string
  turn: number
  controlOf: VictoryControlLookup
}): VictoryAssessment {
  const lastTurn = scenarioLastTurn(input.scenarioId)
  if (!isScenarioFinalTurn(input.scenarioId, input.turn)) {
    const thresholds = victoryThresholdsFor(input.scenarioId)
    return {
      level: 'final',
      outcome: 'ongoing',
      winner: null,
      rule: FINAL_VICTORY_RULE,
      thresholds: thresholds.final,
      summary: summarizeVictoryControl(input),
      detail: `第 ${input.turn} 回合不是剧本 ${input.scenarioId} 的最终回合（末回合 ${lastTurn}）⇒ 5.0a 不做终局判定`,
    }
  }
  return evaluateFinalVictory(input)
}
