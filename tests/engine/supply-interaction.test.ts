import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import {
  canDrawFromCarrier,
  DIRECT_DRAW_RANGE_MP,
  assessUnitSupply,
  beginSupplyCheck,
  canDirectDraw,
  chooseSupplySource,
  confirmOosResolution,
  confirmSupplyPickup,
  countSupplyDistance,
  eatingOffTheMapCostT,
  hasReachedSupplyStep,
  holdingsToT,
  isNormalizedHoldings,
  isSpBearingSource,
  planOosResolution,
  planSpMerge,
  planSpPayment,
  planSpSplit,
  planSupplyPickup,
  purposeLabel,
  supplyCoverage,
  supplyPath,
  supplyStepChecklist,
  supplySourceOptions,
  tToHoldings,
  T_PER_SP,
  type BaseSourceKind,
  type ExtenderView,
  type SupplyInteractionState,
  type ThrowHqView,
  type TraceSupplyFacts,
} from '@/engine/rules'

/**
 * 补给交互与 SP 管理（C8，OCS 12.0）测试
 *
 * 断言到**条文**一级：12.1a（拆分/加总/找零）、12.3（拖取与投递）、12.3a/12.3c（5 MP 与相邻即可）、
 * 12.3b-A/C/D（投递三禁令）、12.6a（三种追溯源）、12.6c（吃图上补给，含 6.5 RE ⇒ 4T）、
 * 12.6d/12.6e（断补标记与战略模式禁令）。
 *
 * 逻辑测试一律用**注入的假事实**（同一条竖列、每步 1 MP），使取费与阻断完全可控；
 * 另有一组「可视化原语与原单点查询互证」的断言，证明「界面画的覆盖范围/路径」与
 * 「规则判定用的距离」出自同一次搜索（12.3d）。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

/** 竖列走廊：col 36，row `row0 .. row0+span`（假事实，不读真实地形） */
function corridor(row0: number, span: number): HexRef[] {
  return Array.from({ length: span + 1 }, (_, index) => ({ col: 36, row: row0 + index }))
}

const at = (row: number): HexRef => ({ col: 36, row })
const key = (hex: HexRef): string => `${hex.col}.${hex.row}`

interface FakeFactsOptions {
  hexes: readonly HexRef[]
  /** 每步消耗（默认 1 MP） */
  cost?: number
  sources?: readonly { hex: HexRef; side: Side; kind: BaseSourceKind }[]
  extenders?: readonly ExtenderView[]
  throwHqs?: readonly ThrowHqView[]
  dumps?: readonly { hex: HexRef; side: Side }[]
  enemyCombat?: readonly HexRef[]
  enemyZoc?: readonly HexRef[]
}

/** 注入式假事实：完全确定，不依赖真实地图数据（与 trace-supply.test.ts 同法） */
function makeFacts(options: FakeFactsOptions): TraceSupplyFacts {
  const onMap = new Set(options.hexes.map(key))
  const enemyCombat = new Set((options.enemyCombat ?? []).map(key))
  const enemyZoc = new Set((options.enemyZoc ?? []).map(key))
  const cost = options.cost ?? 1
  return {
    onMap: (hex) => onMap.has(key(hex)),
    sourcesFor: (side) =>
      (options.sources ?? [])
        .filter((item) => item.side === side)
        .map(({ hex, kind }) => ({ hex, kind })),
    extendersFor: (side) =>
      (options.extenders ?? [])
        .filter((item) => item.side === side)
        .map(({ hex, mobility, rangeMp }) => ({ hex, mobility, rangeMp })),
    throwHqsFor: (side) => (options.throwHqs ?? []).filter((item) => item.side === side),
    dumpsFor: (side) =>
      (options.dumps ?? []).filter((item) => item.side === side).map((item) => item.hex),
    hasEnemyCombatUnit: (hex) => enemyCombat.has(key(hex)),
    inEnemyZoc: (hex) => enemyZoc.has(key(hex)),
    stepCost: (from, to) => (onMap.has(key(from)) && onMap.has(key(to)) ? cost : null),
  }
}

