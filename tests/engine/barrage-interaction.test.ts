import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  BARRAGE_COLUMN_SHIFTS,
  BARRAGE_NO_SPOTTER_SHIFT_LEFT,
  BARRAGE_STEP_IDS,
  barrageAircraftFacts,
  barrageCostT,
  barrageStepChecklist,
  barrageTableMeta,
  barrageTerrainLines,
  beginBarrage,
  declareBarrageShifts,
  hasReachedBarrageStep,
  isFacilityBarrage,
  planBarrageOutcome,
  planBarrageSupply,
  resolveBarrage,
  resolveBarrageDice,
  roundBarrageValue,
  validateBarrageLossAllocation,
  type BarrageInteractionState,
} from '@/engine/rules'

/**
 * 轰炸交互（C7，OCS 10.0）测试 —— 断言到条文一级
 *
 * 10.0 通用流程顺序（加总轰炸值 → 定初始列 → 按该列付火炮补给 → 列横移 → 掷 2 骰 →
 * 结算结果）；至少 1 点轰炸值才可用表；10.0d 整体目标；10.0e-A/B/C/D/E/F 的限制与阶段；
 * 10.0a 目标玩家选地形与承受损失单位；10.0b 观察员与低空扫射；10.1b 火炮补给（初始列 / 同源 /
 * 禁部队储备 / 付不出即取消）；10.2b 短程 +1；10.2c 空军无补给；
 * 10.0c 对设施（掷 1 骰、无横移、不需观察员；基地降级 / 逐机掷骰 / 港口累计 / 运输破坏）。
 */

const unwrap = <T>(
  outcome: { ok: true; data: T } | { ok: false; rule: string; reason: string },
): T => {
  if (!outcome.ok) throw new Error(`预期成功，实得失败：${outcome.rule} / ${outcome.reason}`)
  return outcome.data
}

const HEX: HexRef = { col: 36, row: 13 }

/** 一个火炮营（印刷轰炸值 8 ⇒ 轰炸表初始列 `8-11`，该列成本 2 T） */
const artillery = (over: Partial<Parameters<typeof beginBarrage>[0]['units'][number]> = {}) => ({
  unitId: 'art-1',
  printedValue: 8,
  ...over,
})

/** 走完 ①宣布 → ②补给 → ③横移，停在第 4 步（掷骰） */
function toDiceStep(
  over: Partial<Parameters<typeof beginBarrage>[0]> = {},
  shift: Partial<Parameters<typeof declareBarrageShifts>[1]> = {},
  supply: Partial<Parameters<typeof planBarrageSupply>[1]> = {},
): BarrageInteractionState {
  const declared = unwrap(
    beginBarrage({
      kind: 'artillery',
      phase: 'combat',
      targetKind: 'combatUnits',
      targetHex: HEX,
      units: [artillery()],
      ...over,
    }),
  )
  const paid = unwrap(planBarrageSupply(declared, { availableT: 10, fromSameHq: true, ...supply }))
  return unwrap(declareBarrageShifts(paid.state, shift)).state
}

/* ────────────────────────────── ① 10.0d / 10.0e 宣布目标与轰炸值 ────────────────────────────── */

