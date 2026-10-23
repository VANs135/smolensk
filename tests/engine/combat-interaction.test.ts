import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, neighbor } from '@/engine/hex-geometry'
import {
  COMBAT_STEP_IDS,
  beginCombat,
  declareCombatAr,
  declareCombatTerrain,
  lossesOf,
  optionsOf,
  planCombatSupply,
  planLosses,
  planOptions,
  resolveAdvance,
  resolveCombatDice,
  resolveRetreats,
  resolveSurprise,
  stepChecklist,
  type BattleFacts,
  type BattleUnitView,
  type CombatInteractionState,
  type CombatUnitPatch,
  type RetreatFacts,
} from '@/engine/rules'

/**
 * 战斗交互（C6）测试 —— 9.2 九步流程的顺序与各步入参合法性
 *
 * 断言到条文一级：9.1 构成 / 9.5+12.4 补给（含 9.5b 减员例）/ 9.6 AR / 9.4 地形 / 9.7+4.2 攻防比 /
 * 9.8 奇袭 / 9.9 查表 / 9.10 选项（9.10a 组合、9.10c 忽略、9.10d 进击惩罚）/ 9.11 损失 /
 * 9.12 撤退（完整距离、DG、ZOC 额外损失）/ 9.12g 推进 / 9.13 进击。
 *
 * 夹具固定为 **Open、攻 10 : 守 10 = 1:1**（AR 4 : 2，DRM = 2），故修正骰 = 骰值 + 2：
 *   骰 5 → 7  → CRT「7 行 1:1 列」= `AL1o1 Do1`
 *   骰 8 → 10 → CRT「10 行 1:1 列」= `Ao1 Do1`
 *   骰 12 → 14 → CRT「14 行 1:1 列」= `Ao1 e4 DL1o2`
 */

const DEFENDER_HEX: HexRef = { col: 36, row: 14 }
const ATTACKER_HEX: HexRef = { col: 36, row: 13 }

function unit(over: Partial<BattleUnitView> = {}): BattleUnitView {
  return {
    id: 'u1',
    side: 'axis',
    hex: ATTACKER_HEX,
    attackerType: 'other',
    attack: 10,
    ar: 4,
    dg: false,
    mode: 'combat',
    printedSteps: 1,
    steps: 1,
    re: 1,
    internalStocks: null,
    outOfSupply: false,
    mobility: 'leg',
    attackCapable: true,
    ...over,
  }
}

function defender(over: Partial<BattleUnitView> = {}): BattleUnitView {
  return unit({ id: 'd1', side: 'soviet', hex: DEFENDER_HEX, ar: 2, ...over })
}

/** 两个攻方单位（5 + 5 = 10 战力 ⇒ 对守方 10 为 1:1），AR 单位是 a1 */
function attackerPair(): BattleUnitView[] {
  return [
    unit({ id: 'a1', attack: 5, steps: 3, printedSteps: 3, ar: 4 }),
    unit({ id: 'a2', attack: 5, steps: 1 }),
  ]
}

/** 守方：10 战力 3 军力，AR 2 */
function defenderUnit(over: Partial<BattleUnitView> = {}): BattleUnitView {
  return defender({ attack: 10, steps: 3, printedSteps: 3, ...over })
}

function facts(over: Partial<BattleFacts> = {}): BattleFacts {
  return {
    canEnterForAttack: () => true,
    hedgehogLevelAt: () => 0,
    hexsideTerrainsBetween: () => [],
    hexTerrainsAt: () => ['Open'],
    defenderAtLevelAt: () => 'none',
    // 9.1c：缺省＝空账本（本环节还没打过）——本文件不考账本，账本用例在 `battle.test.ts`
    attackedThisSegmentBy: () => false,
    attackedThisSegmentAt: () => false,
    ...over,
  }
}

const retreatFacts = (over: Partial<RetreatFacts> = {}): RetreatFacts => ({
  enemyCombatUnitAt: () => false,
  inEnemyZocAt: () => false,
  prohibitedFor: () => false,
  friendlyCombatUnitsAt: () => [],
  immobile: () => false,
  ...over,
})

/** 断言成功并返回 data */
function unwrap<T>(
  outcome: { ok: true; data: T } | { ok: false; rule: string; reason: string },
): T {
  if (!outcome.ok) throw new Error(`预期成功，实得失败：${outcome.rule} / ${outcome.reason}`)
  return outcome.data
}

/** 把引擎给出的变更落到单位视图上（与状态层落盘同规） */
function applyPatches(
  units: readonly BattleUnitView[],
  patches: readonly CombatUnitPatch[],
): BattleUnitView[] {
  return units.map((unitView) => {
    const patch = patches.find((item) => item.unitId === unitView.id)
    if (patch === undefined) return unitView
    return {
      ...unitView,
      ...(patch.steps === undefined ? {} : { steps: patch.steps }),
      ...(patch.hex === undefined ? {} : { hex: patch.hex }),
      ...(patch.dg === true ? { dg: true } : {}),
    }
  })
}

/** 跑到「已宣布地形」为止（9.2 的第 1–4 步） */
function upToTerrain(input: {
  attackers?: readonly BattleUnitView[]
  defenders?: readonly BattleUnitView[]
  facts?: BattleFacts
  attackerAvailableT?: number
  defenderProvides?: boolean
  attackerUnitIds?: readonly string[]
  attackerUnitId?: string
  defenderUnitId?: string
  stackChoices?: readonly { hex: HexRef; kind: 'hex' | 'hexside'; terrain: string }[]
  defenderTerrain?: string
  phase?: CombatInteractionState['phase']
  attackType?: 'regular' | 'overrun'
}): {
  state: CombatInteractionState
  attackers: BattleUnitView[]
  defenders: BattleUnitView[]
} {
  const attackers = [...(input.attackers ?? [unit()])]
  const defenders = [...(input.defenders ?? [defender()])]
  const mapFacts = input.facts ?? facts()
  const begin = unwrap(
    beginCombat({
      attackers,
      defenders,
      facts: mapFacts,
      attackType: input.attackType ?? 'regular',
      phase: input.phase ?? 'combat',
    }),
  )
  const supplied = unwrap(
    planCombatSupply(begin, {
      attackers,
      defenders,
      attackerAvailableT: input.attackerAvailableT ?? 9,
      defenderProvides: input.defenderProvides ?? true,
      defenderAvailableT: 9,
      ...(input.attackerUnitIds === undefined ? {} : { attackerUnitIds: input.attackerUnitIds }),
    }),
  )
  const declared = unwrap(
    declareCombatAr(supplied.state, {
      attackers,
      defenders,
      attackerUnitId: input.attackerUnitId ?? supplied.state.composition.attackerIds[0]!,
      defenderUnitId: input.defenderUnitId ?? defenders[0]!.id,
    }),
  )
  const terrain = unwrap(
    declareCombatTerrain(declared.state, {
      attackers,
      defenders,
      facts: mapFacts,
      ...(input.stackChoices === undefined ? {} : { stackChoices: input.stackChoices }),
      ...(input.defenderTerrain === undefined ? {} : { defenderTerrain: input.defenderTerrain }),
    }),
  )
  return { state: terrain.state, attackers, defenders }
}

