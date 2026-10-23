import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  OVERRUN_ATTACK_TYPE,
  OVERRUN_COST_MP,
  OVERRUN_SEGMENTS,
  applyOverrunMove,
  canEnterForCombat,
  canOverrun,
  overrunEligibility,
  planOverrunMove,
  resolveOverrunAftermath,
  splitOverrunStack,
  undoMoveStep,
  type MoveContext,
  type MoveInteractionState,
  type MoveUnitRuntime,
  type MoveUnitView,
  type MovementSegmentPhase,
} from '@/engine/rules'

/**
 * 突袭（B14，OCS 8.0 / 8.1）测试
 *
 * 断言到条文一级：8.0（移动环节 / 目标须有敌方战斗单位 / 从相邻格发起 / 必须进入 / 可续行）、
 * 8.1（阶段开始即同格、可攻击、战斗/移动/进击模式）、8.1a（3 MP、剩余不足 3 不可突袭、进格不额外扣费）、
 * 8.1b（进格 ≤3 MP、All 不可突袭）、8.1c（不得用道路降费）、8.1e（永不给进击标记）、
 * 8.1f（选项撤退即结束本阶段移动）、8.1g/8.1h（参突者与留驻者）。
 * 地形费率取自 charts-tec.json 真实值（Forest：步行 2 / 履带 3 / 轮式 4）。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
const normalized = (a: HexRef, b: HexRef): string => `${[key(a), key(b)].sort().join('|')}`

function makeMap(
  config: {
    terrains?: Record<string, readonly string[]>
    crossings?: Record<string, { river?: string | null; routes?: readonly string[] }>
  } = {},
) {
  return {
    onMap: () => true,
    terrainsAt: (hex: HexRef): readonly string[] => config.terrains?.[key(hex)] ?? ['Open'],
    crossingBetween: (a: HexRef, b: HexRef) => config.crossings?.[normalized(a, b)] ?? null,
  }
}

function unit(over: Partial<MoveUnitView> = {}): MoveUnitView {
  return {
    id: 'u1',
    side: 'axis',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: { col: 36, row: 13 },
    mobility: 'leg',
    ma: 6,
    re: 2,
    mode: 'combat',
    orientation: 'combat',
    dg: false,
    exploit: false,
    releasedFromReserve: false,
    fuelled: false,
    mpLockedThisPhase: false,
    ...over,
  }
}

function context(units: readonly MoveUnitView[], over: Partial<MoveContext> = {}): MoveContext {
  return { phase: 'movement', activeSide: 'axis', map: makeMap(), units, ...over }
}

const TARGET: HexRef = { col: 36, row: 14 }

/* ────────────────────────────── 8.0 触发条件 ────────────────────────────── */

describe('8.0 突袭：只发生在移动环节、只针对有敌方战斗单位的格', () => {
  it('8.0：三个移动环节可突袭，其他段不行', () => {
    expect(OVERRUN_SEGMENTS).toEqual(['movement', 'reaction', 'exploitation'])
    for (const phase of OVERRUN_SEGMENTS)
      expect(
        overrunEligibility({
          phase,
          // OVERRUN_SEGMENTS 的类型是 GamePhase[]，此处三个值都是移动环节，故收窄给 context
          context: context([unit()], { phase: phase as MovementSegmentPhase }),
          unitIds: ['u1'],
          target: TARGET,
          mpRemaining: 6,
          startedStackedTogether: true,
          defenders: [{ id: 'd1', isCombat: true }],
        }).ok,
      ).toBe(true)
    expect(
      overrunEligibility({
        phase: 'combat',
        context: context([unit()], { phase: 'movement' }),
        unitIds: ['u1'],
        target: TARGET,
        mpRemaining: 6,
        startedStackedTogether: true,
        defenders: [{ id: 'd1', isCombat: true }],
      }),
    ).toMatchObject({ ok: false, rule: '8.0', reason: 'notAMovementSegment:combat' })
  })

  it('8.0：目标格只有非战斗单位 ⇒ 不走突袭，改走 9.14 特殊战斗', () => {
    expect(
      overrunEligibility({
        phase: 'movement',
        context: context([unit()]),
        unitIds: ['u1'],
        target: TARGET,
        mpRemaining: 6,
        startedStackedTogether: true,
        defenders: [{ id: 'truck', isCombat: false }],
      }),
    ).toMatchObject({ ok: false, rule: '8.0', reason: 'noEnemyCombatUnit', useSpecialCombat: true })
  })

  it('8.1：阶段开始时未同格堆叠 ⇒ 不能突袭（委托 canOverrun）', () => {
    expect(
      overrunEligibility({
        phase: 'movement',
        context: context([unit()]),
        unitIds: ['u1'],
        target: TARGET,
        mpRemaining: 6,
        startedStackedTogether: false,
        defenders: [{ id: 'd1', isCombat: true }],
      }),
    ).toMatchObject({ ok: false, rule: '8.1' })
  })

  it('8.1a：剩余 MP 不足 3 不能突袭；足 3 则可（mpCost 固定 3）', () => {
    const base = {
      phase: 'movement' as const,
      context: context([unit()]),
      unitIds: ['u1'],
      target: TARGET,
      startedStackedTogether: true,
      defenders: [{ id: 'd1', isCombat: true }],
    }
    expect(overrunEligibility({ ...base, mpRemaining: 2 })).toMatchObject({
      ok: false,
      rule: '8.1a',
      reason: 'notEnoughMp',
    })
    const ok = overrunEligibility({ ...base, mpRemaining: 3 })
    expect(ok.ok && ok).toMatchObject({ mpCost: 3, entryCost: 1 })
  })
})

