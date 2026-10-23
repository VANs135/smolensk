import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers, type HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 条 12（M2）：**点非战斗单位 ⇒ 开对应动作会话**（`MapSessionKind:'unit'`）
 *
 * 按所点单位的类型（`mapView.unitActionFamily`）路由到**既有**面板（经 `UnitPanel` 分派）：
 *   · sp / supply_point / transport_point / organic_truck / supply_extender ⇒ `supply`
 *     （SP 拖取 / 运输点装卸 / 延补队，12.1 / 13.2 / 9.14）
 *   · air_base ⇒ `air`（空军基地整备，15.1）
 *   · hedgehog ⇒ `fort`（工事，16.0b）
 *
 * 同时落实「右栏只读」：原右栏可写面板（`AirPanel only="admin"` / `SupplyPanel only="ledger"`）
 * 已收进本会话（源码守卫见 air-supply-chain.test.ts）。
 *
 * 用**真实单位库**：点哪一类就路由到哪一族，全看单位数据里的 `noncombatKind`。
 */

const START: HexRef = { col: 36, row: 13 }
const ELSEWHERE: HexRef = { col: 36, row: 12 }

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 取一个指定 `noncombatKind` 的轴方记录（找不到即失败，避免静默用错夹具） */
function recordOfKind(kind: string): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find((record) => record.noncombatKind === kind)
  if (found === undefined) throw new Error(`单位库中没有 noncombatKind='${kind}' 的记录`)
  return found
}

function placeNonCombat(
  workbench: ReturnType<typeof newStores>['workbench'],
  kind: string,
  hex: HexRef,
  instanceId: string,
): void {
  workbench.units.push(toConsoleUnit({ record: recordOfKind(kind), instanceId, hex, side: 'axis' }))
}

