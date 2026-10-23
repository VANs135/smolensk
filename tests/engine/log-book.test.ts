import { describe, expect, it } from 'vitest'

import { fail, succeed } from '@/engine/result-types'
import { DERIVATION_KEY, formatDerivation } from '@/engine/derivation'
import { combatDerivation, flakDerivation } from '@/engine/derivation-builders'
import { buildLogBook, queryLogBook, replaySessionLog, toLogBookEntry } from '@/engine/log-book'
import { createRngState, roll2d6, rollDice } from '@/engine/rng'
import { resolveCombat } from '@/engine/rules/combat'
import type {
  DiceRoll,
  GamePhase,
  GameSession,
  Records,
  SessionLogEntry,
} from '@/engine/state-types'
import type { Side } from '@/data'

/**
 * 结算日志数据层（W7 D2）
 *
 * 逐项核对四件事：结构化 / 可检索 / 可展开 / 与规则编号对齐，外加**固定种子重放复算**。
 * 日志里的掷骰一律用**真实 rng 产出**（种子固定），这样重放复算才有意义。
 */

const SEED = 19410708

/* ── 夹具：真实掷骰 + 真实结果形状（不做任何伪造的骰面） ── */

interface LogInput {
  turn: number
  phase: GamePhase
  side: Side
  action: string
  rule: string
  rolls?: DiceRoll[]
  data?: Record<string, unknown>
}

/** 造一条**成功**日志（与引擎写入方同形：turn/phase/side/action/rolls/outcome） */
function okEntry(input: LogInput): SessionLogEntry {
  return {
    turn: input.turn,
    phase: input.phase,
    side: input.side,
    action: input.action,
    rolls: input.rolls ?? [],
    outcome: succeed(input.rule, input.data ?? {}),
  }
}

/** 造一条**失败**日志（带原因码） */
function failedEntry(input: LogInput & { reason: string }): SessionLogEntry {
  return {
    turn: input.turn,
    phase: input.phase,
    side: input.side,
    action: input.action,
    rolls: input.rolls ?? [],
    outcome: fail(input.rule, input.reason),
  }
}

function createRecords(): Records {
  return {
    turn: 2,
    phase: 'movement',
    preTurnSegment: null,
    activeSide: 'axis',
    firstPlayer: 'axis',
    weather: { air: 'limited', ground: 'good' },
    railCapacity: { axis: 1, soviet: 2 },
    markerTracks: {},
    victoryLocations: [],
    counters: {
      reserveMarkers: { axis: 14, soviet: 0 },
      supplyCache: { axis: 2, soviet: 2 },
      constructionMarkers: 3,
    },
  }
}

/** 固定种子的一局：天气 1 骰 + 战斗 2 骰（共 3 颗），另有两条无掷骰日志与一条失败日志 */
function createSession(): GameSession {
  let rng = createRngState(SEED)
  const weather = rollDice(rng, 1)
  rng = weather.rng
  const combat = roll2d6(rng)
  rng = combat.rng

  return {
    meta: {
      sessionId: 'session-d2',
      createdAt: '1941-07-08T00:00:00.000Z',
      updatedAt: '1941-07-12T09:00:00.000Z',
      schemaVersion: 1,
    },
    state: {
      scenarioId: '1',
      records: createRecords(),
      units: [],
      stacks: [],
      markers: [],
      rng,
    },
    log: [
      okEntry({
        turn: 2,
        phase: 'preTurn',
        side: 'axis',
        action: 'weather',
        rule: '1.5',
        rolls: [weather.value],
        data: { air: 'limited', ground: 'good', rolled: true },
      }),
      okEntry({
        turn: 2,
        phase: 'movement',
        side: 'axis',
        action: 'move',
        rule: '6.1',
        data: { unitId: 'de-pz-3-krd', from: '36.13', to: '37.13', mpSpent: 2 },
      }),
      okEntry({
        turn: 2,
        phase: 'combat',
        side: 'axis',
        action: 'combat',
        rule: '9.9',
        rolls: [combat.value],
        data: { odds: '3:1', terrain: 'Open', crtRow: 12 },
      }),
      failedEntry({
        turn: 2,
        phase: 'supply',
        side: 'soviet',
        action: 'supplyTrace',
        rule: '12.6',
        reason: 'noTraceSupply',
      }),
    ],
    status: { form: 'advancing' },
  }
}

