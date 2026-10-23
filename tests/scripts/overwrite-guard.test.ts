import { describe, expect, it } from 'vitest'

import { decideOverwrite, mergeKeepingOrder, refusalLines } from '../../scripts/overwrite-guard.mjs'

/**
 * 产物覆盖护栏单测（门禁加固 B0①）
 *
 * 护栏要保证两件事：
 *   1. 内容未变时**允许重写**（幂等）——否则使用者会绕过护栏；
 *   2. 内容将变化时**拒绝写入**——否则重跑会静默销毁脚本无法再生的手写数据。
 */
describe('产物覆盖护栏', () => {
  it('首次生成允许写入', () => {
    expect(decideOverwrite({ nextText: 'a', existingText: null })).toEqual({
      ok: true,
      reason: 'firstWrite',
    })
  })

  it('内容相同允许写入（重跑幂等是护栏可被长期遵守的前提）', () => {
    expect(decideOverwrite({ nextText: 'same', existingText: 'same' })).toEqual({
      ok: true,
      reason: 'unchanged',
    })
  })

  it('内容将变化时拒绝写入', () => {
    expect(decideOverwrite({ nextText: 'next', existingText: 'prev' })).toEqual({
      ok: false,
      reason: 'outputWouldChange',
    })
  })

  it('--force 越过护栏', () => {
    expect(decideOverwrite({ nextText: 'next', existingText: 'prev', force: true })).toEqual({
      ok: true,
      reason: 'forced',
    })
  })

  it('拒绝信息包含产物路径与手写块清单，并给出越过的办法', () => {
    const lines = refusalLines({ outFile: 'x.json', preserved: ['surprise 表'] })
    expect(lines[0]).toContain('x.json')
    expect(lines.join('\n')).toContain('surprise 表')
    expect(lines.join('\n')).toContain('--force')
  })

  it('无手写块时不打印多余说明', () => {
    const lines = refusalLines({ outFile: 'x.json' })
    expect(lines.some((line) => line.includes('无法由本脚本再生'))).toBe(false)
  })

  describe('mergeKeepingOrder：合并时必须保持既有键序', () => {
    it('键序不同会让护栏误判为「变化」，故新键只能追加', () => {
      const merged = mergeKeepingOrder({ a: 1, hand: 'keep', z: 3 }, { a: 1, z: 3, fresh: 4 })
      expect(Object.keys(merged)).toEqual(['a', 'hand', 'z', 'fresh'])
      expect(merged.hand).toBe('keep')
      expect(merged.fresh).toBe(4)
    })

    it('同键以新值为准（脚本产出的值覆盖旧的）', () => {
      const merged = mergeKeepingOrder({ a: 1, b: 2 }, { a: 99 })
      expect(merged.a).toBe(99)
      expect(merged.b).toBe(2)
    })

    it('既有键序完整保留（保证重跑文本逐字节相同）', () => {
      const previous = { first: 1, second: 2, third: 3 }
      const merged = mergeKeepingOrder(previous, { third: 3, first: 1, second: 2 })
      expect(Object.keys(merged)).toEqual(Object.keys(previous))
    })
  })
})