describe('9.2 九步流程：步骤清单与顺序', () => {
  it('步骤 id 与 9.2 流程一致，且按序推进', () => {
    expect(COMBAT_STEP_IDS).toEqual([
      'composition',
      'combatSupply',
      'declareAr',
      'declareTerrain',
      'surprise',
      'battleDice',
      'losses',
      'options',
      'retreat',
      'advance',
    ])
    const state = unwrap(
      beginCombat({
        attackers: [unit()],
        defenders: [defender()],
        facts: facts(),
        attackType: 'regular',
        phase: 'combat',
      }),
    )
    expect(state.step).toBe('combatSupply')
    const checklist = stepChecklist(state)
    expect(checklist.find((item) => item.step === 'composition')!.done).toBe(true)
    expect(checklist.find((item) => item.step === 'combatSupply')!.current).toBe(true)
  })

  it('9.2：步骤未到就调用该步 ⇒ 拒绝（顺序不可颠倒）', () => {
    const state = unwrap(
      beginCombat({
        attackers: [unit()],
        defenders: [defender()],
        facts: facts(),
        attackType: 'regular',
        phase: 'combat',
      }),
    )
    expect(
      declareCombatAr(state, { attackers: [unit()], defenders: [defender()], attackerUnitId: 'u1' })
        .ok,
    ).toBe(false)
    expect(resolveCombatDice(state, { die: 7 }).ok).toBe(false)
    expect(planLosses(state, { units: [unit()] }).ok).toBe(false)
  })

  it('9.1：构成非法（无守方 / 不能进入防御格）直接拒绝', () => {
    expect(
      beginCombat({
        attackers: [unit()],
        defenders: [],
        facts: facts(),
        attackType: 'regular',
        phase: 'combat',
      }).ok,
    ).toBe(false)
    expect(
      beginCombat({
        attackers: [unit()],
        defenders: [defender()],
        facts: facts({ canEnterForAttack: () => false }),
        attackType: 'regular',
        phase: 'combat',
      }),
    ).toMatchObject({ ok: false, rule: '9.1f' })
  })

  it('9.8/9.9：环形工事同时进入奇袭 −1 与战斗骰 −完整等级', () => {
    const state = unwrap(
      beginCombat({
        attackers: [unit()],
        defenders: [defender()],
        facts: facts({ hedgehogLevelAt: () => 2 }),
        attackType: 'regular',
        phase: 'combat',
      }),
    )
    expect(state.defenderInHedgehog).toBe(true)
    expect(state.hedgehogLevel).toBe(2)
  })

  /*
   * 9.1c（`_ocs_v43_clean.txt:1091-1097`）：
   *   「在一个战斗环节中，**同一个单位只能攻击一次，同一格只能被攻击一次**。」
   *   「在一个移动环节中，同一个单位可以进行多次突袭，**突袭同一个格的次数没有限制**。」
   * ⇒ 账本事实喂进来时，常规战斗按 9.1c 拒；同一份事实对**突袭**（8.1）不生效。
   */
  it('9.1c：本环节已攻击过的单位再攻 ⇒ 拒并给 9.1c', () => {
    const outcome = beginCombat({
      attackers: [unit()],
      defenders: [defender()],
      facts: facts({ attackedThisSegmentBy: (id) => id === 'u1' }),
      attackType: 'regular',
      phase: 'combat',
    })
    expect(outcome).toMatchObject({ ok: false, rule: '9.1c' })
    if (!outcome.ok) expect(outcome.reason).toContain('unitAlreadyAttackedThisSegment:u1')
  })

  it('9.1c：本环节已被攻击过的格再被攻击 ⇒ 拒并给 9.1c', () => {
    const outcome = beginCombat({
      attackers: [unit()],
      defenders: [defender()],
      facts: facts({ attackedThisSegmentAt: () => true }),
      attackType: 'regular',
      phase: 'combat',
    })
    expect(outcome).toMatchObject({ ok: false, rule: '9.1c' })
    if (!outcome.ok) expect(outcome.reason).toBe('hexAlreadyAttackedThisSegment')
  })

  it('9.1c 下一条：**突袭不受账本限制**（移动环节同一格可反复突袭）', () => {
    const outcome = beginCombat({
      attackers: [unit()],
      defenders: [defender()],
      facts: facts({
        attackedThisSegmentBy: () => true,
        attackedThisSegmentAt: () => true,
      }),
      attackType: 'overrun',
      phase: 'movement',
    })
    expect(outcome.ok).toBe(true)
  })

  it('9.1c：账本冲突**不掩盖**更具体的构成问题（先报 9.1f）', () => {
    const outcome = beginCombat({
      attackers: [unit()],
      defenders: [defender()],
      facts: facts({
        canEnterForAttack: () => false,
        attackedThisSegmentBy: () => true,
      }),
      attackType: 'regular',
      phase: 'combat',
    })
    expect(outcome).toMatchObject({ ok: false, rule: '9.1f' })
  })
})

