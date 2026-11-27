import { describe, expect, it } from 'vitest'

import type { AiSnapshot } from '@/ai/policy'
import { contextMenuCandidates } from '@/ai/training/candidates'

const hex = { col: 8, row: 12 }

function menu(
  overrides: Partial<NonNullable<AiSnapshot['contextMenu']>> = {},
): NonNullable<AiSnapshot['contextMenu']> {
  return {
    hex,
    targetId: 'f1',
    targetLabel: 'Ge 10.Pz Truck',
    items: [
      {
        key: 'move.transportMerge',
        label: '合并 / 拆分运输点数（13.2c）',
        rule: '13.2c',
        group: '运输',
        disabled: false,
      },
      {
        key: 'move.railTransport',
        label: '铁路运输（13.3）',
        rule: '13.3',
        group: '运输',
        disabled: false,
      },
      {
        key: 'move.strat.toggle',
        label: '转入战略模式（5.8）',
        rule: '5.8',
        group: '模式改变',
        disabled: true,
      },
    ],
    ...overrides,
  }
}

describe('F 阶段右键菜单候选', () => {
  it('菜单没开 ⇒ 每枚可点设施给两条通道：左键开会话 + 右键弹菜单', () => {
    expect(contextMenuCandidates(null, [{ unitId: 'f1', label: 'Ge 10.Pz Truck', hex }])).toEqual([
      { kind: 'unitOpen', unitId: 'f1' },
      { kind: 'contextOpen', unitId: 'f1' },
    ])
  })

  it('两套通道分开：左键那条不产生菜单，右键那条不产会话', () => {
    const out = contextMenuCandidates(null, [{ unitId: 'f1', label: 'Ge 10.Pz Truck', hex }])
    expect(out.filter((action) => action.kind === 'unitOpen')).toHaveLength(1)
    expect(out.filter((action) => action.kind === 'contextOpen')).toHaveLength(1)
  })

  it('菜单开着 ⇒ 列可用项 + 收起；禁用项不出现（不置灰）', () => {
    expect(contextMenuCandidates(menu(), [])).toEqual([
      { kind: 'contextAct', targetId: 'f1', key: 'move.transportMerge' },
      { kind: 'contextAct', targetId: 'f1', key: 'move.railTransport' },
      { kind: 'contextClose' },
    ])
  })

  it('菜单开着时不再开第二个菜单（两支互斥）', () => {
    const out = contextMenuCandidates(menu(), [{ unitId: 'f2', label: 'SP 4', hex }])
    expect(out.some((action) => action.kind === 'contextOpen')).toBe(false)
  })
})
