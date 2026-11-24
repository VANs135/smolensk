import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import { areAdjacent, HEX_DIRECTIONS, isOnMap, neighbor, sameHex } from '@/engine/hex-geometry'
import {
  createMapFacts,
  createTraceSupplyFacts,
  countSupplyDistanceToAny,
  projectsZoc,
  selectMovementTerrain,
  supplyReachableHexes,
  supplyStepCost,
} from '@/engine/rules'
import type {
  MapFacts,
  SupplyMobility,
  TraceSupplyFactsSource,
  TraceSupplyUnitView,
} from '@/engine/rules'

/**
 * H③（12.3d）：**补给搜索的成本口径**守卫
 *
 * 病灶（用户 2026-09-19 报告「选中需要加油的单位时浏览器占 1G 内存然后卡死」的实测根因）：
 *   ① `createTraceSupplyFacts` 的两个逐格判据在**闭包里线性扫全表** ——
 *      `hasEnemyCombatUnit` 扫全部战斗单位的**格**、`inEnemyZoc` 扫全部 ZOC 源；而 `stepMp` 每展开一个邻格
 *      都要问一次 ⇒ 一次 8 MP 查询＝「每个被访问格 × 6 邻格 × 全表单位数」次比较；
 *   ② `runDijkstra` 用**线性取最小**（每弹一格重扫整张 `best`，且已 settle 的也照扫）⇒ 与访问格数平方相关。
 *   实测（剧本 1 真实盘面，216 枚算子）：单次 8 MP 查询 37 ms、`drawableDumpsFor` 一次 602 ms、
 *   选中一枚需加油的单位整条 fuel computed 链 **2500 ms**。
 *
 * 本文件钉三条不变式：① 逐单位读取次数不随单位数放大（**确定性**）；
 * ② 查询耗时的比值不随单位数放大（与机器速度无关）；③ 一条宽松的绝对耗时烟测（防整体回退）。
 *
 * 测法边界（如实）：① 数的是**单位格对象**的 `col/row` 读取次数 —— 这正是"线性扫全表"的代理指标
 * （扫一遍表必然读每个格的坐标），但它数不到 `Map`/`Set` 的内部操作，故**不覆盖** `runDijkstra` 自身的
 * 算法复杂度（那一条靠 ② ③ 的耗时代理）；② 是比值（与机器无关）、③ 留 ~8 倍余量，
 * 二者在极慢/极忙的机器上仍可能抖动 —— 真正的规则正确性由既有 12.3/12.6/12.7 全套用例兜底。
 */

/** 造一批单位（**同一格**、六邻皆图外，不影响查询结论）：每个单位的格对象都是独立 Proxy，数坐标读取 */
function countingUnits(count: number): {
  units: TraceSupplyUnitView[]
  reads: () => number
  reset: () => void
} {
  let reads = 0
  const at: HexRef = { col: 0, row: 0 }
  const units: TraceSupplyUnitView[] = []
  for (let i = 0; i < count; i += 1) {
    const hex = new Proxy(
      { ...at },
      {
        get(target, prop, receiver) {
          reads += 1
          return Reflect.get(target, prop, receiver)
        },
      },
    )
    units.push({
      id: `u${i}`,
      side: (i % 2 === 0 ? 'axis' : 'soviet') as Side,
      hex,
      isCombat: true,
      // 4.5 的 ZOC 三条件全给：让 ZOC 那条扫表路径也真实发生
      attackCapable: true,
      inCombatMode: true,
      hasTraceSupply: true,
    })
  }
  return { units, reads: () => reads, reset: () => (reads = 0) }
}

/** 六邻皆图内的格（查询与地图削角无关） */
function coreHex(): HexRef {
  for (let col = 1; col < 40; col += 1) {
    for (let row = 1; row < 40; row += 1) {
      const ref = { col, row }
      if (!isOnMap(ref)) continue
      if (HEX_DIRECTIONS.every((direction) => isOnMap(neighbor(ref, direction)))) return ref
    }
  }
  throw new Error('地图上找不到六邻皆图内的格')
}

