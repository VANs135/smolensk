import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import {
  RAIL_CAP_PER_TRANSPORT_EQUIVALENT,
  RAIL_MOVEMENT_MP_COST,
  RAIL_MULTI_TRACK_MULTIPLIER,
  RAIL_POST_DETRAIN_MP,
  RAIL_PRE_LOAD_MA_FRACTION,
  RAIL_SHORT_LEG_EQUIVALENT_MULTIPLIER,
  RAIL_TRAINBUSTING_MULTIPLIER,
  convertedRailRun,
  createRailFacts,
  mergeTransportPoints,
  railCapacityCost,
  railPathFacts,
  splitTransportPoint,
  transportEquivalentOf,
  transportPointLoadCost,
  validateGaugeConversion,
  validateRailMovement,
  validateTransportPointLoad,
  validateTransportPointUnload,
  type GaugeConversionInput,
  type RailCargo,
  type RailCargoView,
  type RailFacts,
  type RailLayerSource,
  type RailMovementInput,
  type TransportPointView,
} from '@/engine/rules'

/**
 * 铁路运输与运输点数（B8）测试 —— 断言到条文一级
 *
 * 13.3a 铁路容量修正（破坏区加倍 / 全程多轨减半，4.3 累计）· 13.3b 仅移动阶段 ·
 * 13.3e 登车/移动/卸货三步（含 5.6a 移动模式、5.10d DG、4.7d 卸货后不得再动）·
 * 13.3f/13.3g 轨距转换（仅铁路修理单位、EZOC 内不可转、每阶段 ≤4 格、不得接力）·
 * 13.2c 运输点数合并/拆分（不耗 MP、同阶段、同类型、同格）·
 * 13.2f 装卸各耗印刷 MA 的 10%（4.2 取整）· 4.7 运输当量（含 4.7b 短腿减半）。
 */

const A: HexRef = { col: 36, row: 13 }
const B: HexRef = { col: 36, row: 14 }
const C: HexRef = { col: 36, row: 15 }

/** 三步路径（含起点与终点）：A → B → C */
const PATH: HexRef[] = [A, B, C]

function facts(over: Partial<RailFacts> = {}): RailFacts {
  return {
    hasRail: () => true,
    isRailConnected: () => true,
    railGaugeUsable: () => true,
    isControlled: () => true,
    inEnemyZoc: () => false,
    hasEnemyCombatUnit: () => false,
    isDetrainable: () => true,
    isTrainbusting: () => false,
    isMultiTrackEdge: () => false,
    isRailRepairUnit: () => false,
    ...over,
  }
}

/** 单位货物（缺省：轴方 4RE 步行 MA3 的移动模式单位，未登车前移动） */
function unitCargo(
  over: Partial<Extract<RailCargoView, { kind: 'unit' }>> = {},
): Extract<RailCargoView, { kind: 'unit' }> {
  return {
    kind: 'unit',
    id: 'u1',
    side: 'axis',
    re: 4,
    mobility: 'leg',
    moveMa: 3,
    mode: 'move',
    dg: false,
    currentMa: 3,
    preLoadMp: 0,
    ...over,
  }
}

function railed(over: Partial<RailMovementInput> = {}) {
  return validateRailMovement({
    phase: 'movement',
    cargo: unitCargo(),
    from: A,
    to: C,
    path: PATH,
    facts: facts(),
    ...over,
  })
}

/** 断言成功并返回 data */
function unwrap<T>(
  outcome: { ok: true; data: T } | { ok: false; rule: string; reason: string },
): T {
  if (!outcome.ok) throw new Error(`预期成功，实得失败：${outcome.rule} / ${outcome.reason}`)
  return outcome.data
}

describe('4.7 运输当量（4.7a/4.7b/4.7c）', () => {
  it('4.7a：1 RE 单位 = 1 当量；SP 与运输点数按自身数量计', () => {
    expect(transportEquivalentOf({ kind: 'unit', re: 4, mobility: 'track', moveMa: 8 })).toBe(4)
    expect(transportEquivalentOf({ kind: 'sp', amount: 3 })).toBe(3)
    expect(transportEquivalentOf({ kind: 'transportPoint', size: 2 })).toBe(2)
  })

  it('4.7b：移动模式印刷 MA 为 1–6 的**步行**单位当量减半', () => {
    expect(RAIL_SHORT_LEG_EQUIVALENT_MULTIPLIER).toBe(0.5)
    expect(transportEquivalentOf({ kind: 'unit', re: 4, mobility: 'leg', moveMa: 3 })).toBe(2)
    expect(transportEquivalentOf({ kind: 'unit', re: 4, mobility: 'leg', moveMa: 1 })).toBe(2)
    expect(transportEquivalentOf({ kind: 'unit', re: 4, mobility: 'leg', moveMa: 6 })).toBe(2)
    // MA 7 超出「1 至 6」区间 ⇒ 不减半
    expect(transportEquivalentOf({ kind: 'unit', re: 4, mobility: 'leg', moveMa: 7 })).toBe(4)
    // 非步行 MP（履带/轮式）不减半
    expect(transportEquivalentOf({ kind: 'unit', re: 4, mobility: 'track', moveMa: 3 })).toBe(4)
  })
})

