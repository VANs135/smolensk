import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import { hexDistance } from '@/engine/hex-geometry'
import { useContainersStore, useMapViewStore, useTutorialStore } from '@/stores'
import { setTutorialAirAllInactive } from '@/stores/tutorial-settings'
import { fresh, progress } from '../flows/flow-harness'

/**
 * Vitebsk 教学模式（用户 2026-11-18 第 2 条 + 2026-11-19 扩充）
 *
 * 覆盖：
 *   · 教学开局把空军盒内的飞机置为未激活（14.1a 的整备才有对象）；
 *   · 引导状态机按「初设飞机 → 整备 → 增援 SP → 加油 → 移动 → 扫射 ×2 → 突袭 → 战斗 → 轰炸
 *     → 补给 → 苏军反击」逐步放行，前一步没做完不放开下一步；
 *   · 两次斯图卡扫射的骰面由教学脚本保证（第一轮未命中、第二轮必中并 DG），不改引擎判定；
 *   · 射击阶段有 Ju.88 + Bf.110 护航轰炸，苏军 I.153 出来拦截，全走 14.x 既有链路；
 *   · 反应阶段苏军 18 Tk Div 反扑，结果落在 CRT 攻方损失列（苏军失败，不靠运气）；
 *   · 引导目标给出按钮级文字（buttonTexts），并带单位介绍与霍特口径短句。
 */
