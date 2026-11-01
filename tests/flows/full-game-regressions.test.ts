import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { describe, it, expect } from 'vitest'
import { mapLayers, scenarioSetup, scenarios, unitsAxis } from '@/data'
import { deriveDrawComposition, createMapFacts, selectMovementTerrain } from '@/engine/rules'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import { hexCanvasPoint } from '@/render/map-layout'
import { replaySessionLog } from '@/engine/log-book'
import { createMemoryStorage } from '@/shared'
import {
  useSetupStore,
  useWorkbenchStore,
  useGameSessionStore,
  useHotseatStore,
  useMapViewStore,
  SAVE_SLOT_KEY,
} from '@/stores'
import {
  placeGround,
  placeAir,
  airBaseRecord,
  fighterRecord,
  groundRecord,
  CORE_HEX,
} from './sop-harness'

function fresh() {
  setActivePinia(createPinia())
  const setup = useSetupStore(),
    w = useWorkbenchStore(),
    g = useGameSessionStore(),
    hot = useHotseatStore()
  hot.setMode('solo')
  g.setSaveStorage(createMemoryStorage())
  return { setup, w, g, hot }
}
function fillSetup(ctx: ReturnType<typeof fresh>) {
  const { setup, w } = ctx
  if (setup.truckLoadSummary.mode === 'choose_loaded') {
    setup.beginTruckPick()
    const seen = new Set<string>()
    for (const row of setup.truckPickRows) {
      const key = `${row.hex.col}.${row.hex.row}`
      if (seen.has(key)) continue
      seen.add(key)
      setup.pickTruckAtHex(row.hex)
      if (setup.truckLoadSummary.done) break
    }
    setup.cancelTruckPick()
    expect(setup.truckLoadSummary.done).toBe(true)
  }
  for (let n = 0; n < 500; n++) {
    const item = setup.sideQueue
      .flatMap((q) => q.items)
      .find((p) => p.remaining > 0 && p.kind !== 'truck')
    if (!item) {
      if (setup.setupSideCursor) {
        setup.confirmSideSetup()
        continue
      }
      break
    }
    if (item.kind === 'self') setup.beginSelfPlacement(item.entryIndex)
    else if (item.kind === 'air') setup.beginAirPlacement(item.side, item.entryIndex)
    else if (item.kind === 'shift') setup.beginShiftPlacement(item.formationId!)
    const choices = [...(setup.placing?.candidates ?? [])].sort((a, b) => {
      const load = (h: { col: number; row: number }) =>
        w.units
          .filter((u) => u.hex.col === h.col && u.hex.row === h.row)
          .reduce((v, u) => v + u.re, 0) +
        100 * w.airUnits.filter((u) => u.hex.col === h.col && u.hex.row === h.row).length +
        1000 * w.spDumps.filter((d) => d.hex.col === h.col && d.hex.row === h.row).length
      return load(a) - load(b)
    })
    expect(choices.length).toBeGreaterThan(0)
    expect(setup.placeAtHex(choices[0]!)).toBe(true)
  }
  expect(setup.pendingPlacement.filter((p) => p.remaining > 0)).toHaveLength(0)
  expect(setup.initialPlacementsComplete).toBe(true)
}