describe('9.5 / 12.4 战斗补给确认与拒付', () => {
  it('攻方全额才可攻：付不足则取消战斗', () => {
    const attackers = [unit({ steps: 3 })]
    const state = unwrap(
      beginCombat({
        attackers,
        defenders: [defender()],
        facts: facts(),
        attackType: 'regular',
        phase: 'combat',
      }),
    )
    expect(
      planCombatSupply(state, {
        attackers,
        defenders: [defender()],
        attackerAvailableT: 2,
        defenderProvides: true,
        defenderAvailableT: 9,
      }),
    ).toMatchObject({ ok: false, rule: '12.4', reason: 'attackSupplyNotFull' })
  })

  it('9.5b 例：攻方付不出全额时可**减少参战单位**（从 3 个减到 1 个即可付 1T）', () => {
    const attackers = [unit({ id: 'u1' }), unit({ id: 'u2' }), unit({ id: 'u3' })]
    const state = unwrap(
      beginCombat({
        attackers,
        defenders: [defender()],
        facts: facts(),
        attackType: 'regular',
        phase: 'combat',
      }),
    )
    const supplied = unwrap(
      planCombatSupply(state, {
        attackers,
        defenders: [defender()],
        attackerAvailableT: 1,
        defenderProvides: false,
        defenderAvailableT: 0,
        attackerUnitIds: ['u1'],
      }),
    )
    expect(supplied.state.composition.attackerIds).toEqual(['u1'])
    expect(supplied.state.supply!.attacker.requiredT).toBe(1)
    expect(supplied.state.supply!.defender.paid).toBe(false)
    expect(supplied.state.supply!.defender.declined).toBe(true)
  })

  it('12.4：守方 ≤1 RE 时只耗 1T', () => {
    const smallDefender = defender({ re: 0.5 })
    const state = unwrap(
      beginCombat({
        attackers: [unit()],
        defenders: [smallDefender],
        facts: facts(),
        attackType: 'regular',
        phase: 'combat',
      }),
    )
    const supplied = unwrap(
      planCombatSupply(state, {
        attackers: [unit()],
        defenders: [smallDefender],
        attackerAvailableT: 1,
        defenderProvides: true,
        defenderAvailableT: 1,
      }),
    )
    expect(supplied.state.supply!.defender.requiredT).toBe(1)
  })
})

describe('9.6 行动值指定：攻方先、守方后', () => {
  function atArStep() {
    const attackers = attackerPair()
    const defenders = [defenderUnit()]
    const begin = unwrap(
      beginCombat({ attackers, defenders, facts: facts(), attackType: 'regular', phase: 'combat' }),
    )
    return unwrap(
      planCombatSupply(begin, {
        attackers,
        defenders,
        attackerAvailableT: 9,
        defenderProvides: true,
        defenderAvailableT: 9,
      }),
    ).state
  }

  it('只给攻方 ⇒ 等守方宣布（不前进）', () => {
    const state = atArStep()
    const pending = unwrap(
      declareCombatAr(state, {
        attackers: attackerPair(),
        defenders: [defenderUnit()],
        attackerUnitId: 'a1',
      }),
    )
    expect(pending.awaitingDefender).toBe(true)
    expect(pending.state.step).toBe('declareAr')
  })

  it('9.6：AR 单位必须参战；DRM ＝ 攻方 AR − 守方 AR', () => {
    const state = atArStep()
    const declared = unwrap(
      declareCombatAr(state, {
        attackers: attackerPair(),
        defenders: [defenderUnit()],
        attackerUnitId: 'a1',
        defenderUnitId: 'd1',
      }),
    )
    expect(declared.state.ar).toMatchObject({ attackerAr: 4, defenderAr: 2, drm: 2 })
    expect(declared.state.step).toBe('declareTerrain')
    expect(
      declareCombatAr(state, {
        attackers: attackerPair(),
        defenders: [defenderUnit()],
        attackerUnitId: 'nope',
        defenderUnitId: 'd1',
      }).ok,
    ).toBe(false)
  })
})

describe('9.4 逐堆叠地形宣布与初始攻防比', () => {
  it('逐堆叠可选格内或格边地形（不累计）；守方地形决定战斗表横行', () => {
    const attackers = [unit(), unit({ id: 'u2', hex: { col: 37, row: 14 } })]
    const { state } = upToTerrain({
      attackers,
      facts: facts({
        hexTerrainsAt: () => ['Woods'],
        hexsideTerrainsBetween: () => ['Minor River'],
      }),
      stackChoices: [
        { hex: ATTACKER_HEX, kind: 'hexside', terrain: 'Minor River' },
        { hex: { col: 37, row: 14 }, kind: 'hex', terrain: 'Woods' },
      ],
      defenderTerrain: 'Woods',
    })
    expect(state.odds!.terrain.defenderTerrain).toBe('Woods')
    expect(state.odds!.terrain.combatLine).toBe('Close')
    expect(state.odds!.terrain.attackerTerrainByHex).toEqual([
      { hex: ATTACKER_HEX, terrain: 'Minor River', kind: 'hexside' },
      { hex: { col: 37, row: 14 }, terrain: 'Woods', kind: 'hex' },
    ])
  })

  it('9.4b/9.4c：守方只能选格内地形；攻方堆叠选了非候选地形 ⇒ 拒绝', () => {
    const begin = unwrap(
      beginCombat({
        attackers: [unit()],
        defenders: [defender()],
        facts: facts({
          hexTerrainsAt: () => ['Woods'],
          hexsideTerrainsBetween: () => ['Minor River'],
        }),
        attackType: 'regular',
        phase: 'combat',
      }),
    )
    const supplied = unwrap(
      planCombatSupply(begin, {
        attackers: [unit()],
        defenders: [defender()],
        attackerAvailableT: 9,
        defenderProvides: true,
        defenderAvailableT: 9,
      }),
    )
    const declared = unwrap(
      declareCombatAr(supplied.state, {
        attackers: [unit()],
        defenders: [defender()],
        attackerUnitId: 'u1',
        defenderUnitId: 'd1',
      }),
    )
    expect(
      declareCombatTerrain(declared.state, {
        attackers: [unit()],
        defenders: [defender()],
        facts: facts({
          hexTerrainsAt: () => ['Woods'],
          hexsideTerrainsBetween: () => ['Minor River'],
        }),
        defenderTerrain: 'Minor River',
      }),
    ).toMatchObject({ ok: false, rule: '9.4c' })
  })

  it('9.7 + 4.2：初始攻防比按四舍五入取整，标签与列位同口径', () => {
    // 攻 25 : 守 10 → 2.5 → 3:1
    const { state } = upToTerrain({
      attackers: [unit({ attack: 25 })],
      defenders: [defender({ attack: 10 })],
    })
    expect(state.odds!.attackerTotal).toBe(25)
    expect(state.odds!.defenderTotal).toBe(10)
    expect(state.odds!.oddsLabel).toBe('3:1')
    expect(state.odds!.columnLabel).toBe('3:1')
    expect(state.odds!.columnRule).toBe('9.7a')
  })

  it('9.14a：守方战斗值为 0 ⇒ 最右列；攻方为 0 ⇒ 最左列', () => {
    const rightMost = upToTerrain({
      attackers: [unit({ attack: 10 })],
      defenders: [defender({ attack: 0 })],
    })
    expect(rightMost.state.odds!.columnRule).toBe('9.14a')
    expect(rightMost.state.odds!.columnIndex).toBe(12)
    const leftMost = upToTerrain({
      attackers: [unit({ attack: 0 })],
      defenders: [defender({ attack: 10 })],
    })
    expect(leftMost.state.odds!.columnRule).toBe('9.14a')
    expect(leftMost.state.odds!.columnIndex).toBe(0)
  })

  it('9.5a/9.5：断补守方且未付战斗补给 ⇒ 战力 ×¼', () => {
    const { state } = upToTerrain({
      attackers: [unit()],
      defenders: [defender({ attack: 8, outOfSupply: true })],
      defenderProvides: false,
    })
    expect(state.odds!.defenderTotal).toBe(2)
  })
})

