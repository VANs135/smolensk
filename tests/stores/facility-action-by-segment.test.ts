import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ConsolePhase } from '@/stores'
import type { HexRef } from '@/data'
import {
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 用户 2026-10-25：**「不同环节每个单位\设施能做的事情不一样，比如移动环节点击补给站可以销毁，
 * 其它时候点击补给站都是单位指定消耗时有用，单点补给站能不能有操作得看规则书的规定」**
 *
 * 逐条对原文（`_ocs_v43_clean.txt`）：
 *   · **12.11a 销毁补给站**：「……这只能在**该玩家的移动、反应和进击阶段中的移动环节**进行」
 *     ⇒ 补给站"对它自己"的操作**只有销毁**，且只在 C/E/G 的**移动环节**。
 *   · **13.2f 装卸**（运输点）／**12.7c 转延补队或崩溃** ⇒ 移动环节。
 *   · **15.1 整备**：「在飞机整备阶段中，空军基地可整备一次」⇒ **A 段**。
 *   · **15.3 修建与改进**／**15.4 缩减**：「只能在**移动阶段**中」⇒ C 段。
 *   · **16.0b 工事修建与改进**：「只能在移动阶段中」⇒ C 段。
 *
 * 于是：A 段点补给站是"整备付款"、D 段点补给站是"选它当补给源"、F 段的战斗补给同理——
 * 那些都不是"对补给站操作" ⇒ 不该给操作入口；点开一个空的会话比不给更糟。
 */

const HEX: HexRef = { col: 36, row: 13 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

function recordOfKind(kind: string) {
  const found = unitChoices('axis').find((record) => record.noncombatKind === kind)
  if (found === undefined) throw new Error(`单位库中没有 noncombatKind='${kind}' 的记录`)
  return found
}

function place(
  workbench: ReturnType<typeof stores>['workbench'],
  kind: string,
  instanceId: string,
): void {
  workbench.units.push(
    toConsoleUnit({ record: recordOfKind(kind), instanceId, hex: HEX, side: 'axis' }),
  )
}

/** 把操作台切到"某阶段的某个环节"（环节 id 由 SOP 表给，不在这里猜） */
function enter(
  workbench: ReturnType<typeof stores>['workbench'],
  phase: ConsolePhase,
  stepId: string,
): void {
  workbench.setPhase(phase)
  const index = workbench.playerSegmentSteps.findIndex((step) => step.id === stepId)
  expect(index, `本阶段没有 ${stepId} 环节`).toBeGreaterThanOrEqual(0)
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
}

describe('设施 × 环节：能不能"对它操作"由规则书定', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
  })

  it('★ C 段移动环节：补给站**有**操作（12.11a 销毁），进的是补给面板', () => {
    const { workbench, mapView } = s
    place(workbench, 'sp', 'sp-1')
    enter(workbench, 'movement', 'movement.modeAndMovement')
    expect(mapView.unitActionAvailableAt('sp-1')).toBe(true)
    expect(mapView.openUnitActionAt(HEX, 'sp-1')).toBe(true)
    expect(mapView.unitActionFamily).toBe('supply')
  })

  it('★ D 段补给：补给站**没有**操作（那里只是"选它当补给源"，不是对站操作）', () => {
    const { workbench, mapView } = s
    place(workbench, 'sp', 'sp-1')
    enter(workbench, 'supply', 'supply.check')
    expect(mapView.unitActionAvailableAt('sp-1')).toBe(false)
    expect(mapView.openUnitActionAt(HEX, 'sp-1')).toBe(false)
    expect(mapView.unitActionFamily).toBeNull()
  })

  it('★ A 段整备：补给站没有操作；空军基地**有**（15.1 整备）', () => {
    const { workbench, mapView } = s
    place(workbench, 'sp', 'sp-1')
    place(workbench, 'air_base', 'base-1')
    enter(workbench, 'aircraftRefit', 'aircraftRefit.refit')
    expect(mapView.unitActionAvailableAt('sp-1')).toBe(false)
    expect(mapView.unitActionAvailableAt('base-1')).toBe(true)
    expect(mapView.openUnitActionAt(HEX, 'base-1')).toBe(true)
    expect(mapView.unitActionFamily).toBe('air')
  })

  it('★ C 段移动环节：空军基地有操作（15.3 修建 / 15.4 缩减）；工事有（16.0b）', () => {
    const { workbench, mapView } = s
    place(workbench, 'air_base', 'base-1')
    place(workbench, 'hedgehog', 'hog-1')
    enter(workbench, 'movement', 'movement.modeAndMovement')
    expect(mapView.unitActionAvailableAt('base-1')).toBe(true)
    expect(mapView.unitActionAvailableAt('hog-1')).toBe(true)
  })

  it('★ F 段战斗：补给站没有操作（战斗补给是"从它付款"，不是对它操作）', () => {
    const { workbench, mapView } = s
    place(workbench, 'sp', 'sp-1')
    enter(workbench, 'combat', 'combat.combat')
    expect(mapView.unitActionAvailableAt('sp-1')).toBe(false)
  })

  it('★ 运输点在 C 段有操作（13.2f 装卸 / 12.7c 转延补队），A 段没有', () => {
    const { workbench, mapView } = s
    place(workbench, 'transport_point', 'tp-1')
    enter(workbench, 'movement', 'movement.modeAndMovement')
    expect(mapView.unitActionAvailableAt('tp-1')).toBe(true)
    enter(workbench, 'aircraftRefit', 'aircraftRefit.refit')
    expect(mapView.unitActionAvailableAt('tp-1')).toBe(false)
  })

  it('★ 操作菜单：C 段基地列出「修建 / 缩减」两项（只列本环节允许的）', () => {
    const { workbench, mapView } = s
    place(workbench, 'air_base', 'base-1')
    enter(workbench, 'movement', 'movement.modeAndMovement')
    const options = mapView.unitActionOptions('base-1')
    expect(options.map((item) => item.key)).toEqual(['move.construction', 'air.baseReduce'])
    // 每项都带规则号与"开哪一段"，界面据此只展开那一段
    expect(options.map((item) => item.only)).toEqual(['airstrip', 'reduce'])
    expect(options.every((item) => item.rule !== '' && item.label !== '')).toBe(true)
  })

  it('★ 操作菜单：A 段基地只剩「整备」一项（15.1 在 A 段）', () => {
    const { workbench, mapView } = s
    place(workbench, 'air_base', 'base-1')
    enter(workbench, 'aircraftRefit', 'aircraftRefit.refit')
    const options = mapView.unitActionOptions('base-1')
    expect(options.map((item) => item.key)).toEqual(['air.refit'])
    expect(options[0]?.only).toBe('refit')
  })

  it('★ 界面按"一个操作一个面板"落地（源码守卫）', () => {
    const unitPanel = readFileSync('src/components/game/UnitPanel.vue', 'utf8')
    // 先给操作菜单，挑定后才展开那一段
    expect(unitPanel).toContain('unitActionOptions')
    expect(unitPanel).toContain('picked === null')
    expect(unitPanel).toContain(':only="airOnly"')
    const airPanel = readFileSync('src/components/air/AirPanel.vue', 'utf8')
    for (const flag of [
      'showsRefit',
      'showsAirstrip',
      'showsReduce',
      'showsCapture',
      'showsPlace',
    ]) {
      expect(airPanel, `AirPanel 缺 ${flag} 分段`).toContain(flag)
    }
  })

  it('★ 设施动作表本身就是"规则书清单"（键与环节由闸门表给，不在这里另写一套）', () => {
    const { mapView } = s
    expect(mapView.facilityActionKeys('sp')).toEqual(['move.dumpBlow'])
    expect(mapView.facilityActionKeys('air_base')).toEqual([
      'air.refit',
      'move.construction',
      'air.baseReduce',
    ])
    expect(mapView.facilityActionKeys('hedgehog')).toEqual(['move.hedgehog'])
    // 没有"对它操作"的种类（纯标记类）⇒ 空表
    expect(mapView.facilityActionKeys('marker')).toEqual([])
  })
})
