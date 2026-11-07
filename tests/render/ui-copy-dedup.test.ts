import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

const airPanel = () => read('src/components/air/AirPanel.vue')
const combatPanel = () => read('src/components/combat/CombatPanel.vue')
const supplyPanel = () => read('src/components/supply/SupplyPanel.vue')
const movePanel = () => read('src/components/move/MovePanel.vue')
const reinforcementPanel = () => read('src/components/reinforcement/ReinforcementPanel.vue')
const barragePanel = () => read('src/components/barrage/BarragePanel.vue')

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

describe('U0：同一信息全界面只出现一次', () => {
  it('9.11c 原文只出现一处（战斗面板两段逐字重复已合并）', () => {
    expect(occurrences(combatPanel(), '第一点必须由 AR 单位承受')).toBe(1)
  })

  it('撤退三色说明只出现一处（标题不再复述正文）', () => {
    const panel = combatPanel()
    expect(occurrences(panel, '青绿＝可撤退')).toBe(1)
    expect(occurrences(panel, '暗红＝必被消灭')).toBe(1)
  })

  it('12.3b-A 的「只能送即用补给」只出现一处', () => {
    expect(occurrences(supplyPanel(), '只能送**需要立即使用**的补给')).toBe(1)
  })

  it('12.6「只对战斗单位要求追溯补给」只出现一处', () => {
    expect(occurrences(supplyPanel(), '只对战斗单位要求追溯补给')).toBe(1)
  })

  it('专规 2.4 的「被锁的师不能移动」只出现一处', () => {
    expect(occurrences(reinforcementPanel(), '被锁的师**不能移动')).toBe(1)
  })

  it('12.5a 的「轮式/履带战斗单位」原文只出现一处', () => {
    expect(occurrences(movePanel(), '轮式/履带**战斗单位**')).toBe(1)
  })

  it('空军「停在空军基地格」只出现一处', () => {
    expect(occurrences(airPanel(), '飞机停在空军基地格')).toBe(1)
  })

  it('空军任务「每机每阶段一次」只出现一处', () => {
    expect(occurrences(airPanel(), '每机每阶段一次')).toBe(1)
  })

  it('付款来源标题跨面板共用同一短词', () => {
    expect(read('src/components/base/copy.ts')).toContain('paySource')
    expect(movePanel()).toContain('UI_COPY.paySource')
    expect(supplyPanel()).toContain('UI_COPY.paySource')
    expect(occurrences(movePanel(), '付款补给站（12.5c-A')).toBe(0)
    expect(occurrences(supplyPanel(), '付款补给站（12.3b')).toBe(0)
  })

  it('轰炸面板不再复述空军任务流程（由空军面板承载）', () => {
    expect(barragePanel()).not.toContain('空军任务（轰炸 / 低空扫射）请点')
  })
})

describe('U0：条款号只进 `?`，不进正文', () => {
  it('RuleTip 组件存在并从 base 出口导出', () => {
    expect(read('src/components/base/RuleTip.vue')).toContain('<details')
    expect(read('src/components/base/index.ts')).toContain('RuleTip')
  })

  it('被合并的段落用 RuleTip 承载条款号', () => {
    expect(combatPanel()).toContain('<RuleTip')
    expect(supplyPanel()).toContain('<RuleTip')
    expect(movePanel()).toContain('<RuleTip')
    expect(reinforcementPanel()).toContain('<RuleTip')
  })

  it('被合并的正文不再出现条款号字样', () => {
    const panel = combatPanel()
    expect(panel).not.toContain('9.11c：第一点必须')
    expect(movePanel()).not.toContain('燃料（12.5）：12.5a')
  })
})

describe('U0：人员空投死入口下线', () => {
  it('单位货物 picker 只在空运任务渲染（空投整块不渲染）', () => {
    const panel = airPanel()
    // 空运分支：保留 14.9 的单位运输能力
    expect(panel).toContain("airMissionKind === 'air_transport'")
    // 空投分支：14.10b 的计划/执行回合只在空投下出现
    expect(panel).toContain("airMissionKind === 'air_drop'")
    // 旧的「空运或空投」合并门不再包住单位货物
    expect(panel).not.toContain('isCargoMission')
  })

  it('空投给出 `?` 说明，且不再渲染单位货物标题', () => {
    expect(airPanel()).toContain('人员空投本作不启用')
    expect(occurrences(airPanel(), '14.10a：空投的战斗单位')).toBe(0)
  })

  it('界面源码不再出现 N/A 字样', () => {
    for (const path of [
      'src/components/air/AirPanel.vue',
      'src/components/combat/CombatPanel.vue',
      'src/components/supply/SupplyPanel.vue',
      'src/components/move/MovePanel.vue',
      'src/components/reinforcement/ReinforcementPanel.vue',
      'src/components/barrage/BarragePanel.vue',
    ]) {
      expect(read(path), path).not.toContain('N/A')
    }
  })
})
