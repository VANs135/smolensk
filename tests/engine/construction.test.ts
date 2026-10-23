import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { hexDistance, neighbors } from '@/engine/hex-geometry'
import {
  AIRSTRIP_BUILD_T,
  AIRSTRIP_UPGRADE_T,
  AIR_BASE_MAX_LEVEL,
  CONSTRUCTION_MARKERS_PER_SETUP,
  CONSTRUCTION_MIN_BUILDER_RE,
  CONSTRUCTION_RADIUS_HEXES,
  HEDGEHOG_COST_SP_PER_LEVEL,
  HEDGEHOG_MAX_LEVEL,
  SOVIET_HEDGEHOG_BUILD_FROM,
  bridgedCrossing,
  canReduceAirstrip,
  constructionTaskCostsSp,
  hedgehogBuildCostSp,
  isConstructionMarkerDestroyed,
  legMpDistanceWithinRadius,
  planAirBaseBuild,
  planAirstripBuild,
  planAirstripUpgrade,
  planConstructionMarkerUse,
  planHedgehogBuild,
  planHedgehogReduce,
  printedPermanentHedgehogAt,
  validateConstructionBase,
  withinConstructionRange,
  type ConstructionExecutor,
  type ConstructionWorker,
  type HedgehogHexState,
  type MapFacts,
} from '@/engine/rules'

/**
 * 特殊单位与设施（B17）测试 —— 断言到条文一级
 *
 * 13.8a 工程能力 / 13.8d 建造前提（移动阶段、不可移动、一格一任务、2 格半径）·
 * 13.8b 架桥（大河→小河、小河→无额外消耗；仅进出工兵格；不得过河突袭）·
 * 16.0b/c 环形工事修建与缩减（2 SP/级、每格每回合 ±1、降到 1 级以下移除、缩减免费）·
 * 15.3 空军基地修建（1 SP/级、每回合 +1、上限 3）· 15.2 简易机场（1T 建 / 3T 升级 / 永不降级）·
 * 专规 1.3a 印刷永久工事不可降低 · 专规 1.3b 工事上限 1 级 · 专规 2.3e 苏军 8/1 前禁建 ·
 * 专规 3.5 轴方建造标记（免费、移动前、须轴方战斗单位、只被苏方战斗单位摧毁）。
 *
 * ★ 「1RE 的单位」判读（用户 2026-09-13 裁定）：指的是**在目标格内被指定执行作业的那一小队单位**
 *   （格内堆叠的**子集**），其 RE **合计 ≥ 1** 即可；作业后**只有这批被指定的单位**本阶段不能再移动，
 *   格内其余单位照常行动 —— 见「16.0b 作业单位的指定与行动约束」一组。
 */

const unwrap = <T>(
  outcome: { ok: true; data: T } | { ok: false; rule: string; reason: string },
): T => {
  if (!outcome.ok) throw new Error(`预期成功，实得失败：${outcome.rule} / ${outcome.reason}`)
  return outcome.data
}

/** 移动阶段、有工程能力、未移动、未施工 */
function context(over: Partial<Parameters<typeof validateConstructionBase>[0]> = {}) {
  return {
    phase: 'movement' as const,
    engineerCapable: true,
    movedThisPhase: false,
    hexesThisPhase: 0,
    task: 'buildHedgehog' as const,
    previousTaskThisPhase: null,
    ...over,
  }
}

/** 一名作业单位（缺省：1 RE、战斗模式、本阶段未移动） */
const worker = (over: Partial<ConstructionWorker> = {}): ConstructionWorker => ({
  id: 'u1',
  re: 1,
  mode: 'combat',
  movedThisPhase: false,
  ...over,
})

/** 16.0b 的「目标格内指定的一小队作业单位」 */
const workers = (
  ...units: ConstructionWorker[]
): Extract<ConstructionExecutor, { kind: 'inPlaceUnits' }> => ({ kind: 'inPlaceUnits', units })

