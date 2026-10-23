import { describe, expect, it } from 'vitest'

import { DATA_VERSION, scenarios } from '@/data'
import { createRngState, replayFrom, roll2d6, verifyRngState } from '@/engine/rng'
import {
  SAVE_ERROR_KINDS,
  SAVE_FILE_VERSION,
  SaveFileError,
  classifySaveError,
  describeSaveFile,
  deserializeSaveFile,
  serializeSaveFile,
} from '@/engine/save-file'
import {
  answerQuestion,
  askQuestion,
  serializeSession,
  SESSION_SAVE_VERSION,
} from '@/engine/session'
import { agreedOptionQuestion } from '@/engine/session-flow'
import type { GameSession, Marker, Records, Stack, Unit } from '@/engine/state-types'

/**
 * 存档序列化（W6 D1）
 *
 * 逐项核对用户要求的六件事都能「存得下、读得回、版本不符即拒」：
 *   状态 / 种子 / 日志游标 / 进行中会话（含待答）/ 共识开关 / 剧本与数据版本。
 */

const SAVED_AT = '1941-07-12T09:30:00.000Z'

/* ── 夹具（数值取自已核实数据：专规 1.2 铁路容量、剧本初设；与 state-types 测试同源） ── */

/** 图上的地面单位（含模式/补给等运行状态） */
function createOnMapUnit(): Unit {
  return {
    id: 'de-pz-3-krd',
    recordId: 'de-pz-3-krd',
    kind: 'ground',
    side: 'axis',
    hex: { col: 36, row: 13 },
    container: null,
    face: 'combat',
    mode: 'combat',
    steps: 2,
    re: 2,
    dg: false,
    outOfSupply: false,
    internalStocks: null,
    fuel: false,
    exploit: false,
    airStatus: null,
  }
}

/** 死亡堆里的单位（不在图上，位置由容器表达） */
function createDeadPileUnit(): Unit {
  return {
    ...createOnMapUnit(),
    id: 'ru-tk-57',
    recordId: 'ru-tk-57',
    side: 'soviet',
    hex: null,
    container: { kind: 'deadPile' },
    steps: 0,
  }
}

function createStack(): Stack {
  return { hex: { col: 36, row: 13 }, unitIds: ['de-pz-3-krd'], hedgehogLevel: 1 }
}

function createMarker(): Marker {
  return {
    id: 'mk-exploit-1',
    recordId: 'exploit',
    side: 'both',
    hex: { col: 36, row: 13 },
    track: null,
  }
}

function createRecords(): Records {
  return {
    turn: 4,
    phase: 'movement',
    preTurnSegment: null,
    activeSide: 'axis',
    firstPlayer: 'axis',
    weather: { air: 'normal', ground: 'good' },
    railCapacity: { axis: 1, soviet: 2 },
    markerTracks: { 'mk-rail-cap': 3 },
    victoryLocations: [{ hex: { col: 36, row: 13 }, controlledBy: 'axis', listed: true }],
    counters: {
      reserveMarkers: { axis: 14, soviet: 0 },
      supplyCache: { axis: 2, soviet: 2 },
      constructionMarkers: 3,
    },
  }
}

/** 会话夹具：非空盘面（单位/堆叠/标记）+ 非零游标 + 已掷过骰 */
function createSession(overrides: Partial<GameSession> = {}): GameSession {
  const seed = 19410708
  // 先掷两颗 2d6，让 rng 的内部状态与 drawCount 都偏离初值（这样「往返后能续掷」才有意义）
  const first = roll2d6(createRngState(seed))
  const second = roll2d6(first.rng)
  return {
    meta: {
      sessionId: 'session-d1',
      createdAt: '1941-07-08T00:00:00.000Z',
      updatedAt: '1941-07-12T09:00:00.000Z',
      schemaVersion: 1,
    },
    state: {
      scenarioId: '1',
      records: createRecords(),
      units: [createOnMapUnit(), createDeadPileUnit()],
      stacks: [createStack()],
      markers: [createMarker()],
      rng: second.rng,
    },
    log: [
      {
        turn: 4,
        phase: 'movement',
        side: 'axis',
        action: 'weather',
        rolls: [first.value, second.value],
        outcome: { ok: true, rule: '1.5', data: { air: 'normal' }, pending: [] },
      },
    ],
    status: { form: 'advancing' },
    ...overrides,
  }
}

/** 待答中的会话（进行中会话：形态 awaiting + 带选项的问题） */
function createAwaitingSession(): GameSession {
  return askQuestion(createSession(), {
    id: 'initiative',
    responder: 'soviet',
    kind: 'initiative',
    rule: '2.3',
    prompt: '苏联方先手判定胜出：选择本回合先手或后手',
    options: [
      { id: 'first', label: '先手（本方先行动）' },
      { id: 'second', label: '后手（对手先行动）' },
    ],
    payload: { chooser: 'soviet' },
  })
}

