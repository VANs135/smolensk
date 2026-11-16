/**
 * 交互收口 11 号：画布空白点击必须有一条真实事件通路
 *
 * 守卫两件事：画布把「没命中格」的左键单击发出来；对局台接住它去退待点格。
 * 少了前者，玩家只剩 Esc 一条暗路（＝误点无退路）。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('11 号：空白点击退选格', () => {
  it('MapCanvas 在未命中格时 emit blankClick', () => {
    const canvas = read('src/components/map/MapCanvas.vue')
    expect(canvas).toContain('blankClick: []')
    expect(canvas).toContain("else emit('blankClick')")
  })

  it('对局台 / 操作台把 blank-click 接到 cancelBlankPick', () => {
    const table = read('src/views/GameTableView.vue')
    expect(table).toContain('@blank-click="mapView.cancelBlankPick()"')
    const bench = read('src/views/WorkbenchView.vue')
    expect(bench).toContain('@blank-click="mapView.cancelBlankPick()"')
  })

  it('换段/换方/换回合/直跳环节都清 pendingHexPick', () => {
    const code = read('src/stores/workbench.ts')
    // 四处过渡各一句；总量至少 4
    const hits = code.match(/pendingHexPick\.value = null/g)?.length ?? 0
    expect(hits).toBeGreaterThanOrEqual(4)
  })
})
