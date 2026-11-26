import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, NEAR_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 2026-11-26：**右键已选中施工者 ⇒ 只铺候选格，不再列全部工程兵**
 *
 * 本文件钉 store 侧的两条候选投影：空军建造（15.3/15.2A）与环形工事（16.0b/c 工程兵途径）。
 * 三条判据必须与落盘动作同源：13.8d 公共闸门（阶段/未移动/一格一任务）、2 格步行 MP、目标格本身。
 */
function engineerAt(hex = CORE_HEX, id = 'eng-1') {
  const record = groundRecord('axis', (item) => (item.specialized ?? []).includes('hq'))
  const unit = placeGround(useWorkbenchStore(), record, hex, 'axis', id)
  unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
  unit.mpSpent = 0
  unit.movementEnded = false
  return unit
}

function airStage() {
  setActivePinia(createPinia())
  const workbench = useWorkbenchStore()
  workbench.setPhase('movement')
  workbench.setTurn(4)
  const engineer = engineerAt()
  workbench.prepareAirConstructionWindowNow('baseBuild', engineer.instanceId)
  return { workbench, engineer }
}

describe('15.3 / 15.2A：右键施工者的候选格', () => {
  it('★ 只按**这一名**工程兵铺 2 格步行 MP 内的落点（不是全部工程兵/全图）', () => {
    const { workbench, engineer } = airStage()
    const candidates = workbench.airConstructionCandidateHexes('baseBuild')
    expect(candidates).toContainEqual(CORE_HEX)
    expect(candidates).toContainEqual(NEAR_HEX)
    expect(candidates.every((hex) => workbench.constructionLegRangeTo(engineer, hex) <= 2)).toBe(
      true,
    )
  })

  it('★ 目标格已有空中设施 / 建造标记 ⇒ 不进候选（4.8、专规 3.5 同一把闸）', () => {
    const { workbench } = airStage()
    workbench.constructionMarkerPieces.push({ id: 'm1', kind: 'airStrip', hex: NEAR_HEX })
    const build = workbench.airConstructionCandidateHexes('airstripBuild')
    expect(build).not.toContainEqual(NEAR_HEX)
    expect(build).toContainEqual(CORE_HEX)
  })

  it('★ 施工者已移动 / 已做过一格 ⇒ 候选清空（13.8d 一格一任务，不先给可点格）', () => {
    const { workbench, engineer } = airStage()
    expect(workbench.airConstructionCandidateHexes('baseBuild').length).toBeGreaterThan(0)
    engineer.mpSpent = 1
    expect(workbench.airConstructionCandidateHexes('baseBuild')).toEqual([])
  })

  it('★ 15.2A 升格候选含**本方真简易机场**与标记简易机场（3.5：standard air strip）', () => {
    const { workbench } = airStage()
    workbench.constructionMarkerPieces.push({ id: 'm1', kind: 'airStrip', hex: NEAR_HEX })
    expect(workbench.airConstructionCandidateHexes('airstripUpgrade')).toContainEqual(NEAR_HEX)
  })
})

describe('16.0b/c：右键施工工程兵的候选格', () => {
  it('★ 工程兵途径按 2 格步行 MP 铺候选；非目标格（已建满）被同源判据筛掉', () => {
    setActivePinia(createPinia())
    const workbench = useWorkbenchStore()
    workbench.setPhase('movement')
    workbench.setTurn(4)
    const engineer = engineerAt()
    workbench.prepareHedgehogWindowNow('build', 'engineer', engineer.instanceId, '')
    const candidates = workbench.hedgehogCandidateHexes('build')
    expect(candidates).toContainEqual(CORE_HEX)
    expect(candidates).toContainEqual(NEAR_HEX)
    expect(candidates.every((hex) => workbench.constructionLegRangeTo(engineer, hex) <= 2)).toBe(
      true,
    )

    workbench.hedgehogTurnLedger = { [`${NEAR_HEX.col}.${NEAR_HEX.row}`]: { built: 1, reduced: 0 } }
    expect(workbench.hedgehogCandidateHexes('build')).not.toContainEqual(NEAR_HEX)
  })
})
