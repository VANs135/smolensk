import { describe, expect, it } from 'vitest'

import { mapConfig, rulesConstants } from '@/data'
import {
  AIR_COMBAT_ATTACKER_ABORT_MAX_DICE,
  AIR_COMBAT_BOTH_ABORT_DICE,
  AIR_COMBAT_LOSS_NO_LOSS_MAX_DICE,
  airBoxRefitCapacity,
  baseTransferMaxRange,
  canHipShoot,
  checkPanzerGroupSpPayment,
  checkSecurityNeeds,
  hedgehogCombatDrm,
  isAirMissionAllowedInPhase,
  refitCapacity,
  refitEligibility,
  resolveWeather,
  splitSupplyTableSp,
  type PanzerGroupBoundary,
} from '@/engine/rules'
import { boundarySideOf } from '@/engine/rules'
import {
  airCombatLookup,
  airCombatLossRoll,
  ATTRITION_AR_COLUMNS,
  ATTRITION_DRM,
  attritionColumnIndex,
  attritionLookup,
  clampColumnIndex,
  crtLookup,
  HEDGEHOG_SURPRISE_DRM,
  isFreeSpecialReplEligible,
  parseAttritionCell,
  resolveSurprise,
  specialReplRoll,
  surpriseColumnShift,
} from '@/engine/tables'
import { evaluateDecisiveVictory, evaluateFinalVictory } from '@/engine/rules/victory'
import { BASELINE_SEED } from './regression-harness'

/**
 * W7 D3 回归基线 · **逐规则用例**（一个条款一段，测试名带规则编号）
 *
 * ## 这份文件与「引擎单测」的分工
 *   `tests/engine/**` 是**模块级**单测（改哪个模块跑哪个）；
 *   本文件是**条款级基线**：每条只钉住「规则书怎么说的 ⇒ 引擎就得怎么算」这一对照关系，
 *   覆盖全局最容易在重构中悄悄漂移的条款（取表 / 阈值 / 额度 / 归属 / 胜利），
 *   故它**不重复**模块内部实现细节，只断言规则语义。
 *
 * ## 取数纪律
 *   期望值一律来自 `rules-constants.json` / 表数据或规则书明文（如「奇数点归 Guderian」），
 *   不写第二份魔法数字；确需冻结的常量（如「−等级」的工事修正）在注释里给出条文出处。
 */

/** 3.4a 的真实分界线（产品数据 `map-config.panzerGroupBoundary` 第一段） */
const BOUNDARY: PanzerGroupBoundary = (() => {
  const pair = mapConfig.panzerGroupBoundary?.[0]
  if (pair === undefined) throw new Error('产品数据缺 panzerGroupBoundary（3.4a 无从判侧）')
  const [west, east] = pair
  if (west === undefined || east === undefined) throw new Error('分界线端点缺失')
  return { west: { ...west }, east: { ...east } }
})()

const HEX = (col: number, row: number) => ({ col, row })

/* ────────────────────────────── 1.5 / 1.4a 天气与图外盒 ────────────────────────────── */

describe('W7 D3 逐规则：1.5 天气判定（专规 1.5）', () => {
  it('1.5：掷 1 骰，≤ 限飞阈值 = Limited Flight，其余 Normal；地面条件恒 good', () => {
    const maxLimited = rulesConstants.smolensk.weather.limitedFlightMaxDice
    expect(resolveWeather(1).isLimited).toBe(true)
    expect(resolveWeather(1).air).toBe('limited')
    expect(resolveWeather(maxLimited).isLimited).toBe(true)
    expect(resolveWeather(maxLimited + 1).isLimited).toBe(false)
    expect(resolveWeather(6).air).toBe('normal')
    expect(resolveWeather(1).ground).toBe('good')
    expect(resolveWeather(6).ground).toBe('good')
  })

  it('1.5：骰面越界即抛（不做静默兜底）', () => {
    expect(() => resolveWeather(0)).toThrow()
    expect(() => resolveWeather(7)).toThrow()
    expect(() => resolveWeather(2.5)).toThrow()
  })

  it('1.5：Limited Flight 下 Reaction / Exploitation 禁飞、Movement 仍可；Hip Shoot 禁行', () => {
    const limited = resolveWeather(1)
    const normal = resolveWeather(6)
    expect(isAirMissionAllowedInPhase(limited, 'movement')).toBe(true)
    expect(isAirMissionAllowedInPhase(limited, 'reaction')).toBe(false)
    expect(isAirMissionAllowedInPhase(limited, 'exploitation')).toBe(false)
    expect(isAirMissionAllowedInPhase(normal, 'reaction')).toBe(true)
    // 低空扫射：口径唯一在 `canHipShoot`（天气 + 专规 2.2a/3.2a），不再有"只看天气"的第二个实现
    expect(canHipShoot('axis', limited.air === 'normal')).toBe(false)
    expect(canHipShoot('axis', normal.air === 'normal')).toBe(true)
  })
})

