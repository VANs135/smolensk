import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
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
  it('非法苏方归属使整笔拒绝，不先提交合法的轴方修改', () => {
    const { setup, board } = boot()
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
    expect(setup.confirmSpOwnership()).toBe(true)
    expect(Object.keys(board.spDumpPanzerGroups).length).toBeGreaterThan(0)
    expect(setup.selectScenario('7')).toBe(true)
    expect(board.spDumpPanzerGroups).toEqual({})
  })
})
