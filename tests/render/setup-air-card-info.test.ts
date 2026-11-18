import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * ★ 用户 2026-11-16（批 G）：**初设飞机按激活态分两栏**
 *
 * 前口径（2026-11-15）是「一行机型 · 激活态」；现口径改为：
 * 栏头写状态（激活 / 未激活）与剩余枚数，栏内仍是算子阵列；空状态不出栏。
 */
describe('初设飞机：按激活态分栏', () => {
  const source = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')

  it('飞机不再写「机型 · 激活态」文字行，改为分栏', () => {
    // 2026-11-19 初设队列改版：飞机改为**独立分区**（按 stack.key 判定），栏内仍是阵列
    expect(source).toContain("stack.key === 'air'")
    expect(source).toContain('queue__air')
    expect(source).toContain('airStatusSections')
    expect(source).not.toContain('airCardText')
    expect(source).not.toContain('airStatusText')
  })

  it('栏头是「激活 / 未激活」，栏内是算子阵列', () => {
    expect(source).toContain("label: '激活'")
    expect(source).toContain("label: '未激活'")
    expect(source).toContain('queue__air-col-head')
    // 2026-11-19：同一状态跨机型平铺（逐枚算子阵列）
    expect(source).toContain('v-for="chip in group.chips"')
  })
})
