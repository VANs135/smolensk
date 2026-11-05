import { describe, expect, it } from 'vitest'

import { succeed } from '@/engine/result-types'
import {
  advanceSession,
  appendLog,
  answerQuestion,
  askQuestion,
  canAdvance,
  currentQuestion,
  currentResponder,
  deserializeSession,
  isAwaiting,
  isTerminated,
  SESSION_SAVE_VERSION,
  SessionError,
  sessionForm,
  serializeSession,
  startSession,
  terminateSession,
  terminationOf,
} from '@/engine/session'
import type { SessionStepper } from '@/engine/session'
import { SESSION_FORMS, TERMINATION_REASONS } from '@/engine/session-types'
import type { QuestionOption, SessionQuestion, SessionStatus } from '@/engine/session-types'
import type { GameSession, SessionLogEntry } from '@/engine/state-types'

/**
 * 会话框架（B4）测试
 *
 * 覆盖四形态迁移（created / advancing / awaiting / terminated）、形态守卫、
 * 待答与应答方约束、「强制动作与自动后果不进待答」、终止判定与序列化往返。
 */

/** 最小会话夹具（形态可指定，便于逐形态用例） */
function createSession(status: SessionStatus = { form: 'created' }): GameSession {
  return {
    meta: {
      sessionId: 'session-b4',
      createdAt: '1941-07-08T00:00:00.000Z',
      updatedAt: '1941-07-08T00:00:00.000Z',
      schemaVersion: 1,
    },
    state: {
      scenarioId: '1',
      records: {
        turn: 1,
        phase: 'movement',
        preTurnSegment: null,
        activeSide: 'axis',
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
      },
      units: [],
      stacks: [],
      markers: [],
      rng: { seed: 19410708, state: 19410708, drawCount: 0 },
    },
    log: [],
    status,
  }
}

/** 待答问题夹具：9.10 选项（守方选择撤退或损失 1 军力） */
function createQuestion(overrides: Partial<SessionQuestion> = {}): SessionQuestion {
  return {
    id: 'q-1',
    responder: 'soviet',
    kind: 'option',
    rule: '9.10',
    prompt: '守方选择：撤退或损失 1 军力',
    options: [
      { id: 'retreat', label: '撤退' },
      { id: 'lose-step', label: '损失 1 军力' },
    ],
    ...overrides,
  }
}

/** 自动后果日志条目（无待答） */
function createAutoEntry(): SessionLogEntry {
  return {
    turn: 1,
    phase: 'movement',
    side: 'axis',
    action: 'refit',
    rolls: [],
    outcome: succeed('15.1', { note: '基地自动整备' }),
  }
}

/** 开局到 advancing 的会话 */
function advancing(): GameSession {
  return startSession(createSession())
}

/** 停在待答的会话 */
function awaiting(): GameSession {
  return askQuestion(advancing(), createQuestion())
}

describe('四形态与查询', () => {
  it('形态词表与终止原因词表', () => {
    expect([...SESSION_FORMS]).toEqual(['created', 'advancing', 'awaiting', 'terminated'])
    expect([...TERMINATION_REASONS]).toEqual(['turnsExhausted', 'earlyDecision'])
  })

  it('created：无待答、不能推进、未终止', () => {
    const session = createSession()
    expect(sessionForm(session)).toBe('created')
    expect(canAdvance(session)).toBe(false)
    expect(currentQuestion(session)).toBeNull()
    expect(currentResponder(session)).toBeNull()
    expect(isTerminated(session)).toBe(false)
    expect(terminationOf(session)).toBeNull()
  })

  it('advancing：可推进、无待答', () => {
    const session = advancing()
    expect(sessionForm(session)).toBe('advancing')
    expect(canAdvance(session)).toBe(true)
    expect(isAwaiting(session)).toBe(false)
    expect(currentResponder(session)).toBeNull()
  })

  it('awaiting：不可推进、暴露问题与当前应答方', () => {
    const session = awaiting()
    expect(sessionForm(session)).toBe('awaiting')
    expect(canAdvance(session)).toBe(false)
    expect(isAwaiting(session)).toBe(true)
    expect(currentQuestion(session)?.rule).toBe('9.10')
    expect(currentResponder(session)).toBe('soviet')
  })

  it('terminated：暴露终止原因（5.0a 回合用尽）', () => {
    const session = terminateSession(advancing(), 'turnsExhausted')
    expect(sessionForm(session)).toBe('terminated')
    expect(canAdvance(session)).toBe(false)
    expect(isTerminated(session)).toBe(true)
    expect(terminationOf(session)).toBe('turnsExhausted')
  })
})

