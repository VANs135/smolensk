import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { expect } from 'vitest'

import { createMemoryStorage } from '@/shared'
import { useSetupStore, useWorkbenchStore, useGameSessionStore, useHotseatStore } from '@/stores'

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
  }
  placeRemaining()
  /*
   * ch10（用户 2026-11-10）：抽签只在初设单位摆完**之后**执行一次；
   * 抽签产生的西移项会再回到初设 box ⇒ 执行完再摆一轮。
   */
  if (setup.setupDrawEntryVisible) {
    expect(setup.executeSetupDraws(), setup.lastAction?.detail).toBe(true)
    placeRemaining()
  }
  expect(setup.pendingPlacement.filter((p) => p.remaining > 0)).toHaveLength(0)
  expect(setup.initialPlacementsComplete).toBe(true)
}

/** 测试玩家明确选择不供养，并按单位顺序分配已判损失；生产程序不替玩家选择。 */
export function answerBoardChoices(ctx: ReturnType<typeof fresh>) {
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
