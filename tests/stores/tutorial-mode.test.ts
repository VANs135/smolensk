import { readFileSync } from 'node:fs'

import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import { useContainersStore, useMapViewStore, useTutorialStore } from '@/stores'
import { combatFixedDie, combatFixedSurprise } from '@/stores/fire-resolution'
import {
  setTutorialAirAllInactive,
  setTutorialFixedReinforcement,
} from '@/stores/tutorial-settings'
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
    await placeTutorialSetup(ctx)
    expect(ctx.setup.startGameNow(), ctx.setup.lastAction?.detail).toBe(true)
    await nextTick()

    expect(ctx.g.firstWeatherChoice).toBe('normal')
    expect(tutorial.active).toBe(true)
    expect(tutorial.currentStep?.id).toBe('air-refit')
    // 进度数字 1 基（原来 0 起 ⇒ 站第 12 步显示 11/24，被误读成卡住）
    expect(tutorial.progressLabel).toBe(`4/${String(tutorial.steps.length)}`)
    // 条 1：整备步要框住「整备」按钮本身，而不是只圈空军盒
    expect(tutorial.currentStep?.target.buttonTexts).toContain('整备')

    const boxed = ctx.w.airUnits.filter((air) => ctx.w.airBoxMembers.includes(air.instanceId))
    // Intro 自身 7 架 + 教学为「两队 Ju.88」补的第 8 架（开局脚本进空军盒）
    expect(boxed.length).toBe(8)
    expect(boxed.every((air) => air.airStatus === 'inactive')).toBe(true)

    const containers = useContainersStore()
    expect(containers.activateAirBox('axis')).toBe(true)
    expect(boxed.every((air) => air.airStatus === 'active')).toBe(true)
    expect(tutorial.currentStep?.id).toBe('reinforce-sp')
  }, 20_000)

  it('苏方初设由脚本自动落完，轴心的飞机仍要玩家自己摆（用户 2026-11-23）', async () => {
    const ctx = fresh()
    const tutorial = useTutorialStore()
    tutorial.stop()
    setTutorialAirAllInactive(true)
    tutorial.startFor()
    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    for (let guard = 0; guard < 6 && ctx.setup.setupSideCursor === 'soviet'; guard += 1)
      await nextTick()

    // 不点「自动放置」也已换手到轴心，且苏方条目零待定
    expect(ctx.setup.setupSideCursor).toBe('axis')
    expect(ctx.setup.pendingPlacement.filter((item) => item.side === 'soviet')).toHaveLength(0)
    expect(ctx.w.log.some((line) => line.text.includes('苏方初设自动布设未完成'))).toBe(false)
    // 苏方算子按剧本数据落位（18 Tk Div 仍是「预备 + 移动面」）
    const tank = ctx.w.units.find((unit) => unit.name === 'Ru 18 Tk Div')
    expect(tank?.mode.mode).toBe('reserve')
    expect(tank?.mode.orientation).toBe('move')
    // 轴心 7 架飞机一枚都还没落：全在待落位队列里，盘上零架
    expect(ctx.w.airUnits).toHaveLength(0)
    const axisAirPending = ctx.setup.pendingPlacement.filter(
      (item) => item.side === 'axis' && item.category === 'air',
    )
    expect(axisAirPending.length).toBeGreaterThan(0)
    // 教学模式下不给「自动放置」入口（否则一键就把学员自己该摆的飞机也摆好了）
    const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    expect(queue).toContain('!tutorial.active')
    // 此时引导停在「飞机先入盒」，而不是「敌军布设」
    expect(tutorial.currentStep?.id).toBe('setup-air')
  }, 20_000)

  it('两次斯图卡扫射：脚本保证第二次命中并 DG，之后进突袭', async () => {
    const ctx = await startTutorial()

    // 第一轮：脚本把骰面固定为 2（Ju.87 12-16 列 ⇒ 未命中）
    const first = await hipShoot(ctx, 18, 27)
    expect(first).toBeDefined()
    expect(ctx.w.barrageState?.dice?.die).toBe(2)
    const target = ctx.w.units.find((unit) => unit.hex.col === 18 && unit.hex.row === 27)
    expect(target?.mode.dg ?? false).toBe(false)

    // 第二轮：脚本把骰面固定为 9（同一列 ⇒ [1/2]，飞机轰炸按 10.0a 直接判 DG），必中
    const second = await hipShoot(ctx, 18, 27)
    expect(second).toBeDefined()
    expect(ctx.w.barrageState?.dice?.die).toBe(9)
    expect(target?.mode.dg).toBe(true)
  }, 20_000)

  it('完整教学线：扫射 → 突袭 → 战斗步（补给 / AR）；后续炮兵、空袭、反扑、夺城见步骤守卫', async () => {
    const ctx = await startTutorial()
    const tutorial = useTutorialStore()

    // 两次斯图卡扫射 18.27 的坦克师
    await hipShoot(ctx, 18, 27)
    await hipShoot(ctx, 18, 27)
    expect(ctx.w.units.find((unit) => unit.hex.col === 18 && unit.hex.row === 27)?.mode.dg).toBe(
      true,
    )

    // 两个摩步突袭 → 战斗补给 → AR 宣布（9.2 段序）
    expect(ctx.w.overrunNow({ col: 18, row: 27 })).toBe(true)
    expect(ctx.w.combatState?.attackType).toBe('overrun')
    expect(tutorialStep(ctx).id).toBe('combat-supply')
    const attackerDump = ctx.w.combatSupplyDumps.find((item) => item.side === 'attacker')?.dumps[0]
    if (attackerDump !== undefined) ctx.w.pickCombatSupplyDump('attacker', attackerDump.id)
    ctx.w.confirmCombatSupplySide('attacker')
    ctx.w.confirmCombatSupplySide('defender')
    expect(ctx.w.confirmCombatSupply()).toBe(true)
    expect(tutorialStep(ctx).id).toBe('combat-ar')
    expect(ctx.w.declareCombatArStep('attacker')).toBe(true)
    expect(tutorialStep(ctx).id).toBe('combat-finish')
    tutorial.stop()
  }, 60_000)

  it('战机扫荡：另一架 Bf110 扫 LaGG.3，两败俱伤都返航，然后才轮到轰炸', async () => {
    const ctx = await startTutorial()
    const tutorial = useTutorialStore()
    const airBase: HexRef = { col: 19, row: 28 }

    // 先走完两次斯图卡与突袭战斗，炮兵推到射程内 ⇒ 引导进「战机扫荡」
    await hipShoot(ctx, 18, 27)
    await hipShoot(ctx, 18, 27)
    expect(ctx.w.overrunNow({ col: 18, row: 27 })).toBe(true)
    const attackerDump = ctx.w.combatSupplyDumps.find((item) => item.side === 'attacker')?.dumps[0]
    if (attackerDump !== undefined) ctx.w.pickCombatSupplyDump('attacker', attackerDump.id)
    ctx.w.confirmCombatSupplySide('attacker')
    ctx.w.confirmCombatSupplySide('defender')
    expect(ctx.w.confirmCombatSupply()).toBe(true)
    expect(ctx.w.declareCombatArStep('attacker')).toBe(true)
    expect(ctx.w.declareCombatArStep('defender')).toBe(true)
    expect(ctx.w.autoResolveCombatToOutcome()).toBe(true)
    for (let guard = 0; guard < 12 && ctx.w.combatState?.finished !== true; guard++) {
      const step = ctx.w.combatState?.step
      if (step === 'losses') expect(ctx.w.confirmCombatLosses()).toBe(true)
      else if (step === 'options') {
        ctx.w.combatInputs.optionRetreatHexes = ctx.w.combatRequirement?.options ?? 0
        ctx.w.combatInputs.optionLossPoints = 0
        expect(ctx.w.confirmCombatOptions()).toBe(true)
      } else if (step === 'retreat') {
        for (const plan of ctx.w.combatRetreatPlans)
          for (const unit of plan.units) {
            const destination =
              unit.destinations.find((item) => !item.forcedDestruction) ?? unit.destinations[0]!
            ctx.w.combatInputs.retreatPaths[unit.unitId] = destination.path
              .map((hex) => `${String(hex.col)}.${String(hex.row)}`)
              .join(',')
          }
        expect(ctx.w.confirmCombatRetreats()).toBe(true)
      } else if (step === 'advance') expect(ctx.w.confirmCombatAdvance()).toBe(true)
    }
    expect(ctx.w.combatState?.finished).toBe(true)

    ctx.w.finishMove()
    const artillery = ctx.w.units.find((unit) => unit.unitId === 'ax-motorized-ge-20-mtr-20-arty')!
    ctx.w.beginMovePick(artillery.hex, [artillery.instanceId])
    expect(ctx.w.confirmMovePick()).toBe(true)
    const artyNode = (ctx.w.groupReachable?.hexes ?? []).find(
      (item) => hexDistance(item.hex, { col: 19, row: 27 }) <= 3,
    )
    expect(artyNode).toBeDefined()
    expect(ctx.w.moveAlongDraggedPath(artyNode?.path ?? [])).toBe(true)
    ctx.w.finishMove()
    expect(tutorial.currentStep?.id).toBe('fighter-sweep')

    const lagg = ctx.w.airUnits.find((air) => air.instanceId === 'tutorial-su-lagg3')!
    const i153 = ctx.w.airUnits.find((air) => air.instanceId === 'tutorial-su-i153')!
    expect(lagg.airStatus).toBe('active')
    // I.153 留到轰炸课才升空，不提前拦截扫荡
    expect(i153.airStatus).toBe('inactive')

    expect(ctx.w.canAirMissionTarget('fighter_sweep', airBase)).toBe(true)
    ctx.w.setAirActive(true)
    ctx.w.setAirMissionKind('fighter_sweep')
    expect(ctx.w.setAirTargetFromText('19.28')).toBe(true)

    const sweepPlane = ctx.w.airUnits.find(
      (air) =>
        air.side === 'axis' &&
        air.aircraftId === 'ax-aircraft-ge-bf-110' &&
        air.airStatus === 'active' &&
        air.missionsFlownThisPhase === 0,
    )!
    expect(tutorial.currentStep?.target.airInstanceId).toBe(sweepPlane.instanceId)
    ctx.w.toggleAirMissionUnit(sweepPlane.instanceId)
    expect(ctx.w.beginAirMissionNow()).toBe(true)

    // 14.6 不受防空影响 ⇒ 直接 14.3e 逐轮空战；教学固定骰让双方返航且各损 1
    expect(ctx.w.airInputs.airCombatDice).toEqual([{ die: 6, lossDie: 5 }])
    expect(ctx.w.confirmAirCombatNow()).toBe(true)
    const round = ctx.w.airState?.airCombat?.rounds[0]
    expect(round?.abortSide).toBe('both')
    expect([...(round?.stepLossIds ?? [])].sort()).toEqual(
      [lagg.instanceId, sweepPlane.instanceId].sort(),
    )
    expect(lagg.steps).toBe(1)
    expect(sweepPlane.steps).toBe(1)
    expect(lagg.airStatus).toBe('inactive')
    expect(sweepPlane.airStatus).toBe('inactive')

    ctx.w.autoResolveAirMissionNow()
    if (ctx.w.airState?.step === 'resolveMission') ctx.w.settleAirMissionNow()
    if (ctx.w.airState?.step === 'returnToBase') ctx.w.completeAirReturnNow()
    expect(ctx.w.airState?.step).toBe('done')
    expect(ctx.w.airState?.finished).toBe(true)
    expect(tutorial.currentStep?.id).toBe('bombing')

    // 进轰炸环节后 I.153 才升空；四机按 Ju.88 ×2 → Do.17z → 未扫荡的 Bf110 逐枚高亮
    for (let guard = 0; guard < 8 && ctx.w.segmentStep?.id !== 'movement.barrage'; guard++)
      ctx.w.advanceSegmentNow()
    expect(ctx.w.segmentStep?.id).toBe('movement.barrage')
    expect(i153.airStatus).toBe('active')
    // 上一波任务选机名单要清掉（真实 UI 从菜单重新发起时会重置）
    ctx.w.toggleAirMissionUnit(sweepPlane.instanceId)
    ctx.w.setAirMissionKind('barrage')
    expect(ctx.w.setAirTargetFromText('19.28')).toBe(true)
    // 14.4c：I.153 的基地罩住 19.28 ⇒ 它才是轰炸的拦截机
    expect(ctx.w.airTargetInEnemyPatrolZone).toBe(true)
    expect(ctx.w.airInterceptionResponse?.eligibleFighterIds).toContain(i153.instanceId)
    const availableOf = (aircraftId: string) =>
      ctx.w.airUnits.filter(
        (air) =>
          air.side === 'axis' &&
          air.aircraftId === aircraftId &&
          air.airStatus === 'active' &&
          air.missionsFlownThisPhase === 0,
      )
    const expectedBombingIds = [
      ...availableOf('ax-aircraft-ge-ju-88').map((air) => air.instanceId),
      ...availableOf('ax-aircraft-ge-do-17z').map((air) => air.instanceId),
      ...availableOf('ax-aircraft-ge-bf-110').map((air) => air.instanceId),
    ]
    expect(expectedBombingIds).toHaveLength(4)

    // review 2026-11-20：把第一架 Ju.88 标成「已飞过」⇒ 引导应跳过它、指向第二架；
    // 恢复后重新指回第一架。钉住「所有机型都按激活且未飞过筛」这条健壮性口径。
    const firstJu88 = ctx.w.airUnits.find((air) => air.instanceId === expectedBombingIds[0])!
    firstJu88.missionsFlownThisPhase = 1
    expect(tutorial.currentStep?.target.airInstanceId).toBe(expectedBombingIds[1])
    firstJu88.missionsFlownThisPhase = 0
    expect(tutorial.currentStep?.target.airInstanceId).toBe(firstJu88.instanceId)

    for (const id of expectedBombingIds) {
      expect(tutorial.currentStep?.target.airInstanceId).toBe(id)
      ctx.w.toggleAirMissionUnit(id)
    }
    expect(tutorial.currentStep?.target.buttonTexts).toContain('发起任务')
    tutorial.stop()
  }, 90_000)

  it('端到端（一）：轰炸结算（含受损确认）→ 苏军反扑脚本自打完 → 引导推进到弹幕', async () => {
    const ctx = await startTutorial()
    const tutorial = useTutorialStore()

    const same = (a: { col: number; row: number }, b: { col: number; row: number }): boolean =>
      a.col === b.col && a.row === b.row

    /** 把一场 9.2 战斗从补给步一路走完（与界面点法同序） */
    const drainCombat = (): void => {
      const attackerDump = ctx.w.combatSupplyDumps.find((item) => item.side === 'attacker')
        ?.dumps[0]
      if (attackerDump !== undefined) ctx.w.pickCombatSupplyDump('attacker', attackerDump.id)
      ctx.w.confirmCombatSupplySide('attacker')
      ctx.w.confirmCombatSupplySide('defender')
      ctx.w.confirmCombatSupply()
      ctx.w.declareCombatArStep('attacker')
      ctx.w.declareCombatArStep('defender')
      ctx.w.autoResolveCombatToOutcome()
      for (let guard = 0; guard < 12 && ctx.w.combatState?.finished !== true; guard++) {
        const step = ctx.w.combatState?.step
        if (step === 'losses') void ctx.w.confirmCombatLosses()
        else if (step === 'options') {
          ctx.w.combatInputs.optionRetreatHexes = ctx.w.combatRequirement?.options ?? 0
          ctx.w.combatInputs.optionLossPoints = 0
          void ctx.w.confirmCombatOptions()
        } else if (step === 'retreat') {
          for (const plan of ctx.w.combatRetreatPlans)
            for (const unit of plan.units) {
              const destination =
                unit.destinations.find((item) => !item.forcedDestruction) ?? unit.destinations[0]
              if (destination === undefined) continue
              ctx.w.combatInputs.retreatPaths[unit.unitId] = destination.path
                .map((hex) => `${String(hex.col)}.${String(hex.row)}`)
                .join(',')
            }
          void ctx.w.confirmCombatRetreats()
        } else if (step === 'advance') void ctx.w.confirmCombatAdvance()
        else return
      }
    }

    /** 10.0a 的「1/2」要玩家落盘受损单位：逐点到够，再确认 */
    const drainBarrageLoss = (): void => {
      for (let guard = 0; guard < 8 && !ctx.w.barrageLossReady; guard++) {
        const hex = ctx.w.airState?.targetHex ?? null
        const loser =
          hex === null
            ? undefined
            : ctx.w.units.find((unit) => unit.side === 'soviet' && same(unit.hex, hex))
        if (loser === undefined) return
        ctx.w.addBarrageLossPoint(loser.instanceId)
      }
      if (ctx.w.barrageLossReady) ctx.w.confirmBarrageLossNow()
    }

    // 1) 两次扫射 + 突袭 → 战斗走完
    await hipShoot(ctx, 18, 27)
    await hipShoot(ctx, 18, 27)
    expect(ctx.w.overrunNow({ col: 18, row: 27 })).toBe(true)
    drainCombat()
    expect(ctx.w.combatState?.finished).toBe(true)

    // 2) 炮兵推进到 17.27（弹幕射程覆盖 19.27）
    ctx.w.finishMove()
    const artillery = ctx.w.units.find((unit) => unit.unitId === 'ax-motorized-ge-20-mtr-20-arty')!
    ctx.w.beginMovePick(artillery.hex, [artillery.instanceId])
    expect(ctx.w.confirmMovePick()).toBe(true)
    const artyNode = (ctx.w.groupReachable?.hexes ?? []).find(
      (item) => item.hex.col === 17 && item.hex.row === 27,
    )
    expect(artyNode).toBeDefined()
    expect(ctx.w.moveAlongDraggedPath(artyNode?.path ?? [])).toBe(true)
    ctx.w.finishMove()
    expect(tutorial.currentStep?.id).toBe('fighter-sweep')

    // 3) 扫荡 LaGG.3：教学固定骰让双方返航、各损 1
    ctx.w.setAirActive(true)
    ctx.w.setAirMissionKind('fighter_sweep')
    expect(ctx.w.setAirTargetFromText('19.28')).toBe(true)
    const sweepPlane = ctx.w.airUnits.find(
      (air) =>
        air.side === 'axis' &&
        air.aircraftId === 'ax-aircraft-ge-bf-110' &&
        air.airStatus === 'active' &&
        air.missionsFlownThisPhase === 0,
    )!
    ctx.w.toggleAirMissionUnit(sweepPlane.instanceId)
    expect(ctx.w.beginAirMissionNow()).toBe(true)
    /*
     * 用户 2026-11-23：14.3e-B 的守方逐轮点名归**苏军自己** ——
     * 教学局苏军由脚本接管，脚本按缺省口径（该格 ACV 最高的苏军激活机）替它点名，
     * 玩家那一侧只看见「由苏军自选」，攻方点位仍然空着（不在这一战替玩家预点）。
     */
    expect(ctx.w.airState?.step).toBe('airCombat')
    /*
     * 用户 2026-11-23：14.3e-B 的守方逐轮点名归**苏军自己** —— 教学局苏军由脚本接管，
     * 脚本按缺省口径（任务格上 ACV 最高的苏军激活机）替它点名，玩家那一侧只看见
     * 「由苏军自选」；攻方点位仍留空（不在这场空战里替玩家预点）。
     */
    const lagg = ctx.w.airUnits.find(
      (air) =>
        air.side === 'soviet' &&
        air.airStatus === 'active' &&
        air.hex.col === 19 &&
        air.hex.row === 28,
    )
    expect(lagg?.name).toBe('Ru LaGG.3')
    expect(ctx.w.airInputs.airCombatPicks[0]?.defenderAircraftId).toBe(lagg?.instanceId)
    expect(ctx.w.airInputs.airCombatPicks[0]?.attackerAircraftId).toBeNull()
    expect(ctx.w.confirmAirCombatNow()).toBe(true)
    ctx.w.autoResolveAirMissionNow()
    if (ctx.w.airState?.step === 'resolveMission') ctx.w.settleAirMissionNow()
    if (ctx.w.airState?.step === 'returnToBase') ctx.w.completeAirReturnNow()
    expect(ctx.w.airState?.finished).toBe(true)
    expect(tutorial.currentStep?.id).toBe('bombing')
    // 引导走到轰炸步 ⇒ 苏军 I.153 已升空（14.4c 巡逻区成立的前提）
    const i153 = ctx.w.airUnits.find((air) => air.instanceId === 'tutorial-su-i153')!
    expect(i153.airStatus).toBe('active')

    // 4) 轰炸：四机齐出 → 发起 → 结算（含 10.0a 的受损落盘）
    for (let guard = 0; guard < 8 && ctx.w.segmentStep?.id !== 'movement.barrage'; guard++)
      ctx.w.advanceSegmentNow()
    ctx.w.toggleAirMissionUnit(sweepPlane.instanceId)
    ctx.w.setAirMissionKind('barrage')
    expect(ctx.w.setAirTargetFromText('19.28')).toBe(true)
    const availableOf = (aircraftId: string) =>
      ctx.w.airUnits.filter(
        (air) =>
          air.side === 'axis' &&
          air.aircraftId === aircraftId &&
          air.airStatus === 'active' &&
          air.missionsFlownThisPhase === 0,
      )
    for (const id of [
      ...availableOf('ax-aircraft-ge-ju-88').map((air) => air.instanceId),
      ...availableOf('ax-aircraft-ge-do-17z').map((air) => air.instanceId),
      ...availableOf('ax-aircraft-ge-bf-110').map((air) => air.instanceId),
    ])
      ctx.w.toggleAirMissionUnit(id)
    expect(ctx.w.beginAirMissionNow()).toBe(true)
    for (let guard = 0; guard < 20; guard++) {
      const state = ctx.w.airState
      if (state === null || state.finished) break
      if (state.step === 'resolveMission') {
        drainBarrageLoss()
        ctx.w.settleAirMissionNow()
        continue
      }
      if (state.step === 'returnToBase') {
        ctx.w.completeAirReturnNow()
        continue
      }
      ctx.w.autoResolveAirMissionNow()
    }
    expect(ctx.w.airState?.finished).toBe(true)
    expect(tutorial.currentStep?.id).toBe('reaction-attack')

    // 5) 推到反应阶段：苏军 18 Tk Div 由脚本加油 → 移到城格 → 突袭，战斗窗交给玩家
    for (let guard = 0; guard < 12 && ctx.w.phase !== 'reaction'; guard++) ctx.w.advanceSegmentNow()
    expect(ctx.w.phase).toBe('reaction')
    for (let guard = 0; guard < 24; guard++) await nextTick()
    /*
     * 用户 2026-11-23：反扑不再由脚本一口气打完 —— 脚本只演苏军（攻方）那一半，
     * 战斗窗停在「守方补给」等玩家。苏军那一侧走完 ⇒ 引导从 reaction-attack 落到 reaction-supply。
     */
    expect(tutorial.reaction).toBe('running')
    expect(ctx.w.combatState).not.toBeNull()
    expect(ctx.w.combatState?.finished).not.toBe(true)
    expect(tutorial.currentStep?.id).toBe('reaction-supply')
    // 脚本只代点了攻方那一半：攻方补给已确认，守方补给还空着等玩家
    expect(ctx.w.combatInputs.supplyConfirmed.attacker).toBe(true)
    expect(ctx.w.combatInputs.supplyConfirmed.defender).toBe(false)
    // 守方那一半整段没被代点：战斗仍停在补给步，守方行动值也没宣布
    expect(ctx.w.combatState?.step).toBe('combatSupply')
    expect(ctx.w.combatState?.ar).toBeUndefined()

    // 5a) 守方补给（玩家）：付（从第一座可达的守方补给站扣，与修前脚本同一口径）
    const defenderDump = ctx.w.combatSupplyDumps.find((item) => item.side === 'defender')?.dumps[0]
    expect(defenderDump).toBeDefined()
    expect(ctx.w.pickCombatSupplyDump('defender', defenderDump!.id)).toBe(true)
    expect(ctx.w.confirmCombatSupplySide('defender')).toBe(true)
    await nextTick()
    expect(ctx.w.confirmCombatSupply()).toBe(true)
    await nextTick()
    expect(tutorial.currentStep?.id).toBe('reaction-ar')

    // 5b) 守方行动值（玩家）：挑 AR 最高的那一枚宣布
    const defenderAr = [...ctx.w.battleDefenders].sort((a, b) => b.raw.ar - a.raw.ar)[0]
    expect(defenderAr).toBeDefined()
    ctx.w.combatInputs.defenderArUnitId = defenderAr!.instanceId
    expect(ctx.w.declareCombatArStep('defender')).toBe(true)
    await nextTick()
    expect(tutorial.currentStep?.id).toBe('reaction-terrain')

    // 5c) 守方防御地形（玩家）：沿用默认地形，确认地形 ⇒ 自动结算到战果
    expect(ctx.w.autoResolveCombatToOutcome()).toBe(true)
    await nextTick()
    /*
     * 这一仗按当前数值守方没有损失：自动结算一到战果，攻方那半（全灭）由脚本收完就收束了
     * ——所以「承受战果」这一步可能当场即过（引导直接落到弹幕）。守方真有损失时它才留下。
     */
    expect(['reaction-await', 'barrage-city']).toContain(tutorial.currentStep?.id)

    /*
     * 5d) 战果：攻方那半由脚本代点，守方这半由测试代玩家点（与界面同序）。
     * 每轮先让 post 监听跑一次（脚本替苏军推进），再处理轮到守方的那一段。
     */
    for (let guard = 0; guard < 16 && ctx.w.combatState?.finished !== true; guard++) {
      await nextTick()
      const battle = ctx.w.combatState
      if (battle === null || battle.finished === true) break
      const stage = battle.resolution.stage
      const score = ctx.w.combatRequirement
      if (battle.step === 'losses' && stage.startsWith('defender')) {
        expect(ctx.w.confirmCombatLosses()).toBe(true)
        continue
      }
      if (battle.step === 'options' && stage.startsWith('defender')) {
        ctx.w.combatInputs.optionRetreatHexes = 0
        ctx.w.combatInputs.optionLossPoints = score?.options ?? 0
        expect(ctx.w.confirmCombatOptions()).toBe(true)
        continue
      }
    }
    expect(ctx.w.combatState?.finished).toBe(true)
    expect(tutorial.reaction).toBe('done')
    const raw = ctx.w.combatState?.dice?.result.raw ?? null
    /*
     * 用户口径（2026-11-21）：反扑固定成「攻方被奇袭、取端列、进攻骰 2」的必败局，
     * 城里的苏军守军不受影响 —— 玩家后面的夺城步照样有城可攻。
     */
    const onCity = ctx.w.units.filter(
      (unit) => unit.hex.col === 19 && unit.hex.row === 27 && unit.isCombat,
    )
    expect(onCity.some((unit) => unit.side === 'soviet')).toBe(true)
    expect(onCity.some((unit) => unit.side === 'axis')).toBe(false)
    expect(raw?.startsWith('A')).toBe(true)
    expect(tutorial.currentStep?.id).toBe('barrage-city')

    // 6) 炮火压制维捷布斯克：10.0 全流程（教学固定骰，10.0a 炸出 DG）
    for (let guard = 0; guard < 12 && ctx.w.phase !== 'combat'; guard++) ctx.w.advanceSegmentNow()
    const cityDefenders = ctx.w.units.filter(
      (unit) => unit.side === 'soviet' && unit.hex.col === 19 && unit.hex.row === 27,
    )
    expect(cityDefenders.length).toBeGreaterThan(0)
    ctx.w.battleTarget = {
      hex: { col: 19, row: 27 },
      defenderIds: cityDefenders.map((unit) => unit.instanceId),
    }
    // 空军那一步把 19.28 留在轰炸目标上 ⇒ 炮兵这一步必须显式改指城格（10.0d）
    ctx.w.pickBarrageTargetAt({ col: 19, row: 27 })
    ctx.w.setBarrageActive(true)
    ctx.w.toggleBarrageUnit(artillery.instanceId)
    expect(ctx.w.beginBarrageNow()).toBe(true)
    // 10.1b：付款来源只能取盘上真实候选（HQ 投递 / 编内卡车拖取），不得凭空加补给站
    const supplyChoices = ctx.w.barrageSupplyDumpChoices
    expect(supplyChoices.length).toBeGreaterThan(0)
    // 该剧本由随摩步推进的编内卡车（装载中的 SP，12.1b）供这一发弹幕
    const truckSupply = supplyChoices.find((dump) => dump.id.startsWith('unit:'))
    expect(truckSupply).toBeDefined()
    expect(ctx.w.pickBarrageSupplyDump(truckSupply!.id)).toBe(true)
    // 这一发要付多少 T 由 10.1b 的列成本算；该剧本炮兵带 −2T 修正，故只需 1 T
    // （编内卡车那 1 SP 按 3.3a 折 4 T，付得起这 1 T，不另加补给站）
    expect(ctx.w.barragePayNeedT).toBe(1)
    expect(ctx.w.confirmBarrageSupplyStep()).toBe(true)
    // 真扣款（12.3a）：编内卡车上的 SP 必须实打实扣掉（1 → 0）
    expect(ctx.w.spDumps.find((dump) => dump.id === truckSupply!.id)?.sp ?? 0).toBe(0)
    expect(ctx.w.confirmBarrageShiftsStep()).toBe(true)
    // 10.0a：骰 12 必出 DG，把城里的守军打残，第 25 步的攻入才有胜算
    ctx.w.barrageInputs.die = 12
    ctx.w.barrageInputs.halfDie = 4
    expect(ctx.w.rollBarrageDiceStep()).toBe(true)
    const stepLosses = ctx.w.barrageSummary?.unitOutcome?.stepLosses ?? 0
    if (stepLosses > 0) {
      // 10.0a：损失必须按目标格内的守军足额分配（单枚吃不下就跨枚接着吃）
      const losses: Record<string, number> = {}
      let remaining = stepLosses
      for (const unit of [...ctx.w.barrageLossTargets].sort((a, b) => b.steps - a.steps)) {
        if (remaining <= 0) break
        const take = Math.min(remaining, unit.steps)
        if (take > 0) {
          losses[unit.instanceId] = take
          remaining -= take
        }
      }
      expect(remaining).toBe(0)
      ctx.w.barrageInputs.losses = losses
    }
    expect(ctx.w.confirmBarrageOutcomeStep()).toBe(true)
    expect(ctx.w.barrageState?.finished).toBe(true)
    expect(ctx.w.barrageState?.targetHex).toEqual({ col: 19, row: 27 })
    expect(tutorial.currentStep?.id).toBe('capture-city')

    // 第 25 步：攻入维捷布斯克 —— 18.27 的两枚德军压上城格，走 9.2 九步
    // 10.0 的炮击会话必须先收走，才允许换环节（canReplaceBarrage）
    ctx.w.clearBarrage()
    expect(ctx.w.setSegmentStepIndex(1)).toBe(true)
    ctx.w.setBattleMode('full')
    const siege = ctx.w.units.filter(
      (unit) => unit.hex.col === 18 && unit.hex.row === 27 && unit.side === 'axis' && unit.isCombat,
    )
    expect(siege.length).toBe(2)
    // 9.1：宣告交战要先选中一个攻方算子（战斗环节不可移动 ⇒ 这里只做只读选中）
    ctx.w.selectForMove({ col: 18, row: 27 }, [siege[0]!.instanceId])
    expect(ctx.w.selectedUnit?.instanceId).toBe(siege[0]!.instanceId)
    ctx.w.openBattle({ col: 19, row: 27 })
    expect(ctx.w.battleTarget?.hex).toEqual({ col: 19, row: 27 })
    expect(ctx.w.battleDefenders.length).toBe(2)
    for (const unit of siege) ctx.w.toggleCombatAttacker(unit.instanceId)
    expect(ctx.w.combatAttackers.length).toBe(2)
    expect(ctx.w.beginCombatNow()).toBe(true)
    expect(ctx.w.combatState?.step ?? 'NULL').toBe('combatSupply')
    // 9.5 / 12.4：攻方这一仗的车马费仍由随摩步前推的编内卡车付（12.1b：装载中的 SP 算补给站）
    const battleTruck = ctx.w.combatSupplyDumps
      .find((group) => group.side === 'attacker')
      ?.dumps.find((dump) => dump.id.startsWith('unit:'))
    expect(battleTruck).toBeDefined()
    expect(ctx.w.pickCombatSupplyDump('attacker', battleTruck!.id)).toBe(true)
    expect(ctx.w.confirmCombatSupply()).toBe(true)
    expect(ctx.w.combatState?.step).toBe('declareAr')
    // 9.6：攻方先宣布 AR 单位，守方后宣布
    ctx.w.combatInputs.attackerArUnitId = siege[0]!.instanceId
    expect(ctx.w.declareCombatArStep('attacker')).toBe(true)
    ctx.w.combatInputs.defenderArUnitId = ctx.w.battleDefenders[0]!.instanceId
    expect(ctx.w.declareCombatArStep('defender')).toBe(true)
    // 9.4b / 9.7：守方宣布地形并定初始攻防比
    expect(ctx.w.declareCombatTerrainStep()).toBe(true)
    expect(ctx.w.combatState?.step).toBe('surprise')
    // 教学演出：这一步的奇袭/骰面由教学脚本钉死（否则 2d6 随机一输就卡死）
    expect(combatFixedSurprise.value).toEqual({ die: 12, shiftDie: 6 })
    expect(combatFixedDie.value).toBe(8)
    expect(ctx.w.rollCombatSurprise()).toBe(true)
    if (ctx.w.combatAwaitingShiftDie) expect(ctx.w.rollCombatShiftDie()).toBe(true)
    expect(ctx.w.rollCombatDice()).toBe(true)
    /*
     * 9.11 / 9.10 / 9.12：按实际待决的步子逐步确有地推进；守方的选项点数全部换成军力损失
     * （不换撤退格），把城里守军吃干净，攻方才能推进占城。
     */
    let guard = 0
    while (guard < 12) {
      guard += 1
      const step = ctx.w.combatState?.step
      if (step === 'losses') {
        expect(ctx.w.confirmCombatLosses()).toBe(true)
        continue
      }
      if (step === 'options') {
        const stage = ctx.w.combatState?.resolution.stage ?? ''
        const units = stage.startsWith('attacker') ? ctx.w.combatAttackers : ctx.w.battleDefenders
        const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
        const pending = ctx.w.combatRequirement
        if (pending !== null && pending.options > 0 && pending.options <= capacity) {
          ctx.w.combatInputs.optionRetreatHexes = 0
          ctx.w.combatInputs.optionLossPoints = pending.options
        }
        expect(ctx.w.confirmCombatOptions()).toBe(true)
        continue
      }
      break
    }
    // 9.12g：防御格已空 ⇒ 攻方战后推进，进格即占领维捷布斯克
    expect(ctx.w.combatState?.step).toBe('advance')
    ctx.w.combatInputs.advanceUnitIds = [siege[0]!.instanceId]
    expect(ctx.w.confirmCombatAdvance()).toBe(true)
    expect(ctx.w.combatState?.finished).toBe(true)
    expect(
      ctx.w.units.some(
        (unit) =>
          unit.side === 'axis' && unit.isCombat && unit.hex.col === 19 && unit.hex.row === 27,
      ),
    ).toBe(true)
    expect(ctx.w.battleDefenders.length).toBe(0)
    // 城格易手 ⇒ 教学最后一步也随之收束
    await nextTick()
    expect(tutorial.currentStep ?? null).toBeNull()
    // 教学收束时产品必须自己收回演出固定骰，否则本局后续战斗全被钉死（此处不再手动兜底）
    expect(combatFixedDie.value).toBeNull()
    expect(combatFixedSurprise.value).toBeNull()
    tutorial.stop()
  }, 120_000)

  it('教学脚本：两队 Ju.88 + Do.17z + Bf110 轰炸、扫荡两败俱伤、固定拦截骰、AI 苏军不代打（源码守卫）', () => {
    const source = readFileSync('src/stores/tutorial.ts', 'utf8')
    // 14.2a：四机齐出（两队 Ju.88 + 一队 Do.17z + 一队未扫荡的 Bf110）
    expect(source).toContain("'ax-aircraft-ge-do-17z'")
    expect(source).toContain('tutorial-axis-ju88-2')
    // 14.6：扫荡用另一架 Bf110，2d6=6 + ACV 3 − 2 = 7 ⇒ 双方返航；损失骰 5 ⇒ 各损 1
    expect(source).toContain('airCombatDice = [{ die: 6, lossDie: 5 }]')
    // 文案口径：不写格子编号，巡逻区讲成「从拦截距离内起飞迎击」
    expect(source).toContain('从拦截距离内起飞迎击')
    // 14.3e：拦截空战固定 2d6=6（轴心胜）；10.0a：轰炸骰固定 11（DG + 1 军力损失）
    expect(source).toContain('interceptDie = 6')
    expect(source).toContain('barrageInputs.die = 12')
    // 逐枚高亮：同名机两枚，只能按实例 id 框住当前该点的那枚
    const guide = readFileSync('src/components/tutorial/TutorialGuide.vue', 'utf8')
    const panel = readFileSync('src/components/air/AirPanel.vue', 'utf8')
    expect(guide).toContain('data-air-instance-id')
    expect(panel).toContain(':data-air-instance-id="item.air.instanceId"')
    // 2026-11-21：教学是 PvE 外壳、苏军由脚本固定行动 ⇒ 反应段「脚本接管才代打」，普通 PvE 才让位给 AI
    expect(source).toContain("if (hotseat.scriptedSide !== 'soviet') return")
    // 不能跳过这一步：反扑不得再有 skipped 通道
    expect(source).not.toContain("reaction.value === 'skipped'")
  })

  it('引导文案：霍特口径短句、单位介绍与按钮级目标齐备', async () => {
    const ctx = fresh()
    const tutorial = useTutorialStore()
    tutorial.stop()
    setTutorialAirAllInactive(true)
    tutorial.startFor()
    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    expect(ctx.g.setFirstWeatherChoice('normal', 'Intro')).toBe(true)
    await placeTutorialSetup(ctx)
    expect(ctx.setup.startGameNow(), ctx.setup.lastAction?.detail).toBe(true)
    await nextTick()

    const steps = tutorial.steps
    const source = readFileSync('src/stores/tutorial.ts', 'utf8')
    expect(steps.length).toBeGreaterThanOrEqual(16)
    expect(steps.map((step) => step.id)).toEqual([
      'setup-soviet',
      'setup-air',
      'setup-start',
      'air-refit',
      'reinforce-sp',
      'advance-rebuild',
      'rebuild-open',
      'rebuild-place',
      'move-mode',
      'fuel',
      'scout',
      'scout-supply',
      'strafe-1',
      'strafe-2',
      'move',
      'overrun-1',
      'combat-supply',
      'combat-ar',
      'combat-finish',
      'artillery-move',
      'fighter-sweep',
      'bombing',
      'reaction-attack',
      'reaction-supply',
      'reaction-ar',
      'reaction-terrain',
      'reaction-await',
      'barrage-city',
      'capture-city',
    ])
    // 每条提示都短（一行）且以霍特口吻下达
    expect(steps.every((step) => step.hint.length <= 40)).toBe(true)
    expect(steps.filter((step) => step.hint.includes('霍特')).length).toBeGreaterThanOrEqual(10)
    // 单位介绍穿插在关键步
    // 加油步讲的是「编队法 + 支付流程」（用户 2026-11-20 口径）
    expect(steps.find((step) => step.id === 'fuel')?.intro).toContain('补给堆')
    expect(steps.find((step) => step.id === 'strafe-1')?.intro).toContain('斯图卡')
    // 选机阶段（打开任务面板后）才逐枚高亮斯图卡；见 hipShoot 助手里的按钮断言
    // 文案口径（docs/教学文案.md）：不写格子编号 ⇒ 讲「截击机够得着的距离内 / 拦截距离」
    expect(steps.find((step) => step.id === 'fighter-sweep')?.intro).toContain('LaGG.3')
    expect(steps.find((step) => step.id === 'fighter-sweep')?.hint).toContain('Bf110')
    expect(steps.find((step) => step.id === 'bombing')?.intro).toContain('Ju.88')
    expect(steps.find((step) => step.id === 'bombing')?.intro).toContain('起飞迎击')
    // 引导真实指到按钮
    expect(steps.find((step) => step.id === 'air-refit')?.target.buttonTexts).toContain('整备')
    // 突袭只打 18.27 的坦克师；炮兵另有弹幕步、空军另有空袭步
    expect(steps.find((step) => step.id === 'overrun-1')?.target.hex).toEqual({
      col: 18,
      row: 27,
    })
    expect(steps.find((step) => step.id === 'artillery-move')?.target.hex).toEqual({
      col: 17,
      row: 27,
    })
    expect(steps.find((step) => step.id === 'barrage-city')?.target.hex).toEqual({
      col: 19,
      row: 27,
    })
    // 空军轰的是大城 19.28（小城交给炮兵与地面进攻）——轰炸目标随任务状态给，这里查常量
    expect(source).toContain('const BOMB_HEX: HexRef = { col: 19, row: 28 }')
    expect(steps.find((step) => step.id === 'capture-city')?.target.hex).toEqual({
      col: 19,
      row: 27,
    })
    // 炮兵团没有进攻能力（括号攻击值）⇒ 说明里不得再出现「炮兵团参与突袭」的口径
    const overrunIntro = steps.find((step) => step.id === 'overrun-1')?.intro ?? ''
    expect(overrunIntro).toContain('没有进攻能力')
    // 摩步战斗面 MA 3（8-4-3）、移动面 14：突袭一次 3 MP，两连突 6 MP
    expect(steps.find((step) => step.id === 'move-mode')?.intro).toContain('8-4-3')
    expect(steps.find((step) => step.id === 'scout')?.intro).toContain('控制区')
    // 增援段「高亮一个放一个」：SP → Pax → Eq 逐张框手牌卡（按 title 短串命中）
    expect(source).toContain("buttonTexts: ['到货 SP']")
    expect(source).toContain("buttonTexts: ['补员表 · Pax']")
    expect(source).toContain("buttonTexts: ['补员表 · Eq']")
    // 侦察营：停下即过（不再死认 18.26 一格）
    expect(source).toContain('scoutMoved')
    // 12.5a：加油步必须要求「堆里每个战斗单位都加过油」，否则 MC 没油开不动会把引导卡死
    expect(source).toContain('stackCombatFuelled')
    expect(source).toContain('scout.mpSpent > 0')
  }, 20_000)
})

