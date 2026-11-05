import { describe, expect, it } from 'vitest'

import { createRngState } from '@/engine/rng'
import { ACTIONS_BY_PHASE, BARRAGE_SOURCES_BY_PHASE, checkTiming } from '@/engine/rules'
import { GAME_PHASES } from '@/engine/state-types'
import type { LegalityRequest } from '@/engine/rules'
import {
  advanceTurn,
  applyInitiativeChoice,
  initiativeQuestion,
  isDecisionPhase,
  nextPhase,
  opponentOf,
  PLAYER_TURN_PHASES,
  resolveInitiative,
  resolveTurnWeather,
  setFirstPlayer,
  TOTAL_TURNS,
  turnDate,
  TurnDriverError,
  turnRoleOf,
} from '@/engine/turn-driver'
import type { GamePhase, Records } from '@/engine/state-types'

/**
 * 环节 ⓪：**SOP 骨架**（Pre-Turn + 段序列 + Turn End）——2.2 流程表 / 2.3 先手判定 / 专规 1.5
 *
 * 本文件是「分环节测试台」的总纲：先固定**段的顺序**与**每段许可的动作**，
 * 后续每个环节文件再各自验证本段内的规则逻辑。
 * 单独运行：`npx vitest run tests/flows/00-sop-backbone.test.ts`
 */

/** 最小 Records 夹具（只填判定所需字段） */
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

/** 最小时机请求（只判 2.2 的段闸，不注入单位与目标格事实） */
function timing(
  phase: GamePhase,
  action: LegalityRequest['action'],
  extra: Partial<LegalityRequest> = {},
) {
  return checkTiming({
    action,
    side: 'axis',
    activeSide: 'axis',
    phase,
    date: turnDate(1),
    ...extra,
  })
}

