import { confirmSetupForStart } from '../flows/setup-harness'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { scenarioSetup, scenarios } from '@/data'
import { deriveDrawComposition, setupSourceOf } from '@/engine/rules'
import {
  useContainersStore,
  useGameSessionStore,
  useHotseatStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

function boot(scenarioId = '1', automatic = true) {
  setActivePinia(createPinia())
  // 2026-11-09：模式前移到选剧本，进初设前必须先选
  useHotseatStore().setMode('solo')
  const setup = useSetupStore()
  const containers = useContainersStore()
  const game = useGameSessionStore()
  const board = useWorkbenchStore()
  if (automatic) {
    const ok = setup.selectScenario(scenarioId)
    expect(ok, setup.lastAction?.detail ?? containers.lastAction?.detail).toBe(true)
  } else {
    expect(game.setScenarioId(scenarioId)).toBe(true)
    expect(setup.runAutoSetup()).toBe(true)
  }
  return { setup, containers, game, board }
}

function capture(board: ReturnType<typeof useWorkbenchStore>) {
  return JSON.stringify({ units: board.units, dead: board.deadPile, rng: board.rng })
}

function aufkId(formationId: string) {
  const result = deriveDrawComposition({
    rows: scenarioSetup.entries.filter((row) => row.scenarioId === '1'),
    formationId,
  })
  if (!result.ok) throw new Error(result.reason)
  return result.data.aufkBattalionUnitId!
}

describe('S1 ch10/ch11：编队抽取、处置和新局账本', () => {
  it.each(scenarios.scenarios.map((scenario) => scenario.id))(
    '剧本%s：真实自动初设完成抽取处置，重试不改盘面或骰序，并可进入首个玩家环节',
    (id) => {
      const { setup, containers, board, game } = boot(id)
      expect(containers.setupDrawProgress.complete, containers.lastAction?.detail).toBe(true)
      expect(setup.stepDone.formationDraw).toBe(true)
      const rows = scenarioSetup.entries.filter(
        (row) => row.scenarioId === setupSourceOf(id).source,
      )
      for (const group of containers.scenarioDrawBox!.groups) {
        for (const formationId of containers.drawnOf(group)) {
          const derived = deriveDrawComposition({
            rows,
            formationId,
            aufkLocation: group.kind === 'deadPileAufk' ? 'hex' : 'dead_pile',
          })
          expect(derived.ok).toBe(true)
          if (!derived.ok) continue
          const facts = derived.data
          if (group.kind === 'mtrAufkSwap') {
            expect(board.units.some((unit) => unit.unitId === facts.mtrRegimentUnitId)).toBe(false)
            expect(
              board.deadPile.some(
                (unit) => 'unitId' in unit && unit.unitId === facts.mtrRegimentUnitId,
              ),
            ).toBe(true)
            expect(
              board.units.find((unit) => unit.unitId === facts.aufkBattalionUnitId)?.hex,
            ).toEqual(facts.anchorHex)
            expect(
              board.deadPile.some(
                (unit) => 'unitId' in unit && unit.unitId === facts.aufkBattalionUnitId,
              ),
            ).toBe(false)
          } else if (group.kind === 'deadPileAufk' || group.kind === 'deadPileKrd') {
            const unitId =
              group.kind === 'deadPileAufk' ? facts.aufkBattalionUnitId : facts.krdBattalionUnitId
            expect(board.units.some((unit) => unit.unitId === unitId)).toBe(false)
            expect(board.deadPile.some((unit) => 'unitId' in unit && unit.unitId === unitId)).toBe(
              true,
            )
          } else if (group.kind === 'moveMode') {
            const members = board.units.filter(
              (unit) => facts.onMapUnitIds.includes(unit.unitId) && unit.isCombat,
            )
            expect(members.length).toBeGreaterThan(0)
            expect(
              members.every(
                (unit) => unit.mode.mode === 'move' && unit.mode.orientation === 'move',
              ),
            ).toBe(true)
          } else {
            const item = containers.pendingShiftWestPlacements.find(
              (item) => item.formationId === formationId,
            )!
            expect(item.unitIds).toHaveLength(facts.onMapUnitIds.length)
            for (const instanceId of item.unitIds) {
              const hex = board.units.find((unit) => unit.instanceId === instanceId)!.hex
              expect(`${hex.col}.${hex.row}`).toBe(item.hexText)
            }
          }
        }
      }
      const before = capture(board)
      const outcomes = JSON.stringify(containers.formationDrawOutcomes)
      const deposit = vi.spyOn(board, 'sendToDeadPileNow')
      const returned = vi.spyOn(board, 'returnFromDeadPileNow')
      expect(setup.runSetupDraws()).toBe(true)
      expect(setup.runSetupDraws()).toBe(true)
      expect(capture(board)).toBe(before)
      expect(JSON.stringify(containers.formationDrawOutcomes)).toBe(outcomes)
      expect(deposit).not.toHaveBeenCalled()
      expect(returned).not.toHaveBeenCalled()
      confirmSetupForStart(setup)
      expect(setup.startGameNow()).toBe(true)
      expect(game.session).not.toBeNull()
      expect(game.guidance?.step.driver).toBe('player')
    },
  )

  it('重复自动执行不能覆盖玩家已经提交的西移改点', () => {
    const { setup, containers, board } = boot()
    const item = containers.pendingShiftWestPlacements[0]!
    expect(setup.beginShiftPlacement(item.formationId)).toBe(true)
    const changed = setup.placing!.candidates.find(
      (hex) => `${hex.col}.${hex.row}` !== item.hexText,
    )!
    expect(changed).toBeDefined()
    expect(setup.placeAtHex(changed)).toBe(true)
    const before = capture(board)
    const outcomes = JSON.stringify(containers.formationDrawOutcomes)
    expect(setup.runSetupDraws()).toBe(true)
    expect(capture(board)).toBe(before)
    expect(JSON.stringify(containers.formationDrawOutcomes)).toBe(outcomes)
    expect(containers.drawShiftHexOf(item.formationId)).toBe(`${changed.col}.${changed.row}`)
  })

  it('整组西移遇到缺失成员时拒绝全部移动，也不能写完成回执', () => {
    const { setup, containers, board } = boot('1', false)
    const group = containers.scenarioDrawBox!.groups.find((g) => g.kind === 'shiftWest')!
    containers.drawFormations(group)
    const items = containers.pendingShiftWestPlacements
    for (const item of items)
      expect(containers.setDrawShiftHexNow(item.formationId, '9.1')).toBe(true)
    const missingId = items.at(-1)!.unitIds[0]!
    board.units = board.units.filter((unit) => unit.instanceId !== missingId)
    const before = capture(board)
    expect(containers.applyShiftWestPlacementsNow()).toBe(false)
    expect(containers.lastAction?.detail).toContain('缺少待移动')
    expect(capture(board)).toBe(before)
    expect(containers.formationDrawOutcomes).toEqual([])
    expect(setup.startGameNow()).toBe(false)
  })

  it('非西移组的直接应用入口也不重复提交死亡堆互换', () => {
    const { containers, board } = boot()
    const group = containers.scenarioDrawBox!.groups.find((g) => g.kind === 'mtrAufkSwap')!
    const before = capture(board)
    const returned = vi.spyOn(board, 'returnFromDeadPileNow')
    expect(containers.applyDraw(group)).toBe(true)
    expect(capture(board)).toBe(before)
    expect(returned).not.toHaveBeenCalled()
  })

  it('只选落点但未执行摆位，不能按已处置开局；重试采用该落点', () => {
    const { setup, containers, game, board } = boot()
    const item = containers.pendingShiftWestPlacements[0]!
    const selected = item.fromHexText!
    expect(containers.setDrawShiftHexNow(item.formationId, selected)).toBe(true)
    expect(setup.stepDone.formationDraw).toBe(false)
    expect(setup.startGameNow()).toBe(false)
    expect(game.session).toBeNull()
    expect(setup.runSetupDraws()).toBe(true)
    expect(containers.setupDrawProgress.complete).toBe(true)
    for (const id of item.unitIds) {
      const hex = board.units.find((unit) => unit.instanceId === id)!.hex
      expect(`${hex.col}.${hex.row}`).toBe(selected)
    }
  })

  it.each(['finishSetup', 'startGameNow'] as const)(
    '%s：处置失败保留抽签结果并阻止收束；修正来源后只补做未提交组',
    (action) => {
      const { setup, containers, board, game } = boot('1', false)
      const group = containers.scenarioDrawBox!.groups.find((g) => g.kind === 'mtrAufkSwap')!
      const drawn = containers.drawFormations(group)
      const deadIndex = board.deadPile.findIndex(
        (unit) => !('aircraftId' in unit) && unit.unitId === aufkId(drawn[0]!),
      )
      expect(deadIndex).toBeGreaterThanOrEqual(0)
      const [missing] = board.deadPile.splice(deadIndex, 1)
      expect(setup.runSetupDraws()).toBe(false)
      expect(setup.lastAction?.ok).toBe(false)
      expect(setup.stepDone.formationDraw).toBe(false)
      const failedBoard = capture(board)
      const draws = JSON.stringify(containers.drawResults)
      expect(setup[action]()).toBe(false)
      expect(setup.finished).toBe(false)
      expect(game.session).toBeNull()
      expect(capture(board)).toBe(failedBoard)
      board.deadPile.push(missing!)
      expect(setup.runSetupDraws()).toBe(true)
      expect(JSON.stringify(containers.drawResults)).toBe(draws)
      expect(containers.setupDrawProgress.complete).toBe(true)
      confirmSetupForStart(setup)
      expect(setup.startGameNow()).toBe(true)
    },
  )

  it('整组互换先核对所有来源：返场单位错误地在图上时，不先送走摩托化团', () => {
    const { setup, containers, board } = boot('1', false)
    const group = containers.scenarioDrawBox!.groups.find((g) => g.kind === 'mtrAufkSwap')!
    const drawn = containers.drawFormations(group)
    const dead = board.deadPile.find(
      (unit) => !('aircraftId' in unit) && unit.unitId === aufkId(drawn.at(-1)!),
    )!
    expect(dead).toBeDefined()
    expect(board.returnFromDeadPileNow({ instanceId: dead.instanceId, hexText: '11.3' })).toBe(true)
    const before = capture(board)
    expect(containers.applyDraw(group)).toBe(false)
    expect(containers.lastAction?.detail).toContain('不在死亡堆')
    expect(capture(board)).toBe(before)
    expect(containers.formationDrawOutcomes).toEqual([])
    expect(setup.finishSetup()).toBe(false)
  })

  it('首次抽取失败且零组完成时，选剧本必须报告失败', () => {
    const { setup, containers } = boot('7')
    const failed = vi.spyOn(containers, 'runSetupDrawsNow').mockReturnValue({
      ok: false,
      drawnGroups: 0,
      appliedGroups: 0,
      pendingShift: [],
      detail: '抽取池不足，未完成抽取',
    })
    expect(setup.selectScenario('1')).toBe(false)
    expect(setup.lastAction?.ok).toBe(false)
    expect(setup.lastAction?.detail).toContain('抽取池不足')
    failed.mockRestore()
  })

  it('首次进入当前剧本时，自动初设抽取失败也向界面返回失败', () => {
    setActivePinia(createPinia())
    useHotseatStore().setMode('solo')
    const setup = useSetupStore()
    const containers = useContainersStore()
    vi.spyOn(containers, 'runSetupDrawsNow').mockReturnValueOnce({
      ok: false,
      drawnGroups: 0,
      appliedGroups: 0,
      pendingShift: [],
      detail: '初设抽取失败',
    })
    expect(setup.enterSetup('1')).toBe(false)
    expect(setup.lastAction?.detail).toBe('初设抽取失败')
  })

  it('已有但不足额的抽取记录不能标完成，重试也不能悄悄再抽', () => {
    const { setup, containers, board } = boot()
    const row = containers.drawResults['1']![0]!
    row.formationIds = row.formationIds.slice(0, 1)
    const before = capture(board)
    expect(setup.runSetupDraws()).toBe(false)
    expect(setup.stepDone.formationDraw).toBe(false)
    expect(capture(board)).toBe(before)
    expect(setup.startGameNow()).toBe(false)
  })

  it('清盘重建同一剧本时重做抽取处置；换无抽取剧本不会留下旧名单和落点', () => {
    const { setup, containers, board } = boot()
    const oldIds = board.units.map((unit) => unit.instanceId)
    expect(setup.selectScenario('1')).toBe(true)
    expect(board.units.some((unit) => oldIds.includes(unit.instanceId))).toBe(false)
    expect(containers.setupDrawProgress.complete).toBe(true)
    for (const item of containers.pendingShiftWestPlacements) {
      for (const id of item.unitIds) {
        const hex = board.units.find((unit) => unit.instanceId === id)!.hex
        expect(`${hex.col}.${hex.row}`).toBe(item.hexText)
      }
    }
    expect(setup.selectScenario('7')).toBe(true)
    expect(containers.drawResults).toEqual({})
    expect(containers.drawShiftHexText).toEqual({})
    expect(containers.formationDrawOutcomes).toEqual([])
    expect(setup.formationDrawNotes).toEqual([])
    expect(setup.selectScenario('2')).toBe(true)
    expect(Object.keys(containers.drawResults)).toEqual(['2'])
    expect(containers.setupDrawProgress.complete).toBe(true)
  })
})
