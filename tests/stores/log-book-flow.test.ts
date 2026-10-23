import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { queryLogBook } from '@/engine/log-book'
import { createMemoryStorage } from '@/shared'
import { useGameSessionStore } from '@/stores'

/**
 * 结算日志数据层（W7 D2）的**端到端流程**（store 级）
 *
 * 用**真实流程**产生日志（C10 的会话步进：开局共识 → 天气 → 先手判定 → 段推进 → 回合推进），
 * 再核对 D2 的四件事与重放复算 —— 日志里的骰子全部来自引擎的种子化 RNG，故重放必须通过。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useGameSessionStore()
}

/** 推进到指定回合（途中按规则要求作答：共识采纳、先手选先手） */
function advanceToTurn(store: ReturnType<typeof newStore>, targetTurn: number): void {
  // W7 C13：开局共识是第一个回合的先决条件（专规 4.0）⇒ 先走勾选列表，再开始推进
  if (!store.agreedRecorded) {
    store.setAllAgreedChecks(true)
    if (!store.confirmAgreedChecklist()) {
      throw new Error(`开局共识写入被拒：${store.error?.rule}/${store.error?.reason}`)
    }
  }
  let guard = 0
  while ((store.records?.turn ?? Number.MAX_SAFE_INTEGER) < targetTurn) {
    guard += 1
    if (guard > 3000) throw new Error('流程未在合理步数内到达目标回合（疑似死循环）')
    if (store.terminated) return
    if (store.awaiting) {
      store.answerNow(store.question?.kind === 'agreedOption' ? 'adopt' : 'first')
    } else {
      store.stepNow()
    }
  }
}

describe('W7 D2：结算日志由真实流程产生', () => {
  it('D2：无会话 ⇒ 空手册、空检索、无重放报告（不臆造）', () => {
    const store = newStore()
    expect(store.logBook.stats.total).toBe(0)
    expect(store.logBook.rules).toEqual([])
    expect(store.logEntries).toEqual([])
    expect(store.replayReport).toBeNull()
    expect(store.logFiltered).toBe(false)
  })

  it('D2：跑两个回合后，日志结构化并带规则号（1.5 天气 / 2.3 先手 / 4.0 共识 / 2.2 流程）', () => {
    const store = newStore()
    store.startGame()
    advanceToTurn(store, 3)

    const book = store.logBook
    expect(book.stats.total).toBeGreaterThan(0)
    expect(book.stats.failed).toBe(0) // 正常流程里没有「被拒」日志
    const rules = book.rules.map((entry) => entry.rule)
    expect(rules).toContain('1.5') // 天气判定
    expect(rules).toContain('2.3') // 先手判定
    expect(rules).toContain('4.0') // 开局共识
    expect(rules).toContain('2.2') // 段推进 / 回合推进
    // 每条都有可展开明细与一行摘要
    for (const entry of book.entries) {
      expect(entry.details.length).toBeGreaterThan(0)
      expect(entry.summary).toContain(entry.rule)
    }
  })

  it('D2：可检索 —— 按规则号 / 阵营 / 动作 / 关键词命中，多条件为「与」', () => {
    const store = newStore()
    store.startGame()
    advanceToTurn(store, 3)
    const book = store.logBook

    // 按规则号（与规则编号对齐的入口）
    const weather = queryLogBook(book, { rule: '1.5' })
    expect(weather.length).toBeGreaterThanOrEqual(1)
    expect(weather.every((entry) => entry.action === 'weather')).toBe(true)

    // 按阵营
    expect(queryLogBook(book, { side: 'axis' }).length).toBeGreaterThan(0)

    // 按动作
    expect(queryLogBook(book, { action: 'turnEnd' }).length).toBeGreaterThanOrEqual(1)

    // 关键词命中的明细则（天气明细里有 air=normal / air=limited）
    expect(queryLogBook(book, { text: 'air=' }).length).toBeGreaterThanOrEqual(1)

    // 多条件「与」：先手判定 + 规则 2.3
    const initiative = queryLogBook(book, { action: 'initiative', rule: '2.3' })
    expect(initiative.length).toBeGreaterThanOrEqual(1)
    expect(queryLogBook(book, { action: 'initiative', rule: '1.5' })).toEqual([])

    // store 里的筛选入口
    store.setLogQuery({ rule: '1.5' })
    expect(store.logFiltered).toBe(true)
    expect(store.logEntries).toEqual(weather)
    store.clearLogQuery()
    expect(store.logFiltered).toBe(false)
    expect(store.logEntries.length).toBe(book.stats.total)
  })

  it('D2：固定种子重放复算通过（真实流程的骰子逐条吻合，且给出了每条日志的游标）', () => {
    const store = newStore()
    store.startGame()
    advanceToTurn(store, 3)

    const report = store.replayReport
    expect(report).not.toBeNull()
    if (report === null) throw new Error('应当有重放报告')
    expect(report.ok).toBe(true)
    expect(report.rngSelfConsistent).toBe(true)
    expect(report.stateMatches).toBe(true)
    expect(report.firstDivergence).toBeNull()
    // 第 1 回合天气按剧本指定不掷骰；此后每回合 1 骰 + 每回合先手判定 2d6 ⇒ 跨回合必有掷骰
    expect(report.diceCount).toBeGreaterThan(0)
    // 重放终点游标应与存档的掷骰游标一致
    expect(report.cursors.at(-1)?.drawCountAfter).toBe(store.session?.state.rng.drawCount)
    // 游标区间单调不减，且与日志同序
    const cursors = report.cursors
    expect(cursors).toHaveLength(store.logBook.stats.total)
    for (let index = 1; index < cursors.length; index += 1) {
      expect(cursors[index]!.drawCountBefore).toBeGreaterThanOrEqual(
        cursors[index - 1]!.drawCountAfter,
      )
    }
  })

  it('D2：篡改日志里的骰面 ⇒ 重放报出首个分歧（并给出定位信息）', () => {
    const store = newStore()
    store.startGame()
    advanceToTurn(store, 3)
    const session = store.session
    if (session === null) throw new Error('应当有会话')

    // 找第一条带掷骰的日志，改掉它的骰面
    const index = session.log.findIndex((entry) => entry.rolls.length > 0)
    expect(index).toBeGreaterThanOrEqual(0)
    const tamperedLog = session.log.map((entry, position) =>
      position === index
        ? {
            ...entry,
            rolls: entry.rolls.map((roll) => ({ ...roll, faces: [1], count: 1, total: 1 })),
          }
        : entry,
    )
    store.session = { ...session, log: tamperedLog }

    const report = store.replayReport
    expect(report?.ok).toBe(false)
    expect(report?.firstDivergence?.index).toBe(index)
    expect(report?.detail).toContain('首个分歧')
  })

  it('D2：读档后日志手册与重放结论一并恢复（存档里的日志是可复算的）', () => {
    const store = newStore()
    // Vitest 为 node 环境无 localStorage ⇒ 注入内存介质
    store.setSaveStorage(createMemoryStorage())
    store.startGame()
    advanceToTurn(store, 3)
    const before = store.logBook.stats
    expect(store.saveNow()).toBe(true)

    store.resetGame()
    expect(store.logBook.stats.total).toBe(0)

    expect(store.loadNow()).toBe(true)
    expect(store.logBook.stats).toEqual(before)
    expect(store.replayReport?.ok).toBe(true)
  })
})
