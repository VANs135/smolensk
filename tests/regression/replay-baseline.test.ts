import { describe, expect, it } from 'vitest'

import { replaySessionLog } from '@/engine/log-book'
import {
  advance,
  createRngState,
  nextUint32,
  replayFrom,
  roll2d6,
  RNG_ALGORITHM,
  verifyRngState,
} from '@/engine/rng'
import type { DiceRoll, GameSession, RngState } from '@/engine/state-types'
import {
  appendEntries,
  BASELINE_SEED,
  buildBaselineSession,
  consume1d6,
  consume2d6,
  makeLogEntry,
  makeRollingEntry,
} from './regression-harness'

/**
 * W7 D3 回归基线 · **固定种子重放**
 *
 * 三件事各测一层（CODE_SPEC §3.3 掷骰必须可重放 / §7 追加整局回归）：
 *   ① **PRNG 黄金样本**：固定种子的骰序列与内部状态逐位冻结 —— 算法或种子一变即失败；
 *   ② **游标可重推**：`replayFrom(seed, n)` ≡ 逐步消费 n 次（存档只留 seed+游标也能复算）；
 *   ③ **会话日志复算**：真实流程跑出的会话 `replaySessionLog().ok === true`；
 *      篡改任意一处（骰面 / 内部状态）都必须被**如实报出**，不许静默通过。
 */

/* ────────────────────────────── ① PRNG 黄金样本（固定种子） ────────────────────────────── */

describe('W7 D3：固定种子重放 —— PRNG 黄金样本', () => {
  it('W7 D3：固定种子的 1d6 序列是黄金样本（前 12 颗逐位冻结）', () => {
    const { faces, rng } = consume1d6(BASELINE_SEED, 12)
    expect(faces).toEqual([4, 3, 1, 1, 5, 2, 5, 4, 2, 1, 3, 5])
    // 12 颗 1d6 ⇒ 游标推进 12；内部状态随之冻结
    expect(rng.drawCount).toBe(12)
    expect(rng.seed).toBe(BASELINE_SEED)
  })

  it('W7 D3：接续的 2d6 序列是黄金样本（6 次逐位冻结）', () => {
    // 先吃掉 12 颗 1d6，再掷 6 次 2d6 —— 与上一条用例同一条序列，故首尾相接
    const first = consume1d6(BASELINE_SEED, 12)
    let rng: RngState = first.rng
    const twins: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const draw = roll2d6(rng)
      rng = draw.rng
      twins.push(draw.value.faces.join('+'))
    }
    expect(twins).toEqual(['6+2', '1+6', '4+5', '5+3', '3+3', '2+5'])
    // 12 + 6×2 = 24 颗；游标与内部状态一并冻结（算法改动的第一道警报）
    expect(rng.drawCount).toBe(24)
    expect(rng.state).toBe(1027317260)
  })

  it('W7 D3：nextUint32 前 8 个取值是黄金样本（跨平台可移植性基线）', () => {
    let rng: RngState = createRngState(BASELINE_SEED)
    const values: number[] = []
    for (let index = 0; index < 8; index += 1) {
      const draw = nextUint32(rng)
      rng = draw.rng
      values.push(draw.value)
    }
    expect(values).toEqual([
      1225913439, 3865250042, 1506877428, 2804448702, 3047601790, 3389408545, 3292647736,
      3846768003,
    ])
  })

  it('W7 D3：同种子必同序列；换种子必不同（防止「退化成常量」的假重放）', () => {
    expect(consume1d6(BASELINE_SEED, 20).faces).toEqual(consume1d6(BASELINE_SEED, 20).faces)
    expect(consume2d6(BASELINE_SEED, 10).faces).toEqual(consume2d6(BASELINE_SEED, 10).faces)
    expect(consume1d6(BASELINE_SEED, 20).faces).not.toEqual(consume1d6(BASELINE_SEED + 1, 20).faces)
  })

  it('W7 D3：骰面恒在 1–6，2d6 合计恒等于两骰之和（拒绝采样的取值域）', () => {
    const ones = consume1d6(BASELINE_SEED, 200)
    expect(ones.faces.every((face) => face >= 1 && face <= 6)).toBe(true)
    // 六面都出现过（200 颗足够；若算法退化会立刻暴露）
    expect([...new Set(ones.faces)].sort()).toEqual([1, 2, 3, 4, 5, 6])

    let rng: RngState = createRngState(BASELINE_SEED)
    for (let index = 0; index < 100; index += 1) {
      const draw = roll2d6(rng)
      rng = draw.rng
      expect(draw.value.total).toBe((draw.value.faces[0] ?? 0) + (draw.value.faces[1] ?? 0))
    }
  })
})

/* ────────────────────────────── ② 游标可重推 ────────────────────────────── */

describe('W7 D3：固定种子重放 —— 游标可重推（存档只留 seed + drawCount 也能复算）', () => {
  it('W7 D3：replayFrom(seed, n) ≡ 逐步消费 n 次（1d6 / 推进步）', () => {
    const consumed = consume1d6(BASELINE_SEED, 24).rng
    expect(replayFrom(BASELINE_SEED, 24)).toEqual(consumed)
    // advance 推进 n 步不取值，与「掷 n 颗单骰」等价
    expect(advance(createRngState(BASELINE_SEED), 24)).toEqual(consumed)
  })

  it('W7 D3：replayFrom(seed, 0) 即初始状态；负数 / 非整数游标一律拒绝（不静默归零）', () => {
    expect(replayFrom(BASELINE_SEED, 0)).toEqual(createRngState(BASELINE_SEED))
    expect(() => replayFrom(BASELINE_SEED, -1)).toThrow()
    expect(() => replayFrom(BASELINE_SEED, 1.5)).toThrow()
    expect(() => advance(createRngState(BASELINE_SEED), -1)).toThrow()
  })

  it('W7 D3：verifyRngState 接受自洽状态，拒绝被篡改的状态', () => {
    const good = consume1d6(BASELINE_SEED, 7).rng
    expect(verifyRngState(good)).toBe(true)
    expect(verifyRngState({ ...good, state: good.state + 1 })).toBe(false)
    expect(verifyRngState({ ...good, drawCount: good.drawCount + 1 })).toBe(false)
    expect(verifyRngState({ ...good, seed: BASELINE_SEED + 1 })).toBe(false)
    expect(verifyRngState({ ...good, drawCount: -1 })).toBe(false)
  })
})

