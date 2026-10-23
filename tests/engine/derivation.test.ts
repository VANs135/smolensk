import { describe, expect, it } from 'vitest'

import {
  DERIVATION_KEY,
  derivationFromOutcomeData,
  diceStep,
  factStep,
  formatDerivation,
  formatStep,
  lookupStep,
  modifierStep,
  modifierTotal,
  resultStep,
  type Derivation,
} from '@/engine/derivation'
import {
  attritionDerivation,
  combatDerivation,
  flakDerivation,
  initiativeDerivation,
  surpriseDerivation,
  weatherDerivation,
} from '@/engine/derivation-builders'
import { createRngState, roll1d6, roll2d6 } from '@/engine/rng'
import { computeFlakDrm, type FlakDrmInput } from '@/engine/rules/air'
import { hedgehogCombatDrm } from '@/engine/rules/hedgehog'
import { resolveCombat } from '@/engine/rules/combat'
import { attritionLookup } from '@/engine/tables/attrition'
import { resolveSurprise } from '@/engine/tables/surprise'
import type { DiceRoll } from '@/engine/state-types'

/**
 * 结算复核（W7 C11）
 *
 * 本文件的重点是**等价性核对**——界面上摊开的计算过程必须与引擎实际用的算式是同一件事：
 *   · 各项 `modifier` 之和 == 引擎用的 DRM；
 *   · `subtotal` == 引擎算出的修正后骰值；
 *   · `result` == 引擎给出的结果码。
 * 骰面一律取真实 rng 产出（种子固定），不手工编造骰面，这样才能核对「骰值 + 修正 = 修正后骰值」。
 */

const SEED = 19410710

/** 固定种子下依次掷出的 2d6（用于给各用例提供真实骰面） */
function realRolls2d6(count: number): DiceRoll[] {
  const rolls: DiceRoll[] = []
  let rng = createRngState(SEED)
  for (let index = 0; index < count; index += 1) {
    const draw = roll2d6(rng)
    rng = draw.rng
    rolls.push(draw.value)
  }
  return rolls
}

/** 固定种子下依次掷出的 1d6 */
function realRolls1d6(count: number): DiceRoll[] {
  const rolls: DiceRoll[] = []
  let rng = createRngState(SEED)
  for (let index = 0; index < count; index += 1) {
    const draw = roll1d6(rng)
    rng = draw.rng
    rolls.push(draw.value)
  }
  return rolls
}

/** 取某类步骤（用例断言用） */
function stepOf(derivation: Derivation, kind: Derivation['steps'][number]['kind']) {
  return derivation.steps.filter((step) => step.kind === kind)
}

/* ────────────────────────────── 9.9 战斗结算 ────────────────────────────── */

