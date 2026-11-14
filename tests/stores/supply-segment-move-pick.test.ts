import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * 缺陷 B（2026-11-14 实点）：补给段点单位被记成「待开拔」，换段不清 `movePick`
 *
 * 现场：D 补给段点 9.6 的 Ru 55 Rifle Div ⇒ 日志「已选 1 枚待开拔（6.1）」；
 * 推进到 E 反应段后自动弹出「移动准备（6.1）」会话，主语仍是苏军单位，
 * 而该段决策方是轴心国；点 × 关掉又因 `movePick` 未清而立刻重建。
 *
 * 判据（2.2 环节归属 + 6.1）：
 *   · 只有放行 `move.order` 的环节点己方单位才建立待开拔集；
 *   · 换段/换方/换回合一律清 `movePick`（段内半截选择不能带过去）；
 *   · 会话派生再校验「所属方」：该格无本环节行动方的可开拔单位 ⇒ 不开移动会话。
 */
const HEX: HexRef = { col: 36, row: 13 }

type Workbench = ReturnType<typeof useWorkbenchStore>

/** 徒步战斗单位（可开拔，且不触发 12.5a 加油） */
function legCombat(side: 'axis' | 'soviet') {
  const found = unitChoices(side).find(
    (record) =>
      record.isCombat === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.ma ?? 0) >= 2,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有徒步战斗单位`)
  return found
}

function mount(side: 'axis' | 'soviet') {
  setActivePinia(createPinia())
  const workbench = useWorkbenchStore()
  const mapView = useMapViewStore()
  workbench.setActiveSide(side)
  return { workbench, mapView }
}

function place(store: Workbench, side: 'axis' | 'soviet', instanceId: string, hex: HexRef = HEX) {
  const unit = toConsoleUnit({ record: legCombat(side), instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 把 store 放到本阶段允许该动作的环节（B7 闸门反查，不写死序号） */
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
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('缺陷 B：补给段不建待开拔、换段清选择集', () => {
  it('D 补给段点己方单位 ⇒ 只读选中，不建 movePick、不开移动会话', () => {
    const { workbench, mapView } = mount('soviet')
    workbench.setPhase('supply')
    const unit = place(workbench, 'soviet', 's1')

    workbench.clickHex(HEX)

    expect(workbench.movePick).toBeNull()
    expect(workbench.selectedUnit?.instanceId).toBe(unit.instanceId)
    expect(mapView.session).toBeNull()
  })

  it('移动段建起的 movePick 在换段（movement → reaction）后清空', () => {
    const { workbench, mapView } = mount('soviet')
    workbench.setPhase('movement')
    goToActionStep(workbench, 'move.order')
    place(workbench, 'soviet', 's1')

    workbench.clickHex(HEX)
    expect(workbench.movePick?.ids).toEqual(['s1'])

    workbench.setPhase('reaction')
    expect(workbench.movePick).toBeNull()
    expect(mapView.session).toBeNull()
  })

  it('反应段残留苏军 movePick（旧档/直写）也不会开出移动会话', () => {
    const { workbench, mapView } = mount('soviet')
    workbench.setPhase('reaction')
    place(workbench, 'soviet', 's1')

    // 模拟修复前遗留的跨段选择集（该格在本环节没有行动方 axis 的可开拔单位）
    workbench.movePick = { hex: HEX, ids: ['s1'] }

    expect(mapView.session).toBeNull()
  })
})
