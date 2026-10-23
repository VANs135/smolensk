import { FLAK_MODIFIERS, baseAaValue, type FlakDrmInput } from './rules/air'
import { HEDGEHOG_SURPRISE_DRM } from './rules/combat'
import { hedgehogCombatDrm } from './rules/hedgehog'
import { ATTRITION_DRM, attritionDrmFor } from './tables/attrition'
import {
  diceStep,
  factStep,
  lookupStep,
  modifierStep,
  resultStep,
  type Derivation,
  type DerivationStep,
} from './derivation'
import type { DiceRoll } from './state-types'

/**
 * 各结算族的**复核构造器**（W7 C11）
 *
 * ## 与引擎函数**成对**是本文件的硬纪律
 *   每个构造器都对应一个既有引擎函数，二者必须用**同一批常量、同一批条件**：
 *   | 构造器 | 对应引擎函数 | 常量来源 |
 *   |---|---|---|
 *   | `combatDerivation` | `resolveCombat`（9.9 战斗表） | 逐项值取自该函数已算出的结论 |
 *   | `surpriseDerivation` | `resolveSurprise`（9.8 奇袭） | `HEDGEHOG_SURPRISE_DRM`（`combat.ts`，单一定义） |
 *   | `flakDerivation` | `computeFlakDrm`（14.4e 防空） | `FLAK_MODIFIERS`（`air.ts`） |
 *   | `attritionDerivation` | `resolveAttrition`（12.8b 损耗） | `ATTRITION_DRM`（`tables/attrition.ts`） |
 *   | `weatherDerivation` | `resolveTurnWeather`（专规 1.5） | 结论取自该函数 |
 *   | `initiativeDerivation` | `resolveInitiative`（2.3） | 结论取自该函数 |
 *   测试逐族做**等价性核对**：`modifier` 之和 == 该函数用的 DRM、`subtotal` == 该函数给出的修正后骰值。
 *
 * 因此界面上的「计算过程」不是另写一遍规则，而是**把引擎已经算过的账摊开**。
 */

/** 把「无掷骰记录」写成显式提示（不臆造骰面） */
const NO_ROLLS: readonly DiceRoll[] = []

/* ────────────────────────────── 9.9 战斗结算 ────────────────────────────── */

/** 战斗结算复核的输入（**全部字段都来自引擎结论**） */
export interface CombatDerivationInput {
  /** 2d6 掷骰（控制台实际掷出的那颗；缺省表示未记录骰面，只给合计） */
  roll: DiceRoll | null
  /** 2d6 合计（引擎 `CombatDiceResult.die`；无 roll 时以它为准） */
  die: number
  /** 9.6：攻方行动值（及来源单位） */
  attackerAr: number
  attackerArSource: string
  /** 9.6：守方行动值（及来源单位） */
  defenderAr: number
  defenderArSource: string
  /** 9.9：守方环形工事**完整等级**（修正 −等级） */
  hedgehogLevel: number
  /** 9.9：修正后骰值（引擎给出的结果；缺省时按骰值 + 各项修正逐项加总，常量同源） */
  modifiedDice?: number
  /** 9.9：CRT 原始格值（引擎 `CombatResult.raw`，如 `AL1o1 Do1`） */
  raw: string
  /** 9.9：地形列组（如 `Open`） */
  terrainLine: string
  /** 9.7a / 9.14a：取到的列标签（如 `3:1`） */
  columnLabel: string
  /** 9.7：攻防比标签（界面展示用；与 columnLabel 同源） */
  oddsLabel?: string
  /** 9.3b：防御地形（决定列组） */
  terrain?: string
  /** 9.4d：攻方军力（已按地形倍率修正）与逐单位明细 */
  attackerStrength?: number
  defenderStrength?: number
  attackerStrengthById?: readonly { unitId: string; strength: number }[]
}

/**
 * 9.9 战斗结算复核
 *
 * 算式（与 `resolveCombat` 完全一致）：`修正骰 = 2d6 + 攻方 AR − 守方 AR − 工事等级`；
 * 每项都写出**来源**（哪一方的行动值单位 / 环形工事等级）与**规则号**（9.6 / 9.9）。
 */