describe('2.2 流程表：段的顺序与许可动作矩阵', () => {
  it('2.2：玩家回合的八段顺序为 A 整备 → B 增援 → C 移动 → D 补给 → E 反应 → F 战斗 → G 进击 → H 清理', () => {
    expect([...PLAYER_TURN_PHASES]).toEqual([
      'aircraftRefit',
      'reinforcement',
      'movement',
      'supply',
      'reaction',
      'combat',
      'exploitation',
      'cleanUp',
    ])
    // 全阶段枚举 = Pre-Turn + 玩家八段 + Turn End
    expect([...GAME_PHASES]).toEqual(['preTurn', ...PLAYER_TURN_PHASES, 'turnEnd'])
  })

  it('2.2：逐段推进走完先手方 A–H，再交给后手方；后手方走完落到 turnEnd', () => {
    let records = createRecords({
      phase: 'aircraftRefit',
      preTurnSegment: null,
      activeSide: 'axis',
      firstPlayer: 'axis',
    })
    const seen: GamePhase[] = []
    for (let step = 0; step < PLAYER_TURN_PHASES.length; step += 1) {
      records = nextPhase(records)
      seen.push(records.phase)
    }
    // 先手方：A → … → H 之后交给后手方，回到 A
    expect(seen).toEqual([...PLAYER_TURN_PHASES.slice(1), 'aircraftRefit'])
    expect(records.activeSide).toBe('soviet')
    expect(turnRoleOf(records)).toBe('second')

    for (let step = 0; step < PLAYER_TURN_PHASES.length; step += 1) {
      records = nextPhase(records)
    }
    expect(records.phase).toBe('turnEnd')
    expect(records.activeSide).toBeNull()
  })

  it('2.2：每段的许可动作（回归闸门——改这里就是改 SOP，须有规则依据）', () => {
    expect([...ACTIONS_BY_PHASE.preTurn]).toEqual([])
    expect([...ACTIONS_BY_PHASE.aircraftRefit]).toEqual(['refit'])
    // B 段：到达表投放（13.6/2.1/3.1）+ 重建（13.5a）+ 合并（13.9）
    expect([...ACTIONS_BY_PHASE.reinforcement]).toEqual(['arrival', 'rebuild', 'consolidate'])
    /*
     * ★ 契约变更（H④，用户 2026-09-19 口径，**不是放宽**）：D 段原先含 `fuel`（那个「加油」环节），
     *   现按「燃料环节不应该存在，未加油单位是在移动前加油」删掉 —— 12.5c 把付款绑在**消耗时刻**，
     *   补给段不发生燃料消耗 ⇒ 燃料的时机改由 `TIMING_DEFERRED_ACTIONS` 表达（出处是 12.5c），
     *   本表只登记"2.2 段名里写出的动作族"。
     */
    expect([...ACTIONS_BY_PHASE.supply]).toEqual(['supplyTrace', 'hqThrow'])
    expect([...ACTIONS_BY_PHASE.supply]).not.toContain('fuel')
    // 7.0 首句 / 7.0b：反应阶段的**突袭**照常结算 ⇒ E 段含 `overrun`（仍不含 `attack`）
    expect([...ACTIONS_BY_PHASE.reaction]).toEqual(['reserveRelease', 'move', 'overrun', 'barrage'])
    // F/G 段另含 20.0a 的「战后推进/撤退时创建拆分单位」
    expect([...ACTIONS_BY_PHASE.combat]).toEqual(['barrage', 'attack', 'breakdown'])
    expect([...ACTIONS_BY_PHASE.exploitation]).toEqual([
      'reserveRelease',
      'move',
      'overrun',
      'barrage',
      'attack',
      'breakdown',
    ])
    // H 清理：2.2 末段给出**清理**这一动作（摘 DG/进击/燃料标记 + 移除对手的运输破坏标记），
    // 其余动作仍不得在 H 段执行（见下方「段闸确实拦得住」）
    expect([...ACTIONS_BY_PHASE.cleanUp]).toEqual(['cleanUp'])
    expect([...ACTIONS_BY_PHASE.turnEnd]).toEqual([])
    // C 移动段是唯一含「铁路/装卸/工程/工事」的动作集合（13.x / 16.0）
    expect([...ACTIONS_BY_PHASE.movement]).toContain('railTransport')
    expect([...ACTIONS_BY_PHASE.movement]).toContain('railConversion')
    expect([...ACTIONS_BY_PHASE.movement]).toContain('loadUnload')
    expect([...ACTIONS_BY_PHASE.movement]).toContain('engineer')
    expect([...ACTIONS_BY_PHASE.movement]).toContain('buildHedgehog')
  })

  it('2.2：段闸确实拦得住——移动类动作不得出现在 Pre-Turn / B 增援 / H 清理', () => {
    for (const phase of ['preTurn', 'reinforcement', 'cleanUp', 'turnEnd'] as const) {
      const violations = timing(phase, 'move')
      expect(violations.map((item) => item.reason)).toContain('actionNotInSegment')
      expect(violations[0]?.rule).toBe('2.2')
    }
    // 整备只能在 A 段（15.1A）
    expect(timing('movement', 'refit').map((item) => item.reason)).toContain('actionNotInSegment')
  })

  it('2.2：轰炸来源按段分级——C 段仅空中/舰炮，F 段仅炮兵，E/G 段三种皆可（SOP 原文）', () => {
    expect([...(BARRAGE_SOURCES_BY_PHASE.movement ?? [])]).toEqual(['air', 'ship'])
    expect([...(BARRAGE_SOURCES_BY_PHASE.combat ?? [])]).toEqual(['artillery'])
    expect([...(BARRAGE_SOURCES_BY_PHASE.reaction ?? [])]).toEqual(['artillery', 'air', 'ship'])
    expect([...(BARRAGE_SOURCES_BY_PHASE.exploitation ?? [])]).toEqual(['artillery', 'air', 'ship'])

    // C 段用炮兵轰炸 ⇒ 违反 SOP（10.1a/2.2）
    const cSegment = timing('movement', 'barrage', { barrageSource: 'artillery' })
    expect(cSegment.map((item) => item.reason)).toContain('barrageSourceNotAllowedInSegment')
    // F 段用空中轰炸 ⇒ 同样违反
    const fSegment = timing('combat', 'barrage', { barrageSource: 'air' })
    expect(fSegment.map((item) => item.reason)).toContain('barrageSourceNotAllowedInSegment')
    expect(fSegment[0]?.rule).toBe('10.1a')
    // F 段用炮兵轰炸 ⇒ 允许
    expect(timing('combat', 'barrage', { barrageSource: 'artillery' })).toEqual([])
  })

  it('2.2：六个决策阶段（B–G）与两个后勤阶段（A/H）的划分', () => {
    const decision = ['reinforcement', 'movement', 'supply', 'reaction', 'combat', 'exploitation']
    for (const phase of decision) expect(isDecisionPhase(phase as GamePhase)).toBe(true)
    for (const phase of ['preTurn', 'aircraftRefit', 'cleanUp', 'turnEnd'])
      expect(isDecisionPhase(phase as GamePhase)).toBe(false)
  })
})