/** 测试玩家明确选择不供养，并按单位顺序分配已判损失；生产程序不替玩家选择。 */
function answerBoardChoices(ctx: ReturnType<typeof fresh>) {
  const { w } = ctx
  if (w.phase === 'movement' && w.actionAllowedNow('move.modeChange')) {
    for (const unit of w.units.filter(
      (u) => u.side === w.activeSide && u.mode.mode === 'reserve',
    )) {
      w.movePick = null
      w.selectedId = unit.instanceId
      w.switchUnitMode('combat')
    }
  }
  if (w.phase !== 'supply' || !w.supplyFeedingSettled) return
  for (const duty of w.supplyPhasePlan?.attritionDuty ?? []) {
    const key = `${duty.hex.col}.${duty.hex.row}`
    if (w.attritionAppliedHexes.includes(key)) continue
    const rolled = w.attritionResults[key]
    if (!rolled) continue
    let left = rolled.losses.kind === 'allSteps' ? Number.POSITIVE_INFINITY : rolled.losses.steps
    for (const id of duty.unitIds) {
      const unit = w.units.find((u) => u.instanceId === id)
      if (!unit) continue
      const loss = Math.min(left, unit.steps)
      w.setAttritionAllocation(key, id, loss)
      left -= loss
    }
    expect(
      w.applyAttritionNow(key),
      JSON.stringify({ key, rolled, inputs: w.attritionInputs[key], log: w.log[0] }),
    ).toBe(true)
  }
}
async function progress(ctx: ReturnType<typeof fresh>, done: () => boolean, limit = 3000) {
  for (let n = 0; n < limit && !done(); n++) {
    answerBoardChoices(ctx)
    if (ctx.g.awaiting) expect(ctx.g.answerNow('first')).toBe(true)
    else ctx.w.advanceSegmentNow()
    await nextTick()
    if (n % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(done()).toBe(true)
}

describe('整局主线回归：开局、自动结算、玩家义务和持久化', () => {
  for (const scenario of scenarios.scenarios) {
    it(`剧本 ${scenario.id}：双方完整初设并走完一个双方玩家回合`, async () => {
      const ctx = fresh()
      expect(ctx.setup.enterSetup(scenario.id)).toBe(true)
      fillSetup(ctx)
      expect(ctx.setup.startGameNow()).toBe(true)
      await nextTick()
      const turn = ctx.w.turn
      await progress(ctx, () => ctx.w.turn > turn || ctx.g.terminated)
      expect(ctx.g.log.filter((e) => e.action === 'variableRepl')).toHaveLength(2)
      expect(ctx.g.log.filter((e) => e.action === 'cleanUp')).toHaveLength(2)
      const replay = replaySessionLog(ctx.g.session!)
      expect(replay.ok, replay.detail).toBe(true)
    }, 60000)
  }
  it('剧本 1：正式流程在提前决胜生效日终止，重开重新生成初设', async () => {
    const ctx = fresh()
    ctx.setup.enterSetup('1')
    fillSetup(ctx)
    ctx.setup.startGameNow()
    await progress(ctx, () => ctx.g.terminated, 5000)
    expect(ctx.g.termination).toBe('earlyDecision')
    expect(ctx.w.turn).toBe(13)
    expect(ctx.w.decisiveVictory.winner).toBe('soviet')
    const oldIds = ctx.w.units.map((u) => u.instanceId)
    expect(ctx.setup.restartGameNow()).toBe(true)
    expect(ctx.g.session).toBeNull()
    expect(ctx.setup.finished).toBe(false)
    expect(ctx.w.units.length).toBeGreaterThan(0)
    expect(ctx.w.units.some((u) => oldIds.includes(u.instanceId))).toBe(false)
  }, 180000)
  it('共识草稿跨初设、开局和读档保持一致', () => {
    const { setup, g } = fresh()
    g.setAllAgreedChecks(true)
    const count = g.agreedCheckedCount
    setup.enterSetup('1')
    expect(g.agreedCheckedCount).toBe(count)
    setup.startGameNow()
    expect(g.consensus.filter((c) => c.adopted === true)).toHaveLength(count)
    expect(g.saveNow()).toBe(true)
    expect(g.loadNow()).toBe(true)
    expect(g.consensus.filter((c) => c.adopted === true)).toHaveLength(count)
  })
  it('同格 SP 合并保持总量，完成条目不能再生成补给', () => {
    const { setup, w } = fresh()
    setup.enterSetup('1')
    const p = setup.pendingPlacement.find((p) => p.kind === 'self' && p.raw.includes('SP'))!
    const q = setup.pendingPlacement.find(
      (q) =>
        q.kind === 'self' &&
        q.raw.includes('SP') &&
        q.entryIndex !== p.entryIndex &&
        q.candidates.some((h) => p.candidates.some((v) => v.col === h.col && v.row === h.row)),
    )!
    const hex = p.candidates.find((h) =>
      q.candidates.some((v) => h.col === v.col && h.row === v.row),
    )!
    setup.beginSelfPlacement(p.entryIndex)
    expect(setup.placeAtHex(hex)).toBe(true)
    for (
      let n = 0;
      n < 20 &&
      setup.pendingPlacement.some((i) => i.kind === 'self' && i.entryIndex === q.entryIndex);
      n++
    ) {
      setup.beginSelfPlacement(q.entryIndex)
      expect(setup.placeAtHex(hex)).toBe(true)
    }
    expect(
      setup.pendingPlacement.some((i) => i.entryIndex === q.entryIndex && i.kind === 'self'),
    ).toBe(false)
    const total = () => w.spDumps.reduce((v, d) => v + d.sp * 4 + d.t, 0)
    const before = total()
    setup.beginSelfPlacement(q.entryIndex)
    expect(setup.placeAtHex(hex)).toBe(false)
    expect(total()).toBe(before)
  })
  it('初设仍有另一方待办时不能显示全局完成；正式动作在开局前拒绝', () => {
    const { setup, w, g } = fresh()
    setup.enterSetup('1')
    expect(setup.initialPlacementsComplete).toBe(false)
    const unit = w.units.find(
      (u) => u.side === 'axis' && u.isCombat && u.attackCapable && u.raw.ma > 0,
    )!
    w.beginMovePick(unit.hex, [unit.instanceId])
    expect(w.confirmMovePick()).toBe(false)
    expect(g.session).toBeNull()
    expect(w.moveInteraction).toBeNull()
  })
  it('编队抽签选中真实步兵成员，初设死亡飞机实际进入死亡堆', () => {
    const result = deriveDrawComposition({
      rows: scenarioSetup.entries.filter((e) => e.scenarioId === '1'),
      formationId: '20 Mtr Div',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const unit = unitsAxis.units.find((u) => u.id === result.data.mtrRegimentUnitId)!
    expect(unit.specialized ?? []).not.toContain('artillery')
    expect(unit.id).toMatch(/mot-inf/)
    const { setup, w } = fresh()
    setup.enterSetup('1')
    const expected = setup
      .plan!.pieces.filter((p) => p.unitIdKind === 'aircraft' && p.toDeadPile)
      .map((p) => p.unitId)
    const actual = w.deadPile
      .filter((e) => 'aircraftId' in e)
      .map((e) => ('aircraftId' in e ? e.aircraftId : ''))
    expect(actual).toEqual(expected)
    expect(
      setup.sideQueue
        .flatMap((q) => q.items)
        .filter((i) => i.imageUrl)
        .every((i) => i.imageUrl!.startsWith('/counters/')),
    ).toBe(true)
  })
  it('首页冷读档恢复盘面、环节、MP、燃料窗口与初设完成状态', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('1')
    ctx.setup.startGameNow()
    ctx.w.setPhase('movement')
    ctx.w.setSegmentStepIndex(1)
    const unit = ctx.w.units.find((u) => u.isCombat)!
    unit.mpSpent = 1
    const before = ctx.w.units.map((u) => ({ id: u.instanceId, hex: u.hex, mp: u.mpSpent }))
    expect(ctx.g.saveNow()).toBe(true)
    const storage = ctx.g.storage!
    setActivePinia(createPinia())
    const g = useGameSessionStore()
    g.setSaveStorage(storage)
    expect(g.loadNow()).toBe(true)
    const w = useWorkbenchStore(),
      setup = useSetupStore()
    expect(w.units.map((u) => ({ id: u.instanceId, hex: u.hex, mp: u.mpSpent }))).toEqual(before)
    expect(w.segmentStepPosition.index).toBe(1)
    expect(setup.finished).toBe(true)
    expect(setup.ensureSetupLoaded()).toBe(false)
    // 真实整图冷启动与恢复接近 5 秒；并行全量运行时需留出调度余量。
  }, 15000)
  it('坏盘面读取失败时不改变正在进行的对局', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('1')
    ctx.setup.startGameNow()
    expect(ctx.g.saveNow()).toBe(true)
    const storage = ctx.g.storage!,
      payload = JSON.parse(storage.getItem(SAVE_SLOT_KEY)!) as {
        board: { fields: Record<string, unknown> }
      }
    payload.board.fields['units'] = [null]
    storage.setItem(SAVE_SLOT_KEY, JSON.stringify(payload))
    const before = JSON.stringify({ state: ctx.g.session, units: ctx.w.units, air: ctx.w.airUnits })
    expect(ctx.g.loadNow()).toBe(false)
    expect(JSON.stringify({ state: ctx.g.session, units: ctx.w.units, air: ctx.w.airUnits })).toBe(
      before,
    )
  })
  it('整备付款优先于展开堆叠，一次点击激活飞机并只扣一次款', () => {
    const { w } = fresh()
    w.setPhase('aircraftRefit')
    const base = placeGround(w, airBaseRecord(1), CORE_HEX, 'axis', 'base')
    placeAir(w, fighterRecord('axis'), CORE_HEX, 'axis', 'plane', 'inactive')
    w.spDumps.push({ id: 'dump', hex: { ...CORE_HEX }, side: 'axis', sp: 2, t: 0 })
    const map = useMapViewStore()
    map.expandStackAt(CORE_HEX)
    expect(w.beginRefitNow(base.instanceId)).toBe(true)
    w.toggleRefitAircraft('plane')
    map.onHexClick(CORE_HEX, undefined, hexCanvasPoint(CORE_HEX))
    expect(w.airUnits.find((u) => u.instanceId === 'plane')?.airStatus).toBe('active')
    expect(w.spDumps[0]!.sp * 4 + w.spDumps[0]!.t).toBe(7)
  })
  it('反应交接与取消交接不改玩家回合归属或清空阶段账本', async () => {
    const ctx = fresh()
    ctx.hot.setMode('pvp')
    ctx.g.startGame()
    await progress(ctx, () => ctx.w.phase === 'reaction')
    expect(ctx.hot.viewerSide).toBe('soviet')
    const side = ctx.w.activeSide
    const ledger = ctx.w.attackPhaseLedger
    ctx.hot.beginHandoff()
    expect(ctx.w.activeSide).toBe(side)
    expect(ctx.g.guidance?.step.id).toBe('first.reaction')
    ctx.hot.cancelHandoff()
    expect(ctx.hot.viewerSide).toBe('soviet')
    expect(ctx.w.attackPhaseLedger).toEqual(ledger)
  })
  it('E段非行动方释放预备后可以实际开拔，行动方身份保持不变', () => {
    const { w } = fresh()
    w.setPhase('reaction')
    const record = groundRecord(
      'soviet',
      (r) =>
        r.attackCapable === true &&
        r.classes?.movementClass === 'leg' &&
        (r.factors?.combat?.ma ?? 0) > 0,
    )
    const unit = placeGround(w, record, CORE_HEX, 'soviet', 'reactor')
    unit.mode.mode = 'reserve'
    w.selectedId = unit.instanceId
    expect(w.releaseReserveNow()).toBe(true)
    w.beginMovePick(CORE_HEX, [unit.instanceId])
    expect(w.confirmMovePick()).toBe(true)
    expect(w.moveInteraction?.unitIds).toEqual(['reactor'])
    expect(w.activeSide).toBe('axis')
  })
  it('D段强制恢复在推进前落实，同一计划重复提交不重复收费', () => {
    const { w } = fresh()
    w.setPhase('supply')
    const record = groundRecord('axis', (r) => r.attackCapable === true && (r.reSize ?? 0) > 0)
    const unit = placeGround(w, record, CORE_HEX, 'axis', 'recover')
    unit.internalStocks = 'low'
    w.spDumps.push({ id: 'stock', hex: CORE_HEX, side: 'axis', sp: 8, t: 0 })
    expect(w.planSupplyPhaseNow()).toBe(true)
    expect(w.applySupplyPhaseRecoveryNow()).toBe(true)
    const paid = w.spDumps[0]!.sp * 4 + w.spDumps[0]!.t
    expect(paid).toBeLessThan(32)
    expect(unit.internalStocks).toBeNull()
    expect(w.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(w.spDumps[0]!.sp * 4 + w.spDumps[0]!.t).toBe(paid)
    w.advanceSegmentNow()
    expect(w.segmentStep?.id).toBe('supply.check')
  })
  it('掷骰后战斗不能取消或保存，损失完整结算后才能继续', async () => {
    const ctx = fresh(),
      { w, g } = ctx,
      mapFacts = createMapFacts()
    const from = HEX_DIRECTIONS.map((d) => neighbor(CORE_HEX, d)).find(
      (h) =>
        mapLayers.hexes.some((v) => v.col === h.col && v.row === h.row) &&
        selectMovementTerrain({
          terrainsPresent: mapFacts.terrainsAt(CORE_HEX),
          mobility: 'leg',
          crossing: mapFacts.crossingBetween(h, CORE_HEX),
          followingRoad: true,
          forOverrun: false,
        }).ok,
    )!
    const ar = groundRecord(
      'axis',
      (r) =>
        r.attackCapable === true &&
        (r.steps?.total ?? 1) >= 2 &&
        (r.factors?.combat?.attack ?? 0) >= 3,
    )
    const dr = groundRecord(
      'soviet',
      (r) => r.attackCapable === true && (r.steps?.total ?? 1) >= 2 && r.branch === 'infantry',
    )
    const a = placeGround(w, ar, from, 'axis', 'a'),
      d = placeGround(w, dr, CORE_HEX, 'soviet', 'd')
    w.spDumps.push(
      { id: 'da', hex: { ...from }, side: 'axis', sp: 8, t: 0 },
      { id: 'dd', hex: { ...CORE_HEX }, side: 'soviet', sp: 8, t: 0 },
    )
    g.startGame(19410708)
    await progress(ctx, () => w.segmentStep?.id === 'combat.combat')
    w.clickHex(from)
    w.clickHex(CORE_HEX)
    expect(w.beginCombatNow()).toBe(true)
    w.pickCombatSupplyDump('attacker', 'da')
    w.pickCombatSupplyDump('defender', 'dd')
    expect(w.confirmCombatSupply()).toBe(true)
    w.combatInputs.attackerArUnitId = a.instanceId
    expect(w.declareCombatArStep('attacker')).toBe(true)
    w.combatInputs.defenderArUnitId = d.instanceId
    expect(w.declareCombatArStep('defender')).toBe(true)
    expect(w.declareCombatTerrainStep()).toBe(true)
    w.rollCombatSurprise()
    if (w.combatAwaitingShiftDie) w.rollCombatShiftDie()
    expect(w.rollCombatDice()).toBe(true)
    const pending = w.combatState
    expect(g.saveNow()).toBe(false)
    w.cancelCombat()
    expect(w.combatState).toBe(pending)
    expect(w.advanceSegmentNow()).toBeNull()
    for (let n = 0; n < 12 && !w.combatState?.finished; n++) {
      const step = w.combatState?.step
      if (step === 'losses') expect(w.confirmCombatLosses()).toBe(true)
      else if (step === 'options') {
        w.combatInputs.optionLossPoints = w.combatRequirement?.options ?? 0
        expect(w.confirmCombatOptions()).toBe(true)
      } else if (step === 'retreat') expect(w.confirmCombatRetreats()).toBe(true)
      else if (step === 'advance') expect(w.confirmCombatAdvance()).toBe(true)
      else throw new Error(`战斗停在未处理的步骤 ${step}`)
    }
    expect(w.combatState?.finished).toBe(true)
    expect(g.saveNow()).toBe(true)
  }, 30000)
})
