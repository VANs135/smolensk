import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useGameSessionStore, useWorkbenchStore } from '@/stores'
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
