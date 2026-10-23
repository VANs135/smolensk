import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { feedbackRowsOf, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * M9② 操作反馈区：引擎带规则号的解释要**到得了玩家眼前**
 *
 * 修前的缺口不是「文案不好」，而是**没有任何界面读这两处**：
 *   · `workbench.log`——引擎/接线层每次拒绝都 `pushLog(kind, text, rule)`，带规则编号；
 *   · `workbench.moveBlocked`——移动/开拔被拒的原因代码与规则号。
 * 于是「点非法格毫无反应、只能自己猜为什么不行」。本组钉住三件事：
 *   ① 纯函数 `feedbackRowsOf` 的取景与排序（被拒那步置顶 + 最近 N 条）；
 *   ② 点**非法格**真的会落 `moveBlocked` 且**带规则编号**；
 *   ③ 该 `moveBlocked` 与同规则号的日志条目都能被反馈区取到（＝玩家看得见）。
 */
const START: HexRef = { col: 36, row: 13 }

function newStore() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 取一个满足条件的单位库记录（找不到即测试失败，避免静默用错夹具） */
function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/** 可移动的徒步战斗单位（MA ≥ 4，够走到图上的邻格） */
const legCombat = () =>
  pickRecord(
    'axis',
    (record: ReturnType<typeof unitChoices>[number]) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
) {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

describe('M9②：操作反馈行的组装（纯函数）', () => {
  it('被拒的一步置顶、标 danger、带规则号；其余按日志顺序取最近 N 条', () => {
    const log = [
      { id: 'l3', kind: 'warning' as const, text: '第三', rule: '6.2' },
      { id: 'l2', kind: 'success' as const, text: '第二' },
      { id: 'l1', kind: 'info' as const, text: '第一', rule: '6.1' },
    ]
    const rows = feedbackRowsOf({
      log,
      moveBlocked: { rule: '6.2b', reason: 'allTerrain' },
      limit: 2,
    })
    expect(rows).toEqual([
      { id: 'move-blocked', tone: 'danger', text: '这一步被拒：allTerrain', rule: '6.2b' },
      { id: 'l3', tone: 'warning', text: '第三', rule: '6.2' },
      { id: 'l2', tone: 'success', text: '第二', rule: null },
    ])
  })

  it('没有被拒、也没有日志 ⇒ 空（界面据此显示「暂无反馈」）', () => {
    expect(feedbackRowsOf({ log: [] })).toEqual([])
    expect(feedbackRowsOf({ log: [], moveBlocked: null })).toEqual([])
  })

  it('缺省取 6 条（界面 LIMIT 与这里同源，不得各写一遍）', () => {
    const log = Array.from({ length: 10 }, (_, index) => ({
      id: `l${index}`,
      kind: 'info' as const,
      text: `${index}`,
    }))
    expect(feedbackRowsOf({ log })).toHaveLength(6)
    expect(feedbackRowsOf({ log })[0]!.id).toBe('l0')
  })
})

describe('M9②：点非法格真的会给出带规则编号的解释', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('移动阶段点一个**够不到**的格 ⇒ `moveBlocked` 带规则号 + 同号日志（反馈区可取到）', () => {
    const store = newStore()
    store.setPhase('movement')
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    // 起一次移动（选中的徒步战斗单位）
    store.clickHex(START)
    // 条 10（批 M）：点格只建取子清单，开拔交由「开始移动」按钮
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction, '应当已进入移动交互').not.toBeNull()

    // 一个远处的非法格（够不到）：先清空两条来源，确认是**这一次点击**落下的
    store.setHoverHex(null)
    const far: HexRef = { col: START.col + 12, row: START.row + 6 }
    store.clickHex(far)

    expect(store.moveBlocked).not.toBeNull()
    expect(store.moveBlocked!.rule.length).toBeGreaterThan(0)
    expect(store.moveBlocked!.reason.length).toBeGreaterThan(0)

    // 反馈区取到的第一行就是这次被拒（带同一个规则号）
    const rows = feedbackRowsOf({ log: store.log, moveBlocked: store.moveBlocked })
    expect(rows[0]).toMatchObject({ tone: 'danger', rule: store.moveBlocked!.rule })
    // 日志里也有一条**同规则号**的说明（双向可查）
    expect(store.log.some((entry) => entry.rule === store.moveBlocked!.rule)).toBe(true)
    // 该单位仍在原格（被拒＝不动盘面）
    expect(unit.hex).toEqual(START)
  })

  /*
   * ★ 批 A 切片 2（2026-09-18）：段别改成 **A 整备段** —— F 段的战斗环节现在由**环节**分派，
   *   点己方算子＝加入攻方（9.1b），不再走"移动被拒"。判据与话术（2.2「没有移动环节」）本身没变。
   */
  it('在没有移动环节的阶段点己方算子 ⇒ 解释是 2.2（段别不对），同样带规则号', () => {
    const store = newStore()
    store.setPhase('aircraftRefit') // 2.2：A 整备段没有移动环节
    place(store, legCombat(), START, 'axis', 'a1')
    // 条 10（批 M）：点格建取子清单；确认开拔才被 2.2 拦下
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(false)

    expect(store.moveBlocked?.rule).toBe('2.2')
    expect(store.moveBlocked?.reason).toContain('没有移动环节')
    const rows = feedbackRowsOf({ log: store.log, moveBlocked: store.moveBlocked })
    expect(rows[0]).toMatchObject({ tone: 'danger', rule: '2.2' })
    expect(store.log.some((entry) => entry.rule === '2.2')).toBe(true)
  })

  it('走出一步之后不再显示旧的被拒原因（`moveBlocked` 清零）', () => {
    const store = newStore()
    store.setPhase('movement')
    place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    store.clickHex({ col: START.col + 12, row: START.row + 6 })
    expect(store.moveBlocked).not.toBeNull()

    // 走一格合法步（6.1：每格重算范围）⇒ 被拒状态收束
    const legal = store.groupReachable.hexes.find((node) => node.mpSpent > 0)
    expect(legal, '该单位应当有可到达的邻格').toBeDefined()
    store.clickHex(legal!.hex)
    expect(store.moveBlocked).toBeNull()
    expect(feedbackRowsOf({ log: store.log, moveBlocked: store.moveBlocked })[0]?.tone).not.toBe(
      'danger',
    )
  })
})