/** 13.8d 的「具工程能力单位」 */
const engineer = (
  over: Partial<Extract<ConstructionExecutor, { kind: 'engineer' }>> = {},
): Extract<ConstructionExecutor, { kind: 'engineer' }> => ({
  kind: 'engineer',
  engineerCapable: true,
  unitId: 'e1',
  movedThisPhase: false,
  legMpDistanceToTarget: 2,
  ...over,
})

/** 目标格工事状态（缺省：无工事、非印刷、本回合未动） */
function hexState(over: Partial<HedgehogHexState> = {}): HedgehogHexState {
  return {
    level: 0,
    isPrintedPermanent: false,
    levelsBuiltThisTurn: 0,
    levelsReducedThisTurn: 0,
    ...over,
  }
}

describe('13.8a / 13.8d 建造作业的公共前提', () => {
  it('13.8d：只能在移动阶段施工', () => {
    expect(validateConstructionBase(context())).toBeNull()
    expect(validateConstructionBase(context({ phase: 'reaction' }))).toMatchObject({
      rule: '13.8d',
      reason: 'constructionOnlyInMovementPhase',
    })
    expect(validateConstructionBase(context({ phase: 'exploitation' }))).toMatchObject({
      reason: 'constructionOnlyInMovementPhase',
    })
  })

  it('13.8a：无工程能力者不能施工', () => {
    expect(validateConstructionBase(context({ engineerCapable: false }))).toMatchObject({
      rule: '13.8a',
      reason: 'requiresEngineerCapability',
    })
  })

  it('13.8d：执行建造的阶段中不能移动', () => {
    expect(validateConstructionBase(context({ movedThisPhase: true }))).toMatchObject({
      rule: '13.8d',
      reason: 'builderMovedThisPhase',
    })
  })

  it('13.8d：只能在一个格内建造、只能一种类型', () => {
    expect(validateConstructionBase(context({ hexesThisPhase: 1 }))).toMatchObject({
      reason: 'oneHexPerPhase',
    })
    // 已有过不同任务类型 ⇒ 拒绝（同一类型不报此项）
    expect(
      validateConstructionBase(
        context({ task: 'buildAirBase', previousTaskThisPhase: 'buildHedgehog' }),
      ),
    ).toMatchObject({ reason: 'oneTaskTypePerPhase' })
    expect(
      validateConstructionBase(
        context({ task: 'buildAirBase', previousTaskThisPhase: 'buildAirBase' }),
      ),
    ).toBeNull()
  })

  it('13.8d：2 格半径（以步行 MP 计，无视敌方 ZOC）', () => {
    expect(CONSTRUCTION_RADIUS_HEXES).toBe(2)
    expect(withinConstructionRange({ legMpDistance: 2 })).toBe(true)
    expect(withinConstructionRange({ legMpDistance: 3 })).toBe(false)
    expect(
      planHedgehogBuild({
        side: 'axis',
        date: '1941-07-08',
        executor: engineer({ legMpDistanceToTarget: 3 }),
        hex: hexState(),
        availableSp: 2,
      }),
    ).toMatchObject({ ok: false, rule: '13.8d', reason: 'targetBeyondConstructionRadius:3>2' })
  })

  it('13.8d：修建/改进/修理付费，缩减/伤害免费', () => {
    expect(constructionTaskCostsSp('buildHedgehog')).toBe(true)
    expect(constructionTaskCostsSp('improveAirBase')).toBe(true)
    expect(constructionTaskCostsSp('reduceHedgehog')).toBe(false)
    expect(constructionTaskCostsSp('reduceAirBase')).toBe(false)
    expect(constructionTaskCostsSp('damagePort')).toBe(false)
  })
})

