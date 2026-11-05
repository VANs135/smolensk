import { describe, expect, it } from 'vitest'

import { createRngState } from '@/engine/rng'
import {
  advanceTurn,
  applyInitiativeChoice,
  DECISION_PHASES,
  initiativeQuestion,
  INITIATIVE_RULE,
  isDecisionPhase,
  nextPhase,
  opponentOf,
  PLAYER_TURN_PHASES,
  resolveInitiative,
  resolveTurnWeather,
  SERVICE_PHASES,
  setFirstPlayer,
  TOTAL_TURNS,
  turnDate,
  TurnDriverError,
  turnRoleOf,
  WEATHER_RULE,
} from '@/engine/turn-driver'
import { GAME_PHASES } from '@/engine/state-types'
import type { GamePhase, Records } from '@/engine/state-types'

/**
 * 阶段机与回合驱动（B5）测试
 *
 * 条文依据：2.2 流程表 / 2.3 先手判定 / 专规 1.5 天气表 / 回合轨（19 回合）。
 * 需要特殊骰面的用例用「确定性扫描种子」构造，结果稳定，不会偶发红灯。
 */

/** 最小 Records 夹具 */
function createRecords(overrides: Partial<Records> = {}): Records {
  return {
    turn: 1,
    phase: 'preTurn',
    preTurnSegment: 'weatherDetermination',
    activeSide: null,
    firstPlayer: 'axis',
    weather: { air: 'normal', ground: 'good' },
    railCapacity: { axis: 0, soviet: 2 },
    markerTracks: {},
    victoryLocations: [],
    counters: {
      reserveMarkers: { axis: 14, soviet: 0 },
      supplyCache: { axis: 2, soviet: 2 },
      constructionMarkers: 3,
    },
    ...overrides,
  }
}

/** 扫描一个「首次判定即平局」的种子（2.3 平局重掷） */
function findTieSeed(): number {
  for (let seed = 1; seed < 5000; seed += 1) {
    const draw = resolveInitiative(createRngState(seed), { isFirstTurn: false })
    if (draw.resolution.kind === 'choice' && draw.resolution.rerolls > 0) return seed
  }
  throw new Error('未找到产生平局的种子（1..5000）')
}

/** 扫描一个「首骰为 1」的种子（天气表 1 = 受限飞行） */
function findLimitedWeatherSeed(): number {
  for (let seed = 1; seed < 5000; seed += 1) {
    const draw = resolveTurnWeather(createRngState(seed), { isFirstTurn: false })
    if (draw.resolution.weather.air === 'limited') return seed
  }
  throw new Error('未找到掷出 1 的种子（1..5000）')
}

/** 扫描一个「首骰非 1」的种子（天气表 2–6 = 正常飞行） */
function findNormalWeatherSeed(): number {
  for (let seed = 1; seed < 5000; seed += 1) {
    const draw = resolveTurnWeather(createRngState(seed), { isFirstTurn: false })
    if (draw.resolution.weather.air === 'normal') return seed
  }
  throw new Error('未找到掷出 2–6 的种子（1..5000）')
}

