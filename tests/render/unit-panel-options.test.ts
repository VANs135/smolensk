import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 会话窗「有选项」的**接线守卫**（2026-11-26 用户报：点设施开会话，窗里没有可点的东西）
 *
 * 仓里没有 `@vue/test-utils`，面板的渲染分支拿不到挂载级断言 ⇒ 按源码切片钉住三件事：
 *   ① 多选项设施必须有**选项清单**分支（修前 `activeOnly === null` 一路 `v-else-if` 落空 ⇒ 空白窗）；
 *   ② 清单每一项点了要走 store 的**同一执行入口**（不另写规则、不自己拼动作）；
 *   ③ 连"本环节没有操作"也得有个字，不许再出现纯空白会话框。
 */

const read = (path: string): string => readFileSync(path, 'utf8')

describe('UnitPanel：会话窗的选项落点', () => {
  const panel = read('src/components/game/UnitPanel.vue')
  const store = read('src/stores/map-view.ts')

  it('★ 多选项设施有选项清单分支（旧实现这里整窗空白）', () => {
    expect(panel).toContain('v-else-if="menuOptions.length > 0"')
    expect(panel).toContain('v-for="item in menuOptions"')
    // 清单来自 store，不在组件里另算一遍"能做什么"
    expect(panel).toContain('mapView.unitActionMenuAt(id)')
  })

  it('★ 点清单里某项 ⇒ store 的同一执行入口（与右键菜单同源）', () => {
    expect(panel).toContain('mapView.openUnitActionSectionNow(id, key)')
    // store 侧两个入口都在公开面上，且都接到既有判据
    expect(store).toContain('function unitActionMenuAt(')
    expect(store).toContain('function openUnitActionSectionNow(')
    expect(store).toContain(
      'return counterActionsAt(hex, instanceId).filter((item) => item.key in FACILITY_ACTION_META)',
    )
    expect(store).toContain('return applyContextAction(hex, instanceId, key)')
  })

  it('不许空窗：连"没有可执行操作"都要有一行字', () => {
    expect(panel).toContain('action-menu__empty')
    expect(panel).toContain('这个设施本环节没有可执行的操作。')
  })
})