describe('W6 D1：存档内容（六项齐备）', () => {
  it('D1：文件头带存档版本 / 数据契约版本 / 剧本号 / 写盘时间戳', () => {
    const session = createSession()
    const text = serializeSaveFile(session, SAVED_AT)
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(parsed['saveVersion']).toBe(SAVE_FILE_VERSION)
    expect(parsed['dataVersion']).toBe(DATA_VERSION)
    expect(parsed['scenarioId']).toBe('1')
    expect(parsed['savedAt']).toBe(SAVED_AT)
  })

  it('D1：状态（记录轨 / 单位 / 堆叠 / 标记）逐字段往返一致', () => {
    const session = createSession()
    const restored = deserializeSaveFile(serializeSaveFile(session, SAVED_AT)).session
    expect(restored.state.records).toStrictEqual(createRecords())
    expect(restored.state.units).toStrictEqual(session.state.units)
    expect(restored.state.stacks).toStrictEqual(session.state.stacks)
    expect(restored.state.markers).toStrictEqual(session.state.markers)
    expect(restored.state.scenarioId).toBe('1')
  })

  it('D1：种子与日志游标往返一致，且**续掷的第一颗骰与原局相同**（可复算）', () => {
    const session = createSession()
    const restored = deserializeSaveFile(serializeSaveFile(session, SAVED_AT)).session
    expect(restored.state.rng).toStrictEqual(session.state.rng)

    const original = roll2d6(session.state.rng)
    const resumed = roll2d6(restored.state.rng)
    expect(resumed.value).toStrictEqual(original.value)
    expect(resumed.rng).toStrictEqual(original.rng)
  })

  it('D1：日志（整局审计）完整往返，条数与掷骰一并保留', () => {
    const session = createSession()
    const restored = deserializeSaveFile(serializeSaveFile(session, SAVED_AT)).session
    expect(restored.log).toStrictEqual(session.log)
    expect(restored.meta).toStrictEqual(session.meta)
  })

  it('D1：进行中会话（awaiting）连待答问题一起存读，读回后仍停下等作答', () => {
    const session = createAwaitingSession()
    const restored = deserializeSaveFile(serializeSaveFile(session, SAVED_AT)).session
    expect(restored.status).toStrictEqual(session.status)
    if (restored.status.form !== 'awaiting') throw new Error('应仍为待答形态')
    expect(restored.status.question).toMatchObject({
      id: 'initiative',
      kind: 'initiative',
      rule: '2.3',
      responder: 'soviet',
    })
    expect(restored.status.question.options?.map((option) => option.id)).toEqual([
      'first',
      'second',
    ])
    expect(restored.status.question.payload).toEqual({ chooser: 'soviet' })
    // 读回后作答仍然走得通（题号/应答方/选项都在）
    const answered = answerQuestion(restored, {
      questionId: 'initiative',
      side: 'soviet',
      optionId: 'second',
    })
    expect(answered.status.form).toBe('advancing')
  })

  it('D1：共识开关（scenarios.agreedOptions）结论随档保留，可从日志读出', () => {
    const items = scenarios.agreedOptions.items
    const first = items[0] ?? ''
    // 走真实路径作答：会话提问 → 作答入日志
    const asked = askQuestion(createSession(), agreedOptionQuestion(0, first, 'axis'))
    const answered = answerQuestion(asked, {
      questionId: 'agreedOption:0',
      side: 'axis',
      optionId: 'adopt',
    })
    const info = describeSaveFile(serializeSaveFile(answered, SAVED_AT))
    expect(info.consensus[0]).toEqual({ item: first, adopted: true })
    // 其余条目未作答
    expect(info.consensus.slice(1).every((entry) => entry.adopted === null)).toBe(true)
  })
})

describe('W6 D1：存档摘要（读档校验通过后给出）', () => {
  it('D1：摘要含剧本名 / 形态 / 回合阶段 / 种子与游标 / 日志条数 / 待答', () => {
    const info = describeSaveFile(serializeSaveFile(createAwaitingSession(), SAVED_AT))
    const scenario = scenarios.scenarios.find((item) => item.id === '1')
    expect(info).toMatchObject({
      saveVersion: SAVE_FILE_VERSION,
      dataVersion: DATA_VERSION,
      scenarioId: '1',
      scenarioName: scenario?.name,
      savedAt: SAVED_AT,
      form: 'awaiting',
      termination: null,
      turn: 4,
      phase: 'movement',
      logEntries: 1,
    })
    expect(info.awaiting).toMatchObject({
      questionId: 'initiative',
      kind: 'initiative',
      responder: 'soviet',
    })
    // 掷骰游标按**骰子颗数**计：夹具掷了两次 2d6 ⇒ drawCount = 4
    expect(info.drawCount).toBe(4)
    expect(info.seed).toBe(19410708)
    expect(info.rngState).toBe(createSession().state.rng.state)
  })

  it('D1：终止形态的摘要给出终止原因', () => {
    const terminated = createSession({ status: { form: 'terminated', reason: 'turnsExhausted' } })
    expect(describeSaveFile(serializeSaveFile(terminated, SAVED_AT)).termination).toBe(
      'turnsExhausted',
    )
  })
})