/** 交战中的某单位（12.6：只有战斗单位需要追溯补给） */
function unit(overrides: {
  id?: string
  side?: Side
  hex: HexRef
  isCombat?: boolean
  re?: number
  mode?: 'combat' | 'move' | 'reserve' | 'strat'
}): {
  id: string
  side: Side
  hex: HexRef
  isCombat: boolean
  re: number
  mode?: 'combat' | 'move' | 'reserve' | 'strat'
} {
  return {
    id: overrides.id ?? 'u1',
    side: overrides.side ?? 'axis',
    hex: overrides.hex,
    isCombat: overrides.isCombat ?? true,
    re: overrides.re ?? 4,
    ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
  }
}

/* ────────────────────────────── 12.1a SP / T ────────────────────────────── */

describe('12.1a SP 与 T 的拆分与加总', () => {
  it('1 SP = 4 T，且折算可往返', () => {
    expect(T_PER_SP).toBe(4)
    expect(holdingsToT({ sp: 2, t: 3 })).toBe(11)
    expect(tToHoldings(11)).toEqual({ sp: 2, t: 3 })
    expect(tToHoldings(0)).toEqual({ sp: 0, t: 0 })
  })

  it('「尽可能将 T 并为 SP」的规范形式是 T < 4', () => {
    expect(isNormalizedHoldings({ sp: 1, t: 3 })).toBe(true)
    expect(isNormalizedHoldings({ sp: 1, t: 4 })).toBe(false)
  })

  it('加总：T 满 4 并为等额 SP，总额不变（减少堆叠）', () => {
    const merged = planSpMerge({ holdings: { sp: 1, t: 6 } })
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.data.holdings).toEqual({ sp: 2, t: 2 })
    expect(merged.data.rule).toBe('12.1a')
  })

  it('加总：已是规范形式则原样返回（并说明未变）', () => {
    const merged = planSpMerge({ holdings: { sp: 3, t: 1 } })
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.data.holdings).toEqual({ sp: 3, t: 1 })
    expect(merged.data.detail).toContain('尽量并为 SP')
  })

  it('加总/拆分：非法输入一律拒绝', () => {
    expect(planSpMerge({ holdings: { sp: -1, t: 0 } })).toMatchObject({ ok: false, rule: '12.1a' })
    expect(planSpMerge({ holdings: { sp: 1, t: 0.5 } })).toMatchObject({ ok: false, rule: '12.1a' })
    expect(planSpSplit({ holdings: { sp: 1, t: 0 }, spToSplit: -1 })).toMatchObject({
      ok: false,
      rule: '12.1a',
    })
    expect(planSpSplit({ holdings: { sp: 1, t: 0 }, spToSplit: 2 })).toMatchObject({
      ok: false,
      reason: 'notEnoughSp:2>1',
    })
  })

  it('拆分：把整 SP 找零为 T，总额不变（可支付零钱）', () => {
    const split = planSpSplit({ holdings: { sp: 2, t: 1 }, spToSplit: 1 })
    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(split.data.holdings).toEqual({ sp: 1, t: 5 })
    expect(split.data.tAdded).toBe(4)
    expect(holdingsToT(split.data.holdings)).toBe(holdingsToT({ sp: 2, t: 1 }))
  })

  it('拆分 0 个 SP 即不变（界面「不拆分」入口）', () => {
    const split = planSpSplit({ holdings: { sp: 2, t: 3 }, spToSplit: 0 })
    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(split.data.holdings).toEqual({ sp: 2, t: 3 })
  })

  it('支付：手上 T 不够时自动找零一个整 SP，扣完后再并回 SP', () => {
    const paid = planSpPayment({ holdings: { sp: 1, t: 0 }, wantT: 1 })
    expect(paid.ok).toBe(true)
    if (!paid.ok) return
    expect(paid.data.splitNeeded).toBe(true)
    expect(paid.data.holdingsAfter).toEqual({ sp: 0, t: 3 })
  })

  it('支付：手上 T 够时直接扣，余额规范化', () => {
    const paid = planSpPayment({ holdings: { sp: 2, t: 3 }, wantT: 3 })
    expect(paid.ok).toBe(true)
    if (!paid.ok) return
    expect(paid.data.splitNeeded).toBe(false)
    expect(paid.data.holdingsAfter).toEqual({ sp: 2, t: 0 })
  })

  it('支付：不足或非法一律拒绝（不出现「有多少付多少」）', () => {
    expect(planSpPayment({ holdings: { sp: 0, t: 1 }, wantT: 2 })).toMatchObject({
      ok: false,
      reason: 'insufficientSpHoldings:2>1',
    })
    expect(planSpPayment({ holdings: { sp: 1, t: 0 }, wantT: -1 })).toMatchObject({ ok: false })
  })

  it('用途与条文对应（12.3 的用途清单）', () => {
    expect(purposeLabel('fuel')).toContain('12.5')
    expect(purposeLabel('combat')).toContain('12.4')
    expect(purposeLabel('refit')).toContain('15.1')
    expect(purposeLabel('internalStocks')).toContain('12.10')
    expect(purposeLabel('build')).toContain('13.8')
  })
})