describe('形态迁移：开局 / 提问 / 作答 / 终止', () => {
  it('startSession：created → advancing；重复开局抛错', () => {
    const session = startSession(createSession())
    expect(sessionForm(session)).toBe('advancing')
    expect(() => startSession(session)).toThrow(SessionError)
  })

  it('askQuestion：advancing → awaiting', () => {
    const session = askQuestion(advancing(), createQuestion())
    expect(sessionForm(session)).toBe('awaiting')
  })

  it('askQuestion：一次只允许一个待答', () => {
    expect(() => askQuestion(awaiting(), createQuestion({ id: 'q-2' }))).toThrow(SessionError)
  })

  it('askQuestion：未开局 / 已终止不可提问', () => {
    expect(() => askQuestion(createSession(), createQuestion())).toThrow(SessionError)
    expect(() =>
      askQuestion(terminateSession(advancing(), 'earlyDecision'), createQuestion()),
    ).toThrow(SessionError)
  })

  it('answerQuestion：awaiting → advancing，并把作答记入日志', () => {
    const session = answerQuestion(awaiting(), {
      questionId: 'q-1',
      side: 'soviet',
      optionId: 'lose-step',
    })
    expect(sessionForm(session)).toBe('advancing')
    expect(session.log).toHaveLength(1)
    const entry = session.log[0]!
    expect(entry.action).toBe('answer')
    expect(entry.side).toBe('soviet')
    expect(entry.outcome.rule).toBe('9.10')
  })

  it('answerQuestion 校验：题号 / 应答方 / 选项', () => {
    expect(() =>
      answerQuestion(awaiting(), { questionId: 'q-9', side: 'soviet', optionId: 'retreat' }),
    ).toThrow(SessionError)

    expect(() =>
      answerQuestion(awaiting(), { questionId: 'q-1', side: 'axis', optionId: 'retreat' }),
    ).toThrow(SessionError)

    expect(() => answerQuestion(awaiting(), { questionId: 'q-1', side: 'soviet' })).toThrow(
      SessionError,
    )

    expect(() =>
      answerQuestion(awaiting(), { questionId: 'q-1', side: 'soviet', optionId: 'nope' }),
    ).toThrow(SessionError)
  })

  it('answerQuestion：非待答形态抛错', () => {
    expect(() => answerQuestion(advancing(), { questionId: 'q-1', side: 'soviet' })).toThrow(
      SessionError,
    )
  })

  it('无选项问题用自由作答值（value）', () => {
    const session = askQuestion(
      advancing(),
      createQuestion({ id: 'q-2', kind: 'choice', options: undefined }),
    )
    const answered = answerQuestion(session, { questionId: 'q-2', side: 'soviet', value: 1 })
    expect(sessionForm(answered)).toBe('advancing')
    expect(answered.log[0]!.outcome.ok).toBe(true)
  })

  it('terminateSession 幂等，且保留首个原因', () => {
    const once = terminateSession(advancing(), 'turnsExhausted')
    const twice = terminateSession(once, 'earlyDecision')
    expect(terminationOf(twice)).toBe('turnsExhausted')
  })
})

describe('强制动作与自动后果不进待答', () => {
  it('appendLog 只记账、不改形态，也不产生应答方', () => {
    let session = advancing()
    session = appendLog(session, createAutoEntry())
    session = appendLog(session, createAutoEntry())

    expect(sessionForm(session)).toBe('advancing')
    expect(canAdvance(session)).toBe(true)
    expect(currentQuestion(session)).toBeNull()
    expect(currentResponder(session)).toBeNull()
    expect(session.log).toHaveLength(2)
  })

  it('advanceSession 守卫：created / awaiting 不可推进，terminated 幂等', () => {
    const stepper: SessionStepper = (s) => ({ kind: 'advanced', session: s })

    expect(() => advanceSession(createSession(), stepper)).toThrow(SessionError)
    expect(() => advanceSession(awaiting(), stepper)).toThrow(SessionError)

    const done = terminateSession(advancing(), 'turnsExhausted')
    const result = advanceSession(done, stepper)
    expect(result.kind).toBe('terminated')
    expect(result.session).toBe(done)
  })

  it('advanceSession 一致性：步进自述类型必须与返回形态一致', () => {
    // 自述 advanced，却把会话落到 awaiting（伪装待答）→ 抛错
    const disguised: SessionStepper = (s) => ({
      kind: 'advanced',
      session: askQuestion(s, createQuestion()),
    })
    expect(() => advanceSession(advancing(), disguised)).toThrow(SessionError)

    // 自述 question，却没有提问（该问未问）→ 抛错
    const claimed: SessionStepper = (s) => ({ kind: 'question', session: s })
    expect(() => advanceSession(advancing(), claimed)).toThrow(SessionError)
  })

  it('advanceSession 正常两路：推进一步 / 提问停下', () => {
    const advance: SessionStepper = (s) => ({
      kind: 'advanced',
      session: appendLog(s, createAutoEntry()),
    })
    const stepped = advanceSession(advancing(), advance)
    expect(stepped.kind).toBe('advanced')
    expect(stepped.session.log).toHaveLength(1)

    const ask: SessionStepper = (s) => ({
      kind: 'question',
      session: askQuestion(s, createQuestion()),
    })
    const asked = advanceSession(advancing(), ask)
    expect(asked.kind).toBe('question')
    expect(asked.session.status.form).toBe('awaiting')
  })
})

