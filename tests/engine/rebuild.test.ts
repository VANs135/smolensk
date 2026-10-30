import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  addReplHoldings,
  canAffordRepl,
  clearNonSavableRepl,
  emptyReplHoldings,
  isSavableRepl,
  planRebuild,
  rebuildChartRows,
  rebuildRow,
  replResourceForAircraft,
  subtractReplHoldings,
  REPL_STEPS_PER_COUNTER,
  TRUCK_REBUILD_COST_EQUIPMENT,
  type RebuildCandidateView,
  type RebuildPlacementFacts,
  type ReplHoldings,
} from '@/engine/rules'

/**
 * 补员与重建（通规 13.5 ← 专规 1.6 Notes）
 *
 * 逐条对到 13.5a–f 与专规 1.6 的覆盖条款；骰面无关，全部是确定性判定。
 */

const hex = (col: number, row: number): HexRef => ({ col, row })

const holdings = (partial: Partial<ReplHoldings> = {}): ReplHoldings => ({
  ...emptyReplHoldings(),
  ...partial,
})

/** 事实：HQ 在 36.13（2 格内即通过），敌方 ZOC 无 */
function facts(overrides: Partial<RebuildPlacementFacts> = {}): RebuildPlacementFacts {
  const hq = hex(36, 13)
  return {
    withinHqThrowOfFriendlyHq: (target) =>
      Math.abs(target.col - hq.col) <= 2 && target.row === hq.row,
    inUnnegatedEnemyZoc: () => false,
    hasFriendlyAirBase: () => true,
    friendlyAirBaseHex: () => hex(36, 13),
    ...overrides,
  }
}

/** 死亡堆中的步兵师（步兵师步损 = 2x Pax） */
function infDiv(overrides: Partial<RebuildCandidateView> = {}): RebuildCandidateView {
  return {
    id: 'u-inf-5',
    side: 'axis',
    rebuildType: 'Infantry Div step',
    rebuildable: true,
    isAircraft: false,
    inDeadPile: true,
    hex: null,
    steps: 0,
    printedSteps: 4,
    isBreakdown: false,
    isTruckTransportPoint: false,
    ...overrides,
  }
}

describe('13.5：补员账本与可保存性（专规 1.6 Notes）', () => {
  it('13.5：账本相加 / 够付判定 / 扣减（不足即抛错）', () => {
    const a = holdings({ pax: 2, eq: 1 })
    const b = addReplHoldings(a, { pax: 1, ftr: 1 })
    expect(b).toEqual({ pax: 3, eq: 1, ftr: 1, tac: 0 })
    expect(canAffordRepl(b, { pax: 1, ftr: 1 })).toBe(true)
    expect(canAffordRepl(b, { pax: 4 })).toBe(false)
    expect(subtractReplHoldings(b, { pax: 1, ftr: 1 })).toEqual({ pax: 2, eq: 1, ftr: 0, tac: 0 })
    expect(() => subtractReplHoldings(b, { pax: 9 })).toThrow(RangeError)
  })

  it('专规 1.6 Notes：Pax / Eq 可跨回合保存，Ftr / Tac 不可 ⇒ 阶段末清零', () => {
    expect(isSavableRepl('pax')).toBe(true)
    expect(isSavableRepl('eq')).toBe(true)
    expect(isSavableRepl('ftr')).toBe(false)
    expect(isSavableRepl('tac')).toBe(false)
    expect(clearNonSavableRepl(holdings({ pax: 3, eq: 2, ftr: 1, tac: 1 }))).toEqual({
      pax: 3,
      eq: 2,
      ftr: 0,
      tac: 0,
    })
  })

  it('13.5c / 13.5b：重建表的行键来自图表（无行键即不可重建）', () => {
    expect(rebuildChartRows('axis').map((row) => row.unitType)).toContain('Infantry Div step')
    expect(rebuildRow('axis', 'Flm Panzer Bn')?.rebuild).toMatchObject({ kind: 'none' })
    expect(rebuildRow('axis', 'Aufk (Arm Recon) Bn')?.rebuild).toMatchObject({ kind: 'special' })
    expect(rebuildRow('axis', 'Breakdown Rgt')?.rebuild).toMatchObject({ kind: 'pool' })
    expect(rebuildRow('axis', 'Not A Real Type')).toBeNull()
  })
})

