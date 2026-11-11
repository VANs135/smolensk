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
import { HEX_RADIUS_PX, hexCanvasPoint } from '@/render/map-layout'
import { hitStackFan, stackFanLayout } from '@/render/stack-fan'
import { aircraftChoices, toConsoleAirUnit } from '@/stores/workbench-model'

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

  it('点地图：把点击交给操作台；起了会话也照开堆叠窗（用户 2026-11-10）', () => {
    const { workbench, mapView } = stores
    const unit = toConsoleUnit({ record: legCombat(), instanceId: 'a1', hex: START, side: 'axis' })
    workbench.units.push(unit)

    mapView.onHexClick(START, { x: 120, y: 80 })

    // ★ 条 10（批 M）：点格只建立取子清单（movePick），**不自动开拔**；开拔交由「开始移动」按钮
    expect(workbench.movePick?.ids).toEqual(['a1'])
    expect(mapView.session?.kind).toBe('move')
    // 用户 2026-11-10：点格就该看到该格的堆叠窗（窗口不再承担"摊开地图"的职责）
    expect(mapView.popup?.hex).toEqual(START)
    expect(mapView.popup?.variant).toBe('content')
    // 点「开始移动」才真正开拔（这是裁定变更，非断言放宽）
    expect(workbench.confirmMovePick()).toBe(true)
    expect(workbench.moveInteraction).not.toBeNull()
    expect(workbench.moveInteraction!.unitIds).toEqual(['a1'])
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

  it('闲置态点**某一枚** ⇒ 只选这一枚（用户 2026-11-10：命落到具体算子，不是整格）', () => {
    const { workbench, mapView } = stores
    const ids = stackOf(3)

    mapView.onHexClick(START, { x: 40, y: 50 }, slotCenter(3, 0))

    // 整格不再全选：这一击只点名点到的那一枚
    expect(mapView.stackSelection).toEqual([ids[0]])
    expect(workbench.movePick?.ids).toEqual([ids[0]])
    // 常态摊开由渲染层负责 ⇒ 不需要"展开态"这个开关（页仍停在第 0 页）
    expect(mapView.expandedStack).toBeNull()
    // 摊开要真的传到渲染层：该格 3 枚都在覆盖层上，渲染层按扇面逐枚画
    expect(
      mapView.overlay.tokens.filter(
        (token) => token.hex.col === START.col && token.hex.row === START.row,
      ),
    ).toHaveLength(3)
  })

  it('点格内空白 ⇒ **整格全选 + 开堆叠窗口**（用户 2026-11-10：点格开窗，供成组选择）', () => {
    const { workbench, mapView } = stores
    const ids = stackOf(3)

    const layout = stackFanLayout({ hex: START, total: 3, page: 0 })
    const center = hexCanvasPoint(START)
    const blank = { x: center.x, y: center.y - HEX_RADIUS_PX * 0.82 }
    expect(hitStackFan({ layout, point: blank })).toBeNull()

    mapView.onHexClick(START, { x: 40, y: 50 }, blank)

    expect(mapView.stackSelection).toEqual(ids)
    expect(workbench.movePick?.ids).toEqual(ids)
    expect(mapView.expandedStack).toEqual({ hex: START, page: 0 })
    expect(mapView.popup?.hex).toEqual(START)
    expect(mapView.popup?.variant).toBe('content')
  })

  it('已选整格后点某一枚 ⇒ 只剔除那一枚（选择集与引擎取子同步）', () => {
    const { workbench, mapView } = stores
    const ids = stackOf(3)
    const center = hexCanvasPoint(START)
    mapView.onHexClick(START, { x: 40, y: 50 }, { x: center.x, y: center.y - HEX_RADIUS_PX * 0.82 })

    mapView.onHexClick(START, undefined, slotCenter(3, 1))

    expect(mapView.stackSelection).toEqual([ids[0], ids[2]])
    expect(workbench.movePick?.ids).toEqual([ids[0], ids[2]])
  })

  it('再点一次 ⇒ 恢复选择（切换是双向的，不需要别的页面）', () => {
    const { workbench, mapView } = stores
    const ids = stackOf(3)
    const center = hexCanvasPoint(START)
    mapView.onHexClick(START, { x: 40, y: 50 }, { x: center.x, y: center.y - HEX_RADIUS_PX * 0.82 })
    mapView.onHexClick(START, undefined, slotCenter(3, 1))
    mapView.onHexClick(START, undefined, slotCenter(3, 1))

    // 剔除后再点同一枚 ⇒ 恢复到默认全选（恢复的一枚追加在末尾，按集合比较）
    expect([...mapView.stackSelection].sort()).toEqual([...ids].sort())
    expect([...(workbench.movePick?.ids ?? [])].sort()).toEqual([...ids].sort())
  })

  it('超过 6 枚时点击角标翻页（常态摊开下直接可翻，不必先点格）', () => {
    const { mapView } = stores
    const ids = stackOf(7)
    const center = hexCanvasPoint(START)
    // 先在格内空白处点一下 ⇒ 整格全选（点某一枚只会单选那一枚）
    mapView.onHexClick(START, { x: 40, y: 50 }, { x: center.x, y: center.y - HEX_RADIUS_PX * 0.82 })
    expect(mapView.stackSelection).toEqual(ids)

    const badge = stackFanLayout({ hex: START, total: 7, page: 0 }).pageBadge!
    mapView.onHexClick(START, undefined, { x: badge.x, y: badge.y })

    expect(mapView.expandedStack?.page).toBe(1)
    // 翻页不改变选择集
    expect(mapView.stackSelection).toEqual(ids)
  })

  it('点另一格 ⇒ 页归零并改选新格（不会两格同时翻页）', () => {
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

    expect(mapView.expandedStack).toBeNull()
    expect(mapView.stackSelection).toEqual(['o1'])
  })

  it('默认全选：点格内空白选全部，点某一枚只剔除那一枚（用户 2026-11-10）', () => {
    const { mapView } = stores
    const ids = stackOf(4)
    const center = hexCanvasPoint(START)
    mapView.onHexClick(START, { x: 40, y: 50 }, { x: center.x, y: center.y - HEX_RADIUS_PX * 0.82 })

    // 默认全选
    expect(mapView.stackSelection).toEqual(ids)
    // 点第 3 枚 ⇒ 只剔除它，其余仍在
    mapView.onHexClick(START, undefined, slotCenter(4, 2))
    expect(mapView.stackSelection).toEqual([ids[0], ids[1], ids[3]])
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
    const center = hexCanvasPoint(START)
    // 点格内空白 ⇒ 整格全选（页停在第 0 页，`collapseStack` 视为"已收"）
    mapView.onHexClick(START, { x: 40, y: 50 }, { x: center.x, y: center.y - HEX_RADIUS_PX * 0.82 })
    expect(mapView.expandedStack).not.toBeNull()
    expect(mapView.collapseStack()).toBe(true)
    expect(mapView.expandedStack).toBeNull()
    expect(mapView.collapseStack()).toBe(false)
  })

  it('单枚格点这一枚 ⇒ 选中它（常态摊开不改变"点枚即选"的语义）', () => {
    const { workbench, mapView } = stores
    const [id] = stackOf(1)
    const center = hexCanvasPoint(START)
    mapView.onHexClick(START, { x: 40, y: 50 }, center)
    expect(mapView.stackSelection).toEqual([id])
    expect(workbench.movePick?.ids).toEqual([id])
    expect(mapView.expandedStack).toBeNull()
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

  it('① 点缺油堆叠 ⇒ 整格全选 + 移动准备窗，**不自动进加油**（用户 2026-11-10）', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    put(fuelUnitRecord(), 't1', START)
    put(fuelUnitRecord(), 't2', START)

    mapView.onHexClick(START, { x: 40, y: 50 }, { x: 0, y: 0 })

    // 整格全选发生（选择集建立、取子清单有货）
    expect(mapView.expandedStack).toEqual({ hex: START, page: 0 })
    expect(workbench.movePick?.ids.length).toBe(2)
    /*
     * ★ 口径更正：加油不是一个自动跳转的步骤，而是右键菜单里的一项。
     *   点格只开移动准备（6.1），不再因为"缺油"顶成燃料会话。
     */
    expect(mapView.session).toMatchObject({ kind: 'move', rule: '6.1' })
    expect(mapView.session?.kind).not.toBe('fuel')
    // ★ 用户 2026-11-10：窗口不再被"刚起了会话"压掉 —— 点格就该看到该格的堆叠窗
    expect(mapView.popup?.hex).toEqual(START)
    expect(mapView.popup?.variant).toBe('content')
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

  it('① 会话在跑时，**未被消费**的点击不再另开新窗（窗口仍停在这一格）', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    put(fuelUnitRecord(), 't1', START)
    mapView.onHexClick(START, { x: 40, y: 50 }, { x: 0, y: 0 })
    expect(mapView.session).toMatchObject({ kind: 'move' })
    const opened = mapView.popup
    expect(opened?.hex).toEqual(START)

    // 再点别处（不是补给站 / 落点 / 任务格那种"会话自己的地图点选"）⇒ 不另开新窗
    mapView.onHexClick({ col: 36, row: 11 }, { x: 300, y: 200 })
    expect(mapView.popup).toEqual(opened)
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

    // ★ 条 10（批 M）：点格建立取子清单并起移动会话；用户 2026-11-10：窗口照开（点格即开窗）
    expect(mapView.session?.kind).toBe('move')
    expect(mapView.popup?.hex).toEqual(START)
    expect(mapView.popup?.variant).toBe('content')
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

  it('★ 专规 1.4a：驻在图外空军盒的飞机**不画在地图上**（出盒后恢复）', () => {
    const { workbench, mapView, hotseat } = newStores()
    workbench.setPhase('movement')
    workbench.setActiveSide('soviet')
    hotseat.setViewerSide('soviet')
    workbench.setAirActive(true)
    const choice = workbench.airUnitChoices.find((item) => (item.rangeHexes ?? 0) >= 20)!
    expect(
      workbench.addAirUnit(choice.aircraftId, `${String(START.col)}.${String(START.row)}`),
    ).toBe(true)
    const plane = workbench.airUnits[0]!
    const airTokenIds = () =>
      mapView.overlay.tokens.filter((token) => token.air === true).map((token) => token.id)

    // 在图上：画在该格
    expect(airTokenIds()).toContain(plane.instanceId)

    // 进盒：图上不再有它（盒卡里列出，见 ContainersPanel）
    workbench.setAirInBoxMembership(plane.instanceId, true)
    expect(airTokenIds()).not.toContain(plane.instanceId)

    // 出盒：回到图上
    workbench.setAirInBoxMembership(plane.instanceId, false)
    expect(airTokenIds()).toContain(plane.instanceId)
  })

  it('4.9a：敌方格只画公开战斗算子和最上方图内激活飞机，点击不展开', () => {
    const { workbench, mapView, hotseat } = newStores()
    const aircraft = aircraftChoices('axis')[0]!
    const placePlane = (instanceId: string, airStatus: 'active' | 'inactive') =>
      workbench.airUnits.push(
        toConsoleAirUnit({ aircraft, instanceId, side: 'axis', hex: START, airStatus }),
      )
    workbench.units.push(
      toConsoleUnit({ record: legCombat(), instanceId: 'top', hex: START, side: 'axis' }),
      toConsoleUnit({ record: legCombat(), instanceId: 'concealed', hex: START, side: 'axis' }),
    )
    placePlane('off-map', 'active')
    placePlane('public-plane', 'active')
    placePlane('inactive-plane', 'inactive')
    placePlane('concealed-plane', 'active')
    workbench.setAirInBoxMembership('off-map', true)
    workbench.setActiveSide('soviet')
    hotseat.setViewerSide('soviet')

    expect(mapView.overlay.tokens.map(({ id }) => id)).toEqual(['top', 'public-plane'])
    expect(mapView.overlay.tokens.every(({ hiddenStack }) => hiddenStack)).toBe(true)
    mapView.onHexClick(START, { x: 120, y: 80 }, hexCanvasPoint(START), 0.8)
    expect(mapView.expandedStack).toBeNull()
    expect(mapView.popupContent?.airUnits).toEqual([])
  })
})
