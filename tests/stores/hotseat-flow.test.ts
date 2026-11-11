import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useHotseatStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 切方与信息展示纪律的**端到端流程**（W7 C13，store 级）
 *
 * 三条链路逐条走通：
 *   ① **观察方**：只由 `setViewerSide` 手动切换，换手不遮屏、不自动翻（2026-11-11 口径）；
 *   ② **4.9a 展示纪律**：敌方格只见最上方（战斗模式可攻击）单位 + 最上方激活飞机，枚数不外露；
 *      4.8b 的堆叠顺序提示（ZOC 单位须置顶）；
 *   ③ **共识勾选列表（专规 4.0）**：未全部勾选 ⇒ 第一回合不开始；全部勾选 + 写入日志 ⇒ 才放行。
 *
 * 用真实单位库（不造数）；规则判据本身在 `tests/engine/fog.test.ts` 与 `tests/engine/session-flow.test.ts`。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    workbench: useWorkbenchStore(),
    hotseat: useHotseatStore(),
    session: useGameSessionStore(),
  }
}

/** 棋盘上两个相邻格（用于「相邻有敌方地面单位」的事实） */
const HEX_A: HexRef = { col: 34, row: 17 }
const HEX_B: HexRef = { col: 35, row: 17 }

/** 取一枚「其他」类型的多军力战斗单位（真实单位库） */
function combatRecord(side: 'axis' | 'soviet'): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(
    (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) >= 3,
  )
  if (found === undefined) throw new Error(`${side} 单位库里找不到战斗单位`)
  return found
}

/** 摆一枚算子 */
function place(
  workbench: ReturnType<typeof useWorkbenchStore>,
  side: 'axis' | 'soviet',
  hex: HexRef,
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record: combatRecord(side), instanceId, hex, side })
  workbench.units.push(unit)
  return unit
}

describe('W7 C13：4.9a 敌方堆叠明细隐藏（配合 4.8b 堆叠顺序）', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let hotseat: ReturnType<typeof useHotseatStore>

  beforeEach(() => {
    const stores = newStores()
    workbench = stores.workbench
    hotseat = stores.hotseat
  })

  it('C13：敌方格只给最上方一枚（其余隐藏，且不透露枚数）', () => {
    const top = place(workbench, 'axis', HEX_A, 'e-top')
    place(workbench, 'axis', HEX_A, 'e-1')
    place(workbench, 'axis', HEX_A, 'e-2')
    // 观察方 = 苏联（2026-11-11 起由玩家手动指定，不随行动方自动切）
    workbench.setActiveSide('soviet')
    hotseat.setViewerSide('soviet')
    expect(hotseat.viewerSide).toBe('soviet')

    const visible = hotseat.visibleUnitIdsInHex(HEX_A)
    expect(visible).toEqual([top.instanceId])
    expect(hotseat.hasHiddenContent(HEX_A)).toBe(true)

    const display = hotseat.displayOf(HEX_A)
    expect(display.mode).toBe('topOnly')
    if (display.mode !== 'topOnly') return
    expect(display.top?.id).toBe(top.instanceId)
    // 4.9a：枚数不公开（界面不得显示「＋2」）
    expect(display.stackSizeHidden).toBe(true)
    expect(display.denied.join('｜')).toContain('堆叠枚数')
  })

  it('C13：己方格全见（同一格换观察方即可见全部）', () => {
    place(workbench, 'axis', HEX_A, 'e-top')
    place(workbench, 'axis', HEX_A, 'e-1')
    workbench.setActiveSide('axis')
    const display = hotseat.displayOf(HEX_A)
    expect(display.mode).toBe('full')
    expect(hotseat.visibleUnitIdsInHex(HEX_A)).toHaveLength(2)
    expect(hotseat.hasHiddenContent(HEX_A)).toBe(false)
  })

  it('C13：4.9a 只见「战斗模式的可攻击单位」——DG 顶牌不算，ZOC 单位才是可见的那一枚', () => {
    const dgTop = place(workbench, 'axis', HEX_A, 'dg-top')
    dgTop.mode = { ...dgTop.mode, dg: true } // 5.10：DG 不是战斗模式
    const zocUnit = place(workbench, 'axis', HEX_A, 'zoc-unit')
    workbench.setActiveSide('soviet')
    hotseat.setViewerSide('soviet')

    const display = hotseat.displayOf(HEX_A)
    expect(display.mode).toBe('topOnly')
    if (display.mode !== 'topOnly') return
    expect(display.top?.id).toBe(zocUnit.instanceId)
    expect(display.topFlags.dg).toBe(false)
  })

  it('C13：4.8b C 提示 —— 有 ZOC 的单位不在最上方（只提示，不重排）', () => {
    const top = place(workbench, 'axis', HEX_A, 'top')
    // 顶牌断补 ⇒ 不投射 ZOC（4.5）；其下单位正常 ⇒ 应置顶
    top.hasTraceSupply = false
    place(workbench, 'axis', HEX_A, 'zoc-below')
    workbench.setActiveSide('axis')

    const issues = hotseat.stackOrderIssues
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]?.issue.rule).toBe(hotseat.STACK_ORDER_RULE)
    expect(issues[0]?.issue.detail).toContain('4.8b C')
    // 顺序未被引擎改动（仍是最初的摆放顺序）
    expect(workbench.units.map((unit) => unit.instanceId)).toEqual(['top', 'zoc-below'])
  })

  it('C13：4.8b D —— 相邻有敌方地面单位时，HQ 不得作为最上方的战斗单位', () => {
    const hq = place(workbench, 'axis', HEX_A, 'hq')
    hq.name = 'HQ 9th Army'
    hq.hasTraceSupply = false // 不投射 ZOC ⇒ 堆叠内无 ZOC 单位，才轮到 4.8b D 的分支
    const inf = place(workbench, 'axis', HEX_A, 'inf')
    inf.hasTraceSupply = false
    place(workbench, 'soviet', HEX_B, 'enemy-adjacent') // 相邻格有敌方地面单位
    workbench.setActiveSide('axis')

    const issues = hotseat.stackOrderIssues.filter((item) => item.hex.col === HEX_A.col)
    expect(issues.map((item) => item.issue.detail).join('｜')).toContain('4.8b D')
  })
})

