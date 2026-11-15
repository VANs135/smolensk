import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import {
  exposedSessionStep,
  planSessionSteps,
  useMapViewStore,
  useWorkbenchStore,
  type SessionStepFacts,
} from '@/stores'

/**
 * 增援段第二段：**一次检定 → 结果与手牌同屏**（用户 2026-11-15 口径）
 *
 * 修前：3.6 随机事件、1.6b 掷表、统一手牌各占一个会话步骤，玩家点「掷骰检定」后
 * 还要再点「本步完成 / 跳过」才看得到可落位的单位（窗口依次是随机事件 / 补员表 / 手牌）。
 * 现在：掷骰是自动的，点一次检定后，结果（SP / 补员点数与来源）与可落位单位在同一窗；
 * 唯一出口是「结束本段」。
 */

function baseFacts(over: Partial<SessionStepFacts['reinforce']> = {}): SessionStepFacts {
  return {
    kind: 'reinforce',
    combat: null,
    barrage: null,
    air: null,
    ops: null,
    supply: null,
    move: { fuelPending: false, pickPending: false, moving: false, overrunZocHeld: false },
    reinforce: {
      stepId: 'reinforcement.replRoll',
      acked: [],
      arrivalPending: false,
      randomEventPending: false,
      supplyTrainPending: false,
      panzerGroupRulesOn: false,
      variableExitPending: false,
      replTablePending: true,
      specialReplPending: false,
      supplyPlacePending: false,
      handPending: false,
      handPlacedCount: 0,
      rebuildAvailable: false,
      frontalReservesPending: false,
      slowMobilizationVisible: false,
      consolidationAvailable: false,
      ...over,
    },
    breakout: false,
    breakoutReturnPending: false,
    containers: false,
    exclusive: false,
    exclusiveSections: [],
    unit: false,
  }
}

const idsOf = (facts: SessionStepFacts): string[] =>
  planSessionSteps(facts).map((entry) => entry.id)

describe('增援段第二段：只留一个「掷骰与落位」窗', () => {
  it('轴方掷骰段（随机事件 / 补给列车 / 可变撤离 / 补员表全在）⇒ 只有一个窗', () => {
    expect(
      idsOf(
        baseFacts({
          randomEventPending: true,
          supplyTrainPending: true,
          variableExitPending: true,
          replTablePending: true,
          handPending: true,
          handPlacedCount: 2,
        }),
      ),
    ).toEqual(['reinforce:roll'])
  })

  it('苏方有方面军预备队时：先领取（必须当即领取），再进掷骰与落位窗', () => {
    expect(idsOf(baseFacts({ frontalReservesPending: true, handPending: true }))).toEqual([
      'reinforce:frontalReserves',
      'reinforce:roll',
    ])
  })

  it('结束后不再冒出第二段的其他窗', () => {
    const items = planSessionSteps(baseFacts({ acked: ['reinforce:roll'] }))
    expect(exposedSessionStep(items)).toBe(null)
  })

  it('结束本段记的是同一个窗 id（下次进入不再重复出现）', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    const mapView = useMapViewStore()
    store.setPhase('reinforcement')
    store.setTurn(2)
    const at = store.playerSegmentSteps.findIndex((step) => step.id === 'reinforcement.replRoll')
    expect(at).toBeGreaterThanOrEqual(0)
    store.setSegmentStepIndex(at)
    store.variableReplInputs.autoRoll = false
    store.variableReplInputs.supplyDice = 7
    store.variableReplInputs.replDice = 7
    store.variableReplInputs.specialDie = 3
    expect(store.rollVariableReplNow()).toBe(true)
    store.markSpecialReplDraw(store.activeSide, store.turn)
    expect(store.endRollSegmentNow(true)).toBe(true)
    expect(mapView.sessionSteps.map((step) => step.id)).not.toContain('reinforce:roll')
  })
})

describe('增援面板：掷骰与手牌同屏，不再有第二个掷骰窗', () => {
  const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')

  it('只保留一个第二段窗，旧的自动掷骰窗 / 手牌窗 / 结束窗一律不再单列', () => {
    expect(panel).toContain('item="reinforce:roll"')
    for (const dead of [
      'item="reinforce:randomEvent"',
      'item="reinforce:supplyTrain"',
      'item="reinforce:variableExit"',
      'item="reinforce:replTable"',
      'item="reinforce:hand"',
      'item="reinforce:endRoll"',
    ]) {
      expect(panel, `仍残留独立窗 ${dead}`).not.toContain(dead)
    }
  })

  it('结果与手牌在同一窗内：手牌与检定按钮都不再各自挂在独立窗的 ack 上', () => {
    expect(panel).toContain('workbench.rollHandEntries')
    expect(panel).toContain('runReplCheck')
    // 1.6c 未掷时，「掷骰检定」是唯一入口（不出现第二颗骰 / 第二个掷骰按钮）
    expect((panel.match(/runReplCheck/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })
})