describe('10.0d / 10.0e：宣布整体目标与轰炸值分配', () => {
  it('10.0：加总轰炸值 → 定初始列与**该列**的 T 成本；下一步是付补给', () => {
    const state = unwrap(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery(), artillery({ unitId: 'art-2', printedValue: 3 })],
      }),
    )
    expect(state.totalValue).toBe(11)
    // 8 + 3 = 11 落在 `8-11` 列（index 4），该列成本 2 T
    expect(state.table).toMatchObject({
      tableId: 'barrage',
      initialColumn: 4,
      columnLabel: '8-11',
      costT: 2,
    })
    expect(state.step).toBe('supply')
    expect(state.finished).toBe(false)
  })

  it('10.0d：整体目标决定用哪张表（战斗单位 ⇒ 轰炸表；设施 ⇒ 对设施轰炸表）', () => {
    const units = unwrap(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
      }),
    )
    expect(units.table.tableId).toBe('barrage')
    expect(isFacilityBarrage(units)).toBe(false)

    const facility = unwrap(
      beginBarrage({
        kind: 'air',
        phase: 'movement',
        targetKind: 'airBase',
        targetHex: HEX,
        units: [artillery({ printedValue: 11 })],
      }),
    )
    expect(facility.table.tableId).toBe('barrage-vs-facility')
    expect(isFacilityBarrage(facility)).toBe(true)
  })

  it('10.0：至少需要 1 点轰炸值才可使用轰炸表（不允许零点轰炸）', () => {
    const outcome = beginBarrage({
      kind: 'artillery',
      phase: 'combat',
      targetKind: 'combatUnits',
      targetHex: HEX,
      units: [artillery({ printedValue: 0 })],
    })
    expect(outcome).toMatchObject({ ok: false, rule: '10.0', reason: 'belowMinBarrageValue' })
  })

  it('10.0：没有参炸单位即无从轰炸', () => {
    expect(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [],
      }),
    ).toMatchObject({ ok: false, rule: '10.0', reason: 'noBarrageUnit' })
  })

  it('10.0e-F：一次轰炸只能使用同一类型（火炮/海军/空军其一）', () => {
    expect(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
        facts: { mixedKinds: true },
      }),
    ).toMatchObject({ ok: false, rule: '10.0e-F', reason: 'mixedBarrageKinds' })
  })

  it('10.0e-B：不得拆分轰炸值、不得低于印刷值', () => {
    expect(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
        facts: { splitValue: true },
      }),
    ).toMatchObject({ ok: false, rule: '10.0e-B', reason: 'cannotSplitBarrageValue' })
    expect(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
        facts: { belowPrintedValue: true },
      }),
    ).toMatchObject({ ok: false, rule: '10.0e-B', reason: 'belowPrintedBarrageValue' })
  })

  it('10.0e-B：一个单位每阶段只能轰炸一次', () => {
    expect(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
        facts: { unitAlreadyBarragedThisPhase: true },
      }),
    ).toMatchObject({ ok: false, rule: '10.0e-B', reason: 'unitAlreadyBarraged' })
  })

  it('10.0e-A：每格每阶段只允许被轰炸一次（低空扫射除外）', () => {
    const base = {
      kind: 'artillery' as const,
      phase: 'combat' as const,
      targetKind: 'combatUnits' as const,
      targetHex: HEX,
      units: [artillery()],
    }
    expect(beginBarrage({ ...base, facts: { hexAlreadyBarragedThisPhase: true } })).toMatchObject({
      ok: false,
      rule: '10.0e-A',
      reason: 'hexAlreadyBarraged',
    })
    // 低空扫射是例外（10.0e-A/C），但必须有正确观察员（10.0b）
    expect(
      beginBarrage({
        kind: 'air',
        phase: 'movement',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery({ printedValue: 8, rangeFromBase: 3 })],
        facts: { hexAlreadyBarragedThisPhase: true, hipShoot: true, hasSpotter: true },
      }).ok,
    ).toBe(true)
  })

  it('10.0b：低空扫射必须有正确的观察员（无论用哪张表）', () => {
    expect(
      beginBarrage({
        kind: 'air',
        phase: 'movement',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery({ rangeFromBase: 3 })],
        facts: { hipShoot: true, hasSpotter: false },
      }),
    ).toMatchObject({ ok: false, rule: '10.0b', reason: 'hipShootNeedsCorrectSpotter' })
  })

  it('10.0e-C/D：阶段门槛（空军＝移动/反应/进击；火炮＝战斗/反应/进击）', () => {
    expect(
      beginBarrage({
        kind: 'air',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
      }),
    ).toMatchObject({ ok: false, rule: '10.0e-C', reason: 'wrongPhaseForair:combat' })
    expect(
      beginBarrage({
        kind: 'artillery',
        phase: 'movement',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
      }),
    ).toMatchObject({ ok: false, rule: '10.0e-D', reason: 'wrongPhaseForartillery:movement' })
  })

  it('13.4a：火炮处于预备/战略模式⇒不得轰炸（只要有一个即拒）', () => {
    expect(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery(), artillery({ unitId: 'art-2', inReserveOrStrat: true })],
      }),
    ).toMatchObject({
      ok: false,
      rule: '13.4a',
      reason: 'artilleryInReserveOrStratCannotBarrage',
    })
  })
})

/* ────────────────────────────── ② 10.1b / 10.2c 补给 ────────────────────────────── */

describe('10.1b / 10.2c：按初始列支付战斗补给', () => {
  const declared = () =>
    unwrap(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
      }),
    )

  it('10.1b：火炮按**初始列**成本支付（8 ⇒ 2 T）', () => {
    const paid = unwrap(planBarrageSupply(declared(), { availableT: 2, fromSameHq: true }))
    expect(paid.state.supply).toMatchObject({ requiredT: 2, paid: true, waived: false })
    expect(paid.state.step).toBe('shifts')
  })

  it('10.1b：付不出即不能执行（调用方应整次取消，且不视为已轰炸过）', () => {
    expect(planBarrageSupply(declared(), { availableT: 1, fromSameHq: true })).toMatchObject({
      ok: false,
      rule: '10.1b',
      reason: 'cannotAfford',
    })
  })

  it('10.1b-C：轰炸永远不能使用部队储备', () => {
    expect(
      planBarrageSupply(declared(), { availableT: 9, usedInternalStocks: true, fromSameHq: true }),
    ).toMatchObject({ ok: false, rule: '10.1b-C', reason: 'internalStocksForbidden' })
  })

  it('10.1b-A：多单位齐射须来自同一指挥部；不用指挥部则须来自同一补给站', () => {
    const multi = unwrap(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery(), artillery({ unitId: 'art-2' })],
      }),
    )
    expect(planBarrageSupply(multi, { availableT: 9 })).toMatchObject({
      ok: false,
      rule: '10.1b-A',
      reason: 'mixedSupplySources',
    })
    expect(planBarrageSupply(multi, { availableT: 9, fromSameHq: true }).ok).toBe(true)
    expect(planBarrageSupply(multi, { availableT: 9, fromSameDump: true }).ok).toBe(true)
  })

  it('10.2c：空军轰炸**无**补给消耗', () => {
    const air = unwrap(
      beginBarrage({
        kind: 'air',
        phase: 'movement',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery({ rangeFromBase: 3 })],
      }),
    )
    const paid = unwrap(planBarrageSupply(air, { availableT: 0 }))
    expect(paid.state.supply).toMatchObject({
      requiredT: 0,
      paid: true,
      waived: true,
      rule: '10.2c',
    })
  })

  it('步骤顺序：不在补给步调用即拒绝（顺序不可颠倒）', () => {
    const paid = unwrap(planBarrageSupply(declared(), { availableT: 9, fromSameHq: true }))
    expect(planBarrageSupply(paid.state, { availableT: 9 })).toMatchObject({
      ok: false,
      reason: 'notAtSupplyStep:shifts',
    })
  })
})

