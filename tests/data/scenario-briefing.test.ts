import { describe, expect, it } from 'vitest'

import { scenarios } from '@/data'

/**
 * 剧本目标窗（用户 2026-11-18 第 1 条）
 *
 * 「在剧本开局之后、进入初设之前，给玩家一个任务目标 / 胜利条件窗口，玩家点确定再进入初设。」
 * 窗口内容**按该剧本原文摘录**（`_pdf_text/Smolensk_Rules_v1.1.txt` 与
 * `_pdf_text/Smolensk_Vitebsk_Scenario.txt`），不得自造；缺字段由本批补进 `scenarios.json`。
 *
 * 本文件只钉数据侧：每个剧本都有 brief，条目非空且每条都带条款号（条款号只进 `?`）。
 */
describe('scenarios.json：剧本目标窗数据', () => {
  const all = () => scenarios.scenarios
  const byId = (id: string) => all().find((item) => item.id === id)!
  const flatText = (id: string, key: 'objectives' | 'victory' | 'restrictions'): string =>
    (byId(id).briefing?.[key] ?? []).map((item) => `${item.text} ${item.rule}`).join(' ')

  it('8 个剧本都带 briefing：目标、胜利条件、来源非空，每条都有条款号', () => {
    expect(all()).toHaveLength(8)
    for (const scenario of all()) {
      const brief = scenario.briefing
      expect(brief, `剧本 ${scenario.id} 缺 briefing`).toBeDefined()
      expect(brief!.objectives.length, `剧本 ${scenario.id} 缺目标`).toBeGreaterThan(0)
      expect(brief!.victory.length, `剧本 ${scenario.id} 缺胜利条件`).toBeGreaterThan(0)
      expect(brief!.source.trim().length, `剧本 ${scenario.id} 缺原文出处`).toBeGreaterThan(0)
      const items = [...brief!.objectives, ...brief!.victory, ...(brief!.restrictions ?? [])]
      for (const item of items) {
        expect(item.text.trim().length, `剧本 ${scenario.id} 有空条目`).toBeGreaterThan(0)
        expect(
          item.rule.trim().length,
          `剧本 ${scenario.id} 条目缺条款号：${item.text}`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('剧本 1：目标/胜利按 5.0a–5.0c 原文摘录（11 个目标格 + 提前决胜）', () => {
    expect(flatText('1', 'victory')).toContain('至少 7 个目标格')
    expect(flatText('1', 'victory')).toContain('至少 6 个目标格')
    expect(flatText('1', 'victory')).toContain('至少 9 个目标格')
    expect(flatText('1', 'victory')).toContain('至少 8 个目标格')
    expect(flatText('1', 'victory')).toContain('52.09')
    expect(flatText('1', 'restrictions')).toContain('1/2')
  })

  it('剧本 2：胜利阈值按原文 6 / 7（不套用 5.0a 的 7 / 6）', () => {
    expect(flatText('2', 'victory')).toContain('至少 6 个目标格')
    expect(flatText('2', 'victory')).toContain('至少 7 个目标格')
    expect(flatText('2', 'victory')).toContain('27.05')
    expect(flatText('2', 'victory')).toContain('32.25')
  })

  it('剧本 3：限制含「不得以预备模式初设」与 4 辆卡车自选满载', () => {
    expect(flatText('3', 'restrictions')).toContain('预备模式')
    expect(flatText('3', 'restrictions')).toContain('4 辆')
    expect(flatText('3', 'restrictions')).toContain('移动模式')
  })

  it('剧本 4：胜利同剧本 2、限制同剧本 3（原文「same as」）', () => {
    expect(flatText('4', 'victory')).toContain('至少 6 个目标格')
    expect(flatText('4', 'restrictions')).toContain('剧本 3')
  })

  it('剧本 5/6：Krd / Aufk 入死亡堆的抽签口径；剧本 6 限制同剧本 5', () => {
    expect(flatText('5', 'restrictions')).toContain('Krd')
    expect(flatText('5', 'restrictions')).toContain('Aufk')
    expect(flatText('6', 'restrictions')).toContain('剧本 5')
  })

  it('剧本 7：限制含卡车全部空载与掷可变撤离（3.3c）', () => {
    expect(flatText('7', 'restrictions')).toContain('空载')
    expect(flatText('7', 'restrictions')).toContain('3.3c')
  })

  it('Intro: Vitebsk：大胜/小胜按原文，限制含攻方不得用 Internals', () => {
    expect(flatText('Intro', 'victory')).toContain('大胜')
    expect(flatText('Intro', 'victory')).toContain('小胜')
    expect(flatText('Intro', 'restrictions')).toContain('Internals')
    expect(flatText('Intro', 'restrictions')).toContain('12.10')
  })
})