describe('W7 D3 逐规则：1.4a 图外空军盒（专规 1.4a / 3.5）', () => {
  it('1.4a：图外空军盒**容量无限且免费**整备（与基地的 1T/次 不同）', () => {
    const box = airBoxRefitCapacity()
    expect(box.unlimited).toBe(true)
    expect(box.capacity).toBe(Number.POSITIVE_INFINITY)
    expect(box.costT).toBe(0)
  })
})

/* ────────────────────────────── 3.4 / 3.4a / 3.4b 装甲集群 ────────────────────────────── */

describe('W7 D3 逐规则：3.4a 装甲集群分界线（专规 3.4a）', () => {
  it('3.4a：分界线两端点判为「在线上」；线以北 = north、线以南 = south', () => {
    expect(boundarySideOf(BOUNDARY.west, BOUNDARY)).toBe('onLine')
    expect(boundarySideOf(BOUNDARY.east, BOUNDARY)).toBe('onLine')
    // 取分界线中段列，同一列上抬/下压若干行即可稳定分侧
    const col = Math.round((BOUNDARY.west.col + BOUNDARY.east.col) / 2)
    const span = BOUNDARY.east.col - BOUNDARY.west.col
    const t = (col - BOUNDARY.west.col) / span
    const lineRow = BOUNDARY.west.row + t * (BOUNDARY.east.row - BOUNDARY.west.row)
    expect(boundarySideOf(HEX(col, Math.ceil(lineRow) + 5), BOUNDARY)).toBe('north')
    expect(boundarySideOf(HEX(col, Math.floor(lineRow) - 5), BOUNDARY)).toBe('south')
  })
})

describe('W7 D3 逐规则：3.4b 装甲集群补给限制（专规 3.4b）', () => {
  it('3.4b：Supply Table 到货**均分**两集群，**奇数点归 Guderian**', () => {
    expect(splitSupplyTableSp(7)).toEqual({ hoth: 3, guderian: 4 })
    expect(splitSupplyTableSp(6)).toEqual({ hoth: 3, guderian: 3 })
    expect(splitSupplyTableSp(1)).toEqual({ hoth: 0, guderian: 1 })
    expect(splitSupplyTableSp(0)).toEqual({ hoth: 0, guderian: 0 })
    // 负数按 0 处理（不产生负补给）
    expect(splitSupplyTableSp(-5)).toEqual({ hoth: 0, guderian: 0 })
  })

  it('3.4b：「错误」集群的 SP 不得支付多单位编队的燃油 / 战斗 / 轰炸；其它用途不受限', () => {
    const before = rulesConstants.smolensk.panzerGroupConstraintEnd
    const date = '1941-07-22' // 早于约束失效日 ⇒ 3.4/3.4b 生效
    expect(date < before).toBe(true)

    for (const purpose of ['fuel', 'combat', 'barrage'] as const) {
      // 错的集群 ⇒ 拒
      const wrong = checkPanzerGroupSpPayment({
        agreedByConsensus: true,
        spGroup: 'hoth',
        formationGroup: 'guderian',
        purpose,
        date,
        inMultiUnitFormation: true,
      })
      expect(wrong.ok).toBe(false)
      expect(wrong.rule).toBe('3.4b')
      // 对的集群 ⇒ 允
      expect(
        checkPanzerGroupSpPayment({
          agreedByConsensus: true,
          spGroup: 'guderian',
          formationGroup: 'guderian',
          purpose,
          date,
          inMultiUnitFormation: true,
        }).ok,
      ).toBe(true)
    }

    // 其它用途（不属燃油/战斗/轰炸）⇒ 不受集群限制
    expect(
      checkPanzerGroupSpPayment({
        agreedByConsensus: true,
        spGroup: 'hoth',
        formationGroup: 'guderian',
        purpose: 'other',
        date,
        inMultiUnitFormation: true,
      }).ok,
    ).toBe(true)

    // 非多单位编队（步兵师 / 独立单位）⇒ 完全不受 3.4 约束
    expect(
      checkPanzerGroupSpPayment({
        agreedByConsensus: true,
        spGroup: 'hoth',
        formationGroup: null,
        purpose: 'fuel',
        date,
        inMultiUnitFormation: false,
      }).ok,
    ).toBe(true)
  })

  it('3.4b：约束在 19 August 起失效；未归属的新 SP 一律须先归属集群', () => {
    const end = rulesConstants.smolensk.panzerGroupConstraintEnd
    expect(
      checkPanzerGroupSpPayment({
        agreedByConsensus: true,
        spGroup: 'hoth',
        formationGroup: 'guderian',
        purpose: 'combat',
        date: end,
        inMultiUnitFormation: true,
      }).ok,
    ).toBe(true)
    const unassigned = checkPanzerGroupSpPayment({
      agreedByConsensus: true,
      spGroup: null,
      formationGroup: 'guderian',
      purpose: 'combat',
      date: '1941-07-22',
      inMultiUnitFormation: true,
      unassigned: true,
    })
    expect(unassigned.ok).toBe(false)
    if (unassigned.ok) throw new Error('未归属的新 SP 应当被拒（3.4b）')
    expect(unassigned.reason).toBe('newSpMustBeAssignedToAPanzerGroup')
  })
})