describe('W7 C11：9.9 战斗结算复核与引擎算式等价', () => {
  const rolls = realRolls2d6(4)
  const cases = [
    { die: rolls[0]!.total, attackerAR: 5, defenderAR: 5, hedgehogLevel: 0 },
    { die: rolls[1]!.total, attackerAR: 5, defenderAR: 2, hedgehogLevel: 0 },
    { die: rolls[2]!.total, attackerAR: 5, defenderAR: 5, hedgehogLevel: 2 },
    { die: rolls[3]!.total, attackerAR: 3, defenderAR: 4, hedgehogLevel: 3 },
  ]

  it('C11：逐用例 —— 修正项之和 == 引擎 DRM、骰值 + 修正 == 引擎修正后骰值', () => {
    cases.forEach((item, index) => {
      const result = resolveCombat({
        die: item.die,
        attackerAR: item.attackerAR,
        defenderAR: item.defenderAR,
        ...(item.hedgehogLevel === 0 ? {} : { hedgehogLevel: item.hedgehogLevel }),
        terrainLine: 'Open',
        attackerA: 10,
        defenderA: 10,
      })

      const derivation = combatDerivation({
        roll: rolls[index]!,
        die: item.die,
        attackerAr: item.attackerAR,
        attackerArSource: '攻方 AR 单位 u-atk',
        defenderAr: item.defenderAR,
        defenderArSource: '守方 AR 单位 u-def',
        hedgehogLevel: item.hedgehogLevel,
        modifiedDice: result.modifiedDice,
        raw: result.raw,
        terrainLine: result.terrainLine,
        columnLabel: result.ratio,
      })
      const context = `骰 ${item.die}／AR ${item.attackerAR}−${item.defenderAR}／工事 ${item.hedgehogLevel}`

      // ① 各项修正之和 == 引擎的 DRM（9.6 AR 差 + 9.9 工事 −等级）
      expect(modifierTotal(derivation), context).toBe(
        item.attackerAR - item.defenderAR + hedgehogCombatDrm(item.hedgehogLevel),
      )
      // ② 恒等式：骰值 + 修正之和 == 引擎给出的修正后骰值
      expect(item.die + modifierTotal(derivation), context).toBe(result.modifiedDice)
      const subtotal = stepOf(derivation, 'subtotal')[0]!
      expect(subtotal.kind === 'subtotal' && subtotal.value, context).toBe(result.modifiedDice)
      // ③ 结果码与查表输入与引擎一致
      const resultStep = stepOf(derivation, 'result')[0]!
      expect(resultStep.kind === 'result' && resultStep.value, context).toBe(result.raw)
      const lookups = stepOf(derivation, 'lookup')
      expect(lookups, context).toHaveLength(2)
      expect(lookups[1], context).toMatchObject({ table: 'CRT9.9', row: result.modifiedDice })
    })
  })

  it('C11：每一步都写出规则号与来源（可对着规则书复核）', () => {
    const result = resolveCombat({
      die: 7,
      attackerAR: 5,
      defenderAR: 5,
      terrainLine: 'Open',
      attackerA: 10,
      defenderA: 10,
    })
    const derivation = combatDerivation({
      roll: rolls[0]!,
      die: 7,
      attackerAr: 5,
      attackerArSource: '攻方 AR 单位 u-atk',
      defenderAr: 5,
      defenderArSource: '守方 AR 单位 u-def',
      hedgehogLevel: 0,
      modifiedDice: result.modifiedDice,
      raw: result.raw,
      terrainLine: result.terrainLine,
      columnLabel: result.ratio,
      oddsLabel: '1:1',
      terrain: 'Open',
      attackerStrength: 10,
      defenderStrength: 10,
      attackerStrengthById: [
        { unitId: 'u-atk', strength: 6 },
        { unitId: 'u-atk2', strength: 4 },
      ],
    })

    expect(derivation.rule).toBe('9.9')
    expect(derivation.steps.every((step) => step.rule.length > 0)).toBe(true)
    const modifiers = stepOf(derivation, 'modifier')
    expect(modifiers.map((step) => (step.kind === 'modifier' ? step.source : ''))).toEqual([
      '攻方 AR 单位 u-atk',
      '守方 AR 单位 u-def',
      expect.stringContaining('环形工事'),
    ])
    // 明细里保留「单位军力」与「防御地形」，供界面逐项展开
    const labels = derivation.steps.map((step) => step.label)
    expect(labels).toContain('攻方单位 u-atk')
    expect(labels).toContain('防御地形')
    expect(labels).toContain('修正合计')
  })

  it('C11：未记录骰面时如实说明（不臆造骰面）', () => {
    const result = resolveCombat({
      die: 7,
      attackerAR: 5,
      defenderAR: 5,
      terrainLine: 'Open',
      attackerA: 10,
      defenderA: 10,
    })
    const derivation = combatDerivation({
      roll: null,
      die: 7,
      attackerAr: 5,
      attackerArSource: 'u-atk',
      defenderAr: 5,
      defenderArSource: 'u-def',
      hedgehogLevel: 0,
      modifiedDice: result.modifiedDice,
      raw: result.raw,
      terrainLine: result.terrainLine,
      columnLabel: result.ratio,
    })
    const dice = stepOf(derivation, 'dice')[0]!
    expect(dice.kind === 'dice' && dice.rolls).toEqual([])
    expect(dice.kind === 'dice' && dice.source).toBe('攻方')
    expect(formatStep(dice)).toContain('无掷骰记录')
  })
})

/* ────────────────────────────── 9.8 奇袭 ────────────────────────────── */

