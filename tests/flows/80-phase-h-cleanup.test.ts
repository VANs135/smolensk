import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { nextTick } from 'vue'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { ACTIONS_BY_PHASE, checkTiming, removalAllowedNow } from '@/engine/rules'
import {
  advanceTurn,
  isDecisionPhase,
  nextPhase,
  PLAYER_TURN_PHASES,
  turnDate,
} from '@/engine/turn-driver'
import type { GamePhase, Records } from '@/engine/state-types'
import { createPhaseCoordinator } from '@/stores/phase-coordinator'

import { combatRecord, label, newConsole, placeGround } from './sop-harness'
import { fillSetup, fresh, progress } from './flow-harness'

/**
 * 环节 Ⓗ：**清理**（H 段）与回合收束——2.2 流程表
 *
 * 2.2 流程表把 H 清理列为**玩家八段的最后一段**，随后交给对手重做 A–H，或落到 Turn End 推进回合。
 * 本文件验证段机侧的全部事实：H 段没有玩家动作、换方点正确、Turn End 的推进与守卫，
 * 以及**专规 3.3b 的 Trainbusting 标记移除**（「在任意 Clean Up Phase，若安全需求满足或该城转苏控则移除」）。
 *
 * ⚠ 说明：2.2 对 H 段的**通用**自动清理效果（移除 DG 标记、移除进击标记、燃料标记翻面/移除、
 *   移除对手的运输破坏标记）已实现于 `engine/rules/cleanup.ts#planCleanUp`，条款级用例见
 *   `tests/engine/cleanup.test.ts`；本文件负责**段机侧**（许可动作、换方、Turn End 与专规 3.3b）。
 * 单独运行：`npx vitest run tests/flows/80-phase-h-cleanup.test.ts`
 */

/** 最小 Records 夹具 */
function createRecords(overrides: Partial<Records> = {}): Records {
  return {
    turn: 1,
    phase: 'cleanUp',
    preTurnSegment: null,
    activeSide: 'axis',
    firstPlayer: 'axis',
    weather: { air: 'normal', ground: 'good' },
    railCapacity: { axis: 0, soviet: 2 },
    markerTracks: {},
    victoryLocations: [],
    ...overrides,
  }
}

describe('Ⓗ H 段：只有「清理」这一个动作的收束段（2.2）', () => {
  it('2.2 / ACTIONS_BY_PHASE：H 段只许可 cleanUp（清理全自动），移动/战斗/整备等一律拒绝', () => {
    expect([...ACTIONS_BY_PHASE.cleanUp]).toEqual(['cleanUp'])
    // 清理本身在 H 段合法
    expect(
      checkTiming({
        action: 'cleanUp',
        side: 'axis',
        activeSide: 'axis',
        phase: 'cleanUp',
        date: turnDate(1),
      }),
    ).toEqual([])
    for (const action of ['move', 'barrage', 'attack', 'refit', 'engineer'] as const) {
      const violations = checkTiming({
        action,
        side: 'axis',
        activeSide: 'axis',
        phase: 'cleanUp',
        date: turnDate(1),
      })
      expect(violations.map((item) => item.reason)).toContain('actionNotInSegment')
    }
    // 清理也不能拿到别的段去执行（2.2：清理只属 H 段）
    for (const phase of ['movement', 'supply', 'combat', 'exploitation'] as const) {
      const violations = checkTiming({
        action: 'cleanUp',
        side: 'axis',
        activeSide: 'axis',
        phase,
        date: turnDate(1),
      })
      expect(violations.map((item) => item.reason)).toContain('actionNotInSegment')
    }
    // 不是玩家决策阶段（六个决策阶段为 B–G）
    expect(isDecisionPhase('cleanUp')).toBe(false)
  })

  it('2.2：先手方 H 段 → 交给后手方重做 A 段；后手方 H 段 → 落到 Turn End', () => {
    const firstDone = nextPhase(createRecords({ activeSide: 'axis', firstPlayer: 'axis' }))
    expect(firstDone.phase).toBe('aircraftRefit')
    expect(firstDone.activeSide).toBe('soviet')

    const secondDone = nextPhase(createRecords({ activeSide: 'soviet', firstPlayer: 'axis' }))
    expect(secondDone.phase).toBe('turnEnd')
    expect(secondDone.activeSide).toBeNull()
  })

  it('★ H 段是自动段：阶段协调器在离开 H 之前执行一次清理，无需任何按钮', () => {
    let current: Records = createRecords({ phase: 'cleanUp', activeSide: 'soviet' })
    let cleaned = 0
    const coordinator = createPhaseCoordinator({
      current: () => current,
      isInitialSetup: () => false,
      isPlayerPhase: () => false,
      start() {},
      settleObligations: () => true,
      cleanUp() {
        cleaned += 1
        return true
      },
      publishVictory() {},
      resetPhase() {},
      resetTurn() {},
      refreshTrace() {},
      ensureReinforcement() {},
    })
    expect(coordinator.beforeStep()).toBe(true)
    expect(cleaned).toBe(1)
    // 一旦离开 H，后续步进不再重复清理
    current = createRecords({ phase: 'reinforcement', activeSide: 'axis' })
    expect(coordinator.beforeStep()).toBe(true)
    expect(cleaned).toBe(1)
  })

  it('★ 源码守卫：自动段不铺动作按钮（验证页也没有「执行 H 段清理」入口）', () => {
    const view = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(view).not.toContain('runCleanUpNow')
    expect(view).not.toContain('执行 H 段清理')
  })

  it('2.2：缺少行动方或先手方时 H 段换方即抛错（不允许静默推断）', () => {
    expect(() => nextPhase(createRecords({ activeSide: null }))).toThrow()
    expect(() => nextPhase(createRecords({ firstPlayer: null }))).toThrow()
  })
})

