import { confirmSetupForStart } from '../flows/setup-harness'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { scenarioSetup, scenarios } from '@/data'
import { deriveDrawComposition, setupSourceOf } from '@/engine/rules'
import { createMemoryStorage } from '@/shared'
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
    // ch10（用户 2026-11-10）：抽签只在初设单位放置完成后执行一次 ⇒ 先摆完必做项，再执行抽签
    confirmSetupForStart(setup)
    expect(setup.drawSetupEffectsNow(), setup.lastAction?.detail).toBe(true)
    expect(setup.finishSetup()).toBe(true)
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
  const ids = scenarios.scenarios.map((s) => s.id)
  it.each(ids)(
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
      // 已开局 ⇒ 重入被拒（台账/会话双重闸门），且盘面与处置回执不变
      expect(setup.runSetupDraws()).toBe(false)
      expect(setup.drawSetupEffectsNow()).toBe(true) // 台账已存在 ⇒ 幂等
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
    // 已开局 ⇒ 只能幂等回 true，不得覆盖玩家已提交的西移改点
    expect(setup.runSetupDraws()).toBe(false)
    expect(setup.drawSetupEffectsNow()).toBe(true)
    expect(capture(board)).toBe(before)
    expect(JSON.stringify(containers.formationDrawOutcomes)).toBe(outcomes)
    expect(containers.drawShiftHexOf(item.formationId)).toBe(`${changed.col}.${changed.row}`)
  })

  it('整组西移遇到缺失成员时拒绝全部移动，也不能写完成回执', () => {
    const { setup, containers, board, game } = boot('1', false)
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
    /*
     * 用户 2026-11-14 裁定 1（推翻旧的"失败即回滚"口径）：缺失成员的西移师
     * 视为"抽签成功、待玩家给落点" ⇒ 保留盘面与台账、初设栏露出该项，不建会话；
     * 落齐后由「开始游戏」开局。
     */
    expect(setup.drawSetupEffectsNow(), setup.lastAction?.detail).toBe(true)
    expect(setup.setupEffectLedger).not.toBeNull()
    expect(game.session).toBeNull()
    expect(setup.pendingPlacement.some((item) => item.kind === 'shift')).toBe(true)
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

  it('两段式：确认初设只收束不建会话；点「抽签」才执行并开局，重复点击不重抽', () => {
    setActivePinia(createPinia())
    useHotseatStore().setMode('solo')
    const setup = useSetupStore()
    const containers = useContainersStore()
    const board = useWorkbenchStore()
    const game = useGameSessionStore()
    expect(setup.selectScenario('1')).toBe(true)
    confirmSetupForStart(setup, { draws: false })
    // 第一段：确认后仍在初设、会话未建、抽签按钮出现
    expect(setup.finished).toBe(true)
    expect(setup.setupConfirmed).toBe(true)
    expect(game.session).toBeNull()
    expect(setup.setupDrawEntryVisible).toBe(true)
    expect(setup.stepDone.formationDraw).toBe(false)
    // 第二段：唯一入口执行效果 → 写台账 → 开局
    expect(setup.drawSetupEffectsNow()).toBe(true)
    expect(setup.setupEffectLedger).not.toBeNull()
    expect(setup.setupEffectLedger!.scenarioId).toBe('1')
    expect(game.session).not.toBeNull()
    expect(containers.setupDrawProgress.complete).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(false)
    // 不可重入：重复点击幂等，盘面不变
    const before = capture(board)
    expect(setup.drawSetupEffectsNow()).toBe(true)
    expect(capture(board)).toBe(before)
  })

  it.each(['finishSetup', 'startGameNow'] as const)(
    '%s：抽签处置失败不写台账、不建会话；修正来源后只补做未提交组',
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
      // 两段式：确认在前、抽签在后 ⇒ 确认不因抽签失败被拒；但不得建会话、不得写台账
      expect(setup[action]()).toBe(true)
      expect(setup.finished).toBe(true)
      expect(game.session).toBeNull()
      expect(setup.setupEffectLedger).toBeNull()
      expect(capture(board)).toBe(failedBoard)
      board.deadPile.push(missing!)
      expect(setup.runSetupDraws()).toBe(true)
      expect(JSON.stringify(containers.drawResults)).toBe(draws)
      expect(containers.setupDrawProgress.complete).toBe(true)
      confirmSetupForStart(setup)
      expect(setup.drawSetupEffectsNow()).toBe(true)
      expect(game.session).not.toBeNull()
    },
  )

  it('整组互换先核对所有来源：返场单位错误地在图上时，不先送走摩托化团', () => {
    const { containers, board } = boot('1', false)
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
    // ch10：初设已确认 ⇒ 抽签已执行过；此处落盘失败表现为"处置未完成"，不再让 finishSetup 返 false
    expect(containers.setupDrawProgress.complete).toBe(false)
  })

  it('抽签失败且零组完成时，执行入口必须报告失败', () => {
    const { setup, containers } = boot('1', false)
    const failed = vi.spyOn(containers, 'runSetupDrawsNow').mockReturnValue({
      ok: false,
      drawnGroups: 0,
      appliedGroups: 0,
      pendingShift: [],
      roadGaps: [],
      placements: [],
      detail: '抽取池不足，未完成抽取',
    })
    confirmSetupForStart(setup, { draws: false })
    expect(setup.drawSetupEffectsNow()).toBe(false)
    expect(setup.lastAction?.ok).toBe(false)
    expect(setup.lastAction?.detail ?? containers.lastAction?.detail).toContain('抽取池不足')
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
      roadGaps: [],
      placements: [],
      detail: '初设抽取失败',
    })
    expect(setup.enterSetup('1')).toBe(true)
    // ch10：抽签改在初设完成后执行 ⇒ 失败在执行入口报出
    confirmSetupForStart(setup, { draws: false })
    expect(setup.drawSetupEffectsNow()).toBe(false)
    expect(setup.lastAction?.detail).toBe('初设抽取失败')
  })

  it('已有但不足额的抽取记录不能标完成，重试也不能悄悄再抽', () => {
    const { setup, containers, board } = boot()
    const row = containers.drawResults['1']![0]!
    row.formationIds = row.formationIds.slice(0, 1)
    const before = capture(board)
    // 已开局 ⇒ 重入被拒；进度未完成 ⇒ 不能标勾（台账不会再补抽）
    expect(setup.runSetupDraws()).toBe(false)
    expect(setup.stepDone.formationDraw).toBe(false)
    expect(capture(board)).toBe(before)
    expect(containers.setupDrawProgress.complete).toBe(false)
    expect(() => setup.drawSetupEffectsNow()).not.toThrow()
  })

  it('抽签台账随存读档复原：读档后不重抽，台账与抽签结果原样回来', () => {
    const { setup, containers, game } = boot()
    game.setSaveStorage(createMemoryStorage())
    const ledger = JSON.stringify(setup.setupEffectLedger)
    const draws = JSON.stringify(containers.drawResults)
    const outcomes = JSON.stringify(containers.formationDrawOutcomes)
    expect(ledger).not.toBe('null')
    expect(game.saveNow()).toBe(true)
    // 模拟刷新/换局导致的本地丢失，再从存档复原
    setup.setupEffectLedger = null
    expect(game.loadNow()).toBe(true)
    expect(JSON.stringify(setup.setupEffectLedger)).toBe(ledger)
    expect(JSON.stringify(containers.drawResults)).toBe(draws)
    expect(JSON.stringify(containers.formationDrawOutcomes)).toBe(outcomes)
    expect(setup.setupDrawEntryVisible).toBe(false)
    expect(setup.drawSetupEffectsNow()).toBe(true) // 幂等：不重抽
    expect(JSON.stringify(containers.drawResults)).toBe(draws)
  })

  it('§4.6 抽签结果清单：条目与台账 placements 一致，抽中的师各一行', () => {
    const { setup, containers } = boot()
    const fromLedger = (setup.setupEffectLedger?.entries ?? []).flatMap(
      (entry) => entry.placements ?? [],
    )
    expect(setup.setupDrawRows).toEqual(fromLedger)
    const drawn = containers.scenarioDrawBox!.groups.flatMap((group) => containers.drawnOf(group))
    expect(setup.setupDrawRows.map((row) => row.formationId)).toEqual([...drawn])
    expect(new Set(setup.setupDrawRows.map((row) => row.formationId)).size).toBe(drawn.length)
  })

  it('§4.6 已落位的行：西移组落点＝盘上单位所在格；不改位置的组目标为空', () => {
    const { setup, containers, board } = boot('1')
    const shifted = setup.setupDrawRows.filter((row) => row.toHex !== null)
    expect(shifted.length).toBeGreaterThan(0)
    for (const row of shifted) {
      expect(row.placed).toBe(true)
      const item = containers.pendingShiftWestPlacements.find(
        (entry) => entry.formationId === row.formationId,
      )!
      expect(row.toHex).toBe(item.hexText)
      for (const instanceId of item.unitIds) {
        const hex = board.units.find((unit) => unit.instanceId === instanceId)!.hex
        expect(`${hex.col}.${hex.row}`).toBe(row.toHex)
      }
    }
    // 改模式 / 进出死亡堆：不换位置（`toHex === null`），处置已落盘
    const inPlace = setup.setupDrawRows.filter((row) => row.toHex === null)
    expect(inPlace.length).toBeGreaterThan(0)
    expect(inPlace.every((row) => row.placed)).toBe(true)
  })

  it('§4.6 未执行抽签时清单为空（面板整区不出现）', () => {
    setActivePinia(createPinia())
    useHotseatStore().setMode('solo')
    const setup = useSetupStore()
    expect(setup.selectScenario('1')).toBe(true)
    confirmSetupForStart(setup, { draws: false })
    expect(setup.setupDrawEntryVisible).toBe(true)
    expect(setup.setupDrawRows).toEqual([])
    expect(setup.drawSetupEffectsNow()).toBe(true)
    expect(setup.setupDrawRows.length).toBeGreaterThan(0)
  })

  it('清盘重建同一剧本时重做抽取处置；换无抽取剧本不会留下旧名单和落点', () => {
    const { setup, containers, board } = boot('1', false)
    const oldIds = board.units.map((unit) => unit.instanceId)
    expect(setup.selectScenario('1')).toBe(true)
    expect(board.units.some((unit) => oldIds.includes(unit.instanceId))).toBe(false)
    // ch10：重开剧本不再自动抽签 ⇒ 旧名单清空，需再走一次「确认初设 → 执行抽取」
    expect(containers.setupDrawProgress.complete).toBe(false)
    expect(containers.drawResults).toEqual({})
    confirmSetupForStart(setup, { draws: false })
    expect(setup.runSetupDraws(), setup.lastAction?.detail).toBe(true)
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
    expect(containers.drawResults).toEqual({})
    confirmSetupForStart(setup)
    expect(setup.drawSetupEffectsNow(), setup.lastAction?.detail).toBe(true)
    expect(Object.keys(containers.drawResults)).toEqual(['2'])
    expect(containers.setupDrawProgress.complete).toBe(true)
  })
})
