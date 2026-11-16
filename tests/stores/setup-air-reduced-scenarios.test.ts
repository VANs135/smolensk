import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { airBarrageStrengthOf, airCombatRatingOf, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 初设减损飞机（剧本 7）：计划 → 待落位卡 → 落盘后数值
 *
 * 原文：剧本 7 苏军 `At any air bases: 1x I.153 * / … / 2x Pe.2 * / 2x SB.2 *`，
 * 注 `"*" = one unit begins reduced`。原文没有 `Damaged` 档：减损＝同一枚算子翻到背面，
 * 空战 / 轰炸取背面印值（14.1b / 14.4f）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

describe('初设减损飞机（剧本 7 苏军）', () => {
  let setup: ReturnType<typeof newStores>['setup']
  let workbench: ReturnType<typeof newStores>['workbench']

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
    workbench = stores.workbench
    setup.selectScenario('7')
    setup.runAutoSetup() // 空军基地先落盘，飞机才有候选格（14.1a）
  })

  it('待落位卡逐枚标出减损：I.153 是减损面，I.16 不是', () => {
    const airItems = setup.pendingPlacement.filter(
      (item) => item.kind === 'air' && item.side === 'soviet',
    )
    const i153 = airItems.find((item) => item.raw === 'su-aircraft-ru-i-153')
    const i16 = airItems.find((item) => item.raw === 'su-aircraft-ru-i-16')
    expect(i153?.airReduced).toBe(true)
    expect(i153?.airReducedRemaining).toBe(1)
    expect(i16?.airReduced).toBe(false)
    expect(i16?.airReducedRemaining).toBe(0)
  })

  it('落盘后每型只有 1 枚减损（steps=印值−1），空战 / 轰炸取背面印值', () => {
    const plan = setup.airPlanOf('soviet')
    if (plan === null) throw new Error('剧本 7 苏军应有飞机初设计划')
    const base = plan.placements[0]?.candidates[0]
    if (base === undefined) throw new Error('自动初设应先落空军基地')
    for (const row of plan.placements) {
      setup.setAirChoice(row.entryIndex, `${base.col}.${base.row}`)
    }
    expect(setup.runAirSetup('soviet')).toBe(true)

    const reduced = [
      ['su-aircraft-ru-i-153', 1, 0, 0],
      ['su-aircraft-ru-lagg-3', 1, 1, 0],
      ['su-aircraft-ru-yak-1', 1, 1, 0],
      ['su-aircraft-ru-pe-2', 2, 0, 3],
      ['su-aircraft-ru-sb-2', 2, 0, 1],
    ] as const
    for (const [aircraftId, count, combatBack, barrageBack] of reduced) {
      const hits = workbench.airUnits.filter((air) => air.aircraftId === aircraftId)
      expect(hits, aircraftId).toHaveLength(count)
      // `"*" = one unit begins reduced`：该型只有 1 枚减损
      const hurt = hits.filter((air) => air.steps === 1)
      expect(hurt, aircraftId).toHaveLength(1)
      expect(airCombatRatingOf(hurt[0]!)).toBe(combatBack)
      expect(airBarrageStrengthOf(hurt[0]!)).toBe(barrageBack)
      expect(hits.filter((air) => air.steps === 2)).toHaveLength(count - 1)
    }

    // 未标 `*` 的 I.16（2 枚）保持满员
    const i16 = workbench.airUnits.filter((air) => air.aircraftId === 'su-aircraft-ru-i-16')
    expect(i16).toHaveLength(2)
    expect(i16.every((air) => air.steps === 2)).toBe(true)
  })
})
