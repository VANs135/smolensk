import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { describe, it, expect } from 'vitest'
import { prepareBoardSnapshot, type SnapshotContract } from '@/engine/board-snapshot'
import { actingSideFor, phaseTransition } from '@/engine/game-lifecycle'
import { createSnapshotRegistry } from '@/stores/snapshot-registry'
import { createPhaseCoordinator } from '@/stores/phase-coordinator'
import { captureGameSnapshot, prepareGameSnapshot } from '@/stores/game-snapshot'
import { useGameSessionStore, type BoardCodec } from '@/stores/session'
import type { Records } from '@/engine/state-types'

function records(phase: Records['phase'] = 'movement'): Records {
  setActivePinia(createPinia())
  const session = useGameSessionStore()
  session.startGame()
  return { ...session.records!, phase, activeSide: 'axis', firstPlayer: 'axis' }
}
const contract: SnapshotContract = {
  version: 6,
  defaults: { units: [], ledger: {}, segmentStepIndex: 0 },
  legacyMissingKeys: { 5: ['segmentStepIndex'] },
  validate: () => true,
}

describe('完整值的快照解析与状态提交', () => {
  it('旧档只补明确缺失的字段，结果不与输入或默认值共享对象', () => {
    const input = { version: 5, fields: { units: [{ id: 'a' }], ledger: { paid: 1 } } }
    const result = prepareBoardSnapshot(input, contract)
    expect(result.sourceVersion).toBe(5)
    expect(result.fields['segmentStepIndex']).toBe(0)
    input.fields.units[0]!.id = 'changed'
    expect(result.fields['units']).toEqual([{ id: 'a' }])
    expect(contract.defaults['units']).toEqual([])
  })
  it.each([3.5, 0, 7])('拒绝未声明版本 %s', (version) => {
    expect(() =>
      prepareBoardSnapshot(
        { version, fields: { units: [], ledger: {}, segmentStepIndex: 0 } },
        contract,
      ),
    ).toThrow()
  })
  it('已存在的旧字段不能借迁移漏掉', () => {
    expect(() => prepareBoardSnapshot({ version: 5, fields: { units: [] } }, contract)).toThrow(
      'ledger',
    )
  })
  it('判断兼容性不读取当前ref形态，也不记住上一份档的版本', () => {
    const value = ref<unknown>(null),
      seen: number[] = []
    const registry = createSnapshotRegistry({
      version: 6,
      fields: () => [['optional', value]],
      legacyMissingKeys: { 5: [] },
      validate: () => true,
      beforeCapture() {},
      afterRestore(snapshot) {
        seen.push(snapshot.sourceVersion)
      },
    })
    const old = { version: 5, fields: { optional: { paid: 1 } } },
      current = { version: 6, fields: { optional: null } }
    expect(registry.accepts(old)).toBe(true)
    expect(registry.accepts(current)).toBe(true)
    registry.restore(old)
    expect(seen).toEqual([5])
    value.value = []
    expect(registry.accepts(current)).toBe(true)
  })
  it('恢复后处理失败时，所有映射字段回到原值', () => {
    const units = ref<unknown>([{ id: 'before' }]),
      ledger = ref<unknown>({ paid: 1 })
    const registry = createSnapshotRegistry({
      version: 6,
      fields: () => [
        ['units', units],
        ['ledger', ledger],
      ],
      legacyMissingKeys: {},
      validate: () => true,
      beforeCapture() {},
      afterRestore() {
        throw new Error('failed')
      },
    })
    expect(() =>
      registry.restore({ version: 6, fields: { units: [], ledger: { paid: 9 } } }),
    ).toThrow('failed')
    expect(units.value).toEqual([{ id: 'before' }])
    expect(ledger.value).toEqual({ paid: 1 })
  })
  it('会话、盘面、初设一起捕获，非法初设在恢复前拒绝', () => {
    records()
    const session = useGameSessionStore().session!
    const entity = { id: 'before' }
    const board: BoardCodec = {
      capture: () => ({ version: 6, fields: { units: [entity] } }),
      accepts: () => true,
      restore() {
        throw new Error('不应提交')
      },
    }
    const setup: BoardCodec = {
      capture: () => ({ finished: true }),
      accepts: () => false,
      restore() {
        throw new Error('不应提交')
      },
    }
    const snapshot = captureGameSnapshot(session, board, setup)
    entity.id = 'after'
    expect(JSON.stringify(snapshot.board)).toContain('before')
    expect(() => prepareGameSnapshot(snapshot.session, snapshot.board, board, setup)).toThrow(
      'setupUnrecognized',
    )
  })
})

describe('2.2 生命周期仅依赖正式记录轨', () => {
  it('天气子步骤变化不会重复清掉阶段账本', () => {
    const before = { ...records('preTurn'), activeSide: null }
    const after = { ...before, preTurnSegment: 'firstPlayerDetermination' as const }
    expect(phaseTransition(before, after)).toEqual({
      changed: false,
      turnChanged: false,
      refreshTrace: false,
      reinforcementKey: null,
    })
  })
  it('反应段的操作者切到对方，不改变玩家回合所有者', () => {
    const state = records('reaction')
    expect(actingSideFor(state)).toBe('soviet')
    expect(state.activeSide).toBe('axis')
    expect(actingSideFor({ ...state, activeSide: null })).toBeNull()
  })
  it('进入D段先重置阶段，再刷新追溯；新回合额外清回合账本', () => {
    const previous = records(),
      current = { ...previous, phase: 'supply' as const, turn: previous.turn + 1 },
      events: string[] = []
    const coordinator = createPhaseCoordinator({
      current: () => current,
      isInitialSetup: () => false,
      isPlayerPhase: () => true,
      start() {},
      settleObligations: () => true,
      cleanUp: () => true,
      publishVictory() {},
      resetPhase() {
        events.push('phase')
      },
      resetTurn() {
        events.push('turn')
      },
      refreshTrace() {
        events.push('trace')
      },
      ensureReinforcement() {},
    })
    coordinator.afterStep(previous)
    expect(events).toEqual(['phase', 'turn', 'trace'])
  })
  it('待决义务拒绝推进时，不执行清理或发布新的胜利判定', () => {
    const events: string[] = []
    const coordinator = createPhaseCoordinator({
      current: () => records('combat'),
      isInitialSetup: () => false,
      isPlayerPhase: () => true,
      start() {},
      settleObligations: () => false,
      cleanUp() {
        events.push('clean')
        return true
      },
      publishVictory() {
        events.push('victory')
      },
      resetPhase() {},
      resetTurn() {},
      refreshTrace() {},
      ensureReinforcement() {},
    })
    expect(coordinator.beforeStep()).toBe(false)
    expect(events).toEqual([])
  })
  it('回合结束不是H清理，不受界面fallback阶段影响', () => {
    let clean = 0
    const coordinator = createPhaseCoordinator({
      current: () => records('turnEnd'),
      isInitialSetup: () => false,
      isPlayerPhase: () => false,
      start() {},
      settleObligations: () => true,
      cleanUp() {
        clean++
        return true
      },
      publishVictory() {},
      resetPhase() {},
      resetTurn() {},
      refreshTrace() {},
      ensureReinforcement() {},
    })
    expect(coordinator.beforeStep()).toBe(true)
    expect(clean).toBe(0)
  })
})
