import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useHotseatStore, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 战斗结算入口按视角方收口（用户 2026-11-18 第 4 条）
 *
 * 现场：视角方只裁显示，战斗窗仍同时摆出攻/守两方的行动值、地形、损失、选项、
 * 撤退与推进按钮 —— 守方玩家能点攻方的宣布按钮，反之亦然。
 *
 * 口径：**只出现本方要决策的那一份**；对手那一份保留一句等待提示，不给控件。
 * （solo 双方都给、验证页 stepwise 全量，见 CombatPanel 的 canActCombatRole。）
 */

const panel = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')

describe('战斗结算：按视角方收口', () => {
  it('行动值：攻/守两侧的选人与宣布各自收口', () => {
    expect(panel).toMatch(
      /combat:ar:attacker[\s\S]{0,400}canActCombatRole\('attacker'\)[\s\S]{0,900}攻方 AR 单位/,
    )
    expect(panel).toMatch(
      /combat:ar:defender[\s\S]{0,400}canActCombatRole\('defender'\)[\s\S]{0,900}守方 AR 单位/,
    )
  })

  it('地形：攻方堆叠选项只给攻方，守方地形只给守方', () => {
    expect(panel).toMatch(/canActCombatRole\('attacker'\)[\s\S]{0,200}combatStackTerrainOptions/)
    expect(panel).toMatch(/canActCombatRole\('defender'\)[\s\S]{0,200}combatDefenderTerrainOptions/)
  })

  it('强制损失 / 选项：按当前结算方的归属收口', () => {
    expect(panel).toMatch(/combat:losses[\s\S]{0,2000}v-if="canActResolver"/)
    expect(panel).toMatch(/combat:options[\s\S]{0,2000}v-if="canActResolver"/)
  })

  it('撤退：按撤退计划方的归属收口', () => {
    expect(panel).toMatch(
      /canActCombatRole\(retreatPlan\.side\)[\s\S]{0,1200}confirmCombatRetreats/,
    )
  })

  it('战后推进：只给攻方', () => {
    expect(panel).toMatch(
      /combat:advance[\s\S]{0,400}canActCombatRole\('attacker'\)[\s\S]{0,4000}confirmCombatAdvance/,
    )
  })

  it('状态栏（流程条）：PVE 轮到 AI 时不摆「推进」', () => {
    const strip = readFileSync('src/components/session/FlowStrip.vue', 'utf8')
    expect(strip).toContain('aiTurnHidden')
    expect(strip).toMatch(/v-if="showAdvance"/)
  })

  it('resolverRole 跟着结算段走，PVE 不把 AI 那一侧算成可操作', () => {
    setActivePinia(createPinia())
    const w = useWorkbenchStore()
    const hotseat = useHotseatStore()
    const mapView = useMapViewStore()

    hotseat.mode = 'pve'
    hotseat.aiSide = 'axis'
    hotseat.setViewerSide('soviet')
    w.activeSide = 'axis'
    w.combatState = {
      step: 'declareAr',
      composition: { attackerIds: [], defenderIds: [], attackerHexes: [], defenderHexes: [] },
      resolution: { stage: 'attackerAr' },
    } as unknown as typeof w.combatState

    expect(mapView.resolverRole).toBe('attacker')
    expect(mapView.canActResolver).toBe(false)
  })
})