const CORE_HEX: HexRef = coreHex()

/** 距 CORE_HEX 约 7 格的格（让 8 MP 的洪泛真的铺开；找不到就退回邻格） */
const FAR_HEX: HexRef = (() => {
  for (let step = 7; step >= 1; step -= 1) {
    const candidate = { col: CORE_HEX.col + step, row: CORE_HEX.row }
    if (isOnMap(candidate)) return candidate
  }
  return neighbor(CORE_HEX, HEX_DIRECTIONS[0]!)
})()

function board(count: number): {
  source: TraceSupplyFactsSource
  reads: () => number
  reset: () => void
} {
  const counter = countingUnits(count)
  return { source: { units: counter.units }, reads: counter.reads, reset: counter.reset }
}

function query(facts: ReturnType<typeof createTraceSupplyFacts>): number {
  const t0 = performance.now()
  countSupplyDistanceToAny(facts, {
    from: CORE_HEX,
    targets: [FAR_HEX],
    side: 'axis',
    mobility: 'truck',
    maxMp: 8,
  })
  return performance.now() - t0
}

describe('H③（12.3d）：补给搜索的成本口径', () => {
  it('★ 逐单位读取次数不随场上单位数放大（第 2 次查询：150 枚 vs 3 枚）', () => {
    const small = board(3)
    const big = board(150)
    const smallFacts = createTraceSupplyFacts(small.source)
    const bigFacts = createTraceSupplyFacts(big.source)
    // 第 1 次查询＝预热（允许它付出"建一次索引"的逐单位成本）
    query(smallFacts)
    query(bigFacts)
    small.reset()
    big.reset()
    query(smallFacts)
    query(bigFacts)
    const smallReads = small.reads()
    const bigReads = big.reads()
    // 修前：每次查询都逐格扫全表 ⇒ bigReads ≈ 50 × smallReads（150 / 3）
    expect(bigReads).toBeLessThanOrEqual(smallReads + 2)
  })

  it('★ 查询耗时不随场上单位数放大（同一查询：300 枚 vs 3 枚，取中位数，比值 ≤ 3）', () => {
    /*
     * 修前：每展开一个邻格都要扫全表 ⇒ 比值 ≈ 单位数之比（150 / 3 时实测 16×）。
     * 修后两者都在亚毫秒级，单次测量噪声大 ⇒ 取 5 次中位数、门槛放宽到 3（被守护的信号是"几十倍"级的）。
     */
    const small = board(3)
    const big = board(300)
    const smallFacts = createTraceSupplyFacts(small.source)
    const bigFacts = createTraceSupplyFacts(big.source)
    query(smallFacts)
    query(bigFacts)
    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[2]!
    const tSmall = Math.max(
      median([
        query(smallFacts),
        query(smallFacts),
        query(smallFacts),
        query(smallFacts),
        query(smallFacts),
      ]),
      0.05,
    )
    const tBig = Math.max(
      median([query(bigFacts), query(bigFacts), query(bigFacts), query(bigFacts), query(bigFacts)]),
      0.05,
    )
    expect(tBig / tSmall).toBeLessThanOrEqual(3)
  })

  it('★ 单次 8 MP 查询的**挂死**守卫（200 ms；不是性能指标，防"整条链慢到卡死"）', () => {
    const big = board(150)
    const facts = createTraceSupplyFacts(big.source)
    query(facts)
    const t = query(facts)
    /*
     * ★ 变更（H④ 门禁实测，**不是放宽数值**）：本用例原先是"< 10 ms 的宽松烟测"（修前 ~21 ms）。
     *   它在单跑时是 2 ms，但在**整仓门禁并发**下实测 **48 ms**（同一份代码、同一台机器）——
     *   绝对毫秒阈值随之失真。守卫本意只是"防整体回退到卡死"，故门槛改为 200 ms
     *   （比并发下观测值再留 4 倍余量）：真正的"数量级回退"由上面两条**与负载无关**的守卫抓
     *   （读取计数：确定性；耗时比：中位数比值 ≤ 3）。
     */
    expect(t).toBeLessThan(200)
  })

  it('★ S1：静态地形成本表按 MapFacts 身份记忆（第二次零地形选择）', () => {
    /*
     * 病灶（S1 前）：成本表挂在**补给事实**上 ⇒ 盘面一变（facts 重建）整张丢掉，
     * 每次重算覆盖集都要重跑数千次地形选择（`crossingBetween` + `terrainsAt` +
     * `selectMovementTerrain`）。成本只依赖 MapFacts + 机动 ⇒ 按 MapFacts 身份记忆。
     *
     * 测法边界（如实）：数的是"`MapFacts` 查询次数"（确定性、与机器无关），不测绝对耗时；
     * 语义正确性由下一条"与 TEC 模型逐格一致"兜底。
     */
    const base = createMapFacts()
    const counts = { terrains: 0, crossing: 0 }
    const counting = (): MapFacts => ({
      onMap: base.onMap,
      terrainsAt: (hex) => {
        counts.terrains += 1
        return base.terrainsAt(hex)
      },
      crossingBetween: (a, b) => {
        counts.crossing += 1
        return base.crossingBetween(a, b)
      },
    })
    const map = counting()
    const to = neighbor(CORE_HEX, HEX_DIRECTIONS[0]!)
    const first = supplyStepCost(map, CORE_HEX, to, 'truck')
    expect({ ...counts }).toEqual({ terrains: 1, crossing: 1 })
    // 同一 MapFacts / 同一方向 / 同一机动：完全命中，不再碰地图
    expect(supplyStepCost(map, CORE_HEX, to, 'truck')).toBe(first)
    expect({ ...counts }).toEqual({ terrains: 1, crossing: 1 })
    // 机动类型是键的一部分（12.3a：轮式/步行/履带成本不同）
    supplyStepCost(map, CORE_HEX, to, 'leg')
    expect({ ...counts }).toEqual({ terrains: 2, crossing: 2 })
    // 新的 MapFacts（自定义源）：不复用，也不得读到陈旧值
    const other = counting()
    supplyStepCost(other, CORE_HEX, to, 'truck')
    expect({ ...counts }).toEqual({ terrains: 3, crossing: 3 })
    // `null`（不可通行）也必须算作"已缓存"：否则每次都要重算
    const blocked: HexRef = { col: 1, row: 0 }
    expect(supplyStepCost(map, CORE_HEX, blocked, 'truck')).toBeNull()
    const afterNull = { ...counts }
    supplyStepCost(map, CORE_HEX, blocked, 'truck')
    expect({ ...counts }).toEqual(afterNull)
  })

  it('★ S1：记忆后的成本与 TEC 模型逐格一致（两个 MapFacts × 三种机动）', () => {
    /*
     * 模型＝条文口径本身（`selectMovementTerrain`：6.2d 取最贵、6.2a 沿路忽略地形、6.2b 边费）：
     * 本用例只经由 `MapFacts` 的两个查询独立算一遍，再与**带记忆**的 `supplyStepCost` 对照，
     * 覆盖"同一 MapFacts 被多次建事实共享"这条新路径（第二次走的是缓存值）。
     */
    const mapA = createMapFacts()
    // 空地图：任何方向都没有地形/格边 ⇒ 必须全部不可通行（反空转的另一半）
    const mapB = createMapFacts({ hexes: [], edges: [] })
    const model = (map: MapFacts, from: HexRef, to: HexRef, mobility: SupplyMobility) => {
      const crossing = map.crossingBetween(from, to)
      const result = selectMovementTerrain({
        terrainsPresent: map.terrainsAt(to),
        mobility,
        crossing,
        followingRoad: (crossing?.routes ?? []).length > 0,
      })
      return result.ok ? result.totalMp : null
    }
    let checked = 0
    let passable = 0
    for (let col = 2; col <= 58; col += 6) {
      for (let row = 1; row <= 32; row += 5) {
        const from: HexRef = { col, row }
        for (const direction of HEX_DIRECTIONS) {
          const to = neighbor(from, direction)
          if (!isOnMap(to)) continue
          for (const mobility of ['truck', 'leg', 'track'] as SupplyMobility[]) {
            const got = supplyStepCost(mapA, from, to, mobility)
            expect(got).toBe(model(mapA, from, to, mobility))
            expect(supplyStepCost(mapA, from, to, mobility)).toBe(got)
            expect(supplyStepCost(mapB, from, to, mobility)).toBeNull()
            checked += 1
            if (got !== null) passable += 1
          }
        }
      }
    }
    // 反空转：抽样必须真的铺开，且必须既有可通行也有不可通行
    expect(checked).toBeGreaterThan(300)
    expect(passable).toBeGreaterThan(50)
  })

  it('★ 索引与原判据逐格一致（模型对照：全图每一格 × 两方）', () => {
    /*
     * H③ 把两个判据从"每次扫全表"改成"建一次索引" —— 本用例按**条文模型**独立算一遍期望值
     * （12.3d 敌方战斗单位阻断 × 4.5 ZOC 六邻投射 × 4.5b 格内己方战斗单位抵消），
     * 与 facts 的索引结论逐格对照。模型只读盘面事实、不读索引，故能抓住索引漏格/多格/键口径错。
     */
    const placed: TraceSupplyUnitView[] = []
    for (let i = 0; i < 60; i += 1) {
      const ref = { col: (i % 24) + 1, row: ((i * 7) % 30) + 1 }
      if (!isOnMap(ref)) continue
      placed.push({
        id: `m${i}`,
        side: (i % 3 === 0 ? 'soviet' : 'axis') as Side,
        hex: ref,
        isCombat: true,
        // 每 4 枚里 1 枚不投射 ZOC（可攻击 ∧ 战斗模式 ∧ 非断补 缺一）
        attackCapable: i % 4 !== 1,
        inCombatMode: i % 5 !== 2,
        hasTraceSupply: i % 7 !== 3,
      })
    }
    const facts = createTraceSupplyFacts({ units: placed })
    const projecting = placed.filter((unit) =>
      projectsZoc({
        hex: unit.hex!,
        side: unit.side,
        attackCapable: unit.attackCapable ?? false,
        inCombatMode: unit.inCombatMode ?? false,
        hasTraceSupply: unit.hasTraceSupply ?? true,
      }),
    )
    const combatAt = (hex: HexRef, side: Side): boolean =>
      placed.some((unit) => unit.isCombat && unit.side === side && sameHex(unit.hex!, hex))
    const projectAdjacent = (hex: HexRef, side: Side): boolean =>
      projecting.some((unit) => unit.side === side && areAdjacent(unit.hex!, hex))

    let checked = 0
    let zocTrue = 0
    let enemyTrue = 0
    for (let c = 1; c <= 40; c += 1) {
      for (let r = 1; r <= 40; r += 1) {
        const hex = { col: c, row: r }
        if (!isOnMap(hex)) continue
        checked += 1
        for (const side of ['axis', 'soviet'] as Side[]) {
          const enemy: Side = side === 'axis' ? 'soviet' : 'axis'
          expect(facts.hasEnemyCombatUnit(hex, side)).toBe(combatAt(hex, enemy))
          expect(facts.inEnemyZoc(hex, side)).toBe(
            !combatAt(hex, side) && projectAdjacent(hex, enemy),
          )
          if (combatAt(hex, enemy)) enemyTrue += 1
          if (facts.inEnemyZoc(hex, side)) zocTrue += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
    // ★ 反空转：两组判据都必须**真的**命中过（否则"全 false 对全 false"也能骗过上面两条断言）
    expect(zocTrue).toBeGreaterThan(100)
    expect(enemyTrue).toBeGreaterThan(20)
  })

  it('★ 大洪泛（整片可达区）与独立模型逐格一致', () => {
    /*
     * 不设 `stopAt` 时（C8 的投递/拖取整片可视化、`supplyReachableHexes`）洪泛上千格 ——
     * 这正是 H③ 把"取最小"换成堆的那条路径。本用例用**测试内的独立 Dijkstra**（只读
     * `facts.stepCost` 与模型判据）算一遍期望可达集，与引擎结论逐格对照。
     *
     * 测法边界（如实）：这里**不测耗时**。曾经写过一条"40 MP 洪泛中位耗时 < 25 ms"的守卫，
     * 单跑 13.6 ms、整仓门禁并发下 35.9 ms ⇒ 时间阈值随机器负载失真（洪泛分配重、被 GC 挤得更狠），
     * 已删。堆的**性能**收益只在回执里给了单跑实测（40 MP / 1374 格：线性 38.7 → 堆 13.6 ms），
     * 本文件只守它的**正确性**（同一洪泛、同一结论）与索引的**成本口径**（前四条）。
     */
    const units: TraceSupplyUnitView[] = []
    for (let i = 0; i < 150; i += 1) {
      // 全塞在右下角：既保留"全表规模"，又不让任何 ZOC 落到起点附近（起点被 ZOC 封死则洪泛＝1 格）
      const ref = { col: (i % 10) + 30, row: ((i * 7) % 10) + 20 }
      if (!isOnMap(ref)) continue
      units.push({
        id: `flood${i}`,
        side: (i % 3 === 0 ? 'soviet' : 'axis') as Side,
        hex: ref,
        isCombat: true,
        attackCapable: true,
        inCombatMode: true,
        hasTraceSupply: true,
      })
    }
    const facts = createTraceSupplyFacts({ units })
    const budget = 60
    const got = supplyReachableHexes(facts, {
      from: CORE_HEX,
      side: 'axis',
      mobility: 'truck',
      maxMp: budget,
    })
    // 反空转：洪泛必须真的铺开（否则"逐格一致"退化成"两边都空"）
    expect(got.length).toBeGreaterThan(500)

    // 期望值：测试内的独立 Dijkstra（边缘遍历 + 线性取最小，规模只有上千格，慢一点无所谓）
    const best = new Map<string, number>([[`${CORE_HEX.col}.${CORE_HEX.row}`, 0]])
    const done = new Set<string>()
    for (;;) {
      let key: string | null = null
      let mp = Number.POSITIVE_INFINITY
      for (const [candidate, value] of best) {
        if (done.has(candidate)) continue
        if (value < mp) {
          mp = value
          key = candidate
        }
      }
      if (key === null || mp > budget) break
      done.add(key)
      const [col, row] = key.split('.').map(Number)
      const here: HexRef = { col: col!, row: row! }
      for (const direction of HEX_DIRECTIONS) {
        const next = neighbor(here, direction)
        if (!facts.onMap(next)) continue
        if (facts.hasEnemyCombatUnit(next, 'axis')) continue
        if (facts.inEnemyZoc(next, 'axis') || facts.inEnemyZoc(here, 'axis')) continue
        const step = facts.stepCost(here, next, 'truck')
        if (step === null) continue
        const candidate = mp + step
        if (candidate > budget) continue
        const nextKey = `${next.col}.${next.row}`
        const existing = best.get(nextKey)
        if (existing === undefined || candidate < existing) best.set(nextKey, candidate)
      }
    }
    const expected = new Set(
      [...best.entries()].filter(([, mp]) => mp <= budget).map(([key]) => key),
    )
    expect(new Set(got.map((item) => `${item.hex.col}.${item.hex.row}`))).toEqual(expected)
  })
})