/* ────────────────────────────── 9.8 / 9.9 战斗表与奇袭 ────────────────────────────── */

describe('W7 D3 逐规则：9.8 奇袭表（9.8 + 9.6 DRM）', () => {
  it('9.8：常规战斗行 —— ≥10 攻方奇袭、≤5 守方奇袭、6–9 无奇袭', () => {
    const at = (die: number) =>
      resolveSurprise({ die, arDifferential: 0, attackType: 'regular' }).side
    expect(at(12)).toBe('attacker')
    expect(at(10)).toBe('attacker')
    expect(at(9)).toBeNull()
    expect(at(6)).toBeNull()
    expect(at(5)).toBe('defender')
    expect(at(2)).toBe('defender')
  })

  it('9.8：突袭行与常规行**表不同** —— 突袭 ≥9 攻方、≤6 守方、7–8 无', () => {
    const at = (die: number) =>
      resolveSurprise({ die, arDifferential: 0, attackType: 'overrun' }).side
    expect(at(9)).toBe('attacker')
    expect(at(8)).toBeNull()
    expect(at(7)).toBeNull()
    expect(at(6)).toBe('defender')
  })

  it('9.8：★ 环形工事任意等级都是 −1（与 9.9 的完整等级修正分开）', () => {
    expect(HEDGEHOG_SURPRISE_DRM).toBe(-1)
    // 修正后 10 − 1 = 9 ⇒ 常规行不再发生攻方奇袭
    expect(
      resolveSurprise({
        die: 10,
        arDifferential: 0,
        attackType: 'regular',
        defenderInHedgehog: true,
      }).side,
    ).toBeNull()
    expect(resolveSurprise({ die: 10, arDifferential: 0, attackType: 'regular' }).side).toBe(
      'attacker',
    )
  })

  it('9.8：9.6 的 AR 差作为 DRM 加在掷骰上（攻方 AR 高 ⇒ 更易奇袭）', () => {
    const base = resolveSurprise({ die: 9, arDifferential: 0, attackType: 'regular' })
    const boosted = resolveSurprise({ die: 9, arDifferential: 2, attackType: 'regular' })
    expect(base.side).toBeNull()
    expect(boosted.modifiedDice).toBe(11)
    expect(boosted.drm).toBe(2)
    expect(boosted.side).toBe('attacker')
  })

  it('9.8：奇袭后的列横移 —— 攻方向右（正）、守方向左（负）、无奇袭为 0', () => {
    expect(surpriseColumnShift({ side: 'attacker', shiftDie: 3 }).shift).toBe(3)
    expect(surpriseColumnShift({ side: 'defender', shiftDie: 3 }).shift).toBe(-3)
    expect(surpriseColumnShift({ side: null }).shift).toBe(0)
    // 发生奇袭却没给横移骰 ⇒ 抛错（不默认成 0）
    expect(() => surpriseColumnShift({ side: 'attacker' })).toThrow()
  })

  it('9.1g / 9.7b：横移或初始 odds 越界 ⇒ 夹取到表内边界列', () => {
    expect(clampColumnIndex(20, 13)).toEqual({ index: 12, clamped: true, rule: '9.1g' })
    expect(clampColumnIndex(-3, 13)).toEqual({ index: 0, clamped: true, rule: '9.1g' })
    expect(clampColumnIndex(5, 13)).toEqual({ index: 5, clamped: false, rule: '9.1g' })
    expect(() => clampColumnIndex(1, 0)).toThrow()
  })
})

