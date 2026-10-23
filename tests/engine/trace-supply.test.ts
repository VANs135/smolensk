import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import { unitsSoviet } from '@/data'
import { neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import {
  DIRECT_DRAW_RANGE_MP,
  assessUnitSupply,
  canCreateExtenderAt,
  canDirectDraw,
  canDrawFromDump,
  canEatOffTheMap,
  canThrowViaHQ,
  countSupplyDistance,
  countSupplyDistanceToAny,
  createTraceSupplyAt,
  createTraceSupplyFacts,
  eatingOffTheMapCostT,
  extenderRangeMpOf,
  formationTraceTradeoff,
  hasTraceSupply,
  planOutOfSupply,
  requiresTraceSupply,
  traceCoverageHexes,
  traceSourcesFor,
  type BaseSourceKind,
  type ExtenderView,
  type ThrowHqView,
  type TraceSupplyFacts,
  type TraceSupplyUnitView,
} from '@/engine/rules'

/**
 * 补给追溯（B10，OCS 12.0）测试
 *
 * 口径：断言到**条文**一级（12.3a–d / 12.6a–f / 12.7a–d / 12.8a / 5.8b）。
 * 逻辑测试一律用**注入的假事实**（同一条竖列、每步 1 MP），使取费与阻断完全可控；
 * 另有一组「默认工厂 + 真实地图」的集成断言，证明计费与 TEC 口径同源（12.3d）。
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
  /** 敌方**战斗单位**所在格（12.3d：阻断一切路径） */
  enemyCombat?: readonly HexRef[]
  /** 未抵消的敌方 ZOC 所在格（12.3d：只阻断卡车 MP 路径的进入与离开） */
  enemyZoc?: readonly HexRef[]
}

/** 注入式假事实：完全确定，不依赖真实地图数据 */
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

/* ────────────────────────────── 12.3a / 12.3c 直接拖取（5 MP） ────────────────────────────── */

describe('12.3a/12.3c 直接拖取：5 MP，或与 dump 相邻', () => {
  it('上限取自 rules-constants 的 directDrawRangeMp（5）', () => {
    expect(DIRECT_DRAW_RANGE_MP).toBe(5)
  })

  it('≤ 5 MP 成立，超过不成立；与 dump 相邻则永远成立（12.3c）', () => {
    expect(canDirectDraw({ distanceMp: 5 }).ok).toBe(true)
    expect(canDirectDraw({ distanceMp: 5.5 })).toMatchObject({ ok: false, rule: '12.3a' })
    expect(canDirectDraw({ distanceMp: 39, adjacentToDump: true })).toMatchObject({
      ok: true,
      rule: '12.3c',
    })
  })

  it('canDrawFromDump：5 MP 内可取；12.3c 使第 6 格也可取（够到它相邻的第 5 格）；第 7 格不可', () => {
    const hexes = corridor(0, 10)
    const facts = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    expect(canDrawFromDump(facts, { hex: at(4), side: 'axis', mobility: 'truck' }).ok).toBe(true)
    // 12.3c：单位在 6，补给路径够到它相邻的 5（5 MP）即足够
    expect(canDrawFromDump(facts, { hex: at(6), side: 'axis', mobility: 'truck' }).ok).toBe(true)
    // 单位在 7：最近的相邻格是 6，需 6 MP > 5，且不相邻于 dump
    expect(canDrawFromDump(facts, { hex: at(7), side: 'axis', mobility: 'truck' }).ok).toBe(false)
    // 与 dump 相邻（距离 1）当然可取
    expect(canDrawFromDump(facts, { hex: at(1), side: 'axis', mobility: 'truck' }).ok).toBe(true)
    // 己方 dump 不服务敌方
    expect(canDrawFromDump(facts, { hex: at(1), side: 'soviet', mobility: 'truck' })).toMatchObject(
      {
        ok: false,
        reason: 'noDump',
      },
    )
  })

  it('12.3c：补给能到单位的**相邻格**即可（从 dump 出发的第 6 格也可取）', () => {
    const hexes = corridor(0, 10)
    const facts = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    // 单位在 5：dump→单位的相邻格（4 或 6）均在 5 MP 内；单位在 6 时 dump→5 只有 5 MP
    expect(
      countSupplyDistanceToAny(facts, {
        from: at(0),
        targets: [at(6), ...(['N', 'S'] as const).map((d) => neighbor(at(6), d))],
        side: 'axis',
        mobility: 'truck',
        maxMp: DIRECT_DRAW_RANGE_MP,
      }),
    ).toMatchObject({ ok: true, mp: 5 })
  })
})

