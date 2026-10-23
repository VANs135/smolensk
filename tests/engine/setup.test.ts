import { describe, expect, it } from 'vitest'

import { scenarioSetup, scenarios } from '@/data'
import {
  CHOICE_PLACEMENTS,
  ENTERABILITY_RULE,
  LOAD_RULE,
  PANZER_GROUP_SP_RULE,
  SETUP_RULE,
  SP_OWNERSHIP_RULE,
  STACKING_RULE,
  WITHIN_RULE,
  airSetupPolicyOf,
  normalizeAircraftKey,
  parseSetupRadius,
  planAirSetup,
  planAutoSetup,
  planSetupPlacement,
  planSupplyOwnership,
  planTruckFullLoad,
  requiresPanzerGroupSpAssignment,
  scenarioFirstTurnDate,
  setupCandidates,
  setupEntryViews,
  setupFlowFor,
  setupPlacementOfText,
  setupSourceOf,
} from '@/engine/rules'

/**
 * 初设与开局流程（W7 C14）的**条款级**核对
 *
 * 逐条对着通规 **IV Set Up Notes**（A/C/D/E/F/I/J）、专规 **Setup Notes**（A/C/D/F）、
 * **12.1d**（SP 归属）、**3.4b**（轴方 SP 归属装甲集群）、**13.2h**（满载记法）与
 * **14.1a**（飞机与基地同格）断言；一切数值来自 `scenario-setup.json` 与 `scenarios.json`，
 * 测试只核对「引擎是否照数据办事」，不另造数据。
 */

const S1 = '1'
const S7 = '7'

/** 剧本 1 的条目数（源库 `counts`：苏 145 + 德 52） */
const S1_ENTRIES = 197

describe('W7 C14：剧本选择与初设源（专规 Setup Notes A）', () => {
  it('C14：本体有初设条目的剧本以本体为源；1–2 / 3–4 / 5–6 共用初设', () => {
    expect(setupSourceOf(S1)).toMatchObject({ source: '1', via: 'own' })
    expect(setupSourceOf('2')).toMatchObject({ source: '1', via: 'inherits' })
    expect(setupSourceOf('3')).toMatchObject({ source: '3', via: 'own' })
    expect(setupSourceOf('4')).toMatchObject({ source: '3', via: 'inherits' })
    expect(setupSourceOf('5')).toMatchObject({ source: '5', via: 'own' })
    expect(setupSourceOf('6')).toMatchObject({ source: '5', via: 'inherits' })
    // 剧本 7 自带条目 ⇒ 以本体为源（虽然 inherits 指向 5）
    expect(setupSourceOf(S7)).toMatchObject({ source: '7', via: 'own' })
  })

  it('C14：条目视图逐条来自数据（剧本 1 共 197 条：苏 145 / 德 52）', () => {
    const all = setupEntryViews(S1)
    expect(all).toHaveLength(S1_ENTRIES)
    expect(setupEntryViews(S1, 'soviet')).toHaveLength(145)
    expect(setupEntryViews(S1, 'axis')).toHaveLength(52)
    // 剧本 2 走初设源 ⇒ 条目与剧本 1 一致
    expect(setupEntryViews('2').length).toBe(setupEntryViews(S1).length)
  })

  it('C14：开局流程步骤清单（剧本选择 → 编制抽取 → 卡车满载 → SP 归属 → 自动初设 → 飞机 → 自定义）', () => {
    const steps = setupFlowFor(S1)
    expect(steps.map((step) => step.id)).toEqual([
      'scenario',
      'formationDraw',
      'truckLoad',
      'spOwnership',
      'autoSetup',
      'airSetup',
      'selfSetup',
    ])
    // 剧本 1 有编队抽签（ch10 12 个入杯）与建制内卡车（全部满载）
    expect(steps.find((step) => step.id === 'formationDraw')?.applicable).toBe(true)
    expect(steps.find((step) => step.id === 'formationDraw')?.detail).toContain('12')
    expect(steps.find((step) => step.id === 'truckLoad')?.detail).toContain('all_loaded')
    // 剧本 7 的剧本页没有编队抽签条目（不显示为待办）
    expect(setupFlowFor(S7).find((step) => step.id === 'formationDraw')?.applicable).toBe(false)
  })
})