describe('W6 D1：读档逐层校验（不符即拒，不做静默迁移）', () => {
  const good = (): Record<string, unknown> =>
    JSON.parse(serializeSaveFile(createSession(), SAVED_AT)) as Record<string, unknown>

  it('D1：存档文件版本不符 ⇒ 拒（路径 #/saveVersion）', () => {
    const file = { ...good(), saveVersion: SAVE_FILE_VERSION + 1 }
    expect(() => deserializeSaveFile(JSON.stringify(file))).toThrow(/#\/saveVersion/)
  })

  it('D1：数据契约版本不符 ⇒ 拒（路径 #/dataVersion）', () => {
    const file = { ...good(), dataVersion: '0.0.1' }
    expect(() => deserializeSaveFile(JSON.stringify(file))).toThrow(/#\/dataVersion/)
  })

  it('D1：剧本不存在于剧本库 ⇒ 拒（路径 #/scenarioId）', () => {
    const file = { ...good(), scenarioId: '99' }
    expect(() => deserializeSaveFile(JSON.stringify(file))).toThrow(/#\/scenarioId/)
  })

  it('D1：文件头剧本与会话状态剧本不一致 ⇒ 拒（路径 #/session/state/scenarioId）', () => {
    const base = createSession()
    const mismatched: GameSession = {
      ...base,
      state: { ...base.state, scenarioId: '3', records: { ...base.state.records } },
    }
    const file = {
      ...good(),
      scenarioId: '1',
      // 会话内部写剧本 3，外壳写 1
      session: JSON.parse(serializeSession(mismatched)).session,
    }
    expect(() => deserializeSaveFile(JSON.stringify(file))).toThrow(/#\/session\/state\/scenarioId/)
  })

  it('D1：可显式指定期望数据版本（用于读旧档的拒绝理由）', () => {
    const text = serializeSaveFile(createSession(), SAVED_AT)
    expect(() => deserializeSaveFile(text, { expectedDataVersion: '9.9.9' })).toThrow(
      /#\/dataVersion/,
    )
    expect(() => deserializeSaveFile(text, { knownScenarioIds: ['3', '5'] })).toThrow(
      /#\/scenarioId/,
    )
  })

  it('D1：非法 JSON / 缺字段 / 会话容器版本不符 ⇒ 带路径报错', () => {
    expect(() => deserializeSaveFile('{ not json')).toThrow(SaveFileError)

    const noSavedAt = good()
    delete noSavedAt['savedAt']
    expect(() => deserializeSaveFile(JSON.stringify(noSavedAt))).toThrow(/#\/savedAt/)

    const noDataVersion = good()
    delete noDataVersion['dataVersion']
    expect(() => deserializeSaveFile(JSON.stringify(noDataVersion))).toThrow(/#\/dataVersion/)

    // 会话容器版本（内层）不符 ⇒ 路径 #/sessionSaveVersion
    const badSessionVersion = { ...good(), sessionSaveVersion: SESSION_SAVE_VERSION + 1 }
    expect(() => deserializeSaveFile(JSON.stringify(badSessionVersion))).toThrow(
      /#\/sessionSaveVersion/,
    )

    // 会话骨架损坏（meta 缺失）⇒ 由会话层校验报在 #/session
    const badSession = good()
    badSession['session'] = { ...(badSession['session'] as object), meta: undefined }
    expect(() => deserializeSaveFile(JSON.stringify(badSession))).toThrow(/#\/session/)
  })

  it('D1：掷骰算法标识不符 ⇒ 拒（换算法后旧档不可复算）', () => {
    const file = { ...good(), rngAlgorithm: 'mulberry32-v0' }
    expect(() => deserializeSaveFile(JSON.stringify(file))).toThrow(/#\/rngAlgorithm/)
  })

  it('D1：种子—游标—内部状态不自洽 ⇒ 拒（存档不可复算）', () => {
    const base = createSession()
    const tampered: GameSession = {
      ...base,
      state: { ...base.state, rng: { ...base.state.rng, state: base.state.rng.state + 1 } },
    }
    const file = { ...good(), session: JSON.parse(serializeSession(tampered)).session }
    expect(() => deserializeSaveFile(JSON.stringify(file))).toThrow(/#\/session\/state\/rng/)
  })

  it('D1：只留种子也能复算（replayFrom 重推游标，读档完整性检查通过）', () => {
    const session = createSession()
    const replayed = replayFrom(session.state.rng.seed, session.state.rng.drawCount)
    expect(replayed).toStrictEqual(session.state.rng)
    expect(verifyRngState(session.state.rng)).toBe(true)
  })
})

describe('W7 C15：存档错误的归类（界面照它说话，不自己解析字符串）', () => {
  it('C15：无档 / 无介质 / 无会话三个原因码各归其类，并给出可操作建议', () => {
    expect(classifySaveError('emptySlot')).toMatchObject({ kind: 'emptySlot', layer: null })
    expect(classifySaveError('emptySlot').hint).toContain('保存')
    expect(classifySaveError('storageUnavailable')).toMatchObject({ kind: 'storageUnavailable' })
    expect(classifySaveError('noSessionToSave')).toMatchObject({ kind: 'noSessionToSave' })
    expect(classifySaveError('storageWriteFailed:QuotaExceededError')).toMatchObject({
      kind: 'other',
    })
  })

  it('C15：**版本不匹配**逐层可辨（存档格式 / 数据契约 / 会话容器 / 掷骰算法），并解出期望与实际', () => {
    const cases: {
      reason: string
      layer: string
      expected: string | null
      actual: string | null
    }[] = [
      {
        reason:
          '[save-file] #/saveVersion: 存档文件版本不匹配：期望 1，实际 99（本作不做静默迁移）',
        layer: '存档文件格式',
        expected: '1',
        actual: '99',
      },
      {
        reason:
          '[save-file] #/dataVersion: 数据契约版本不匹配：期望 0.4.0，实际 0.0.1（数据文件契约已变更，旧档不可直读）',
        layer: '数据契约',
        expected: '0.4.0',
        actual: '0.0.1',
      },
      {
        reason: '[save-file] #/sessionSaveVersion: 会话容器版本不匹配：期望 1，实际 2',
        layer: '会话容器',
        expected: '1',
        actual: '2',
      },
      {
        // 掷骰算法用的是另一句文案（「算法不一致」），故解不出「期望 / 实际」
        reason:
          '[save-file] #/rngAlgorithm: 掷骰算法不一致：存档 mulberry32-v0，当前 mulberry32（换算法后旧档不可复算）',
        layer: '掷骰算法',
        expected: null,
        actual: null,
      },
    ]
    for (const item of cases) {
      const info = classifySaveError(item.reason)
      expect(info.kind).toBe('versionMismatch')
      expect(info.layer).toBe(item.layer)
      expect(info.detail).toContain(item.layer)
      expect(info.hint.length).toBeGreaterThan(0)
    }
    // 能解析出「期望 / 实际」的两例
    expect(classifySaveError(cases[0]!.reason)).toMatchObject({ expected: '1', actual: '99' })
    expect(classifySaveError(cases[1]!.reason)).toMatchObject({
      expected: '0.4.0',
      actual: '0.0.1',
    })
  })

  it('C15：内容类拒读各归其类（非法 JSON / 剧本不在库 / 内外不一致 / 不可复算 / 结构损坏）', () => {
    expect(classifySaveError('不是合法 JSON：Unexpected token')).toMatchObject({ kind: 'notJson' })
    expect(classifySaveError('[save-file] #/scenarioId: 剧本不存在于剧本库：99')).toMatchObject({
      kind: 'scenarioUnknown',
    })
    expect(
      classifySaveError(
        '[save-file] #/session/state/scenarioId: 内外剧本不一致：文件头 1，会话状态 2',
      ),
    ).toMatchObject({ kind: 'innerScenarioMismatch' })
    expect(
      classifySaveError(
        '[save-file] #/session/state/rng: 掷骰状态不可复算：seed 1 + drawCount 2 推不出内部状态 3',
      ),
    ).toMatchObject({ kind: 'rngNotReplayable' })
    expect(classifySaveError('[save-file] #: 期望非空字符串，实际 undefined')).toMatchObject({
      kind: 'corrupt',
    })
    expect(classifySaveError('某种未归类的失败')).toMatchObject({ kind: 'other' })
  })

  it('C15：分类结果可直接显示（每条都有说明与建议，不留空）', () => {
    const reasons = [
      'emptySlot',
      'storageUnavailable',
      'noSessionToSave',
      '[save-file] #/dataVersion: 数据契约版本不匹配：期望 0.4.0，实际 0.0.1（数据文件契约已变更，旧档不可直读）',
      '[save-file] #: 期望对象，实际 string',
      'storageReadFailed:SecurityError',
      '未知原因',
    ]
    for (const reason of reasons) {
      const info = classifySaveError(reason)
      expect(info.detail.length).toBeGreaterThan(0)
      expect(info.hint.length).toBeGreaterThan(0)
      expect(SAVE_ERROR_KINDS).toContain(info.kind)
    }
  })
})
