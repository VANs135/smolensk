import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { emptyReplHoldings } from '@/engine/rules'
import { useMapViewStore, useSetupStore, useWorkbenchStore, unitChoices } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 左键堆叠窗的选中集（用户 2026-11-09 第 4 轮）
 *
 * 口径：
 *   · 窗内只摆**战斗单位**，摊开堆叠默认全部选中；点某枚＝取消该单位选中、再点恢复；
 *   · 选中集**就是** `workbench.movePick.ids` —— 不再另存一份 `stackPickIds`
 *     （同一处状态不留两份）；
 *   · 旧的「选择要一起开拔的单位」清单已删，chip 直接驱动 `movePick`。
 *
 * 非战斗（SP / 运输点）不进这个窗——它们的操作走右键菜单。
 */

const HEX: HexRef = { col: 15, row: 10 }
const OTHER: HexRef = { col: 16, row: 10 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('soviet')
  return { workbench, mapView: useMapViewStore() }
}

/** 战斗单位（单位库里的 `isCombat` 记录） */
function combatRecord() {
  return groundRecord('soviet', (record) => record.isCombat === true)
}

function placeInfantry(workbench: Workbench, id: string, hex: HexRef = HEX) {
  placeGround(workbench, combatRecord(), hex, 'soviet', id)
}

function addDump(workbench: Workbench): void {
  workbench.spDumps.push({ id: 'd1', hex: { ...HEX }, side: 'soviet', sp: 4, t: 0 })
}

/** 补给点数算子（盘面上的 SP 计数枚，非战斗） */
function spRecord() {
  const found = unitChoices('soviet').find(
    (record) => record.isCombat !== true && (record.noncombatDetails?.spValue ?? 0) > 0,
  )
  if (found === undefined) throw new Error('苏军单位库中没有 SP 点数算子')
  return found
}

/** 运输点数（3.3b，非战斗） */
function transportRecord() {
  const found = unitChoices('soviet').find(
    (record) => record.isCombat !== true && (record.noncombatDetails?.transport ?? 0) > 0,
  )
  if (found === undefined) throw new Error('苏军单位库中没有运输点数')
  return found
}

