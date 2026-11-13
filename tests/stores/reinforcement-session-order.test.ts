import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  exposedSessionStep,
  planSessionSteps,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type SessionStepFacts,
} from '@/stores'

/**
 * 增援段（B）单窗顺序守卫
 *
 * 用户口径：B 段会话一次只开一个窗、只办一件事，前一件办完才出下一件；
 * 窗口次序按原文可定的部分排，其余专规按 spec 的建议位。
 *
 * 判据只读 `planSessionSteps` 的投影与 store 的既有账本，不在测试里另写规则。
 */

function baseFacts(over: Partial<SessionStepFacts['reinforce']> = {}): SessionStepFacts {
  return {
    kind: 'reinforce',
    combat: null,
    barrage: null,
    air: null,
    ops: null,
    supply: null,
    move: {
      fuelPending: false,
      pickPending: false,
      moving: false,
      overrunZocHeld: false,
    },
    reinforce: {
      stepId: 'reinforcement.arrival',
      acked: [],
      arrivalPending: false,
      randomEventPending: false,
      supplyTrainPending: false,
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

describe('增援段：段 → 节集合（v7.1 第二段）', () => {
  it('到达环节：只出到达段的两块，不混入掷骰/重建/方面军', () => {
    expect(
      idsOf(
        baseFacts({
          stepId: 'reinforcement.arrival',
          arrivalPending: true,
          slowMobilizationVisible: true,
          replTablePending: true,
          supplyPlacePending: true,
          randomEventPending: true,
          specialReplPending: true,
          rebuildAvailable: true,
          consolidationAvailable: true,
          frontalReservesPending: true,
        }),
      ),
    ).toEqual(['reinforce:arrival', 'reinforce:slow'])
  })

  it('掷骰宿主：段内块按 §3 次序，最后是统一手牌与结束本段', () => {
    expect(
      idsOf(
        baseFacts({
          stepId: 'reinforcement.replRoll',
          arrivalPending: true,
          replTablePending: true,
          supplyPlacePending: true,
          randomEventPending: true,
          supplyTrainPending: true,
          variableExitPending: true,
          specialReplPending: true,
          frontalReservesPending: true,
          rebuildAvailable: true,
          consolidationAvailable: true,
        }),
      ),
    ).toEqual([
      'reinforce:randomEvent',
      'reinforce:supplyTrain',
      'reinforce:variableExit',
      'reinforce:replTable',
      'reinforce:frontalReserves',
      'reinforce:endRoll',
    ])
  })

  it('掷骰宿主：手牌非空时在结束本段之前插「待放上手牌」', () => {
    expect(
      idsOf(
        baseFacts({
          stepId: 'reinforcement.replRoll',
          replTablePending: true,
          supplyPlacePending: true,
          handPending: true,
        }),
      ),
    ).toEqual(['reinforce:replTable', 'reinforce:hand', 'reinforce:endRoll'])
  })

  it('重建环节：只问「是否结束本段」（不夹带补员表/到达/大窗）', () => {
    expect(
      idsOf(
        baseFacts({
          stepId: 'reinforcement.rebuild',
          arrivalPending: true,
          replTablePending: true,
          supplyPlacePending: true,
          rebuildAvailable: true,
          consolidationAvailable: true,
        }),
      ),
    ).toEqual(['reinforce:endRebuild'])
  })

  it('轴方专规：随机事件 / 补给列车 / 可变撤离都在掷骰宿主内按序出现', () => {
    expect(
      idsOf(
        baseFacts({
          stepId: 'reinforcement.replRoll',
          randomEventPending: true,
          supplyTrainPending: true,
          variableExitPending: true,
          arrivalPending: true,
          replTablePending: false,
        }),
      ),
    ).toEqual([
      'reinforce:randomEvent',
      'reinforce:supplyTrain',
      'reinforce:variableExit',
      'reinforce:endRoll',
    ])
  })

  it('苏方专规：判定并入「掷骰检定」，与方面军预备队按序出现', () => {
    expect(
      idsOf(
        baseFacts({
          stepId: 'reinforcement.replRoll',
          specialReplPending: true,
          replTablePending: true,
          frontalReservesPending: true,
          arrivalPending: true,
        }),
      ),
    ).toEqual(['reinforce:replTable', 'reinforce:frontalReserves', 'reinforce:endRoll'])
  })
})

describe('增援段：一次只暴露第一件', () => {
  it('暴露的恒是第一项；前一件 ack 后才轮到下一件', () => {
    const before = baseFacts({
      stepId: 'reinforcement.rebuild',
      rebuildAvailable: true,
      consolidationAvailable: true,
    })
    expect(exposedSessionStep(planSessionSteps(before))?.id).toBe('reinforce:endRebuild')

    const after = baseFacts({
      stepId: 'reinforcement.rebuild',
      rebuildAvailable: true,
      consolidationAvailable: true,
      acked: ['reinforce:endRebuild'],
    })
    expect(exposedSessionStep(planSessionSteps(after))).toBe(null)
  })

  it('强制项不受 ack 影响：到达没放完，记了 ack 也仍停在到达窗', () => {
    const items = planSessionSteps(
      baseFacts({ arrivalPending: true, replTablePending: true, acked: ['reinforce:arrival'] }),
    )
    expect(exposedSessionStep(items)?.id).toBe('reinforce:arrival')
  })
})

describe('增援段：未办完不能下一步（store 拒绝推进）', () => {
  it('1.6c 可掷而未掷时，acknowledge 返回 false（掷表不是「领取」）', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    store.setPhase('reinforcement')
    expect(store.hasSpecialReplDraw(store.activeSide, store.turn)).toBe(false)
    expect(store.acknowledgeReinforcementStepNow('reinforce:specialRepl')).toBe(false)
  })

  it('第二段未掷可变增援时，结束本段返回 false', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    store.setPhase('reinforcement')
    expect(store.variableReplRolled).toBe(false)
    expect(store.endRollSegmentNow(false)).toBe(false)
  })
})

/** 六邻皆图内的格（与 3.3d 既有用例同法；合并要求同格） */
const CORE_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

describe('增援段：整编窗尊重 3.3d', () => {
  /** 走到 B 段里允许 `rein.rebuild` 的环节（不手写序号） */
  function armRebuildStep(store: ReturnType<typeof useWorkbenchStore>): void {
    store.setPhase('reinforcement')
    const allowed = actionGateOf('rein.rebuild')
      .where.filter((item) => item.phase === store.phase)
      .map((item) => item.segment)
    const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
    if (index < 0) throw new Error('B 段没有允许 rein.rebuild 的环节')
    expect(store.setSegmentStepIndex(index)).toBe(true)
  }

  function twoStepRecord(side: 'axis' | 'soviet') {
    const found =
      side === 'axis'
        ? unitChoices('axis').find((record) => /Inf Div/i.test(record.vassalName ?? ''))
        : unitChoices('soviet').find((record) => /Tk Div|Rifle Div/i.test(record.vassalName ?? ''))
    if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
    return found
  }

  it('轴方多单位编队同堆叠 ⇒ 不出现整编窗', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    armRebuildStep(store)
    const record = twoStepRecord('axis')
    const keep = toConsoleUnit({ record, instanceId: 'k1', hex: CORE_HEX, side: 'axis' })
    const remove = toConsoleUnit({ record, instanceId: 'r1', hex: CORE_HEX, side: 'axis' })
    keep.formation = 'Pz-Gr Div'
    remove.formation = 'Pz-Gr Div'
    store.units.push(keep, remove)
    expect(store.consolidationAvailable).toBe(false)
  })

  it('同一形状换苏方 ⇒ 整编窗出现', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    store.setActiveSide('soviet')
    armRebuildStep(store)
    const record = twoStepRecord('soviet')
    const keep = toConsoleUnit({ record, instanceId: 'k2', hex: CORE_HEX, side: 'soviet' })
    const remove = toConsoleUnit({ record, instanceId: 'r2', hex: CORE_HEX, side: 'soviet' })
    store.units.push(keep, remove)
    expect(store.consolidationAvailable).toBe(true)
  })
})

describe('增援面板：只用新窗口 id', () => {
  it('面板不残留旧 id，且每个 item 都在新清单内', () => {
    const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    for (const dead of [
      'reinforce:replRoll',
      'reinforce:replPlace',
      'reinforce:freeRail',
      'reinforce:breakdown',
    ]) {
      expect(panel).not.toContain(dead)
    }
    const allowed = new Set([
      'reinforce:randomEvent',
      'reinforce:supplyTrain',
      'reinforce:arrival',
      'reinforce:variableExit',
      'reinforce:frontalReserves',
      'reinforce:slow',
      'reinforce:replTable',
      'reinforce:specialRepl',
      'reinforce:supplyTable',
      'reinforce:endRebuild',
      'reinforce:hand',
      'reinforce:endRoll',
    ])
    const ids = [...panel.matchAll(/item="(reinforce:[^"]+)"/gu)].map((match) => match[1]!)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(allowed.has(id), `${id} 不在新清单`).toBe(true)
  })
})