describe('13.8d 步行 MP 半径的量取（legMpDistanceWithinRadius）', () => {
  /** 合成地图：网格内全为指定地形；`edges` 给出带河/路的格边 */
  function fakeMap(input: {
    terrain: string
    /** 这些格用 `blocked` 地形（禁入） */
    blocked?: readonly string[]
    blockedTerrain?: string
    /** 这些格边挂河（键为 `列.行-列.行` 的排序对） */
    crossings?: Readonly<Record<string, { river?: string; routes?: readonly string[] }>>
    /** 这些格不在图内 */
    offMap?: readonly string[]
  }): MapFacts {
    const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
    const sortedEdge = (a: HexRef, b: HexRef): string =>
      [`${a.col}.${a.row}`, `${b.col}.${b.row}`].sort().join('-')
    return {
      onMap: (hex) => !(input.offMap ?? []).includes(key(hex)),
      terrainsAt: (hex) =>
        (input.blocked ?? []).includes(key(hex))
          ? [input.blockedTerrain ?? 'Forest']
          : [input.terrain],
      crossingBetween: (a, b) => {
        const spec = (input.crossings ?? {})[sortedEdge(a, b)]
        if (spec === undefined) return null
        return {
          river: spec.river ?? null,
          routes: spec.routes ?? [],
        }
      },
    }
  }

  const at = (col: number, row: number): HexRef => ({ col, row })
  /** 恰好 n 格远的一圈格（按六角几何 BFS） */
  function shell(start: HexRef, n: number): HexRef[] {
    const keyOf = (hex: HexRef): string => `${hex.col}.${hex.row}`
    const visited = new Set<string>([keyOf(start)])
    let frontier: HexRef[] = [start]
    for (let step = 0; step < n; step += 1) {
      const next: HexRef[] = []
      for (const hex of frontier) {
        for (const item of neighbors(hex)) {
          const key = keyOf(item.hex)
          if (visited.has(key)) continue
          visited.add(key)
          next.push(item.hex)
        }
      }
      frontier = next
    }
    return frontier
  }

  it('同格距离 0；相邻开阔地 1 MP；第二格 2 MP；第三格超出半径 ⇒ null', () => {
    const map = fakeMap({ terrain: 'Open' })
    const start = at(10, 10)
    expect(legMpDistanceWithinRadius({ map, from: start, to: start })).toBe(0)
    for (const hex of shell(start, 1)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBe(1)
    }
    for (const hex of shell(start, 2)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBe(2)
    }
    // 3 MP > 2 ⇒ 半径内不可达（null）
    for (const hex of shell(start, 3)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBeNull()
    }
  })

  it('地形计入长度：森林（leg 2 MP）的邻格即已用尽半径 ⇒ 再往外不可达', () => {
    const map = fakeMap({ terrain: 'Forest' })
    const start = at(10, 10)
    // 进入森林邻格 = 2 MP ⇒ 刚好用完半径
    for (const hex of shell(start, 1)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBe(2)
    }
    // 森林再走一步 = 4 MP ⇒ 超出
    for (const hex of shell(start, 2)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBeNull()
    }
  })

  it('沿路降费：横向 2 格借次要道路（leg 0.5 MP/格）仍在半径内', () => {
    const start = at(10, 10)
    const first = shell(start, 1)[0]!
    const second = shell(start, 2).find((hex) => hexDistance(first, hex) === 1)!
    const edge = (a: HexRef, b: HexRef): string =>
      [`${a.col}.${a.row}`, `${b.col}.${b.row}`].sort().join('-')
    const map = fakeMap({
      terrain: 'Open',
      crossings: {
        [edge(start, first)]: { routes: ['Secondary Road'] },
        [edge(first, second)]: { routes: ['Secondary Road'] },
      },
    })
    // 0.5 + 0.5 = 1 ≤ 2 ⇒ 两格都能到（且比纯开阔地的 2 MP 更省）
    expect(legMpDistanceWithinRadius({ map, from: start, to: second })).toBe(1)
  })

  it('禁入地形不可穿越（6.2c）：被围住则半径内不可达', () => {
    const start = at(10, 10)
    const map = fakeMap({
      terrain: 'Open',
      blocked: shell(start, 1).map((hex) => `${hex.col}.${hex.row}`),
      blockedTerrain: 'Lake/Blocked',
    })
    // 邻格本身是禁入地形 ⇒ 走不进去
    for (const hex of shell(start, 1)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBeNull()
    }
    // 外圈被邻圈完全隔断 ⇒ 半径内也不可达
    for (const hex of shell(start, 2)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBeNull()
    }
  })

  it('图外（onMap 为假）不量距离', () => {
    const start = at(10, 10)
    const outside = at(0, 0)
    const map = fakeMap({ terrain: 'Open', offMap: [`${outside.col}.${outside.row}`] })
    expect(legMpDistanceWithinRadius({ map, from: start, to: outside })).toBeNull()
    expect(legMpDistanceWithinRadius({ map, from: outside, to: start })).toBeNull()
  })

  /**
   * ★ 用户 2026-09-15 裁定：「13.8d 的 2 格步行 MA 是**专门针对工程能力**的限制，和其它的不一样」
   *
   * ⇒ 这 2 格**一律按步行价目量**，与执行者自身机动类型无关（与 6.2「按该单位自身机动类型取费」
   * 是两套口径）。故本组刻意挑**步行与轮式/履带取费不同**的地形来钉：
   *   · Woods：leg 1 / truck 3 —— 按步行 1 格 = 1 MP（在半径内）；按轮式 1 格 = 3 MP（超半径）
   *   · Forest：leg 2 / truck 4 —— 按步行 1 格 = 2 MP（恰在半径内）；按轮式 = 4 MP（超半径）
   * 若哪天有人把执行者的机动类型又接回量取里，这两条会立刻变红。
   */
  it('13.8d：一律按**步行**价目量（Woods：leg 1 / truck 3）——不随执行者机动类型变', () => {
    const start = at(10, 10)
    const map = fakeMap({ terrain: 'Woods' })
    for (const hex of shell(start, 1)) {
      // 步行 1 MP ⇒ 邻格在半径内且距离为 1（若按轮式会是 3 ⇒ 超半径）
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBe(1)
    }
    // 步行再走一格 = 2 MP ⇒ 仍在半径内（2 格上限）；按轮式则 6 MP
    for (const hex of shell(start, 2)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBe(2)
    }
  })

  it('13.8d：Forest（leg 2 / truck 4）邻格恰用满半径 ⇒ 再往外不可达', () => {
    const start = at(10, 10)
    const map = fakeMap({ terrain: 'Forest' })
    for (const hex of shell(start, 1)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBe(2)
    }
    for (const hex of shell(start, 2)) {
      expect(legMpDistanceWithinRadius({ map, from: start, to: hex })).toBeNull()
    }
  })
})

