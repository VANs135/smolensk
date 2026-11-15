import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'

import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import {
  computeReachableHexes,
  evaluateStep,
  insidePlayArea,
  planRetreatDestinations,
  resolveAdvanceAfterCombat,
  resolveRetreat,
} from '@/engine/rules'
import type {
  MoveContext,
  MoveUnitView,
  RetreatFacts,
  StepFailure,
  StepSuccess,
} from '@/engine/rules'

/**
 * 剧本活动区（用户 2026-11-15 口径）：范围外**不可进入**
 *
 * 读数从剧本走（`playAreaHexes`），限制落在**进格判据**上：移动 / 突袭进格 / 可达格高亮 /
 * 撤退路径与落点 / 战后推进。缺省不注入 ⇒ 全图不限（既有剧本行为不变）。
 */

const START: HexRef = { col: 36, row: 13 }
const NEIGHBORS = HEX_DIRECTIONS.map((direction) => neighbor(START, direction))
const IN_HEX = NEIGHBORS[0]!
const OUT_HEX = NEIGHBORS[1]!
const AREA: readonly HexRef[] = [START, IN_HEX]

function makeMap() {
  return {
    onMap: () => true,
    terrainsAt: (): readonly string[] => ['Open'],
    crossingBetween: () => null,
  }
}

function unit(over: Partial<MoveUnitView> = {}): MoveUnitView {
  return {
    id: 'u1',
    side: 'axis',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: START,
    mobility: 'leg',
    ma: 6,
    re: 2,
    mode: 'combat',
    orientation: 'combat',
    dg: false,
    exploit: false,
    releasedFromReserve: false,
    fuelled: false,
    mpLockedThisPhase: false,
    ...over,
  }
}

function context(over: Partial<MoveContext> = {}): MoveContext {
  return { phase: 'movement', activeSide: 'axis', map: makeMap(), units: [unit()], ...over }
}

function expectOk(outcome: ReturnType<typeof evaluateStep>): StepSuccess {
  if (!outcome.ok) throw new Error(`预期成功，实得失败：${outcome.reason} / ${outcome.rule}`)
  return outcome
}

function expectFail(outcome: ReturnType<typeof evaluateStep>): StepFailure {
  if (outcome.ok) throw new Error('预期失败，实得成功')
  return outcome
}

const retreatFacts = (over: Partial<RetreatFacts> = {}): RetreatFacts => ({
  enemyCombatUnitAt: () => false,
  inEnemyZocAt: () => false,
  prohibitedFor: () => false,
  friendlyCombatUnitsAt: () => [],
  immobile: () => false,
  ...over,
})

describe('活动区判据（剧本读数，缺省不限）', () => {
  it('未给活动区 ⇒ 视为全图可进入', () => {
    expect(insidePlayArea(undefined, OUT_HEX)).toBe(true)
  })

  it('给了活动区 ⇒ 只认格集内的格', () => {
    expect(insidePlayArea(AREA, START)).toBe(true)
    expect(insidePlayArea(AREA, IN_HEX)).toBe(true)
    expect(insidePlayArea(AREA, OUT_HEX)).toBe(false)
  })
})

describe('移动进格（6.1 / 8.1）：活动区外的格不可进入', () => {
  it('活动区内的邻格可以进', () => {
    expectOk(evaluateStep(context({ playAreaHexes: AREA }), 'u1', IN_HEX))
  })

  it('活动区外的邻格按「不可进入」拒绝', () => {
    const failure = expectFail(evaluateStep(context({ playAreaHexes: AREA }), 'u1', OUT_HEX))
    expect(failure.reason).toBe('outsidePlayArea')
  })

  it('可达格高亮与逐格判据同口径：不会高亮活动区外的格', () => {
    const result = computeReachableHexes(context({ playAreaHexes: AREA }), 'u1')
    if (!result.ok) throw new Error(`预期可达，实得：${result.reason}`)
    expect(result.reachable.length).toBeGreaterThan(0)
    for (const hex of result.reachable) expect(insidePlayArea(AREA, hex.hex)).toBe(true)
  })
})

describe('撤退（9.12）：路径与落点都不得出活动区', () => {
  it('落点规划排除活动区外的格', () => {
    const plans = planRetreatDestinations({
      from: START,
      distance: 1,
      mobility: 'leg',
      side: 'axis',
      facts: retreatFacts({ outsidePlayArea: (hex) => !insidePlayArea(AREA, hex) }),
    })
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) expect(insidePlayArea(AREA, plan.hex)).toBe(true)
    expect(plans.some((plan) => plan.hex.col === OUT_HEX.col && plan.hex.row === OUT_HEX.row)).toBe(
      false,
    )
  })

  it('被硬塞入活动区外路径 ⇒ 按不可通行处理（消灭）', () => {
    const result = resolveRetreat({
      unit: { id: 'u1', side: 'axis', hex: START, mobility: 'leg', dg: false },
      path: [OUT_HEX],
      distance: 1,
      facts: retreatFacts({ outsidePlayArea: (hex) => !insidePlayArea(AREA, hex) }),
    })
    expect(result.destroyed).toBe(true)
    expect(result.reason).toBe('outsidePlayArea')
  })
})

describe('战后推进（9.12g）：防御格在活动区外则不得推进', () => {
  it('推进目标在活动区外 ⇒ 无人推进（合法结果，不报错）', () => {
    const outcome = resolveAdvanceAfterCombat({
      attackType: 'regular',
      defendingHexCleared: true,
      attackerRetreated: false,
      candidates: [{ id: 'u1', paidCombatSupply: true }],
      chosenUnitIds: ['u1'],
      advanceIntoOutsidePlayArea: true,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.advanceUnitIds).toEqual([])
  })
})
