import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 9.11a：军力损失「改派」的唯一复位入口按需出现
 *
 * 损失屏的「规范分配」按钮作用是把**已改派**的那一点退回规范分配。没改派时它点了什么也不做
 * （`lossTakerId === null` 已是规范分配）——按用户口径「不可用项不出现（不置灰）」，
 * 它只应在确实改派过之后出现，而不是常年摆在那里灰着。
 */
const combatPanel = () => readFileSync('src/components/combat/CombatPanel.vue', 'utf8')

describe('战斗 · 损失改派复位钮', () => {
  it('「规范分配」只在已改派（lossTakerId 非空）时出现', () => {
    const panel = combatPanel()
    // 按钮内的标签行（与上方说明文字「规范分配：」区分开；缩进随角色收口的 <template> 层级变化）
    const labelAt = panel.search(/\n\s+规范分配\n/)
    expect(labelAt).toBeGreaterThan(0)
    const buttonAt = panel.lastIndexOf('<BaseButton', labelAt)
    const snippet = panel.slice(buttonAt, labelAt)
    expect(snippet).toContain('v-if="workbench.combatInputs.lossTakerId !== null"')
    expect(snippet).not.toContain(':disabled="workbench.combatInputs.lossTakerId === null"')
  })
})
