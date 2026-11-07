import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { segmentLabelsOfAction } from '@/stores'

const source = (path: string) => readFileSync(path, 'utf8')

/**
 * P8「还债」：组件内另算逐点收口（源码守卫 + 投影行为）
 *
 * 只钉「组件不得另立判据」：规则结论一律取自引擎/store 的既有事实或只读投影。
 */
describe('P8：组件内另算还债（源码守卫）', () => {
  it('#2 MovePanel 环节名取 ACTION_GATES 投影', () => {
    expect(segmentLabelsOfAction('move.order')).toEqual([
      'C 移动·模式与移动',
      'E 反应·反应移动',
      'G 进击·进击移动',
    ])
    const move = source('src/components/move/MovePanel.vue')
    expect(move).toContain('segmentLabelsOfAction')
    expect(move).not.toContain('模式与移动」「E 反应')
  })
})
