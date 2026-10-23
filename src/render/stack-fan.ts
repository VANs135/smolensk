import type { HexRef } from '@/data'

import { HEX_RADIUS_PX, hexCanvasPoint } from './map-layout'

/**
 * **就地展开堆叠**的布局与命中（B2，用户 2026-09-16 #1）
 *
 * 用户口径：「点击堆叠后的拾取**不是指把单位捡起来**，而是在地图上的格子里展开堆叠，
 * 让玩家一眼看出堆叠里有什么，此时**默认是全选堆叠**，被选择单位可以高亮边框，
 * 玩家再点击高亮边框单位可以取消选择，而不需要在别的页面点击取消」。
 *
 * 本模块只算**几何**（每枚摆在哪、点哪里命中哪一枚），不碰状态、不做规则判断：
 *   · 布局按枚数分档（1 / 2 / 3–4 / >4），全部**收在格内**（不越格边 ⇒ 点相邻格仍是点相邻堆叠）；
 *   · >4 枚时用「2×2 + 角标 +n」分页，**点角标翻页**（不弹新窗）；
 *   · 命中是矩形（返回的坐标是世界坐标，命中判定在世界坐标里做）。
 */

/**
 * 展开时同一格最多**平铺**几枚（超过即分页）
 *
 * 4 = 2×2：flat-top 六角格的内接正方形边长约 1.73R，四等分后每枚约 0.86R，
 * 与算子图定尺（格内接正方形）相称；再多就该分页了。
 */
export const STACK_FAN_PAGE_SIZE = 4

/** 展开布局的一枚（世界坐标的左上角与边长） */
export interface StackFanSlot {
  /** 该枚在原堆叠里的下标（0 = 底层；与调用方的顺序一致） */
  index: number
  /** 左上角（世界坐标） */
  x: number
  y: number
  /** 边长（世界坐标） */
  size: number
}

/** 展开布局结论 */
export interface StackFanLayout {
  /** 本页的槽位（自上而下按绘制序：先画的在下、后画的在上） */
  slots: readonly StackFanSlot[]
  /** 本页在整体里的起始下标 */
  pageStart: number
  /** 总枚数 */
  total: number
  /** 总页数（≥1） */
  pageCount: number
  /** 本页页码（0 起） */
  page: number
  /** 分页角标的中心（世界坐标；无分页时为 null） */
  pageBadge: { x: number; y: number; radius: number } | null
}

/** 展开的枚边长（世界坐标）：格内接正方形的 0.45 ⇒ 四枚并排仍不越格 */
export const STACK_FAN_SLOT_RATIO = 0.45

/** 单枚（1 枚时不展开）的边长＝算子图定尺，与 token-layer 的 TOKEN_SIZE_PX 一致 */
export const STACK_FAN_SINGLE_RATIO = 0.5

/** 归一化页码（负数/越界都回到合法范围；页数至少 1） */
export function normalizePage(page: number, total: number): number {
  const pageCount = pageCountOf(total)
  if (!Number.isInteger(page)) return 0
  if (page < 0) return 0
  if (page >= pageCount) return pageCount - 1
  return page
}

/** 总页数（0 枚也算 1 页，便于调用方无脑渲染） */
export function pageCountOf(total: number): number {
  const count = Math.max(0, Math.trunc(total))
  return Math.max(1, Math.ceil(count / STACK_FAN_PAGE_SIZE))
}

/**
 * 算一格的**展开布局**
 *
 * @param input.hex    格（世界坐标由 `map-layout` 的标定公式给）
 * @param input.total  该格算子总数
 * @param input.page   页码（越界自动夹到合法范围）
 * @param input.columns 各栏的"原堆叠下标"分组（**条 7 / R3**：战斗 | 非战斗两栏）。
 *   缺省＝单栏（保持旧行为，所有下标按原序平铺）；给了就按栏从左到右排，栏内图阵列。
 *   每栏是一串"原堆叠下标"（与调用方 `group` 的顺序一致），命中 `slot.index` 仍＝原下标，
 *   故下游（token-layer 的 `group[slot.index]` 与 `handleStackClick` 的 `tokens[hit.index]`）无需改。
 */
