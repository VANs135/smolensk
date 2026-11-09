import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { emptyReplHoldings } from '@/engine/rules'
import { useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

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