describe('Ⓗ 专规 3.3b：Trainbusting 标记只在 H 段移除', () => {
  /** 首个地图城市格（3.3b 的治安检查对象） */
  const CITY_HEX: HexRef = (() => {
    const found = mapLayers.hexes.find((hex) => hex.city !== undefined)
    if (found === undefined) throw new Error('地图上找不到城市格')
    return { col: found.col, row: found.row }
  })()

  it('3.3b：判据规定移除只能在 Clean Up Phase 进行', () => {
    expect(removalAllowedNow('cleanUp')).toBe(true)
    for (const phase of ['movement', 'supply', 'reaction', 'combat', 'exploitation'] as const) {
      expect(removalAllowedNow(phase)).toBe(false)
    }
  })

  it('3.3b：需求满足后，G 段检查只登记「待移除」，切到 H 段才真正移除', () => {
    const store = newConsole()
    store.toggleAxisCityControlNow(label(CITY_HEX))
    // 无驻兵、无 ZOC ⇒ 放一枚
    store.applySecurityNeedsNow()
    expect(store.trainbustingMarks.length).toBe(1)

    // 驻兵 ⇒ 需求满足，但仍在 G 段（进击）⇒ 不移除
    placeGround(store, combatRecord('axis'), CITY_HEX, 'axis', 'u1')
    store.setPhase('exploitation')
    expect(store.securityNeeds?.removeAt).toEqual([CITY_HEX])
    store.applySecurityNeedsNow()
    expect(store.trainbustingMarks.length).toBe(1)

    // 切到 H 清理段 ⇒ 移除
    store.setPhase('cleanUp')
    store.applySecurityNeedsNow()
    expect(store.trainbustingMarks.length).toBe(0)
  })
})

describe('Ⓗ 回合收束：Turn End 与下一回合的 Pre-Turn', () => {
  it('2.2：Turn End 推进到下一回合的 Pre-Turn 天气判定，并清空行动方与先手', () => {
    const next = advanceTurn(createRecords({ phase: 'turnEnd', activeSide: null, turn: 3 }))
    expect(next.turn).toBe(4)
    expect(next.phase).toBe('preTurn')
    expect(next.preTurnSegment).toBe('weatherDetermination')
    expect(next.activeSide).toBeNull()
    expect(next.firstPlayer).toBeNull()
    // 天气保留上一回合值，直到天气判定子步重新掷出（2.2）
    expect(next.weather).toEqual({ air: 'normal', ground: 'good' })
  })

  it('2.2：一个回合内先手方与后手方各走一遍 A–H（共 16 段 + 2 次换方）', () => {
    let records = createRecords({
      phase: 'aircraftRefit',
      activeSide: 'axis',
      firstPlayer: 'axis',
    })
    const transitions: GamePhase[] = []
    // 先手方 A→H 需 8 次推进；再过 1 次换方，共 17 次推进后落到后手方的 H 之后的 turnEnd
    for (let step = 0; step < PLAYER_TURN_PHASES.length * 2; step += 1) {
      records = nextPhase(records)
      transitions.push(records.phase)
    }
    expect(transitions.slice(0, PLAYER_TURN_PHASES.length)).toEqual([
      ...PLAYER_TURN_PHASES.slice(1),
      'aircraftRefit',
    ])
    expect(records.phase).toBe('turnEnd')
  })
})

describe('Ⓗ 回合收束：B 段的「本段可收回」登记不得跨段 / 跨回合存活', () => {
  it('换回合后，上一段已落位的 1.6c 返场与 2.3c 编制转化登记必须清空', async () => {
    const store = newConsole()
    store.specialReplPlacedThisSegment = [
      { instanceId: 'old-special', name: '上一回合返场', steps: 2, priorSteps: 3 },
    ]
    store.frontalUnitPlacedThisSegment = {
      instanceId: 'old-frontal',
      entry: { recordId: 'x', name: '上一回合编制转化', images: null },
    }
    store.setPhase('movement')
    store.setTurn(2)
    await nextTick()
    /*
     * 两条 `withdraw*` 只按「仍在第二段（replRoll）」把关、不看回合 ⇒ 若登记不清零，
     * 下一回合的第二段会把上一回合已上场的算子重新列成"本段已放置"并允许收回死亡堆。
     */
    expect(store.specialReplPlacedThisSegment).toEqual([])
    expect(store.frontalUnitPlacedThisSegment).toBeNull()
  })

  it('换方同样清空（同一回合的另一半也不继承对手的收回登记）', async () => {
    const store = newConsole()
    store.specialReplPlacedThisSegment = [
      { instanceId: 'old-special', name: '轴方返场', steps: 2, priorSteps: 3 },
    ]
    store.setActiveSide('soviet')
    await nextTick()
    expect(store.specialReplPlacedThisSegment).toEqual([])
  })
})

