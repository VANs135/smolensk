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

  it('飞机按四个“面”分组（激活/未激活 × 完好/减损），逐枚出卡', () => {
    // 2026-11-19：不再每型一张“下一枚”卡；四份同时平铺
    expect(panel).toContain('pendingAirFaces')
    expect(panel).toContain("row.face.status === 'active' ? '激活' : '未激活'")
    expect(panel).toContain('group-mode')
    expect(panel).toContain("'sections'")
  })

  it('减损飞机按原文 `*` 显式标记（不另造 Damaged 状态、不重复计数）', () => {
    // 原文：剧本页 `"*" = one unit begins reduced`；减损与激活态是两个维度
    expect(panel).toContain(' · 减损')
    expect(panel).toContain(' · 完好')
    expect(panel).toContain('减损面')
    expect(panel).toContain('空战')
    expect(panel).toContain('轰炸')
    expect(panel).not.toContain("'damaged'")
  })

  it('不可用项不出现（blockedReason / 无候选 / 卡车单入口）', () => {
    expect(panel).toContain('blockedReason === null')
    expect(panel).toContain("item.kind !== 'truck'")
    expect(panel).toContain('item.candidates.length > 0 || item.offMapAllowed === true')
  })
})
