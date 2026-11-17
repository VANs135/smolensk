import type { HexRef } from '@/data'

import { HEX_RADIUS_PX, HEX_ROW_SPACING_PX, hexCanvasPoint } from './map-layout'

/**
 * 格内**地面堆叠**能完整摆下（互不重叠、四角不越格）的枚数
 *
 * ★ 用户 2026-11-18：这就是「点空白」两条分支的**唯一阈值**——不随缩放/扇面漂移。
 *   它之所以等于每页枚数：单页只摆得下这么多，超出的必须靠窗口逐枚查看。
 */
export const IN_HEX_GROUND_CAPACITY = 4
export const STACK_FAN_PAGE_SIZE = IN_HEX_GROUND_CAPACITY
export const STACK_FAN_HIT_SCREEN_PX = 24

/** 格内算子原尺。内缩后给算子边框留出空间。 */
export const TOKEN_INSET_RATIO = 0.94
export const TOKEN_SIZE_PX = (HEX_ROW_SPACING_PX * 2 * TOKEN_INSET_RATIO) / (1 + Math.sqrt(3))

export interface StackFanSlot {
  /** 原令牌数组的下标。 */
  index: number
  x: number
  y: number
  size: number
}

export interface StackFanLayout {
  /** 先画的在下，后画的在上。 */
  slots: readonly StackFanSlot[]
  pageStart: number
  total: number
  pageCount: number
  page: number
  pageBadge: { x: number; y: number; radius: number } | null
}

/**
 * 1–4 枚的**不重叠**排布（坐标以外接圆半径为单位）
 *
 * ★ 用户 2026-11-18：「完全显示」＝算子不重叠、能看全。
 *   2 枚左右并排（边长 0.6×原尺，刚好贴住）；3/4 枚用 2×2 的四个角位，边长 0.52×原尺，
 *   四角落在 `x + y/√3 = 0.978R < R` 内 ⇒ 既不重叠也不越出六角格。
 */
const POSITIONS = [
  [],
  [[0, 0]],
  [
    [-0.36, 0],
    [0.36, 0],
  ],
  [
    [-0.31, -0.31],
    [0.31, -0.31],
    [0, 0.31],
  ],
  [
    [-0.31, -0.31],
    [0.31, -0.31],
    [-0.31, 0.31],
    [0.31, 0.31],
  ],
] as const
const SIZE_RATIOS = [1, 1, 0.6, 0.52, 0.52] as const

export function normalizePage(page: number, total: number): number {
  return Number.isInteger(page) ? Math.max(0, Math.min(page, pageCountOf(total) - 1)) : 0
}

export function pageCountOf(total: number): number {
  return Math.max(1, Math.ceil(total / STACK_FAN_PAGE_SIZE))
}

/** 第一页优先铺顶层，单页按底到顶的顺序绘制。 */
export function stackFanLayout(input: {
  hex: HexRef
  total: number
  page?: number
  order?: readonly number[]
}): StackFanLayout {
  const center = hexCanvasPoint(input.hex)
  const total = Math.max(0, Math.trunc(input.total))
  const pageCount = pageCountOf(total)
  const page = normalizePage(input.page ?? 0, total)
  const pageStart = page * STACK_FAN_PAGE_SIZE
  const visible = Math.min(STACK_FAN_PAGE_SIZE, total - pageStart)
  const order = input.order?.slice(total - pageStart - visible, total - pageStart)
  const size = TOKEN_SIZE_PX * (SIZE_RATIOS[visible] ?? 1)
  const slots = (POSITIONS[visible] ?? []).map(([dx, dy], index) => ({
    index: order?.[index] ?? pageStart + index,
    x: center.x + dx * HEX_RADIUS_PX - size / 2,
    y: center.y + dy * HEX_RADIUS_PX - size / 2,
    size,
  }))
  return {
    slots,
    pageStart,
    total,
    pageCount,
    page,
    pageBadge:
      pageCount > 1
        ? { x: center.x + 0.8 * HEX_RADIUS_PX, y: center.y, radius: 0.16 * HEX_RADIUS_PX }
        : null,
  }
}

export function isNoncombatTokenLike(token: {
  air?: boolean
  noncombatKind?: string | null
}): boolean {
  return token.air === true || token.noncombatKind != null
}

export type StackFanHit =
  { kind: 'slot'; index: number } | { kind: 'page'; nextPage: number } | null

export function insideCounter(
  point: { x: number; y: number },
  center: { x: number; y: number },
  size: number,
): boolean {
  return Math.abs(point.x - center.x) <= size / 2 && Math.abs(point.y - center.y) <= size / 2
}

export function counterHitSize(size: number, scale: number): number {
  return Math.max(size, STACK_FAN_HIT_SCREEN_PX / scale)
}

/** 先按实际绘制顺序命中图面，再用扩大的触区选最近的一枚。 */
export function hitStackFan(input: {
  layout: StackFanLayout
  point: { x: number; y: number }
  scale?: number
}): StackFanHit {
  const { layout, point, scale = 1 } = input
  const badge = layout.pageBadge
  if (badge !== null && Math.hypot(point.x - badge.x, point.y - badge.y) <= badge.radius) {
    return { kind: 'page', nextPage: (layout.page + 1) % layout.pageCount }
  }
  let nearest: StackFanSlot | null = null
  let minDistance = Infinity
  for (let i = layout.slots.length - 1; i >= 0; i -= 1) {
    const slot = layout.slots[i]!
    const center = { x: slot.x + slot.size / 2, y: slot.y + slot.size / 2 }
    if (insideCounter(point, center, slot.size)) return { kind: 'slot', index: slot.index }
    if (!insideCounter(point, center, counterHitSize(slot.size, scale))) continue
    const distance = Math.hypot(point.x - center.x, point.y - center.y)
    if (distance < minDistance) {
      nearest = slot
      minDistance = distance
    }
  }
  return nearest === null ? null : { kind: 'slot', index: nearest.index }
}

export function defaultSelectionOf(selectableIds: readonly string[]): string[] {
  return [...selectableIds]
}

export function toggleSelection(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id]
}
