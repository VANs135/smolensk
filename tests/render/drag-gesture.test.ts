import { describe, expect, it } from 'vitest'

import {
  DRAG_CLICK_SLOP_PX,
  IDLE_DRAG,
  beginDrag,
  dragCancel,
  dragEnd,
  dragMove,
} from '@/render/drag-gesture'

/**
 * M9⑤：地图拖动手势的状态机（纯函数）
 *
 * 三条只有异常路径才暴露的纪律：
 *   ① `pointerup` 可能永远不到（系统手势/浏览器接管/指针失联）⇒ 由 `pointercancel`
 *      或「移动事件里左键位已松」两条路复位，否则拖动状态卡死、此后点选全被当成平移；
 *   ② 位移 ≤ `DRAG_CLICK_SLOP_PX` 仍算单击（手抖不该把点格变成平移）；
 *   ③ 取消**不得**判为单击。
 */
describe('拖动状态机（M9⑤）', () => {
  it('按下 → 复位为「未按下」只有抬起/取消两条出口', () => {
    const gesture = beginDrag({ x: 100, y: 100 })
    expect(gesture).toEqual({
      dragging: true,
      moved: false,
      last: { x: 100, y: 100 },
      pointerId: null,
    })
    expect(dragEnd(gesture).gesture).toEqual(IDLE_DRAG)
    expect(dragCancel(gesture).gesture).toEqual(IDLE_DRAG)
  })

  it('④ 多指：手势身份（`pointerId`）必须一路带下去（丢了就分不清是哪一根手指）', () => {
    /*
     * 回执（2026-10-30）：状态里原先没有指针身份 ⇒ 第二根手指按下会替换整段手势，
     * 先抬起的那根被当成"本次手势结束"并判一次单击（误点一格），仍在屏上的那根再也拖不动。
     * 该用例只钉住纯模块的"身份传递"（组件侧的闸门见 MapCanvas 的三个 handler）。
     */
    const gesture = beginDrag({ x: 0, y: 0 }, 7)
    expect(gesture.pointerId).toBe(7)
    const panned = dragMove(gesture, { x: 30, y: 0 }, 1)
    expect(panned.kind).toBe('pan')
    expect(panned.kind === 'pan' && panned.gesture.pointerId).toBe(7)
    // 五秒后（多步平移）身份仍然在
    let step = panned
    for (let i = 0; i < 3; i += 1) {
      step = dragMove(step.kind === 'pan' ? step.gesture : gesture, { x: 40 + i, y: 0 }, 1)
    }
    expect(step.kind === 'pan' && step.gesture.pointerId).toBe(7)
  })

  it('① 抬起事件丢了：移动事件里左键位已松 ⇒ 就地复位且**不算**单击', () => {
    const gesture = beginDrag({ x: 10, y: 10 })
    // 正常按下时 buttons=1；系统接管后到达的事件 buttons=0
    const aborted = dragMove(gesture, { x: 40, y: 40 }, 0)
    expect(aborted.kind).toBe('aborted')
    expect(aborted.kind === 'aborted' && aborted.gesture).toEqual(IDLE_DRAG)
    // 复位之后：不再产生平移，也不再产生点击
    expect(dragMove(IDLE_DRAG, { x: 50, y: 50 }, 1).kind).toBe('idle')
    expect(dragEnd(IDLE_DRAG).clicked).toBe(false)
  })

  it('② 容差内位移仍是单击；超过容差即平移（且此后抬起不再点格）', () => {
    const gesture = beginDrag({ x: 0, y: 0 })
    const small = dragMove(gesture, { x: 1, y: 1 }, 1) // |1|+|1| = 2 ≤ 2
    expect(small.kind).toBe('pan')
    expect(small.kind === 'pan' && small.gesture.moved).toBe(false)
    expect(dragEnd(small.kind === 'pan' ? small.gesture : IDLE_DRAG).clicked).toBe(true)

    const big = dragMove(gesture, { x: 2, y: 1 }, 1) // |2|+|1| = 3 > 2
    expect(big.kind === 'pan' && big.gesture.moved).toBe(true)
    expect(dragEnd(big.kind === 'pan' ? big.gesture : IDLE_DRAG).clicked).toBe(false)
    expect(DRAG_CLICK_SLOP_PX).toBe(2)
  })

  it('平移增量与累计位置：每步只报增量，位置随事件更新', () => {
    let gesture = beginDrag({ x: 0, y: 0 })
    const first = dragMove(gesture, { x: 10, y: -5 }, 1)
    expect(first.kind === 'pan' && [first.dx, first.dy]).toEqual([10, -5])
    gesture = first.kind === 'pan' ? first.gesture : gesture
    const second = dragMove(gesture, { x: 12, y: -5 }, 1)
    expect(second.kind === 'pan' && [second.dx, second.dy]).toEqual([2, 0])
  })

  it('坐标没变 ⇒ idle（不产生 0 位移的平移）', () => {
    const gesture = beginDrag({ x: 5, y: 5 })
    expect(dragMove(gesture, { x: 5, y: 5 }, 1).kind).toBe('idle')
  })

  it('③ 取消永不判为单击；未按下时的抬起也不产生点击', () => {
    const dragged = dragMove(beginDrag({ x: 0, y: 0 }), { x: 1, y: 0 }, 1)
    const gesture = dragged.kind === 'pan' ? dragged.gesture : IDLE_DRAG
    expect(dragEnd(gesture).clicked).toBe(true) // 容差内：抬起算单击
    expect(dragCancel(gesture).clicked).toBe(false) // 同样手势，取消不算
    expect(dragEnd(IDLE_DRAG).clicked).toBe(false) // 重复抬起
    expect(dragCancel(IDLE_DRAG).clicked).toBe(false)
  })

  it('右/中键（左键位为 0）不产生平移——按下时已由组件过滤，这里再兜一层', () => {
    const gesture = beginDrag({ x: 0, y: 0 })
    // buttons=2（右键）：左键位 0 ⇒ 视为「抬起丢失」而复位，绝不连续平移
    expect(dragMove(gesture, { x: 30, y: 30 }, 2).kind).toBe('aborted')
    // 左键 + 右键同时按下（buttons=3）：左键位仍在 ⇒ 正常平移
    expect(dragMove(gesture, { x: 30, y: 30 }, 3).kind).toBe('pan')
  })
})
