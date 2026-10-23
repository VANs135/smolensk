import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import { allVictoryConditionHexes } from '@/engine/rules'
import { toConsoleUnit, unitChoices, useGameSessionStore, useWorkbenchStore } from '@/stores'

/**
 * ⑬ + ⑭ 接线：**操作台各机制 → 会话日志**
 *
 * 目的：让 D2（`SettlementLogPanel` 的检索与固定种子重放）覆盖操作台的结算，
 * 而不是只覆盖会话流程条自己那几笔（天气/先手/段推进）。
 *
 * 三条硬约束（本次接线的全部要点）：
 *   ① **入账**：操作台的结算写进 `session.log`（与会话条目同构：turn/phase/side/action/rolls/outcome）；
 *   ② **同一颗骰源**：有会话时操作台的掷骰推进 `session.state.rng` ⇒ 重放能逐条重掷并比对骰面；
 *   ③ **单向耦合**：只有操作台 → 会话（会话 store 不反向引操作台，避免两个 store 互相 import）。
 *
 * 「未开局」时操作台必须照旧独立可玩（不因缺会话而报错或丢骰）。
 */

function newStores() {
  setActivePinia(createPinia())
  return { session: useGameSessionStore(), workbench: useWorkbenchStore() }
}

type Stores = ReturnType<typeof newStores>

/** 摆一个可攻击的地面单位（用于 5.0c 控制账本） */
function placeAttacker(store: Stores, hex: HexRef, side: Side, instanceId: string): void {
  const record = unitChoices(side).find((item) => item.attackCapable === true)
  if (record === undefined) throw new Error(`单位库中没有 ${side} 的可攻击记录`)
  store.workbench.units.push(toConsoleUnit({ record, instanceId, hex, side }))
}

describe('⑭ 接线：操作台结算写进会话日志', () => {
  it('未开局时不入账，也不报错（操作台独立可玩）', () => {
    const stores = newStores()
    expect(stores.session.session).toBeNull()
    expect(() => stores.workbench.rollDice()).not.toThrow()
    expect(stores.session.log).toEqual([])
  })

  it('开局后：通用掷骰以 manualRoll 入账，且骰面取自同一颗会话骰源', () => {
    const stores = newStores()
    expect(stores.session.startGame(20260913)).toBe(true)
    const before = stores.session.session?.state.rng.drawCount ?? 0

    stores.workbench.rollDice()
    stores.workbench.rollDice()

    const entries = stores.session.log.filter((entry) => entry.action === 'manualRoll')
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.rolls).toHaveLength(1)
      expect(entry.rolls[0]?.count).toBe(2)
      expect(entry.rolls[0]?.faces).toHaveLength(2)
    }
    // ⑭ 唯一骰源：两次 2d6 ⇒ 会话 RNG 游标推进 4 枚骰
    expect(stores.session.session?.state.rng.drawCount).toBe(before + 4)
  })

  it('D2 检索：按 action / rule 能查到操作台的结算', () => {
    const stores = newStores()
    stores.session.startGame(20260913)
    stores.workbench.rollDice()

    stores.session.setLogQuery({ action: 'manualRoll' })
    expect(stores.session.logEntries).toHaveLength(1)
    expect(stores.session.logEntries[0]?.action).toBe('manualRoll')

    stores.session.setLogQuery({ rule: '9.8' })
    expect(stores.session.logEntries.length).toBeGreaterThanOrEqual(1)

    stores.session.setLogQuery({ action: 'notExist' })
    expect(stores.session.logEntries).toHaveLength(0)
    stores.session.clearLogQuery()
    expect(stores.session.logFiltered).toBe(false)
  })

  it('D2 重放：操作台的骰子入账后，固定种子重放复算无分歧', () => {
    const stores = newStores()
    stores.session.startGame(20260913)
    stores.workbench.rollDice()
    stores.workbench.rollDice()

    const report = stores.session.replayReport
    expect(report).not.toBeNull()
    // 骰子真的走了会话 RNG、且逐条记了骰面 ⇒ 重放能复算出同一终态
    expect(report?.firstDivergence).toBeNull()
    expect(report?.stateMatches).toBe(true)
    expect(report?.ok).toBe(true)
  })

  it('未入账的骰子会让重放报分歧（反向验证「掷了必记」是必要的）', () => {
    const stores = newStores()
    stores.session.startGame(20260913)
    // 直接写会话 RNG（绕过操作台的掷骰通道）⇒ 消耗了一枚骰子却没有日志条目
    const rng = stores.session.session?.state.rng
    if (rng === undefined) throw new Error('应有会话')
    stores.session.setSessionRng({ ...rng, state: rng.state + 1, drawCount: rng.drawCount + 1 })

    const report = stores.session.replayReport
    expect(report?.ok).toBe(false)
    expect(report?.stateMatches).toBe(false)
  })
})

describe('⑬ 接线：5.0c 控制事实与判定结论推给会话', () => {
  it('刷新控制账本 ⇒ Records.victoryLocations 落值（不再是空档）', () => {
    const stores = newStores()
    stores.session.startGame(20260913)
    expect(stores.session.records?.victoryLocations).toEqual([])

    const hex = allVictoryConditionHexes()[0]
    if (hex === undefined) throw new Error('本剧本应有胜利条件格')
    placeAttacker(stores, hex, 'axis', 'ax-1')
    stores.workbench.refreshVictoryControlNow()

    const locations = stores.session.records?.victoryLocations ?? []
    const hit = locations.find((item) => item.hex.col === hex.col && item.hex.row === hex.row)
    expect(hit).toMatchObject({ controlledBy: 'axis' })
    // `listed` 标记该格是否属 5.0a 的「所列格」名单
    expect(typeof hit?.listed).toBe('boolean')
  })

  it('判定结论一并推送（5.0b 提前决胜 / 5.0a 最终评估）', () => {
    const stores = newStores()
    stores.session.startGame(20260913)
    expect(stores.session.pushedVerdicts.decisive).toBeNull()

    const hex = allVictoryConditionHexes()[0]
    if (hex === undefined) throw new Error('本剧本应有胜利条件格')
    placeAttacker(stores, hex, 'axis', 'ax-1')
    stores.workbench.refreshVictoryControlNow()

    expect(stores.session.pushedVerdicts.decisive?.rule).toBe('5.0b')
    expect(stores.session.pushedVerdicts.final?.rule).toBe('5.0a')
    // 盘面只控 1 格 ⇒ 两档都未达成（提前决胜保持 ongoing，不会误判终止）
    expect(stores.session.pushedVerdicts.decisive?.outcome).toBe('ongoing')
    expect(stores.session.earlyDecisionMet).toBe(false)
  })

  it('胜利判定入会话日志（可按规则号检索 5.0a / 5.0b）', () => {
    const stores = newStores()
    stores.session.startGame(20260913)
    // 回合推到 19 Aug 之后（5.0b 的检查时点）
    stores.workbench.setTurn(10)
    expect(stores.workbench.date).toBe('1941-08-08')
    stores.workbench.checkVictoryNow('turnStart')

    stores.session.setLogQuery({ rule: '5.0b' })
    expect(stores.session.logEntries.length).toBeGreaterThanOrEqual(1)
    expect(stores.session.logEntries[0]?.action).toBe('decisiveVictory')
  })
})
