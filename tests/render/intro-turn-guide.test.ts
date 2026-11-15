import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** Intro: Vitebsk 的单回合引导（教学提示，不参与推进） */
const guide = readFileSync('src/components/session/IntroTurnGuide.vue', 'utf8')
const strip = readFileSync('src/components/session/FlowStrip.vue', 'utf8')

describe('单回合引导（Intro: Vitebsk）', () => {
  it('只在 Intro 出现，且不调用任何推进动作', () => {
    expect(guide).toContain("scenarioId === 'Intro'")
    expect(guide).not.toContain('advanceSegmentNow')
  })

  it('覆盖剧本页顺序：补给/SP → 推进 → 突袭/战斗 → 占两格 → 统计 SP', () => {
    for (const text of ['补给与 SP', '7 Pz', '20 Mtr', '突袭', '19.27', '统计 SP']) {
      expect(guide, `引导缺「${text}」`).toContain(text)
    }
  })

  it('挂在流程条的 panel 形态（bar 形态只留一行，不占地图上方）', () => {
    expect(strip).toContain("import IntroTurnGuide from './IntroTurnGuide.vue'")
    expect(strip).toContain('<IntroTurnGuide />')
  })
})
