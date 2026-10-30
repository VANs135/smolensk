/**
 * 指针拖动（平移地图）的状态机 —— **纯函数，可单测**
 *
 * 为什么单独成模块：地图画布是唯一用「按下—拖动—抬起」手势平移的地方，而这条路上有三个
 * 只有在真机/异常路径上才暴露的坑，靠肉眼看组件代码查不出来：
 *
 *   ① **`pointerup` 可能永远不到**（系统手势、浏览器接管、指针失联）⇒ 必须由
 *      `pointercancel` 或「移动事件里按钮位已松」两条路复位，否则 `dragging` 卡在 true，
 *      此后任何平移都会把「点选」吃掉；
 *   ② **手抖 vs 拖动**：位移 ≤ `DRAG_CLICK_SLOP_PX` 仍算单击（否则点格会变成几像素的平移）；
 *   ③ **取消 ≠ 抬起**：`pointercancel` 之后**不得**判为单击（用户并没有完成这次点击）。
 *
 * 组件只做「读事件 → 调这里 → 按返回值平移/点选」，判定全在本模块。
 */

/** 拖动状态（组件持有一个，按本模块的返回值整体替换） */
export interface DragGesture {
  /** 是否处于按下—拖动中 */
  dragging: boolean
  /** 本次手势是否已超过点击容差（超过即视为平移，抬起时不再点格） */
  moved: boolean
  /** 上一次事件的客户端坐标（用于算增量） */
  last: { x: number; y: number } | null
  /**
   * 发起这次手势的指针 id（`null` ＝未记录 / 非指针来源）
   *
   * ★ 为什么必须有：触屏/触控板是**多指**的。第二根手指按下会再走一次 `pointerdown`，
   *   若不记 id 就把整个手势替换掉；随后先抬起的那根手指被当成"本次手势的抬起"
   *   ⇒ 判一次 `clicked`（用户根本没想点格），而仍在屏上的那根手指的移动因为
   *   `dragging === false` 全部变成 `idle` ⇒ 地图突然拖不动。
   */
  pointerId: number | null
}

/** 未按下时的状态 */
export const IDLE_DRAG: DragGesture = { dragging: false, moved: false, last: null, pointerId: null }

/** 点击容差（客户端像素）：|dx| + |dy| 超过它才算平移 */
export const DRAG_CLICK_SLOP_PX = 2

/** 按下（`pointerId` 用于多指判据：只认发起手势的那一根） */
export function beginDrag(
  point: { x: number; y: number },
  pointerId: number | null = null,
): DragGesture {
  return { dragging: true, moved: false, last: { ...point }, pointerId }
}

/** 拖动中的一步结果 */
export type DragStep =
  /** 没在拖动，或坐标没变：什么都不做 */
  | { kind: 'idle' }
  /** 指针已被系统接管（`buttons` 里左键位已松）⇒ 就地复位，**不算单击** */
  | { kind: 'aborted'; gesture: DragGesture }
  /** 平移 (dx, dy) */
  | { kind: 'pan'; dx: number; dy: number; gesture: DragGesture }

/**
 * 移动一步
 *
 * @param buttons 事件的 `PointerEvent.buttons` 位掩码（左键位＝1）
 */
export function dragMove(
  gesture: DragGesture,
  point: { x: number; y: number },
  buttons: number,
): DragStep {
  if (!gesture.dragging) return { kind: 'idle' }
  // ① 抬起事件丢了：按钮位已松 ⇒ 就地复位
  if ((buttons & 1) === 0) return { kind: 'aborted', gesture: IDLE_DRAG }
  const last = gesture.last
  if (last === null) return { kind: 'idle' }
  const dx = point.x - last.x
  const dy = point.y - last.y
  if (dx === 0 && dy === 0) return { kind: 'idle' }
  return {
    kind: 'pan',
    dx,
    dy,
    gesture: {
      dragging: true,
      moved: gesture.moved || Math.abs(dx) + Math.abs(dy) > DRAG_CLICK_SLOP_PX,
      last: { ...point },
      // 手势身份必须一路带下去（丢失 ⇒ 多指时判据失效）
      pointerId: gesture.pointerId,
    },
  }
}

/** 抬起 / 取消的结果 */
export interface DragEnd {
  /** 这次手势是否算**单击**（须由调用方接着做命中测试与派发） */
  clicked: boolean
  gesture: DragGesture
}

/**
 * 抬起（`pointerup`）
 *
 * 未在拖动中 ⇒ `clicked = false`（重复抬起不产生第二次点击）。
 */
export function dragEnd(gesture: DragGesture): DragEnd {
  if (!gesture.dragging) return { clicked: false, gesture }
  return { clicked: !gesture.moved, gesture: IDLE_DRAG }
}

/**
 * 取消（`pointercancel`）
 *
 * 与 `dragEnd` 的唯一区别：**永不**算单击（用户没有完成这次点击）。
 */
export function dragCancel(gesture: DragGesture): DragEnd {
  if (!gesture.dragging) return { clicked: false, gesture }
  return { clicked: false, gesture: IDLE_DRAG }
}