/* ────────────────────────────── 8.1b / 8.1c 地形门槛 ────────────────────────────── */

describe('8.1b / 8.1c 地形门槛：进格 ≤3 MP，且不得用道路降费', () => {
  const forestTarget = makeMap({ terrains: { '36.14': ['Forest'] } })

  it('8.1b：履带进 Forest 3 MP ⇒ 可突袭；轮式 4 MP ⇒ 不可', () => {
    const track = overrunEligibility({
      phase: 'movement',
      context: context([unit({ mobility: 'track', fuelled: true })], { map: forestTarget }),
      unitIds: ['u1'],
      target: TARGET,
      mpRemaining: 6,
      startedStackedTogether: true,
      defenders: [{ id: 'd1', isCombat: true }],
    })
    expect(track.ok && track.entryCost).toBe(3)

    const truck = overrunEligibility({
      phase: 'movement',
      context: context([unit({ mobility: 'truck', fuelled: true })], { map: forestTarget }),
      unitIds: ['u1'],
      target: TARGET,
      mpRemaining: 6,
      startedStackedTogether: true,
      defenders: [{ id: 'd1', isCombat: true }],
    })
    expect(truck).toMatchObject({ ok: false, rule: '8.1b', reason: 'prohibited' })
  })

  it('8.1c：同一格有二级道路也不能把进格 MP 压低（轮式仍按格内地形 4 MP 计 ⇒ 不可突袭）', () => {
    const roadForest = makeMap({
      terrains: { '36.14': ['Forest'] },
      crossings: { '36.13|36.14': { routes: ['Secondary Road'] } },
    })
    // 对照：常规移动可以沿路只花 0.5 MP（6.2a 道路优先）
    const plain = canOverrun({
      context: context([unit({ mobility: 'truck', fuelled: true })], { map: roadForest }),
      unitIds: ['u1'],
      target: TARGET,
      startedStackedTogether: true,
      mpRemaining: 6,
    })
    expect(plain).toMatchObject({ ok: false, rule: '8.1b' })
    // 8.1c：禁止用道路降费 ⇒ 突袭资格仍按 4 MP 判，不得突袭
    expect(
      overrunEligibility({
        phase: 'movement',
        context: context([unit({ mobility: 'truck', fuelled: true })], { map: roadForest }),
        unitIds: ['u1'],
        target: TARGET,
        mpRemaining: 6,
        startedStackedTogether: true,
        defenders: [{ id: 'd1', isCombat: true }],
      }),
    ).toMatchObject({ ok: false, rule: '8.1b' })
  })

  it('8.1b：地形写为「全部（All）」的格不能突袭', () => {
    // 步行过大河 = All
    const river = makeMap({ crossings: { '36.13|36.14': { river: 'Major River' } } })
    expect(
      overrunEligibility({
        phase: 'movement',
        context: context([unit({ mobility: 'leg' })], { map: river }),
        unitIds: ['u1'],
        target: TARGET,
        mpRemaining: 6,
        startedStackedTogether: true,
        defenders: [{ id: 'd1', isCombat: true }],
      }),
    ).toMatchObject({ ok: false, rule: '8.1b' })
  })
})

/* ────────────────────────────── 专规地形表与 9.1f：只能沿路进入的格 ────────────────────────────── */