export function combatDerivation(input: CombatDerivationInput): Derivation {
  const steps: DerivationStep[] = []

  steps.push(
    diceStep({
      label: '战斗掷骰',
      rule: '9.9',
      source: '攻方',
      rolls: input.roll === null ? NO_ROLLS : [input.roll],
    }),
  )
  steps.push(
    factStep({
      label: '骰值',
      rule: '9.9',
      source: input.roll === null ? '引擎给出的 2d6 合计（未记录骰面）' : '实掷骰面',
      text: String(input.die),
    }),
  )
  steps.push(
    modifierStep({
      label: '攻方行动值',
      rule: '9.6',
      source: input.attackerArSource,
      value: input.attackerAr,
    }),
  )
  steps.push(
    modifierStep({
      label: '守方行动值',
      rule: '9.6',
      source: input.defenderArSource,
      value: -input.defenderAr,
    }),
  )
  steps.push(
    modifierStep({
      label: `环形工事 ${input.hedgehogLevel} 级`,
      rule: '9.9',
      source: '守方格内环形工事（9.9 按**完整等级**修正，与 9.8 的 −1 不同）',
      value: hedgehogCombatDrm(input.hedgehogLevel),
    }),
  )

  const modifierSum = input.attackerAr - input.defenderAr + hedgehogCombatDrm(input.hedgehogLevel)
  const modifiedDice = input.modifiedDice ?? input.die + modifierSum
  steps.push({
    kind: 'subtotal',
    label: '修正后骰值',
    rule: '9.9',
    value: modifiedDice,
    formula: `${input.die} ${formatSigned(input.attackerAr)} ${formatSigned(-input.defenderAr)} ${formatSigned(hedgehogCombatDrm(input.hedgehogLevel))}`,
  })

  if (input.terrain !== undefined) {
    steps.push(
      factStep({
        label: '防御地形',
        rule: '9.3b',
        source: '守方从格内地形中选定',
        text: `${input.terrain}（列组 ${input.terrainLine}）`,
      }),
    )
  }
  if (input.attackerStrength !== undefined && input.defenderStrength !== undefined) {
    steps.push(
      factStep({
        label: '军力',
        rule: '9.4d',
        source: '攻方逐单位按地形倍率修正后合计',
        text: `攻 ${input.attackerStrength} ／ 守 ${input.defenderStrength}`,
      }),
    )
  }
  for (const unit of input.attackerStrengthById ?? []) {
    steps.push(
      factStep({
        label: `攻方单位 ${unit.unitId}`,
        rule: '9.4d',
        source: '地形倍率修正后战力',
        text: String(unit.strength),
      }),
    )
  }
  steps.push(
    lookupStep({
      label: '取列',
      rule: '9.7a',
      table: 'CRT9.9',
      column:
        input.oddsLabel === undefined
          ? input.columnLabel
          : `${input.oddsLabel} ⇒ ${input.columnLabel}`,
    }),
  )
  steps.push(
    lookupStep({
      label: '查战斗表',
      rule: '9.9',
      table: 'CRT9.9',
      row: modifiedDice,
      column: input.terrainLine,
    }),
  )
  steps.push(resultStep({ label: '战斗结果', rule: '9.9', value: input.raw }))

  return {
    title: '战斗结算（9.9）',
    rule: '9.9',
    steps: [
      ...steps,
      // 明细里同时保留「修正项合计」供核对（引擎给出的修正后骰值应等于骰值 + 本合计）
      factStep({
        label: '修正合计',
        rule: '9.6 / 9.9',
        source: '各项修正之和（供核对）',
        text: `${formatSigned(modifierSum)} ⇒ ${input.die} ${formatSigned(modifierSum)} = ${input.die + modifierSum}`,
      }),
    ],
  }
}

/** 带符号数字（`＋2` / `−1` / `0`） */
function formatSigned(value: number): string {
  if (value === 0) return '0'
  return `${value > 0 ? '＋' : '−'}${Math.abs(value)}`
}

/* ────────────────────────────── 9.8 奇袭 ────────────────────────────── */