/* ────────────────────────────── ③ 10.0a / 10.0b / 10.2b 列横移 ────────────────────────────── */

describe('10.0a / 10.0b / 10.2b：列横移确认', () => {
  it('10.0a：地形横移由**目标玩家**选择（Close −1 / Extr Close −2 / Open 0）', () => {
    expect(toDiceStep({}, { terrainLine: 'Open' }).shifts?.terrain).toBe(0)
    expect(toDiceStep({}, { terrainLine: 'Close' }).shifts?.terrain).toBe(-1)
    expect(toDiceStep({}, { terrainLine: 'Extr Close' }).shifts?.terrain).toBe(-2)
  })

  it('★ 10.0a：地形线必须由**目标格内存在的地形**产生（不能任取最有利的一条）', () => {
    // 目标格候选地形 → 可提供的战斗线（顺序照 TEC）
    expect(barrageTerrainLines(['Open', 'Woods'])).toEqual(['Open', 'Close'])
    expect(barrageTerrainLines(['Minor City'])).toEqual(['Very Close'])
    // 格边地形不参与本项（10.0c 同口径：地形横移只来自格内地形）
    expect(barrageTerrainLines(['Minor River', 'Railroad'])).toEqual([])

    // 已付补给的横移步状态（与 `toDiceStep` 同路，只是把横移留到本用例里做）
    const paid = unwrap(
      planBarrageSupply(
        unwrap(
          beginBarrage({
            kind: 'artillery',
            phase: 'combat',
            targetKind: 'combatUnits',
            targetHex: HEX,
            units: [artillery()],
          }),
        ),
        { availableT: 9, fromSameHq: true },
      ),
    ).state

    // 给出候选集时校验：目标格只有 Open/Woods ⇒ 选 Extr Close 被拒（否则白拿左移 2）
    expect(
      declareBarrageShifts(paid, {
        terrainLine: 'Extr Close',
        terrainCandidates: ['Open', 'Woods'],
      }),
    ).toMatchObject({ ok: false, rule: '10.0a', reason: 'terrainLineNotInTargetHex:Extr Close' })
    // 格内确实有该地形线则放行
    expect(
      declareBarrageShifts(paid, { terrainLine: 'Close', terrainCandidates: ['Open', 'Woods'] }).ok,
    ).toBe(true)
  })

  it('10.0a：密度 / 工事 / 地形 / 战略模式可叠加，且横移后夹取到表列范围', () => {
    const state = toDiceStep(
      {},
      { terrainLine: 'Close', hedgehogLevel: 1, enemyREInHex: 1, stratModeInHex: true },
    )
    expect(state.shifts).toMatchObject({
      density: -1,
      hedgehog: -1,
      terrain: -1,
      stratMode: 3,
      total: 0,
    })
    // 初始列 4 且无净横移 ⇒ 仍为 4
    expect(state.finalColumn).toBe(4)
    // 越界一律夹取：初始列 4 + 大量左移 ⇒ 0
    const clamped = toDiceStep({}, { hasSpotter: false, terrainLine: 'Extr Close' })
    expect(clamped.finalColumn).toBe(0)
  })

  it('10.0b：无正确观察员 ⇒ 左移 3 列', () => {
    expect(toDiceStep({}, { hasSpotter: false }).shifts?.spotter).toBe(-3)
    expect(toDiceStep({}, { hasSpotter: true }).shifts?.spotter).toBe(0)
  })

  it('10.2b：全部飞机在基地 10 格内 ⇒ 右移 1；**战略轰炸机永远不享受**', () => {
    const air = (over: Record<string, unknown>) =>
      toDiceStep(
        {
          kind: 'air',
          phase: 'movement',
          units: [artillery({ rangeFromBase: 10, ...over })],
        },
        { rangeFromBase: 10, ...over },
      )
    expect(air({}).shifts?.shortRange).toBe(1)
    expect(air({ rangeFromBase: 11 }).shifts?.shortRange).toBe(0)
    expect(air({ strategicBomber: true }).shifts?.shortRange).toBe(0)
  })

  it('10.0c：对设施轰炸**没有**横移（传了地形也不生效）', () => {
    const facility = unwrap(
      beginBarrage({
        kind: 'air',
        phase: 'movement',
        targetKind: 'airBase',
        targetHex: HEX,
        units: [artillery({ printedValue: 11 })],
      }),
    )
    const paid = unwrap(planBarrageSupply(facility, { availableT: 0 }))
    const shifted = unwrap(
      declareBarrageShifts(paid.state, { terrainLine: 'Extr Close', hasSpotter: false }),
    ).state
    expect(shifted.shifts?.total).toBe(0)
    expect(shifted.finalColumn).toBe(shifted.table.initialColumn)
    expect(shifted.shifts?.detail.join()).toContain('10.0c')
  })

  it('步骤顺序：不在横移步调用即拒绝（此时仍停在补给步）', () => {
    const declared = unwrap(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
      }),
    )
    expect(declareBarrageShifts(declared, {})).toMatchObject({
      ok: false,
      reason: 'notAtShiftsStep:supply',
    })
  })
})

