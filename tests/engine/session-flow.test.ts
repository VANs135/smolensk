import { describe, expect, it } from 'vitest'

import {
  applyAgreedChecklist,
  applyAnswerToRecords,
  consensusDecisions,
  isAgreedOptionAnswered,
  makeSessionStepper,
  pendingAgreedOptionIndex,
  SOP_STEPS,
  SOP_STEP_COUNT,
  guidanceFor,
  stepIndexFor,
  type SessionFlowContext,
} from '@/engine/session-flow'
import {
  advanceSession,
  answerQuestion,
  isAwaiting,
  isTerminated,
  sessionForm,
  startSession,
  terminationOf,
} from '@/engine/session'
import type { SessionAnswer } from '@/engine/session-types'
import { createRngState } from '@/engine/rng'
import { evaluateDecisiveVictory, evaluateFinalVictory } from '@/engine/rules/victory'
import type { GameSession, Records } from '@/engine/state-types'

/**
 * 会话流程驱动（W6 C10：2.2 流程表逐步引导 / 待答 / 终止）
 *
 * 核对三件事：
 *   ① **步骤清单**＝2.2 流程表（Pre-Turn 2 步 + 双方各 A–H 8 步 + Turn End 1 步 = 19 步）；
 *   ② **逐步引导**由 `Records` 唯一推出（阶段 + Pre-Turn 子步骤 + 先手方对比）；
 *   ③ **步进**：自动段直接结算入账、先手判定停下待答（2.3）、末回合终止（5.0a）、
 *      达成提前决胜即终止（5.0b）、开局共识逐项强制选择（scenarios.agreedOptions）。
 */

