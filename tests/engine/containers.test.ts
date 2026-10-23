import { describe, expect, it } from 'vitest'

import { markers, rulesConstants, scenarios } from '@/data'
import {
  AIR_BOX_RULE,
  BREAKDOWN_BOX_RULE,
  DEAD_PILE_RULE,
  EDGE_BOX_RULE,
  FORMATION_BOX_RULE,
  MAIN_SECTION,
  RAIL_CAP_TRACK_RULE,
  SPECIAL_REPL_RULE,
  TURN_TRACK_RULE,
  alarmHasRoom,
  alarmMixRows,
  axisDrawPool,
  airBoxView,
  allBoxViews,
  boxArtwork,
  breakdownBoxView,
  deadPileView,
  edgeBoxView,
  formationBoxView,
  freeSpecialReplPool,
  planAirBoxActivate,
  planBreakdownTake,
  planEdgeBoxMove,
  planFormationBoxHide,
  planFormationBoxReveal,
  planScenarioDraw,
  planSpecialReplDraw,
  planTurnMarkerAdvance,
  railCapPositionValid,
  railCapTrackView,
  scenarioDrawBoxView,
  specialReplBoxView,
  turnTrackView,
  weatherTrackView,
  type BoxUnitView,
  type ScenarioDrawGroup,
  type TurnRecordFacts,
} from '@/engine/rules'

/**
 * 记录轨与容器管理（W7 C12）——**条款级**核对
 *
 * 每条断言都对着规则书的一处条款（注释标号），并把「数值来自数据」这一点也纳入核对：
 *   · 回合轨 19 格 / 铁路容量轨刻度与升级日 ⇒ `markers.json` + `rules-constants.json`；
 *   · 拆分单位上限 ⇒ 1.8a 表 1-4；1.6c 免费重建资格 ⇒ `charts-supply-repl.json`；
 *   · 剧本抽取池规模 ⇒ 由 `formations.json` 推导，并与规则书给的 12 / 14 交叉核对。
 */

/** 记录轨事实（本作地面恒 good，1.5） */
function facts(overrides: Partial<TurnRecordFacts> = {}): TurnRecordFacts {
  return {
    turn: 4,
    weather: { air: 'normal', ground: 'good' },
    railCapacity: { axis: 0, soviet: 2 },
    ...overrides,
  }
}

/** 造一枚盒内单位视图（只给判定需要的字段） */
function unit(overrides: Partial<BoxUnitView> & { id: string }): BoxUnitView {
  return { side: 'soviet', ...overrides }
}

/* ────────────────────────────── 记录轨 ────────────────────────────── */