describe('阶段常量（2.2 流程表）', () => {
  it('玩家回合阶段 = 全阶段去掉 Pre-Turn 与 Turn-End（即 A–H 八段）', () => {
    expect([...PLAYER_TURN_PHASES]).toEqual(
      GAME_PHASES.filter((phase) => phase !== 'preTurn' && phase !== 'turnEnd'),
    )
  })

  it('决策阶段六个（B–G）：增援/移动/补给/反应/战斗/进击', () => {
    expect(DECISION_PHASES).toHaveLength(6)
    expect([...DECISION_PHASES]).toEqual([
      'reinforcement',
      'movement',
      'supply',
      'reaction',
      'combat',
      'exploitation',
    ])
  })

  it('后勤与事务阶段两段（A 飞机整备 / H 清理），与决策阶段合计为玩家回合阶段', () => {
    expect([...SERVICE_PHASES]).toEqual(['aircraftRefit', 'cleanUp'])
    expect([...DECISION_PHASES, ...SERVICE_PHASES].slice().sort()).toEqual(
      [...PLAYER_TURN_PHASES].slice().sort(),
    )
  })

  it('isDecisionPhase：六段为真，后勤事务阶段与 Pre-Turn / Turn-End 为假', () => {
    for (const phase of DECISION_PHASES) expect(isDecisionPhase(phase)).toBe(true)
    for (const phase of [...SERVICE_PHASES, 'preTurn', 'turnEnd'] as GamePhase[]) {
      expect(isDecisionPhase(phase)).toBe(false)
    }
  })

  it('回合轨：19 回合，首末为 1941-07-08 / 1941-09-08', () => {
    expect(TOTAL_TURNS).toBe(19)
    expect(turnDate(1)).toBe('1941-07-08')
    expect(turnDate(6)).toBe('1941-07-26')
    expect(turnDate(19)).toBe('1941-09-08')
    expect(() => turnDate(20)).toThrow(TurnDriverError)
  })

  it('规则依据常量：先手 2.3 / 天气 1.5', () => {
    expect(INITIATIVE_RULE).toBe('2.3')
    expect(WEATHER_RULE).toBe('1.5')
  })

  it('opponentOf：双方互换', () => {
    expect(opponentOf('axis')).toBe('soviet')
    expect(opponentOf('soviet')).toBe('axis')
  })
})

describe('先手判定（2.3）', () => {
  it('首回合由剧本指定、不掷骰（first_turn）', () => {
    const start = createRngState(19410708)
    const draw = resolveInitiative(start, { isFirstTurn: true, scenarioFirstPlayer: 'soviet' })
    expect(draw.resolution).toEqual({ kind: 'specified', firstPlayer: 'soviet' })
    expect(draw.rolls).toEqual([])
    expect(draw.rng).toEqual(start) // 未消耗随机数
  })

  it('首回合缺剧本先手即抛错', () => {
    expect(() => resolveInitiative(createRngState(1), { isFirstTurn: true })).toThrow(
      TurnDriverError,
    )
  })

  it('常规回合：双方各掷 2 骰，点数高者为 chooser，且不替其选择', () => {
    const draw = resolveInitiative(createRngState(19410708), { isFirstTurn: false })
    expect(draw.resolution.kind).toBe('choice')
    if (draw.resolution.kind !== 'choice') return

    // 每次尝试产生两条掷骰记录（各方一条 2d6）
    expect(draw.rolls).toHaveLength(2)
    expect(draw.rolls[0]!.count).toBe(2)
    expect(draw.rolls[1]!.count).toBe(2)
    expect(draw.resolution.rolls.axis.count).toBe(2)
    expect(draw.resolution.rolls.soviet.count).toBe(2)
    // 引擎只掷骰与比较：结果里只有 chooser，没有 firstPlayer
    expect(draw.resolution).not.toHaveProperty('firstPlayer')
    const { axis, soviet } = draw.resolution.rolls
    expect(draw.resolution.chooser).toBe(axis.total > soviet.total ? 'axis' : 'soviet')
  })

  it('平局重掷；启用房规 4.2a 时平局直接判胜、不重掷', () => {
    const seed = findTieSeed()

    const rerolled = resolveInitiative(createRngState(seed), { isFirstTurn: false })
    expect(rerolled.resolution.kind).toBe('choice')
    if (rerolled.resolution.kind === 'choice') {
      expect(rerolled.resolution.rerolls).toBeGreaterThan(0)
      // 尝试次数 = 重掷数 + 1，每次两条记录（各 2d6）
      expect(rerolled.rolls).toHaveLength((rerolled.resolution.rerolls + 1) * 2)
    }

    const houseRule = resolveInitiative(createRngState(seed), {
      isFirstTurn: false,
      tieBreaker: 'soviet',
    })
    expect(houseRule.rolls).toHaveLength(2)
    expect(houseRule.resolution.kind).toBe('choice')
    if (houseRule.resolution.kind === 'choice') {
      expect(houseRule.resolution.chooser).toBe('soviet')
      expect(houseRule.resolution.rerolls).toBe(0)
    }
  })

  it('同种子同结果（可复算）', () => {
    const a = resolveInitiative(createRngState(7), { isFirstTurn: false })
    const b = resolveInitiative(createRngState(7), { isFirstTurn: false })
    expect(a.resolution).toEqual(b.resolution)
    expect(a.rolls).toEqual(b.rolls)
  })

  it('胜者选择以待答问题表达（源库注记：选择必须由胜者输入）', () => {
    const question = initiativeQuestion('soviet')
    expect(question.responder).toBe('soviet')
    expect(question.rule).toBe('2.3')
    expect(question.options?.map((option) => option.id)).toEqual(['first', 'second'])
  })

  it('落地：选择先手 → chooser 成为 firstPlayer；选择后手 → 对手成为 firstPlayer', () => {
    const records = createRecords()
    expect(applyInitiativeChoice(records, 'soviet', 'first').firstPlayer).toBe('soviet')
    expect(applyInitiativeChoice(records, 'soviet', 'second').firstPlayer).toBe('axis')
    // Pre-Turn 期间不设行动方（进入 A 段时才设，见 nextPhase）
    expect(applyInitiativeChoice(records, 'soviet', 'first').activeSide).toBeNull()
  })

  it('首回合剧本先手可直接落地', () => {
    expect(setFirstPlayer(createRecords(), 'soviet').firstPlayer).toBe('soviet')
  })
})