describe('16.0b 作业单位的指定与行动约束（用户裁定口径）', () => {
  const build = (executor: ConstructionExecutor, over: Partial<{ availableSp: number }> = {}) =>
    planHedgehogBuild({
      side: 'axis',
      date: '1941-07-08',
      executor,
      hex: hexState(),
      availableSp: 2,
      ...over,
    })

  it('16.0b：两个 4RE 师同格，只派其中一个动手 ⇒ 只有它不能再移动', () => {
    const result = unwrap(
      build(workers(worker({ id: 'div-A', re: 4 }), worker({ id: 'div-B', re: 4 }))),
    )
    expect(result.immobileUnitIds).toEqual(['div-A', 'div-B'])
    // 只指定一个师时，另一个师不在约束名单内
    const onlyA = unwrap(build(workers(worker({ id: 'div-A', re: 4 }))))
    expect(onlyA.immobileUnitIds).toEqual(['div-A'])
    // ★ 指派「未参与作业」的单位不受约束：名单只含被指定者
    expect(onlyA.immobileUnitIds).not.toContain('div-B')
  })

  it('16.0b：两个营 + 一个 4RE 师同格 —— 多不退、少必须补', () => {
    // 格内：两个 0.5 RE 营 + 一个 4 RE 师
    const bn1 = worker({ id: 'bn-1', re: 0.5 })
    const bn2 = worker({ id: 'bn-2', re: 0.5 })
    const div = worker({ id: 'div-A', re: 4 })

    // ① 只选师 ⇒ 满足
    expect(unwrap(build(workers(div))).immobileUnitIds).toEqual(['div-A'])
    // ② 只选两个营（合计 1 RE）⇒ 满足
    expect(unwrap(build(workers(bn1, bn2))).immobileUnitIds).toEqual(['bn-1', 'bn-2'])
    // ③ 全选（多不退）⇒ 满足
    expect(unwrap(build(workers(div, bn1, bn2))).immobileUnitIds).toEqual(['div-A', 'bn-1', 'bn-2'])
    // ④ 只选一个营（0.5 RE，少必须补）⇒ 不满足
    expect(build(workers(bn1))).toMatchObject({
      ok: false,
      reason: 'operatingUnitsReBelowMinimum:0.5',
    })
  })

  it('16.0b：数个营同格，只需其中两个营动手（合计 1 RE）', () => {
    const result = unwrap(
      build(
        workers(
          worker({ id: 'bn-1', re: 0.5 }),
          worker({ id: 'bn-2', re: 0.5 }),
          worker({ id: 'bn-3', re: 0.5 }),
        ),
      ),
    )
    expect(result.immobileUnitIds).toEqual(['bn-1', 'bn-2', 'bn-3'])
    // 只派两个营 ⇒ 只这两个营受约束，第三个营仍可行动
    expect(
      unwrap(build(workers(worker({ id: 'bn-1', re: 0.5 }), worker({ id: 'bn-2', re: 0.5 }))))
        .immobileUnitIds,
    ).toEqual(['bn-1', 'bn-2'])
  })

  it('16.0b：被指定单位的 RE **合计**须 ≥ 1（单个 1/2 RE 营不足）', () => {
    expect(CONSTRUCTION_MIN_BUILDER_RE).toBe(1)
    expect(build(workers(worker({ id: 'bn-1', re: 0.5 })))).toMatchObject({
      ok: false,
      reason: 'operatingUnitsReBelowMinimum:0.5',
    })
    expect(build(workers(worker({ id: 'rep-1', re: 0.25 }))).ok).toBe(false)
    // 未指定任何单位 ⇒ 无执行者
    expect(build(workers())).toMatchObject({ ok: false, reason: 'noOperatingUnits' })
  })

  it('16.0b：被指定单位须**逐员**处于战斗模式、且**逐员**未移动', () => {
    expect(
      build(workers(worker({ id: 'a', re: 2 }), worker({ id: 'b', re: 2, mode: 'move' }))),
    ).toMatchObject({ ok: false, reason: 'operatingUnitMustBeCombatMode:b' })
    expect(
      build(workers(worker({ id: 'a', re: 2, movedThisPhase: true }), worker({ id: 'b', re: 2 }))),
    ).toMatchObject({ ok: false, reason: 'operatingUnitAlreadyMoved:a' })
    // 同格可因多个模式标记而混合模式（4.8b）；只要被指派的那几个是战斗模式即可
    expect(
      build(workers(worker({ id: 'a', re: 2 }), worker({ id: 'b', re: 2, mode: 'strat' }))).ok,
    ).toBe(false)
    expect(build(workers(worker({ id: 'b', re: 2 }))).ok).toBe(true)
  })

  it('16.0b：具工程能力者亦可（13.8d，2 格内）；仅该单位受不可移动约束', () => {
    const viaEngineer = unwrap(build(engineer({ unitId: 'eng-9' })))
    expect(viaEngineer.immobileUnitIds).toEqual(['eng-9'])
    expect(build(engineer({ engineerCapable: false }))).toMatchObject({
      ok: false,
      reason: 'requiresEngineerCapability',
    })
    expect(build(engineer({ movedThisPhase: true }))).toMatchObject({
      ok: false,
      reason: 'builderMovedThisPhase',
    })
  })
})

