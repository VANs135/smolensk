import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { areAdjacent } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * B15a：**移动 / 突袭的操作链进会话框**（方案 §4.2「地图优先的操作链」）
 *
 * 为什么这批要做：6.1 的「撤销一步 / 结束移动 / 放弃整次移动」与 6.1f 的「放下」原先只挂在
 * `WorkbenchView`（引擎验证页）——**对局台上没有入口**，于是"能不能走完一局"缺了一环。
 *
 * 本文件钉四件事：
 *   ① **路由**：正在移动 ⇒ `mapView.session.kind === 'move'`，标题带单位名与规则号（突袭时是 8.1a）；
 *   ② **取消落到 store**：`cancelSession()` ⇒ `cancelWholeMove()`（不是"把工具关掉"），且 MP 真还原；
 *   ③ **操作链真的接线**：撤销一步还原 MP、6.1f 放下把该枚就地停住、结束移动收束本次交互；
 *   ④ **源码守卫**：面板用 store 的动作（不自己算规则）、`MapDock` 真的把 `MovePanel` 挂进 else 分支。
 *
 * ★ 用**真实地图 + 真实单位库**（不造数）：会话在不在，全看引擎状态机有没有在跑。
 *
 * ★ 条 10（批 M）契约同步：**旧口径「点格即开始移动」已作废**——`clickHex` 现在只建立取子清单
 *   （`movePick`），真正开拔改由「开始移动」按钮（`confirmMovePick`）触发。故本文件凡是"选完即开拔"
 *   的写定都改为 `clickHex(START)` 之后显式 `confirmMovePick()`。这是**裁定变更**（非放宽）：
 *   验收要求"选中后点开始移动按钮才开拔"。
 */