describe('天气判定（专规 1.5 / 天气表）', () => {
  it('首回合按剧本指定、不掷骰', () => {
    const start = createRngState(19410708)
    const draw = resolveTurnWeather(start, { isFirstTurn: true, firstTurnWeather: 'normal' })
    expect(draw.resolution).toEqual({
      weather: { air: 'normal', ground: 'good' },
      rolled: false,
      rolls: [],
    })
    expect(draw.rng).toEqual(start)
  })

  it('首回合缺剧本天气即抛错', () => {
    expect(() => resolveTurnWeather(createRngState(1), { isFirstTurn: true })).toThrow(
      TurnDriverError,
    )
  })

  it('常规回合掷 1 骰：1 → 受限飞行', () => {
    const seed = findLimitedWeatherSeed()
    const draw = resolveTurnWeather(createRngState(seed), { isFirstTurn: false })
    expect(draw.resolution.rolled).toBe(true)
    expect(draw.resolution.rolls).toHaveLength(1)
    expect(draw.resolution.rolls[0]!.total).toBe(1)
    expect(draw.resolution.weather).toEqual({ air: 'limited', ground: 'good' })
  })

  it('常规回合掷 1 骰：2–6 → 正常飞行；地面恒为良好', () => {
    const seed = findNormalWeatherSeed()
    const draw = resolveTurnWeather(createRngState(seed), { isFirstTurn: false })
    expect(draw.resolution.rolls[0]!.total).toBeGreaterThanOrEqual(2)
    expect(draw.resolution.weather).toEqual({ air: 'normal', ground: 'good' })
  })
})