describe('16.0b 环形工事修建 / 改进', () => {
  const build = (over: Partial<Parameters<typeof planHedgehogBuild>[0]> = {}) =>
    planHedgehogBuild({
      side: 'axis',
      date: '1941-07-08',
      executor: workers(worker()),
      hex: hexState(),
      availableSp: 2,
      ...over,
    })

  it('16.0b：原地 1RE 战斗模式单位 + 2 SP ⇒ 修建 1 级', () => {
    expect(HEDGEHOG_MAX_LEVEL).toBe(1)
    expect(HEDGEHOG_COST_SP_PER_LEVEL).toBe(2)
    expect(unwrap(build())).toMatchObject({ costSp: 2, levelAfter: 1, rule: '16.0b' })
  })

  it('16.0b：每格每回合最多 +1 级', () => {
    expect(build({ hex: hexState({ levelsBuiltThisTurn: 1 }) })).toMatchObject({
      ok: false,
      reason: 'hedgehogAlreadyImprovedThisTurn',
    })
  })

  it('专规 1.3b：任何一方都不能把工事改进到 1 级以上', () => {
    expect(build({ hex: hexState({ level: 1 }) })).toMatchObject({
      ok: false,
      reason: 'hedgehogAtMaxLevel:1',
    })
  })

  it('专规 2.3e：苏军 8 月 1 日回合之前不能修建（轴方不受限）', () => {
    expect(SOVIET_HEDGEHOG_BUILD_FROM).toBe('1941-08-01')
    expect(build({ side: 'soviet', date: '1941-07-19' })).toMatchObject({
      ok: false,
      rule: '专规 2.3e',
      reason: 'sovietCannotBuildHedgehogBefore:1941-08-01',
    })
    expect(build({ side: 'soviet', date: '1941-08-01' }).ok).toBe(true)
    expect(build({ side: 'axis', date: '1941-07-08' }).ok).toBe(true)
  })

  it('16.0b：SP 不足即拒绝（2 SP/级）', () => {
    expect(build({ availableSp: 1 })).toMatchObject({
      ok: false,
      reason: 'insufficientSpForHedgehog:2',
    })
  })
})