describe('13.5c / 13.5b：不可重建的两种情形', () => {
  it('13.5c：AR 后有黄点（rebuildable=false）⇒ 永久不可重建', () => {
    const outcome = planRebuild({
      side: 'axis',
      candidate: infDiv({ rebuildable: false }),
      replHex: hex(36, 13),
      holdings: holdings({ pax: 9 }),
      facts: facts(),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('13.5c')
  })

  it('13.5b：拆分单位被摧毁后返回资源池，不重建', () => {
    const outcome = planRebuild({
      side: 'axis',
      candidate: infDiv({ isBreakdown: true }),
      replHex: hex(36, 13),
      holdings: holdings({ pax: 9 }),
      facts: facts(),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('13.5b')
  })

  it('13.5：重建表行不可经常规途径重建（No Rebuild / Special / Pool / ReplOnly）即拒', () => {
    for (const rebuildType of [
      'Flm Panzer Bn',
      'Aufk (Arm Recon) Bn',
      'Breakdown Rgt',
      'Aircraft',
    ]) {
      const outcome = planRebuild({
        side: 'axis',
        candidate: infDiv({ rebuildType }),
        replHex: hex(36, 13),
        holdings: holdings({ pax: 9, eq: 9 }),
        facts: facts(),
      })
      expect(outcome.ok).toBe(false)
    }
  })
})

describe('13.5a：重建的落点（HQ 2 格内、无未抵消敌 ZOC、图上单位须与补员同格）', () => {
  it('13.5a：补员不在 HQ 2 格内 ⇒ 拒', () => {
    const outcome = planRebuild({
      side: 'axis',
      candidate: infDiv(),
      replHex: hex(30, 20),
      // 4 军力师从死亡堆满血重建 = 4 step × 2 Pax = 8（13.5b + 表行 "Infantry Div step"）
      holdings: holdings({ pax: 8 }),
      facts: facts(),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('rebuildHexNotWithinHqRange:u-inf-5')
  })

  it('4.5a：补员格在敌方 ZOC 内 ⇒ 拒', () => {
    const outcome = planRebuild({
      side: 'axis',
      candidate: infDiv(),
      replHex: hex(36, 13),
      holdings: holdings({ pax: 8 }),
      facts: facts({ inUnnegatedEnemyZoc: () => true }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('4.5a')
  })

  it('13.5a：重建**图上有损**单位的须与补员**堆叠在一起**', () => {
    const stacked = planRebuild({
      side: 'axis',
      candidate: infDiv({ inDeadPile: false, hex: hex(36, 13), steps: 2, printedSteps: 4 }),
      replHex: hex(36, 13),
      // 补 2 个 step ⇒ 4 Pax
      holdings: holdings({ pax: 4 }),
      facts: facts(),
    })
    expect(stacked.ok).toBe(true)
    if (stacked.ok) expect(stacked.data.placements[0]).toMatchObject({ stepsAfter: 4 })

    const apart = planRebuild({
      side: 'axis',
      candidate: infDiv({ inDeadPile: false, hex: hex(35, 13), steps: 2, printedSteps: 4 }),
      replHex: hex(36, 13),
      holdings: holdings({ pax: 4 }),
      facts: facts(),
    })
    expect(apart.ok).toBe(false)
    if (!apart.ok) expect(apart.reason).toBe('unitNotStackedWithRepl:u-inf-5')
  })

  it('13.5b：地面重建缺补员格即拒；不消耗 MP', () => {
    const missing = planRebuild({
      side: 'axis',
      candidate: infDiv(),
      holdings: holdings({ pax: 8 }),
      facts: facts(),
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('missingReplHex:u-inf-5')

    const ok = planRebuild({
      side: 'axis',
      candidate: infDiv(),
      replHex: hex(36, 13),
      holdings: holdings({ pax: 8 }),
      facts: facts(),
    })
    if (!ok.ok) return
    expect(ok.data.placements[0]?.mpSpent).toBe(0)
    expect(ok.data.cost).toEqual({ pax: 8 })
  })
})

describe('13.5：费用与 13.5d 成对重建', () => {
  it('★ 13.5b：多军力师**按 step 计费**（4 军力从死亡堆满血重建 = 4 × 2 Pax = 8）', () => {
    /*
     * 表行键写的是 "Infantry Div **step** — 2x Pax"，13.5b「可重建**任意数量的军力**
     * （前提是有足够的补员）」⇒ 每补回 1 step 付一份行价。
     * 修前恒按 1 份收（2 Pax）却回来 4 个军力 —— 少收三份。
     */
    const ok = planRebuild({
      side: 'axis',
      candidate: infDiv(),
      replHex: hex(36, 13),
      holdings: holdings({ pax: 9 }),
      facts: facts(),
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.data.cost).toEqual({ pax: 8 })
    expect(ok.data.holdingsAfter).toEqual({ pax: 1, eq: 0, ftr: 0, tac: 0 })
    expect(ok.data.placements[0]?.stepsAfter).toBe(4)
  })

  it('★ 13.5b：图上有损只补 1 step ⇒ 只收 1 份（2 Pax）', () => {
    const ok = planRebuild({
      side: 'axis',
      candidate: infDiv({ inDeadPile: false, hex: hex(36, 13), steps: 3, printedSteps: 4 }),
      replHex: hex(36, 13),
      holdings: holdings({ pax: 9 }),
      facts: facts(),
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.data.cost).toEqual({ pax: 2 })
    expect(ok.data.placements[0]?.stepsAfter).toBe(4)
  })

  it('★ 13.5b：`stepsToRestore` 指定补 2 step ⇒ 收 4 Pax（逐点收费）', () => {
    const ok = planRebuild({
      side: 'axis',
      candidate: infDiv({ inDeadPile: false, hex: hex(36, 13), steps: 1, printedSteps: 4 }),
      replHex: hex(36, 13),
      stepsToRestore: 2,
      holdings: holdings({ pax: 9 }),
      facts: facts(),
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.data.cost).toEqual({ pax: 4 })
    expect(ok.data.placements[0]?.stepsAfter).toBe(3)
  })

  it('13.5：补员不足即拒（不静默）', () => {
    const outcome = planRebuild({
      side: 'axis',
      candidate: infDiv(),
      replHex: hex(36, 13),
      holdings: holdings({ pax: 1 }),
      facts: facts(),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('insufficientRepl:8x Pax')
  })

  it('13.5d：成对重建（两个小单位用一个补员）；只剩一个仍消耗一个补员', () => {
    const pair = planRebuild({
      side: 'axis',
      candidate: infDiv({ rebuildType: 'Anti-Tank Bn (German)' }),
      replHex: hex(36, 13),
      holdings: holdings({ eq: 2 }),
      pairSize: 2,
      unitsRequested: 4,
      facts: facts(),
    })
    if (!pair.ok) return
    // 4 个单位 / 每补员 2 个 ⇒ 2 点 Eq
    expect(pair.data.cost).toEqual({ eq: 2 })
    expect(pair.data.placements).toHaveLength(4)

    const single = planRebuild({
      side: 'axis',
      candidate: infDiv({ rebuildType: 'Anti-Tank Bn (German)' }),
      replHex: hex(36, 13),
      holdings: holdings({ eq: 2 }),
      pairSize: 2,
      unitsRequested: 1,
      facts: facts(),
    })
    if (!single.ok) return
    expect(single.data.cost).toEqual({ eq: 1 })
  })
})

describe('13.5e：卡车重建（须因敌方行动被摧毁，1x Eq）', () => {
  it('13.5e：卡车 = 1x Eq；未标记「因敌方行动被摧毁」即拒', () => {
    const ok = planRebuild({
      side: 'axis',
      candidate: infDiv({
        rebuildType: 'Transport Points',
        isTruckTransportPoint: true,
        destroyedByEnemy: true,
      }),
      replHex: hex(36, 13),
      holdings: holdings({ eq: 2 }),
      facts: facts(),
    })
    if (!ok.ok) return
    expect(ok.data.cost).toEqual({ eq: TRUCK_REBUILD_COST_EQUIPMENT })

    const notEnemy = planRebuild({
      side: 'axis',
      candidate: infDiv({
        rebuildType: 'Transport Points',
        isTruckTransportPoint: true,
        destroyedByEnemy: false,
      }),
      replHex: hex(36, 13),
      holdings: holdings({ eq: 2 }),
      facts: facts(),
    })
    expect(notEnemy.ok).toBe(false)
  })
})

describe('13.5f + 专规 1.6 Notes：飞机重建（Eq 不重建飞机；Ftr/Tac 各 1 step）', () => {
  it('专规 1.6 Notes：F 型用 Ftr 补员、T / S / Tpt 型用 Tac 补员', () => {
    expect(replResourceForAircraft('F')).toBe('ftr')
    expect(replResourceForAircraft('T')).toBe('tac')
    expect(replResourceForAircraft('S')).toBe('tac')
    expect(replResourceForAircraft('Tpt')).toBe('tac')
    expect(replResourceForAircraft('comb')).toBeNull()
    expect(REPL_STEPS_PER_COUNTER).toBe(1)
  })

  it('13.5f：飞机在**任一友方空军基地**以**激活**状态重建，不必在 HQ 附近', () => {
    const ok = planRebuild({
      side: 'soviet',
      candidate: infDiv({
        id: 'air-il2',
        rebuildType: 'Aircraft',
        isAircraft: true,
        aircraftType: 'T',
        inDeadPile: true,
        printedSteps: 2,
      }),
      holdings: holdings({ tac: 1 }),
      facts: facts(),
    })
    if (!ok.ok) return
    expect(ok.data.rule).toBe('13.5f')
    expect(ok.data.placements[0]).toMatchObject({
      hex: hex(36, 13),
      airStatus: 'active',
      mpSpent: 0,
    })
    expect(ok.data.cost).toEqual({ tac: 1 })
  })

  it('专规 1.6 Notes：**Eq 不重建飞机**（用 Eq 即拒）', () => {
    const outcome = planRebuild({
      side: 'axis',
      candidate: infDiv({
        id: 'air-ju52',
        rebuildType: 'Aircraft',
        isAircraft: true,
        aircraftType: 'Tpt',
        inDeadPile: true,
        printedSteps: 2,
      }),
      holdings: holdings({ eq: 4 }),
      facts: facts(),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('insufficientRepl:1x Tac')
  })

  it('专规 1.6 Notes：死堆飞机重建**只出一个军力**（要满编须再重建一次）', () => {
    const ok = planRebuild({
      side: 'soviet',
      candidate: infDiv({
        id: 'air-il2',
        rebuildType: 'Aircraft',
        isAircraft: true,
        aircraftType: 'T',
        inDeadPile: true,
        printedSteps: 2,
      }),
      holdings: holdings({ tac: 1 }),
      facts: facts(),
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.data.placements[0]!.stepsAfter).toBe(1)
  })

  it('13.5f：无友方空军基地 ⇒ 拒', () => {
    const outcome = planRebuild({
      side: 'axis',
      candidate: infDiv({
        id: 'air-f',
        rebuildType: 'Aircraft',
        isAircraft: true,
        aircraftType: 'F',
        inDeadPile: true,
        printedSteps: 2,
      }),
      holdings: holdings({ ftr: 2 }),
      facts: facts({ hasFriendlyAirBase: () => false, friendlyAirBaseHex: () => null }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('13.5f')
  })
})
