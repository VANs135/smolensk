import { describe, expect, it } from 'vitest'

import {
  buildChartsTables,
  buildFlakMissionLoss,
  buildGridTable,
  PRESERVED_TABLE_IDS,
} from '../../scripts/sync-charts.mjs'

/** 断言视图（仅为测试收敛类型） */
interface TablesOut {
  meta: { version: string; description: string }
  tables: { id: string; rows: string[]; columns: string[]; grid: string[][]; cost?: unknown }[]
}

/** 最小可用的源库 tables（形状照 charts.json）
 *
 * 行标签刻意避开类整数键（如 '2'）：JS 对象属性序会把类整数键排到前面，
 * 那会掩盖"按 rows 标注顺序转行主序"这一被测行为。
 */
function fakeSourceTables() {
  return {
    barrage_table: {
      columns: ['1', '2'],
      rows: { 'one or less': ['-', 'DG'], 'odds two': ['1', '2'] },
      cost_t: [1, 1],
    },
    barrage_vs_facility: { columns: ['1'], rows: { one: ['-'] } },
    capture_table: { columns: ['1', '2', '3'], rows: { one: ['x', 'y', 'z'] } },
    flak: { mission_loss_table: { '2 aircraft': ['W', 'S', 'W', 'S', 'W', 'S'] } },
    // 注意：源库里这两张表是异形（surprise 为对象、attrition 为行主序），脚本**不生成**它们
  }
}

/**
 * sync-charts.mjs 核心单测（门禁加固 B0①）
 *
 * 重点不是"能生成表"，而是**脚本无法再生成的两张手写表不会因为重跑而消失**：
 * `tables/lookup.ts` 缺表会直接抛 TableLookupError，而 schema 里这两张表并不缺省。
 */
describe('sync-charts 转换核心', () => {
  it('网格表：rows/columns/grid 三件套，无 cost_t 时不写 cost 键', () => {
    const withCost = buildGridTable('barrage', {
      columns: ['1'],
      rows: { 'one or less': ['-'] },
      cost_t: [1],
    }) as Record<string, unknown>
    expect(withCost.rows).toEqual(['one or less'])
    expect(withCost.grid).toEqual([['-']])
    expect('cost' in withCost).toBe(true)

    const withoutCost = buildGridTable('capture', {
      columns: ['1'],
      rows: { one: ['x'] },
    }) as Record<string, unknown>
    expect('cost' in withoutCost).toBe(false)
  })

  it('防空任务损失表：固定 3 行（2/3/4 机）× 6 列（骰 1–6）', () => {
    const table = buildFlakMissionLoss({
      '2 aircraft': ['W', 'S', 'W', 'S', 'W', 'S'],
      '3 aircraft': ['W', 'S', 'W', 'S', 'W', 'S'],
      '4 aircraft': ['W', 'S', 'W', 'S', 'W', 'S'],
    }) as { rows: string[]; columns: string[]; grid: string[][] }
    expect(table.columns).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(table.rows).toEqual(['2 aircraft', '3 aircraft', '4 aircraft'])
    expect(table.grid).toHaveLength(3)
    expect(table.grid.every((row) => row.length === 6)).toBe(true)
  })

  it('缺少既有产物时对两张手写表报错（宁可脚本失败，也不要产出读不出的数据）', () => {
    expect(() => buildChartsTables(fakeSourceTables(), null)).toThrow(/手写表缺失/)
  })

  it('缺少其中一张手写表时报错并点名是哪张', () => {
    expect(() =>
      buildChartsTables(fakeSourceTables(), {
        tables: [{ id: 'surprise', rows: ['a'], columns: ['1'], grid: [['x']] }],
      }),
    ).toThrow(/attrition/)
  })

  it('从既有产物保留手写表，且按既有顺序插回原位（重跑幂等的前提）', () => {
    const existing = {
      tables: [
        { id: 'barrage', rows: ['旧'], columns: ['1'], grid: [['旧']] },
        { id: 'barrage-vs-facility', rows: ['旧'], columns: ['1'], grid: [['旧']] },
        { id: 'capture', rows: ['旧'], columns: ['1'], grid: [['旧']] },
        { id: 'flak-mission-loss', rows: ['旧'], columns: ['1'], grid: [['旧']] },
        { id: 'surprise', rows: ['奇袭行'], columns: ['1'], grid: [['奇袭']] },
        { id: 'attrition', rows: ['损耗行'], columns: ['1'], grid: [['损耗']] },
      ],
    }
    const out = buildChartsTables(fakeSourceTables(), existing) as unknown as TablesOut

    // 表序与既有产物一致（四张脚本表在前、两张手写表在后）
    expect(out.tables.map((table) => table.id)).toEqual([
      'barrage',
      'barrage-vs-facility',
      'capture',
      'flak-mission-loss',
      'surprise',
      'attrition',
    ])
    // 手写表内容原样保留
    const surprise = out.tables.find((table) => table.id === 'surprise')
    expect(surprise?.grid).toEqual([['奇袭']])
    const attrition = out.tables.find((table) => table.id === 'attrition')
    expect(attrition?.grid).toEqual([['损耗']])
    // 脚本表以新产出为准
    const barrage = out.tables.find((table) => table.id === 'barrage')
    expect(barrage?.grid).toEqual([
      ['-', 'DG'],
      ['1', '2'],
    ])
  })

  it('保留清单常量与 lookup.ts 的消费口径一致', () => {
    expect([...PRESERVED_TABLE_IDS]).toEqual(['surprise', 'attrition'])
  })
})