describe('13.3a 铁路容量成本（破坏区加倍 / 全程多轨减半）', () => {
  const cargo: RailCargo = { kind: 'unit', re: 4, mobility: 'track', moveMa: 8 }

  it('13.3a：无路径修正时 1 点容量 = 1 当量', () => {
    const cost = railCapacityCost({
      cargo,
      path: { hasTrainbustingZone: false, entirePathMultiTrack: false },
    })
    expect(cost.factor).toBe(1)
    expect(cost.cost).toBe(4 * RAIL_CAP_PER_TRANSPORT_EQUIVALENT)
    expect(cost.rule).toBe('13.3a')
  })

  it('13.3a：路径含运输破坏区 ⇒ 费用翻倍', () => {
    const cost = railCapacityCost({
      cargo,
      path: { hasTrainbustingZone: true, entirePathMultiTrack: false },
    })
    expect(cost.factor).toBe(RAIL_TRAINBUSTING_MULTIPLIER)
    expect(cost.cost).toBe(8)
  })

  it('13.3a：路径全程多轨 ⇒ 费用减半', () => {
    const cost = railCapacityCost({
      cargo,
      path: { hasTrainbustingZone: false, entirePathMultiTrack: true },
    })
    expect(cost.factor).toBe(RAIL_MULTI_TRACK_MULTIPLIER)
    expect(cost.cost).toBe(2)
  })

  it('4.3：两条修正累计（破坏区 ×2 且全程多轨 ×½ ⇒ 回到原值）', () => {
    const cost = railCapacityCost({
      cargo,
      path: { hasTrainbustingZone: true, entirePathMultiTrack: true },
    })
    expect(cost.factor).toBe(RAIL_TRAINBUSTING_MULTIPLIER * RAIL_MULTI_TRACK_MULTIPLIER)
    expect(cost.cost).toBe(4)
  })

  it('4.7a：当量可为分数（如 2T + 1/2 RE）', () => {
    const cost = railCapacityCost({
      cargo: { kind: 'unit', re: 2, mobility: 'leg', moveMa: 4 },
      path: { hasTrainbustingZone: false, entirePathMultiTrack: false },
    })
    expect(cost.equivalent).toBe(1)
    expect(cost.cost).toBe(1)
  })

  it('13.3a：路径修正由路径逐格/逐段扫描得出（破坏区按格、多轨按格边）', () => {
    // 破坏区在 B 格；多轨在 A–B 与 B–C 两段格边上 ⇒ 全部命中
    const legs = new Set(['36.13|36.14', '36.14|36.15'])
    const pf = railPathFacts(PATH, {
      isTrainbusting: (hex) => hex.row === B.row,
      isMultiTrackEdge: (from, to) => {
        const [lo, hi] = [`${from.col}.${from.row}`, `${to.col}.${to.row}`].sort()
        return legs.has(`${lo}|${hi}`)
      },
    })
    expect(pf).toEqual({ hasTrainbustingZone: true, entirePathMultiTrack: true })
  })

  it('13.3a：只要**一段**格边是单轨，全程多轨即不成立（减半不适用）', () => {
    const pf = railPathFacts(PATH, {
      isTrainbusting: () => false,
      // 只有 A–B 是多轨，B–C 是单轨
      isMultiTrackEdge: (from, to) => from.row === A.row && to.row === B.row,
    })
    expect(pf.entirePathMultiTrack).toBe(false)
  })

  it('13.3a：单格路径（零段）不成立「全程多轨」（没有任何一段走在多轨上）', () => {
    const pf = railPathFacts([A], {
      isTrainbusting: () => false,
      isMultiTrackEdge: () => true,
    })
    expect(pf.entirePathMultiTrack).toBe(false)
  })
})