/**
 * 教学初设（用户 2026-11-23 口径）
 *
 * 苏方初设是**自动的**：`tutorial.ts` 的 `autoPlaceScriptedSetup` 在初设一落到苏方就把它落完并换手，
 * 玩家不点「自动放置」；轴心的 7 架飞机仍要玩家自己逐枚放回图外空军盒（专规 1.4a），再确认本方布设。
 */
async function placeTutorialSetup(ctx: Ctx): Promise<void> {
  // 自动布设挂在初设状态的 post 监听上：等它把游标交到轴心
  for (let guard = 0; guard < 6 && ctx.setup.setupSideCursor === 'soviet'; guard += 1)
    await nextTick()
  expect(ctx.setup.setupSideCursor).toBe('axis')
  // 苏方条目已落完（不再有苏方待定项），轴心的飞机一枚都没被代放
  expect(ctx.setup.pendingPlacement.filter((item) => item.side === 'soviet')).toHaveLength(0)
  const plan = ctx.setup.airPlanOf('axis')?.placements.filter((row) => row.count > 0)
  expect(plan?.length ?? 0).toBeGreaterThan(0)
  let placedAir = 0
  for (const row of plan ?? [])
    for (let copy = 0; copy < row.count; copy += 1) {
      expect(ctx.setup.placeAirInOffMapBoxNow('axis', row.entryIndex)).toBe(true)
      placedAir += 1
    }
  expect(placedAir).toBe(7)
  expect(ctx.setup.currentSideSetupBlocker).toBeNull()
  expect(ctx.setup.confirmSideSetup()).toBe(true)
}