describe('9.1f / 8.1c 专规地形表声明：履带轮式禁入但有路 ⇒ 可普通攻击、不可突袭', () => {
  /** 轮式/履带禁入的格（Swamp 对 truck 为 P）+ 该格边有二级道路 */
  const swampWithRoad = makeMap({
    terrains: { '36.14': ['Swamp'] },
    crossings: { '36.13|36.14': { routes: ['Secondary Road'] } },
  })
  const swampNoRoad = makeMap({ terrains: { '36.14': ['Swamp'] } })
  const step = (map: ReturnType<typeof makeMap>, followingRoad: boolean) =>
    canEnterForCombat({
      terrainsPresent: ['Swamp'],
      mobility: 'truck',
      crossing: map.crossingBetween({ col: 36, row: 13 }, TARGET),
      followingRoad,
    })

  it('有路时只能沿路进入 ⇒ via=roadOnly：普通攻击可以、突袭不可以（8.1c）', () => {
    const verdict = step(swampWithRoad, true)
    expect(verdict).toMatchObject({ ok: true, via: 'roadOnly' })
    expect(verdict.ok && verdict.detail).toContain('可普通攻击，不可突袭')

    // 突袭资格同判：借路也不放行（forOverrun 不计道路折扣）
    expect(
      overrunEligibility({
        phase: 'movement',
        context: context([unit({ mobility: 'truck', fuelled: true })], { map: swampWithRoad }),
        unitIds: ['u1'],
        target: TARGET,
        mpRemaining: 6,
        startedStackedTogether: true,
        defenders: [{ id: 'd1', isCombat: true }],
      }),
    ).toMatchObject({ ok: false, rule: '8.1b', reason: 'prohibited' })
  })

  it('无路时连进入都不行 ⇒ 两种攻击都不可以（9.1f 前段）', () => {
    expect(step(swampNoRoad, false)).toMatchObject({ ok: false, reason: 'prohibited' })
    expect(step(swampNoRoad, false).ok === false && step(swampNoRoad, false).detail).toContain(
      '不能进入的格也不得攻击（9.1f）',
    )
  })

  it('不借道路即可进入的格 ⇒ via=normal：普通攻击与突袭都可以', () => {
    const open = makeMap()
    const verdict = canEnterForCombat({
      terrainsPresent: ['Open'],
      mobility: 'leg',
      crossing: open.crossingBetween({ col: 36, row: 13 }, TARGET),
      followingRoad: false,
    })
    expect(verdict).toMatchObject({ ok: true, via: 'normal', terrain: 'Open', cost: 1 })
  })
})

/* ────────────────────────────── 8.0 / 8.1a/e/f 后果 ────────────────────────────── */

describe('8.0 / 8.1a / 8.1e / 8.1f 突袭后的移动与状态', () => {
  it('8.1a：每次突袭固定消耗 3 MP；4 MP 起突袭后剩 1 MP', () => {
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: 4,
      attackerRetreatedInOptions: false,
      defenderLeftHex: false,
    })
    expect(aftermath).toMatchObject({ mpSpent: 3, mpRemaining: 1, mayContinueMoving: false })
    expect(OVERRUN_COST_MP).toBe(3)
  })

  it('8.0：防御方撤退或被摧毁 ⇒ 所有攻击单位必须进入该格且不额外扣 MP', () => {
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: 6,
      attackerRetreatedInOptions: false,
      defenderLeftHex: true,
    })
    expect(aftermath).toMatchObject({
      mustEnterDefenderHex: true,
      mpRemaining: 3,
      mayContinueMoving: true,
      movementEndsThisPhase: false,
    })
    // 8.1a 规则书算例：进格 1 MP 的格突袭两次，累计 6 MP，并在第二次进入该格
    expect(overrunTwoTimes()).toEqual({ total: 6, enteredWithNoExtraCost: true })
  })

  it('8.1f：在一个或多个选项中撤退 ⇒ 其在当前阶段中的移动结束', () => {
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: 9,
      attackerRetreatedInOptions: true,
      defenderLeftHex: false,
    })
    expect(aftermath).toMatchObject({
      movementEndsThisPhase: true,
      mayContinueMoving: false,
      mustEnterDefenderHex: false,
      rule: '8.1f',
    })
  })

  it('8.0：未撤退且剩余 ≥3 MP ⇒ 可继续移动并再次突袭', () => {
    const continues = resolveOverrunAftermath({
      mpRemainingBefore: 6,
      attackerRetreatedInOptions: false,
      defenderLeftHex: false,
    })
    expect(continues).toMatchObject({ mayContinueMoving: true, mpRemaining: 3 })
    const stuck = resolveOverrunAftermath({
      mpRemainingBefore: 5,
      attackerRetreatedInOptions: false,
      defenderLeftHex: true,
    })
    expect(stuck).toMatchObject({ mayContinueMoving: false, mustEnterDefenderHex: true })
  })

  it('8.1e：突袭永不给予进击标记', () => {
    for (const input of [
      { mpRemainingBefore: 9, attackerRetreatedInOptions: false, defenderLeftHex: true },
      { mpRemainingBefore: 9, attackerRetreatedInOptions: true, defenderLeftHex: false },
    ])
      expect(resolveOverrunAftermath(input).exploitGranted).toBe(false)
    expect(OVERRUN_ATTACK_TYPE).toBe('overrun')
  })

  it('前置校验：剩余不足 3 MP 却调用后果结算 ⇒ 报错（不静默）', () => {
    expect(() =>
      resolveOverrunAftermath({
        mpRemainingBefore: 2,
        attackerRetreatedInOptions: false,
        defenderLeftHex: false,
      }),
    ).toThrowError(/8\.1a/)
  })
})

