import { describe, expect, it } from 'vitest'

import { hasTraceSupply } from '@/engine/rules'
import type { UnitRecordView } from '@/stores'
import {
  createSupplyFacts,
  throwRangeMpOf,
  toConsoleUnit,
  toThrowHqView,
  unitChoices,
} from '@/stores'

import { CORE_HEX, NEAR_HEX } from '../flows/sop-harness'

/**
 * R1（13.1b / 12.3b / 5.4a）：HQ 投递距离**按当前朝上的那一面取**
 *
 * ## 原文
 *   · **13.1b**：HQ 的投递距离「印在算子底部左边，**战斗面与移动面不同**」。
 *   · **12.3b**：「距离以它**印刷的投递距离**为准」。
 *   · **5.4a**：一切数值以**朝向那一面**为基准。
 *
 * ## 本夹具钉什么
 *   数据侧（`units-axis.json` / `units-soviet.json`）**两面都有** `throwRange`，本文件直接取真实单位库：
 *   同一座 HQ 在 `combat` / `move` 两种朝向下 `throwRangeMpOf` 返回值**不同且各自等于印值**，
 *   `toThrowHqView` 也随朝向取到不同的 `throwRangeMp`。
 *   （修前此判据已按 `mode.orientation` 分支 —— 本夹具只固化行为，不改代码。）
 */

const hqs = (side: 'axis' | 'soviet'): UnitRecordView[] =>
  unitChoices(side).filter(
    (record) => record.throwRange !== undefined && record.throwRange !== null,
  )

const PICK = (side: 'axis' | 'soviet', range: number): UnitRecordView => {
  const found = hqs(side).find((record) => record.throwRange?.combatFace === range)
  if (found === undefined) throw new Error(`${side} 单位库里没有战斗面投递距离 ${range} 的 HQ`)
  return found
}

/** 同一算子分别在两个朝向下取投递距离（不改数据，只切朝向） */
function rangeByFace(record: UnitRecordView) {
  const unit = toConsoleUnit({
    record,
    instanceId: `probe-${record.id}`,
    hex: { col: 1, row: 1 },
    side: record.id.startsWith('ax') ? 'axis' : 'soviet',
  })
  const readAt = (orientation: 'combat' | 'move') => {
    unit.mode.orientation = orientation
    unit.raw = unit.faces[orientation]
    return { mp: throwRangeMpOf(unit), view: toThrowHqView(unit) }
  }
  return {
    combat: readAt('combat'),
    move: readAt('move'),
    printed: record.throwRange!,
  }
}

describe('13.1b：投递距离按当前面取（正反面不同）', () => {
  it('★ 轴心 8/5 型 HQ：战斗面 8、移动面 5', () => {
    const record = PICK('axis', 8)
    const { combat, move, printed } = rangeByFace(record)
    expect(printed).toEqual({ combatFace: 8, moveFace: 5 })
    expect(combat.mp).toBe(8)
    expect(move.mp).toBe(5)
    expect(combat.view.throwRangeMp).toBe(8)
    expect(move.view.throwRangeMp).toBe(5)
    expect(combat.mp).not.toBe(move.mp)
  })

  it('★ 轴心 10/7 型 HQ：战斗面 10、移动面 7', () => {
    const record = PICK('axis', 10)
    const { combat, move, printed } = rangeByFace(record)
    expect(printed).toEqual({ combatFace: 10, moveFace: 7 })
    expect(combat.mp).toBe(10)
    expect(move.mp).toBe(7)
    expect(combat.view.throwRangeMp).toBe(10)
    expect(move.view.throwRangeMp).toBe(7)
  })

  it('★ 苏联 HQ：两面 10/7 各自成立（不沿用轴心的 8/5）', () => {
    const record = PICK('soviet', 10)
    const { combat, move, printed } = rangeByFace(record)
    expect(printed).toEqual({ combatFace: 10, moveFace: 7 })
    expect(combat.mp).toBe(10)
    expect(move.mp).toBe(7)
    expect(combat.view.throwRangeMp).toBe(10)
    expect(move.view.throwRangeMp).toBe(7)
  })

  it('★ 全量：每一座 HQ 的两面印值都可读，且不为 0', () => {
    for (const side of ['axis', 'soviet'] as const) {
      const records = hqs(side)
      expect(records.length).toBeGreaterThan(0)
      for (const record of records) {
        const { combat, move, printed } = rangeByFace(record)
        expect(printed.combatFace).toBeGreaterThan(0)
        expect(printed.moveFace).toBeGreaterThan(0)
        expect(combat.mp).toBe(printed.combatFace)
        expect(move.mp).toBe(printed.moveFace)
      }
    }
  })
})

describe('12.3b：非 HQ 无投递距离', () => {
  it('非 HQ 返回 0（不把普通单位误当 HQ）', () => {
    const record = unitChoices('axis').find(
      (item) => item.throwRange === undefined || item.throwRange === null,
    )
    if (record === undefined) throw new Error('轴心单位库里找不到非 HQ 算子')
    const unit = toConsoleUnit({
      record,
      instanceId: 'plain-1',
      hex: { col: 1, row: 1 },
      side: 'axis',
    })
    expect(throwRangeMpOf(unit)).toBe(0)
  })
})

/* ────────────── 13.1a–c：指挥部双面印值与 DG 例外（只固化行为，不改代码） ────────────── */

describe('13.1a：DG 不影响指挥部的特殊功能', () => {
  it('HQ 开 DG 后仍是有效投递源（投递距离与视图都不因 DG 改变）', () => {
    const record = PICK('axis', 8)
    const hq = toConsoleUnit({ record, instanceId: 'hq-dg', hex: CORE_HEX, side: 'axis' })
    // 5.10e 的 DG：对 HQ 只改战斗相关数值，不影响 13.1b 的投递
    hq.mode.dg = true

    const facts = createSupplyFacts({
      units: [hq],
      dumps: [],
      sources: [{ hex: CORE_HEX, side: 'axis', kind: 'supplySourceHex' }],
    })
    // 12.3b：目标在投递距离内 ⇒ 仍可作为追溯补给来源
    const verdict = hasTraceSupply(facts, { hex: NEAR_HEX, side: 'axis', mobility: 'leg' })
    expect(verdict.ok).toBe(true)
    expect(verdict.rule).toBe('12.6a')
    expect(throwRangeMpOf(hq)).toBe(record.throwRange!.combatFace)
    expect(toThrowHqView(hq).throwRangeMp).toBe(record.throwRange!.combatFace)
  })
})

describe('13.1a：战斗面的投递距离比移动面更远', () => {
  it('全量 HQ：每一座的两面印值都是「战斗面 > 移动面」', () => {
    for (const side of ['axis', 'soviet'] as const) {
      for (const record of hqs(side)) {
        const printed = record.throwRange!
        expect(printed.combatFace!).toBeGreaterThan(printed.moveFace!)
      }
    }
  })
})

describe('13.1c：战斗面 5（只防御）/移动面 1、AR 0', () => {
  it('全量 HQ：两面攻击值 5 / 1（战斗面加括号）、两面 AR 0 且不可主动攻击', () => {
    for (const side of ['axis', 'soviet'] as const) {
      for (const record of hqs(side)) {
        const factors = record.factors!
        expect(factors.combat!.attack).toBe(5)
        expect(factors.move!.attack).toBe(1)
        expect(factors.combat!.ar).toBe(0)
        expect(factors.move!.ar).toBe(0)
        // 括号＝只能防御（13.1c），故不算可攻击单位
        expect(record.attackValueBracketed).toBe(true)
        expect(record.attackCapable).toBe(false)
      }
    }
  })
})
