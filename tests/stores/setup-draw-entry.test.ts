import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** 用户 2026-11-11（体检 A 组·第 3 条）：过期「尚未接线」告示不得回填。 */

describe('过期文案：尚未接线', () => {
  it('SupplyPanel 不再声称运输点数货物 / 13.3g 例外未接线', () => {
    const supply = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    expect(supply).not.toContain('尚未接线')
    expect(supply).not.toContain('运输点数作为铁路货物')
  })
})