/** 奇袭复核的输入（取自 `resolveSurprise` 的结论） */
export interface SurpriseDerivationInput {
  /** 2d6 掷骰（控制台实掷；缺省只给合计） */
  roll: DiceRoll | null
  /** 2d6 合计（引擎 `SurpriseLookup` 的原始骰值 = 修正后骰值 − drm） */
  die: number
  /** 9.6：DRM ＝ 攻方 AR − 守方 AR */
  arDifferential: number
  /** 9.8：守方是否在环形工事内（−1，不随等级） */
  defenderInHedgehog: boolean
  /** 引擎给出的修正后骰值（缺省时按骰值 + 各项修正逐项加总，常量同源） */
  modifiedDice?: number
  /** 9.8：引擎判定的获奇袭方（`null` ＝ 无奇袭，不横移） */
  side: 'attacker' | 'defender' | null
  /** 9.8：横移 1d6（发生奇袭时） */
  shiftRoll?: DiceRoll | null
  /** 奇袭横移列数（引擎结论） */
  shift?: number
}

/** 9.8 奇袭复核 */
export function surpriseDerivation(input: SurpriseDerivationInput): Derivation {
  const hedgehog = input.defenderInHedgehog ? HEDGEHOG_SURPRISE_DRM : 0
  const modifiedDice = input.modifiedDice ?? input.die + input.arDifferential + hedgehog
  const steps: DerivationStep[] = [
    diceStep({
      label: '奇袭掷骰',
      rule: '9.8',
      source: '双方共用一次 2d6',
      rolls: input.roll === null ? NO_ROLLS : [input.roll],
    }),
    modifierStep({
      label: '行动值差（攻方 AR − 守方 AR）',
      rule: '9.6',
      source: '9.6 判定的 DRM（与战斗掷骰共用）',
      value: input.arDifferential,
    }),
    modifierStep({
      label: '守方在环形工事内',
      rule: '9.8',
      source: '任意等级均 −1（不随等级变化）',
      value: hedgehog,
    }),
    {
      kind: 'subtotal',
      label: '修正后骰值',
      rule: '9.8',
      value: modifiedDice,
      formula: `${input.die} ${formatSigned(input.arDifferential)} ${formatSigned(hedgehog)}`,
    },
    lookupStep({
      label: '查奇袭表',
      rule: '9.8',
      table: '奇袭表 9.8',
      row: modifiedDice,
    }),
    resultStep({
      label: '奇袭判定',
      rule: '9.8',
      value:
        input.side === null
          ? '无奇袭（不横移）'
          : input.side === 'attacker'
            ? '攻方奇袭'
            : '守方奇袭',
    }),
  ]

  if (input.shiftRoll != null || input.shift !== undefined) {
    steps.push(
      diceStep({
        label: '横移掷骰',
        rule: '9.8',
        source: '发生奇袭后另掷 1d6 定横移列数',
        rolls: input.shiftRoll == null ? NO_ROLLS : [input.shiftRoll],
      }),
    )
    if (input.shift !== undefined) {
      steps.push(
        factStep({
          label: '横移列数',
          rule: '9.1g',
          source: '按 9.1g 取端列',
          text: formatSigned(input.shift),
        }),
      )
    }
  }

  return { title: '奇袭判定（9.8）', rule: '9.8', steps }
}

/* ────────────────────────────── 14.4e 防空 ────────────────────────────── */

/**
 * 14.4e 防空掷骰修正复核
 *
 * 逐项复现 `computeFlakDrm` 的判定（**同一批 `FLAK_MODIFIERS` 常量、同一批条件**），
 * 好处是界面能说清「这 +2 是哪来的」；测试核对逐项之和 == `computeFlakDrm(input)`。
 */
