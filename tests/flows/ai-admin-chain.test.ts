import { describe, expect, it } from 'vitest'

import { runAiStep, createAiMemory } from '@/ai/driver'
import { decideAiAction, type AiSnapshot } from '@/ai/policy'

import { fresh } from './flow-harness'

/**
 * 批 1：AI 行政链（初设 / A 整备 / B 到货、到货 SP、补给列车、重建整编）
 *
 * 这些分支此前从未被 `decideAiAction` 返回过：双 AI 对打里 B 段只能靠「放弃手牌」过关，
 * A 段整备与初设抽签则由测试代码替 AI 做。本文件把「谁来做、按什么顺序做」钉住：
 *   · 纯决策用例逐条断言候选与顺序（不碰 store）；
 *   · 一个 flow 用例证明 AI 能自己从 `enterSetup('1')` 走到开局（含 ch10 抽签）。
 */

function snap(over: Partial<AiSnapshot> = {}): AiSnapshot {
  return {
    turn: 1,
    // 完整档（Intro）：这些用例钉的是行政链的原有顺序，基线档另有简化用例
    scenarioId: 'Intro',
    phase: 'reinforcement',
    segment: 'reinforcement.arrival',
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
      interceptAnswer: true,
      setup: true,
    },
    setupInProgress: false,
    locked: false,
    can: new Set(['rein.arrival']),
    advanceAvailable: true,
    specialPending: false,
    reserveUnitIds: [],
    reserveTriedUnitIds: [],
    reserveOnHedgehogIds: [],
    reserveReleasedUnitIds: [],
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
      inMovementPhase: false,
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
      requirement: null,
      retreatPlans: [],
      triedDefenderHexes: [],
    },
    supply: { planLoaded: false, recoverySettled: false, feedingSettled: false, duties: [] },
    ...over,
  }
}