describe('W7 C14：放置类别与 w/i X 半径（通规 IV-A）', () => {
  it('C14：剧本页文案 → 放置类别（含 † 容差与空军机队两种细分）', () => {
    expect(setupPlacementOfText('固定格号')).toBe('fixed')
    expect(setupPlacementOfText('固定格号（±1 格，带 †）')).toBe('fixedTolerant')
    expect(setupPlacementOfText('多点位（每处各一份）')).toBe('multiHex')
    expect(setupPlacementOfText('死亡堆')).toBe('deadPile')
    expect(setupPlacementOfText('自由放置（任一指挥部同格）')).toBe('anyHq')
    expect(setupPlacementOfText('条件放置（指定格附近若干格内）')).toBe('radius')
    expect(setupPlacementOfText('自由放置（任意空军基地）')).toBe('airbaseFree')
    expect(setupPlacementOfText('空军机队（按空军基地部署，初设不标具体格）')).toBe('airFleet')
    expect(setupPlacementOfText('未标位置')).toBe('unknown')
  })

  it('C14：`w/i X hexes` 的 X 从原文解析（含 † 容差写法）', () => {
    expect(parseSetupRadius('w/i 3 hexes of 34.17 or 34.18')).toBe(3)
    expect(parseSetupRadius('w/i 1 hex of 31.17')).toBe(1)
    expect(parseSetupRadius('listed ±1 hex')).toBe(1)
    expect(parseSetupRadius('死亡堆')).toBeNull()
    expect(parseSetupRadius(null)).toBeNull()
  })

  it('C14：`w/i 3 hexes of 34.17 or 34.18` ⇒ 候选＝两锚格各自 3 格内的并集（含边界，IV-A）', () => {
    const entry = setupEntryViews(S1, 'soviet').find((view) => view.placement === 'radius')
    expect(entry).toBeDefined()
    if (entry === undefined) return
    expect(entry.radius).toBe(3)
    expect(entry.anchors).toHaveLength(2)
    const candidates = setupCandidates(entry)
    expect(candidates.length).toBeGreaterThan(0)
    // 两个锚格都在候选里（含边界）
    for (const anchor of entry.anchors) {
      expect(candidates.some((hex) => hex.col === anchor.col && hex.row === anchor.row)).toBe(true)
    }
    // 单锚格 3 格半径 = 37 格（中心 + 6 + 12 + 18）；两锚格并集不超过 74
    expect(candidates.length).toBeLessThanOrEqual(74)
  })

  it('C14：`Stacked with any … HQs` 的候选＝注入的本方 HQ 格；缺事实即不可解', () => {
    const entry = setupEntryViews(S1, 'soviet').find((view) => view.placement === 'anyHq')
    expect(entry).toBeDefined()
    if (entry === undefined) return
    expect(setupCandidates(entry)).toEqual([])
    const hqHex = { col: 20, row: 0 }
    expect(setupCandidates(entry, { hqHexes: [hqHex] })).toEqual([hqHex])
  })

  it('C14：`At any air bases` 的候选＝注入的本方空军基地格（14.1a）', () => {
    const entry = setupEntryViews(S1, 'soviet').find((view) => view.placement === 'airFleet')
    expect(entry).toBeDefined()
    if (entry === undefined) return
    const base = { col: 34, row: 18 }
    expect(setupCandidates(entry, { airBaseHexes: [base] })).toEqual([base])
  })
})

