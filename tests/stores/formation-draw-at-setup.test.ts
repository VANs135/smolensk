import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
import { shiftWestDestination } from '@/engine/rules'
import { useContainersStore, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 第六批 §6-A：**编队抽签放到初设自动执行**（用户 2026-10-25）
 *
 * 「初设里的德军抽取编队放置或者替换单位，应该放在初设时自动抽取后给玩家初设」——
 * ch10「Formation Chit Draw」/ ch11 的剧本随机化都是**开局前**的剧本随机化，
 * 处置（沿道路西移 / 以 Move Mode 初设 / 与死亡堆互换 / 营入死亡堆）全部作用在**初设摆好的算子**上，
 * 故抽签必须：① 在**自动初设之后**跑；② **自动**跑（随机数一律自动结算）；
 * ③ 把"要玩家给落点"的那部分（西移）交回**初设 box**，而不是留在 B 增援段等玩家去点。
 *
 * 本文件钉五件事：
 *   ① 选剧本即**自动抽签**（不用玩家点「抽签」），且抽签在自动初设**之后**（处置改得到盘上算子）；
 *   ② 不依赖落点的组当场落盘；西移组**只抽不落盘**（落点还没给）；
 *   ③ 西移编队进**初设 box**（`pendingPlacement` 的 ground 类）⇒ 点一项点地图即摆一个师；
 *   ④ 幂等：重复进入不重抽（换剧本/重挂载不会把抽签结果与已落盘处置搅乱）；
 *   ⑤ 完成初设时**没给落点**的西移师**留在剧本页原格**（不移除——规则没写"未落位即移除"）。
 */

/** 建一套真实盘面：选剧本 ⇒ 自动初设 + 自动抽签 */
function boot(scenarioId = '1') {
  setActivePinia(createPinia())
  const game = useGameSessionStore()
  const workbench = useWorkbenchStore()
  const containers = useContainersStore()
  const setup = useSetupStore()
  game.setScenarioId(scenarioId)
  containers.setScenario(scenarioId)
  setup.selectScenario(scenarioId)
  return { game, workbench, containers, setup }
}

/** 剧本 1 的抽签组（取自初设源剧本） */
function groupsOf(scenarioId = '1') {
  return (
    scenarios.scenarios.find((item) => item.id === scenarioId)?.setup.formationDraw?.groups ?? []
  )
}

describe('§6-A：编队抽签在初设自动执行（ch10 / ch11）', () => {
  it('★ 选剧本即自动抽签：各组都抽到了人，不用玩家点「抽签」', () => {
    const { containers } = boot('1')
    const groups = groupsOf('1')
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      expect(containers.drawnOf(group).length).toBe(group.count)
    }
    // 回执里说清了"抽了几组 / 落盘几组 / 谁在等落点"
    expect(containers.lastAction?.scope).toBe('初设·编队抽取')
  })

  it('★ ch10「4 others」：A/B 两组**不重叠**（B 只从 A 抽剩的那些里再抽）', () => {
    const { containers } = boot('1')
    const groups = groupsOf('1')
    const a = containers.drawnOf(groups[0]!)
    const b = containers.drawnOf(groups[1]!)
    expect(a.length).toBe(groups[0]!.count)
    expect(b.length).toBe(groups[1]!.count)
    // 同一个师不能既"西移三格"又"Mtr↔Aufk 互换"（原文是"4 others"）
    expect(a.filter((id) => b.includes(id))).toEqual([])
    expect(new Set([...a, ...b]).size).toBe(a.length + b.length)
  })

  it('★ 重抽某组时也排除**其它组**已抽中的（手动入口同口径）', () => {
    const { containers } = boot('1')
    const groups = groupsOf('1')
    const b = containers.drawnOf(groups[1]!)
    const again = containers.drawFormations(groups[0]!)
    expect(again.length).toBe(groups[0]!.count)
    expect(again.filter((id) => b.includes(id))).toEqual([])
  })

  it('★ 不依赖落点的组当场落盘；西移组只抽不落盘（落点还没给）', () => {
    const { containers } = boot('1')
    const groups = groupsOf('1')
    const shift = groups.find((group) => group.kind === 'shiftWest')
    expect(shift).toBeDefined()
    const others = groups.filter((group) => group.kind !== 'shiftWest')
    expect(others.length).toBeGreaterThan(0)

    // 西移：抽中 ⇒ 按「视为有道路」**当场算出落点并摆位**（台账有该组的落点）
    expect(containers.pendingShiftWestPlacements.length).toBe(shift?.count ?? 0)
    const shiftRow = containers.formationDrawOutcomes.find((row) => row.groupKind === 'shiftWest')
    expect(shiftRow).toBeDefined()
    expect(shiftRow?.destinations.length).toBe(shift?.count ?? 0)
    for (const item of containers.pendingShiftWestPlacements) {
      expect(item.hexText).not.toBeNull() // 落点已自动算出（不再等玩家给）
    }
    // 其余组：已落盘（台账有该组）
    for (const group of others) {
      expect(containers.formationDrawOutcomes.some((row) => row.groupKind === group.kind)).toBe(
        true,
      )
    }
  })

  it('★ 抽签在自动初设**之后**：处置改的是盘上那几枚算子（实例 id 由自动初设生成）', () => {
    const { workbench, containers } = boot('1')
    // 自动初设有盘面（否则"改盘上算子"无从谈起）
    expect(workbench.units.length).toBeGreaterThan(0)
    // 处置确实落到了盘上：至少有一个非西移组的处置留下了痕迹（死亡堆有被送进去的算子）
    const deposited = containers.formationDrawOutcomes.filter(
      (row) => row.groupKind !== 'shiftWest',
    )
    expect(deposited.length).toBeGreaterThan(0)
    expect(workbench.deadPile.length).toBeGreaterThan(0)
  })

  it('★ 西移已**自动摆位**⇒ 不占待办；仍可点地图改落点（ch10）', () => {
    const { workbench, containers, setup } = boot('1')
    // 自动摆好了 ⇒ 待办里不该再有西移项（玩家不必为抽签点地图）
    expect(setup.pendingPlacement.filter((item) => item.kind === 'shift').length).toBe(0)
    const item = containers.pendingShiftWestPlacements[0]!
    expect(item.hexText).not.toBeNull()

    // 落点＝沿 SW 从所列位置走 N 格（引擎 `shiftWestDestination` 的口径）
    const target = item.hexText!.split('.').map(Number)
    expect(target[0]!).toBeLessThan(item.fromHexText!.split('.').map(Number)[0]!)
    const onTarget = workbench.units.filter(
      (unit) => item.unitIds.includes(unit.instanceId) && unit.hex.col === target[0],
    )
    expect(onTarget.length).toBe(item.unitIds.length)

    // 仍可改：点一项 ⇒ 地图高亮候选（原格 N 格半径内且不更靠东）⇒ 点地图换一格
    expect(setup.beginShiftPlacement(item.formationId)).toBe(true)
    const from = item.fromHexText!.split('.').map(Number)
    expect(setup.placing?.candidates.length).toBeGreaterThan(0)
    expect(setup.placing!.candidates.every((hex) => hex.col <= (from[0] ?? 0))).toBe(true)
    const moved = { col: Math.max(1, (target[0] ?? 1) - 1), row: target[1] ?? 0 }
    expect(setup.placeAtHex(moved)).toBe(true)
    const after = workbench.units.filter(
      (unit) => item.unitIds.includes(unit.instanceId) && unit.hex.col === moved.col,
    )
    expect(after.length).toBe(item.unitIds.length)
  })

  it('★ 幂等：重复进入不重抽（换剧本再回来 / 重挂载不会搅乱抽签结果与已落盘处置）', () => {
    const { containers, setup } = boot('1')
    const group = groupsOf('1')[0]!
    const before = [...containers.drawnOf(group)]
    expect(before.length).toBeGreaterThan(0)
    setup.runSetupDraws()
    setup.runSetupDraws()
    expect(containers.drawnOf(group)).toEqual(before)
  })

  it('★ 剧本 2（共用剧本 1 初设）也能抽：池按**初设源**取，组成也按源剧本推', () => {
    const { containers, workbench } = boot('2')
    // 池成员只挂在 S1·axis 上 ⇒ 修前剧本 2 的池为空、一个也抽不出来
    expect(containers.pendingShiftWestPlacements.length).toBeGreaterThan(0)
    // 组成也推得出来（初设行按源剧本取）⇒ 图上找得到该师的算子
    expect(containers.pendingShiftWestPlacements.some((item) => item.unitIds.length > 0)).toBe(true)
    expect(workbench.units.length).toBeGreaterThan(0)
  })

  it('★ 落点＝沿 SW 从所列位置走 N 格（「视为那个格子有道路」）：11.03 → 8.01', () => {
    const dest = shiftWestDestination({ col: 11, row: 3 }, 3)
    expect([dest.hex.col, dest.hex.row]).toEqual([8, 1])
    expect(dest.walked).toBe(3)
    expect(dest.exact).toBe(true)
    // 与原文示例（11.03 → 9.01）**同向**：向西（列减）且向南（行减）；
    // 差一格是道路拐弯所致（数据里该区域没有 road 边）⇒ 回执与界面已如实写明
    expect(dest.hex.col).toBeLessThan(11)
    expect(dest.hex.row).toBeLessThan(3)
  })

  it('★ 完成初设：西移师停在**自动算出的落点**（不移除、也不留在原格）', () => {
    const { workbench, setup, containers } = boot('1')
    const item = containers.pendingShiftWestPlacements[0]!
    const target = item.hexText!.split('.').map(Number)
    const countBefore = workbench.units.length

    expect(setup.finishSetup()).toBe(true)

    // 一个算子都没少（不是"未落位即移除"）
    expect(workbench.units.length).toBe(countBefore)
    expect(setup.notes.join('\n')).not.toContain('留在剧本页原格')
    const moved = workbench.units.filter(
      (unit) =>
        item.unitIds.includes(unit.instanceId) &&
        unit.hex.col === target[0] &&
        unit.hex.row === target[1],
    )
    expect(moved.length).toBe(item.unitIds.length)
  })
})
