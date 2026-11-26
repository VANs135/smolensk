import { describe, expect, it } from 'vitest'

import { mapLayers, rulesConstants, scenarios } from '@/data'
import { parseConvertedRailRun, unitChoices } from '@/stores'
import { combatRecord, groundRecord, label, newConsole, placeGround } from '../flows/sop-harness'

/**
 * 专规 1.2 / 通规 13.3f：**轨距账本**（谁能用这条铁路）
 *
 * 条文：「铁路线始终处于两种轨距之一，宽轨或标准轨。**最初除剧本初设另有注明者外，全部为宽轨**。
 * 就铁路运货**与获得追溯补给**而言：苏方**只能**使用宽轨铁路，轴方**只能**使用标准铁轨。」
 * ⇒ 印刷图全是宽轨，轴方要能用铁路必须先换轨；换轨状态是运行期账本（剧本初设 + 13.3f 转换）。
 *
 * ★ 与 13.3a「多轨减半」的**地形**口径严格分开：那条管**运量费用**，本条只管**谁能用**。
 */
describe('专规 1.2 轨距账本（13.3f）', () => {
  const villageRailHexes = (() => {
    const rail = new Set<string>()
    for (const edge of mapLayers.edges) {
      if (edge.rail !== true) continue
      rail.add(`${edge.a.col}.${edge.a.row}`)
      rail.add(`${edge.b.col}.${edge.b.row}`)
    }
    return mapLayers.hexes
      .filter(
        (hex) =>
          rail.has(`${hex.col}.${hex.row}`) &&
          hex.terrainsPresent.some((name) => name === 'Village' || name.includes('City')),
      )
      .map((hex) => ({ col: hex.col, row: hex.row }))
  })()

  it('常量口径：印刷宽轨、苏方宽轨、轴方标准轨（两侧必须不同，否则等于没有轨距限制）', () => {
    const store = newConsole()
    expect(store.printedRailGauge).toBe('broad')
    expect(rulesConstants.smolensk.railGauge.usableBySide.soviet).toBe('broad')
    expect(rulesConstants.smolensk.railGauge.usableBySide.axis).toBe('standard')
    // 换轨目标＝非印刷轨距的那一种
    expect(store.convertedRailGauge).toBe('standard')
  })

  it('开局按当前剧本（缺省剧本 1）的初设换轨落账：01.03→02.02 两格', () => {
    const store = newConsole()
    expect(scenarios.scenarios[0]?.id).toBe('1')
    expect([...store.convertedRailHexes].sort()).toEqual(['1.3', '2.2'])
    // 这两格已转为标准轨 ⇒ 轴方可用、苏方不可用
    expect(store.railGaugeAt({ col: 2, row: 2 })).toBe('standard')
    expect(store.isRailGaugeUsableAt({ col: 2, row: 2 }, 'axis')).toBe(true)
    expect(store.isRailGaugeUsableAt({ col: 2, row: 2 }, 'soviet')).toBe(false)
    // 未换轨的格仍是宽轨 ⇒ 结论相反
    const unconverted = villageRailHexes.find(
      (hex) => !store.convertedRailHexes.includes(label(hex)),
    )
    expect(unconverted).toBeDefined()
    expect(store.railGaugeAt(unconverted!)).toBe('broad')
    expect(store.isRailGaugeUsableAt(unconverted!, 'axis')).toBe(false)
    expect(store.isRailGaugeUsableAt(unconverted!, 'soviet')).toBe(true)
  })

  it('切剧本即按该剧本重取初设换轨（剧本 7 共 4 段、远超剧本 1）', () => {
    const store = newConsole()
    const before = store.convertedRailHexes.length
    store.setScenarioId('7')
    expect(store.convertedRailHexes.length).toBeGreaterThan(before)
    // 剧本 7 的第四段是北向支线 15.10 → 18.18（端点 18.18 驻 RR Bn）
    expect(store.convertedRailHexes).toContain('18.18')
    expect(store.convertedRailHexes).toContain('15.10')
    // 1.19→34.18 那一段 34 格：34.18 也在账本里
    expect(store.convertedRailHexes).toContain('34.18')
  })

  it('清空账本 ⇒ 铁路恢复印刷宽轨（轴方随之一格都不可用）', () => {
    const store = newConsole()
    expect(store.isRailGaugeUsableAt({ col: 2, row: 2 }, 'axis')).toBe(true)
    store.clearConvertedRailsNow()
    expect(store.convertedRailHexes).toEqual([])
    expect(store.railGaugeAt({ col: 2, row: 2 })).toBe('broad')
    expect(store.isRailGaugeUsableAt({ col: 2, row: 2 }, 'axis')).toBe(false)
  })

  it('重复按剧本初设换轨幂等（不会越滚越多）', () => {
    const store = newConsole()
    const first = [...store.convertedRailHexes].sort()
    expect(store.seedConvertedRailsNow()).toBe(true)
    expect([...store.convertedRailHexes].sort()).toEqual(first)
    expect(store.seedConvertedRailsNow()).toBe(true)
    expect([...store.convertedRailHexes].sort()).toEqual(first)
  })
})

