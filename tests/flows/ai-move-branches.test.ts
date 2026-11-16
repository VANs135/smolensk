import { describe, expect, it } from 'vitest'

import { createAiMemory, runAiStep } from '@/ai/driver'
import { decideAiAction, type AiSnapshot } from '@/ai/policy'
import { useGameSessionStore, useSetupStore } from '@/stores'

import { CORE_HEX, NEAR_HEX, groundRecord, newConsole, placeGround } from './sop-harness'

/**
 * 批 2：AI 的 **C 段支线**（换模式 / 突袭 / 铁路 / 装卸 / 建造标记 / 换轨）
 *
 * 这些入口此前从没被 `decideAiAction` 返回过：AI 在移动段只会「逐格走」，
 * 突袭要靠地图层分派、铁路/装卸/换轨/建造标记根本没有分支。
 * 本文件先钉「谁来做、按什么顺序做」：
 *   · 纯决策用例逐条断言快照候选 → 动作；
 *   · flow 用例用真实 store 证明驱动能把动作落到既有提交入口。
 */

function snap(over: Partial<AiSnapshot> = {}): AiSnapshot {
  return {
    turn: 1,
    phase: 'movement',
    segment: 'movement.modeAndMovement',
    segmentStepIndex: 0,
    activeSide: 'axis',
    defenderSide: 'soviet',
    terminated: false,
    awaitingOptionIds: [],
    awaitingResponder: null,
    awaitingPrompt: '',
    setup: {
      active: false,
      cursorActive: false,
      remaining: 0,
      drawVisible: false,
      shiftFormationIds: [],
    },
    refit: { bases: [] },
    rein: {
      arrival: { removalsPending: false, entries: [] },
      supply: {
        sp: 0,
        picked: [],
        cityCandidates: [],
        edgeHex: null,
        planReady: false,
        panzerGroupRulesOn: false,
        groupTargets: [],
        trainPending: false,
        trainHexes: [],
        trainGroupRequired: false,
      },
      rebuild: null,
    },
    overstack: { active: false },
    setupRemaining: 0,
    control: {
      activeSide: true,
      responder: true,
      attacker: true,
      defender: true,
      requirement: true,
      retreat: true,
      setup: true,
    },
    setupInProgress: false,
    locked: false,
    can: new Set(['move.order']),
    advanceAvailable: true,
    specialPending: false,
    reserveUnitIds: [],
    reserveTriedUnitIds: [],
    move: {
      active: false,
      hasStepped: false,
      selectedIds: [],
      reachableHexes: [],
      triedUnits: [],
      triedTargets: [],
      candidates: [],
      enemyHexes: [],
    },
    branch: {
      modeSwitch: null,
      overrunTargets: [],
      railUnit: null,
      railSp: null,
      transport: null,
      constructionMarker: null,
      gauge: null,
    },
    air: {
      inProgress: false,
      flownThisPhase: false,
      inMovementPhase: true,
      weatherNormal: true,
      target: null,
      aircraftId: null,
    },
    barrage: {
      state: null,
      choices: [],
      selectedUnitIds: [],
      targetHex: null,
      supplyDumpIds: [],
      triedTargets: [],
      enemyHexes: [],
      outcomeStepLosses: 0,
      lossTargets: [],
    },
    combat: {
      state: null,
      defenderHex: null,
      adjacentDefenderHexes: [],
      attackerDumpIds: [],
      defenderDumpIds: [],
      requirement: null,
      retreatPlans: [],
      triedDefenderHexes: [],
    },
    supply: { planLoaded: false, recoverySettled: false, feedingSettled: false, duties: [] },
    ...over,
  }
}

function branch(over: Partial<AiSnapshot['branch']>): AiSnapshot['branch'] {
  return { ...snap().branch, ...over }
}

function aiCtx(w: ReturnType<typeof newConsole>) {
  return { workbench: w, session: useGameSessionStore(), setup: useSetupStore() }
}

/** 把操作台停在 C 段的「模式与移动」环节（移动支线都在这一环） */
function atMovementStep(w: ReturnType<typeof newConsole>): void {
  w.setPhase('movement')
  const index = w.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  expect(index).toBeGreaterThanOrEqual(0)
  w.setSegmentStepIndex(index)
  expect(w.segmentStep?.id).toBe('movement.modeAndMovement')
}

const legCombat = () =>
  groundRecord(
    'axis',
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )

