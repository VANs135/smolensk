import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { zocHexes, type ZocSource } from '@/engine/rules'
import { useMapViewStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, combatRecord, placeGround } from '../flows/sop-harness'

/**
 * 4.5：**ZOC 覆盖层的界面高亮**（`zocHexes` 此前零调用 ⇒ 玩家看不到 ZOC 范围，只能逐格试）
 *
 * 条文：「**可攻击单位** + **战斗模式** + **有追溯补给**，三者齐备才投射 ZOC」；投射范围＝**六邻格**
 * （无地形/格边豁免）。
 *
 * 本文件钉：① 层默认关；② 开启后覆盖格**就是引擎给的六邻格**；③ 投射条件逐条生效
 * （断补 / 非战斗模式 / 不可攻击者都不投射）；④ 覆盖格**只取地图实际画出的算子**
 * （不泄露战雾之外的信息）；⑤ 只收**图内**格。
 */
const boot = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 该格在图内的六邻（用作期望值；与引擎的 `zocHexes` 独立算一遍） */
const onMapNeighbors = (hex: { col: number; row: number }) =>
  HEX_DIRECTIONS.map((direction) => neighbor(hex, direction)).filter(
    (item) => isOnMap(item) && item !== undefined,
  )

describe('4.5：ZOC 覆盖层', () => {
  it('默认关闭；开启后才进覆盖层', () => {
    const { mapView } = boot()
    expect(mapView.zocLayerVisible).toBe(false)
    expect(mapView.overlay.zoc).toBeNull()
    mapView.zocLayerVisible = true
    expect(mapView.overlay.zoc).not.toBeNull()
  })

  it('战斗模式 + 可攻击 + 有补给的单位 ⇒ 覆盖其六邻格（图内）', () => {
    const { workbench, mapView } = boot()
    const unit = placeGround(workbench, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    unit.attackCapable = true
    unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    unit.hasTraceSupply = true
    mapView.zocLayerVisible = true

    const expected = onMapNeighbors(CORE_HEX).map((hex) => `${hex!.col}.${hex!.row}`)
    const actual = mapView.overlay.zoc!.friendly.map((hex) => `${hex.col}.${hex.row}`)
    expect(new Set(actual)).toEqual(new Set(expected))
    // 4.5：投射范围是六邻，**不含**单位自己所在的格
    expect(actual).not.toContain(`${CORE_HEX.col}.${CORE_HEX.row}`)
  })

  it('4.5 的三个投射条件逐条生效（断补 / 非战斗模式 / 不可攻击 ⇒ 都不投射）', () => {
    const combatMode = {
      mode: 'combat' as const,
      orientation: 'combat' as const,
      dg: false,
      exploit: false,
    }
    const outOfSupply = () => {
      const { workbench, mapView } = boot()
      const unit = placeGround(workbench, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
      unit.mode = { ...combatMode }
      unit.hasTraceSupply = false
      mapView.zocLayerVisible = true
      expect(mapView.overlay.zoc!.friendly).toEqual([])
    }
    // 4.5：断补单位不投射 ZOC
    outOfSupply()
    // 4.5：非战斗模式不投射 ZOC（5.5/5.6）
    const moveMode = boot()
    const moving = placeGround(moveMode.workbench, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    moving.mode = { ...combatMode, mode: 'move', orientation: 'move' }
    moveMode.mapView.zocLayerVisible = true
    expect(moveMode.mapView.overlay.zoc!.friendly).toEqual([])
    // 4.5：可攻击是前置条件
    const weakBoot = boot()
    const weak = placeGround(weakBoot.workbench, combatRecord('axis'), CORE_HEX, 'axis', 'u2')
    weak.mode = { ...combatMode }
    weak.attackCapable = false
    weakBoot.mapView.zocLayerVisible = true
    expect(weakBoot.mapView.overlay.zoc!.friendly).toEqual([])
  })

  it('只取**地图实际画出的算子**：被战雾藏起来的敌方单位不产生覆盖格', () => {
    const { workbench, mapView } = boot()
    // 一枚苏方战斗单位（己方视角＝轴方，故它属"敌方"）
    const enemy = placeGround(workbench, combatRecord('soviet'), CORE_HEX, 'soviet', 'e1')
    enemy.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    mapView.zocLayerVisible = true
    // boot() 的 viewerSide 是轴方；苏方单位是否可见由热坐的 4.9a 名单决定。
    // 本用例只钉"覆盖格来自 tokens 那一份"：把可见令牌集合与覆盖集对照。
    const visibleGroundIds = new Set(
      mapView
        .fogVisibleTokens(
          workbench.units.map(
            (unit) => ({ id: unit.instanceId, hex: unit.hex, side: unit.side }) as never,
          ),
        )
        .map((token) => token.id),
    )
    const enemyCovered = mapView.overlay.zoc!.enemy.length
    if (!visibleGroundIds.has(enemy.instanceId)) expect(enemyCovered).toBe(0)
    else expect(enemyCovered).toBeGreaterThan(0)
  })

  it('与引擎逐格口径一致（本层不另算 ZOC）', () => {
    const { workbench, mapView } = boot()
    const unit = placeGround(workbench, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    unit.attackCapable = true
    unit.hasTraceSupply = true
    mapView.zocLayerVisible = true
    const sources: ZocSource[] = [
      {
        hex: unit.hex,
        side: 'axis',
        attackCapable: true,
        inCombatMode: true,
        hasTraceSupply: true,
      },
    ]
    expect(new Set(mapView.overlay.zoc!.friendly.map((hex) => `${hex.col}.${hex.row}`))).toEqual(
      new Set(zocHexes(sources, 'axis').map((hex) => `${hex.col}.${hex.row}`)),
    )
  })
})