/* ────────────────────────────── 12.3b HQ 投递 ────────────────────────────── */

describe('12.3b HQ 投递：战略模式不可、不可转投、须在印值投递距离内', () => {
  it('纯数值判定：战略模式 HQ 不能投递（12.3b-C）、不可转投（12.3b-D）', () => {
    expect(canThrowViaHQ({ hqMode: 'strat', distanceMp: 1, throwRangeMp: 5 })).toMatchObject({
      ok: false,
      rule: '12.3b-C',
      reason: 'stratHqCannotThrow',
    })
    expect(
      canThrowViaHQ({ hqMode: 'combat', distanceMp: 1, throwRangeMp: 5, receivedByThrow: true }),
    ).toMatchObject({ ok: false, rule: '12.3b-D', reason: 'hqCannotReThrow' })
    expect(canThrowViaHQ({ hqMode: 'move', distanceMp: 3, throwRangeMp: 3 }).ok).toBe(true)
    expect(canThrowViaHQ({ hqMode: 'move', distanceMp: 3.5, throwRangeMp: 3 })).toMatchObject({
      ok: false,
      reason: 'outOfThrowRange',
    })
  })

  it('有资格的 HQ 成为追溯补给源（kind=hqThrow）；战略模式的 HQ 不是', () => {
    const hexes = corridor(0, 12)
    const dump = { hex: at(0), side: 'axis' as Side }
    const hq: ThrowHqView = {
      hex: at(2),
      side: 'axis',
      mode: 'combat',
      mobility: 'truck',
      throwRangeMp: 4,
      throwMobility: 'truck',
    }
    const facts = makeFacts({ hexes, dumps: [dump], throwHqs: [hq] })
    // 单位在 5：HQ(2) 到「单位或其相邻格(4/6)」为 2–4 MP ≤ 4
    expect(traceSourcesFor(facts, { hex: at(5), side: 'axis', mobility: 'truck' })).toEqual([
      { hex: at(2), kind: 'hqThrow' },
    ])
    // 超投递距离（单位 9：最近相邻格 8，距离 6 > 4）⇒ 无源
    expect(hasTraceSupply(facts, { hex: at(9), side: 'axis', mobility: 'truck' })).toMatchObject({
      ok: false,
    })

    // 12.3b-C：战略模式的 HQ 不投递
    const stratHq = makeFacts({
      hexes,
      dumps: [dump],
      throwHqs: [{ ...hq, mode: 'strat' }],
    })
    expect(traceSourcesFor(stratHq, { hex: at(5), side: 'axis', mobility: 'truck' })).toEqual([])
    // 12.3b-D：已由别的 HQ 投递获得补给的 HQ 不可再投
    const relayHq = makeFacts({
      hexes,
      dumps: [dump],
      throwHqs: [{ ...hq, receivedByThrow: true }],
    })
    expect(traceSourcesFor(relayHq, { hex: at(5), side: 'axis', mobility: 'truck' })).toEqual([])
    // HQ 自己够不到任何 dump/源时也不具备投递资格
    const dryHq = makeFacts({ hexes, throwHqs: [hq] })
    expect(traceSourcesFor(dryHq, { hex: at(5), side: 'axis', mobility: 'truck' })).toEqual([])
  })
})

/* ────────────────────────────── 12.6a/12.6b 追溯补给 ────────────────────────────── */