describe('W7 C14：自动初设（专规 Setup Notes D + 通规 IV）', () => {
  it('C14：剧本 1 的 197 条分成「可直接落位 158 条」与「自由项 39 条」，无缺口', () => {
    const plan = planAutoSetup({ scenarioId: S1 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const automatic = setupEntryViews(S1).filter((view) => view.automatic)
    expect(automatic).toHaveLength(158)
    expect(plan.data.choices).toHaveLength(197 - 158)
    // 一切自由项都在 CHOICE_PLACEMENTS 之内（不会把固定格号误当自由项）
    for (const choice of plan.data.choices) expect(CHOICE_PLACEMENTS).toContain(choice.placement)
    // 剧本 1 的条目全部有算子链接或属计数类 ⇒ 无缺口
    expect(
      plan.data.dataGaps.filter((gap) => gap.includes('未识别') || gap.includes('人工配子')),
    ).toEqual([])
    expect(plan.data.detail).toContain('剧本 1')
  })

  it('C14：死亡堆条目（13.5）⇒ 无格、标记 toDeadPile', () => {
    const plan = planAutoSetup({ scenarioId: S1 })
    if (!plan.ok) throw new Error('应当成功')
    const dead = plan.data.pieces.filter((piece) => piece.toDeadPile)
    expect(dead.length).toBeGreaterThan(0)
    for (const piece of dead) expect(piece.hex).toBeNull()
    for (const piece of plan.data.pieces) {
      if (!piece.toDeadPile) expect(piece.hex).not.toBeNull()
    }
    // 剧本 1 德方死亡堆里有 3 Pz Div（编队条目 ⇒ 展开到各下属）
    expect(dead.some((piece) => piece.name.includes('3 Pz Div'))).toBe(true)
  })

  it('C14：`多点位（每处各一份）`⇒ 所列每格各一份（22.19 与 24.19 的拆分团）', () => {
    const plan = planAutoSetup({ scenarioId: S1 })
    if (!plan.ok) throw new Error('应当成功')
    const entry = setupEntryViews(S1, 'soviet').find(
      (view) => view.placement === 'multiHex' && view.kind === 'unit',
    )
    expect(entry).toBeDefined()
    if (entry === undefined) return
    const placed = plan.data.pieces.filter((piece) => piece.entryIndex === entry.index)
    expect(placed.map((piece) => piece.hexText)).toEqual(['22.19', '24.19'])
  })

  it('C14：`count` = 该型算子枚数（`2x 26-1-1 Arty Bde` 在自由项里记 2 枚）', () => {
    const view = setupEntryViews(S1, 'soviet').find((row) => row.raw.startsWith('2x 26-1-1'))
    expect(view?.count).toBe(2)
  })

  it('C14：剧本页明示的减损（IV-G 的例外）⇒ 以「印值 − 减损」入位', () => {
    const plan = planAutoSetup({ scenarioId: S1 })
    if (!plan.ok) throw new Error('应当成功')
    const view = setupEntryViews(S1).find((row) => row.stepPenalty === 1)
    expect(view).toBeDefined()
    if (view === undefined) return
    const placed = plan.data.pieces.filter((piece) => piece.entryIndex === view.index)
    expect(placed.length).toBeGreaterThan(0)
    for (const piece of placed) {
      expect(piece.steps).not.toBeNull()
      expect(piece.steps).toBeGreaterThan(0)
      // 减损后军力必小于印值（印值至少 2）
      expect(piece.steps!).toBeLessThan(3)
    }
  })

  it('C14：计数类非战斗单位（SP / 运输点 / 空军基地）入账，且等级取自原文（IV-C / 12.1d）', () => {
    const plan = planAutoSetup({ scenarioId: S1 })
    if (!plan.ok) throw new Error('应当成功')
    const sp = plan.data.ledger.filter((row) => row.kind === 'sp')
    const transport = plan.data.ledger.filter((row) => row.kind === 'transport_point')
    const airbase = plan.data.ledger.filter((row) => row.kind === 'airbase')
    expect(sp.length).toBeGreaterThan(0)
    expect(transport.length).toBeGreaterThan(0)
    expect(airbase.length).toBeGreaterThan(0)
    // 剧本 1 德方 2.02 是 Level 2 Airbase + 5 SP + 2 Wagon Points
    const at202 = plan.data.ledger.filter((row) => row.hexText === '2.02')
    expect(at202.some((row) => row.kind === 'airbase' && row.level === 2)).toBe(true)
    expect(at202.some((row) => row.kind === 'sp' && row.count === 5)).toBe(true)
    expect(
      at202.some((row) => row.kind === 'transport_point' && row.transportKind === 'wagon'),
    ).toBe(true)
    // 12.1d：计数类算子的归属＝带上图的一方
    for (const row of plan.data.ledger) expect(row.owner).toBe(row.side)
    // SP 账本的交错引用 12.1d
    expect(sp[0]?.rule).toBe(SP_OWNERSHIP_RULE)
  })

  it('C14：多点位的计数类条目在每个格各记一份（剧本 1 苏方 34.18 / 36.13 的 1 SP 与空军基地）', () => {
    const plan = planAutoSetup({ scenarioId: S1 })
    if (!plan.ok) throw new Error('应当成功')
    const rows = plan.data.ledger.filter(
      (row) => row.hexText === '34.18' || row.hexText === '36.13',
    )
    expect(rows.some((row) => row.hexText === '34.18')).toBe(true)
    expect(rows.some((row) => row.hexText === '36.13')).toBe(true)
  })
})

describe('W7 C14：玩家自定义初设的落位校验（通规 IV-A / F / I）', () => {
  const radiusEntry = () => {
    const entry = setupEntryViews(S1, 'soviet').find((view) => view.placement === 'radius')
    if (entry === undefined) throw new Error('剧本 1 应有 w/i X 条目')
    return entry
  }

  it('C14：目标格须落在候选集内（IV-A 含边界）——范围外即拒', () => {
    const entry = radiusEntry()
    const inside = setupCandidates(entry)[10]
    expect(inside).toBeDefined()
    if (inside === undefined) return
    const ok = planSetupPlacement({ entry, targetHex: inside })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.data.freeChoice).toBe(true)

    const far = { col: 62, row: 34 }
    const rejected = planSetupPlacement({ entry, targetHex: far })
    expect(rejected).toMatchObject({ ok: false, rule: WITHIN_RULE })
    if (!rejected.ok) expect(rejected.reason).toContain('setupHexOutOfRange')
  })

  it('C14：`任一指挥部同格` 的条目落在非 HQ 格 ⇒ 拒；落在 HQ 格 ⇒ 通过', () => {
    const entry = setupEntryViews(S1, 'soviet').find((view) => view.placement === 'anyHq')
    if (entry === undefined) throw new Error('剧本 1 应有任一指挥部同格条目')
    const hqHex = { col: 20, row: 0 }
    // 未给 HQ 事实 ⇒ 候选不可解，直接拒（不猜 HQ 在哪）
    expect(planSetupPlacement({ entry, targetHex: hqHex })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('setupCandidatesUnavailable'),
    })
    const facts = { hqHexes: [hqHex] }
    expect(planSetupPlacement({ entry, targetHex: hqHex, facts }).ok).toBe(true)
    // 非 HQ 格虽然在图上，但不在候选集内
    expect(planSetupPlacement({ entry, targetHex: { col: 20, row: 2 }, facts })).toMatchObject({
      ok: false,
      rule: WITHIN_RULE,
    })
  })

  it('C14：死亡堆条目不能再「落位」（13.5）', () => {
    const entry = setupEntryViews(S1, 'axis').find((view) => view.placement === 'deadPile')
    if (entry === undefined) throw new Error('剧本 1 德方应有死亡堆条目')
    expect(planSetupPlacement({ entry, targetHex: { col: 2, row: 2 } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('setupEntryGoesToDeadPile'),
    })
  })

  it('C14：IV-I —— 注入「该格不可按常规移动进入」即拒', () => {
    const entry = radiusEntry()
    const target = setupCandidates(entry)[5]
    if (target === undefined) throw new Error('应当有候选格')
    const rejected = planSetupPlacement({
      entry,
      targetHex: target,
      facts: { canEnter: () => false },
    })
    expect(rejected).toMatchObject({ ok: false, rule: ENTERABILITY_RULE })
    if (!rejected.ok) expect(rejected.reason).toContain('setupHexNotEnterable')
    // 候选也随之被过滤掉
    expect(setupCandidates(entry, { canEnter: () => false })).toEqual([])
  })

  it('C14：IV-F —— 注入格内既有 RE 后，超 4.8 的 10 RE 上限即拒', () => {
    const entry = setupEntryViews(S1, 'axis').find(
      (view) => view.placement === 'fixed' && view.kind === 'unit' && view.pieces.length > 0,
    )
    if (entry === undefined) throw new Error('剧本 1 德方应有固定格号单位')
    const targetHex = entry.anchors[0]
    if (targetHex === undefined) throw new Error('应当有格号')
    expect(planSetupPlacement({ entry, targetHex }).ok).toBe(true)
    const rejected = planSetupPlacement({
      entry,
      targetHex,
      facts: { existingRe: () => 10 },
    })
    expect(rejected).toMatchObject({ ok: false, rule: STACKING_RULE })
    if (!rejected.ok) expect(rejected.reason).toContain('setupOverStacked')
  })
})

describe('W7 C14：卡车满载指定（通规 IV-C/D + 13.2h + 专规 Setup Note C）', () => {
  const trucks = (count: number) =>
    Array.from({ length: count }, (_item, index) => ({
      instanceId: `truck-${index}`,
      unitId: 'ax-armor_pz-ge-3-pz-truck',
    }))

  it('C14：剧本 1「德军全部满载」⇒ 12 辆全满；漏一辆即拒', () => {
    const all = trucks(12)
    const ok = planTruckFullLoad({
      scenarioId: S1,
      trucks: all,
      fullInstanceIds: all.map((truck) => truck.instanceId),
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.data.mode).toBe('all_loaded')
      expect(ok.data.full).toHaveLength(12)
      expect(ok.data.empty).toEqual([])
      // 13.2h：满载面记作「运力 + F」
      expect(ok.data.notation.fullFace).toBe('1F')
      expect(ok.data.notation.emptyFace).toBe('1')
    }
    expect(
      planTruckFullLoad({
        scenarioId: S1,
        trucks: all,
        fullInstanceIds: all.slice(1).map((truck) => truck.instanceId),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('expectAllLoaded') })
  })

  it('C14：剧本 3「玩家自选 4 辆满载」⇒ 正好 4 辆；3 辆或 5 辆都拒', () => {
    const all = trucks(14)
    const four = all.slice(0, 4).map((truck) => truck.instanceId)
    expect(planTruckFullLoad({ scenarioId: '3', trucks: all, fullInstanceIds: four }).ok).toBe(true)
    expect(
      planTruckFullLoad({ scenarioId: '3', trucks: all, fullInstanceIds: four.slice(0, 3) }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('expectChooseLoaded') })
    expect(
      planTruckFullLoad({
        scenarioId: '3',
        trucks: all,
        fullInstanceIds: all.slice(0, 5).map((t) => t.instanceId),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('expectChooseLoaded') })
    expect(planTruckFullLoad({ scenarioId: '3', trucks: all, fullInstanceIds: [] })).toMatchObject({
      ok: false,
    })
  })

  it('C14：剧本 7「德军全部空载」⇒ 一辆也不许满；指定不存在的实例拒；重复指定拒', () => {
    const all = trucks(2)
    const ok = planTruckFullLoad({ scenarioId: S7, trucks: all, fullInstanceIds: [] })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.data.mode).toBe('all_unloaded')
    expect(
      planTruckFullLoad({ scenarioId: S7, trucks: all, fullInstanceIds: ['truck-0'] }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('expectAllUnloaded') })
    expect(
      planTruckFullLoad({
        scenarioId: '3',
        trucks: trucks(14),
        fullInstanceIds: ['nope'],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('truckLoadUnknownInstance') })
    expect(
      planTruckFullLoad({
        scenarioId: '3',
        trucks: trucks(14),
        fullInstanceIds: ['truck-0', 'truck-0'],
      }),
    ).toMatchObject({ ok: false, reason: 'truckLoadDuplicateInstance' })
  })

  it('C14：满载方式取自剧本数据（四个剧本页的原文都进了 cases）', () => {
    const modes = scenarios.scenarios
      .filter((item) => item.setup.organicTrucks.mode !== undefined)
      .map((item) => `${item.id}:${item.setup.organicTrucks.mode}`)
    expect(modes).toContain('1:all_loaded')
    expect(modes).toContain('3:choose_loaded')
    expect(modes).toContain('5:choose_loaded')
    expect(modes).toContain('7:all_unloaded')
  })
})

describe('W7 C14：SP 归属划分（12.1d + Setup Note F + 3.4b）', () => {
  const dumps = [
    { id: 'axis:2.02', hex: { col: 2, row: 2 }, side: 'axis' as const, points: 5 },
    { id: 'axis:3.07', hex: { col: 3, row: 7 }, side: 'axis' as const, points: 4 },
    { id: 'soviet:20.00', hex: { col: 20, row: 0 }, side: 'soviet' as const, points: 2 },
  ]

  it('C14：剧本 1（8 Jul）适用 3.4b ⇒ 轴方 dump 必须逐一点名装甲集群', () => {
    expect(requiresPanzerGroupSpAssignment(S1)).toBe(true)
    expect(scenarioFirstTurnDate(S1)).toBe('1941-07-08')
    const rejected = planSupplyOwnership({
      agreedByConsensus: true,
      scenarioId: S1,
      dumps,
    })
    expect(rejected).toMatchObject({ ok: false, rule: PANZER_GROUP_SP_RULE })
    if (!rejected.ok) expect(rejected.reason).toContain('spOwnershipMissing:axis:2.02')

    const ok = planSupplyOwnership({
      agreedByConsensus: true,
      scenarioId: S1,
      dumps,
      assignments: { 'axis:2.02': 'guderian', 'axis:3.07': 'hoth' },
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.data.requiresPanzerGroup).toBe(true)
    // 12.1d：归属＝带上图的一方
    expect(ok.data.entries.map((entry) => entry.owner)).toEqual(['axis', 'axis', 'soviet'])
    expect(ok.data.entries[0]?.panzerGroup).toBe('guderian')
    expect(ok.data.entries[2]?.panzerGroup).toBeNull()
  })

  it('C14：剧本 7（26 Aug）不适用 3.4b ⇒ 不准再点名装甲集群', () => {
    expect(requiresPanzerGroupSpAssignment(S7)).toBe(false)
    expect(scenarioFirstTurnDate(S7)).toBe('1941-08-26')
    const axisOnly = [
      { id: 'axis:2.18', hex: { col: 2, row: 18 }, side: 'axis' as const, points: 2 },
    ]
    expect(
      planSupplyOwnership({
        agreedByConsensus: true,
        scenarioId: S7,
        dumps: axisOnly,
      }).ok,
    ).toBe(true)
    expect(
      planSupplyOwnership({
        agreedByConsensus: true,
        scenarioId: S7,
        dumps: axisOnly,
        assignments: { 'axis:2.18': 'hoth' },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('spOwnershipNotApplicable') })
  })

  it('C14：苏方 dump 不得点名装甲集群；点名不存在的 dump 也拒', () => {
    const axisOnly = [
      { id: 'axis:2.02', hex: { col: 2, row: 2 }, side: 'axis' as const, points: 5 },
    ]
    expect(
      planSupplyOwnership({
        agreedByConsensus: true,
        scenarioId: S1,
        dumps: axisOnly,
        assignments: { 'axis:2.02': 'hoth', 'soviet:nope': 'hoth' },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('spOwnershipUnknownDump') })
    expect(
      planSupplyOwnership({
        agreedByConsensus: true,
        scenarioId: S1,
        dumps: [axisOnly[0]!, dumps[2]!],
        assignments: { 'axis:2.02': 'hoth', 'soviet:20.00': 'hoth' },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('spOwnershipSovietGroupForbidden'),
    })
  })

  it('C14：剧本库把 SP 归属注记写在顶层 setupNotes（数据出处可回溯）', () => {
    expect(scenarios.setupNotes.spOwnership).toContain('Setup Note F')
    expect(scenarios.setupNotes.newSpAssignment).toContain('装甲集群')
  })
})

describe('W7 C14：飞机初设（IV-E + 14.1a + 剧本页明文）', () => {
  it('C14：剧本 1 德军「All planes must begin Inactive.」⇒ 全部非激活', () => {
    expect(airSetupPolicyOf(S1, 'axis')).toMatchObject({
      policy: 'all_inactive',
      statedInRules: true,
    })
    const plan = planAirSetup({ scenarioId: S1, side: 'axis', facts: { airBaseHexes: [] } })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.placements.length).toBe(10)
    for (const placement of plan.data.placements) {
      expect(placement.statuses.every((status) => status === 'inactive')).toBe(true)
      expect(placement.reduced.every((flag) => flag === false)).toBe(true)
    }
    // 位置候选＝空军基地格（14.1a）；缺该事实即如实记缺口
    expect(plan.data.dataGaps.join('｜')).toContain('airBaseHexes')
  })

  it('C14：剧本 1 苏军「Half … must begin Inactive. Round fractions up.」⇒ 每型 ⌈n/2⌉ 非激活', () => {
    expect(airSetupPolicyOf(S1, 'soviet')).toMatchObject({
      policy: 'half_inactive_round_up',
      reducedTypes: ['Pe.2'],
    })
    const plan = planAirSetup({
      scenarioId: S1,
      side: 'soviet',
      facts: { airBaseHexes: [{ col: 34, row: 18 }] },
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const su2 = plan.data.placements.find((row) => row.name.includes('Su.2'))
    expect(su2?.count).toBe(2)
    // 2 枚 ⇒ ⌈2/2⌉ = 1 枚非激活
    expect(su2?.statuses).toEqual(['inactive', 'active'])
    const il2 = plan.data.placements.find((row) => row.name.includes('IL.2'))
    expect(il2?.count).toBe(3)
    // 3 枚 ⇒ ⌈3/2⌉ = 2 枚非激活
    expect(il2?.statuses.filter((status) => status === 'inactive')).toHaveLength(2)
    // 候选基地格原样给出
    expect(su2?.candidates).toEqual([{ col: 34, row: 18 }])
  })

  it('C14：`*` = one unit begins reduced ⇒ 该型第一枚以减损状态初设（军力 −1）', () => {
    const plan = planAirSetup({
      scenarioId: S1,
      side: 'soviet',
      facts: { airBaseHexes: [{ col: 34, row: 18 }] },
    })
    if (!plan.ok) throw new Error('应当成功')
    const pe2 = plan.data.placements.find((row) => row.name.includes('Pe.2'))
    expect(pe2).toBeDefined()
    expect(pe2?.reduced).toEqual([true])
    expect(pe2?.steps).toEqual([1])
    // 其余机型不减损（机型名取自空军专表：'Ru Yak 4'）
    const yak = plan.data.placements.find((row) => row.name.includes('Yak'))
    expect(yak?.reduced.every((flag) => flag === false)).toBe(true)
    expect(yak?.steps).toEqual([2, 2])
  })

  it('C14：剧本 3/5/7 苏军剧本页未述激活态 ⇒ 按 IV-E 默认全 Active，并如实记缺口', () => {
    expect(airSetupPolicyOf('3', 'soviet')).toMatchObject({
      policy: 'all_active',
      statedInRules: false,
    })
    const plan = planAirSetup({ scenarioId: '3', side: 'soviet' })
    if (!plan.ok) throw new Error('应当成功')
    for (const placement of plan.data.placements) {
      expect(placement.statuses.every((status) => status === 'active')).toBe(true)
    }
    expect(plan.data.dataGaps.join('｜')).toContain('未述飞机初始激活态')
    // 剧本 3 德军仍为「半数非激活」
    expect(airSetupPolicyOf('3', 'axis')).toMatchObject({ policy: 'half_inactive_round_up' })
  })

  it('C14：剧本 2/4/6 的飞机初设政策随初设源（1 / 3 / 5）', () => {
    expect(airSetupPolicyOf('2', 'axis')).toMatchObject({ policy: 'all_inactive' })
    expect(airSetupPolicyOf('4', 'axis')).toMatchObject({ policy: 'half_inactive_round_up' })
    expect(airSetupPolicyOf('6', 'axis')).toMatchObject({ policy: 'half_inactive_round_up' })
  })

  it('C14：机型名归一（`Bf-109e` 与 `Bf.109e` 同键；`*` 标注不误伤 `Bf.109e-7`）', () => {
    expect(normalizeAircraftKey('Bf-109e')).toBe(normalizeAircraftKey('Bf.109e'))
    expect(normalizeAircraftKey('Bf-109e')).toBe('bf109e')
    expect(normalizeAircraftKey('Ru LaGG.3')).toBe('rulagg3')
    // 剧本 3 德军初设里同时有 Bf.109e 与 Bf.109e-7；剧本页 `*` 标在 `2x Do.17z` / `3x He.111` 上
    const plan = planAirSetup({
      scenarioId: '3',
      side: 'axis',
      facts: { airBaseHexes: [{ col: 2, row: 2 }] },
    })
    if (!plan.ok) throw new Error('应当成功')
    const e7 = plan.data.placements.find((row) => row.name.includes('Bf.109e-7'))
    expect(e7?.reduced.every((flag) => flag === false)).toBe(true)
    const e = plan.data.placements.find((row) => row.name.endsWith('Bf.109e'))
    expect(e?.reduced.every((flag) => flag === false)).toBe(true)
    // `*` 命中的两个机型各有一枚减损
    const do17 = plan.data.placements.find((row) => row.name.includes('Do.17z'))
    expect(do17?.reduced).toEqual([true, false])
    expect(do17?.steps).toEqual([1, 2])
    const he111 = plan.data.placements.find((row) => row.name.includes('He.111'))
    expect(he111?.reduced).toEqual([true, false, false])
    expect(plan.data.dataGaps).toEqual([])
  })
})

describe('W7 C14：初设索引的数据自检', () => {
  it('C14：1155 条条目全在（剧本 1/3/5/7），且棋子条目带 unitId 链接', () => {
    expect(scenarioSetup.entries).toHaveLength(1155)
    const ids = new Set(scenarioSetup.entries.map((entry) => entry.scenarioId))
    expect([...ids].sort()).toEqual(['1', '3', '5', '7'])
    const pieces = scenarioSetup.entries.filter((entry) =>
      ['unit', 'hq', 'formation', 'aircraft', 'extender'].includes(entry.kind),
    )
    const linked = pieces.filter((entry) => entry.unitId != null)
    expect(linked).toHaveLength(pieces.length)
  })

  it('C14：计数类条目不指向棋子（unitIdKind = none），与 `12.1d` 的通用算子口径一致', () => {
    const counts = scenarioSetup.entries.filter((entry) =>
      ['sp', 'transport_point', 'airbase'].includes(entry.kind),
    )
    expect(counts.length).toBe(97 + 58 + 48)
    for (const entry of counts) {
      expect(entry.unitIdKind).toBe('none')
      expect(entry.unitId ?? null).toBeNull()
    }
  })

  it('C14：`unknown` 放置方式在源库里为 0（不存在「未标位置」条目）', () => {
    expect(setupEntryViews(S1).filter((view) => view.placement === 'unknown')).toEqual([])
    expect(setupEntryViews(S7).filter((view) => view.placement === 'unknown')).toEqual([])
  })

  it('C14：落位校验的规则号可回溯（IV / IV-A / IV-F / IV-I / 13.5）', () => {
    expect(SETUP_RULE).toBe('IV')
    expect(WITHIN_RULE).toBe('IV-A')
    expect(STACKING_RULE).toBe('IV-F')
    expect(ENTERABILITY_RULE).toBe('IV-I')
    expect(LOAD_RULE).toBe('IV-C')
    expect(SP_OWNERSHIP_RULE).toBe('12.1d')
    expect(PANZER_GROUP_SP_RULE).toBe('3.4b')
  })
})