/**
 * 13.3f 的轨距门真的接进了**铁路补给线**（专规 1.2 的「与获得追溯补给」那一半）
 *
 * 只把账本记对不算接线：`railSupplyPath` 必须据此在新旧轨距之间给出相反结论。
 */
describe('专规 1.2：轨距门接进铁路补给线（13.3c / 12.6a②）', () => {
  it('轴方：未换轨的铁路全不可用 ⇒ 铁路可达集合为空（不会白拿苏方宽轨网）', () => {
    const store = newConsole()
    store.clearConvertedRailsNow()
    store.setSupplyActive(true)
    // 声明一个 12.6a① 补给源（边缘铁路格），该格是宽轨 ⇒ 轴方不可用
    const railHex = (() => {
      for (const edge of mapLayers.edges) {
        if (edge.rail !== true) continue
        return edge.a
      }
      throw new Error('地图上没有铁路格边')
    })()
    store.supplySourceDraft = { hexText: label(railHex), kind: 'edgeRail' }
    expect(store.addSupplySource()).toBe(true)
    expect(store.railSupply.railReachableHexes).toEqual([])
    expect(store.railSupply.detrainableHexes).toEqual([])
  })

  it('苏方：同一条铁路立刻可用（同一张图、同一段轨，结论按方相反）', () => {
    const store = newConsole()
    store.clearConvertedRailsNow()
    store.setSupplyActive(true)
    // 12.6a① 的补给源按**声明时**的当前方落账 ⇒ 先切到苏方再声明（否则苏方没有源）
    store.setActiveSide('soviet')
    const railHex = (() => {
      for (const edge of mapLayers.edges) {
        if (edge.rail !== true) continue
        return edge.a
      }
      throw new Error('地图上没有铁路格边')
    })()
    store.supplySourceDraft = { hexText: label(railHex), kind: 'edgeRail' }
    expect(store.addSupplySource()).toBe(true)
    // 宽轨对苏方可用 ⇒ 沿铁路扩散（与上面轴方的「空集」形成对照）
    expect(store.railSupply.railReachableHexes.length).toBeGreaterThan(0)
  })
})

/**
 * 13.3f／13.3g 轨距转换动作
 *
 * ★ 2026-09-15：三支铁路修理单位（苏 West RR Rgt、德 I-2 / II-2 RR Bn）已入库并推进到 `valued`，
 *   原先「单位库里没有任何 `rail_repair` 算子 ⇒ 13.3g 的通过路径不可达」的数据缺口**已闭合**；
 *   本组自此兼作**缺口闭合的回归锚点**（通过路径的完整行为见 `rail-repair-flow.test.ts`）。
 */
