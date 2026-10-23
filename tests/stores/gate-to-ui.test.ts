import { createPinia, setActivePinia } from 'pinia'
import { stackFanLayout } from '@/render/stack-fan'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  mapHintOf,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useMapViewStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * B9：闸门接线到界面（不参与环节的算子点不动 / 灰显 / 就地一行提示 / 待办计数）
 *
 * 用户口径（2026-09-16 ④⑤）：「一切行动都在地图页展开单一会话框」「**不参与环节的算子无法点击**」；
 * 方案 §4.1.4：界面**只查表**——不可选者不高亮、点击无响应、只就地一行灰提示。
 *
 * 本文件钉四件事：
 *   ① **点不动**：摊开时非参与算子**不进默认选择集**；点它**不改选择集**且留一行带规则号的提示；
 *   ② **灰显**：`map-view` 的令牌带 `disabled`（只标本方，敌方不灰）；
 *   ③ **就地提示**：`mapHintOf` 纯函数的取舍（闸门拒绝优先于移动被拒）；
 *   ④ **待办计数**：`participatingUnitCount` 与"本环节允许的动作族"同源（换环节就变）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    workbench: useWorkbenchStore(),
    session: useGameSessionStore(),
    mapView: useMapViewStore(),
  }
}

/** 一枚轴方战斗单位（能移动、且**有印刷攻击值**——9.1b 的可攻击判据要求 > 0） */
const combatRecord = () =>
  unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) > 0 &&
      record.classes?.movementClass === 'leg',
  )!

/** 一枚轴方有轰炸值的火炮 */
const artilleryRecord = () =>
  unitChoices('axis').find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )!

const HEX = { col: 36, row: 13 }

