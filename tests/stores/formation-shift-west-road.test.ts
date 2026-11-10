import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useContainersStore, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 剧本 1 西移「沿道路三格」的 store 接线（ch10）
 *
 * 引擎只收 `hasRoad` 谓词；本文件钉的是接线：道路索引来自 `map-layers.edges[].road`。
 * 固定种子下 A 组抽中 29 Mtr / 4 Pz / 12 Pz / 7 Pz：
 *   · 29 Mtr 4.18 → 1.19（secondary 4.18–3.19–2.18–1.19）
 *   · 12 Pz 4.25 → 1.26（secondary 4.25–3.25–2.25–1.26）
 *   · 7 Pz 15.25 → 12.24（track 15.25–14.24–13.24–12.24）
 *   · 4 Pz 8.8 周边 0 条 road 边 ⇒ 留 8.8、不移动、不阻塞初设
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
  return { workbench, containers, setup }
}

describe('剧本 1 西移按道路落点接线（ch10）', () => {
  it('抽中的四个师：有路沿路走满三格，无路留在所列位置', () => {
    const { containers, workbench } = boot()
    const items = new Map(
      containers.pendingShiftWestPlacements.map((item) => [item.formationId, item]),
    )
    const expected: Record<string, string> = {
      '29 Mtr Div': '1.19',
      '12 Pz Div': '1.26',
      '7 Pz Div': '12.24',
      '4 Pz Div': '8.8',
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

  it('无 road 边的师留在原格并记 warning；不产生待办，抽签仍算已处置', () => {
    const { containers, workbench, setup } = boot()
    const gap = containers.pendingShiftWestPlacements.find(
      (item) => item.formationId === '4 Pz Div',
    )!
    expect(gap.fromHexText).toBe('8.8')
    expect(gap.hexText).toBe('8.8')
    expect(
      workbench.log.some(
        (entry) => entry.kind === 'warning' && entry.text.includes('无西向 road 边 ⇒ 留在原格'),
      ),
    ).toBe(true)
    expect(setup.pendingPlacement.filter((item) => item.kind === 'shift')).toEqual([])
    expect(containers.setupDrawProgress.complete).toBe(true)
  })

  it('重跑返回 roadGaps（不移动、不进 pendingShift），盘面不变', () => {
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
    expect(rerun.roadGaps).toEqual([{ formationId: '4 Pz Div', fromHex: '8.8', missing: 'SW|NW' }])
    const after = workbench.units.map(
      (unit) => `${unit.instanceId}@${unit.hex.col}.${unit.hex.row}`,
    )
    expect(after).toEqual(before)
  })
})