export function stackFanLayout(input: {
  hex: HexRef
  total: number
  page?: number
  columns?: readonly (readonly number[])[]
}): StackFanLayout {
  const center = hexCanvasPoint(input.hex)
  const total = Math.max(0, Math.trunc(input.total))
  const page = normalizePage(input.page ?? 0, total)
  const pageCount = pageCountOf(total)
  const pageStart = page * STACK_FAN_PAGE_SIZE
  const visible = Math.max(0, Math.min(STACK_FAN_PAGE_SIZE, total - pageStart))

  // 旧行为：单栏（不分组 ⇒ 全部按原序平铺，命中 index ＝原下标）
  if (input.columns === undefined) {
    const slots: StackFanSlot[] = []
    const single = total <= 1
    const size = HEX_RADIUS_PX * (single ? STACK_FAN_SINGLE_RATIO : STACK_FAN_SLOT_RATIO)

    if (single || visible === 1) {
      slots.push({ index: pageStart, x: center.x - size / 2, y: center.y - size / 2, size })
    } else {
      const gap = size * 0.12
      const step = size + gap
      const positions =
        visible === 2
          ? [
              { dx: -1, dy: -1 },
              { dx: 1, dy: 1 },
            ]
          : [
              { dx: -1, dy: -1 },
              { dx: 1, dy: -1 },
              { dx: -1, dy: 1 },
              { dx: 1, dy: 1 },
            ]
      for (let i = 0; i < visible; i += 1) {
        const position = positions[i]!
        slots.push({
          index: pageStart + i,
          x: center.x + (position.dx * step) / 2 - size / 2,
          y: center.y + (position.dy * step) / 2 - size / 2,
          size,
        })
      }
    }
    return { slots, pageStart, total, pageCount, page, pageBadge: pageBadgeOf(center, pageCount) }
  }

  /*
   * 条 7 / R3：**战斗 | 非战斗两栏**。
   * 每栏**独立**分页（每栏最多 4 枚，>4 仍分页），两栏共享同一页码（某一栏空了就只翻另一栏）；
   * 命中 index ＝原堆叠下标（与单栏一致），故下游（token-layer 的 `group[slot.index]` 与
   * handleStackClick 的 `tokens[hit.index]`）无需改。
   */
  const size = HEX_RADIUS_PX * STACK_FAN_SLOT_RATIO
  const slots: StackFanSlot[] = []
  const combatItems = input.columns[0] ?? []
  const nonCombatItems = input.columns[1] ?? []
  // 整页号取两栏中较大者（每栏各自按 STACK_FAN_PAGE_SIZE 切窗）
  const colPageCount = Math.max(pageCountOf(combatItems.length), pageCountOf(nonCombatItems.length))
  const colPage = Math.max(0, Math.min(colPageCount - 1, Math.trunc(input.page ?? 0)))
  const colGap = size * 0.12
  const colStep = size + colGap
  const bothNonEmpty = combatItems.length > 0 && nonCombatItems.length > 0
  const colOffsetX = bothNonEmpty ? (colStep * 1.15) / 2 : 0
  const columnsLayout: { items: readonly number[]; offset: number }[] = [
    {
      items: combatItems.slice(
        colPage * STACK_FAN_PAGE_SIZE,
        colPage * STACK_FAN_PAGE_SIZE + STACK_FAN_PAGE_SIZE,
      ),
      offset: bothNonEmpty ? -colOffsetX : 0,
    },
    {
      items: nonCombatItems.slice(
        colPage * STACK_FAN_PAGE_SIZE,
        colPage * STACK_FAN_PAGE_SIZE + STACK_FAN_PAGE_SIZE,
      ),
      offset: bothNonEmpty ? colOffsetX : 0,
    },
  ]
  for (const { items, offset } of columnsLayout) {
    if (items.length === 0) continue
    const colCenterX = center.x + offset
    if (items.length <= 2) {
      const startY = center.y - ((items.length - 1) * colStep) / 2
      items.forEach((orig, i) => {
        slots.push({
          index: orig,
          x: colCenterX - size / 2,
          y: startY + i * colStep - size / 2,
          size,
        })
      })
    } else {
      const positions = [
        { dx: -1, dy: -1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: 1 },
        { dx: 1, dy: 1 },
      ]
      items.forEach((orig, i) => {
        const p = positions[i]!
        slots.push({
          index: orig,
          x: colCenterX + (p.dx * colStep) / 2 - size / 2,
          y: center.y + (p.dy * colStep) / 2 - size / 2,
          size,
        })
      })
    }
  }
  return {
    slots,
    pageStart,
    total,
    pageCount: colPageCount,
    page: colPage,
    pageBadge: pageBadgeOf(center, colPageCount),
  }
}

