import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { createAiMemory, runAiStep, type AiContext } from '@/ai/driver'
import { useGameSessionStore, useHotseatStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * PVE 初设：一方确认后交棒给另一方，且双方各用自己那一份 UI（用户 2026-11-18 第 5 条）
 *
 * 现场：玩 PVE 苏联，轴心先初设；轴心落完后苏联这一侧无法继续初设。口径：
 *   · 游标在谁身上，窗口就只归谁：对手的「必做事项 / 布置卡 / 按钮」一律不出现；
 *   · 一方确认 ⇒ 自动交棒给另一方；双方都确认才收束；
 *   · 落位入口也按游标拒绝对手的条目（挡住残留卡片 / 误点）。
 */

function mountPve(scenarioId: string, aiSide: 'axis' | 'soviet') {
  setActivePinia(createPinia())
  const setup = useSetupStore()
  const hotseat = useHotseatStore()
  const workbench = useWorkbenchStore()
  const session = useGameSessionStore()
  hotseat.setMode('pve')
  hotseat.setAiSide(aiSide)
  expect(setup.enterSetup(scenarioId)).toBe(true)
  const ctx: AiContext = { workbench, session, setup }
  return { setup, hotseat, workbench, session, ctx }
}

describe('PVE 初设：交棒与单方窗口', () => {
  it('轴心先布设 ⇒ AI 确认后游标交给苏联；苏联窗口只列苏联自己的条目', () => {
    const { setup, ctx, hotseat } = mountPve('3', 'axis')
    expect(setup.setupSideCursor).toBe('axis')
    expect(hotseat.playerSide).toBe('soviet')

    const memory = createAiMemory()
    for (let i = 0; i < 4; i += 1) runAiStep(ctx, { memory, control: 'axis' })
    expect(setup.setupSideConfirmed.axis).toBe(true)
    expect(setup.setupSideCursor).toBe('soviet')

    // 单方投影：必做事项里不再出现轴心的卡车 / SP 归属
    expect(setup.sideSetupIssues.every((issue) => issue.side === 'soviet')).toBe(true)
    expect(setup.sideSetupIssues.some((issue) => issue.id === 'sideConfirmation')).toBe(true)

    // 苏联侧确实有可布设的条目（不是空白窗）
    expect(setup.pendingPlacement.some((item) => item.side === 'soviet')).toBe(true)
  })

  it('苏联先布设的剧本：反向也成立（AI 苏联确认后，轴心窗口只见轴心条目）', () => {
    const { setup, ctx } = mountPve('1', 'soviet')
    expect(setup.setupSideCursor).toBe('soviet')
    const memory = createAiMemory()
    for (let i = 0; i < 4; i += 1) runAiStep(ctx, { memory, control: 'soviet' })
    expect(setup.setupSideCursor).toBe('axis')
    expect(setup.sideSetupIssues.every((issue) => issue.side === 'axis')).toBe(true)
  })

  it('落位入口冻结已确认的对手侧（交棒后不能回头改对方的布置）', () => {
    const { setup, ctx } = mountPve('3', 'axis')
    const axisSelf = setup.pendingPlacement.find(
      (item) => item.side === 'axis' && item.kind === 'self' && item.remaining > 0,
    )
    expect(axisSelf).toBeDefined()

    const memory = createAiMemory()
    for (let i = 0; i < 4; i += 1) runAiStep(ctx, { memory, control: 'axis' })
    expect(setup.setupSideCursor).toBe('soviet')
    expect(setup.setupSideConfirmed.axis).toBe(true)

    expect(setup.beginSelfPlacement(axisSelf!.entryIndex)).toBe(false)
    expect(setup.placing).toBeNull()
    expect(String(setup.lastAction?.detail ?? '')).toContain('不能操作轴心国')
    // 苏联自己的条目仍可开（不是把整条入口关死）
    const sovietSelf = setup.pendingPlacement.find(
      (item) => item.side === 'soviet' && item.kind === 'self' && item.remaining > 0,
    )
    if (sovietSelf !== undefined) {
      expect(setup.beginSelfPlacement(sovietSelf.entryIndex)).toBe(true)
      setup.cancelPlacement()
    }
  })

  it('确认一方后才换手，双方都确认才收束', () => {
    const { setup, ctx } = mountPve('3', 'axis')
    const memory = createAiMemory()
    for (let i = 0; i < 4; i += 1) runAiStep(ctx, { memory, control: 'axis' })
    expect(setup.setupSideCursor).toBe('soviet')

    expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupSideCursor).toBeNull()
  })

  it('初设窗源码守卫：按游标只画一方，并把必做事项切成单方投影', () => {
    const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    expect(queue).toContain('cursorWindowForViewer')
    expect(queue).toContain('setup.sideSetupIssues')
    expect(queue).toContain('queue__wait')
  })
})