/* ────────────────────────────── ④ 10.0 / 10.0c 掷骰 ────────────────────────────── */

describe('10.0 / 10.0c：掷骰结算', () => {
  it('10.0a：2 骰查轰炸表（值 8 → 列 `8-11`；骰 7 → DG）', () => {
    const rolled = unwrap(resolveBarrageDice(toDiceStep(), { die: 7 }))
    expect(rolled.awaitingHalfDie).toBe(false)
    expect(rolled.state.result?.code).toBe('DG')
    expect(rolled.state.outcome).toMatchObject({
      table: 'barrage',
      value: { dg: true, stepLosses: 0 },
    })
    expect(rolled.state.step).toBe('outcome')
  })

  it('10.0a：`1/2` 须再掷**取整骰**，未给则停在掷骰步等它', () => {
    // 值 8（列 `8-11`）+ 骰 12 ⇒ 格值 `1/2`
    const awaiting = unwrap(resolveBarrageDice(toDiceStep(), { die: 12 }))
    expect(awaiting.awaitingHalfDie).toBe(true)
    expect(awaiting.state.step).toBe('dice')
    expect(awaiting.state.dice).toMatchObject({ die: 12, awaitingHalfDie: true })

    // 取整骰 4 ⇒ 损 1 点军力并 DG
    const loss = unwrap(resolveBarrageDice(toDiceStep(), { die: 12, halfDie: 4 }))
    expect(loss.state.outcome).toMatchObject({ value: { dg: true, stepLosses: 1 } })
    // 取整骰 3 ⇒ 只 DG
    const dgOnly = unwrap(resolveBarrageDice(toDiceStep(), { die: 12, halfDie: 3 }))
    expect(dgOnly.state.outcome).toMatchObject({ value: { dg: true, stepLosses: 0 } })
  })

  it('10.0a：`[1/2]` 在「飞机轰炸 / 缺观察员 / 等级≥3 工事」时**直接视为 DG**', () => {
    // 值 117 ⇒ 最右列；骰 5 ⇒ `[1/2]`；空军轰炸 ⇒ 视为 DG（不掷取整骰）
    const air = toDiceStep({
      kind: 'air',
      phase: 'movement',
      units: [artillery({ printedValue: 117, rangeFromBase: 3 })],
    })
    const rolled = unwrap(resolveBarrageDice(air, { die: 5 }))
    expect(rolled.awaitingHalfDie).toBe(false)
    expect(rolled.state.outcome).toMatchObject({ value: { dg: true, stepLosses: 0 } })
    // 缺观察员同样视为 DG
    const noSpotter = toDiceStep(
      { units: [artillery({ printedValue: 117 })] },
      { hasSpotter: false },
    )
    expect(unwrap(resolveBarrageDice(noSpotter, { die: 5 })).state.outcome).toMatchObject({
      value: { dg: true, stepLosses: 0 },
    })
  })

  it('10.0c：对设施掷**一个骰子**（值 11 → 列 `11-20`；骰 5 → `1 * (4)`）', () => {
    const facility = unwrap(
      beginBarrage({
        kind: 'air',
        phase: 'movement',
        targetKind: 'airBase',
        targetHex: HEX,
        units: [artillery({ printedValue: 11 })],
      }),
    )
    const paid = unwrap(planBarrageSupply(facility, { availableT: 0 }))
    const shifted = unwrap(declareBarrageShifts(paid.state, {})).state
    const rolled = unwrap(resolveBarrageDice(shifted, { die: 5 }))
    expect(rolled.state.result?.code).toBe('1 * (4)')
    expect(rolled.state.step).toBe('outcome')
  })

  it('掷骰越界抛错（轰炸骰 2–12；设施骰 1–6）', () => {
    expect(() => resolveBarrageDice(toDiceStep(), { die: 13 })).toThrow(RangeError)
    expect(() => resolveBarrageDice(toDiceStep(), { die: 1 })).toThrow(RangeError)
  })

  it('步骤顺序：不在掷骰步调用即拒绝', () => {
    const rolled = unwrap(resolveBarrageDice(toDiceStep(), { die: 7 })).state
    expect(resolveBarrageDice(rolled, { die: 7 })).toMatchObject({
      ok: false,
      reason: 'notAtDiceStep:outcome',
    })
  })
})