/** 分页角标（格右下角内沿；与枚区错开） */
function pageBadgeOf(
  center: { x: number; y: number },
  pageCount: number,
): { x: number; y: number; radius: number } | null {
  return pageCount > 1
    ? {
        x: center.x + HEX_RADIUS_PX * 0.5,
        y: center.y + HEX_RADIUS_PX * 0.5,
        radius: HEX_RADIUS_PX * 0.18,
      }
    : null
}

/**
 * 条 7 / R3：判定某枚令牌是否「非战斗」（停机场的飞机 `air`，或带 `noncombatKind` 的单位）。
 * 用结构类型即可，不引入领域模型。
 */
export function isNoncombatTokenLike(token: {
  air?: boolean
  noncombatKind?: string | null
}): boolean {
  return token.air === true || (token.noncombatKind !== undefined && token.noncombatKind !== null)
}

/**
 * 把堆叠令牌按「战斗 | 非战斗」分栏（条 7 / R3）。
 *
 * 返回每栏的"原堆叠下标"（与 `stackFanLayout` 的 `columns` 契约一致）；
 * 纯战斗堆（无非战斗令牌）退回 `undefined` ⇒ 调用方走单栏旧行为（保留 1 枚用 SINGLE_RATIO 等细节）。
 */
export function combatNoncombatColumns(
  tokens: readonly { air?: boolean; noncombatKind?: string | null }[],
): readonly (readonly number[])[] | undefined {
  const combat: number[] = []
  const nonCombat: number[] = []
  tokens.forEach((token, i) => {
    if (isNoncombatTokenLike(token)) nonCombat.push(i)
    else combat.push(i)
  })
  if (nonCombat.length === 0) return undefined
  return [combat, nonCombat]
}

/** 展开态的命中结果 */
export type StackFanHit =
  { kind: 'slot'; index: number } | { kind: 'page'; nextPage: number } | null

/** 点是否落在矩形内（世界坐标） */
function insideRect(
  point: { x: number; y: number },
  rect: { x: number; y: number; size: number },
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.size &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.size
  )
}

/**
 * 命中判定（世界坐标）
 *
 * 取序：**分页角标优先**（它压在最上），再按**后画的先命中**（栅格右上 > 左下，与视觉一致）。
 * 未命中任何枚即返回 null ⇒ 调用方据此"点空白收起展开"。
 */
export function hitStackFan(input: {
  layout: StackFanLayout
  point: { x: number; y: number }
}): StackFanHit {
  const { layout, point } = input
  const badge = layout.pageBadge
  if (badge !== null) {
    const dx = point.x - badge.x
    const dy = point.y - badge.y
    if (dx * dx + dy * dy <= badge.radius * badge.radius) {
      return { kind: 'page', nextPage: (layout.page + 1) % layout.pageCount }
    }
  }
  for (let i = layout.slots.length - 1; i >= 0; i -= 1) {
    const slot = layout.slots[i]!
    if (insideRect(point, slot)) return { kind: 'slot', index: slot.index }
  }
  return null
}

/**
 * **默认全选**（用户口径）——展开时把整堆都放进选择集
 *
 * 返回的是一份新数组（调用方自行决定存哪）；不参与本环节的算子**不在入参里**，
 * 故「默认全选」天然只覆盖"可参与的那些"。
 */
export function defaultSelectionOf(selectableIds: readonly string[]): string[] {
  return [...selectableIds]
}

/**
 * 点某一枚 = **切换**它的选择（用户口径：再点高亮边框的那枚即取消）
 *
 * 返回新的选择集（保持原有顺序，便于界面稳定）。
 */
export function toggleSelection(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id]
}
