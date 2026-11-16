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

    // ② 初设单位放置完成后：仍不可见（两段式：先确认，后抽签）
    for (let guard = 0; setup.setupSideCursor !== null && guard < 3; guard++)
      expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupPlacementComplete).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(false)
    expect(containers.setupDrawsExecuted).toBe(false)

    // ③ 确认初设（只收束不建会话）⇒ 唯一入口出现
    expect(setup.startGameNow()).toBe(true)
    expect(setup.setupConfirmed).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(true)

    // ④ 执行一次 ⇒ 入口收起、账本落定
    expect(setup.drawSetupEffectsNow()).toBe(true)
    expect(containers.setupDrawsExecuted).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(false)
    expect(setup.finishSetup()).toBe(true)
  })

  // 重活是全量并行跑套件时会被 CPU 争抢：本用例单跑约 2s，并行时曾越过默认 5s；放宽到 20s
  it('推进多个回合与增援段后仍不出现，也不再重抽', () => {
    const { setup, containers, workbench } = boot()
    confirmSetupForStart(setup)
    expect(setup.drawSetupEffectsNow()).toBe(true)
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
    expect(setup.drawSetupEffectsNow()).toBe(true)
    expect(JSON.stringify(containers.drawResults)).toBe(ledger)
  }, 20_000)

  it('旧「按环节抽签」分支已删除（无 store 入口、无 SOP 环节）', () => {
    const { containers } = boot()
    expect('drawAndApplyStepNow' in containers).toBe(false)
    expect(sopStepById('reinforcement.formationDraw')).toBeNull()
  })

  /**
   * ★ 用户 2026-11-10：「抽取编队」是初设窗里唯一的抽签入口——
   *   点一次＝抽取＋自动落位＋落账；没点就开局不得隐式补做。
   */
  it('★ 抽取编队唯一入口：确认后才出现，抽签落账即开局', () => {
    const { setup, containers } = boot()
    // 正向摆完必做项（剧本 1：卡车按剧本全满载、只剩双方确认），但**不点**抽取按钮
    for (let guard = 0; setup.setupSideCursor !== null && guard < 3; guard++)
      expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupPlacementComplete).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(false)
    // 先确认初设：只收束、不建会话、不抽签，账本原封不动
    const ledger = JSON.stringify(containers.drawResults)
    expect(setup.startGameNow()).toBe(true)
    expect(setup.setupConfirmed).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(true)
    expect(JSON.stringify(containers.drawResults)).toBe(ledger)
    // 点一次 ⇒ 抽取 + 自动落位 + 落账 + 开局，入口与必做事项同时消失
    expect(setup.drawSetupEffectsNow()).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(false)
    expect(setup.requiredSetupIssues.some((issue) => issue.rule.includes('ch10'))).toBe(false)
    expect(setup.startGameNow()).toBe(true)
    // 源码守卫：唯一可点入口在地图左上角的「初设」栏（DecisionQueue），文案「抽取编队」
    const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    expect(queue).toContain('抽取编队')
    expect(queue).toContain('setup.drawSetupEffectsNow(')
    // 初设面板与容器窗都不得再有可点入口（全程序只允许一处）
    const panel = readFileSync('src/components/setup/SetupPanel.vue', 'utf8')
    expect(panel).not.toContain('setup.drawSetupEffectsNow(')
    const containersPanel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    expect(containersPanel).not.toContain('setup.drawSetupEffectsNow(')
    const store = readFileSync('src/stores/setup.ts', 'utf8')
    expect(store).not.toContain('if (setupPlacementComplete.value && !runSetupDraws())')
  })
})

/**
 * 用户 2026-11-11：**战况抽屉只留战况** —— 初设面板（一键预设初设与开局选剧本重复）与
 * 专规机制（各机制已做到对应环节）删挂载；一键预设初设挪进地图左上角「初设」栏，
 * 与「抽取编队」同一处，全程序只保留这一处可点。
 */
describe('战况抽屉挂载与一键预设初设唯一入口', () => {
  function statusDrawerSource(): string {
    const view = readFileSync('src/views/GameTableView.vue', 'utf8')
    const start = view.indexOf('id="table-drawer-status"')
    const end = view.indexOf('id="table-drawer-cards"')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return view.slice(start, end)
  }

  it('战况抽屉不再挂初设面板与专规机制，只留战况三块与阶段仪表', () => {
    const drawer = statusDrawerSource()
    expect(drawer).not.toContain('<SetupPanel')
    expect(drawer).not.toContain('<ExclusiveRulesPanel')
    expect(drawer).toContain('<VictoryPanel />')
    // 阶段仪表（2026-11-10 #6）与容器信息（盒子唯一展示）仍保留；
    // R3（2026-11-16）：三块按段只留一段 ⇒ 容器块是链尾的 `v-else`
    expect(drawer).toContain('<ReinforcementPanel only="info" />')
    expect(drawer).toMatch(/<ContainersPanel\s+v-else\s+only="info"\s*\/>/)
  })

  it('一键预设初设只在地图左上角「初设」栏可点', () => {
    const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    expect(queue).toContain('一键预设初设')
    expect(queue).toContain('setup.presetSelfSetupNow(')
    const panel = readFileSync('src/components/setup/SetupPanel.vue', 'utf8')
    expect(panel).not.toContain('setup.presetSelfSetupNow(')
  })
})
