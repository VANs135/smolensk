import { describe, expect, it } from 'vitest'

import { ACTION_GATES, buildLegalActionsView, type LegalActionsInput } from '@/stores/legal-actions'
import { useLegalActionsStore } from '@/stores/legal-actions-store'

import { fillSetup, fresh } from '../flows/flow-harness'

/**
 * B1：**合法动作只读聚合视图**
 *
 * 只验证"搬运"：视图里的每条 entry 都必须来自 `ACTION_GATES` 与既有 store 投影，
 * 不新增任何规则判据、不造候选。纯函数一层逐条钉住状态机，store 一层只钉"真的读得到"。
 */

function input(overrides: Partial<LegalActionsInput> = {}): LegalActionsInput {
  return {
    phase: 'movement',
    segment: 'movement.modeAndMovement',
    role: 'active',
    side: 'axis',
    gatedKeys: new Set<string>(),
    terminated: false,
    locked: false,
    advance: { available: false, submit: 'advanceSegmentNow' },
    answer: { awaiting: false, options: [] },
    setup: { active: false, choices: [] },
    candidates: {},
    ...overrides,
  }
}

function entryOf(view: ReturnType<typeof buildLegalActionsView>, key: string) {
  const found = view.entries.find((entry) => entry.key === key)
  expect(found, `视图里没有 ${key}`).toBeDefined()
  return found!
}

describe('纯函数：按闸门表逐条搬运', () => {
  it('ACTION_GATES 每个 key 恰好出现一次，且顺序与闸门表一致', () => {
    const view = buildLegalActionsView(input())
    const gateEntries = view.entries.filter((entry) =>
      ACTION_GATES.some((gate) => gate.key === entry.key),
    )
    expect(gateEntries).toHaveLength(ACTION_GATES.length)
    expect(gateEntries.map((entry) => entry.key)).toEqual(ACTION_GATES.map((gate) => gate.key))
  })

  it('未 gated ⇒ blocked（即使给了候选）', () => {
    const candidates = [{ ref: 'u1', label: 'U1' }]
    const view = buildLegalActionsView(input({ candidates: { 'move.order': candidates } }))
    const entry = entryOf(view, 'move.order')
    expect(entry.gated).toBe(false)
    expect(entry.status).toBe('blocked')
    expect(entry.candidates).toEqual([])
  })

  it('gated 但无候选投影 ⇒ unsupported 且 note 非空', () => {
    const view = buildLegalActionsView(input({ gatedKeys: new Set(['move.order']) }))
    const entry = entryOf(view, 'move.order')
    expect(entry.status).toBe('unsupported')
    expect(entry.candidates).toEqual([])
    expect(entry.note ?? '').toContain('尚无单位/格级候选投影')
  })

  it('gated 且有候选 ⇒ available 且候选原样搬运', () => {
    const candidates = [
      { ref: 'u1', label: 'U1' },
      { ref: 'u2', label: 'U2', disabledReason: '测试原因' },
    ]
    const view = buildLegalActionsView(
      input({ gatedKeys: new Set(['move.order']), candidates: { 'move.order': candidates } }),
    )
    const entry = entryOf(view, 'move.order')
    expect(entry.status).toBe('available')
    expect(entry.candidates).toEqual(candidates)
  })
})

describe('U0：没有提交入口的动作不得显示为可点', () => {
  it('submit === "" 的 entry 即使 available 也 clickable=false', () => {
    const keys = ['rein.formationDraw', 'rein.specialRepl', 'exclusive.panzerObligation']
    const candidates = Object.fromEntries(keys.map((key) => [key, [{ ref: 'x', label: 'X' }]]))
    const view = buildLegalActionsView(input({ gatedKeys: new Set(keys), candidates }))
    for (const key of keys) {
      const entry = entryOf(view, key)
      expect(entry.status).toBe('available')
      expect(entry.submit).toBe('')
      expect(entry.clickable).toBe(false)
      expect(entry.note ?? '').toContain('无既有提交入口')
    }
  })

  it('有提交入口且 available ⇒ clickable=true；blocked ⇒ false', () => {
    const view = buildLegalActionsView(
      input({
        gatedKeys: new Set(['move.order']),
        candidates: { 'move.order': [{ ref: 'u1', label: 'U1' }] },
      }),
    )
    expect(entryOf(view, 'move.order').clickable).toBe(true)
    expect(entryOf(view, 'move.overrun').clickable).toBe(false)
  })
})