describe('13.3e 铁路移动三步（登车 → 移动 → 卸货，同一阶段）', () => {
  it('13.3b：只能在移动阶段使用铁路运量', () => {
    expect(railed({ phase: 'reaction' })).toMatchObject({
      ok: false,
      rule: '13.3b',
      reason: 'railOnlyInMovementPhase',
    })
    expect(railed({ phase: 'exploitation' })).toMatchObject({ ok: false, rule: '13.3b' })
  })

  it('13.3e：路径必须起于货物所在格、止于卸货格', () => {
    expect(railed({ path: [B, C] })).toMatchObject({ ok: false, reason: 'pathMustStartAtCargoHex' })
    expect(railed({ path: [A, B] })).toMatchObject({
      ok: false,
      reason: 'pathMustEndAtDestination',
    })
    expect(railed({ path: [] })).toMatchObject({ ok: false, reason: 'emptyPath' })
  })

  it('13.3e-1：登车格必须有铁路且为可火车卸货格，且不在敌方 ZOC（不可抵消）', () => {
    expect(railed({ facts: facts({ hasRail: (hex) => hex.row !== A.row }) })).toMatchObject({
      ok: false,
      reason: `entrainHexHasNoRail:${A.col}.${A.row}`,
    })
    expect(railed({ facts: facts({ isDetrainable: (hex) => hex.row !== A.row }) })).toMatchObject({
      ok: false,
      reason: `entrainHexNotDetrainable:${A.col}.${A.row}`,
    })
    expect(railed({ facts: facts({ inEnemyZoc: (hex) => hex.row === A.row }) })).toMatchObject({
      ok: false,
      reason: `entrainHexInEnemyZoc:${A.col}.${A.row}`,
    })
  })

  it('5.6a：铁路运输须移动模式（3 步同阶段）', () => {
    expect(railed({ cargo: unitCargo({ mode: 'combat' }) })).toMatchObject({
      ok: false,
      rule: '5.6a',
    })
    expect(railed({ cargo: unitCargo({ mode: 'strat' }) })).toMatchObject({
      ok: false,
      rule: '5.6a',
    })
  })

  it('5.10d：DG 单位不能使用铁路运输', () => {
    expect(railed({ cargo: unitCargo({ mode: 'move', dg: true }) })).toMatchObject({
      ok: false,
      rule: '5.10d',
    })
  })

  it('13.3e-2：路径必须逐格以铁路相接', () => {
    expect(
      railed({
        facts: facts({ isRailConnected: (from, to) => !(from.row === A.row && to.row === B.row) }),
      }),
    ).toMatchObject({
      ok: false,
      reason: `pathNotRailConnected:${A.col}.${A.row}>${B.col}.${B.row}`,
    })
  })

  it('13.3e-2 / 13.3f / 13.3h：路径格不得无铁路 / 错误轨距 / 未控制', () => {
    expect(railed({ facts: facts({ hasRail: (hex) => hex.row !== B.row }) })).toMatchObject({
      ok: false,
      reason: `pathHexHasNoRail:${B.col}.${B.row}`,
    })
    expect(railed({ facts: facts({ railGaugeUsable: (hex) => hex.row !== B.row }) })).toMatchObject(
      { ok: false, rule: '13.3f', reason: `pathHexWrongGauge:${B.col}.${B.row}` },
    )
    expect(railed({ facts: facts({ isControlled: (hex) => hex.row !== B.row }) })).toMatchObject({
      ok: false,
      rule: '13.3h',
      reason: `pathHexUncontrolled:${B.col}.${B.row}`,
    })
  })

  it('13.3e-2：不可进入有敌方战斗单位或有敌方 ZOC 的**途经格**', () => {
    expect(
      railed({ facts: facts({ hasEnemyCombatUnit: (hex) => hex.row === B.row }) }),
    ).toMatchObject({ ok: false, reason: `pathHexEnemyCombatUnit:${B.col}.${B.row}` })
    expect(railed({ facts: facts({ inEnemyZoc: (hex) => hex.row === B.row }) })).toMatchObject({
      ok: false,
      reason: `pathHexInEnemyZoc:${B.col}.${B.row}`,
    })
  })

  it('13.3e-3：卸货格必须有铁路、可卸货、轨距正确、受控，且无敌方单位与 ZOC', () => {
    expect(railed({ facts: facts({ hasRail: (hex) => hex.row !== C.row }) })).toMatchObject({
      ok: false,
      reason: `detrainHexHasNoRail:${C.col}.${C.row}`,
    })
    expect(railed({ facts: facts({ isDetrainable: (hex) => hex.row !== C.row }) })).toMatchObject({
      ok: false,
      reason: `detrainHexNotDetrainable:${C.col}.${C.row}`,
    })
    expect(railed({ facts: facts({ railGaugeUsable: (hex) => hex.row !== C.row }) })).toMatchObject(
      { ok: false, rule: '13.3f', reason: `detrainHexWrongGauge:${C.col}.${C.row}` },
    )
    expect(railed({ facts: facts({ isControlled: (hex) => hex.row !== C.row }) })).toMatchObject({
      ok: false,
      rule: '13.3h',
      reason: `detrainHexUncontrolled:${C.col}.${C.row}`,
    })
    expect(
      railed({ facts: facts({ hasEnemyCombatUnit: (hex) => hex.row === C.row }) }),
    ).toMatchObject({ ok: false, reason: `detrainHexEnemyCombatUnit:${C.col}.${C.row}` })
    // 卸货格在敌方 ZOC 内 ⇒ 拒绝（13.3e-3）
    expect(railed({ facts: facts({ inEnemyZoc: (hex) => hex.row === C.row }) })).toMatchObject({
      ok: false,
      reason: `detrainHexInEnemyZoc:${C.col}.${C.row}`,
    })
  })

  it('13.3e 成功：铁路移动本身不耗 MP，只按容量计费；卸货后可用 MP 为 0（4.7d）', () => {
    const result = unwrap(railed())
    // 步行 MA3 的 4RE 单位 ⇒ 当量 2（4.7b），无路径修正 ⇒ 2 点容量
    expect(result.equivalent).toBe(2)
    expect(result.cost).toBe(2)
    // 13.3e / 4.7d：铁路移动不由 MA 结算（距离不限，只占容量）
    expect(result.mpCost).toBe(RAIL_MOVEMENT_MP_COST)
    expect(result.mpCost).toBe(0)
    // 4.7d：普通单位卸货后不得再移动
    expect(result.postDetrainMp).toBe(RAIL_POST_DETRAIN_MP)
    expect(result.postDetrainMp).toBe(0)
    expect(result.rule).toBe('13.3e')
  })

  it('13.3a：成功路径含破坏区 ⇒ 成本翻倍', () => {
    expect(
      unwrap(railed({ facts: facts({ isTrainbusting: (hex) => hex.row === B.row }) })).cost,
    ).toBe(4)
  })

  it('13.6b：增援/新 SP 可「地图外登车」（跳过登车格检查）', () => {
    const offMap = railed({
      entrainOffMap: true,
      facts: facts({
        hasRail: (hex) => hex.row !== A.row,
        isDetrainable: (hex) => hex.row !== A.row,
        inEnemyZoc: (hex) => hex.row === A.row,
      }),
    })
    expect(offMap.ok).toBe(true)
    // ★ 单位自身的运输资格仍照常校验（5.6a）
    expect(railed({ entrainOffMap: true, cargo: unitCargo({ mode: 'combat' }) })).toMatchObject({
      ok: false,
      rule: '5.6a',
    })
  })

  it('13.3g-C：铁路修理单位可在**任意**铁路格登车与卸货', () => {
    const repair = railed({
      cargo: unitCargo({ id: 'rr1' }),
      facts: facts({ isDetrainable: () => false, isRailRepairUnit: (id) => id === 'rr1' }),
    })
    expect(repair.ok).toBe(true)
  })

  it('13.3g-B：铁路修理单位可在**战斗模式**下使用铁路移动', () => {
    const repair = railed({
      cargo: unitCargo({ id: 'rr1', mode: 'combat' }),
      facts: facts({ isRailRepairUnit: (id) => id === 'rr1' }),
    })
    expect(repair.ok).toBe(true)
    // 普通单位在战斗模式下不得使用铁路（5.6a）
    expect(railed({ cargo: unitCargo({ mode: 'combat' }) })).toMatchObject({
      ok: false,
      rule: '5.6a',
    })
  })

  it('13.3g-B：铁路修理单位卸货后可用「完整 MA − 登车前移动」继续移动（4.7d 例外）', () => {
    const repairFacts = facts({ isRailRepairUnit: (id) => id === 'rr1' })

    // 移动模式：完整 MA 6 − 登车前 2 ⇒ 卸货后还可走 4 MP
    const moveMode = unwrap(
      railed({ cargo: unitCargo({ id: 'rr1', currentMa: 6, preLoadMp: 2 }), facts: repairFacts }),
    )
    expect(moveMode.postDetrainMp).toBe(4)

    // 战斗模式：以**战斗面** MA 为准（2 − 1 ⇒ 1 MP）
    const combatMode = unwrap(
      railed({
        cargo: unitCargo({ id: 'rr1', mode: 'combat', currentMa: 2, preLoadMp: 1 }),
        facts: repairFacts,
      }),
    )
    expect(combatMode.postDetrainMp).toBe(1)

    // 普通单位同一情形仍为 0（4.7d：卸货后不允许继续移动）
    expect(unwrap(railed({ cargo: unitCargo({ currentMa: 6, preLoadMp: 2 }) })).postDetrainMp).toBe(
      0,
    )
  })

  it('13.3e-1：登车前最多消耗「一半 MA」，且以当前生效面 MA 为准', () => {
    expect(RAIL_PRE_LOAD_MA_FRACTION).toBe(0.5)
    // 移动面 MA 3 ⇒ 上限 1.5
    expect(railed({ cargo: unitCargo({ currentMa: 3, preLoadMp: 1.5 }) }).ok).toBe(true)
    expect(railed({ cargo: unitCargo({ currentMa: 3, preLoadMp: 2 }) })).toMatchObject({
      ok: false,
      reason: 'preLoadMpExceedsHalfMa:2>1.5',
    })
    // 战斗面 MA 2（铁路修理单位）⇒ 上限 1
    const repairFacts = facts({ isRailRepairUnit: () => true })
    expect(
      railed({
        cargo: unitCargo({ id: 'rr1', mode: 'combat', currentMa: 2, preLoadMp: 1 }),
        facts: repairFacts,
      }).ok,
    ).toBe(true)
    expect(
      railed({
        cargo: unitCargo({ id: 'rr1', mode: 'combat', currentMa: 2, preLoadMp: 1.5 }),
        facts: repairFacts,
      }),
    ).toMatchObject({ ok: false, reason: 'preLoadMpExceedsHalfMa:1.5>1' })
  })
})