describe('16.0c 环形工事缩减（含专规 1.3a 永久工事不可降低）', () => {
  const reduce = (over: Partial<Parameters<typeof planHedgehogReduce>[0]> = {}) =>
    planHedgehogReduce({
      executor: workers(worker()),
      hex: hexState({ level: 1 }),
      ...over,
    })

  it('★ 专规 1.3a：印刷永久工事**不可降低**', () => {
    expect(reduce({ hex: hexState({ level: 1, isPrintedPermanent: true }) })).toMatchObject({
      ok: false,
      rule: '专规 1.3a',
      reason: 'printedPermanentHedgehogCannotBeReduced',
    })
    // 数据侧一致：印刷工事格判定为「永久且不可降低」
    expect(printedPermanentHedgehogAt({ col: 20, row: 7 })).toBe(true)
    expect(printedPermanentHedgehogAt({ col: 1, row: 1 })).toBe(false)
  })

  it('16.0c：该格无工事则无从缩减', () => {
    expect(reduce({ hex: hexState({ level: 0 }) })).toMatchObject({
      ok: false,
      reason: 'noHedgehogInHex',
    })
  })

  it('16.0c：降到 1 级以下 ⇒ 移除；缩减**免费**', () => {
    const removed = unwrap(reduce({ hex: hexState({ level: 1 }) }))
    expect(removed).toMatchObject({ costSp: 0, levelAfter: 0, removes: true, rule: '16.0c' })
    const lowered = unwrap(reduce({ hex: hexState({ level: 2 }) }))
    expect(lowered).toMatchObject({ costSp: 0, levelAfter: 1, removes: false })
  })

  it('16.0c：每格每回合最多降低 1 级', () => {
    expect(reduce({ hex: hexState({ level: 2, levelsReducedThisTurn: 1 }) })).toMatchObject({
      ok: false,
      reason: 'hedgehogAlreadyReducedThisTurn',
    })
  })

  it('16.0c：执行者须合格（已移动 / 非战斗模式 ⇒ 拒绝），且只约束被指定者', () => {
    expect(reduce({ executor: workers(worker({ movedThisPhase: true })) })).toMatchObject({
      ok: false,
      reason: 'operatingUnitAlreadyMoved:u1',
    })
    expect(reduce({ executor: workers(worker({ mode: 'move' })) })).toMatchObject({
      ok: false,
      reason: 'operatingUnitMustBeCombatMode:u1',
    })
    // 一个 4RE 师动手 → 只有它不能移动
    expect(
      unwrap(reduce({ executor: workers(worker({ id: 'div-A', re: 4 })) })).immobileUnitIds,
    ).toEqual(['div-A'])
  })
})

