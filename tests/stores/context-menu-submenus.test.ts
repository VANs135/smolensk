import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  replRecordOf,
  useHotseatStore,
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
  // 2026-11-11：观察方手动选（不再随行动方自动切），测试里与行动方对齐
  useHotseatStore().setViewerSide(side)
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

  /** 该枚算子菜单里的某一项 */
  function actionIn(store: ReturnType<typeof stores>, id: string, key: string) {
    return actionsIn(store, id).find((item) => item.key === key)
  }

  it('★ 改变朝向：同一单位连点两次在战斗↔移动间往返', () => {
    const unit = placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'u1', 'combat')

    const first = actionIn(s, 'u1', 'move.orientation.toggle')
    expect(first?.group).toBe('模式改变')
    expect(first?.disabledReason).toBeNull()
    expect(first?.label).toContain('移动')
    expect(s.mapView.openContextAction('u1', 'move.orientation.toggle')).toBe(true)
    expect(unit.mode.mode).toBe('move')

    // 连点第二次：同键反向，回到战斗模式（不是单向空操作）
    const second = actionIn(s, 'u1', 'move.orientation.toggle')
    expect(second?.group).toBe('模式改变')
    expect(second?.disabledReason).toBeNull()
    expect(second?.label).toContain('战斗')
    expect(s.mapView.openContextAction('u1', 'move.orientation.toggle')).toBe(true)
    expect(unit.mode.mode).toBe('combat')
  })

  it('★ 补员算子：没有「改变朝向」项', () => {
    const record = replRecordOf('soviet', 'pax')
    if (record === null) throw new Error('单位库里缺少苏军 Pax 补员记录')
    placeGround(s.workbench, record, HEX, 'soviet', 'rx')
    const keys = actionsIn(s, 'rx').map((item) => item.key)
    expect(keys).not.toContain('move.orientation.toggle')
  })

  it('★ 不在移动环节（不可改模式）⇒ 整组不出现', () => {
    s.workbench.setPhase('reinforcement')
    goToActionStep(s.workbench, 'rein.rebuild')
    placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'u2', 'move')
    const actions = actionsIn(s, 'u2')
    expect(actions.some((item) => item.group === '模式改变')).toBe(false)
  })

  it('★ 转入预备模式：点击落预备', () => {
    const t = stores('axis')
    t.workbench.setScenarioId('1')
    t.workbench.setPhase('movement')
    goToActionStep(t.workbench, 'move.modeChange')
    const record = groundRecord(
      'axis',
      (item) => item.isCombat === true && item.classes?.movementClass === 'leg',
    )
    const unit = placeGround(t.workbench, record, HEX, 'axis', 'ax1', 'combat')

    const item = actionIn(t, 'ax1', 'move.reserve.toggle')
    expect(item?.group).toBe('模式改变')
    expect(item?.disabledReason).toBeNull()
    expect(item?.label).toBe('转入预备模式')
    expect(t.mapView.openContextAction('ax1', 'move.reserve.toggle')).toBe(true)
    expect(unit.mode.mode).toBe('reserve')
  })

  it('★ 转出预备模式：只在反应环节出现并可点', () => {
    // 反应阶段的**行动者**是非阶段玩家：activeSide=soviet ⇒ actingSide=axis
    const t = stores('soviet')
    // 2026-11-11：观察方手动选；本用例要看的是轴方反应单位
    useHotseatStore().setViewerSide('axis')
    t.workbench.setPhase('reaction')
    goToActionStep(t.workbench, 'reserve.release')
    const record = groundRecord(
      'axis',
      (item) => item.isCombat === true && item.classes?.movementClass === 'leg',
    )
    const unit = placeGround(t.workbench, record, HEX, 'axis', 'axr', 'combat')
    unit.mode = { ...unit.mode, mode: 'reserve' }

    const item = actionIn(t, 'axr', 'move.reserve.toggle')
    expect(item?.group).toBe('模式改变')
    expect(item?.disabledReason).toBeNull()
    expect(item?.label).toBe('转出预备模式')
    expect(t.mapView.openContextAction('axr', 'move.reserve.toggle')).toBe(true)
    expect(unit.mode.releasedFromReserve).toBe(true)
  })

  it('★ 战略模式：转入后菜单变「转出战略模式」，再点回移动模式', () => {
    const t = stores('axis')
    t.workbench.setPhase('movement')
    goToActionStep(t.workbench, 'move.modeChange')
    const record = groundRecord(
      'axis',
      (item) => item.isCombat === true && item.classes?.movementClass === 'leg',
    )
    const unit = placeGround(t.workbench, record, HEX, 'axis', 'axs', 'combat')

    const first = actionIn(t, 'axs', 'move.strat.toggle')
    expect(first?.group).toBe('模式改变')
    expect(first?.disabledReason).toBeNull()
    expect(first?.label).toBe('转入战略模式')
    expect(t.mapView.openContextAction('axs', 'move.strat.toggle')).toBe(true)
    expect(unit.mode.mode).toBe('strat')

    const second = actionIn(t, 'axs', 'move.strat.toggle')
    expect(second?.label).toBe('转出战略模式')
    expect(t.mapView.openContextAction('axs', 'move.strat.toggle')).toBe(true)
    expect(unit.mode.mode).toBe('move')
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
    // 同格再摆一枚编内卡车：它在格上，但不在 `movePick.ids` 里 ⇒ 不得成为菜单的目标
    const truck = groundRecord('axis', (record) => record.noncombatKind === 'organic_truck')
    placeGround(s.workbench, truck, HEX, 'soviet', 'truck', 'move')
    s.workbench.beginMovePick(HEX, ['a', 'b'])
    expect(s.workbench.movePick?.ids).toEqual(['a', 'b'])
    s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
    // 只有一块共用菜单，标题取两份选中（2 枚），不是卡车
    expect(s.mapView.contextOptions.map((item) => item.id)).toEqual(['__shared__'])
    expect(s.mapView.contextOptions[0]?.label).toBe('已选 2 枚')
    expect(s.mapView.contextOptions.length).toBe(1)
    // 两枚步兵都能改模式 ⇒ 「模式改变」组在列（卡车的菜单不会顶替这份）
    const modeRows =
      s.mapView.contextOptions[0]?.actions.filter((a) => a.group === '模式改变') ?? []
    expect(modeRows.length).toBeGreaterThan(0)
  })

  it('★ 窗内右键某枚 ⇒ 单目标菜单（该单位自己的）', () => {
    const ok = s.mapView.openUnitContext(HEX, 'b', { x: 0, y: 0 })
    expect(ok).toBe(true)
    expect(s.mapView.contextOptions.map((item) => item.id)).toEqual(['b'])
  })

  it('★ 会话窗开着（ops / supply / containers 等）时，窗内右键仍出该单位自己的菜单', () => {
    /*
     * 用户 2026-11-10：在会话窗里对算子右键无效。
     * 根因：`canOpenCounterContext` 把"会话种类"当成了闸门，只放行 move / unit / reinforce，
     * 其余会话（ops / barrage / air / supply / breakout / containers / exclusive）一律拒。
     * 右键菜单与当前会话本就并存（`unit` 段已是先例），能否列出动作由 `counterActionsAt` 逐项判。
     */
    s.mapView.openOpsFlow('barrage', HEX)
    expect(s.mapView.session?.kind).toBe('ops')
    const ok = s.mapView.openUnitContext(HEX, 'b', { x: 0, y: 0 })
    expect(ok).toBe(true)
    expect(s.mapView.contextOptions.map((item) => item.id)).toEqual(['b'])
  })

  it('★ 地图右键敌方堆叠 ⇒ 一份共用菜单出「低空扫射」（14.7d）', () => {
    const enemyHex: HexRef = { col: 35, row: 12 }
    placeGround(
      s.workbench,
      groundRecord('axis', (record) => record.isCombat === true),
      enemyHex,
      'axis',
      'ax-a',
    )
    placeGround(
      s.workbench,
      groundRecord('axis', (record) => record.isCombat === true),
      enemyHex,
      'axis',
      'ax-b',
    )
    s.workbench.selectedId = null
    // 观察员/航程/天气等前置另测；这里只验右键把**敌方堆叠**接到三操作统一入口
    const spy = vi.spyOn(s.workbench, 'hipShootEntryEligible').mockReturnValue(true)
    s.mapView.onHexContext(enemyHex, { x: 0, y: 0 }, { x: 0, y: 0 })

    // 4.9a：敌方堆叠只露可见面 ⇒ 右键出**一份**菜单（不是每枚一块）
    expect(s.mapView.contextOptions).toHaveLength(1)
    const row = s.mapView.contextOptions[0]?.actions.find((item) => item.key === 'ops.hipShoot')
    expect(row?.label).toContain('低空扫射')
    expect(row?.only).toBe('opsHipShoot')
    spy.mockRestore()
  })
})