describe('terminated / locked 的总闸', () => {
  for (const flag of ['terminated', 'locked'] as const) {
    it(`${flag} ⇒ 非 phase.advance / panel.answer 的 entry 一律 blocked`, () => {
      const gatedKeys = new Set<string>(ACTION_GATES.map((gate) => gate.key))
      const view = buildLegalActionsView(
        input({
          [flag]: true,
          gatedKeys,
          candidates: { 'move.order': [{ ref: 'u1', label: 'U1' }] },
          setup: {
            active: true,
            choices: [{ entryIndex: 1, label: '步兵', hexes: [{ ref: '1.2', label: '1.2' }] }],
          },
        }),
      )
      const others = view.entries.filter(
        (entry) => entry.key !== 'phase.advance' && entry.key !== 'panel.answer',
      )
      expect(others.length).toBeGreaterThan(0)
      expect(others.every((entry) => entry.status === 'blocked')).toBe(true)
    })
  }
})

describe('panel.answer', () => {
  it('awaiting 且有选项 ⇒ available，候选就是选项', () => {
    const view = buildLegalActionsView(
      input({
        answer: {
          awaiting: true,
          options: [
            { id: 'first', label: '先手' },
            { id: 'second', label: '后手' },
          ],
        },
      }),
    )
    const entry = entryOf(view, 'panel.answer')
    expect(entry.status).toBe('available')
    expect(entry.submit).toBe('answerNow')
    expect(entry.candidates).toEqual([
      { ref: 'first', label: '先手' },
      { ref: 'second', label: '后手' },
    ])
  })

  it('未 awaiting ⇒ blocked', () => {
    const view = buildLegalActionsView(input())
    expect(entryOf(view, 'panel.answer').status).toBe('blocked')
  })
})

describe('setup.place', () => {
  it('active + 2 项候选 ⇒ available，ref 按 entryIndex:格号 拼接', () => {
    const view = buildLegalActionsView(
      input({
        setup: {
          active: true,
          choices: [
            {
              entryIndex: 3,
              label: '步兵',
              hexes: [
                { ref: '1.2', label: '1.2' },
                { ref: '3.4', label: '3.4' },
              ],
            },
          ],
        },
      }),
    )
    const entry = entryOf(view, 'setup.place')
    expect(entry.status).toBe('available')
    expect(entry.submit).toBe('placeSelfEntry')
    expect(entry.candidates).toHaveLength(2)
    expect(entry.candidates.map((candidate) => candidate.ref)).toEqual(['3:1.2', '3:3.4'])
    expect(entry.candidates[0]!.label).toBe('步兵 ⇒ 1.2')
  })

  it('不 active ⇒ blocked', () => {
    const view = buildLegalActionsView(input())
    expect(entryOf(view, 'setup.place').status).toBe('blocked')
  })
})

describe('store 适配层：只读投影真的读得到', () => {
  it('剧本 1 进入初设后：side 可读、setup.place 有候选', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    const legal = useLegalActionsStore()
    expect(['axis', 'soviet']).toContain(legal.view.side)
    const place = entryOf(legal.view, 'setup.place')
    expect(place.status).toBe('available')
    expect(place.candidates.length).toBeGreaterThan(0)
    expect(place.candidates.every((candidate) => candidate.ref.includes(':'))).toBe(true)
  })

  it('摆完初设并开局后：phase=aircraftRefit、phase.advance 可用、全部闸门 key 都在', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    fillSetup(ctx)
    expect(ctx.setup.startGameNow()).toBe(true)

    const legal = useLegalActionsStore()
    expect(legal.view.phase).toBe('aircraftRefit')
    expect(entryOf(legal.view, 'phase.advance').status).toBe('available')
    for (const gate of ACTION_GATES) expect(entryOf(legal.view, gate.key)).toBeDefined()
  })
})
