import { describe, expect, it } from 'vitest'

import {
  BREAKDOWN_RE,
  BREAKDOWN_STEPS,
  MIN_PARENT_STEPS_TO_CREATE,
  breakdownAbsorbObligations,
  planBreakdownAbsorb,
  planBreakdownCreate,
  planConsolidation,
  type BreakdownSideView,
  type ConsolidationAircraftView,
  type ConsolidationGroundView,
} from '@/engine/rules'

/**
 * 拆分单位与合并（通规 20.0 / 13.9 ← 专规 2.4 / 3.3d）
 *
 * 逐条对到 20.0a–g 与 13.9 的四种合并；判定全部确定性。
 */

const parent = (overrides: Partial<BreakdownSideView> = {}): BreakdownSideView => ({
  id: 'u-inf-5',
  side: 'axis',
  nationality: 'german',
  classKind: 'other',
  ar: 4,
  steps: 4,
  printedSteps: 4,
  dg: false,
  internalStocks: null,
  mode: 'combat',
  ...overrides,
})

const breakdown = (overrides: Partial<BreakdownSideView> = {}): BreakdownSideView => ({
  id: 'brk-1',
  side: 'axis',
  nationality: 'german',
  classKind: 'other',
  ar: 3,
  steps: 1,
  printedSteps: 1,
  dg: false,
  internalStocks: null,
  mode: 'combat',
  ...overrides,
})

/** 两面印值（13.9 判的是**两个单位之间**两面一致） */
const face = (attack: number, ar: number, ma: number) => ({ attack, ar, ma })

const ground = (overrides: Partial<ConsolidationGroundView> = {}): ConsolidationGroundView => ({
  id: 'u-a',
  combatFace: face(20, 4, 3),
  moveFace: face(10, 4, 5),
  internalStocks: null,
  dg: false,
  locationKey: '36.13',
  steps: 2,
  printedSteps: 4,
  formationId: null,
  ...overrides,
})

const plane = (overrides: Partial<ConsolidationAircraftView> = {}): ConsolidationAircraftView => ({
  id: 'air-a',
  sameTypeAndValues: true,
  sameStatus: true,
  reduced: true,
  locationKey: '36.13',
  steps: 1,
  printedSteps: 2,
  ...overrides,
})

