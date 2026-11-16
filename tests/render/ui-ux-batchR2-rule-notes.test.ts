import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 批 R2（用户 2026-11-16）：**窗内不放规则长段，条款号收进 `?`**。
 *
 * 移动窗已有「结束 / 撤销 / 放弃」的 RuleNote（不得回退）；
 * 补给窗开头那段 12.0 流程说明此前直接铺在窗内，现收进 `?`，窗内只留操作。
 */
const supply = readFileSync(
  new URL('../../src/components/supply/SupplyPanel.vue', import.meta.url),
  'utf8',
)

describe('R2：补给窗规则长段收进 ?', () => {
  it('12.0 流程说明在 RuleNote 里，不再直接铺在窗内', () => {
    expect(supply).not.toMatch(
      /<p v-if="!workbench\.supplyActive && props\.only === null" class="muted">/,
    )
    expect(supply).toMatch(
      /<RuleNote[^>]*>[\s\S]{0,400}开启后按 12\.0 章逐步结算[\s\S]{0,400}<\/RuleNote>/,
    )
  })

  it('移动窗的结束 / 撤销 / 放弃说明仍在 RuleNote（回归守卫）', () => {
    const move = readFileSync(
      new URL('../../src/components/move/MovePanel.vue', import.meta.url),
      'utf8',
    )
    expect(move).toMatch(/<RuleNote title="结束 \/ 撤销 \/ 放弃本次移动"/)
  })
})
