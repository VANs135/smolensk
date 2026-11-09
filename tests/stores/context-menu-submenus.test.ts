import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  replRecordOf,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 右键菜单多级分组（用户 2026-11-09）
 *
 * 两条口径：
 *   · 一级只摆分组入口，右侧子菜单按组展开；
 *   · 「模式改变」只列**此刻真正能切过去**的模式 —— 判据在 `workbench.switchableModesOf`，
 *     与 `switchUnitMode` 同源，不允许点进去才被拒（也不摆灰按钮）。
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

/** 普通战斗单位（步兵）：验「模式改变」的可切换集合 */
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

describe('switchableModesOf：与 switchUnitMode 同一判据', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
  })

  it('★ 普通战斗单位：当前模式不列，另一面在列（combat ⇄ move）', () => {
    const inCombat = placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'c1', 'combat')
    const combatModes = s.workbench.switchableModesOf(inCombat.instanceId)
    expect(combatModes).not.toContain('combat')
    expect(combatModes).toContain('move')

    const inMove = placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'm1', 'move')
    const moveModes = s.workbench.switchableModesOf(inMove.instanceId)
    expect(moveModes).not.toContain('move')
    expect(moveModes).toContain('combat')
  })

  it('★ 补员算子（13.5）：不列 combat（它就是移动模式，其余照常判）', () => {
    const record = replRecordOf('soviet', 'pax')
    if (record === null) throw new Error('单位库里缺少苏军 Pax 补员记录')
    const repl = placeGround(s.workbench, record, HEX, 'soviet', 'r1')
    const modes = s.workbench.switchableModesOf(repl.instanceId)
    expect(repl.mode.mode).toBe('move')
    expect(modes).not.toContain('combat')
    expect(modes).not.toContain('move')
  })

  it('★ 单位不存在 / 不是当前行动方 ⇒ 空', () => {
    expect(s.workbench.switchableModesOf('nope')).toEqual([])
    placeGround(s.workbench, infantryRecord(), HEX, 'axis', 'enemy', 'move')
    expect(s.workbench.switchableModesOf('enemy')).toEqual([])
  })

  it('★ 已开始移动（已耗 MP）⇒ 非预备模式不能切；投影不写日志', () => {
    const unit = placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'm2', 'move')
    const logCount = s.workbench.log.length
    unit.mpSpent = 1
    const modes = s.workbench.switchableModesOf('m2')
    expect(modes).not.toContain('combat')
    expect(modes).not.toContain('move')
    expect(modes).not.toContain('strat')
    // 投影只读：`canEnterReserveMode` 会 pushLog，本函数必须走纯函数
    expect(s.workbench.log.length).toBe(logCount)
  })
})

describe('右键「模式改变」分组', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
  })

  it('★ 模式动作归「模式改变」组，只列可切换的模式（当前模式不出现）', () => {
    placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'u1', 'move')
    const actions = actionsIn(s, 'u1')
    const modeActions = actions.filter((item) => item.key.startsWith('move.mode.'))
    expect(modeActions.length).toBeGreaterThan(0)
    for (const action of modeActions) {
      expect(action.group).toBe('模式改变')
      expect(action.disabledReason).toBeNull()
    }
    const keys = modeActions.map((item) => item.key)
    expect(keys).toContain('move.mode.combat')
    expect(keys).not.toContain('move.mode.move')
  })

  it('★ 补员算子：菜单里没有「改战斗模式」', () => {
    const record = replRecordOf('soviet', 'pax')
    if (record === null) throw new Error('单位库里缺少苏军 Pax 补员记录')
    placeGround(s.workbench, record, HEX, 'soviet', 'rx')
    const keys = actionsIn(s, 'rx').map((item) => item.key)
    expect(keys).not.toContain('move.mode.combat')
  })

  it('★ 不在移动环节（不可改模式）⇒ 整组不出现', () => {
    s.workbench.setPhase('reinforcement')
    goToActionStep(s.workbench, 'rein.rebuild')
    placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'u2', 'move')
    const actions = actionsIn(s, 'u2')
    expect(actions.some((item) => item.group === '模式改变')).toBe(false)
  })
})

describe('堆叠右键：目标集合', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
    placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'a', 'move')
    placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'b', 'move')
  })

  it('★ 已选单位就在这一格 ⇒ 只列它', () => {
    s.workbench.selectedId = 'b'
    s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(s.mapView.contextOptions.map((item) => item.id)).toEqual(['b'])
  })

  it('★ 没有选中 ⇒ 该格全部本单位合成**一份**共用菜单', () => {
    s.workbench.selectedId = null
    s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(s.mapView.contextOptions.map((item) => item.id)).toEqual(['__shared__'])
    expect(s.mapView.contextOptions[0]?.label).toBe('已选 2 枚')
    // 选项是能力并集：步兵能改模式，两枚都具备 ⇒ 组只出现一次
    const modeRows =
      s.mapView.contextOptions[0]?.actions.filter((a) => a.group === '模式改变') ?? []
    expect(modeRows.length).toBeGreaterThan(0)
  })

  it('★ 取子清单选中两枚 ⇒ 菜单按选中集合出，不落到某一枚（尤其编内卡车）', () => {
    s.workbench.setMovePickIds(['a', 'b'])
    s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(s.mapView.contextOptions.map((item) => item.id)).toEqual(['__shared__'])
    const keys = s.mapView.contextOptions[0]?.actions.map((item) => item.key) ?? []
    expect(keys.length).toBeGreaterThan(0)
  })

  it('★ 窗内右键某枚 ⇒ 单目标菜单（该单位自己的）', () => {
    const ok = s.mapView.openUnitContext(HEX, 'b', { x: 0, y: 0 })
    expect(ok).toBe(true)
    expect(s.mapView.contextOptions.map((item) => item.id)).toEqual(['b'])
  })
})

describe('源码守卫', () => {
  it('★ 菜单一级是分组入口 + 子菜单容器；MapPopover 放行溢出', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).toContain('context-group__trigger')
    expect(popover).toContain('context-group__submenu')
    expect(popover).toContain('class="popover--menu"')

    const mapPopover = readFileSync('src/components/map/MapPopover.vue', 'utf8')
    expect(mapPopover).toContain('.popover--menu .popover__body')
    expect(mapPopover).toContain('overflow: visible')
  })

  it('★ MODE_MENU_ACTIONS 带目标模式列，模式动作不再归「移动」组', () => {
    const source = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(source).toContain("['move.mode.combat', '改战斗模式', 'combat']")

    const start = source.indexOf('for (const [key, label, to] of MODE_MENU_ACTIONS)')
    expect(start).toBeGreaterThan(-1)
    const block = source.slice(start, start + 600)
    expect(block).toContain("group: '模式改变'")
    expect(block).not.toContain("group: '移动'")
  })
})