describe('9.8 / 9.9 奇袭、横移与战斗掷骰', () => {
  it('9.8：攻方奇袭向右横移，横移后列位用于查表', () => {
    const { state } = upToTerrain({
      attackers: [unit({ ar: 5 })],
      defenders: [defender({ ar: 0 })],
      attackerUnitId: 'u1',
    })
    // 2d6 = 12 + DRM 5 = 17 ≥ 10 ⇒ 攻方奇袭；横移骰 3
    const surprised = unwrap(resolveSurprise(state, { die: 12, shiftDie: 3 }))
    expect(surprised.awaitingShiftDie).toBe(false)
    expect(surprised.state.surprise).toMatchObject({ side: 'attacker', shift: 3 })
    expect(surprised.state.surprise!.finalColumnIndex).toBe(state.odds!.columnIndex + 3)
    expect(surprised.state.step).toBe('battleDice')
  })

  it('9.8：发生奇袭时须再掷 1 骰 —— 未给横移骰则停在本步等玩家掷', () => {
    const { state } = upToTerrain({
      attackers: [unit({ ar: 5 })],
      defenders: [defender({ ar: 0 })],
      attackerUnitId: 'u1',
    })
    const pending = unwrap(resolveSurprise(state, { die: 12 }))
    expect(pending.awaitingShiftDie).toBe(true)
    expect(pending.state.step).toBe('surprise')
    expect(pending.state.surprise).toBeUndefined()
  })

  it('9.8：守方在环形工事内 ⇒ 奇袭掷骰 −1（等级无关，恒 −1）', () => {
    const withHedgehog = upToTerrain({
      attackers: [unit({ ar: 4 })],
      defenders: [defender({ ar: 2 })],
      attackerUnitId: 'u1',
      facts: facts({ hedgehogLevelAt: () => 1 }),
    })
    // 8 + 2 − 1 = 9 落在常规战斗的「无奇袭」区间（6–9）⇒ 不发生奇袭
    expect(unwrap(resolveSurprise(withHedgehog.state, { die: 8 })).state.surprise!.side).toBeNull()
    // 9 + 2 − 1 = 10 ⇒ 恰好攻方奇袭（若没有 −1 则为 11，结果相同；故上面那条才是判据）
    const boundary = unwrap(resolveSurprise(withHedgehog.state, { die: 9, shiftDie: 2 }))
    expect(boundary.state.surprise!.side).toBe('attacker')

    const noHedgehog = upToTerrain({
      attackers: [unit({ ar: 4 })],
      defenders: [defender({ ar: 2 })],
      attackerUnitId: 'u1',
    })
    // 8 + 2 = 10 ⇒ 攻方奇袭（带工事时同样掷出 8 却不奇袭）
    expect(
      unwrap(resolveSurprise(noHedgehog.state, { die: 8, shiftDie: 1 })).state.surprise!.side,
    ).toBe('attacker')
  })

  it('9.9：修正骰 ＝ 2d6 + 攻方 AR − 守方 AR − 工事完整等级（9.6–9 无奇袭）', () => {
    const { state } = upToTerrain({
      attackers: attackerPair(),
      defenders: [defenderUnit()],
      attackerUnitId: 'a1',
      defenderUnitId: 'd1',
    })
    // 7 + (4−2) = 9 ⇒ 无奇袭，列位不横移
    const surprised = unwrap(resolveSurprise(state, { die: 7 }))
    expect(surprised.state.surprise!.side).toBeNull()
    const dice = unwrap(resolveCombatDice(surprised.state, { die: 7 }))
    expect(dice.state.dice!.modifiedDice).toBe(9)
    expect(dice.state.dice!.result.raw).toBe('Ao1 Do1')
    expect(lossesOf(dice.state.dice!.result, 'attacker')).toBe(0)
    expect(optionsOf(dice.state.dice!.result, 'attacker')).toBe(1)
    expect(optionsOf(dice.state.dice!.result, 'defender')).toBe(1)
  })
})