describe('13.3f / 13.3g 轨距转换', () => {
  const base: GaugeConversionInput = {
    phase: 'movement',
    unit: { id: 'rr1', side: 'axis' },
    targetHex: B,
    convertedThisPhase: 0,
    mode: 'combat',
    orientation: 'combat',
    dg: false,
    currentMa: 4,
    usedNewlyConvertedRailThisPhase: false,
    facts: facts({ isRailRepairUnit: (id) => id === 'rr1' }),
  }

  it('13.3g：只有铁路修理单位能转换轨距', () => {
    expect(validateGaugeConversion({ ...base, unit: { id: 'inf1', side: 'axis' } })).toMatchObject({
      ok: false,
      rule: '13.3g',
      reason: 'notRailRepairUnit:inf1',
    })
  })

  it('13.3g-D：只能在移动阶段转换', () => {
    expect(validateGaugeConversion({ ...base, phase: 'reaction' })).toMatchObject({
      ok: false,
      reason: 'conversionOnlyInMovementPhase',
    })
  })

  it('13.3f：目标格必须有铁路', () => {
    expect(
      validateGaugeConversion({
        ...base,
        facts: facts({ isRailRepairUnit: () => true, hasRail: () => false }),
      }),
    ).toMatchObject({ ok: false, reason: `targetHexHasNoRail:${B.col}.${B.row}` })
  })

  it('13.3f-A：敌方 ZOC 内不可转换轨距（无法被抵消）', () => {
    expect(
      validateGaugeConversion({
        ...base,
        facts: facts({ isRailRepairUnit: () => true, inEnemyZoc: () => true }),
      }),
    ).toMatchObject({ ok: false, rule: '13.3f', reason: `enemyZocCannotConvert:${B.col}.${B.row}` })
  })

  it('13.3g-D / 5.10e：须战斗模式，或 DG 但朝向战斗面', () => {
    // 移动模式且朝向移动面 ⇒ 不允许
    expect(validateGaugeConversion({ ...base, mode: 'move', orientation: 'move' })).toMatchObject({
      ok: false,
      reason: 'mustBeCombatMode:rr1',
    })
    // DG 但朝向战斗面 ⇒ 允许（5.10e）
    expect(
      validateGaugeConversion({ ...base, mode: 'move', dg: true, orientation: 'combat' }).ok,
    ).toBe(true)
    // DG 且朝向移动面 ⇒ 不允许
    expect(
      validateGaugeConversion({ ...base, mode: 'move', dg: true, orientation: 'move' }),
    ).toMatchObject({ ok: false, reason: 'mustBeCombatMode:rr1' })
  })

  it('13.3g-D：每移动阶段至多 4 格；当前 MA 小于 4 时取 MA', () => {
    expect(validateGaugeConversion({ ...base, convertedThisPhase: 3 }).ok).toBe(true)
    expect(validateGaugeConversion({ ...base, convertedThisPhase: 4 })).toMatchObject({
      ok: false,
      reason: 'conversionLimitReached:4>=4',
    })
    // 当前 MA 2 ⇒ 上限 2
    expect(validateGaugeConversion({ ...base, currentMa: 2, convertedThisPhase: 2 })).toMatchObject(
      {
        ok: false,
        reason: 'conversionLimitReached:2>=2',
      },
    )
  })

  it('13.3g-A：不得「接力」（用铁路移动进入刚转换的格后再转换）', () => {
    expect(
      validateGaugeConversion({ ...base, usedNewlyConvertedRailThisPhase: true }),
    ).toMatchObject({ ok: false, reason: 'noLeapfrogging:rr1' })
  })

  it('13.3f-B：转换不消耗 SP，也不消耗额外移动点数', () => {
    const result = unwrap(validateGaugeConversion(base))
    expect(result).toMatchObject({ convertedThisPhase: 1, spCost: 0, mpCost: 0, rule: '13.3f' })
  })
})