describe('条 12（M2）：点非战斗单位开 unit 会话', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('点 SP ⇒ supply 会话（SP 拖取 / 补给账本）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'sp', START, 'sp-1')
    expect(mapView.session).toBeNull()

    mapView.onHexClick(START, { x: 40, y: 40 })

    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('supply')
    expect(mapView.session?.rule).toBe('12.1')
    // 条 12：单位会话优先于取子/小窗 ⇒ 不开小窗、不建移动取子清单
    expect(mapView.popup).toBeNull()
    expect(workbench.movePick).toBeNull()
  })

  it('点运输点 ⇒ supply 会话（装卸）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'transport_point', START, 'tp-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('supply')
  })

  it('点延补队 ⇒ supply 会话（9.14d）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'supply_extender', START, 'se-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('supply')
  })

  it('点空军基地 ⇒ air 会话（整备 15.1）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('air')
    expect(mapView.session?.rule).toBe('15.1')
  })

  it('点工事（hedgehog）⇒ fort 会话（16.0b）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'hedgehog', START, 'hg-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('fort')
    expect(mapView.session?.rule).toBe('16.0b')
  })

  it('点别处（空格）⇒ 收掉单位会话', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'sp', START, 'sp-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')

    mapView.onHexClick(ELSEWHERE, { x: 40, y: 40 })
    expect(mapView.session).toBeNull()
    expect(mapView.unitActionFamily).toBeNull()
  })

  it('点战斗单位 ⇒ 不开 unit 会话（仍走取子/移动那条链）', () => {
    const { workbench, mapView } = stores
    const record = unitChoices('axis').find(
      (item) =>
        item.classes?.movementClass === 'leg' &&
        item.attackCapable === true &&
        (item.factors?.combat?.ma ?? 0) >= 4,
    )!
    workbench.units.push(toConsoleUnit({ record, instanceId: 'a1', hex: START, side: 'axis' }))
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).not.toBe('unit')
    expect(mapView.unitActionFamily).toBeNull()
    // 战斗单位照旧建立取子清单（条 10）
    expect(workbench.movePick?.ids).toEqual(['a1'])
  })

  it('cancelSession ⇒ 收掉单位会话', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')

    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.session).toBeNull()
    expect(mapView.unitActionHex).toBeNull()
  })

  it('单位离开盘面 ⇒ 会话自然消失（family 归 null）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'sp', START, 'sp-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.unitActionFamily).toBe('supply')

    workbench.units = workbench.units.filter((unit) => unit.instanceId !== 'sp-1')
    expect(mapView.unitActionFamily).toBeNull()
    expect(mapView.session).toBeNull()
  })

  it('★ 批 A：点空军基地 ⇒ unit(air) 会话，勾选参战机后路由器切到 air(mission) 会话', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    const aircraft = aircraftChoices('axis')[0]!
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft,
        instanceId: 'ac-1',
        hex: START,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    // 点基地 ⇒ unit(air) 会话（渲染完整 AirPanel：admin＋mission 选机入口）
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('air')

    // 在会话里勾选这枚参战机 ⇒ airMissionAirIds>0 ⇒ 路由器优先给 air(mission) 会话
    workbench.toggleAirMissionUnit('ac-1')
    expect(workbench.airMissionAirIds).toContain('ac-1')
    expect(mapView.session?.kind).toBe('air')
  })

  it('★ 批 A：C 段点空格（有飞机按航程够到、无己方算子）⇒ 开空军任务入口（target-first）', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    // 进 C 段移动环节（14.7d 低空扫射就在此宣布；该环节允许 air 来源，且非轰炸工具态 ⇒ isIdleForStack 为真）
    const idx = workbench.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.modeAndMovement',
    )
    expect(workbench.setSegmentStepIndex(idx)).toBe(true)
    expect(workbench.barrageKindsInSegment.includes('air')).toBe(true)
    // 空军基地 + 一架激活飞机停在其格
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: aircraftChoices('axis')[0]!,
        instanceId: 'ac-1',
        hex: START,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    // 找一个"在图内、无任何单位、飞机够得到"的邻格
    const target = HEX_DIRECTIONS.map((direction) => neighbor(START, direction)).find(
      (hex) =>
        isOnMap(hex) &&
        mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row) &&
        !workbench.units.some((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row),
    )
    expect(target, '应找到图内的空邻格').toBeDefined()

    // 点这一格 ⇒ 开空军任务入口：预填任务格 + 开空军工具 + 置引导态 ⇒ air 会话
    mapView.onHexClick(target!, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('air')
    expect(mapView.airEntryTarget).toEqual(target)
    expect(workbench.airTargetHex).toEqual(target)
    expect(workbench.airActive).toBe(true)
    // 单框纪律：开了会话就不再另开小窗
    expect(mapView.popup).toBeNull()
  })

  it('★ 批 A：空军引导态在勾到第一架参战机后交棒（airEntryTarget 清空、会话续跑）', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    const idx = workbench.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.modeAndMovement',
    )
    expect(workbench.setSegmentStepIndex(idx)).toBe(true)
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: aircraftChoices('axis')[0]!,
        instanceId: 'ac-1',
        hex: START,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    const target = HEX_DIRECTIONS.map((direction) => neighbor(START, direction)).find(
      (hex) =>
        isOnMap(hex) &&
        mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row) &&
        !workbench.units.some((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row),
    )!
    mapView.onHexClick(target, { x: 40, y: 40 })
    expect(mapView.airEntryTarget).toEqual(target)

    workbench.toggleAirMissionUnit('ac-1')
    expect(mapView.airEntryTarget).toBeNull() // 引导态交棒
    expect(mapView.session?.kind).toBe('air') // 会话续跑（由选机驱动）

    // 取消会话 ⇒ airEntryTarget 仍空、会话消失
    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.session).toBeNull()
    expect(mapView.airEntryTarget).toBeNull()
  })

  it('★ 批 A：按航程列机——任务格在航程内时该机不灰显（14.1 只在超航程时触发）', () => {
    const { workbench } = stores
    workbench.setPhase('movement')
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: aircraftChoices('axis')[0]!,
        instanceId: 'ac-1',
        hex: START,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    // 相邻格在航程内 ⇒ 该机在候选阵列里**不**被 14.1 灰显
    const near = neighbor(START, HEX_DIRECTIONS[0]!)
    workbench.setAirTargetFromText(`${near.col}.${near.row}`)
    expect(
      workbench.airMissionJoinChoices.find((c) => c.air.instanceId === 'ac-1')?.disabledReason,
    ).toBeNull()
    /*
     * 注：本作斯摩棱斯克图上任一格距都在轴方各机航程内（最小航程 41 > 图内最大格距 35），
     * 故"超航程灰显"的 TRUE 分支在此图不可达；逻辑已实现（airMissionJoinChoices 的 14.1 判据），
     * 更大图 / 更短航程机出现时即生效。这里只钉"航程内不误灰显"。
     */
  })
})
