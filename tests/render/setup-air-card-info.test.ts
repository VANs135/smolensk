import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * ★ 用户 2026-11-16（批 G）/ 2026-11-19：**初设飞机按四个面分栏**
 *
 * 前口径（2026-11-16）是「激活 / 未激活」两栏；现口径把减损独立成面：
 * 激活/未激活 × 完好/减损 = 四栏，栏头写面与枚数，栏内仍是逐枚算子阵列。
 */
describe('初设飞机：按四个面分栏', () => {
  const source = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')

  it('飞机不再写「机型 · 激活态」文字行，改为四栏', () => {
    expect(source).toContain("activeRow.key === 'air'")
    expect(source).toContain('queue__air')
    expect(source).toContain('airFaceSections')
    expect(source).not.toContain('airCardText')
    expect(source).not.toContain('airStatusText')
  })

  it('栏头是四类面，栏内是逐枚算子阵列', () => {
    expect(source).toContain("label: '激活 · 完好'")
    expect(source).toContain("label: '激活 · 减损'")
    expect(source).toContain("label: '未激活 · 完好'")
    expect(source).toContain("label: '未激活 · 减损'")
    expect(source).toContain('queue__air-col-head')
    expect(source).toContain('v-for="chip in group.chips"')
  })
})
