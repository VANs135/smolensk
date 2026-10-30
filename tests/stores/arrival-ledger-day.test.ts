import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { actionGateOf, useWorkbenchStore } from '@/stores'
import type { ActionKey, ConsolePhase } from '@/stores'

/**
 * 13.6：到达账本必须**按天作废**（两本账：已投放 / 裁判手改落点）
 *
 * 回执（2026-10-30 实测 BUG）：`markArrivalPlaced` 先改计划键、再把**上一整天**的
 * `{0..N:true}` 一并带进新键 ⇒ 换日后新一天除第 0 条外的到货全部显示"已投放"、
 * 点击被 `placeArrivalNow` 的 13.6 账本拒绝 ⇒ 这些算子**永远进不了场**（且账本进快照，读档救不回）。
 * 同一处 `arrivalHexOverrides` 也只按"下标"存、只随剧本更换清空 ⇒ 换日后昨天的落点覆盖
 * 套到今天同下标的条目上（要么每次都被候选校验拒投，要么落到别的条目的入场格）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function goToStep(
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

/** 找"至少 2 条可投放算子"的回合（够验证"第 0 条记过账后，第 1 条仍能放"） */
function findTurnWithTwoPlaceable(
  store: ReturnType<typeof newStore>,
  from = 1,
): { turn: number; count: number } {
  for (let turn = from; turn <= 40; turn += 1) {
    store.setTurn(turn)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    if (plan === null) continue
    const placeable = plan.units.filter(
      (unit) => unit.kind !== 'sp' && unit.kind !== 'unclassified',
    )
    if (placeable.length >= 2) return { turn, count: placeable.length }
  }
  throw new Error('到达表里找不到两天都有到货的窗口')
}

describe('13.6：到达账本换日作废', () => {
  it('★ 换日后旧下标不得"复活"：新一天放完第 0 条，昨天放过的那个下标仍可投放', () => {
    const store = newStore()
    const first = findTurnWithTwoPlaceable(store)
    goToStep(store, 'rein.arrival')

    const placeableOf = (): number[] =>
      store
        .arrivalPlan!.units.map((unit, index) => ({ unit, index }))
        .filter(({ unit }) => unit.kind !== 'sp' && unit.kind !== 'unclassified')
        .map(({ index }) => index)
    const yesterday = placeableOf()
    /*
     * 挑一个**两天都存在**的下标（>0）来记昨天的账：修复前的漏账是"按键名合并"，
     * 只有"昨天的下标今天还在用"时才会复活成"已投放"，故必须让两个下标集合有交集。
     */
    const next = findTurnWithTwoPlaceable(store, first.turn + 1)
    expect(next.turn).toBeGreaterThan(first.turn)
    const today0 = placeableOf()
    const overlap = yesterday.filter((index) => index > 0 && today0.includes(index))
    expect(overlap.length, '两天到达表应当有公共下标（否则本用例测不到换日串账）').toBeGreaterThan(
      0,
    )
    const staleIndex = overlap[0]!
    // 回到昨天把这一条放掉
    store.setTurn(first.turn)
    store.setPhase('reinforcement')
    goToStep(store, 'rein.arrival')
    expect(store.placeArrivalNow(staleIndex)).toBe(true)
    expect(store.arrivalPlaced[staleIndex]).toBe(true)

    // 换到下一个有到货的回合
    store.setTurn(next.turn)
    store.setPhase('reinforcement')
    goToStep(store, 'rein.arrival')
    expect(store.arrivalPlaced).toEqual({})
    // 手改落点同样不带过来
    expect(store.arrivalPlacements.some((item) => item.detail.includes('裁判手改落点'))).toBe(false)

    /*
     * ★ 关键一击：在新一天**真的放一枚**（这一步才会把计划键刷成新值）。
     *   修前 `markArrivalPlaced` 把昨天的 `{0..N:true}` 一并带进新键 ⇒ 新一天其余条目
     *   全部变"已投放"、`placeArrivalNow` 一律拒绝 ⇒ 算子永远进不了场。
     */
    const today = placeableOf()
    const todayFirst = today[0]!
    expect(store.placeArrivalNow(todayFirst)).toBe(true)
    // 今天其余条目不得因为"昨天的下标"而变灰
    for (const index of today.slice(1)) {
      expect(store.arrivalPlaced[index]).not.toBe(true)
    }
  })

  it('★ 同一回合内「已投放」仍然生效（13.6 每条只投一次，不能靠换日修复把它放松）', () => {
    const store = newStore()
    findTurnWithTwoPlaceable(store)
    goToStep(store, 'rein.arrival')
    const index = store.arrivalPlan!.units.findIndex(
      (unit) => unit.kind !== 'sp' && unit.kind !== 'unclassified',
    )
    expect(store.placeArrivalNow(index)).toBe(true)
    // 同一天再投同一条 ⇒ 被账本挡住（这条是修复前就有的正确行为，钉住别改坏）
    expect(store.placeArrivalNow(index)).toBe(false)
    expect(store.arrivalPlaced[index]).toBe(true)
  })
})
