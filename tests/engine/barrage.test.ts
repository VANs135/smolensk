import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  BARRAGE_BRACKET_HEDGEHOG_MIN_LEVEL,
  BARRAGE_COLUMN_SHIFTS,
  BARRAGE_DENSITY_CAP_RE,
  BARRAGE_HALF_RESULT_STEP_LOSS_MIN_DIE,
  BARRAGE_MIN_VALUE,
  BARRAGE_NO_SPOTTER_SHIFT_LEFT,
  BARRAGE_SHORT_RANGE_HEXES,
  barrageColumnShifts,
  barrageCostT,
  barrageEligibility,
  canBarrageAtRange,
  canPayBarrageCost,
  computeDensityShift,
  densityReOf,
  isCorrectSpotter,
  parseFacilityCode,
  resolveBarrage,
  resolveBarrageOutcome,
  resolveBarrageVsFacility,
  resolveFacilityOutcome,
} from '@/engine/rules'

/**
 * 轰炸结算（B15，OCS 10.0）测试
 *
 * 横移数值与结果解释照录**中文辅助卡第 4 页轰炸表附注**（与英文原版逐项一致）：
 *   密度（1 RE 及以下左移 1；>1≤3 无；>3≤4 右移 1；>4≤5 右移 2；>5≤6 右移 3；>6 右移 4）；
 *   存在任意等级环形工事 ⇒ 左移 1；复杂/非常复杂地形 ⇒ 左移 1、极端复杂 ⇒ 左移 2；
 *   缺正确观察员 ⇒ 左移 3（战略轰炸机永久生效）；目标格内有战略模式单位 ⇒ 右移 3；
 *   全部飞机在基地 10 格内 ⇒ 右移 1（战略轰炸机不享受）；
 *   结果：`-` 无效果 / `DG` 全体 DG / `#` 损 # 点军力并 DG /
 *   `[1/2]` 在等级 3-4 工事、飞机或舰船轰炸、或缺观察员时**视为 DG**，否则按 `1/2` 处理 /
 *   `1/2` 掷 1 骰：4-6 损 1 点军力并 DG，其他只 DG。
 */

const HEX: HexRef = { col: 36, row: 13 }
const ADJACENT: HexRef = { col: 36, row: 14 }

/* ────────────────────────────── 10.0a 密度 ────────────────────────────── */

describe('10.0a 密度：只算战斗单位，且单个师/编队计入密度时上限 3 RE', () => {
  it('密度表全档（含 1 RE 及以下左移 1）', () => {
    expect(computeDensityShift(undefined)).toBe(0)
    expect(computeDensityShift(1)).toBe(-1)
    expect(computeDensityShift(2)).toBe(0)
    expect(computeDensityShift(3)).toBe(0)
    expect(computeDensityShift(4)).toBe(1)
    expect(computeDensityShift(5)).toBe(2)
    expect(computeDensityShift(6)).toBe(3)
    expect(computeDensityShift(7)).toBe(4)
  })

  it('统计只含战斗单位（运输点、SP 等不计）', () => {
    expect(
      densityReOf([
        { isCombat: true, re: 1 },
        { isCombat: false, re: 5 },
      ]),
    ).toBe(1)
  })

  it('单师上限 3 RE：4 RE 的师只计 3；同一编队的多算子合并后封顶 3', () => {
    expect(BARRAGE_DENSITY_CAP_RE).toBe(3)
    expect(densityReOf([{ isCombat: true, re: 4 }])).toBe(3)
    // 同一编队（多单位编队）3 + 2 = 5 ⇒ 封顶 3
    expect(
      densityReOf([
        { isCombat: true, re: 3, formationId: 'div1' },
        { isCombat: true, re: 2, formationId: 'div1' },
      ]),
    ).toBe(3)
    // 不同编队各自封顶后相加：2 + 2 = 4
    expect(
      densityReOf([
        { isCombat: true, re: 2, formationId: 'div1' },
        { isCombat: true, re: 2, formationId: 'div2' },
      ]),
    ).toBe(4)
  })
})