/* ────────────────────────────── 12.3a / 12.3c 直接拖取 ────────────────────────────── */

describe('12.3a/12.3c 来源枚举：直接拖取（5 MP 或相邻）', () => {
  it('5 MP 内成立；12.3c 的终点取「单位格或其相邻格」中最近者', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(3) }) })
    const dump = options.find((option) => option.kind === 'dump')
    expect(dump).toBeDefined()
    expect(dump?.ok).toBe(true)
    // 12.3c：够到单位的相邻格（36.2）即足够 ⇒ 距离 2，路径终点是相邻格而非单位格
    expect(dump?.distanceMp).toBe(2)
    expect(dump?.path?.map(key)).toEqual(['36.0', '36.1', '36.2'])
    expect(dump?.viaAdjacency).toBe(true)
  })

  it('超出 5 MP 则不通过（有界搜索：超出预算即不给具体值）', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(7) }) })
    const dump = options.find((option) => option.kind === 'dump')
    expect(dump).toMatchObject({ ok: false, rule: '12.3a', reason: 'directDrawOutOfRange' })
    expect(dump?.distanceMp).toBeNull()
    expect(dump?.path).toBeNull()
    expect(DIRECT_DRAW_RANGE_MP).toBe(5)
  })

  it('12.3c 相邻即可：补给够到单位的**相邻格**即可（路径终点是相邻格而非单位格）', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    // 单位在 36.6：dump→36.5 恰为 5 MP ≤ 5，故单位仍可获得补给
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(6) }) })
    const dump = options.find((option) => option.kind === 'dump')
    expect(dump).toMatchObject({ ok: true, rule: '12.3a', distanceMp: 5 })
    expect(dump?.viaAdjacency).toBe(true)
    expect(dump?.path?.map(key)).toEqual(['36.0', '36.1', '36.2', '36.3', '36.4', '36.5'])
  })

  it('纯数值判据与地图判据同源（12.3a/12.3c）', () => {
    expect(canDirectDraw({ distanceMp: 5 }).ok).toBe(true)
    expect(canDirectDraw({ distanceMp: 5.5 }).ok).toBe(false)
    expect(canDirectDraw({ distanceMp: 39, adjacentToDump: true })).toMatchObject({
      ok: true,
      rule: '12.3c',
    })
  })

  it('己方 dump 不服务敌方（12.3a 的归属）', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(2), side: 'soviet' }) })
    expect(options.some((option) => option.kind === 'dump')).toBe(false)
  })

  it('12.1b：追溯来源（边缘铁路格/卸货格/延补队）不含 SP，不能当拖取来源', () => {
    expect(isSpBearingSource('dump')).toBe(true)
    expect(isSpBearingSource('hqThrow')).toBe(true)
    expect(isSpBearingSource('baseSource')).toBe(false)
    expect(isSpBearingSource('extender')).toBe(false)
    expect(isSpBearingSource('eatOffTheMap')).toBe(false)
  })

  it('12.6a③/12.7：回连成功的延补队会作为独立的来源类别列出', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'edgeRail' }],
      extenders: [{ hex: at(3), side: 'axis', mobility: 'truck', rangeMp: 20 }],
    })
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(5) }) })
    const extender = options.find((option) => option.kind === 'extender')
    expect(extender).toMatchObject({ ok: true, rule: '12.6a' })
    expect(extender?.hex).toEqual({ col: 36, row: 3 })
    expect(options.find((option) => option.kind === 'baseSource')).toMatchObject({ ok: true })
  })
})

