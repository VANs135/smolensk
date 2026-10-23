/**
 * 视口变换（C2 地图渲染与视口）——**纯几何**，无 DOM、无状态写入
 *
 * 坐标分三层，转换只在本模块定义，别处不得各写一份：
 *   ① 世界坐标（world）：地图版式的画布坐标，原点在图幅左上留白处，1 单位 = 1 像素
 *      （由 `render/map-layout.ts#hexCanvasPoint` 给出格心）
 *   ② 屏幕坐标（screen）：视口容器内的 CSS 像素，原点在容器左上角
 *   ③ 变换：`screen = world × scale + offset`（等比缩放 + 平移，无旋转）
 *
 * 采用「scale + offset」而非 ctx 的矩阵栈，是为了让**命中测试**（screen → world）
 * 与绘制共用同一份参数：绘制与点击互为逆运算，不会因两处公式漂移而错格。
 *
 * 本文件不引 `@/data`：世界尺寸由调用方传入（`BOARD_SIZE_PX`），故可独立测试。
 */

/** 点（世界 / 屏幕坐标共用形状） */
export interface Point {
  x: number
  y: number
}

/** 尺寸 */
export interface Size {
  width: number
  height: number
}

/** 轴对齐矩形（左上角 + 宽高） */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 视口变换：把世界坐标映射到屏幕坐标 */
export interface ViewportTransform {
  /** 缩放倍率（1 = 地图像素与屏幕像素 1:1） */
  scale: number
  /** 屏幕 X 平移量（世界原点在屏幕上的位置） */
  offsetX: number
  /** 屏幕 Y 平移量 */
  offsetY: number
}

/** 最小缩放：整幅地图约 5800×3900 世界像素，0.04 时约 234×158 屏幕像素（仍可判方位） */
export const MIN_SCALE = 0.04

/** 最大缩放：2 倍即可看清算子与印刷格号，再放大只会变糊 */
export const MAX_SCALE = 2

/** 滚轮/按钮每一档的缩放倍率（1.15 ≈ 每 5 档翻倍） */
export const ZOOM_STEP = 1.15

/** 适应窗口时的内边距（屏幕像素） */
export const FIT_PADDING_PX = 16

/** 把缩放倍率夹到 [MIN_SCALE, MAX_SCALE] */
export function clampScale(scale: number): number {
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE)
}

/** 恒等视口（scale=1、不平移）；主要供测试与默认值使用 */
export function identityViewport(scale = 1): ViewportTransform {
  return { scale, offsetX: 0, offsetY: 0 }
}

/** 世界坐标 → 屏幕坐标 */
export function worldToScreen(point: Point, viewport: ViewportTransform): Point {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: point.y * viewport.scale + viewport.offsetY,
  }
}

/**
 * 屏幕坐标 → 世界坐标（worldToScreen 的逆运算）
 *
 * 地图点击选格走这条路径：先转世界坐标，再交给 `map-layout#hitTestHex`。
 */
export function screenToWorld(point: Point, viewport: ViewportTransform): Point {
  return {
    x: (point.x - viewport.offsetX) / viewport.scale,
    y: (point.y - viewport.offsetY) / viewport.scale,
  }
}

/** 平移（参数为屏幕像素位移；拖拽向右下即 dx、dy 为正） */
export function panBy(viewport: ViewportTransform, dx: number, dy: number): ViewportTransform {
  return { ...viewport, offsetX: viewport.offsetX + dx, offsetY: viewport.offsetY + dy }
}

/**
 * 以某个**屏幕锚点**为中心缩放（滚轮缩放的标准做法）
 *
 * 锚点下的世界点在缩放前后落在同一屏幕位置，故光标指着哪格就一直指着哪格。
 */
export function zoomAt(
  viewport: ViewportTransform,
  anchorScreen: Point,
  factor: number,
): ViewportTransform {
  const scale = clampScale(viewport.scale * factor)
  // 先求锚点对应的世界点，再由「它必须仍然落在 anchorScreen」反解新 offset
  const world = screenToWorld(anchorScreen, viewport)
  return {
    scale,
    offsetX: anchorScreen.x - world.x * scale,
    offsetY: anchorScreen.y - world.y * scale,
  }
}

/** 以视口中心为锚点缩放到指定倍率（缩放按钮用） */
export function zoomToScale(
  viewport: ViewportTransform,
  targetScale: number,
  viewSize: Size,
): ViewportTransform {
  const anchor = { x: viewSize.width / 2, y: viewSize.height / 2 }
  const factor = clampScale(targetScale) / viewport.scale
  return zoomAt(viewport, anchor, factor)
}

/** 视口当前可见的**世界**矩形（未做任何外扩） */
export function visibleWorldRect(viewport: ViewportTransform, viewSize: Size): Rect {
  const topLeft = screenToWorld({ x: 0, y: 0 }, viewport)
  const bottomRight = screenToWorld({ x: viewSize.width, y: viewSize.height }, viewport)
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  }
}

/** 矩形向外扩张 margin（负值即收缩） */
export function expandRect(rect: Rect, margin: number): Rect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  }
}

/** 点是否落在矩形内（含边界） */
export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/** 两矩形是否相交（用于格心矩形与可见区域的裁剪判定） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  )
}

/**
 * 适应窗口：整幅世界铺满视口（留 `padding` 内边距）并居中
 *
 * 倍率取长宽两个方向的较小者，保证整幅地图都进得来；随后夹到 [MIN_SCALE, MAX_SCALE]。
 */
export function fitViewport(
  worldSize: Size,
  viewSize: Size,
  padding = FIT_PADDING_PX,
): ViewportTransform {
  const usableWidth = Math.max(viewSize.width - padding * 2, 1)
  const usableHeight = Math.max(viewSize.height - padding * 2, 1)
  const scale = clampScale(
    Math.min(
      usableWidth / Math.max(worldSize.width, 1),
      usableHeight / Math.max(worldSize.height, 1),
    ),
  )
  return {
    scale,
    offsetX: (viewSize.width - worldSize.width * scale) / 2,
    offsetY: (viewSize.height - worldSize.height * scale) / 2,
  }
}

/**
 * 约束平移量：地图大于视口时不允许拖出空边；地图小于视口时强制居中
 *
 * 这样用户永远「看得见地图」，不会把图拖到视口之外找不回来。
 */
export function clampViewport(
  viewport: ViewportTransform,
  worldSize: Size,
  viewSize: Size,
): ViewportTransform {
  const scaledWidth = worldSize.width * viewport.scale
  const scaledHeight = worldSize.height * viewport.scale
  const offsetX =
    scaledWidth <= viewSize.width
      ? (viewSize.width - scaledWidth) / 2
      : Math.min(Math.max(viewport.offsetX, viewSize.width - scaledWidth), 0)
  const offsetY =
    scaledHeight <= viewSize.height
      ? (viewSize.height - scaledHeight) / 2
      : Math.min(Math.max(viewport.offsetY, viewSize.height - scaledHeight), 0)
  return { scale: viewport.scale, offsetX, offsetY }
}

/** 屏幕上 1 像素对应的世界距离（供「按屏幕恒定字号/线宽」换算） */
export function worldUnitsPerScreenPixel(viewport: ViewportTransform): number {
  return 1 / viewport.scale
}
