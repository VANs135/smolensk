import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { arrivalPlacementCandidates, type ArrivalPlacementFacts } from '@/engine/rules'
import { useWorkbenchStore } from '@/stores'

/**
 * 用户 2026-10-25 实测 BUG①：**放增援的时候可以任意放，没按剧本要求做好限制**
 *
 * 通规 13.6：「增援……会被放置在**它们的入场格**中」，不是"玩家任选一格"；
 * 13.6b 给的唯一退路是「地图边缘的入场格被敌方单位阻挡 ⇒ 最近的未被阻挡边缘格」。
 * 修前「点地图选落点」给的是 `candidates: 'any'`（任意格），于是 `Entry …` 的到达能被摆到地图另一头。
 * 本文件钉住：候选来自卡面（`arrivalPlacementCandidates`），选格 / 手改 / 投放**三处同一口径**。
 */

function newStore() {
  setActivePinia(createPinia())
  const workbench = useWorkbenchStore()
  // turn 1 的当日到达卡没有条目；turn 2 的轴方条目是 `Entry …`（入场格 1.26 / 1.12、1.19）
  workbench.setTurn(2)
  workbench.setPhase('reinforcement')
  return workbench
}

describe('13.6：增援落点只能落在**卡面候选**内（不是任意格）', () => {
  it('★ 候选＝卡面的入场格；点地图选落点给的就是这几格（不是 any）', () => {
    const workbench = newStore()
    expect(workbench.arrivalCandidates.length).toBeGreaterThan(0)
    expect(workbench.arrivalCandidates[1]).toEqual([{ col: 1, row: 26 }])
    expect(workbench.beginArrivalHexPickNow(1)).toBe(true)
    const candidates = workbench.hexPickView?.candidates
    expect(candidates).not.toBe('any')
    expect(candidates).toEqual([{ col: 1, row: 26 }])
  })

  it('★ 手改到候选外 ⇒ 拒绝且落点不动；改到候选内 ⇒ 生效', () => {
    const workbench = newStore()
    const before = workbench.arrivalPlacements[1]?.hex
    workbench.setArrivalHexOverride(1, '30.30')
    expect(workbench.arrivalPlacements[1]?.hex).toEqual(before)
    expect(workbench.log.some((entry) => entry.text.includes('不在该到达条目的落点范围内'))).toBe(
      true,
    )
    workbench.setArrivalHexOverride(1, '1.26')
    expect(workbench.arrivalPlacements[1]?.hex).toEqual({ col: 1, row: 26 })
  })

  it('★ 投放时也校验（绕过"点地图选格"手输落点，同样不能放到候选外）', () => {
    const workbench = newStore()
    expect(workbench.placeArrivalNow(1, undefined, '30.30')).toBe(false)
    expect(workbench.reinforcementError?.reason).toBe('arrivalHexOutsideCandidates')
    expect(workbench.arrivalPlaced[1]).not.toBe(true)
  })

  it('★ 没有候选时**不进**待点态（并说明原因），不是退回任意格', () => {
    const workbench = newStore()
    // 清掉本方基地/补给源与图边可选格不现实 ⇒ 用一个"当日没有到达条目"的日子
    workbench.setTurn(1)
    expect(workbench.arrivalCandidates.length).toBe(0)
    expect(workbench.beginArrivalHexPickNow(0)).toBe(false)
    expect(workbench.hexPickView).toBeNull()
    expect(workbench.log.some((entry) => entry.text.includes('不能在地图上选格'))).toBe(true)
  })

  it('★ 13.6b：入场格被敌方挡住 ⇒ 候选改为最近的**未被阻挡边缘格**', () => {
    const facts = (blocked: boolean): ArrivalPlacementFacts => ({
      entryHexes: () => [{ col: 1, row: 26 }],
      isBlocked: () => blocked,
      nearestOpenEdgeHex: () => ({ col: 1, row: 0 }),
      friendlyAirBaseHexes: () => [{ col: 10, row: 10 }],
      directDrawHqHexes: () => [],
      edgeSupplySourceHexes: () => [{ col: 1, row: 0 }],
      westEdgeHexes: () => [{ col: 0, row: 10 }],
      isNorthEdge: () => false,
    })
    const placement = { kind: 'entryHex', letters: ['A'], label: 'Entry A' } as const
    expect(arrivalPlacementCandidates(placement, facts(false))).toEqual([{ col: 1, row: 26 }])
    expect(arrivalPlacementCandidates(placement, facts(true))).toEqual([{ col: 1, row: 0 }])
  })

  it('★ 地理参照 / 任一基地 / 西缘：候选各按卡面口径（不是"整张地图"）', () => {
    const facts: ArrivalPlacementFacts = {
      entryHexes: () => [],
      isBlocked: () => false,
      nearestOpenEdgeHex: () => null,
      friendlyAirBaseHexes: () => [{ col: 10, row: 10 }],
      directDrawHqHexes: () => [{ col: 20, row: 20 }],
      edgeSupplySourceHexes: () => [{ col: 1, row: 0 }],
      westEdgeHexes: () => [{ col: 0, row: 10 }],
      isNorthEdge: () => false,
    }
    expect(arrivalPlacementCandidates({ kind: 'anyAirbase', label: 'Any Airbase' }, facts)).toEqual(
      [{ col: 10, row: 10 }],
    )
    expect(
      arrivalPlacementCandidates({ kind: 'anyWestEdge', label: 'Any west edge hexes' }, facts),
    ).toEqual([{ col: 0, row: 10 }])
    // 2.1 / 3.1：有"可直接拖取"的 HQ 就只落在那些 HQ
    expect(arrivalPlacementCandidates({ kind: 'hqOrEdgeSource', label: 'HQ' }, facts)).toEqual([
      { col: 20, row: 20 },
    ])
    // 地理参照：只给半径内的**图上**格
    const within = arrivalPlacementCandidates(
      { kind: 'geographic', anchor: { col: 11, row: 3 }, radiusHexes: 1, label: 'w/i 1' },
      facts,
    )
    expect(within.length).toBeGreaterThan(0)
    expect(within).toContainEqual({ col: 11, row: 3 })
    expect(within.length).toBeLessThanOrEqual(7)
    // 进死亡堆的条目：图上没有可放的格
    expect(arrivalPlacementCandidates({ kind: 'deadPile', label: 'Dead Pile' }, facts)).toEqual([])
  })
})
