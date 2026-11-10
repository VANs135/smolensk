import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { sopStepById } from '@/engine/rules'
import { useContainersStore, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { confirmSetupForStart } from '../flows/setup-harness'

/**
 * ch10 Formation Chit Draw（用户 2026-11-10 裁定）
 *
 * 编队抽取**只发生在初设单位放置完成之后**，之后任何阶段都不应再出现抽取入口/窗口：
 *   · 入口可见条件＝「初设已确认 ∧ 抽签尚未执行」；
 *   · 执行过一次即永久收起；增援段 / 回合开始 / 阶段切换都不再出现；
 *   · 旧的「B 段按环节抽签」分支（`drawAndApplyStepNow` + `rein.formationDraw`）已删除。
 */

function boot() {
  setActivePinia(createPinia())
  const setup = useSetupStore()
  const containers = useContainersStore()
  const workbench = useWorkbenchStore()
  useGameSessionStore().setScenarioId('1')
  containers.setScenario('1')
  expect(setup.selectScenario('1')).toBe(true)
  return { setup, containers, workbench }
}

describe('ch10：编队抽取只在初设完成后执行一次', () => {
  it('初设确认前不可见 → 确认后出现一次 → 执行后永久收起', () => {
    const { setup, containers } = boot()

    // ① 初设未确认：不可见，且选剧本不再自动抽签
    expect(setup.finished).toBe(false)
    expect(setup.setupDrawEntryVisible).toBe(false)
    expect(containers.setupDrawsExecuted).toBe(false)

    // ② 初设单位放置完成后：出现唯一一次入口（剧本 1 卡车按剧本全满载，只剩双方确认）
    for (let guard = 0; setup.setupSideCursor !== null && guard < 3; guard++)
      expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupPlacementComplete).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(true)
    expect(containers.setupDrawsExecuted).toBe(false)

    // ③ 执行一次 ⇒ 入口收起、账本落定、此时才允许收束初设
    expect(setup.executeSetupDraws()).toBe(true)
    expect(containers.setupDrawsExecuted).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(false)
    expect(setup.finishSetup()).toBe(true)
  })

  it('推进多个回合与增援段后仍不出现，也不再重抽', () => {
    const { setup, containers, workbench } = boot()
    confirmSetupForStart(setup)
    expect(setup.executeSetupDraws()).toBe(true)
    expect(setup.finishSetup()).toBe(true)
    const ledger = JSON.stringify(containers.drawResults)

    for (const turn of [2, 3, 4]) {
      workbench.setTurn(turn)
      for (const phase of ['reinforcement', 'movement', 'combat'] as const) {
        workbench.setPhase(phase)
        workbench.setActiveSide('axis')
        expect(setup.setupDrawEntryVisible).toBe(false)
      }
    }
    // 队内台账不重抽：再点执行也是 no-op
    expect(setup.executeSetupDraws()).toBe(true)
    expect(JSON.stringify(containers.drawResults)).toBe(ledger)
  })

  it('旧「按环节抽签」分支已删除（无 store 入口、无 SOP 环节）', () => {
    const { containers } = boot()
    expect('drawAndApplyStepNow' in containers).toBe(false)
    expect(sopStepById('reinforcement.formationDraw')).toBeNull()
  })

  /**
   * ★ 用户 2026-11-10：「抽取编队」是初设窗里唯一的抽签入口——
   *   点一次＝抽取＋自动落位＋落账；没点就开局不得隐式补做。
   */
  it('★ 抽取编队唯一入口：开局不隐式兜底，按钮文案不带条款号', () => {
    const { setup, containers } = boot()
    // 正向摆完必做项（剧本 1：卡车按剧本全满载、只剩双方确认），但**不点**抽取按钮
    for (let guard = 0; setup.setupSideCursor !== null && guard < 3; guard++)
      expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupPlacementComplete).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(true)
    // 没点按钮 ⇒ 开局被 ch10/ch11 拦下，账本原封不动
    const ledger = JSON.stringify(containers.drawResults)
    expect(setup.startGameNow()).toBe(false)
    expect(setup.lastAction?.rule).toContain('ch10')
    expect(JSON.stringify(containers.drawResults)).toBe(ledger)
    // 点一次 ⇒ 抽取 + 自动落位 + 落账，入口与必做事项同时消失
    expect(setup.executeSetupDraws()).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(false)
    expect(setup.requiredSetupIssues.some((issue) => issue.rule.includes('ch10'))).toBe(false)
    expect(setup.startGameNow()).toBe(true)
    // 源码守卫：唯一入口文案「抽取编队」，条款号只在 title（? 提示）里
    const panel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    expect(panel).toContain('抽取编队')
    expect(panel).not.toContain('执行编队抽取（ch10）')
    const store = readFileSync('src/stores/setup.ts', 'utf8')
    expect(store).not.toContain('if (setupPlacementComplete.value && !runSetupDraws())')
  })
})
