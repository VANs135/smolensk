import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import {
  attritionArOf,
  attritionStackAr,
  canAffordAttackSupply,
  canAttemptDumpDestruction,
  canUseInternalStocks,
  computeCombatSupplyCost,
  defenderCombatSupplyOption,
  dumpDestructionPercent,
  extenderDisplacementCandidates,
  internalStocksReplenishCost,
  planDumpDestruction,
  planInternalStocksRecovery,
  planSupplyPhase,
  resolveAttrition,
  resolveExtenderCollapse,
  supplyTokensOf,
  validateAttritionAllocation,
  type BaseSourceKind,
  type SupplyPhaseUnitView,
  type TraceSupplyFacts,
} from '@/engine/rules'

/**
 * 补给阶段与断补损耗（B11）测试
 *
 * 条文：12.8a–c（损耗）/ 12.10e（部队储备恢复）/ 12.11a（主动销毁补给站）/ 9.14d（延补队崩溃）
 * 逻辑测试用**注入的假事实**（同一竖列、每步 1 MP），掷骰由测试直接给定（模块不含随机）。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

const at = (row: number): HexRef => ({ col: 36, row })
const key = (hex: HexRef): string => `${hex.col}.${hex.row}`

function corridor(row0: number, span: number): HexRef[] {
  return Array.from({ length: span + 1 }, (_, index) => ({ col: 36, row: row0 + index }))
}

function makeFacts(options: {
  hexes: readonly HexRef[]
  sources?: readonly { hex: HexRef; side: Side; kind: BaseSourceKind }[]
  dumps?: readonly { hex: HexRef; side: Side }[]
  enemyCombat?: readonly HexRef[]
}): TraceSupplyFacts {
  const onMap = new Set(options.hexes.map(key))
  const enemyCombat = new Set((options.enemyCombat ?? []).map(key))
  return {
    onMap: (hex) => onMap.has(key(hex)),
    sourcesFor: (side) =>
      (options.sources ?? [])
        .filter((item) => item.side === side)
        .map(({ hex, kind }) => ({ hex, kind })),
    extendersFor: () => [],
    throwHqsFor: () => [],
    dumpsFor: (side) =>
      (options.dumps ?? []).filter((item) => item.side === side).map((item) => item.hex),
    hasEnemyCombatUnit: (hex) => enemyCombat.has(key(hex)),
    inEnemyZoc: () => false,
    stepCost: (from, to) => (onMap.has(key(from)) && onMap.has(key(to)) ? 1 : null),
  }
}

/* ────────────────────────────── 12.8 损耗 ────────────────────────────── */

describe('12.8 损耗：取列 AR 与掷骰修正', () => {
  it('12.8c：DG 不修正 AR；战略模式按 AR 0', () => {
    expect(attritionArOf({ ar: 4, mode: 'combat' })).toBe(4)
    expect(attritionArOf({ ar: 2, mode: 'move' })).toBe(2)
    expect(attritionArOf({ ar: 2, mode: 'strat' })).toBe(0)
  })

  it('12.8b：取列 AR ＝ 断补单位中最高者（只看传入的断补单位）', () => {
    expect(
      attritionStackAr([
        { id: 'a', ar: 2, mode: 'combat' },
        { id: 'b', ar: 5, mode: 'combat' },
        { id: 'c', ar: 4, mode: 'strat' },
      ]),
    ).toBe(5)
    expect(attritionStackAr([])).toBe(0)
  })

  it('resolveAttrition：2 骰 + 修正后查表，返回损失与原始格值', () => {
    const noDrm = resolveAttrition({ die: 9, bestAr: 4, oosSteps: 3 })
    expect(noDrm).toMatchObject({ rule: '12.8b', modifiedDice: 9, drm: 0, raw: '-1 Step' })
    expect(noDrm.losses).toEqual({ kind: 'steps', steps: 1 })
    const drm = resolveAttrition({ die: 9, bestAr: 4, oosSteps: 5 })
    expect(drm).toMatchObject({ modifiedDice: 12, drm: 3, raw: '-All Steps' })
    expect(drm.losses).toEqual({ kind: 'allSteps' })
  })

  it('12.8b：分摊校验——不得超过现有军力、须恰好满足所要求的点数', () => {
    const units = [
      { id: 'a', steps: 2 },
      { id: 'b', steps: 4 },
    ]
    expect(
      validateAttritionAllocation({ required: 3, units, allocation: { a: 2, b: 1 } }),
    ).toMatchObject({ ok: true })
    expect(validateAttritionAllocation({ required: 3, units, allocation: { a: 1, b: 1 } }).ok).toBe(
      false,
    )
    expect(validateAttritionAllocation({ required: 1, units, allocation: { a: 3 } }).ok).toBe(false)
    expect(validateAttritionAllocation({ required: 1, units, allocation: { zz: 1 } }).ok).toBe(
      false,
    )
    // 结果为 All Steps：该格断补单位全部消灭
    expect(
      validateAttritionAllocation({ required: 'all', units, allocation: { a: 2, b: 4 } }),
    ).toMatchObject({ ok: true })
    expect(
      validateAttritionAllocation({ required: 'all', units, allocation: { a: 2, b: 1 } }).ok,
    ).toBe(false)
  })
})

