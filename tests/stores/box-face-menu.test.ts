import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  actionGateOf,
  useContainersStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

import {
  CORE_HEX,
  airBaseRecord,
  fighterRecord,
  groundRecord,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 图外盒贴图菜单（用户 2026-11-18）
 *
 * 口径：盒内算子**直接在贴图上**左键选中、右键出菜单；菜单按当前环节与该单位实际可做的动作给，
 * 能做的才出现。贴图上能完成的动作不再另开同名弹窗（死亡堆 / 空军盒不再因展开卡而顶出会话）。
 */

const DEAD_CARD = 'axis-dead-pile'
const AIR_CARD = 'axis-airfields'
const OFFBOARD_CARD = 'axis-offboard'

const repoPath = (relative: string): string => resolve(process.cwd(), relative)
const read = (absolute: string): string => readFileSync(absolute, 'utf8')

function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

function stores(side: 'axis' | 'soviet' = 'axis') {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide(side)
  useHotseatStore().setViewerSide(side)
  return {
    workbench,
    mapView: useMapViewStore(),
    containers: useContainersStore(),
    hotseat: useHotseatStore(),
  }
}

// 拆分单位被毁按 13.5b 返回资源池，不进死亡堆 ⇒ 菜单夹具取普通战斗单位
const axisGround = () =>
  groundRecord('axis', (record) => record.isCombat === true && record.branch !== 'breakdown')

describe('死亡堆贴图菜单（13.5）', () => {
  it('★ 右键菜单给既有能力（重建 / 返场落点 / 永久移除），不再靠弹窗', () => {
    const { workbench, mapView } = stores()
    const unit = placeGround(workbench, axisGround(), CORE_HEX, 'axis', 'dead-1')
    workbench.sendToDeadPileNow(unit.instanceId)

    const keys = mapView.boxUnitActions(DEAD_CARD, unit.instanceId).map((item) => item.key)
    expect(keys).toContain('deadPile.returnHex')
    // 不在增援重建环节 ⇒ 重建（13.5）与永久移除（13.5c）都不摆（能做的才出现）
    expect(keys).not.toContain('deadPile.rebuild')
    expect(keys).not.toContain('deadPile.removeForever')
  })

  it('★ 菜单执行落既有入口：永久移除后死亡堆真的少一枚', () => {
    const { workbench, mapView } = stores()
    const unit = placeGround(workbench, axisGround(), CORE_HEX, 'axis', 'dead-2')
    workbench.sendToDeadPileNow(unit.instanceId)
    // 13.5c 只在 B 增援·重建/到货环节放行（`rein.rebuild`），先走到那一步
    workbench.setPhase('reinforcement')
    goToActionStep(workbench, 'rein.rebuild')

    expect(mapView.boxUnitActions(DEAD_CARD, unit.instanceId).map((item) => item.key)).toContain(
      'deadPile.removeForever',
    )
    expect(mapView.runBoxUnitAction(DEAD_CARD, unit.instanceId, 'deadPile.removeForever')).toBe(
      true,
    )
    expect(workbench.deadPile.some((item) => item.instanceId === unit.instanceId)).toBe(false)
  })

  it('★ 展开死亡堆卡不再顶出盒内动作会话（贴图已承载）', () => {
    const { mapView, containers } = stores()
    containers.toggleCardOpen(DEAD_CARD)
    expect(containers.openCardNeedsWindow).toBe(false)
    expect(mapView.session?.kind).not.toBe('containers')
  })
})

describe('空军盒贴图菜单（10.0d / 14.x / 15.1）', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores('axis')
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'air.mission')
  })

  it('★ C 移动环节右键盒内激活机 ⇒ 出本环节允许的空军任务项', () => {
    placeGround(s.workbench, airBaseRecord(2), CORE_HEX, 'axis', 'base-air')
    const plane = placeAir(
      s.workbench,
      fighterRecord('axis'),
      CORE_HEX,
      'axis',
      'plane-1',
      'active',
    )
    s.workbench.setAirInBoxMembership(plane.instanceId, true)

    const keys = s.mapView.boxUnitActions(AIR_CARD, plane.instanceId).map((item) => item.key)
    const choices = s.workbench.airMissionKindChoices.map(
      (choice) => `airUnitMission:${choice.key}`,
    )
    expect(choices.length).toBeGreaterThan(0)
    for (const key of choices) expect(keys).toContain(key)

    const first = s.workbench.airMissionKindChoices[0]!
    expect(
      s.mapView.runBoxUnitAction(AIR_CARD, plane.instanceId, `airUnitMission:${first.key}`),
    ).toBe(true)
    expect(s.workbench.airMissionAirIds).toContain(plane.instanceId)
    expect(s.workbench.airMissionKind).toBe(first.key)
  })

  it('★ A 整备段右键盒内非激活机 ⇒ 不再提供整备（唯一入口在盒内「整备」按钮）', () => {
    const plane = placeAir(
      s.workbench,
      fighterRecord('axis'),
      CORE_HEX,
      'axis',
      'plane-2',
      'inactive',
    )
    s.workbench.setAirInBoxMembership(plane.instanceId, true)
    s.workbench.setPhase('aircraftRefit')
    goToActionStep(s.workbench, 'air.refit')

    const keys = s.mapView.boxUnitActions(AIR_CARD, plane.instanceId).map((item) => item.key)
    expect(keys).not.toContain('airUnitRefitBox')
    expect(s.mapView.runBoxUnitAction(AIR_CARD, plane.instanceId, 'airUnitRefitBox')).toBe(false)
    // 入口仍在：空军盒名册的「整备盒内飞机」按钮走同一个 store 动作
    expect(s.containers.activateAirBox('axis')).toBe(true)
    expect(plane.airStatus).toBe('active')
  })

  it('★ 展开空军盒卡也不顶出盒内动作会话', () => {
    s.containers.toggleCardOpen(AIR_CARD)
    expect(s.containers.openCardNeedsWindow).toBe(false)
    expect(s.mapView.session?.kind).not.toBe('containers')
  })
})