describe('13.3f / 13.3g 轨距转换动作', () => {
  it('普通战斗单位不能转换轨距（13.3g：只有铁路修理单位可以）', () => {
    const store = newConsole()
    const unit = placeGround(store, combatRecord('axis'), { col: 36, row: 13 }, 'axis', 'u1')
    expect(store.isRailRepairUnit(unit.instanceId)).toBe(false)
    expect(store.convertRailGaugeNow('u1', '36.13')).toBe(false)
  })

  it('单位库里已有 `rail_repair` 算子：苏 1 支、轴 2 支（13.3g 的载体，2026-09-15 入库）', () => {
    const rr = (side: 'axis' | 'soviet') =>
      unitChoices(side).filter((record) => (record.specialized ?? []).includes('rail_repair'))
    expect(
      rr('axis')
        .map((record) => record.vassalName)
        .sort(),
    ).toEqual(['Ge I-2 RR Bn', 'Ge II-2 RR Bn'])
    expect(rr('soviet').map((record) => record.vassalName)).toEqual(['West RR Rgt'])
    // 它们是**战斗单位**（可做 4.5b 抵消），但不可发起攻击（印值带括号，11.0）
    for (const record of [...rr('axis'), ...rr('soviet')]) {
      expect(record.isCombat).toBe(true)
      expect(record.attackCapable).toBe(false)
    }
  })

  it('目标格不是「列.行」⇒ 拒绝且不写账本', () => {
    const store = newConsole()
    placeGround(store, combatRecord('axis'), { col: 36, row: 13 }, 'axis', 'u1')
    const before = [...store.convertedRailHexes]
    expect(store.convertRailGaugeNow('u1', '不是坐标')).toBe(false)
    expect(store.convertedRailHexes).toEqual(before)
  })

  it('找不到单位实例 ⇒ 拒绝', () => {
    const store = newConsole()
    const before = [...store.convertedRailHexes]
    expect(store.convertRailGaugeNow('不存在', '36.13')).toBe(false)
    expect(store.convertedRailHexes).toEqual(before)
  })
})

/**
 * 13.3g-D 的「每移动阶段 ≤ min(4, MA) 格」账本：换阶段即清零
 */
describe('13.3g-D：换轨计数的阶段账本', () => {
  it('换阶段清零（13.3g-D 的额度是「每移动阶段」）', () => {
    const store = newConsole()
    store.gaugeConversionsThisPhase = [{ instanceId: 'u1', count: 3 }]
    store.setPhase('combat')
    expect(store.gaugeConversionsThisPhase).toEqual([])
  })

  it('选中的铁路修理单位在移动阶段 ⇒ 左下角提示换轨额度 n/min(4,MA)', () => {
    const store = newConsole()
    store.setPhase('movement')
    const record = groundRecord('axis', (item) => (item.specialized ?? []).includes('rail_repair'))
    const unit = placeGround(store, record, { col: 2, row: 2 }, 'axis', 'rr-quota')
    store.selectedId = unit.instanceId

    expect(store.mapHint).toEqual({ text: '换轨额度 0/4 格', rule: '13.3g', tone: 'info' })
    store.gaugeConversionsThisPhase = [{ instanceId: unit.instanceId, count: 2 }]
    expect(store.mapHint?.text).toBe('换轨额度 2/4 格')
    store.gaugeConversionsThisPhase = [{ instanceId: unit.instanceId, count: 4 }]
    expect(store.mapHint).toEqual({
      text: '换轨额度 4/4 格',
      rule: '13.3g',
      tone: 'warning',
    })

    // 换成普通战斗单位 / 离开移动阶段 ⇒ 额度提示让位，不占左下角
    store.selectedId = null
    expect(store.mapHint).toBeNull()
    store.selectedId = unit.instanceId
    store.setPhase('combat')
    expect(store.mapHint).toBeNull()
  })
})