/* ────────────────────────────── ⑤ 10.0a / 10.0c 结果确认 ────────────────────────────── */

describe('10.0a：结果确认（DG 强制 + 目标玩家分配损失）', () => {
  const resolved = (die: number, halfDie?: number) =>
    unwrap(
      resolveBarrageDice(toDiceStep({ units: [artillery({ printedValue: 69 })] }), {
        die,
        ...(halfDie === undefined ? {} : { halfDie }),
      }),
    ).state

  it('10.0a：DG ⇒ 该格**全体战斗单位**进入 DG（无损失分配）', () => {
    const state = toDiceStep()
    const rolled = unwrap(resolveBarrageDice(state, { die: 7 })).state
    const done = unwrap(planBarrageOutcome(rolled, { eligibleUnitIds: ['e1', 'e2'] }))
    expect(done.patches).toEqual([
      { unitId: 'e1', dg: true },
      { unitId: 'e2', dg: true },
    ])
    expect(done.state.finished).toBe(true)
    expect(done.state.step).toBe('done')
  })

  it('10.0a：`#` 结果须由目标玩家**足额**分配损失（列 `69-116` + 骰 12 ⇒ 2 点）', () => {
    const rolled = resolved(12)
    expect(rolled.result?.code).toBe('2')
    // 少给 ⇒ 拒绝
    expect(
      planBarrageOutcome(rolled, { eligibleUnitIds: ['e1'], losses: [{ unitId: 'e1', steps: 1 }] }),
    ).toMatchObject({ ok: false, reason: 'lossAllocationMismatch:1!=2' })
    // 多给 ⇒ 拒绝
    expect(
      planBarrageOutcome(rolled, { eligibleUnitIds: ['e1'], losses: [{ unitId: 'e1', steps: 3 }] }),
    ).toMatchObject({ ok: false, reason: 'lossAllocationMismatch:3!=2' })
    // 足额 ⇒ 通过，且 DG 与损失一并产出
    const done = unwrap(
      planBarrageOutcome(rolled, {
        eligibleUnitIds: ['e1', 'e2'],
        losses: [
          { unitId: 'e1', steps: 1 },
          { unitId: 'e2', steps: 1 },
        ],
      }),
    )
    expect(done.patches).toEqual([
      { unitId: 'e1', dg: true },
      { unitId: 'e2', dg: true },
      { unitId: 'e1', steps: 1 },
      { unitId: 'e2', steps: 1 },
    ])
  })

  it('10.0a：承受者必须落在**目标格内**（非目标格单位即拒）', () => {
    const rolled = resolved(12)
    expect(
      planBarrageOutcome(rolled, {
        eligibleUnitIds: ['e1'],
        losses: [
          { unitId: 'e1', steps: 1 },
          { unitId: 'other', steps: 1 },
        ],
      }),
    ).toMatchObject({ ok: false, reason: 'unitNotInTargetHex:other' })
  })

  it('10.0a：无损失结果却给出分配 ⇒ 拒绝；`-` 结果无效果', () => {
    const dgOnly = unwrap(resolveBarrageDice(toDiceStep(), { die: 7 })).state
    expect(
      planBarrageOutcome(dgOnly, { eligibleUnitIds: ['e1'], losses: [{ unitId: 'e1', steps: 1 }] }),
    ).toMatchObject({ ok: false, reason: 'noLossExpected:1' })
    // 值 1（最左列）+ 骰 2 ⇒ `-`：不 DG、不损军力
    const none = unwrap(
      resolveBarrageDice(toDiceStep({ units: [artillery({ printedValue: 1 })] }), { die: 2 }),
    ).state
    const done = unwrap(planBarrageOutcome(none, { eligibleUnitIds: ['e1'] }))
    expect(done.state.outcome).toMatchObject({ value: { dg: false, stepLosses: 0 } })
    expect(done.patches).toEqual([])
  })

  it('12.4 风格校验：分配明细的形状（只允许非负整数步数）', () => {
    expect(
      validateBarrageLossAllocation({
        required: 1,
        losses: [{ unitId: 'e1', steps: 1.5 }],
        eligibleUnitIds: ['e1'],
      }),
    ).toMatchObject({ ok: false, reason: 'invalidSteps:e1' })
    expect(
      validateBarrageLossAllocation({
        required: 1,
        losses: [{ unitId: 'e1', steps: 1 }],
        eligibleUnitIds: ['e1'],
      }),
    ).toMatchObject({ ok: true, allocated: 1 })
  })
})

