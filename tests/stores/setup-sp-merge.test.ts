import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useGameSessionStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 用户 2026-10-25：**「一个格子里放有多个补给（SP/T）时自动合并，格子里只需要展示该格有多少补给」**
 *
 * 例：剧本在该格放了 2 SP，玩家初设又放 2 SP ⇒ 该格是**一条 4 SP 的补给站**，
 * 不是两枚 2 SP 算子（12.1b：「含 SP 的位置即补给站」——补给站是**位置**，不是条目）。
 *
 * 既有能力（§5-C 已做）：账本同格合并（`sp:格` 一条）+ 地图令牌按格聚合（`spDumpTokens`）。
 * 本条补的是**算子层**：初设再落同格时不再生成第二枚 SP 算子，而是把既有那枚的点数改成总量。
 */

function boot() {
  setActivePinia(createPinia())
  const game = useGameSessionStore()
  const workbench = useWorkbenchStore()
  const setup = useSetupStore()
  const mapView = useMapViewStore()
  game.setScenarioId('1')
  setup.selectScenario('1')
  return { workbench, setup, mapView }
}

describe('12.1b：同格补给自动合并（初设叠加）', () => {
  it('★ 剧本已有 2 SP 的格再放 2 SP ⇒ 一格一条 4 SP（不是两枚 2 SP 算子）', () => {
    const { workbench, setup, mapView } = boot()
    /*
     * 找一对"**候选命中**且该格剧本已有补给站"的组合：SP 条目的合法落点是
     * `w/i N of …` 那一片，而剧本自带的补给站也落在其中若干格上（例 28.04 的 3 SP）。
     */
    let hit:
      | {
          entryIndex: number
          count: number
          hex: { col: number; row: number }
          side: 'axis' | 'soviet'
          before: number
        }
      | undefined
    for (const view of setup.selfChoiceEntries.filter((item) => item.kind === 'sp')) {
      for (const candidate of setup.candidatesOf(view.index)) {
        const dump = setup.spDumps.find(
          (item) =>
            item.side === view.side &&
            item.hex.col === candidate.col &&
            item.hex.row === candidate.row,
        )
        if (dump === undefined) continue
        hit = {
          entryIndex: view.index,
          count: view.count,
          hex: { col: candidate.col, row: candidate.row },
          side: view.side,
          before: dump.points,
        }
        break
      }
      if (hit !== undefined) break
    }
    expect(hit).toBeDefined()
    const { hex, side, before, count: added } = hit!
    expect(added).toBeGreaterThan(0)

    expect(setup.placeSelfEntry(hit!.entryIndex, hex)).toBe(true)

    // ① 账本：同格只剩一条，点数相加
    const dumps = setup.spDumps.filter(
      (item) => item.hex.col === hex.col && item.hex.row === hex.row && item.side === side,
    )
    expect(dumps.length).toBe(1)
    expect(dumps[0]!.points).toBe(before + added)

    // ② 盘面：该格只有**一枚** SP 算子，且点数＝合计（贴图按最近面额 + 角标显示实数）
    const counters = workbench.units.filter(
      (unit) =>
        unit.noncombatKind === 'sp' &&
        unit.side === side &&
        unit.hex.col === hex.col &&
        unit.hex.row === hex.row,
    )
    expect(counters.length).toBe(1)
    expect(counters[0]!.noncombatSp).toBe(before + added)

    // ③ 地图令牌：该格一枚补给站，角标＝合计（不是两枚）
    const tokens = mapView.overlay.tokens.filter(
      (token) =>
        token.noncombatKind === 'sp' && token.hex.col === hex.col && token.hex.row === hex.row,
    )
    expect(tokens.length).toBe(1)
    expect(tokens[0]!.spPoints).toBe(before + added)
  })

  it('★ 换一格放（该格原本没有补给站）⇒ 照常新建一条，不合并不误并', () => {
    const { workbench, setup } = boot()
    const entry = setup.selfChoiceEntries.find((view) => view.kind === 'sp')
    expect(entry).toBeDefined()
    // 挑一个剧本没有补给站的格（候选里的第一格）
    const target = setup.candidatesOf(entry!.index)[0]
    expect(target).toBeDefined()
    const occupied = setup.spDumps.filter(
      (item) => item.hex.col === target!.col && item.hex.row === target!.row,
    )
    expect(occupied.length).toBe(0)

    expect(setup.placeSelfEntry(entry!.index, target!)).toBe(true)
    const dumps = setup.spDumps.filter(
      (item) => item.hex.col === target!.col && item.hex.row === target!.row,
    )
    expect(dumps.length).toBe(1)
    expect(dumps[0]!.points).toBe(entry!.count)
    expect(
      workbench.units.filter(
        (unit) =>
          unit.noncombatKind === 'sp' &&
          unit.hex.col === target!.col &&
          unit.hex.row === target!.row,
      ).length,
    ).toBeGreaterThan(0)
  })
})
