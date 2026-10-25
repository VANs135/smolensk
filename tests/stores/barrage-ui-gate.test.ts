import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

/**
 * 用户 2026-10-25 实测 BUG②：**增援的时候点格子可能出现空军轰炸的 UI**
 *
 * 修前地图小窗的「炮击 / 空军轰炸」入口只看"这枚算子有没有印刷轰炸值"（`canBarrage`），
 * **没问环节闸门** ⇒ B 增援段点己方火炮照样给轰炸入口，点了还真会开出轰炸流程。
 * 现在界面一律走 `actionAllowedNow`（与 `requireAction` 同一处判据），不在这环节就不给入口。
 */

function newStore() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

describe('闸门预测 `actionAllowedNow`（与 requireAction 同一口径，无副作用）', () => {
  it('★ B 增援段：轰炸与空中任务都**不**放行', () => {
    const workbench = newStore()
    workbench.setPhase('reinforcement')
    expect(workbench.actionAllowedNow('barrage.declare')).toBe(false)
    expect(workbench.actionAllowedNow('air.mission')).toBe(false)
    // 该段真正该放的是到货落位（13.6）
    expect(workbench.actionAllowedNow('rein.arrival')).toBe(true)
  })

  it('★ C 段轰炸环节：两者都放行（14.7b / 10.0）', () => {
    const workbench = newStore()
    workbench.setPhase('movement')
    const index = workbench.playerSegmentSteps.findIndex((step) => step.id === 'movement.barrage')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(workbench.setSegmentStepIndex(index)).toBe(true)
    expect(workbench.actionAllowedNow('barrage.declare')).toBe(true)
    expect(workbench.actionAllowedNow('air.mission')).toBe(true)
    // 反过来：到货落位不该在这一环节放行
    expect(workbench.actionAllowedNow('rein.arrival')).toBe(false)
  })

  it('★ 地图小窗的轰炸入口**问闸门**（不再只看"有没有印刷轰炸值"）', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).toContain("workbench.actionAllowedNow('barrage.declare')")
    // 空军任务区与"选入任务"也受同一闸门约束（不是只藏了「炮击」一个按钮）
    expect(popover).toContain("workbench.actionAllowedNow('air.mission')")
    expect(popover).toContain('pickedAir.length > 0 && airMissionAllowed')
    expect(popover).toContain('|| !airMissionAllowed')
  })
})
