import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * ★ 用户 2026-11-15（实机试玩第 4 项）：**初设飞机卡片左侧空着浪费，写上飞机型号和是否激活**。
 *
 * 口径：极简、不写描述性文字 —— 卡片只补两项事实「机型 + 激活态」；
 * 激活态取剧本初设计划里**这一枚**的状态（`statuses[placed]`），不在界面另算规则。
 */
describe('初设飞机卡片：补机型与激活态', () => {
  const source = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')

  it('飞机卡片在算子图之外写机型', () => {
    expect(source).toContain("item.kind === 'air'")
    expect(source).toContain('queue__air')
    expect(source).toContain('airCardText')
  })

  it('激活态读该型这一枚的初设状态，并落成「激活 / 非激活」', () => {
    expect(source).toContain('airStatusText')
    expect(source).toContain('statuses[item.placed]')
    expect(source).toContain('非激活')
  })
})
