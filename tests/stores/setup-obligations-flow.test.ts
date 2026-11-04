import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  useContainersStore,
  useGameSessionStore,
  useHotseatStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'
import { createMemoryStorage } from '@/shared'
import { confirmSetupForStart } from '../flows/setup-harness'

function boot(id = '1') {
  setActivePinia(createPinia())
  const setup = useSetupStore(),
    game = useGameSessionStore(),
    board = useWorkbenchStore()
  useHotseatStore().setMode('solo')
  game.setSaveStorage(createMemoryStorage())
  expect(setup.selectScenario(id)).toBe(true)
  return { setup, game, board, containers: useContainersStore() }
}

describe('S1：必做初设、主动放弃与双方确认', () => {
  it.each(['3', '4', '5', '6'])('剧本%s：未完成规定满载选择时不能确认轴方、收束或开局', (id) => {
    const { setup, game, board } = boot(id)
    const cursor = setup.setupSideCursor,
      rng = { ...board.rng },
      units = JSON.stringify(board.units)
    expect(setup.truckLoadSummary.done).toBe(false)
    expect(setup.requiredSetupIssues.some((issue) => issue.id === 'truckLoad')).toBe(true)
    expect(setup.confirmSideSetup()).toBe(false)
    expect(setup.setupSideCursor).toBe(cursor)
    expect(setup.finishSetup()).toBe(false)
    expect(setup.startGameNow()).toBe(false)
    expect(game.session).toBeNull()
    expect(board.rng).toEqual(rng)
    expect(JSON.stringify(board.units)).toBe(units)
    confirmSetupForStart(setup)
    expect(setup.truckLoadSummary.done).toBe(true)
    expect(setup.requiredSetupIssues).toEqual([])
    expect(setup.startGameNow()).toBe(true)
  })

  it('满载已落账后更换同额名单，旧完成标记不能放行与实物不一致的载货', () => {
    const { setup, board, game } = boot('3')
    confirmSetupForStart(setup)
    const old = setup.truckFullIds[0]!
    const replacement = setup.setupTrucks.find(
      (truck) => !setup.truckFullIds.includes(truck.instanceId),
    )!
    setup.toggleTruckFull(old, false)
    setup.toggleTruckFull(replacement.instanceId, true)
    expect(setup.truckFullIds.length).toBe(setup.requiredFullTrucks)
    expect(setup.completed['truckLoad']).toBe(false)
    expect(setup.truckLoadSummary.done).toBe(false)
    expect(setup.startGameNow()).toBe(false)
    expect(game.session).toBeNull()
    expect(setup.designateTrucks()).toBe(true)
    expect(board.units.find((unit) => unit.instanceId === old)?.loadedSpT).toBe(0)
    expect(
      board.units.find((unit) => unit.instanceId === replacement.instanceId)?.loadedSpT,
    ).toBeGreaterThan(0)
    expect(setup.truckLoadSummary.done).toBe(true)
    expect(setup.startGameNow()).toBe(true)
  })

  it('必做西移与普通未摆单位分别列出；未完成西移不能确认轴方', () => {
    const { setup, containers } = boot()
    expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupSideCursor).toBe('axis')
    containers.drawShiftHexText = {}
    expect(setup.requiredSetupIssues.some((issue) => issue.id.startsWith('shift:'))).toBe(true)
    expect(setup.omittablePlacements.length).toBeGreaterThan(0)
    expect(
      setup.omittablePlacements.every((item) => item.kind === 'self' || item.kind === 'air'),
    ).toBe(true)
    expect(setup.confirmSideSetup()).toBe(false)
    expect(setup.setupSideCursor).toBe('axis')
  })

  it('尚未逐方确认时不能开局；成功换手清除上一方的地图落位', () => {
    const { setup, board, game } = boot()
    const item = setup.pendingPlacement.find(
      (item) =>
        item.side === setup.setupSideCursor && item.kind === 'self' && item.candidates.length > 0,
    )!
    expect(item).toBeDefined()
    expect(setup.beginSelfPlacement(item.entryIndex)).toBe(true)
    expect(setup.startGameNow()).toBe(false)
    expect(setup.lastAction?.detail).toContain('双方布设确认')
    expect(setup.placing).not.toBeNull()
    expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.placing).toBeNull()
    const units = JSON.stringify(board.units)
    expect(setup.placeAtHex(item.candidates[0]!)).toBe(false)
    expect(JSON.stringify(board.units)).toBe(units)
    expect(game.session).toBeNull()
    expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.omittablePlacements.length).toBeGreaterThan(0)
    expect(setup.startGameNow()).toBe(true)
    expect(setup.notes.join('')).toContain('本局移除')
  })

  it('卡车选额已满足时，未选车辆为空载，不能继续计作待完成项；换手取消点车模式', () => {
    const { setup, board } = boot('3')
    const required = setup.requiredFullTrucks!
    for (const truck of setup.setupTrucks.slice(0, required))
      setup.toggleTruckFull(truck.instanceId, true)
    expect(setup.designateTrucks()).toBe(true)
    expect(setup.decisionQueue.find((stack) => stack.key === 'truck')!.count).toBe(0)
    expect(setup.beginTruckPick()).toBe(true)
    expect(setup.confirmSideSetup()).toBe(true)
    const units = JSON.stringify(board.units)
    const hex = setup.truckPickRows[0]!.hex
    expect(setup.pickTruckAtHex(hex)).toBe(false)
    expect(JSON.stringify(board.units)).toBe(units)
  })
})

