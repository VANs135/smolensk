import { describe, expect, it } from 'vitest'

import {
  AIR_MISSION_MAX_AIRCRAFT,
  AIR_MISSION_SEQUENCE,
  AIR_MISSION_STEP_IDS,
  BASE_TRANSFER_RANGE_MULTIPLIER,
  ENGINEERING_MIN_RE,
  INTERCEPTION_EXEMPT_FROM_WEATHER_AND_PHASE,
  airBoxRangeHexes,
  airBoxRefitCapacity,
  airBoxRules,
  airMissionStepIndex,
  baseTransferMaxRange,
  canAddAircraftAtStep,
  canEnterEdgeBox,
  canIntercept,
  canInterceptAgainSamePhase,
  canJoinMission,
  canPerformMissionThisPhase,
  canReduceAirBase,
  canVoluntarilyReturn,
  edgeBoxConnection,
  edgeBoxRules,
  interceptionPostCombatStatus,
  isCombatOrBarrageAllowedInOffMapBox,
  isEdgeBoxExitFuelFree,
  airUnloadLimitT,
  missionSegmentOf,
  planAirUnload,
  refitCapacity,
  refitEligibility,
  resolveBaseTransfer,
  type AirBaseOperatingUnit,
} from '@/engine/rules'

/**
 * 空军任务流程 / 整备 / 基地转移与缩减 / 地图外盒（W5 B16）条款级测试
 *
 * 断言依据：OCS 通规 14.2a / 14.2e / 14.2f / 14.3d / 14.5 / 14.11 / 15.1 / 15.2B / 15.4，
 * 以及 Smolensk 专规 1.4 / 1.4a / 1.4b（原版 PDF Smolensk_Rules_v1.1.pdf 第 1 页）。
 */

describe('14.2f 任务七步序列', () => {
  it('步骤顺序即规则要求的 A→G 结算顺序', () => {
    expect(AIR_MISSION_STEP_IDS).toEqual([
      'declare',
      'move',
      'airCombat',
      'interception',
      'flak',
      'resolveMission',
      'returnToBase',
    ])
    expect(AIR_MISSION_SEQUENCE.map((s) => s.step)).toEqual([...AIR_MISSION_STEP_IDS])
    expect(airMissionStepIndex('declare')).toBe(0)
    expect(airMissionStepIndex('returnToBase')).toBe(6)
  })

  it('14.2f 游戏说明：C 步骤（空战）之后不能再往任务里加飞机', () => {
    expect(canAddAircraftAtStep('declare')).toBe(true)
    expect(canAddAircraftAtStep('move')).toBe(true)
    expect(canAddAircraftAtStep('airCombat')).toBe(false)
    expect(canAddAircraftAtStep('interception')).toBe(false)
    expect(canAddAircraftAtStep('returnToBase')).toBe(false)
  })

  it('14.2a：一次任务的空军单位合计上限为 4', () => {
    expect(AIR_MISSION_MAX_AIRCRAFT).toBe(4)
    expect(canJoinMission(3).ok).toBe(true)
    const over = canJoinMission(4)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.reason).toContain('missionAircraftLimitExceeded')
    expect(canJoinMission(2, 3).ok).toBe(false)
  })
})

describe('14.2e 任务的执行时机', () => {
  it('14.2e：同一空军单位在一个阶段内只能执行一次任务', () => {
    expect(canPerformMissionThisPhase(0)).toBe(true)
    expect(canPerformMissionThisPhase(1)).toBe(false)
  })

  it('14.2e：各任务的执行环节（移动环节 / 轰炸环节 / 拦截插在敌方任务 D 步）', () => {
    expect(missionSegmentOf('hip_shoot')).toBe('movementSegment')
    expect(missionSegmentOf('fighter_sweep')).toBe('movementSegment')
    expect(missionSegmentOf('air_transport')).toBe('movementSegment')
    expect(missionSegmentOf('air_drop')).toBe('movementSegment')
    expect(missionSegmentOf('base_transfer')).toBe('movementSegment')
    expect(missionSegmentOf('barrage')).toBe('barrageSegment')
    expect(missionSegmentOf('trainbusting')).toBe('barrageSegment')
    expect(missionSegmentOf('interception')).toBe('interceptStep')
  })
})