describe('Pre-Turn ①：天气判定（专规 1.5 / 天气表）', () => {
  it('专规 1.5：剧本首回合按剧本指定，不掷骰', () => {
    const draw = resolveTurnWeather(createRngState(7), {
      isFirstTurn: true,
      firstTurnWeather: 'limited',
    })
    expect(draw.resolution.rolled).toBe(false)
    expect(draw.resolution.rolls).toEqual([])
    expect(draw.resolution.weather).toEqual({ air: 'limited', ground: 'good' })
  })

  it('专规 1.5：首回合未给剧本天气即抛错（禁止静默默认值）', () => {
    expect(() => resolveTurnWeather(createRngState(7), { isFirstTurn: true })).toThrow(
      TurnDriverError,
    )
  })

  it('专规 1.5 / 天气表：1 = 受限飞行，2–6 = 正常飞行，地面恒良好', () => {
    const found = new Map<string, number>()
    for (let seed = 1; seed <= 200 && found.size < 2; seed += 1) {
      const draw = resolveTurnWeather(createRngState(seed), { isFirstTurn: false })
      found.set(draw.resolution.weather.air, draw.resolution.weather.air === 'limited' ? 1 : 2)
      expect(draw.resolution.weather.ground).toBe('good')
      expect(draw.resolution.rolls).toHaveLength(1)
    }
    expect([...found.keys()].sort()).toEqual(['limited', 'normal'])
  })
})

