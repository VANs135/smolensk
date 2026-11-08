import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ConsolePhase } from '@/stores'
import type { HexRef, Side } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * BUG 2（用户 2026-11-08）：**移动阶段的低空扫射没有 UI，无法操作**
 *
 * ## 原文（`_ocs_v43_clean.txt`）
 *   · **14.2e**「激活的飞机可以执行以下任务……每个阶段只能执行一次任务」；
 *     「低空扫射是在**移动环节**而非轰炸环节中进行的一种特殊类型的轰炸」（14.2e / 14.7d）。
 *   · **14.7d**「低空扫射在移动环节中进行」；**14.7d-B** 单机；**14.7d-C** 需正确观察员（10.0b）。
 *   · **14.1a** 飞机停在本方空军基地格 ⇒ 基地格就是"点哪一枚飞机"的唯一盘面把手。
 *   · **14.2f-A/B** 宣布任务类型与任务格，再由 14.2f 流程跑到返航。
 *
 * ## 修前病灶
 *   移动环节点本方空军基地（A1）⇒ 只开「修建 / 缩减」两段的设施会话（`facilityActionKeys('air_base')`
 *   没有空军任务这一族），**没有任何地方能选机、定类型、交任务**；目标优先入口（点敌方格）
 *   只在"点空格/敌格"时出现，从基地/飞机这一侧完全不可见 ⇒ 用户看到的"没有 UI"。
 *
 * ## 测法
 *   全部走 store 的既有入口（`unitActionOptions` / `openUnitActionAt` / `runAirMissionWithKind`），
 *   不渲染组件；提交链与 `air-barrage-flow.test.ts` 同源（真实地图格、真实飞机库与单位库）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

const CORE_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

const TARGET_HEX: HexRef = (() => {
  const found = HEX_DIRECTIONS.map((direction) => neighbor(CORE_HEX, direction)).find(
    (hex) =>
      isOnMap(hex) && mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row),
  )
  if (found === undefined) throw new Error('找不到与核心格相邻的图内格')
  return found
})()

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

function enter(
  workbench: ReturnType<typeof newStores>['workbench'],
  phase: ConsolePhase,
  stepId: string,
): void {
  workbench.setPhase(phase)
  const index = workbench.playerSegmentSteps.findIndex((step) => step.id === stepId)
  expect(index, `本阶段没有 ${stepId} 环节`).toBeGreaterThanOrEqual(0)
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
}

function airBaseRecord() {
  const found = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
  if (found === undefined) throw new Error('单位库中没有空军基地算子')
  return found
}

/** 能低空扫射的轴方机（14.7d-B：专规给 `canHipShoot`） */
function hipShootRecord(side: Side) {
  const found = aircraftChoices(side).find(
    (record) => record.airAbilities?.canHipShoot === true && (record.barrageStrength ?? 0) > 0,
  )
  if (found === undefined) throw new Error(`${side} 飞机库中没有可低空扫射的机`)
  return found
}

/**
 * 现场：本方基地（CORE）+ 本方观察员（10.0b）+ 目标格上的敌方战斗单位 + 停在本方基地的飞机。
 * 飞机状态由调用方给（激活 ⇒ 可出动；非激活 ⇒ 入口可开但选机被 14.1a 拒）。
 */
