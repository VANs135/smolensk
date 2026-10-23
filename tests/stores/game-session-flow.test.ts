import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
import { SOP_STEP_COUNT } from '@/engine/session-flow'
import { useGameSessionStore } from '@/stores'

/**
 * 会话流程条（W6 C10）的**端到端流程**（store 级）
 *
 * 用**真实剧本数据**（`scenarios.json`：首回合方、首回合天气、初设数值、共识开关）；
 * 断言的是「流程走通 + 形态写对 + 内核裁决生效」——面板侧不做任何规则计算。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useGameSessionStore()
}

/**
 * W7 C13：专规 4.0 的**开局共识勾选列表**
 *
 * 「选择剧本后，第一个回合开始前，全部勾选才开始」⇒ 任何推进之前，先把共识一次性写入日志。
 */
function confirmConsensus(store: ReturnType<typeof newStore>): void {
  store.setAllAgreedChecks(true)
  expect(store.confirmAgreedChecklist()).toBe(true)
}

/**
 * 一路推进到**停下待答**（跳过全部自动段）
 *
 * 首回合先手由剧本指定（2.3）⇒ 首个真玩家的待答在第 2 回合的先手判定处。
 */
function stepToAwaiting(store: ReturnType<typeof newStore>): void {
  for (let guard = 0; guard < 200; guard += 1) {
    if (store.awaiting || store.terminated) return
    if (!store.stepNow()) throw new Error(`推进被拒：${store.error?.rule}/${store.error?.reason}`)
  }
  throw new Error('未在合理步数内停下待答')
}

describe('W6 C10：开局与初设（会话驱动）', () => {
  it('2.2：开局后形态为 advancing，记录轨落在首回合的 Pre-Turn 天气判定', () => {
    const store = newStore()
    expect(store.form).toBeNull() // 未开局（未建会话）
    expect(store.startGame()).toBe(true)
    expect(store.form).toBe('advancing')
    expect(store.records).toMatchObject({
      turn: 1,
      phase: 'preTurn',
      preTurnSegment: 'weatherDetermination',
      activeSide: null,
      firstPlayer: null,
    })
    expect(store.guidance?.index).toBe(0)
    expect(store.guidance?.total).toBe(SOP_STEP_COUNT)
  })

  it('1.2 / 1.7 / 3.5 / 2.3：初设数值取自剧本数据（railCap / supplyCache / 建造标记 / 首回合天气）', () => {
    const store = newStore()
    store.startGame()
    const setup = scenarios.scenarios[0]?.setup
    expect(store.records?.railCapacity).toEqual(setup?.railCap)
    expect(store.records?.counters.supplyCache).toEqual({
      axis: setup?.supplyCache,
      soviet: setup?.supplyCache,
    })
    expect(store.records?.counters.constructionMarkers).toBe(setup?.constructionMarkers)
    // 首回合天气按剧本指定（数据 'normal' ⇒ 引擎 'normal'）
    expect(store.records?.weather).toEqual({ air: 'normal', ground: 'good' })
  })

  it('2.2：未开局就步进 ⇒ 内核拒绝并记录原因（不静默）', () => {
    const store = newStore()
    expect(store.stepNow()).toBe(false)
    expect(store.error?.reason).toBe('sessionNotStarted')
  })
})