describe('B9：不参与环节的算子点不动（就地展开层面）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  /** 把盘面推到 F 段的**炮击环节**（那里只有炮兵参与） */
  const setupCombatBarrageStep = () => {
    const { workbench, session } = stores
    workbench.units.push(
      toConsoleUnit({ record: artilleryRecord(), instanceId: 'gun', hex: HEX, side: 'axis' }),
      toConsoleUnit({ record: combatRecord(), instanceId: 'inf', hex: HEX, side: 'axis' }),
    )
    session.startGame()
    for (let i = 0; i < 40; i += 1) {
      session.advanceToNextStop()
      if (workbench.phase === 'combat') break
      if (session.awaiting) session.answerNow('first')
      if (session.terminated) break
    }
    expect(workbench.phase).toBe('combat')
    expect(workbench.segmentStep?.id).toBe('combat.barrage')
  }

  it('摊开堆叠时**不默认选中**（条 8 裁定①作废）：参与集合仅作取子候选', () => {
    const { mapView, workbench } = stores
    setupCombatBarrageStep()

    mapView.expandStackAt(HEX)

    // 条 8：展开**不预填**选择集——选中只在显式点选后发生（规则裁定变更，非断言放宽）
    expect(mapView.stackSelection).toEqual([])
    expect(workbench.participatingUnitIds).toEqual(['gun'])
    expect(mapView.expandedStack).toEqual({ hex: HEX, page: 0 })
  })

  it('点非参与的那一枚：**不改选择集**，且留一行带规则号的提示', () => {
    const { mapView, workbench } = stores
    setupCombatBarrageStep()
    mapView.expandStackAt(HEX)
    const before = [...mapView.stackSelection]
    const logBefore = workbench.log.length
    // `segmentStep` 在 workbench 上（map-view 只读它算出的参与集合）
    expect(workbench.segmentStep?.id).toBe('combat.barrage')
    // 条 8：展开即空选择集（选中只来自显式点选）
    expect(before).toEqual([])

    /*
     * 槽位下标与"该格可见算子的顺序"一一对应（`stackFanLayout` 的 `index` 就是下标）：
     * 本格摆的是 gun → inf，故 index 1 就是那枚**不参与**的步兵。
     */
    const fan = stackFanLayout({ hex: HEX, total: 2, page: 0 })
    const infSlot = fan.slots.find((slot) => slot.index === 1)
    expect(infSlot, '槽位下标 1 应对应第二枚算子').toBeDefined()
    const center = { x: infSlot!.x + infSlot!.size / 2, y: infSlot!.y + infSlot!.size / 2 }

    mapView.onHexClick(HEX, undefined, center)

    // ① 点不动：选择集保持原样（不是"点了没反应"，而是明确拒绝）
    expect(mapView.stackSelection).toEqual(before)
    // ② 且就地留了一行带规则号的提示（走操作台日志 ⇒ 侧栏反馈区与地图内提示都能取到）
    expect(workbench.log.length).toBeGreaterThan(logBefore)
    expect(workbench.log[0]?.kind).toBe('warning')
    expect(workbench.log[0]?.text).toContain('不参与本环节')
    expect(workbench.log[0]?.rule).toBeTruthy()
  })

  it('★ B26：不参与的那枚**不能加入，但已选中的可以剔除**（#22 的出口）', () => {
    const { mapView, workbench } = stores
    setupCombatBarrageStep()
    mapView.expandStackAt(HEX)
    // 条 8：展开即空选择集；取子候选仍＝参与集合（gun）
    expect(mapView.stackSelection).toEqual([])
    expect(workbench.movePick?.ids).toEqual(['gun'])

    /*
     * 场景：默认全选把不该参炸的也圈进来了（B26 之前的毛病）。
     * 这里直接构造"步兵已被圈进来"的状态，验证点它可以把它**剔掉** ——
     * 修前是"不参与 ⇒ 点不动 ⇒ 既选不中炮兵、也剔不掉步兵"。
     */
    mapView.stackSelection = ['gun', 'inf']
    workbench.setMovePickIds(['gun', 'inf'])
    const fan = stackFanLayout({ hex: HEX, total: 2, page: 0 })
    const infSlot = fan.slots.find((slot) => slot.index === 1)!
    mapView.onHexClick(HEX, undefined, {
      x: infSlot.x + infSlot.size / 2,
      y: infSlot.y + infSlot.size / 2,
    })

    // 剔除成功（不是"点了没反应"），且引擎那份取子集合同步
    expect(mapView.stackSelection).toEqual(['gun'])
    expect(workbench.movePick?.ids).toEqual(['gun'])
  })

  it('灰显：本方非参与算子带 `disabled`，敌方算子不灰（4.9a 已限制成只读）', () => {
    const { mapView, workbench } = stores
    setupCombatBarrageStep()
    // 放一枚苏军单位（敌方视角下的"我方"是被动方；viewerSide 跟随 activeSide=axis）
    workbench.units.push(
      toConsoleUnit({ record: combatRecord(), instanceId: 'enemy', hex: HEX, side: 'soviet' }),
    )

    const tokens = mapView.overlay.tokens
    const gun = tokens.find((token) => token.id === 'gun')
    const inf = tokens.find((token) => token.id === 'inf')
    const enemy = tokens.find((token) => token.id === 'enemy')
    expect(gun?.disabled).toBe(false)
    expect(inf?.disabled).toBe(true)
    expect(enemy?.disabled).toBe(false)
  })

  it('换环节即改口径：进了战斗环节，步兵也参与（待办计数跟着变）', () => {
    const { mapView, workbench } = stores
    setupCombatBarrageStep()
    // 炮击环节：参与的只有那门火炮（有印值轰炸值）
    expect(workbench.participatingUnitIds).toEqual(['gun'])

    expect(workbench.stepToNextSegmentStep()).toBe(true)
    expect(workbench.segmentStep?.id).toBe('combat.combat')
    /*
     * 战斗环节：参与集合**整个换了一批**——火炮没有印刷攻击值（attack=0）⇒ 不进攻击方（9.1b），
     * 而步兵可攻击且未动 ⇒ 参与。这一条正是"换环节即改口径"的实证。
     */
    expect(workbench.participatingUnitIds).toEqual(['inf'])

    mapView.expandStackAt(HEX)
    // 条 8：展开即空选择集（即使步兵在本环节参与，也不默认选中）
    expect(mapView.stackSelection).toEqual([])
  })
})

describe('B9：地图内就地提示（mapHintOf 纯函数）', () => {
  it('闸门拒绝优先于移动被拒（前者说明"此刻在哪一环才能做"）', () => {
    const hint = mapHintOf({
      refusal: { key: 'combat.declare', rule: '9.2', reason: '只能在「F 战斗 · 战斗环节」进行' },
      moveBlocked: { rule: '6.1', reason: '单位本轮已动过' },
    })
    expect(hint).toEqual({
      text: '本环节不能做这一步：只能在「F 战斗 · 战斗环节」进行',
      rule: '9.2',
      tone: 'warning',
    })
  })

  it('没有闸门拒绝时给"这一步被拒"（移动被拒），tone 为 danger', () => {
    const hint = mapHintOf({ moveBlocked: { rule: '4.5a-A', reason: '进入敌方 ZOC 必须停止' } })
    expect(hint).toEqual({
      text: '这一步被拒：进入敌方 ZOC 必须停止',
      rule: '4.5a-A',
      tone: 'danger',
    })
  })

  it('两者都没有 ⇒ 不显示任何东西（不占一行空提示）', () => {
    expect(mapHintOf({})).toBeNull()
    expect(mapHintOf({ refusal: null, moveBlocked: null })).toBeNull()
  })

  it('store 的 `mapHint` 与之一致（接线不失真）', () => {
    setActivePinia(createPinia())
    const workbench = useWorkbenchStore()
    expect(workbench.mapHint).toBeNull()
  })
})
