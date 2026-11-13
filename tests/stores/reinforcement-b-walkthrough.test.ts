import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useContainersStore, useSetupStore, useWorkbenchStore } from '@/stores'

type Workbench = ReturnType<typeof useWorkbenchStore>

function boot(): Workbench {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const w = useWorkbenchStore()
  w.setScenarioId('1')
  w.setActiveSide('axis')
  w.setTurn(2)
  w.setPhase('reinforcement')
  return w
}

function gotoStep(w: Workbench, id: string): void {
  const index = w.playerSegmentSteps.findIndex((step) => step.id === id)
  expect(index).toBeGreaterThanOrEqual(0)
  expect(w.setSegmentStepIndex(index)).toBe(true)
}

describe('B 增援：1.6c 特殊补员', () => {
  it('自动掷出的 1.6c 与「掷骰检定」共用同一颗骰，不再多掷一次', () => {
    const w = boot()
    w.variableReplInputs.autoRoll = true
    expect(w.rollVariableReplNow()).toBe(true)
    const die = w.variableReplSpecialDie!
    expect(die).not.toBeNull()

    gotoStep(w, 'reinforcement.replRoll')
    const c = useContainersStore()
    const drawsBefore = w.drawCount
    expect(c.drawSpecialRepl(w.activeSide, die)).toBe(true)

    expect(w.drawCount).toBe(drawsBefore)
    expect(c.specialReplLast?.die).toBe(die)
    expect(c.specialReplLast?.side).toBe('axis')
  })

  it('验证页主动设回合时，1.6c 的「已掷」记账记在操作台回合上，第二段能收束', () => {
    const w = boot()
    w.variableReplInputs.autoRoll = true
    expect(w.rollVariableReplNow()).toBe(true)
    gotoStep(w, 'reinforcement.replRoll')

    const c = useContainersStore()
    expect(c.drawSpecialRepl(w.activeSide, w.variableReplSpecialDie ?? undefined)).toBe(true)
    expect(w.hasSpecialReplDraw('axis', w.turn)).toBe(true)
    expect(w.hasSpecialReplDraw('axis', 1)).toBe(false)
    expect(w.endRollSegmentNow(true)).toBe(true)
  })
})

describe('B 增援：到达段拒绝提示', () => {
  it('执行 1.6a 移除后不再残留「先做移除」的拒绝', () => {
    const w = boot()
    gotoStep(w, 'reinforcement.arrival')
    expect(w.arrivalRemovalsPending).toBe(true)
    expect(w.placeArrivalNow(0)).toBe(false)
    expect(w.reinforcementError?.rule).toBe('1.6a')

    expect(w.applyArrivalRemovalsNow()).toBeUndefined()
    expect(w.reinforcementError).toBeNull()
  })

  it('到达成功投放后不再残留上一条拒绝', () => {
    const w = boot()
    gotoStep(w, 'reinforcement.arrival')
    w.applyArrivalRemovalsNow()

    const index = w.arrivalPlan?.units.findIndex(
      (unit, i) => unit.kind !== 'aircraft' && (w.arrivalCandidates[i]?.length ?? 0) > 0,
    )
    expect(index).toBeGreaterThanOrEqual(0)
    const hex = w.arrivalCandidates[index!]![0]!
    expect(w.placeArrivalNow(index!, undefined, '99.99')).toBe(false)
    expect(w.reinforcementError).not.toBeNull()
    expect(w.placeArrivalNow(index!, undefined, String(hex))).toBe(true)
    expect(w.reinforcementError).toBeNull()
  })

  it('图外盒：飞机到达可投放到图外空军盒（13.6 / 专规 1.4a）', () => {
    const w = boot()
    w.setTurn(4)
    gotoStep(w, 'reinforcement.arrival')
    w.applyArrivalRemovalsNow()
    const index = w.arrivalPlan?.units.findIndex(
      (unit, i) => unit.kind === 'aircraft' && w.arrivalAirBoxAvailable(i),
    )
    expect(index).toBeGreaterThanOrEqual(0)
    expect(w.placeArrivalInAirBoxNow(index!)).toBe(true)
    expect(w.arrivalPlaced[index!]).toBe(true)
    const ids = w.arrivalPlacedUnits[index!] ?? []
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => w.airBoxMembers.includes(id))).toBe(true)
  })

  it('底部横幅把拒绝码翻成中文，不直接印原始码', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../src/components/reinforcement/ReinforcementPanel.vue', import.meta.url),
      ),
      'utf8',
    )
    expect(source).toContain('arrivalErrorText(genericReinforcementError.reason)')
    expect(source).toContain("code === 'arrivalSpGroupRequired'")
  })
})