/* ────────────────────────────── 12.3b 指挥部投递 ────────────────────────────── */

describe('12.3b 来源枚举：指挥部投递', () => {
  const hq = (overrides: Partial<ThrowHqView> = {}): ThrowHqView => ({
    hex: at(1),
    side: 'axis',
    mode: 'combat',
    mobility: 'truck',
    throwRangeMp: 6,
    throwMobility: 'truck',
    ...overrides,
  })

  it('HQ 自身能从 dump 拖取且在投递距离内 ⇒ 可投递，并给出路径', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({
      hexes,
      dumps: [{ hex: at(0), side: 'axis' }],
      throwHqs: [hq()],
    })
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(3) }) })
    const throwOption = options.find((option) => option.kind === 'hqThrow')
    expect(throwOption?.ok).toBe(true)
    // 12.3c：投递同样可以停在单位的相邻格（36.2）⇒ 距离 1
    expect(throwOption?.distanceMp).toBe(1)
    expect(throwOption?.path?.map(key)).toEqual(['36.1', '36.2'])
    expect(throwOption?.rule).toBe('12.3b')
  })

  it('12.3b-C：战略模式的 HQ 不能投递', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({
      hexes,
      dumps: [{ hex: at(0), side: 'axis' }],
      throwHqs: [hq({ mode: 'strat' })],
    })
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(3) }) })
    expect(options.find((option) => option.kind === 'hqThrow')).toMatchObject({
      ok: false,
      rule: '12.3b-C',
      reason: 'stratHqCannotThrow',
    })
  })

  it('12.3b-D：HQ 不得把别的 HQ 投递给它的补给再转投', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({
      hexes,
      dumps: [{ hex: at(0), side: 'axis' }],
      throwHqs: [hq({ receivedByThrow: true })],
    })
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(3) }) })
    expect(options.find((option) => option.kind === 'hqThrow')).toMatchObject({
      ok: false,
      rule: '12.3b-D',
      reason: 'hqCannotReThrow',
    })
  })

  it('超出投递距离则拒绝（并报出真实距离）', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({
      hexes,
      dumps: [{ hex: at(0), side: 'axis' }],
      throwHqs: [hq({ throwRangeMp: 3 })],
    })
    // 单位在 36.6：HQ（36.1）到其相邻格 36.5 需 4 MP > 投递距离 3
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(6) }) })
    expect(options.find((option) => option.kind === 'hqThrow')).toMatchObject({
      ok: false,
      rule: '12.3b',
      reason: 'outOfThrowRange',
      distanceMp: null,
    })
  })

  it('12.3b 前置：HQ 自身拿不到补给（既拖不到 dump 也无追溯源）则不能投递', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes, throwHqs: [hq()] })
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(3) }) })
    expect(options.find((option) => option.kind === 'hqThrow')).toMatchObject({
      ok: false,
      rule: '12.3b',
      reason: 'hqNotSupplied',
    })
  })
})

/* ────────────────────────────── 12.6c 吃图上补给 ────────────────────────────── */