describe('W7 C13：开局共识勾选列表（专规 4.0：勾 = 采用，默认全部不勾）', () => {
  it('scenarios.agreedOptions：默认全部不用；未写入日志时步进会**自动补写**结论再推进', () => {
    const store = newStore()
    store.startGame()
    // 勾选列表逐行来自数据（顺序即题号）；★ 用户口径：默认全部不勾（都不用）
    expect(store.agreedChecklistRows.map((row) => row.item)).toEqual([...store.agreedOptionItems])
    expect(store.agreedCheckedCount).toBe(0)
    expect(store.agreedRecorded).toBe(false)

    // 不勾任何一项也能直接开局：步进时按当前勾选（默认全不用）自动写入日志
    expect(store.stepNow()).toBe(true)
    expect(store.agreedRecorded).toBe(true)
    expect(store.consensus.every((entry) => entry.adopted === false)).toBe(true)
    // 共识已收束 ⇒ 流程推进到 Pre-Turn 的下一步（先手判定）
    expect(store.records?.preTurnSegment).toBe('firstPlayerDetermination')
  })

  it('scenarios.agreedOptions：勾上某条 ⇒ 自动补写时该条被采纳', () => {
    const store = newStore()
    store.startGame()
    store.setAgreedCheck(1, true)
    expect(store.agreedCheckedCount).toBe(1)
    expect(store.stepNow()).toBe(true)
    expect(store.consensus[1]).toMatchObject({ adopted: true })
    expect(store.consensus.filter((entry) => entry.adopted === true)).toHaveLength(1)
  })

  it('scenarios.agreedOptions：全部勾选 + 写入日志 ⇒ 逐条结论进日志，此后进入天气判定', () => {
    const store = newStore()
    store.startGame()
    confirmConsensus(store)
    expect(store.consensus.every((entry) => entry.adopted === true)).toBe(true)
    // 共识全部答完 ⇒ 下一步是 Pre-Turn 的天气判定（自动段）
    expect(store.stepNow()).toBe(true)
    expect(store.records?.preTurnSegment).toBe('firstPlayerDetermination')
  })

  it('scenarios.agreedOptions：写入日志后仍可逐条改（勾选 = 采用该条）', () => {
    const store = newStore()
    store.startGame()
    store.setAllAgreedChecks(true)
    store.setAgreedCheck(0, false)
    expect(store.confirmAgreedChecklist()).toBe(true)
    expect(store.consensus[0]).toMatchObject({ adopted: false })
    expect(store.consensus.slice(1).every((entry) => entry.adopted === true)).toBe(true)
  })
})

describe('W6 C10：待答面板只听内核裁决', () => {
  it('2.3：选项不在列 / 无待答时作答 ⇒ 一律被内核拒绝，面板不关', () => {
    const store = newStore()
    store.startGame()
    // 无待答时作答
    expect(store.answerNow('adopt')).toBe(false)
    expect(store.error?.reason).toBe('noPendingQuestion')

    // W7 C13：先过共识勾选列表这道门（专规 4.0），再一路推进到首个真待答（第 2 回合先手判定，2.3）
    confirmConsensus(store)
    stepToAwaiting(store)
    expect(store.awaiting).toBe(true)
    const questionIdBefore = store.question?.id
    // 非法选项 ⇒ 会话框架拒绝
    expect(store.answerNow('notAnOption')).toBe(false)
    expect(store.error).not.toBeNull()
    // 问题仍在（面板保持打开）
    expect(store.question?.id).toBe(questionIdBefore)
    // 合法作答后才关闭
    expect(store.answerNow('first')).toBe(true)
    expect(store.question).toBeNull()
    expect(store.error).toBeNull()
  })

  it('2.3：首回合先手由剧本指定（不掷骰、不待答）；常规回合停下待答', () => {
    const store = newStore()
    store.startGame()
    confirmConsensus(store)
    store.stepNow() // 天气
    store.stepNow() // 先手判定（首回合：剧本指定）
    expect(store.records?.firstPlayer).toBe('axis') // scenario 1 firstPlayer = axis
    expect(store.records?.phase).toBe('aircraftRefit')
    expect(store.awaiting).toBe(false)
  })

  it('2.3：常规回合待答，作答后先手方按选项落地', () => {
    const store = newStore()
    store.startGame()
    confirmConsensus(store)
    // 第 1 回合：天气 → 先手（指定）→ 先手方 8 段 → 后手方 8 段 → 回合结束 → 第 2 回合
    const stepsPerTurn = SOP_STEP_COUNT
    for (let step = 0; step < stepsPerTurn; step += 1) store.stepNow()
    expect(store.records?.turn).toBe(2)
    store.stepNow() // 第 2 回合天气
    store.stepNow() // 第 2 回合先手判定 ⇒ 停下待答
    expect(store.awaiting).toBe(true)
    expect(store.question).toMatchObject({ id: 'initiative', rule: '2.3' })
    const responder = store.question?.responder
    expect(store.answerNow('second')).toBe(true)
    // 选「后手」⇒ 对手成为先手方
    expect(store.records?.firstPlayer).toBe(responder === 'axis' ? 'soviet' : 'axis')
  })
})

