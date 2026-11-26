import { describe, expect, it } from 'vitest'

import { createAiMemory, runAiStep, snapshotOf } from '@/ai/driver'
import { decideAiAction, type AiSnapshot } from '@/ai/policy'
import { candidateActionsOf } from '@/ai/training/candidates'
import { createTrainingIdentity } from '@/ai/training/identity'
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
    // 默认按完整档（Intro）跑：这些用例钉的是原动作链，基线档行为另有一组用例
    scenarioId: 'Intro',
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
    rebuildHqHexes: [],
    control: {
      activeSide: true,
      responder: true,
      attacker: true,
      defender: true,
      requirement: true,
      retreat: true,
      interceptAnswer: true,
      setup: true,
    },
    setupInProgress: false,
    locked: false,
    can: new Set(['move.order']),
    advanceAvailable: true,
    specialPending: false,
    reserveUnitIds: [],
    reserveTriedUnitIds: [],
    reserveOnHedgehogIds: [],
    reserveReleasedUnitIds: [],
    fuel: { unfuelledUnitIds: [], triedUnitIds: [] },
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
      dumpBlow: null,
    },
    air: {
      inProgress: false,
      flownThisPhase: false,
      inMovementPhase: true,
      weatherNormal: true,
      target: null,
      aircraftId: null,
      missionSide: null,
      driveable: true,
    },
    airInterception: null,
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
      attackerSupplyConfirmed: false,
      defenderSupplyConfirmed: false,
      attackerStocksApplicable: false,
      defenderStocksApplicable: false,
      requirement: null,
      optionLadder: [],
      optionCapacity: 0,
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
  /*
   * 这一组用例钉的是**完整档**的动作接线（与剧本数据无关）⇒ 用 context 覆盖走 Intro 档；
   * 非 Intro 的简化档在下面「基线档」用例里单独钉。
   */
  return {
    workbench: w,
    session: useGameSessionStore(),
    setup: useSetupStore(),
    scenarioId: 'Intro',
  }
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
          missionSide: null,
          driveable: true,
        },
      }),
    )
    expect(action).toEqual({ kind: 'airMission', target, aircraftId: 'ac1' })
  })
})

