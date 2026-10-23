import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'

import { neighbors } from '@/engine/hex-geometry'
import {
  OVERRUN_MAX_ENTRY_MP,
  availableMa,
  canOverrun,
  canonicalMode,
  computeReachableHexes,
  createMapFacts,
  evaluateStep,
  exertsZoc,
  inEnemyZocAt,
  projectsZoc,
  requiresFuel,
  zocNegatedAt,
  zocSourcesOf,
} from '@/engine/rules'
import type { MoveContext, MoveUnitView, StepFailure, StepSuccess } from '@/engine/rules'

/**
 * 移动（OCS 6.0 / 6.1 / 6.2 + 4.5a-A + 4.5b + 8.1）测试
 *
 * 地形费率取自 charts-tec.json 的真实值（Open 1／Forest leg2·track3·truck4／Swamp 履带轮式禁入／
 * 二级道路 0.5／小河 delta 步行+1·履带+3·轮式+5／大河 履带轮式禁入·步行 All）。
 * 用合成地图隔离规则，另有一组用**产品真实地图**（createMapFacts）验证接线。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
const normalized = (a: HexRef, b: HexRef): string => {
  const [x, y] = [key(a), key(b)].sort()
  return `${x}|${y}`
}

/** 合成地图：默认全 'Open'，可覆写格内地形与格边 */
function makeMap(
  config: {
    onMap?: (hex: HexRef) => boolean
    terrains?: Record<string, readonly string[]>
    crossings?: Record<string, { river?: string | null; routes?: readonly string[] }>
  } = {},
) {
  return {
    onMap: config.onMap ?? (() => true),
    terrainsAt: (hex: HexRef): readonly string[] => config.terrains?.[key(hex)] ?? ['Open'],
    crossingBetween: (a: HexRef, b: HexRef) => config.crossings?.[normalized(a, b)] ?? null,
  }
}