describe('12.6c 吃图上补给：仅在没有追溯补给时可用', () => {
  it('有追溯补给时该选项不通过（onlyWhenNoTraceSupply）', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'supplySourceHex' }],
      dumps: [{ hex: at(1), side: 'axis' }],
    })
    const options = supplySourceOptions(facts, { unit: unit({ hex: at(3) }) })
    expect(options.find((option) => option.kind === 'eatOffTheMap')).toMatchObject({
      ok: false,
      rule: '12.6c',
      reason: 'onlyWhenNoTraceSupply',
    })
  })

  it('6.5 RE 需 4 T（小数向上取整），判定与结算一致', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    const target = unit({ hex: at(2), re: 6.5 })
    const assessment = assessUnitSupply(facts, target, { mobility: 'truck' })
    expect(assessment.status).toBe('canEatOffTheMap')
    expect(assessment.eatingCostT).toBe(4)
    expect(eatingOffTheMapCostT(6.5)).toBe(4)

    const resolution = planOosResolution({
      assessment,
      action: 'eatOffTheMap',
      holdings: { sp: 1, t: 0 },
    })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) return
    expect(resolution.data.costT).toBe(4)
    expect(resolution.data.markedOutOfSupply).toBe(false)
    expect(resolution.data.holdingsAfter).toEqual({ sp: 0, t: 0 })
  })

  it('12.6e：战略模式的单位不允许吃图上补给', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    const options = supplySourceOptions(facts, {
      unit: unit({ hex: at(2), mode: 'strat' }),
    })
    expect(options.find((option) => option.kind === 'eatOffTheMap')).toMatchObject({
      ok: false,
      reason: 'stratCannotEatOffTheMap',
    })

    const assessment = assessUnitSupply(facts, unit({ hex: at(2), mode: 'strat' }), {
      mobility: 'truck',
    })
    expect(assessment.canEatOffTheMap).toBe(false)
    expect(
      planOosResolution({ assessment, action: 'eatOffTheMap', holdings: { sp: 4, t: 0 } }),
    ).toMatchObject({ ok: false, reason: 'cannotEatOffTheMap' })
  })

  it('已在补给状态时不能吃图上补给（12.6c：只作为退路）', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'supplySourceHex' }],
      dumps: [{ hex: at(1), side: 'axis' }],
    })
    const assessment = assessUnitSupply(facts, unit({ hex: at(3) }), { mobility: 'truck' })
    expect(assessment.status).toBe('inSupply')
    expect(
      planOosResolution({ assessment, action: 'eatOffTheMap', holdings: { sp: 4, t: 0 } }),
    ).toMatchObject({ ok: false, rule: '12.6c', reason: 'onlyWhenNoTraceSupply' })
  })
})

/* ────────────────────────────── 12.6d 断补处置 ────────────────────────────── */

describe('12.6d 断补处置：接受断补并标记', () => {
  it('无源无 dump ⇒ 断补；接受断补即标记（等 12.8 掷损耗骰）', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes })
    const assessment = assessUnitSupply(facts, unit({ hex: at(3) }), { mobility: 'truck' })
    expect(assessment.status).toBe('outOfSupply')
    expect(assessment.canEatOffTheMap).toBe(false)

    const resolution = planOosResolution({
      assessment,
      action: 'acceptOutOfSupply',
      holdings: { sp: 2, t: 1 },
    })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) return
    expect(resolution.data.markedOutOfSupply).toBe(true)
    expect(resolution.data.costT).toBe(0)
    // 接受断补不动 SP 持仓
    expect(resolution.data.holdingsAfter).toEqual({ sp: 2, t: 1 })
  })

  it('不需要补给的单位（非战斗单位 12.0）不能走断补处置', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes })
    const assessment = assessUnitSupply(facts, unit({ hex: at(3), isCombat: false }), {
      mobility: 'truck',
    })
    expect(assessment.required).toBe(false)
    expect(
      planOosResolution({ assessment, action: 'acceptOutOfSupply', holdings: { sp: 0, t: 0 } }),
    ).toMatchObject({ ok: false, reason: 'unitDoesNotRequireTraceSupply' })
  })
})

/* ────────────────────────────── 12.3 拖取 / 投递结算 ────────────────────────────── */

