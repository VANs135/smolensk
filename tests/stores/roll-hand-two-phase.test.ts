import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkbenchStore } from '@/stores/workbench'

/**
 * v7.1 第二段＝**两段式**（用户 2026-11-11 口径）
 *
 *   ① 判定阶段：1.6c → 3.6 随机事件 → 3.6 补给列车 → 3.3c 可变撤离 → 1.6b 补员表 →
 *      1.6b 补给表 → 2.3c 方面军预备队。**不落子、不出地图落点**；
 *   ② 放置阶段：全部产出汇成**同一张手牌**，点一条 → 点高亮格落一枚 → 可收回。
 *
 * 本文件只钉三件事：判定未走完不许放；手牌合并了哪几类来源；补给列车/补给表不再各自占块。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

type Store = ReturnType<typeof newStore>

/** 把环节拨到第二段（replRoll），并选一个日期没有 2.3c 批次的回合 */
function enterRollSegment(store: Store): void {
  store.setTurn(2)
  store.setPhase('reinforcement')
  const at = store.playerSegmentSteps.findIndex((step) => step.id === 'reinforcement.replRoll')
  expect(at).toBeGreaterThanOrEqual(0)
  store.setSegmentStepIndex(at)
}

/** 手填骰面掷 1.6b（autoRoll 关掉，结果可预期） */
function roll(store: Store): void {
  store.variableReplInputs.autoRoll = false
  store.variableReplInputs.supplyDice = 9
  store.variableReplInputs.replDice = 10
  store.variableReplInputs.specialDie = 2
  expect(store.rollVariableReplNow()).toBe(true)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('v7.1 第二段：判定阶段 → 放置阶段', () => {
  it('判定没走完 ⇒ 不进放置阶段（修前"判完一项就能立刻放置"）', () => {
    const store = newStore()
    enterRollSegment(store)

    // ① 1.6b 未掷
    expect(store.rollPlacementOpen).toBe(false)
    expect(store.rollPlacementBlockedReason).toContain('1.6b')
    expect(store.beginRollHandEntryNow('repl:pax')).toBe(false)

    // ② 1.6b 已掷、1.6c 未掷 ⇒ 仍不许落位
    roll(store)
    expect(store.variableReplRolled).toBe(true)
    expect(store.rollPlacementOpen).toBe(false)
    expect(store.rollPlacementBlockedReason).toContain('1.6c')

    // ③ 八件事走完 ⇒ 放行
    store.markSpecialReplDraw(store.activeSide, store.turn)
    expect(store.rollPlacementBlockedReason).toBeNull()
    expect(store.rollPlacementOpen).toBe(true)
  })

  it('判定阶段不落子：掷表后 SP 与补员都还在手牌上', () => {
    const store = newStore()
    enterRollSegment(store)
    const dumpsBefore = store.spDumps.length
    roll(store)

    expect(store.spDumps.length).toBe(dumpsBefore)
    expect(store.units.filter((unit) => unit.instanceId.startsWith('repl'))).toEqual([])
    // 裁定 2：1.6b 补给表 SP 直接入图外盒，不再自动填 2.1 免费铁运池
    expect(store.supplyArrivalSp).toBe(0)
    expect(store.airBoxSupply(store.activeSide).sp).toBeGreaterThan(0)
    expect(store.rollHandPoints).toBeGreaterThan(0)
  })

  it('手牌合并全部来源：补员表 / 补给表 SP / 补给列车 各一条，来源标签保留', () => {
    const store = newStore()
    enterRollSegment(store)
    roll(store)
    store.markSpecialReplDraw(store.activeSide, store.turn)

    const entries = store.rollHandEntries
    const ids = entries.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    // 裁定 2：1.6b 补给表 SP 已入图外盒，不再出现在 2.1 的落账手牌里
    expect(ids).not.toContain('sp:arrival')
    expect(store.airBoxSupply(store.activeSide).sp).toBeGreaterThan(0)
    // 补员表的两族都在同一张手牌里（修前只有它们算"手牌"）
    if (store.replPending.pax > 0) expect(ids).toContain('repl:pax')
    if (store.replPending.eq > 0) expect(ids).toContain('repl:eq')
    // 每个条目都带来源标签与角标
    for (const entry of entries) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.count).toBeGreaterThan(0)
    }
    // 补给列车若掷出 ⇒ 也在同一张手牌（不再单独占块）
    if (store.supplyTrainPending) {
      const train = entries.find((entry) => entry.id === 'sp:train')
      expect(train).toBeDefined()
      expect(train!.label).toContain('3.6 补给列车')
      expect(train!.count).toBe(store.supplyTrainSp)
    }
    // 手牌是同一处口径：角标总数＝各条之和
    expect(store.rollHandPoints).toBe(entries.reduce((sum, entry) => sum + entry.count, 0))
  })

  it('结束本段才把暂存的到货 SP 落账（城市/图边判据仍按 2.1/3.1）', () => {
    const store = newStore()
    enterRollSegment(store)
    roll(store)
    store.markSpecialReplDraw(store.activeSide, store.turn)
    // 裁定 2 后 1.6b 的 SP 不再自动进落账池；这里手填 1 SP，继续验 2.1 的落账机制
    store.supplyArrivalSp = 1
    const edge = store.openSupplySourceHexes[0]
    expect(edge).toBeDefined()
    expect(store.beginRollHandEntryNow('sp:arrival')).toBe(true)
    expect(store.pickHexFor(edge!)).toBe(true)
    expect(store.supplyTableUnplaced).toBe(0)
    // 只是"指定了落点"，还没写补给账本
    expect(store.spDumps).toEqual([])

    // 其余手牌放完（或本来就没有）：候选从选格态里取（引擎只给合法格）
    for (let guard = 0; guard < 40 && store.replPending.pax > 0; guard += 1) {
      expect(store.beginRollHandEntryNow('repl:pax')).toBe(true)
      const candidates = store.hexPickView?.candidates
      const hex = Array.isArray(candidates) ? candidates[0] : undefined
      if (hex === undefined) break
      if (!store.pickHexFor(hex)) break
    }
    for (let guard = 0; guard < 40 && store.replPending.eq > 0; guard += 1) {
      expect(store.beginRollHandEntryNow('repl:eq')).toBe(true)
      const candidates = store.hexPickView?.candidates
      const hex = Array.isArray(candidates) ? candidates[0] : undefined
      if (hex === undefined) break
      if (!store.pickHexFor(hex)) break
    }

    if (store.supplyTrainPending) {
      if (store.panzerGroupRulesOn && store.activeSide === 'axis') {
        store.setSupplyTrainGroup('guderian')
      }
      const railHex = store.supplyTrainPlacementHexes[0]
      if (railHex !== undefined) {
        expect(store.beginRollHandEntryNow('sp:train')).toBe(true)
        expect(store.pickHexFor(railHex)).toBe(true)
      }
    }

    expect(store.rollHandPending).toBe(false)
    expect(store.endRollSegmentNow(false)).toBe(true)
    // 落账后：图边源格上有这批到货 SP
    expect(
      store.spDumps.some((dump) => dump.hex.col === edge!.col && dump.hex.row === edge!.row),
    ).toBe(true)
  })

  it('补给列车 / 补给表不再各自占块：块内只剩判定回执，落点全在统一手牌', () => {
    const source = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    // 补给列车的"块内放置"按钮已删
    expect(source).not.toContain('点地图高亮铁路格放置 2 SP')
    // 补给表的块内表单与落账按钮已删
    expect(source).not.toContain('落账（专规 2.1）')
    expect(source).not.toContain('workbench.applySupplyArrivalsNow()')
    // 统一手牌是唯一放置入口
    expect(source).toContain('workbench.beginRollHandEntryNow(entry.id)')
    expect(source).toContain('workbench.rollHandEntries')
  })
})
