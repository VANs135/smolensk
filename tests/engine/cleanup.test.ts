import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { CLEANUP_PHASE, cleanupPatchById, isCleanUpNoop, planCleanUp } from '@/engine/rules'
import { ACTIONS_BY_PHASE } from '@/engine/rules'
import type { GamePhase } from '@/engine/state-types'
import type { CleanUpMarkerView, CleanUpUnitView } from '@/engine/rules/cleanup'

/**
 * H 清理阶段的通用自动清理（2.2 末段 + 5.9 / 5.10 / 12.5d / 10.0c-C）
 *
 * 条文原文（2.2 流程表·清理阶段）：
 *   「当前阶段玩家为他的单位移除所有**进击**和**混乱(DG)**标记，并**移除(或翻面)他所有的燃料标记**。
 *     移除由**非阶段玩家**生成的**运输破坏标记**。」
 *
 * 单测只喂「视图」不造盘面：断言的是补丁清单与计数（引擎不写状态）。
 */

/** 造一枚单位视图 */
function unit(
  id: string,
  side: 'axis' | 'soviet',
  flags: { dg?: boolean; exploit?: boolean; fuelled?: boolean } = {},
): CleanUpUnitView {
  return {
    id,
    side,
    dg: flags.dg === true,
    exploit: flags.exploit === true,
    fuelled: flags.fuelled === true,
  }
}

const HEX: HexRef = { col: 36, row: 13 }
const mark = (id: string, side: 'axis' | 'soviet'): CleanUpMarkerView => ({
  id,
  hex: { ...HEX },
  side,
})

describe('H 清理：段闸与动作登记（2.2）', () => {
  it('只有清理阶段能执行清理；其余段一律拒绝（2.2）', () => {
    const others: GamePhase[] = [
      'preTurn',
      'aircraftRefit',
      'reinforcement',
      'movement',
      'supply',
      'reaction',
      'combat',
      'exploitation',
      'turnEnd',
    ]
    for (const phase of others) {
      const outcome = planCleanUp({
        phase,
        side: 'axis',
        units: [unit('u1', 'axis', { dg: true })],
      })
      expect(outcome.ok, `${phase} 段不该允许清理`).toBe(false)
      if (!outcome.ok) {
        expect(outcome.rule).toBe('2.2')
        expect(outcome.reason).toContain('notCleanUpPhase')
      }
    }
    expect(CLEANUP_PHASE).toBe('cleanUp')
    const ok = planCleanUp({ phase: CLEANUP_PHASE, side: 'axis', units: [] })
    expect(ok.ok).toBe(true)
  })

  it('2.2 的 H 段许可动作里已登记 cleanUp（原来为空集合）', () => {
    expect([...ACTIONS_BY_PHASE.cleanUp]).toEqual(['cleanUp'])
  })
})

