import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** 初设单位 box：复用增援面板同一套算子阵列（CounterPicker） */
const panel = readFileSync('src/components/setup/SetupPanel.vue', 'utf8')

describe('初设单位 box 的算子阵列', () => {
  it('复用 CounterPicker（不另写一套阵列/样式）', () => {
    expect(panel).toContain("from '@/components/game'")
    expect(panel).toContain('CounterPicker')
    expect(panel).toContain('<CounterPicker')
    // 旧的「待落位」逐行列表不再渲染（抽签结果列表仍用 box__list，不在本断言范围）
    expect(panel).not.toContain('v-for="item in boxItems(')
  })

  it('飞机按激活 / 非激活分组（口径取 planAirSetup 的 statuses）', () => {
    expect(panel).toContain('statuses')
    expect(panel).toContain("status === 'active' ? '激活' : '非激活'")
  })

  it('不可用项不出现（blockedReason / 无候选 / 卡车单入口）', () => {
    expect(panel).toContain('blockedReason === null')
    expect(panel).toContain("item.kind !== 'truck'")
    expect(panel).toContain('item.candidates.length > 0 || item.offMapAllowed === true')
  })
})
