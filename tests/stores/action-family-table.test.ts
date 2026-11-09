import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  ACTION_FAMILY_TABLE,
  UNREGISTERED_ACTION_FAMILIES,
  actionFamilyRowsAt,
  entryPointsOf,
} from '@/stores'
import { ACTION_GATES, allowedActionsOf } from '@/stores/workbench-model'
import { AIR_MISSION_SEGMENT } from '@/engine/rules'

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

  it('★ 三载体守卫：声明了"盒区"的动作族，盒区必须有可达入口', () => {
    /*
     * 用户 2026-11-09：上一轮"删重复入口"把图外盒的整备入口删没了。
     * 这里按载体逐一断言：META 声明了哪个载体，就必须在该载体的组件里找到触发实现；
     * 只登记不实现 ⇒ 红（不允许"声明了却点不到"）。
     */
    const boxKeys = [
      ...new Set(ACTION_FAMILY_TABLE.filter((row) => row.entry.includes('盒区')).map((r) => r.key)),
    ]
    expect(boxKeys.length).toBeGreaterThan(0)
    for (const key of boxKeys) {
      const probe = BOX_ENTRY_PROBES[key]
      if (probe === undefined) throw new Error(`${key} 声明了盒区入口但没有登记实现探针`)
      const hit = probe.files.some((file) => probe.pattern.test(read(repoPath(file))))
      expect(hit, `${key} 的盒区入口没有实现（删重复入口时删掉了？）`).toBe(true)
    }
  })

  it('★ 整备（air.refit）：图上格 / 图外盒 / 面板 三类载体各自可达', () => {
    expect(read(repoPath('src/components/game/MapActionPopover.vue'))).toContain('beginRefitNow')
    expect(read(repoPath('src/components/game/BoxCard.vue'))).toContain('activateAirBox')
    expect(read(repoPath('src/components/air/AircraftRoster.vue'))).toContain('activateAirBox')
  })
})

/** 各动作族的载体实现探针（新增载体声明时同步加一条） */
const BOX_ENTRY_PROBES: Record<string, { files: readonly string[]; pattern: RegExp }> = {
  'air.refit': {
    files: ['src/components/game/BoxCard.vue', 'src/components/air/AircraftRoster.vue'],
    pattern: /activateAirBox/,
  },
  'air.mission': {
    files: ['src/components/air/AircraftRoster.vue'],
    pattern: /setAirInBox/,
  },
}

function repoPath(relative: string): string {
  return new URL(`../../${relative}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

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

it('10.0 第二段：移动环节的轰炸口子注明「仅空军」', () => {
  const rows = actionFamilyRowsAt({
    phase: 'movement',
    segment: 'movement.modeAndMovement',
    role: 'active',
    side: 'axis',
  }).filter((row) => row.key === 'barrage.declare')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.note).toContain('10.0 第二段')
  expect(rows[0]!.note).toContain('移动环节仅')
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

it('14.11 基地转移：表口径限移动环节，与引擎同口径', () => {
  const entry = UNREGISTERED_ACTION_FAMILIES.find((item) => item.id === 'air.transfer')
  expect(entry).toBeDefined()
  // 14.2e：「转移可在不同的移动环节中执行」⇒ 表登记为移动环节，而不是“无时机限制”
  expect(entry!.segmentKind).toBe('movementSegment')
  // 与引擎唯一口径对齐（AIR_MISSION_SEGMENT.base_transfer）
  expect(entry!.segmentKind).toBe(AIR_MISSION_SEGMENT.base_transfer)
  expect(entry!.note).toContain('移动环节')
  expect(entry!.note).not.toContain('原文未给时机限制')
})

/*
 * 菜单/面板已改成只查本表（`workbench.segmentActionKeys` / `actionAllowedNow`）。
 * 这条用例把"表"与"闸门表"逐查询对齐：换投影不得改变任何一段的实际可点集合，
 * 否则删入口时对"某阶段还剩什么能力"的判断就会跟着错。
 */
it('表与 allowedActionsOf 逐查询等价（换投影不改行为）', () => {
  const combos = new Map<
    string,
    {
      phase: (typeof ACTION_GATES)[number]['where'][number]['phase']
      segment: string
      role: 'active' | 'nonActive'
    }
  >()
  for (const gate of ACTION_GATES) {
    for (const where of gate.where) {
      const role = where.role ?? 'active'
      combos.set(`${where.phase}|${where.segment}|${role}`, {
        phase: where.phase,
        segment: where.segment,
        role,
      })
    }
  }
  for (const combo of combos.values()) {
    for (const side of ['axis', 'soviet'] as const) {
      for (const atSegmentEnd of [false, true]) {
        const query = { ...combo, side, atSegmentEnd }
        const fromTable = new Set(actionFamilyRowsAt(query).map((row) => row.key))
        const fromGate = allowedActionsOf(query)
        expect([...fromTable].sort(), JSON.stringify(query)).toEqual([...fromGate].sort())
      }
    }
  }
})