describe('W7 C11：9.8 奇袭复核与奇袭表等价', () => {
  const rolls = realRolls2d6(3)

  it('C11：无工事 —— 修正项之和 == 奇袭表的 drm', () => {
    const lookup = resolveSurprise({ die: 8, arDifferential: 5, attackType: 'regular' })
    const derivation = surpriseDerivation({
      roll: rolls[0]!,
      die: 8,
      arDifferential: 5,
      defenderInHedgehog: false,
      modifiedDice: lookup.modifiedDice,
      side: lookup.side,
    })
    expect(modifierTotal(derivation)).toBe(lookup.drm)
    expect(8 + modifierTotal(derivation)).toBe(lookup.modifiedDice)
  })

  it('C11：守方在环形工事内 —— −1 不随等级（9.8 与 9.9 的区别）', () => {
    const lookup = resolveSurprise({
      die: 8,
      arDifferential: 5,
      attackType: 'regular',
      defenderInHedgehog: true,
    })
    const derivation = surpriseDerivation({
      roll: rolls[1]!,
      die: 8,
      arDifferential: 5,
      defenderInHedgehog: true,
      modifiedDice: lookup.modifiedDice,
      side: lookup.side,
    })
    expect(modifierTotal(derivation)).toBe(lookup.drm)
    expect(modifierTotal(derivation)).toBe(4)
    const hedgehog = stepOf(derivation, 'modifier')[1]!
    expect(hedgehog.kind === 'modifier' && hedgehog.value).toBe(-1)
  })

  it('C11：未发生奇袭时如实写「无奇袭」，并给出横移骰步骤', () => {
    const lookup = resolveSurprise({ die: 8, arDifferential: 0, attackType: 'regular' })
    const derivation = surpriseDerivation({
      roll: rolls[2]!,
      die: 8,
      arDifferential: 0,
      defenderInHedgehog: false,
      modifiedDice: lookup.modifiedDice,
      side: lookup.side,
      shiftRoll: realRolls1d6(1)[0]!,
      shift: 2,
    })
    expect(lookup.side).toBeNull()
    const result = stepOf(derivation, 'result')[0]!
    expect(result.kind === 'result' && result.value).toBe('无奇袭（不横移）')
    expect(stepOf(derivation, 'dice')).toHaveLength(2)
  })
})

/* ────────────────────────────── 14.4e 防空 ────────────────────────────── */

describe('W7 C11：14.4e 防空复核与 computeFlakDrm 等价', () => {
  const inputs: FlakDrmInput[] = [
    { missionAircraftCount: 2, targetHasHQ: false, inEnemyPatrolZone: false },
    { missionAircraftCount: 3, targetHasHQ: true, inEnemyPatrolZone: false },
    { missionAircraftCount: 3, targetHasHQ: true, airBaseLevel: 2, inEnemyPatrolZone: true },
    {
      missionAircraftCount: 4,
      targetHasHQ: true,
      airBaseLevel: 1,
      printedFlakValue: 2,
      inEnemyPatrolZone: true,
      missionHasFighter: true,
    },
    {
      missionAircraftCount: 4,
      targetHasHQ: false,
      airBaseLevel: 3,
      printedFlakValue: 1,
      inEnemyPatrolZone: true,
      missionHasFighter: false,
      trainbustingInPatrolZone: true,
    },
  ]

  it('C11：逐项之和 == computeFlakDrm（含修正为 0 的项照留）', () => {
    inputs.forEach((input) => {
      const derivation = flakDerivation(input)
      expect(derivation.rule).toBe('14.4e')
      expect(modifierTotal(derivation)).toBe(computeFlakDrm(input))
      const subtotal = stepOf(derivation, 'subtotal')[0]!
      expect(subtotal.kind === 'subtotal' && subtotal.value).toBe(computeFlakDrm(input))
    })
    // 六项修正恒定在列（值可为 0），复核要看到「这一项算过」
    inputs.forEach((input) => {
      expect(stepOf(flakDerivation(input), 'modifier')).toHaveLength(6)
    })
  })

  it('C11：修正为 0 的项照留（复核要看到「这一项算过且为 0」）', () => {
    const derivation = flakDerivation({
      missionAircraftCount: 1,
      targetHasHQ: false,
      inEnemyPatrolZone: false,
    })
    const modifiers = stepOf(derivation, 'modifier')
    expect(modifiers).toHaveLength(6)
    expect(modifiers.every((step) => step.kind === 'modifier' && step.value === 0)).toBe(true)
  })
})

/* ────────────────────────────── 12.8b 损耗 ────────────────────────────── */

