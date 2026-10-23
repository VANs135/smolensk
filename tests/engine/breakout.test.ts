import { describe, expect, it } from 'vitest'

import {
  BREAKOUT_FIRST_TURN_DRM,
  BREAKOUT_MIN_PRINTED_MA,
  BREAKOUT_RANGE_HEXES,
  BREAKOUT_SUCCESS_MIN_DICE,
  canBreakout,
  resolveBreakout,
  resolveBreakoutAttempt,
  resolveBreakoutReturn,
  type BreakoutConditions,
  type BreakoutPathFacts,
  type BreakoutUnitView,
} from '@/engine/rules'

/**
 * 突围（B9）测试 —— 断言到条文一级
 *
 * 2.2 时机（移动阶段的**首环节**）· 12.8e 资格（无追溯补给 / 战斗单位 / 印刷 MA ≥ 1）·
 * 12.8e-A 路径（无敌方战斗单位、无禁入地形；**仅轮式**另需无未被抵消 EZOC）·
 * 12.8e-B 15 格直线距离 · 12.8e 断补首回合豁免（免除 A/B + 掷骰 +1 + 运输点数可突围）·
 * 12.8e 掷骰（1d6：1–4 失败进死亡堆 / 5–6 成功离图）· 12.8e 返场骰（当前回合 + 骰值）·
 * 12.8e 末段（返回保留军力损失、清除其他标记）。
 */

const unwrap = <T>(
  outcome: { ok: true; data: T } | { ok: false; rule: string; reason: string },
): T => {
  if (!outcome.ok) throw new Error(`预期成功，实得失败：${outcome.rule} / ${outcome.reason}`)
  return outcome.data
}

/** 突围单位（缺省：断补的 4MA 战斗单位） */
function unitView(over: Partial<BreakoutUnitView> = {}): BreakoutUnitView {
  return {
    id: 'u1',
    isCombat: true,
    isTransportPoint: false,
    moveMa: 4,
    hasTraceSupply: false,
    ...over,
  }
}

/** 12.8e-A 路径事实（缺省：徒步、全程无障碍） */
function pathFacts(over: Partial<BreakoutPathFacts> = {}): BreakoutPathFacts {
  return {
    mobility: 'leg',
    hasEnemyCombatUnit: false,
    hasProhibitedTerrain: false,
    hasUnnegatedEzoc: false,
    ...over,
  }
}

/** 12.8e 条件事实（缺省：A 可用、B 距离 10 格） */
function conditions(over: Partial<BreakoutConditions> = {}): BreakoutConditions {
  return { path: pathFacts(), nearestTracedCombatFriendDistance: 10, ...over }
}

/** 缺省的突围资格请求：移动阶段、断补、非首回合、A/B 均满足 */
function request(over: Partial<Parameters<typeof canBreakout>[0]> = {}) {
  return canBreakout({
    phase: 'movement',
    unit: unitView(),
    firstTurnOutOfSupply: false,
    conditions: conditions(),
    ...over,
  })
}

describe('12.8e 突围资格：时机与基本前提', () => {
  it('2.2：突围是移动阶段的**首环节**，其他阶段不可突围', () => {
    expect(request({ phase: 'movement' }).ok).toBe(true)
    for (const phase of ['reaction', 'exploitation', 'combat', 'supply'] as const) {
      expect(request({ phase })).toMatchObject({
        ok: false,
        rule: '2.2',
        reason: 'breakoutOnlyInMovementPhaseBreakoutSegment',
      })
    }
  })

  it('12.8e：只有「当前没有追溯补给」的单位才突围（有追溯补给者拒绝）', () => {
    expect(request({ unit: unitView({ hasTraceSupply: true }) })).toMatchObject({
      ok: false,
      rule: '12.8e',
      reason: 'hasTraceSupply:u1',
    })
  })

  it('12.8e：非战斗单位除外（普通非战斗单位任何情形都不可突围）', () => {
    const support = unitView({ isCombat: false, isTransportPoint: false })
    expect(request({ unit: support })).toMatchObject({
      ok: false,
      reason: 'nonCombatUnitCannotBreakout:u1',
    })
    // 即便命中首回合豁免，非战斗单位仍不可（豁免只额外放开**运输点数**）
    expect(request({ unit: support, firstTurnOutOfSupply: true })).toMatchObject({
      ok: false,
      reason: 'nonCombatUnitCannotBreakout:u1',
    })
  })

  it('12.8e：印刷 MA 至少为 1（MA 0 不可突围）', () => {
    expect(BREAKOUT_MIN_PRINTED_MA).toBe(1)
    expect(request({ unit: unitView({ moveMa: 0 }) })).toMatchObject({
      ok: false,
      reason: 'printedMaBelowMinimum:u1:0',
    })
    expect(request({ unit: unitView({ moveMa: 1 }) }).ok).toBe(true)
  })
})

