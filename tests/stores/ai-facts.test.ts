import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { aircraftChoices, toConsoleAirUnit } from '@/stores'

import {
  CORE_HEX,
  combatRecord,
  groundRecord,
  label,
  newConsole,
  placeGround,
} from '../flows/sop-harness'

/**
 * **AI 训练用的只读投影**（2026-11-26 用户：「训练 PVE 的 AI 要用」）
 *
 * 这三条此前藏在 store 内部（`justEnteredHexFor` / `rebuildRowFor` / `rebuildHqHexes`），
 * 对 AI 只有两个坏选择：要么自己复刻一份（`driver.ts` 曾经手抄 `moveInteraction.steps` 判「刚进入」），
 * 要么只能看动作结果的成败。现在按「只给事实、不给判断」开放三个读侧入口：
 *
 *   · `justEnteredHexOf(id, hex)`：本阶段最近一次「移动进入」且此刻仍停留 ⇒ 返回该格，否则 null
 *   · `rebuildRowOf(id)`：此刻该走的重建表行键（玩家已选优先，否则按类型自动映射；推不出为 ''）
 *   · `rebuildHqHexes`：可作重建圆心的友方 HQ 格（战斗模式，或 DG 朝战斗面）
 *
 * ★ 测法边界：这里只钉**事实本身**。能不能换轨 / 能不能重建仍由写入口
 *   （`convertRailGaugeNow` / `rebuildLegalHexes` / `rebuild*Now`）判，本文件不替代那些用例。
 */

/** 苏方铁路修理单位（West RR Rgt） */
const isRailRepair = (record: { specialized?: readonly string[] }): boolean =>
  (record.specialized ?? []).includes('rail_repair')

/** Mogilev（15.10）→ 15.11：相邻两格都在干线上（与 `rail-repair-flow.test.ts` 同一段路） */
const FROM: HexRef = { col: 15, row: 10 }
const NEXT: HexRef = { col: 15, row: 11 }

/** 让单位真的走一格（`clickHex` 建取子 → 确认开拔 → 点目标格） */
function walkInto(
  store: ReturnType<typeof newConsole>,
  unitId: string,
  from: HexRef,
  to: HexRef,
): void {
  const active = store.moveInteraction?.unitIds.includes(unitId) === true
  if (!active || store.moveInteraction?.finished === true) {
    store.clickHex(from)
    if (store.movePickHex !== null) {
      store.setMovePickOnly(unitId)
      expect(
        store.confirmMovePick(),
        `${store.moveBlocked?.rule ?? '-'}/${store.moveBlocked?.reason ?? '-'}`,
      ).toBe(true)
    }
  }
  store.clickHex(to)
  expect(store.units.find((unit) => unit.instanceId === unitId)?.hex).toEqual(to)
}

describe('13.3f-B：justEnteredHexOf（「刚进入」的只读投影）', () => {
  it('没走 ⇒ null；走进 ⇒ 该格；换阶段 ⇒ 作废；传别的格 ⇒ null', () => {
    const store = newConsole()
    store.switchSide()
    store.setPhase('movement')
    const record = groundRecord('soviet', isRailRepair)
    const rr = placeGround(store, record, FROM, 'soviet', 'rr-ai', 'combat')

    expect(store.justEnteredHexOf(rr.instanceId, rr.hex)).toBeNull()

    walkInto(store, rr.instanceId, FROM, NEXT)
    const entered = store.justEnteredHexOf(rr.instanceId, NEXT)
    expect(entered).not.toBeNull()
    expect(label(entered!)).toBe(label(NEXT))
    // 传一个并非「它刚进入」的格 ⇒ 不能说成刚进入（防远程换轨）
    expect(store.justEnteredHexOf(rr.instanceId, FROM)).toBeNull()

    // 换阶段 ⇒ 本阶段记账清零（`railArrived` / `lastGroundEntryByUnit` 同点清）
    store.setPhase('supply')
    expect(store.justEnteredHexOf(rr.instanceId, NEXT)).toBeNull()
  })
})