describe('W7 C11：12.8b 损耗复核与损耗表等价', () => {
  const rolls = realRolls2d6(3)

  it('C11：修正与取表一致（逐用例）', () => {
    const cases = [
      { die: rolls[0]!.total, bestAr: 5, oosSteps: 4 },
      { die: rolls[1]!.total, bestAr: 3, oosSteps: 5 },
      { die: rolls[2]!.total, bestAr: 2, oosSteps: 9 },
    ]
    cases.forEach((item, index) => {
      const lookup = attritionLookup(item.die, item.bestAr, item.oosSteps)
      const derivation = attritionDerivation({
        roll: rolls[index]!,
        die: item.die,
        oosSteps: item.oosSteps,
        modifiedDice: lookup.modifiedDice,
        bestAr: item.bestAr,
      })
      const context = `骰 ${item.die}／最高 AR ${item.bestAr}／断补军力 ${item.oosSteps}`
      expect(modifierTotal(derivation), context).toBe(lookup.drm)
      expect(item.die + modifierTotal(derivation), context).toBe(lookup.modifiedDice)
      const lookupStepIn = stepOf(derivation, 'lookup')[0]!
      expect(lookupStepIn.kind === 'lookup' && lookupStepIn.row, context).toBe(lookup.modifiedDice)
    })
  })
})

/* ────────────────────────────── 专规 1.5 天气 / 2.3 先手 ────────────────────────────── */

describe('W7 C11：专规 1.5 天气与 2.3 先手复核', () => {
  it('C11：首回合由剧本指定 —— 不掷骰、如实说明来源', () => {
    const derivation = weatherDerivation({ roll: null, air: 'limited', specified: true })
    expect(stepOf(derivation, 'dice')).toHaveLength(0)
    const fact = stepOf(derivation, 'fact')[0]!
    expect(fact.kind === 'fact' && fact.text).toBe('受限飞行')
    const result = stepOf(derivation, 'result')[0]!
    expect(result.kind === 'result' && result.value).toContain('受限飞行')
  })

  it('C11：常规回合掷 1 骰查天气表，行＝骰值', () => {
    const roll = realRolls1d6(1)[0]!
    const derivation = weatherDerivation({ roll, air: 'normal', specified: false })
    expect(stepOf(derivation, 'dice')).toHaveLength(1)
    const lookup = stepOf(derivation, 'lookup')[0]!
    expect(lookup.kind === 'lookup' && lookup.row).toBe(roll.total)
  })

  it('C11：首回合指定先手 / 常规回合双掷 + 重掷', () => {
    const specified = initiativeDerivation({ specifiedFirstPlayer: 'soviet' })
    expect(stepOf(specified, 'dice')).toHaveLength(0)
    expect(specified.steps.some((step) => step.kind === 'result' && step.value === '苏联')).toBe(
      true,
    )

    const [axisRoll, sovietRoll] = realRolls2d6(2)
    const rolled = initiativeDerivation({
      axisRoll: axisRoll!,
      sovietRoll: sovietRoll!,
      chooser: 'axis',
      rerolls: 1,
    })
    expect(stepOf(rolled, 'dice')).toHaveLength(2)
    expect(rolled.steps.some((step) => step.kind === 'fact' && step.label === '重掷')).toBe(true)
    expect(rolled.steps.some((step) => step.kind === 'result' && step.value === '轴心国')).toBe(
      true,
    )
  })
})

/* ────────────────────────────── 形状校验与格式化 ────────────────────────────── */