/* ────────────────────────────── 12.11a 主动销毁补给站 ────────────────────────────── */

describe('12.11a 主动销毁补给站', () => {
  it('只在三个移动环节可尝试，且每阶段每补给站一次', () => {
    for (const segment of ['movement', 'reaction', 'exploitation'] as const)
      expect(canAttemptDumpDestruction({ segment })).toMatchObject({ ok: true })
    // 其他段（如 F 战斗段 / D 补给段）不可
    expect(canAttemptDumpDestruction({ segment: 'combat' })).toMatchObject({
      ok: false,
      rule: '12.11a',
      reason: 'wrongSegment',
    })
    expect(canAttemptDumpDestruction({ segment: 'supply' })).toMatchObject({ ok: false })
    expect(canAttemptDumpDestruction({ segment: 'movement', attemptsThisPhase: 1 })).toMatchObject({
      ok: false,
      reason: 'alreadyAttempted',
    })
  })

  it('销毁百分比查表（1 骰：25/50/75/100）', () => {
    expect(dumpDestructionPercent(1)).toBe(25)
    expect(dumpDestructionPercent(2)).toBe(50)
    expect(dumpDestructionPercent(3)).toBe(50)
    expect(dumpDestructionPercent(4)).toBe(75)
    expect(dumpDestructionPercent(5)).toBe(75)
    expect(dumpDestructionPercent(6)).toBe(100)
  })

  it('规则书算例：4 SP 中尝试销毁 3 SP，掷得 75% → 销毁 2 SP + 1 T', () => {
    const plan = planDumpDestruction({ requestedT: supplyTokensOf(3 * 4).sp * 4, percent: 75 })
    expect(plan).toMatchObject({ ok: true, destroyedT: 9, sp: 2, t: 1, rule: '12.11a' })
  })

  it('损失取整到最接近的 T；非法入参不静默', () => {
    // 1 SP = 4 T 的 33% → 1.32 T → 取整到 1 T
    expect(planDumpDestruction({ requestedT: 4, percent: 33 })).toMatchObject({
      ok: true,
      destroyedT: 1,
    })
    expect(planDumpDestruction({ requestedT: -1, percent: 50 }).ok).toBe(false)
    expect(planDumpDestruction({ requestedT: 4, percent: 120 }).ok).toBe(false)
  })

  it('补给点数拆分：1 SP = 4 T（12.1a）', () => {
    expect(supplyTokensOf(9)).toEqual({ sp: 2, t: 1 })
    expect(supplyTokensOf(4)).toEqual({ sp: 1, t: 0 })
    expect(supplyTokensOf(0)).toEqual({ sp: 0, t: 0 })
  })
})

/* ────────────────────────────── 12.10e 部队储备强制恢复 ────────────────────────────── */