describe('左键堆叠窗：选中集只有 movePick 一份', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    placeInfantry(s.workbench, 'inf-a')
    placeInfantry(s.workbench, 'inf-b')
    addDump(s.workbench)
  })

  it('★ 摊开堆叠 ⇒ movePick 即选中集（只有战斗单位），mapView 不再有 stackPickIds', () => {
    s.mapView.expandStackAt(HEX)
    s.mapView.openPopup(HEX, 0, 0)

    expect([...(s.workbench.movePick?.ids ?? [])].sort()).toEqual(['inf-a', 'inf-b'])
    // 同一处状态只留 movePick：旧的 UI 选中集与切换函数都不再存在
    expect('stackPickIds' in s.mapView).toBe(false)
    expect('toggleStackPick' in s.mapView).toBe(false)
  })

  it('★ 点一枚＝从 movePick 取消；再点＝恢复', () => {
    s.mapView.expandStackAt(HEX)
    s.workbench.toggleMovePick('inf-a')
    expect([...(s.workbench.movePick?.ids ?? [])]).toEqual(['inf-b'])
    s.workbench.toggleMovePick('inf-a')
    expect([...(s.workbench.movePick?.ids ?? [])].sort()).toEqual(['inf-a', 'inf-b'])
  })

  it('★ 换格摊开＝movePick 指向新格（不沿用上一格的取消）', () => {
    s.mapView.expandStackAt(HEX)
    s.workbench.toggleMovePick('inf-a')
    expect([...(s.workbench.movePick?.ids ?? [])]).toEqual(['inf-b'])

    placeInfantry(s.workbench, 'inf-c', OTHER)
    s.mapView.expandStackAt(OTHER)
    expect(s.workbench.movePick?.hex).toEqual(OTHER)
    expect([...(s.workbench.movePick?.ids ?? [])]).toEqual(['inf-c'])
  })

  it('★ #12 默认全选＝战斗单位：SP / 运输点不进默认集；点一枚取消、再点恢复（可空）', () => {
    // 同格再摆一枚 SP 点数与一枚运输点数（都是非战斗，但可被显式点选）
    placeGround(s.workbench, spRecord(), HEX, 'soviet', 'sp1')
    placeGround(s.workbench, transportRecord(), HEX, 'soviet', 'tp1')

    s.mapView.expandStackAt(HEX)
    // 默认集只含战斗单位
    expect([...(s.workbench.movePick?.ids ?? [])].sort()).toEqual(['inf-a', 'inf-b'])
    // 非战斗仍出现在可选清单里（显式点选才进集合）
    expect([...s.workbench.movePickChoices.map((unit) => unit.instanceId)].sort()).toEqual([
      'inf-a',
      'inf-b',
      'sp1',
      'tp1',
    ])

    // 点一枚 ⇒ 取消；再点 ⇒ 恢复
    s.workbench.toggleMovePick('inf-a')
    expect(s.workbench.movePick?.ids).toEqual(['inf-b'])
    s.workbench.toggleMovePick('inf-a')
    expect([...(s.workbench.movePick?.ids ?? [])].sort()).toEqual(['inf-a', 'inf-b'])

    // 全部取消（允许空集，再点恢复），不被"至少保留一枚"挡住
    s.workbench.toggleMovePick('inf-a')
    s.workbench.toggleMovePick('inf-b')
    expect(s.workbench.movePick?.ids).toEqual([])
    s.workbench.toggleMovePick('inf-b')
    expect(s.workbench.movePick?.ids).toEqual(['inf-b'])
  })

  it('★ #12 非战斗被显式点选后可再取消；「全选本格」回到战斗单位集', () => {
    placeGround(s.workbench, transportRecord(), HEX, 'soviet', 'tp1')
    s.mapView.expandStackAt(HEX)
    s.workbench.toggleMovePick('tp1')
    expect(s.workbench.movePick?.ids).toContain('tp1')
    s.workbench.setMovePickAll()
    expect([...(s.workbench.movePick?.ids ?? [])].sort()).toEqual(['inf-a', 'inf-b'])
  })

  it('★ 13.5 补员算子不算战斗单位：同格的 Pax 补员不进选中集', () => {
    // 补员记录在数据层写 `isCombat: true`，若不按 `replKind` 剔掉就会混进这个窗
    s.workbench.setReplHoldingsNow({ ...emptyReplHoldings(), pax: 1 }, HEX)
    const repls = s.workbench.units.filter((unit) => unit.replKind !== null)
    expect(repls).toHaveLength(1)

    s.mapView.expandStackAt(HEX)
    expect([...(s.workbench.movePick?.ids ?? [])].sort()).toEqual(['inf-a', 'inf-b'])
    // 取子清单（chip 与旧清单共用的那一份）同样看不见补员算子
    expect(s.workbench.movePickChoices.map((unit) => unit.instanceId).sort()).toEqual([
      'inf-a',
      'inf-b',
    ])
  })

  it('★ 组件接线：旧开拔清单已删，chip 直接绑 movePick', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).not.toContain('选择要一起开拔的单位')
    expect(popover).not.toContain('stackPickIds')
    expect(popover).not.toContain('toggleStackPick')
    expect(popover).toContain('@click="toggleChip(unit.id)"')
    expect(popover).toContain('workbench.toggleMovePick(id)')
    expect(popover).toContain('movePickIds.value.includes(id)')
  })

  it('★ 堆叠窗极简：只有算子与按钮，"选完点开始移动即进入移动"，无说明块', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    // 开始移动按钮走既有 confirmMovePick（6.1），不另写规则
    expect(popover).toContain('开始移动')
    expect(popover).toContain('workbench.confirmMovePick()')
    // 旧的"发起战斗"只显示攻方数量的信息块（无按钮）已删
    expect(popover).not.toContain('<h4 class="block__title">发起战斗</h4>')
    // 选中集默认全选：chip 选中态读 movePick.ids（同格即全选）
    expect(popover).toContain('!isMovePickHex.value || movePickIds.value.includes(id)')
  })
})

/**
 * 堆叠窗口收口（用户 2026-11-10）
 *
 * 四条口径：列全 / 默认全选 / 地图同格展开 / 删说明文字。
 */