describe('S1→C：真实开局后的首个地面行动', () => {
  it.each(['1', '5'])(
    '剧本%s：按剧本先手推进到C，图上真实徒步单位能走一格并保存恢复MP',
    async (id) => {
      const { setup, game, board } = boot(id)
      confirmSetupForStart(setup)
      expect(setup.startGameNow()).toBe(true)
      for (let step = 0; step < 100 && !board.actionAllowedNow('move.order'); step++) {
        board.advanceSegmentNow()
        await nextTick()
      }
      expect(board.actionAllowedNow('move.order')).toBe(true)
      const candidates = board.units.filter(
        (unit) =>
          unit.side === board.activeSide &&
          unit.isCombat &&
          !unit.locked &&
          unit.mode.mode !== 'reserve' &&
          unit.raw.mobility === 'leg' &&
          unit.raw.ma > 0,
      )
      let movedId: string | null = null
      for (const unit of candidates) {
        const from = { ...unit.hex }
        board.beginMovePick(from, [unit.instanceId])
        if (!board.confirmMovePick()) continue
        const target = board.groupReachable.hexes.find(
          (node) => node.path.length === 2 && !node.inEnemyZoc && !node.forcedStop,
        )
        if (target === undefined) {
          board.abortMoveNow()
          continue
        }
        board.clickHex(target.hex)
        expect(unit.hex).toEqual(target.hex)
        expect(unit.mpSpent).toBeGreaterThan(0)
        expect(game.saveNow()).toBe(false)
        expect(game.saveError?.reason).toContain('请先完成当前')
        board.finishMove()
        expect(board.moveInteraction?.finished).toBe(true)
        movedId = unit.instanceId
        break
      }
      expect(movedId).not.toBeNull()
      const unit = board.units.find((unit) => unit.instanceId === movedId)!
      const after = { hex: { ...unit.hex }, mp: unit.mpSpent, ended: unit.movementEnded }
      expect(game.saveNow(), game.saveError?.reason).toBe(true)
      expect(game.loadNow()).toBe(true)
      const restored = board.units.find((unit) => unit.instanceId === movedId)!
      expect({ hex: restored.hex, mp: restored.mpSpent, ended: restored.movementEnded }).toEqual(
        after,
      )
    },
    30000,
  )
})