/* ────────────────────────────── 10.0a / 10.0b / 10.2b 列横移 ────────────────────────────── */

describe('10.0a / 10.0b / 10.2b 列横移：密度 + 工事 + 地形 + 观察员 + 战略模式 + 短程', () => {
  it('规则书 10.1 算例：8RE、1 级工事、复杂地形、有观察员 ⇒ +4 −1 −1 = 右移 2 列', () => {
    const shifts = barrageColumnShifts({
      enemyREInHex: 8,
      hedgehogLevel: 1,
      terrainLine: 'Close',
      hasSpotter: true,
    })
    expect(shifts).toMatchObject({ density: 4, hedgehog: -1, terrain: -1, spotter: 0, total: 2 })
  })

  it('地形横移按战斗线（由目标玩家选择）：开阔 0、复杂/非常复杂 −1、极端复杂 −2', () => {
    const of = (terrainLine: 'Open' | 'Close' | 'Very Close' | 'Extr Close') =>
      barrageColumnShifts({ terrainLine }).terrain
    expect(of('Open')).toBe(0)
    expect(of('Close')).toBe(-1)
    expect(of('Very Close')).toBe(-1)
    expect(of('Extr Close')).toBe(-2)
    expect(BARRAGE_COLUMN_SHIFTS.terrainByCombatLine['Extr Close']).toBe(-2)
  })

  it('环形工事：任意等级都左移 1 列（等级 1 与等级 4 同值）', () => {
    expect(barrageColumnShifts({ hedgehogLevel: 1 }).hedgehog).toBe(-1)
    expect(barrageColumnShifts({ hedgehogLevel: 4 }).hedgehog).toBe(-1)
    expect(barrageColumnShifts({ hedgehogLevel: 0 }).hedgehog).toBe(0)
  })

  it('战略模式：目标格内任何单位为战略模式 ⇒ 右移 3 列', () => {
    expect(barrageColumnShifts({ stratModeInHex: true }).stratMode).toBe(3)
    expect(BARRAGE_COLUMN_SHIFTS.stratModeInHex).toBe(3)
  })

  it('观察员：无正确观察员左移 3；战略轰炸机该惩罚永久生效', () => {
    expect(BARRAGE_NO_SPOTTER_SHIFT_LEFT).toBe(3)
    expect(barrageColumnShifts({ hasSpotter: false }).spotter).toBe(-3)
    expect(barrageColumnShifts({ hasSpotter: true }).spotter).toBe(0)
    const strategic = barrageColumnShifts({ hasSpotter: true, strategicBomber: true })
    expect(strategic.spotter).toBe(-3)
    expect(strategic.detail.join('|')).toContain('永久生效')
  })

  it('10.2b 短程效果：仅空军、全部飞机 ≤10 格、非战略轰炸机 ⇒ 右移 1', () => {
    expect(BARRAGE_SHORT_RANGE_HEXES).toBe(10)
    const air = barrageColumnShifts({ kind: 'air', rangeFromBase: 10 })
    expect(air.shortRange).toBe(1)
    expect(barrageColumnShifts({ kind: 'air', rangeFromBase: 11 }).shortRange).toBe(0)
    // 火炮/舰船不享受
    expect(barrageColumnShifts({ kind: 'artillery', rangeFromBase: 1 }).shortRange).toBe(0)
    // 战略轰炸机永远不享受
    expect(
      barrageColumnShifts({ kind: 'air', rangeFromBase: 1, strategicBomber: true }).shortRange,
    ).toBe(0)
  })
})

/* ────────────────────────────── 10.0b 观察员定义 ────────────────────────────── */

