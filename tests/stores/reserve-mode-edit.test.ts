import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 用户 2026-11-18：移动环节内的预备单位**换面 / 取消预备**
 *
 * 口径：
 *   · 转入预备后仍可切换移动面与战斗面（入口＝右键「模式改变」）；
 *   · 可以**直接取消预备**回到正常状态——这不是 5.7b 的「转出预备」（那是反应 / 进击阶段的动作）；
 *   · 两者都只在移动环节（闸门 `move.modeChange`）出现，且不改 MP、不动本次移动的账。
 */

const HEX: HexRef = { col: 36, row: 13 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('soviet')
  useHotseatStore().setViewerSide('soviet')
  return { workbench, mapView: useMapViewStore() }
}

/** 把操作台切到本段里允许该动作的环节（与 engine 的闸门表同一处判据） */
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

function infantryRecord() {
  return groundRecord(
    'soviet',
    (record) => record.isCombat === true && record.classes?.movementClass === 'leg',
  )
}

/** 该算子在右键菜单里的动作（先选中，再右键这一格） */
function actionsIn(s: ReturnType<typeof stores>, instanceId: string) {
  s.workbench.selectedId = instanceId
  s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
  return s.mapView.contextOptions.find((item) => item.id === instanceId)?.actions ?? []
}

/** 本移动环节刚转入预备的单位（5.7a 的朝向锁在册） */
function reserveUnit(
  workbench: ReturnType<typeof useWorkbenchStore>,
  id: string,
  orientation: 'move' | 'combat' = 'move',
) {
  const unit = placeGround(workbench, infantryRecord(), HEX, 'soviet', id, orientation)
  unit.mode = { mode: 'reserve', orientation, dg: false, exploit: false }
  unit.reserveEnteredThisPhase = true
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('预备换面（移动环节）', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
  })

  it('★ 本环节刚转入预备仍能换面：模式保持 reserve，印值按新面刷新', () => {
    const unit = reserveUnit(s.workbench, 'r1', 'move')
    unit.mpSpent = 2

    expect(s.workbench.switchReserveFaceNow('combat', ['r1'])).toBe(true)

    expect(unit.mode.mode).toBe('reserve')
    expect(unit.mode.orientation).toBe('combat')
    expect(unit.raw).toBe(unit.faces.combat)
    // 换面不是切换模式，MP 账不动
    expect(unit.mpSpent).toBe(2)
    expect(s.workbench.log.some((entry) => entry.rule === '5.7a' && entry.kind === 'success')).toBe(
      true,
    )
  })

  it('★ 右键「模式改变」提供换面项，连点两次在两面之间往返', () => {
    const unit = reserveUnit(s.workbench, 'r2', 'move')

    const first = actionsIn(s, 'r2').find((item) => item.key === 'move.reserve.face')
    expect(first?.group).toBe('模式改变')
    expect(first?.disabledReason).toBeNull()
    expect(first?.label).toContain('战斗面')
    expect(s.mapView.openContextAction('r2', 'move.reserve.face')).toBe(true)
    expect(unit.mode.orientation).toBe('combat')

    const second = actionsIn(s, 'r2').find((item) => item.key === 'move.reserve.face')
    expect(second?.label).toContain('移动面')
    expect(s.mapView.openContextAction('r2', 'move.reserve.face')).toBe(true)
    expect(unit.mode.orientation).toBe('move')
  })
})

describe('取消预备（不是 5.7b 转出）', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
  })

  it('★ 取消后按当前朝向回到正常模式，并清掉本阶段进入预备的标记', () => {
    const unit = reserveUnit(s.workbench, 'c1', 'move')

    expect(s.workbench.cancelReserveModeNow(['c1'])).toBe(true)

    expect(unit.mode.mode).toBe('move')
    expect(unit.mode.orientation).toBe('move')
    expect(unit.reserveEnteredThisPhase).toBe(false)
    expect(unit.mode.releasedFromReserve).not.toBe(true)
  })

  it('★ 朝向为战斗面时取消 ⇒ 回到战斗模式', () => {
    const unit = reserveUnit(s.workbench, 'c2', 'combat')

    expect(s.workbench.cancelReserveModeNow(['c2'])).toBe(true)

    expect(unit.mode.mode).toBe('combat')
    expect(unit.raw).toBe(unit.faces.combat)
  })

  it('★ 右键「取消预备模式」可点，点完菜单不再列换面/取消（已不是预备）', () => {
    const unit = reserveUnit(s.workbench, 'c3', 'move')

    const item = actionsIn(s, 'c3').find((option) => option.key === 'move.reserve.cancel')
    expect(item?.group).toBe('模式改变')
    expect(item?.disabledReason).toBeNull()
    expect(item?.label).toBe('取消预备模式')
    expect(s.mapView.openContextAction('c3', 'move.reserve.cancel')).toBe(true)
    expect(unit.mode.mode).toBe('move')

    const keys = actionsIn(s, 'c3').map((option) => option.key)
    expect(keys).not.toContain('move.reserve.cancel')
    expect(keys).not.toContain('move.reserve.face')
  })

  it('★ 只在移动环节：别的环节既不列项，直接调用也被闸门拒', () => {
    const unit = reserveUnit(s.workbench, 'c4', 'move')
    s.workbench.setPhase('reinforcement')
    goToActionStep(s.workbench, 'rein.rebuild')

    const keys = actionsIn(s, 'c4').map((option) => option.key)
    expect(keys).not.toContain('move.reserve.cancel')
    expect(keys).not.toContain('move.reserve.face')

    expect(s.workbench.cancelReserveModeNow(['c4'])).toBe(false)
    expect(unit.mode.mode).toBe('reserve')
  })
})
