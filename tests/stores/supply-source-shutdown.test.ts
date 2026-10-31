import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

/**
 * 专规 2.1a：补给源关停后**不再是 2.1/3.1 的落点**
 *
 * 原文（2.1）：「The rest of the SP is put in **map-edge supply source hexes**」；
 * 2.1a：「These supply sources **cease to exist** on fixed dates: **Entry L on 19 July**.
 *   **Entry E (and all South edge sources west of there) on 19 August**.」
 *
 * 回执（2026-11-01 第 22 条）：引擎 `supplySourceStatuses` 一直会按日期判 `open`，
 * 但**落点**这一侧（`arrivalFacts.edgeSupplySourceHexes()` 与免费铁运的余额落点）
 * 直接用了剧本的 live 清单（不看日期）⇒ 19 Jul 之后仍能把 SP 塞进 20.35。
 * 修后两侧都改用 `openSupplySourceHexes`。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 把回合推到「日期 >= target」的第一回合（回合轨是连续日期） */
function turnAtOrAfter(workbench: ReturnType<typeof newStore>, target: string): number {
  for (let turn = 1; turn <= 200; turn += 1) {
    workbench.setTurn(turn)
    if (workbench.date >= target) return turn
  }
  throw new Error(`回合轨里找不到 ${target} 之后的日期`)
}

describe('专规 2.1a：关停的补给源不能接货', () => {
  it('★ Entry L（20.35）在 19 July 前开放、当日起从落点集合里消失', () => {
    const workbench = newStore()
    workbench.setActiveSide('soviet')

    // 19 Jul 之前：20.35 在清单里，也在"可落点"里
    const before = turnAtOrAfter(workbench, '1941-07-19') - 1
    workbench.setTurn(before)
    expect(workbench.date < '1941-07-19').toBe(true)
    expect(
      workbench.scenarioSupplySourceHexes.some((hex) => hex.col === 20 && hex.row === 35),
    ).toBe(true)
    expect(workbench.openSupplySourceHexes.some((hex) => hex.col === 20 && hex.row === 35)).toBe(
      true,
    )

    // 19 Jul 起：清单还在（剧本数据不动），但**可落点**里没有了
    workbench.setTurn(turnAtOrAfter(workbench, '1941-07-19'))
    expect(
      workbench.scenarioSupplySourceHexes.some((hex) => hex.col === 20 && hex.row === 35),
    ).toBe(true)
    expect(workbench.openSupplySourceHexes.some((hex) => hex.col === 20 && hex.row === 35)).toBe(
      false,
    )
  })

  it('★ 19 August 起南缘「Entry E 及以西」再关一批：可落点进一步减少', () => {
    const workbench = newStore()
    workbench.setActiveSide('soviet')

    workbench.setTurn(turnAtOrAfter(workbench, '1941-07-19'))
    const afterEntryL = workbench.openSupplySourceHexes.length

    workbench.setTurn(turnAtOrAfter(workbench, '1941-08-19'))
    const afterSouth = workbench.openSupplySourceHexes.length
    expect(afterSouth).toBeLessThan(afterEntryL)
    // 可落点恒为剧本清单的子集（不会凭空多出格）
    const live = new Set(workbench.scenarioSupplySourceHexes.map((hex) => `${hex.col}.${hex.row}`))
    for (const hex of workbench.openSupplySourceHexes)
      expect(live.has(`${hex.col}.${hex.row}`)).toBe(true)
  })

  it('★ 免费铁运的余额落点：19 July 起把 SP 放到 20.35 会被拒（那格已不是补给源）', () => {
    /*
     * 2.1：「The rest of the SP is put in **map-edge supply source hexes**」——
     * 2.1a 关停后 20.35 不再是补给源，故 `planFreeRailArrivals` 的 `notEdgeSupplySource` 应当拒。
     * 修前 store 传的是剧本 live 清单（不看日期）⇒ 这个落点会被放行。
     */
    const workbench = newStore()
    workbench.setActiveSide('soviet')
    workbench.setTurn(turnAtOrAfter(workbench, '1941-07-19'))
    workbench.supplyArrivalSp = 3
    workbench.freeRailPicked = []
    workbench.freeRailEdgeHex = { col: 20, row: 35 }

    expect(workbench.freeRailPlan).toBeNull()
    expect(workbench.freeRailError?.reason).toContain('notEdgeSupplySource')
  })

  it('轴方无 2.1a 关停条款（3.1）：任何日期都不减', () => {
    const workbench = newStore()
    workbench.setActiveSide('axis')
    workbench.setTurn(1)
    const early = workbench.openSupplySourceHexes.length
    workbench.setTurn(turnAtOrAfter(workbench, '1941-08-19'))
    expect(workbench.openSupplySourceHexes.length).toBe(early)
  })
})