/** 单位视图夹具：默认轴方步行战斗单位、战斗模式、MA 6、补给充足 */
function unit(over: Partial<MoveUnitView> = {}): MoveUnitView {
  return {
    id: 'u1',
    side: 'axis',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: { col: 36, row: 13 },
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

/** 敌方 ZOC 源（战斗模式 + 可攻击 + 非断补 + 未混乱） */
function enemy(hex: HexRef, over: Partial<MoveUnitView> = {}): MoveUnitView {
  return unit({ id: `enemy-${key(hex)}`, side: 'soviet', hex, ...over })
}

function context(units: readonly MoveUnitView[], over: Partial<MoveContext> = {}): MoveContext {
  return { phase: 'movement', activeSide: 'axis', map: makeMap(), units, ...over }
}

/** 断言为成功并返回成功结果（类型收窄辅助） */
function expectOk(outcome: ReturnType<typeof evaluateStep>): StepSuccess {
  if (!outcome.ok) throw new Error(`预期成功，实得失败：${outcome.reason} / ${outcome.rule}`)
  return outcome
}

/** 断言为失败并返回失败结果 */
function expectFail(outcome: ReturnType<typeof evaluateStep>): StepFailure {
  if (outcome.ok) throw new Error('预期失败，实得成功')
  return outcome
}

/* ────────────────────────────── MA 与燃料 ────────────────────────────── */
describe('可用 MA 与燃料需求（6.1h / 12.5a）', () => {
  it('6.1h：按模式修正后不取整（战略 ×2、DG ×1/2、进击 ×1/2）', () => {
    expect(availableMa(unit({ ma: 5 }), 'movement')).toBe(5)
    expect(availableMa(unit({ ma: 5, mode: 'strat', orientation: 'move' }), 'movement')).toBe(10)
    expect(availableMa(unit({ ma: 5, dg: true }), 'movement')).toBe(2.5)
    expect(availableMa(unit({ ma: 5, exploit: true }), 'exploitation')).toBe(2.5)
  })

  it('12.5a：只有「轮式/履带 MP 的战斗单位」需要燃料', () => {
    expect(requiresFuel(unit({ mobility: 'truck' }))).toBe(true)
    expect(requiresFuel(unit({ mobility: 'track' }))).toBe(true)
    expect(requiresFuel(unit({ mobility: 'leg' }))).toBe(false)
    // 卡车/运输点数等非战斗单位永远不需要燃料
    expect(requiresFuel(unit({ mobility: 'truck', isCombat: false }))).toBe(false)
  })
})

/* ────────────────────────────── 逐步移动 ────────────────────────────── */

describe('逐步移动（6.1 / 6.2）', () => {
  it('平地相邻：按目标格地形取费（Open = 1 MP）', () => {
    const ctx = context([unit()])
    const step = expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))
    expect(step.cost).toBe(1)
    expect(step.hexCost).toBe(1)
    expect(step.hexsideCost).toBe(0)
    expect(step.roadOverride).toBe(false)
    expect(step.minimumMove).toBe(false)
  })

  it('6.2d：格内多地形取最贵（Forest track=3）', () => {
    const ctx = context([unit({ mobility: 'track', fuelled: true })], {
      map: makeMap({ terrains: { '36.14': ['Open', 'Forest'] } }),
    })
    expect(expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 })).cost).toBe(3)
  })

  it('6.2a：沿连续道路移动付道路费率并忽略格内地形（Forest track=3 → 二级道路 0.5）', () => {
    const ctx = context([unit({ mobility: 'track', fuelled: true })], {
      map: makeMap({
        terrains: { '36.14': ['Forest'] },
        crossings: { '36.13|36.14': { routes: ['Secondary Road'] } },
      }),
    })
    const step = expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))
    expect(step.cost).toBe(0.5)
    expect(step.roadOverride).toBe(true)
  })

  it('6.2b：格边地形消耗与进入格消耗相加（步行过小河 +1）', () => {
    const ctx = context([unit({ mobility: 'leg' })], {
      map: makeMap({ crossings: { '36.13|36.14': { river: 'Minor River' } } }),
    })
    const step = expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))
    expect(step.hexCost).toBe(1)
    expect(step.hexsideCost).toBe(1)
    expect(step.cost).toBe(2)
  })

  it('桥（河 + 路）取消河效果并按所走道路计费', () => {
    const ctx = context([unit({ mobility: 'truck', fuelled: true })], {
      map: makeMap({
        crossings: { '36.13|36.14': { river: 'Minor River', routes: ['Secondary Road'] } },
      }),
    })
    const step = expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))
    expect(step.cost).toBe(0.5)
    expect(step.crossedOnBridge).toBe(true)
    expect(step.hexsideCost).toBe(0)
  })

  it('6.2c：禁入格（Swamp 对履带/轮式）拒绝', () => {
    const ctx = context([unit({ mobility: 'truck', fuelled: true })], {
      map: makeMap({ terrains: { '36.14': ['Swamp'] } }),
    })
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))).toMatchObject({
      reason: 'prohibited',
      rule: '6.2c',
    })
  })

  it('6.2c：禁入格边（大河对轮式）拒绝', () => {
    const ctx = context([unit({ mobility: 'truck', fuelled: true })], {
      map: makeMap({ crossings: { '36.13|36.14': { river: 'Major River' } } }),
    })
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 })).reason).toBe('prohibited')
  })

  it('地形写 All：可进入但耗尽全部残余 MA 并结束本轮移动（大河对步行）', () => {
    const ctx = context([unit({ mobility: 'leg', ma: 6 })], {
      map: makeMap({ crossings: { '36.13|36.14': { river: 'Major River' } } }),
    })
    const step = expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))
    expect(step.spendsAllMp).toBe(true)
    expect(step.mustEndMove).toBe(true)
  })

  it('6.1d：互逆性——身处禁入地形时不能从非道路格边离开', () => {
    // 轮式单位位于 Swamp 格（如初设所致）：进入 Open 本身可行，但反向为禁入 → 不合法
    const ctx = context([unit({ mobility: 'truck', fuelled: true })], {
      map: makeMap({ terrains: { '36.13': ['Swamp'] } }),
    })
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))).toMatchObject({
      reason: 'reciprocity',
      rule: '6.1d',
    })
  })

  it('6.1c：MP 不足但位于起点格时可走一格（最小移动）并结束本轮', () => {
    // 轮式进 Forest 需 4 MP，MA 只有 3 → 最小移动
    const ctx = context([unit({ mobility: 'truck', fuelled: true, ma: 3 })], {
      map: makeMap({ terrains: { '36.14': ['Forest'] } }),
    })
    const step = expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))
    expect(step.minimumMove).toBe(true)
    expect(step.mustEndMove).toBe(true)
    expect(step.cost).toBe(3)
  })

  it('6.1c（★ 用户裁定口径）：只有 1 点移动力、邻格消耗 2 也能进一格（用尽该点 MP）', () => {
    // 履带进 Woods 需 2 MP、MA 只有 1 → 仍可进一格，代价是把这 1 点用完
    const ctx = context([unit({ mobility: 'track', fuelled: true, ma: 1 })], {
      map: makeMap({ terrains: { '36.14': ['Woods'] } }),
    })
    const step = expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))
    expect(step.minimumMove).toBe(true)
    expect(step.cost).toBe(1) // 用尽剩余 MP
    expect(step.hexCost).toBe(2) // 地形实际要 2 MP（如实带出）
    expect(step.mustEndMove).toBe(true)
  })

  it('6.1c：禁入地形不受最小移动保护（不能进也不能穿）', () => {
    const ctx = context([unit({ mobility: 'truck', fuelled: true, ma: 1 })], {
      map: makeMap({ terrains: { '36.14': ['Swamp'] } }),
    })
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 })).reason).toBe('prohibited')
  })

  it('6.1c：已移动过则不再适用最小移动（MP 不足即拒绝）', () => {
    const ctx = context([unit({ mobility: 'truck', fuelled: true, ma: 3 })], {
      map: makeMap({ terrains: { '36.14': ['Forest'] } }),
    })
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 }, { mpSpent: 1 })).reason).toBe(
      'notEnoughMp',
    )
  })

  it('4.8a：堆叠超限**不是逐步禁令**——移动中可以暂时超堆叠，只如实标记并留待阶段末结算', () => {
    const blockers = [
      unit({ id: 'b1', hex: { col: 36, row: 14 }, re: 5 }),
      unit({ id: 'b2', hex: { col: 36, row: 14 }, re: 5 }),
    ]
    const ctx = context([unit({ re: 2 }), ...blockers])
    const step = expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))
    expect(step.createsOverstack).toBe(true)
    // 不造成超限时不标记
    const light = context([unit({ re: 2 }), unit({ id: 'b1', hex: { col: 36, row: 14 }, re: 1 })])
    expect(expectOk(evaluateStep(light, 'u1', { col: 36, row: 14 })).createsOverstack).toBe(false)
  })

  it('6.3b：目标格被敌方战斗单位占据时不能直接走进', () => {
    const ctx = context([unit(), enemy({ col: 36, row: 14 })])
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))).toMatchObject({
      reason: 'enemyOccupied',
      rule: '6.3b',
    })
  })

  it('12.5a：未加注燃料的轮式战斗单位不能消耗任何 MP', () => {
    const ctx = context([unit({ mobility: 'truck', fuelled: false })])
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))).toMatchObject({
      reason: 'needsFuel',
      rule: '12.5a',
    })
    // 加注后即可移动
    expectOk(
      evaluateStep(context([unit({ mobility: 'truck', fuelled: true })]), 'u1', {
        col: 36,
        row: 14,
      }),
    )
  })

  it('6.1b：无 MA 单位不可移动', () => {
    const ctx = context([unit({ ma: 0 })])
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))).toMatchObject({
      reason: 'immobile',
      rule: '6.1b',
    })
  })

  it('6.1：必须沿连续格（不相邻即拒绝）', () => {
    const ctx = context([unit()])
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 38, row: 13 })).reason).toBe('notAdjacent')
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 13 })).reason).toBe('notAdjacent')
  })

  it('图外格不可进入（含削角空洞）', () => {
    const ctx = context([unit()], {
      map: makeMap({ onMap: (hex) => !(hex.col === 36 && hex.row === 14) }),
    })
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 })).reason).toBe(
      'destinationOffMap',
    )
  })

  it('6.0 / 6.3a / 7.0a / 11.0a：阶段不许可即拒绝', () => {
    const ctx = context([unit()], { phase: 'reaction' })
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))).toMatchObject({
      reason: 'phaseNotAllowed',
      rule: '6.3a',
    })
  })
})