describe('Pre-Turn ②：先手判定（2.3）', () => {
  it('2.3：首回合由剧本指定先手，不掷骰', () => {
    const draw = resolveInitiative(createRngState(3), {
      isFirstTurn: true,
      scenarioFirstPlayer: 'soviet',
    })
    expect(draw.resolution).toEqual({ kind: 'specified', firstPlayer: 'soviet' })
    expect(draw.rolls).toEqual([])
  })

  it('2.3：常规回合双方各掷 2d6，高者为胜者；胜者的先/后手由待答问题输入', () => {
    const draw = resolveInitiative(createRngState(11), { isFirstTurn: false })
    expect(draw.resolution.kind).toBe('choice')
    if (draw.resolution.kind !== 'choice') return
    const { chooser, rolls } = draw.resolution
    expect(chooser).toBe(rolls.axis.total > rolls.soviet.total ? 'axis' : 'soviet')

    // 待答问题只问「先手 / 后手」，不替胜者做决定
    const question = initiativeQuestion(chooser)
    expect(question.responder).toBe(chooser)
    expect(question.rule).toBe('2.3')
    expect(question.options?.map((option) => option.id)).toEqual(['first', 'second'])

    // 落地：选先手 ⇒ firstPlayer = 胜者；选后手 ⇒ 对手
    const records = createRecords({ firstPlayer: null })
    expect(applyInitiativeChoice(records, chooser, 'first').firstPlayer).toBe(chooser)
    expect(applyInitiativeChoice(records, chooser, 'second').firstPlayer).toBe(opponentOf(chooser))
  })

  it('2.3：双方平局即重掷（房规 4.2a 时由指定方判胜）', () => {
    const tieSeed = (() => {
      for (let seed = 1; seed < 5000; seed += 1) {
        const draw = resolveInitiative(createRngState(seed), { isFirstTurn: false })
        if (draw.resolution.kind === 'choice' && draw.resolution.rerolls > 0) return seed
      }
      throw new Error('未找到产生平局的种子')
    })()
    const rerolled = resolveInitiative(createRngState(tieSeed), { isFirstTurn: false })
    expect(rerolled.resolution.kind).toBe('choice')
    if (rerolled.resolution.kind !== 'choice') return
    expect(rerolled.resolution.rerolls).toBeGreaterThan(0)

    const tieBroken = resolveInitiative(createRngState(tieSeed), {
      isFirstTurn: false,
      tieBreaker: 'soviet',
    })
    expect(tieBroken.resolution.kind).toBe('choice')
    if (tieBroken.resolution.kind !== 'choice') return
    expect(tieBroken.resolution.rerolls).toBe(0)
    expect(tieBroken.resolution.chooser).toBe('soviet')
  })

  it('2.3：setFirstPlayer 落地剧本指定；turnRoleOf 区分先/后手回合', () => {
    const specified = setFirstPlayer(createRecords({ firstPlayer: null }), 'axis')
    expect(specified.firstPlayer).toBe('axis')
    expect(turnRoleOf({ ...specified, activeSide: 'axis' })).toBe('first')
    expect(turnRoleOf({ ...specified, activeSide: 'soviet' })).toBe('second')
    expect(turnRoleOf(createRecords({ activeSide: null }))).toBeNull()
  })
})

describe('Pre-Turn → 玩家回合的门与 Turn End 的推进（2.2）', () => {
  it('2.2：先手未判定时不得从 Pre-Turn 进入玩家回合（防静默沿用上一回合）', () => {
    const stuck = createRecords({ preTurnSegment: 'firstPlayerDetermination', firstPlayer: null })
    expect(() => nextPhase(stuck)).toThrow(TurnDriverError)

    const ready = nextPhase(createRecords({ preTurnSegment: 'firstPlayerDetermination' }))
    expect(ready.phase).toBe('aircraftRefit')
    expect(ready.activeSide).toBe('axis')
    expect(ready.preTurnSegment).toBeNull()
  })

  it('2.2：Pre-Turn 内先走天气子步，再走先手子步', () => {
    const afterWeather = nextPhase(createRecords({ preTurnSegment: 'weatherDetermination' }))
    expect(afterWeather.preTurnSegment).toBe('firstPlayerDetermination')
    expect(afterWeather.phase).toBe('preTurn')
  })

  it('2.2 Turn End：仅 turnEnd 可推进回合；推进后回 Pre-Turn 并清空行动方与先手', () => {
    const ended = createRecords({ phase: 'turnEnd', activeSide: null, turn: 1 })
    const next = advanceTurn(ended)
    expect(next.turn).toBe(2)
    expect(next.phase).toBe('preTurn')
    expect(next.preTurnSegment).toBe('weatherDetermination')
    expect(next.activeSide).toBeNull()
    expect(next.firstPlayer).toBeNull()

    expect(() => advanceTurn(createRecords({ phase: 'combat' }))).toThrow(TurnDriverError)
    // 已到本对局末回合 ⇒ 不得再推进（应由终止判定收束，5.0a）
    expect(() =>
      advanceTurn(createRecords({ phase: 'turnEnd', activeSide: null, turn: TOTAL_TURNS })),
    ).toThrow(TurnDriverError)
  })
})
