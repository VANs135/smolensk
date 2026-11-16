import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 批 H1（接线守卫）：**地图内拖动落子**必须真的接在画布与对局台上。
 *
 * 三条不可退：
 *   ① 画布把「本次移动中的算子」也当拖动源（`counterDragSource`），不只盒源；
 *   ② 拖放事件带**落点格**，由图外盒判定之后才会走「拖到格＝点击该格」；
 *   ③ 落点在图外（`hex === null`）时不做地图落子 —— 只保留既有的盒行为。
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('H1 接线：地图内拖动落子', () => {
  it('MapCanvas 同时认盒源与移动拖动源', () => {
    const source = read('../../src/components/map/MapCanvas.vue')
    expect(source).toContain('counterDragSource')
    expect(source).toContain('props.boxDragSource?.(')
    expect(source).toContain('props.counterDragSource?.(')
  })

  it('counterDrop 带落点格（hex），供上层判断是否在地图内', () => {
    const source = read('../../src/components/map/MapCanvas.vue')
    expect(source).toMatch(/counterDrop:\s*\[id: string,[\s\S]{0,120}hex: HexRef \| null\]/)
    expect(source).toMatch(/emit\('counterDrop'[\s\S]{0,120}dropHex/)
  })

  it('对局台：先判图外盒，再有落点格才拖到格；图外不做地图落子', () => {
    const source = read('../../src/views/GameTableView.vue')
    expect(source).toContain(':counter-drag-source="mapView.counterForMoveDragAt"')
    expect(source).toContain('mapView.dropMovingCounterAt(id, hex')
    expect(source).toMatch(/if \(hex === null\) return/)
  })

  it('悬停预览文本由上层算好传给画布（画布不读 store）', () => {
    const canvas = read('../../src/components/map/MapCanvas.vue')
    const view = read('../../src/views/GameTableView.vue')
    expect(canvas).toContain('hoverPreview')
    expect(view).toContain(':hover-preview=')
    expect(view).toContain('workbench.hoverPreviewAt(')
  })
})
