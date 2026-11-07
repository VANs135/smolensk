import { describe, expect, it } from 'vitest'
import { isReactive, reactive } from 'vue'

import type { HexRef } from '@/data'

import { buildMoveContext, toConsoleUnit, type UnitRecordView } from '@/stores/workbench-model'

/**
 * A 闸门：移动上下文必须是**plain 快照**
 *
 * 根因（见 docs/2026-11-08-网页卡顿定位与桌面端评估.md）：`buildMoveContext` 原样搬运
 * Pinia 单位对象里的 `hex` 引用，BFS 每步读 `hex.col/row` 都走 Vue 响应式 Proxy
 * （CPU 采样 `Vue reactive get` 占 362ms）。这里锁死「上下文内不出现响应式代理」，
 * 改造后必须为 false；改造前恒为 true（红）。
 */

const RECORD: UnitRecordView = {
  id: 'plain-snapshot-rgt',
  nameZh: '快照测试团',
  side: 'axis',
  isCombat: true,
  attackCapable: true,
  classes: { combatClass: 'armor', movementClass: 'tracked' },
  reSize: 3,
  specialized: [],
  status: 'valued',
  factors: {
    combat: { attack: 10, ar: 4, ma: 5 },
    move: { attack: 4, ar: 4, ma: 10 },
  },
}

const REACTIVE_HEX: HexRef = reactive({ col: 12, row: 12 })
const REACTIVE_SAFE_EDGE = reactive({ col: 1, row: 12 })
const REACTIVE_BRIDGE = reactive({ col: 13, row: 12 })

const unit = toConsoleUnit({
  record: RECORD,
  instanceId: 'plain-1',
  hex: REACTIVE_HEX,
  side: 'axis',
})
unit.fuelled = true

const context = buildMoveContext({
  units: [unit],
  activeSide: 'axis',
  phase: 'movement',
  safeEdgeHexesBySide: { axis: [REACTIVE_SAFE_EDGE], soviet: [] },
  bridgedHexesBySide: { axis: [REACTIVE_BRIDGE], soviet: [] },
  ownBridgeHexByUnitId: { 'plain-1': REACTIVE_BRIDGE },
})

describe('移动上下文是 plain 快照（A）', () => {
  it('单位位置不是响应式代理，且坐标值不变', () => {
    const view = context.units[0]!
    expect(view.hex).toEqual({ col: 12, row: 12 })
    expect(isReactive(view.hex)).toBe(false)
  })

  it('安全边缘格与架桥格不是响应式代理，且坐标值不变', () => {
    const safe = context.safeEdgeHexesBySide!.soviet
    const safeAxis = context.safeEdgeHexesBySide!.axis
    expect(safe).toEqual([])
    expect(safeAxis).toEqual([{ col: 1, row: 12 }])
    expect(isReactive(safeAxis[0])).toBe(false)

    const bridged = context.bridgedHexesBySide!.axis
    expect(bridged).toEqual([{ col: 13, row: 12 }])
    expect(isReactive(bridged[0])).toBe(false)

    const own = context.ownBridgeHexByUnitId!['plain-1']!
    expect(own).toEqual({ col: 13, row: 12 })
    expect(isReactive(own)).toBe(false)
  })
})