/** 摆一个「有铁路 + 村庄/城市」的格（供上面的补给线用例引用，避免删了没人发现） */
describe('轨距账本与装卸格判定的交叉检查', () => {
  it('地图上确实存在既非铁路格、又不可被误判为卸货格的村庄格（13.3c 的前置条件不是摆设）', () => {
    const rail = new Set<string>()
    for (const edge of mapLayers.edges) {
      if (edge.rail !== true) continue
      rail.add(`${edge.a.col}.${edge.a.row}`)
      rail.add(`${edge.b.col}.${edge.b.row}`)
    }
    const villageNotRail = mapLayers.hexes.filter(
      (hex) =>
        !rail.has(`${hex.col}.${hex.row}`) &&
        hex.terrainsPresent.some((name) => name === 'Village' || name.includes('City')),
    )
    expect(villageNotRail.length).toBeGreaterThan(0)
    // 这些格在任何轨距下都不该成为卸货格（13.3c 第一条：须先是铁路格）
    const store = newConsole()
    store.setSupplyActive(true)
    for (const hex of villageNotRail.slice(0, 5)) {
      store.supplySourceDraft = { hexText: label(hex), kind: 'edgeRail' }
      store.addSupplySource()
    }
    const detrainable = new Set(store.railSupply.detrainableHexes.map(label))
    for (const hex of villageNotRail.slice(0, 5)) expect(detrainable.has(label(hex))).toBe(false)
  })

  it('卸货格（若有）都在账本允许的轨距上（当前方视角自洽）', () => {
    const store = newConsole()
    // 用苏方视角：宽轨全可用 ⇒ 卸货格必为宽轨格（即不在换轨账本里）
    store.setActiveSide('soviet')
    store.setSupplyActive(true)
    for (const hex of villageRailLikeHexes()) {
      store.supplySourceDraft = { hexText: label(hex), kind: 'edgeRail' }
      store.addSupplySource()
    }
    for (const hex of store.railSupply.detrainableHexes)
      expect(store.convertedRailHexes).not.toContain(label(hex))
  })

  function villageRailLikeHexes() {
    const rail = new Set<string>()
    for (const edge of mapLayers.edges) {
      if (edge.rail !== true) continue
      rail.add(`${edge.a.col}.${edge.a.row}`)
      rail.add(`${edge.b.col}.${edge.b.row}`)
    }
    return mapLayers.hexes
      .filter(
        (hex) =>
          rail.has(`${hex.col}.${hex.row}`) &&
          hex.terrainsPresent.some((name) => name === 'Village' || name.includes('City')),
      )
      .map((hex) => ({ col: hex.col, row: hex.row }))
  }

  it('摆一个战斗单位不影响轨距判定（轨距是地图账本，与此格有无单位无关）', () => {
    const store = newConsole()
    const unit = placeGround(store, combatRecord('axis'), { col: 2, row: 2 }, 'axis', 'u1')
    expect(store.railGaugeAt(unit.hex)).toBe('standard')
  })
})

/**
 * 5-X2：剧本 7 的 4 段轴心换轨与端头格（专规 1.2 / 13.3d）
 *
 * 剧本页原文（逐字）：
 *   Converted Axis Rails:
 *    01.03 to 2.02
 *    01.19 to 34.18
 *    01.07 to 38.05
 *    15.10 to 18.18
 *
 * - 段内＝**标准轨**（轴方可用、苏方不可用）；段外沿用专规 1.2 的默认宽轨；
 * - 端头＝各段 **B 端（东端终点）**，用 `mk-38`（`Neutral_Railhead.png`，side=neutral）标记；
 *   A 端与段内非端头格**不得**有标记；
 * - `2.02` 按 `02.02` 处理（列 2 行 2），与数据里的 `2.02` 同解。
 */