type Ctx = ReturnType<typeof fresh>

function tutorialStep(_ctx: Ctx) {
  const tutorial = useTutorialStore()
  const step = tutorial.currentStep
  expect(step).not.toBeNull()
  return step!
}

/** 开教学局并走到「移动完成、右键扫射」这一步（与第 2 条用例共用） */
async function startTutorial(prepare?: (ctx: Ctx) => void): Promise<Ctx> {
  const ctx = fresh()
  prepare?.(ctx)
  const tutorial = useTutorialStore()
  tutorial.stop()
  setTutorialAirAllInactive(true)
  setTutorialFixedReinforcement(true)
  tutorial.startFor()

  expect(ctx.setup.enterSetup('Intro')).toBe(true)
  expect(ctx.g.setFirstWeatherChoice('normal', 'Intro')).toBe(true)
  await placeTutorialSetup(ctx)
  expect(ctx.setup.startGameNow(), ctx.setup.lastAction?.detail).toBe(true)
  await nextTick()

  expect(tutorial.currentStep?.id).toBe('air-refit')
  expect(useContainersStore().activateAirBox('axis')).toBe(true)
  expect(tutorial.currentStep?.id).toBe('reinforce-sp')

  ctx.w.advanceSegmentNow()
  ctx.w.advanceSegmentNow()
  expect(ctx.w.phase).toBe('reinforcement')
  expect(ctx.w.applySupplyArrivalsNow()).toBe(true)

  /*
   * 2026-11-19：新增 13.5 重建教学
   *
   * 补给落完 ⇒ 进入下一环节到重建段；玩家在死亡堆选中侦察营即自动进入选格
   * （pickDeadPileUnitNow → beginDeadPileRebuildNow，2026-11-18 口径），再点 14.28 落地。
   * 教学只保留「选中死亡堆 → 点高亮格」两步：引擎里没有独立的「下达重建」动作。
   */
  /*
   * 2026-11-19（用户改口径）：补员不从旁路注入，改由 1.6b 补员表发放
   * （教学固定 Pax ×1 / Eq ×1）⇒ 测试也要按玩家路径掷表并落位。
   * Eq 必须落在重建格 5.28（13.5a：所需补员全在该格、战斗模式 HQ 2 格内）。
   */
  expect(ctx.w.rollVariableReplNow()).toBe(true)
  expect(ctx.w.beginReplPlaceHexPickNow('eq')).toBe(true)
  expect(ctx.w.pickHexFor({ col: 5, row: 27 })).toBe(true)
  expect(ctx.w.beginReplPlaceHexPickNow('pax')).toBe(true)
  expect(ctx.w.pickHexFor({ col: 5, row: 27 })).toBe(true)

  for (let n = 0; n < 4 && ctx.w.segmentStep?.id !== 'reinforcement.rebuild'; n++) {
    expect(ctx.w.advanceSegmentNow()).not.toBeNull()
  }
  expect(ctx.w.segmentStep?.id).toBe('reinforcement.rebuild')
  ctx.w.pickDeadPileUnitNow('tutorial-axis-recon')
  expect(ctx.w.deadPilePickId).toBe('tutorial-axis-recon')
  // 选中即自动进入选格：地图已高亮 13.5a 合法落点，教学应前进到「点高亮格」
  expect(ctx.w.hexPickView?.label).toBe('重建落点（13.5a 合法格）')
  expect(tutorial.currentStep?.id).toBe('rebuild-place')
  expect(ctx.w.pickHexFor({ col: 5, row: 27 })).toBe(true)
  expect(ctx.w.units.some((unit) => unit.unitId === 'ax-arm_rec-ge-14-mtr-14-arm-rec')).toBe(true)

  await progress(ctx, () => ctx.w.phase === 'movement')

  const motIds = ['ax-motorized-ge-20-mtr-76-mot-inf', 'ax-motorized-ge-20-mtr-90-mot-inf']
  const scoutId = 'ax-motorized-ge-20-mtr-30-mc'

  // ① 两个摩步先翻移动面（战斗面 MA 3 不够两连突）
  const motUnits = motIds.map((id) => ctx.w.units.find((unit) => unit.unitId === id)!)
  for (const unit of motUnits) {
    ctx.w.selectedId = unit.instanceId
    if (unit.mode.mode !== 'move') ctx.w.switchUnitMode('move')
  }
  expect(motUnits.every((unit) => unit.mode.mode === 'move')).toBe(true)
  expect(tutorial.currentStep?.id).toBe('fuel')

  // ② 编队法加油：整堆一次付清，油从补给堆里扣
  const stack = ctx.w.units.filter((unit) => unit.hex.col === 14 && unit.hex.row === 27)
  const ids = stack.map((unit) => unit.instanceId)
  ctx.w.beginMovePick({ col: 14, row: 27 }, ids)
  ctx.w.fuelMethod = 'formation'
  const dump = ctx.w.fuelDumpChoices?.[0]
  if (dump !== undefined) ctx.w.pickFuelDump(dump.id)
  ctx.w.payFuel()
  expect(stack.every((unit) => unit.fuelled)).toBe(true)
  expect(tutorial.currentStep?.id).toBe('scout')

  // ③ 30 侦察营（履带）无视 ZOC 绕进 18.26
  const scout = ctx.w.units.find((unit) => unit.unitId === scoutId)!
  ctx.w.beginMovePick({ col: 14, row: 27 }, [scout.instanceId])
  expect(ctx.w.confirmMovePick()).toBe(true)
  const scoutNode = (ctx.w.groupReachable?.hexes ?? []).find(
    (item) => item.hex.col === 18 && item.hex.row === 26,
  )
  expect(scoutNode).toBeDefined()
  expect(ctx.w.moveAlongDraggedPath(scoutNode?.path ?? [])).toBe(true)
  expect(`${scout.hex.col}.${scout.hex.row}`).toBe('18.26')
  expect(tutorial.currentStep?.id).toBe('scout-supply')

  // ④ 两个摩步推到 17.27（突袭 18.27 的前置格）
  ctx.w.finishMove()
  ctx.w.beginMovePick(
    { col: 14, row: 27 },
    motIds.map((id) => ctx.w.units.find((u) => u.unitId === id)!.instanceId),
  )
  expect(ctx.w.confirmMovePick()).toBe(true)
  const node = (ctx.w.groupReachable?.hexes ?? []).find(
    (item) => item.hex.col === 17 && item.hex.row === 27,
  )
  expect(node).toBeDefined()
  expect(ctx.w.moveAlongDraggedPath(node?.path ?? [])).toBe(true)
  expect(hexDistance({ col: 17, row: 27 }, { col: 18, row: 27 })).toBe(1)
  return ctx
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
  // 第一轮扫射正好也是「补给接不上」信息步的放行条件（那一步只指格、不指按钮）
  expect(['scout-supply', 'strafe-1', 'strafe-2']).toContain(stepNow?.id)
  if (stepNow?.id !== 'scout-supply') {
    expect(stepNow?.target.buttonTexts).toContain('Ju.87b')
    expect(stepNow?.target.airInstanceId).toBeTruthy()
  }
  const plane = ctx.w.airUnits.find(
    (air) =>
      air.side === 'axis' &&
      air.airStatus === 'active' &&
      air.canHipShoot &&
      air.aircraftId === 'ax-aircraft-ge-ju-87b',
  )
  expect(plane).toBeDefined()
  if (stepNow?.id !== 'scout-supply') expect(stepNow?.target.airInstanceId).toBe(plane!.instanceId)
  ctx.w.toggleAirMissionUnit(plane!.instanceId)
  expect(mapView.advanceOpsFlow()).toBe(true)
  ctx.w.autoResolveAirMissionNow()
  if (ctx.w.airState?.step === 'resolveMission') ctx.w.settleAirMissionNow()
  if (ctx.w.airState?.step === 'returnToBase') ctx.w.completeAirReturnNow()
  return plane
}
