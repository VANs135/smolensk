import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 状态 / 提示栏溢出（用户 2026-11-18）
 *
 * 实跑（900×480，长日志 + 长拒绝文案 + 完整盒列表）：
 * 修前 `.gt__drawer-body` 的直接子项被 flex 压扁（`.panel` clientHeight=0、scrollHeight=1418、
 * `overflow:hidden`）⇒ 后面的内容既看不见也滚不到；修后子项 `flex-shrink:0`，
 * 外层 `overflow:auto` 可滚到 scrollHeight。
 *
 * 这里守住结构：抽屉内容列自身可滚，且直接子项不参与收缩。
 */

const read = (path: string): string => readFileSync(path, 'utf8')

describe('状态 / 提示栏溢出可查看', () => {
  it('★ 抽屉内容列：外层自滚 + 直接子项不被压扁', () => {
    const view = read('src/views/GameTableView.vue')
    expect(view).toMatch(/\.gt__drawer-body\s*\{[^}]*overflow:\s*auto/)
    expect(view).toMatch(/\.gt__drawer-body > \*\s*\{[^}]*flex-shrink:\s*0/)
  })

  it('★ 提示条与拒绝文案允许换行，不靠裁切', () => {
    const strip = read('src/components/game/ActionFeedbackStrip.vue')
    expect(strip).toContain('word-break: break-word')
    expect(strip).toMatch(/\.feedback__list\s*\{[^}]*overflow:\s*auto/)
  })
})