describe('10.0b 正确的观察员＝与目标格相邻的友方战斗单位', () => {
  it('相邻 + 友方 + 战斗单位 ⇒ 正确；非战斗/敌对方/不相邻 ⇒ 不正确', () => {
    expect(
      isCorrectSpotter({
        side: 'axis',
        friendlySide: 'axis',
        hex: ADJACENT,
        targetHex: HEX,
        isCombat: true,
      }),
    ).toBe(true)
    expect(
      isCorrectSpotter({
        side: 'axis',
        friendlySide: 'axis',
        hex: ADJACENT,
        targetHex: HEX,
        isCombat: false,
      }),
    ).toBe(false)
    expect(
      isCorrectSpotter({
        side: 'axis',
        friendlySide: 'soviet',
        hex: ADJACENT,
        targetHex: HEX,
        isCombat: true,
      }),
    ).toBe(false)
    expect(
      isCorrectSpotter({
        side: 'axis',
        friendlySide: 'axis',
        hex: { col: 10, row: 10 },
        targetHex: HEX,
        isCombat: true,
      }),
    ).toBe(false)
  })
})

/* ────────────────────────────── 10.1a / 10.1b 火炮 ────────────────────────────── */

describe('10.1a / 10.1b 火炮：射程按格、补给取初始列', () => {
  it('10.1a：射程以格计，不受天气地形影响（射程 3 可打 1–3 格）', () => {
    expect(canBarrageAtRange({ rangeHexes: 3, distanceHexes: 1 })).toBe(true)
    expect(canBarrageAtRange({ rangeHexes: 3, distanceHexes: 3 })).toBe(true)
    expect(canBarrageAtRange({ rangeHexes: 3, distanceHexes: 4 })).toBe(false)
    expect(canBarrageAtRange({ rangeHexes: 3, distanceHexes: 0 })).toBe(false)
  })

  it('10.1b：★ 补给用量取**初始列**，不随横移变化（规则书算例：值 12–16 → 3T）', () => {
    expect(barrageCostT(16)).toBe(3)
    const plain = resolveBarrage({ die: 8, valueRange: 16 })
    const shifted = resolveBarrage({
      die: 8,
      valueRange: 16,
      enemyREInHex: 8,
      hedgehogLevel: 1,
      terrainLine: 'Close',
      hasSpotter: true,
    })
    expect(plain.costT).toBe(3)
    expect(shifted.costT).toBe(3) // 横移后列更靠右（成本更高），但费用仍按初始列
    expect(shifted.finalColumn).toBe(shifted.initialColumn + 2)
    expect(shifted.shifts.total).toBe(2)
  })

  it('10.1b：付不出则不能轰炸；不能用部队储备；多单位须同一来源', () => {
    expect(canPayBarrageCost({ requiredT: 3, availableT: 2 })).toMatchObject({
      ok: false,
      reason: 'cannotAfford',
    })
    expect(canPayBarrageCost({ requiredT: 3, availableT: 5, unitCount: 1 })).toMatchObject({
      ok: true,
    })
    expect(
      canPayBarrageCost({ requiredT: 3, availableT: 5, unitCount: 1, usedInternalStocks: true }),
    ).toMatchObject({ ok: false, rule: '10.1b-C', reason: 'internalStocksForbidden' })
    expect(
      canPayBarrageCost({
        requiredT: 3,
        availableT: 5,
        unitCount: 2,
        fromSameHq: false,
        fromSameDump: false,
      }),
    ).toMatchObject({ ok: false, rule: '10.1b-A', reason: 'mixedSupplySources' })
    expect(
      canPayBarrageCost({ requiredT: 3, availableT: 5, unitCount: 2, fromSameHq: true }),
    ).toMatchObject({ ok: true })
  })

  it('10.0：至少 1 点轰炸值才可使用轰炸表', () => {
    expect(BARRAGE_MIN_VALUE).toBe(1)
    expect(() => resolveBarrage({ die: 8, valueRange: 0 })).toThrowError(/至少需要 1 点轰炸值/)
    expect(() => resolveBarrage({ die: 13, valueRange: 8 })).toThrowError(/2–12/)
  })
})