function setupBaseAndTarget(
  workbench: ReturnType<typeof newStores>['workbench'],
  airStatus: 'active' | 'inactive' = 'active',
): void {
  workbench.setAirActive(true)
  workbench.units.push(
    toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
  )
  const spotter = unitChoices('axis').find((record) => record.isCombat === true)
  if (spotter === undefined) throw new Error('轴方单位库里没有战斗单位')
  workbench.units.push(
    toConsoleUnit({ record: spotter, instanceId: 'spot-1', hex: CORE_HEX, side: 'axis' }),
  )
  const defender = unitChoices('soviet').find((record) => record.isCombat === true)
  if (defender === undefined) throw new Error('苏方单位库里没有战斗单位')
  workbench.units.push(
    toConsoleUnit({ record: defender, instanceId: 'def-1', hex: TARGET_HEX, side: 'soviet' }),
  )
  workbench.airUnits.push(
    toConsoleAirUnit({
      aircraft: hipShootRecord('axis'),
      instanceId: 'air-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus,
    }),
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('BUG 2：移动环节从空军基地这一侧就能发起低空扫射（14.2e / 14.7d）', () => {
  it('★ C 段移动环节：点本方空军基地 ⇒ 操作菜单含「空军任务」（否则这条链在界面上不存在）', () => {
    const { workbench, mapView } = newStores()
    enter(workbench, 'movement', 'movement.modeAndMovement')
    setupBaseAndTarget(workbench)

    const options = mapView.unitActionOptions('base-1')
    const mission = options.find((item) => item.key === 'air.mission')
    expect(mission, '移动环节的基地菜单里缺「空军任务」入口').toBeDefined()
    expect(mission?.only).toBe('mission')
    expect(mission?.panel).toBe('air')
    expect(mission?.rule).toBe('14.2e')
    // 同一枚基地仍有 15.3 / 15.4 两项（入口不是替换，是并列）
    expect(options.map((item) => item.only)).toEqual(
      expect.arrayContaining(['mission', 'airstrip', 'reduce']),
    )
    // 点它 = 开「空军基地」动作会话（AirPanel 的 mission 段随 only 展开）
    expect(mapView.openUnitActionAt(CORE_HEX, 'base-1')).toBe(true)
    expect(mapView.unitActionFamily).toBe('air')
  })

  it('★ 从该入口提交低空扫射 ⇒ 单机任务跑完轰炸链并返航（14.7d-B / 14.2f-F）', () => {
    const { workbench } = newStores()
    enter(workbench, 'movement', 'movement.modeAndMovement')
    setupBaseAndTarget(workbench)
    expect(workbench.setAirTargetFromText(label(TARGET_HEX))).toBe(true)
    workbench.toggleAirMissionUnit('air-1')
    expect(workbench.airMissionAirIds).toEqual(['air-1'])
    // 10.0b：低空扫射要正确观察员（面板上的事实声明，与既有低空扫射用例同口径）
    workbench.barrageInputs = { ...workbench.barrageInputs, hasSpotter: true }

    // 面板的"任务类型"下拉即调用这一条具名入口（组件里不写规则）
    expect(workbench.runAirMissionWithKind('hip_shoot')).toBe(true)
    expect(workbench.barrageState?.finished).toBe(true)
    expect(workbench.barrageAirIds.length).toBe(1)
    expect(workbench.airState?.finished).toBe(true)
    expect(workbench.airUnits.find((air) => air.instanceId === 'air-1')?.airStatus).toBe('inactive')
  })

  it('★ 不可发起时入口不出：A 段整备只给「整备」、F 段战斗连菜单都不开', () => {
    const { workbench, mapView } = newStores()
    setupBaseAndTarget(workbench)
    enter(workbench, 'aircraftRefit', 'aircraftRefit.refit')
    expect(mapView.unitActionOptions('base-1').map((item) => item.only)).toEqual(['refit'])
    enter(workbench, 'combat', 'combat.combat')
    expect(mapView.unitActionOptions('base-1')).toEqual([])
    expect(mapView.unitActionAvailableAt('base-1')).toBe(false)
  })

  it('★ 非激活飞机：入口在，但参战机灰显且理由来自 14.1a（不是静默不可点）', () => {
    const { workbench, mapView } = newStores()
    enter(workbench, 'movement', 'movement.modeAndMovement')
    setupBaseAndTarget(workbench, 'inactive')

    expect(mapView.unitActionOptions('base-1').some((item) => item.key === 'air.mission')).toBe(
      true,
    )
    const choice = workbench.airMissionJoinChoices.find((item) => item.air.instanceId === 'air-1')
    expect(choice?.disabledReason ?? '').toContain('14.1a')
  })
})
