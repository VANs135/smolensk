import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createMemoryStorage } from '@/shared'
import {
  SAVE_SLOT_KEY,
  useSetupStore,
  useWorkbenchStore,
  useGameSessionStore,
  useHotseatStore,
} from '@/stores'
import { confirmSetupForStart } from '../flows/setup-harness'

function boot() {
  setActivePinia(createPinia())
  const setup = useSetupStore(),
    board = useWorkbenchStore(),
    game = useGameSessionStore()
  useHotseatStore().setMode('solo')
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
  it('供养额度和破坏尝试随归并迁移，再次存读档不丢失或翻倍', async () => {
    const { board, game } = boot()
    for (let step = 0; step < 100 && !board.actionAllowedNow('move.dumpBlow'); step++) {
      board.advanceSegmentNow()
      await nextTick()
    }
    expect(board.actionAllowedNow('move.dumpBlow')).toBe(true)
    expect(game.saveNow()).toBe(true)
    const storage = game.storage!
    const payload = JSON.parse(storage.getItem(SAVE_SLOT_KEY)!) as {
      board: { fields: Record<string, unknown> }
    }
    payload.board.fields['oosFedReByDump'] = { first: 2, second: 3, 'unit:truck': 4 }
    payload.board.fields['dumpDestructionAttempts'] = { second: 1 }
    storage.setItem(SAVE_SLOT_KEY, JSON.stringify(payload))
    expect(game.loadNow()).toBe(true)
    expect(board.dumpDestructionAttempts).toEqual({ first: 1 })
    const dumps = JSON.stringify(board.spDumps),
      rng = { ...board.rng }
    expect(board.destructDumpNow('first')).toBe(false)
    expect(JSON.stringify(board.spDumps)).toBe(dumps)
    expect(board.rng).toEqual(rng)
    expect(game.saveNow()).toBe(true)
    const restored = JSON.parse(storage.getItem(SAVE_SLOT_KEY)!) as typeof payload
    expect(restored.board.fields['oosFedReByDump']).toEqual({ first: 5, 'unit:truck': 4 })
    expect(game.loadNow()).toBe(true)
    expect(board.dumpDestructionAttempts).toEqual({ first: 1 })
    expect(game.saveNow()).toBe(true)
    expect(
      (JSON.parse(storage.getItem(SAVE_SLOT_KEY)!) as typeof payload).board.fields[
        'oosFedReByDump'
      ],
    ).toEqual({ first: 5, 'unit:truck': 4 })
  }, 30000)
  it('不同集群未归并时，不把各自供养及破坏历史合在一起', () => {
    const { board, game } = boot()
    board.setDumpPanzerGroupNow('first', 'guderian')
    board.setDumpPanzerGroupNow('second', 'hoth')
    board.dumpDestructionAttempts = { first: 1, second: 1 }
    expect(game.saveNow()).toBe(true)
    expect(game.loadNow()).toBe(true)
    expect(board.dumpDestructionAttempts).toEqual({ first: 1, second: 1 })
  })
  it('被归并条目的待归属记录迁移到保留ID，声明后可清完待办', () => {
    const { board, game } = boot()
    board.pendingSpGroupAssignment = ['second', 'first', 'second']
    expect(game.saveNow()).toBe(true)
    expect(game.loadNow()).toBe(true)
    expect(board.pendingSpGroupAssignment).toEqual(['first'])
    board.setDumpPanzerGroupNow('first', 'hoth')
    expect(board.pendingSpGroupAssignment).toEqual([])
    expect(game.saveNow()).toBe(true)
    expect(game.loadNow()).toBe(true)
    expect(board.pendingSpGroupAssignment).toEqual([])
  })
  it('无归并时也清理不存在的归属和待办，不制造补给站', () => {
    const { board, game } = boot()
    board.setDumpPanzerGroupNow('first', 'guderian')
    board.setDumpPanzerGroupNow('second', 'hoth')
    board.spDumpPanzerGroups['missing'] = 'hoth'
    board.pendingSpGroupAssignment = ['missing', 'second']
    expect(game.saveNow()).toBe(true)
    expect(game.loadNow()).toBe(true)
    expect(board.panzerGroupOfDump('missing')).toBeNull()
    expect(board.pendingSpGroupAssignment).toEqual([])
    expect(board.spDumps.some((dump) => dump.id === 'missing')).toBe(false)
  })
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
    expect(board.panzerGroupOfDump('second')).toBeNull()
  })
})