export function flakDerivation(input: FlakDrmInput): Derivation {
  const mods = FLAK_MODIFIERS
  const steps: DerivationStep[] = []

  steps.push(
    modifierStep({
      label: '任务 ≥3 机',
      rule: '14.4e',
      source: '任务飞机数 ≥3（表 17-3）',
      value: input.missionAircraftCount >= 3 ? mods.missionThreePlusAircraft : 0,
    }),
  )
  steps.push(
    modifierStep({
      label: '目标格内有 HQ',
      rule: '14.4e',
      source: '目标格堆叠内含 HQ',
      value: input.targetHasHQ ? mods.targetHasHQ : 0,
    }),
  )
  steps.push(
    modifierStep({
      label: `空军基地防空点数 ${input.airBaseLevel ?? 0}（${input.baseIsAirstrip === true ? '简易机场' : '基地'}）`,
      rule: '15.0b-B',
      source:
        '15.0b-B：防空点数等于其等级；15.2F：简易机场不能提供任何防空值（唯一实现 baseAaValue）',
      value: baseAaValue(input.airBaseLevel ?? 0, input.baseIsAirstrip === true),
    }),
  )
  steps.push(
    modifierStep({
      label: '地图印刷防空值',
      rule: '14.4e',
      source: '目标格印刷防空值原样加入',
      value: input.printedFlakValue ?? 0,
    }),
  )
  steps.push(
    modifierStep({
      label:
        input.missionHasFighter === true
          ? '敌人巡逻区内·任务编有战斗机'
          : '敌人巡逻区内·任务无战斗机',
      rule: '14.4e',
      source: '目标格处于敌方巡逻区内时的分档',
      value: input.inEnemyPatrolZone
        ? input.missionHasFighter === true
          ? mods.inEnemyPatrolZoneWithFighter
          : mods.inEnemyPatrolZoneNoFighter
        : 0,
    }),
  )
  steps.push(
    modifierStep({
      label: '运输破坏（巡逻区内）',
      rule: '14.4e',
      source: 'trainbusting 任务在敌方巡逻区内 +1（与上一条累计）',
      value: input.trainbustingInPatrolZone === true ? mods.trainbustingInPatrolZone : 0,
    }),
  )

  const total = steps.reduce((sum, step) => (step.kind === 'modifier' ? sum + step.value : sum), 0)
  steps.push({
    kind: 'subtotal',
    label: '防空 DRM 合计',
    rule: '14.4e',
    value: total,
    formula: steps
      .filter((step) => step.kind === 'modifier')
      .map((step) => formatSigned(step.value))
      .join(' '),
  })

  return { title: '防空掷骰修正（14.4e）', rule: '14.4e', steps }
}

/* ────────────────────────────── 12.8b 损耗 ────────────────────────────── */

/** 损耗复核的输入（取自 `attritionLookup` 的结论） */
export interface AttritionDerivationInput {
  /** 2d6 掷骰（控制台实掷；缺省只给骰值） */
  roll: DiceRoll | null
  /** 2d6 合计（12.8b 掷两枚骰子） */
  die: number
  /** 12.8b：该格断补军力数（≥ 阈值时 +修正） */
  oosSteps: number
  /** 引擎给出的修正后骰值（`AttritionLookup.modifiedDice`） */
  modifiedDice: number
  /** 断补堆叠中最高行动值（12.8b 取列依据；缺省不展示） */
  bestAr?: number
}

/** 12.8b 损耗表掷骰复核（判定条件与 `attritionLookup` 一致，常量同源 `ATTRITION_DRM`） */
export function attritionDerivation(input: AttritionDerivationInput): Derivation {
  const value = attritionDrmFor(input.oosSteps)
  const steps: DerivationStep[] = [
    diceStep({
      label: '损耗掷骰',
      rule: '12.8b',
      source: '每格断补单位各掷两枚骰',
      rolls: input.roll === null ? NO_ROLLS : [input.roll],
    }),
    modifierStep({
      label: `断补军力 ${input.oosSteps} 步（阈值 ≥${ATTRITION_DRM.minSteps}）`,
      rule: '12.8b',
      source: value === 0 ? '未达阈值，不加修正' : '达到阈值，掷骰加修正',
      value,
    }),
    {
      kind: 'subtotal',
      label: '修正后骰值',
      rule: '12.8b',
      value: input.modifiedDice,
      formula: `${input.die} ${formatSigned(value)}`,
    },
  ]
  if (input.bestAr !== undefined) {
    steps.push(
      factStep({
        label: '取列',
        rule: '12.8b',
        source: '按格中断补单位中最高行动值取列（DG 不修正，12.8c）',
        text: String(input.bestAr),
      }),
    )
  }
  steps.push(
    lookupStep({
      label: '查损耗表',
      rule: '12.8b',
      table: '损耗表 12.8b',
      row: input.modifiedDice,
    }),
  )
  return { title: '损耗掷骰（12.8b）', rule: '12.8b', steps }
}

