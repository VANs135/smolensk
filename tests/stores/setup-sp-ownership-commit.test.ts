import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { boundarySideOf, PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import { createMemoryStorage } from '@/shared'
import { useSetupStore, useWorkbenchStore, useGameSessionStore } from '@/stores'
import { confirmSetupForStart } from '../flows/setup-harness'

function boot() {
  setActivePinia(createPinia())
  const setup = useSetupStore(),
    board = useWorkbenchStore(),
    game = useGameSessionStore()
  game.setSaveStorage(createMemoryStorage())
  game.setAgreedCheck(game.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM), true)
  expect(setup.selectScenario('1')).toBe(true)
  return { setup, board, game }
}

describe('Setup Note F/3.4b：初设SP归属实际提交', () => {
  it('后采纳选项时，双方确认和开局必须等待归属实际落实', () => {
    const { setup, board, game } = boot()
    const index = game.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
    game.setAgreedCheck(index, false)
    expect(setup.selectScenario('1')).toBe(true)
    confirmSetupForStart(setup)
    game.setAgreedCheck(index, true)
    const before = JSON.stringify(board.units),
      rng = { ...board.rng }
    expect(setup.stepDone.spOwnership).toBe(false)
    expect(setup.requiredSetupIssues.some((issue) => issue.id === 'spOwnership')).toBe(true)
    expect(setup.spAssignments).toEqual({})
    expect(setup.confirmSpOwnership()).toBe(false)
    expect(setup.lastAction?.detail ?? '').toContain('spOwnershipMissing:')
    expect(setup.startGameNow()).toBe(false)
    expect(game.session).toBeNull()
    expect(JSON.stringify(board.units)).toBe(before)
    expect(board.rng).toEqual(rng)
    for (const dump of setup.spDumpsOf('axis')) setup.setSpAssignment(dump.id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(true)
    expect(setup.startGameNow()).toBe(true)
  })
  it('旧确认不能覆盖改选、清空或实际账本不一致，重新确认后才恢复就绪', () => {
    const { setup, board, game } = boot()
    confirmSetupForStart(setup)
    const dump = setup.spDumpsOf('axis')[0]!
    const other = board.panzerGroupOfDump(dump.id) === 'hoth' ? 'guderian' : 'hoth'
    setup.setSpAssignment(dump.id, other)
    expect(setup.stepDone.spOwnership).toBe(false)
    expect(setup.startGameNow()).toBe(false)
    expect(setup.confirmSpOwnership()).toBe(true)
    board.spDumpPanzerGroups = {}
    expect(setup.stepDone.spOwnership).toBe(false)
    expect(setup.startGameNow()).toBe(false)
    setup.setSpAssignment(dump.id, null)
    expect(setup.confirmSpOwnership()).toBe(false)
    expect(game.session).toBeNull()
    setup.setSpAssignment(dump.id, other)
    expect(setup.confirmSpOwnership()).toBe(true)
    expect(setup.startGameNow()).toBe(true)
  })
  it('未启用选项或晚起始剧本不增加SP归属必做项', () => {
    const { setup, game } = boot()
    game.setAgreedCheck(game.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM), false)
    expect(setup.requiredSetupIssues.some((issue) => issue.id === 'spOwnership')).toBe(false)
    expect(setup.selectScenario('7')).toBe(true)
    game.setAgreedCheck(game.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM), true)
    expect(setup.requiredSetupIssues.some((issue) => issue.id === 'spOwnership')).toBe(false)
  })
  it('确认后实际补给站读取玩家选择，重复确认不重复写入，存读档保留归属', () => {
    const { setup, board, game } = boot()
    for (const dump of setup.spDumpsOf('axis')) setup.setSpAssignment(dump.id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(true)
    for (const dump of setup.spDumpsOf('axis'))
      expect(board.panzerGroupOfDump(dump.id)).toBe('hoth')
    const logs = board.log.length
    expect(setup.confirmSpOwnership()).toBe(true)
    // 初设确认自身有回执，实际归属无需重复写日志。
    expect(board.log.length).toBe(logs + 1)
    confirmSetupForStart(setup)
    expect(setup.startGameNow()).toBe(true)
    expect(game.saveNow()).toBe(true)
    const groups = { ...board.spDumpPanzerGroups }
    board.spDumpPanzerGroups = {}
    expect(game.loadNow()).toBe(true)
    expect(board.spDumpPanzerGroups).toEqual(groups)
  })
  it('初设归属只认玩家选择，分界线不自动改写', () => {
    const { setup, board } = boot()
    confirmSetupForStart(setup)
    const boundary = board.panzerGroupBoundaryWithPath
    expect(boundary).not.toBeNull()
    const dumps = setup.spDumpsOf('axis')
    const dump =
      boundary === null
        ? dumps[0]!
        : (dumps.find((item) => boundarySideOf(item.hex, boundary) === 'north') ?? dumps[0]!)
    const side = boundary === null ? 'south' : boundarySideOf(dump.hex, boundary)
    const chosen = side === 'north' ? 'guderian' : 'hoth'
    setup.setSpAssignment(dump.id, chosen)
    expect(setup.confirmSpOwnership()).toBe(true)
    expect(board.panzerGroupOfDump(dump.id)).toBe(chosen)
  })
  it('非法苏方归属使整笔拒绝，不先提交合法的轴方修改', () => {
    const { setup, board } = boot()
    for (const dump of setup.spDumpsOf('axis')) setup.setSpAssignment(dump.id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(true)
    const before = { ...board.spDumpPanzerGroups }
    for (const dump of setup.spDumpsOf('axis')) setup.setSpAssignment(dump.id, 'hoth')
    setup.setSpAssignment(setup.spDumpsOf('soviet')[0]!.id, 'hoth')
    expect(setup.stepDone.spOwnership).toBe(false)
    expect(setup.confirmSpOwnership()).toBe(false)
    expect(board.spDumpPanzerGroups).toEqual(before)
  })
  it('清盘换剧本同时清除旧补给站归属及待归属记录', () => {
    const { setup, board } = boot()
    for (const dump of setup.spDumpsOf('axis')) setup.setSpAssignment(dump.id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(true)
    expect(Object.keys(board.spDumpPanzerGroups).length).toBeGreaterThan(0)
    expect(setup.selectScenario('7')).toBe(true)
    expect(board.spDumpPanzerGroups).toEqual({})
  })
})
