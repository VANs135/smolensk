import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useHotseatStore,
  useMapViewStore,
  useWorkbenchStore,
} from '@/stores'
import { hexCanvasPoint } from '@/render/map-layout'
import { hitStackFan, stackFanLayout } from '@/render/stack-fan'

/**
 * 地图视图编排（W7 C16）的 store 级测试
 *
 * 三件事：
 *   ① **点什么**：`onHexClick` 打开就近小窗、并把点击委托给操作台（无特殊流程时）；
 *   ② **画什么**：无战斗流程时撤退落点 / 推进格 / 补给站一律为空（不给玩家误导性高亮）；
 *   ③ **小窗内容**：按 4.9a 的可见性列出该格算子。
 */

const START = { col: 36, row: 13 }

const newStores = () => {
  setActivePinia(createPinia())
  return {
    workbench: useWorkbenchStore(),
    hotseat: useHotseatStore(),
    mapView: useMapViewStore(),
  }
}

const legCombat = () =>
  unitChoices('axis').find(
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )!

describe('W7 C16：地图视图编排（点什么 / 画什么 / 小窗内容）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('点地图：把点击交给操作台；起了会话就不再开小窗（B26：一次点击只出一个 UI）', () => {
    const { workbench, mapView } = stores
    const unit = toConsoleUnit({ record: legCombat(), instanceId: 'a1', hex: START, side: 'axis' })
    workbench.units.push(unit)

    mapView.onHexClick(START, { x: 120, y: 80 })

    // ★ 条 10（批 M）：点格只建立取子清单（movePick），**不自动开拔**；开拔交由「开始移动」按钮
    expect(workbench.movePick?.ids).toEqual(['a1'])
    expect(mapView.session?.kind).toBe('move')
    expect(mapView.popup).toBeNull()
    // 点「开始移动」才真正开拔（这是裁定变更，非断言放宽）
    expect(workbench.confirmMovePick()).toBe(true)
    expect(workbench.moveInteraction).not.toBeNull()
    expect(workbench.moveInteraction!.unitIds).toEqual(['a1'])
    // ★ B26（用户报告 #17「点一格同时出现格子内容与移动结算两个框」）：
    //   这一击产生了移动会话 ⇒ **不再另开小窗**（修前会同时出现两个框）
  })

  it('★ B26：本击**没有**产生会话时小窗照旧打开（闸门只拦"刚起了会话"的那一击）', () => {
    const { workbench, mapView } = stores
    // 空格子：点它不会起任何会话
    mapView.onHexClick(START, { x: 120, y: 80 })
    expect(mapView.session).toBeNull()
    // ★ 条 25（批 U）：这一格是**空格** ⇒ 开的是**只读格号浮签**（变体 label），不是常规小窗
    expect(mapView.popup).toEqual({ hex: START, x: 120, y: 80, variant: 'label' })
    void workbench
  })

  it('小窗内容：列出该格可见算子（己方格全列，4.9a）', () => {
    const { workbench, mapView } = stores
    workbench.units.push(
      toConsoleUnit({ record: legCombat(), instanceId: 'a1', hex: START, side: 'axis' }),
    )
    // 先手动开小窗（点己方单枚会起会话 ⇒ 按 B26 不再自动开小窗，故这里直接开）
    mapView.openPopup(START, 10, 10)
    const content = mapView.popupContent
    expect(content).not.toBeNull()
    expect(content!.hex).toEqual(START)
    expect(content!.units.map((token) => token.id)).toEqual(['a1'])
    // 无飞机时飞机列表为空
    expect(content!.airUnits).toEqual([])
    mapView.closePopup()
    expect(mapView.popupContent).toBeNull()
  })

  it('画什么：没有战斗流程时，撤退落点 / 推进格 / 付款补给站一律为空', () => {
    const { mapView } = stores
    expect(mapView.overlay.retreat ?? null).toBeNull()
    expect(mapView.overlay.advance ?? []).toEqual([])
    expect(mapView.overlay.payDumps ?? []).toEqual([])
    expect(mapView.combatSourceDumps).toEqual([])
  })

  it('撤退提示：没有撤退流程时不显示（不给玩家误导性提示）', () => {
    const { mapView } = stores
    expect(mapView.retreatSidePlan).toBeNull()
    expect(mapView.retreatHint).toBe('')
  })

  it('9.14c：位移落点铺在地图上（候选＝并集），点候选格即选定该落点', () => {
    const { workbench, mapView } = stores
    // 苏军 3 枚卡车运输点 + 一个德军可攻击单位进入该格（9.14 的触发前提）
    const trucks = unitChoices('soviet')
      .filter(
        (record) =>
          record.noncombatKind === 'transport_point' &&
          (record.noncombatDetails?.transportKind ?? '') === 'truck',
      )
      .slice(0, 3)
    trucks.forEach((record, index) =>
      workbench.units.push(
        toConsoleUnit({ record, instanceId: `tp${index}`, hex: START, side: 'soviet' }),
      ),
    )
    workbench.units.push(
      toConsoleUnit({ record: legCombat(), instanceId: 'a1', hex: START, side: 'axis' }),
    )

    expect(workbench.resolveSpecialCombatAt(START, 'axis')).toBe(true)
    const pending = workbench.specialPending
    // 「卡车」列在 DEFAULT_SEED 下掷 5（50%）⇒ 部分夺取、部分位移 ⇒ 必有待决
    expect(pending).not.toBeNull()
    if (pending === null || pending.items.length === 0) return

    // 画什么：候选格与已选格都在覆盖层上
    expect(mapView.overlay.specialDisplace?.candidates.length).toBeGreaterThan(0)
    expect(mapView.specialHint).toContain('9.14')

    // 点什么：点一个候选格 ⇒ 该项落点被选定（不再落到普通移动/选算子分支）
    const item = mapView.specialItem!
    const target = item.candidates[0]!
    mapView.onHexClick(target, { x: 5, y: 6 })
    const after = workbench.specialPending?.items.find((entry) => entry.unitId === item.unitId)
    expect(after?.chosen).toEqual(target)
    expect(workbench.moveInteraction).toBeNull()

    // 小窗开在被点的格上（便于就地确认）
    expect(mapView.popup?.hex).toEqual(target)
  })
})

