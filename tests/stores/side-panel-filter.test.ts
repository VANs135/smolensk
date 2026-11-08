import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useGameSessionStore, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * ② 双方面板串台（2026-11-09 用户实测）
 *
 * 要求：德军回合**不渲染**苏方条目（如方面军预备队），苏军回合**不渲染**德方条目；
 * 不是变灰、不是不可点，而是根本不出现。判据只取 store 现有事实（`activeSide` /
 * 环节归属），组件不自己推断。
 *
 * 本组钉三件事：
 *  1. 德军回合的计划里没有「方面军预备队」（专规 2.3c 苏方）这一步；
 *  2. 苏军回合、且该批真的存在时，这一步正常出现；
 *  3. 撤离（3.3c 轴方）的界面事实只在轴方回合为真。
 */

function boot() {
  setActivePinia(createPinia())
  const session = useGameSessionStore()
  expect(session.startGame()).toBe(true)
  const workbench = useWorkbenchStore()
  const mapView = useMapViewStore()
  return { session, workbench, mapView }
}

/** 走到「方面军预备队」批次存在的回合（22 Jul / 1 Aug / 1 Sep） */
function seekFrontalReserveTurn(workbench: ReturnType<typeof useWorkbenchStore>): number {
  for (let turn = 1; turn <= 45; turn += 1) {
    workbench.setTurn(turn)
    if (workbench.frontalReservesToday !== null) return turn
  }
  throw new Error('没有找到方面军预备队批次所在的回合')
}

/** 进入 B 增援段并把环节步定位到第 index 步（切方后步骤表会变） */
function enterReinforcement(workbench: ReturnType<typeof useWorkbenchStore>, index = 0): void {
  workbench.setPhase('reinforcement')
  workbench.setSegmentStepIndex(index)
}

describe('② 双方面板串台（按方不渲染）', () => {
  let ctx: ReturnType<typeof boot>

  beforeEach(() => {
    ctx = boot()
  })

  it('德军回合：计划里不出现苏方「方面军预备队」', () => {
    const { workbench, mapView } = ctx
    const turn = seekFrontalReserveTurn(workbench)
    expect(workbench.frontalReservesToday).not.toBeNull()
    workbench.setActiveSide('axis')
    enterReinforcement(workbench)

    expect(workbench.segmentStep?.id).not.toBe('reinforcement.frontalReserves')
    expect(mapView.sessionSteps.map((step) => step.id)).not.toContain('reinforce:frontalReserves')
    expect(mapView.sessionStep?.id).not.toBe('reinforce:frontalReserves')
    // 回合/日期确实是对的那一档（证明确实有批次可领，而不是批次还没到）
    expect(turn).toBeGreaterThan(1)
  })

  it('苏军回合：同一批次存在时「方面军预备队」正常出现', () => {
    const { workbench, mapView } = ctx
    seekFrontalReserveTurn(workbench)
    workbench.setActiveSide('soviet')
    enterReinforcement(workbench)

    const frontIndex = workbench.playerSegmentSteps.findIndex(
      (step) => step.id === 'reinforcement.frontalReserves',
    )
    // 苏方步骤表里必须有这一步（轮到该方时正常出现）
    expect(frontIndex).toBeGreaterThanOrEqual(0)
    // 「一次只暴露一件事」：定位到这一步后，它才成为当前待决事项
    workbench.setSegmentStepIndex(frontIndex)
    expect(mapView.sessionSteps.map((step) => step.id)).toContain('reinforce:frontalReserves')
    expect(mapView.sessionStep?.id).toBe('reinforce:frontalReserves')
  })

  it('撤离（3.3c 轴方）的界面事实只在轴方回合为真', () => {
    const { workbench } = ctx
    let turned = false
    for (let turn = 1; turn <= 45; turn += 1) {
      workbench.setTurn(turn)
      if (workbench.variableExitOpen) {
        turned = true
        break
      }
    }
    expect(turned).toBe(true)

    workbench.setActiveSide('axis')
    expect(workbench.variableExitForActiveSide).toBe(true)
    workbench.setActiveSide('soviet')
    expect(workbench.variableExitForActiveSide).toBe(false)
  })
})
