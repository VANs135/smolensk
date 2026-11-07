import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * P5（UI4/UI5 反馈缺口）的**源码守卫**（仓库不挂组件渲染测试）
 *
 * 钉住对局台四个面板必须显示、且必须**读 store 投影**而不是自己重算的反馈：
 *   ① `MovePanel`：移动额度（`moveBudgetRows`）/ 悬停路径（`hoverNode`）/ 单步预览（`stepPreview`）；
 *   ② `SupplyPanel`：付款后余额（`summary.pickup.sourceAfter` / `summary.oos.holdingsAfter`）；
 *   ③ `CombatPanel` / `BarragePanel`：「须完成结算」（`combatCancelBlocker` / `barrageCancelBlocker`）。
 */
describe('P5：对局台反馈投影（源码守卫）', () => {
  it('MovePanel：读 store 的额度 / 悬停 / 单步预览，不自己算额度', () => {
    const movePanel = readFileSync('src/components/move/MovePanel.vue', 'utf8')
    expect(movePanel).toContain('workbench.moveBudgetRows')
    expect(movePanel).toContain('workbench.hoverNode')
    expect(movePanel).toContain('workbench.stepPreview')
    expect(movePanel).toContain('剩余')
    expect(movePanel).toContain('预览不扣 MP')
    // 额度判据的唯一定义在引擎 `availableMaOf`（store 投影）；组件不得再算一份
    expect(movePanel).not.toContain('availableMaOf(')
  })

  it('SupplyPanel：结果摘要显示付款后余额（结构化字段，不是只贴 detail 文本）', () => {
    const supplyPanel = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    expect(supplyPanel).toContain('付款后余额')
    expect(supplyPanel).toContain('summary.pickup.sourceAfter')
    expect(supplyPanel).toContain('summary.oos.holdingsAfter')
  })

  it('CombatPanel：显示「须完成结算」与 store 的唯一判据', () => {
    const combatPanel = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    expect(combatPanel).toContain('combatCancelBlocker')
    expect(combatPanel).toContain('须完成结算')
  })

  it('BarragePanel：显示「须完成结算」与 store 的唯一判据', () => {
    const barragePanel = readFileSync('src/components/barrage/BarragePanel.vue', 'utf8')
    expect(barragePanel).toContain('barrageCancelBlocker')
    expect(barragePanel).toContain('须完成结算')
  })
})