describe('12.6a 三种补给源与 12.6b 源格阻断', () => {
  const hexes = corridor(0, 12)

  it('12.6a①②：地图边缘铁路源 / 专规补给源 / 火车卸货格都算，按 kind 区分', () => {
    const facts = makeFacts({
      hexes,
      sources: [
        { hex: at(0), side: 'axis', kind: 'edgeRail' },
        { hex: at(1), side: 'axis', kind: 'detrainable' },
        { hex: at(2), side: 'axis', kind: 'supplySourceHex' },
      ],
    })
    expect(traceSourcesFor(facts, { hex: at(6), side: 'axis', mobility: 'leg' })).toEqual([
      { hex: at(1), kind: 'detrainable' },
      { hex: at(0), kind: 'edgeRail' },
      { hex: at(2), kind: 'supplySourceHex' },
    ])
    expect(hasTraceSupply(facts, { hex: at(6), side: 'axis', mobility: 'leg' })).toMatchObject({
      ok: true,
      rule: '12.6a',
    })
  })

  it('12.6b：源格内有未抵消的敌方 ZOC ⇒ 不能从该源获得追溯补给', () => {
    const facts = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'supplySourceHex' }],
      enemyZoc: [at(0)],
    })
    expect(hasTraceSupply(facts, { hex: at(3), side: 'axis', mobility: 'leg' })).toMatchObject({
      ok: false,
      rule: '12.6b',
      reason: 'sourceBlocked',
    })
  })

  it('12.3d：绝不能穿敌方战斗单位；无源即断补（12.6a）', () => {
    const blocked = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'detrainable' }],
      enemyCombat: [at(3)],
    })
    expect(hasTraceSupply(blocked, { hex: at(6), side: 'axis', mobility: 'leg' })).toMatchObject({
      ok: false,
      reason: 'noSource',
    })
    const noSource = makeFacts({ hexes })
    expect(hasTraceSupply(noSource, { hex: at(2), side: 'axis', mobility: 'leg' })).toMatchObject({
      ok: false,
      rule: '12.6a',
      reason: 'noSource',
    })
  })

  it('12.3d：未抵消的敌方 ZOC 阻挡卡车 MP 路径的**进入与离开**，徒步不受影响', () => {
    const facts = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'detrainable' }],
      enemyZoc: [at(4)],
    })
    expect(hasTraceSupply(facts, { hex: at(8), side: 'axis', mobility: 'truck' })).toMatchObject({
      ok: false,
    })
    expect(hasTraceSupply(facts, { hex: at(8), side: 'axis', mobility: 'leg' }).ok).toBe(true)
    // 12.3d 的另一半：卡车**从** ZOC 格出发也被阻断（起点在 ZOC 内 ⇒ 出不去）
    expect(
      countSupplyDistance(facts, { from: at(4), to: at(5), side: 'axis', mobility: 'truck' }),
    ).toMatchObject({ ok: false })
  })

  it('12.6：trace 无距离上限（连通即可），而拖取有 5 MP 上限', () => {
    const hexes = corridor(0, 40)
    const facts = makeFacts({ hexes, sources: [{ hex: at(0), side: 'axis', kind: 'detrainable' }] })
    expect(hasTraceSupply(facts, { hex: at(39), side: 'axis', mobility: 'truck' }).ok).toBe(true)
    const withDump = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    expect(canDrawFromDump(withDump, { hex: at(39), side: 'axis', mobility: 'truck' }).ok).toBe(
      false,
    )
  })

  it('12.0：只有战斗单位需要追溯补给', () => {
    expect(requiresTraceSupply({ isCombat: true })).toBe(true)
    expect(requiresTraceSupply({ isCombat: false })).toBe(false)
  })
})

/* ────────────────────────────── 12.6c 图上补给 ────────────────────────────── */

