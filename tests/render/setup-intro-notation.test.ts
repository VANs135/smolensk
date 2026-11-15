import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** 初设视图的「原文 ↔ 解析」对照（Intro: Vitebsk） */
const panel = readFileSync('src/components/setup/SetupPanel.vue', 'utf8')

describe('初设原文对照（Intro: Vitebsk）', () => {
  it('直接读 scenario-setup.json，只在该剧本出现', () => {
    expect(panel).toContain('scenarioSetup')
    expect(panel).toContain("from '@/data'")
    expect(panel).toContain("setup.scenarioId === 'Intro'")
    expect(panel).toContain('初设原文对照')
  })

  it('逐条显示剧本页原文与解析结果（链接 / 落点 / 减损）', () => {
    expect(panel).toContain('entry.raw')
    expect(panel).toContain('unitId')
    expect(panel).toContain('stepPenalty')
  })
})
