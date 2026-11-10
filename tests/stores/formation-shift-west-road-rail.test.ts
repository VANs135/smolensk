import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useContainersStore, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'
import { confirmSetupForStart } from '../flows/setup-harness'

/**
 * 剧本 1 西移「沿道路/铁路三格」的 store 接线（ch10）
 *
 * 引擎只收 `hasRoadOrRail` 谓词；本文件钉的是接线：边索引来自 `map-layers.edges[].road`
 * **∪** `edges[].rail`（用户 2026-11-10 裁定「铁路和道路都算路」）。
 * 固定种子下 A 组抽中 29 Mtr / 4 Pz / 12 Pz / 7 Pz：
 *   · 29 Mtr 4.18 → 1.19（rail 4.18–3.18–2.18，secondary 2.18–1.19）
 *   · 12 Pz 4.25 → 1.26（secondary 4.25–3.25–2.25–1.26）
 *   · 7 Pz 15.25 → 12.24（track 15.25–14.24–13.24–12.24）
 *   · 4 Pz 8.8 → 5.8（多轨铁路 8.8–7.8–6.7–5.8）
 */

function boot(scenarioId = '1') {
  setActivePinia(createPinia())
  const game = useGameSessionStore()
  const workbench = useWorkbenchStore()
  const containers = useContainersStore()
  const setup = useSetupStore()
  game.setScenarioId(scenarioId)
  containers.setScenario(scenarioId)
  setup.selectScenario(scenarioId)
  // ch10（用户 2026-11-10）：抽签只在初设单位放置完成后执行一次
  confirmSetupForStart(setup)
  setup.executeSetupDraws()
  return { workbench, containers, setup }
}

describe('剧本 1 西移按道路/铁路落点接线（ch10）', () => {
  it('抽中的四个师：沿道路或铁路都走满三格', () => {
    const { containers, workbench } = boot()
    const items = new Map(
      containers.pendingShiftWestPlacements.map((item) => [item.formationId, item]),
    )
    const expected: Record<string, string> = {
      '29 Mtr Div': '1.19',
      '12 Pz Div': '1.26',
      '7 Pz Div': '12.24',
      '4 Pz Div': '5.8',
    }
    expect([...items.keys()].sort()).toEqual(Object.keys(expected).sort())
    for (const [formationId, destination] of Object.entries(expected)) {
      const item = items.get(formationId)!
      expect(item.hexText).toBe(destination)
      expect(item.unitIds.length).toBeGreaterThan(0)
      for (const instanceId of item.unitIds) {
        const unit = workbench.units.find((entry) => entry.instanceId === instanceId)!
        expect(`${unit.hex.col}.${unit.hex.row}`).toBe(destination)
      }
    }
  })

  it('4 Pz 只连铁轨也走满三格：无 roadGaps、无 warning、初设无待办', () => {
    const { containers, workbench, setup } = boot()
    const fourth = containers.pendingShiftWestPlacements.find(
      (item) => item.formationId === '4 Pz Div',
    )!
    expect(fourth.fromHexText).toBe('8.8')
    expect(fourth.hexText).toBe('5.8')
    expect(
      workbench.log.some(
        (entry) => entry.kind === 'warning' && entry.text.includes('无西向道路/铁路边'),
      ),
    ).toBe(false)
    expect(setup.pendingPlacement.filter((item) => item.kind === 'shift')).toEqual([])
    expect(containers.setupDrawProgress.complete).toBe(true)
  })

  it('重跑不产生 roadGaps（全部走满），盘面不变', () => {
    const { containers, workbench } = boot()
    // 清掉本次的落点与西移台账 ⇒ 重跑会走同一条自动分支
    containers.formationDrawOutcomes = containers.formationDrawOutcomes.filter(
      (row) => row.groupKind !== 'shiftWest',
    )
    containers.drawShiftHexText = {}
    const before = workbench.units.map(
      (unit) => `${unit.instanceId}@${unit.hex.col}.${unit.hex.row}`,
    )
    const rerun = containers.runSetupDrawsNow()
    expect(rerun.ok).toBe(true)
    expect(rerun.pendingShift).toEqual([])
    expect(rerun.roadGaps).toEqual([])
    const after = workbench.units.map(
      (unit) => `${unit.instanceId}@${unit.hex.col}.${unit.hex.row}`,
    )
    expect(after).toEqual(before)
  })
})
