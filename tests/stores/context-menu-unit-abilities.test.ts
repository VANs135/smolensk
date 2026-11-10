import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  needsFuelOf,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 右键己方算子 ⇒ 五项能力（用户 2026-11-09，第 2 批）
 *
 * 口径：
 *   · 转换延补队（12.7）/ 拆分（20.0a）已是既有右键项，本文件钉它们仍在；
 *   · **合并单位（13.9-1）** 与 **加油（12.5）** 为本批新进右键 —— 可用才出现（不灰按钮）；
 *   · 判据只复用既有 store / 引擎入口（`mergePartnerAt` 走 `planConsolidation` 预演，
 *     `needsFuelNow` 与 `fuelTargets` 同源），不在这里重写规则。
 *
 * 补员（13.5）不在地图层：重建表**行键**（费用）须由玩家显式选定，工程库没有「算子 → 行」映射，
 * 静默取建议行会扣错费用 ⇒ 仍留在增援面板（见交付说明）。
 */

const HEX: HexRef = { col: 36, row: 13 }

function stores(side: 'axis' | 'soviet' = 'soviet') {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide(side)
  return { workbench, mapView: useMapViewStore() }
}

/** B8：把操作台切到本段里允许该动作的环节（与 engine 的闸门表同一处判据） */
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

/** 13.9-1：多军力师（两面印值相同 ⇒ 两枚同一记录放一起即可合并） */
function multiStepRecord() {
  return groundRecord('soviet', (record) => /Tk Div|Rifle Div/i.test(record.vassalName ?? ''))
}

/** 12.5a：轮式 / 履带战斗单位（耗 MP 就要先付油） */
function fuelRecord() {
  return groundRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      (record.classes?.movementClass === 'truck' || record.classes?.movementClass === 'tracked') &&
      (record.factors?.combat?.ma ?? 0) >= 1,
  )
}

function legRecord() {
  return groundRecord(
    'soviet',
    (record) => record.isCombat === true && record.classes?.movementClass === 'leg',
  )
}

/** 右键菜单里该枚算子的项（`onHexContext` 之后从 `contextOptions` 取） */
function menuKeys(s: ReturnType<typeof stores>, instanceId: string): string[] {
  s.workbench.selectedId = instanceId
  s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
  return (s.mapView.contextOptions.find((item) => item.id === instanceId)?.actions ?? []).map(
    (item) => item.key,
  )
}

describe('右键：13.9-1 合并单位', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('reinforcement')
    goToActionStep(s.workbench, 'rein.rebuild')
  })

  it('★ 同格有且仅有另一枚可合并 ⇒ 出现「合并单位」，点它即并（不弹第二个选择）', () => {
    const record = multiStepRecord()
    const keep = placeGround(s.workbench, record, HEX, 'soviet', 'k1')
    const remove = placeGround(s.workbench, record, HEX, 'soviet', 'r1')
    keep.steps = 2
    remove.steps = 1

    expect(menuKeys(s, 'k1')).toContain('rein.consolidate')
    expect(s.mapView.openContextAction('k1', 'rein.consolidate')).toBe(true)
    expect(s.workbench.units.map((unit) => unit.instanceId)).toEqual(['k1'])
    expect(keep.steps).toBe(3)
  })

  it('★ 同格只有自己 ⇒ 不出现（没有可并的第二枚）', () => {
    const keep = placeGround(s.workbench, multiStepRecord(), HEX, 'soviet', 'k1')
    expect(menuKeys(s, 'k1')).not.toContain('rein.consolidate')
    expect(keep.steps).toBe(keep.printedSteps)
  })

  it('★ 同格有两枚可并（三枚堆叠）⇒ 不出现：不替玩家挑并哪一枚', () => {
    const record = multiStepRecord()
    for (const id of ['a', 'b', 'c']) placeGround(s.workbench, record, HEX, 'soviet', id)
    expect(menuKeys(s, 'a')).not.toContain('rein.consolidate')
  })

  it('★ 不在增援段（13.9 时机）⇒ 不出现', () => {
    const record = multiStepRecord()
    placeGround(s.workbench, record, HEX, 'soviet', 'k1')
    placeGround(s.workbench, record, HEX, 'soviet', 'r1')
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
    expect(menuKeys(s, 'k1')).not.toContain('rein.consolidate')
  })

  it('★ 专规 3.3d：轴方多单位编队合并会被拒 ⇒ 菜单里不出现', () => {
    const record = groundRecord('axis', (item) => /Inf Div/i.test(item.vassalName ?? ''))
    const axis = stores('axis')
    axis.workbench.setPhase('reinforcement')
    goToActionStep(axis.workbench, 'rein.rebuild')
    const keep = placeGround(axis.workbench, record, HEX, 'axis', 'k1')
    const remove = placeGround(axis.workbench, record, HEX, 'axis', 'r1')
    keep.formation = 'Pz-Gr Div'
    remove.formation = 'Pz-Gr Div'
    expect(menuKeys(axis, 'k1')).not.toContain('rein.consolidate')
  })
})