describe('序列化（四种形态皆可存档）', () => {
  it('往返一致：created / advancing / awaiting / terminated', () => {
    const cases: GameSession[] = [
      createSession(),
      advancing(),
      awaiting(),
      terminateSession(advancing(), 'earlyDecision'),
    ]
    for (const session of cases) {
      expect(deserializeSession(serializeSession(session))).toStrictEqual(session)
    }
  })

  it('存档信封带版本号', () => {
    const parsed = JSON.parse(serializeSession(advancing())) as { saveVersion: number }
    expect(parsed.saveVersion).toBe(SESSION_SAVE_VERSION)
  })

  it('版本不匹配即拒（指明字段路径）', () => {
    const text = JSON.stringify({ saveVersion: 99, session: advancing() })
    expect(() => deserializeSession(text)).toThrow(/#\/saveVersion/)
  })

  it('非法 JSON / 结构缺失都带路径报错', () => {
    expect(() => deserializeSession('{ not json')).toThrow(SessionError)

    const missingStatus = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: { meta: createSession().meta, state: createSession().state, log: [] },
    })
    expect(() => deserializeSession(missingStatus)).toThrow(/#\/session\/status/)

    const badResponder = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: {
        ...awaiting(),
        status: { form: 'awaiting', question: { ...createQuestion(), responder: 'neutral' } },
      },
    })
    expect(() => deserializeSession(badResponder)).toThrow(
      /#\/session\/status\/question\/responder/,
    )

    const badReason = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: { ...advancing(), status: { form: 'terminated', reason: 'surrender' } },
    })
    expect(() => deserializeSession(badReason)).toThrow(/#\/session\/status\/reason/)

    const badForm = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: { ...advancing(), status: { form: 'paused' } },
    })
    expect(() => deserializeSession(badForm)).toThrow(/#\/session\/status\/form/)
  })

  it('awaiting 缺 question 即拒', () => {
    const text = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: { ...advancing(), status: { form: 'awaiting' } },
    })
    expect(() => deserializeSession(text)).toThrow(/#\/session\/status\/question/)
  })
})

/**
 * 自查修复项：题面完整性、选项一致性、存档日志与选项的完整性校验。
 * 这些缺陷的共同后果是「损坏存档能把引擎带崩在数组方法上」或「脏数据静默入日志」。
 */
describe('输入校验与存档完整性（自查修复）', () => {
  it('askQuestion 拒绝不完整题面（空 id / rule / prompt）', () => {
    expect(() => askQuestion(advancing(), createQuestion({ id: '' }))).toThrow(SessionError)
    expect(() => askQuestion(advancing(), createQuestion({ rule: '' }))).toThrow(SessionError)
    expect(() => askQuestion(advancing(), createQuestion({ prompt: '' }))).toThrow(SessionError)
  })

  it('askQuestion 拒绝畸形 options（非数组 / 选项缺 id）', () => {
    expect(() =>
      askQuestion(
        advancing(),
        createQuestion({ options: 'retreat' as unknown as QuestionOption[] }),
      ),
    ).toThrow(SessionError)

    expect(() =>
      askQuestion(advancing(), createQuestion({ options: [{ id: '', label: '撤退' }] })),
    ).toThrow(SessionError)
  })

  it('answerQuestion 拒绝无选项问题携带 optionId（防脏数据入日志）', () => {
    const session = askQuestion(advancing(), createQuestion({ id: 'q-2', options: undefined }))
    expect(() =>
      answerQuestion(session, { questionId: 'q-2', side: 'soviet', optionId: 'retreat' }),
    ).toThrow(SessionError)
  })

  it('读档：awaiting 的 options 损坏即拒（不再崩在数组方法上）', () => {
    const text = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: {
        ...awaiting(),
        status: { form: 'awaiting', question: { ...createQuestion(), options: 'retreat' } },
      },
    })
    expect(() => deserializeSession(text)).toThrow(/#\/session\/status\/question\/options/)
  })

  it('读档：日志条目缺 outcome / 阶段非法即拒', () => {
    const missingOutcome = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: {
        ...advancing(),
        log: [{ turn: 1, phase: 'movement', side: 'axis', action: 'refit', rolls: [] }],
      },
    })
    expect(() => deserializeSession(missingOutcome)).toThrow(/#\/session\/log\/0\/outcome/)

    const badPhase = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: { ...advancing(), log: [{ ...createAutoEntry(), phase: 'brunch' }] },
    })
    expect(() => deserializeSession(badPhase)).toThrow(/#\/session\/log\/0\/phase/)
  })

  it('读档：失败结果缺 reason 即拒；成功结果缺 pending 即拒', () => {
    const badFailure = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: {
        ...advancing(),
        log: [{ ...createAutoEntry(), outcome: { ok: false, rule: '1.5' } }],
      },
    })
    expect(() => deserializeSession(badFailure)).toThrow(/#\/session\/log\/0\/outcome\/reason/)

    const badSuccess = JSON.stringify({
      saveVersion: SESSION_SAVE_VERSION,
      session: {
        ...advancing(),
        log: [{ ...createAutoEntry(), outcome: { ok: true, rule: '1.5', data: {} } }],
      },
    })
    expect(() => deserializeSession(badSuccess)).toThrow(/#\/session\/log\/0\/outcome\/pending/)
  })
})
