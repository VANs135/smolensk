import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 批 M2（接线守卫）：增援铁路抵达**点格即落子**，原位只留「撤回」一步。
 *
 * 口径：不再有「确认」这一步；落子后的撤回条必须真的调用 `undoArrivalRailNow`
 * （退回算子与运力），而不是只清界面状态。
 */
const view = readFileSync(new URL('../../src/views/GameTableView.vue', import.meta.url), 'utf8')

describe('M2 接线：铁路抵达一步撤回', () => {
  it('对局台按 arrivalRailUndo 显示撤回条，且只调 undoArrivalRailNow', () => {
    expect(view).toContain('workbench.arrivalRailUndo')
    expect(view).toContain('workbench.undoArrivalRailNow()')
  })

  it('抵达撤回条里没有「确认」按钮（确认那一步已删）', () => {
    const block = view.slice(
      view.indexOf('workbench.arrivalRailUndo'),
      view.indexOf('workbench.arrivalRailUndo') + 1200,
    )
    expect(block).not.toContain('确认')
    expect(block).not.toContain('confirmRailTransportNow')
  })
})