describe('12.6c 图上补给：每 1 T 喂最多 2 RE，小数向上取整', () => {
  it('规则书算例：6.5 RE 需 4 T；边界取整正确', () => {
    expect(eatingOffTheMapCostT(6.5)).toBe(4)
    expect(eatingOffTheMapCostT(2)).toBe(1)
    expect(eatingOffTheMapCostT(3)).toBe(2)
    expect(eatingOffTheMapCostT(0)).toBe(0)
  })

  it('12.6c：取整作用在**批次总量**上——逐单位增量累加 ≡ 一次性批量', () => {
    /* 条文例「6.5 的 RE 需消耗 4T」中的 6.5 RE 只能是**一批单位合计**；
     * 收费按批次费率之差（增量）逐单位收，累计必须恰等于批量收费。 */
    const batch = [2, 2, 1.5, 1] // 合计 6.5 RE
    let fed = 0
    let charged = 0
    for (const re of batch) {
      charged += eatingOffTheMapCostT(fed + re) - eatingOffTheMapCostT(fed)
      fed += re
    }
    expect(fed).toBe(6.5)
    expect(charged).toBe(eatingOffTheMapCostT(6.5))
    expect(charged).toBe(4)

    /*
     * 但**"逐单位各取整再相加"与批量口径并不总相等**——上面那批恰好在两种口径下都是 4，
     * 这正是该缺陷长期没被发现的原因。取一批二者相异者作证：
     * 两个 1RE 单位 ⇒ 批量 1 T，而逐单位各取整则是 1+1 = 2 T（多收一倍）。
     */
    expect(eatingOffTheMapCostT(1 + 1)).toBe(1)
    expect(eatingOffTheMapCostT(1) + eatingOffTheMapCostT(1)).toBe(2)
  })

  it('须在 dump 的拖取距离内，或经有资格的 HQ 投递；超出即不可', () => {
    const hexes = corridor(0, 12)
    const facts = makeFacts({
      hexes,
      dumps: [{ hex: at(0), side: 'axis' }],
      throwHqs: [
        {
          hex: at(4),
          side: 'axis',
          mode: 'move',
          mobility: 'truck',
          throwRangeMp: 3,
          throwMobility: 'truck',
        },
      ],
    })
    // 4 MP 内：直接拖取
    expect(canEatOffTheMap(facts, { hex: at(4), side: 'axis', mobility: 'truck' })).toMatchObject({
      ok: true,
      rule: '12.3a',
    })
    // 9：超出拖取 5 MP，但 HQ(4) 的投递距离 3 够到「9 或其相邻格 8」（4 MP 不行，8 为 4 MP）… 用 7 验证投递
    expect(canEatOffTheMap(facts, { hex: at(7), side: 'axis', mobility: 'truck' })).toMatchObject({
      ok: true,
      rule: '12.3b',
    })
    // 12：既不在拖取距离，也不在投递距离
    expect(canEatOffTheMap(facts, { hex: at(12), side: 'axis', mobility: 'truck' })).toMatchObject({
      ok: false,
      rule: '12.6c',
    })
    // 12.6e：战略模式单位不允许吃图上补给
    expect(
      canEatOffTheMap(facts, { hex: at(4), side: 'axis', mobility: 'truck', unitMode: 'strat' }),
    ).toMatchObject({ ok: false, rule: '12.6e', reason: 'stratCannotEatOffTheMap' })
  })
})

/* ────────────────────────────── 12.7 延补队 ────────────────────────────── */

describe('12.7 延补队：生成、新的 trace 取用点、锁链', () => {
  /*
   * ★ 批 F 切片 4②（2026-09-18）：原先这里的「生成需 5 点同型运输点，代价为一半 MA」
   *   与「编内卡车 / 装载中的运输点都不能组建延补队」两组断言打的是 `extenderCreationCost`
   *   （`trace-supply.ts` 里那份**只看聚合点数**的第二实现）——该函数已删除、口径收敛到
   *   `extender.ts` 的 `canConvertTransportToExtender` + `planConvertTransportToExtender`。
   *   同样的三条判据（阈值 5 / 一半 MA / 装载者先卸载）现在钉在 `tests/engine/extender.test.ts`
   *   的「批 F 切片 4②：12.7 收敛到一处实现」一组里（含 judge 与 plan 的一致性矩阵）。
   */

  it('12.7d：生成格必须能连上补给来源（被敌方 ZOC 挡住则不能生成）', () => {
    const hexes = corridor(0, 12)
    const source = { hex: at(0), side: 'axis' as Side, kind: 'detrainable' as BaseSourceKind }
    const open = makeFacts({ hexes, sources: [source] })
    expect(canCreateExtenderAt(open, { hex: at(3), side: 'axis', mobility: 'leg' })).toMatchObject({
      ok: true,
      rule: '12.7d',
    })
    // 卡车机动 + 中间有敌方 ZOC ⇒ 连不上来源
    const blocked = makeFacts({ hexes, sources: [source], enemyZoc: [at(6)] })
    expect(
      canCreateExtenderAt(blocked, { hex: at(9), side: 'axis', mobility: 'truck' }),
    ).toMatchObject({ ok: false, rule: '12.7d', reason: 'notConnectedToSource' })
  })

  it('12.7a/12.7b：延补队回连到源后成为取用点；12.7c 锁链可再延伸', () => {
    const hexes = corridor(0, 12)
    const source = { hex: at(0), side: 'axis' as Side, kind: 'detrainable' as BaseSourceKind }
    // 敌方 ZOC 在 6：卡车路径被截断，单位（卡车）够不到源
    const noExtender = makeFacts({ hexes, sources: [source], enemyZoc: [at(6)] })
    expect(
      hasTraceSupply(noExtender, { hex: at(9), side: 'axis', mobility: 'truck' }),
    ).toMatchObject({ ok: false })

    // 放一个**徒步**延补队（不受 ZOC 影响）在 8，距离 8 回连到源 0 ⇒ 成为取用点
    const withExtender = makeFacts({
      hexes,
      sources: [source],
      enemyZoc: [at(6)],
      extenders: [{ hex: at(8), side: 'axis', mobility: 'leg', rangeMp: 8 }],
    })
    expect(traceSourcesFor(withExtender, { hex: at(9), side: 'axis', mobility: 'truck' })).toEqual([
      { hex: at(8), kind: 'extender' },
    ])

    // 距离不足：12.7g 允许「相邻即可」，故边界是 range+1——range 6 时源到 7 号（8 的相邻格）= 7 > 6 ⇒ 不可用
    const tooShort = makeFacts({
      hexes,
      sources: [source],
      enemyZoc: [at(6)],
      extenders: [{ hex: at(8), side: 'axis', mobility: 'leg', rangeMp: 6 }],
    })
    expect(traceSourcesFor(tooShort, { hex: at(9), side: 'axis', mobility: 'truck' })).toEqual([])

    // 12.7c 锁链：8 号延补队距离不够，但 4 号（4 ≤ 4）可用，8 号再连 4 号（4 ≤ 4）⇒ 可用
    const chained = makeFacts({
      hexes,
      sources: [source],
      enemyZoc: [at(6)],
      extenders: [
        { hex: at(4), side: 'axis', mobility: 'leg', rangeMp: 4 },
        { hex: at(8), side: 'axis', mobility: 'leg', rangeMp: 4 },
      ],
    })
    expect(traceSourcesFor(chained, { hex: at(9), side: 'axis', mobility: 'truck' })).toEqual([
      { hex: at(8), kind: 'extender' },
    ])
  })
})

