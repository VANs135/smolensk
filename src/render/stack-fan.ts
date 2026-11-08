import type { HexRef } from '@/data'

import { HEX_RADIUS_PX, HEX_ROW_SPACING_PX, hexCanvasPoint } from './map-layout'

export const STACK_FAN_PAGE_SIZE = 6
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

/** 坐标以外接圆半径为单位。重叠时每枚仍保留可独立点击的中心。 */
const POSITIONS = [
  [],
  [[0, 0]],
  [
    [-0.28, 0],
    [0.28, 0],
  ],
  [
    [-0.24, -0.2],
    [0.24, -0.2],
    [0, 0.42],
  ],
  [
    [-0.24, -0.34],
    [0.24, -0.34],
    [-0.24, 0.34],
    [0.24, 0.34],
  ],
  [
    [-0.2, -0.4],
    [0.2, -0.4],
    [-0.355, 0.15],
    [0, 0.15],
    [0.355, 0.15],
  ],
  [
    [-0.34, -0.32],
    [0, -0.32],
    [0.34, -0.32],
    [-0.34, 0.32],
    [0, 0.32],
    [0.34, 0.32],
  ],
] as const
const SIZE_RATIOS = [1, 1, 0.74, 0.68, 0.58, 0.58, 0.5] as const

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