/** 8.1a 算例：进格需 1 MP 的格突袭两次（3+3=6 MP），第二次占领该格且不额外扣费 */
function overrunTwoTimes(): { total: number; enteredWithNoExtraCost: boolean } {
  const first = resolveOverrunAftermath({
    mpRemainingBefore: 6,
    attackerRetreatedInOptions: false,
    defenderLeftHex: false,
  })
  const second = resolveOverrunAftermath({
    mpRemainingBefore: first.mpRemaining,
    attackerRetreatedInOptions: false,
    defenderLeftHex: true,
  })
  return { total: 6 - second.mpRemaining, enteredWithNoExtraCost: second.mustEnterDefenderHex }
}

/* ────────────────────────────── 8.1g / 8.1h 参突堆叠 ────────────────────────────── */

describe('8.1g / 8.1h 参突者与留驻者', () => {
  it('8.1g：只有参突单位随堆叠移动；8.1h：留驻者计入 4.8a 且不受结果影响', () => {
    const split = splitOverrunStack({
      side: 'axis',
      friendlyUnits: [
        { id: 'a', re: 3, isCombat: true },
        { id: 'b', re: 2, isCombat: true },
        { id: 'truck', re: 0, isCombat: false },
      ],
      participantIds: ['a'],
    })
    expect(split).toMatchObject({
      participantIds: ['a'],
      stayIds: ['b', 'truck'],
      originStackRe: 5,
    })
    expect(split.rule).toBe('8.1g')
  })

  it('8.1h：原格堆叠规模照常计入全部友方战斗单位（超 10 RE 时突袭资格由 canOverrun 拒绝）', () => {
    const crowded = [
      unit({ id: 'u1', re: 2 }),
      unit({ id: 'x1', re: 5 }),
      unit({ id: 'x2', re: 4 }),
    ]
    expect(
      canOverrun({
        context: context(crowded),
        unitIds: ['u1'],
        target: TARGET,
        startedStackedTogether: true,
        mpRemaining: 6,
      }),
    ).toMatchObject({ ok: false, rule: '4.8a', reason: 'stackingLimit' })
    const split = splitOverrunStack({
      side: 'axis',
      friendlyUnits: crowded.map((item) => ({ id: item.id, re: item.re, isCombat: true })),
      participantIds: ['u1'],
    })
    expect(split.originStackRe).toBe(11)
  })
})

