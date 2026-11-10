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
      variableExitPending: false,
      replTablePending: true,
      specialReplPending: false,
      supplyPlacePending: false,
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

describe('增援段：按规则顺序单窗排列', () => {
  it('苏方 22 Jul：到达 → 方面军 → 慢动员 → 补员表 → 特殊补员 → 补给表 → 重建 → 整编', () => {
    expect(
      idsOf(
        baseFacts({
          arrivalPending: true,
          frontalReservesPending: true,
          slowMobilizationVisible: true,
          replTablePending: true,
          specialReplPending: true,
          supplyPlacePending: true,
          rebuildAvailable: true,
          consolidationAvailable: true,
        }),
      ),
    ).toEqual([
      'reinforce:arrival',
      'reinforce:frontalReserves',
      'reinforce:slow',
      'reinforce:replTable',
      'reinforce:specialRepl',
      'reinforce:supplyTable',
      'reinforce:rebuild',
      'reinforce:consolidation',
    ])
  })

  it('轴方 22 Jul：随机事件 → 到达 → 补员表 → 特殊补员 → 补给表 → 重建 → 整编', () => {
    expect(
      idsOf(
        baseFacts({
          randomEventPending: true,
          arrivalPending: true,
          replTablePending: true,
          specialReplPending: true,
          supplyPlacePending: true,
          rebuildAvailable: true,
          consolidationAvailable: true,
        }),
      ),
    ).toEqual([
      'reinforce:randomEvent',
      'reinforce:arrival',
      'reinforce:replTable',
      'reinforce:specialRepl',
      'reinforce:supplyTable',
      'reinforce:rebuild',
      'reinforce:consolidation',
    ])
  })

  it('轴方 19 Aug：到达 → 可变撤离 → 补员表 → 补给表 → …；无随机事件、无特殊补员', () => {
    expect(
      idsOf(
        baseFacts({
          variableExitPending: true,
          arrivalPending: true,
          replTablePending: true,
          specialReplPending: false,
          supplyPlacePending: true,
          rebuildAvailable: true,
          consolidationAvailable: true,
        }),
      ),
    ).toEqual([
      'reinforce:arrival',
      'reinforce:variableExit',
      'reinforce:replTable',
      'reinforce:supplyTable',
      'reinforce:rebuild',
      'reinforce:consolidation',
    ])
  })
})

describe('增援段：一次只暴露第一件', () => {
  it('暴露的恒是第一项；前一件 ack 后才轮到下一件', () => {
    const before = baseFacts({ slowMobilizationVisible: true, replTablePending: true })
    expect(exposedSessionStep(planSessionSteps(before))?.id).toBe('reinforce:slow')

    const after = baseFacts({
      slowMobilizationVisible: true,
      replTablePending: true,
      acked: ['reinforce:slow'],
    })
    expect(exposedSessionStep(planSessionSteps(after))?.id).toBe('reinforce:replTable')
  })

  it('强制项不受 ack 影响：到达没放完，记了 ack 也仍停在到达窗', () => {
    const items = planSessionSteps(
      baseFacts({ arrivalPending: true, replTablePending: true, acked: ['reinforce:arrival'] }),
    )
    expect(exposedSessionStep(items)?.id).toBe('reinforce:arrival')
  })
})

describe('增援段：未办完不能下一步（store 拒绝推进）', () => {
  it('补员表未掷、补给 SP 未落账时，acknowledge 返回 false', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    store.setPhase('reinforcement')
    expect(store.variableReplRolled).toBe(false)
    expect(store.acknowledgeReinforcementStepNow('reinforce:replTable')).toBe(false)
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
      'reinforce:arrival',
      'reinforce:variableExit',
      'reinforce:frontalReserves',
      'reinforce:slow',
      'reinforce:replTable',
      'reinforce:specialRepl',
      'reinforce:supplyTable',
      'reinforce:rebuild',
      'reinforce:consolidation',
    ])
    const ids = [...panel.matchAll(/item="(reinforce:[^"]+)"/gu)].map((match) => match[1]!)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(allowed.has(id), `${id} 不在新清单`).toBe(true)
  })
})