describe('W7 C13（用户 2026-11-11 口径）：观察方由玩家手动选定，不自动切屏/切视角', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let hotseat: ReturnType<typeof useHotseatStore>

  beforeEach(() => {
    const stores = newStores()
    workbench = stores.workbench
    hotseat = stores.hotseat
    expect(hotseat.setMode('pvp')).toBe(true)
  })

  it('C13：观察方只在玩家点选时变；轮到对手行动不自动翻', () => {
    expect(hotseat.viewerSide).toBe('axis')

    hotseat.setViewerSide('soviet')
    expect(hotseat.viewerSide).toBe('soviet')
    expect(hotseat.opponentSide).toBe('axis')

    // 行动方翻面（如 T 键 / 直接切方）不再带动观察方
    workbench.switchSide()
    workbench.switchSide()
    expect(hotseat.viewerSide).toBe('soviet')
  })

  it('C13：切观察方会清空选中与交互态（与切方同纪律）', () => {
    const unit = place(workbench, 'axis', HEX_A, 'u1')
    workbench.setTool('move')
    workbench.clickHex(unit.hex)
    expect(workbench.selectedUnit?.instanceId).toBe('u1')
    hotseat.setViewerSide('soviet')
    expect(workbench.selectedUnit).toBeNull()
  })

  it('C13：hotseat store 不再导出交接判据（整条移除，不留开关）', () => {
    expect('handoffPending' in hotseat).toBe(false)
    expect('beginHandoff' in hotseat).toBe(false)
    expect('confirmHandoff' in hotseat).toBe(false)
    expect('cancelHandoff' in hotseat).toBe(false)
    expect('setHotseatEnabled' in hotseat).toBe(false)
  })
})