/**
 * B3：就地展开堆叠（用户 2026-09-16 #1）
 *
 * 用户口径：「点击堆叠后的拾取**不是指把单位捡起来**，而是在地图上的格子里展开堆叠……
 * 此时默认是全选堆叠，被选择单位可以高亮边框，玩家再点击高亮边框单位可以取消选择，
 * **而不需要在别的页面点击取消**」。
 *
 * 这里验的是"一击只做一件事"和"地图上的圈＝真正会动的人"这两条：
 *   ① 闲置态点堆叠 ⇒ 摊开 + 默认全选，**不开小窗**；
 *   ② 圈与引擎那份取子集合（6.1f）**同步**——点掉一枚，它真的不会被带走；
 *   ③ 点空白收起但**保留选择集**；Esc 走同一路；
 *   ④ 有交互在进行时**不抢**点击（移动中、战斗中…点击另有含义）。
 */
describe('B3：地图上就地展开堆叠（点格展开 / 点枚切换 / 收起）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  /** 在 START 摆 n 枚己方（axis）地面算子，返回它们的实例 id */
  const stackOf = (n: number): string[] => {
    const ids = Array.from({ length: n }, (_, index) => `s${index}`)
    ids.forEach((instanceId, index) => {
      stores.workbench.units.push(
        toConsoleUnit({ record: legCombat(), instanceId, hex: START, side: 'axis' }),
      )
      void index
    })
    return ids
  }

  /** 展开态的槽位中心（世界坐标）＝玩家真正点到的那一点 */
  const slotCenter = (total: number, index: number, page = 0) => {
    const layout = stackFanLayout({ hex: START, total, page })
    const slot = layout.slots.find((item) => item.index === index)!
    return { x: slot.x + slot.size / 2, y: slot.y + slot.size / 2 }
  }

  it('闲置态点堆叠 ⇒ 就地摊开、**不默认选中**（条 8 裁定①作废）、取子清单为可参与候选', () => {
    const { workbench, mapView } = stores
    const ids = stackOf(3)

    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(3, 0))

    expect(mapView.expandedStack).toEqual({ hex: START, page: 0 })
    // 条 8 裁定：展开时**不预填**选择集——选中只发生在显式点选后（这是规则裁定变更，非断言放宽）
    expect(mapView.stackSelection).toEqual([])
    // 摊开要真的传到渲染层（否则状态对了、玩家眼前什么都没有）
    expect(mapView.overlay.expandedStack).toEqual({ hex: START, page: 0 })
    // 6.1f 取子清单＝该格的**可参与候选**（参与集合）；可见选中态（金边）仍是空
    expect(workbench.movePick?.ids).toEqual(ids)
    // ★ 条 10（批 M）＋ 批 A 切片 3①：摊开即起**移动会话**（统一操作条取代小窗，单一对话框），
    //   故小窗不再同屏打开（修前摊开无条件开小窗 ⇒ 与移动会话两框同屏）
    expect(mapView.session?.kind).toBe('move')
    expect(mapView.popup).toBeNull()
  })

  it('点某一枚 ⇒ 选中它（条 8：选中只来自显式点选），且引擎取子集合同步', () => {
    const { workbench, mapView } = stores
    const ids = stackOf(3)
    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(3, 0))

    // 点"第 2 枚"（槽位下标 1）⇒ 把它加进选择集
    mapView.onHexClick(START, undefined, slotCenter(3, 1))

    expect(mapView.stackSelection).toEqual([ids[1]])
    expect(workbench.movePick?.ids).toEqual([ids[1]])
    // 点在格内 ⇒ 展开态还开着
    expect(mapView.expandedStack).not.toBeNull()
  })

  it('再点一次 ⇒ 取消选择（切换是双向的，不需要别的页面）', () => {
    const { workbench, mapView } = stores
    stackOf(3)
    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(3, 0))
    mapView.onHexClick(START, undefined, slotCenter(3, 1))
    mapView.onHexClick(START, undefined, slotCenter(3, 1))

    // 点选一枚 ⇒ 选中；再点同一枚 ⇒ 取消（选择集回到空）
    expect(mapView.stackSelection).toEqual([])
    expect(workbench.movePick?.ids).toEqual([])
  })

  it('点格内空白 ⇒ 收起，但选择集保留（玩家下次进来还是上次勾的那些）', () => {
    const { mapView } = stores
    const ids = stackOf(3)
    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(3, 0))
    mapView.onHexClick(START, undefined, slotCenter(3, 1))
    const kept = [...mapView.stackSelection]

    // 格中心偏下的空白：既不在任何槽位矩形里，也不在分页角标上（3 枚无角标）
    const layout = stackFanLayout({ hex: START, total: 3, page: 0 })
    const blank = { x: hexCanvasPoint(START).x, y: hexCanvasPoint(START).y }
    expect(hitStackFan({ layout, point: blank })).toBeNull()

    mapView.onHexClick(START, undefined, blank)

    expect(mapView.expandedStack).toBeNull()
    expect(mapView.stackSelection).toEqual(kept)
    // 条 8 下：先点一枚 ⇒ 选择集只有那一枚，收起后保留
    expect(kept).toEqual([ids[1]])
  })

  it('拖过 4 枚 ⇒ 分页角标翻页（点角标不是点格）', () => {
    const { mapView } = stores
    stackOf(5)
    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(5, 0))
    expect(mapView.expandedStack?.page).toBe(0)

    const badge = stackFanLayout({ hex: START, total: 5, page: 0 }).pageBadge!
    mapView.onHexClick(START, undefined, { x: badge.x, y: badge.y })

    expect(mapView.expandedStack?.page).toBe(1)
    // 翻页不改变选择集（条 8 下展开即空选择集）
    expect(mapView.stackSelection).toEqual([])
  })

  it('已摊开时点另一格 ⇒ 摊开新格（旧格自然收起，不会两格同时摊开）', () => {
    const { mapView } = stores
    stackOf(2)
    const other = { col: START.col + 1, row: START.row }
    stores.workbench.units.push(
      toConsoleUnit({ record: legCombat(), instanceId: 'o1', hex: other, side: 'axis' }),
      toConsoleUnit({ record: legCombat(), instanceId: 'o2', hex: other, side: 'axis' }),
    )
    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(2, 0))
    const firstLayout = stackFanLayout({ hex: other, total: 2, page: 0 })
    const firstSlot = firstLayout.slots[0]!
    mapView.onHexClick(
      other,
      { x: 40, y: 50 },
      {
        x: firstSlot.x + firstSlot.size / 2,
        y: firstSlot.y + firstSlot.size / 2,
      },
    )

    expect(mapView.expandedStack?.hex).toEqual(other)
    // 条 8：新摊开的格**不默认选中**
    expect(mapView.stackSelection).toEqual([])
  })

  it('条 8 裁定①：展开堆叠不产生任何默认选中（规则裁定变更，非断言放宽）', () => {
    const { mapView } = stores
    const ids = stackOf(4)
    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(4, 0))

    // 验收"堆叠无默认选"：摊开后选择集为空，须显式点选才进选择集
    expect(mapView.stackSelection).toEqual([])
    // 分页 >4 仍正常工作，且默认选择集仍为空的约束不被分页破坏
    expect(mapView.overlay.expandedStack).not.toBeNull()
    // 显式点选一枚 ⇒ 仅该枚被选中（其余仍不在选择集）
    mapView.onHexClick(START, undefined, slotCenter(4, 2))
    expect(mapView.stackSelection).toEqual([ids[2]])
  })

  it('有交互在进行时点堆叠**不摊开**（同一击不既走移动又摊开）', () => {
    const { workbench, mapView } = stores
    // 先点一枚单独的算子 ⇒ 进入移动交互
    workbench.units.push(
      toConsoleUnit({
        record: legCombat(),
        instanceId: 'solo',
        hex: { col: 36, row: 12 },
        side: 'axis',
      }),
    )
    mapView.onHexClick({ col: 36, row: 12 }, { x: 10, y: 10 })
    // 条 10：点格只建取子清单，开拔交由「开始移动」按钮
    expect(workbench.confirmMovePick()).toBe(true)
    expect(workbench.moveInteraction).not.toBeNull()

    stackOf(3)
    // 反空转守卫：该格**确实**有 3 枚可见算子（否则"没摊开"可能只是因为没东西可摊）
    expect(
      mapView.overlay.tokens.filter((token) => token.hex.col === 36 && token.hex.row === 13),
    ).toHaveLength(3)

    // 移动进行中点到一个堆叠格 ⇒ 归既有分派（走这一格），不摊开
    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(3, 0))

    expect(mapView.expandedStack).toBeNull()
    // 这一击由移动交互消化（仍在移动中，而不是被展开态吃掉）
    expect(workbench.moveInteraction).not.toBeNull()
  })

  it('Esc 收起：`collapseStack` 是真假信号（没收的也返回 false，不吞按键）', () => {
    const { mapView } = stores
    stackOf(2)
    expect(mapView.collapseStack()).toBe(false)
    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(2, 0))
    expect(mapView.expandedStack).not.toBeNull()
    expect(mapView.collapseStack()).toBe(true)
    expect(mapView.expandedStack).toBeNull()
    expect(mapView.collapseStack()).toBe(false)
  })

  it('单枚格不摊开（没有可分辨的东西，也不必多一次点击）', () => {
    const { workbench, mapView } = stores
    stackOf(1)
    mapView.onHexClick(START, { x: 40, y: 50 }, { x: 0, y: 0 })
    expect(mapView.expandedStack).toBeNull()
    void workbench
  })
})