describe('W7 D3 逐规则：9.9 CRT 取表（9.9）—— 明细见 crt-golden.test.ts', () => {
  it('9.9：列位由地形类决定（同一 odds 在不同地形落不同列）', () => {
    const extr = crtLookup(8, 'Extr Close', '3:1')
    const open = crtLookup(8, 'Open', '3:1')
    // 四类地形的列位表不同 ⇒ 同一 odds 的列下标不同（9.7 按地形取列）
    expect(extr.columnIndex).toBe(3)
    expect(open.columnIndex).toBeGreaterThan(extr.columnIndex)
    expect(extr.columnLabel).toBe('3:1')
    expect(open.columnLabel).toBe('3:1')
  })
})

/* ────────────────────────────── 12.8b 损耗表 ────────────────────────────── */

describe('W7 D3 逐规则：12.8b 断补损耗表（12.8b）', () => {
  it('12.8b：格值解析 —— No Loss / −N Steps / −All Steps', () => {
    expect(parseAttritionCell('No Loss')).toEqual({ kind: 'steps', steps: 0 })
    expect(parseAttritionCell('-2 Steps')).toEqual({ kind: 'steps', steps: 2 })
    expect(parseAttritionCell('-All Steps')).toEqual({ kind: 'allSteps' })
    expect(() => parseAttritionCell('?')).toThrow()
  })

  it('12.8b：列位按**最高行动值**取（5 为最强列、0 为最弱列），越界夹取', () => {
    expect(ATTRITION_AR_COLUMNS[0]).toBe('5')
    expect(attritionColumnIndex(5)).toBe(0)
    expect(attritionColumnIndex(99)).toBe(0)
    expect(attritionColumnIndex(0)).toBe(ATTRITION_AR_COLUMNS.length - 1)
    expect(attritionColumnIndex(-3)).toBe(ATTRITION_AR_COLUMNS.length - 1)
  })

  it('12.8b：断补累计步数达阈值加 DRM（+3）；骰值越界即抛', () => {
    const withDrm = attritionLookup(5, 1, ATTRITION_DRM.minSteps)
    expect(withDrm.drm).toBe(ATTRITION_DRM.modifier)
    expect(withDrm.modifiedDice).toBe(5 + ATTRITION_DRM.modifier)
    const without = attritionLookup(5, 1, ATTRITION_DRM.minSteps - 1)
    expect(without.drm).toBe(0)
    expect(without.modifiedDice).toBe(5)
    // 结果必为可解析的格值（kind 合法）
    expect(['steps', 'allSteps']).toContain(without.result.kind)
    expect(() => attritionLookup(13, 1, 0)).toThrow()
    expect(() => attritionLookup(1, 1, 0)).toThrow()
  })
})

/* ────────────────────────────── 14.3e 空战 ────────────────────────────── */

describe('W7 D3 逐规则：14.3e 空战（14.3e）', () => {
  it('14.3e：修正骰 ≤6 攻方退出、=7 双方退出、≥8 守方退出', () => {
    expect(airCombatLookup(AIR_COMBAT_ATTACKER_ABORT_MAX_DICE)).toBe('attacker_aborts')
    expect(airCombatLookup(AIR_COMBAT_BOTH_ABORT_DICE)).toBe('both_abort')
    expect(airCombatLookup(AIR_COMBAT_BOTH_ABORT_DICE + 1)).toBe('defender_aborts')
    expect(airCombatLookup(2)).toBe('attacker_aborts')
  })

  it('14.3e：损失骰 1–4 无损失、5–6 军力损失（退出方各掷一次）', () => {
    expect(airCombatLossRoll(AIR_COMBAT_LOSS_NO_LOSS_MAX_DICE)).toBe('no_loss')
    expect(airCombatLossRoll(1)).toBe('no_loss')
    expect(airCombatLossRoll(AIR_COMBAT_LOSS_NO_LOSS_MAX_DICE + 1)).toBe('step_loss')
    expect(airCombatLossRoll(6)).toBe('step_loss')
  })
})

