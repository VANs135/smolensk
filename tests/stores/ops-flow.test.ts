import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'

import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import {
  actionGateOf,
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ConsolePhase,
} from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  groundRecord,
  label,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 三操作统一流程（2026-11-10 规格 §0–§5）
 *
 * 钉四件事：
 *   ① 炮击入口判据 = 10.1a 射程覆盖 + 10.0e 账本 + **10.1b 付得起**（付不起 ⇒ 菜单项缺席）；
 *   ② 右键菜单三项与窗内候选**同源**（都走 `barrageCandidatesAt` / `bombingCandidatesAt`）；
 *   ③ 第 1 步 → 第 2 步由 `advanceOpsFlow` 把球交给既有状态机（`barrageState` / `airState`）；
 *   ④ 地图外空军盒是**独立基地分组**且可出击（2.1C 只禁盒内战斗）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 把 store 放到允许该动作的环节（与既有流程测试同一路） */
function enterStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: Parameters<typeof actionGateOf>[0],
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

const TARGET_HEX: HexRef = NEAR_HEX

/** 敌方目标格守军（10.0a 的战斗单位目标） */
function defenderRecord() {
  return groundRecord('soviet', (record) => record.isCombat === true)
}

/** 带印刷轰炸值与射程的火炮（10.0e-B / 10.1a / 10.1b） */
function artilleryRecord() {
  return groundRecord(
    'axis',
    (record) =>
      (record.factors?.combat?.barrage ?? 0) > 0 && (record.factors?.combat?.range ?? 0) > 0,
  )
}

/** 有低空扫射能力的轴方机（14.7d-B） */
function hipShootRecord() {
  const found = aircraftChoices('axis').find(
    (record) => record.airAbilities?.canHipShoot === true && (record.barrageStrength ?? 0) > 0,
  )
  if (found === undefined) throw new Error('轴方飞机库中没有可低空扫射的机')
  return found
}

function airBaseRecord() {
  return groundRecord('axis', (record) => record.noncombatKind === 'air_base')
}

/** 炮击现场：C 段/F 段轰炸环节 + 邻格火炮 + 目标格守军 + 一座补给站 */
function setupBarrage(withDump: boolean) {
  const { workbench, mapView } = newStores()
  workbench.setPhase('combat')
  enterStep(workbench, 'barrage.declare')
  const gun = placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
  placeGround(workbench, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')
  if (withDump) {
    workbench.spDumps.push({ id: 'dump-1', hex: CORE_HEX, side: 'axis', sp: 0, t: 20 })
  }
  return { workbench, mapView, gun }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('炮击入口（10.1a / 10.0e / 10.1b）', () => {
  it('★ 射程覆盖 + 有补给 ⇒ 入口出现；付不起 ⇒ **项缺席**（不灰显、不弹提示）', () => {
    const funded = setupBarrage(true)
    expect(funded.workbench.barrageEntryEligible(TARGET_HEX)).toBe(true)

    const broke = setupBarrage(false)
    expect(broke.workbench.barrageEntryEligible(TARGET_HEX)).toBe(false)
    // 判据不过 ⇒ 右键菜单根本不出现（不是灰项）
    expect(broke.mapView.openUnitContext(TARGET_HEX, 'def-1', { x: 0, y: 0 })).toBe(false)
    expect(broke.mapView.contextOptions).toEqual([])
  })

  it('★ 候选与入口同源：射程打不到的炮兵不进候选（10.1a）', () => {
    const { workbench } = setupBarrage(true)
    const far = mapLayers.hexes.find((hex) => hexDistance(hex, TARGET_HEX) > 4)
    if (far === undefined) throw new Error('地图上找不到距离 >4 的格')
    const outOfRange = placeGround(
      workbench,
      artilleryRecord(),
      { col: far.col, row: far.row },
      'axis',
      'art-far',
    )
    const ids = workbench.barrageCandidatesAt(TARGET_HEX).map((unit) => unit.instanceId)
    expect(ids).toContain('art-1')
    expect(ids).not.toContain(outOfRange.instanceId)
  })
})

describe('统一流程：第 1 步 → 第 2 步（炮击）', () => {
  it('★ 选炮 → 下一步 ⇒ 宣布成功、会话仍是 `ops`、进第 2 步补给窗', () => {
    const { workbench, mapView, gun } = setupBarrage(true)
    expect(mapView.openOpsFlow('barrage', TARGET_HEX)).toBe(true)
    expect(mapView.opsFlow?.step).toBe(1)
    expect(mapView.session?.kind).toBe('ops')
    expect(mapView.session?.title).toContain('炮击')

    workbench.toggleBarrageUnit(gun.instanceId)
    expect(mapView.advanceOpsFlow()).toBe(true)
    expect(mapView.opsFlow?.step).toBe(2)
    expect(workbench.barrageState).not.toBeNull()

    // 取消整单 ⇒ 状态机回滚（10.1b 的账本不视为已炸过）
    expect(mapView.cancelOpsFlow()).toBe(true)
    expect(workbench.barrageState).toBeNull()
    expect(mapView.opsFlow).toBeNull()
  })
})

describe('候选同源（规格 §3 集合等式）', () => {
  it('★ 空军第 1 步只取候选函数给出的那批（不列未激活 / 已出任务 / 航程不够）', () => {
    const panel = readFileSync('src/components/ops/OpsFlowPanel.vue', 'utf8')
    // 与右键入口同一函数：轰炸 `bombingCandidatesAt`、扫射 `hipShootCandidatesAt`
    expect(panel).toContain('bombingCandidatesAt')
    expect(panel).toContain('hipShootCandidatesAt')
    // 不再在组件里按机型能力二次筛选（那是第二套判据）
    expect(panel).not.toContain('barrageStrength ?? 0) > 0')
    expect(panel).not.toContain('canHipShoot === true')
  })
})

describe('地图外空军盒（2.1C / 规格 §4 裁定③）', () => {
  it('★ 盒内驻机作为**独立基地分组**参与候选，且可被勾选出击', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    enterStep(workbench, 'air.mission')
    workbench.setAirActive(true)
    workbench.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    )
    placeAir(workbench, hipShootRecord(), CORE_HEX, 'axis', 'air-map')
    const boxed = toConsoleAirUnit({
      aircraft: hipShootRecord(),
      instanceId: 'air-box',
      hex: { col: 0, row: 0 },
      side: 'axis',
      airStatus: 'active',
    })
    workbench.airUnits.push(boxed)
    workbench.airBoxMembers.push('air-box')

    workbench.setAirMissionKind('hip_shoot')
    expect(workbench.setAirTargetFromText(label(TARGET_HEX))).toBe(true)

    const groups = workbench.airMissionBaseGroupsWithBox
    const boxGroup = groups.find((group) => group.baseId === '__offmap_air_box__')
    expect(boxGroup, '图外盒没有作为独立基地分组出现').toBeDefined()
    expect(boxGroup?.aircraft.map((item) => item.air.instanceId)).toContain('air-box')

    // 图上分组不含盒内机（两者互不串）
    const onMapIds = workbench.airMissionBaseGroups.flatMap((group) =>
      group.aircraft.map((item) => item.air.instanceId),
    )
    expect(onMapIds).toContain('air-map')
    expect(onMapIds).not.toContain('air-box')

    // 可勾选 ⇒ 参与任务（盒内整备等入口维持既有实现，这里只验出击）
    workbench.toggleAirMissionUnit('air-box')
    expect(workbench.airMissionAirIds).toContain('air-box')
  })
})