describe('右键：12.5 加油（用户 2026-11-10：唯一入口＝右键菜单，按可用性列方法）', () => {
  it('★ 移动环节、耗油且未加注 ⇒ 菜单列出「单单位法」，点它打开加油窗（不再只是设选中）', () => {
    const s = stores('axis')
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'supply.fuel')
    const tank = placeGround(s.workbench, fuelRecord(), HEX, 'axis', 't1')
    expect(needsFuelOf(tank)).toBe(true)
    expect(tank.fuelled).toBe(false)

    const keys = menuKeys(s, 't1')
    expect(keys).toContain('supply.fuel:singleUnit')
    // 旧键（不带方法）不再出现：入口必须落到"某一法"
    expect(keys).not.toContain('supply.fuel')

    expect(s.mapView.openContextAction('t1', 'supply.fuel:singleUnit')).toBe(true)
    expect(s.workbench.fuelSubjectId).toBe('t1')
    expect(s.workbench.fuelMethod).toBe('singleUnit')
    expect(s.mapView.session?.kind).toBe('fuel')
  })

  it('★ 编队单位 ⇒ 菜单同时列出编队法；该编队已付过 ⇒ 编队法不再出现（#13 同源判据）', () => {
    const s = stores('axis')
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'supply.fuel')
    const t1 = placeGround(s.workbench, fuelRecord(), HEX, 'axis', 't1')
    t1.formation = 'Pz-Gr Div'

    expect(menuKeys(s, 't1')).toContain('supply.fuel:formation')

    s.workbench.formationFuelThrows['Pz-Gr Div'] = {
      side: 'axis',
      sourceKey: 'dump:test',
      sourceLabel: '测试来源',
      coveredIds: ['t1'],
      originHex: { ...HEX },
    }
    expect(menuKeys(s, 't1')).not.toContain('supply.fuel:formation')
    // 已付编队不影响单单位法（12.5c-C 任何单位都可用）
    expect(menuKeys(s, 't1')).toContain('supply.fuel:singleUnit')
  })

  it('★ 已加注 ⇒ 不出现（12.5 没有第二笔要付）', () => {
    const s = stores('axis')
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'supply.fuel')
    const tank = placeGround(s.workbench, fuelRecord(), HEX, 'axis', 't1')
    tank.fuelled = true
    expect(menuKeys(s, 't1')).not.toContain('supply.fuel:singleUnit')
  })

  it('★ 步行单位（12.5a：不需燃料）⇒ 不出现', () => {
    const s = stores()
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'supply.fuel')
    const foot = placeGround(s.workbench, legRecord(), HEX, 'soviet', 'l1')
    expect(menuKeys(s, 'l1')).not.toContain('supply.fuel:singleUnit')
    expect(foot.fuelled).toBe(false)
  })
})

describe('右键：既有项不搬动（12.7 转换延补队）', () => {
  it('★ 运输点数在移动环节 ⇒ 右键仍有「运输点 ⇄ 延补队」', () => {
    const s = stores()
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.extenderConvert')
    const point = placeGround(
      s.workbench,
      groundRecord(
        'soviet',
        (record) =>
          record.noncombatKind === 'transport_point' &&
          (record.noncombatDetails?.transport ?? 0) >= 2,
      ),
      HEX,
      'soviet',
      'tp-1',
    )
    expect(menuKeys(s, point.instanceId)).toContain('move.extenderConvert')
  })
})

describe('右键：不灰按钮（不满足就不出现）', () => {
  it('★ 正在移动中 ⇒ 只有"先结束移动"才能做的项不进菜单（不是灰按钮）', () => {
    const s = stores()
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
    placeGround(s.workbench, legRecord(), HEX, 'soviet', 'l1')
    expect(s.workbench.beginMoveFor(['l1'])).toBe(true)
    expect(s.workbench.moveInteraction).not.toBe(null)

    menuKeys(s, 'l1')
    // 20.0a 的拆分在移动中仍合法（`add()` 明列豁免）；其余"先结束移动"才能做的项整条消失。
    // 用户 2026-11-09：「模式改变」改列"此刻真正能切的模式"——该单位尚未耗 MP ⇒ 引擎
    // `canSwitchModeNow` 仍允许切到 move，故这项合法地留在菜单里（不再是"先结束移动"的灰按钮）。
    const keys = s.mapView.contextOptions.flatMap((item) => item.actions).map((item) => item.key)
    expect(keys).toEqual(['move.orientation.toggle', 'move.breakdown'])
  })
})
