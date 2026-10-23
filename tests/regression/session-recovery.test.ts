import { describe, expect, it } from 'vitest'

import { replaySessionLog } from '@/engine/log-book'
import { createRngState, verifyRngState } from '@/engine/rng'
import { deserializeSaveFile, serializeSaveFile } from '@/engine/save-file'
import { deserializeSession, serializeSession } from '@/engine/session'
import type { GameSession } from '@/engine/state-types'
import { type KeyValueStorage, createMemoryStorage } from '@/shared'
import { SAVE_SLOT_KEY } from '@/stores'
import {
  BASELINE_SEED,
  buildBaselineSession,
  driveToTurn,
  newSessionStore,
  type SessionStore,
} from './regression-harness'

/**
 * W7 D3 回归基线 · **会话可恢复**（W6 D1 存档 + 会话驱动）
 *
 * ## 「可恢复」的硬标准
 *   不是「能读回来」，而是**恢复后继续跑，结果与从未中断完全一致**：
 *   日志逐条相同、记录轨相同、RNG 游标相同 —— 这正是 CODE_SPEC §3.3 说的
 *   「种子入存档 ⇒ 整局可复现」在存档层的落地。
 *
 * ## 四层断言
 *   ① **往返保真**：`serializeSaveFile` → `deserializeSaveFile`（以及会话层的
 *      `serializeSession` → `deserializeSession`）逐字段一致；
 *   ② **中断续跑 ≡ 不间断**：存档点在中间，两侧跑到同一回合后**三项全等**；
 *   ③ **待答态可恢复**：停下待答时存档，读回后问题仍在、仍可作答并继续；
 *   ④ **失败不静默**：版本不符 / 内容损坏一律拒绝，且**不动当前会话**。
 */

/** 注入内存存储的会话 store（Vitest 为 node 环境，无 localStorage） */
function newStoredSession(adapter: KeyValueStorage = createMemoryStorage()) {
  const store = newSessionStore()
  store.setSaveStorage(adapter)
  return { store, adapter }
}

/** 开局并推进到目标回合（固定种子 ⇒ 可复算） */
function startAndDrive(store: SessionStore, targetTurn: number): void {
  if (!store.startGame(BASELINE_SEED)) {
    throw new Error(`开局被拒：${store.error?.rule}/${store.error?.reason}`)
  }
  driveToTurn(store, targetTurn)
}

describe('W7 D3 会话可恢复：存档往返保真', () => {
  it('W7 D3：存档文件往返 —— 会话态逐字段一致（元信息 / 状态 / 日志）', () => {
    const session = buildBaselineSession()
    const text = serializeSaveFile(session, '2026-01-01T00:00:00.000Z')
    const file = deserializeSaveFile(text)

    expect(file.scenarioId).toBe(session.state.scenarioId)
    expect(file.session.meta.sessionId).toBe(session.meta.sessionId)
    expect(file.session.state.records).toEqual(session.state.records)
    expect(file.session.state.rng).toEqual(session.state.rng)
    expect(file.session.log).toEqual(session.log)
    expect(file.session.status).toEqual(session.status)
  })

  it('W7 D3：会话容器往返 —— RNG 仍然自洽、重放仍然全绿（存档没丢可复算信息）', () => {
    const session = buildBaselineSession()
    const restored = deserializeSession(serializeSession(session))

    expect(restored.state.rng).toEqual(session.state.rng)
    expect(verifyRngState(restored.state.rng)).toBe(true)
    const report = replaySessionLog(restored)
    expect(report.ok).toBe(true)
    expect(report.firstDivergence).toBeNull()
  })
})

describe('W7 D3 会话可恢复：中断续跑 ≡ 不间断跑', () => {
  it('W7 D3：中间存档后再推进的结果，与从未中断的同一局**三项全等**', () => {
    const { store: interrupted, adapter } = newStoredSession()
    startAndDrive(interrupted, 2)
    const savedLogLength = interrupted.log.length
    expect(savedLogLength).toBeGreaterThan(0)
    expect(interrupted.saveNow()).toBe(true)

    // ① 不间断：接着跑到第 4 回合
    driveToTurn(interrupted, 4)
    const continuous = interrupted.session
    if (continuous === null) throw new Error('不间断跑的会话缺席')

    // ② 从存档恢复：再跑到第 4 回合
    const { store: resumed } = newStoredSession(adapter)
    expect(resumed.loadNow()).toBe(true)
    expect(resumed.log.length).toBe(savedLogLength)
    driveToTurn(resumed, 4)
    const restored = resumed.session
    if (restored === null) throw new Error('恢复后的会话缺席')

    // 三项全等：日志 / 记录轨 / RNG（游标与内部状态）
    expect(restored.log).toEqual(continuous.log)
    expect(restored.state.records).toEqual(continuous.state.records)
    expect(restored.state.rng).toEqual(continuous.state.rng)
    expect(replaySessionLog(restored).ok).toBe(true)
  })

  it('W7 D3：读档后继续推进不被拒（记录轨与先决条件都随档恢复）', () => {
    const { store, adapter } = newStoredSession()
    startAndDrive(store, 2)
    expect(store.saveNow()).toBe(true)

    const { store: resumed } = newStoredSession(adapter)
    expect(resumed.loadNow()).toBe(true)
    // 记录轨与形态随档恢复 ⇒ 可直接继续推进
    expect(resumed.records?.turn).toBe(store.records?.turn)
    expect(resumed.form).toBe('advancing')
    expect(resumed.stepNow()).toBe(true)
    expect(resumed.error).toBeNull()
  })
})