/** 空白盘面的最小会话（本模块不承载算子，只跑流程） */
function createSession(overrides: Partial<Records> = {}): GameSession {
  const records: Records = {
    turn: 1,
    phase: 'preTurn',
    preTurnSegment: 'weatherDetermination',
    activeSide: null,
    firstPlayer: null,
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
  return {
    meta: {
      sessionId: 'session-c10',
      createdAt: '1941-07-08T00:00:00.000Z',
      updatedAt: '1941-07-08T00:00:00.000Z',
      schemaVersion: 1,
    },
    state: {
      scenarioId: '1',
      records,
      units: [],
      stacks: [],
      markers: [],
      rng: createRngState(19410708),
    },
    log: [],
    status: { form: 'advancing' },
  }
}

const context = (overrides: Partial<SessionFlowContext> = {}): SessionFlowContext => ({
  firstTurn: 1,
  lastTurn: 19,
  scenarioFirstPlayer: 'axis',
  firstTurnWeather: 'normal',
  earlyDecisionMet: false,
  agreedOptionItems: [],
  ...overrides,
})

/** 走一步（返回步进结果） */
function step(session: GameSession, ctx: SessionFlowContext = context()) {
  return advanceSession(session, makeSessionStepper(ctx))
}

/** 作答并落地 */
function answerAndApply(session: GameSession, optionId: string): GameSession {
  const question = session.status.form === 'awaiting' ? session.status.question : null
  if (question === null) throw new Error('当前无待答问题')
  const answer: SessionAnswer = { questionId: question.id, side: question.responder, optionId }
  const next = answerQuestion(session, answer)
  const records = applyAnswerToRecords({ records: next.state.records, question, answer })
  return { ...next, state: { ...next.state, records } }
}

describe('2.2：步骤清单（一个回合 19 步）', () => {
  it('2.2：Pre-Turn 2 步 + 先手方 A–H 8 步 + 后手方 A–H 8 步 + Turn End 1 步', () => {
    expect(SOP_STEP_COUNT).toBe(19)
    expect(SOP_STEPS.map((step_) => step_.id).slice(0, 2)).toEqual([
      'preTurn.weatherDetermination',
      'preTurn.firstPlayerDetermination',
    ])
    expect(SOP_STEPS[2]?.id).toBe('first.aircraftRefit')
    expect(SOP_STEPS[9]?.id).toBe('first.cleanUp')
    expect(SOP_STEPS[10]?.id).toBe('second.aircraftRefit')
    expect(SOP_STEPS[17]?.id).toBe('second.cleanUp')
    expect(SOP_STEPS[18]?.id).toBe('turnEnd')
  })

  it('2.2：逐步分类——天气/H 清理/Turn End 自动；先手判定待答；A–G 玩家参与', () => {
    const byId = new Map(SOP_STEPS.map((entry) => [entry.id, entry]))
    expect(byId.get('preTurn.weatherDetermination')?.driver).toBe('automatic')
    expect(byId.get('preTurn.firstPlayerDetermination')?.driver).toBe('question')
    expect(byId.get('first.movement')?.driver).toBe('player')
    expect(byId.get('second.cleanUp')?.driver).toBe('automatic')
    expect(byId.get('turnEnd')?.driver).toBe('automatic')
    // 规则章号落在各段归属章
    expect(byId.get('first.aircraftRefit')?.rule).toBe('15.1')
    expect(byId.get('first.supply')?.rule).toBe('12.0')
    expect(byId.get('preTurn.firstPlayerDetermination')?.rule).toBe('2.3')
    expect(byId.get('preTurn.weatherDetermination')?.rule).toBe('1.5')
  })
})

describe('2.2：逐步引导由 Records 推出', () => {
  it('2.2：Pre-Turn 按子步骤落在前两步', () => {
    expect(stepIndexFor(createSession().state.records)).toBe(0)
    expect(
      stepIndexFor(createSession({ preTurnSegment: 'firstPlayerDetermination' }).state.records),
    ).toBe(1)
    expect(guidanceFor(createSession().state.records)).toMatchObject({ index: 0, total: 19 })
  })

  it('2.2：A–H 按「行动方是否先手方」落到 2..9 / 10..17', () => {
    const first = createSession({
      phase: 'movement',
      preTurnSegment: null,
      activeSide: 'axis',
      firstPlayer: 'axis',
    }).state.records
    expect(stepIndexFor(first)).toBe(4) // 2 + C 段序号 2

    const second = createSession({
      phase: 'movement',
      preTurnSegment: null,
      activeSide: 'soviet',
      firstPlayer: 'axis',
    }).state.records
    expect(stepIndexFor(second)).toBe(12)
    expect(SOP_STEPS[12]?.id).toBe('second.movement')
  })

  it('2.2：Turn End 固定最后一步', () => {
    expect(
      stepIndexFor(createSession({ phase: 'turnEnd', preTurnSegment: null }).state.records),
    ).toBe(18)
  })

  it('2.2：行动方/先手方缺失 ⇒ 返回 null（不静默兜底）', () => {
    const records = createSession({
      phase: 'movement',
      preTurnSegment: null,
      activeSide: null,
      firstPlayer: null,
    }).state.records
    expect(stepIndexFor(records)).toBeNull()
    expect(guidanceFor(records)).toBeNull()
  })
})

describe('2.2 / 1.5：步进（自动段）', () => {
  it('1.5：Pre-Turn 天气判定自动结算并入账（首回合按剧本指定，不掷骰）', () => {
    const session = createSession()
    const advance = step(session)
    expect(advance.kind).toBe('advanced')
    expect(advance.session.state.records.phase).toBe('preTurn')
    expect(advance.session.state.records.preTurnSegment).toBe('firstPlayerDetermination')
    const entry = advance.session.log.at(-1)
    expect(entry).toMatchObject({ action: 'weather', phase: 'preTurn' })
    expect(entry?.outcome).toMatchObject({ ok: true, rule: '1.5' })
  })

  it('2.2：先手方走完 A–H 的 8 步后交给后手方（段序与流程表一致）', () => {
    let session = createSession({
      phase: 'aircraftRefit',
      preTurnSegment: null,
      activeSide: 'axis',
      firstPlayer: 'axis',
    })
    const seen: string[] = []
    for (let index = 0; index < 8; index += 1) {
      const advance = step(session)
      expect(advance.kind).toBe('advanced')
      session = advance.session
      seen.push(session.state.records.phase)
    }
    // 先手方 A→H 之后交给后手方重做 A 段
    expect(seen).toEqual([
      'reinforcement',
      'movement',
      'supply',
      'reaction',
      'combat',
      'exploitation',
      'cleanUp',
      'aircraftRefit',
    ])
    expect(session.state.records.activeSide).toBe('soviet')
  })

  it('2.2：后手方 H 段之后落到 Turn End（无行动方）', () => {
    const session = createSession({
      phase: 'cleanUp',
      preTurnSegment: null,
      activeSide: 'soviet',
      firstPlayer: 'axis',
    })
    const advance = step(session)
    expect(advance.session.state.records.phase).toBe('turnEnd')
    expect(advance.session.state.records.activeSide).toBeNull()
  })

  it('2.2：Turn End 推进回合，回到下一回合的 Pre-Turn 天气判定', () => {
    const session = createSession({ phase: 'turnEnd', preTurnSegment: null, turn: 3 })
    const advance = step(session)
    expect(advance.kind).toBe('advanced')
    expect(advance.session.state.records).toMatchObject({
      turn: 4,
      phase: 'preTurn',
      preTurnSegment: 'weatherDetermination',
      activeSide: null,
      firstPlayer: null,
    })
  })
})

describe('2.3：先手判定作为待答问题', () => {
  it('2.3：首回合不掷骰，按剧本指定先手并自动进入 A 段', () => {
    const session = createSession({ preTurnSegment: 'firstPlayerDetermination' })
    const advance = step(session, context({ scenarioFirstPlayer: 'axis' }))
    expect(advance.kind).toBe('advanced')
    expect(advance.session.state.records).toMatchObject({
      phase: 'aircraftRefit',
      activeSide: 'axis',
      firstPlayer: 'axis',
    })
  })

  it('2.3：常规回合停下待答（题面=选择先手/后手，应答方=掷骰胜者）', () => {
    const session = createSession({ turn: 2, preTurnSegment: 'firstPlayerDetermination' })
    const advance = step(session)
    expect(advance.kind).toBe('question')
    expect(sessionForm(advance.session)).toBe('awaiting')
    const question =
      advance.session.status.form === 'awaiting' ? advance.session.status.question : null
    expect(question).toMatchObject({ id: 'initiative', kind: 'initiative', rule: '2.3' })
    expect(question?.options?.map((option) => option.id)).toEqual(['first', 'second'])
    // 掷骰已入账（可复算）
    expect(advance.session.log.some((entry) => entry.action === 'initiative')).toBe(true)
  })

  it('2.3：作答后按选项落地先手方（先手/后手），并回到 advancing', () => {
    const session = createSession({ turn: 2, preTurnSegment: 'firstPlayerDetermination' })
    const asked = step(session)
    const resolved = answerAndApply(asked.session, 'second')
    expect(sessionForm(resolved)).toBe('advancing')
    const chooser =
      asked.session.status.form === 'awaiting' ? asked.session.status.question.responder : null
    // 选「后手」⇒ 对手成为先手方
    expect(resolved.state.records.firstPlayer).toBe(chooser === 'axis' ? 'soviet' : 'axis')
    // 作答已入账（answerQuestion 的固有行为）
    expect(resolved.log.at(-1)).toMatchObject({ action: 'answer' })
  })

  it('2.3：应答方不符 / 选项不在列 ⇒ 内核拒绝（界面无法绕过）', () => {
    const session = createSession({ turn: 2, preTurnSegment: 'firstPlayerDetermination' })
    const asked = step(session)
    const question = asked.session.status.form === 'awaiting' ? asked.session.status.question : null
    if (question === null) throw new Error('应当有待答问题')
    const wrongSide = question.responder === 'axis' ? 'soviet' : 'axis'
    expect(() =>
      answerQuestion(asked.session, {
        questionId: question.id,
        side: wrongSide,
        optionId: 'first',
      }),
    ).toThrow()
    expect(() =>
      answerQuestion(asked.session, {
        questionId: question.id,
        side: question.responder,
        optionId: 'nope',
      }),
    ).toThrow()
  })
})

describe('scenarios.agreedOptions：开局共识逐项强制选择', () => {
  const items = ['地图外盒是否隐藏（1.4）', '秘密掷骰（4.9e）']

  it('共识开关：开局前逐条提问，采纳/不采纳两态', () => {
    const session = createSession()
    const asked = step(session, context({ agreedOptionItems: items }))
    expect(asked.kind).toBe('question')
    const question = asked.session.status.form === 'awaiting' ? asked.session.status.question : null
    expect(question?.id).toBe('agreedOption:0')
    expect(question?.kind).toBe('agreedOption')
    expect(question?.rule).toBe('4.0')
    expect(question?.options?.map((option) => option.id)).toEqual(['adopt', 'decline'])
  })

  it('共识开关：作答逐条推进（第 2 条在前 1 条答完后才问）', () => {
    const session = createSession()
    const first = step(session, context({ agreedOptionItems: items }))
    expect(pendingAgreedOptionIndex(first.session, items)).toBe(0)
    const answered = answerAndApply(first.session, 'adopt')
    expect(isAgreedOptionAnswered(answered, 0)).toBe(true)
    expect(pendingAgreedOptionIndex(answered, items)).toBe(1)

    const second = step(answered, context({ agreedOptionItems: items }))
    const question =
      second.session.status.form === 'awaiting' ? second.session.status.question : null
    expect(question?.id).toBe('agreedOption:1')
  })

  it('共识开关：全部答完 ⇒ 进入 Pre-Turn 天气判定（不再重复提问）', () => {
    let session = createSession()
    for (const option of ['adopt', 'decline']) {
      const asked = step(session, context({ agreedOptionItems: items }))
      session = answerAndApply(asked.session, option)
    }
    expect(pendingAgreedOptionIndex(session, items)).toBeNull()
    const advance = step(session, context({ agreedOptionItems: items }))
    expect(advance.kind).toBe('advanced')
    expect(advance.session.state.records.preTurnSegment).toBe('firstPlayerDetermination')
  })

  it('共识开关：结论可从日志读出（「必须写入存档」）', () => {
    const session = createSession()
    const answered = answerAndApply(
      step(session, context({ agreedOptionItems: items })).session,
      'adopt',
    )
    expect(consensusDecisions(answered, items)).toEqual([
      { item: items[0], adopted: true },
      { item: items[1], adopted: null },
    ])
  })
})

describe('W7 C13：共识勾选列表（4.0：勾 = 采用，默认全部不勾）', () => {
  const items = ['地图外盒是否隐藏（1.4）', '秘密掷骰（4.9e）', '同步操作回合（2.4）']

  it('C13：部分勾选 / 全不勾 ⇒ 都照写日志（勾 = 采用，不勾 = 不用）', () => {
    const session = createSession()
    const partial = applyAgreedChecklist({
      session,
      context: context({ agreedOptionItems: items }),
      checks: [true, false, true],
    })
    expect(partial.ok).toBe(true)
    if (!partial.ok) return
    expect(partial.data.decisions.map((decision) => decision.adopted)).toEqual([true, false, true])

    // 全不勾也合法（默认口径）：逐条记为「不采用」，但仍写进日志
    const none = applyAgreedChecklist({
      session: createSession(),
      context: context({ agreedOptionItems: items }),
      checks: [false, false, false],
    })
    expect(none.ok).toBe(true)
    if (!none.ok) return
    expect(none.data.decisions.every((decision) => decision.adopted === false)).toBe(true)

    // 勾选数与条目数不符仍拒绝（这是形状错误，不是选择错误）
    expect(
      applyAgreedChecklist({
        session,
        context: context({ agreedOptionItems: items }),
        checks: [true],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('LengthMismatch') })
  })

  it('C13：全部勾选 ⇒ 逐条结论一次写入日志，此后第一回合才推进', () => {
    const checked = applyAgreedChecklist({
      session: createSession(),
      context: context({ agreedOptionItems: items }),
      checks: [true, true, true],
    })
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    const session = checked.data.session
    // 三条结论都在日志里（＝存档的一部份）
    expect(session.log.filter((entry) => entry.action === 'answer')).toHaveLength(items.length)
    expect(pendingAgreedOptionIndex(session, items)).toBeNull()
    expect(consensusDecisions(session, items).every((decision) => decision.adopted === true)).toBe(
      true,
    )
    expect(checked.data.detail).toContain('3/3 项采纳')
    // 共识过后即可走天气判定（自动段）
    const advance = step(session, context({ agreedOptionItems: items }))
    expect(advance.kind).toBe('advanced')
  })

  it('C13：勾选 = 已达成一致、采纳 = 是否生效（第 2 条谈过但不用）', () => {
    const plan = applyAgreedChecklist({
      session: createSession(),
      context: context({ agreedOptionItems: items }),
      checks: [true, true, true],
      adopted: [true, false, true],
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(
      consensusDecisions(plan.data.session, items).map((decision) => decision.adopted),
    ).toEqual([true, false, true])
    expect(plan.data.detail).toContain('2/3 项采纳')
  })
})

describe('5.0a / 5.0b：终止判定（P3）', () => {
  it('5.0b：回合开始达成提前决胜 ⇒ 立即终止（不掷天气、不进玩家段）', () => {
    const session = createSession({ turn: 13 })
    const advance = step(session, context({ earlyDecisionMet: true }))
    expect(advance.kind).toBe('terminated')
    expect(isTerminated(advance.session)).toBe(true)
    expect(terminationOf(advance.session)).toBe('earlyDecision')
    expect(advance.session.log.at(-1)?.outcome).toMatchObject({ ok: true, rule: '5.0b' })
  })

  it('5.0b：未达成 ⇒ 正常掷天气进入回合', () => {
    const session = createSession({ turn: 13 })
    const advance = step(session, context({ earlyDecisionMet: false }))
    expect(advance.kind).toBe('advanced')
  })

  it('5.0a：末回合结束时终止（回合数用尽）', () => {
    const session = createSession({ phase: 'turnEnd', preTurnSegment: null, turn: 19 })
    const advance = step(session, context({ lastTurn: 19 }))
    expect(advance.kind).toBe('terminated')
    expect(terminationOf(advance.session)).toBe('turnsExhausted')
    expect(advance.session.log.at(-1)?.outcome).toMatchObject({ ok: true, rule: '5.0a' })
  })

  it('5.0a：未到末回合 ⇒ 正常推进；已终止的会话再步进 ⇒ 幂等返回', () => {
    const session = createSession({ phase: 'turnEnd', preTurnSegment: null, turn: 18 })
    const advanced = step(session, context({ lastTurn: 19 }))
    expect(advanced.kind).toBe('advanced')
    expect(advanced.session.state.records.turn).toBe(19)

    const terminated = step(
      createSession({ turn: 19, phase: 'turnEnd', preTurnSegment: null }),
      context(),
    )
    const again = step(terminated.session, context())
    expect(again.kind).toBe('terminated')
    expect(again.session).toBe(terminated.session)
  })

  it('⑬ 接线 5.0a：注入判定结论后，收束条目带上胜方与控制计数', () => {
    const session = createSession({ phase: 'turnEnd', preTurnSegment: null, turn: 19 })
    // 盘面求值：全格归苏军 ⇒ 5.0a 判苏胜
    const finalVictory = evaluateFinalVictory({ scenarioId: '1', controlOf: () => 'soviet' })
    expect(finalVictory.outcome).toBe('soviet')
    const advance = step(session, context({ finalVictory }))
    expect(advance.kind).toBe('terminated')
    const entry = advance.session.log.at(-1)
    expect(entry?.outcome).toMatchObject({ ok: true, rule: '5.0a' })
    if (entry === undefined || !entry.outcome.ok) return
    expect(entry.outcome.data['victory']).toMatchObject({
      level: 'final',
      outcome: 'soviet',
      winner: 'soviet',
      listedSoviet: expect.any(Number),
      listedTotal: expect.any(Number),
    })
  })

  it('⑬ 接线 5.0a：未注入判定结论时保持既有行为（只记 reason）', () => {
    const session = createSession({ phase: 'turnEnd', preTurnSegment: null, turn: 19 })
    const advance = step(session, context())
    const entry = advance.session.log.at(-1)
    if (entry === undefined || !entry.outcome.ok) throw new Error('应有成功的收束条目')
    expect(entry.outcome.data['victory']).toBeUndefined()
    expect(entry.outcome.data['reason']).toBe('turnsExhausted')
  })

  it('⑬ 接线 5.0b：判定结论优先于手填开关（结论为 ongoing 时不终止）', () => {
    const records = {
      turn: 10,
      phase: 'preTurn' as const,
      preTurnSegment: 'weatherDetermination' as const,
    }
    // 手填开关说「已达成」，但盘面结论是 ongoing（两城未全控）⇒ 以结论为准，不终止
    const ongoing = evaluateDecisiveVictory({
      scenarioId: '1',
      date: '1941-08-19',
      controlOf: () => null,
    })
    expect(ongoing.outcome).toBe('ongoing')
    const advanced = step(
      createSession(records),
      context({ earlyDecisionMet: true, decisiveVictory: ongoing }),
    )
    expect(advanced.kind).toBe('advanced')

    // 结论达成 ⇒ 立即终止，且条目带上结论
    const met = evaluateDecisiveVictory({
      scenarioId: '1',
      date: '1941-08-19',
      controlOf: () => 'soviet',
    })
    expect(met.outcome).toBe('soviet')
    const terminated = step(
      createSession(records),
      context({ earlyDecisionMet: false, decisiveVictory: met }),
    )
    expect(terminated.kind).toBe('terminated')
    const entry = terminated.session.log.at(-1)
    if (entry === undefined || !entry.outcome.ok) throw new Error('应有成功的收束条目')
    expect(entry.outcome.data['victory']).toMatchObject({ level: 'decisive', outcome: 'soviet' })
  })

  it('2.2：待答期间不得步进（须先作答）', () => {
    const session = createSession({ turn: 2, preTurnSegment: 'firstPlayerDetermination' })
    const asked = step(session)
    expect(isAwaiting(asked.session)).toBe(true)
    expect(() => step(asked.session)).toThrow()
  })
})

describe('W6 C10：整局流程可跑通（19 回合 × 19 步，含逐回合先手待答）', () => {
  it('2.2 / 2.3 / 5.0a：从开局共识到末回合终止，全程无异常', () => {
    let session = startSession({ ...createSession(), status: { form: 'created' } })
    const items = ['同步操作回合（2.4）']
    let guard = 0
    while (!isTerminated(session)) {
      guard += 1
      if (guard > 2000) throw new Error('流程未在合理步数内终止（疑似死循环）')
      const advance = step(session, context({ agreedOptionItems: items, earlyDecisionMet: false }))
      session = advance.session
      if (advance.kind === 'question') {
        // 逐题作答：共识采纳、先手选择先手
        const question = session.status.form === 'awaiting' ? session.status.question : null
        session = answerAndApply(session, question?.kind === 'agreedOption' ? 'adopt' : 'first')
      }
    }
    expect(terminationOf(session)).toBe('turnsExhausted')
    expect(session.state.records.turn).toBe(19)
    // 19 回合每回合都留下了天气/段推进/回合推进的审计日志
    expect(session.log.filter((entry) => entry.action === 'weather')).toHaveLength(19)
    expect(session.log.filter((entry) => entry.action === 'turnEnd')).toHaveLength(18)
    expect(session.log.filter((entry) => entry.action === 'answer')).toHaveLength(19) // 1 共识 + 18 先手
  })
})