describe('专规 1.2 剧本初设换轨：端点原文 → 逐格清单', () => {
  /** 实地图铁路邻接（`rail === true` 的格边） */
  const realRailNeighbors = (hex: HexRef): HexRef[] => {
    const found: HexRef[] = []
    for (const edge of mapLayers.edges) {
      if (edge.rail !== true) continue
      if (edge.a.col === hex.col && edge.a.row === hex.row) found.push(edge.b)
      if (edge.b.col === hex.col && edge.b.row === hex.row) found.push(edge.a)
    }
    return found
  }
  const source = { railNeighbors: realRailNeighbors }
  const hexOf = (text: string): HexRef => {
    const [col, row] = text.split('.').map((n) => Number(n))
    return { col: col!, row: row! }
  }

  /** 剧本页声明的全部走线（与 `src/data/scenarios.json` 的 `setup.convertedAxisRails` 同源写法） */
  const DECLARED_RUNS: Record<string, string[]> = {
    1: ['01.03 to 2.02'],
    2: ['01.03 to 2.02'],
    3: ['01.03 to 2.02', '01.19 to 4.18', '01.07 to 4.07'],
    4: ['01.03 to 2.02', '01.19 to 4.18', '01.07 to 4.07'],
    5: ['01.03 to 2.02', '01.19 to 24.19', '01.07 to 24.06'],
    6: ['01.03 to 2.02', '01.19 to 24.19', '01.07 to 24.06'],
    7: ['01.03 to 2.02', '01.19 to 34.18', '01.07 to 38.05', '15.10 to 18.18'],
  }

  it('专规 1.2：剧本页每条走线都在**实地图**上唯一可推（分叉/不连通即失败）', () => {
    let runs = 0
    let hexes = 0
    for (const [scenarioId, declarations] of Object.entries(DECLARED_RUNS)) {
      for (const declaration of declarations) {
        const [fromText, toText] = declaration.split(' to ')
        const outcome = convertedRailRun(source, {
          from: hexOf(fromText!),
          to: hexOf(toText!),
        })
        expect(`${scenarioId} ${declaration} ${outcome.ok ? 'ok' : outcome.reason}`).toBe(
          `${scenarioId} ${declaration} ok`,
        )
        if (!outcome.ok) continue
        runs += 1
        hexes += outcome.data.hexes.length
        // 端点必须在清单里（含两端），且首尾就是原文顺序
        expect(outcome.data.hexes[0]).toEqual(hexOf(fromText!))
        expect(outcome.data.hexes.at(-1)).toEqual(hexOf(toText!))
        // 逐格相邻（清单是一条连续的铁路线）
        for (let index = 1; index < outcome.data.hexes.length; index += 1)
          expect(
            realRailNeighbors(outcome.data.hexes[index - 1]!).some(
              (item) =>
                item.col === outcome.data.hexes[index]!.col &&
                item.row === outcome.data.hexes[index]!.row,
            ),
          ).toBe(true)
      }
    }
    // 7 个剧本共 18 段走线（剧本 1/2 各 1、3/4/5/6 各 3、7 有 4）
    expect(runs).toBe(18)
    expect(hexes).toBeGreaterThan(0)
  })

  it('专规 1.2：剧本 1 的走线恰是 01.03→02.02 两格（印刷初设卡「place in 2.02」）', () => {
    const outcome = unwrap(convertedRailRun(source, { from: hexOf('01.03'), to: hexOf('02.02') }))
    expect(outcome.hexes.map((hex) => `${hex.col}.${hex.row}`)).toEqual(['1.3', '2.2'])
  })

  it('专规 1.2：走线长度随端点的列号单调（01.19→24.19 为 24 格），且正反向同长', () => {
    const forward = unwrap(convertedRailRun(source, { from: hexOf('01.19'), to: hexOf('24.19') }))
    const backward = unwrap(convertedRailRun(source, { from: hexOf('24.19'), to: hexOf('01.19') }))
    expect(forward.hexes).toHaveLength(24)
    expect(backward.hexes).toHaveLength(24)
    expect([...backward.hexes].reverse()).toEqual(forward.hexes)
  })

  it('13.3f：端点不在铁路图上 ⇒ 失败且原因可读（不悄悄给空集）', () => {
    // 1.1 在铁路图上不存在（实地图铁路共 357 格，无 1.1）
    expect(convertedRailRun(source, { from: hexOf('01.01'), to: hexOf('02.02') })).toMatchObject({
      ok: false,
      rule: '13.3f',
      reason: 'convertedRunDisconnected:1.1-2.2',
    })
  })

  it('13.3f：最短路径不唯一（分叉）⇒ 失败，不猜一条', () => {
    /*
     * 造一条菱形：A=0 → 两个中继（1 与 9）→ B=100。
     * 两条最短路径等长 ⇒ 「A 到 B 的那条铁路线」并不唯一，必须失败而不是任选一条。
     */
    const diamond = (hex: HexRef): HexRef[] => {
      const map: Record<string, HexRef[]> = {
        '0.0': [{ col: 1, row: 0 }],
        '1.0': [{ col: 0, row: 0 }],
      }
      if (hex.col === 0)
        return [
          { col: 1, row: 0 },
          { col: 9, row: 0 },
        ]
      if (hex.col === 1)
        return [
          { col: 0, row: 0 },
          { col: 100, row: 0 },
        ]
      if (hex.col === 9)
        return [
          { col: 0, row: 0 },
          { col: 100, row: 0 },
        ]
      if (hex.col === 100) return []
      return map[`${hex.col}.${hex.row}`] ?? []
    }
    expect(
      convertedRailRun(
        { railNeighbors: diamond },
        { from: { col: 0, row: 0 }, to: { col: 100, row: 0 } },
      ),
    ).toMatchObject({ ok: false, rule: '13.3f' })
  })
})

