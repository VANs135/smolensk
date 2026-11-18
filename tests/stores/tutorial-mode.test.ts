import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import { hexDistance } from '@/engine/hex-geometry'
import { useContainersStore, useTutorialStore } from '@/stores'
import { setTutorialAirAllInactive } from '@/stores/tutorial-settings'
import { fresh, progress } from '../flows/flow-harness'

/**
 * Vitebsk 教学模式（用户 2026-11-18 第 2 条）
 *
 * 覆盖：
 *   · 教学开局把空军盒内的飞机置为未激活（14.1a 的整备才有对象）；
 *   · 引导状态机按「初设飞机 → 整备 → 增援 SP → 加油 → 移动 → 低空扫射 → 突袭 → 战斗补给 → AR」
 *     逐步放行，前一步没做完不放开下一步；
 *   · 天气固定正常。
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

    const boxed = ctx.w.airUnits.filter((air) => ctx.w.airBoxMembers.includes(air.instanceId))
    expect(boxed.length).toBe(7)
    expect(boxed.every((air) => air.airStatus === 'inactive')).toBe(true)

    const containers = useContainersStore()
    expect(containers.activateAirBox('axis')).toBe(true)
    expect(boxed.every((air) => air.airStatus === 'active')).toBe(true)
    expect(tutorial.currentStep?.id).toBe('reinforce-sp')
  })

  it('引导按真实操作逐项推进，直到选完提供 AR 的单位', async () => {
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

    // A 整备：未整备前，后面即使做了动作也不放行
    expect(tutorial.currentStep?.id).toBe('air-refit')
    expect(useContainersStore().activateAirBox('axis')).toBe(true)
    expect(tutorial.currentStep?.id).toBe('reinforce-sp')

    // 推进到 B，落账补给表 SP
    ctx.w.advanceSegmentNow()
    ctx.w.advanceSegmentNow()
    expect(ctx.w.phase).toBe('reinforcement')
    expect(ctx.w.applySupplyArrivalsNow()).toBe(true)
    expect(tutorial.currentStep?.id).toBe('fuel')

    await progress(ctx, () => ctx.w.phase === 'movement')
    expect(ctx.w.phase).toBe('movement')
    expect(tutorial.currentStep?.id).toBe('fuel')

    // 加油（编队）→ 切移动模式 → 走到苏军旁边
    const stack = ctx.w.units.filter((unit) => unit.hex.col === 14 && unit.hex.row === 27)
    const ids = stack.map((unit) => unit.instanceId)
    ctx.w.beginMovePick({ col: 14, row: 27 }, ids)
    ctx.w.fuelMethod = 'formation'
    const dump = ctx.w.fuelDumpChoices?.[0]
    if (dump !== undefined) ctx.w.pickFuelDump(dump.id)
    ctx.w.payFuel()
    expect(stack.every((unit) => unit.fuelled)).toBe(true)
    expect(tutorial.currentStep?.id).toBe('move')

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
    expect(tutorial.currentStep?.id).toBe('airstrike')

    // 低空扫射：任务结算完成即放行（骰子是否 DG 由规则决定，不拿骰子卡教学）
    const { useMapViewStore } = await import('@/stores')
    const mapView = useMapViewStore()
    const target = ctx.w.units.find((unit) => unit.hex.col === 18 && unit.hex.row === 27)
    expect(target).toBeDefined()
    mapView.openUnitContext(target!.hex, target!.instanceId, { x: 0, y: 0 })
    expect(mapView.openContextAction(target!.instanceId, 'ops.hipShoot')).toBe(true)
    const plane = ctx.w.airUnits.find(
      (air) => air.side === 'axis' && air.airStatus === 'active' && air.canHipShoot,
    )
    expect(plane).toBeDefined()
    ctx.w.toggleAirMissionUnit(plane!.instanceId)
    mapView.advanceOpsFlow()
    ctx.w.autoResolveAirMissionNow()
    ctx.w.settleAirMissionNow()
    expect(tutorial.currentStep?.id).toBe('overrun')

    // 突袭 → 战斗补给 → AR
    expect(ctx.w.overrunNow({ col: 18, row: 27 })).toBe(true)
    expect(ctx.w.combatState?.attackType).toBe('overrun')
    expect(tutorial.currentStep?.id).toBe('combat-supply')

    const attackerDump = ctx.w.combatSupplyDumps.find((item) => item.side === 'attacker')?.dumps[0]
    if (attackerDump !== undefined) ctx.w.pickCombatSupplyDump('attacker', attackerDump.id)
    ctx.w.confirmCombatSupplySide('attacker')
    ctx.w.confirmCombatSupplySide('defender')
    expect(ctx.w.confirmCombatSupply()).toBe(true)
    expect(tutorial.currentStep?.id).toBe('combat-ar')

    expect(ctx.w.combatState?.declaredAttackerArUnitId).toBeUndefined()
    expect(ctx.w.declareCombatArStep('attacker')).toBe(true)
    expect(ctx.w.combatState?.declaredAttackerArUnitId).not.toBeUndefined()
    expect(tutorial.currentStep).toBeNull()
    expect(tutorial.completed).toBe(true)

    tutorial.stop()
  }, 20_000)
})
