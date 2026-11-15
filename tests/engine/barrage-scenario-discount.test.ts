import { describe, expect, it } from 'vitest'

import type { BarrageTableMeta } from '@/engine/rules/barrage'
import {
  barrageTableWithScenarioRule,
  beginBarrage,
  scenarioBarrageSupplyDiscount,
} from '@/engine/rules/barrage-interaction'

/** 只验证成本字段，其余列位元信息按形状补齐 */
function tableMeta(costT: number): BarrageTableMeta {
  return {
    tableId: 'barrage',
    initialColumn: 1,
    costT,
    columnLabel: '测试列',
    columnCount: 5,
  }
}

const BASE_INPUT = {
  kind: 'artillery' as const,
  phase: 'combat' as const,
  targetKind: 'combatUnits' as const,
  targetHex: { col: 19, row: 27 },
  units: [{ unitId: 'art-1', printedValue: 17 }],
}

describe('剧本级炮击补给折扣（Intro: Vitebsk 的德军 −2T）', () => {
  it('只对指定方生效：该方 −2，另一方与其它剧本不变', () => {
    expect(scenarioBarrageSupplyDiscount('Intro', 'axis')).toBe(2)
    expect(scenarioBarrageSupplyDiscount('Intro', 'soviet')).toBe(0)
    expect(scenarioBarrageSupplyDiscount('1', 'axis')).toBe(0)
    expect(scenarioBarrageSupplyDiscount(undefined, 'axis')).toBe(0)
  })

  it('按初始列成本扣减，最低为 0（原 2T 即免费）', () => {
    expect(
      barrageTableWithScenarioRule(tableMeta(5), { scenarioId: 'Intro', side: 'axis' }).costT,
    ).toBe(3)
    expect(
      barrageTableWithScenarioRule(tableMeta(2), { scenarioId: 'Intro', side: 'axis' }).costT,
    ).toBe(0)
    expect(
      barrageTableWithScenarioRule(tableMeta(1), { scenarioId: 'Intro', side: 'axis' }).costT,
    ).toBe(0)
    expect(
      barrageTableWithScenarioRule(tableMeta(5), { scenarioId: 'Intro', side: 'soviet' }).costT,
    ).toBe(5)
    expect(
      barrageTableWithScenarioRule(tableMeta(5), { scenarioId: '1', side: 'axis' }).costT,
    ).toBe(5)
  })

  it('beginBarrage 直接产出折扣后的 costT（供付得起判定使用）', () => {
    // 轰炸值 17 ⇒ 原成本 3T
    const normal = beginBarrage(BASE_INPUT)
    expect(normal.ok && normal.data.table.costT).toBe(3)

    const axis = beginBarrage({ ...BASE_INPUT, scenarioId: 'Intro', side: 'axis' })
    expect(axis.ok && axis.data.table.costT).toBe(1)

    const soviet = beginBarrage({ ...BASE_INPUT, scenarioId: 'Intro', side: 'soviet' })
    expect(soviet.ok && soviet.data.table.costT).toBe(3)

    const other = beginBarrage({ ...BASE_INPUT, scenarioId: '1', side: 'axis' })
    expect(other.ok && other.data.table.costT).toBe(3)
  })

  it('轰炸值 8 ⇒ 原成本 2T；Intro 德军降为 0（免费）', () => {
    const input = { ...BASE_INPUT, units: [{ unitId: 'art-1', printedValue: 8 }] }
    const normal = beginBarrage(input)
    expect(normal.ok && normal.data.table.costT).toBe(2)
    const axis = beginBarrage({ ...input, scenarioId: 'Intro', side: 'axis' })
    expect(axis.ok && axis.data.table.costT).toBe(0)
  })
})