describe('13.2c 运输点数合并 / 拆分（不耗 MP、仅友方移动阶段、同类型同格）', () => {
  const truck = (over: Partial<TransportPointView> = {}): TransportPointView => ({
    id: 't1',
    type: 'truck',
    size: 1,
    hex: A,
    ...over,
  })

  it('13.2c：只能在友方移动阶段合并/拆分', () => {
    expect(
      mergeTransportPoints({
        phase: 'reaction',
        side: 'axis',
        activeSide: 'axis',
        points: [truck(), truck({ id: 't2' })],
      }),
    ).toMatchObject({ ok: false, reason: 'transportPointOpsOnlyInMovementPhase' })
    expect(
      mergeTransportPoints({
        phase: 'movement',
        side: 'soviet',
        activeSide: 'axis',
        points: [truck(), truck({ id: 't2' })],
      }),
    ).toMatchObject({ ok: false, reason: 'transportPointOpsOnlyInFriendlyPhase' })
  })

  it('13.2c：合并需 ≥2 个、同类型、同格；成功则不耗 MP', () => {
    expect(
      mergeTransportPoints({
        phase: 'movement',
        side: 'axis',
        activeSide: 'axis',
        points: [truck()],
      }),
    ).toMatchObject({ ok: false, reason: 'mergeNeedsAtLeastTwoPoints' })

    expect(
      mergeTransportPoints({
        phase: 'movement',
        side: 'axis',
        activeSide: 'axis',
        points: [truck(), truck({ id: 't2', type: 'wagon' })],
      }),
    ).toMatchObject({ ok: false, reason: 'differentTypesCannotMerge' })

    expect(
      mergeTransportPoints({
        phase: 'movement',
        side: 'axis',
        activeSide: 'axis',
        points: [truck(), truck({ id: 't2', hex: B })],
      }),
    ).toMatchObject({ ok: false, reason: 'differentHexesCannotMerge' })

    const merged = unwrap(
      mergeTransportPoints({
        phase: 'movement',
        side: 'axis',
        activeSide: 'axis',
        points: [truck({ size: 2 }), truck({ id: 't2', size: 3 })],
      }),
    )
    expect(merged).toMatchObject({ type: 'truck', size: 5, mpCost: 0, rule: '13.2c' })
  })

  it('13.2c：拆分需 ≥2 份、每份为正、合计等于原规模；成功则不耗 MP', () => {
    const split = (sizes: readonly number[]) =>
      splitTransportPoint({
        phase: 'movement',
        side: 'axis',
        activeSide: 'axis',
        point: { id: 't1', type: 'truck', size: 4 },
        sizes,
      })

    expect(split([4])).toMatchObject({ ok: false, reason: 'splitNeedsAtLeastTwoParts' })
    expect(split([2, 0])).toMatchObject({ ok: false, reason: 'badSplitSize:2,0' })
    expect(split([2, 1])).toMatchObject({ ok: false, reason: 'splitSumMismatch:3!=4' })

    const result = unwrap(split([1, 3]))
    expect(result).toMatchObject({ type: 'truck', sizes: [1, 3], mpCost: 0, rule: '13.2c' })
  })
})