describe('12.10e 部队储备：成本与强制恢复', () => {
  it('成本：单军力 2T；多军力按其 RE 计；耗尽为两倍', () => {
    expect(
      internalStocksReplenishCost({ level: 'low', reSize: 1, multiStep: false }),
    ).toMatchObject({
      ok: true,
      t: 2,
    })
    expect(internalStocksReplenishCost({ level: 'low', reSize: 3, multiStep: true })).toMatchObject(
      {
        ok: true,
        t: 6,
      },
    )
    expect(
      internalStocksReplenishCost({ level: 'exhausted', reSize: 1, multiStep: false }),
    ).toMatchObject({ ok: true, t: 4 })
    expect(internalStocksReplenishCost({ level: 'low', reSize: 0, multiStep: true }).ok).toBe(false)
  })

  it('SP 充裕：按需完全恢复，余额不被浪费（12.10e-A）', () => {
    const plan = planInternalStocksRecovery({
      units: [
        { id: 'a', level: 'low', reSize: 1, multiStep: false, canDraw: true },
        { id: 'b', level: 'exhausted', reSize: 1, multiStep: false, canDraw: true },
      ],
      availableT: 10,
    })
    expect(plan.spentT).toBe(6) // 2 + 4
    expect(plan.wastedT).toBe(0)
    expect(plan.unmet).toEqual([])
    expect(plan.recoveries.map((item) => item.to)).toEqual(['ready', 'ready'])
  })

  it('12.10e-C：不足时消耗现有全部补给——1 T 直接浪费', () => {
    const plan = planInternalStocksRecovery({
      units: [{ id: 'a', level: 'low', reSize: 1, multiStep: false, canDraw: true }],
      availableT: 1,
    })
    expect(plan.recoveries).toEqual([])
    expect(plan.spentT).toBe(1)
    expect(plan.wastedT).toBe(1)
    expect(plan.unmet).toEqual(['a'])
  })

  it('12.10e-C：2 T 可恢复一个低下单位，或把耗尽单位改为低下', () => {
    const low = planInternalStocksRecovery({
      units: [{ id: 'a', level: 'low', reSize: 1, multiStep: false, canDraw: true }],
      availableT: 2,
    })
    expect(low.recoveries).toEqual([{ unitId: 'a', from: 'low', to: 'ready', costT: 2 }])
    expect(low.wastedT).toBe(0)

    const exhausted = planInternalStocksRecovery({
      units: [{ id: 'a', level: 'exhausted', reSize: 1, multiStep: false, canDraw: true }],
      availableT: 2,
    })
    expect(exhausted.recoveries).toEqual([{ unitId: 'a', from: 'exhausted', to: 'low', costT: 2 }])
    expect(exhausted.wastedT).toBe(0)
  })

  it('12.10e-C：唯一待恢复单位是多军力时，2 T 也会被浪费', () => {
    const plan = planInternalStocksRecovery({
      // 2 RE 的多军力单位：低价 = 2 RE × 2 T = 4 T
      units: [{ id: 'div', level: 'low', reSize: 2, multiStep: true, canDraw: true }],
      availableT: 2,
    })
    expect(plan.recoveries).toEqual([])
    expect(plan.spentT).toBe(2)
    expect(plan.wastedT).toBe(2)
    expect(plan.unmet).toEqual(['div'])
  })

  it('12.10e-B：不可拖取/不可投递者不恢复（编内卡车上的 SP 例外由调用方置 false）', () => {
    const plan = planInternalStocksRecovery({
      units: [{ id: 'a', level: 'low', reSize: 1, multiStep: false, canDraw: false }],
      availableT: 10,
    })
    expect(plan.recoveries).toEqual([])
    expect(plan.spentT).toBe(0)
    expect(plan.unmet).toEqual(['a'])
  })
})

/* ────────────────────────────── 补给阶段总计划（SP 分配） ────────────────────────────── */

