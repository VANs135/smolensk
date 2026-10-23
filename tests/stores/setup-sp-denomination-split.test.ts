import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 第六批批 S 切片 4（条 26）：**初设 SP / 运输点按量分面额落盘**
 *
 * 修前（契约）：SP 条目 `total` 写死为 1，一次点完一整条，不能分多格、不能选量。
 * 修后（条 26）：SP / 运输点以**实际量**计，可分多次落在**不同格**，每次由玩家选「这一下放几」；
 *   同格同方的多次放置**合并进同一条 dump**（账本逐格合一，不出现重复 id）。
 *
 * 验收（取自 `docs/第六批修改方案.md` 批 S）：
 *   · 9SP 可分 5 + 4 落两格（任一合法拆法都成立）；也可一次 9 落一格；
 *   · 同格多次放置 ⇒ 账本合成一条（points 相加）。
 *
 * 不触碰 §5-C 的全局 dump id 重映射（spDumpPanzerGroups / pendingSpGroupAssignment /
 * barrageSupplyDumpId）：本改动的合并**保持 dump id 不变**（`sp:格`），引用依旧解析，故无需迁移。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

const spEntryOf = (setup: ReturnType<typeof useSetupStore>) =>
  setup.decisionQueue
    .flatMap((stack) => stack.items)
    .find((item) => item.kind === 'self' && item.raw.includes('SP'))

describe('第六批 S4：初设 SP 按量分面额落盘（条 26）', () => {
  let stores: ReturnType<typeof newStores>
  beforeEach(() => {
    stores = newStores()
    stores.setup.selectScenario('1')
  })

  it('★ SP 条目 total＝实际 SP 量（不再是写死的 1），且可一次点完', () => {
    const { setup } = stores
    const sp = spEntryOf(setup)!
    expect(sp.total).toBeGreaterThan(1)

    expect(setup.beginSelfPlacement(sp.entryIndex)).toBe(true)
    // 默认 chunk＝剩余量 ⇒ 一次点完
    expect(setup.placing?.chunk).toBe(sp.total)
    const target = sp.candidates[0]!
    expect(setup.placeAtHex(target)).toBe(true)
    expect(setup.placing).toBeNull()

    const dump = setup.spDumps.find(
      (item) => item.hex.col === target.col && item.hex.row === target.row && item.side === sp.side,
    )
    expect(dump?.points).toBe(sp.total)
  })

  it('★ 可分多格：先放一部分到 A，再放剩余到 B（两条 dump 各记各的量）', () => {
    const { setup } = stores
    const sp = spEntryOf(setup)!
    const total = sp.total
    const c1 = Math.max(1, Math.floor(total / 2))
    const c2 = total - c1
    expect(c2).toBeGreaterThan(0)

    const a = sp.candidates[0]!
    const b = sp.candidates.find((hex) => hex.col !== a.col || hex.row !== a.row)!
    expect(b).toBeDefined()

    const beforeA = setup.spDumps
      .filter((d) => d.hex.col === a.col && d.hex.row === a.row && d.side === sp.side)
      .reduce((sum, d) => sum + d.points, 0)
    const beforeB = setup.spDumps
      .filter((d) => d.hex.col === b.col && d.hex.row === b.row && d.side === sp.side)
      .reduce((sum, d) => sum + d.points, 0)

    expect(setup.beginSelfPlacement(sp.entryIndex)).toBe(true)
    // 第一份：放 c1 到 A
    setup.setPlacingChunk(c1)
    expect(setup.placing?.chunk).toBe(c1)
    expect(setup.placeAtHex(a)).toBe(true)
    expect(setup.placing).not.toBeNull()
    expect(setup.placing?.placed).toBe(c1)

    // 第二份：放 c2 到 B
    setup.setPlacingChunk(c2)
    expect(setup.placeAtHex(b)).toBe(true)
    expect(setup.placing).toBeNull()

    const dumpA = setup.spDumps.find(
      (d) => d.hex.col === a.col && d.hex.row === a.row && d.side === sp.side,
    )
    const dumpB = setup.spDumps.find(
      (d) => d.hex.col === b.col && d.hex.row === b.row && d.side === sp.side,
    )
    expect(dumpA?.points).toBe(beforeA + c1)
    expect(dumpB?.points).toBe(beforeB + c2)
  })

  it('★ 同格合并：同一格放两次 ⇒ 账本合成一条（points 相加，无重复 id）', () => {
    const { setup } = stores
    const sp = spEntryOf(setup)!
    const total = sp.total
    const c1 = Math.max(1, Math.floor(total / 2))
    const c2 = total - c1
    const a = sp.candidates[0]!

    const beforeA = setup.spDumps
      .filter((d) => d.hex.col === a.col && d.hex.row === a.row && d.side === sp.side)
      .reduce((sum, d) => sum + d.points, 0)

    expect(setup.beginSelfPlacement(sp.entryIndex)).toBe(true)
    setup.setPlacingChunk(c1)
    expect(setup.placeAtHex(a)).toBe(true)
    // 再在同格放 c2
    setup.setPlacingChunk(c2)
    expect(setup.placeAtHex(a)).toBe(true)
    expect(setup.placing).toBeNull()

    const atA = setup.spDumps.filter(
      (d) => d.hex.col === a.col && d.hex.row === a.row && d.side === sp.side,
    )
    // ★ 关键：同格同方只合成**一条** dump（账本逐格合一），不重复 id
    expect(atA).toHaveLength(1)
    expect(atA[0]?.points).toBe(beforeA + c1 + c2)
  })

  it('源码守卫：放置态暴露「本次落多少」的选择面额（含剩余量）', () => {
    const { setup } = stores
    const sp = spEntryOf(setup)!
    expect(setup.beginSelfPlacement(sp.entryIndex)).toBe(true)
    const choices = setup.placingChunkChoices
    // 至少含「剩余量」本身（保证一次点完永远可选）
    expect(choices).toContain(sp.total)
    expect(choices.every((value) => value > 0 && value <= sp.total)).toBe(true)
  })
})