describe('14.3d 主动返航窗口', () => {
  it('14.3d-A：空战开始前可返航部分飞机，但须至少留 1 架继续战斗', () => {
    expect(
      canVoluntarilyReturn({ window: 'beforeAirCombat', friendlyActiveRemainingAfterReturn: 1 }).ok,
    ).toBe(true)
    const none = canVoluntarilyReturn({
      window: 'beforeAirCombat',
      friendlyActiveRemainingAfterReturn: 0,
    })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.reason).toBe('mustKeepOneActiveUnitInCombat')
  })

  it('14.3d-B：空战开始后双方都不能返航', () => {
    const blocked = canVoluntarilyReturn({
      window: 'duringAirCombat',
      friendlyActiveRemainingAfterReturn: 3,
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('noVoluntaryReturnDuringAirCombat')
  })

  it('14.3d-C：空战完全结束后可主动返航（无留存要求）', () => {
    expect(
      canVoluntarilyReturn({ window: 'afterAirCombat', friendlyActiveRemainingAfterReturn: 0 }).ok,
    ).toBe(true)
  })
})

describe('14.5 拦截', () => {
  const base = {
    missionKind: 'barrage' as const,
    missionHexInPatrolZone: true,
    hasActiveFighterInPatrolZone: true,
    alreadyIntercepted: false,
  }

  it('14.5：受防空影响且任务格在巡逻区内、有激活战斗机 ⇒ 可拦截（一次一架）', () => {
    const r = canIntercept(base)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.interceptorCount).toBe(1)
  })

  it('14.5：每个任务只能被拦截一次', () => {
    const r = canIntercept({ ...base, alreadyIntercepted: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missionAlreadyIntercepted')
  })

  it('14.5：任务格不在巡逻区内不可拦截', () => {
    const r = canIntercept({ ...base, missionHexInPatrolZone: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missionHexOutsidePatrolZone')
  })

  it('14.4a：战机扫荡与拦截本身永不受防空影响 ⇒ 不可被拦截', () => {
    const sweep = canIntercept({ ...base, missionKind: 'fighter_sweep' })
    expect(sweep.ok).toBe(false)
    if (!sweep.ok) expect(sweep.reason).toContain('missionNotFlakAffected')

    const intercept = canIntercept({ ...base, missionKind: 'interception' })
    expect(intercept.ok).toBe(false)
  })

  it('14.5：没有可用的激活战斗机则不可拦截', () => {
    const r = canIntercept({ ...base, hasActiveFighterInPatrolZone: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('noActiveFighterInPatrolZone')
  })

  it('14.5：拦截胜 ⇒ 返回基地保持激活且同阶段可再拦；败 ⇒ 非激活', () => {
    expect(interceptionPostCombatStatus(true)).toBe('active')
    expect(interceptionPostCombatStatus(false)).toBe('inactive')
    expect(canInterceptAgainSamePhase(true)).toBe(true)
    expect(canInterceptAgainSamePhase(false)).toBe(false)
  })

  it('14.5 重要提示：拦截永不受专规天气与阶段限制', () => {
    expect(INTERCEPTION_EXEMPT_FROM_WEATHER_AND_PHASE).toBe(true)
  })
})

describe('14.11 基地转移', () => {
  it('14.11：转移距离可增加一倍（射程 ×2）', () => {
    expect(BASE_TRANSFER_RANGE_MULTIPLIER).toBe(2)
    expect(baseTransferMaxRange(6)).toBe(12)
  })

  it('14.11：战斗机在正常距离内转移 ⇒ 保持激活', () => {
    const r = resolveBaseTransfer({ isFighter: true, rangeHexes: 6, distanceHexes: 6 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.airStatus).toBe('active')
      expect(r.data.maxDistanceHexes).toBe(12)
    }
  })

  it('14.11：战斗机超出正常距离但在 2 倍内 ⇒ 非激活', () => {
    const r = resolveBaseTransfer({ isFighter: true, rangeHexes: 6, distanceHexes: 7 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.airStatus).toBe('inactive')
  })

  it('14.11：超过 2 倍射程 ⇒ 不可转移', () => {
    const r = resolveBaseTransfer({ isFighter: true, rangeHexes: 6, distanceHexes: 13 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('beyondDoubleRange')
  })

  it('14.11：非战斗机即便在正常距离内也一律变为非激活', () => {
    const r = resolveBaseTransfer({ isFighter: false, rangeHexes: 6, distanceHexes: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.airStatus).toBe('inactive')
  })
})

describe('15.1 / 15.2B / 专规 1.4a 整备额度', () => {
  it('15.1B：基地容量 = 等级 × 2，费用固定 1T', () => {
    expect(refitCapacity({ level: 3 })).toEqual({ capacity: 6, unlimited: false, costT: 1 })
    expect(refitCapacity({ level: 1 }).capacity).toBe(2)
  })

  it('15.2B：简易机场每阶段只整备 1 架', () => {
    expect(refitCapacity({ isAirstrip: true })).toEqual({ capacity: 1, unlimited: false, costT: 1 })
  })

  it('专规 1.4a：图外空军盒无限驻机、免费整备', () => {
    const box = airBoxRefitCapacity()
    expect(box.unlimited).toBe(true)
    expect(box.capacity).toBe(Number.POSITIVE_INFINITY)
    expect(box.costT).toBe(0)
  })
})

describe('15.1 整备资格', () => {
  const ok = {
    phase: 'aircraftRefit' as const,
    level: 2,
    alreadyRefitThisPhase: false,
    inUnnegatedEnemyZoc: false,
    requestedAircraft: 4,
    availableT: 1,
  }

  it('15.1A：整备只在飞机整备阶段进行', () => {
    const r = refitEligibility({ ...ok, phase: 'movement' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('refitOnlyInAircraftRefitPhase')
  })

  it('15.1A：每个空军基地每整备阶段只能整备一次', () => {
    const r = refitEligibility({ ...ok, alreadyRefitThisPhase: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('baseAlreadyRefitThisPhase')
  })

  it('15.1C：未抵消的敌方 ZOC 内不可整备', () => {
    const r = refitEligibility({ ...ok, inUnnegatedEnemyZoc: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unnegatedEnemyZoc')
  })

  it('15.1B：超过等级 ×2 的飞机数不可整备', () => {
    const r = refitEligibility({ ...ok, requestedAircraft: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('refitCapacityExceeded')
  })

  it('15.1B：T 不足则不可整备', () => {
    const r = refitEligibility({ ...ok, availableT: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('insufficientRefitT')
  })

  it('15.1：条件齐备则整备成功，返回容量与费用', () => {
    const r = refitEligibility(ok)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ capacity: 4, unlimited: false, costT: 1 })
  })

  it('15.1D：天气从不禁止整备（判定无天气入参）', () => {
    // 专规 1.5 的受限飞行只在 weather.ts 约束任务，不影响整备
    const r = refitEligibility(ok)
    expect(r.ok).toBe(true)
  })

  it('专规 1.4a：图外空军盒免费整备任意架数', () => {
    const r = refitEligibility({
      ...ok,
      isAirBox: true,
      requestedAircraft: 99,
      availableT: 0,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.costT).toBe(0)
  })
})

describe('15.4 / 15.0c 空军基地缩减', () => {
  /** 作业单位：在目标格内被**指定**执行缩减的那一小队单位（用户 2026-09-13 裁定的「1RE 的单位」口径） */
  const op = (over: Partial<AirBaseOperatingUnit> = {}): AirBaseOperatingUnit => ({
    id: 'u1',
    re: 1,
    mode: 'combat',
    movedThisPhase: false,
    ...over,
  })
  const ok = {
    phase: 'movement' as const,
    currentLevel: 2,
    operatingUnits: [op()],
    alreadyReducedThisPhase: false,
  }

  it('15.4：格内 1RE 战斗模式单位、未移动 ⇒ 可缩减 1 级', () => {
    expect(ENGINEERING_MIN_RE).toBe(1)
    const r = canReduceAirBase(ok)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.levelAfter).toBe(1)
      expect(r.data.immobileUnitIds).toEqual(['u1'])
    }
  })

  it('15.4：只在移动阶段可缩减', () => {
    const r = canReduceAirBase({ ...ok, phase: 'reaction' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('reductionOnlyInMovementPhase')
  })

  it('15.4：同一基地每阶段只能缩减一次', () => {
    const r = canReduceAirBase({ ...ok, alreadyReducedThisPhase: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('baseAlreadyReducedThisPhase')
  })

  it('15.0c：永远不能降到低于 1 级', () => {
    const r = canReduceAirBase({ ...ok, currentLevel: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('airBaseLevelCannotGoBelowOne')
  })

  it('15.4：被指定单位已移动 / 非战斗模式 / 合计不足 1 RE ⇒ 拒绝', () => {
    expect(
      canReduceAirBase({ ...ok, operatingUnits: [op({ movedThisPhase: true })] }),
    ).toMatchObject({
      ok: false,
      reason: 'reducingUnitAlreadyMoved:u1',
    })
    expect(canReduceAirBase({ ...ok, operatingUnits: [op({ mode: 'move' })] })).toMatchObject({
      ok: false,
      reason: 'reducingUnitMustBeCombatMode:u1',
    })
    // 单个 1/2 RE 拆分连单独被指定 ⇒ 合计不足
    expect(canReduceAirBase({ ...ok, operatingUnits: [op({ re: 0.5 })] })).toMatchObject({
      ok: false,
      reason: 'reducingUnitsReBelowMinimum:0.5',
    })
    // 未指定任何单位
    expect(canReduceAirBase({ ...ok, operatingUnits: [] })).toMatchObject({
      ok: false,
      reason: 'reducingUnitNotEligible',
    })
  })

  it('15.4：★ 只约束被指定的单位；数个营里只派两个动手', () => {
    // 同格三个营，只指定其中两个（合计 1 RE）⇒ 只有这两个营本阶段不能再移动，第三个营照常
    const r = canReduceAirBase({
      ...ok,
      operatingUnits: [op({ id: 'bn-1', re: 0.5 }), op({ id: 'bn-2', re: 0.5 })],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.immobileUnitIds).toEqual(['bn-1', 'bn-2'])
  })

  it('15.4：被指定者中含具工程能力的单位 ⇒ 替代 RE 门槛（13.8d）', () => {
    const r = canReduceAirBase({
      ...ok,
      operatingUnits: [op({ id: 'eng', re: 0.4, engineerCapable: true })],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.immobileUnitIds).toEqual(['eng'])
  })
})

describe('专规 1.4 地图外盒与边缘盒', () => {
  it('1.4：盒内不允许战斗或轰炸', () => {
    expect(isCombatOrBarrageAllowedInOffMapBox()).toBe(false)
    expect(airBoxRules().combatOrBarrageAllowed).toBe(false)
  })

  it('1.4a：图外空军盒射程（苏 20 / 轴 30）与无限容量、免费整备', () => {
    expect(airBoxRangeHexes('soviet')).toBe(20)
    expect(airBoxRangeHexes('axis')).toBe(30)
    const rules = airBoxRules()
    expect(rules.infiniteCapacity).toBe(true)
    expect(rules.freeRefitPerTurn).toBe(true)
    expect(rules.extraSpFlownByAirTransport).toBe(true)
  })

  it('1.4b：边缘盒连接范围（东北连北＋东、东南连南＋东）', () => {
    expect(edgeBoxConnection('northeast')).toBe('northAndEast')
    expect(edgeBoxConnection('southeast')).toBe('southAndEast')
  })

  it('1.4b：盒内含追溯补给，但图上单位不得从中取补；进入即停；离开免费加油', () => {
    const rules = edgeBoxRules()
    expect(rules.hasTraceSupply).toBe(true)
    expect(rules.onMapUnitsCanDraw).toBe(false)
    expect(rules.mustStopOnEntry).toBe(true)
    expect(rules.exitFuelsFree).toBe(true)
    expect(rules.retreatAllowed).toBe(false)
    expect(isEdgeBoxExitFuelFree()).toBe(true)
  })

  it('1.4b：仅苏方地面单位在移动阶段从地图边缘补给源格进出', () => {
    const ok = canEnterEdgeBox({
      side: 'soviet',
      phase: 'movement',
      unitKind: 'ground',
      fromSupplySourceHex: true,
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.data.entryMp).toBe(1)
      expect(ok.data.allowsRailCap).toBe(true)
    }

    expect(
      canEnterEdgeBox({
        side: 'axis',
        phase: 'movement',
        unitKind: 'ground',
        fromSupplySourceHex: true,
      }).ok,
    ).toBe(false)
    expect(
      canEnterEdgeBox({
        side: 'soviet',
        phase: 'movement',
        unitKind: 'air',
        fromSupplySourceHex: true,
      }).ok,
    ).toBe(false)
    expect(
      canEnterEdgeBox({
        side: 'soviet',
        phase: 'reaction',
        unitKind: 'ground',
        fromSupplySourceHex: true,
      }).ok,
    ).toBe(false)
    expect(
      canEnterEdgeBox({
        side: 'soviet',
        phase: 'movement',
        unitKind: 'ground',
        fromSupplySourceHex: false,
      }).ok,
    ).toBe(false)
  })
})

/* ────────── 15.0b-C / 14.9f / 15.2C：空运卸载上限 ────────── */

/**
 * 「15.0b-C：每个移动环节中，只能卸载 空军基地**等级×2T** 数量的货物……」；
 * 「15.2C：（简易机场）每个移动环节中，它们的**卸载容量上限为 2T**」；
 * 「14.9f：……如果货物超过此限额，**如果超出部分对应的运输机在目的地格变为非激活状态**，
 *   则可以卸载超额部分的货物」；「15.0b-C：……或者**是空投或滑翔机行动，则无限制**。装载货物没有限制。」
 *
 * ★ 本组钉的是**接线**：修前 `unloadTPerLevelPerPhase` 常量在数据层与 schema 里都声明了，但**全库零消费**
 *   ⇒ 同一个基地、同一个移动环节可以**无限**卸载空运来的 SP（那条规则等于不存在）。
 * 测法边界：本组只测引擎判据（上限/余额/例外）；"落地后 SP 真的进了账本 + 台账跨环节清零"由
 *   `tests/stores/air-unload-limit-flow.test.ts` 覆盖。
 */
describe('15.0b-C / 14.9f：空运卸载上限（等级×2T；简易机场 2T；空投无限制）', () => {
  it('上限 = 等级 × 2T；简易机场按 1 级算（15.2C 明示 2T）', () => {
    expect(airUnloadLimitT({ baseLevel: 1, isAirstrip: false })).toBe(2)
    expect(airUnloadLimitT({ baseLevel: 3, isAirstrip: false })).toBe(6)
    expect(airUnloadLimitT({ baseLevel: 0, isAirstrip: false })).toBe(0)
    expect(airUnloadLimitT({ baseLevel: 0, isAirstrip: true })).toBe(2)
  })

  it('14.9f：可用余额 = 上限 − 本格本环节已卸量；超出的部分被拒并如实报出', () => {
    const plan = planAirUnload({
      kind: 'air_transport',
      baseLevel: 2,
      isAirstrip: false,
      usedT: 3,
      cargoT: 2,
      overLimitAircraftInactive: false,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data).toMatchObject({ allowedT: 1, refusedT: 1, limitT: 4, rule: '14.9f' })
    expect(plan.data.detail).toContain('不能卸载')
  })

  it('14.9f / 14.9e-A：超出部分由**在目的地变非激活**的运输机承运 ⇒ 允许一并卸载', () => {
    const plan = planAirUnload({
      kind: 'air_transport',
      baseLevel: 2,
      isAirstrip: false,
      usedT: 3,
      cargoT: 2,
      overLimitAircraftInactive: true,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data).toMatchObject({ allowedT: 2, refusedT: 0, limitT: 4 })
    expect(plan.data.detail).toContain('非激活')
  })

  it('15.0b-C：空投（含滑翔机降落）**不设卸载上限**', () => {
    const plan = planAirUnload({
      kind: 'air_drop',
      baseLevel: 1,
      isAirstrip: false,
      usedT: 99,
      cargoT: 4,
      overLimitAircraftInactive: false,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data).toMatchObject({ allowedT: 4, refusedT: 0, limitT: null, rule: '15.0b-C' })
  })

  it('无基地（等级 0，非简易机场）⇒ 上限 0：空运的货一件也卸不下（先得有机场）', () => {
    const plan = planAirUnload({
      kind: 'air_transport',
      baseLevel: 0,
      isAirstrip: false,
      usedT: 0,
      cargoT: 3,
      overLimitAircraftInactive: false,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data).toMatchObject({ allowedT: 0, refusedT: 3, limitT: 0 })
  })
})