describe('9.10 / 9.11 结算：攻方先、守方后，从 AR 单位起算', () => {
  /** 走到「战斗骰已掷」；骰 5 → `AL1o1 Do1`（攻 L1+o1 / 守 o1） */
  function afterLowDice() {
    const attackers = attackerPair()
    const defenders = [defenderUnit()]
    const { state } = upToTerrain({
      attackers,
      defenders,
      attackerUnitId: 'a1',
      defenderUnitId: 'd1',
    })
    const surprised = unwrap(resolveSurprise(state, { die: 5 }))
    const dice = unwrap(resolveCombatDice(surprised.state, { die: 5 }))
    return { state: dice.state, attackers, defenders }
  }

  it('9.10b/9.11c：攻方先结算强制损失，AR 单位承受第一点', () => {
    const { state, attackers, defenders } = afterLowDice()
    expect(state.dice!.result.raw).toBe('AL1o1 Do1')
    expect(state.resolution.stage).toBe('attackerLosses')

    const losses = unwrap(planLosses(state, { units: [...attackers, ...defenders] }))
    expect(losses.patches).toEqual([
      { unitId: 'a1', steps: 2 },
      { unitId: 'a2', steps: 1 },
    ])
    expect(losses.state.resolution.stage).toBe('attackerOptions')
    expect(losses.state.resolution.attacker.forcedLosses).toEqual([{ unitId: 'a1', steps: 1 }])
  })

  it('9.11c：把强制损失塞给非 AR 单位 ⇒ 拒绝（分配形状由规则锁定）', () => {
    const { state, attackers, defenders } = afterLowDice()
    expect(
      planLosses(state, {
        units: [...attackers, ...defenders],
        allocation: [{ unitId: 'a2', steps: 1 }],
      }),
    ).toMatchObject({ ok: false, rule: '9.11c' })
  })

  it('9.10a：选项可「撤退格数 + 损失军力数」任意组合，但总数必须完全满足', () => {
    const { state, attackers, defenders } = afterLowDice()
    const losses = unwrap(planLosses(state, { units: [...attackers, ...defenders] }))
    const current = applyPatches([...attackers, ...defenders], losses.patches)
    const attackerUnits = current.filter((item) => item.side === 'axis')

    // o1 却想「不撤退也不损失」⇒ 非法
    expect(
      planOptions(losses.state, { units: attackerUnits, retreatHexes: 0, lossPoints: 0 }),
    ).toMatchObject({ ok: false, rule: '9.10a' })

    // o1 选成 1 点军力损失
    const asLoss = unwrap(
      planOptions(losses.state, { units: attackerUnits, retreatHexes: 0, lossPoints: 1 }),
    )
    expect(asLoss.retreatHexes).toBe(0)
    expect(asLoss.state.resolution.stage).toBe('defenderLosses')

    // o1 选成 1 格撤退
    const asRetreat = unwrap(
      planOptions(losses.state, { units: attackerUnits, retreatHexes: 1, lossPoints: 0 }),
    )
    expect(asRetreat.retreatHexes).toBe(1)
  })

  it('9.10c：攻方用选项撤退后，守方可以忽略自己的选项', () => {
    const { state, attackers, defenders } = afterLowDice()
    const losses = unwrap(planLosses(state, { units: [...attackers, ...defenders] }))
    const current = applyPatches([...attackers, ...defenders], losses.patches)
    const attackerUnits = current.filter((item) => item.side === 'axis')
    const options = unwrap(
      planOptions(losses.state, { units: attackerUnits, retreatHexes: 1, lossPoints: 0 }),
    )
    // 守方的强制损失（o1 无 L，故无损失）
    const defenderLosses = unwrap(planLosses(options.state, { units: current }))
    const defenderUnits = applyPatches(current, defenderLosses.patches).filter(
      (item) => item.side === 'soviet',
    )
    const ignored = unwrap(
      planOptions(defenderLosses.state, { units: defenderUnits, ignore: true }),
    )
    expect(ignored.rule).toBe('9.10c')
    expect(ignored.state.resolution.defender.optionIgnored).toBe(true)
    expect(ignored.state.step).toBe('retreat')
  })

  /*
   * H①（用户 2026-09-18 报的第 2 条）：**攻方在承受选项前被摧毁 ⇒ 跳过攻方选项页**
   *
   * 9.10c：「如果攻击方已撤退，或**无法完成所有选项**，则防御方便可忽略他的选项。」
   * 举例 B：「AL1o1，Do1……**唯一的攻击者因 L1 摧毁**，因此**防御者可以忽略他的选项**。」
   * 9.12g-D：「常规战斗后并非必须如此，由拥有者玩家选择哪些攻击单位进行推进（**如果有的话**）。」
   * ⇒ 攻方全灭时**不该**再让玩家面对一个填不动的选项页（修前攻方名单为空，选项只能靠"死人撤退"凑过去）。
   */
  describe('H①：攻方在承受选项前被摧毁（9.10c 例 B）', () => {
    /** 1:1 行 `AL1o1 Do1` 的现场（骰 5 + DRM 2 ⇒ 修正骰 7；守方 3 军力、非 DG） */
    function afterAlL1(attackerSteps: number) {
      const attackers = [unit({ id: 'a1', steps: attackerSteps, printedSteps: 3 })]
      const defenders = [defenderUnit({ id: 'd1' })]
      const { state } = upToTerrain({
        attackers,
        defenders,
        attackerUnitId: 'a1',
        defenderUnitId: 'd1',
      })
      const surprised = unwrap(resolveSurprise(state, { die: 5 }))
      expect(surprised.state.surprise!.side).toBeNull()
      const dice = unwrap(resolveCombatDice(surprised.state, { die: 5 }))
      return { attackers, defenders, state: dice.state }
    }

    it('★ 攻方只有 1 军力 ⇒ AL1 即全灭：直落 defenderLosses，不再停在 attackerOptions', () => {
      const { attackers, defenders, state } = afterAlL1(1)
      const losses = unwrap(planLosses(state, { units: [...attackers, ...defenders] }))
      // 攻方那枚被打到 0 军力（AL1）
      expect(losses.patches.find((patch) => patch.unitId === 'a1')?.steps).toBe(0)
      // 9.10c 例 B：跳过攻方选项步，直接交给守方结算强制损失
      expect(losses.state.resolution.stage).toBe('defenderLosses')
      expect(losses.state.step).toBe('losses')
      expect(losses.state.resolution.attacker.optionsSkipped).toBe('attackerWipedOut')
      // 守方的强制损失照常结算（这一步不该被跳过）
      const current = applyPatches([...attackers, ...defenders], losses.patches)
      const defenderLosses = unwrap(planLosses(losses.state, { units: current }))
      expect(defenderLosses.state.resolution.stage).toBe('defenderOptions')
    })

    it('★ 对照：攻方 3 军力（扛得住 AL1）⇒ 仍按 9.10b 先结算攻方选项', () => {
      const { attackers, defenders, state } = afterAlL1(3)
      const losses = unwrap(planLosses(state, { units: [...attackers, ...defenders] }))
      expect(losses.state.resolution.stage).toBe('attackerOptions')
      expect(losses.state.step).toBe('options')
      expect(losses.state.resolution.attacker.optionsSkipped).toBeUndefined()
    })
  })
})

