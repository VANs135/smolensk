import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '@/shared'
import {
  toConsoleUnit,
  useContainersStore,
  useGameSessionStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'
import { groundRecord, placeGround } from './sop-harness'

/**
 * B 段（增援与编制）操作级实测 —— 剧本 1「斯摩棱斯克」
 *
 * 用户口径（2026-11-15）：教学剧本没有增援/可变补员，必须用剧本 1 走真实链路：
 * 确认布设 → 放弃未布设 → 抽编队（三步必做）→ `saveNow()` → 冷读档 → 真推进到 B 段，
 * 然后**逐环节真操作**（掷骰检定 / 到货落位 / 重建与整编），每环节同时抓面板文本与 store 事实。
 *
 * 不走 `w.setPhase('reinforcement')` 之类的捷径：一切状态都由会话推进出来。
 */

type Stores = {
  g: ReturnType<typeof useGameSessionStore>
  w: ReturnType<typeof useWorkbenchStore>
  setup: ReturnType<typeof useSetupStore>
  mapView: ReturnType<typeof useMapViewStore>
  containers: ReturnType<typeof useContainersStore>
  storage: ReturnType<typeof createMemoryStorage>
}

function mount(storage: ReturnType<typeof createMemoryStorage>): Stores {
  setActivePinia(createPinia())
  const g = useGameSessionStore()
  g.setSaveStorage(storage)
  useHotseatStore().setMode('solo')
  return {
    g,
    w: useWorkbenchStore(),
    setup: useSetupStore(),
    mapView: useMapViewStore(),
    containers: useContainersStore(),
    storage,
  }
}

/** 确认布设 → 放弃未布设 → 抽编队 → 存档（用户指定的三步必做） */
function setupConfirmAbandonDrawSave(s: Stores): void {
  const { setup, g } = s
  expect(setup.enterSetup('1')).toBe(true)
  if (setup.requiredSetupIssues.some((issue) => issue.id === 'spOwnership')) {
    for (const dump of setup.spDumpsOf('axis')) setup.setSpAssignment(dump.id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(true)
  }
  if (setup.truckLoadSummary.mode === 'choose_loaded' && !setup.truckLoadSummary.done) {
    expect(setup.beginTruckPick()).toBe(true)
    const seen = new Set<string>()
    for (const row of setup.truckPickRows) {
      const key = `${row.hex.col}.${row.hex.row}`
      if (seen.has(key) || row.full) continue
      seen.add(key)
      expect(setup.pickTruckAtHex(row.hex)).toBe(true)
      if (setup.truckLoadSummary.done) break
    }
    expect(setup.truckLoadSummary.done).toBe(true)
    setup.cancelTruckPick()
  }
  // ① 确认布设
  for (let guard = 0; setup.setupSideCursor !== null && guard < 2; guard++) {
    expect(setup.confirmSideSetup()).toBe(true)
  }
  expect(setup.setupSideCursor).toBeNull()
  // ② 放弃未布设（以「初设已确认」收束；未落位项记为本局移除）
  expect(setup.startGameNow(), setup.lastAction?.detail).toBe(true)
  expect(setup.finished).toBe(true)
  expect(setup.lastAction?.detail ?? '').toContain('初设已确认')
  const omitted = setup.notes.filter((note) => note.includes('未初设 ⇒ 本局移除'))
  expect(omitted.length).toBeGreaterThan(0)
  // ③ 抽编队（本剧本只有 formationDraw 一种强制效果；入口必须可见）
  expect(setup.setupDrawEntryVisible).toBe(true)
  expect(setup.drawSetupEffectsNow(), setup.lastAction?.detail).toBe(true)
  expect(setup.setupDrawEntryVisible).toBe(false)
  expect(s.containers.formationDrawOutcomes.length).toBeGreaterThan(0)
  // ④ 存档
  expect(g.saveNow()).toBe(true)
}

/**
 * 冷读档后**真推进**到第 2 回合轴方 B 段（12 July 有真实到货）。
 *
 * 推进途中若被「本方手牌未落位」闸门挡住（刚补上的 1.6b 守卫），
 * 测试玩家按面板「结束本段」确认放弃——这是合法玩家动作，不是跳过用例。
 */
async function advanceToAxisReinforcement(s: Stores): Promise<void> {
  const { w, g, containers } = s
  for (let n = 0; n < 3000; n++) {
    if (w.turn === 2 && w.phase === 'reinforcement' && w.activeSide === 'axis') return
    if (g.awaiting) {
      expect(g.answerNow('first')).toBe(true)
      await nextTick()
      continue
    }
    if (w.advanceSegmentNow()) {
      await nextTick()
      continue
    }
    const blocked = w.advanceBlock
    if (
      blocked?.rule === '1.6b' &&
      w.segmentStep?.id === 'reinforcement.replRoll' &&
      w.rollHandPending
    ) {
      containers.drawSpecialRepl(w.activeSide, w.variableReplSpecialDie ?? undefined)
      expect(w.endRollSegmentNow(true)).toBe(true)
      await nextTick()
      continue
    }
    throw new Error(`推进被阻断：${JSON.stringify(blocked)}（${w.phase}/${w.activeSide}）`)
  }
  throw new Error(
    `未能在限定步数内到达第 2 回合轴方 B 段（现在 ${w.turn}/${w.phase}/${w.activeSide}）`,
  )
}

/** 完整链路：确认/放弃/抽签 → 存档 → 冷读档 → 推进到 B 段 */
async function bootToAxisReinforcement(): Promise<Stores> {
  const storage = createMemoryStorage()
  const first = mount(storage)
  setupConfirmAbandonDrawSave(first)
  const loaded = mount(storage)
  expect(loaded.g.loadNow()).toBe(true)
  expect(loaded.setup.finished).toBe(true)
  expect(loaded.g.session).not.toBeNull()
  await nextTick()
  await advanceToAxisReinforcement(loaded)
  return loaded
}

describe('B 增援段操作级实测（剧本 1）', () => {
  it('掷骰检定：骰点 / SP 与补员数量 / 来源都落账，手牌只含本方本次所得', async () => {
    const s = await bootToAxisReinforcement()
    const { w, g, mapView, containers } = s

    // 面板：B 段会话已开，先落在「当日到达」宿主
    expect(mapView.session?.kind).toBe('reinforce')
    expect(mapView.session?.title).toContain('增援')
    expect(mapView.sessionStep?.id).toBe('reinforce:arrival')

    // 切到第二段宿主（面板的补员表卡）
    const rollStep = w.playerSegmentSteps.findIndex((step) => step.id === 'reinforcement.replRoll')
    expect(rollStep).toBeGreaterThanOrEqual(0)
    expect(w.setSegmentStepIndex(rollStep)).toBe(true)
    await nextTick()
    expect(mapView.sessionStep?.id).toBe('reinforce:roll')
    expect(mapView.sessionStep?.title).toContain('掷骰')
    expect(mapView.sessionStep?.title).toContain('落位')

    // store 事实：1.6b 的掷骰结果
    const repl = w.lastVariableRepl
    expect(repl).not.toBeNull()
    expect(repl!.rule).toBe('1.6b')
    expect(repl!.detail).toContain('补给表')
    expect(repl!.detail).toContain('补员表')
    expect(repl!.repl.pax + repl!.repl.eq + repl!.repl.ftr + repl!.repl.tac).toBeGreaterThan(0)

    // 结算记录：骰点、SP、补员数量与来源都在账上
    const rollEntry = g.log.find(
      (entry) => entry.action === 'variableRepl' && entry.turn === 2 && entry.side === 'axis',
    )
    expect(rollEntry).toBeDefined()
    expect(rollEntry!.outcome.rule).toBe('1.6b')
    expect(rollEntry!.rolls).toHaveLength(5)
    const settled = rollEntry!.outcome
    expect(settled.ok).toBe(true)
    const settledRepl = settled.ok ? (settled.data.repl as { pax: number; eq: number }) : undefined
    expect(settledRepl).toMatchObject({ pax: repl!.repl.pax, eq: repl!.repl.eq })
    // SP 去向（专规 1.6b「place new units per 2.1 and 3.1」+ 2.1/3.1 免费铁运）：
    // 进到货落账池 → 城市格每格 1 SP、余额落图边补给源格；**不再**进图外空军盒
    expect(w.offMapRollDeposit).toBeNull()
    expect(g.log.some((entry) => entry.action === 'offMapSupplyDeposit' && entry.turn === 2)).toBe(
      false,
    )
    expect(w.supplyArrivalSp).toBe(repl!.sp)

    // 1.6c「掷骰检定」：同一颗骰子，结果落账
    expect(w.hasSpecialReplDraw('axis', 2)).toBe(false)
    expect(containers.drawSpecialRepl('axis', w.variableReplSpecialDie ?? undefined)).toBe(true)
    expect(containers.specialReplLast?.side).toBe('axis')
    expect(containers.specialReplLast?.die).toBe(w.variableReplSpecialDie)
    expect(containers.specialReplLast?.detail).toContain('1.6c')

    // 手牌与账本：数量只能来自本方本次掷骰（不得混入对手上一方的待放项）
    expect(w.replPending).toEqual({ pax: repl!.repl.pax, eq: repl!.repl.eq })
    expect(w.replHoldings.ftr).toBe(repl!.repl.ftr)
    expect(w.replHoldings.tac).toBe(repl!.repl.tac)
    const hand = new Map(w.rollHandEntries.map((entry) => [entry.id, entry.count]))
    expect(hand.get('repl:pax') ?? 0).toBe(repl!.repl.pax)
    expect(hand.get('repl:eq') ?? 0).toBe(repl!.repl.eq)
    // 补给表 SP 在同一张手牌里（判完全部骰子后可逐格点）
    expect(hand.get('sp:arrival') ?? 0).toBe(repl!.sp)
  }, 60000)

  it('★ 1.6b 补给表 SP：城市格每格 1 点（免费铁运）+ 余额落图边补给源格', async () => {
    const s = await bootToAxisReinforcement()
    const { w, containers } = s
    const rollStep = w.playerSegmentSteps.findIndex((step) => step.id === 'reinforcement.replRoll')
    expect(w.setSegmentStepIndex(rollStep)).toBe(true)
    await nextTick()
    const sp = w.lastVariableRepl!.sp
    expect(sp).toBeGreaterThan(0)
    // 修前：SP 直接进图外空军盒，手牌里没有、图上放不了
    expect(w.offMapRollDeposit).toBeNull()
    expect(w.supplyArrivalSp).toBe(sp)

    // 判定未走完 ⇒ 闸门关着（面板也不给可点卡）
    expect(w.rollPlacementOpen).toBe(false)
    expect(containers.drawSpecialRepl('axis', w.variableReplSpecialDie ?? undefined)).toBe(true)
    expect(w.rollPlacementOpen).toBe(true)

    // 免费铁运城市格（若盘面有）每格 1 SP；点图边补给源格 ⇒ 其余全部落那里
    const city = w.freeRailCityCandidates[0]
    if (city !== undefined) {
      expect(w.beginRollHandEntryNow('sp:arrival')).toBe(true)
      expect(w.pickHexFor(city.hex)).toBe(true)
      expect(w.supplyTableUnplaced).toBe(sp - 1)
    }
    const edge = w.openSupplySourceHexes[0]!
    expect(w.beginRollHandEntryNow('sp:arrival')).toBe(true)
    expect(w.pickHexFor(edge)).toBe(true)
    expect(w.supplyTableUnplaced).toBe(0)
    expect(w.rollHandEntries.some((entry) => entry.id === 'sp:arrival')).toBe(false)

    // 落账（12.1b）：免费铁运城市格 1 SP、余额全在那一个图边源格上
    const spAt = (hex: { col: number; row: number }): number =>
      w.allSpDumps
        .filter(
          (item) => item.side === 'axis' && item.hex.col === hex.col && item.hex.row === hex.row,
        )
        .reduce((sum, item) => sum + item.sp, 0)
    const cityBefore = city === undefined ? 0 : spAt(city.hex)
    const edgeBefore = spAt(edge)
    expect(w.applySupplyArrivalsNow()).toBe(true)
    const sameHex = city !== undefined && city.hex.col === edge.col && city.hex.row === edge.row
    if (city !== undefined) {
      expect(spAt(city.hex) - cityBefore).toBe(1)
    }
    expect(spAt(edge) - edgeBefore).toBe(sameHex ? sp - 1 : sp - (city === undefined ? 0 : 1))
  }, 60000)

  it('★ 1.6c：轴方抽到 Aufk/Krd（5–6）时，死亡堆里的侦察营进手牌而不是作废', async () => {
    const s = await bootToAxisReinforcement()
    const { w, containers } = s
    const rollStep = w.playerSegmentSteps.findIndex((step) => step.id === 'reinforcement.replRoll')
    expect(w.setSegmentStepIndex(rollStep)).toBe(true)
    await nextTick()

    // 死亡堆里放一枚轴方装甲侦察营（数据标记 special_repl_to_rebuild）
    const record = groundRecord('axis', (item) => item.id === 'ax-arm_rec-ge-14-mtr-14-arm-rec')
    w.deadPile.push(
      toConsoleUnit({ record, instanceId: 'ax-dead-aufk', hex: { col: 0, row: 0 }, side: 'axis' }),
    )

    expect(containers.drawSpecialRepl('axis', 5)).toBe(true)
    // 修前：第二项按苏方 Alarm 清单找 ⇒ 永远 `void`，手牌里没有这一枚
    expect(w.specialReplPending.length).toBe(1)
    const returned = w.specialReplPending[0]!
    const returnedUnit = w.deadPile.find((item) => item.instanceId === returned.instanceId)
    expect(returnedUnit?.side).toBe('axis')
    // 面板摘要只写实际落到的：这一项是「unit」，不是凭空承诺
    expect(containers.specialReplLast?.grant).toBe('unit')
    await nextTick()
    const hand = w.rollHandEntries.find((entry) => entry.id === 'unit:special:0')
    expect(hand).toBeDefined()
    expect(hand!.blocked).toBeNull()
  }, 60000)

  it('到货落位：候选＝卡面进场格；13.6a 允许临时超堆叠；落不下时拒绝并说明', async () => {
    const s = await bootToAxisReinforcement()
    const { w, mapView } = s
    const arrivalStep = w.playerSegmentSteps.findIndex(
      (step) => step.id === 'reinforcement.arrival',
    )
    expect(arrivalStep).toBeGreaterThanOrEqual(0)
    expect(w.setSegmentStepIndex(arrivalStep)).toBe(true)
    await nextTick()
    expect(mapView.sessionStep?.id).toBe('reinforce:arrival')
    expect(mapView.sessionStep?.title).toContain('当日到达落位')

    // 1.6a：到达卡上的 Remove 条目必须先在放置前执行
    expect(w.arrivalRemovalsPending).toBe(true)
    w.applyArrivalRemovalsNow()
    await nextTick()
    expect(w.arrivalRemovalsPending).toBe(false)

    const plan = w.arrivalPlan
    expect(plan).not.toBeNull()
    const candidatesOf = (index: number) => w.arrivalCandidates[index] ?? []
    const singleUnitIndex = (exclude: readonly number[] = []): number =>
      plan!.units.findIndex(
        (unit, index) =>
          unit.kind === 'unit' &&
          !exclude.includes(index) &&
          !w.arrivalPlaced[index] &&
          candidatesOf(index).length === 1,
      )

    // ① 正常：候选就是卡面进场格，点格即落到该格
    const normal = singleUnitIndex()
    expect(normal).toBeGreaterThanOrEqual(0)
    const entry = candidatesOf(normal)[0]!
    expect(w.arrivalPlacements[normal]?.hex).toMatchObject(entry)
    expect(w.beginArrivalPlacePickNow(normal)).toBe(true)
    expect(w.hexPickView?.candidates).toEqual([entry])
    expect(w.pickHexFor(entry)).toBe(true)
    await nextTick()
    expect(w.arrivalPlaced[normal]).toBe(true)
    const landedIds = w.arrivalPlacedUnits[normal] ?? []
    expect(landedIds.length).toBeGreaterThan(0)
    for (const id of landedIds) {
      const unit = w.units.find((item) => item.instanceId === id)
      expect(unit, id).toBeDefined()
      expect(unit!.side).toBe('axis')
      expect({ col: unit!.hex.col, row: unit!.hex.row }).toEqual(entry)
    }

    // ② 堆叠：进场格上先堆到 >10 RE，13.6a 仍允许落位；B 段不产生 4.8a 义务
    const stacked = singleUnitIndex([normal])
    expect(stacked).toBeGreaterThanOrEqual(0)
    const stackedHex = candidatesOf(stacked)[0]!
    const record = groundRecord('axis', (item) => item.isCombat === true)
    for (let n = 0; n < 6; n++) {
      placeGround(w, record, stackedHex, 'axis', `fixture-stack-${n}`)
    }
    expect(
      w.units
        .filter((unit) => unit.hex.col === stackedHex.col && unit.hex.row === stackedHex.row)
        .reduce((sum, unit) => sum + unit.re, 0),
    ).toBeGreaterThan(10)
    expect(w.beginArrivalPlacePickNow(stacked)).toBe(true)
    expect(w.pickHexFor(stackedHex)).toBe(true)
    await nextTick()
    expect(w.arrivalPlaced[stacked]).toBe(true)
    expect(w.overstackDuties).toHaveLength(0)

    // ③ 落不下：敌单位占住进场格 ⇒ 不落位，并给出可见原因（不是静默失败）
    const blockedIndex = singleUnitIndex([normal, stacked])
    expect(blockedIndex).toBeGreaterThanOrEqual(0)
    const blockedHex = candidatesOf(blockedIndex)[0]!
    const enemy = groundRecord('soviet', (item) => item.isCombat === true)
    placeGround(w, enemy, blockedHex, 'soviet', 'fixture-blocker')
    await nextTick()
    const redirected = candidatesOf(blockedIndex)
    expect(redirected.some((hex) => hex.col === blockedHex.col && hex.row === blockedHex.row)).toBe(
      false,
    )
    expect(w.beginArrivalPlacePickNow(blockedIndex)).toBe(true)
    expect(w.pickHexFor(blockedHex)).toBe(true)
    await nextTick()
    expect(w.arrivalPlaced[blockedIndex]).not.toBe(true)
    expect(w.log[0]?.text ?? '').toContain('不是「增援落点')
  }, 60000)

  it('重建与整编：补员点算子再点格落位，账本与死亡堆重建同步', async () => {
    const s = await bootToAxisReinforcement()
    const { w, mapView, containers } = s
    const rollStep = w.playerSegmentSteps.findIndex((step) => step.id === 'reinforcement.replRoll')
    expect(w.setSegmentStepIndex(rollStep)).toBe(true)
    await nextTick()
    // 1.6c 判定必须先完成，放置阶段才开放
    containers.drawSpecialRepl(w.activeSide, w.variableReplSpecialDie ?? undefined)
    await nextTick()

    // ① 手牌投影：点一条 → 高亮合法格 → 点格落下
    const placementHex = w.replInitialPlacementHexesFor.pax[0]!
    expect(placementHex).toBeDefined()
    const paxBefore = w.replPending.pax
    const eqBefore = w.replPending.eq
    expect(paxBefore).toBeGreaterThan(0)
    expect(eqBefore).toBeGreaterThan(0)
    expect(w.replHoldings.pax).toBe(0)
    expect(w.replHoldings.eq).toBe(0)
    expect(mapView.sessionSteps.map((step) => step.id)).toContain('reinforce:roll')

    for (let n = 0; n < paxBefore; n++) {
      expect(w.beginRollHandEntryNow('repl:pax')).toBe(true)
      expect(w.hexPickView?.candidates).toEqual(w.replInitialPlacementHexesFor.pax)
      expect(w.pickHexFor(placementHex)).toBe(true)
      await nextTick()
    }
    expect(w.replPending.pax).toBe(0)
    expect(w.replHoldings.pax).toBe(paxBefore)
    expect(
      w.units.filter(
        (unit) =>
          unit.replKind === 'pax' &&
          unit.hex.col === placementHex.col &&
          unit.hex.row === placementHex.row,
      ),
    ).toHaveLength(paxBefore)

    expect(w.beginRollHandEntryNow('repl:eq')).toBe(true)
    expect(w.pickHexFor(placementHex)).toBe(true)
    await nextTick()
    expect(w.replPending.eq).toBe(0)
    expect(w.replHoldings.eq).toBe(eqBefore)
    expect(w.rollHandEntries.filter((entry) => entry.id.startsWith('repl:'))).toHaveLength(0)
    // 1.6b 补给表 SP 也在这张手牌里：点一个图边补给源格（余额全部落那里）才清零
    const edgeSpHex = w.openSupplySourceHexes[0]!
    expect(w.beginRollHandEntryNow('sp:arrival')).toBe(true)
    expect(w.pickHexFor(edgeSpHex)).toBe(true)
    expect(w.rollHandPending).toBe(false)
    expect(w.rollHandPoints).toBe(0)

    // ② 死亡堆重建：右键单位 → 高亮合法格（含刚放下补员的格）→ 点格扣点回场
    const rebuildStep = w.playerSegmentSteps.findIndex(
      (step) => step.id === 'reinforcement.rebuild',
    )
    expect(w.setSegmentStepIndex(rebuildStep)).toBe(true)
    await nextTick()
    expect(mapView.session?.title).toContain('重建与整编')
    expect(mapView.sessionStep?.id).toBe('reinforce:endRebuild')

    const deadId = w.deadPile
      .map((unit) => unit.instanceId)
      .find((id) => {
        const hexes = w.rebuildLegalHexes(id)
        return hexes.some((hex) => hex.col === placementHex.col && hex.row === placementHex.row)
      })
    expect(deadId, '死亡堆里应有一枚能用刚放下的补员重建的单位').toBeDefined()
    const deadBefore = w.deadPile.find((unit) => unit.instanceId === deadId)!
    expect(w.beginDeadPileRebuildNow(deadId!)).toBe(true)
    expect(w.hexPickView?.candidates).toContainEqual(placementHex)
    expect(w.pickHexFor(placementHex)).toBe(true)
    await nextTick()

    expect(w.deadPile.some((unit) => unit.instanceId === deadId)).toBe(false)
    const rebuilt = w.units.find(
      (unit) =>
        unit.hex.col === placementHex.col &&
        unit.hex.row === placementHex.row &&
        unit.name === deadBefore.name,
    )
    expect(rebuilt, deadBefore.name).toBeDefined()
    expect(rebuilt!.steps).toBeGreaterThan(0)
    // 账本同步：Eq 补员被扣掉，Pax 仍留在图上（跨段可用，不清空）
    expect(w.replHoldings.eq).toBe(eqBefore - 1)
    expect(w.replHoldings.pax).toBe(paxBefore)
    expect(w.log.some((line) => line.text.includes('重建'))).toBe(true)
  }, 60000)
})