describe('12.3 拖取与投递选择：结算与三条禁令', () => {
  const dumpSource = {
    kind: 'dump' as const,
    hex: at(0),
    path: null,
    distanceMp: 2,
    viaAdjacency: false,
    ok: true,
    rule: '12.3a',
    detail: 'stub',
  }
  const throwSource = { ...dumpSource, kind: 'hqThrow' as const, hex: at(1), rule: '12.3b' }

  it('拖取：从补给站扣 SP，必要时找零，并回报用途（12.3：本身不耗燃料）', () => {
    const plan = planSupplyPickup({
      source: dumpSource,
      holdings: { sp: 2, t: 0 },
      amountT: 3,
      purpose: 'combat',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.sourceAfter).toEqual({ sp: 1, t: 1 })
    expect(plan.data.deliveredT).toBe(3)
    expect(plan.data.detail).toContain('不耗燃料')
  })

  it('12.3b-A：指挥部只能投递需要立即被使用的补给', () => {
    expect(
      planSupplyPickup({
        source: throwSource,
        holdings: { sp: 1, t: 0 },
        amountT: 2,
        purpose: 'internalStocks',
        forImmediateUse: false,
      }),
    ).toMatchObject({ ok: false, rule: '12.3b-A', reason: 'hqThrowOnlyForImmediateUse' })
  })

  it('不可用的来源、零/负数金额、非含 SP 来源一律拒绝', () => {
    expect(
      planSupplyPickup({
        source: { ...dumpSource, ok: false, reason: 'directDrawOutOfRange' },
        holdings: { sp: 1, t: 0 },
        amountT: 1,
        purpose: 'fuel',
      }),
    ).toMatchObject({ ok: false, reason: 'directDrawOutOfRange' })
    expect(
      planSupplyPickup({
        source: dumpSource,
        holdings: { sp: 1, t: 0 },
        amountT: 0,
        purpose: 'fuel',
      }),
    ).toMatchObject({ ok: false, reason: 'invalidAmountT:0' })
    expect(
      planSupplyPickup({
        source: { ...dumpSource, kind: 'baseSource' },
        holdings: { sp: 1, t: 0 },
        amountT: 1,
        purpose: 'fuel',
      }),
    ).toMatchObject({ ok: false, reason: 'sourceHasNoSp:baseSource' })
  })

  it('来源不足以支付时报「持仓不足」（金额来自来源，不来自 UI）', () => {
    expect(
      planSupplyPickup({
        source: dumpSource,
        holdings: { sp: 0, t: 1 },
        amountT: 2,
        purpose: 'fuel',
      }),
    ).toMatchObject({ ok: false, reason: 'insufficientSpHoldings:2>1' })
  })
})

/* ────────────────────────────── 交互状态机 ────────────────────────────── */

describe('补给交互状态机：步骤顺序与分支', () => {
  const traceFacts = (): TraceSupplyFacts =>
    makeFacts({
      hexes: corridor(0, 12),
      sources: [{ hex: at(0), side: 'axis', kind: 'supplySourceHex' }],
      dumps: [{ hex: at(1), side: 'axis' }],
    })

  const begin = (facts: TraceSupplyFacts): SupplyInteractionState => {
    const result = beginSupplyCheck({
      side: 'axis',
      phase: 'supply',
      unit: unit({ hex: at(3) }),
      facts,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    return result.data
  }

  it('非战斗单位（12.0）直接判完，不进入任何分支', () => {
    const result = beginSupplyCheck({
      side: 'axis',
      phase: 'supply',
      unit: unit({ hex: at(3), isCombat: false }),
      facts: makeFacts({ hexes: corridor(0, 12) }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.step).toBe('done')
    expect(result.data.finished).toBe(true)
    expect(result.data.assessment.required).toBe(false)
  })

  it('有追溯补给 ⇒ trace 分支，停在「选择来源」', () => {
    const state = begin(traceFacts())
    expect(state.branch).toBe('trace')
    expect(state.step).toBe('selectSource')
    expect(hasReachedSupplyStep(state, 'pickup')).toBe(false)
    // `step` 表示**下一步待办** ⇒ 只有「判定补给状态」已打完勾
    expect(supplyStepChecklist(state).map((item) => item.done)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])
  })

  it('无追溯补给但能吃到 dump ⇒ oos 分支（不会被「有 dump」误判成 trace）', () => {
    const facts = makeFacts({
      hexes: corridor(0, 12),
      dumps: [{ hex: at(0), side: 'axis' }],
    })
    const state = begin(facts)
    expect(state.assessment.status).toBe('canEatOffTheMap')
    expect(state.branch).toBe('oos')
    expect(state.step).toBe('resolveOos')
  })

  it('选择来源：只能选含 SP 的来源；选中后进入「拖取/投递」', () => {
    const state = begin(traceFacts())
    const dumpIndex = state.sources.findIndex((source) => source.kind === 'dump')
    const baseIndex = state.sources.findIndex((source) => source.kind === 'baseSource')
    expect(dumpIndex).toBeGreaterThanOrEqual(0)
    expect(baseIndex).toBeGreaterThanOrEqual(0)

    expect(chooseSupplySource(state, { index: baseIndex })).toMatchObject({
      ok: false,
      reason: 'sourceHasNoSp:baseSource',
    })
    expect(chooseSupplySource(state, { index: 99 })).toMatchObject({ ok: false })

    const chosen = chooseSupplySource(state, { index: dumpIndex })
    expect(chosen.ok).toBe(true)
    if (!chosen.ok) return
    expect(chosen.data.state.step).toBe('pickup')
    expect(chosen.data.state.chosenSource?.kind).toBe('dump')
    expect(hasReachedSupplyStep(chosen.data.state, 'pickup')).toBe(true)
  })

  it('拖取/投递结算后落 done，并把来源余额交回状态层', () => {
    const state = begin(traceFacts())
    const dumpIndex = state.sources.findIndex((source) => source.kind === 'dump')
    const chosen = chooseSupplySource(state, { index: dumpIndex })
    if (!chosen.ok) throw new Error('unreachable')
    const done = confirmSupplyPickup(chosen.data.state, {
      holdings: { sp: 1, t: 0 },
      amountT: 1,
      purpose: 'fuel',
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.data.state.step).toBe('done')
    expect(done.data.state.finished).toBe(true)
    expect(done.data.pickup.sourceAfter).toEqual({ sp: 0, t: 3 })
  })

  it('步骤未到即结算立即被拒（顺序纪律）', () => {
    const state = begin(traceFacts())
    expect(
      confirmSupplyPickup(state, { holdings: { sp: 1, t: 0 }, amountT: 1, purpose: 'fuel' }),
    ).toMatchObject({ ok: false, reason: 'notAtPickupStep:selectSource' })
    expect(
      confirmOosResolution(state, { holdings: { sp: 1, t: 0 }, action: 'acceptOutOfSupply' }),
    ).toMatchObject({ ok: false, reason: 'notAtOosStep:selectSource' })
  })

  it('断补分支：吃图上补给或接受断补都能收尾', () => {
    const facts = makeFacts({
      hexes: corridor(0, 12),
      dumps: [{ hex: at(0), side: 'axis' }],
    })
    const state = begin(facts)
    const eaten = confirmOosResolution(state, {
      holdings: { sp: 1, t: 0 },
      action: 'eatOffTheMap',
    })
    expect(eaten.ok).toBe(true)
    if (!eaten.ok) return
    expect(eaten.data.resolution.costT).toBe(2) // 4 RE ⇒ 2 份 × 1 T（12.6c）
    expect(eaten.data.state.step).toBe('done')

    const starved = confirmOosResolution(begin(facts), {
      holdings: { sp: 1, t: 0 },
      action: 'acceptOutOfSupply',
    })
    expect(starved.ok).toBe(true)
    if (!starved.ok) return
    expect(starved.data.resolution.markedOutOfSupply).toBe(true)
  })
})

/* ────────────────────────────── 可视化原语互证 ────────────────────────────── */

describe('12.3d 可视化：覆盖范围与路径同源', () => {
  it('supplyCoverage 就是「距离 ≤ 预算」的全部格，且按 MP 升序', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes })
    const coverage = supplyCoverage(facts, {
      from: at(0),
      side: 'axis',
      mobility: 'truck',
      maxMp: 3,
    })
    expect(coverage.map((item) => item.mp)).toEqual([0, 1, 2, 3])
    expect(coverage.map((item) => key(item.hex))).toEqual(['36.0', '36.1', '36.2', '36.3'])

    // 互证：覆盖集合 ⇔ 单点查询在预算内可达
    for (const hex of hexes) {
      const distance = countSupplyDistance(facts, {
        from: at(0),
        to: hex,
        side: 'axis',
        mobility: 'truck',
        maxMp: 3,
      })
      const inCoverage = coverage.some((item) => key(item.hex) === key(hex))
      expect(inCoverage).toBe(distance.ok)
    }
  })

  it('supplyPath 的步数 = 单点查询的 MP（同一取费与阻断）', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes })
    const path = supplyPath(facts, { from: at(0), to: at(4), side: 'axis', mobility: 'truck' })
    const distance = countSupplyDistance(facts, {
      from: at(0),
      to: at(4),
      side: 'axis',
      mobility: 'truck',
    })
    expect(path?.map(key)).toEqual(['36.0', '36.1', '36.2', '36.3', '36.4'])
    expect(distance.ok).toBe(true)
    if (!distance.ok) return
    expect(path!.length - 1).toBe(distance.mp)
  })

  it('12.3d：敌方战斗单位阻断路径（覆盖范围与实际距离同时收缩）', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes, enemyCombat: [at(2)] })
    expect(
      supplyPath(facts, { from: at(0), to: at(4), side: 'axis', mobility: 'truck' }),
    ).toBeNull()
    const coverage = supplyCoverage(facts, {
      from: at(0),
      side: 'axis',
      mobility: 'truck',
      maxMp: 5,
    })
    expect(coverage.map((item) => key(item.hex))).toEqual(['36.0', '36.1'])
  })

  it('12.3d：未抵消的敌方 ZOC 只挡卡车 MP 路径，不挡步行/履带', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({ hexes, enemyZoc: [at(2)] })
    expect(
      supplyPath(facts, { from: at(0), to: at(4), side: 'axis', mobility: 'truck' }),
    ).toBeNull()
    expect(
      supplyPath(facts, { from: at(0), to: at(4), side: 'axis', mobility: 'leg' })?.map(key),
    ).toEqual(['36.0', '36.1', '36.2', '36.3', '36.4'])
  })
})