describe('补给阶段（2.2 D 段）：SP 分配顺序 = 先强制恢复部队储备，再吃图上补给（12.10e-A）', () => {
  const hexes = corridor(0, 12)
  const unit = (
    id: string,
    row: number,
    extra: Partial<SupplyPhaseUnitView> = {},
  ): SupplyPhaseUnitView => ({
    id,
    side: 'axis',
    hex: at(row),
    isCombat: true,
    steps: 2,
    re: 1,
    ar: 2,
    mode: 'combat',
    internalStocks: null,
    outOfSupply: false,
    multiStep: false,
    ...extra,
  })

  it('恢复 + 追溯判定 + 断补标记 + 损耗义务一次算清', () => {
    const facts = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'detrainable' }],
      // 5 号被敌方战斗单位切断：3 号仍有追溯补给，9 号断补
      enemyCombat: [at(5)],
    })
    const plan = planSupplyPhase(facts, {
      activeSide: 'axis',
      units: [
        unit('a', 3, { internalStocks: 'low', ar: 4 }),
        unit('b', 9, { steps: 3, ar: 2 }),
        // 敌方单位不参与本方补给阶段
        unit('e', 3, { side: 'soviet' }),
      ],
      mobility: 'leg',
      availableT: 2,
    })

    expect(plan.internalStocks.recoveries).toEqual([
      { unitId: 'a', from: 'low', to: 'ready', costT: 2 },
    ])
    expect(plan.internalStocks.spentT).toBe(2)
    expect(plan.remainingT).toBe(0)
    expect(plan.assessments.map((item) => [item.unitId, item.status])).toEqual([
      ['a', 'inSupply'],
      ['b', 'outOfSupply'],
    ])
    expect(plan.outOfSupply.mark).toEqual(['b'])
    expect(plan.attritionDuty).toEqual([{ hex: at(9), unitIds: ['b'], bestAr: 2, oosSteps: 3 }])
  })

  it('12.10e-A：恢复优先于「吃图上补给」，剩余 T 不足以吃即标 affordable=false', () => {
    const facts = makeFacts({
      hexes,
      // 3 号仍有追溯补给（连到 0 号源），9 号被 5 号敌军切断
      sources: [{ hex: at(0), side: 'axis', kind: 'detrainable' }],
      dumps: [{ hex: at(8), side: 'axis' }],
      enemyCombat: [at(5)],
    })
    const plan = planSupplyPhase(facts, {
      activeSide: 'axis',
      units: [unit('a', 3, { internalStocks: 'low' }), unit('b', 9, { steps: 4, re: 4 })],
      mobility: 'leg',
      availableT: 2,
      eatOffTheMap: (id) => id === 'b',
    })
    // 2 T 全被部队储备恢复吃掉
    expect(plan.internalStocks.spentT).toBe(2)
    expect(plan.remainingT).toBe(0)
    // b 的吃图上补给 = ceil(4 RE / 2) × 1 T = 2 T（12.6c 按 RE 计，不是按军力）；已无余额
    expect(plan.feeding).toEqual([{ unitId: 'b', costT: 2, affordable: false }])
    // b 未被喂饱 ⇒ 仍需断补
    expect(plan.outOfSupply.mark).toEqual(['b'])
  })
})

/* ────────────────────────────── 12.4 战斗补给 ────────────────────────────── */

describe('12.4 战斗补给：成本口径与攻守取舍', () => {
  it('攻方按**军力点数**计（1T/step）；守方 2T/场，总 RE ≤1 时 1T', () => {
    expect(computeCombatSupplyCost({ attackerSteps: 3, defenderRE: 2 })).toEqual({
      attackerT: 3,
      defenderT: 2,
    })
    expect(computeCombatSupplyCost({ attackerSteps: 3, defenderRE: 1 })).toEqual({
      attackerT: 3,
      defenderT: 1,
    })
    // 军力与 RE 口径不同：3 军力的师若按 RE 算会少付（此断言防参数误用）
    expect(computeCombatSupplyCost({ attackerSteps: 6, defenderRE: 2 }).attackerT).toBe(6)
  })

  it('12.4：攻方必须**全额**付清才能攻击（不是有多少付多少）', () => {
    expect(canAffordAttackSupply({ requiredT: 3, availableT: 2 })).toMatchObject({
      ok: false,
      rule: '12.4',
      reason: 'attackSupplyNotFull',
    })
    expect(canAffordAttackSupply({ requiredT: 3, availableT: 3 })).toMatchObject({ ok: true })
  })

  it('12.4 / 9.5a：守方可选择不付，以一半战斗值防御（无需全额）', () => {
    expect(defenderCombatSupplyOption({ provided: true })).toMatchObject({
      defenseMultiplier: 1,
      rule: '12.4',
    })
    expect(defenderCombatSupplyOption({ provided: false })).toMatchObject({
      defenseMultiplier: 0.5,
      rule: '12.4',
    })
  })

  it('12.10a：只有图上补给不可用时才能动用部队储备（编内卡车 SP 例外）', () => {
    expect(canUseInternalStocks({ onMapSupplyAvailable: true })).toMatchObject({
      ok: false,
      rule: '12.10a',
      reason: 'onMapSupplyAvailable',
    })
    expect(canUseInternalStocks({ onMapSupplyAvailable: false })).toMatchObject({ ok: true })
    expect(
      canUseInternalStocks({ onMapSupplyAvailable: true, onlyOrganicTruckSp: true }),
    ).toMatchObject({ ok: true, rule: '12.10a' })
  })
})