describe('10.0c：对设施结果确认（A 空军基地 / B 港口 / C 运输破坏）', () => {
  /** 对设施轰炸：值 11 → 列 `11-20`；空军 ⇒ 免费；无横移 */
  function facilityAt(targetKind: 'airBase' | 'port' | 'trainbusting', valueRange = 11) {
    const declared = unwrap(
      beginBarrage({
        kind: 'air',
        phase: 'movement',
        targetKind,
        targetHex: HEX,
        units: [artillery({ printedValue: valueRange })],
      }),
    )
    const paid = unwrap(planBarrageSupply(declared, { availableT: 0 }))
    return unwrap(declareBarrageShifts(paid.state, {})).state
  }

  it('10.0c-A：不带括号的数字 ⇒ 基地降级（最低 1 级）；**简易机场永不降低等级**', () => {
    // 值 11 + 骰 5 ⇒ `1 * (4)`：基地 3 → 2
    const rolled = unwrap(resolveBarrageDice(facilityAt('airBase'), { die: 5 })).state
    const done = unwrap(planBarrageOutcome(rolled, { baseLevel: 3 }))
    expect(done.facility).toMatchObject({ baseLevelAfter: 2 })
    // 简易机场不变
    const airstrip = unwrap(
      planBarrageOutcome(unwrap(resolveBarrageDice(facilityAt('airBase'), { die: 5 })).state, {
        baseLevel: 3,
        isAirstrip: true,
      }),
    )
    expect(airstrip.facility).toMatchObject({ baseLevelAfter: 3 })
    // 已在 1 级 ⇒ 不低于 1
    const floor = unwrap(
      planBarrageOutcome(unwrap(resolveBarrageDice(facilityAt('airBase'), { die: 5 })).state, {
        baseLevel: 1,
      }),
    )
    expect(floor.facility).toMatchObject({ baseLevelAfter: 1 })
  })

  it('10.0c-A：括号结果 ⇒ 该格**每架**敌机各掷骰，≥# 者损 1 军力', () => {
    const rolled = unwrap(resolveBarrageDice(facilityAt('airBase'), { die: 5 })).state
    const done = unwrap(
      planBarrageOutcome(rolled, {
        baseLevel: 3,
        aircraft: [
          { id: 'p1', roll: 4 },
          { id: 'p2', roll: 3 },
        ],
      }),
    )
    expect(done.facility).toMatchObject({ baseLevelAfter: 2 })
    expect(rolled.outcome).toBeUndefined() // 设施结果在确认步产生
    const outcome = done.state.outcome
    expect(outcome?.table).toBe('barrage-vs-facility')
    if (outcome?.table === 'barrage-vs-facility') {
      expect(outcome.value.aircraftLosses).toEqual([
        { id: 'p1', roll: 4, stepLoss: true },
        { id: 'p2', roll: 3, stepLoss: false },
      ])
    }
  })

  it('10.0c-B：港口只有 1/2 造成伤害，且**累计上限 4 点**', () => {
    // 值 41 → 列 `41-80`；骰 6 ⇒ `2 * (3)`
    const rolled = unwrap(resolveBarrageDice(facilityAt('port', 41), { die: 6 })).state
    expect(rolled.result?.code).toBe('2 * (3)')
    const done = unwrap(planBarrageOutcome(rolled, { portDamageBefore: 3 }))
    expect(done.facility).toMatchObject({ portDamage: 4 }) // 3 + 2 ⇒ 封顶 4
  })

  it('10.0c-C：运输破坏须 `*` 结果才放置标记', () => {
    // 值 11 + 骰 5 ⇒ `1 * (4)`：含 `*` ⇒ 放置
    const placed = unwrap(
      planBarrageOutcome(unwrap(resolveBarrageDice(facilityAt('trainbusting'), { die: 5 })).state),
    )
    expect(placed.facility).toMatchObject({ trainbustingPlaced: true })
    // 值 11 + 骰 1 ⇒ `-`：无效果
    const none = unwrap(
      planBarrageOutcome(unwrap(resolveBarrageDice(facilityAt('trainbusting'), { die: 1 })).state),
    )
    expect(none.facility).toMatchObject({ trainbustingPlaced: false })
  })
})

/* ────────────────────────────── 10.2b 短程加成的数据源 ────────────────────────────── */

