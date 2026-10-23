import { describe, expect, it } from 'vitest'

import { arrivalsAxis, arrivalsSoviet, rulesConstants } from '@/data'
import type { HexRef } from '@/data'
import { arrivalTurnOf, turnDates } from '@/engine/turn-driver'
import {
  arrivalDateIso,
  claimFrontalReserves,
  frontalReservesBatch,
  normalizeArrivalDate,
  parseArrivalPlacement,
  planArrivals,
  planSlowMobilization,
  resolveArrivalPlacement,
  shutdownsFor,
  slowMobilizationUnlocks,
  specialReplBoxView,
  type ArrivalPlacementFacts,
} from '@/engine/rules'
import { isSpecialReplAvailable } from '@/engine/rules/timing'

/**
 * 到达表执行（13.6 / 13.6b / 1.6a / 专规 2.1 / 2.1a / 2.3c / 2.4）
 *
 * 全部用**真实到达卡数据**（arrivals-*.json，已冻结）与注入的地图事实，逐条对到规则章节。
 */

const hex = (col: number, row: number): HexRef => ({ col, row })

/** 最小落点事实：入口 K = 6.01，被阻挡；最近的开放边缘格 = 1.01；62.16 与 60.35 为边缘源 */
function facts(overrides: Partial<ArrivalPlacementFacts> = {}): ArrivalPlacementFacts {
  return {
    entryHexes: (letter) => (letter === 'K' ? [hex(6, 1)] : []),
    isBlocked: (target) => target.col === 6,
    nearestOpenEdgeHex: () => hex(1, 1),
    friendlyAirBaseHexes: () => [hex(36, 13)],
    directDrawHqHexes: () => [hex(36, 14)],
    edgeSupplySourceHexes: () => [hex(1, 3), hex(60, 35), hex(62, 16)],
    westEdgeHexes: () => [hex(1, 3)],
    // 行号增大＝向北 ⇒ 北缘取 row 35
    isNorthEdge: (target) => target.row >= 35,
    ...overrides,
  }
}

describe('13.6 / 1.6a：到达卡的日期规范化与解析', () => {
  it('13.6：卡面日期写法不统一，须先规范化再比对（`8 July` / `12 Jul 41` / `1 Sep 41`）', () => {
    expect(normalizeArrivalDate('8 July')).toEqual({ month: 7, day: 8 })
    expect(normalizeArrivalDate('12 Jul 41')).toEqual({ month: 7, day: 12 })
    expect(normalizeArrivalDate('1 Sep 41')).toEqual({ month: 9, day: 1 })
    expect(normalizeArrivalDate('19 August')).toEqual({ month: 8, day: 19 })
    expect(normalizeArrivalDate('not a date')).toBeNull()
  })

  it('13.6：双方到达卡的所有日期块都能规范化（无漏读）', () => {
    for (const data of [arrivalsAxis, arrivalsSoviet]) {
      for (const block of data.blocks) {
        expect(normalizeArrivalDate(block.date)).not.toBeNull()
      }
    }
  })

  it('13.6：分栏标签 → 落点类别（入口字母 / 地理参照 / Any Airbase / 北缘以东 / 西缘）', () => {
    expect(parseArrivalPlacement('Entry K')).toMatchObject({ kind: 'entryHex', letters: ['K'] })
    expect(parseArrivalPlacement('Entry I or J')).toMatchObject({ kind: 'entryHex' })
    expect(parseArrivalPlacement('B or C')).toMatchObject({ kind: 'entryHex', letters: ['B', 'C'] })
    expect(parseArrivalPlacement('w/i 3 of 60.34')).toMatchObject({
      kind: 'geographic',
      anchor: { col: 60, row: 34 },
      radiusHexes: 3,
    })
    expect(parseArrivalPlacement('Any Airbase')).toMatchObject({ kind: 'anyAirbase' })
    expect(parseArrivalPlacement('North Edge, east of 32.xx')).toMatchObject({
      kind: 'northEdgeEastOf',
      col: 32,
    })
    expect(parseArrivalPlacement('Any west edge hexes')).toMatchObject({ kind: 'anyWestEdge' })
    expect(parseArrivalPlacement('??')).toBeNull()
  })
})

