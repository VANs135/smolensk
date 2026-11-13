import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 用户 2026-11-14 裁定 1：6.1f「就地放下」只留移动面板那一处，
 * 算子窗（`MapActionPopover`）里的同名列表删掉 —— 同一件事只有一个入口。
 *
 * 仓库不做组件挂载测试 ⇒ 用源码守卫钉入口数量。
 */
describe('6.1f：就地放下的唯一入口', () => {
  it('移动面板：移动编组里点一枚即放下（唯一入口保留）', () => {
    const panel = readFileSync('src/components/move/MovePanel.vue', 'utf8')
    expect(panel).toContain('移动编组')
    expect(panel).toContain('workbench.dropUnitFromMove($event)')
  })

  it('算子窗：不再列「就地放下」，也不再调 dropUnitFromMove', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).not.toContain('就地放下')
    expect(popover).not.toContain('dropUnitFromMove')
  })
})
