import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
import { useContainersStore, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'

import type { Workbench } from '../flows/sop-harness'

/**
 * I② 切片 2（用户 2026-09-18 报告第 5 条后半）：
 * **「应该调整位置的编队应该放入初设里让玩家设置位置」**
 *
 * 原文（ch10）：剧本 1/2 的 A 组「抽中的师**沿道路向所列位置西移三格**」——那个位置印在剧本卡上、
 * 数据里没有 ⇒ 只能由玩家给。本条要的是：抽中西移的那些师**出现在初设里**，玩家逐条给 `列.行`，
 * 给完照此摆位（而不是像修前那样只能在 B 段的抽取盒里点地图、且与初设没关系）。
 *
 * 本文件钉三件事：
 *   ① 抽签后（B 段西移组）初设里**列出**待摆位的编队（含原初设格号与 ch10 的西移格数）；
 *   ② 玩家给落点 ⇒ 「照此摆位」把该师**图上**的单位摆过去，并写进台账；
 *   ③ **缺落点整笔拒绝**（不猜），且格式非法的落点当场拒。
 */

function goToDrawStep(workbench: Workbench): void {
  workbench.setPhase('reinforcement')
  workbench.setActiveSide('axis')
  const index = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'reinforcement.formationDraw',
  )
  if (index < 0) throw new Error('B 段没有「编队抽取」环节')
  if (!workbench.setSegmentStepIndex(index)) throw new Error('进入编队抽取环节失败')
}

function boot() {
  setActivePinia(createPinia())
  const game = useGameSessionStore()
  const workbench = useWorkbenchStore()
  const containers = useContainersStore()
  const setup = useSetupStore()
  game.setScenarioId('1')
  containers.setScenario('1')
  setup.selectScenario('1') // 真实盘面（初设落盘）
  return { workbench, containers }
}

/** 抽一次西移组并落盘（落点稍后由玩家在初设里给） */
function drawShiftWest(containers: ReturnType<typeof boot>['containers'], workbench: Workbench) {
  goToDrawStep(workbench)
  const group = (
    scenarios.scenarios.find((item) => item.id === '1')?.setup.formationDraw?.groups ?? []
  ).find((item) => item.kind === 'shiftWest')
  if (group === undefined) throw new Error('剧本 1 应有 shiftWest 组')
  containers.drawFormations(group)
  return group
}

describe('I② 切片 2：西移编队进初设摆位（ch10）', () => {
  it('★ 抽签后初设列出待摆位编队：带原初设格号、西移格数、图上单位数；未给落点为 null', () => {
    const { containers, workbench } = boot()
    const group = drawShiftWest(containers, workbench)
    const pending = containers.pendingShiftWestPlacements
    expect(pending.length).toBe(group.count)
    for (const item of pending) {
      expect(item.hexText).toBeNull() // 还没给落点
      expect(item.fromHexText).not.toBeNull() // 原初设格号（给落点的参照）
      expect(item.shiftHexes).toBe(group.shiftHexes ?? 0)
    }
    // 反空转：图上单位至少找得到一部分（推得出组成的那些师）
    expect(pending.some((item) => item.unitIds.length > 0)).toBe(true)
  })

  it('★ 给落点 ⇒ 「照此摆位」把该师图上单位摆过去，并写进台账', () => {
    const { containers, workbench } = boot()
    drawShiftWest(containers, workbench)
    const pending = containers.pendingShiftWestPlacements
    // 给每个师一个落点：原初设格西移 3 列（与 ch10 的"西移 3 格"一致）
    for (const item of pending) {
      const from = item.fromHexText!.split('.').map(Number)
      expect(
        containers.setDrawShiftHexNow(
          item.formationId,
          `${String(from[0]! - 3)}.${String(from[1]!)}`,
        ),
      ).toBe(true)
    }
    expect(containers.applyShiftWestPlacementsNow()).toBe(true)

    // 图上单位确实搬到了落点（重新读投影：此刻才带上玩家给的落点）
    const placed = containers.pendingShiftWestPlacements
    const first = placed[0]!
    const target = first.hexText!.split('.').map(Number)
    for (const instanceId of first.unitIds) {
      const unit = workbench.units.find((entry) => entry.instanceId === instanceId)
      if (unit === undefined) continue
      expect([unit.hex.col, unit.hex.row]).toEqual([target[0], target[1]])
    }
    // 台账里记下落点（初设面板读它）
    const row = containers.formationDrawOutcomes.find((item) => item.groupKind === 'shiftWest')
    expect(row?.destinations.length).toBe(pending.length)
    // 列差与 ch10 相符 ⇒ 不该有"列差 ≠ 西移格数"的提示
    expect(workbench.log.map((entry) => entry.text).join('\n')).not.toContain('≠ ch10 的西移')
  })

  it('★ 缺落点 ⇒ **整笔拒绝**（不改动任何算子）；格式非法的落点当场拒', () => {
    const { containers, workbench } = boot()
    drawShiftWest(containers, workbench)
    const pending = containers.pendingShiftWestPlacements
    expect(containers.applyShiftWestPlacementsNow()).toBe(false) // 一个落点都没给

    const before = new Map(
      workbench.units.map((unit) => [unit.instanceId, `${unit.hex.col}.${unit.hex.row}`]),
    )
    expect(containers.setDrawShiftHexNow(pending[0]!.formationId, '不是格号')).toBe(false)
    expect(containers.applyShiftWestPlacementsNow()).toBe(false)
    // 只给了一个 ⇒ 仍拒（不猜其余）
    const from = pending[0]!.fromHexText!.split('.').map(Number)
    expect(
      containers.setDrawShiftHexNow(
        pending[0]!.formationId,
        `${String(from[0]! - 3)}.${String(from[1]!)}`,
      ),
    ).toBe(true)
    expect(containers.applyShiftWestPlacementsNow()).toBe(false)

    for (const unit of workbench.units) {
      expect(`${unit.hex.col}.${unit.hex.row}`).toBe(before.get(unit.instanceId))
    }
  })
})
