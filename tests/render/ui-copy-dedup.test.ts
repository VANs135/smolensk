import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

const airPanel = () => read('src/components/air/AirPanel.vue')
const combatPanel = () => read('src/components/combat/CombatPanel.vue')
const supplyPanel = () => read('src/components/supply/SupplyPanel.vue')
const movePanel = () => read('src/components/move/MovePanel.vue')
const fuelPanel = () => read('src/components/fuel/FuelPanel.vue')
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
    // 用户 2026-11-10：付款区移到加油窗 ⇒ 原文只在 FuelPanel 出现一次（移动窗不再复述）
    expect(occurrences(fuelPanel(), '轮式/履带**战斗单位**')).toBe(1)
    expect(occurrences(movePanel(), '轮式/履带**战斗单位**')).toBe(0)
  })

  it('空军「停在空军基地格」只出现一处', () => {
    expect(occurrences(airPanel(), '飞机停在空军基地格')).toBe(1)
  })

  it('空军任务「每机每阶段一次」只出现一处', () => {
    expect(occurrences(airPanel(), '每机每阶段一次')).toBe(1)
  })

  it('付款来源标题跨面板共用同一短词', () => {
    expect(read('src/components/base/copy.ts')).toContain('paySource')
    // 用户 2026-11-10：加油付款在 FuelPanel（右键入口），不动 SupplyPanel 的支付
    expect(fuelPanel()).toContain('UI_COPY.paySource')
    expect(supplyPanel()).toContain('UI_COPY.paySource')
    expect(occurrences(fuelPanel(), '付款补给站（12.5c-A')).toBe(0)
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
    expect(fuelPanel()).toContain('<RuleTip')
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

describe('U1-c：战斗窗减负', () => {
  it('战斗面板不再有「其他入口」与九步清单', () => {
    const panel = combatPanel()
    expect(panel).not.toContain('其他入口')
    expect(panel).not.toContain('九步清单')
    expect(panel).not.toContain('一键查表')
    expect(panel).not.toContain('九步完整流程')
    expect(panel).not.toContain('setBattleMode')
  })

  it('付款仍可走：来源声明 + 确认按钮 + 9.5b 参战攻方阵列都在', () => {
    const panel = combatPanel()
    expect(panel).toContain('declaredDumpOf')
    expect(panel).toContain('confirmCombatSupply')
    expect(panel).toContain('toggleCombatSupplyAttacker')
    expect(panel).toContain('defenderProvides')
    expect(panel).toContain('attackerUsesInternalStocks')
    expect(panel).toContain('defenderUsesInternalStocks')
    expect(panel).toContain('<RuleTip rule="9.5 / 12.4">')
  })

  it('折扣勾选用极短标签，不再挂解释段落', () => {
    const panel = combatPanel()
    expect(panel).toContain('守方支付')
    expect(panel).not.toContain('不勾＝拒付')
    expect(panel).not.toContain('（12.10a；用一次降一级，12.10b）')
    expect(panel).not.toContain('（12.10a；须同时勾"守方支付战斗补给"）')
  })
})

describe('U3：点格气泡不再展示内部状态', () => {
  it('战斗小窗删掉 9.2 当前步与九步结算说明', () => {
    const src = read('src/components/game/MapActionPopover.vue')
    expect(src).not.toContain('九步结算的输入在')
    expect(src).not.toContain('9.2 当前步')
    expect(src).not.toContain('青绿＝安全格')
    expect(src).toContain("step === 'advance'")
  })

  it('战斗会话中只有推进格保留辅助小窗', () => {
    const src = read('src/stores/map-view.ts')
    expect(src).toContain("sessionKindAfter === 'combat' && workbench.combatLiveStep !== 'advance'")
  })
})