describe('教学模式：Vitebsk', () => {
  it('教学开局：天气固定正常，飞机全部未激活，整备后进入增援 SP', async () => {
    const ctx = fresh()
    const tutorial = useTutorialStore()
    tutorial.stop()
    setTutorialAirAllInactive(true)
    tutorial.startFor()

    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    expect(ctx.g.setFirstWeatherChoice('normal', 'Intro')).toBe(true)
    expect(ctx.setup.presetSelfSetupNow().airPlaced).toBe(7)
    expect(ctx.setup.startGameNow()).toBe(true)
    await nextTick()

    expect(ctx.g.firstWeatherChoice).toBe('normal')
    expect(tutorial.active).toBe(true)
    expect(tutorial.currentStep?.id).toBe('air-refit')
    // 条 1：整备步要框住「整备」按钮本身，而不是只圈空军盒
    expect(tutorial.currentStep?.target.buttonTexts).toContain('整备')

    const boxed = ctx.w.airUnits.filter((air) => ctx.w.airBoxMembers.includes(air.instanceId))
    expect(boxed.length).toBe(7)
    expect(boxed.every((air) => air.airStatus === 'inactive')).toBe(true)

    const containers = useContainersStore()
    expect(containers.activateAirBox('axis')).toBe(true)
    expect(boxed.every((air) => air.airStatus === 'active')).toBe(true)
    expect(tutorial.currentStep?.id).toBe('reinforce-sp')
  }, 20_000)

  it('两次斯图卡扫射：脚本保证第二次命中并 DG，之后进突袭', async () => {
    const ctx = await startTutorial()

    // 第一轮：脚本把骰面固定为 2（Ju.87 12-16 列 ⇒ 未命中）
    const first = await hipShoot(ctx, 18, 27)
    expect(first).toBeDefined()
    expect(ctx.w.barrageState?.dice?.die).toBe(2)
    const target = ctx.w.units.find((unit) => unit.hex.col === 18 && unit.hex.row === 27)
    expect(target?.mode.dg ?? false).toBe(false)

    // 第二轮：脚本把骰面固定为 9（同一列 ⇒ DG + 1 点损失），必中
    const second = await hipShoot(ctx, 18, 27)
    expect(second).toBeDefined()
    expect(ctx.w.barrageState?.dice?.die).toBe(9)
    expect(target?.mode.dg).toBe(true)
  }, 20_000)

  it('完整教学线：扫射 → 突袭 → 轰炸（I.153 拦截）→ 补给 → 苏军反击失败', async () => {
    const ctx = await startTutorial()
    const tutorial = useTutorialStore()

    // 两次扫射
    await hipShoot(ctx, 18, 27)
    await hipShoot(ctx, 18, 27)
    expect(ctx.w.units.find((unit) => unit.hex.col === 18 && unit.hex.row === 27)?.mode.dg).toBe(
      true,
    )

    // 突袭 → 战斗补给 → AR → 走完战斗
    expect(ctx.w.overrunNow({ col: 18, row: 27 })).toBe(true)
    expect(ctx.w.combatState?.attackType).toBe('overrun')
    const mapView = useMapViewStore()
    expect(tutorialStep(ctx).id).toBe('combat-supply')
    const attackerDump = ctx.w.combatSupplyDumps.find((item) => item.side === 'attacker')?.dumps[0]
    if (attackerDump !== undefined) ctx.w.pickCombatSupplyDump('attacker', attackerDump.id)
    ctx.w.confirmCombatSupplySide('attacker')
    ctx.w.confirmCombatSupplySide('defender')
    expect(ctx.w.confirmCombatSupply()).toBe(true)
    expect(tutorialStep(ctx).id).toBe('combat-ar')
    expect(ctx.w.declareCombatArStep('attacker')).toBe(true)
    expect(tutorialStep(ctx).id).toBe('combat-finish')
    finishAxisCombat(ctx)

    // 进入移动段的轰炸环节，发起 Ju.88 + Bf.110 护航轰炸，I.153 拦截
    expect(tutorialStep(ctx).id).toBe('bombing')
    for (let n = 0; n < 6 && ctx.w.segmentStep?.id !== 'movement.barrage'; n++) {
      expect(ctx.w.advanceSegmentNow()).not.toBeNull()
    }
    expect(ctx.w.segmentStep?.id).toBe('movement.barrage')

    const victim = ctx.w.units.find(
      (unit) => unit.side === 'soviet' && unit.hex.col === 19 && unit.hex.row === 27,
    )
    expect(victim).toBeDefined()
    mapView.openUnitContext(victim!.hex, victim!.instanceId, { x: 0, y: 0 })
    expect(mapView.openContextAction(victim!.instanceId, 'ops.bombing')).toBe(true)
    const ju88 = ctx.w.airUnits.find(
      (air) => air.side === 'axis' && air.aircraftId === 'ax-aircraft-ge-ju-88',
    )
    const bf110 = ctx.w.airUnits.find(
      (air) => air.side === 'axis' && air.aircraftId === 'ax-aircraft-ge-bf-110',
    )
    const i153 = ctx.w.airUnits.find((air) => air.aircraftId === 'su-aircraft-ru-i-153')
    expect(ju88).toBeDefined()
    expect(bf110).toBeDefined()
    expect(i153).toBeDefined()
    ctx.w.toggleAirMissionUnit(ju88!.instanceId)
    ctx.w.toggleAirMissionUnit(bf110!.instanceId)
    expect(mapView.advanceOpsFlow()).toBe(true)
    expect(ctx.w.airState?.step).toBe('interception')
    expect(tutorialStep(ctx).target.texts).toContain('拦截方宣布拦截（14.5：不强制）')
    expect(ctx.w.airInterceptorCandidates.map((item) => item.instanceId)).toContain(
      i153!.instanceId,
    )
    ctx.w.airInputs.interceptDeclared = true
    // 条 1：勾选拦截后，引导要指到 I.153 这一格拦截机（不是整块面板）
    expect(tutorialStep(ctx).target.buttonTexts).toContain('Ru I.153')
    ctx.w.airInputs.interceptorId = i153!.instanceId
    expect(ctx.w.declareInterceptionNow()).toBe(true)
    expect(ctx.w.resolveInterceptionCombatNow()).toBe(true)
    ctx.w.autoResolveAirMissionNow()
    if (ctx.w.airState?.step === 'resolveMission') expect(ctx.w.settleAirMissionNow()).toBe(true)
    settleBarrageLosses(ctx)
    if (ctx.w.airState?.step === 'resolveMission') expect(ctx.w.settleAirMissionNow()).toBe(true)
    if (ctx.w.airState?.step === 'returnToBase') expect(ctx.w.completeAirReturnNow()).toBe(true)
    expect(tutorialStep(ctx).id).toBe('supply-phase')

    // 补给段 → 反应段（苏军 18 Tk Div 反扑，脚本自动跑；结果必须苏军失败）
    await driveSupplyPhase(ctx)
    await progress(ctx, () => ctx.w.phase === 'reaction')
    await nextTick()
    await nextTick()
    expect(ctx.w.phase).toBe('reaction')

    const combat = ctx.w.combatState
    expect(combat?.finished).toBe(true)
    expect(combat?.attackType).toBe('overrun')
    expect(combat?.dice?.result.raw.startsWith('A')).toBe(true)
    const tk = ctx.w.units.find((unit) => unit.unitId === 'su-armor_tk-ru-18-tk-div')
    expect(tk === undefined || tk.steps < 3).toBe(true)
    // 反应段跑完即整条教学线收束
    expect(tutorial.completed).toBe(true)
    expect(tutorial.currentStep).toBeNull()
    tutorial.stop()
  }, 60_000)

  it('引导文案：霍特口径短句、单位介绍与按钮级目标齐备', async () => {
    const ctx = fresh()
    const tutorial = useTutorialStore()
    tutorial.stop()
    setTutorialAirAllInactive(true)
    tutorial.startFor()
    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    expect(ctx.g.setFirstWeatherChoice('normal', 'Intro')).toBe(true)
    expect(ctx.setup.presetSelfSetupNow().airPlaced).toBe(7)
    expect(ctx.setup.startGameNow()).toBe(true)
    await nextTick()

    const steps = tutorial.steps
    expect(steps.length).toBeGreaterThanOrEqual(16)
    expect(steps.map((step) => step.id)).toEqual([
      'setup-soviet',
      'setup-air',
      'setup-start',
      'air-refit',
      'reinforce-sp',
      'fuel',
      'move',
      'strafe-1',
      'strafe-2',
      'overrun',
      'combat-supply',
      'combat-ar',
      'combat-finish',
      'bombing',
      'supply-phase',
      'reaction-attack',
    ])
    // 每条提示都短（一行）且以霍特口吻下达
    expect(steps.every((step) => step.hint.length <= 40)).toBe(true)
    expect(steps.filter((step) => step.hint.includes('霍特')).length).toBeGreaterThanOrEqual(10)
    // 单位介绍穿插在关键步
    expect(steps.find((step) => step.id === 'fuel')?.intro).toContain('师')
    expect(steps.find((step) => step.id === 'strafe-1')?.intro).toContain('斯图卡')
    expect(steps.find((step) => step.id === 'bombing')?.intro).toContain('Ju.88')
    // 引导真实指到按钮
    expect(steps.find((step) => step.id === 'air-refit')?.target.buttonTexts).toContain('整备')
    expect(steps.find((step) => step.id === 'overrun')?.target.hex).toEqual({ col: 18, row: 27 })
  }, 20_000)
})

