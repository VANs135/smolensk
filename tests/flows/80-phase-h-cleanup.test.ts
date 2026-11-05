import { describe, expect, it } from 'vitest'

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

import { combatRecord, label, newConsole, placeGround } from './sop-harness'

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
    counters: {
      reserveMarkers: { axis: 14, soviet: 0 },
      supplyCache: { axis: 2, soviet: 2 },
      constructionMarkers: 3,
    },
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