describe('5-X2：剧本 7 轴心换轨 4 段与端头格（专规 1.2 / 13.3d）', () => {
  /** 每段取 3 个段内格（含 B 端，另有中段格）与 1 个 B 端 */
  const SEGMENTS = [
    {
      declaration: '01.03 to 2.02',
      inside: [
        { col: 1, row: 3 },
        { col: 2, row: 2 },
      ],
      head: { col: 2, row: 2 },
    },
    {
      declaration: '01.19 to 34.18',
      inside: [
        { col: 10, row: 17 },
        { col: 20, row: 19 },
        { col: 34, row: 18 },
      ],
      head: { col: 34, row: 18 },
    },
    {
      declaration: '01.07 to 38.05',
      inside: [
        { col: 15, row: 10 },
        { col: 27, row: 5 },
        { col: 38, row: 5 },
      ],
      head: { col: 38, row: 5 },
    },
    {
      declaration: '15.10 to 18.18',
      inside: [
        { col: 15, row: 13 },
        { col: 17, row: 16 },
        { col: 18, row: 18 },
      ],
      head: { col: 18, row: 18 },
    },
  ] as const

  it('段内判标准轨（轴方可走、苏方不可走），段外仍是印刷宽轨', () => {
    const store = newConsole()
    store.setScenarioId('7')
    for (const segment of SEGMENTS) {
      for (const hex of segment.inside) {
        expect(store.railGaugeAt(hex), `${segment.declaration} 段内 ${label(hex)}`).toBe('standard')
        expect(store.isRailGaugeUsableAt(hex, 'axis')).toBe(true)
        expect(store.isRailGaugeUsableAt(hex, 'soviet')).toBe(false)
      }
    }

    // 段外：全图任意一条铁路边上、不在换轨账本里的格仍是宽轨（苏方可走、轴方不可走）
    const converted = new Set(store.convertedRailHexes)
    const outside = (() => {
      for (const edge of mapLayers.edges) {
        if (edge.rail !== true) continue
        for (const hex of [edge.a, edge.b]) if (!converted.has(label(hex))) return hex
      }
      throw new Error('地图上没有段外铁路格')
    })()
    expect(store.railGaugeAt(outside)).toBe('broad')
    expect(store.isRailGaugeUsableAt(outside, 'axis')).toBe(false)
    expect(store.isRailGaugeUsableAt(outside, 'soviet')).toBe(true)
  })

  it('端头由换轨账本推导：换轨到头的 B 端各有 mk-38，A 端与已换轨的并入点不出', () => {
    const store = newConsole()
    store.setScenarioId('7')
    const markers = store.railheadMarkers
    for (const marker of markers) {
      expect(marker.recordId).toBe('mk-38')
      // 标记方别取 markers.json 的 neutral（不归属任何一方）
      expect(marker.side).toBe('neutral')
    }
    const headKeys = new Set(
      markers.filter((marker) => marker.hex !== null).map((marker) => label(marker.hex!)),
    )
    // 换轨到头的四个 B 端（2.2 / 34.18 / 38.5 / 18.18）各有端头；其余格都没有
    const derivedHeads = new Set(['2.2', '34.18', '38.5', '18.18'])
    expect([...headKeys].sort()).toEqual([...derivedHeads].sort())
    expect(markers).toHaveLength(derivedHeads.size)

    /*
     * ★ 18.18（Orsha）在列：剧本页把它印成「15.10 to 18.18」这条北向支线的 B 端
     *   （`setup.railheads` 第 4 项，两营 RR Bn 驻此），往北 18.19 仍是宽轨。
     *   它虽有 17.19 / 18.17 / 19.19 三个已换轨邻格（逐格法会当交汇点跳过），
     *   但按段端法「段内最长已换轨前缀的末端」它仍是该段前沿 ⇒ 必须有 mk-38
     *   （2026-11-22 修正；见《端头一致性实测-2026-11-22.md》）。
     */
    expect(headKeys.has('18.18')).toBe(true)
    for (const segment of SEGMENTS) {
      const from = parseConvertedRailRun(segment.declaration)!.from
      expect(headKeys.has(label(from)), `${segment.declaration} 的 A 端不该有端头标记`).toBe(false)
      for (const hex of segment.inside) {
        const key = label(hex)
        if (derivedHeads.has(key)) continue
        expect(headKeys.has(key), `${key} 不该有端头标记`).toBe(false)
      }
    }
    for (const key of derivedHeads) expect(headKeys.has(key)).toBe(true)
  })

  it('2.02 按 02.02 处理（同一格的两种写法，都解成列 2 行 2）', () => {
    expect(parseConvertedRailRun('01.03 to 2.02')).toEqual(parseConvertedRailRun('01.03 to 02.02'))
  })
})