/* ────────────────────────────── 12.6f 编队同源取舍 ────────────────────────────── */

describe('12.6f 编队同源：整体 trace 到同一来源，否则只有一部分免费', () => {
  const hexes = corridor(0, 12)

  it('两单位各连不同源时，取覆盖最多的共同来源，其余列为未覆盖', () => {
    const facts = makeFacts({
      hexes,
      sources: [
        { hex: at(0), side: 'axis', kind: 'detrainable' },
        { hex: at(10), side: 'axis', kind: 'supplySourceHex' },
      ],
      // 5 号有敌方战斗单位，把走廊切断：3 只能连下端源、7 只能连上端源
      enemyCombat: [at(5)],
    })
    const result = formationTraceTradeoff(facts, {
      side: 'axis',
      mobility: 'leg',
      units: [
        { id: 'a', hex: at(3) },
        { id: 'b', hex: at(7) },
      ],
    })
    expect(result.rule).toBe('12.6f')
    expect(result.sameSource).toBe(false)
    expect(result.commonSource?.hex).toEqual(at(0))
    expect(result.coveredUnitIds).toEqual(['a'])
    expect(result.uncoveredUnitIds).toEqual(['b'])
  })

  it('全体连到同一来源时 sameSource 为真且全覆盖', () => {
    const facts = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'detrainable' }],
    })
    const result = formationTraceTradeoff(facts, {
      side: 'axis',
      mobility: 'leg',
      units: [
        { id: 'a', hex: at(3) },
        { id: 'b', hex: at(4) },
      ],
    })
    expect(result.sameSource).toBe(true)
    expect(result.coveredUnitIds).toEqual(['a', 'b'])
    expect(result.uncoveredUnitIds).toEqual([])
  })
})

/* ────────────────────────────── 12.6d / 12.8a 断补标记与解除 ────────────────────────────── */