describe('15.3 空军基地修建 / 改进', () => {
  const buildBase = (over: Partial<Parameters<typeof planAirBaseBuild>[0]> = {}) =>
    planAirBaseBuild({
      executor: engineer(),
      currentLevel: 0,
      levelsBuiltThisTurn: 0,
      availableSp: 1,
      ...over,
    })

  it('15.3：具工程能力单位 + 1 SP/级 ⇒ 新建 1 级', () => {
    expect(unwrap(buildBase())).toMatchObject({ costSp: 1, levelAfter: 1, rule: '15.3' })
    expect(unwrap(buildBase({ currentLevel: 1 }))).toMatchObject({ levelAfter: 2 })
  })

  it('15.3：永远无法改进大于三级', () => {
    expect(AIR_BASE_MAX_LEVEL).toBe(3)
    expect(buildBase({ currentLevel: 3 })).toMatchObject({
      ok: false,
      reason: 'airBaseAtMaxLevel:3',
    })
  })

  it('15.3：等级每回合只能提升一级', () => {
    expect(buildBase({ levelsBuiltThisTurn: 1 })).toMatchObject({
      ok: false,
      reason: 'airBaseAlreadyImprovedThisTurn',
    })
  })

  it('15.3：SP 不足 / 超半径 / 已移动 ⇒ 拒绝', () => {
    expect(buildBase({ availableSp: 0 })).toMatchObject({
      ok: false,
      reason: 'insufficientSpForAirBase:1',
    })
    expect(buildBase({ executor: engineer({ legMpDistanceToTarget: 3 }) })).toMatchObject({
      ok: false,
      rule: '13.8d',
    })
    expect(buildBase({ executor: engineer({ movedThisPhase: true }) })).toMatchObject({
      ok: false,
      reason: 'builderMovedThisPhase',
    })
  })
})

describe('15.2 简易机场', () => {
  it('15.2A：修建 1 T（一格至多一个空军设施，4.8 / 15.0a）', () => {
    expect(AIRSTRIP_BUILD_T).toBe(1)
    expect(
      unwrap(planAirstripBuild({ executor: engineer(), hexHasAirFacility: false, availableT: 1 })),
    ).toMatchObject({ costT: 1, rule: '15.2A' })
    expect(
      planAirstripBuild({ executor: engineer(), hexHasAirFacility: true, availableT: 5 }),
    ).toMatchObject({ ok: false, rule: '4.8', reason: 'airFacilityPerHexLimit' })
    expect(
      planAirstripBuild({ executor: engineer(), hexHasAirFacility: false, availableT: 0 }),
    ).toMatchObject({ ok: false, reason: 'insufficientTForAirstrip:1' })
  })

  it('15.2A：支付 3 T 升级为**一级**空军基地', () => {
    expect(AIRSTRIP_UPGRADE_T).toBe(3)
    expect(
      unwrap(planAirstripUpgrade({ executor: engineer(), hexHasAirstrip: true, availableT: 3 })),
    ).toMatchObject({ costT: 3, levelAfter: 1, rule: '15.2A' })
    expect(
      planAirstripUpgrade({ executor: engineer(), hexHasAirstrip: false, availableT: 9 }),
    ).toMatchObject({ ok: false, reason: 'noAirstripToUpgrade' })
  })

  it('15.2E：简易机场**永远不能**被缩减降级', () => {
    expect(canReduceAirstrip()).toBe(false)
  })
})