/* ────── B42（13.2g-B）：编内卡车的 SP 只许同一多单位编队内的单位拖取 ────── */

/**
 * 原文 **13.2g**：「编内卡车……与其他运输点数基本一样，但有几点例外：……**B) 只允许同一多单位编队内的
 *   单位拖取它们的 SP**……」；末句：「玩家可以使用指挥部，将装载于**编内卡车**的补给，投递给**同一
 *   多单位编队内**的单位。」
 *
 * 测法边界：本组只钉**资格判据**（真值表）；"候选人选与扣款路径真的用了这条判据"由
 *   `tests/stores/carried-sp-source.test.ts` 的端到端用例覆盖。
 */
describe('B42（13.2g-B）：编内卡车 SP 的拖取资格', () => {
  it('★ 常规运输点数不受限；编内卡车须**同编队**（且双方编队号都不可为空）', () => {
    // 13.2g 只讲编内卡车 ⇒ 常规运输点数照 13.2f/12.1b 可拖
    expect(
      canDrawFromCarrier({
        carrierIsOrganicTruck: false,
        carrierFormation: null,
        drawerFormation: '3PZ',
      }),
    ).toBe(true)

    // 编内卡车：同编队 ⇒ 可以
    expect(
      canDrawFromCarrier({
        carrierIsOrganicTruck: true,
        carrierFormation: '3PZ',
        drawerFormation: '3PZ',
      }),
    ).toBe(true)

    // 编内卡车：不同编队 ⇒ 不可以（13.2g-B 的原话就是"只允许同一编队内"）
    expect(
      canDrawFromCarrier({
        carrierIsOrganicTruck: true,
        carrierFormation: '3PZ',
        drawerFormation: '4PZ',
      }),
    ).toBe(false)

    // 编内卡车：拖取方无编队（独立单位）⇒ 也不可以
    expect(
      canDrawFromCarrier({
        carrierIsOrganicTruck: true,
        carrierFormation: '3PZ',
        drawerFormation: null,
      }),
    ).toBe(false)

    // 数据缺编队号的编内卡车**不**因此变成"谁都能拖"
    expect(
      canDrawFromCarrier({
        carrierIsOrganicTruck: true,
        carrierFormation: null,
        drawerFormation: '3PZ',
      }),
    ).toBe(false)
    expect(
      canDrawFromCarrier({
        carrierIsOrganicTruck: true,
        carrierFormation: null,
        drawerFormation: null,
      }),
    ).toBe(false)
  })
})
