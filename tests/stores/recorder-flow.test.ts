import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useGameSessionStore, useRecorderStore, useWorkbenchStore } from '@/stores'

/**
 * ⑧ 对局记录与导出（2026-11-09）
 *
 * 盯四件事：
 *  1. 开启后能记下**既有事实**：回合/阶段/环节/行动方、日志（含拒绝原因）、结算提交；
 *  2. 停止即得一份可保存的 JSONL，首行 header 带应用版本/提交号/剧本/模式/种子；
 *  3. 未开启时零记录、`stop()` 返回 null，不抛错；
 *  4. 记录本身出问题（不可序列化）不得阻断导出，更不得影响对局。
 */

function boot() {
  setActivePinia(createPinia())
  const session = useGameSessionStore()
  expect(session.startGame()).toBe(true)
  const workbench = useWorkbenchStore()
  const recorder = useRecorderStore()
  return { session, workbench, recorder }
}

const metaOf = (
  overrides: Partial<Parameters<ReturnType<typeof useRecorderStore>['start']>[0]> = {},
) => ({
  appVersion: '0.1.0',
  appCommit: 'abc1234',
  scenarioId: '1',
  scenarioName: 'Smolensk Campaign',
  mode: 'pvp',
  aiSide: null,
  seed: 20260913,
  turn: 1,
  phase: 'movement',
  ...overrides,
})

function parseLines(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('⑧ 对局记录与导出', () => {
  it('开启后记下回合/阶段/环节/行动方；停止导出 header + 事件行', () => {
    const { workbench, recorder } = boot()
    recorder.start(metaOf())
    workbench.setPhase('supply')
    // 一句被拒的日志（真实拒绝文本走同一 pushLog 通道）
    workbench.pushLog('warning', '随便一动被拒绝：测试用', '6.1')

    expect(recorder.count).toBeGreaterThanOrEqual(2)
    const file = recorder.stop()
    expect(file).not.toBeNull()
    const lines = parseLines(file!.text)

    expect(lines[0]).toMatchObject({
      type: 'header',
      appVersion: '0.1.0',
      appCommit: 'abc1234',
      scenarioId: '1',
      scenarioName: 'Smolensk Campaign',
      mode: 'pvp',
      aiSide: null,
      seed: 20260913,
    })
    expect(file!.filename).toMatch(/^smolensk-log-pvp-1-\d{8}-\d{6}\.jsonl$/)

    const logLine = lines.find(
      (line) => line.kind === 'log' && line.text === '随便一动被拒绝：测试用',
    )
    expect(logLine).toBeDefined()
    expect(logLine).toMatchObject({ level: 'warning', rule: '6.1', phase: 'supply' })
    expect(typeof logLine!.turn).toBe('number')
    expect(typeof logLine!.side).toBe('string')
    expect(String(logLine!.step ?? '')).toContain('supply')
    expect(typeof logLine!.at).toBe('string')
  })

  it('关键结算提交也进记录（超集：action + rolls + outcome）', () => {
    const { workbench, recorder } = boot()
    recorder.start(metaOf())
    expect(
      workbench.recordSettlement({
        action: 'move',
        rule: '6.1',
        data: { from: '10.10', to: '10.11' },
      }),
    ).toBe(true)

    const file = recorder.stop()!
    const settle = parseLines(file.text).find((line) => line.kind === 'settle')
    expect(settle).toBeDefined()
    expect(settle).toMatchObject({ rule: '6.1' })
    expect(settle!.detail).toMatchObject({ action: 'move' })
  })

  it('未开启记录 ⇒ 零记录、停止返回 null、不抛', () => {
    const { recorder } = boot()
    expect(() =>
      recorder.note({
        kind: 'log',
        turn: 1,
        phase: 'movement',
        side: 'axis',
        step: null,
      }),
    ).not.toThrow()
    expect(recorder.count).toBe(0)
    expect(recorder.stop()).toBeNull()
  })

  it('记录内容出问题（循环引用）不得阻断导出', () => {
    const { recorder } = boot()
    recorder.start(metaOf())
    const circular: Record<string, unknown> = {}
    circular.self = circular
    recorder.note({
      kind: 'log',
      turn: 1,
      phase: 'movement',
      side: 'axis',
      step: null,
      text: '带循环引用的事件',
      detail: circular,
    })
    const file = recorder.stop()
    expect(file).not.toBeNull()
    expect(file!.text).toContain('带循环引用的事件')
    expect(file!.text).toContain('detail(unserializable)')
  })
})