/* ────────────────────────────── 9.14d 延补队崩溃 ────────────────────────────── */

describe('9.14d 延补队崩溃位移', () => {
  const extender = { id: 'e', hex: at(5), side: 'axis' as Side, rangeMp: 3 }

  it('位移到「有追溯补给」的合法格（敌方单位/ZOC/禁入地形不影响位移）', () => {
    const result = resolveExtenderCollapse({
      extender,
      candidates: [at(2), at(4), at(8)],
      hasTraceSupplyAt: (hex) => hex.row === 4 || hex.row === 8,
    })
    expect(result).toMatchObject({ rule: '9.14d', hex: at(4), flipToTransportPoints: true })
    expect(result.legalHexes).toEqual([at(4), at(8)])
    expect(result.captureCheckRequired).toBe(false)
  })

  it('不存在合法格：留在原格、翻面，并按 9.14c 接受夺取判定', () => {
    const result = resolveExtenderCollapse({
      extender,
      candidates: [at(2), at(4)],
      hasTraceSupplyAt: () => false,
    })
    expect(result.hex).toBeNull()
    expect(result.legalHexes).toEqual([])
    expect(result.captureCheckRequired).toBe(true)
  })

  it('候选按 12.7b 的延补队距离（格距）筛出', () => {
    expect(extenderDisplacementCandidates(extender, [at(1), at(2), at(5), at(9)])).toEqual([
      at(2),
      at(5),
    ])
  })
})

/* ────────────────────────────── 12.6c 批量取整（第五批 B4） ────────────────────────────── */

describe('12.6c 批量取整：D 段计划的吃图上补给按批次 RE 总量计价（与交互链同口径）', () => {
  const hexes = corridor(0, 12)
  const unit = (id: string, row: number): SupplyPhaseUnitView => ({
    id,
    side: 'axis',
    hex: at(row),
    isCombat: true,
    steps: 2,
    re: 1,
    ar: 2,
    mode: 'combat',
    internalStocks: null,
    outOfSupply: false,
    multiStep: false,
  })

  it('三枚 1RE 单位同批吃图上补给 ⇒ 批量合计 2T（修前逐单位 ceil 相加 = 3T）', () => {
    const facts = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'detrainable' }],
      dumps: [{ hex: at(8), side: 'axis' }],
      enemyCombat: [at(5)],
    })
    const plan = planSupplyPhase(facts, {
      activeSide: 'axis',
      units: [unit('a', 9), unit('b', 9), unit('c', 9)],
      mobility: 'leg',
      availableT: 9,
      eatOffTheMap: () => true,
    })
    const total = plan.feeding.reduce((sum, item) => sum + item.costT, 0)
    // 12.6c：取整作用在**批次 RE 总量**上（3 RE ⇒ 2T）——不能逐单位各取整再相加（3×1T = 3T）
    expect(total, '12.6c 批量口径的合计 T').toBe(2)
    expect(plan.remainingT).toBe(7)
    // 三枚都被喂饱 ⇒ 免于断补
    expect(plan.outOfSupply.mark).toEqual([])
  })
})
