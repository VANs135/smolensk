import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 死操作②：热坐交接遮罩挡住顶栏 ⇒「存档 / 读档」看起来能点、点了没反应。
 *
 * 期望（二选一，此处两条都做）：
 *   ① 顶栏抬到遮罩之上 —— 遮罩不覆盖顶栏（只遮盘面）；
 *   ② 交接未确认时存档按钮**明确置灰**并说明「须先确认交接」。
 * 仅调整层级 / 可用态与文案，不改交接本身的规则语义。
 */

const APP = readFileSync('src/App.vue', 'utf8')

describe('死操作②：交接遮罩存在时顶栏不得留「能点但没反应」', () => {
  it('① 存档按钮在交接未确认时置灰并给出原因', () => {
    expect(APP).toContain('useHotseatStore')
    expect(APP).toMatch(/:disabled="hotseat\.handoffPending"/)
    expect(APP).toContain('须先确认交接')
  })

  it('② 交接期间棋桌不可聚焦，存档对话框隐藏', () => {
    expect(APP).toContain(':inert="hotseat.handoffPending && currentView === \'game\'"')
    expect(APP).toContain(':open="ui.saveDialogOpen && !hotseat.handoffPending"')
  })
})