/* ────────────────────────────── 10.0a 结果解释 ────────────────────────────── */

describe('10.0a 结果解释：DG、减损与 [1/2]', () => {
  it('`-` 无效果；`DG` 只 DG；`#` 损 # 点军力并 DG', () => {
    expect(resolveBarrageOutcome({ code: '-' })).toMatchObject({ dg: false, stepLosses: 0 })
    expect(resolveBarrageOutcome({ code: 'DG' })).toMatchObject({ dg: true, stepLosses: 0 })
    expect(resolveBarrageOutcome({ code: '2' })).toMatchObject({ dg: true, stepLosses: 2 })
    expect(resolveBarrageOutcome({ code: '3' })).toMatchObject({ stepLosses: 3 })
  })

  it('`1/2`：需取整骰；4-6 损 1 点军力并 DG，其他只 DG（规则书算例：掷 3 ⇒ 不损军力、只 DG）', () => {
    expect(BARRAGE_HALF_RESULT_STEP_LOSS_MIN_DIE).toBe(4)
    const needDie = resolveBarrageOutcome({ code: '1/2' })
    expect(needDie).toMatchObject({ needsHalfDie: true, dg: true, stepLosses: 0 })
    expect(resolveBarrageOutcome({ code: '1/2', halfDie: 3 })).toMatchObject({
      needsHalfDie: false,
      stepLosses: 0,
      dg: true,
    })
    expect(resolveBarrageOutcome({ code: '1/2', halfDie: 4 })).toMatchObject({
      stepLosses: 1,
      dg: true,
    })
    expect(() => resolveBarrageOutcome({ code: '1/2', halfDie: 7 })).toThrowError(/1–6/)
  })

  it('`[1/2]`：等级 3-4 工事 / 飞机或舰船轰炸 / 缺观察员 ⇒ 直接视为 DG（不掷骰）', () => {
    expect(BARRAGE_BRACKET_HEDGEHOG_MIN_LEVEL).toBe(3)
    // 三者任一成立
    expect(
      resolveBarrageOutcome({ code: '[1/2]', hedgehogLevel: 3, hasSpotter: true }),
    ).toMatchObject({
      needsHalfDie: false,
      stepLosses: 0,
      dg: true,
    })
    expect(resolveBarrageOutcome({ code: '[1/2]', kind: 'air', hasSpotter: true })).toMatchObject({
      needsHalfDie: false,
    })
    expect(resolveBarrageOutcome({ code: '[1/2]', hasSpotter: false })).toMatchObject({
      needsHalfDie: false,
    })
  })

  it('规则书 10.1 算例的 `[1/2]`：有观察员且不在 3 级以上工事内 ⇒ 视为普通 1/2（需掷取整骰）', () => {
    const outcome = resolveBarrageOutcome({
      code: '[1/2]',
      hedgehogLevel: 1,
      hasSpotter: true,
      kind: 'artillery',
    })
    expect(outcome).toMatchObject({ needsHalfDie: true, dg: true, stepLosses: 0 })
    // 该算例中掷 3 ⇒ 目标格不损失军力，但变为混乱
    expect(
      resolveBarrageOutcome({ code: '[1/2]', hedgehogLevel: 1, hasSpotter: true, halfDie: 3 }),
    ).toMatchObject({
      stepLosses: 0,
      dg: true,
    })
  })
})

/* ────────────────────────────── 10.0c 对设施轰炸 ────────────────────────────── */