describe('9.12 撤退方向：完整撤退距离、DG 与敌方 ZOC', () => {
  /** 攻守各 o1，双方各撤退 1 格 ⇒ 进入撤退步（攻方 a1 有 3 军力，可承受 o1 的损失） */
  function atRetreatStep(defenderDg = false) {
    const attackers = [unit({ id: 'a1', steps: 3, printedSteps: 3 })]
    const defenders = [defenderUnit({ id: 'd1', dg: defenderDg })]
    const { state } = upToTerrain({
      attackers,
      defenders,
      attackerUnitId: 'a1',
      defenderUnitId: 'd1',
    })
    // DRM = 4 − (2−1) = 3（守方 DG 时，5.10b 行动值 −1）/ 2；骰值 5 使两侧都满足：
    //   · 无奇袭（5 > 攻方 AR 4，且 < 触发守方奇袭的阈值）；
    //   · 修正骰 = 5 + DRM：DG 时 8 → 2:1 行 `Ao1 Do1`（双方各 1 点选项）；
    //     非 DG 时 7 → 1:1 行 `AL1o1 Do1`（同样双方各 1 点选项）。
    //   ★ 守方 DG 会同时改行动值（DRM）与防御值（攻防比 1:1 → 2:1，5.10b-A），
    //     故两个分支的**列**不同，骰值必须按各自列重取，不能沿用同一个修正骰。
    const die = 5
    const surprised = unwrap(resolveSurprise(state, { die }))
    expect(surprised.state.surprise!.side).toBeNull()
    const dice = unwrap(resolveCombatDice(surprised.state, { die }))
    const start = [...attackers, ...defenders]
    const attackerLosses = unwrap(planLosses(dice.state, { units: start }))
    let current = applyPatches(start, attackerLosses.patches)
    const attackerOptions = unwrap(
      planOptions(attackerLosses.state, {
        units: current.filter((item) => item.side === 'axis'),
        retreatHexes: 1,
        lossPoints: 0,
      }),
    )
    current = applyPatches(current, attackerOptions.patches)
    const defenderLosses = unwrap(planLosses(attackerOptions.state, { units: current }))
    current = applyPatches(current, defenderLosses.patches)
    const defenderOptions = unwrap(
      planOptions(defenderLosses.state, {
        units: current.filter((item) => item.side === 'soviet'),
        retreatHexes: 1,
        lossPoints: 0,
      }),
    )
    current = applyPatches(current, defenderOptions.patches)
    return { state: defenderOptions.state, units: current }
  }

  it('9.12：撤退格数必须等于选项点数（完整撤退距离）', () => {
    const { state, units } = atRetreatStep()
    expect(state.step).toBe('retreat')
    // 给 2 格 ⇒ 与 o1 不符，拒绝
    expect(
      resolveRetreats(state, {
        units,
        paths: [
          {
            unitId: 'a1',
            path: [
              { col: 36, row: 12 },
              { col: 36, row: 11 },
            ],
          },
        ],
        facts: retreatFacts(),
      }),
    ).toMatchObject({ ok: false, rule: '9.12' })

    const retreat = unwrap(
      resolveRetreats(state, {
        units,
        paths: [
          { unitId: 'a1', path: [{ col: 36, row: 12 }] },
          { unitId: 'd1', path: [{ col: 36, row: 15 }] },
        ],
        facts: retreatFacts(),
      }),
    )
    expect(retreat.results.find((item) => item.unitId === 'd1')!.gainsDg).toBe(false)
    expect(retreat.state.step).toBe('advance')
    expect(retreat.patches).toContainEqual({ unitId: 'a1', hex: { col: 36, row: 12 } })
    expect(retreat.patches).toContainEqual({ unitId: 'd1', hex: { col: 36, row: 15 } })
  })

  it('9.12a：撤退 2 格 ⇒ 进入第 2 格时 DG', () => {
    const { state, units } = atRetreatStep()
    // 把选项改成 2 格撤退：这里直接用「o2」的守方结果不便构造，故验证引擎对 2 格路径的 DG 判定
    const retreat = unwrap(
      resolveRetreats(
        {
          ...state,
          resolution: {
            ...state.resolution,
            defender: {
              ...state.resolution.defender,
              option: { points: 2, retreatHexes: 2, lossPoints: 0 },
            },
          },
        },
        {
          units,
          paths: [
            { unitId: 'a1', path: [{ col: 36, row: 12 }] },
            {
              unitId: 'd1',
              path: [
                { col: 36, row: 15 },
                { col: 36, row: 16 },
              ],
            },
          ],
          facts: retreatFacts(),
        },
      ),
    )
    expect(retreat.results.find((item) => item.unitId === 'd1')!.gainsDg).toBe(true)
  })

  it('9.12e：整堆叠撤退进入敌方 ZOC ⇒ 报出额外 1 点损失与候选承受者', () => {
    // 守方撤退前已是 DG（9.12e 的前提），故承受者只能从「撤退中的 DG 单位」里选
    const { state, units } = atRetreatStep(true)
    const retreat = unwrap(
      resolveRetreats(state, {
        units,
        paths: [
          { unitId: 'a1', path: [{ col: 36, row: 12 }] },
          { unitId: 'd1', path: [{ col: 36, row: 15 }] },
        ],
        facts: retreatFacts({ inEnemyZocAt: (hex) => hex.row === 15 }),
      }),
    )
    expect(retreat.extraLoss).toEqual({ points: 1, eligibleUnitIds: ['d1'] })
    expect(retreat.results.find((item) => item.unitId === 'd1')!.extraLoss).toBe(1)
    // 进入 ZOC 一律 DG（9.12e），且只报「候选承受者」，不自行决定由谁承担
    expect(retreat.results.find((item) => item.unitId === 'd1')!.gainsDg).toBe(true)
  })

  it('9.12e：撤退进入敌方 ZOC 时，与该格同格的友方战斗单位一并 DG', () => {
    const { state, units } = atRetreatStep()
    const retreat = unwrap(
      resolveRetreats(state, {
        units,
        paths: [
          { unitId: 'a1', path: [{ col: 36, row: 12 }] },
          { unitId: 'd1', path: [{ col: 36, row: 15 }] },
        ],
        facts: retreatFacts({
          inEnemyZocAt: (hex) => hex.row === 15,
          friendlyCombatUnitsAt: () => ['bystander'],
        }),
      }),
    )
    expect(retreat.patches).toContainEqual({ unitId: 'bystander', dg: true })
    expect(retreat.extraLoss).toEqual({ points: 0, eligibleUnitIds: [] })
  })

  it('9.12：落点与起撤格的**直线距离**必须等于撤退格数（等长但落点不对的之字形路径被拒）', () => {
    const { state, units } = atRetreatStep()
    // 造一条「2 步、落点却只离起点 1 格」的路径（等长但不满足完整撤退距离）
    let zigzag: HexRef[] | null = null
    for (const first of HEX_DIRECTIONS) {
      const p1 = neighbor(DEFENDER_HEX, first)
      for (const second of HEX_DIRECTIONS) {
        const p2 = neighbor(p1, second)
        if (hexDistance(DEFENDER_HEX, p2) === 1) {
          zigzag = [p1, p2]
          break
        }
      }
      if (zigzag !== null) break
    }
    expect(zigzag).not.toBeNull()

    // 把守方选项改成「撤 2 格」，再给这条等长但落点不对的路径
    const twoHexState: CombatInteractionState = {
      ...state,
      resolution: {
        ...state.resolution,
        attacker: {
          ...state.resolution.attacker,
          option: { points: 2, retreatHexes: 2, lossPoints: 0 },
        },
        defender: {
          ...state.resolution.defender,
          option: { points: 2, retreatHexes: 2, lossPoints: 0 },
        },
      },
    }
    // 攻方给一条正当的 2 格直线路径，守方给这条「等长但落点不对」的路径 ⇒ 引擎按 9.12 拒绝
    const attackerPath = [neighbor(ATTACKER_HEX, 'N')]
    attackerPath.push(neighbor(attackerPath[0]!, 'N'))
    const failed = resolveRetreats(twoHexState, {
      units,
      paths: [
        { unitId: 'a1', path: attackerPath },
        { unitId: 'd1', path: zigzag! },
      ],
      facts: retreatFacts(),
    })
    expect(failed).toMatchObject({ ok: false, rule: '9.12' })
    expect(failed.ok === false && failed.reason).toContain('retreatMustEndAtFullDistance')
  })

  it('9.12d：未参战战斗单位与编内卡车可跟随撤退（同路径）；其他非战斗单位必须留在原格', () => {
    const { state, units } = atRetreatStep()
    const withFriends: BattleUnitView[] = [
      ...units,
      unit({ id: 'a9', side: 'axis', hex: ATTACKER_HEX }),
      unit({
        id: 'ot1',
        side: 'axis',
        hex: ATTACKER_HEX,
        isCombat: false,
        noncombatKind: 'organic_truck',
      }),
      unit({
        id: 'dump1',
        side: 'axis',
        hex: ATTACKER_HEX,
        isCombat: false,
        noncombatKind: 'dump',
      }),
    ]
    const paths = [
      { unitId: 'a1', path: [{ col: 36, row: 12 }] },
      { unitId: 'd1', path: [{ col: 36, row: 15 }] },
    ]

    // 分派给 a1（参战者）与跟随者；两者都随 a1 的路径落地
    const followed = unwrap(
      resolveRetreats(state, {
        units: withFriends,
        paths,
        facts: retreatFacts(),
        tagalongIds: ['a9', 'ot1'],
      }),
    )
    expect(followed.patches).toContainEqual({ unitId: 'a9', hex: { col: 36, row: 12 } })
    expect(followed.patches).toContainEqual({ unitId: 'ot1', hex: { col: 36, row: 12 } })

    // 9.12d 反面：补给站（dump）不可跟随
    expect(
      resolveRetreats(state, {
        units: withFriends,
        paths,
        facts: retreatFacts(),
        tagalongIds: ['dump1'],
      }),
    ).toMatchObject({ ok: false, rule: '9.12d' })

    // 9.12d：跟随者必须与撤退单位**同格**
    const afar = [...units, unit({ id: 'a9', side: 'axis', hex: { col: 40, row: 20 } })]
    expect(
      resolveRetreats(state, {
        units: afar,
        paths,
        facts: retreatFacts(),
        tagalongIds: ['a9'],
      }),
    ).toMatchObject({ ok: false, rule: '9.12d' })
  })

  it('9.12a：战斗表 DG 结果 ⇒ 掷骰步就产出「全部防御单位 DG」的补丁（先于任何撤退）', () => {
    // 攻方压倒性（20:1 级别）⇒ 高列必有多格带守方 DG
    const attackers = [unit({ id: 'a1', attack: 40, ar: 4, steps: 3, printedSteps: 3 })]
    const defenders = [defenderUnit({ id: 'd1', attack: 10, steps: 3, printedSteps: 3, ar: 2 })]
    const { state } = upToTerrain({
      attackers,
      defenders,
      attackerUnitId: 'a1',
      defenderUnitId: 'd1',
    })
    let dgPatches: CombatUnitPatch[] | null = null
    let plainPatches: CombatUnitPatch[] | null = null
    for (let die = 2; die <= 12; die += 1) {
      // 一并给出横移骰，避免停在「等横移骰」的中间态
      const surprised = unwrap(resolveSurprise(state, { die, shiftDie: 3 }))
      void surprised
      const dice = unwrap(resolveCombatDice(surprised.state, { die }))
      if (dice.state.dice!.result.defender.disorganized) {
        dgPatches = [...dice.patches]
        break
      }
      plainPatches = [...dice.patches]
    }
    // 9.12a：DG 结果 ⇒ 全部防御单位立即 DG（引擎只给补丁，落盘在状态层）
    expect(dgPatches).toEqual([{ unitId: 'd1', dg: true }])
    // 非 DG 结果 ⇒ 不产生任何补丁
    expect(plainPatches).toEqual([])
  })
})

