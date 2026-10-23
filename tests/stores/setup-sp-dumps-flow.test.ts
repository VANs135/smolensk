import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 12.1b / 12.1c：**初设落的 SP 就是补给站**（备忘录 #3 的回归）
 *
 * 修前的断链：初设把剧本页的 SP 落成盘面算子并记在 setup store 自己的台账里，
 * 而整备付款（15.1B）、战斗补给、12.3a 拖取读的是 workbench 的 `spDumps` 账本 ⇒
 * 玩家在整备阶段看到「可付款补给站：0 处」，尽管地图上摆着初设的 SP。
 *
 * 规则依据（通规 v4.3 12.1b 原文）：「任何含有 SP 的位置，无论是地面上**未装载**的补给，
 * 还是**装载在运输点数上**的补给，都统称为补给站。图上补给……SP 使用前并不需要卸载。」
 */
describe('12.1b：初设 SP 落账（地图上有 SP ⇒ 付款候选中就有它）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('自动初设后：workbench 账本与 setup 台账逐条一致（12.1c / 12.1d）', () => {
    const setup = useSetupStore()
    const workbench = useWorkbenchStore()
    expect(setup.runAutoSetup()).toBe(true)

    const mine = setup.spDumps
    expect(mine.length).toBeGreaterThan(0) // 剧本 1 有初设 SP
    expect(workbench.spDumps).toHaveLength(mine.length)
    for (const dump of mine) {
      const landed = workbench.spDumps.find((item) => item.id === dump.id)
      expect(landed, `${dump.id} 应已落账`).not.toBeUndefined()
      expect(landed!.hex).toEqual(dump.hex)
      expect(landed!.side).toBe(dump.side)
      expect(landed!.sp).toBe(dump.points)
      expect(landed!.t).toBe(0)
    }
  })

  it('整备付款候选非空：基地附近（12.3a）的初设补给站被认作 15.1B 的可付款补给站', () => {
    const setup = useSetupStore()
    const workbench = useWorkbenchStore()
    setup.runAutoSetup()

    const bases = workbench.airBases
    expect(bases.length).toBeGreaterThan(0)
    /*
     * `airRefitPayDumps` 每次都要算一遍 12.3a 的拖取判定（贵）⇒ 只对**距离最近的那一座基地**做
     * 端到端验证：先按格距挑出「本方初设 SP 在 5 格内」的基地，取最近的一座。
     */
    const scored = bases
      .map((base) => {
        const distances = workbench.spDumps
          .filter((dump) => dump.side === base.side)
          .map((dump) =>
            Math.max(Math.abs(dump.hex.col - base.hex.col), Math.abs(dump.hex.row - base.hex.row)),
          )
        return {
          base,
          nearest: distances.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...distances),
        }
      })
      .filter((item) => item.nearest <= 5)
      .sort((a, b) => a.nearest - b.nearest)
    expect(scored.length, '初设 SP 附近应有本方基地').toBeGreaterThan(0)

    const pays = workbench.airRefitPayDumps(scored[0]!.base.id)
    expect(pays.length, `基地 ${scored[0]!.base.id} 应能拖到初设补给站`).toBeGreaterThan(0)
  }, 60_000)

  it('重置初设即清空账本（12.1b：补给站随盘面一起消失，不残留）', () => {
    const setup = useSetupStore()
    const workbench = useWorkbenchStore()
    setup.runAutoSetup()
    expect(workbench.spDumps.length).toBeGreaterThan(0)

    setup.resetAll()
    expect(setup.spDumps).toEqual([])
    expect(workbench.spDumps).toEqual([])
  })

  it('重跑自动初设不叠加（整批落账，不是追加）', () => {
    const setup = useSetupStore()
    const workbench = useWorkbenchStore()
    setup.runAutoSetup()
    const first = workbench.spDumps.length
    setup.resetInputs()
    setup.runAutoSetup()
    expect(workbench.spDumps).toHaveLength(first)
  })
})
