import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '@/shared'
import { useGameSessionStore } from '@/stores'

/**
 * S4（用户 2026-11-17 实走）：**回合结束态（turnEnd，`activeSide = null`）是合法存档态**
 *
 * 实走现场：在 H「回合结束」点保存成功（`saveNow` 返回 true、无 `saveError`），
 * 随即读档被拒 `recordsMissingSide:回合记录缺少行动方与先手方（2.2）` —— 同一份档存得进读不出。
 *
 * 口径：优先让**读档恢复它**（turnEnd 之后本来就要 `advanceTurn` 重判先手，
 * 行动方/先手清空是引擎的合法收尾），而不是把保存拒掉。
 */

function newStore() {
  setActivePinia(createPinia())
  const store = useGameSessionStore()
  store.setSaveStorage(createMemoryStorage())
  return store
}

type SessionStore = ReturnType<typeof newStore>

/** 一路推进到 H 之后「回合结束」（不处理玩家动作，只看阶段机） */
function reachTurnEnd(store: SessionStore): void {
  store.setScenarioId('4')
  expect(store.startGame()).toBe(true)
  for (let guard = 0; guard < 400; guard += 1) {
    if (store.records?.phase === 'turnEnd') return
    if (store.terminated) throw new Error('未到 turnEnd 就终止了')
    if (!store.stepNow()) throw new Error(`推进被拒：${store.error?.rule}/${store.error?.reason}`)
  }
  throw new Error('未在合理步数内推进到 turnEnd')
}

describe('S4：回合结束态存取对称', () => {
  it('在 H 保存 → 读回 records 逐项一致 → 还能继续推进到下一回合', () => {
    const store = newStore()
    reachTurnEnd(store)
    expect(store.records?.activeSide).toBeNull()
    // turnEnd 只清行动方；先手方保留到下一回合 Pre-Turn 再重判
    expect(store.records?.firstPlayer).not.toBeNull()
    const before = JSON.parse(JSON.stringify(store.records)) as Record<string, unknown>

    expect(store.saveNow()).toBe(true)
    expect(store.saveError).toBeNull()

    // 脏化：先推进一回合，确保读档不是「什么都没变」
    expect(store.stepNow()).toBe(true)
    expect(store.records?.phase).toBe('preTurn')
    expect(store.records?.turn).toBe((before['turn'] as number) + 1)

    expect(store.loadNow()).toBe(true)
    expect(store.saveError).toBeNull()
    expect(JSON.parse(JSON.stringify(store.records))).toEqual(before)

    // 读回后仍可继续：回合结束 → 下一回合 Pre-Turn（行动方与先手一并清空、待判）
    expect(store.stepNow()).toBe(true)
    expect(store.records?.turn).toBe((before['turn'] as number) + 1)
    expect(store.records?.phase).toBe('preTurn')
    expect(store.records?.activeSide).toBeNull()
    expect(store.records?.firstPlayer).toBeNull()
  })
})