describe('W6 C10：终止（P3）', () => {
  it('5.0b：注入「盘面已达成提前决胜」⇒ 回合开始即终止', () => {
    const store = newStore()
    store.startGame()
    confirmConsensus(store)
    store.stepNow() // 天气（第 1 回合，早于 19 Aug 不终止）
    expect(store.terminated).toBe(false)

    store.earlyDecisionMet = true
    // 走到第 2 回合的回合开始（第 1 回合共 19 步：天气已走 1 步，余 18 步到 Turn End + 推进回合）
    for (let step = 0; step < SOP_STEP_COUNT - 1; step += 1) store.stepNow()
    expect(store.records?.turn).toBe(2)
    expect(store.terminated).toBe(false) // 5.0b 在**回合开始**判定 ⇒ 还差一次推进
    store.stepNow()
    expect(store.terminated).toBe(true)
    expect(store.termination).toBe('earlyDecision')
  })

  it('5.0a：跑完整个剧本（剧本 2：8 回合）⇒ 回合用尽终止', () => {
    const store = newStore()
    store.setScenarioId('2')
    store.startGame()
    confirmConsensus(store)
    let guard = 0
    while (!store.terminated) {
      guard += 1
      if (guard > 2000) throw new Error('流程未在合理步数内终止（疑似死循环）')
      if (store.awaiting) {
        store.answerNow(store.question?.kind === 'agreedOption' ? 'adopt' : 'first')
      } else {
        store.stepNow()
      }
    }
    expect(store.termination).toBe('turnsExhausted')
    expect(store.records?.turn).toBe(8) // 剧本 2：8 Jul 起 8 回合 ⇒ 末回合第 8 回合
    expect(store.form).toBe('terminated')
  })

  it('5.0a：终止后不再推进（形态幂等）', () => {
    const store = newStore()
    store.setScenarioId('2')
    store.startGame()
    confirmConsensus(store)
    let guard = 0
    while (!store.terminated) {
      guard += 1
      if (guard > 2000) throw new Error('流程未在合理步数内终止（疑似死循环）')
      if (store.awaiting) {
        store.answerNow(store.question?.kind === 'agreedOption' ? 'adopt' : 'first')
      } else {
        store.stepNow()
      }
    }
    const turn = store.records?.turn
    store.stepNow()
    expect(store.terminated).toBe(true)
    expect(store.records?.turn).toBe(turn)
  })
})

describe('W6 C10：重置与剧本切换', () => {
  it('2.2：重置清空会话但保留剧本选择', () => {
    const store = newStore()
    store.setScenarioId('3')
    store.startGame()
    store.resetGame()
    expect(store.form).toBeNull()
    expect(store.scenarioId).toBe('3')
    expect(store.guidance).toBeNull()
  })

  it('2.2：开局途中不允许换剧本（避免流程与剧本错配），终止后允许', () => {
    const store = newStore()
    store.startGame()
    expect(store.setScenarioId('5')).toBe(false)
    expect(store.error?.reason).toBe('scenarioLockedWhilePlaying')
    store.resetGame()
    expect(store.setScenarioId('5')).toBe(true)
    expect(store.scenarioId).toBe('5')
  })
})