describe('12.6d 断补标记与 12.8a 解除', () => {
  const hexes = corridor(0, 12)

  it('无 trace 且不吃图上补给 ⇒ 置标记；本回合恢复 trace ⇒ 除标记；非战斗单位不参与', () => {
    const facts = makeFacts({
      hexes,
      sources: [{ hex: at(0), side: 'axis', kind: 'detrainable' }],
      enemyCombat: [at(5)],
    })
    const units = [
      { id: 'supplied', side: 'axis' as Side, hex: at(3), isCombat: true, re: 4 },
      { id: 'cutoff', side: 'axis' as Side, hex: at(8), isCombat: true, re: 4 },
      { id: 'truck', side: 'axis' as Side, hex: at(9), isCombat: false, re: 0 },
    ]
    const assessments = units.map((unit) => assessUnitSupply(facts, unit, { mobility: 'leg' }))
    expect(assessments.map((item) => item.status)).toEqual([
      'inSupply',
      'outOfSupply',
      'notRequired',
    ])

    const plan = planOutOfSupply({ assessments, alreadyOutOfSupply: ['supplied'] })
    expect(plan.rule).toBe('12.6d')
    expect(plan.mark).toEqual(['cutoff'])
    expect(plan.clear).toEqual(['supplied'])
  })

  it('12.6c：够得着 dump 时可选择吃图上补给（永不被强迫），吃完即不置断补标记', () => {
    const facts = makeFacts({ hexes, dumps: [{ hex: at(0), side: 'axis' }] })
    const unit = { id: 'besieged', side: 'axis' as Side, hex: at(4), isCombat: true, re: 5 }
    const assessment = assessUnitSupply(facts, unit, { mobility: 'truck' })
    expect(assessment.status).toBe('canEatOffTheMap')
    expect(assessment.eatingCostT).toBe(3) // 5 RE → ceil(5/2) × 1T = 3T

    expect(planOutOfSupply({ assessments: [assessment], alreadyOutOfSupply: [] }).mark).toEqual([
      'besieged',
    ])
    expect(
      planOutOfSupply({
        assessments: [assessment],
        alreadyOutOfSupply: [],
        eatOffTheMap: () => true,
      }).mark,
    ).toEqual([])
  })
})

/* ────────────────────────────── 12.3d 计费口径（真实地图集成） ────────────────────────────── */

describe('12.3d 计费一律用正常地形成本（忽略天气与运输破坏）', () => {
  it('默认工厂的最短路 = 逐步 TEC 计费（同一来源，无天气加成）', () => {
    const facts = createTraceSupplyFacts({})
    const map = createMapFacts()
    const from: HexRef = { col: 36, row: 13 }
    for (const to of (['N', 'S', 'NE', 'SW'] as const).map((direction) =>
      neighbor(from, direction),
    )) {
      const crossing = map.crossingBetween(from, to)
      const expected = selectMovementTerrain({
        terrainsPresent: map.terrainsAt(to),
        mobility: 'truck',
        crossing,
        followingRoad: (crossing?.routes ?? []).length > 0,
      })
      expect(expected.ok).toBe(true)
      if (!expected.ok) continue
      const distance = countSupplyDistance(facts, { from, to, side: 'axis', mobility: 'truck' })
      expect(distance).toMatchObject({ ok: true })
      if (distance.ok) expect(distance.mp).toBe(expected.totalMp)
    }
  })

  it('默认工厂：真实地图上能连到源；敌方 ZOC（未抵消）阻断卡车路径（集成）', () => {
    const sourceHex: HexRef = { col: 36, row: 13 }
    const unitHex = neighbor(sourceHex, 'N')
    const facts = createTraceSupplyFacts({
      sources: [{ hex: sourceHex, side: 'axis', kind: 'detrainable' }],
      dumps: [{ hex: sourceHex, side: 'axis' }],
    })
    expect(hasTraceSupply(facts, { hex: unitHex, side: 'axis', mobility: 'truck' }).ok).toBe(true)
    expect(canDrawFromDump(facts, { hex: unitHex, side: 'axis', mobility: 'truck' }).ok).toBe(true)

    // 敌方战斗单位（战斗模式 + 可攻击 + 有补给 ⇒ 投射 ZOC）邻在源格旁 ⇒ 源格落入敌方 ZOC
    const enemy: TraceSupplyUnitView = {
      id: 'enemy',
      side: 'soviet',
      hex: unitHex,
      isCombat: true,
      attackCapable: true,
      inCombatMode: true,
      hasTraceSupply: true,
    }
    const blocked = createTraceSupplyFacts({
      sources: [{ hex: sourceHex, side: 'axis', kind: 'detrainable' }],
      units: [enemy],
    })
    expect(
      hasTraceSupply(blocked, { hex: sourceHex, side: 'axis', mobility: 'truck' }),
    ).toMatchObject({
      ok: false,
    })
    // 4.5b 抵消：源格内放一个己方战斗单位即抵消该格敌方 ZOC
    const negated = createTraceSupplyFacts({
      sources: [{ hex: sourceHex, side: 'axis', kind: 'detrainable' }],
      units: [enemy, { id: 'friendly', side: 'axis', hex: sourceHex, isCombat: true }],
    })
    expect(
      hasTraceSupply(negated, { hex: sourceHex, side: 'axis', mobility: 'truck' }),
    ).toMatchObject({
      ok: true,
    })
  })
})