describe('13.6 / 13.6c / 专规 2.1a：一日的到达计划', () => {
  it('13.6：轴方 1941-07-12 的到达卡被解析成投放需求（含 -1 step 与满载运输点）', () => {
    const outcome = planArrivals({ side: 'axis', date: '1941-07-12' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const plan = outcome.data
    expect(plan.units.length).toBeGreaterThan(0)
    // 3.1：Entry K 的 5th Corps HQ 与两个 -1 step 的步兵师
    const division = plan.units.find((unit) => unit.name === '5 Inf Div')
    expect(division).toMatchObject({
      kind: 'unit',
      designation: '5',
      parentType: 'Inf Div',
      factors: '20-4-3',
      stepsLost: 1,
    })
    expect(division?.placement).toMatchObject({ kind: 'entryHex' })
    // 13.6c：运输点满载 SP 入场
    const truck = plan.units.find((unit) => /Truck Points/.test(unit.raw))
    expect(truck).toMatchObject({ kind: 'transportPoint', loadedWithSp: true, count: 3 })
    // 当日的强制移除（1.6a）
    expect(plan.removals.map((item) => item.raw)).toContain('Ju.87b')
    expect(plan.removals[0]?.rule).toBe('1.6a')
  })

  it('13.6：苏方 1941-07-12 的 Any Airbase 条目被识别为飞机（落点＝任一友方空军基地）', () => {
    const outcome = planArrivals({ side: 'soviet', date: '1941-07-12' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const aircraft = outcome.data.units.filter((unit) => unit.kind === 'aircraft')
    expect(aircraft.map((unit) => unit.raw)).toEqual(expect.arrayContaining(['MiG.3', 'SB.2']))
    expect(aircraft[0]?.placement).toMatchObject({ kind: 'anyAirbase' })
  })

  it('13.6：非到达日返回空计划（不臆造）', () => {
    const outcome = planArrivals({ side: 'axis', date: '1941-07-13' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.units).toEqual([])
    expect(outcome.data.removals).toEqual([])
  })

  it('专规 2.1a：Entry L 于 19 July 关闭、Entry E 及南缘源于 19 August 关闭', () => {
    expect(shutdownsFor('soviet', '1941-07-18')).toEqual([])
    expect(shutdownsFor('soviet', '1941-07-19')).toEqual(['Entry L'])
    expect(shutdownsFor('soviet', '1941-08-19')).toEqual(['Entry L', 'Entry E 及以西所有南缘源'])
    // 轴方的补给源关闭不在专规 2.1a 之列
    expect(shutdownsFor('axis', '1941-08-19')).toEqual([])
  })
})

describe('13.6 / 13.6b：落点解算（含被阻挡时改投最近边缘格）', () => {
  it('13.6：入口未被阻挡 ⇒ 按入场格放置', () => {
    const result = resolveArrivalPlacement(
      { kind: 'entryHex', letters: ['K'], label: 'Entry K' },
      facts({ isBlocked: () => false }),
    )
    expect(result).toMatchObject({ status: 'placed', hex: hex(6, 1), rule: '13.6' })
  })

  it('13.6b：入场格被敌方单位阻挡 ⇒ 改投**最近的未被阻挡的地图边缘格**', () => {
    const result = resolveArrivalPlacement(
      { kind: 'entryHex', letters: ['K'], label: 'Entry K' },
      facts(),
    )
    expect(result).toMatchObject({ status: 'fallbackEdge', hex: hex(1, 1), rule: '13.6b' })
  })

  it('13.6：飞机落点为任一友方空军基地；该校无基地时报告 noAirbase', () => {
    expect(
      resolveArrivalPlacement({ kind: 'anyAirbase', label: 'Any Airbase' }, facts()),
    ).toMatchObject({ status: 'placed', hex: hex(36, 13) })
    expect(
      resolveArrivalPlacement(
        { kind: 'anyAirbase', label: 'Any Airbase' },
        facts({ friendlyAirBaseHexes: () => [] }),
      ),
    ).toMatchObject({ status: 'noAirbase', hex: null })
  })

  it('专规 2.1 / 3.1：Pax / Eq / 特殊补员 / 回归优先投到能直接拖取的 HQ，其次边缘补给源格', () => {
    expect(resolveArrivalPlacement({ kind: 'hqOrEdgeSource', label: 'HQ' }, facts())).toMatchObject(
      { status: 'placed', hex: hex(36, 14), rule: '2.1' },
    )
    // 没有可用 HQ ⇒ 退到边缘源格
    expect(
      resolveArrivalPlacement(
        { kind: 'hqOrEdgeSource', label: 'HQ' },
        facts({ directDrawHqHexes: () => [] }),
      ),
    ).toMatchObject({ status: 'placed', hex: hex(1, 3) })
    // 两者都没有 ⇒ noHq（不静默）
    expect(
      resolveArrivalPlacement(
        { kind: 'hqOrEdgeSource', label: 'HQ' },
        facts({ directDrawHqHexes: () => [], edgeSupplySourceHexes: () => [] }),
      ),
    ).toMatchObject({ status: 'noHq', hex: null })
  })

  it('1.6a：死亡堆落点不需要格', () => {
    expect(
      resolveArrivalPlacement({ kind: 'deadPile', label: 'Dead Pile' }, facts()),
    ).toMatchObject({ status: 'deadPile', hex: null, rule: '1.6a' })
  })

  it('地理参照与北缘以东：按半径 / 列约束给候选', () => {
    expect(
      resolveArrivalPlacement(
        { kind: 'geographic', anchor: hex(60, 34), radiusHexes: 3, label: 'w/i 3 of 60.34' },
        facts(),
      ),
    ).toMatchObject({ status: 'placed', hex: hex(60, 34) })
    expect(
      resolveArrivalPlacement(
        { kind: 'northEdgeEastOf', col: 32, label: 'North Edge, east of 32.xx' },
        facts(),
      ),
    ).toMatchObject({ status: 'placed', hex: hex(60, 35) })
  })
})

describe('13.6：日程日期 → 执行回合的归位（口径只有一处）', () => {
  /*
   * ★ 2026-09-15 用户裁定：回合轨的月内日号是轮盘 sectors `[1,5,8,12,15,19,22,26,29]` 每月重复，
   *   8 月与 9 月的首回合是 **1 日**（原 `derived_turn_dates` 错推为 2 日，源数据已修正）。
   *   故到货卡的每一块现在都**精确命中**回合轨；`arrivalTurnOf` 对既有日程是恒等映射。
   */
  it('arrivalTurnOf：日程日期归到轨上第一个 ≥ 它的回合；每张日程只有一个执行回合', () => {
    const track = turnDates()
    expect(track).toContain('1941-08-01')
    expect(track).toContain('1941-09-01')
    expect(track).not.toContain('1941-08-02')
    // 修正后：卡面日期本身就是回合 ⇒ 归位即恒等
    expect(arrivalTurnOf('1941-08-01')).toBe('1941-08-01')
    expect(arrivalTurnOf('1941-09-01')).toBe('1941-09-01')
    expect(arrivalTurnOf('1941-07-22')).toBe('1941-07-22')
    expect(arrivalTurnOf('1941-08-05')).toBe('1941-08-05')
    // 轨上不存在的日期仍按「第一个 ≥」归位（对**未来**的卡面日期保持确定性）
    expect(arrivalTurnOf('1941-08-02')).toBe('1941-08-05')
    // 轨末之后 ⇒ 本局永不触发
    expect(arrivalTurnOf('1941-12-01')).toBeNull()
  })

  it('13.6：8 月 1 日回合执行的是卡上「1 Aug 41」那一块（双方）', () => {
    expect(arrivalDateIso('1 Aug 41')).toBe('1941-08-01')

    // 苏方 8/1：卡上 1 Aug 块的成建制到达（并带 2.3e 的提示原文）
    const soviet = planArrivals({ side: 'soviet', date: '1941-08-01' })
    expect(soviet.ok).toBe(true)
    if (!soviet.ok) return
    expect(soviet.data.units.map((unit) => unit.raw)).toEqual(
      expect.arrayContaining(['18-1-3 Tk Div (109)', '13-3-3 Mtn Inf Div (194)']),
    )
    expect(soviet.data.notes.some((note) => /Operational Limits/.test(note))).toBe(true)

    // 轴方 8/1：卡上 1 Aug 块**只有移除**（5 个机型 + 7 枚预备标记）——故不能断言「有到达单位」
    const axis = planArrivals({ side: 'axis', date: '1941-08-01' })
    expect(axis.ok).toBe(true)
    if (!axis.ok) return
    expect(axis.data.units).toEqual([])
    expect(axis.data.removals.map((item) => item.raw)).toEqual(
      expect.arrayContaining(['Bf.109e-7', '7x Reserve Markers']),
    )

    // 8/5 是另一张卡（苏方 32nd/49th Army HQ 等），两块内容不同 ⇒ 没有重复触发
    const later = planArrivals({ side: 'soviet', date: '1941-08-05' })
    expect(later.ok).toBe(true)
    if (!later.ok) return
    expect(later.data.units.map((unit) => unit.raw)).toContain('32nd Army HQ')
    expect(later.data.units.map((unit) => unit.raw)).not.toContain('18-1-3 Tk Div (109)')
  })

  it('13.6：卡上「1 Sep 41」那一块在 9 月 1 日回合执行', () => {
    expect(arrivalDateIso('1 Sep 41')).toBe('1941-09-01')
    expect(arrivalTurnOf('1941-09-01')).toBe('1941-09-01')
    const outcome = planArrivals({ side: 'soviet', date: '1941-09-01' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.units.map((unit) => unit.raw)).toContain('6-2-5 Tk Bde (121, 129)')
  })

  it('13.6：非日程回合仍是空计划（不臆造）', () => {
    for (const date of ['1941-07-13', '1941-08-12', '1941-08-26']) {
      for (const side of ['axis', 'soviet'] as const) {
        const outcome = planArrivals({ side, date })
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) return
        expect(outcome.data.units).toEqual([])
        expect(outcome.data.removals).toEqual([])
      }
    }
  })
})

describe('专规 2.3c：方面军预备队三批', () => {
  it('2.3c：三批分别在 22 Jul / 1 Aug / 1 Sep，各 2 SP + 一次编制转化 + 两次免费重建', () => {
    expect(rulesConstants.smolensk.frontalReserves.batches).toHaveLength(3)
    for (const batch of rulesConstants.smolensk.frontalReserves.batches) {
      expect(batch.sp).toBe(rulesConstants.smolensk.frontalReservesSp)
      expect(batch.freeRebuilds).toEqual(['IL.2', 'HQ or artillery'])
    }
    expect(frontalReservesBatch('1941-07-22')).toMatchObject({
      convertFrom: '12-1-4 Mtr Div (69)',
      convertTo: '16-2-5 Mtr Div (107)',
    })
    /*
     * ★ 三批的卡面日期（22 Jul / 1 Aug / 1 Sep）在**修正后的回合轨上都是真实回合**
     *   （第 5 / 8 / 17 回合）⇒ 可领取日即卡面日；归位口径 `arrivalTurnOf` 在此是恒等映射。
     */
    expect(frontalReservesBatch('1941-08-01')).toMatchObject({ convertTo: '8-1-5 Tk Rgt (114)' })
    expect(frontalReservesBatch('1941-09-01')).toMatchObject({ convertTo: '10-0-1 Inf Div (103)' })
    // 非批次日 ⇒ 不认（每批只在一个回合触发）
    expect(frontalReservesBatch('1941-07-15')).toBeNull()
    expect(frontalReservesBatch('1941-08-05')).toBeNull()
    expect(frontalReservesBatch('1941-09-05')).toBeNull()
  })

  it('2.3c：非批次日期不得领取（「必须当即领取、不能保存」）', () => {
    const data = claimFrontalReserves('1941-07-22')
    expect(data.ok).toBe(true)
    const missing = claimFrontalReserves('1941-07-15')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.rule).toBe('2.3c')
  })
})

describe('专规 2.4：Slow Mobilization 的解锁', () => {
  it('2.4 表 2-2：30th 于 12 Jul 解锁 2、15 Jul 再解锁 3；28th/24th 于 15 Jul 各 3、19 Jul 各 5、24th 于 22 Jul 再 3', () => {
    expect(slowMobilizationUnlocks('1941-07-12')).toEqual([
      { date: '1941-07-12', army: '30th', unlockDivisions: 2 },
    ])
    expect(slowMobilizationUnlocks('1941-07-15')).toHaveLength(3)
    expect(slowMobilizationUnlocks('1941-07-19')).toHaveLength(2)
    expect(slowMobilizationUnlocks('1941-07-22')).toEqual([
      { date: '1941-07-22', army: '24th', unlockDivisions: 3 },
    ])
  })

  it('2.4：解锁数量不得超过当日配额与当前锁定数', () => {
    const ok = planSlowMobilization({
      date: '1941-07-12',
      army: '30th',
      lockedDivisions: 5,
      unlockRequested: 2,
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.data).toMatchObject({ unlocked: 2, remainingLocked: 3 })

    const tooMany = planSlowMobilization({
      date: '1941-07-12',
      army: '30th',
      lockedDivisions: 5,
      unlockRequested: 3,
    })
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.reason).toBe('unlockExceedsQuota:3>2')

    const noQuota = planSlowMobilization({
      date: '1941-07-15',
      army: '30th',
      lockedDivisions: 5,
      unlockRequested: 1,
    })
    expect(noQuota.ok).toBe(true)
    const wrongDay = planSlowMobilization({
      date: '1941-07-12',
      army: '28th',
      lockedDivisions: 5,
      unlockRequested: 1,
    })
    expect(wrongDay.ok).toBe(false)
  })

  it('1.6c：19 Aug 起不再掷特殊补员（日期闸门的唯一实现是 `timing.isSpecialReplAvailable`）', () => {
    expect(isSpecialReplAvailable('1941-08-18')).toBe(true)
    expect(isSpecialReplAvailable('1941-08-19')).toBe(false)
    // 特殊补员盒的 active 旗标与它同源（`specialReplBoxView` 不再自算 `date < endDate`）
    const before = specialReplBoxView({ side: 'soviet', date: '1941-08-18', deadPile: [] })
    const after = specialReplBoxView({ side: 'soviet', date: '1941-08-19', deadPile: [] })
    expect([before.active, after.active]).toEqual([true, false])
  })
})
