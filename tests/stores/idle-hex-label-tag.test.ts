import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 条 25（批 U 切片 U1）：**空闲点空格 ⇒ 只读格号浮签**
 *
 * 用户清单原文（第六批 §2 条 25）：「空闲点空格：先 `clickHex`（会清选中并写"选中空格"日志）
 * 再 `openPopup` → 330px 常规小窗，仍显示"该格算子 0 枚"等 ⇒ 不是"只读格号小文字框"」。
 *
 * 本文件钉三件事：
 *   ① **变体**：空格那一击开的是 `label` 浮签（只读格号），有内容的格照旧开 `content` 小窗；
 *   ② **不碰 `clickHex` 的既有选中语义**：空格那一击仍然清选中、仍然写"选中格 X.Y（空格）"日志
 *      （本条只改**显示**，不改**选中/日志**——那是既有契约，改动会牵动别的用例）；
 *   ③ **源码守卫**：小窗外壳按变体渲染，浮签分支不再画"该格算子 N 枚"那一套清单。
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

describe('条 25：空闲点空格 ⇒ 只读格号浮签', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('① 点空格 ⇒ 开的是**只读格号浮签**（变体 label），不是常规小窗', () => {
    const { mapView } = stores
    mapView.onHexClick(START, { x: 120, y: 80 })

    expect(mapView.popup).not.toBeNull()
    expect(mapView.popup!.hex).toEqual(START)
    expect(mapView.popup!.variant).toBe('label')
    // 浮签只有格号 ⇒ 内容侧也不该给出"该格算子 0 枚"那一套可操作清单
    const content = mapView.popupContent
    expect(content).not.toBeNull()
    expect(content!.units).toEqual([])
    expect(content!.airUnits).toEqual([])
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

  it('④ 关掉浮签 ⇒ 与既有小窗同一个收口（`closePopup` 后内容也没了）', () => {
    const { mapView } = stores
    mapView.onHexClick(START, { x: 120, y: 80 })
    expect(mapView.popup!.variant).toBe('label')
    mapView.closePopup()
    expect(mapView.popup).toBeNull()
    expect(mapView.popupContent).toBeNull()
  })

  it('⑤ 源码守卫：小窗按变体渲染，浮签分支**不画**算子清单', () => {
    const src = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    // 外壳按变体切换：格号浮签走独立分支
    expect(src).toMatch(/variant\s*===\s*'label'/)
    expect(src).toMatch(/variant\s*===\s*'content'/)
    // 浮签分支是**只读格号**：把模板切到浮签那一段看，不再出现"该格算子 N 枚"那一行
    const labelBranch = src.slice(
      src.indexOf(`variant === 'label'`),
      src.indexOf('v-else-if') === -1 ? src.length : src.indexOf('v-else-if'),
    )
    expect(labelBranch).not.toContain('该格算子')
    expect(labelBranch).not.toContain('<BaseButton')
  })
})