describe('堆叠窗口收口：列全、默认全选、同格展开、删说明', () => {
  const popoverSource = (): string =>
    readFileSync('src/components/game/MapActionPopover.vue', 'utf8')

  it('★ 默认全选：摊开即选中该格全部本方可开拔算子', () => {
    const s = stores()
    placeInfantry(s.workbench, 'inf-a')
    placeInfantry(s.workbench, 'inf-b')

    s.mapView.expandStackAt(HEX)

    expect([...s.mapView.stackSelection].sort()).toEqual(['inf-a', 'inf-b'])
    expect([...(s.workbench.movePick?.ids ?? [])].sort()).toEqual(['inf-a', 'inf-b'])
  })

  it('★ 默认全选不跨敌我：同格敌方算子不进选中集', () => {
    const s = stores()
    placeInfantry(s.workbench, 'inf-a')
    placeGround(
      s.workbench,
      groundRecord('axis', (record) => record.isCombat === true),
      HEX,
      'axis',
      'ax-a',
    )

    s.mapView.expandStackAt(HEX)

    expect(s.mapView.stackSelection).toEqual(['inf-a'])
    expect(s.workbench.movePick?.ids).toEqual(['inf-a'])
  })

  it('★ 列全：窗口不再按「参与集合 / 战斗单位」过滤，飞机另列', () => {
    const popover = popoverSource()
    // 旧的两层过滤（本方非参与项、非战斗单位）必须消失
    expect(popover).not.toContain('actionableOwnIds')
    expect(popover).not.toContain('combatUnits')
    // 直接摆该格全部地面令牌；飞机单列
    expect(popover).toContain('content.value?.units')
    expect(popover).toContain('content.value?.airUnits')
  })

  it('★ 点己方堆叠即自动展开（窗内不再有展开按钮）', () => {
    const s = stores()
    placeInfantry(s.workbench, 'inf-a')
    placeInfantry(s.workbench, 'inf-b')

    s.mapView.onHexClick(HEX)

    // 点这一击就摊开，并默认全选
    expect(s.mapView.expandedStack).toEqual({ hex: HEX, page: 0 })
    expect([...s.mapView.stackSelection].sort()).toEqual(['inf-a', 'inf-b'])
    // 不再有「地图展开 / 收起展开」按钮（多一个按钮＝多一步操作）
    expect(popoverSource()).not.toContain('地图展开')
    expect(popoverSource()).not.toContain('收起展开')
  })

  it('★ 切格即自动收起；空格不展开', () => {
    const s = stores()
    placeInfantry(s.workbench, 'inf-a')
    placeInfantry(s.workbench, 'inf-b')

    s.mapView.onHexClick(HEX)
    expect(s.mapView.expandedStack).not.toBeNull()

    // 切到另一空格 ⇒ 旧格的摊开自动收起，新格没有可摊开的堆叠
    s.mapView.onHexClick(OTHER)
    expect(s.mapView.expandedStack).toBeNull()
  })

  it('★ 删说明文字：窗内不再写规则解释段落', () => {
    const popover = popoverSource()
    expect(popover).not.toContain('青色虚线＝合法落点')
    expect(popover).not.toContain('本格没有非激活飞机')
    expect(popover).not.toContain('整备容量')
  })

  it('★ 13.2g：点格开窗，窗口里必须有编内卡车，并标出与编队的随行关系', () => {
    const s = stores()
    // 编内卡车只在轴方单位库里出现 ⇒ 这一条按轴方视点摆（4.9a 会裁掉敌方不可见令牌）。
    // 视点由当前行动方推出（`decisionSide`），不能直接写只读的 `viewerSide`。
    s.workbench.setActiveSide('axis')
    const truckRecord = groundRecord('axis', (record) => record.noncombatKind === 'organic_truck')
    placeGround(s.workbench, truckRecord, HEX, 'axis', 'truck')
    placeGround(
      s.workbench,
      groundRecord('axis', (record) => record.isCombat === true),
      HEX,
      'axis',
      'inf-a',
    )

    s.mapView.onHexClick(HEX)

    // 窗口＝该格全列（含卡车），否则玩家不知道它跟着谁
    expect(s.mapView.popup?.variant).toBe('content')
    expect(s.mapView.popupContent?.units.map((unit) => unit.id)).toContain('truck')
    // 组件层：按 `formation` 给 chip 追加「随 <编队>」标注（不是说明段落）
    const popover = popoverSource()
    expect(popover).toContain('truckFormationOf')
    expect(popover).toContain("noncombatKind !== 'organic_truck'")
  })
})
