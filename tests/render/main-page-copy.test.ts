import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * UI1-a / UI6-a：正式页与存档对话框的**文案与可用态**
 *
 * - 存档：只承诺真实策略「结算点才可存档」，按钮禁用与否由 store 的
 *   `saveBlockedReason` 投影决定，组件不另算规则。
 * - 正式页与共用面板：不再把内部批次编号（C/W/B）写进可见标题。
 */

const read = (file: string): string => fs.readFileSync(path.resolve(file), 'utf8')

describe('UI1-a：存档文案与可用态', () => {
  it('对话框说明与按钮来自既有 store 事实', () => {
    const src = read('src/components/save/SaveLoadDialog.vue')
    expect(src).toContain('结算点才可存档')
    expect(src).toContain('workbench.saveBlockedReason')
    expect(src).toContain(':disabled="!canSave"')
    // 旧口径「任意环节都可存档」已删除
    expect(src).not.toContain('任意环节都可存档')
  })
})

describe('UI6-a：正式页可见标题不带批次编号', () => {
  it('对局台与存档标题已去批次码', () => {
    expect(read('src/views/GameTableView.vue')).toContain('<BaseTag kind="info">对局台</BaseTag>')
    expect(read('src/components/save/SaveLoadDialog.vue')).not.toContain('存档 / 读档（W7 C15）')
  })

  it('共用面板标题不再以 C/W/B 批次码开头', () => {
    const panels = [
      'src/components/air/AirPanel.vue',
      'src/components/barrage/BarragePanel.vue',
      'src/components/combat/CombatPanel.vue',
      'src/components/reinforcement/ReinforcementPanel.vue',
      'src/components/supply/SupplyPanel.vue',
      'src/components/setup/SetupPanel.vue',
      'src/components/hotseat/ConsensusChecklist.vue',
      'src/components/exclusive/ExclusiveRulesPanel.vue',
      'src/components/containers/ContainersPanel.vue',
      'src/components/session/TerminationNotice.vue',
      'src/components/session/SettlementLogPanel.vue',
    ]
    for (const file of panels) {
      expect(read(file), `${file} 标题仍带批次码`).not.toMatch(/title="[^"]*（(?:C|W|B)\d/)
    }
  })
})