describe('20.0：拆分单位的规模与创建前提', () => {
  it('20.0f：拆分单位为 1 RE / 1 点军力（常量唯一来源 rules-constants）', () => {
    expect(BREAKDOWN_RE).toBe(1)
    expect(BREAKDOWN_STEPS).toBe(1)
    expect(MIN_PARENT_STEPS_TO_CREATE).toBe(2)
  })

  it('20.0：装甲 / 机械化单位不能创建拆分单位（只有「其他」类型可以）', () => {
    const armor = planBreakdownCreate({
      parent: parent({ classKind: 'armor' }),
      breakdown: breakdown(),
      timing: 'startMove',
      poolCount: 3,
    })
    expect(armor.ok).toBe(false)
    if (!armor.ok) expect(armor.reason).toBe('armorOrMechCannotBreakdown:u-inf-5:armor')

    const mech = planBreakdownCreate({
      parent: parent({ classKind: 'mech' }),
      breakdown: breakdown(),
      timing: 'startMove',
      poolCount: 3,
    })
    expect(mech.ok).toBe(false)
  })

  it('专规 2.4：被 Slow Mobilization 锁定的师不能拆解', () => {
    const outcome = planBreakdownCreate({
      parent: parent(),
      breakdown: breakdown(),
      timing: 'startMove',
      poolCount: 3,
      locked: true,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('专规 2.4')
  })

  it('20.0a：只有开始移动 / 战后推进 / 战后撤退三个时机（阶段末不允许创建）', () => {
    const ok = planBreakdownCreate({
      parent: parent(),
      breakdown: breakdown(),
      timing: 'advanceAfterCombat',
      poolCount: 3,
    })
    expect(ok.ok).toBe(true)
    const bad = planBreakdownCreate({
      parent: parent(),
      breakdown: breakdown(),
      // 故意给一个不在 20.0a 时机表里的值（防线在引擎内部，故用类型断言模拟非法输入）
      timing: 'segmentEnd' as unknown as 'startMove',
      poolCount: 3,
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.rule).toBe('20.0a')
  })

  it('20.0：**最后一点军力永远不能**创建拆分单位', () => {
    const outcome = planBreakdownCreate({
      parent: parent({ steps: 1 }),
      breakdown: breakdown(),
      timing: 'startMove',
      poolCount: 3,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('lastStepCannotCreateBreakdown:u-inf-5:1')
  })

  it('20.0b：只能创建 AR ≤ 自己的拆分单位', () => {
    const ok = planBreakdownCreate({
      parent: parent({ ar: 3 }),
      breakdown: breakdown({ ar: 3 }),
      timing: 'startMove',
      poolCount: 3,
    })
    expect(ok.ok).toBe(true)
    const bad = planBreakdownCreate({
      parent: parent({ ar: 2 }),
      breakdown: breakdown({ ar: 3 }),
      timing: 'startMove',
      poolCount: 3,
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('breakdownArTooHigh:3>2')
  })

  it('20.0c：标记与模式必须与拆分单位**相同**（DG / 部队储备 / 模式）', () => {
    for (const mismatch of [
      { dg: true },
      { internalStocks: 'low' as const },
      { mode: 'reserve' as const },
    ]) {
      const outcome = planBreakdownCreate({
        parent: parent(mismatch),
        breakdown: breakdown(),
        timing: 'startMove',
        poolCount: 3,
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.rule).toBe('20.0c')
    }
  })

  it('20.0g：池中数量不足即拒（同国籍共用一池）', () => {
    const outcome = planBreakdownCreate({
      parent: parent(),
      breakdown: breakdown(),
      timing: 'startMove',
      poolCount: 0,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('breakdownPoolExhausted:0<1')
  })

  it('20.0 / 20.0e：创建后母单位军力减 count，且不消耗 MP', () => {
    const outcome = planBreakdownCreate({
      parent: parent({ steps: 4 }),
      breakdown: breakdown(),
      timing: 'startMove',
      poolCount: 2,
      count: 2,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.parentStepsAfter).toBe(2)
    expect(outcome.data.count).toBe(2)
  })
})

describe('20.0b–e：吸收拆分单位', () => {
  it('20.0b：只能吸收 AR ≥ 自己的拆分单位', () => {
    const ok = planBreakdownAbsorb({
      parent: parent({ ar: 3, steps: 2 }),
      breakdown: breakdown({ ar: 3 }),
      timing: 'segmentEnd',
      stacked: true,
      parentReduced: true,
    })
    expect(ok.ok).toBe(true)
    const bad = planBreakdownAbsorb({
      parent: parent({ ar: 4, steps: 2 }),
      breakdown: breakdown({ ar: 3 }),
      timing: 'segmentEnd',
      stacked: true,
      parentReduced: true,
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('breakdownArTooLow:3<4')
  })

  it('20.0d：须与母单位**堆叠**，且只在**阶段结束时**吸收', () => {
    const notStacked = planBreakdownAbsorb({
      parent: parent({ steps: 2 }),
      breakdown: breakdown(),
      timing: 'segmentEnd',
      stacked: false,
      parentReduced: true,
    })
    expect(notStacked.ok).toBe(false)
    if (!notStacked.ok) expect(notStacked.reason).toBe('breakdownNotStackedWithParent:brk-1')

    const wrongTiming = planBreakdownAbsorb({
      parent: parent({ steps: 2 }),
      breakdown: breakdown(),
      timing: 'startMove' as unknown as 'segmentEnd',
      stacked: true,
      parentReduced: true,
    })
    expect(wrongTiming.ok).toBe(false)
    if (!wrongTiming.ok) expect(wrongTiming.rule).toBe('20.0d')
  })

  it('20.0d：母单位减损 ⇒ 该吸收为**强制**；吸收后超出印值的军力直接丢失', () => {
    const mandatory = planBreakdownAbsorb({
      parent: parent({ steps: 2, printedSteps: 4 }),
      breakdown: breakdown(),
      timing: 'segmentEnd',
      stacked: true,
      parentReduced: true,
    })
    if (!mandatory.ok) return
    expect(mandatory.data).toMatchObject({ parentStepsAfter: 3, mandatory: true, overflowLost: 0 })

    const overflow = planBreakdownAbsorb({
      parent: parent({ steps: 4, printedSteps: 4 }),
      breakdown: breakdown(),
      timing: 'segmentEnd',
      stacked: true,
      parentReduced: false,
    })
    if (!overflow.ok) return
    expect(overflow.data).toMatchObject({ parentStepsAfter: 4, overflowLost: 1, mandatory: false })
  })

  it('20.0d：阶段末的强制吸收义务（减损且与合格拆分单位堆叠）', () => {
    const obligations = breakdownAbsorbObligations({
      units: [
        // 母单位 AR 3 才能吸收 AR 3 的拆分单位（20.0b 的方向性）
        {
          ...parent({ id: 'reduced', ar: 3, steps: 2, printedSteps: 4 }),
        },
        {
          ...parent({ id: 'full', ar: 3, steps: 4, printedSteps: 4 }),
        },
      ],
      breakdownsStackedWith: (parentId) => (parentId === 'reduced' ? [breakdown()] : []),
    })
    expect(obligations).toHaveLength(1)
    expect(obligations[0]).toMatchObject({ parentId: 'reduced', breakdownIds: ['brk-1'] })
  })

  it('20.0：装甲 / 机械化单位不能吸收拆分单位', () => {
    const outcome = planBreakdownAbsorb({
      parent: parent({ classKind: 'armor', steps: 2 }),
      breakdown: breakdown(),
      timing: 'segmentEnd',
      stacked: true,
      parentReduced: true,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('20.0')
  })
})

describe('13.9-1：多军力单位合并（增援阶段）', () => {
  it('13.9：只在本方**增援阶段**', () => {
    const outcome = planConsolidation({
      kind: 'multiStepUnits',
      phaseIsReinforcement: false,
      keep: ground(),
      remove: ground({ id: 'u-b' }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('13.9')
  })

  it('13.9-1：须同格；移除一个并把军力并入另一个（超印值部分丢失）', () => {
    const ok = planConsolidation({
      kind: 'multiStepUnits',
      phaseIsReinforcement: true,
      keep: ground({ steps: 2, printedSteps: 4 }),
      remove: ground({ id: 'u-b', steps: 1, printedSteps: 4 }),
    })
    if (!ok.ok) return
    expect(ok.data).toMatchObject({ removeIds: ['u-b'], keepStepsAfter: 3, overflowLost: 0 })

    const overflow = planConsolidation({
      kind: 'multiStepUnits',
      phaseIsReinforcement: true,
      keep: ground({ steps: 3, printedSteps: 4 }),
      remove: ground({ id: 'u-b', steps: 3, printedSteps: 4 }),
    })
    if (!overflow.ok) return
    expect(overflow.data).toMatchObject({ keepStepsAfter: 4, overflowLost: 2 })

    const otherHex = planConsolidation({
      kind: 'multiStepUnits',
      phaseIsReinforcement: true,
      keep: ground(),
      remove: ground({ id: 'u-b', locationKey: '37.13' }),
    })
    expect(otherHex.ok).toBe(false)
  })

  it('13.9：参与合并的单位不能是部队储备低下/耗尽，也不能是 DG', () => {
    const lowStocks = planConsolidation({
      kind: 'multiStepUnits',
      phaseIsReinforcement: true,
      keep: ground({ internalStocks: 'low' }),
      remove: ground({ id: 'u-b' }),
    })
    expect(lowStocks.ok).toBe(false)

    const dg = planConsolidation({
      kind: 'multiStepUnits',
      phaseIsReinforcement: true,
      keep: ground(),
      remove: ground({ id: 'u-b', dg: true }),
    })
    expect(dg.ok).toBe(false)
    if (!dg.ok) expect(dg.reason).toBe('dgCannotConsolidate:u-b')
  })

  it('13.9：被交换或合并的地面单位必须在**算子两面都完全相同**', () => {
    // 两面都相同 ⇒ 通过
    expect(
      planConsolidation({
        kind: 'multiStepUnits',
        phaseIsReinforcement: true,
        keep: ground(),
        remove: ground({ id: 'u-b' }),
      }).ok,
    ).toBe(true)

    // 移动面不同 ⇒ 不是「同等单位」，拒
    const outcome = planConsolidation({
      kind: 'multiStepUnits',
      phaseIsReinforcement: true,
      keep: ground(),
      remove: ground({ id: 'u-b', moveFace: face(10, 4, 6) }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('facesNotIdentical:u-a:u-b')

    // 战斗面不同 ⇒ 同样拒
    expect(
      planConsolidation({
        kind: 'multiStepUnits',
        phaseIsReinforcement: true,
        keep: ground(),
        remove: ground({ id: 'u-b', combatFace: face(16, 4, 3) }),
      }).ok,
    ).toBe(false)
  })

  it('13.9：单位即使**相邻敌方或断补**也可合并（本模块不因这些事实拒绝）', () => {
    const outcome = planConsolidation({
      kind: 'multiStepUnits',
      phaseIsReinforcement: true,
      keep: ground({ internalStocks: null }),
      remove: ground({ id: 'u-b' }),
    })
    expect(outcome.ok).toBe(true)
  })
})

describe('13.9-2 / 13.9-3：编队换装与独立单位并入编队（专规 3.3d）', () => {
  it('13.9-2：替换来源须来自**死亡堆**、属**不同的**多单位编队', () => {
    const ok = planConsolidation({
      kind: 'formations',
      phaseIsReinforcement: true,
      replaced: ground({ id: 'in-play', formationId: '3Pz' }),
      replacement: ground({ id: 'from-dead', formationId: '4Pz', inDeadPile: true }),
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.data.replacesIdentity).toBe(true)

    const sameFormation = planConsolidation({
      kind: 'formations',
      phaseIsReinforcement: true,
      replaced: ground({ id: 'in-play', formationId: '3Pz' }),
      replacement: ground({ id: 'from-dead', formationId: '3Pz', inDeadPile: true }),
    })
    expect(sameFormation.ok).toBe(false)
    if (!sameFormation.ok) expect(sameFormation.reason).toBe('sameFormation:3Pz')

    const notDead = planConsolidation({
      kind: 'formations',
      phaseIsReinforcement: true,
      replaced: ground({ id: 'in-play', formationId: '3Pz' }),
      replacement: ground({ id: 'elsewhere', formationId: '4Pz' }),
    })
    expect(notDead.ok).toBe(false)
    if (!notDead.ok) expect(notDead.reason).toBe('replacementNotInDeadPile:elsewhere')
  })

  it('专规 3.3d：轴心国多单位编队**不能**使用 Consolidation', () => {
    const outcome = planConsolidation({
      kind: 'formations',
      phaseIsReinforcement: true,
      axisFormationConsolidation: true,
      replaced: ground({ id: 'in-play', formationId: '3Pz' }),
      replacement: ground({ id: 'from-dead', formationId: '4Pz', inDeadPile: true }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('专规 3.3d')
  })

  it('13.9-3：独立单位可并入编队；编队单位**永远不能**转为独立单位', () => {
    const ok = planConsolidation({
      kind: 'independentsIntoFormation',
      phaseIsReinforcement: true,
      replaced: ground({ id: 'independent', formationId: null }),
      replacement: ground({ id: 'from-dead', formationId: '3Pz', inDeadPile: true }),
    })
    expect(ok.ok).toBe(true)

    const forbidden = planConsolidation({
      kind: 'independentsIntoFormation',
      phaseIsReinforcement: true,
      replaced: ground({ id: 'in-play', formationId: '3Pz' }),
      replacement: ground({ id: 'from-dead', formationId: '4Pz', inDeadPile: true }),
    })
    expect(forbidden.ok).toBe(false)
    if (!forbidden.ok) expect(forbidden.reason).toBe('formationUnitCannotBecomeIndependent:in-play')
  })
})

describe('13.9-4：飞机合并（可在任何阶段）', () => {
  it('13.9-4：同类同值同状态的两架**减损**飞机同格 ⇒ 合并为一架满军力', () => {
    const ok = planConsolidation({
      kind: 'aircraft',
      keep: plane(),
      remove: plane({ id: 'air-b' }),
    })
    if (!ok.ok) return
    expect(ok.data).toMatchObject({
      removeIds: ['air-b'],
      keepStepsAfter: 2,
      replacesIdentity: false,
    })
  })

  it('13.9-4：受 13.9 总则限制（类型/数值/状态不同、未减损、不同格都拒）', () => {
    expect(
      planConsolidation({
        kind: 'aircraft',
        keep: plane(),
        remove: plane({ id: 'air-b', sameTypeAndValues: false }),
      }).ok,
    ).toBe(false)
    expect(
      planConsolidation({
        kind: 'aircraft',
        keep: plane(),
        remove: plane({ id: 'air-b', sameStatus: false }),
      }).ok,
    ).toBe(false)
    expect(
      planConsolidation({
        kind: 'aircraft',
        keep: plane(),
        remove: plane({ id: 'air-b', reduced: false }),
      }).ok,
    ).toBe(false)
    expect(
      planConsolidation({
        kind: 'aircraft',
        keep: plane(),
        remove: plane({ id: 'air-b', locationKey: '37.13' }),
      }).ok,
    ).toBe(false)
  })
})