/* ────────────────────────────── 15.1 / 15.2 整备与基地 ────────────────────────────── */

describe('W7 D3 逐规则：15.1 / 15.2 / 14.11 空军基地（15.0 章）', () => {
  it('15.1B：容量＝等级 × 2、费用 1T（与等级和架数无关）；简易机场容量 1', () => {
    expect(refitCapacity({ level: 1 }).capacity).toBe(2)
    expect(refitCapacity({ level: 3 }).capacity).toBe(6)
    expect(refitCapacity({ isAirstrip: true }).capacity).toBe(1)
    expect(refitCapacity({ level: 3 }).costT).toBe(rulesConstants.air.refitTPerBase)
    expect(refitCapacity({ isAirstrip: true }).costT).toBe(rulesConstants.air.refitTPerBase)
  })

  it('15.1A / 15.1C / 15.1B：判定链顺序 —— 阶段 → 每基地一次 → ZOC → 容量 → T', () => {
    const ok = {
      level: 1,
      phase: 'aircraftRefit' as const,
      alreadyRefitThisPhase: false,
      inUnnegatedEnemyZoc: false,
      requestedAircraft: 1,
      availableT: 1,
    }
    expect(refitEligibility(ok).ok).toBe(true)

    const wrongPhase = refitEligibility({ ...ok, phase: 'movement' })
    expect(wrongPhase).toMatchObject({
      ok: false,
      rule: '15.1A',
      reason: 'refitOnlyInAircraftRefitPhase',
    })

    const twice = refitEligibility({ ...ok, alreadyRefitThisPhase: true })
    expect(twice).toMatchObject({ ok: false, rule: '15.1A', reason: 'baseAlreadyRefitThisPhase' })

    const inZoc = refitEligibility({ ...ok, inUnnegatedEnemyZoc: true })
    expect(inZoc).toMatchObject({ ok: false, rule: '15.1C', reason: 'unnegatedEnemyZoc' })

    const tooMany = refitEligibility({ ...ok, requestedAircraft: 3 })
    expect(tooMany).toMatchObject({ ok: false, rule: '15.1B', reason: 'refitCapacityExceeded:2' })

    const noT = refitEligibility({ ...ok, availableT: 0 })
    expect(noT).toMatchObject({ ok: false, rule: '15.1B', reason: 'insufficientRefitT' })
  })

  it('14.11：基地转移距离上限 = 战机航程 × 2', () => {
    expect(baseTransferMaxRange(7)).toBe(14)
    expect(baseTransferMaxRange(0)).toBe(0)
  })
})

/* ────────────────────────────── 16.0 环形工事 ────────────────────────────── */

describe('W7 D3 逐规则：16.0 环形工事（16.0d）', () => {
  it('16.0d：战斗掷骰修正 = −等级（0 级返回 +0，避免把 −0 带进运算）', () => {
    expect(hedgehogCombatDrm(0)).toBe(0)
    expect(hedgehogCombatDrm(1)).toBe(-1)
    expect(hedgehogCombatDrm(4)).toBe(-4)
  })
})

/* ────────────────────────────── 3.3b 治安需求 ────────────────────────────── */

describe('W7 D3 逐规则：3.3b 治安需求（专规 3.3b）', () => {
  it('3.3b：轴控城既无可攻击单位占据、也无轴方 ZOC ⇒ 放 Trainbusting 标记', () => {
    const outcome = checkSecurityNeeds([
      {
        hex: HEX(36, 13),
        name: 'Smolensk',
        controlledByAxis: true,
        occupiedByAttackCapable: false,
        coveredByAxisZoc: false,
        hasTrainbusting: false,
      },
    ])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.placeAt).toEqual([HEX(36, 13)])
    expect(outcome.data.removeAt).toEqual([])
  })

  it('3.3b：需求满足（占据或 ZOC 覆盖）⇒ 移除该格标记；非轴控城也一律移除', () => {
    const outcome = checkSecurityNeeds([
      {
        hex: HEX(36, 13),
        name: 'Smolensk',
        controlledByAxis: true,
        occupiedByAttackCapable: false,
        coveredByAxisZoc: true,
        hasTrainbusting: true,
      },
      {
        hex: HEX(37, 13),
        controlledByAxis: false,
        occupiedByAttackCapable: false,
        coveredByAxisZoc: false,
        hasTrainbusting: true,
      },
    ])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.placeAt).toEqual([])
    expect(outcome.data.removeAt).toEqual([HEX(36, 13), HEX(37, 13)])
  })
})