describe('W7 D2：结构化（一条日志 → 一条记录）', () => {
  it('D2：字段齐备（下标 / 回合 / 阶段 / 阵营 / 动作 / 规则号 / 成败 / 掷骰 / 明细 / 摘要）', () => {
    const session = createSession()
    const entry = toLogBookEntry(session.log[2]!, 2)
    expect(entry).toMatchObject({
      index: 2,
      turn: 2,
      phase: 'combat',
      side: 'axis',
      action: 'combat',
      rule: '9.9',
      ok: true,
      reason: null,
      diceCount: 2,
    })
    expect(entry.rolls[0]).toMatchObject({ count: 2 })
    expect(entry.rolls[0]?.faces).toHaveLength(2)
    // 明细行把 outcome.data 摊平（键值对）
    expect(entry.details.map((row) => row.label)).toEqual(['odds', 'terrain', 'crtRow'])
    expect(entry.details.find((row) => row.label === 'odds')?.value).toBe('3:1')
  })

  it('D2：失败日志带原因码，明细行给出「原因码」', () => {
    const entry = toLogBookEntry(createSession().log[3]!, 3)
    expect(entry).toMatchObject({ ok: false, reason: 'noTraceSupply', diceCount: 0 })
    expect(entry.details).toEqual([{ label: '原因码', value: 'noTraceSupply' }])
  })

  it('D2：待处理项（9.10 选项等）单独成行', () => {
    const withPending: SessionLogEntry = {
      turn: 2,
      phase: 'combat',
      side: 'axis',
      action: 'combat',
      rolls: [],
      outcome: succeed('9.10', { result: 'AL1' }, [
        { kind: 'option', unitIds: ['u1', 'u2'], rule: '9.10', note: '撤退或损失' },
      ]),
    }
    const entry = toLogBookEntry(withPending, 0)
    expect(entry.pending).toHaveLength(1)
    expect(entry.details.some((row) => row.label.startsWith('待处理（option）'))).toBe(true)
    expect(entry.details.find((row) => row.label.startsWith('待处理'))?.value).toContain(
      '单位 2 个',
    )
  })

  it('D2：摘要含动作 / 规则号 / 掷骰 / 明细值（供关键词检索）', () => {
    const entry = toLogBookEntry(createSession().log[0]!, 0)
    expect(entry.summary).toContain('weather')
    expect(entry.summary).toContain('规则 1.5')
    expect(entry.summary).toContain('掷骰')
    expect(entry.summary).toContain('air=limited')
  })
})

describe('W7 D2：与规则编号对齐 + 索引与统计', () => {
  it('D2：规则号索引列出「本局哪些规则动过、各多少次、第几条」', () => {
    const book = buildLogBook(createSession().log)
    expect(book.rules.map((entry) => `${entry.rule}×${entry.count}`)).toEqual([
      '1.5×1',
      '12.6×1',
      '6.1×1',
      '9.9×1',
    ])
    const combat = book.rules.find((entry) => entry.rule === '9.9')
    expect(combat).toMatchObject({ count: 1, firstIndex: 2 })
    expect(combat?.indexes).toEqual([2])
  })

  it('D2：动作 / 回合索引与统计（成败、骰数、按阵营与阶段）', () => {
    const book = buildLogBook(createSession().log)
    expect(book.actions).toEqual(['combat', 'move', 'supplyTrace', 'weather'])
    expect(book.turns).toEqual([2])
    expect(book.stats).toMatchObject({
      total: 4,
      ok: 3,
      failed: 1,
      diceCount: 3, // 天气 1 颗 + 战斗 2 颗
      bySide: { axis: 3, soviet: 1 },
    })
    expect(book.stats.byPhase).toContainEqual({ phase: 'combat', count: 1 })
  })

  it('D2：空日志 ⇒ 空手册（不报错、不臆造）', () => {
    const book = buildLogBook([])
    expect(book.entries).toEqual([])
    expect(book.rules).toEqual([])
    expect(book.stats).toMatchObject({ total: 0, ok: 0, failed: 0, diceCount: 0 })
  })
})