describe('12.8e-A 路径条件（无敌方战斗单位 / 无禁入地形；仅轮式另需无未被抵消 EZOC）', () => {
  it('12.8e-A：路径上有敌方战斗单位 ⇒ 拒绝', () => {
    expect(
      request({ conditions: conditions({ path: pathFacts({ hasEnemyCombatUnit: true }) }) }),
    ).toMatchObject({ ok: false, reason: 'pathHasEnemyCombatUnit:u1' })
  })

  it('12.8e-A：路径上有移动禁入地形 ⇒ 拒绝（以移动模式的 MA 类型判断）', () => {
    expect(
      request({ conditions: conditions({ path: pathFacts({ hasProhibitedTerrain: true }) }) }),
    ).toMatchObject({ ok: false, reason: 'pathHasProhibitedTerrain:u1' })
  })

  it('12.8e-A：**只有轮式 MP 单位**受「未被抵消的 EZOC」限制（徒步/履带无视）', () => {
    const withEzoc = conditions({ path: pathFacts({ hasUnnegatedEzoc: true }) })
    // 轮式 ⇒ 拒绝
    expect(
      request({ conditions: { ...withEzoc, path: { ...withEzoc.path, mobility: 'truck' } } }),
    ).toMatchObject({
      ok: false,
      reason: 'pathHasUnnegatedEzocForWheeled:u1',
    })
    // 徒步 / 履带 ⇒ 仍可（条文只限轮式）
    expect(
      request({ conditions: { ...withEzoc, path: { ...withEzoc.path, mobility: 'leg' } } }).ok,
    ).toBe(true)
    expect(
      request({ conditions: { ...withEzoc, path: { ...withEzoc.path, mobility: 'track' } } }).ok,
    ).toBe(true)
  })
})

describe('12.8e-B 距离条件（15 格内、含 15 格，直线距离）', () => {
  it('12.8e-B：最近有追溯补给的友方战斗单位须在 15 格内（含 15 格）', () => {
    expect(BREAKOUT_RANGE_HEXES).toBe(15)
    expect(request({ conditions: conditions({ nearestTracedCombatFriendDistance: 15 }) }).ok).toBe(
      true,
    )
    expect(
      request({ conditions: conditions({ nearestTracedCombatFriendDistance: 16 }) }),
    ).toMatchObject({ ok: false, rule: '12.8e', reason: 'noTracedCombatFriendWithinRange:u1:16' })
    expect(
      request({ conditions: conditions({ nearestTracedCombatFriendDistance: null }) }),
    ).toMatchObject({ ok: false, reason: 'noTracedCombatFriendWithinRange:u1:none' })
  })

  it('12.8e：非首回合必须给出 A/B 事实（缺省即拒绝，不静默放行）', () => {
    expect(request({ conditions: undefined })).toMatchObject({
      ok: false,
      reason: 'conditionsNotEvaluated:u1',
    })
  })
})