describe('W7 C12：记录轨（回合轨 / 天气轨 / 铁路容量轨）', () => {
  it('C12：回合轨 19 格来自 markers.json，当前格给出回合标记（OCS 2.2 Turn End）', () => {
    const view = turnTrackView(facts({ turn: 4 }))
    expect(view.rule).toBe(TURN_TRACK_RULE)
    expect(view.slots).toHaveLength(19)
    expect(view.slots).toHaveLength(markers.turnTrack.length)
    expect(view.slots[3]).toEqual({ turn: 4, date: '1941-07-19' })
    expect(view.currentTurn).toBe(4)
    expect(view.markers).toHaveLength(1)
    expect(view.markers[0]).toMatchObject({ position: 4, side: null })
    expect(view.markers[0]!.detail).toContain('T4')
  })

  it('C12：回合标记只许向前推进，且目标须在轨上（2.2）', () => {
    const ok = planTurnMarkerAdvance(facts({ turn: 4 }), 5)
    expect(ok.ok).toBe(true)
    expect(ok.ok && ok.data.date).toBe('1941-07-22')
    const back = planTurnMarkerAdvance(facts({ turn: 4 }), 3)
    expect(back).toMatchObject({
      ok: false,
      reason: expect.stringContaining('turnMarkerMustMoveForward'),
    })
    const beyond = planTurnMarkerAdvance(facts({ turn: 4 }), 20)
    expect(beyond).toMatchObject({
      ok: false,
      reason: expect.stringContaining('turnTrackOutOfRange'),
    })
  })

  it('C12：天气轨给出条件与限制摘要（专规 1.5：1 = 受限飞行 / 2–6 = 正常飞行）', () => {
    const normal = weatherTrackView(facts())
    expect(normal.air).toBe('normal')
    expect(normal.ground).toBe('good')
    expect(normal.note).toContain('无额外限制')
    const limited = weatherTrackView(facts({ weather: { air: 'limited', ground: 'good' } }))
    expect(limited.note).toContain('反应与进击阶段禁止空军任务')
  })

  it('C12：铁路容量轨刻度与升级日来自数据（专规 1.2 表 1-1：苏 2→3、轴 0→1）', () => {
    const track = markers.railCap
    const before = railCapTrackView(facts(), track.boostDate)
    expect(before.rule).toBe(RAIL_CAP_TRACK_RULE)
    expect(before.maxMain).toBe(track.maxMain)
    expect(before.maxSub).toBe(track.maxSub)
    expect(before.boosted).toBe(true) // 升级日当天即生效（date >= boostDate）
    const axis = before.sides.find((entry) => entry.side === 'axis')!
    const soviet = before.sides.find((entry) => entry.side === 'soviet')!
    expect(axis.boostTo).toBe(rulesConstants.smolensk.railCapAfter.axis)
    expect(soviet.boostTo).toBe(rulesConstants.smolensk.railCapAfter.soviet)
    expect(axis.current).toBe(0) // 盘面事实（尚未提升）
    expect(axis.onDate).toBe(rulesConstants.smolensk.railCapAfter.axis)
    // 升格前的日期给出升格前的值
    expect(railCapTrackView(facts(), '1941-07-12').boosted).toBe(false)
    expect(railCapTrackView(facts(), '1941-07-12').sides[0]!.onDate).toBe(
      rulesConstants.smolensk.railCapBefore.axis,
    )
    // 标记在轨（13.3b），位置＝当前容量
    expect(axis.marker).toMatchObject({ position: 0, side: 'axis' })
  })

  it('C12：铁路容量轨位合法性（主轨 1–maxMain + 副轨 0–maxSub）', () => {
    expect(railCapPositionValid(0)).toBe(true)
    expect(railCapPositionValid(markers.railCap.maxMain + markers.railCap.maxSub)).toBe(true)
    expect(railCapPositionValid(markers.railCap.maxMain + markers.railCap.maxSub + 1)).toBe(false)
  })
})

/* ────────────────────────────── 死亡堆与拆分盒 ────────────────────────────── */