/**
 * 批 A 切片 3①②（用户口径 9.17⑤ / 9.16 #3 后半、#17）
 *
 * ① **单一对话框**：会话非空 ⇒ 把「格子内容」小窗收掉、且这一击不再开它。
 * ② **候选按环节过滤**：小窗只列**本环节能行动**的己方算子（敌方算子是 4.9a 的目标，照列）；
 *    被滤掉的给一行含规则号的交代。
 *
 * ## 测法边界（如实交代）
 *   · 这里的"能行动"来自 `participatingUnitIds`（B7 的 `participatesIn`）⇒ 本文件只验**过滤的机制**
 *     （可行动/不可行动的分野、敌方不受影响）；**9.1c 那一条**（已攻击过的单位被滤掉）在
 *     `attack-once-ledger-flow.test.ts` 里按 `participatesIn` 与账本断言；
 *   · **不覆盖**组件层渲染（本仓库不挂组件渲染测试 ⇒ "框里真没画出来"靠源码与这层投影断言）。
 */
describe('批 A 切片 3：单一对话框与候选过滤', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  /** 轴心国**需要燃料**的战斗单位（轮式/履带；12.5a） */
  const fuelUnitRecord = () =>
    unitChoices('axis').find(
      (record) =>
        record.isCombat === true &&
        (record.classes?.movementClass === 'truck' ||
          record.classes?.movementClass === 'tracked') &&
        (record.factors?.combat?.ma ?? 0) >= 1,
    )!

  /** 轴心国敌方（苏军）战斗单位：小窗里作为 4.9a 的**目标**出现 */
  const enemyRecord = () => unitChoices('soviet').find((record) => record.isCombat === true)!

  const put = (record: ReturnType<typeof unitChoices>[number], instanceId: string, hex: HexRef) => {
    const unit = toConsoleUnit({ record, instanceId, hex, side: 'axis' })
    stores.workbench.units.push(unit)
    return unit
  }

  it('① 摊开"缺油"堆叠 ⇒ 会话起来了，**小窗不再同屏打开**', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    put(fuelUnitRecord(), 't1', START)
    put(fuelUnitRecord(), 't2', START)

    mapView.onHexClick(START, { x: 40, y: 50 }, { x: 0, y: 0 })

    // 摊开发生了（选择集建立、取子清单有货）
    expect(mapView.expandedStack).toEqual({ hex: START, page: 0 })
    expect(workbench.movePick?.ids.length).toBe(2)
    // 摊开建立取子清单 ⇒ 两枚都缺油 ⇒ 当场长出「移动 / 燃料（12.5c）」会话
    expect(mapView.session).toMatchObject({ kind: 'move', rule: '12.5c' })
    // ★ 结构保证（修前摊开无条件 `openPopup` ⇒ 两框同屏）
    expect(mapView.popup).toBeNull()
  })

  it('① 小窗开着时会话**从别的路径**起来 ⇒ 小窗被收掉', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    // 先点空格子开格号浮签（此时没有任何会话；条 25 ⇒ 变体 label）
    mapView.onHexClick(START, { x: 120, y: 80 })
    expect(mapView.session).toBeNull()
    expect(mapView.popup).toEqual({ hex: START, x: 120, y: 80, variant: 'label' })

    // 另一格选中一辆未加注的坦克 ⇒ 燃料会话出现（走的不是"点地图开窗"那条路）
    const other = { col: 36, row: 12 }
    put(fuelUnitRecord(), 't1', other)
    workbench.clickHex(other)

    expect(mapView.session).not.toBeNull()
    expect(mapView.popup).toBeNull()
  })

  it('① 会话在跑时，**未被消费**的点击不再开小窗（动作控件都在会话面板里）', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    put(fuelUnitRecord(), 't1', START)
    mapView.onHexClick(START, { x: 40, y: 50 }, { x: 0, y: 0 })
    expect(mapView.session).toMatchObject({ kind: 'move' })

    // 再点别处（不是补给站 / 落点 / 任务格那种"会话自己的地图点选"）⇒ 不开小窗
    mapView.onHexClick({ col: 36, row: 11 }, { x: 300, y: 200 })
    expect(mapView.popup).toBeNull()
  })

  it('② 候选按环节过滤：本环节不能行动的单位被排除在取子清单之外（移动会话取代小窗后，过滤落在 movePick）', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    // 换到移动段的「模式与移动」环节（6.1：本轮已移动的单位不参与本环节）
    const allowed = actionGateOf('move.order')
      .where.filter((item) => item.phase === workbench.phase)
      .map((item) => item.segment)
    const index = workbench.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
    expect(workbench.setSegmentStepIndex(index)).toBe(true)

    put(legCombat(), 'm1', START)
    const ended = put(legCombat(), 'm2', START)
    // 该单位本轮移动已结束 ⇒ 6.1 判它不参与本环节
    workbench.units.find((unit) => unit.instanceId === 'm2')!.movementEnded = true
    void ended
    // 敌方算子（4.9a 的目标）：它本来就不"参与"本环节，但必须照列
    const enemy = toConsoleUnit({
      record: enemyRecord(),
      instanceId: 'e1',
      hex: START,
      side: 'soviet',
    })
    workbench.units.push(enemy)

    mapView.onHexClick(START, { x: 40, y: 50 }, { x: 0, y: 0 })

    // ★ 条 10（批 M）＋ 批 A 切片 3①：摊开即起**移动会话**（统一操作条取代小窗，单一对话框）⇒ 小窗被收掉
    expect(mapView.session?.kind).toBe('move')
    expect(mapView.popup).toBeNull()
    // 6.1：本轮移动已结束的 m2 不参与本环节 ⇒ 被排除在取子清单之外（候选过滤现落在 movePick；非断言放宽）
    expect(workbench.movePick?.ids).toEqual(['m1'])
    // 该格确有 e1 / m1 / m2 三枚（4.9a「这一格有什么」事实层不变；过滤只发生在候选那一层）
    expect(
      workbench.units
        .filter((unit) => unit.hex.col === START.col && unit.hex.row === START.row)
        .map((unit) => unit.instanceId)
        .sort(),
    ).toEqual(['e1', 'm1', 'm2'])
  })
})