const START: HexRef = { col: 36, row: 13 }

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 徒步战斗单位（能走、能战斗；6.1 的移动主体） */
const legRecord = (side: 'axis' | 'soviet') => {
  const found = unitChoices(side).find(
    (record) =>
      record.isCombat === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.ma ?? 0) >= 2,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有徒步战斗单位`)
  return found
}

function place(
  store: ReturnType<typeof newStores>['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
) {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 从 `store.groupReachable` 里取一个与起点相邻的可到达格（一步即到） */
function adjacentReachable(store: ReturnType<typeof newStores>['workbench']): HexRef {
  const hit = store.groupReachable.hexes.find((node) => areAdjacent(START, node.hex))
  if (hit === undefined) throw new Error('起点没有相邻的可到达格（夹具前提不成立）')
  return hit.hex
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B15a：移动会话的路由与取消', () => {
  it('★ 正在移动 ⇒ 路由出 `move` 会话；标题带单位名与 6.1', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    place(workbench, legRecord('axis'), START, 'axis', 'a1')

    expect(mapView.session).toBeNull()
    workbench.clickHex(START)
    // 条 10：点格只建取子清单，开拔交由「开始移动」按钮
    expect(workbench.confirmMovePick()).toBe(true)
    expect(workbench.moveInteraction).not.toBeNull()

    const session = mapView.session
    expect(session?.kind).toBe('move')
    expect(session?.rule).toBe('6.1')
    expect(session?.title).toContain('6.1')
  })

  it('★ 会话取消 ⇒ `cancelWholeMove`（放弃整次移动、全部还原），不是"把工具关掉"', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    const unit = place(workbench, legRecord('axis'), START, 'axis', 'a1')
    workbench.clickHex(START)
    // 条 10：点格只建取子清单，开拔交由「开始移动」按钮
    expect(workbench.confirmMovePick()).toBe(true)

    const step = adjacentReachable(workbench)
    workbench.clickHex(step)
    expect(workbench.moveInteraction?.steps.length).toBeGreaterThan(0)
    expect(unit.mpSpent).toBeGreaterThan(0)

    expect(mapView.cancelSession()).toBe(true)
    // 6.1：放弃本次移动 = 回到开始移动之前（位置上、MP 上都要回去），并**退出移动态**
    //（§4.3「流程一结束即自动消失」：会话随之收起）
    expect(workbench.moveInteraction).toBeNull()
    expect(unit.hex).toEqual(START)
    expect(unit.mpSpent).toBe(0)
    expect(mapView.session).toBeNull()
  })

  it('一次只给一个会话：移动与战斗不会同时挂两个（结构保证）', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    place(workbench, legRecord('axis'), START, 'axis', 'a1')
    workbench.clickHex(START)
    // 条 10：点格只建取子清单，开拔交由「开始移动」按钮
    expect(workbench.confirmMovePick()).toBe(true)
    expect(mapView.session?.kind).toBe('move')
    // 移动中不会冒出战斗/轰炸会话（引擎同一时刻只跑一个状态机）
    expect(workbench.combatState).toBeNull()
    expect(workbench.barrageState).toBeNull()
  })
})

describe('B15a：操作链（撤销一步 / 放下 / 结束移动）真的接线', () => {
  it('★ 撤销一步：MP 与步数都回到上一步之前（6.1）', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    const unit = place(workbench, legRecord('axis'), START, 'axis', 'a1')
    workbench.clickHex(START)
    // 条 10：点格只建取子清单，开拔交由「开始移动」按钮
    expect(workbench.confirmMovePick()).toBe(true)
    workbench.clickHex(adjacentReachable(workbench))

    const afterStep = unit.mpSpent
    expect(afterStep).toBeGreaterThan(0)
    workbench.undoLastStep()
    expect(unit.mpSpent).toBeLessThan(afterStep)
    expect(workbench.moveInteraction?.steps.length).toBe(0)
    expect(unit.hex.col === START.col && unit.hex.row === START.row).toBe(true)
  })

  it('★ 6.1f 放下：点阵列里那一枚即把它就地停住（其余继续）', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    const a = place(workbench, legRecord('axis'), START, 'axis', 'a1')
    const b = place(workbench, legRecord('axis'), START, 'axis', 'a2')
    // 6.1：选择方式＝整堆叠（地图上点堆叠只落顶上一枚，故这里显式切到"整堆叠"）
    workbench.setStackSelect(true)
    workbench.clickHex(START)
    // 条 10：点格只建取子清单，开拔交由「开始移动」按钮
    expect(workbench.confirmMovePick()).toBe(true)
    workbench.setStackSelect(false)
    expect(workbench.moveUnits.map((unit) => unit.instanceId).sort()).toEqual(
      [a.instanceId, b.instanceId].sort(),
    )

    expect(workbench.dropUnitFromMove(a.instanceId)).toBe(true)
    expect(a.movementEnded).toBe(true)
    // 还有一枚在动 ⇒ 交互不结束
    expect(workbench.moveInteraction?.finished).toBe(false)
    expect(workbench.activeMoveUnits.map((unit) => unit.instanceId)).toEqual([b.instanceId])
  })

  it('★ 结束移动：收束本次交互（会话随之消失）', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    place(workbench, legRecord('axis'), START, 'axis', 'a1')
    workbench.clickHex(START)
    // 条 10：点格只建取子清单，开拔交由「开始移动」按钮
    expect(workbench.confirmMovePick()).toBe(true)

    workbench.finishMove()
    expect(workbench.moveInteraction?.finished).toBe(true)
    expect(mapView.session).toBeNull()
  })
})

describe('B15a：移动面板的接线（源码守卫）', () => {
  const panel = readFileSync('src/components/move/MovePanel.vue', 'utf8')

  it('六个动作都直连 store（面板不自己算规则）', () => {
    for (const call of [
      'workbench.undoLastStep()',
      'workbench.finishMove()',
      'workbench.abortMoveNow()',
      'workbench.dropUnitFromMove($event)',
      'workbench.confirmZocEntry()',
      'workbench.dismissZocConfirm()',
      'workbench.switchUnitMode(',
      'workbench.setHoverHex',
    ]) {
      expect(panel).toContain(call)
    }
    // 规则计算不在组件里：面板不导入引擎
    expect(panel).not.toContain("from '@/engine")
  })

  it('★ `MapDock` 的 else 分支挂的是移动面板（会话种类与视图一一对应）', () => {
    const view = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(view).toContain("session.kind === 'combat'")
    expect(view).toContain("session.kind === 'barrage'")
    expect(view).toContain('<MovePanel v-else />')
    expect(view).toContain("from '@/components/move'")
  })

  it('路由与取消都在 `map-view` 里（视图不自己拼"关掉面板"的语义）', () => {
    const store = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(store).toContain("kind: 'move'")
    expect(store).toContain("current.kind === 'move'")
    expect(store).toContain('abortMoveNow()')
  })
})