describe('W7 C13：共识勾选列表（专规 4.0：勾 = 采用该条，默认全部不勾）', () => {
  let session: ReturnType<typeof useGameSessionStore>

  beforeEach(() => {
    const stores = newStores()
    session = stores.session
  })

  it('C13：勾选列表来自数据，开局后默认全不勾；步进时自动补写结论再推进', () => {
    session.setScenarioId('1')
    expect(session.startGame()).toBe(true)
    expect(session.agreedChecklistRows.length).toBe(session.agreedOptionItems.length)
    // ★ 用户口径：默认全部不勾（都不用）
    expect(session.agreedChecklistRows.every((row) => row.checked)).toBe(false)
    expect(session.agreedCheckedCount).toBe(0)
    expect(session.agreedRecorded).toBe(false)

    // 不勾任何一项也照样开局：步进时按当前勾选（默认全不用）自动写入日志（4.0）
    expect(session.stepNow()).toBe(true)
    expect(session.agreedRecorded).toBe(true)
    expect(session.consensus.every((decision) => decision.adopted === false)).toBe(true)
  })

  it('C13：单项即采用（一个勾选框：勾 = 用这条）', () => {
    session.setScenarioId('1')
    session.startGame()
    session.setAgreedCheck(1, true)
    expect(session.agreedCheckedCount).toBe(1)
    expect(session.agreedChecklistRows[1]?.checked).toBe(true)
    expect(session.agreedChecklistRows[0]?.checked).toBe(false)
    expect(session.confirmAgreedChecklist()).toBe(true)
    expect(session.consensus[1]?.adopted).toBe(true)
    expect(session.consensus[0]?.adopted).toBe(false)
  })

  it('C13：全部勾选 + 写入日志 ⇒ 结论进日志；此后第一回合才开始', () => {
    session.setScenarioId('1')
    session.startGame()
    for (let index = 0; index < session.agreedOptionItems.length; index += 1) {
      session.setAgreedCheck(index, true)
    }
    expect(session.agreedCheckedCount).toBe(session.agreedOptionItems.length)

    expect(session.confirmAgreedChecklist()).toBe(true)
    expect(session.agreedRecorded).toBe(true)
    // 逐条结论都写进了日志（＝存档的一部份，4.0）
    const answers = session.log.filter((entry) => entry.action === 'answer')
    expect(answers).toHaveLength(session.agreedOptionItems.length)
    expect(session.consensus.every((decision) => decision.adopted === true)).toBe(true)

    // 现在可以推进第一回合了
    expect(session.stepNow()).toBe(true)
    expect(session.error).toBeNull()
  })

  it('C13：谈过但不用的条目也允许（存档回读的「勾了但不生效」仍可表示）', () => {
    session.setScenarioId('1')
    session.startGame()
    session.setAllAgreedChecks(true)
    // 第 2 条（秘密掷骰 4.9e）勾了但决定不用
    session.setAgreedAdopt(1, false)
    expect(session.agreedCheckedCount).toBe(session.agreedOptionItems.length)
    expect(session.confirmAgreedChecklist()).toBe(true)
    expect(session.consensus[0]?.adopted).toBe(true)
    expect(session.consensus[1]?.adopted).toBe(false)
    expect(session.agreedChecklistRows[1]?.adopted).toBe(false)
  })

  it('C13：换剧本 / 重开一局都会把勾选恢复为默认（本局预备动作）', () => {
    session.setScenarioId('1')
    session.startGame()
    session.setAgreedCheck(0, true)
    expect(session.agreedCheckedCount).toBe(1)

    // 已开局时换剧本会被拒（2.2：避免流程与剧本错配）⇒ 先重置
    expect(session.setScenarioId('3')).toBe(false)
    session.resetGame()
    // ★ 默认全不勾（用户口径）
    expect(session.agreedCheckedCount).toBe(0)
    expect(session.setScenarioId('3')).toBe(true)

    session.startGame()
    expect(session.agreedCheckedCount).toBe(0)
  })

  it('C13：共识结论驱动信息纪律（1.4 隐藏盒 / 4.9e 秘密掷骰）', () => {
    setActivePinia(createPinia())
    const workbench = useWorkbenchStore()
    const hotseat = useHotseatStore()
    const store = useGameSessionStore()
    store.setScenarioId('1')
    store.startGame()
    // 未写入日志 ⇒ 默认态（公开掷骰）
    expect(hotseat.policy.secretRolls).toBe(false)
    expect(hotseat.rollVisibleToViewer('axis')).toBe(true)

    store.setAllAgreedChecks(true)
    store.confirmAgreedChecklist()
    expect(hotseat.policy.secretRolls).toBe(true)
    // 4.9e：观察方为轴心国时，苏联的掷骰骰面对其不可见
    workbench.setActiveSide('axis')
    expect(hotseat.rollVisibleToViewer('soviet')).toBe(false)
    expect(hotseat.rollVisibleToViewer('axis')).toBe(true)
  })
})
