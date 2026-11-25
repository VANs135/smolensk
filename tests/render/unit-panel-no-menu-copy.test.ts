import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 会话窗「不许复制右键菜单」的接线守卫（2026-11-26 用户实测）
 *
 * 现象：铁路运输（13.3）的窗里冒出「修建 / 改进基地（15.3）」「缩减基地（15.4）」。
 * 根因：`UnitPanel` 里那份"可选动作清单"排在"已选段"之前，且与右键菜单同名同项。
 * 定稿 §4.1：设施动作由**右键菜单选段**，会话窗只画选中的那一段。
 *
 * 仓里没有 `@vue/test-utils` ⇒ 按源码切片钉：面板不得再引入菜单清单，也不得自己拼动作名。
 */

const read = (path: string): string => readFileSync(path, 'utf8')

describe('UnitPanel：会话窗不复制右键菜单', () => {
  const panel = read('src/components/game/UnitPanel.vue')
  const store = read('src/stores/map-view.ts')

  it('★ 面板里不再有动作清单分支（修前它就排掉了 13.3 自己的那一段）', () => {
    expect(panel).not.toContain('menuOptions')
    expect(panel).not.toContain('unitActionMenuAt')
    expect(panel).not.toContain('openUnitActionSectionNow')
    expect(store).not.toContain('function unitActionMenuAt(')
    expect(store).not.toContain('function openUnitActionSectionNow(')
  })

  it('★ 已选段优先：模板里 `activeOnly` 分支之后才允许兜底文案', () => {
    const activeAt = panel.indexOf('v-else-if="activeOnly !== null"')
    const hintAt = panel.indexOf('action-menu__empty')
    expect(activeAt).toBeGreaterThan(-1)
    expect(hintAt).toBeGreaterThan(activeAt)
  })

  it('兜底文案指回右键菜单（不给假按钮）', () => {
    expect(panel).toContain('emptyHint')
    expect(panel).toContain('右键菜单')
  })
})