/* ────────────────────────────── ③ 会话日志复算（真实流程） ────────────────────────────── */

describe('W7 D3：固定种子重放 —— 真实流程会话的日志复算', () => {
  it('W7 D3：真实流程跑出的会话：重放全程吻合、终点状态一致、无分歧', () => {
    const session = buildBaselineSession()
    const report = replaySessionLog(session)

    expect(report.algorithm).toBe(RNG_ALGORITHM)
    expect(report.seed).toBe(BASELINE_SEED)
    expect(report.logEntries).toBe(session.log.length)
    expect(report.logEntries).toBeGreaterThan(0)
    // 基线里必须真的有骰子，否则「重放通过」是空话
    expect(report.diceCount).toBeGreaterThan(0)
    expect(report.rngSelfConsistent).toBe(true)
    expect(report.stateMatches).toBe(true)
    expect(report.firstDivergence).toBeNull()
    expect(report.ok).toBe(true)
    expect(report.detail).toContain(RNG_ALGORITHM)
    expect(report.detail).toContain(String(BASELINE_SEED))
  })

  it('W7 D3：逐条游标区间单调、首尾相接，且末条终点＝存档游标', () => {
    const session = buildBaselineSession()
    const report = replaySessionLog(session)

    expect(report.cursors).toHaveLength(session.log.length)
    let previous = 0
    for (const cursor of report.cursors) {
      expect(cursor.drawCountBefore).toBe(previous)
      expect(cursor.drawCountAfter).toBeGreaterThanOrEqual(cursor.drawCountBefore)
      previous = cursor.drawCountAfter
    }
    expect(previous).toBe(session.state.rng.drawCount)
  })

  it('W7 D3：会话可重复构造（同种子两次跑出的日志条数与骰数一致）', () => {
    const first = replaySessionLog(buildBaselineSession())
    const second = replaySessionLog(buildBaselineSession())
    expect(second.logEntries).toBe(first.logEntries)
    expect(second.diceCount).toBe(first.diceCount)
    expect(second.ok).toBe(true)
  })

  it('W7 D3：篡改某条日志的骰面 ⇒ 报出首个分歧（定位到条号、动作、规则与当时游标）', () => {
    const base = buildBaselineSession()
    // 追加两条真骰日志（骰子接在基线游标之后消费 ⇒ 重放必然吻合）
    let rng: RngState = base.state.rng
    const first = makeRollingEntry({ rng, count: 2, action: 'combat', rule: '9.9' })
    rng = first.rng
    const second = makeRollingEntry({ rng, count: 1, action: 'barrage', rule: '10.0' })
    rng = second.rng
    const session: GameSession = {
      ...base,
      log: [...base.log, first.entry, second.entry],
      state: { ...base.state, rng },
    }
    // 前提：不加篡改时这条会话是吻合的
    expect(replaySessionLog(session).ok).toBe(true)

    // 篡改第 2 条（`barrage`）的骰面 ⇒ 首个分歧应落在那一条
    const targetIndex = session.log.length - 1
    const target = session.log[targetIndex]
    if (target === undefined) throw new Error('定向构造失败：目标日志条目缺席')
    const tampered: DiceRoll = { count: 1, faces: [6], total: 6 }
    const log = session.log.map((entry, index) =>
      index === targetIndex ? { ...entry, rolls: [tampered] } : entry,
    )
    const report = replaySessionLog({ ...session, log })

    expect(report.ok).toBe(false)
    expect(report.firstDivergence).not.toBeNull()
    expect(report.firstDivergence?.index).toBe(targetIndex)
    expect(report.firstDivergence?.action).toBe('barrage')
    expect(report.firstDivergence?.rule).toBe('10.0')
    expect(report.firstDivergence?.expected.faces).toEqual([6])
    // 重放值与日志值不同（要么骰面不同，要么原本就不是 6）
    expect(report.detail).toContain('首个分歧在第')
    expect(report.detail).toContain('10.0')
  })

  it('W7 D3：篡改存档的内部状态 ⇒ rngSelfConsistent=false 且总判定不通过', () => {
    const base = buildBaselineSession()
    const broken: GameSession = {
      ...base,
      state: { ...base.state, rng: { ...base.state.rng, state: base.state.rng.state + 7 } },
    }
    const report = replaySessionLog(broken)
    expect(report.rngSelfConsistent).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.detail).toContain('不自洽')
  })

  it('W7 D3：手动追加的日志也会被重放核对（钉住「日志即真相」的契约）', () => {
    const base = buildBaselineSession()
    // 用**错误的骰面**追加一条：重放必须报分歧（而不是照抄日志）
    const forged = makeLogEntry({
      action: 'combat',
      rule: '9.9',
      rolls: [{ count: 2, faces: [6, 6], total: 12 }],
    })
    const session = appendEntries(base, [forged])
    const report = replaySessionLog(session)
    expect(report.ok).toBe(false)
    expect(report.firstDivergence?.index).toBe(session.log.length - 1)
    expect(report.firstDivergence?.expected).toEqual({ count: 2, faces: [6, 6], total: 12 })
  })
})