describe('源码守卫', () => {
  it('★ 全站拦掉 WebView 原生右键菜单（输入框保留系统菜单）', () => {
    const app = readFileSync('src/App.vue', 'utf8')
    // 不再只拦图片：窗口级监听一律 preventDefault，否则原生菜单会盖住单位菜单
    expect(app).toContain('preventDefault()')
    expect(app).not.toContain('instanceof HTMLImageElement')
    // 例外：文本输入保留复制/粘贴
    expect(app).toContain('HTMLInputElement')
    expect(app).toContain('HTMLTextAreaElement')
    expect(app).toContain('isContentEditable')
    expect(app).toContain("addEventListener('contextmenu'")
    expect(app).toContain("removeEventListener('contextmenu'")
    // 窗内 chip 仍自带 prevent.stop（双保险）
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).toContain('@contextmenu.prevent.stop="onChipContext')
  })

  it('★ 菜单一级是分组入口 + 子菜单容器；MapPopover 放行溢出', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).toContain('context-group__trigger')
    expect(popover).toContain('context-group__submenu')
    expect(popover).toContain('class="popover--menu"')

    const mapPopover = readFileSync('src/components/map/MapPopover.vue', 'utf8')
    expect(mapPopover).toContain('.popover--menu .popover__body')
    expect(mapPopover).toContain('overflow: visible')
  })

  it('★ 模式组只有三个 toggle 键，不再出现 move.mode.combat / 四键循环', () => {
    const source = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(source).toContain('move.orientation.toggle')
    expect(source).toContain('move.reserve.toggle')
    expect(source).toContain('move.strat.toggle')
    expect(source).not.toContain('move.mode.combat')
    expect(source).not.toContain('for (const [key, label, to] of MODE_MENU_ACTIONS)')
    expect(source).not.toContain('MODE_MENU_TARGETS')
  })
})