/* ────────────────────────────── 12.7 延补队的距离与禁令 ────────────────────────────── */

describe('12.7 延补队：距离＝印值 MA、组建禁令、12.7g 相邻即可', () => {
  it('12.7b：距离取印值 MA——卡车延补队 20 轮式 MP、马车延补队 10（取自单位库）', () => {
    const truck = unitsSoviet.units.find((item) => item.id === 'su-extender-truck')
    const wagon = unitsSoviet.units.find((item) => item.id === 'su-extender-wagon')
    expect(truck).toBeDefined()
    expect(wagon).toBeDefined()
    expect(truck?.classes?.movementClass).toBe('truck')
    expect(wagon?.classes?.movementClass).toBe('leg')
    expect(extenderRangeMpOf({ ma: truck?.factors?.combat?.ma ?? 0 })).toBe(20)
    expect(extenderRangeMpOf({ ma: wagon?.factors?.combat?.ma ?? 0 })).toBe(10)
    expect(() => extenderRangeMpOf({ ma: -1 })).toThrowError(/印值 MA 非法/)
  })

  /*
   * ★ 批 F 切片 4②：「编内卡车与装载中的运输点都不能组建延补队」原先打的是 `extenderCreationCost`
   *   （已删）。两条禁令现在的判据位置：**编内卡车**＝`isConvertibleTransportPoint`（本文件上方
   *   「只有通用运输点数参与凑数」一组）与 store 的 `convertibleTransportPointsAt`；
   *   **装载者**＝`extender.ts` 的 `convertibleOf`（在 `tests/engine/extender.test.ts` 的收敛组里钉住）。
   */

  it('12.7g：回连适用「相邻即可」——够到延补队的相邻格也算连上', () => {
    const hexes = corridor(0, 12)
    const source = { hex: at(0), side: 'axis' as Side, kind: 'detrainable' as BaseSourceKind }
    // 敌方 ZOC 在 2：3 号及以北的单位（卡车）回不到源，但**徒步**延补队不受 ZOC 影响
    const base = {
      hexes,
      sources: [source],
      enemyZoc: [at(2)],
    }
    // 延补队在 5、range 4：到源 0 需 5 格 > 4，但它与 4 号相邻、源到 4 号恰好 4 ≤ 4 ⇒ 连上
    const relaxed = makeFacts({
      ...base,
      extenders: [{ hex: at(5), side: 'axis', mobility: 'leg', rangeMp: 4 }],
    })
    expect(traceSourcesFor(relaxed, { hex: at(6), side: 'axis', mobility: 'truck' })).toEqual([
      { hex: at(5), kind: 'extender' },
    ])
    // range 收紧到 3：连相邻格也不够（源到 4 号 = 4 > 3）⇒ 该延补队不可用
    const tight = makeFacts({
      ...base,
      extenders: [{ hex: at(5), side: 'axis', mobility: 'leg', rangeMp: 3 }],
    })
    expect(traceSourcesFor(tight, { hex: at(6), side: 'axis', mobility: 'truck' })).toEqual([])
  })
})

/* ────────────────────────────── 5.8b 桥接 ────────────────────────────── */

describe('5.8b 桥接：MoveContext.traceSupplyAt', () => {
  it('返回 (hex, side) => 是否拥有追溯补给', () => {
    const facts = makeFacts({
      hexes: corridor(0, 6),
      sources: [{ hex: at(0), side: 'axis', kind: 'detrainable' }],
    })
    const traceSupplyAt = createTraceSupplyAt(facts)
    expect(traceSupplyAt(at(3), 'axis')).toBe(true)
    // 苏军在该格无源（5.8b 会让战略模式单位无法在此结束移动）
    expect(traceSupplyAt(at(3), 'soviet')).toBe(false)
    // 图外 ⇒ false
    expect(traceSupplyAt({ col: 100, row: 100 }, 'axis')).toBe(false)
  })
})

