import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * C2（用户 2026-11-17 实走）：地面炮击窗不要复写空军的「选飞机发起任务」
 *
 * 实走现场：F 段「射击 → 炮击」打开的地面炮击窗，标题写成
 * 「炮击（10.1） · 格 10.28 · 选飞机发起任务」——`sessionTitle` 对 `kind === 'ops'`
 * 也拼了空军三面板标题（airStageTitle）。空军三面板只属于 `kind === 'air'`。
 */

describe('C2：炮击/地面操作的标题不套空军阶段', () => {
  it('sessionTitle 只对 air 会话追加空军阶段副题', () => {
    const src = readFileSync('src/views/GameTableView.vue', 'utf8')

    expect(src).not.toContain("current.kind === 'ops' || current.kind === 'air'")
    expect(src).toContain("current.kind === 'air'")
  })
})
