import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import {
  useContainersStore,
  useGameSessionStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 读档后「会话已建、初设未完成」时，ch10/ch11 的抽签入口必须还在
 *
 * 现场（2026-11-15 对局台实点）：存档里 `game.session !== null` 而 `setup.finished === false`
 * （验证页「回合开始检查」或早期读档会产生这种档），初设栏剩两条 `draw:*` 必做事项：
 *   · 「抽取编队」入口把「有会话」当成「已开局」⇒ 永不出现；
 *   · 执行器与抽签算法又都硬拒「开局后抽签」⇒ 玩家读档后**永远**补不上这条强制效果。
 *
 * 口径：门只按**初设是否完成**（`setup.finished`）判，不按「有没有建会话」判；
 * 会话已建但初设未完成时，确认只确认、抽签照做，别让人卡死。
 */
describe('ch10：会话已建但初设未完成时的抽签入口', () => {
  function boot() {
    setActivePinia(createPinia())
    const setup = useSetupStore()
    const containers = useContainersStore()
    const workbench = useWorkbenchStore()
    const game = useGameSessionStore()
    game.setScenarioId('1')
    containers.setScenario('1')
    expect(setup.selectScenario('1')).toBe(true)
    // 复刻「验证页 · 回合开始检查 / 早期读档」的现场：先有会话，初设还没收束
    expect(game.startGame(workbench.seed)).toBe(true)
    workbench.initialSetupInProgress = true
    return { setup, containers }
  }

  it('★ 确认初设只确认：不提前收束，抽签入口随即出现（修前永不出现）', () => {
    const { setup } = boot()
    expect(setup.finished).toBe(false)
    for (let guard = 0; setup.setupSideCursor !== null && guard < 3; guard++)
      expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(false)

    expect(setup.startGameNow(), setup.lastAction?.detail).toBe(true)
    expect(setup.setupConfirmed).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(true)
  })

  it('★ 点「抽取编队」能真抽：两组都落账，draw:* 义务消失', () => {
    const { setup, containers } = boot()
    for (let guard = 0; setup.setupSideCursor !== null && guard < 3; guard++)
      expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.startGameNow(), setup.lastAction?.detail).toBe(true)
    expect(setup.drawSetupEffectsNow(), setup.lastAction?.detail).toBe(true)
    expect(containers.setupDrawsExecuted).toBe(true)
    expect(setup.requiredSetupIssues.filter((issue) => issue.id.startsWith('draw:'))).toHaveLength(0)
  })
})
