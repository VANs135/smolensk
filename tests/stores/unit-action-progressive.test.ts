import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 用户 2026-10-25：**渐进交互**——「点格子先只展开堆叠，堆叠里只展示该格单位；
 * 点空军基地就进它的操作，点其它单位/设施也能各做各的」。
 *
 * 修前：格里有**任何**非战斗单位就立刻开会话（整备/补给/工事）⇒
 *   ① 玩家还没看清这格有什么就被推进下一步；
 *   ② 一格同时有基地 + SP 时只按"第一枚非战斗单位"取面板（点 SP 也进基地的整备）。
 *
 * 现在：`unitActionUnitId` 精确到**那一枚**；`openUnitActionAt` 由堆叠清单里的「操作」调用；
 * 只有"该格就这一枚可见本单位"时才省掉摊开这一步。
 */

const HEX: HexRef = { col: 36, row: 13 }

const newStores = () => {
  setActivePinia(createPinia())
  // 该会话只在**初设收束之后**才存在（初设期一切摆位在初设面板里）
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

function recordOfKind(kind: string) {
  const found = unitChoices('axis').find((record) => record.noncombatKind === kind)
  if (found === undefined) throw new Error(`单位库中没有 noncombatKind='${kind}' 的记录`)
  return found
}

function place(
  workbench: ReturnType<typeof newStores>['workbench'],
  kind: string,
  instanceId: string,
  hex: HexRef = HEX,
  side: 'axis' | 'soviet' = 'axis',
): void {
  workbench.units.push(toConsoleUnit({ record: recordOfKind(kind), instanceId, hex, side }))
}

describe('渐进交互：点格摊堆叠 ⇒ 点具体那一枚才进操作', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('★ 一格有「基地 + SP」⇒ 点格**不直接开**会话，而是摊开堆叠', () => {
    const { workbench, mapView } = stores
    place(workbench, 'air_base', 'base-1')
    place(workbench, 'sp', 'sp-1')
    expect(workbench.units.length).toBe(2)

    mapView.onHexClick(HEX)
    // 没有"未经选择就进下一步"：单位动作会话不该出现
    expect(mapView.session?.kind).not.toBe('unit')
    // 摊开了这一格（清单由玩家点）
    expect(mapView.expandedStack?.hex).toEqual(HEX)
    expect(mapView.unitActionHex).toBeNull()
  })

  it('★ 同一格里点「基地」⇒ 基地操作；点「SP」⇒ 补给操作（各进各的）', () => {
    const { workbench, mapView } = stores
    place(workbench, 'air_base', 'base-1')
    place(workbench, 'sp', 'sp-1')

    expect(mapView.openUnitActionAt(HEX, 'base-1')).toBe(true)
    expect(mapView.session).toMatchObject({ kind: 'unit' })
    expect(mapView.unitActionFamily).toBe('air')
    expect(mapView.unitActionUnitId).toBe('base-1')

    expect(mapView.openUnitActionAt(HEX, 'sp-1')).toBe(true)
    expect(mapView.unitActionFamily).toBe('supply')
    expect(mapView.unitActionUnitId).toBe('sp-1')
  })

  it('★ 该格只有这一枚本单位 ⇒ 省掉摊开、点格即进它的操作', () => {
    const { workbench, mapView } = stores
    place(workbench, 'air_base', 'base-1')
    mapView.onHexClick(HEX)
    expect(mapView.session).toMatchObject({ kind: 'unit' })
    expect(mapView.unitActionFamily).toBe('air')
    expect(mapView.unitActionUnitId).toBe('base-1')
  })

  it('★ 敌方单位不开操作会话（只显示，不动别人的东西）', () => {
    const { workbench, mapView } = stores
    place(workbench, 'air_base', 'enemy-base', HEX, 'soviet')
    expect(mapView.openUnitActionAt(HEX, 'enemy-base')).toBe(false)
    expect(mapView.unitActionFamily).toBeNull()
    expect(mapView.session?.kind).not.toBe('unit')
  })

  it('★ 收掉会话时"那一枚"的记账也清（不会带到下一格）', () => {
    const { workbench, mapView } = stores
    place(workbench, 'air_base', 'base-1')
    expect(mapView.openUnitActionAt(HEX, 'base-1')).toBe(true)
    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.unitActionUnitId).toBeNull()
    expect(mapView.unitActionHex).toBeNull()
    expect(mapView.unitActionFamily).toBeNull()
  })
})