type Ctx = ReturnType<typeof fresh>

function tutorialStep(_ctx: Ctx) {
  const tutorial = useTutorialStore()
  const step = tutorial.currentStep
  expect(step).not.toBeNull()
  return step!
}

/** 开教学局并走到「移动完成、右键扫射」这一步（与第 2 条用例共用） */
async function startTutorial(): Promise<Ctx> {
  const ctx = fresh()
  const tutorial = useTutorialStore()
  tutorial.stop()
  setTutorialAirAllInactive(true)
  tutorial.startFor()

  expect(ctx.setup.enterSetup('Intro')).toBe(true)
  expect(ctx.g.setFirstWeatherChoice('normal', 'Intro')).toBe(true)
  expect(ctx.setup.presetSelfSetupNow().airPlaced).toBe(7)
  expect(ctx.setup.startGameNow()).toBe(true)
  await nextTick()

  expect(tutorial.currentStep?.id).toBe('air-refit')
  expect(useContainersStore().activateAirBox('axis')).toBe(true)
  expect(tutorial.currentStep?.id).toBe('reinforce-sp')

  ctx.w.advanceSegmentNow()
  ctx.w.advanceSegmentNow()
  expect(ctx.w.phase).toBe('reinforcement')
  expect(ctx.w.applySupplyArrivalsNow()).toBe(true)
  await progress(ctx, () => ctx.w.phase === 'movement')

  const stack = ctx.w.units.filter((unit) => unit.hex.col === 14 && unit.hex.row === 27)
  const ids = stack.map((unit) => unit.instanceId)
  ctx.w.beginMovePick({ col: 14, row: 27 }, ids)
  ctx.w.fuelMethod = 'formation'
  const dump = ctx.w.fuelDumpChoices?.[0]
  if (dump !== undefined) ctx.w.pickFuelDump(dump.id)
  ctx.w.payFuel()
  expect(stack.every((unit) => unit.fuelled)).toBe(true)

  for (const unit of stack) {
    ctx.w.selectedId = unit.instanceId
    if (unit.mode.mode !== 'move') ctx.w.switchUnitMode('move')
  }
  ctx.w.confirmMovePick()
  const node = (ctx.w.groupReachable?.hexes ?? []).find(
    (item) => item.hex.col === 17 && item.hex.row === 27,
  )
  expect(node).toBeDefined()
  expect(ctx.w.moveAlongDraggedPath(node?.path ?? [])).toBe(true)
  expect(hexDistance({ col: 17, row: 27 }, { col: 18, row: 27 })).toBe(1)
  expect(tutorial.currentStep?.id).toBe('strafe-1')
  return ctx
}