describe('Ⓗ 整回合闭环：初设 → Pre-Turn → A–H → 下一回合 A 段', () => {
  it('先手方 H 只清本方；换回合后新回合 A 段没有上一回合的残留', async () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    fillSetup(ctx)
    expect(ctx.setup.startGameNow()).toBe(true)

    // 双方各塞一套阶段标记：formation 燃料按 12.5d 应活到本方清理段，DG / 进击同理
    const seed = (unitId: string) => {
      const unit = ctx.w.units.find((item) => item.instanceId === unitId)!
      unit.mode = { ...unit.mode, dg: true, exploit: true }
      unit.fuelled = true
      unit.fuelMethod = 'formation'
      unit.minimalFuel = false
      return unit
    }
    const seeded = [
      ...ctx.w.units
        .filter((unit) => unit.side === 'axis')
        .slice(0, 2)
        .map((unit) => seed(unit.instanceId)),
      ...ctx.w.units
        .filter((unit) => unit.side === 'soviet')
        .slice(0, 2)
        .map((unit) => seed(unit.instanceId)),
    ]

    const cleanUpCount = () => ctx.g.log.filter((entry) => entry.action === 'cleanUp').length
    const startedTurn = ctx.w.turn
    await progress(ctx, () => cleanUpCount() >= 1)

    // 先手方 H 之后：本方标记清空，对手原样（activeSide 已换到先手方的对手）
    const cleaned = ctx.w.activeSide === 'soviet' ? 'axis' : 'soviet'
    for (const unit of seeded.filter((item) => item.side === cleaned)) {
      expect(unit.mode.dg, `${unit.instanceId} DG`).toBe(false)
      expect(unit.mode.exploit, `${unit.instanceId} 进击`).toBe(false)
      expect(unit.fuelled, `${unit.instanceId} 燃料`).toBe(false)
    }
    /*
     * 12.8a：断补标记保留到**下一个友方补给阶段**重新判定 ⇒ 本方 H 之后到下一回合补给段之前，
     * 供给结论不得被清理或换回合顺手清掉（"供给标记结转"）。
     */
    const traceBefore = new Map(
      ctx.w.units
        .filter((unit) => unit.side === cleaned)
        .map((unit) => [unit.instanceId, unit.hasTraceSupply] as const),
    )

    await progress(
      ctx,
      () =>
        ctx.g.terminated || (ctx.w.turn > startedTurn && ctx.g.records?.phase === 'aircraftRefit'),
    )
    if (ctx.g.terminated) return

    // 新回合 A 段：逐项核对上一回合的阶段级前值已清干净
    expect(ctx.g.records?.phase).toBe('aircraftRefit')
    expect(ctx.w.date).toBe(turnDate(ctx.w.turn))
    for (const unit of ctx.w.units) {
      expect(unit.mode.dg, `${unit.instanceId} DG 残留`).toBe(false)
      expect(unit.mode.exploit, `${unit.instanceId} 进击残留`).toBe(false)
      expect(unit.fuelled, `${unit.instanceId} 燃料残留`).toBe(false)
      expect(unit.minimalFuel ?? false, `${unit.instanceId} 最省供油残留`).toBe(false)
      expect(unit.mpSpent, `${unit.instanceId} mpSpent`).toBe(0)
      expect(unit.movementEnded, `${unit.instanceId} movementEnded`).toBe(false)
      expect(unit.reserveEnteredThisPhase, `${unit.instanceId} reserveEntered`).toBe(false)
      expect(unit.mpLockedThisPhase, `${unit.instanceId} mpLocked`).toBe(false)
      expect(unit.mode.releasedFromReserve ?? false, `${unit.instanceId} released`).toBe(false)
    }
    for (const air of ctx.w.airUnits) expect(air.missionsFlownThisPhase).toBe(0)
    // 12.8a：本方（已在上一回合判过）的供给结论原样结转，直到下一回合本方补给段再判
    for (const [unitId, trace] of traceBefore) {
      const unit = ctx.w.units.find((item) => item.instanceId === unitId)
      if (unit === undefined) continue
      expect(unit.hasTraceSupply, `${unitId} 供给标记结转`).toBe(trace)
    }
    expect(ctx.w.railCapSpentThisTurn).toEqual([])
    expect(ctx.w.freeRailPicked).toEqual([])
    expect(ctx.w.supplyArrivalSp).toBe(0)
    expect(ctx.w.supplyTrainHex).toBeNull()
    expect(ctx.w.hedgehogTurnLedger).toEqual({})
    expect(ctx.w.airBaseTurnLedger).toEqual({})
  }, 180000)
})
