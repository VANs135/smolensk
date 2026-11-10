import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * ★ 用户 2026-11-10（最终版）：战况只留**三块**——胜利分 / 胜利点 / 占领情况；
 *   长说明与条款号收进 `?`（`RuleTip`），主屏不再摆大字说明与分隔线。
 */
const panel = readFileSync('src/components/victory/VictoryPanel.vue', 'utf8')

describe('战况面板：只留三块', () => {
  it('标题不带条款号（条款号进 `?`）', () => {
    expect(panel).toContain('<BasePanel title="战况">')
    expect(panel).not.toContain('胜利判定（只读：')
  })

  it('恰好三块小标题，顺序为 胜利分 → 胜利点 → 占领情况', () => {
    const titles = [...panel.matchAll(/<h4 class="vp__title">([^<]+)<\/h4>/g)].map((hit) =>
      hit[1]!.trim(),
    )
    expect(titles).toEqual(['胜利分', '胜利点', '占领情况'])
  })

  it('长说明与 5.0a/5.0b/5.0c 条文进 `RuleTip`，主屏不再铺开', () => {
    expect(panel).toContain('<RuleTip rule="5.0a / 5.0b">')
    expect(panel).toContain('<RuleTip rule="5.0c">')
    // 旧主屏上的大字说明块已删
    expect(panel).not.toContain('控制账本在**每个玩家回合的 H 清理段收束时')
    expect(panel).not.toContain('胜利格（5.0c）：所列格')
    expect(panel).not.toContain('<hr />\n    <p class="muted">')
  })
})