/** 走一轮斯图卡低空扫射，返回所用飞机 */
async function hipShoot(ctx: Ctx, col: number, row: number) {
  const mapView = useMapViewStore()
  const target = ctx.w.units.find(
    (unit) => unit.side !== 'axis' && unit.hex.col === col && unit.hex.row === row,
  )
  expect(target).toBeDefined()
  mapView.openUnitContext(target!.hex, target!.instanceId, { x: 0, y: 0 })
  expect(mapView.openContextAction(target!.instanceId, 'ops.hipShoot')).toBe(true)
  // 条 1：任务面板打开后，引导直接指到「Ju.87b」这枚飞机按钮
  const stepNow = useTutorialStore().currentStep
  expect(['strafe-1', 'strafe-2']).toContain(stepNow?.id)
  expect(stepNow?.target.buttonTexts).toContain('Ju.87b')
  const plane = ctx.w.airUnits.find(
    (air) =>
      air.side === 'axis' &&
      air.airStatus === 'active' &&
      air.canHipShoot &&
      air.aircraftId === 'ax-aircraft-ge-ju-87b',
  )
  expect(plane).toBeDefined()
  ctx.w.toggleAirMissionUnit(plane!.instanceId)
  expect(mapView.advanceOpsFlow()).toBe(true)
  ctx.w.autoResolveAirMissionNow()
  if (ctx.w.airState?.step === 'resolveMission') ctx.w.settleAirMissionNow()
  if (ctx.w.airState?.step === 'returnToBase') ctx.w.completeAirReturnNow()
  return plane
}