describe('12.8e 断补首回合豁免（免除 A/B + 掷骰 +1）', () => {
  it('12.8e：首回合免除 A/B（不查条件也通过），并给出 +1 掷骰修正', () => {
    expect(BREAKOUT_FIRST_TURN_DRM).toBe(1)
    const first = unwrap(
      request({
        firstTurnOutOfSupply: true,
        conditions: undefined,
        // 故意给出「不满足」的路径，验证首回合确实不看 A/B
      }),
    )
    expect(first).toMatchObject({ firstTurn: true, drm: BREAKOUT_FIRST_TURN_DRM, rule: '12.8e' })
    expect(first.detail).toContain('首回合')
  })

  it('12.8e：首回合豁免时**运输点数也允许突围**（为每个点数分别掷骰）', () => {
    const tp = unitView({ isCombat: false, isTransportPoint: true })
    expect(request({ unit: tp, firstTurnOutOfSupply: true, conditions: undefined }).ok).toBe(true)
    // 非首回合：运输点数（非战斗单位）不可突围
    expect(request({ unit: tp })).toMatchObject({
      ok: false,
      reason: 'nonCombatUnitCannotBreakout:u1',
    })
  })

  it('12.8e：非首回合的 drm 为 0', () => {
    expect(unwrap(request()).drm).toBe(0)
  })
})

describe('12.8e 突围掷骰（1d6：1–4 失败进死亡堆 / 5–6 成功离图）', () => {
  it('12.8e：1–4 失败 ⇒ 进入死亡堆（可正常重建），且不带任何保留标记', () => {
    expect(BREAKOUT_SUCCESS_MIN_DICE).toBe(5)
    for (const die of [1, 2, 3, 4]) {
      const result = resolveBreakoutAttempt({ die, firstTurnOutOfSupply: false })
      expect(result).toMatchObject({
        die,
        drm: 0,
        modifiedDie: die,
        success: false,
        disposition: 'deadPile',
        keepsStepLosses: false,
        clearsOtherMarkers: false,
        rule: '12.8e',
      })
    }
  })

  it('12.8e：5–6 成功 ⇒ 离图并作为增援返回；返回时保留军力损失、清除其他标记', () => {
    for (const die of [5, 6]) {
      const result = resolveBreakoutAttempt({ die, firstTurnOutOfSupply: false })
      expect(result).toMatchObject({
        die,
        modifiedDie: die,
        success: true,
        disposition: 'returnAsReinforcement',
        keepsStepLosses: true,
        clearsOtherMarkers: true,
      })
      expect(result.detail).toContain('再掷 1 骰')
    }
  })

  it('12.8e：首回合 +1 使原本失败的 4 变为成功', () => {
    expect(resolveBreakoutAttempt({ die: 4, firstTurnOutOfSupply: false }).success).toBe(false)
    const boosted = resolveBreakoutAttempt({ die: 4, firstTurnOutOfSupply: true })
    expect(boosted).toMatchObject({ drm: BREAKOUT_FIRST_TURN_DRM, modifiedDie: 5, success: true })
    // 3 + 1 = 4 仍然失败
    expect(resolveBreakoutAttempt({ die: 3, firstTurnOutOfSupply: true }).success).toBe(false)
  })

  it('12.8e：骰值必须是 1–6 的单骰（越界抛 RangeError）', () => {
    expect(() => resolveBreakoutAttempt({ die: 0, firstTurnOutOfSupply: false })).toThrow(
      RangeError,
    )
    expect(() => resolveBreakoutAttempt({ die: 7, firstTurnOutOfSupply: false })).toThrow(
      RangeError,
    )
    expect(() => resolveBreakoutAttempt({ die: 3.5, firstTurnOutOfSupply: false })).toThrow(
      RangeError,
    )
  })
})

describe('12.8e 返场回合（当前回合向后数返回骰的回合数）', () => {
  it('12.8e：返场回合 ＝ 当前回合 + 返回骰', () => {
    const result = resolveBreakoutReturn({ currentTurn: 5, returnDie: 3 })
    expect(result).toMatchObject({ returnsOnTurn: 8, beyondLastTurn: null, rule: '12.8e' })
  })

  it('12.8e：越出回合轨时如实报出（不擅自夹取）', () => {
    const beyond = resolveBreakoutReturn({ currentTurn: 18, returnDie: 6, lastTurn: 19 })
    expect(beyond).toMatchObject({ returnsOnTurn: 24, beyondLastTurn: true })
    expect(beyond.detail).toContain('不再返场')
    const within = resolveBreakoutReturn({ currentTurn: 18, returnDie: 1, lastTurn: 19 })
    expect(within).toMatchObject({ returnsOnTurn: 19, beyondLastTurn: false })
  })

  it('12.8e：返回骰须为 1–6，当前回合须为 ≥1 的整数（越界抛 RangeError）', () => {
    expect(() => resolveBreakoutReturn({ currentTurn: 5, returnDie: 0 })).toThrow(RangeError)
    expect(() => resolveBreakoutReturn({ currentTurn: 5, returnDie: 7 })).toThrow(RangeError)
    expect(() => resolveBreakoutReturn({ currentTurn: 0, returnDie: 3 })).toThrow(RangeError)
  })
})

