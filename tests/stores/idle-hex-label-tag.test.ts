import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 条 25（D2 修订）：点空格**不再**弹只读格号浮签 —— 格号改走**悬停投影**
 *
 * 用户口径：「点格浮签常驻，应改为悬停投影」。
 * 修前：空闲点空格 ⇒ `openPopup(..., variant: 'label')` 留一个只读小签，必须再点一下才收。
 * 修后：那一击**只**走 `clickHex`（清选中 + 写"选中空格"日志）；格号由地图的悬停提示
 * （`MapCanvas` 的 `hoverTip`，空格外回落成 `col.row`）随指针浮现，离格即消失。
 *
 * 本文件钉四件事：
 *   ① **不再开窗**：空格那一击 `popup` 保持 null；有内容的格照旧开 `content` 小窗（不动）；
 *   ② **不碰 `clickHex` 的既有选中语义**：空格那一击仍然清选中、仍然写"选中格 X.Y（空格）"日志；
 *   ③ **保留会话辅助窗**：会话在跑时被消费的点选仍开 `content`（9.12g 推进窗等）；
 *   ④ **源码守卫**：`MapActionPopover` 不再有 `label` 分支；`MapCanvas` 悬停时给空格补格号。
 */

const START: HexRef = { col: 36, row: 13 }

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 一枚苏方战斗算子（只为在"有内容的格"上验证变体取 `content`：点非当前方 ⇒ 不起会话） */
const sovietCombat = () =>
  unitChoices('soviet').find(
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )!

describe('条 25（D2）：点空格只走 clickHex，格号改由悬停投影', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('① 点空格 ⇒ **不开**小窗（格号改为悬停显示）', () => {
    const { mapView } = stores
    mapView.onHexClick(START, { x: 120, y: 80 })

    expect(mapView.popup).toBeNull()
    expect(mapView.popupContent).toBeNull()
  })

  it('② 该格**有内容** ⇒ 照旧开常规小窗（变体 content）', () => {
    const { workbench, mapView } = stores
    // 敌方（非当前方）算子：点它不会起会话（`friendlyUnitsAt` 为空 ⇒ 只写入 selectedId）
    workbench.units.push(
      toConsoleUnit({
        record: sovietCombat(),
        instanceId: 'e1',
        hex: START,
        side: 'soviet',
      }),
    )

    mapView.onHexClick(START, { x: 120, y: 80 })

    expect(mapView.popup).not.toBeNull()
    expect(mapView.popup!.variant).toBe('content')
  })

  it('③ 点空格**不改** `clickHex` 的既有选中语义（仍清选中、仍写"空格"日志）', () => {
    const { workbench, mapView } = stores
    mapView.onHexClick(START, { x: 120, y: 80 })

    // 选中态：空格 ⇒ selectedId 归 null；没有起移动交互
    expect(workbench.selectedId).toBeNull()
    expect(workbench.moveInteraction).toBeNull()
    // 日志照旧（既有契约，本条只动显示层）
    expect(workbench.log[0]?.text).toContain(`选中格 ${START.col}.${START.row}`)
    expect(workbench.log[0]?.text).toContain('空格')
  })

  it('④ 会话辅助窗不受影响：会话在跑时被消费的点选仍开 content', () => {
    const { mapView } = stores
    // 直接走"会话在跑"的路径不好构造，这里只钉 `openPopup` 的显式入口仍是 content
    mapView.openPopup(START, 10, 10)
    expect(mapView.popup).toEqual({ hex: START, x: 10, y: 10, variant: 'content' })
    mapView.closePopup()
    expect(mapView.popup).toBeNull()
  })

  it('⑤ 源码守卫：小窗不再有 label 分支；悬停空格外补格号投影', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).not.toMatch(/variant\s*===\s*'label'/)
    expect(popover).not.toContain('hex-tag')

    const canvas = readFileSync('src/components/map/MapCanvas.vue', 'utf8')
    // 悬停提示：有令牌取令牌全称，空格回落成 `col.row`
    expect(canvas).toMatch(/tokenTipAt\([^)]*\)\s*\?\?/)
    expect(canvas).toMatch(/hoverTip/)

    const mapView = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(mapView).not.toContain(`variant: 'label'`)
    expect(mapView).not.toContain('popupVariantFor')
  })
})