/* ────────────────────────────── ZOC：强制停止与垫人 ────────────────────────────── */

describe('敌方 ZOC：轮式强制停止与 4.5b 抵消（4.5a-A / 4.5b）', () => {
  const enemyAt = { col: 36, row: 14 }
  const target = { col: 37, row: 14 } // 与敌单位相邻，故目标格在其 ZOC 内

  it('轮式进入未抵消的敌方 ZOC 必须停止（不得继续移动）', () => {
    const ctx = context([unit({ mobility: 'truck', fuelled: true }), enemy(enemyAt)])
    const step = expectOk(evaluateStep(ctx, 'u1', target))
    expect(step.forcedStop).toBe(true)
    expect(step.mustEndMove).toBe(true)
  })

  it('步行与履带不受 ZOC 影响（4.5a-A 末句）', () => {
    for (const mobility of ['leg', 'track'] as const) {
      const ctx = context([unit({ mobility, fuelled: true }), enemy(enemyAt)])
      expect(expectOk(evaluateStep(ctx, 'u1', target)).forcedStop).toBe(false)
    }
  })

  it('4.5b 垫人：格内有己方战斗单位且已承诺本阶段不再消耗 MP → 抵消该格敌方 ZOC', () => {
    const ghost = unit({ id: 'ghost', hex: target, isCombat: true, mpLockedThisPhase: true })
    const ctx = context([unit({ mobility: 'truck', fuelled: true }), ghost, enemy(enemyAt)])
    expect(zocNegatedAt(ctx, target, 'axis')).toBe(true)
    expect(inEnemyZocAt(ctx, target, 'axis')).toBe(false)
    expect(expectOk(evaluateStep(ctx, 'u1', target)).forcedStop).toBe(false)
  })

  it('4.5b：非战斗单位（如 HQ/卡车）不能抵消 ZOC', () => {
    const nonCombat = unit({ id: 'hq', hex: target, isCombat: false, mpLockedThisPhase: true })
    const ctx = context([unit({ mobility: 'truck', fuelled: true }), nonCombat, enemy(enemyAt)])
    expect(zocNegatedAt(ctx, target, 'axis')).toBe(false)
    expect(expectOk(evaluateStep(ctx, 'u1', target)).forcedStop).toBe(true)
  })

  it('4.5b 代价：已承诺不再消耗 MP 的垫人单位自己不能再移动', () => {
    const ctx = context([unit({ mpLockedThisPhase: true })])
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))).toMatchObject({
      reason: 'mpLocked',
      rule: '4.5b',
    })
  })

  it('4.5：断补或混乱的敌方单位不投射 ZOC', () => {
    const noSupply = context([
      unit({ mobility: 'truck', fuelled: true }),
      enemy(enemyAt, { hasTraceSupply: false }),
    ])
    expect(expectOk(evaluateStep(noSupply, 'u1', target)).forcedStop).toBe(false)
    const dgEnemy = context([
      unit({ mobility: 'truck', fuelled: true }),
      enemy(enemyAt, { dg: true }),
    ])
    expect(expectOk(evaluateStep(dgEnemy, 'u1', target)).forcedStop).toBe(false)
  })
})

describe('5.8a：战略模式不得进入敌方 ZOC', () => {
  const enemyAt = { col: 36, row: 14 }
  const inZoc = { col: 37, row: 14 } // 与敌单位相邻，故在敌方 ZOC 内
  const strat = (over: Partial<MoveUnitView> = {}) =>
    unit({ mode: 'strat', orientation: 'move', ma: 8, ...over })

  it('战略单位不得**进入**敌方 ZOC（徒步也禁止——有别于 4.5a-A 只限轮式）', () => {
    const ctx = context([strat(), enemy(enemyAt)])
    expect(expectFail(evaluateStep(ctx, 'u1', inZoc))).toMatchObject({
      reason: 'stratIntoEzoc',
      rule: '5.8a',
    })
    // 对照：非战略单位的徒步可以进入（4.5a-A 对徒步/履带不设限）
    const normal = context([unit({ mobility: 'leg', ma: 8 }), enemy(enemyAt)])
    expect(expectOk(evaluateStep(normal, 'u1', inZoc)).forcedStop).toBe(false)
  })

  it('已在敌方 ZOC 内的战略单位可以走出（5.8a 只禁「进入」，括注：敌方靠近不触发任何特殊情形）', () => {
    const ctx = context([strat({ hex: inZoc }), enemy(enemyAt)])
    expect(expectOk(evaluateStep(ctx, 'u1', { col: 38, row: 14 })).cost).toBe(1)
  })
})

