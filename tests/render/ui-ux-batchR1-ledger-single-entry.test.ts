import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 批 R1（用户 2026-11-16）：**同一本台账只留一个入口**。
 *
 * 对局台有两处会挂同一块面板：地图会话（MapDock）与战况抽屉（status）。
 * 会话开着时，同一个「增援与编制」台账不能同时出现在两处（看两遍、改两遍）；
 * 但也不能两边各删一半 —— 没开会话时抽屉仍要能看全。
 */
const view = readFileSync(new URL('../../src/views/GameTableView.vue', import.meta.url), 'utf8')

describe('R1：增援台账单入口', () => {
  it('增援会话开着时，抽屉里的 only="info" 实例让位（不是删除）', () => {
    expect(view).toMatch(
      /v-if="workbench\.phase === 'reinforcement'[\s\S]{0,80}session\?\.kind !== 'reinforce'/,
    )
    expect(view).toContain('<ReinforcementPanel only="info" />')
  })

  it('补给台账不被删掉：抽屉仍有 only="ledger" 的实例', () => {
    expect(view).toContain('<SupplyPanel only="ledger" />')
  })
})
