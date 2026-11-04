import { describe, expect, it } from 'vitest'
import { normalizeSupplyDumps, remapSupplyDumpAmounts } from '@/engine/rules'

const dumps = [
  { id: 'a', side: 'axis' as const, hex: { col: 30, row: 20 }, sp: 1, t: 2 },
  { id: 'b', side: 'axis' as const, hex: { col: 30, row: 20 }, sp: 2, t: 3 },
]
describe('12.1b/3.4b：补给站恢复归并', () => {
  it('12.6c/12.11a：被归并来源的计数相加，保留其它来源历史，重复迁移不再增加', () => {
    const original = { a: 2, b: 3, 'unit:truck': 4 }
    const aliases = { a: 'a', b: 'a' }
    const result = remapSupplyDumpAmounts(original, aliases)
    expect(result).toEqual({ a: 5, 'unit:truck': 4 })
    expect(original).toEqual({ a: 2, b: 3, 'unit:truck': 4 })
    expect(remapSupplyDumpAmounts(result, aliases)).toEqual(result)
  })
  it('不修改输入，返回旧ID映射和去重待办，重复规范化稳定', () => {
    const before = JSON.stringify(dumps)
    const result = normalizeSupplyDumps(dumps, {}, ['b', 'a', 'missing'])
    expect(JSON.stringify(dumps)).toBe(before)
    expect(result.aliases).toEqual({ a: 'a', b: 'a' })
    expect(result.pending).toEqual(['a'])
    expect(result.dumps[0]!.sp * 4 + result.dumps[0]!.t).toBe(17)
    const again = normalizeSupplyDumps(result.dumps, result.groups, result.pending)
    expect(again.dumps).toEqual(result.dumps)
    expect(again.pending).toEqual(result.pending)
    expect(again.merged).toBe(0)
  })
  it('不同归属不合并，保留每笔金额；同归属合并后删除失效归属键', () => {
    expect(normalizeSupplyDumps(dumps, { a: 'hoth', b: 'guderian' }, []).dumps).toHaveLength(2)
    const result = normalizeSupplyDumps(dumps, { a: 'hoth', b: 'hoth', missing: 'guderian' }, ['b'])
    expect(result.groups).toEqual({ a: 'hoth' })
    expect(result.pending).toEqual([])
  })
  it('不同阵营同格不归并，苏方不会继承轴方归属元数据', () => {
    const result = normalizeSupplyDumps(
      [dumps[0]!, { ...dumps[1]!, side: 'soviet' as const }],
      { a: 'hoth', b: 'guderian' },
      ['b'],
    )
    expect(result.dumps).toHaveLength(2)
    expect(result.groups).toEqual({ a: 'hoth' })
    expect(result.pending).toEqual([])
  })
})