describe('W7 C12：死亡堆（13.5）与拆分单位盒（1.8a / 20.0g）', () => {
  it('C12：死亡堆名册与要点（13.5a/13.5b/13.5c）', () => {
    const view = deadPileView({
      side: 'axis',
      units: [
        unit({ id: 'ax-1', side: 'axis' }),
        unit({ id: 'ax-2', side: 'axis', rebuildable: false }),
        unit({ id: 'ax-3', side: 'axis', isBreakdown: true }),
      ],
    })
    expect(view.kind).toBe('deadPile')
    expect(view.rule).toBe(DEAD_PILE_RULE)
    expect(view.holdings.map((holding) => holding.unitId)).toEqual(['ax-1', 'ax-2', 'ax-3'])
    expect(view.holdings[1]!.note).toContain('13.5c')
    expect(view.holdings[2]!.note).toContain('13.5b')
    expect(view.notes.join('｜')).toContain('2 格内')
  })

  it('C12：拆分单位盒按 1.8a 分档（轴 28×AR4 + 2×AR5），盒内 = 上限 − 图上', () => {
    const limits = rulesConstants.smolensk.counterLimits.axisBreakdown
    const boxes = breakdownBoxView({
      side: 'axis',
      breakdownUnits: [
        unit({ id: 'ax-bd-ar4-a', side: 'axis', ar: 4 }),
        unit({ id: 'ax-bd-ar4-b', side: 'axis', ar: 4 }),
        unit({ id: 'ax-bd-ar5', side: 'axis', ar: 5 }),
      ],
      onMap: [unit({ id: 'ax-bd-onmap', side: 'axis', ar: 4 })],
    })
    expect(boxes.kind).toBe('breakdownBox')
    expect(boxes.rule).toBe(BREAKDOWN_BOX_RULE)
    expect(boxes.slots.map((slot) => `${slot.ar}:${slot.limit}`)).toEqual(
      limits.map((entry) => `${entry.ar}:${entry.count}`),
    )
    const ar4 = boxes.slots.find((slot) => slot.ar === 4)!
    expect(ar4.onMap).toBe(1)
    expect(ar4.inBox).toBe(ar4.limit - 1)
    expect(boxes.capacity).toBe(limits.reduce((sum, entry) => sum + entry.count, 0))
    // 盒内可用 = 该档前 inBox 枚，且不超过算子库实际提供的枚数
    expect(boxes.available.filter((item) => item.ar === 4)).toHaveLength(Math.min(2, ar4.inBox))
    expect(boxes.notes.join('｜')).toContain('20.0g')
  })

  it('C12：超上限时如实标记 overLimit（不静默夹取）', () => {
    const boxes = breakdownBoxView({
      side: 'soviet',
      breakdownUnits: [],
      onMap: [unit({ id: 's1', ar: 2 }), unit({ id: 's2', ar: 2 })],
    })
    const ar2 = boxes.slots.find((slot) => slot.ar === 2)!
    expect(ar2.limit).toBe(rulesConstants.smolensk.counterLimits.sovietBreakdown[0]!.count)
    // 图上 2 枚 ≤ 上限 6 ⇒ 不越界
    expect(ar2.overLimit).toBe(false)
    expect(ar2.inBox).toBe(ar2.limit - 2)
  })

  it('C12：从盒取用走 20.0 的既有判定（类型 / 时机 / 军力 / AR / 池），并扣减盒内存量', () => {
    const boxes = breakdownBoxView({
      side: 'axis',
      breakdownUnits: [unit({ id: 'ax-bd', side: 'axis', ar: 4 })],
      onMap: [],
    })
    const parent = {
      id: 'ax-inf-div',
      side: 'axis' as const,
      nationality: 'german',
      classKind: 'other' as const,
      ar: 4,
      steps: 3,
      printedSteps: 3,
      dg: false,
      internalStocks: null,
      mode: 'combat' as const,
    }
    const child = {
      id: 'ax-bd',
      side: 'axis' as const,
      nationality: 'german',
      classKind: 'other' as const,
      ar: 4,
      steps: 1,
      printedSteps: 1,
      dg: false,
      internalStocks: null,
      mode: 'combat' as const,
    }
    const taken = planBreakdownTake({
      side: 'axis',
      parent,
      breakdown: child,
      timing: 'startMove',
      slots: boxes.slots,
    })
    expect(taken.ok).toBe(true)
    expect(taken.ok && taken.data.inBoxAfter).toBe(
      (boxes.slots.find((slot) => slot.ar === 4)?.inBox ?? 0) - 1,
    )
    // 装甲单位不能拆分（20.0）
    const armor = planBreakdownTake({
      side: 'axis',
      parent: { ...parent, classKind: 'armor' },
      breakdown: child,
      timing: 'startMove',
      slots: boxes.slots,
    })
    expect(armor).toMatchObject({ ok: false, rule: '20.0' })
    // 最后一点军力不能创建（20.0）
    const lastStep = planBreakdownTake({
      side: 'axis',
      parent: { ...parent, steps: 1 },
      breakdown: child,
      timing: 'startMove',
      slots: boxes.slots,
    })
    expect(lastStep).toMatchObject({ ok: false, rule: '20.0' })
    // 时机不对（20.0a）
    const wrongTiming = planBreakdownTake({
      side: 'axis',
      parent,
      breakdown: child,
      timing: 'segmentEnd' as 'startMove',
      slots: boxes.slots,
    })
    expect(wrongTiming).toMatchObject({ ok: false, rule: '20.0a' })
  })
})

/* ────────────────────────────── 1.6c 特殊补员抽取盒 ────────────────────────────── */