/* ────────────────────────────── 专规 1.5 天气 / 2.3 先手 ────────────────────────────── */

/**
 * 专规 1.5 天气判定复核
 *
 * 首回合由剧本指定（不掷骰）；此后掷 1 骰查天气表：1 = 受限飞行、2–6 = 正常飞行。
 * `air` 取引擎 `resolveTurnWeather` 的结论，本构造器**不重查表**。
 */
export function weatherDerivation(input: {
  /** 1d6 掷骰；首回合为 null（剧本指定） */
  roll: DiceRoll | null
  /** 引擎给出的空中条件 */
  air: 'normal' | 'limited'
  /** 是否首回合（剧本指定） */
  specified: boolean
}): Derivation {
  const steps: DerivationStep[] = []
  if (input.specified) {
    steps.push(
      factStep({
        label: '首回合天气',
        rule: '1.5',
        source: '由剧本指定（首回合不掷骰）',
        text: input.air === 'normal' ? '正常飞行' : '受限飞行',
      }),
    )
  } else {
    steps.push(
      diceStep({
        label: '天气掷骰',
        rule: '1.5',
        source: '每回合 1 骰',
        rolls: input.roll === null ? NO_ROLLS : [input.roll],
      }),
    )
    steps.push(
      lookupStep({
        label: '查天气表',
        rule: '1.5',
        table: '天气表',
        ...(input.roll === null ? {} : { row: input.roll.total }),
      }),
    )
  }
  steps.push(
    resultStep({
      label: '空中条件',
      rule: '1.5',
      value:
        input.air === 'normal'
          ? '正常飞行（受限飞行限制不适用）'
          : '受限飞行（反应/进击段禁飞、禁低空扫射）',
    }),
  )
  return { title: '天气判定（1.5）', rule: '1.5', steps }
}

/**
 * 2.3 先手判定复核
 *
 * 常规回合双方各掷 2d6，点数高者为胜者并**选择**先手或后手（平局重掷；房规 4.2a 时判胜）。
 * 首回合由剧本指定。
 */
export function initiativeDerivation(input: {
  /** 首回合指定先手（此时不掷骰） */
  specifiedFirstPlayer?: 'axis' | 'soviet'
  axisRoll?: DiceRoll | null
  sovietRoll?: DiceRoll | null
  /** 引擎给出的胜者（chooser） */
  chooser?: 'axis' | 'soviet'
  /** 重掷次数 */
  rerolls?: number
}): Derivation {
  const sideName = (side: 'axis' | 'soviet'): string => (side === 'axis' ? '轴心国' : '苏联')

  if (input.specifiedFirstPlayer !== undefined) {
    return {
      title: '先手判定（2.3）',
      rule: '2.3',
      steps: [
        factStep({
          label: '首回合先手',
          rule: '2.3',
          source: '由剧本指定（首回合不掷骰）',
          text: sideName(input.specifiedFirstPlayer),
        }),
        resultStep({
          label: '先手方',
          rule: '2.3',
          value: sideName(input.specifiedFirstPlayer),
        }),
      ],
    }
  }

  const steps: DerivationStep[] = [
    diceStep({
      label: '轴心国掷骰',
      rule: '2.3',
      source: '常规回合双方各掷 2d6',
      rolls: input.axisRoll == null ? NO_ROLLS : [input.axisRoll],
    }),
    diceStep({
      label: '苏联掷骰',
      rule: '2.3',
      source: '常规回合双方各掷 2d6',
      rolls: input.sovietRoll == null ? NO_ROLLS : [input.sovietRoll],
    }),
  ]
  if ((input.rerolls ?? 0) > 0) {
    steps.push(
      factStep({
        label: '重掷',
        rule: '2.3',
        source: '平局重掷（房规 4.2a 时由指定方判胜）',
        text: `${input.rerolls} 次`,
      }),
    )
  }
  if (input.chooser !== undefined) {
    steps.push(
      resultStep({
        label: '胜者（先手/后手由其选择）',
        rule: '2.3',
        value: sideName(input.chooser),
      }),
    )
  }
  return { title: '先手判定（2.3）', rule: '2.3', steps }
}
