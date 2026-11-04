import { confirmSetupForStart } from '../flows/setup-harness'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { useContainersStore, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'

function boot() {
  setActivePinia(createPinia())
  const setup = useSetupStore(),
    game = useGameSessionStore(),
    board = useWorkbenchStore()
  const containers = useContainersStore()
  setup.selectScenario('1')
  confirmSetupForStart(setup)
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

  it('开局被拒时保留正在点地图的初设项，仍可修正和重新开始', () => {
    const { setup, game } = boot()
    const item = setup.pendingPlacement.find((item) => item.kind === 'self')!
    expect(item).toBeDefined()
    expect(setup.beginSelfPlacement(item.entryIndex)).toBe(true)
    const placing = setup.placing
    const rejected = vi.spyOn(game, 'startGame').mockReturnValue(false)
    expect(setup.startGameNow()).toBe(false)
    expect(setup.placing).toBe(placing)
    expect(setup.finished).toBe(false)
    expect(game.session).toBeNull()
    rejected.mockRestore()
    expect(setup.startGameNow()).toBe(true)
    expect(setup.placing).toBeNull()
  })

  it.each(['finishSetup', 'startGameNow'] as const)(
    'ch10/ch11：%s不能把未完成的编队西移默认跳过；补齐后可开局',
    (action) => {
      const { setup, game, board, containers } = boot()
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
      expect(setup.startGameNow()).toBe(true)
      expect(setup.finished).toBe(true)
      expect(setup.notes.join('\n')).not.toContain('留在剧本页原格')
    },
  )

  it('普通未摆单位仍可按用户口径主动放弃；重复收束不重复记录或修改盘面', () => {
    const { setup, board } = boot()
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