describe('批 1 AI 行政链：纯决策', () => {
  it('初设：分方游标 → 预设；缺西移落点 → 补落点；抽签可见 → 抽签；否则确认开局', () => {
    const base = { setup: { ...snap().setup, active: true }, can: new Set<string>() }
    expect(decideAiAction(snap({ ...base, setup: { ...base.setup, cursorActive: true } }))).toEqual(
      { kind: 'setupPreset' },
    )
    expect(
      decideAiAction(snap({ ...base, setup: { ...base.setup, cursorActive: false } })),
    ).toEqual({ kind: 'setupConfirm' })
    expect(
      decideAiAction(
        snap({
          ...base,
          setup: { ...base.setup, shiftFormationIds: ['4 Pz Div'] },
        }),
      ),
    ).toEqual({ kind: 'setupShiftPlace', formationId: '4 Pz Div' })
    expect(decideAiAction(snap({ ...base, setup: { ...base.setup, drawVisible: true } }))).toEqual({
      kind: 'setupDraw',
    })
  })

  it('A 整备：闸门放行且有基地候选时选第一个基地', () => {
    const action = decideAiAction(
      snap({
        phase: 'aircraftRefit',
        segment: 'aircraftRefit.refit',
        can: new Set(['air.refit']),
        refit: {
          bases: [{ baseId: 'b1', hex: { col: 12, row: 30 }, aircraftIds: ['a1'], dumpId: 'd1' }],
        },
      }),
    )
    expect(action).toEqual({
      kind: 'refitBase',
      baseId: 'b1',
      aircraftIds: ['a1'],
      dumpId: 'd1',
    })
  })

  it('B 到货：先执行 1.6a 移除，再按候选落位；无候选且可进盒 → 落盒；两处都无 → 跳过', () => {
    expect(
      decideAiAction(
        snap({ rein: { ...snap().rein, arrival: { removalsPending: true, entries: [] } } }),
      ),
    ).toEqual({ kind: 'arrivalRemovals' })
    expect(
      decideAiAction(
        snap({
          rein: {
            ...snap().rein,
            arrival: {
              removalsPending: false,
              entries: [{ index: 2, hex: { col: 9, row: 8 }, airBox: false }],
            },
          },
        }),
      ),
    ).toEqual({ kind: 'arrivalPlace', index: 2, hex: { col: 9, row: 8 } })
    expect(
      decideAiAction(
        snap({
          rein: {
            ...snap().rein,
            arrival: { removalsPending: false, entries: [{ index: 3, hex: null, airBox: true }] },
          },
        }),
      ),
    ).toEqual({ kind: 'arrivalPlace', index: 3, hex: null })
    expect(
      decideAiAction(
        snap({
          rein: {
            ...snap().rein,
            arrival: { removalsPending: false, entries: [{ index: 4, hex: null, airBox: false }] },
          },
        }),
      ),
    ).toEqual({ kind: 'arrivalSkip', index: 4 })
  })

  it('B 到货 SP：先勾免费铁运城市格（每格 1 点），再落账', () => {
    const supply = {
      ...snap().rein.supply,
      sp: 5,
      cityCandidates: [
        { col: 11, row: 30 },
        { col: 12, row: 30 },
      ],
      picked: [],
      planReady: false,
    }
    expect(
      decideAiAction(
        snap({
          segment: 'reinforcement.replRoll',
          can: new Set(['rein.supplyArrival']),
          rein: { ...snap().rein, supply },
        }),
      ),
    ).toEqual({ kind: 'supplyArrivalPick', hex: { col: 11, row: 30 } })
    const picked = [
      { col: 11, row: 30 },
      { col: 12, row: 30 },
    ]
    expect(
      decideAiAction(
        snap({
          segment: 'reinforcement.replRoll',
          can: new Set(['rein.supplyArrival']),
          rein: { ...snap().rein, supply: { ...supply, picked, planReady: true } },
        }),
      ),
    ).toEqual({ kind: 'supplyArrivals' })
  })

  it('B 到货 SP（3.4b）：按均分给未定的格补默认归属，奇数点归 Guderian', () => {
    const supply = {
      ...snap().rein.supply,
      sp: 4,
      picked: [
        { col: 11, row: 30 },
        { col: 12, row: 30 },
        { col: 13, row: 30 },
      ],
      planReady: true,
      panzerGroupRulesOn: true,
      groupTargets: [
        { hexText: '11.30', sp: 1, group: null },
        { hexText: '12.30', sp: 1, group: null },
        { hexText: '13.30', sp: 1, group: null },
        { hexText: '1.1', sp: 1, group: null },
      ],
    }
    const action = decideAiAction(
      snap({
        segment: 'reinforcement.replRoll',
        can: new Set(['rein.supplyArrival']),
        rein: { ...snap().rein, supply },
      }),
    )
    expect(action).toEqual({ kind: 'supplyArrivalGroup', hexText: '11.30', group: 'guderian' })
  })

  it('B 补给列车：3.4b 未选归属先选，再落第一处可卸货格', () => {
    const supply = {
      ...snap().rein.supply,
      trainPending: true,
      trainGroupRequired: true,
      trainHexes: [{ col: 20, row: 10 }],
    }
    expect(
      decideAiAction(
        snap({
          segment: 'reinforcement.replRoll',
          can: new Set(['rein.supplyTrain']),
          rein: { ...snap().rein, supply },
        }),
      ),
    ).toEqual({ kind: 'supplyTrainGroup', group: 'guderian' })
    expect(
      decideAiAction(
        snap({
          segment: 'reinforcement.replRoll',
          can: new Set(['rein.supplyTrain']),
          rein: { ...snap().rein, supply: { ...supply, trainGroupRequired: false } },
        }),
      ),
    ).toEqual({ kind: 'supplyTrainPlace', hex: { col: 20, row: 10 } })
  })

  it('B 重建 / 整编：候选优先重建，无重建时做一对整编', () => {
    const rebuildBase = {
      segment: 'reinforcement.rebuild',
      can: new Set(['rein.rebuild']),
    }
    expect(
      decideAiAction(
        snap({
          ...rebuildBase,
          rein: {
            ...snap().rein,
            rebuild: { unitId: 'u1', kind: 'dead', hex: { col: 7, row: 7 }, consolidate: null },
          },
        }),
      ),
    ).toEqual({ kind: 'rebuild', unitId: 'u1', mode: 'dead', hex: { col: 7, row: 7 } })
    expect(
      decideAiAction(
        snap({
          ...rebuildBase,
          rein: {
            ...snap().rein,
            rebuild: {
              unitId: 'u2',
              kind: 'onMap',
              hex: null,
              consolidate: { keepId: 'u2', removeId: 'u3' },
            },
          },
        }),
      ),
    ).toEqual({ kind: 'consolidate', keepId: 'u2', removeId: 'u3' })
  })

  it('玩家控制当前行动方时，行政动作一律让给玩家（wait）', () => {
    const action = decideAiAction(
      snap({
        control: { ...snap().control, activeSide: false },
        rein: {
          ...snap().rein,
          arrival: {
            removalsPending: false,
            entries: [{ index: 0, hex: { col: 1, row: 1 }, airBox: false }],
          },
        },
      }),
    )
    expect(action.kind).toBe('wait')
  })
})

describe('批 1：AI 自己完成初设（含 ch10 抽签）并开局', () => {
  it('剧本 1：从 enterSetup 出发，AI 预设 → 确认 → 抽签 → 开局，无需测试代劳', () => {
    const ctx = fresh()
    ctx.w.seed = 20261115
    expect(ctx.setup.enterSetup('1')).toBe(true)
    const memory = createAiMemory()
    const intents: string[] = []
    for (let n = 0; n < 200 && ctx.g.session === null; n += 1) {
      const result = runAiStep({ workbench: ctx.w, session: ctx.g, setup: ctx.setup }, { memory })
      intents.push(result.intent)
      if (result.intent === 'wait') break
    }
    expect(intents).not.toContain('wait')
    expect(ctx.g.session, `未能开局；决策：${intents.join(' → ')}`).not.toBeNull()
    expect(ctx.setup.setupEffectsExecuted).toBe(true)
    expect(ctx.w.initialSetupInProgress).toBe(false)
    // ch10 抽签真的落盘（不是被跳过）
    expect(ctx.w.log.some((entry) => entry.rule === 'ch10')).toBe(true)
  })
})