describe('H 清理：摘本人单位的 DG / 进击 / 燃料（5.9 / 5.10 / 12.5d）', () => {
  it('只摘**本段玩家**的三种标记，对手单位原样不动', () => {
    const outcome = planCleanUp({
      phase: 'cleanUp',
      side: 'axis',
      units: [
        unit('a1', 'axis', { dg: true, exploit: true, fuelled: true }),
        unit('s1', 'soviet', { dg: true, exploit: true, fuelled: true }),
      ],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.patches).toEqual([
      { unitId: 'a1', clearDg: true, clearExploit: true, clearFuel: true },
    ])
    expect(outcome.data.counts).toEqual({ dg: 1, exploit: 1, fuel: 1, trainbusting: 0 })
  })

  it('无标记的单位不进补丁（补丁只列「确有东西可摘」的单位）', () => {
    const outcome = planCleanUp({
      phase: 'cleanUp',
      side: 'soviet',
      units: [
        unit('s1', 'soviet'),
        unit('s2', 'soviet', { exploit: true }),
        unit('s3', 'soviet', { dg: true }),
      ],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.patches.map((patch) => patch.unitId)).toEqual(['s2', 's3'])
    // 每枚只清自己有的那一种
    expect(outcome.data.patches[0]).toEqual({
      unitId: 's2',
      clearDg: false,
      clearExploit: true,
      clearFuel: false,
    })
    expect(outcome.data.patches[1]).toEqual({
      unitId: 's3',
      clearDg: true,
      clearExploit: false,
      clearFuel: false,
    })
  })

  it('5.9/5.10：只摘标记、不改朝向（补丁里根本没有朝向字段）', () => {
    const outcome = planCleanUp({
      phase: 'cleanUp',
      side: 'axis',
      units: [unit('a1', 'axis', { dg: true, exploit: true })],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    for (const patch of outcome.data.patches) {
      expect(Object.keys(patch).sort()).toEqual(['clearDg', 'clearExploit', 'clearFuel', 'unitId'])
    }
  })

  it('12.5d：燃料已补给（编队标记 / HQ 标记 / 单单位法）在本段一并清零', () => {
    const outcome = planCleanUp({
      phase: 'cleanUp',
      side: 'axis',
      units: [
        unit('hq', 'axis', { fuelled: true }),
        unit('pz', 'axis', { fuelled: true }),
        unit('inf', 'axis'),
      ],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.counts.fuel).toBe(2)
    expect(outcome.data.patches.every((patch) => patch.clearFuel)).toBe(true)
    expect(outcome.data.patches).toHaveLength(2)
  })
})

describe('H 清理：移除对手放置的运输破坏标记（2.2 / 10.0c-C / 14.8c）', () => {
  it('移除**非**本段玩家放置的标记；自己放的留着', () => {
    const outcome = planCleanUp({
      phase: 'cleanUp',
      side: 'axis',
      units: [],
      trainbustingMarks: [
        mark('tb-sov-1', 'soviet'),
        mark('tb-ax-1', 'axis'),
        mark('tb-sov-2', 'soviet'),
      ],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.removeMarkerIds).toEqual(['tb-sov-1', 'tb-sov-2'])
    expect(outcome.data.counts.trainbusting).toBe(2)
  })

  it('轮到苏军清理时，反过来移除轴心方放置的标记', () => {
    const outcome = planCleanUp({
      phase: 'cleanUp',
      side: 'soviet',
      units: [],
      trainbustingMarks: [mark('tb-sov-1', 'soviet'), mark('tb-ax-1', 'axis')],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.removeMarkerIds).toEqual(['tb-ax-1'])
  })

  it('未给标记清单时视为没有标记（不凭空产出移除项）', () => {
    const outcome = planCleanUp({ phase: 'cleanUp', side: 'axis', units: [] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.removeMarkerIds).toEqual([])
    expect(outcome.data.counts.trainbusting).toBe(0)
  })
})

describe('H 清理：计划的形态与日志文案', () => {
  it('detail 把四类计数都写出来，并带规则号 2.2', () => {
    const outcome = planCleanUp({
      phase: 'cleanUp',
      side: 'axis',
      units: [unit('a1', 'axis', { dg: true, exploit: true, fuelled: true })],
      trainbustingMarks: [mark('tb-sov-1', 'soviet')],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.rule).toBe('2.2')
    expect(outcome.data.side).toBe('axis')
    expect(outcome.data.detail).toContain('摘 DG 1 枚')
    expect(outcome.data.detail).toContain('进击 1 枚')
    expect(outcome.data.detail).toContain('清燃料已补给 1 枚')
    expect(outcome.data.detail).toContain('运输破坏标记 1 枚')
  })

  it('cleanupPatchById：按单位 id 取补丁；isCleanUpNoop：四类计数全零才算无事可做', () => {
    const outcome = planCleanUp({
      phase: 'cleanUp',
      side: 'axis',
      units: [unit('a1', 'axis', { dg: true })],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(cleanupPatchById(outcome.data).get('a1')?.clearDg).toBe(true)
    expect(isCleanUpNoop(outcome.data)).toBe(false)

    const empty = planCleanUp({ phase: 'cleanUp', side: 'axis', units: [unit('a1', 'axis')] })
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(isCleanUpNoop(empty.data)).toBe(true)
  })
})
