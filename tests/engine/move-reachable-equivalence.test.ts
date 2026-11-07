import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { reachableSnapshots } from './move-reachable-fixture'

/**
 * A 闸门：可达格 BFS 的等价性
 *
 * 基线由**优化前代码**生成并固化在 `fixtures/move-reachable-baseline.txt`，
 * 覆盖开阔地/道路/过河/EZOC（抵消与未抵消）/敌方占格/战略断补/预备+工事/最小移动/边界。
 * 任何优化都必须是等价变换：本文件逐字符比对，不允许更新基线来「修绿」。
 */
const BASELINE = readFileSync(
  new URL('./fixtures/move-reachable-baseline.txt', import.meta.url),
  'utf8',
)

describe('可达格 BFS 等价性（性能优化 A）', () => {
  it('基线覆盖全部 10 个场景且含拒绝分支', () => {
    expect(BASELINE).toContain('# S1 步行·开阔地')
    expect(BASELINE).toContain('# S9 边界格')
    expect(BASELINE).toContain('# S10 堆叠两枚')
    expect(BASELINE).toContain('reject mpLocked')
  })

  it('现状输出与基线逐字符一致', () => {
    expect(reachableSnapshots()).toBe(BASELINE)
  })
})
