import { confirmSetupForStart } from '../flows/setup-harness'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { scenarios } from '@/data'
import { createMemoryStorage, type KeyValueStorage } from '@/shared'
import {
  SAVE_SLOT_KEY,
  useContainersStore,
  useGameSessionStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

function boot(id = '1', storage: KeyValueStorage = createMemoryStorage()) {
  setActivePinia(createPinia())
  const game = useGameSessionStore()
  game.setSaveStorage(storage)
  const setup = useSetupStore()
  const board = useWorkbenchStore()
  const containers = useContainersStore()
  expect(setup.selectScenario(id)).toBe(true)
  return { game, setup, board, containers, storage }
}

function drawState(containers: ReturnType<typeof useContainersStore>) {
  return JSON.stringify({
    draws: containers.drawResults,
    hexes: containers.drawShiftHexText,
    outcomes: containers.formationDrawOutcomes,
  })
}

function save(id = '1') {
  const original = boot(id)
  const { setup, game } = original
  confirmSetupForStart(setup)
  setup.notes.push('验收：保留初设处置说明')
  expect(setup.startGameNow()).toBe(true)
  expect(game.saveNow()).toBe(true)
  return original
}

type Stored = { board: { setup?: Record<string, unknown> } }

describe('S1：逐枚初设进度的生命周期', () => {
  it('清盘重建同剧本，地面自由项的已摆枚数必须清零', () => {
    const { setup } = boot()
    const item = setup.pendingPlacement.find(
      (item) => item.kind === 'self' && item.candidates.length > 0,
    )!
    expect(item).toBeDefined()
    expect(setup.beginSelfPlacement(item.entryIndex)).toBe(true)
    expect(setup.placeAtHex(item.candidates[0]!)).toBe(true)
    expect(setup.placedSelfInstances[item.entryIndex]).toBeGreaterThan(0)
    expect(setup.selectScenario('1')).toBe(true)
    expect(setup.placedSelfInstances).toEqual({})
    const fresh = setup.pendingPlacement.find(
      (entry) => entry.kind === 'self' && entry.entryIndex === item.entryIndex,
    )!
    expect(fresh.remaining).toBe(fresh.total)
    expect(setup.beginSelfPlacement(item.entryIndex)).toBe(true)
    expect(setup.placing?.placed).toBe(0)
  })

  it('换剧本再回来，飞机逐枚进度不能留下幽灵已摆单位', () => {
    const { setup, board } = boot()
    const item = setup.pendingPlacement.find(
      (item) => item.kind === 'air' && item.candidates.length > 0,
    )!
    expect(item).toBeDefined()
    expect(setup.beginAirPlacement(item.side, item.entryIndex)).toBe(true)
    expect(setup.placeAtHex(item.candidates[0]!)).toBe(true)
    expect(board.airUnits.length).toBe(1)
    expect(Object.keys(setup.placedAirInstances).length).toBe(1)
    expect(setup.selectScenario('7')).toBe(true)
    expect(setup.selectScenario('1')).toBe(true)
    expect(board.airUnits).toEqual([])
    expect(setup.placedAirInstances).toEqual({})
    const fresh = setup.pendingPlacement.find(
      (entry) =>
        entry.kind === 'air' && entry.side === item.side && entry.entryIndex === item.entryIndex,
    )!
    expect(fresh.remaining).toBe(fresh.total)
  })
})

describe('S1：开局存档与初设历史恢复', () => {
  it.each(scenarios.scenarios.map((scenario) => scenario.id))(
    '剧本%s：冷读档保留抽取名单、处置回执、落点、说明和双方确认，继续游戏不再抽签',
    (id) => {
      const original = save(id)
      const draws = drawState(original.containers)
      const notes = [...original.setup.notes]
      const confirmations = { ...original.setup.setupSideConfirmed }
      const units = JSON.stringify(original.board.units)
      const dumps = JSON.stringify(original.board.spDumps)
      expect(new Set(original.board.spDumps.map((dump) => dump.id)).size).toBe(
        original.board.spDumps.length,
      )
      const rng = { ...original.board.rng }
      const session = JSON.stringify(original.game.session)
      setActivePinia(createPinia())
      const game = useGameSessionStore()
      game.setSaveStorage(original.storage)
      expect(game.loadNow(), game.saveError?.reason).toBe(true)
      const setup = useSetupStore(),
        containers = useContainersStore(),
        board = useWorkbenchStore()
      expect(drawState(containers)).toBe(draws)
      expect(setup.notes).toEqual(notes)
      expect(setup.setupSideConfirmed).toEqual(confirmations)
      expect(setup.setupSideCursor).toBeNull()
      expect(setup.stepDone.formationDraw).toBe(true)
      expect(setup.finished).toBe(true)
      expect(JSON.stringify(board.units)).toBe(units)
      expect(JSON.stringify(board.spDumps)).toBe(dumps)
      expect(board.rng).toEqual(rng)
      expect(setup.startGameNow()).toBe(true)
      expect(JSON.stringify(game.session)).toBe(session)
      expect(setup.runSetupDraws()).toBe(false)
      expect(board.rng).toEqual(rng)
      expect(JSON.stringify(board.units)).toBe(units)
      expect(drawState(containers)).toBe(draws)
    },
  )

  it.each(['drawState', 'setup'] as const)(
    '旧档缺少%s时，清除当前初设历史且不重建已经发生的抽签',
    (missing) => {
      const saved = save('3')
      const payload = JSON.parse(saved.storage.getItem(SAVE_SLOT_KEY)!) as Stored
      if (missing === 'setup') delete payload.board.setup
      else delete payload.board.setup!['drawState']
      saved.storage.setItem(SAVE_SLOT_KEY, JSON.stringify(payload))
      const current = boot('1', saved.storage)
      // ch10：选剧本不再自动抽签 ⇒ 这里显式抽一次，制造"当前有抽签历史"的前置
      confirmSetupForStart(current.setup)
      expect(current.setup.executeSetupDraws()).toBe(true)
      expect(current.containers.formationDrawOutcomes.length).toBeGreaterThan(0)
      const pending = current.setup.pendingPlacement.find(
        (item) => item.kind === 'self' && item.candidates.length > 0,
      )!
      expect(current.setup.beginSelfPlacement(pending.entryIndex)).toBe(true)
      expect(current.game.loadNow()).toBe(true)
      expect(current.game.scenarioId).toBe('3')
      expect(current.setup.finished).toBe(true)
      expect(current.setup.placing).toBeNull()
      expect(current.containers.drawResults).toEqual({})
      expect(current.containers.drawShiftHexText).toEqual({})
      expect(current.containers.formationDrawOutcomes).toEqual([])
      const rng = { ...current.board.rng },
        units = JSON.stringify(current.board.units)
      expect(current.setup.runSetupDraws()).toBe(false)
      expect(current.board.rng).toEqual(rng)
      expect(JSON.stringify(current.board.units)).toBe(units)
    },
  )

  it('旧档没有初设快照时冷读档也关闭初设，保留已恢复的补给账本', () => {
    const saved = save('3')
    const payload = JSON.parse(saved.storage.getItem(SAVE_SLOT_KEY)!) as Stored
    delete payload.board.setup
    saved.storage.setItem(SAVE_SLOT_KEY, JSON.stringify(payload))
    const dumps = JSON.stringify(saved.board.spDumps)
    setActivePinia(createPinia())
    const game = useGameSessionStore()
    game.setSaveStorage(saved.storage)
    expect(game.loadNow()).toBe(true)
    expect(useSetupStore().finished).toBe(true)
    expect(useSetupStore().notes.join('')).toContain('不重新抽签')
    expect(useContainersStore().drawResults).toEqual({})
    expect(JSON.stringify(useWorkbenchStore().spDumps)).toBe(dumps)
  })

  it.each(['invalid', 'wrongScenario'] as const)(
    '初设抽取快照%s时先拒读，当前初设、盘面和正在点选的项目不变',
    (fault) => {
      const saved = save('3')
      const payload = JSON.parse(saved.storage.getItem(SAVE_SLOT_KEY)!) as Stored
      const draws = payload.board.setup!['drawState'] as Record<string, unknown>
      if (fault === 'invalid') draws['outcomes'] = null
      else {
        draws['scenarioId'] = '1'
        const results = draws['drawResults'] as Record<string, unknown>
        draws['drawResults'] = { '1': results['3'] }
      }
      saved.storage.setItem(SAVE_SLOT_KEY, JSON.stringify(payload))
      const current = boot('1', saved.storage)
      const pending = current.setup.pendingPlacement.find(
        (item) => item.kind === 'self' && item.candidates.length > 0,
      )!
      expect(current.setup.beginSelfPlacement(pending.entryIndex)).toBe(true)
      const before = drawState(current.containers),
        units = JSON.stringify(current.board.units)
      const placing = current.setup.placing,
        notes = [...current.setup.notes]
      expect(current.game.loadNow()).toBe(false)
      expect(current.game.session).toBeNull()
      expect(current.game.scenarioId).toBe('1')
      expect(current.setup.placing).toBe(placing)
      expect(current.setup.notes).toEqual(notes)
      expect(drawState(current.containers)).toBe(before)
      expect(JSON.stringify(current.board.units)).toBe(units)
    },
  )

  it('未开局的初设不伪装成可保存对局，失败不覆盖已有存档', () => {
    const saved = save()
    const text = saved.storage.getItem(SAVE_SLOT_KEY)
    const current = boot('7', saved.storage)
    expect(current.game.saveNow()).toBe(false)
    expect(current.game.saveError?.reason).toBe('noSessionToSave')
    expect(current.storage.getItem(SAVE_SLOT_KEY)).toBe(text)
  })
})
