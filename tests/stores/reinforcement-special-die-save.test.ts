import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useContainersStore, useGameSessionStore, useWorkbenchStore } from '@/stores'
import { createMemoryStorage } from '@/shared'

/**
 * v10：1.6c 的已掷骰面作为**输入**进盘面快照
 *
 * 修前只存 `lastVariableRepl`（结果）而不存骰面：B 段中途存档→读档后，
 * 面板仍显示自动掷出的 1.6c 结果，但「掷骰检定」会另掷一颗并按新结果入账。
 * 本用例走真实 saveNow/loadNow，确认骰面往返不变。
 */
describe('v10：1.6c 骰面随存档往返', () => {
  it('存档→读档后同一回合的特殊补员骰面不变', () => {
    setActivePinia(createPinia())
    const w = useWorkbenchStore()
    const game = useGameSessionStore()
    game.setSaveStorage(createMemoryStorage())
    game.startGame()
    // 先手已定：否则 records 会出现「reinforcement + 无先手方」，读档校验（2.2）会正当拒读
    game.patchRecords({ activeSide: 'axis', firstPlayer: 'axis' })

    w.setScenarioId('1')
    w.setActiveSide('axis')
    w.setTurn(2)
    w.setPhase('reinforcement')
    w.variableReplInputs.autoRoll = true
    expect(w.rollVariableReplNow()).toBe(true)
    const die = w.variableReplSpecialDie
    expect(die).not.toBeNull()

    expect(game.saveNow()).toBe(true)
    w.variableReplSpecialDie = null
    expect(game.loadNow()).toBe(true)
    expect(w.variableReplSpecialDie).toBe(die)
  })

  it('旧档（v9，缺骰面键）照常读入，读成 null 而不是报错', () => {
    setActivePinia(createPinia())
    const w = useWorkbenchStore()
    w.setScenarioId('1')
    w.setActiveSide('axis')
    w.setTurn(2)
    w.setPhase('reinforcement')
    w.variableReplInputs.autoRoll = true
    expect(w.rollVariableReplNow()).toBe(true)
    expect(w.variableReplSpecialDie).not.toBeNull()

    const snapshot = w.snapshotBoard() as {
      version: number
      fields: Record<string, unknown>
    }
    delete snapshot.fields.variableReplSpecialDie
    snapshot.version = 9
    w.restoreBoard(snapshot, true)
    expect(w.variableReplSpecialDie).toBeNull()
  })
})

/**
 * 1.6c 与「补员表」这一环的先后（19 Aug 前每回合必掷）
 *
 * 进 B 段时引擎在**到达环**自动掷 1.6b（1.6c 因时机闸还没轮到）⇒ 只掷了表、没掷 1.6c；
 * 1.6c 的唯一入口是补员表这一环的「掷骰检定」。若这一环只看 `variableReplRolled` 就允许
 * 完成，玩家跳过 1.6c 后该环消失 ⇒ 手牌永久显示"判定阶段还没走完：1.6c 特殊补员还没掷"，
 * 补给列车 2 SP 再也落不下去（实测：turn 4 的补给列车卡在手牌上）。
 */
describe('1.6c：没掷完不得完成补员表这一环', () => {
  it('补员表 ack 以 1.6c 已掷为前提；掷完才放行', () => {
    setActivePinia(createPinia())
    const w = useWorkbenchStore()
    const containers = useContainersStore()
    w.setScenarioId('1')
    w.setActiveSide('axis')
    w.setTurn(4)
    w.setPhase('reinforcement')
    w.setSegmentStepIndex(0) // 到达环：自动掷 1.6b
    w.variableReplInputs.autoRoll = true
    expect(w.rollVariableReplNow()).toBe(true)
    expect(w.hasSpecialReplDraw('axis', 4)).toBe(false)

    w.setSegmentStepIndex(1) // 掷骰宿主
    expect(w.acknowledgeReinforcementStepNow('reinforce:replTable')).toBe(false)

    expect(containers.drawSpecialRepl('axis', 3)).toBe(true)
    expect(w.hasSpecialReplDraw('axis', 4)).toBe(true)
    expect(w.acknowledgeReinforcementStepNow('reinforce:replTable')).toBe(true)
  })
})