describe('12.8e 一次完整结算（突围掷骰 → 成功者再掷返场骰）', () => {
  it('12.8e：失败（1–4）⇒ 进入死亡堆，**不再**掷返场骰', () => {
    const result = resolveBreakout({ die: 3, firstTurnOutOfSupply: false, currentTurn: 5 })
    expect(result).toMatchObject({
      attempt: { success: false, disposition: 'deadPile', modifiedDie: 3 },
      returnInfo: null,
      pendingReturnDie: false,
    })
  })

  it('12.8e：成功（5–6）但未给返场骰 ⇒ 停在「须再掷一次」', () => {
    const result = resolveBreakout({ die: 6, firstTurnOutOfSupply: false, currentTurn: 5 })
    expect(result).toMatchObject({
      attempt: { success: true, disposition: 'returnAsReinforcement' },
      returnInfo: null,
      pendingReturnDie: true,
    })
  })

  it('12.8e：成功 + 返场骰 ⇒ 离图并给出返场回合；返回保留军力损失、清除其他标记', () => {
    const result = resolveBreakout({
      die: 5,
      firstTurnOutOfSupply: false,
      currentTurn: 7,
      returnDie: 4,
    })
    expect(result.pendingReturnDie).toBe(false)
    expect(result.attempt).toMatchObject({
      success: true,
      keepsStepLosses: true,
      clearsOtherMarkers: true,
    })
    expect(result.returnInfo).toMatchObject({ returnsOnTurn: 11, rule: '12.8e' })
  })

  it('12.8e：断补首回合 +1 ⇒ 骰 4 也能成功返场（骰 3 + 1 = 4 仍失败）', () => {
    const boosted = resolveBreakout({
      die: 4,
      firstTurnOutOfSupply: true,
      currentTurn: 2,
      returnDie: 1,
    })
    expect(boosted.attempt).toMatchObject({
      drm: BREAKOUT_FIRST_TURN_DRM,
      modifiedDie: 5,
      success: true,
    })
    expect(boosted.returnInfo).toMatchObject({ returnsOnTurn: 3 })
    expect(
      resolveBreakout({ die: 3, firstTurnOutOfSupply: true, currentTurn: 2 }).attempt.success,
    ).toBe(false)
  })

  it('12.8e：返场号越出回合轨时如实报出（不夹取）', () => {
    const result = resolveBreakout({
      die: 6,
      firstTurnOutOfSupply: false,
      currentTurn: 18,
      returnDie: 6,
      lastTurn: 19,
    })
    expect(result.returnInfo).toMatchObject({ returnsOnTurn: 24, beyondLastTurn: true })
  })

  it('12.8e：资格 → 掷骰 → 成功再掷骰，一条链走通（首回合豁免的运输点数）', () => {
    // ① 资格：断补首回合的运输点数（非战斗单位）获豁免而可突围
    const eligibility = unwrap(
      request({
        unit: unitView({ id: 'tp1', isCombat: false, isTransportPoint: true, moveMa: 10 }),
        firstTurnOutOfSupply: true,
        conditions: undefined,
      }),
    )
    expect(eligibility).toMatchObject({ firstTurn: true, drm: BREAKOUT_FIRST_TURN_DRM })
    // ② 掷骰：4 + 1 = 5 ⇒ 成功 ③ 再掷返场骰：当前回合 3 + 2 = 5
    const resolution = resolveBreakout({
      die: 4,
      firstTurnOutOfSupply: eligibility.firstTurn,
      currentTurn: 3,
      returnDie: 2,
    })
    expect(resolution.attempt.success).toBe(true)
    expect(resolution.returnInfo).toMatchObject({ returnsOnTurn: 5 })
  })
})