describe('W7 C16：突袭的移动记账（8.1a 3 MP / 8.0 进入 / 8.1f 结束 / 8.1g 只动参突者）', () => {
  /** 两个单位同格移动中的运行态 */
  const runtime: MoveUnitRuntime[] = [
    { unitId: 'u1', hex: { col: 36, row: 13 }, spentMp: 1, ended: false },
    { unitId: 'u2', hex: { col: 36, row: 13 }, spentMp: 2, ended: false },
    { unitId: 'stay', hex: { col: 36, row: 13 }, spentMp: 0, ended: false },
  ]
  const TARGET: HexRef = { col: 37, row: 13 }

  it('C16：防御方离开该格 ⇒ 参突者进入该格、各扣 3 MP、还有 ≥3 MP 就能继续突袭', () => {
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: 7,
      attackerRetreatedInOptions: false,
      defenderLeftHex: true,
    })
    const plan = planOverrunMove({
      runtime,
      participantIds: ['u1', 'u2'],
      target: TARGET,
      aftermath,
    })
    expect(plan.rule).toBe('8.0')
    expect(plan.enterDefenderHex).toBe(true)
    expect(plan.patches).toEqual([
      { unitId: 'u1', spentMp: 4, hex: TARGET, ended: false },
      { unitId: 'u2', spentMp: 5, hex: TARGET, ended: false },
    ])
    expect(plan.mayContinueMoving).toBe(true)
    expect(plan.endedIds).toEqual([])
    // 8.1h：留驻者不在补丁里（MP 与位置都不动）
    expect(plan.patches.some((patch) => patch.unitId === 'stay')).toBe(false)
  })

  it('C16：攻击方在选项里撤退 ⇒ 本阶段移动结束（8.1f），不进入防御格', () => {
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: 6,
      attackerRetreatedInOptions: true,
      defenderLeftHex: true,
    })
    const plan = planOverrunMove({ runtime, participantIds: ['u1'], target: TARGET, aftermath })
    expect(plan.enterDefenderHex).toBe(false)
    expect(plan.patches[0]).toEqual({ unitId: 'u1', spentMp: 4, hex: null, ended: true })
    expect(plan.endedIds).toEqual(['u1'])
    expect(plan.mayContinueMoving).toBe(false)
  })

  it('C16：8.1f——突袭后剩余不足 3 MP ⇒ 仍可继续移动（只是不能再突袭），并照常进格', () => {
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: 4,
      attackerRetreatedInOptions: false,
      defenderLeftHex: true,
    })
    const plan = planOverrunMove({ runtime, participantIds: ['u1'], target: TARGET, aftermath })
    expect(plan.patches[0]).toEqual({ unitId: 'u1', spentMp: 4, hex: TARGET, ended: false })
    expect(plan.mayContinueMoving).toBe(false)
    // 8.1f：只有「在选项中选择撤退」才结束移动 ⇒ 此处没有任何单位结束
    expect(plan.endedIds).toEqual([])
  })

  it('C16：活跃单位里找不到的参突者如实报出（不静默吞掉）', () => {
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: 6,
      attackerRetreatedInOptions: false,
      defenderLeftHex: false,
    })
    const plan = planOverrunMove({
      runtime,
      participantIds: ['u1', 'ghost'],
      target: TARGET,
      aftermath,
    })
    expect(plan.missingParticipantIds).toEqual(['ghost'])
    expect(plan.patches.map((patch) => patch.unitId)).toEqual(['u1'])
    // 相持：留在原格、仍可继续
    expect(plan.patches[0]?.hex).toBeNull()
    expect(plan.mayContinueMoving).toBe(true)
  })

  it('C16：突袭记成移动交互的一步（kind=overrun）⇒ 撤销一步能整步还原', () => {
    const interaction: MoveInteractionState = {
      unitIds: ['u1', 'u2'],
      start: { col: 36, row: 13 },
      steps: [],
      finished: false,
    }
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: 7,
      attackerRetreatedInOptions: false,
      defenderLeftHex: true,
    })
    const plan = planOverrunMove({
      runtime,
      participantIds: ['u1', 'u2'],
      target: TARGET,
      aftermath,
    })
    const applied = applyOverrunMove({ interaction, runtime, plan })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.data.record.kind).toBe('overrun')
    expect(applied.data.record.costById).toEqual({ u1: 3, u2: 3 })
    expect(applied.data.interaction.steps).toHaveLength(1)
    expect(applied.data.patches.map((item) => item.hex)).toEqual([TARGET, TARGET])

    // 撤销：回到突袭之前（位置与 MP 都还原）
    const reverted = undoMoveStep(applied.data.interaction)
    expect(reverted.interaction.steps).toHaveLength(0)
    expect(reverted.patches).toEqual([
      { unitId: 'u1', hex: { col: 36, row: 13 }, spentMp: 1, ended: false },
      { unitId: 'u2', hex: { col: 36, row: 13 }, spentMp: 2, ended: false },
    ])
  })

  it('C16：没有参突者 ⇒ 拒绝（8.1g，不产生空的一步）', () => {
    const interaction: MoveInteractionState = {
      unitIds: ['u1'],
      start: { col: 36, row: 13 },
      steps: [],
      finished: false,
    }
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: 6,
      attackerRetreatedInOptions: false,
      defenderLeftHex: false,
    })
    const plan = planOverrunMove({ runtime, participantIds: [], target: TARGET, aftermath })
    expect(applyOverrunMove({ interaction, runtime, plan })).toMatchObject({
      ok: false,
      rule: '8.1g',
      reason: 'noOverrunParticipant',
    })
  })
})
