/**
 * **唯一会话框**的落位规则（B4，方案 §4.3）
 *
 * 用户口径（2026-09-16 ⑤ / 方案 §4.3）：会话框可拖动，但——
 *   ① **拖出可视区自动回弹**：松手时把**标题栏**夹回容器内，至少留 `DOCK_MIN_VISIBLE_PX` 可见
 *      （否则拖到地图窗口外就再也点不到了，只能刷新页面）；
 *   ② **位置记忆**：同一**会话类型**记住上次位置，**换类型回到默认（右上角）**。
 *
 * 为什么单独成模块：拖动回弹是"看不见的几何"，只能靠单测钉住（本环境点不了界面）。
 * 本模块**只算数、不碰 DOM、不碰状态**（矩形由组件测好后传进来），与 `render/stack-fan.ts` 同一套路。
 */

import { clamp } from '@/shared'

/** 松手后标题栏至少要留在容器内的可见量（像素） */
export const DOCK_MIN_VISIBLE_PX = 8

/** 面板相对默认锚点（右上角）的平移量 */
export interface DockOffset {
  dx: number
  dy: number
}

/** 视口坐标系里的矩形（对齐 `DOMRect` 的四边，便于组件直接喂 `getBoundingClientRect()`） */
export interface DockRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 把平移量夹回"标题栏仍可点到"的范围
 *
 * 判据（**同时**成立才算合法）：
 *   · 竖向：标题栏与容器竖向重叠 ≥ `minVisible` —— 即「标题栏下沿在容器上沿之下 ≥ min」
 *     且「标题栏上沿在容器下沿之上 ≥ min」；
 *   · 横向：面板与容器横向重叠 ≥ `minVisible`（标题栏是整条，故等价）。
 *
 * 退化情形（容器比面板还窄、或比标题栏还矮）：**回到默认位置**（偏移归零）。默认锚点由 CSS
 * 保证贴合，此时"夹"没有意义，归零至少是确定性行为，不会把面板留在视口外。
 *
 * 非有限输入（NaN / Infinity，例如隐藏元素量出 0 宽）一律归零：`transform` 里一旦出现 NaN，
 * 面板会彻底消失**且拖不回来**（拖动增量会一直叠在 NaN 上）。
 */
export function clampDockOffset(input: {
  /** 容器（地图视口）矩形 */
  container: DockRect
  /** 面板在偏移为零时的矩形 */
  base: DockRect
  /** 本次拖动结束时的平移量 */
  offset: DockOffset
  /** 标题栏高度 */
  headerHeight: number
  /** 最小可见量（缺省 `DOCK_MIN_VISIBLE_PX`） */
  minVisible?: number
}): DockOffset {
  const { container, base, offset, headerHeight } = input
  const min = Math.max(0, input.minVisible ?? DOCK_MIN_VISIBLE_PX)
  const numbers = [
    container.left,
    container.top,
    container.right,
    container.bottom,
    base.left,
    base.top,
    base.right,
    base.bottom,
    offset.dx,
    offset.dy,
    headerHeight,
  ]
  if (!numbers.every((value) => Number.isFinite(value))) return { dx: 0, dy: 0 }

  // 容器量不到尺寸（隐藏 / 未布局 ⇒ `getBoundingClientRect()` 全零）：**别夹**。
  // 对着一个 0×0 的"容器"夹，只会把面板推到某个莫名其妙的位置；归零至少是默认位置。
  if (container.right - container.left <= 0 || container.bottom - container.top <= 0) {
    return { dx: 0, dy: 0 }
  }

  const head = Math.max(0, headerHeight)

  // 横向：面板左沿 ≤ 容器右沿 − min，且面板右沿 ≥ 容器左沿 + min
  const dxLow = container.left + min - base.right
  const dxHigh = container.right - min - base.left
  const dx = dxLow <= dxHigh ? clamp(offset.dx, dxLow, dxHigh) : 0

  // 竖向：只看标题栏那一条
  const dyLow = container.top + min - (base.top + head)
  const dyHigh = container.bottom - min - base.top
  const dy = dyLow <= dyHigh ? clamp(offset.dy, dyLow, dyHigh) : 0

  return { dx, dy }
}

/** 会话框的位置记忆（同一会话类型各记一份） */
export interface DockMemory {
  /** 取上次位置；没记过返回 null（调用方据此用默认位置） */
  recall: (key: string) => DockOffset | null
  /** 记下位置；偏移为零视同"回到默认"，不留记录（免得记忆表越攒越假） */
  remember: (key: string, offset: DockOffset) => void
  /** 忘掉某一类型 */
  forget: (key: string) => void
  /** 清空（换剧本 / 重开一局用） */
  clear: () => void
}

/** 建一份位置记忆（组件在模块作用域建一份即可：同一会话类型跨挂载仍记得） */
export function createDockMemory(): DockMemory {
  const store = new Map<string, DockOffset>()
  return {
    recall(key) {
      const found = store.get(key)
      return found === undefined ? null : { dx: found.dx, dy: found.dy }
    },
    remember(key, offset) {
      if (!Number.isFinite(offset.dx) || !Number.isFinite(offset.dy)) return
      if (offset.dx === 0 && offset.dy === 0) {
        store.delete(key)
        return
      }
      store.set(key, { dx: offset.dx, dy: offset.dy })
    },
    forget(key) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
  }
}
