import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '@/shared'
import { useSetupStore, useWorkbenchStore, useGameSessionStore } from '@/stores'
import { confirmSetupForStart } from '../flows/setup-harness'

function boot() {
  setActivePinia(createPinia())
  const setup = useSetupStore(),
    board = useWorkbenchStore(),
    game = useGameSessionStore()
  game.setSaveStorage(createMemoryStorage())
  expect(setup.selectScenario('1')).toBe(true)
  confirmSetupForStart(setup)
  expect(setup.startGameNow()).toBe(true)
  // 构造同格但不同来源的合法账本，用真实存读档入口检查恢复归并。
  board.spDumps.push(
    { id: 'first', side: 'axis', hex: { col: 30, row: 20 }, sp: 2, t: 1 },
    { id: 'second', side: 'axis', hex: { col: 30, row: 20 }, sp: 3, t: 2 },
  )
  return { board, game }
}

describe('12.1b/3.4b：读档归并不能改变SP归属', () => {
  it.each(['guderian', 'unassigned'] as const)(
    '第一条为%s，第二条为Hoth，读档保留两笔和各自归属',
    (first) => {
      const { board, game } = boot()
      if (first !== 'unassigned') board.setDumpPanzerGroupNow('first', first)
      board.setDumpPanzerGroupNow('second', 'hoth')
      expect(game.saveNow()).toBe(true)
      expect(game.loadNow()).toBe(true)
      const dumps = board.spDumps.filter((dump) => dump.id === 'first' || dump.id === 'second')
      expect(dumps).toHaveLength(2)
      expect(dumps.map((dump) => dump.sp * 4 + dump.t)).toEqual([9, 14])
      expect(board.panzerGroupOfDump('first')).toBe(first === 'unassigned' ? null : first)
      expect(board.panzerGroupOfDump('second')).toBe('hoth')
      expect(game.saveNow()).toBe(true)
      expect(game.loadNow()).toBe(true)
      expect(board.spDumps.filter((dump) => dump.id === 'first' || dump.id === 'second')).toEqual(
        dumps,
      )
    },
  )
  it('同归属的同格条目仍可合并，保留第一条标识且总量不变', () => {
    const { board, game } = boot()
    board.setDumpPanzerGroupNow('first', 'hoth')
    board.setDumpPanzerGroupNow('second', 'hoth')
    expect(game.saveNow()).toBe(true)
    expect(game.loadNow()).toBe(true)
    const dumps = board.spDumps.filter((dump) => dump.id === 'first' || dump.id === 'second')
    expect(dumps).toHaveLength(1)
    expect(dumps[0]!.id).toBe('first')
    expect(dumps[0]!.sp * 4 + dumps[0]!.t).toBe(23)
    expect(board.panzerGroupOfDump('first')).toBe('hoth')
  })
})