describe('10.2b 短程加成：任务级空军事实的来源', () => {
  /** 空军轰炸：kind='air'、移动阶段、目标战斗单位；走到掷骰步 */
  function airToDice(
    units: readonly {
      id: string
      printedValue: number
      rangeFromBase?: number
      strategicBomber?: boolean
    }[],
    shift: Partial<Parameters<typeof declareBarrageShifts>[1]> = {},
  ): BarrageInteractionState {
    const declared = unwrap(
      beginBarrage({
        kind: 'air',
        phase: 'movement',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: units.map((unit) => ({
          unitId: unit.id,
          printedValue: unit.printedValue,
          ...(unit.rangeFromBase === undefined ? {} : { rangeFromBase: unit.rangeFromBase }),
          ...(unit.strategicBomber === true ? { strategicBomber: true } : {}),
        })),
      }),
    )
    // 10.2c：空军轰炸无补给消耗
    const paid = unwrap(planBarrageSupply(declared, { availableT: 0 }))
    return unwrap(declareBarrageShifts(paid.state, shift)).state
  }

  it('10.2b：汇总取**最远者**；14.1e：任一战略轰炸机 ⇒ 整次任务按战略轰炸机处理', () => {
    expect(barrageAircraftFacts([])).toEqual({ rangeFromBase: null, strategicBomber: false })
    expect(
      barrageAircraftFacts([
        { unitId: 'a', printedValue: 4, rangeFromBase: 3 },
        { unitId: 'b', printedValue: 4, rangeFromBase: 9 },
      ]),
    ).toEqual({ rangeFromBase: 9, strategicBomber: false })
    expect(
      barrageAircraftFacts([
        { unitId: 'a', printedValue: 4, rangeFromBase: 3 },
        { unitId: 'b', printedValue: 9, rangeFromBase: 3, strategicBomber: true },
      ]),
    ).toEqual({ rangeFromBase: 3, strategicBomber: true })
    // 参炸单位里没有飞机（如火炮）⇒ 不给 rangeFromBase（10.1a 的射程另判）
    expect(barrageAircraftFacts([{ unitId: 'art', printedValue: 8 }]).rangeFromBase).toBeNull()
  })

  it('10.2b：**所有**飞机都在基地 10 格内才右移 1（11 格者即破坏条件）', () => {
    const near = airToDice([
      { id: 'f1', printedValue: 4, rangeFromBase: 10 },
      { id: 'f2', printedValue: 4, rangeFromBase: 3 },
    ])
    expect(near.shifts?.shortRange).toBe(BARRAGE_COLUMN_SHIFTS.allAircraftInShortRange)
    const far = airToDice([
      { id: 'f1', printedValue: 4, rangeFromBase: 3 },
      { id: 'f2', printedValue: 4, rangeFromBase: 11 },
    ])
    expect(far.shifts?.shortRange).toBe(0)
  })

  it('14.1e：战略轰炸机参炸 ⇒ 永不享短程 +1，且无观察员惩罚**永久生效**（10.0b）', () => {
    const state = airToDice([
      { id: 's1', printedValue: 9, rangeFromBase: 3, strategicBomber: true },
    ])
    expect(state.shifts?.shortRange).toBe(0)
    expect(state.shifts?.spotter).toBe(-BARRAGE_NO_SPOTTER_SHIFT_LEFT)
  })

  it('10.2b：显式给出的事实在位时**优先**于自动汇总（便于房规/复算注入）', () => {
    const state = airToDice([{ id: 'f1', printedValue: 4, rangeFromBase: 3 }], {
      rangeFromBase: 20,
    })
    expect(state.shifts?.shortRange).toBe(0)
  })

  it('10.2b：掷骰步复用**汇总后**的事实（展示与查表同一口径）', () => {
    const state = airToDice([{ id: 'f1', printedValue: 4, rangeFromBase: 4 }])
    expect(state.shiftInput?.rangeFromBase).toBe(4)
    const rolled = unwrap(resolveBarrageDice(state, { die: 7 })).state
    // 右移 1 列生效，且掷骰步算出的列位与横移步**展示的列位一致**（同一 shiftInput）
    expect(rolled.result?.shifts.shortRange).toBe(BARRAGE_COLUMN_SHIFTS.allAircraftInShortRange)
    expect(rolled.result?.finalColumn).toBe(state.finalColumn)
  })
})

/* ────────────────────────────── 步骤清单 ────────────────────────────── */
describe('步骤清单（供界面显示还差哪几步）', () => {
  it('步骤 id 顺序与规则书 10.0 通用流程一致', () => {
    expect(BARRAGE_STEP_IDS).toEqual(['declare', 'supply', 'shifts', 'dice', 'outcome', 'done'])
  })

  it('hasReachedBarrageStep / barrageStepChecklist 随推进更新', () => {
    const declared = unwrap(
      beginBarrage({
        kind: 'artillery',
        phase: 'combat',
        targetKind: 'combatUnits',
        targetHex: HEX,
        units: [artillery()],
      }),
    )
    // `step` 表示「下一步待办」⇒ 已到达 `supply`（即将执行），尚未到达 `shifts`
    expect(hasReachedBarrageStep(declared, 'declare')).toBe(true)
    expect(hasReachedBarrageStep(declared, 'supply')).toBe(true)
    expect(hasReachedBarrageStep(declared, 'shifts')).toBe(false)
    const checklist = barrageStepChecklist(declared)
    expect(checklist[0]).toMatchObject({ step: 'declare', done: true })
    expect(checklist[1]).toMatchObject({ step: 'supply', done: false })
  })
})

/**
 * 5.10b-A / 5.8 / 4.2：模式折算进轰炸值 + 小数取整（B1 步骤③ 与配套）
 *
 * 修前：`beginBarrage` 直接按印值求和，DG 火炮按满值轰炸（模式矩阵算了减半但没人用）；
 * 而一旦把 DG 折算接上（印值 5 → 2.5），不取整就会让 `resolveNumericColumnIndex` 找不到区间
 * 而抛 TableLookupError。故这两件事必须同批交付。
 */