describe('W7 C12：1.6c 特殊补员抽取盒（与死亡堆联动）', () => {
  /** 12-2-2 步兵师（数据 freeSpecialReplFactors 里的合格型别） */
  const eligibleDivision = unit({
    id: 'ru-12-2-2',
    attack: 12,
    ar: 2,
    ma: 2,
    steps: 2,
    printedSteps: 2,
  })
  /** 13-3-3（规则明文：永不由此重建） */
  const tankDivision = unit({ id: 'ru-13-3-3', attack: 13, ar: 3, ma: 3 })

  it('C12：免费重建池只含 12-2-2 / 11-1-1 / 10-0-1，13-3-3 不入池（1.6c 表 1-3）', () => {
    const pool = freeSpecialReplPool([eligibleDivision, tankDivision])
    expect(pool.map((item) => item.id)).toEqual(['ru-12-2-2'])
  })

  it('C12：19 August 起停止（rules-constants.smolensk.specialReplEndDate）', () => {
    const endDate = rulesConstants.smolensk.specialReplEndDate
    const before = specialReplBoxView({ side: 'soviet', date: '1941-08-15', deadPile: [] })
    const after = specialReplBoxView({ side: 'soviet', date: endDate, deadPile: [] })
    expect(before.active).toBe(true)
    expect(after.active).toBe(false)
    expect(after.drawsPerTurn).toBe(2) // 苏方每次两项
    expect(
      specialReplBoxView({ side: 'axis', date: '1941-08-15', deadPile: [] }).drawsPerTurn,
    ).toBe(1)
  })

  it('C12：苏方抽到「师 + Alarm」——师返场 −1 军力；无 Alarm 可用则第二项作废', () => {
    const plan = planSpecialReplDraw({
      side: 'soviet',
      date: '1941-08-15',
      die: 4, // 表 1-3：3–6 = Division & Alarm unit
      deadPile: [eligibleDivision, tankDivision],
      alarmUnitIds: [],
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.rule).toBe(SPECIAL_REPL_RULE)
    expect(plan.data.table.kind).toBe('division_alarm')
    expect(plan.data.division).toMatchObject({ unitId: 'ru-12-2-2', stepsAfter: 1 }) // −1 军力
    expect(plan.data.second).toMatchObject({ kind: 'void' })
    /*
     * 2026-09-16：2.3a 的数据缺口已关闭（单位库三条警戒算子带 `alarmLimit`）⇒ 不再有 gap 提示；
     * 只有调用方**没给上限**（alarmQuotas 空）时才提示「本次不校验上限」。
     */
    expect(plan.data.dataGaps).toEqual([])
    expect(plan.data.patches[0]).toMatchObject({ unitId: 'ru-12-2-2', to: null, steps: 1 })
  })

  it('C12：未提供 2.3a 上限时如实体贴缺口（只在缺声明的场合）', () => {
    const plan = planSpecialReplDraw({
      side: 'soviet',
      date: '1941-08-15',
      die: 4,
      deadPile: [eligibleDivision, unit({ id: 'ru-alarm', side: 'soviet', branch: 'anti_tank' })],
      alarmUnitIds: ['ru-alarm'],
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.dataGaps.join('｜')).toContain('2.3a')
  })

  it('2.3a：混编核算给出每型的上限 / 在场 / 余量（3 / 5 / 7）', () => {
    const rows = alarmMixRows({
      quotas: [
        { unitId: 'ru-alarm-tk', limit: 3 },
        { unitId: 'ru-alarm-mil', limit: 5 },
        { unitId: 'ru-alarm-at', limit: 7 },
      ],
      inPlay: { 'ru-alarm-tk': 3, 'ru-alarm-mil': 1 },
    })
    expect(rows).toEqual([
      { unitId: 'ru-alarm-tk', limit: 3, inPlay: 3, remaining: 0, over: false },
      { unitId: 'ru-alarm-mil', limit: 5, inPlay: 1, remaining: 4, over: false },
      { unitId: 'ru-alarm-at', limit: 7, inPlay: 0, remaining: 7, over: false },
    ])
    expect(alarmHasRoom(rows, 'ru-alarm-tk')).toBe(false) // 满编 ⇒ 不可再返场
    expect(alarmHasRoom(rows, 'ru-alarm-at')).toBe(true)
    expect(alarmHasRoom(rows, 'ru-unknown')).toBe(true) // 未登记的类型不受限
  })

  it('2.3a：死亡堆里的 Alarm 各型都满编 ⇒ 第二项作废（reason=alarmMixLimitReached）', () => {
    const plan = planSpecialReplDraw({
      side: 'soviet',
      date: '1941-08-15',
      die: 4,
      deadPile: [eligibleDivision, unit({ id: 'ru-alarm-tk', side: 'soviet', branch: 'armor_tk' })],
      alarmUnitIds: ['ru-alarm-tk'],
      alarmQuotas: [{ unitId: 'ru-alarm-tk', limit: 3 }],
      alarmInPlay: { 'ru-alarm-tk': 3 },
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.second).toMatchObject({ kind: 'void', reason: 'alarmMixLimitReached' })
    expect(plan.data.pools.alarmCandidates).toEqual([])
    expect(plan.data.pools.alarmMix).toEqual([
      { unitId: 'ru-alarm-tk', limit: 3, inPlay: 3, remaining: 0, over: false },
    ])
  })

  it('2.3a：还有余量时同型可返场（与「一型一枚」的普通单位不同）', () => {
    const plan = planSpecialReplDraw({
      side: 'soviet',
      date: '1941-08-15',
      die: 4,
      deadPile: [eligibleDivision, unit({ id: 'ru-alarm-tk', side: 'soviet', branch: 'armor_tk' })],
      alarmUnitIds: ['ru-alarm-tk'],
      alarmQuotas: [{ unitId: 'ru-alarm-tk', limit: 3 }],
      alarmInPlay: { 'ru-alarm-tk': 1 },
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.second).toMatchObject({ kind: 'alarm', unitId: 'ru-alarm-tk' })
    expect(plan.data.pools.alarmMix[0]).toMatchObject({ remaining: 2 })
  })

  it('C12：苏方抽到「师 + Supply Cache」（1–2）', () => {
    const plan = planSpecialReplDraw({
      side: 'soviet',
      date: '1941-08-15',
      die: 1,
      deadPile: [eligibleDivision],
    })
    expect(plan.ok && plan.data.table.kind).toBe('division_caches')
    expect(plan.ok && plan.data.second.kind).toBe('supplyCache')
  })

  it('C12：轴方抽到 Aufk/Krd 营（5–6），从死亡堆返场', () => {
    const plan = planSpecialReplDraw({
      side: 'axis',
      date: '1941-08-15',
      die: 5,
      deadPile: [unit({ id: 'ax-aufk', side: 'axis', branch: 'arm_rec' })],
      alarmUnitIds: ['ax-aufk'],
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.table.kind).toBe('aufk_krd')
    expect(plan.data.division).toBeNull() // 轴方无固定项
    expect(plan.data.second).toMatchObject({ kind: 'alarm', unitId: 'ax-aufk' })
    expect(plan.data.patches.map((patch) => patch.unitId)).toEqual(['ax-aufk'])
  })

  it('C12：死亡堆无合格师 ⇒ 固定项无重建（1.6 表 1-6：dead pile 无单位即无重建）', () => {
    const plan = planSpecialReplDraw({
      side: 'soviet',
      date: '1941-08-15',
      die: 4,
      deadPile: [tankDivision],
    })
    expect(plan.ok && plan.data.division).toBeNull()
    expect(plan.ok && plan.data.detail).toContain('无合格师')
  })

  it('C12：日期已过 / 骰面非法 ⇒ 按规则拒绝（不臆造结果）', () => {
    const stopped = planSpecialReplDraw({
      side: 'axis',
      date: rulesConstants.smolensk.specialReplEndDate,
      die: 3,
      deadPile: [],
    })
    expect(stopped).toMatchObject({
      ok: false,
      reason: expect.stringContaining('specialReplStoppedFrom'),
    })
    const badDie = planSpecialReplDraw({ side: 'axis', date: '1941-08-15', die: 7, deadPile: [] })
    expect(badDie).toMatchObject({ ok: false, reason: expect.stringContaining('DieOutOfRange') })
  })
})

/* ────────────────────────────── 剧本抽取盒 ────────────────────────────── */

describe('W7 C12：剧本抽取盒（编队抽签）', () => {
  it('C12：池规模由 formations.json 推导，与规则书给的 12 / 14 一致', () => {
    // ch10：剧本 1 入杯 12 个装甲/摩托化师；ch11：剧本 3/5 为 14 个
    expect(scenarioDrawBoxView('1').poolSize).toBe(12)
    expect(axisDrawPool('1')).toHaveLength(12)
    expect(scenarioDrawBoxView('3').poolSize).toBe(14)
    expect(axisDrawPool('3')).toHaveLength(14)
    expect(axisDrawPool('5')).toHaveLength(14)
    // 骑兵师不入杯（编队名以 Cav Div 结尾）
    expect(axisDrawPool('1').some((entry) => entry.formationId.includes('Cav'))).toBe(false)
    // 池规模与规则书一致 ⇒ 无「池规模不一致」缺口；但「名单未逐条列出」始终如实标注
    const gaps = scenarioDrawBoxView('1').dataGaps
    expect(gaps.some((gap) => gap.includes('池规模与数据不一致'))).toBe(false)
    expect(gaps.join('｜')).toContain('未逐条列出')
  })

  it('C12：剧本 2/4/6 继承同批初设的抽取参数（sharedSetupWith）', () => {
    expect(scenarioDrawBoxView('2').groups.map((group) => group.kind)).toEqual([
      'shiftWest',
      'mtrAufkSwap',
    ])
    expect(scenarioDrawBoxView('4').groups[0]!.kind).toBe('moveMode')
    expect(scenarioDrawBoxView('6').groups.map((group) => group.count)).toEqual([5, 7])
  })

  it('C12：剧本 7 无随机化 ⇒ 无抽取组，并如实标注数据缺口', () => {
    const box = scenarioDrawBoxView('7')
    expect(box.groups).toEqual([])
    expect(box.dataGaps.join('｜')).toContain('未登记编队抽取参数')
    expect(scenarios.scenarios.find((item) => item.id === '7')?.setup.formationDraw).toBeUndefined()
  })

  it('C12：B 组互换 —— Mtr 团入死亡堆、Aufk 营从死亡堆返场（ch10：Mtr 死、Aufk 活）', () => {
    const group = scenarioDrawBoxView('1').groups[1]!
    expect(group.kind).toBe('mtrAufkSwap')
    const plan = planScenarioDraw({
      scenarioId: '1',
      group: { ...group, count: 1 } as ScenarioDrawGroup,
      drawnFormationIds: ['10 Mtr Div'],
      facts: {
        '10 Mtr Div': { mtrRegimentUnitId: 'ax-mtr-41', aufkBattalionUnitId: 'ax-aufk-10' },
      },
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data.deposits[0]).toMatchObject({ unitId: 'ax-mtr-41', to: 'deadPile' })
    expect(plan.data.returns[0]).toMatchObject({ unitId: 'ax-aufk-10', to: null })
    expect(plan.data.detail).toContain('10 Mtr Div')
  })

  it('C12：S3 的 A 组把抽中师的全部战斗单位转为 Move Mode', () => {
    const group = scenarioDrawBoxView('3').groups[0]!
    expect(group.kind).toBe('moveMode')
    const plan = planScenarioDraw({
      scenarioId: '3',
      group: { ...group, count: 1 },
      drawnFormationIds: ['3 Pz Div'],
      facts: { '3 Pz Div': { combatUnitIds: ['u1', 'u2'] } },
    })
    expect(plan.ok && plan.data.moveModeFormations).toEqual(['3 Pz Div'])
    expect(plan.ok && plan.data.deposits.map((patch) => patch.mode)).toEqual(['move', 'move'])
  })

  it('C12：S5 的 A/B 组把 Krd / Aufk 营加入死亡堆（5 + 7 = 12 个营）', () => {
    const box = scenarioDrawBoxView('5')
    expect(box.groups.map((group) => `${group.kind}:${group.count}`)).toEqual([
      'deadPileKrd:5',
      'deadPileAufk:7',
    ])
    const plan = planScenarioDraw({
      scenarioId: '5',
      group: { ...box.groups[1]!, count: 1 },
      drawnFormationIds: ['10 Pz Div'],
      facts: { '10 Pz Div': { aufkBattalionUnitId: 'ax-aufk-90' } },
    })
    expect(plan.ok && plan.data.deposits[0]).toMatchObject({ unitId: 'ax-aufk-90', to: 'deadPile' })
  })

  it('C12：抽取个数不符 / 编队不在池内 / 组成事实缺失 ⇒ 拒绝（不猜单位）', () => {
    const group = { ...scenarioDrawBoxView('1').groups[1]!, count: 2 }
    const wrongCount = planScenarioDraw({
      scenarioId: '1',
      group,
      drawnFormationIds: ['10 Mtr Div'],
      facts: {},
    })
    expect(wrongCount).toMatchObject({
      ok: false,
      reason: expect.stringContaining('drawCountMismatch'),
    })

    const notInPool = planScenarioDraw({
      scenarioId: '1',
      group,
      drawnFormationIds: ['1 Cav Div', '10 Mtr Div'],
      facts: {},
    })
    expect(notInPool).toMatchObject({
      ok: false,
      reason: expect.stringContaining('formationNotInDrawPool'),
    })

    const missingFacts = planScenarioDraw({
      scenarioId: '1',
      group,
      drawnFormationIds: ['10 Mtr Div', '3 Pz Div'],
      facts: {},
    })
    expect(missingFacts).toMatchObject({
      ok: false,
      reason: expect.stringContaining('drawCompositionFactsMissing'),
    })
  })
})

/* ────────────────────────────── 地图外盒 ────────────────────────────── */

describe('W7 C12：地图外空军盒（1.4a）与边缘盒（1.4b）', () => {
  it('C12：空军盒分 Active / Inactive 两栏，航程取数据（苏 20 / 轴 30）', () => {
    const view = airBoxView({
      side: 'soviet',
      aircraft: [
        unit({ id: 'air-a', side: 'soviet', kind: 'air', airStatus: 'active' }),
        unit({ id: 'air-b', side: 'soviet', kind: 'air', airStatus: 'inactive' }),
      ],
    })
    expect(view.rule).toBe(AIR_BOX_RULE)
    expect(view.sections.map((section) => section.id)).toEqual(['active', 'inactive'])
    expect(view.holdings.map((holding) => `${holding.unitId}:${holding.sectionId}`)).toEqual([
      'air-a:active',
      'air-b:inactive',
    ])
    expect(view.activeCount).toBe(1)
    expect(view.inactiveCount).toBe(1)
    expect(view.rangeHexes).toBe(20)
    expect(airBoxView({ side: 'axis', aircraft: [] }).rangeHexes).toBe(30)
    // 1.4a：盒内免费整备、基数无限 ⇒ 恒可激活
    expect(view.activation).toMatchObject({
      activatable: true,
      freeRefitPerTurn: true,
      infiniteCapacity: true,
    })
  })

  it('C12：盒内免费整备把 Inactive 全部翻为 Active（1.4a，不耗 SP）', () => {
    const plan = planAirBoxActivate({
      side: 'axis',
      aircraft: [
        unit({ id: 'air-x', side: 'axis', kind: 'air', airStatus: 'inactive' }),
        unit({ id: 'air-y', side: 'axis', kind: 'air', airStatus: 'inactive' }),
      ],
    })
    expect(plan.ok && plan.data.activations).toEqual(['air-x', 'air-y'])
    expect(plan.ok && plan.data.detail).toContain('不消耗 SP')
  })

  it('C12：边缘盒——仅苏方地面单位、仅移动阶段、须在边缘补给源格（1.4b）', () => {
    const ok = planEdgeBoxMove({
      side: 'soviet',
      phase: 'movement',
      unitKind: 'ground',
      fromSupplySourceHex: true,
      direction: 'enter',
    })
    expect(ok.ok).toBe(true)
    expect(ok.ok && ok.data.entryMp).toBe(rulesConstants.movement.edgeBoxEntryMp)
    const axis = planEdgeBoxMove({
      side: 'axis',
      phase: 'movement',
      unitKind: 'ground',
      fromSupplySourceHex: true,
      direction: 'enter',
    })
    expect(axis).toMatchObject({ ok: false, rule: '1.4b', reason: 'edgeBoxSovietOnly' })
    const air = planEdgeBoxMove({
      side: 'soviet',
      phase: 'movement',
      unitKind: 'air',
      fromSupplySourceHex: true,
      direction: 'enter',
    })
    expect(air).toMatchObject({ ok: false, reason: 'edgeBoxGroundUnitsOnly' })
    const reaction = planEdgeBoxMove({
      side: 'soviet',
      phase: 'reaction',
      unitKind: 'ground',
      fromSupplySourceHex: true,
      direction: 'enter',
    })
    expect(reaction).toMatchObject({ ok: false, reason: 'edgeBoxMovementPhaseOnly' })
    const inland = planEdgeBoxMove({
      side: 'soviet',
      phase: 'movement',
      unitKind: 'ground',
      fromSupplySourceHex: false,
      direction: 'exit',
    })
    expect(inland).toMatchObject({ ok: false, reason: 'edgeBoxNeedsSupplySourceHex' })
    // 出箱免费供油（1.4b）
    const exit = planEdgeBoxMove({
      side: 'soviet',
      phase: 'movement',
      unitKind: 'ground',
      fromSupplySourceHex: true,
      direction: 'exit',
    })
    expect(exit.ok && exit.data.exitFuelsFree).toBe(true)
    // 铁路容量替代 MP（1.4b：1 MP 或 Rail Cap）
    const byRail = planEdgeBoxMove({
      side: 'soviet',
      phase: 'movement',
      unitKind: 'ground',
      fromSupplySourceHex: true,
      direction: 'enter',
      useRailCap: true,
    })
    expect(byRail.ok && byRail.data.entryMp).toBe(0)
  })

  it('C12：边缘盒视图给出连接与盒内清单（1.4b）', () => {
    const view = edgeBoxView({
      box: 'southeast',
      units: [unit({ id: 'ru-inf', side: 'soviet' })],
    })
    expect(view.rule).toBe(EDGE_BOX_RULE)
    expect(view.side).toBe('soviet')
    expect(view.connection).toBe('southAndEast')
    expect(view.holdings).toHaveLength(1)
    expect(view.notes.join('｜')).toContain('进入即须**停止移动**')
    expect(edgeBoxView({ box: 'northeast', units: [] }).connection).toBe('northAndEast')
  })
})

/* ────────────────────────────── 编队收纳盒 ────────────────────────────── */

describe('W7 C12：编队收纳盒（13.7 / 3.6f）', () => {
  it('C12：收纳盒列出盒内（隐藏）与图上单位，并挂上编队标记', () => {
    const view = formationBoxView({
      formationId: '10 Mtr Div',
      side: 'axis',
      members: [
        unit({ id: 'ax-10-arty', side: 'axis', formationId: '10 Mtr Div' }),
        unit({ id: 'ax-10-aufk', side: 'axis', formationId: '10 Mtr Div' }),
      ],
      onMapIds: ['ax-10-arty'],
    })
    expect(view.rule).toBe(FORMATION_BOX_RULE)
    expect(view.hiddenIds).toEqual(['ax-10-aufk'])
    expect(view.onMapIds).toEqual(['ax-10-arty'])
    expect(view.marker?.markerName).toContain('10')
    expect(view.dataGaps).toEqual([])
  })

  it('C12：标记库找不到对应标记时如实记入 dataGaps（不硬凑）', () => {
    const view = formationBoxView({
      formationId: '99 Pz Div',
      side: 'axis',
      members: [],
      onMapIds: [],
    })
    expect(view.marker).toBeNull()
    expect(view.dataGaps.join('｜')).toContain('未找到')
  })

  it('C12：收纳后必须至少留一个所属单位与标记同格（13.7 硬约束）', () => {
    const rejected = planFormationBoxHide({
      formationId: '10 Mtr Div',
      markerHex: { col: 8, row: 0 },
      remainingOnMap: [{ unitId: 'ax-10-arty', hex: { col: 9, row: 0 } }],
      hideUnitIds: ['ax-10-aufk'],
    })
    expect(rejected).toMatchObject({
      ok: false,
      reason: 'atLeastOneUnitMustStackWithMarker',
    })
    const ok = planFormationBoxHide({
      formationId: '10 Mtr Div',
      markerHex: { col: 8, row: 0 },
      remainingOnMap: [{ unitId: 'ax-10-arty', hex: { col: 8, row: 0 } }],
      hideUnitIds: ['ax-10-aufk'],
    })
    expect(ok.ok && ok.data.hidden).toEqual(['ax-10-aufk'])
    expect(
      planFormationBoxReveal({ formationId: '10 Mtr Div', releaseUnitIds: ['ax-10-aufk'] }).ok,
    ).toBe(true)
    expect(
      planFormationBoxHide({
        formationId: '10 Mtr Div',
        markerHex: { col: 8, row: 0 },
        remainingOnMap: [],
        hideUnitIds: [],
      }),
    ).toMatchObject({ ok: false, reason: 'nothingToHide' })
  })
})

/* ────────────────────────────── 美工接口与总览 ────────────────────────────── */

describe('W7 C12：盒子美工接口与总览', () => {
  it('C12：数据未提供盒图 ⇒ artwork 为 null（界面退化为纯文字盒，不影响判定）', () => {
    expect(markers.containers.artwork).toBeUndefined()
    expect(boxArtwork('dead-pile-axis')).toBeNull()
    expect(deadPileView({ side: 'axis', units: [] }).artwork).toBeNull()
  })

  it('C12：总览一次列出双方死亡堆/拆分盒/特殊补员盒/空军盒 + 两个边缘盒 + 剧本抽取盒', () => {
    const views = allBoxViews({
      scenarioId: '1',
      deadPile: { axis: [], soviet: [] },
      breakdownUnits: { axis: [], soviet: [] },
      breakdownOnMap: { axis: [], soviet: [] },
      aircraftInBox: { axis: [], soviet: [] },
      edgeBoxUnits: { northeast: [], southeast: [] },
      formationBoxes: [],
      date: '1941-07-08',
    })
    expect(views.map((view) => view.kind)).toEqual([
      'deadPile',
      'breakdownBox',
      'specialReplBox',
      'airBox',
      'deadPile',
      'breakdownBox',
      'specialReplBox',
      'airBox',
      'edgeBox',
      'edgeBox',
      'scenarioDrawBox',
    ])
    // 每个盒都有分栏，且栏内持有项都落在声明的栏上
    for (const view of views) {
      expect(view.sections.length).toBeGreaterThan(0)
      const ids = view.sections.map((section) => section.id)
      for (const holding of view.holdings) expect(ids).toContain(holding.sectionId)
    }
  })

  it('C12：1.6c 抽取盒的栏位与死亡堆一致（单栏恒为 main）', () => {
    expect(MAIN_SECTION).toBe('main')
    const view = specialReplBoxView({ side: 'soviet', date: '1941-07-08', deadPile: [] })
    expect(view.sections.map((section) => section.id)).toEqual([MAIN_SECTION, 'second'])
    expect(view.items).toHaveLength(2)
    expect(view.specialRows.length).toBeGreaterThan(0)
  })
})
