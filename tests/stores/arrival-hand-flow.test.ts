import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import {
  actionGateOf,
  useHotseatStore,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
} from '@/stores'
import type { ConsolePhase } from '@/stores'

/**
 * 2026-11-09：手牌式增援（13.6）；2026-11-11 v7.1 第一段整改
 *
 * 用户口径：会话框只排本回合到场算子图标 → 点算子出地图高亮 → 点格即放 →
 * 已放可点回手（可撤销重放）；**不再自动关窗**，改由「结束本段」收束
 * （手牌非空要先确认放弃上场）。落点仍只走既有候选与 `placeArrivalNow` 校验。
 */
const boot = () => {
  setActivePinia(createPinia())
  return {
    workbench: useWorkbenchStore(),
    mapView: useMapViewStore(),
  }
}

function goToArrival(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/** 找一条"有可投放算子、有候选格、且无 1.6a 强制移除"的到达条目（真实到达表，不造数） */
function seekPlaceable(store: ReturnType<typeof boot>['workbench']): number {
  for (let turn = 1; turn <= 40; turn += 1) {
    store.setTurn(turn)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    // 1.6a 先于放置：有强制移除的回合要先执行移除，本用例只测放置/撤回本身
    if (plan === null || plan.removals.length > 0) continue
    const index = plan.units.findIndex(
      (unit, at) =>
        unit.kind !== 'sp' &&
        unit.kind !== 'unclassified' &&
        (store.arrivalCandidates[at]?.length ?? 0) > 0,
    )
    if (index >= 0) return index
  }
  throw new Error('到达表里没有可投放的算子')
}

/** 找"只有 1 条可投放算子、且无强制移除/待落 SP"的回合（用于验证放完不关窗、由结束本段收束） */
function seekSinglePlaceableTurn(store: ReturnType<typeof boot>['workbench']): number {
  for (let turn = 1; turn <= 40; turn += 1) {
    store.setTurn(turn)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    if (plan === null || plan.removals.length > 0) continue
    if (store.supplyArrivalSp !== 0) continue
    const placeable = plan.units
      .map((unit, index) => ({ unit, index }))
      .filter(({ unit }) => unit.kind !== 'sp' && unit.kind !== 'unclassified')
    if (placeable.length !== 1) continue
    const { unit, index } = placeable[0]!
    if (unit.kind !== 'aircraft' && store.resolveArrivalFormation(index) === null) {
      if (store.arrivalRecordOf(index) === null) continue
    }
    if ((store.arrivalCandidates[index]?.length ?? 0) === 0) continue
    // 逐枚点名的多枚条目要投 N 次，本组用例只挑"一次即放完"的条目
    if (store.arrivalRemainingOf(index) !== 1) continue
    return index
  }
  throw new Error('到达表里找不到"只有 1 条可投放算子"的回合')
}

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

describe('13.6：手牌式到达投放', () => {
  it('只列本回合增援：手牌=当日可投放算子；旧长文案/选点+投放按钮已撤', () => {
    const source = readSource('../../src/components/reinforcement/ReinforcementPanel.vue')
    expect(source).toContain('data-testid="arrival-hand"')
    expect(source).toContain("if (unit.kind === 'sp' || unit.kind === 'unclassified') return")
    expect(source).toContain('workbench.arrivalRemainingOf(index) <= 0')
    expect(source).not.toContain('到达表执行（13.6）')
    expect(source).not.toContain('点地图选落点（')

    const { workbench } = boot()
    workbench.setActiveSide('axis')
    seekPlaceable(workbench)
    expect(workbench.arrivalCandidates.length).toBe(workbench.arrivalPlan!.units.length)
  })

  it('点算子 ⇒ 地图高亮该条目候选格；点候选格 ⇒ 立即落位', () => {
    const { workbench } = boot()
    workbench.setActiveSide('axis')
    const index = seekPlaceable(workbench)
    goToArrival(workbench, 'rein.arrival')
    const candidates = workbench.arrivalCandidates[index]!

    expect(workbench.beginArrivalPlacePickNow(index)).toBe(true)
    expect(workbench.hexPickView).not.toBeNull()
    expect(workbench.hexPickView?.label).toContain('增援落点')
    expect(workbench.hexPickView?.candidates).toEqual(candidates)

    const before = workbench.units.length
    expect(workbench.pickHexFor(candidates[0]!)).toBe(true)
    expect(workbench.arrivalPlaced[index]).toBe(true)
    expect(workbench.units.length).toBeGreaterThan(before)
    expect(workbench.hexPickView).toBeNull()
  })

  it('非法格不可放：候选之外的格仍被既有校验拒绝', () => {
    const { workbench } = boot()
    workbench.setActiveSide('axis')
    const index = seekPlaceable(workbench)
    goToArrival(workbench, 'rein.arrival')

    const before = workbench.units.length
    expect(workbench.placeArrivalNow(index, undefined, '99.99')).toBe(false)
    expect(workbench.arrivalPlaced[index]).not.toBe(true)
    expect(workbench.units.length).toBe(before)
    expect(workbench.reinforcementError?.reason).toContain('arrivalHexOutsideCandidates')
  })

  it('放下后可点回手：按投放账本精确移除，且可再次重放', () => {
    const { workbench } = boot()
    workbench.setActiveSide('axis')
    const index = seekPlaceable(workbench)
    goToArrival(workbench, 'rein.arrival')

    const before = workbench.units.length
    expect(workbench.beginArrivalPlacePickNow(index)).toBe(true)
    expect(workbench.pickHexFor(workbench.arrivalCandidates[index]![0]!)).toBe(true)
    const placedCount = workbench.units.length
    expect(placedCount).toBeGreaterThan(before)

    expect(workbench.withdrawArrivalNow(index)).toBe(true)
    expect(workbench.units.length).toBe(before)
    expect(workbench.arrivalPlaced[index]).not.toBe(true)
    expect(workbench.arrivalPlacedUnits[index]).toBeUndefined()

    // 回手后可重放（同一候选）
    expect(workbench.beginArrivalPlacePickNow(index)).toBe(true)
    expect(workbench.pickHexFor(workbench.arrivalCandidates[index]![0]!)).toBe(true)
    expect(workbench.units.length).toBe(placedCount)
  })

  it('并非 PVE 时同样成立：pvp / solo 下投放与回手一致', () => {
    for (const mode of ['pvp', 'solo'] as const) {
      const { workbench } = boot()
      const hotseat = useHotseatStore()
      expect(hotseat.setMode(mode)).toBe(true)
      workbench.setActiveSide('axis')
      const index = seekPlaceable(workbench)
      goToArrival(workbench, 'rein.arrival')
      const before = workbench.units.length
      expect(workbench.beginArrivalPlacePickNow(index)).toBe(true)
      expect(workbench.pickHexFor(workbench.arrivalCandidates[index]![0]!)).toBe(true)
      expect(workbench.withdrawArrivalNow(index)).toBe(true)
      expect(workbench.units.length).toBe(before)
    }
  })

  it('该回合增援放完 ⇒ 会话不自动关闭，由「结束本段」收束', () => {
    const { workbench, mapView } = boot()
    workbench.setActiveSide('axis')
    const index = seekSinglePlaceableTurn(workbench)
    goToArrival(workbench, 'rein.arrival')
    expect(mapView.session?.kind).toBe('reinforce')
    expect(mapView.session?.title).toBe('增援')

    expect(workbench.arrivalUnitsDone).toBe(false)
    expect(workbench.beginArrivalPlacePickNow(index)).toBe(true)
    expect(workbench.pickHexFor(workbench.arrivalCandidates[index]![0]!)).toBe(true)
    expect(workbench.arrivalUnitsDone).toBe(true)
    // v7.1 第一段：放完不再自动关窗，会话保持可见
    expect(mapView.session?.kind).toBe('reinforce')
    expect(workbench.arrivalSegmentClosed).toBe(false)

    // 手牌已空 ⇒ 结束本段不再要确认
    expect(workbench.endArrivalSegmentNow(false)).toBe(true)
    expect(workbench.arrivalSegmentClosed).toBe(true)
  })

  it('手牌非空时结束本段：先拒绝，确认放弃后才收束', () => {
    const { workbench } = boot()
    workbench.setActiveSide('axis')
    seekPlaceable(workbench)
    goToArrival(workbench, 'rein.arrival')
    expect(workbench.arrivalHandPending).toBe(true)
    expect(workbench.endArrivalSegmentNow(false)).toBe(false)
    expect(workbench.arrivalSegmentClosed).toBe(false)
    expect(workbench.reinforcementError?.reason).toBe('arrivalHandNotEmpty')

    expect(workbench.endArrivalSegmentNow(true)).toBe(true)
    expect(workbench.arrivalSegmentClosed).toBe(true)
    expect(workbench.arrivalAbandoned).toBe(true)
  })

  it('1.6a 先于放置：移除未执行时拒绝落位，执行后才放行', () => {
    for (let turn = 1; turn <= 40; turn += 1) {
      const { workbench } = boot()
      workbench.setActiveSide('axis')
      workbench.setTurn(turn)
      workbench.setPhase('reinforcement')
      const plan = workbench.arrivalPlan
      if (plan === null || plan.removals.length === 0) continue
      const index = plan.units.findIndex(
        (unit, at) =>
          unit.kind !== 'sp' &&
          unit.kind !== 'unclassified' &&
          (workbench.arrivalCandidates[at]?.length ?? 0) > 0,
      )
      if (index < 0) continue
      goToArrival(workbench, 'rein.arrival')
      expect(workbench.arrivalRemovalsPending).toBe(true)
      expect(workbench.beginArrivalPlacePickNow(index)).toBe(false)
      expect(workbench.reinforcementError?.reason).toBe('arrivalRemovalsFirst')

      workbench.applyArrivalRemovalsNow()
      expect(workbench.arrivalRemovalsPending).toBe(false)
      expect(workbench.beginArrivalPlacePickNow(index)).toBe(true)
      workbench.cancelHexPick()
      return
    }
    throw new Error('到达表里找不到"有强制移除且同时有可投放算子"的回合')
  })

  it('第一段手牌不显示枚数角标（只有批量条显示）', () => {
    const source = readSource('../../src/components/reinforcement/ReinforcementPanel.vue')
    expect(source).not.toContain('v-if="card.copies > 1"')
  })
})
