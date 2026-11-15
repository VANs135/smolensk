import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useGameSessionStore, useWorkbenchStore } from '@/stores'

/**
 * 「进入下一环节」在初设未收束时**不得静默返回**
 *
 * 现场（2026-11-15 对局台实点）：读到一份「会话已建、初设未收束」的档后，
 * `workbench.initialSetupInProgress === true`，`advanceSegmentNow()` 第一行就 `return null`，
 * 既不写 `advanceBlocked` 也不落日志 —— 按钮看着可点、点了完全没反应，玩家无从判断。
 *
 * 这与此前已修的「死操作①」（`WorkbenchView` 2026-11-08：补给检定挡下时静默 `return null`）
 * 是同一类病灶：**每个挡下点都必须给出原因**（流程条就地显示 + 一行 warning 日志）。
 */
describe('初设未收束时的「进入下一环节」', () => {
  function boot() {
    setActivePinia(createPinia())
    const workbench = useWorkbenchStore()
    const game = useGameSessionStore()
    game.setScenarioId('1')
    expect(game.startGame(workbench.seed)).toBe(true)
    // 读档（`setup.restore`：`initialSetupInProgress = !loaded.finished`）与验证页都会置真
    workbench.initialSetupInProgress = true
    return { workbench }
  }

  it('★ 挡下时必须写 advanceBlock 并给出原因（修前静默 return null）', () => {
    const { workbench } = boot()
    expect(workbench.advanceSegmentNow()).toBeNull()
    expect(workbench.advanceBlock).not.toBeNull()
    expect(workbench.advanceBlock?.reason ?? '').toContain('初设')
    expect(workbench.advanceBlock?.rule ?? '').not.toBe('')
  })
})
