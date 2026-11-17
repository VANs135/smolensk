import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 批 M3 / R3（用户 2026-11-16；2026-11-18 更正）
 *
 * M3：初设收束的主按钮归并成一个入口 —— 按当前状态只长出一枚，条件与文案仍来自既有投影。
 *     2026-11-18：抽签改为完成初设时自动执行 ⇒ 「抽取编队」不再是一枚按钮。
 * R3：战况抽屉**按段只留一段** —— 增援 / 补给 / 容器三块不再同时挂，只显示当前段那一块。
 */
const queue = readFileSync(
  new URL('../../src/components/game/DecisionQueue.vue', import.meta.url),
  'utf8',
)
const view = readFileSync(new URL('../../src/views/GameTableView.vue', import.meta.url), 'utf8')

describe('M3：初设收束单入口', () => {
  it('主按钮归并为一枚 setupPrimary，不再各摆一块', () => {
    expect(queue).toContain('setupPrimary')
    expect(queue).toContain('@click="setupPrimary.run()"')
    // 抽签自动执行 ⇒ 不再有抽取入口；开始游戏（西移缺落点后）与完成初设仍参与计算
    expect(queue).not.toContain('setup.setupDrawEntryVisible')
    expect(queue).toContain('setup.setupStartEntryVisible')
    expect(queue).not.toContain('setup.drawSetupEffectsNow()')
    // 唯一保留的 startGameNow 是「放弃以上未布设单位 → 确认放弃并开局」，不是主入口
    expect(queue.match(/@click="setup\.startGameNow\(\)"/g) ?? []).toHaveLength(1)
    expect(queue).toContain('确认放弃并开局')
  })

  it('只剩「开始游戏 / 完成初设」两个标签（抽签已自动）', () => {
    for (const label of ['开始游戏', '完成初设']) expect(queue).toContain(label)
    expect(queue).not.toContain('抽取编队')
  })
})

describe('R3：状态抽屉按段只留一段', () => {
  it('增援 / 补给 / 容器走同一条 v-if 链，只显示当前段一块', () => {
    expect(view).toMatch(
      /v-if="workbench\.phase === 'reinforcement'[\s\S]{0,200}<ReinforcementPanel only="info" \/>/,
    )
    expect(view).toMatch(
      /v-else-if="workbench\.phase === 'supply'"[\s\S]{0,120}<SupplyPanel only="ledger" \/>/,
    )
    expect(view).toMatch(/<ContainersPanel v-else only="info" \/>/)
  })
})