describe('地图空军堆叠窗内右键飞机（14.2e）', () => {
  it('★ 机场贴图上的飞机 chip 右键 ⇒ 与盒内同源的空军任务菜单', () => {
    const s = stores('axis')
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'air.mission')
    placeGround(s.workbench, airBaseRecord(2), CORE_HEX, 'axis', 'base-air')
    const plane = placeAir(
      s.workbench,
      fighterRecord('axis'),
      CORE_HEX,
      'axis',
      'plane-map',
      'active',
    )

    expect(
      s.mapView.openUnitContext(
        CORE_HEX,
        plane.instanceId,
        { x: 0, y: 0 },
        { fromStackWindow: true },
      ),
    ).toBe(true)
    const menu = s.mapView.contextOptions.find((item) => item.id === plane.instanceId)
    expect(menu, '飞机 chip 必须出它自己的菜单').toBeDefined()
    const keys = menu!.actions.map((item) => item.key)
    expect(keys.some((key) => key.startsWith('air.unit.mission:'))).toBe(true)
  })
})

describe('地图外盒：展开只开卡面，拆分取用由贴图按钮显式请求', () => {
  it('★ 展开地图外盒不再自动顶窗；requestCardWindow 后才开，换卡/收起即作废', () => {
    const { containers } = stores()

    containers.toggleCardOpen(OFFBOARD_CARD)
    expect(containers.openCardNeedsWindow).toBe(false)
    expect(containers.requestCardWindow()).toBe(true)
    expect(containers.openCardNeedsWindow).toBe(true)

    // 收起再展开 ⇒ 旧请求作废（不会莫名其妙又弹窗）
    containers.toggleCardOpen(OFFBOARD_CARD)
    containers.toggleCardOpen(OFFBOARD_CARD)
    expect(containers.openCardNeedsWindow).toBe(false)

    // 死亡堆 / 空军盒：贴图已覆盖，连显式请求也不开门
    containers.toggleCardOpen(AIR_CARD)
    expect(containers.requestCardWindow()).toBe(false)
    expect(containers.openCardNeedsWindow).toBe(false)
  })

  it('★ 贴图上确有「拆分取用…」按钮（唯一入口）', () => {
    const source = read(repoPath('src/components/game/BoxCardFace.vue'))
    expect(source).toContain('breakdownFaceAvailable')
    expect(source).toContain('requestCardWindow')
    expect(source).toContain('拆分取用')
  })
})