describe('批 2 AI C 段支线：纯决策', () => {
  it('专规 3.5：有建造标记候选时先放标记（须在任何单位移动之前）', () => {
    const hex = { col: 9, row: 9 }
    const action = decideAiAction(
      snap({
        can: new Set(['move.construction', 'move.order']),
        branch: branch({ constructionMarker: { marker: 'bridge', hex } }),
      }),
    )
    expect(action).toEqual({ kind: 'constructionMarker', marker: 'bridge', hex })
  })

  it('5.4：换模式候选优先于铁路与逐格移动', () => {
    const action = decideAiAction(
      snap({
        can: new Set(['move.modeChange', 'move.railTransport', 'move.order']),
        branch: branch({
          modeSwitch: { unitId: 'u1', mode: 'move' },
          railUnit: { unitId: 'u2', toHex: { col: 3, row: 4 } },
        }),
      }),
    )
    expect(action).toEqual({ kind: 'modeChangeTo', unitId: 'u1', mode: 'move' })
  })

  it('13.3e：单位铁路运输走 `railMove`，SP 货运走 `railMoveSp`', () => {
    const unitAction = decideAiAction(
      snap({
        can: new Set(['move.railTransport']),
        branch: branch({ railUnit: { unitId: 'u1', toHex: { col: 12, row: 30 } } }),
      }),
    )
    expect(unitAction).toEqual({ kind: 'railMove', unitId: 'u1', toHex: { col: 12, row: 30 } })

    const spAction = decideAiAction(
      snap({
        can: new Set(['move.railTransport']),
        branch: branch({ railSp: { dumpId: 'd1', amount: 1, toHex: { col: 7, row: 8 } } }),
      }),
    )
    expect(spAction).toEqual({
      kind: 'railMoveSp',
      dumpId: 'd1',
      amount: 1,
      toHex: { col: 7, row: 8 },
    })
  })

  it('13.2f：装卸按候选的 load / unload 分派', () => {
    expect(
      decideAiAction(
        snap({
          can: new Set(['move.loadUnload']),
          branch: branch({ transport: { pointId: 't1', mode: 'load', amount: 2 } }),
        }),
      ),
    ).toEqual({ kind: 'transportLoad', pointId: 't1', amount: 2 })
    expect(
      decideAiAction(
        snap({
          can: new Set(['move.loadUnload']),
          branch: branch({ transport: { pointId: 't2', mode: 'unload', amount: 1 } }),
        }),
      ),
    ).toEqual({ kind: 'transportUnload', pointId: 't2', amount: 1 })
  })

  it('8.0：移动中尚未落子时先突袭相邻敌格', () => {
    const action = decideAiAction(
      snap({
        can: new Set(['move.overrun', 'move.order']),
        move: {
          ...snap().move,
          active: true,
          hasStepped: false,
          selectedIds: ['u1'],
          reachableHexes: [{ col: 5, row: 5 }],
        },
        branch: branch({ overrunTargets: [{ col: 6, row: 5 }] }),
      }),
    )
    expect(action).toEqual({ kind: 'overrun', hex: { col: 6, row: 5 } })
  })

  it('13.3f：刚走入非本方轨距格时先换轨，再结束本次移动', () => {
    const action = decideAiAction(
      snap({
        can: new Set(['move.railConversion', 'move.order']),
        move: {
          ...snap().move,
          active: true,
          hasStepped: true,
          selectedIds: ['rr1'],
        },
        branch: branch({ gauge: { unitId: 'rr1', hex: { col: 8, row: 8 } } }),
      }),
    )
    expect(action).toEqual({ kind: 'gaugeConvert', unitId: 'rr1', hex: { col: 8, row: 8 } })
  })

  it('14.7d：低空扫射（C 段空军支线）仍排在移动支线之后正常触发', () => {
    const target = { col: 3, row: 2 }
    const action = decideAiAction(
      snap({
        can: new Set(['air.mission', 'move.order']),
        air: {
          inProgress: false,
          flownThisPhase: false,
          inMovementPhase: true,
          weatherNormal: true,
          target,
          aircraftId: 'ac1',
        },
      }),
    )
    expect(action).toEqual({ kind: 'airMission', target, aircraftId: 'ac1' })
  })
})

describe('批 2 AI C 段支线：落到既有入口', () => {
  it('专规 3.5：轴方移动开始时 AI 自己放下一枚建造标记', () => {
    const w = newConsole()
    w.setConstructionMarkersNow(1)
    placeGround(w, legCombat(), CORE_HEX, 'axis', 'a1')
    atMovementStep(w)

    const result = runAiStep(aiCtx(w), { memory: createAiMemory() })
    expect(result.intent).toMatch(/^constructionMarker/)
    expect(result.ok, JSON.stringify({ err: w.exclusiveError, log: w.log[0] })).toBe(true)
    expect(w.constructionMarkerPieces).toHaveLength(1)
    expect(w.constructionMarkers).toBe(0)
  })

  it('13.2f：AI 自己把同格补给站里的 SP 装上运输点数', () => {
    const w = newConsole()
    const point = placeGround(
      w,
      groundRecord('axis', (record) => record.noncombatKind === 'transport_point'),
      CORE_HEX,
      'axis',
      'tp1',
      'move',
    )
    w.spDumps.push({ id: 'sd1', hex: { ...CORE_HEX }, side: 'axis', sp: 2, t: 0 })
    atMovementStep(w)

    const result = runAiStep(aiCtx(w), { memory: createAiMemory() })
    expect(result.intent).toMatch(/^transportLoad/)
    expect(result.ok, JSON.stringify({ err: w.transportLoadError, log: w.log[0] })).toBe(true)
    expect(point.loadedSpT).toBeGreaterThan(0)
  })

  it('8.0：AI 在移动中自己发起突袭（不再依赖地图层分派）', () => {
    const w = newConsole()
    const unit = placeGround(w, legCombat(), CORE_HEX, 'axis', 'a1')
    placeGround(
      w,
      groundRecord('soviet', (record) => record.isCombat === true),
      NEAR_HEX,
      'soviet',
      'e1',
    )
    atMovementStep(w)

    w.selectedId = unit.instanceId
    expect(w.beginMoveFor([unit.instanceId])).toBe(true)
    expect(w.overrunTargets.length).toBeGreaterThan(0)

    const result = runAiStep(aiCtx(w), { memory: createAiMemory() })
    expect(result.intent).toMatch(/^overrun/)
    expect(result.ok, JSON.stringify({ err: w.combatError, log: w.log[0] })).toBe(true)
    expect(w.overrunContext).not.toBeNull()
    expect(w.combatState).not.toBeNull()
  })
})