describe('阶段流转（2.2）', () => {
  it('一个完整回合：Pre-Turn 两步 → 先手方 A–H → 后手方 A–H → 回合结束', () => {
    let records = createRecords()

    // Pre-Turn：天气判定 → 先手判定
    records = nextPhase(records)
    expect(records).toMatchObject({ phase: 'preTurn', preTurnSegment: 'firstPlayerDetermination' })
    expect(records.activeSide).toBeNull()

    // 先手判定完成 → 进入先手方 A 段
    records = nextPhase(records)
    expect(records).toMatchObject({ phase: 'aircraftRefit', preTurnSegment: null })
    expect(records.activeSide).toBe('axis')
    expect(turnRoleOf(records)).toBe('first')

    // 先手方 A–H 逐段
    const firstRun: GamePhase[] = [records.phase]
    for (let index = 0; index < PLAYER_TURN_PHASES.length - 1; index += 1) {
      records = nextPhase(records)
      firstRun.push(records.phase)
    }
    expect(firstRun).toEqual([...PLAYER_TURN_PHASES])
    expect(turnRoleOf(records)).toBe('first')

    // 先手方 H 之后 → 后手方 A 段
    records = nextPhase(records)
    expect(records.phase).toBe('aircraftRefit')
    expect(records.activeSide).toBe('soviet')
    expect(turnRoleOf(records)).toBe('second')

    // 后手方 A–H 逐段
    for (let index = 0; index < PLAYER_TURN_PHASES.length - 1; index += 1) {
      records = nextPhase(records)
    }
    expect(records.phase).toBe('cleanUp')

    // 后手方 H 之后 → 回合结束
    records = nextPhase(records)
    expect(records.phase).toBe('turnEnd')
    expect(records.activeSide).toBeNull()
    expect(turnRoleOf(records)).toBeNull()
  })

  it('回合内 A 段总共出现两次（先手方与后手方各一次）', () => {
    let records = nextPhase(nextPhase(createRecords())) // 进入先手方 A
    let aircraftRefitCount = 1
    while (records.phase !== 'turnEnd') {
      records = nextPhase(records)
      if (records.phase === 'aircraftRefit') aircraftRefitCount += 1
    }
    expect(aircraftRefitCount).toBe(2)
  })

  it('turnEnd 再调 nextPhase 抛错（须用 advanceTurn）', () => {
    const end = createRecords({ phase: 'turnEnd', preTurnSegment: null })
    expect(() => nextPhase(end)).toThrow(TurnDriverError)
  })

  it('Pre-Turn 子步骤缺失 / 清理阶段缺行动方 都抛错', () => {
    expect(() => nextPhase(createRecords({ preTurnSegment: null }))).toThrow(TurnDriverError)
    expect(() => nextPhase(createRecords({ phase: 'cleanUp', activeSide: null }))).toThrow(
      TurnDriverError,
    )
  })
})

describe('回合与日期推进（2.2 Turn End）', () => {
  it('turnEnd → 下一回合 Pre-Turn：回合 +1、行动方与先手一并清空、日期随回合轨', () => {
    const end = createRecords({ turn: 5, phase: 'turnEnd', preTurnSegment: null })
    const next = advanceTurn(end)
    expect(next.turn).toBe(6)
    expect(next.phase).toBe('preTurn')
    expect(next.preTurnSegment).toBe('weatherDetermination')
    expect(next.activeSide).toBeNull()
    expect(next.firstPlayer).toBeNull() // 先手须在新回合重新判定（2.3）
    expect(turnDate(next.turn)).toBe('1941-07-26')
  })

  it('短剧本按剧本末回合停住（剧本 2 共 8 回合，回合轨共 19）', () => {
    const turn8End = createRecords({ turn: 8, phase: 'turnEnd', preTurnSegment: null })
    expect(() => advanceTurn(turn8End, 8)).toThrow(TurnDriverError)

    const turn7End = createRecords({ turn: 7, phase: 'turnEnd', preTurnSegment: null })
    expect(advanceTurn(turn7End, 8).turn).toBe(8)
  })

  it('末回合参数非法即抛错', () => {
    const end = createRecords({ turn: 5, phase: 'turnEnd', preTurnSegment: null })
    expect(() => advanceTurn(end, 0)).toThrow(TurnDriverError)
    expect(() => advanceTurn(end, 20)).toThrow(TurnDriverError)
    expect(() => advanceTurn(end, 2.5)).toThrow(TurnDriverError)
  })

  it('非 turnEnd 调 advanceTurn 抛错', () => {
    expect(() => advanceTurn(createRecords({ phase: 'movement' }))).toThrow(TurnDriverError)
  })

  it('回合轨末回合（19）调 advanceTurn 抛错（应由终止判定收束 5.0a）', () => {
    const last = createRecords({ turn: TOTAL_TURNS, phase: 'turnEnd', preTurnSegment: null })
    expect(() => advanceTurn(last)).toThrow(TurnDriverError)
  })

  it('先手未判定时不得进入玩家回合（防静默沿用上一回合先手）', () => {
    const undecided = createRecords({
      preTurnSegment: 'firstPlayerDetermination',
      firstPlayer: null,
    })
    expect(() => nextPhase(undecided)).toThrow(TurnDriverError)
    // 先手判定完成后即可进入
    expect(nextPhase(setFirstPlayer(undecided, 'soviet')).activeSide).toBe('soviet')
  })
})