/* ────────────────────────────── 5.0a / 5.0b 胜利 ────────────────────────────── */

describe('W7 D3 逐规则：5.0a / 5.0b 胜利判定（5.0 章）', () => {
  it('5.0a：苏方控制全部所列格（含 Vyazma / Rzhev）⇒ 苏胜；全无控制 ⇒ Draw', () => {
    const soviet = evaluateFinalVictory({ scenarioId: '1', controlOf: () => 'soviet' })
    expect(soviet.level).toBe('final')
    expect(soviet.outcome).toBe('soviet')
    expect(soviet.winner).toBe('soviet')
    expect(soviet.rule).toBe('5.0a')

    const axis = evaluateFinalVictory({ scenarioId: '1', controlOf: () => 'axis' })
    expect(axis.outcome).toBe('axis')

    const none = evaluateFinalVictory({ scenarioId: '1', controlOf: () => null })
    expect(none.outcome).toBe('draw')
    expect(none.winner).toBeNull()
  })

  it('5.0b：早于起始日不做提前决胜检查；到期且条件达成即判该方 Decisive Win', () => {
    const start = rulesConstants.smolensk.earlyDecisionStart
    const before = evaluateDecisiveVictory({
      scenarioId: '1',
      date: '1941-07-08',
      controlOf: () => 'soviet',
    })
    expect(before.outcome).toBe('ongoing')
    expect(before.winner).toBeNull()

    const due = evaluateDecisiveVictory({
      scenarioId: '1',
      date: start,
      controlOf: () => 'soviet',
    })
    expect(due.level).toBe('decisive')
    expect(due.outcome).toBe('soviet')
    expect(due.rule).toBe('5.0b')

    // 未达成 ⇒ 「达成即结束」的检查 ⇒ 游戏继续（不判 Draw）
    const unmet = evaluateDecisiveVictory({
      scenarioId: '1',
      date: start,
      controlOf: () => null,
    })
    expect(unmet.outcome).toBe('ongoing')
  })

  it('5.0b：剧本 2 / 4 属 5.0a 明文例外（规则未给其提前决胜阈值）⇒ 不做检查', () => {
    const assessment = evaluateDecisiveVictory({
      scenarioId: '2',
      date: rulesConstants.smolensk.earlyDecisionStart,
      controlOf: () => 'soviet',
    })
    expect(assessment.outcome).toBe('ongoing')
    expect(assessment.thresholds).toBeNull()
    expect(assessment.detail).toContain('明文例外')
  })
})

/* ────────────────────────────── 1.6c 免费特殊补员 ────────────────────────────── */

describe('W7 D3 逐规则：1.6c 免费特殊补员（专规 1.6c）', () => {
  it('1.6c：只有 12-2-2 型步兵/民兵师可从死亡堆免费重建；13-3-3 等不在列', () => {
    expect(isFreeSpecialReplEligible(12, 2, 2)).toBe(true)
    expect(isFreeSpecialReplEligible(13, 3, 3)).toBe(false)
    expect(isFreeSpecialReplEligible(0, 0, 0)).toBe(false)
  })

  it('1.6c：特殊补员表对每个骰面都能取到一行（无数据洞）', () => {
    for (const die of [1, 2, 3, 4, 5, 6]) {
      const row = specialReplRoll('soviet', die)
      expect(row.label.length).toBeGreaterThan(0)
      expect(typeof row.kind).toBe('string')
      expect(row.kind.length).toBeGreaterThan(0)
    }
  })
})

/* ────────────────────────────── 基线夹具自查 ────────────────────────────── */

describe('W7 D3 逐规则：基线夹具自查', () => {
  it('W7 D3：基线种子为固定值（回归基线的可复算前提）', () => {
    expect(BASELINE_SEED).toBe(19410708)
    expect(Number.isInteger(BASELINE_SEED)).toBe(true)
    expect(BASELINE_SEED).toBeGreaterThan(0)
  })
})