/** 攻方把 9.2 余下步骤走完（教学线里由玩家点按钮；测试里按同一批出口驱动） */
function finishAxisCombat(ctx: Ctx): void {
  for (let n = 0; n < 30; n++) {
    const state = ctx.w.combatState
    if (state === null || state.finished) return
    if (state.step === 'declareAr') {
      if (ctx.w.combatInputs.defenderArUnitId === null) {
        const defender = [...ctx.w.battleDefenders].sort((a, b) => b.raw.ar - a.raw.ar)[0]
        if (defender !== undefined) ctx.w.combatInputs.defenderArUnitId = defender.instanceId
      }
      expect(ctx.w.declareCombatArStep('defender')).toBe(true)
    } else if (state.step === 'declareTerrain') {
      expect(ctx.w.autoResolveCombatToOutcome()).toBe(true)
    } else if (state.step === 'surprise') {
      expect(ctx.w.rollCombatSurprise()).toBe(true)
      if (ctx.w.combatAwaitingShiftDie) expect(ctx.w.rollCombatShiftDie()).toBe(true)
    } else if (state.step === 'battleDice') {
      expect(ctx.w.rollCombatDice()).toBe(true)
    } else if (state.step === 'losses') {
      expect(ctx.w.confirmCombatLosses()).toBe(true)
    } else if (state.step === 'options') {
      const requirement = ctx.w.combatRequirement
      expect(requirement).not.toBeNull()
      ctx.w.combatInputs.optionRetreatHexes = 0
      ctx.w.combatInputs.optionLossPoints = requirement!.options
      expect(ctx.w.confirmCombatOptions()).toBe(true)
    } else if (state.step === 'retreat') {
      expect(ctx.w.confirmCombatRetreats()).toBe(true)
    } else if (state.step === 'advance') {
      expect(ctx.w.confirmCombatAdvance()).toBe(true)
    } else {
      throw new Error(`未处理的战斗步骤 ${state.step}`)
    }
  }
  throw new Error('战斗 30 步未收束')
}

/** 10.0a：把轰炸结果的军力损失分到目标格里的单位上 */
function settleBarrageLosses(ctx: Ctx): void {
  if (ctx.w.barrageLossRequired <= 0) return
  for (const unit of ctx.w.barrageLossTargets) {
    while (
      ctx.w.barrageLossAllocated < ctx.w.barrageLossRequired &&
      ctx.w.barrageLossPointsOf(unit.instanceId) < unit.steps
    ) {
      ctx.w.addBarrageLossPoint(unit.instanceId)
    }
  }
  expect(ctx.w.confirmBarrageLossNow()).toBe(true)
}

/** D 补给段：生成计划 → 确认供养 → 结清损耗 → 进入下一环节 */
async function driveSupplyPhase(ctx: Ctx): Promise<void> {
  await progress(ctx, () => ctx.w.phase === 'supply')
  for (let n = 0; n < 40 && ctx.w.phase === 'supply'; n++) {
    if (ctx.w.supplyPhasePlan === null && !ctx.w.supplyFeedingSettled) {
      ctx.w.planSupplyPhaseNow()
    } else if (!ctx.w.supplyFeedingSettled) {
      ctx.w.applySupplyPhaseFeedingNow()
    } else {
      for (const duty of ctx.w.supplyPhasePlan?.attritionDuty ?? []) {
        const key = `${duty.hex.col}.${duty.hex.row}`
        if (ctx.w.attritionAppliedHexes.includes(key)) continue
        if (!ctx.w.attritionResults[key]) ctx.w.rollAttritionNow(key)
        const rolled = ctx.w.attritionResults[key]
        if (rolled === undefined) break
        let left =
          rolled.losses.kind === 'allSteps' ? Number.POSITIVE_INFINITY : rolled.losses.steps
        for (const id of duty.unitIds) {
          const unit = ctx.w.units.find((item) => item.instanceId === id)
          if (unit === undefined) continue
          const loss = Math.min(left, unit.steps)
          ctx.w.setAttritionAllocation(key, id, loss)
          left -= loss
        }
        ctx.w.applyAttritionNow(key)
      }
    }
    ctx.w.advanceSegmentNow()
    await nextTick()
  }
}