describe('W7 D3 会话可恢复：待答态可恢复', () => {
  it('W7 D3：停下待答时存档 ⇒ 读回后问题仍在、应答后继续推进', () => {
    const { store, adapter } = newStoredSession()
    if (!store.startGame(BASELINE_SEED)) throw new Error('开局被拒')
    // 一路推进到停下待答（首回合先手由剧本指定 ⇒ 首个真待答在 2.3 先手判定）
    for (let guard = 0; guard < 300 && !store.awaiting && !store.terminated; guard += 1) {
      if (!store.stepNow()) throw new Error(`推进被拒：${store.error?.rule}/${store.error?.reason}`)
    }
    expect(store.awaiting).toBe(true)
    const pendingId = store.question?.id
    expect(pendingId).toBeDefined()
    expect(store.saveNow()).toBe(true)

    const { store: resumed } = newStoredSession(adapter)
    expect(resumed.loadNow()).toBe(true)
    expect(resumed.awaiting).toBe(true)
    expect(resumed.question?.id).toBe(pendingId)
    expect(resumed.question?.responder).toBe(store.question?.responder)

    // 作答后能继续走（待答状态与应答方都随档恢复）
    expect(resumed.answerNow('first')).toBe(true)
    expect(resumed.stepNow()).toBe(true)
  })
})

describe('W7 D3 会话可恢复：失败不静默', () => {
  it('W7 D3：槽内容损坏 ⇒ 读档被拒且**不动当前会话**', () => {
    const { store, adapter } = newStoredSession()
    startAndDrive(store, 2)
    const before = store.session
    const beforeLog = store.log.length

    adapter.setItem(SAVE_SLOT_KEY, '{ 这不是合法存档 JSON')
    expect(store.loadNow()).toBe(false)
    expect(store.saveError).not.toBeNull()
    expect(store.session).toBe(before)
    expect(store.log.length).toBe(beforeLog)
  })

  it('W7 D3：存档文件版本不符 ⇒ 明确报「版本不匹配」，不做静默迁移', () => {
    const session = buildBaselineSession()
    const file = JSON.parse(serializeSaveFile(session, '2026-01-01T00:00:00.000Z')) as Record<
      string,
      unknown
    >
    file['saveVersion'] = 999
    expect(() => deserializeSaveFile(JSON.stringify(file))).toThrow(/版本不匹配/)
  })

  it('W7 D3：空槽 ⇒ 读档失败但当前会话不受影响（区分「无档」与「读坏」）', () => {
    const { store } = newStoredSession(createMemoryStorage())
    startAndDrive(store, 1)
    const before = store.session
    expect(store.loadNow()).toBe(false)
    expect(store.saveError?.reason).toBe('emptySlot')
    expect(store.session).toBe(before)
  })

  it('W7 D3：未开局即存档 ⇒ 拒绝（不产生空档）', () => {
    const { store } = newStoredSession()
    expect(store.session).toBeNull()
    expect(store.saveNow()).toBe(false)
    expect(store.saveError).not.toBeNull()
  })
})

describe('W7 D3 会话可恢复：RNG 随档恢复', () => {
  it('W7 D3：种子—游标—内部状态三者自洽；读档后从同一种子重推一致', () => {
    const session = buildBaselineSession()
    const rng = session.state.rng
    expect(rng.seed).toBe(BASELINE_SEED)
    expect(verifyRngState(rng)).toBe(true)

    const restored: GameSession = deserializeSession(serializeSession(session))
    expect(restored.state.rng.drawCount).toBe(rng.drawCount)
    expect(restored.state.rng.state).toBe(rng.state)
    // 从种子重推到该游标 ⇒ 必得同一内部状态（可复算的充要条件）
    const recomputed = replaySessionLog(restored)
    expect(recomputed.stateMatches).toBe(true)
    expect(recomputed.seed).toBe(BASELINE_SEED)
  })

  it('W7 D3：空会话（0 掷骰）同样自洽 —— 边界不放过', () => {
    const fresh = createRngState(BASELINE_SEED)
    expect(verifyRngState(fresh)).toBe(true)
    expect(fresh.drawCount).toBe(0)
  })
})