describe('5.10b-A / 5.8 / 4.2：轰炸值的模式折算与取整', () => {
  const declare = (
    units: Parameters<typeof beginBarrage>[0]['units'],
  ): ReturnType<typeof beginBarrage> =>
    beginBarrage({
      kind: 'artillery',
      phase: 'combat',
      targetKind: 'combatUnits',
      targetHex: HEX,
      units,
    })

  it('4.2：取整口径与 9.7 同源（四舍五入：小数 ≥ .5 进位）', () => {
    expect(roundBarrageValue(2.5)).toBe(3)
    expect(roundBarrageValue(2.4)).toBe(2)
    expect(roundBarrageValue(0.5)).toBe(1)
    expect(roundBarrageValue(8)).toBe(8)
  })

  it('5.10b-A：DG 火炮印值 5 ⇒ 合并 2.5、取整 3；两个值都留在状态里供明细展示', () => {
    const state = unwrap(declare([artillery({ printedValue: 5, dg: true })]))
    expect(state.rawTotalValue).toBe(2.5)
    expect(state.totalValue).toBe(3)
    // 折算后的每单位分配值也可见（印值 × ½）
    expect(state.units[0]!.assignedValue).toBe(2.5)
  })

  it('5.10b-A：DG 与非 DG 混编——各自折算后合并、再取整（合并先于取整）', () => {
    const state = unwrap(
      declare([
        artillery({ unitId: 'a', printedValue: 5, dg: true }), // 2.5
        artillery({ unitId: 'b', printedValue: 6 }), // 6
      ]),
    )
    expect(state.rawTotalValue).toBe(8.5)
    expect(state.totalValue).toBe(9)
  })

  it('对照：非 DG 的整数合计不因取整而改变（既有行为不变）', () => {
    const state = unwrap(declare([artillery()])) // 印值 8
    expect(state.rawTotalValue).toBe(8)
    expect(state.totalValue).toBe(8)
  })

  it('5.7b：本阶段刚释放的预备不折算（数值回到基础行）', () => {
    const state = unwrap(
      declare([artillery({ printedValue: 8, mode: 'reserve', releasedFromReserve: true })]),
    )
    expect(state.totalValue).toBe(8)
  })

  it('5.8：战略模式火炮轰炸值为零 ⇒ 达不到最低轰炸值而被拒', () => {
    const outcome = declare([artillery({ mode: 'strat' })])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.rule).toBe('10.0')
      expect(outcome.reason).toBe('belowMinBarrageValue')
    }
  })

  it('4.2 回归：小数轰炸值不再让取表抛错，且与取整后的整数调用同结果', () => {
    // 修前：2.5 既不落在 `2` 段也不落在 `3-4` 段 ⇒ TableLookupError
    expect(() => resolveBarrage({ die: 7, valueRange: 2.5 })).not.toThrow()
    expect(() => barrageTableMeta({ target: 'combatUnits', valueRange: 2.5 })).not.toThrow()
    expect(() => barrageCostT(2.5)).not.toThrow()
    expect(barrageTableMeta({ target: 'combatUnits', valueRange: 2.5 })).toEqual(
      barrageTableMeta({ target: 'combatUnits', valueRange: 3 }),
    )
    expect(barrageCostT(2.5)).toBe(barrageCostT(3))
  })
})

describe('专规 2.3d：苏军炮兵合并轰炸须同堆叠（第五批 A4）', () => {
  /*
   * 专规原文（Smolensk_Rules_v1.1.txt:329-331，§17.126 亲验）：
   * 「To combine for a single Barrage, all of the firing Soviet artillery units must be stacked together.」
   * ⇒ 带 `sov_artillery_stack_to_combine` 标签的参炸苏军炮兵 ≥2 时必须全部同格；
   *    标签驱动 ⇒ 无标签单位（含德军炮兵）不受此限（对照）。
   * ★ 测法边界：只钉 beginBarrage 的拒绝/放行两态；候选灰显（面板层）在 store 用例里钉。
   */
  const tagged = (hex: HexRef, unitId: string) => ({
    unitId,
    printedValue: 8,
    hex,
    sovArtilleryStackToCombine: true,
  })
  const declare = (units: Parameters<typeof beginBarrage>[0]['units']) =>
    beginBarrage({
      kind: 'artillery',
      phase: 'combat',
      targetKind: 'combatUnits',
      targetHex: HEX,
      units,
    })

  it('两门带标签苏炮分处两格 ⇒ 拒（专规 2.3d）', () => {
    const outcome = declare([tagged(HEX, 'su-arty-1'), tagged({ col: 37, row: 13 }, 'su-arty-2')])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('专规 2.3d')
  })

  it('同格 ⇒ 放行；跨格的无标签炮（含德军）不受此限（对照）', () => {
    expect(declare([tagged(HEX, 'su-arty-1'), tagged(HEX, 'su-arty-2')]).ok).toBe(true)
    // 带标签与不带标签混编：只有一枚带标签 ⇒ 不构成"合并"
    expect(declare([tagged(HEX, 'su-arty-1'), { unitId: 'ge-arty', printedValue: 8 }]).ok).toBe(
      true,
    )
    // 德军两门跨格（无标签）⇒ 不受此限
    expect(
      declare([
        { unitId: 'ge-arty-1', printedValue: 8, hex: HEX },
        { unitId: 'ge-arty-2', printedValue: 8, hex: { col: 37, row: 13 } },
      ]).ok,
    ).toBe(true)
  })
})