describe('W7 D2：可检索', () => {
  const book = buildLogBook(createSession().log)

  it('D2：按规则号检索（与规则编号对齐的入口）', () => {
    expect(queryLogBook(book, { rule: '9.9' }).map((entry) => entry.index)).toEqual([2])
    expect(queryLogBook(book, { rule: '不存在' })).toEqual([])
  })

  it('D2：按回合 / 阶段 / 阵营 / 动作检索', () => {
    expect(queryLogBook(book, { turn: 2 })).toHaveLength(4)
    expect(queryLogBook(book, { turn: 3 })).toHaveLength(0)
    expect(queryLogBook(book, { phase: 'combat' }).map((entry) => entry.rule)).toEqual(['9.9'])
    expect(queryLogBook(book, { side: 'soviet' }).map((entry) => entry.index)).toEqual([3])
    expect(queryLogBook(book, { action: 'weather' }).map((entry) => entry.index)).toEqual([0])
  })

  it('D2：关键词检索命中明细值（不区分大小写）', () => {
    expect(queryLogBook(book, { text: 'limited' }).map((entry) => entry.index)).toEqual([0])
    expect(queryLogBook(book, { text: 'LIMITED' }).map((entry) => entry.index)).toEqual([0])
    expect(queryLogBook(book, { text: 'de-pz-3-krd' }).map((entry) => entry.index)).toEqual([1])
  })

  it('D2：只看失败 / 多条件「与」', () => {
    expect(queryLogBook(book, { onlyFailed: true }).map((entry) => entry.index)).toEqual([3])
    expect(
      queryLogBook(book, { side: 'axis', phase: 'combat' }).map((entry) => entry.index),
    ).toEqual([2])
    expect(queryLogBook(book, { side: 'soviet', phase: 'combat' })).toEqual([])
    // 空条件 ⇒ 全部
    expect(queryLogBook(book)).toHaveLength(4)
  })
})

describe('W7 D2：固定种子重放复算', () => {
  it('D2：重放通过 —— 逐条骰面吻合、终点与存档一致，并给出每条日志的游标', () => {
    const session = createSession()
    const report = replaySessionLog(session)
    expect(report.ok).toBe(true)
    expect(report.seed).toBe(SEED)
    expect(report.logEntries).toBe(4)
    expect(report.diceCount).toBe(3)
    expect(report.rngSelfConsistent).toBe(true)
    expect(report.stateMatches).toBe(true)
    expect(report.firstDivergence).toBeNull()
    expect(report.detail).toContain('重放复算通过')
    expect(report.cursors).toEqual([
      { index: 0, drawCountBefore: 0, drawCountAfter: 1 },
      { index: 1, drawCountBefore: 1, drawCountAfter: 1 },
      { index: 2, drawCountBefore: 1, drawCountAfter: 3 },
      { index: 3, drawCountBefore: 3, drawCountAfter: 3 },
    ])
  })

  it('D2：篡改某一颗骰面 ⇒ 报出首个分歧（定位到条号 / 动作 / 规则 / 游标）', () => {
    const session = createSession()
    const tampered: GameSession = {
      ...session,
      log: session.log.map((entry, index) =>
        index === 2 ? { ...entry, rolls: [{ count: 2, faces: [1, 1], total: 2 }] } : entry,
      ),
    }
    const report = replaySessionLog(tampered)
    expect(report.ok).toBe(false)
    expect(report.firstDivergence).toMatchObject({
      index: 2,
      turn: 2,
      action: 'combat',
      rule: '9.9',
      drawCountBefore: 1,
    })
    expect(report.firstDivergence?.expected.faces).toEqual([1, 1])
    expect(report.firstDivergence?.actual.faces).toHaveLength(2)
    expect(report.detail).toContain('首个分歧在第 3 条')
  })

  it('D2：漏记一次掷骰 ⇒ 后续序列整体错位，同样报出首个分歧', () => {
    const session = createSession()
    const missing: GameSession = {
      ...session,
      // 把天气那条的掷骰抹掉（模拟「掷了但没记」）
      log: [{ ...session.log[0]!, rolls: [] }, ...session.log.slice(1)],
      // 存档游标仍是 3（与日志不再匹配）
    }
    const report = replaySessionLog(missing)
    expect(report.ok).toBe(false)
    expect(report.firstDivergence?.index).toBe(2)
    expect(report.stateMatches).toBe(false)
  })

  it('D2：存档种子—游标—内部状态不自洽 ⇒ 报 verifyRngState 失败', () => {
    const session = createSession()
    const bad: GameSession = {
      ...session,
      state: {
        ...session.state,
        rng: { ...session.state.rng, state: session.state.rng.state + 7 },
      },
    }
    const report = replaySessionLog(bad)
    expect(report.ok).toBe(false)
    expect(report.rngSelfConsistent).toBe(false)
    expect(report.detail).toContain('不自洽')
  })

  it('D2：骰面与颗数自相矛盾的日志 ⇒ 记为分歧而非抛错（读档被手改也不崩）', () => {
    const session = createSession()
    const corrupt: GameSession = {
      ...session,
      log: session.log.map((entry, index) =>
        index === 0 ? { ...entry, rolls: [{ count: 3, faces: [4], total: 4 }] } : entry,
      ),
    }
    const report = replaySessionLog(corrupt)
    expect(report.ok).toBe(false)
    expect(report.firstDivergence?.index).toBe(0)
  })
})