/**
 * 13.3f：端头标记**随该单位换轨实时增减**
 *
 * 原文只说「Players keep track of the current extent of each rail gauge using Railhead markers」，
 * 本条不新增规则，只钉住既有推导链路的**时序**：`railheadMarkers` 由换轨账本 computed 派生，
 * 换轨动作一提交就变，不等阶段末、不靠刷新。两条方向都要成立：
 *   · 轴方换进一格（入账）⇒ 新端头**当场**出现、旧端头当场消失；
 *   · 苏方把该格换回宽轨（出账）⇒ 端头**当场**退回。
 */
describe('13.3f：换轨当即更新端头（不等阶段末 / 不靠刷新）', () => {
  const headKeys = (store: ReturnType<typeof newConsole>): string[] =>
    store.railheadMarkers
      .filter((marker) => marker.hex !== null)
      .map((marker) => label(marker.hex!))
      .sort()

  /** 铁路修理单位（真实单位库记录）；换轨须战斗面（13.3g-D） */
  function rrUnit(
    store: ReturnType<typeof newConsole>,
    side: 'axis' | 'soviet',
    hex: { col: number; row: number },
    instanceId: string,
  ) {
    const record = groundRecord(side, (item) => (item.specialized ?? []).includes('rail_repair'))
    const unit = placeGround(store, record, hex, side, instanceId, 'combat')
    unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    unit.raw = unit.faces.combat
    unit.mpSpent = 0
    unit.movementEnded = false
    return unit
  }

  /** 13.3f-B：换轨必须是“移动进入”的副产品 ⇒ 先真的走一格 */
  function walkInto(
    store: ReturnType<typeof newConsole>,
    unitId: string,
    from: { col: number; row: number },
    to: { col: number; row: number },
  ): void {
    if (store.moveInteraction?.unitIds.includes(unitId) !== true) {
      store.clickHex(from)
      if (store.movePickHex !== null) {
        store.setMovePickOnly(unitId)
        expect(store.confirmMovePick()).toBe(true)
      }
    }
    store.clickHex(to)
    expect(store.units.find((unit) => unit.instanceId === unitId)?.hex).toEqual(to)
  }

  it('★ 转换即增：轴方换进 3.2，端头当场由 2.2 移到 3.2', () => {
    const store = newConsole()
    store.setPhase('movement')
    store.setTurn(5)
    // 剧本 1 初设换轨 01.03→02.02 ⇒ 端头原在 2.2
    expect(headKeys(store)).toEqual(['2.2'])

    const rr = rrUnit(store, 'axis', { col: 2, row: 2 }, 'ax-rr-1')
    walkInto(store, rr.instanceId, { col: 2, row: 2 }, { col: 3, row: 2 })
    expect(store.convertRailGaugeNow(rr.instanceId, '3.2')).toBe(true)

    // 不换阶段、不做任何刷新：账本与端头同时到位
    expect(store.convertedRailHexes).toContain('3.2')
    expect(headKeys(store)).toEqual(['3.2'])
  })

  it('★ 撤销即减：苏方把 2.2 换回宽轨，端头当场退回 1.3', () => {
    const store = newConsole()
    store.setPhase('movement')
    store.setTurn(5)
    store.switchSide()
    expect(headKeys(store)).toEqual(['2.2'])

    const rr = rrUnit(store, 'soviet', { col: 1, row: 3 }, 'su-rr-1')
    walkInto(store, rr.instanceId, { col: 1, row: 3 }, { col: 2, row: 2 })
    expect(store.convertRailGaugeNow(rr.instanceId, '2.2')).toBe(true)

    // 出账 ⇒ 原端头格的标记消失；换轨范围缩回 1.3，端头随之回到 1.3
    expect(store.convertedRailHexes).not.toContain('2.2')
    expect(headKeys(store)).toEqual(['1.3'])
  })
})