describe('9.12g / 9.13 战后推进与进击', () => {
  /**
   * 打一场「1:1、修正骰 14」的攻击：12 + (4−2) = 14 ⇒ 攻方奇袭，横移骰 1 → 列位 2:1，
   * CRT「14 行 2:1 列」= `Ae4 DL1o2`（攻方 e4；守方 L1o2 = 1 损失 + 1 撤退）。
   */
  function toAdvance(phase: CombatInteractionState['phase'] = 'combat') {
    const attackers = [unit({ id: 'a1', attack: 10, steps: 3, printedSteps: 3, ar: 4 })]
    const defenders = [defenderUnit({ id: 'd1', attack: 10, steps: 3, printedSteps: 3, ar: 2 })]
    const { state } = upToTerrain({
      attackers,
      defenders,
      attackerUnitId: 'a1',
      defenderUnitId: 'd1',
      phase,
    })
    const surprised = unwrap(resolveSurprise(state, { die: 12, shiftDie: 1 }))
    const dice = unwrap(resolveCombatDice(surprised.state, { die: 12 }))
    let current = [...attackers, ...defenders]
    // 攻方无强制损失、无选项 ⇒ 直接过
    const attackerLosses = unwrap(planLosses(dice.state, { units: current }))
    current = applyPatches(current, attackerLosses.patches)
    const attackerOptions = unwrap(
      planOptions(attackerLosses.state, {
        units: current.filter((item) => item.side === 'axis'),
        retreatHexes: 0,
        lossPoints: 0,
      }),
    )
    current = applyPatches(current, attackerOptions.patches)
    const defenderLosses = unwrap(planLosses(attackerOptions.state, { units: current }))
    current = applyPatches(current, defenderLosses.patches)
    const defenderOptions = unwrap(
      planOptions(defenderLosses.state, {
        units: current.filter((item) => item.side === 'soviet'),
        retreatHexes: 1,
        lossPoints: 1,
      }),
    )
    current = applyPatches(current, defenderOptions.patches)
    const retreat = unwrap(
      resolveRetreats(defenderOptions.state, {
        units: current,
        paths: [{ unitId: 'd1', path: [{ col: 36, row: 15 }] }],
        facts: retreatFacts(),
      }),
    )
    return { state: retreat.state, units: applyPatches(current, retreat.patches) }
  }

  it('9.12g：只有付了战斗补给的攻击单位才能推进；推进后防御格落入攻方', () => {
    const { state } = toAdvance()
    expect(state.dice!.result.raw).toBe('Ae4 DL1o2')
    const advance = unwrap(
      resolveAdvance(state, {
        defendingHexCleared: true,
        candidates: [
          { id: 'a1', paidCombatSupply: true },
          { id: 'a2', paidCombatSupply: false },
        ],
        chosenUnitIds: ['a1'],
      }),
    )
    expect(advance.advanceUnitIds).toEqual(['a1'])
    expect(advance.patches).toContainEqual({ unitId: 'a1', hex: DEFENDER_HEX })
    expect(advance.state.finished).toBe(true)
  })

  it('9.12g-A：选了没付战斗补给的单位推进 ⇒ 拒绝', () => {
    const { state } = toAdvance()
    expect(
      resolveAdvance(state, {
        defendingHexCleared: true,
        candidates: [{ id: 'a1', paidCombatSupply: false }],
        chosenUnitIds: ['a1'],
      }),
    ).toMatchObject({ ok: false, rule: '9.12g-A' })
  })

  it('9.13：e4 且攻方 AR 4 ≥ 4、把选项全选成损失 ⇒ 取得进击标记', () => {
    const { state } = toAdvance()
    const advance = unwrap(
      resolveAdvance(state, {
        defendingHexCleared: true,
        candidates: [{ id: 'a1', paidCombatSupply: true }],
        chosenUnitIds: ['a1'],
      }),
    )
    expect(advance.exploit).toMatchObject({ granted: true, reason: 'ok' })
    expect(advance.patches).toContainEqual({ unitId: 'a1', exploit: true })
  })

  it('9.13b-B：进击阶段的攻击不给进击标记（e# 只在战斗阶段生效）', () => {
    const { state } = toAdvance('exploitation')
    const advance = unwrap(
      resolveAdvance(state, {
        defendingHexCleared: true,
        candidates: [{ id: 'a1', paidCombatSupply: true }],
        chosenUnitIds: [],
      }),
    )
    expect(advance.exploit).toMatchObject({ granted: false, reason: 'exploitOnlyInCombatPhase' })
  })

  it('9.13b-A：攻方 AR 单位 DG ⇒ 不给进击标记', () => {
    const { state } = toAdvance()
    const advance = unwrap(
      resolveAdvance(state, {
        defendingHexCleared: true,
        candidates: [{ id: 'a1', paidCombatSupply: true }],
        chosenUnitIds: ['a1'],
        attackerArDg: true,
      }),
    )
    expect(advance.exploit).toMatchObject({ granted: false, reason: 'attackerDg' })
  })

  it('9.12b：任何模式下都不可移动的单位不得推进（显式选它 ⇒ 拒绝；突袭后强制推进时无候选 ⇒ 9.12g-A）', () => {
    const { state } = toAdvance()
    const candidates = [{ id: 'a1', paidCombatSupply: true, immobile: true }]
    // 常规战斗：候选全被剔除 ⇒ 合法地「不推进」
    const none = unwrap(
      resolveAdvance(state, { defendingHexCleared: true, candidates, chosenUnitIds: [] }),
    )
    expect(none.advanceUnitIds).toEqual([])
    // 显式点它 ⇒ 按 9.12b 拒绝
    expect(
      resolveAdvance(state, { defendingHexCleared: true, candidates, chosenUnitIds: ['a1'] }),
    ).toMatchObject({ ok: false, rule: '9.12b' })
    // 突袭（8.1f 必须进格）但无可推进者 ⇒ 9.12g-A
    expect(
      resolveAdvance(
        { ...state, attackType: 'overrun' },
        { defendingHexCleared: true, candidates },
      ),
    ).toMatchObject({ ok: false, rule: '9.12g-A' })
  })

  it('专规 1.1b：防御格是敌方安全边缘格（补给源边格）⇒ 不推进（可常规攻击，但不得进入）', () => {
    const { state } = toAdvance()
    const advance = unwrap(
      resolveAdvance(state, {
        defendingHexCleared: true,
        candidates: [{ id: 'a1', paidCombatSupply: true }],
        chosenUnitIds: ['a1'],
        advanceIntoForbiddenHex: true,
      }),
    )
    expect(advance.advanceUnitIds).toEqual([])
    // 不推进 ⇒ 没有进格补丁（9.13 的进击标记与该限制无关，仍按 9.13 照常判定）
    expect(advance.patches.some((patch) => patch.hex !== undefined)).toBe(false)
    expect(advance.state.finished).toBe(true)
  })
})