describe('13.5 / 13.5a：rebuildRowOf 与 rebuildHqHexes', () => {
  it('行键：飞机恒为 Aircraft（不在 13.5b 候选池里，仍给同一答案）', () => {
    const store = newConsole()
    store.setActiveSide('soviet')
    const plane = aircraftChoices('soviet')[0]
    if (plane === undefined) throw new Error('飞机库里没有苏方记录')
    const air = toConsoleAirUnit({
      aircraft: plane,
      instanceId: 'air-ai',
      hex: CORE_HEX,
      side: 'soviet',
      airStatus: 'inactive',
    })
    air.steps = 0
    store.deadPile.push(air)

    expect(store.rebuildCandidates.some((item) => item.instanceId === 'air-ai')).toBe(false)
    expect(store.rebuildRowOf('air-ai')).toBe('Aircraft')
    expect(store.rebuildRowOf('no-such-unit')).toBe('')
  })

  it('行键：图上受损的地面单位按类型自动映射（与面板选行同源）', () => {
    const store = newConsole()
    store.setActiveSide('axis')
    const record = combatRecord('axis')
    const unit = placeGround(store, record, { col: 10, row: 12 }, 'axis', 'g-damaged', 'combat')
    unit.steps = Math.max(0, unit.printedSteps - 1)

    const row = store.rebuildRowOf(unit.instanceId)
    expect(row).not.toBe('')
    // 面板选它时写进 `rebuildPickRow` 的值必须与投影一致（两处不许各算一套）
    store.selectRebuildUnitNow(unit.instanceId)
    expect(store.rebuildPickRow).toBe(row)
    expect(store.rebuildRowOf(unit.instanceId)).toBe(row)
  })

  it('行键：玩家已选优先于自动映射', () => {
    const store = newConsole()
    store.setActiveSide('soviet')
    store.rebuildPickUnitId = 'probe'
    store.rebuildPickRow = 'Pax'
    expect(store.rebuildRowOf('probe')).toBe('Pax')
    // 不是它 ⇒ 回落到自动映射（无候选 ⇒ 空串）
    expect(store.rebuildRowOf('other')).toBe('')
  })

  it('圆心：只收本方、战斗模式（或 DG 朝战斗面）的 HQ', () => {
    const store = newConsole()
    store.setActiveSide('axis')
    const hq = groundRecord('axis', (record) => (record.specialized ?? []).includes('hq'))
    const hqSoviet = groundRecord('soviet', (record) => (record.specialized ?? []).includes('hq'))

    const combatHq = placeGround(store, hq, { col: 10, row: 10 }, 'axis', 'hq-combat', 'combat')
    const moveHq = placeGround(store, hq, { col: 11, row: 10 }, 'axis', 'hq-move', 'move')
    moveHq.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
    const dgHq = placeGround(store, hq, { col: 12, row: 10 }, 'axis', 'hq-dg', 'move')
    // 13.5a via 5.10e：DG 但朝向战斗面 ⇒ 仍算战斗模式
    dgHq.mode = { mode: 'move', orientation: 'combat', dg: true, exploit: false }
    const enemyHq = placeGround(store, hqSoviet, { col: 13, row: 10 }, 'soviet', 'hq-su', 'combat')

    const centers = store.rebuildHqHexes.map((hex) => label(hex))
    expect(centers).toContain(label(combatHq.hex))
    expect(centers).toContain(label(dgHq.hex))
    expect(centers).not.toContain(label(moveHq.hex))
    expect(centers).not.toContain(label(enemyHq.hex))

    // 换到苏方 ⇒ 圆心表整体换成苏方（同一份投影，不许两份）
    store.setActiveSide('soviet')
    expect(store.rebuildHqHexes.map((hex) => label(hex))).toEqual([label(enemyHq.hex)])
  })
})