describe('9.12 / 9.10：AI 的撤退落点与选项（2026-11-23 优化）', () => {
  const combatStep = (over: Partial<AiSnapshot['combat']>) =>
    snap({
      phase: 'combat',
      segment: 'combat.resolve',
      combat: { ...snap().combat, state: { step: 'retreat', finished: false }, ...over },
    })

  const plan = (over: Partial<AiSnapshot['combat']['retreatPlans'][number]>) => ({
    unitId: 'd1',
    role: 'defender' as const,
    chosen: null,
    destinations: [],
    ...over,
  })

  it('同档落点里选「离最近敌军最远」的那一格（不再由格号决定）', () => {
    const action = decideAiAction(
      combatStep({
        defenderHex: { col: 5, row: 5 },
        // 敌军在 5.5 的邻格（守方撤退时的「敌军」＝攻方所在邻格）
        adjacentDefenderHexes: [{ col: 5, row: 4 }],
        retreatPlans: [
          plan({
            destinations: [
              // 两格都安全、都不在敌军 ZOC：一个贴着敌军（4.4），一个离得远（9.9）
              {
                hex: { col: 4, row: 4 },
                forcedDestruction: false,
                inEnemyZoc: false,
                path: [{ col: 4, row: 4 }],
              },
              {
                hex: { col: 9, row: 9 },
                forcedDestruction: false,
                inEnemyZoc: false,
                path: [{ col: 9, row: 9 }],
              },
            ],
          }),
        ],
      }),
    )
    expect(action).toEqual({
      kind: 'combatRetreatPaths',
      paths: [{ unitId: 'd1', path: [{ col: 9, row: 9 }] }],
    })
  })

  it('9.10：所有落点都会被消灭 ⇒ 不再白送，改写为选项损失', () => {
    const action = decideAiAction(
      snap({
        phase: 'combat',
        segment: 'combat.resolve',
        combat: {
          ...snap().combat,
          state: { step: 'options', finished: false },
          requirement: { side: 'defender', losses: 0, options: 1 },
          optionCapacity: 1,
          optionLadder: [
            {
              distance: 1,
              units: [{ unitId: 'd1', landing: 'doomed' }],
              allSafe: false,
              allHaveLanding: true,
            },
          ],
          retreatPlans: [
            plan({
              destinations: [
                {
                  hex: { col: 6, row: 6 },
                  forcedDestruction: true,
                  inEnemyZoc: true,
                  path: [{ col: 6, row: 6 }],
                },
              ],
            }),
          ],
        },
      }),
    )
    expect(action).toEqual({
      kind: 'combatOptions',
      retreatHexes: 0,
      lossPoints: 1,
      ignoreOptions: false,
    })
  })

  it('9.10：存在不会被消灭的落点 ⇒ 仍然选撤退（0 损失）', () => {
    const action = decideAiAction(
      snap({
        phase: 'combat',
        segment: 'combat.resolve',
        combat: {
          ...snap().combat,
          state: { step: 'options', finished: false },
          requirement: { side: 'defender', losses: 0, options: 1 },
          optionCapacity: 1,
          optionLadder: [
            {
              distance: 1,
              units: [{ unitId: 'd1', landing: 'safe' }],
              allSafe: true,
              allHaveLanding: true,
            },
          ],
          retreatPlans: [
            plan({
              destinations: [
                {
                  hex: { col: 6, row: 6 },
                  forcedDestruction: false,
                  inEnemyZoc: false,
                  path: [{ col: 6, row: 6 }],
                },
              ],
            }),
          ],
        },
      }),
    )
    expect(action).toEqual({
      kind: 'combatOptions',
      retreatHexes: 1,
      lossPoints: 0,
      ignoreOptions: false,
    })
  })

  /*
   * 用户 2026-11-23：「教学剧本苏军撤退方向优先守城」。
   * Intro 的城＝19.27 / 19.28（剧本卡：轴方夺取两格⇒大胜）⇒ 守方撤退即使离敌军更近，
   * 也先靠城；非 Intro 剧本没有 anchor，行为回到「离敌军最远」。
   */
  it('Intro：守方撤退先靠维捷布斯克（19.27/19.28），而不是一味远离敌军', () => {
    const action = decideAiAction(
      snap({
        scenarioId: 'Intro',
        phase: 'combat',
        segment: 'combat.resolve',
        combat: {
          ...snap().combat,
          state: { step: 'retreat', finished: false },
          defenderHex: { col: 18, row: 27 },
          adjacentDefenderHexes: [{ col: 18, row: 26 }],
          retreatPlans: [
            plan({
              destinations: [
                // 远离敌军（南边），但离城 4 格
                {
                  hex: { col: 18, row: 31 },
                  forcedDestruction: false,
                  inEnemyZoc: false,
                  path: [{ col: 18, row: 31 }],
                },
                // 紧贴敌军邻格，但就在维捷布斯克城边（19.27 的邻格）
                {
                  hex: { col: 19, row: 26 },
                  forcedDestruction: false,
                  inEnemyZoc: false,
                  path: [{ col: 19, row: 26 }],
                },
              ],
            }),
          ],
        },
      }),
    )
    expect(action).toEqual({
      kind: 'combatRetreatPaths',
      paths: [{ unitId: 'd1', path: [{ col: 19, row: 26 }] }],
    })
  })

  it('非 Intro 剧本不带守城偏好：仍按「离敌军最远」选点', () => {
    const action = decideAiAction(
      snap({
        scenarioId: 'Smolensk',
        phase: 'combat',
        segment: 'combat.resolve',
        combat: {
          ...snap().combat,
          state: { step: 'retreat', finished: false },
          defenderHex: { col: 18, row: 27 },
          adjacentDefenderHexes: [{ col: 18, row: 26 }],
          retreatPlans: [
            plan({
              destinations: [
                {
                  hex: { col: 18, row: 31 },
                  forcedDestruction: false,
                  inEnemyZoc: false,
                  path: [{ col: 18, row: 31 }],
                },
                {
                  hex: { col: 19, row: 26 },
                  forcedDestruction: false,
                  inEnemyZoc: false,
                  path: [{ col: 19, row: 26 }],
                },
              ],
            }),
          ],
        },
      }),
    )
    expect(action).toEqual({
      kind: 'combatRetreatPaths',
      paths: [{ unitId: 'd1', path: [{ col: 18, row: 31 }] }],
    })
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

  it('12.11a：快照与候选表给 dumpBlow，驱动落到 destructDumpNow', () => {
    const w = newConsole()
    w.spDumps.push({ id: 'sd1', hex: { ...CORE_HEX }, side: 'axis', sp: 2, t: 0 })
    atMovementStep(w)

    const ctx = aiCtx(w)
    const memory = createAiMemory()
    const snap = snapshotOf(ctx, memory, 'both')
    expect(snap.branch.dumpBlow).toEqual({ dumpId: 'sd1' })
    const candidates = candidateActionsOf(snap, createTrainingIdentity(ctx))
    expect(candidates.some((candidate) => candidate.action.kind === 'dumpBlow')).toBe(true)

    const result = runAiStep(ctx, {
      memory,
      decider: () => ({ kind: 'dumpBlow', dumpId: 'sd1' }),
    })
    expect(result.intent).toBe('dumpBlow:sd1')
    expect(result.ok, JSON.stringify({ log: w.log[0] })).toBe(true)
    expect(w.dumpDestructionAttempts.sd1).toBe(1)
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

/*
 * 用户 2026-11-23：「先简化一下别的剧本AI逻辑，现在那些AI根本不堪使用，还卡」
 * ⇒ 非 Intro 剧本走 `baseline` 档：只做机械动作（作答/结算/补给损耗/初设/推进），
 *   不再自己发起移动、突袭、铁路、建造、空袭、弹幕、重建。
 */
describe('简化档（非 Intro）：只做机械动作，不主动打仗', () => {
  it('不再自己铺建造标记：动作降级为「推进环节」', () => {
    const action = decideAiAction(
      snap({
        scenarioId: 'Smolensk',
        can: new Set(['move.construction', 'move.order']),
        branch: branch({ constructionMarker: { marker: 'bridge', hex: { col: 9, row: 9 } } }),
      }),
    )
    expect(action).toEqual({ kind: 'advance' })
  })

  it('已在移动中 ⇒ 只收束本次移动（不突袭、不走格）', () => {
    const action = decideAiAction(
      snap({
        scenarioId: 'Smolensk',
        can: new Set(['move.order']),
        move: { ...snap().move, active: true, hasStepped: false, selectedIds: ['a1'] },
        branch: branch({ overrunTargets: [{ col: 3, row: 3 }] }),
      }),
    )
    expect(action).toEqual({ kind: 'moveFinish' })
  })

  it('不自己发起空军任务（有目标也不飞）', () => {
    const action = decideAiAction(
      snap({
        scenarioId: 'Smolensk',
        can: new Set(['air.mission', 'move.order']),
        air: {
          inProgress: false,
          flownThisPhase: false,
          inMovementPhase: true,
          weatherNormal: true,
          target: { col: 3, row: 2 },
          aircraftId: 'ac1',
          missionSide: null,
          driveable: true,
        },
      }),
    )
    expect(action).toEqual({ kind: 'advance' })
  })

  it('战斗结算仍然做：守方撤退照旧按落点排序提交', () => {
    const action = decideAiAction(
      snap({
        scenarioId: 'Smolensk',
        phase: 'combat',
        segment: 'combat.resolve',
        combat: {
          ...snap().combat,
          state: { step: 'retreat', finished: false },
          defenderHex: { col: 18, row: 27 },
          adjacentDefenderHexes: [{ col: 18, row: 26 }],
          retreatPlans: [
            {
              unitId: 'd1',
              role: 'defender',
              chosen: null,
              destinations: [
                {
                  hex: { col: 18, row: 31 },
                  forcedDestruction: false,
                  inEnemyZoc: false,
                  path: [{ col: 18, row: 31 }],
                },
              ],
            },
          ],
        },
      }),
    )
    expect(action).toEqual({
      kind: 'combatRetreatPaths',
      paths: [{ unitId: 'd1', path: [{ col: 18, row: 31 }] }],
    })
  })
})
