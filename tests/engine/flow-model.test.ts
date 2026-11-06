import { describe, expect, it } from 'vitest'

import { buildFlowGuide, type FlowGuideInput } from '@/engine/flow-model'
import type { SopStep } from '@/engine/session-flow'

/** UI2：流程条只读投影的纯函数用例（不读组件、不读 store） */

const step = (overrides: Partial<SopStep> = {}): SopStep =>
  ({
    id: 'move',
    label: '移动',
    rule: '6.1',
    role: 'first',
    driver: 'player',
    ...overrides,
  }) as SopStep

const input = (overrides: Partial<FlowGuideInput> = {}): FlowGuideInput => ({
  sessionExists: true,
  form: 'advancing',
  terminated: false,
  awaiting: false,
  questionRule: null,
  currentStep: step(),
  currentIndex: 4,
  sopLength: 19,
  firstPlayer: 'axis',
  phaseLabel: '移动（6.1 · 6.1b）',
  segmentStep: { label: '移动', rule: '6.1' },
  segmentPosition: { index: 0, total: 3 },
  segmentStepsCount: 3,
  participatingUnitCount: 7,
  refusal: null,
  actionHint: '选择一枚单位拖到相邻格',
  advanceOutcome: null,
  setupApplied: true,
  setupFinished: true,
  agreedRecorded: true,
  saveError: null,
  ...overrides,
})

describe('UI2 flow-model：行动方 / 操作者 / 阻断 / 下一步', () => {
  it('未开局 ⇒ 初设操作者，下一步去初设队列', () => {
    const guide = buildFlowGuide(
      input({ sessionExists: false, form: 'none', setupFinished: false, currentStep: null }),
    )
    expect(guide.decisionRoleLabel).toBe('初设（未开局）')
    expect(guide.nextActionTarget).toBe('setup')
    expect(guide.nextActionLabel).toContain('去初设队列')
    expect(guide.canAdvance).toBe(true)
    expect(guide.actingSideLabel).toBe('—')
  })

  it('待答 ⇒ 不可推进，阻断行带规则号', () => {
    const guide = buildFlowGuide(input({ form: 'awaiting', awaiting: true, questionRule: '2.3' }))
    expect(guide.decisionRoleLabel).toBe('待答（须作答）')
    expect(guide.canAdvance).toBe(false)
    expect(guide.blockers[0]).toMatchObject({ kind: 'warning', rule: '2.3' })
  })

  it('已终止 ⇒ 操作者已终止且不可推进', () => {
    const guide = buildFlowGuide(input({ form: 'terminated', terminated: true }))
    expect(guide.decisionRoleLabel).toBe('已终止')
    expect(guide.canAdvance).toBe(false)
  })

  it('自动步 ⇒ 操作者「自动推进」，行动方取自 SOP 角色', () => {
    const guide = buildFlowGuide(input({ currentStep: step({ driver: 'automatic' }) }))
    expect(guide.decisionRoleLabel).toBe('自动推进')
    expect(guide.actingSideLabel).toBe('先手方 axis')
  })

  it('后手步 ⇒ 行动方「后手方」', () => {
    expect(buildFlowGuide(input({ currentStep: step({ role: 'second' }) })).actingSideLabel).toBe(
      '后手方',
    )
  })

  it('环节投影含第 n/m 环，括号注记只从阶段名移除', () => {
    const guide = buildFlowGuide(input())
    expect(guide.phaseLabel).toBe('移动')
    expect(guide.segmentLabel).toBe('移动（6.1）· 第 1/3 环')
    expect(guide.todoLabel).toBe('本环节可参与 7 枚')
  })

  it('拒绝与存档错误都进阻断清单', () => {
    const guide = buildFlowGuide(
      input({
        refusal: { rule: '6.1', reason: '本环节已移动过' },
        saveError: { rule: '存档', reason: '本地存储不可用' },
      }),
    )
    expect(guide.blockers.map((blocker) => blocker.rule)).toEqual(['6.1', '存档'])
  })

  it('连跑结果文案仍由投影统一生成', () => {
    const guide = buildFlowGuide(
      input({ advanceOutcome: { steps: 3, stoppedBy: 'player' }, currentStep: step() }),
    )
    expect(guide.advanceLabel).toBe('自动段 3 步 → 移动')
  })
})