describe('13.2f 运输点数装载 / 卸载（各耗印刷 MA 的 10%）', () => {
  const actor = { id: 't1', type: 'truck', printedMa: 45, isOrganicTruck: false }

  it('13.2f：费用 = 印刷 MA × 10%，按 4.2 取整（规则书原例 45MA ⇒ 5MP）', () => {
    expect(transportPointLoadCost(45)).toBe(5)
    expect(transportPointLoadCost(10)).toBe(1)
    expect(transportPointLoadCost(6)).toBe(1) // 0.6 ⇒ 1
  })

  it('13.2f：装载必须与补给站同格（可在任何格装载）', () => {
    expect(validateTransportPointLoad({ transportPoint: actor, dumpInHex: false })).toMatchObject({
      ok: false,
      reason: 'loadRequiresDumpInHex',
    })
    expect(
      unwrap(validateTransportPointLoad({ transportPoint: actor, dumpInHex: true })).cost,
    ).toBe(5)
  })

  it('13.2f：卸载需格内有友方战斗单位/港口/空军基地/已卸载补给站', () => {
    expect(
      validateTransportPointUnload({ transportPoint: actor, hexAllowsUnload: false }),
    ).toMatchObject({ ok: false, reason: 'unloadRequirementsNotMet' })
    expect(
      unwrap(validateTransportPointUnload({ transportPoint: actor, hexAllowsUnload: true })).cost,
    ).toBe(5)
  })

  it('13.2g-A：编内卡车永远不能在地图上卸载 SP', () => {
    expect(
      validateTransportPointUnload({
        transportPoint: { ...actor, isOrganicTruck: true },
        hexAllowsUnload: true,
      }),
    ).toMatchObject({ ok: false, rule: '13.2g', reason: 'organicTruckCannotUnload:t1' })
  })
})

