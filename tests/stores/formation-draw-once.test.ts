import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { sopStepById } from '@/engine/rules'
import { useContainersStore, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { confirmSetupForStart } from '../flows/setup-harness'

/**
 * ch10 Formation Chit Draw
 *
 * 编队抽取是**剧本页的纯机械动作**（把编队标记放进杯子随机抽），原文没有给玩家任何取舍：
 *   · 抽取**只发生在初设单位放置完成之后**，确认初设（「完成初设」）时自动执行；
 *   · 抽签后的处置（西移 / Move Mode / Mtr↔Aufk / 进死亡堆）同一笔事务自动落盘；
 *   · 不再有独立的「抽取编队」按钮；执行过一次即永久收起，增援段 / 回合开始 / 阶段切换都不再出现；
 *   · 旧的「B 段按环节抽签」分支（`drawAndApplyStepNow` + `rein.formationDraw`）已删除。
 */

function boot() {
  setActivePinia(createPinia())
  const setup = useSetupStore()
  const containers = useContainersStore()
  const workbench = useWorkbenchStore()
  const game = useGameSessionStore()
  game.setScenarioId('1')
  containers.setScenario('1')
  expect(setup.selectScenario('1')).toBe(true)
  return { setup, containers, workbench, game }
}

describe('ch10：编队抽取只在初设完成后自动执行一次', () => {
  it('初设确认前不抽；点「完成初设」即自动抽取一次并开局；之后不重抽', () => {
    const { setup, containers, game } = boot()

    // ① 初设未确认：未抽签，且选剧本不自动抽签
    expect(setup.finished).toBe(false)
    expect(setup.setupConfirmed).toBe(false)
    expect(containers.setupDrawsExecuted).toBe(false)

    // ② 初设单位放置完成后：仍未抽签（抽签属于初设收束这一笔事务）
    for (let guard = 0; setup.setupSideCursor !== null && guard < 3; guard++)
      expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupPlacementComplete).toBe(true)
    expect(containers.setupDrawsExecuted).toBe(false)

    // ③ 一次点击：确认初设 ⇒ 自动抽签 + 按原文处置 + 开局
    const drawSpy = vi.spyOn(containers, 'runSetupDrawsNow')
    expect(setup.startGameNow(), setup.lastAction?.detail).toBe(true)
    expect(drawSpy).toHaveBeenCalledTimes(1)
    expect(setup.setupConfirmed).toBe(true)
    expect(containers.setupDrawsExecuted).toBe(true)
    expect(setup.finished).toBe(true)
    expect(game.session).not.toBeNull()
    expect(setup.setupDrawEntryVisible).toBe(false)
    drawSpy.mockRestore()
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
   * 用户 2026-11-18：剧本页的抽签是纯机械动作——「编队抽取后该做的一系列操作应该是自动进行的」。
   *   完成初设一次点击＝确认 + 抽取 + 按原文处置 + 落账 + 开局；界面不再给「抽取编队」按钮。
   */
  it('★ 完成初设即自动抽取并开局；界面不再有「抽取编队」按钮', () => {
    const { setup, containers, game } = boot()
    // 正向摆完必做项（剧本 1：卡车按剧本全满载、只剩双方确认）
    for (let guard = 0; setup.setupSideCursor !== null && guard < 3; guard++)
      expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupPlacementComplete).toBe(true)
    expect(containers.setupDrawsExecuted).toBe(false)
    // 一次点击：确认 + 抽取 + 处置 + 开局
    expect(setup.startGameNow(), setup.lastAction?.detail).toBe(true)
    expect(setup.setupConfirmed).toBe(true)
    expect(containers.setupDrawsExecuted).toBe(true)
    expect(game.session).not.toBeNull()
    expect(setup.requiredSetupIssues.some((issue) => issue.rule.includes('ch10'))).toBe(false)
    // 幂等：再点不重抽、不改盘面
    const draws = JSON.stringify(containers.drawResults)
    expect(setup.startGameNow()).toBe(true)
    expect(JSON.stringify(containers.drawResults)).toBe(draws)
    // 源码守卫：地图左上角「初设」栏与初设面板都不再有「抽取编队」入口
    const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    expect(queue).not.toContain('抽取编队')
    expect(queue).not.toContain('setup.drawSetupEffectsNow(')
    expect(queue).not.toContain('setup.setupDrawEntryVisible')
    const panel = readFileSync('src/components/setup/SetupPanel.vue', 'utf8')
    expect(panel).not.toContain('抽取编队')
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
