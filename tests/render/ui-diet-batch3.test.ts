import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 界面收尾·批 3 守卫：不可用项不出现
 *
 * 用户 2026-11-15 口径：
 *   · 不可用项直接不出现；只有「唯一推进口」才允许用状态行写原因；
 *   · 能点地图解决的，不做下拉 / 手输。
 *
 * 豁免：BaseButton 自身的 disabled 入参、UiField 的步进器，以及正由其他线
 * 收尾的 AirPanel / BarragePanel / FuelPanel / OpsFlowPanel。
 *
 * ReinforcementPanel 的置灰清理已在工作副本里做完，但该文件此刻正被增援线重写
 * （v7.1 第二段），等那边提交后再补进 SWEPT，避免两边互相覆盖。
 */

const read = (path: string): string => readFileSync(path, 'utf8')

const SWEPT = [
  'src/components/setup/SetupPanel.vue',
  'src/components/move/MovePanel.vue',
  'src/components/ops/OpsLossPicker.vue',
  'src/components/supply/SupplyPanel.vue',
  'src/components/supply/SupplyPhasePanel.vue',
  'src/components/session/SettlementLogPanel.vue',
  'src/components/session/SessionStep.vue',
  'src/components/session/FlowStrip.vue',
  'src/components/combat/CombatPanel.vue',
  'src/components/exclusive/ExclusiveRulesPanel.vue',
  'src/components/game/CounterOrderPanel.vue',
  'src/components/game/DecisionQueue.vue',
  'src/components/map/MapDock.vue',
  'src/components/containers/ContainersPanel.vue',
  'src/views/GameTableView.vue',
  'src/views/WorkbenchView.vue',
]

const readOnlyHexInputs = [
  'v-model="workbench.convertTargetHexText"',
  'v-model="workbench.supplySourceDraft.hexText"',
  'v-model="workbench.railGaugeTargetHexText"',
]

describe('批 3：不可用项不出现', () => {
  it('清点范围内的窗口不再出现 :disabled 灰按钮', () => {
    for (const path of SWEPT) {
      expect(read(path), `${path} 仍含 :disabled`).not.toContain(':disabled=')
    }
  })

  it('SupplyPanel 的格号只由地图点选，不再留手输框', () => {
    const supply = read('src/components/supply/SupplyPanel.vue')
    for (const binding of readOnlyHexInputs) {
      expect(supply, `SupplyPanel 仍含 ${binding}`).not.toContain(binding)
    }
    expect(supply).toContain('beginConvertTargetHexPickNow')
    expect(supply).toContain('beginSupplySourceHexPickNow')
    expect(supply).toContain('beginRailGaugeTargetHexPickNow')
  })

  it('SupplyPanel 的延补队型号与补给源类别改用按钮，不用下拉', () => {
    const supply = read('src/components/supply/SupplyPanel.vue')
    expect(supply).not.toContain('<select v-model="convertKind"')
    expect(supply).not.toContain('<select v-model="workbench.supplySourceDraft.kind"')
    expect(supply).toContain('CONVERT_KINDS')
    expect(supply).toContain('SOURCE_KINDS')
  })

  it('SupplyPanel 的算子图阵列不再出现置灰项（已试过的站直接不出现）', () => {
    const supply = read('src/components/supply/SupplyPanel.vue')
    expect(supply).not.toContain('disabledReason')
    expect(supply).toContain('dumpDestructionAttempts')
  })

  it('唯一推进口仍是状态行，不是灰按钮', () => {
    const flow = read('src/components/session/FlowStrip.vue')
    expect(flow).toContain('bar__block')
    expect(flow).not.toContain(':disabled="!flow.canAdvance')
  })

  it('关闭语义为 refused 时收掉关闭按钮，不摆禁用叉', () => {
    const dock = read('src/components/map/MapDock.vue')
    expect(dock).toContain('v-if="props.closePolicy !== \'refused\'"')
    expect(dock).not.toContain(':disabled=')
  })
})
