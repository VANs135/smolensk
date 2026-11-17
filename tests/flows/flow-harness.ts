import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { expect } from 'vitest'

import { createMemoryStorage } from '@/shared'
import {
  useContainersStore,
  useSetupStore,
  useWorkbenchStore,
  useGameSessionStore,
  useHotseatStore,
} from '@/stores'

/**
 * flow 级用例的公用夹具（从 `full-game-regressions.test.ts` 抽出）
 *
 * 只做「开新局 / 摆完初设 / 替测试玩家答复盘面义务 / 推进到某状态」，
 * 不含任何断言主题 —— 供整局回归与反应交接等分文件共用，避免同一段流程两份实现。
 */

export function fresh() {
  setActivePinia(createPinia())
  const setup = useSetupStore(),
    w = useWorkbenchStore(),
    g = useGameSessionStore(),
    hot = useHotseatStore()
  hot.setMode('solo')
  g.setSaveStorage(createMemoryStorage())
  return { setup, w, g, hot }
}

export function fillSetup(ctx: ReturnType<typeof fresh>) {
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
  const placeRemaining = () => {
    for (let n = 0; n < 500; n++) {
      const item = setup.sideQueue
        .flatMap((q) => q.items)
        .find((p) => p.remaining > 0 && p.kind !== 'truck')
      if (!item) {
        /*
         * 换手确认前先把超堆叠散开：4.8 / IV-F 的 `stacking:*` 会挡住
         * `confirmSideSetup`（与真人流程一致，不能带着 >10 RE 换手）。
         */
        disperseStacks()
        if (setup.setupSideCursor) {
          setup.confirmSideSetup()
          continue
        }
        break
      }
      if (item.kind === 'self') setup.beginSelfPlacement(item.entryIndex)
      else if (item.kind === 'air') setup.beginAirPlacement(item.side, item.entryIndex)
      else if (item.kind === 'shift') setup.beginShiftPlacement(item.formationId!)
      const sorted = [...(setup.placing?.candidates ?? [])].sort((a, b) => {
        const load = (h: { col: number; row: number }) =>
          w.units
            .filter((u) => u.hex.col === h.col && u.hex.row === h.row)
            .reduce((v, u) => v + u.re, 0) +
          100 * w.airUnits.filter((u) => u.hex.col === h.col && u.hex.row === h.row).length +
          1000 * w.spDumps.filter((d) => d.hex.col === h.col && d.hex.row === h.row).length
        return load(a) - load(b)
      })
      const choices = sorted
      expect(choices.length).toBeGreaterThan(0)
      if (item.kind !== 'self') {
        // 飞机 / 西移仍是"一次一枚/一批"，沿用原单点逻辑
        expect(setup.placeAtHex(choices[0]!)).toBe(true)
        continue
      }
      /*
       * 许可式（`w/i X` / †）候选是**玩家可选**的集合，第一个未必放得下（10 RE）；
       * 按负载升序逐个试，直到该条目落完——模拟玩家在面板里换一个合法格。
       */
      const done = () =>
        !setup.pendingPlacement.some(
          (row) =>
            row.kind === item.kind &&
            row.side === item.side &&
            row.entryIndex === item.entryIndex &&
            row.remaining > 0,
        )
      for (const hex of choices) {
        setup.placeAtHex(hex)
        if (done()) break
      }
      expect(done(), `${item.label}: ${setup.lastAction?.detail ?? '落位失败'}`).toBe(true)
    }
  }
  /*
   * † 整堆默认落原文格（可超 10 RE）⇒ 测试玩家在盘面把超限格散开。
   * 与真人操作同源：`beginStackDisperse` 取 ±1 候选，`moveStackUnit` 校验 IV-A / 10 RE。
   */
  const disperseStacks = () => {
    for (let n = 0; n < 500; n += 1) {
      const over = setup.overStackedHexes[0]
      if (over === undefined) return
      const id = over.movableIds[0]
      expect(id, `${over.label} 超 10 RE 但无 † 算子可散`).toBeDefined()
      expect(setup.beginStackDisperse(id!), over.label).toBe(true)
      const candidates = [...(setup.stackDisperse?.candidates ?? [])]
      let moved = false
      for (const hex of candidates) {
        if (setup.moveStackUnit(id!, hex)) {
          moved = true
          break
        }
      }
      expect(moved, `${over.label} 的 ${id} 无处可散`).toBe(true)
    }
    expect(setup.overStackedHexes.length, '散开 500 步后仍超堆叠').toBe(0)
  }
  placeRemaining()
  disperseStacks()
  /*
   * 两段式（规格 §4.1）：先「完成初设」只确认；抽签由唯一入口执行并开局，
   * 抽签产生的西移项会再回到初设 box ⇒ 执行完再摆一轮。
   */
  if (!setup.finished) expect(setup.startGameNow(), setup.lastAction?.detail).toBe(true)
  if (setup.setupDrawEntryVisible) {
    expect(setup.drawSetupEffectsNow(), setup.lastAction?.detail).toBe(true)
    placeRemaining()
    disperseStacks()
  }
  expect(setup.pendingPlacement.filter((p) => p.remaining > 0)).toHaveLength(0)
  expect(setup.initialPlacementsComplete).toBe(true)
}

/** 测试玩家明确选择不供养，并按单位顺序分配已判损失；生产程序不替玩家选择。 */
export function answerBoardChoices(ctx: ReturnType<typeof fresh>) {
  const { w } = ctx
  /*
   * 1.6b：第二段有未落位手牌时，流程条不再允许直接离开（workbench 的同源闸门）。
   * 自动推进的用例不摆放补员，这里替测试玩家按「结束本段」确认放弃上场。
   */
  if (
    w.phase === 'reinforcement' &&
    w.segmentStep?.id === 'reinforcement.replRoll' &&
    w.rollHandPending
  ) {
    if (
      w.activeSide === 'soviet' &&
      w.frontalReservesToday !== null &&
      !w.frontalReservesClaimed.includes(w.frontalReservesToday.date)
    ) {
      expect(w.claimFrontalReservesNow(), JSON.stringify({ err: w.frontalReservesError })).toBe(
        true,
      )
    }
    if (w.variableExitSelectionOpen) {
      const substitute = w.variableExitSelectionSet.eligibleIds[0]
      if (substitute !== undefined) expect(w.confirmVariableExitSubstitute(substitute)).toBe(true)
    }
    useContainersStore().drawSpecialRepl(w.activeSide, w.variableReplSpecialDie ?? undefined)
    expect(
      w.endRollSegmentNow(true),
      JSON.stringify({
        step: w.segmentStep?.id,
        err: w.reinforcementError,
        rolled: w.variableReplRolled,
        special: w.hasSpecialReplDraw(w.activeSide, w.turn),
        exitOpen: w.variableExitSelectionOpen,
        frontal: w.frontalReservesToday,
        hand: w.rollHandEntries.map((entry) => [entry.id, entry.count]),
        log: w.log[0],
      }),
    ).toBe(true)
  }
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

export async function progress(ctx: ReturnType<typeof fresh>, done: () => boolean, limit = 3000) {
  for (let n = 0; n < limit && !done(); n++) {
    answerBoardChoices(ctx)
    if (ctx.g.awaiting) expect(ctx.g.answerNow('first')).toBe(true)
    else ctx.w.advanceSegmentNow()
    await nextTick()
    if (n % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(done()).toBe(true)
}
