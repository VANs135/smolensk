import { confirmSetupForStart } from '../flows/setup-harness'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { useContainersStore, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'

function boot({ start = true, confirm = true }: { start?: boolean; confirm?: boolean } = {}) {
  setActivePinia(createPinia())
  const setup = useSetupStore(),
    game = useGameSessionStore(),
    board = useWorkbenchStore()
  const containers = useContainersStore()
  setup.selectScenario('1')
  // 两段式：先确认初设；`start` 决定是否顺手点「抽取编队」把局面真正开起来
  if (confirm) confirmSetupForStart(setup, { draws: false })
  else
    for (let guard = 0; setup.setupSideCursor !== null && guard < 3; guard++)
      expect(setup.confirmSideSetup()).toBe(true)
  if (start) expect(setup.drawSetupEffectsNow()).toBe(true)
  return { setup, game, board, containers }
}

describe('S1：初设收束与开局提交', () => {
  it('2.2：重复开始不能推进已开局的玩家环节、重掷或重复写日志', () => {
    const { setup, game, board } = boot()
    expect(setup.startGameNow()).toBe(true)
    const before = JSON.stringify(game.session)
    const rng = { ...board.rng },
      draws = board.drawCount
    const guidance = game.guidance?.step.id
    expect(setup.startGameNow()).toBe(true)
    expect(setup.startGameNow()).toBe(true)
    expect(JSON.stringify(game.session)).toBe(before)
    expect(game.guidance?.step.id).toBe(guidance)
    expect(board.rng).toEqual(rng)
    expect(board.drawCount).toBe(draws)
  })

  it('开局被拒时回滚盘面与抽签处置、不写台账，修正后可重新抽', () => {
    const { setup, game } = boot({ start: false })
    const rejected = vi.spyOn(game, 'startGame').mockReturnValue(false)
    expect(setup.drawSetupEffectsNow()).toBe(false)
    expect(game.session).toBeNull()
    // 抽签与开局是一笔事务 ⇒ 开局失败不写台账、按钮保留
    expect(setup.setupEffectLedger).toBeNull()
    expect(setup.setupDrawEntryVisible).toBe(true)
    rejected.mockRestore()
    expect(setup.drawSetupEffectsNow()).toBe(true)
    expect(setup.setupEffectLedger).not.toBeNull()
    expect(game.session).not.toBeNull()
  })

  it.each(['finishSetup', 'startGameNow'] as const)(
    'ch10/ch11：%s不能把未完成的编队西移默认跳过；补齐后可开局',
    (action) => {
      const { setup, game, board, containers } = boot({ confirm: false, start: false })
      expect(setup.runSetupDraws()).toBe(true) // 先抽签（不写台账/不开局），再制造缺落点
      const destinations = containers.pendingShiftWestPlacements.map((item) => ({
        id: item.formationId,
        hex: item.hexText!,
      }))
      expect(destinations.length).toBeGreaterThan(0)
      containers.drawShiftHexText = {}
      expect(setup.pendingPlacement.some((item) => item.kind === 'shift')).toBe(true)
      expect(setup.beginShiftPlacement(destinations[0]!.id)).toBe(true)
      const placing = setup.placing
      const before = JSON.stringify(board.units)
      const draws = board.drawCount
      const results = JSON.stringify(containers.drawResults)
      expect(setup[action]()).toBe(false)
      expect(setup.finished).toBe(false)
      expect(game.session).toBeNull()
      expect(setup.placing).toBe(placing)
      expect(setup.lastAction?.detail).toContain('请先完成编队西移放置')
      expect(JSON.stringify(board.units)).toBe(before)
      expect(board.drawCount).toBe(draws)
      expect(JSON.stringify(containers.drawResults)).toBe(results)
      for (const dest of destinations) {
        expect(setup.beginShiftPlacement(dest.id)).toBe(true)
        const [col, row] = dest.hex.split('.').map(Number)
        expect(setup.placeAtHex({ col: col!, row: row! })).toBe(true)
      }
      expect(setup.startGameNow()).toBe(true) // 确认初设（只收束）
      expect(setup.pendingPlacement.some((item) => item.kind === 'shift')).toBe(false)
      expect(setup.drawSetupEffectsNow()).toBe(true) // 抽签 + 开局
      expect(setup.finished).toBe(true)
      expect(setup.notes.join('\n')).not.toContain('留在剧本页原格')
    },
  )

  it('普通未摆单位仍可按用户口径主动放弃；重复收束不重复记录或修改盘面', () => {
    const { setup, board } = boot({ confirm: false, start: false })
    expect(setup.pendingPlacement.length).toBeGreaterThan(0)
    expect(setup.finishSetup()).toBe(true)
    expect(setup.notes.join('\n')).toContain('本局移除')
    const notes = [...setup.notes],
      units = JSON.stringify(board.units)
    expect(setup.finishSetup()).toBe(true)
    expect(setup.notes).toEqual(notes)
    expect(JSON.stringify(board.units)).toBe(units)
  })
})