describe('ZOC 与模式矩阵的一致性（★ 进击叠加 / 预备释放）', () => {
  /** 经 move.ts 适配器把单位视图折成 ZOC 来源 */
  const sourceOf = (u: MoveUnitView) => zocSourcesOf([u])[0]!
  const stateOf = (u: MoveUnitView) => ({
    mode: u.mode,
    orientation: u.orientation,
    dg: u.dg,
    exploit: u.exploit,
    releasedFromReserve: u.releasedFromReserve,
  })

  /** 七种模式组合（基础面 × 层叠标记） */
  const MATRIX: [string, MoveUnitView][] = [
    ['战斗模式', unit({ mode: 'combat', orientation: 'combat' })],
    ['移动模式', unit({ mode: 'move', orientation: 'move' })],
    ['进击 + 战斗面', unit({ mode: 'combat', orientation: 'combat', exploit: true })],
    ['进击 + 移动面', unit({ mode: 'move', orientation: 'move', exploit: true })],
    ['预备未释放（战斗面）', unit({ mode: 'reserve', orientation: 'combat' })],
    [
      '预备已释放（战斗面）',
      unit({ mode: 'reserve', orientation: 'combat', releasedFromReserve: true }),
    ],
    ['战略（移动面）', unit({ mode: 'strat', orientation: 'move' })],
    ['DG（战斗面）', unit({ mode: 'combat', orientation: 'combat', dg: true })],
  ]

  it('exertsZoc（模式矩阵）与 projectsZoc（ZOC 模块）逐行一致，且只由 exertsZoc 裁定', () => {
    for (const [label, u] of MATRIX) {
      expect([label, projectsZoc(sourceOf(u))]).toEqual([label, exertsZoc(stateOf(u))])
    }
  })

  it('★ 进击 + 战斗面 = 有控制区；战斗模式有；移动模式/预备/战略/DG 无', () => {
    const expected: Record<string, boolean> = {
      战斗模式: true,
      '进击 + 战斗面': true,
      移动模式: false,
      '进击 + 移动面': false,
      '预备未释放（战斗面）': false,
      '预备已释放（战斗面）': true, // 5.7b：释放即回战斗/移动模式
      '战略（移动面）': false,
      'DG（战斗面）': false, // ★ 用户裁定：DG 无 ZOC
    }
    for (const [label, u] of MATRIX) {
      expect([label, exertsZoc(stateOf(u))]).toEqual([label, expected[label]])
      expect([label, projectsZoc(sourceOf(u))]).toEqual([label, expected[label]])
    }
  })

  it('相邻的「进击 + 战斗面」敌方单位照常投射 ZOC（轮式进入须停止）', () => {
    const target = { col: 37, row: 14 }
    const ctx = context([
      unit({ mobility: 'truck', fuelled: true }),
      enemy({ col: 36, row: 14 }, { mode: 'combat', orientation: 'combat', exploit: true }),
    ])
    expect(inEnemyZocAt(ctx, target, 'axis')).toBe(true)
    expect(expectOk(evaluateStep(ctx, 'u1', target)).forcedStop).toBe(true)
  })

  it('相邻的「已释放的预备（战斗面）」敌方单位也投射 ZOC（5.7b 回到战斗模式）', () => {
    const target = { col: 37, row: 14 }
    const ctx = context([
      unit({ mobility: 'truck', fuelled: true }),
      enemy(
        { col: 36, row: 14 },
        { mode: 'reserve', orientation: 'combat', releasedFromReserve: true },
      ),
    ])
    expect(inEnemyZocAt(ctx, target, 'axis')).toBe(true)
    expect(expectOk(evaluateStep(ctx, 'u1', target)).forcedStop).toBe(true)
  })

  it('canonicalMode：预备释放后折回朝向那一面；其余模式原样（5.7b）', () => {
    expect(
      canonicalMode(
        stateOf(unit({ mode: 'reserve', orientation: 'combat', releasedFromReserve: true })),
      ),
    ).toBe('combat')
    expect(
      canonicalMode(
        stateOf(unit({ mode: 'reserve', orientation: 'move', releasedFromReserve: true })),
      ),
    ).toBe('move')
    expect(canonicalMode(stateOf(unit({ mode: 'reserve', orientation: 'combat' })))).toBe('reserve')
    expect(
      canonicalMode(stateOf(unit({ mode: 'combat', orientation: 'combat', exploit: true }))),
    ).toBe('combat')
  })
})

/* ────────────────────────────── 可达格（UI 接口） ────────────────────────────── */