/**
 * 12.6：**覆盖集**与逐格查询的等价性（防两套口径漂移的闸门）
 *
 * `traceCoverageHexes` 把「逐格向源查」反转成「从源向外铺一次」，因此必须证明两者结论**完全一致**：
 * 它同时验证了「连通性可逆」这一前提（`stepMp` 的阻断判据对称）——若哪天判据被改坏，
 * 这组用例会立刻变红，而不会静默地给出偏松或偏紧的覆盖。
 */
describe('12.6：覆盖集与逐格查询等价（traceCoverageHexes）', () => {
  const HEXES = corridor(10, 12)
  const SOURCE = { hex: at(10), side: 'axis' as const, kind: 'supplySourceHex' as const }

  const variants: { name: string; facts: TraceSupplyFacts }[] = [
    { name: '仅基础源', facts: makeFacts({ hexes: HEXES, sources: [SOURCE] }) },
    {
      name: '敌战斗单位阻断（12.3d）',
      facts: makeFacts({ hexes: HEXES, sources: [SOURCE], enemyCombat: [at(14)] }),
    },
    {
      name: '未抵消敌 ZOC（只阻断轮式）',
      facts: makeFacts({ hexes: HEXES, sources: [SOURCE], enemyZoc: [at(15)] }),
    },
    {
      name: '带 HQ 投递（12.3b + 12.3c 相邻即可）',
      facts: makeFacts({
        hexes: HEXES,
        sources: [SOURCE],
        dumps: [{ hex: at(22), side: 'axis' }],
        throwHqs: [
          {
            hex: at(22),
            side: 'axis',
            mode: 'combat',
            mobility: 'truck',
            throwRangeMp: 5,
            throwMobility: 'truck',
          },
        ],
      }),
    },
    {
      name: '带已连上的延补队（12.7）',
      facts: makeFacts({
        hexes: HEXES,
        sources: [SOURCE],
        extenders: [{ hex: at(18), side: 'axis', mobility: 'truck', rangeMp: 20 }],
      }),
    },
    { name: '无任何源', facts: makeFacts({ hexes: HEXES }) },
  ]

  for (const variant of variants) {
    for (const mobility of ['truck', 'leg'] as const) {
      it(`${variant.name} / ${mobility}：全格逐格一致`, () => {
        const coverage = traceCoverageHexes(variant.facts, { side: 'axis', mobility })
        const mismatches: string[] = []
        for (const hex of HEXES) {
          const perHex = hasTraceSupply(variant.facts, { hex, side: 'axis', mobility }).ok
          if (coverage.has(key(hex)) !== perHex)
            mismatches.push(`${key(hex)}: set=${coverage.has(key(hex))} 逐格=${perHex}`)
        }
        expect(mismatches).toEqual([])
      })
    }
  }

  it('真实地图 + 出厂事实：抽样逐格一致（不吃亏也不多给）', () => {
    const facts = createTraceSupplyFacts({
      sources: [{ hex: { col: 36, row: 13 }, side: 'axis', kind: 'supplySourceHex' }],
      dumps: [{ hex: { col: 36, row: 13 }, side: 'axis' }],
    })
    const coverage = traceCoverageHexes(facts, { side: 'axis', mobility: 'truck' })
    // 全图 2156 格逐个跑逐格查询太慢（那正是本函数要消除的成本），故按步长抽样
    const sampled: HexRef[] = []
    for (let col = 1; col <= 62; col += 5)
      for (let row = 0; row <= 35; row += 4) sampled.push({ col, row })
    const mismatches: string[] = []
    for (const hex of sampled) {
      const perHex = hasTraceSupply(facts, { hex, side: 'axis', mobility: 'truck' }).ok
      if (coverage.has(key(hex)) !== perHex)
        mismatches.push(`${key(hex)}: set=${coverage.has(key(hex))} 逐格=${perHex}`)
    }
    expect(mismatches).toEqual([])
    // 源所在格必在集内 ⇒ 上面的一致性不是"两边都空"的假一致
    expect(coverage.has('36.13')).toBe(true)
  })

  it('createTraceSupplyAt 与覆盖集同口径', () => {
    const facts = makeFacts({ hexes: HEXES, sources: [SOURCE] })
    const traceSupplyAt = createTraceSupplyAt(facts)
    const coverage = traceCoverageHexes(facts, { side: 'axis', mobility: 'truck' })
    for (const hex of HEXES) expect(traceSupplyAt(hex, 'axis')).toBe(coverage.has(key(hex)))
  })
})