/* ────────────────────────────── C11：结算复核过程 ────────────────────────────── */

describe('W7 C11：日志里的结算复核过程（骰点 / 计算过程 / 规则号 / 修正来源）', () => {
  /** 一条带复核过程的战斗日志（复核过程由引擎结论构造，非手工编造） */
  function combatEntry(): SessionLogEntry {
    const roll = roll2d6(createRngState(19410710)).value
    const result = resolveCombat({
      die: roll.total,
      attackerAR: 5,
      defenderAR: 2,
      hedgehogLevel: 1,
      terrainLine: 'Open',
      attackerA: 10,
      defenderA: 10,
    })
    const derivation = combatDerivation({
      roll,
      die: roll.total,
      attackerAr: 5,
      attackerArSource: '攻方 AR 单位 u-atk',
      defenderAr: 2,
      defenderArSource: '守方 AR 单位 u-def',
      hedgehogLevel: 1,
      modifiedDice: result.modifiedDice,
      raw: result.raw,
      terrainLine: result.terrainLine,
      columnLabel: result.ratio,
      oddsLabel: result.ratio,
      terrain: 'Open',
    })
    return {
      turn: 2,
      phase: 'combat',
      side: 'axis',
      action: 'combat',
      rolls: [roll],
      outcome: succeed('9.9', { odds: result.ratio, [DERIVATION_KEY]: derivation }),
    }
  }

  it('C11：日志条目带上复核过程与一行算式（不再当普通明细 JSON 摊平）', () => {
    const entry = toLogBookEntry(combatEntry(), 0)
    expect(entry.derivation).not.toBeNull()
    expect(entry.derivation?.title).toBe('战斗结算（9.9）')
    expect(entry.derivation?.rule).toBe('9.9')
    // 修正项都写出值与来源
    const modifiers = entry.derivation?.steps.filter((step) => step.kind === 'modifier') ?? []
    expect(modifiers.map((step) => (step.kind === 'modifier' ? step.source : ''))).toEqual([
      '攻方 AR 单位 u-atk',
      '守方 AR 单位 u-def',
      expect.stringContaining('环形工事'),
    ])
    // 复核过程不重复出现在明细行里，普通明细照常摊平
    expect(entry.details.map((row) => row.label)).toEqual(['odds'])
    expect(entry.formula).toBe(formatDerivation(entry.derivation!))
    expect(entry.formula).toContain('战斗结算（9.9）')
  })

  it('C11：复核过程进摘要 ⇒ 关键词能命中计算过程与结果码', () => {
    const entry = toLogBookEntry(combatEntry(), 0)
    const book = buildLogBook([combatEntry()])
    expect(entry.summary).toContain('修正后骰值')
    expect(entry.summary).toContain('CRT9.9')
    // 结果码来自引擎（`CombatResult.raw`），一定能在摘要里搜到
    const raw = entry.derivation?.steps.find((step) => step.kind === 'result')
    expect(raw?.kind === 'result' && raw.value).toBeTruthy()
    expect(queryLogBook(book, { text: (raw as { value: string }).value })).toHaveLength(1)
  })

  it('C11：形状不认识的复核过程 ⇒ derivation 为 null，且按普通明细摊平（不藏数据）', () => {
    const broken: SessionLogEntry = {
      turn: 2,
      phase: 'combat',
      side: 'axis',
      action: 'flak',
      rolls: [],
      outcome: succeed('14.4e', { [DERIVATION_KEY]: { title: '残缺' } }),
    }
    const entry = toLogBookEntry(broken, 0)
    expect(entry.derivation).toBeNull()
    expect(entry.formula).toBeNull()
    expect(entry.details.map((row) => row.label)).toEqual([DERIVATION_KEY])
  })

  it('C11：防空复核的 DRM 与 computeFlakDrm 在日志层同样对得上', () => {
    const derivation = flakDerivation({
      missionAircraftCount: 3,
      targetHasHQ: true,
      inEnemyPatrolZone: false,
    })
    const entry = toLogBookEntry(
      {
        turn: 3,
        phase: 'combat',
        side: 'soviet',
        action: 'flak',
        rolls: [],
        outcome: succeed('14.4e', { [DERIVATION_KEY]: derivation }),
      },
      0,
    )
    expect(entry.derivation?.rule).toBe('14.4e')
    const subtotal = entry.derivation?.steps.find((step) => step.kind === 'subtotal')
    expect(subtotal?.kind === 'subtotal' && subtotal.value).toBe(2)
  })
})