describe('可到达格查询（6.1a/6.1c，UI 接口）', () => {
  it('全 Open 地图、MA 3：可达半径 3 内共 36 格，且按格数升序', () => {
    const ctx = context([unit({ ma: 3 })])
    const result = computeReachableHexes(ctx, 'u1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ma).toBe(3)
    expect(result.reachable).toHaveLength(36) // 1+6+12+18 减去起点
    const distances = result.reachable.map((r) => r.mpSpent)
    expect([...distances].sort((a, b) => a - b)).toEqual(distances)
    expect(result.reachable.some((r) => r.hex.col === 36 && r.hex.row === 13)).toBe(false)
    // 每个可达格都带一条从起点出发的路径
    for (const node of result.reachable) {
      expect(node.path[0]).toEqual({ col: 36, row: 13 })
      expect(node.path[node.path.length - 1]).toEqual(node.hex)
    }
  })

  it('轮式被 ZOC 强制停止：该格仍可达，但不再向外扩展', () => {
    const ctx = context([
      unit({ mobility: 'truck', fuelled: true, ma: 6 }),
      enemy({ col: 36, row: 14 }),
    ])
    const result = computeReachableHexes(ctx, 'u1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const stop = result.reachable.find((r) => r.hex.col === 37 && r.hex.row === 14)
    expect(stop?.forcedStop).toBe(true)
    // 越过强制停止格继续走的路径不存在（该格只作终点，不再向外扩展）
    const throughStop = result.reachable.filter((node) =>
      node.path.slice(0, -1).some((hex) => hex.col === 37 && hex.row === 14),
    )
    expect(throughStop).toEqual([])
  })

  it('不可移动的单位返回原因而非空集合（UI 需据此提示）', () => {
    const ctx = context([unit({ mobility: 'truck' })])
    const result = computeReachableHexes(ctx, 'u1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result).toMatchObject({ reason: 'needsFuel', rule: '12.5a' })
  })

  it('产品真实地图接线：Open 起点至少可达其相邻格，且路径连续', () => {
    const map = createMapFacts()
    const start = { col: 36, row: 13 }
    const ctx = context([unit({ hex: start, ma: 6 })], { map })
    const result = computeReachableHexes(ctx, 'u1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reachable.length).toBeGreaterThan(0)
    expect(result.reachable.some((r) => r.hex.col === 36 && r.hex.row === 14)).toBe(true)
  })
})

/* ────────────────────────────── 6.1d 互逆性 ────────────────────────────── */

describe('6.1d 互逆性：反向判定必须与正向同口径地带上「是否沿路」', () => {
  const swampRoad = () =>
    makeMap({
      terrains: { '36.13': ['Swamp'] },
      crossings: { '36.13|36.14': { routes: ['Secondary Road'] } },
    })

  it('身处禁入地形格、沿格边道路离开：合法（沿路进得来就沿路出得去）', () => {
    const ctx = context([unit({ mobility: 'truck', fuelled: true, ma: 10 })], { map: swampRoad() })
    // 正向：进入 Open 格
    expect(expectOk(evaluateStep(ctx, 'u1', { col: 36, row: 14 })).cost).toBeGreaterThan(0)
    // 反向：从 36.14 沿同一条路进入 Swamp，也应合法 ⇒ 互逆成立
    const back = context(
      [unit({ hex: { col: 36, row: 14 }, mobility: 'truck', fuelled: true, ma: 10 })],
      { map: swampRoad() },
    )
    expect(expectOk(evaluateStep(back, 'u1', { col: 36, row: 13 })).cost).toBeGreaterThan(0)
  })

  it('对照：格边不承载道路时，身处禁入地形格仍不能离开（互逆性不被削弱）', () => {
    const ctx = context([unit({ mobility: 'truck', fuelled: true, ma: 10 })], {
      map: makeMap({ terrains: { '36.13': ['Swamp'] } }),
    })
    expect(expectFail(evaluateStep(ctx, 'u1', { col: 36, row: 14 }))).toMatchObject({
      reason: 'reciprocity',
      rule: '6.1d',
    })
  })

  /** 全图逐格 × 六向：|可进入 A→B| 与 |可进入 B→A| 必须一致 */
  function scanOneWaySteps(mobility: 'truck' | 'track' | 'leg'): string[] {
    const map = createMapFacts()
    const at = (hex: HexRef): MoveUnitView => unit({ hex, mobility, ma: 10, fuelled: true })
    const ctxAt = (u: MoveUnitView) => context([u], { map })
    const bad: string[] = []
    for (const h of mapLayers.hexes) {
      const a: HexRef = { col: h.col, row: h.row }
      for (const entry of neighbors(a)) {
        const b = entry.hex
        if (!map.onMap(b)) continue
        const forward = evaluateStep(ctxAt(at(a)), 'u1', b)
        const backward = evaluateStep(ctxAt(at(b)), 'u1', a)
        if (forward.ok !== backward.ok)
          bad.push(
            `${key(a)}→${key(b)}[${entry.direction}]:${forward.ok ? 'OK' : forward.reason}` +
              ` | ${key(b)}→${key(a)}:${backward.ok ? 'OK' : backward.reason}`,
          )
      }
    }
    return bad
  }

  it('产品真实地图：轮式无「进得去、出不来」的单向步', () => {
    const bad = scanOneWaySteps('truck')
    expect(bad, `轮式单向步：\n${bad.slice(0, 12).join('\n')}`).toEqual([])
  })

  it('产品真实地图：履带无单向步', () => {
    const bad = scanOneWaySteps('track')
    expect(bad, `履带单向步：\n${bad.slice(0, 12).join('\n')}`).toEqual([])
  })

  it('产品真实地图：徒步无单向步（对照组）', () => {
    expect(scanOneWaySteps('leg')).toEqual([])
  })

  it('产品真实地图最小反例：2.3(Swamp) ⇄ 2.2 Bobruysk 双向皆合法', () => {
    const map = createMapFacts()
    const go = (from: HexRef, to: HexRef) =>
      evaluateStep(
        context([unit({ hex: from, mobility: 'truck', ma: 10, fuelled: true })], { map }),
        'u1',
        to,
      )
    expect(go({ col: 2, row: 2 }, { col: 2, row: 3 }).ok).toBe(true)
    expect(go({ col: 2, row: 3 }, { col: 2, row: 2 }).ok).toBe(true)
  })
})

/* ────────────────────────────── 突袭资格（8.1） ────────────────────────────── */

describe('突袭资格（8.1 / 8.1a / 8.1b / 8.1c / 5.10b-C）', () => {
  const attacker = unit({ id: 'a1', mobility: 'track', fuelled: true, ma: 8 })
  const attacker2 = unit({ id: 'a2', mobility: 'track', fuelled: true, ma: 8 })
  const defenderHex = { col: 36, row: 14 }
  const base = {
    unitIds: ['a1', 'a2'] as const,
    target: defenderHex,
    startedStackedTogether: true,
    mpRemaining: 8,
  }

  function overrunCtx(map?: MoveContext['map']) {
    return context([attacker, attacker2, enemy(defenderHex)], map === undefined ? {} : { map })
  }

  it('合格：阶段开始同格堆叠的可攻击战斗/移动模式单位，进入格 ≤ 3 MP', () => {
    const check = canOverrun({
      context: overrunCtx(),
      ...base,
      startedStackedTogether: true,
      mpRemaining: 8,
      unitIds: [...base.unitIds],
    })
    expect(check).toEqual({ ok: true, mpCost: 3, entryCost: 1 })
    expect(OVERRUN_MAX_ENTRY_MP).toBe(3)
  })

  it('8.1：本阶段开始时未同格堆叠 → 不能突袭', () => {
    const check = canOverrun({
      context: overrunCtx(),
      ...base,
      startedStackedTogether: false,
      unitIds: [...base.unitIds],
    })
    expect(check.ok).toBe(false)
  })

  it('8.1：不在战斗/移动/进击模式 → 不能突袭（预备未释放）', () => {
    const reserved = unit({
      id: 'a2',
      mode: 'reserve',
      orientation: 'move',
      mobility: 'track',
      fuelled: true,
      ma: 8,
    })
    const ctx = context([attacker, reserved, enemy(defenderHex)])
    const check = canOverrun({
      context: ctx,
      unitIds: ['a1', 'a2'],
      target: defenderHex,
      startedStackedTogether: true,
      mpRemaining: 8,
    })
    expect(check).toMatchObject({ ok: false, rule: '8.1' })
  })

  it('8.1 / 5.7b：**已释放**的预备（已回战斗/移动模式）可以突袭（突袭中用完整战斗值）', () => {
    const released = unit({
      id: 'a1',
      mode: 'reserve',
      orientation: 'combat',
      releasedFromReserve: true,
      mobility: 'track',
      fuelled: true,
      ma: 8,
    })
    const released2 = unit({
      id: 'a2',
      mode: 'reserve',
      orientation: 'combat',
      releasedFromReserve: true,
      mobility: 'track',
      fuelled: true,
      ma: 8,
    })
    const ctx = context([released, released2, enemy(defenderHex)])
    expect(
      canonicalMode({
        mode: 'reserve',
        orientation: 'combat',
        dg: false,
        exploit: false,
        releasedFromReserve: true,
      }),
    ).toBe('combat')
    const check = canOverrun({
      context: ctx,
      unitIds: ['a1', 'a2'],
      target: defenderHex,
      startedStackedTogether: true,
      mpRemaining: 8,
    })
    expect(check).toEqual({ ok: true, mpCost: 3, entryCost: 1 })
  })

  it('5.10b-C：DG 单位不能突袭', () => {
    const dg = unit({ id: 'a2', dg: true, mobility: 'track', fuelled: true, ma: 8 })
    const ctx = context([attacker, dg, enemy(defenderHex)])
    const check = canOverrun({
      context: ctx,
      unitIds: ['a1', 'a2'],
      target: defenderHex,
      startedStackedTogether: true,
      mpRemaining: 8,
    })
    expect(check).toMatchObject({ ok: false, rule: '5.10b' })
  })

  it('8.1a：剩余 MP 不足 3 不能突袭', () => {
    const check = canOverrun({
      context: overrunCtx(),
      unitIds: ['a1', 'a2'],
      target: defenderHex,
      startedStackedTogether: true,
      mpRemaining: 2,
    })
    expect(check).toMatchObject({ ok: false, rule: '8.1a' })
  })

  it('8.1b：进入格 MP 超过 3（履带进 Forest = 3 可用；轮式进 Forest = 4 不可用）', () => {
    const forest = makeMap({ terrains: { '36.14': ['Forest'] } })
    const trackOk = canOverrun({
      context: overrunCtx(forest),
      unitIds: ['a1', 'a2'],
      target: defenderHex,
      startedStackedTogether: true,
      mpRemaining: 8,
    })
    expect(trackOk).toEqual({ ok: true, mpCost: 3, entryCost: 3 })
    const truck = unit({ id: 'a1', mobility: 'truck', fuelled: true, ma: 8 })
    const truck2 = unit({ id: 'a2', mobility: 'truck', fuelled: true, ma: 8 })
    const truckCheck = canOverrun({
      context: context([truck, truck2, enemy(defenderHex)], { map: forest }),
      unitIds: ['a1', 'a2'],
      target: defenderHex,
      startedStackedTogether: true,
      mpRemaining: 8,
    })
    expect(truckCheck).toMatchObject({ ok: false, rule: '8.1b' })
  })

  it('8.1c：不得借道路把进入格 MP 压低（沿二级道路对轮式仍按格内地形 4 MP 计，故不可突袭）', () => {
    const roadForest = makeMap({
      terrains: { '36.14': ['Forest'] },
      crossings: { '36.13|36.14': { routes: ['Secondary Road'] } },
    })
    const truck = unit({ id: 'a1', mobility: 'truck', fuelled: true, ma: 8 })
    const truck2 = unit({ id: 'a2', mobility: 'truck', fuelled: true, ma: 8 })
    const check = canOverrun({
      context: context([truck, truck2, enemy(defenderHex)], { map: roadForest }),
      unitIds: ['a1', 'a2'],
      target: defenderHex,
      startedStackedTogether: true,
      mpRemaining: 8,
    })
    expect(check).toMatchObject({ ok: false, rule: '8.1b' })
  })

  it('8.1b：地形消耗为 All 不可突袭（步行过大河）', () => {
    const river = makeMap({ crossings: { '36.13|36.14': { river: 'Major River' } } })
    const leg = unit({ id: 'a1', mobility: 'leg', ma: 8 })
    const leg2 = unit({ id: 'a2', mobility: 'leg', ma: 8 })
    const check = canOverrun({
      context: context([leg, leg2, enemy(defenderHex)], { map: river }),
      unitIds: ['a1', 'a2'],
      target: defenderHex,
      startedStackedTogether: true,
      mpRemaining: 8,
    })
    expect(check).toMatchObject({ ok: false, rule: '8.1b' })
  })

  it('4.8a：突袭发起格此刻就必须满足 10 RE（突袭不受「移动中暂时超堆叠」豁免）', () => {
    // 发起格内另有 9 RE 友军 + 参突 2 RE × 2 = 13 RE > 10
    const bulky = [
      unit({ id: 'x1', hex: { col: 36, row: 13 }, re: 5 }),
      unit({ id: 'x2', hex: { col: 36, row: 13 }, re: 4 }),
    ]
    const ctx = context([attacker, attacker2, ...bulky, enemy(defenderHex)])
    const check = canOverrun({
      context: ctx,
      unitIds: ['a1', 'a2'],
      target: defenderHex,
      startedStackedTogether: true,
      mpRemaining: 8,
    })
    expect(check).toMatchObject({ ok: false, rule: '4.8a', reason: 'stackingLimit' })
    // 对照：发起格未超限则可突袭
    expect(
      canOverrun({
        context: overrunCtx(),
        unitIds: ['a1', 'a2'],
        target: defenderHex,
        startedStackedTogether: true,
        mpRemaining: 8,
      }),
    ).toMatchObject({ ok: true })
  })
})

/* ────────────────────────────── 12.7 延补队不可移动 ────────────────────────────── */

describe('12.7 延补队面：不能移动（也不能突袭）', () => {
  it('单步 / 可到达格 / 突袭三处判据一致地拒绝', () => {
    const extender = unit({
      id: 'ext',
      isExtenderFace: true,
      mobility: 'truck',
      ma: 20,
      fuelled: true,
    })
    const ctx = context([extender])
    const step = expectFail(evaluateStep(ctx, 'ext', { col: 36, row: 14 }))
    expect(step).toMatchObject({ reason: 'extenderCannotMove', rule: '12.7' })

    const reach = computeReachableHexes(ctx, 'ext')
    expect(reach.ok).toBe(false)
    if (!reach.ok) expect(reach.reason).toBe('extenderCannotMove')

    const overrun = canOverrun({
      context: context([extender, enemy({ col: 36, row: 14 })]),
      unitIds: ['ext'],
      target: { col: 36, row: 14 },
      startedStackedTogether: true,
      mpRemaining: 20,
    })
    expect(overrun).toMatchObject({ ok: false, reason: 'extenderCannotMove', rule: '12.7' })
  })

  it('12.7d：翻回运输点数面（缺省 false）后可正常移动', () => {
    const truck = unit({ id: 'tp', mobility: 'truck', ma: 20, fuelled: true })
    expect(evaluateStep(context([truck]), 'tp', { col: 36, row: 14 }).ok).toBe(true)
  })
})

/* ─────────────────────── 专规 1.1b：安全边缘格 ─────────────────────── */

describe('专规 1.1b：安全边缘格（作为补给源的地图边格）敌方地面单位不得进入', () => {
  const SAFE: HexRef = { col: 37, row: 13 }
  /** 对轴方而言的「敌方安全边缘格」＝苏方清单里的格 */
  const enemySafe = (unitList: readonly MoveUnitView[]): MoveContext =>
    context(unitList, { safeEdgeHexesBySide: { axis: [], soviet: [SAFE] } })

  it('进入被判为 enemySafeEdge（普通移动与突袭一体生效，规则明文「不可被突袭」）', () => {
    const mover = unit({ hex: { col: 36, row: 13 } })
    const failed = expectFail(evaluateStep(enemySafe([mover]), 'u1', SAFE))
    expect(failed.reason).toBe('enemySafeEdge')
    expect(failed.rule).toBe('专规 1.1b')

    // 8.1 的突袭进格与普通移动共用 `evaluateStepFrom` ⇒ 同样被拦
    expect(
      expectFail(evaluateStep(enemySafe([mover]), 'u1', SAFE, { forOverrun: true })).reason,
    ).toBe('enemySafeEdge')
  })

  it('只约束「敌方」：己方自己的安全边缘格与未提供清单的情形都不受限', () => {
    const mover = unit({ hex: { col: 36, row: 13 } })
    const own = context([mover], { safeEdgeHexesBySide: { axis: [SAFE], soviet: [] } })
    expect(evaluateStep(own, 'u1', SAFE).ok).toBe(true)
    // 未提供清单 ⇒ 不施加该检查（宁可少判，也不臆造一张边缘格表）
    expect(evaluateStep(context([mover]), 'u1', SAFE).ok).toBe(true)
  })

  it('可达格 BFS 与逐步判定同一判据（高亮的格 == 真的能走进去的格）', () => {
    const mover = unit({ hex: { col: 36, row: 13 } })
    const blocked = computeReachableHexes(enemySafe([mover]), 'u1')
    expect(blocked.ok).toBe(true)
    if (!blocked.ok) return
    expect(
      blocked.reachable.some((node) => node.hex.col === SAFE.col && node.hex.row === SAFE.row),
    ).toBe(false)

    const plain = computeReachableHexes(context([mover]), 'u1')
    expect(
      plain.ok &&
        plain.reachable.some((node) => node.hex.col === SAFE.col && node.hex.row === SAFE.row),
    ).toBe(true)
  })
})

/* ────────────────────────────── 13.8b 架桥接线 ────────────────────────────── */

/**
 * 13.8b：**架桥真的被移动取费与攻击门槛用上了**
 *
 * 条文：「当与一个大河相邻时，具有工程能力的单位会自动将大河格边的 MP 消耗降至小河格边的 MP 消耗。
 *   同样，具有工程能力的单位也会将小河格边降级为『无额外消耗』。……只有友方单位移动**进入或离开**
 *   工程能力单位所在格时，移动消耗才能降低。」「攻击单位不能使用架桥能力跨越格边来过河**突袭**。」
 *   「架桥对战斗地形效果没有影响，但在**没有桥就无法攻击**的情况下，可通过架桥能力而**允许发动攻击**。」
 *
 * ★ 本条钉的是**接线**：引擎里 `bridgedCrossing` 早就写好、单测也过了，但修前它在 `src/` 内
 *   **零调用**（`MoveContext` 没有这个字段）⇒ 走路时永远按原价收费，"HQ 在河边架桥"整局不生效。
 *   本组用合成地图把「接通之后」的四件事钉住：小河→无额外消耗、大河→可通过、只有进出该格才降、
 *   突袭步不降。
 *
 * 测法边界：本组走**合成地图**（`makeMap`），故与产品地图上具体哪条河无关；
 * 产品地图上的"摆一个 HQ ⇒ 过河变便宜"由 `tests/stores/bridge-terrain-flow.test.ts` 覆盖。
 */
describe('13.8b：架桥接入移动取费（bridgedHexesBySide）', () => {
  /** 本步的出格（架桥单位所在格）与入格 */
  const FROM: HexRef = { col: 36, row: 13 }
  const TO: HexRef = { col: 36, row: 14 }
  const riverAt = (river: string) => makeMap({ crossings: { '36.13|36.14': { river } } })
  const bridges = (hexes: readonly HexRef[]) => ({ axis: hexes, soviet: [] })

  it('步行过小河：本条格边在架桥格里 ⇒ 降为无额外消耗（2 MP → 1 MP）', () => {
    const plain = context([unit({ mobility: 'leg' })], { map: riverAt('Minor River') })
    expect(expectOk(evaluateStep(plain, 'u1', TO)).cost).toBe(2)

    const bridged = context([unit({ mobility: 'leg' })], {
      map: riverAt('Minor River'),
      bridgedHexesBySide: bridges([FROM]),
    })
    const step = expectOk(evaluateStep(bridged, 'u1', TO))
    expect(step.hexsideCost).toBe(0)
    expect(step.cost).toBe(1)
  })

  it('轮式过大河：本来禁入（6.2c），架桥后可通过 —— 「没有桥就无法过河」那一半', () => {
    const truck = () => unit({ mobility: 'truck', fuelled: true })
    expect(
      expectFail(evaluateStep(context([truck()], { map: riverAt('Major River') }), 'u1', TO))
        .reason,
    ).toBe('prohibited')

    const bridged = context([truck()], {
      map: riverAt('Major River'),
      bridgedHexesBySide: bridges([FROM]),
    })
    // 大河降为小河 ⇒ 轮式按 1（Open）+ 5（轮式过小河）取费
    expect(expectOk(evaluateStep(bridged, 'u1', TO)).cost).toBe(6)
  })

  it('13.8b：只有**进出架桥格**才降级 —— 桥在别处、或桥属于对手，都不降', () => {
    const far = context([unit({ mobility: 'leg' })], {
      map: riverAt('Minor River'),
      bridgedHexesBySide: bridges([{ col: 1, row: 1 }]),
    })
    expect(expectOk(evaluateStep(far, 'u1', TO)).cost).toBe(2)

    const enemyBridge = context([unit({ mobility: 'leg' })], {
      map: riverAt('Minor River'),
      bridgedHexesBySide: { axis: [], soviet: [FROM] },
    })
    expect(expectOk(evaluateStep(enemyBridge, 'u1', TO)).cost).toBe(2)
  })

  it('8.1c：突袭步**不得**借架桥过河（`forOverrun` 一律不降级）', () => {
    const bridged = context([unit({ mobility: 'truck', fuelled: true })], {
      map: riverAt('Major River'),
      bridgedHexesBySide: bridges([FROM]),
    })
    // 常规移动可以通过（上一条），突袭判定则仍按大河 ⇒ 禁入
    expect(expectOk(evaluateStep(bridged, 'u1', TO)).cost).toBe(6)
    expect(expectFail(evaluateStep(bridged, 'u1', TO, { forOverrun: true })).reason).toBe(
      'prohibited',
    )
  })

  it('6.1d 互逆性用**同一份**降级格边（否则"借自己架的桥走过去"会被自己判成不互逆）', () => {
    // 架桥格在**入格**一侧：正向（进出该格）降级 ⇒ 反向那一步的 to 也是该格 ⇒ 同样降级。
    // 若互逆性那一支漏了降级，正向会被 6.1d 拒（这是修好后必须成立的一条）。
    const bridged = context([unit({ mobility: 'truck', fuelled: true })], {
      map: riverAt('Major River'),
      bridgedHexesBySide: bridges([TO]),
    })
    expect(expectOk(evaluateStep(bridged, 'u1', TO)).cost).toBe(6)

    // 反向同理：单位站在 TO，桥也在 TO ⇒ 离开该格一样降级
    const back = context([unit({ mobility: 'truck', fuelled: true, hex: TO })], {
      map: riverAt('Major River'),
      bridgedHexesBySide: bridges([TO]),
    })
    expect(expectOk(evaluateStep(back, 'u1', FROM)).cost).toBe(6)
  })
})
