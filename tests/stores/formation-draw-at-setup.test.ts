import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
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

  it('★ 不依赖落点的组当场落盘；西移组只抽不落盘（落点还没给）', () => {
    const { containers } = boot('1')
    const groups = groupsOf('1')
    const shift = groups.find((group) => group.kind === 'shiftWest')
    expect(shift).toBeDefined()
    const others = groups.filter((group) => group.kind !== 'shiftWest')
    expect(others.length).toBeGreaterThan(0)

    // 西移：抽中 ⇒ 进"待摆位"，但**没有**落盘台账（落点缺失，引擎按 shiftWestDestinationMissing 拒）
    expect(containers.pendingShiftWestPlacements.length).toBe(shift?.count ?? 0)
    expect(containers.formationDrawOutcomes.some((row) => row.groupKind === 'shiftWest')).toBe(
      false,
    )
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

  it('★ 西移编队进初设 box（ground 类）⇒ 点一项、点地图即摆一个师', () => {
    const { workbench, containers, setup } = boot('1')
    const items = setup.pendingPlacement.filter((item) => item.kind === 'shift')
    expect(items.length).toBeGreaterThan(0)
    const first = items[0]!
    expect(first.category).toBe('ground')
    expect(first.formationId).toBeDefined()

    // 候选＝原格 N 格半径内且不比原格更靠东（ch10 是"西移"）
    const item = containers.pendingShiftWestPlacements.find(
      (entry) => entry.formationId === first.formationId,
    )
    expect(item).toBeDefined()
    const from = item!.fromHexText!.split('.').map(Number)
    expect(first.candidates.length).toBeGreaterThan(0)
    expect(first.candidates.some((hex) => hex.col === from[0] && hex.row === from[1])).toBe(true)
    expect(first.candidates.every((hex) => hex.col <= (from[0] ?? 0))).toBe(true)

    // 点一项 ⇒ 点地图（西移 3 列，与 ch10 一致）
    expect(setup.beginShiftPlacement(first.formationId!)).toBe(true)
    const target = { col: (from[0] ?? 0) - 3, row: from[1] ?? 0 }
    expect(setup.placeAtHex(target)).toBe(true)

    // 该师图上的算子真的搬过去了
    const moved = workbench.units.filter(
      (unit) => item!.unitIds.includes(unit.instanceId) && unit.hex.col === target.col,
    )
    expect(moved.length).toBe(item!.unitIds.length)
    // 摆完即从待办里消失
    expect(setup.pendingPlacement.some((entry) => entry.formationId === first.formationId)).toBe(
      false,
    )
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

  it('★ 完成初设时**没给落点**的西移师留在剧本页原格（不施加未定的移动，也不移除）', () => {
    const { workbench, setup } = boot('1')
    const pending = setup.pendingPlacement.filter((item) => item.kind === 'shift')
    expect(pending.length).toBeGreaterThan(0)
    const before = new Map(
      workbench.units.map((unit) => [unit.instanceId, `${unit.hex.col}.${unit.hex.row}`]),
    )
    const countBefore = workbench.units.length

    expect(setup.finishSetup()).toBe(true)

    // 一个算子都没少（不是"未落位即移除"）
    expect(workbench.units.length).toBe(countBefore)
    for (const unit of workbench.units) {
      expect(`${unit.hex.col}.${unit.hex.row}`).toBe(before.get(unit.instanceId))
    }
    expect(setup.notes.join('\n')).toContain('留在剧本页原格')
  })
})