describe('createRailFacts：静态铁路图层（产品数据）→ 事实', () => {
  const source: RailLayerSource = {
    edges: [
      { a: A, b: B, rail: true, multiTrack: true },
      { a: B, b: C },
    ],
  }
  const railFacts = createRailFacts({
    isControlled: () => true,
    railGaugeUsable: () => true,
    inEnemyZoc: () => false,
    hasEnemyCombatUnit: () => false,
    isDetrainable: () => true,
    isRailRepairUnit: () => false,
    source,
  })

  it('hasRail / isRailConnected 由铁路格边建索引得出', () => {
    expect(railFacts.hasRail(A)).toBe(true)
    expect(railFacts.hasRail(B)).toBe(true)
    expect(railFacts.hasRail(C)).toBe(false) // 只有公路边，无铁路
    expect(railFacts.isRailConnected(A, B)).toBe(true)
    expect(railFacts.isRailConnected(B, C)).toBe(false)
    // 不相邻的两格不造边键
    expect(railFacts.isRailConnected(A, C)).toBe(false)
  })

  it('13.3a：单/多轨由静态图层的格边标记得出（两格皆视为多轨格，但只有标注的那**一条边**是多轨）', () => {
    expect(railFacts.isMultiTrackEdge(A, B)).toBe(true)
    expect(railFacts.isMultiTrackEdge(B, A)).toBe(true) // 格边无序
    expect(railFacts.isMultiTrackEdge(B, C)).toBe(false) // 同格的另一条边是单轨
    expect(railFacts.isMultiTrackEdge(A, C)).toBe(false) // 不存在这条格边
    // 无 rail: true 的边即使标了 multiTrack 也不算（数据自洽的下界）
    const stray = createRailFacts({
      isControlled: () => true,
      railGaugeUsable: () => true,
      inEnemyZoc: () => false,
      hasEnemyCombatUnit: () => false,
      isDetrainable: () => true,
      isRailRepairUnit: () => false,
      source: { edges: [{ a: A, b: B, multiTrack: true }] },
    })
    expect(stray.isMultiTrackEdge(A, B)).toBe(false)
    expect(railFacts.isTrainbusting(A)).toBe(false)
  })

  it('13.3a：全程多轨 ⇒ 该路径的费用减半（经 railPathFacts 与事实联动）', () => {
    const multi = createRailFacts({
      isControlled: () => true,
      railGaugeUsable: () => true,
      inEnemyZoc: () => false,
      hasEnemyCombatUnit: () => false,
      isDetrainable: () => true,
      isRailRepairUnit: () => false,
      source: {
        edges: [
          { a: A, b: B, rail: true, multiTrack: true },
          { a: B, b: C, rail: true, multiTrack: true },
        ],
      },
    })
    const path = [A, B, C]
    expect(railPathFacts(path, multi).entirePathMultiTrack).toBe(true)
    const cost = railCapacityCost({ cargo: unitCargo(), path: railPathFacts(path, multi) })
    // 4RE 步行 MA3 ⇒ 当量 2（4.7b 短腿减半）；多轨减半 ⇒ 1
    expect(cost.equivalent).toBe(2)
    expect(cost.cost).toBe(1)
    expect(cost.detail).toContain('全程多轨')
    // 末段换成单轨 ⇒ 不减半
    const broken = railPathFacts(path, {
      isTrainbusting: multi.isTrainbusting,
      isMultiTrackEdge: (from, to) => multi.isMultiTrackEdge(from, to) && from.row !== B.row,
    })
    expect(broken.entirePathMultiTrack).toBe(false)
    expect(railCapacityCost({ cargo: unitCargo(), path: broken }).cost).toBe(2)
  })

  it('13.3e：用产品数据建的铁路事实可跑通三步校验', () => {
    const result = validateRailMovement({
      phase: 'movement',
      cargo: unitCargo(),
      from: A,
      to: B,
      path: [A, B],
      facts: railFacts,
    })
    expect(result.ok).toBe(true)
  })
})