describe('10.0c 对设施轰炸：无横移、无需观察员、掷 1 骰', () => {
  it('对设施轰炸不做任何横移（10.0c）', () => {
    const result = resolveBarrageVsFacility(4, 90)
    expect(result.code).toBe('2 * (4)')
    expect(result.shifts.total).toBe(0)
    expect(result.costT).toBe(8)
    expect(() => resolveBarrageVsFacility(7, 8)).toThrowError(/1–6/)
  })

  it('格值解析：`1 * (5)` / `2 * (4)` / `(6)` / `-`', () => {
    expect(parseFacilityCode('2 * (4)')).toEqual({
      levelOrDamage: 2,
      trainbusting: true,
      aircraftThreshold: 4,
    })
    expect(parseFacilityCode('1 * (5)')).toEqual({
      levelOrDamage: 1,
      trainbusting: true,
      aircraftThreshold: 5,
    })
    expect(parseFacilityCode('(6)')).toEqual({
      levelOrDamage: 0,
      trainbusting: false,
      aircraftThreshold: 6,
    })
    expect(parseFacilityCode('-')).toEqual({
      levelOrDamage: 0,
      trainbusting: false,
      aircraftThreshold: null,
    })
  })

  it('空军基地：数字结果降级（最低 1 级；简易机场永不降低）；括号结果对每架飞机掷骰', () => {
    expect(resolveFacilityOutcome({ code: '1', target: 'airBase', baseLevel: 3 })).toMatchObject({
      baseLevelAfter: 2,
    })
    expect(resolveFacilityOutcome({ code: '2', target: 'airBase', baseLevel: 1 })).toMatchObject({
      baseLevelAfter: 1,
    })
    expect(
      resolveFacilityOutcome({ code: '2', target: 'airBase', baseLevel: 3, isAirstrip: true }),
    ).toMatchObject({ baseLevelAfter: 3 })

    const withAircraft = resolveFacilityOutcome({
      code: '1 (5)',
      target: 'airBase',
      baseLevel: 2,
      aircraft: [
        { id: 'a', roll: 5 },
        { id: 'b', roll: 4 },
      ],
    })
    expect(withAircraft).toMatchObject({ baseLevelAfter: 1 })
    expect(withAircraft.aircraftLosses).toEqual([
      { id: 'a', roll: 5, stepLoss: true },
      { id: 'b', roll: 4, stepLoss: false },
    ])
  })

  it('港口：只有 1/2 造成伤害且累计上限 4 点；运输破坏需 `*` 结果', () => {
    expect(
      resolveFacilityOutcome({ code: '1', target: 'port', portDamageBefore: 2 }),
    ).toMatchObject({
      portDamage: 3,
    })
    expect(
      resolveFacilityOutcome({ code: '2', target: 'port', portDamageBefore: 4 }),
    ).toMatchObject({
      portDamage: 4,
    })
    expect(
      resolveFacilityOutcome({ code: '(6)', target: 'port', portDamageBefore: 2 }),
    ).toMatchObject({
      portDamage: 2,
    })
    expect(resolveFacilityOutcome({ code: '1 * (4)', target: 'trainbusting' })).toMatchObject({
      trainbustingPlaced: true,
    })
    expect(resolveFacilityOutcome({ code: '1 (4)', target: 'trainbusting' })).toMatchObject({
      trainbustingPlaced: false,
    })
  })
})

/* ────────────────────────────── 10.0d / 10.0e 资格与阶段 ────────────────────────────── */

