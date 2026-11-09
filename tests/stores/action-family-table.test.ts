import { describe, expect, it } from 'vitest'

import {
  ACTION_FAMILY_TABLE,
  UNREGISTERED_ACTION_FAMILIES,
  actionFamilyRowsAt,
  entryPointsOf,
} from '@/stores'
import { ACTION_GATES } from '@/stores/workbench-model'

/**
 * 「阶段 × 环节 × 动作族」权威表守卫（用户 2026-11-09 裁定）
 *
 * 表是菜单/面板的唯一取值处；它漏一键，就会在删重复入口时把某阶段的能力一起删掉。
 */
describe('动作族权威表：覆盖与依据', () => {
  it('每个闸门键都有动作族与入口登记，且每个 where 都在表里成行', () => {
    for (const gate of ACTION_GATES) {
      expect(() => entryPointsOf(gate.key), `动作族表缺登记：${gate.key}`).not.toThrow()
      expect(entryPointsOf(gate.key).length, `${gate.key} 没有入口`).toBeGreaterThan(0)
      for (const where of gate.where) {
        const rows = actionFamilyRowsAt({
          phase: where.phase,
          segment: where.segment,
          role: where.role ?? 'active',
          side: where.sides?.[0],
          atSegmentEnd: where.at === 'end' ? true : undefined,
        })
        expect(
          rows.some((row) => row.key === gate.key),
          `${gate.key} 在 ${where.phase}/${where.segment} 未成行`,
        ).toBe(true)
      }
    }
  })

  it('每行都带条款号、段名、环节名与触发者', () => {
    expect(ACTION_FAMILY_TABLE.length).toBeGreaterThan(0)
    for (const row of ACTION_FAMILY_TABLE) {
      expect(row.rule.trim(), `${row.key} 缺条款号`).not.toBe('')
      expect(row.label.trim(), `${row.key} 缺标签`).not.toBe('')
      expect(row.phaseLabel.trim(), `${row.key} 缺段名`).not.toBe('')
      expect(row.segmentLabel.trim(), `${row.key} 缺环节名`).not.toBe('')
      expect(row.owner.trim(), `${row.key} 缺触发者`).not.toBe('')
      expect(row.families.length, `${row.key} 缺动作族`).toBeGreaterThan(0)
      expect(row.entry.length, `${row.key} 缺入口`).toBeGreaterThan(0)
    }
  })

  it('段末动作只在 atSegmentEnd 时成行（与 allowedActionsOf 同口径）', () => {
    const endRows = actionFamilyRowsAt({
      phase: 'combat',
      segment: 'combat.combat',
      role: 'active',
      side: 'axis',
    })
    expect(endRows.some((row) => row.key === 'exclusive.panzerObligation')).toBe(false)
    const atEnd = actionFamilyRowsAt({
      phase: 'combat',
      segment: 'combat.combat',
      role: 'active',
      side: 'axis',
      atSegmentEnd: true,
    })
    expect(atEnd.some((row) => row.key === 'exclusive.panzerObligation')).toBe(true)
  })

  it('按方限定的动作不落给另一方', () => {
    const axis = actionFamilyRowsAt({
      phase: 'reinforcement',
      segment: 'reinforcement.frontalReserves',
      role: 'active',
      side: 'axis',
    })
    expect(axis.some((row) => row.key === 'rein.frontalReserves')).toBe(false)
    const soviet = actionFamilyRowsAt({
      phase: 'reinforcement',
      segment: 'reinforcement.frontalReserves',
      role: 'active',
      side: 'soviet',
    })
    expect(soviet.some((row) => row.key === 'rein.frontalReserves')).toBe(true)
  })

  it('未登记闸门的 UI 能力单独列出，条款号与入口齐全', () => {
    expect(UNREGISTERED_ACTION_FAMILIES.length).toBeGreaterThan(0)
    for (const item of UNREGISTERED_ACTION_FAMILIES) {
      expect(item.rule.trim(), `${item.id} 缺条款号`).not.toBe('')
      expect(item.entry.length, `${item.id} 缺入口`).toBeGreaterThan(0)
      expect(item.families.length, `${item.id} 缺动作族`).toBeGreaterThan(0)
    }
  })
})