describe('13.8b 架桥', () => {
  const cross = { river: 'Major River', routes: ['Secondary Road'] }
  const bridged = (over: Partial<Parameters<typeof bridgedCrossing>[1]> = {}) =>
    bridgedCrossing(cross, {
      touchesEngineerHex: true,
      bridgePresent: true,
      forOverrun: false,
      ...over,
    })

  it('13.8b：大河 ⇒ 小河；小河 ⇒ 无额外消耗（路/铁原样保留）', () => {
    expect(bridged()).toEqual({ river: 'Minor River', routes: ['Secondary Road'] })
    expect(
      bridgedCrossing(
        { river: 'Minor River', routes: [] },
        { touchesEngineerHex: true, bridgePresent: true, forOverrun: false },
      ),
    ).toEqual({ river: null, routes: [] })
  })

  it('13.8b：只有**进出工程能力单位所在格**时才能降低', () => {
    expect(bridged({ touchesEngineerHex: false })).toEqual(cross)
  })

  it('13.8b：桥不存在（能力已失去且非自己架的桥）⇒ 不降级', () => {
    expect(bridged({ bridgePresent: false })).toEqual(cross)
  })

  it('13.8b / 8.1c：攻击单位**不得借架桥过河突袭**', () => {
    expect(bridged({ forOverrun: true })).toEqual(cross)
  })

  it('13.8b：湖/禁入不在降级范围内（条文只说大河与小河）', () => {
    expect(
      bridgedCrossing(
        { river: 'Lake/Blocked', routes: [] },
        { touchesEngineerHex: true, bridgePresent: true, forOverrun: false },
      ),
    ).toEqual({ river: 'Lake/Blocked', routes: [] })
  })

  it('13.8b：无河格边原样返回；无格边返回 null', () => {
    expect(
      bridgedCrossing(
        { river: null, routes: ['Track'] },
        { touchesEngineerHex: true, bridgePresent: true, forOverrun: false },
      ),
    ).toEqual({ river: null, routes: ['Track'] })
    expect(
      bridgedCrossing(null, { touchesEngineerHex: true, bridgePresent: true, forOverrun: false }),
    ).toBeNull()
  })
})

describe('专规 3.5 轴方建造标记（桥 / 简易机场）', () => {
  const use = (over: Partial<Parameters<typeof planConstructionMarkerUse>[0]> = {}) =>
    planConstructionMarkerUse({
      kind: 'bridge',
      side: 'axis',
      phase: 'movement',
      beforeMovement: true,
      hexHasAxisCombatUnit: true,
      markerAvailable: true,
      ...over,
    })

  it('专规 3.5：轴方移动阶段、单位移动之前、格内有轴方战斗单位 ⇒ 免费放置', () => {
    expect(CONSTRUCTION_MARKERS_PER_SETUP).toBe(3)
    expect(unwrap(use())).toMatchObject({ costSp: 0, rule: '专规 3.5' })
    expect(unwrap(use({ kind: 'airStrip' })).detail).toContain('15.2')
  })

  it('专规 3.5：仅限轴方 / 仅限移动阶段 / 必须早于单位移动 / 每枚只能用一次', () => {
    expect(use({ side: 'soviet' })).toMatchObject({
      ok: false,
      reason: 'constructionMarkerIsAxisOnly',
    })
    expect(use({ phase: 'reaction' })).toMatchObject({
      ok: false,
      reason: 'constructionMarkerOnlyInMovementPhase',
    })
    expect(use({ beforeMovement: false })).toMatchObject({
      ok: false,
      reason: 'constructionMarkerMustBePlacedBeforeMovement',
    })
    expect(use({ markerAvailable: false })).toMatchObject({
      ok: false,
      reason: 'constructionMarkerAlreadyUsed',
    })
  })

  it('专规 3.5：目标格须有**轴方战斗单位**', () => {
    expect(use({ hexHasAxisCombatUnit: false })).toMatchObject({
      ok: false,
      reason: 'constructionMarkerRequiresAxisCombatUnit',
    })
  })

  it('专规 3.5：只被**苏方战斗单位**进入时摧毁（且不可重建）', () => {
    expect(isConstructionMarkerDestroyed({ enteredBySovietCombatUnit: true })).toBe(true)
    expect(isConstructionMarkerDestroyed({ enteredBySovietCombatUnit: false })).toBe(false)
  })
})

describe('建造花费（供界面预显）', () => {
  it('16.0b / 15.3：按**本作上限**封顶', () => {
    expect(hedgehogBuildCostSp(1)).toBe(2)
    expect(hedgehogBuildCostSp(9)).toBe(2) // 专规 1.3b：上限 1 级
  })
})