describe('W7 C11：读档后的逐字段校验（不半信半疑渲染）', () => {
  /** 一段形状完整的复核（覆盖全部六种步骤） */
  function sample(): Derivation {
    return {
      title: '样例（9.9）',
      rule: '9.9',
      steps: [
        diceStep({ label: '掷骰', rule: '9.9', source: '攻方', rolls: realRolls2d6(1) }),
        modifierStep({ label: '攻方行动值', rule: '9.6', source: 'u-atk', value: 5 }),
        modifierStep({ label: '守方行动值', rule: '9.6', source: 'u-def', value: -2 }),
        { kind: 'subtotal', label: '修正后骰值', rule: '9.9', value: 10, formula: '7 ＋5 −2' },
        factStep({ label: '防御地形', rule: '9.3b', source: '守方选定', text: 'Open' }),
        lookupStep({ label: '查战斗表', rule: '9.9', table: 'CRT9.9', row: 10, column: 'Open' }),
        resultStep({ label: '战斗结果', rule: '9.9', value: 'Ao1 Do1' }),
      ],
    }
  }

  it('C11：JSON 往返后字段逐项还原（读档即还原计算过程）', () => {
    const source = sample()
    const data = JSON.parse(JSON.stringify({ [DERIVATION_KEY]: source })) as Record<string, unknown>
    expect(derivationFromOutcomeData(data)).toEqual(source)
  })

  it('C11：缺键 / 形状不符 ⇒ 返回 null（当作没有复核过程）', () => {
    expect(derivationFromOutcomeData({})).toBeNull()
    expect(derivationFromOutcomeData({ [DERIVATION_KEY]: null })).toBeNull()
    expect(derivationFromOutcomeData({ [DERIVATION_KEY]: 'hi' })).toBeNull()
    expect(derivationFromOutcomeData({ [DERIVATION_KEY]: { title: 'x', rule: '9.9' } })).toBeNull()
    expect(
      derivationFromOutcomeData({
        [DERIVATION_KEY]: { title: 'x', rule: '9.9', steps: 'nope' },
      }),
    ).toBeNull()
  })

  it('C11：步骤类别不认识 ⇒ 整段作废', () => {
    const data = {
      [DERIVATION_KEY]: {
        title: 'x',
        rule: '9.9',
        steps: [{ kind: 'mystery', label: 'a', rule: '9.9' }],
      },
    }
    expect(derivationFromOutcomeData(data)).toBeNull()
  })

  it('C11：骰面被手改成非数字 ⇒ 整段作废（不渲染半截骰点）', () => {
    const data = {
      [DERIVATION_KEY]: {
        title: 'x',
        rule: '9.9',
        steps: [
          {
            kind: 'dice',
            label: '掷骰',
            rule: '9.9',
            source: '攻方',
            rolls: [{ count: 2, faces: [3, 'x'], total: 3 }],
          },
        ],
      },
    }
    expect(derivationFromOutcomeData(data)).toBeNull()
  })

  it('C11：修正项缺值 / 查表缺表名 ⇒ 整段作废', () => {
    expect(
      derivationFromOutcomeData({
        [DERIVATION_KEY]: {
          title: 'x',
          rule: '9.9',
          steps: [{ kind: 'modifier', label: 'a', rule: '9.6', source: 'u' }],
        },
      }),
    ).toBeNull()
    expect(
      derivationFromOutcomeData({
        [DERIVATION_KEY]: {
          title: 'x',
          rule: '9.9',
          steps: [{ kind: 'lookup', label: 'a', rule: '9.9' }],
        },
      }),
    ).toBeNull()
  })
})

describe('W7 C11：渲染口径（界面与日志共用同一格式化）', () => {
  it('C11：formatStep 逐类给出骰点 / 修正 / 合计 / 事实 / 查表 / 结果', () => {
    expect(
      formatStep(
        diceStep({ label: '战斗掷骰', rule: '9.9', source: '攻方', rolls: realRolls2d6(1) }),
      ),
    ).toContain('9.9')
    expect(
      formatStep(modifierStep({ label: '攻方行动值', rule: '9.6', source: 'u-atk', value: 3 })),
    ).toBe('＋3 攻方行动值（u-atk｜9.6）')
    expect(
      formatStep(modifierStep({ label: '守方行动值', rule: '9.6', source: 'u-def', value: -2 })),
    ).toBe('−2 守方行动值（u-def｜9.6）')
    expect(formatStep(modifierStep({ label: 'x', rule: '9.9', source: 'y', value: 0 }))).toContain(
      '＋0',
    )
    expect(
      formatStep({
        kind: 'subtotal',
        label: '修正后骰值',
        rule: '9.9',
        value: 10,
        formula: '7 ＋5 −2',
      }),
    ).toBe('修正后骰值 10（7 ＋5 −2）')
    expect(
      formatStep(factStep({ label: '地形', rule: '9.3b', source: '守方', text: 'Open' })),
    ).toBe('地形：Open（守方｜9.3b）')
    expect(
      formatStep(
        lookupStep({ label: '查表', rule: '9.9', table: 'CRT9.9', row: 10, column: 'Open' }),
      ),
    ).toBe('查表 CRT9.9 行 10 列 Open（9.9）')
    expect(formatStep(resultStep({ label: '结果', rule: '9.9', value: 'Ao1' }))).toBe(
      '结果 Ao1（9.9）',
    )
  })

  it('C11：formatDerivation 串起整段（供日志摘要 / 检索）', () => {
    const text = formatDerivation({
      title: '战斗结算（9.9）',
      rule: '9.9',
      steps: [
        factStep({ label: '骰值', rule: '9.9', source: '实掷骰面', text: '7' }),
        resultStep({ label: '战斗结果', rule: '9.9', value: 'AL1o1 Do1' }),
      ],
    })
    expect(text).toContain('战斗结算（9.9）')
    expect(text).toContain('⇒')
    expect(text).toContain('AL1o1 Do1')
  })
})
