import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * P3 / UI3：会话框外壳的**源码守卫**（仓库不挂组件渲染测试）
 *
 * 钉住三件事：
 *   ① `GameTableView` 的 `MapDock` key 用**会话实例身份**，不再用 `session.kind`；
 *   ② 关闭按钮文案/可用态按 `closePolicy` 投影（取消 / 收起 / 域拒绝）；
 *   ③ 组件只渲染投影，不自己推导规则结论。
 */
describe('P3：会话框外壳（源码守卫）', () => {
  it('GameTableView：MapDock 以 sessionId 为 key，并透传关闭语义', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).toContain(':key="session.sessionId"')
    expect(game).not.toContain(':key="session.kind"')
    expect(game).toContain(':close-policy="session.closePolicy"')
    expect(game).toContain(':close-blocked-reason="session.closeBlockedReason"')
    // 位置记忆仍按种类（既定展示行为，不是会话身份）
    expect(game).toContain(':session-key="session.kind"')
  })

  it('MapDock：三种关闭文案 + refused 分支禁用', () => {
    const dock = readFileSync('src/components/map/MapDock.vue', 'utf8')
    expect(dock).toContain('closePolicy?: MapSessionClosePolicy')
    expect(dock).toContain('取消本次操作')
    expect(dock).toContain('收起本次会话')
    expect(dock).toContain('暂不可关闭')
    expect(dock).toContain(':disabled="props.closePolicy === \'refused\'"')
  })

  it('MapDock 不再把关闭语义写死成一种', () => {
    const dock = readFileSync('src/components/map/MapDock.vue', 'utf8')
    const headStart = dock.indexOf('<header')
    const headEnd = dock.indexOf('</header>')
    const head = dock.slice(headStart, headEnd)
    expect(head).not.toContain('title="取消本次操作"')
    expect(head).not.toContain('aria-label="取消本次操作"')
  })
})