describe('10.0d / 10.0e 轰炸资格：阶段门槛、同类型、每格每阶段一次', () => {
  const base = {
    kind: 'artillery' as const,
    phase: 'combat' as const,
    declaredTarget: 'combatUnits' as const,
    unitCount: 2,
    totalValue: 16,
  }

  it('10.0e-D：火炮只能在战斗/反应/进击阶段（战斗阶段 ✓、移动阶段 ✗）', () => {
    expect(barrageEligibility(base)).toMatchObject({ ok: true })
    expect(barrageEligibility({ ...base, phase: 'movement' })).toMatchObject({
      ok: false,
      rule: '10.0e-D',
    })
    expect(barrageEligibility({ ...base, phase: 'reaction' }).ok).toBe(true)
    expect(barrageEligibility({ ...base, phase: 'exploitation' }).ok).toBe(true)
  })

  it('10.0e-C：空军/海军可在移动阶段（战斗阶段 ✗）', () => {
    const air = { ...base, kind: 'air' as const, unitCount: 3 }
    expect(barrageEligibility({ ...air, phase: 'movement' })).toMatchObject({ ok: true })
    expect(barrageEligibility({ ...air, phase: 'combat' })).toMatchObject({
      ok: false,
      rule: '10.0e-C',
    })
  })

  it('10.0e-A/B/F：每格每阶段一次、每单位一次、不得拆分/低于印刷值、同类型', () => {
    expect(barrageEligibility({ ...base, hexAlreadyBarragedThisPhase: true })).toMatchObject({
      ok: false,
      rule: '10.0e-A',
    })
    // 低空扫射是例外（且它发生在移动环节）
    expect(
      barrageEligibility({
        ...base,
        kind: 'air',
        phase: 'movement',
        hexAlreadyBarragedThisPhase: true,
        hipShoot: true,
      }),
    ).toMatchObject({ ok: false, rule: '10.0b' }) // 仍缺观察员 ⇒ 以 10.0b 拒
    expect(
      barrageEligibility({
        ...base,
        kind: 'air',
        phase: 'movement',
        unitCount: 1, // 14.7d-B：低空扫射须**单机**
        hexAlreadyBarragedThisPhase: true,
        hipShoot: true,
        hasSpotter: true,
      }).ok,
    ).toBe(true)
    expect(barrageEligibility({ ...base, unitAlreadyBarragedThisPhase: true })).toMatchObject({
      ok: false,
      rule: '10.0e-B',
    })
    expect(barrageEligibility({ ...base, splitValue: true }).rule).toBe('10.0e-B')
    expect(barrageEligibility({ ...base, belowPrintedValue: true }).rule).toBe('10.0e-B')
    expect(barrageEligibility({ ...base, mixedKinds: true })).toMatchObject({
      ok: false,
      rule: '10.0e-F',
    })
  })

  it('13.4a：处于预备或战略模式的火炮不能轰炸；10.0：空军单任务 ≤4 机', () => {
    expect(barrageEligibility({ ...base, artilleryInReserveOrStrat: true })).toMatchObject({
      ok: false,
      rule: '13.4a',
    })
    expect(
      barrageEligibility({ ...base, kind: 'air', unitCount: 5, phase: 'movement' }),
    ).toMatchObject({ ok: false, reason: 'tooManyAircraft' })
    expect(barrageEligibility({ ...base, totalValue: 0 })).toMatchObject({
      ok: false,
      reason: 'belowMinBarrageValue',
    })
  })

  it('10.0b：低空扫射必须有正确的观察员（且发生在移动环节）', () => {
    expect(
      barrageEligibility({ ...base, kind: 'air', phase: 'movement', hipShoot: true }),
    ).toMatchObject({
      ok: false,
      rule: '10.0b',
      reason: 'hipShootNeedsCorrectSpotter',
    })
    expect(
      barrageEligibility({
        ...base,
        kind: 'air',
        phase: 'movement',
        unitCount: 1, // 14.7d-B：低空扫射须**单机**
        hipShoot: true,
        hasSpotter: true,
      }).ok,
    ).toBe(true)
  })

  it('14.7d-B/D：低空扫射须**单机**、且**不得**用于运输破坏', () => {
    const hip = {
      kind: 'air' as const,
      phase: 'movement' as const,
      declaredTarget: 'trainbusting' as const,
      unitCount: 1,
      totalValue: 16,
      hipShoot: true,
      hasSpotter: true,
    }
    // 14.7d-D：运输破坏不能作为低空扫射
    expect(barrageEligibility(hip)).toMatchObject({ ok: false, rule: '14.7d-D' })
    // 换成对战斗单位轰炸则须单机
    expect(barrageEligibility({ ...hip, declaredTarget: 'combatUnits' }).ok).toBe(true)
    expect(
      barrageEligibility({ ...hip, declaredTarget: 'combatUnits', unitCount: 3 }),
    ).toMatchObject({ ok: false, rule: '14.7d-B' })
  })
})
