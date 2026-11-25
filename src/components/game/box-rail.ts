/**
 * 左栏盒组（2026-11-26 用户 v5 口径）：一盒一枚、压在左栏最上，点开就是该盒的贴图窗。
 *
 * 这一小块从 `GameTableView.vue` 抽出来，理由有两条：
 *   ① 棋桌页已经顶到 `max-lines` 上限，盒组的分组 / 图标 / 挂载清单不该再挤在同一个文件里；
 *   ② 盒入口的**隔离口径**（视角方一列、裁判 / 无雾才两方）是安全判据，
 *      放在独立模块里比埋在 1600 行的模板旁边更好守（`tests/stores/box-side-isolation.test.ts`）。
 *
 * 这里只管"左栏列哪几张卡、画什么图标、挂哪几张卡"，不碰浮窗本身——
 * 浮窗仍是 `BoxCard.vue` 自己的 `Teleport`（可拖、Esc / × 关）。
 */
import { computed, type ComputedRef } from 'vue'

import { useRefereeTools } from '@/components/ui-mode'
import type { Side } from '@/data'
import type { AuxCardView } from '@/stores/containers'
import { useContainersStore } from '@/stores/containers'
import { useHotseatStore } from '@/stores/hotseat'

/** 一组盒（分组字单字：轴 / 苏 / 共） */
export interface BoxRailGroup {
  key: string
  label: string
  cards: AuxCardView[]
}

/**
 * 盒图标（按卡种类，24×24 线框）。
 * 四种必须互相**看得出区别**，且不能跟抽屉那几枚（战况脉冲 / 表井 / 战报纸）撞形：
 * 空军盒＝飞机剪影、死人堆＝墓碑、地图外盒＝出框箭头、容量轨＝刻度尺。
 */
const BOX_ICON_PATH: Record<string, string> = {
  dead_pile: 'M7 21V10a5 5 0 0 1 10 0v11 M5 21h14 M12 7.4v6.4 M9.4 10.2h5.2',
  air_box: 'M12 3.4 14 10.8 21 13.2v2.2l-7 .5 1 4.6-2 .9-2-5.2-2 5.2-2-.9 1-4.6-7-.5v-2.2l7-2.4z',
  offboard: 'M13.6 4H6.4v16h11.2v-6.4 M20.4 3.6l-8 8 M14.4 3.6h6v6',
  capacity_track: 'M4 8.4h16v7.2H4z M8 8.4v2.4 M12 8.4v3.6 M16 8.4v2.4',
}

/** 未知种类给一个通用方框，不猜 */
export function boxIconPath(kind: string): string {
  return BOX_ICON_PATH[kind] ?? 'M4 6h16v12H4z'
}

/** 左栏盒组：视角方 + 共用；裁判 / 无雾时两方都列（与盒面板同口径） */
export function useBoxRail(): {
  showsAllSides: ComputedRef<boolean>
  groups: ComputedRef<BoxRailGroup[]>
  anchorCards: ComputedRef<AuxCardView[]>
  iconPath: typeof boxIconPath
} {
  const containers = useContainersStore()
  const hotseat = useHotseatStore()
  const showsReferee = useRefereeTools()
  const showsAllSides = computed<boolean>(() => hotseat.fogDisabled || showsReferee)

  const groups = computed<BoxRailGroup[]>(() => {
    const sides: Side[] = showsAllSides.value ? ['axis', 'soviet'] : [hotseat.viewerSide]
    const list: BoxRailGroup[] = sides.map((side) => ({
      key: String(side),
      label: side === 'axis' ? '轴' : '苏',
      cards: [...containers.cardViewsOf(side)],
    }))
    if (containers.sharedCardViews.length > 0) {
      list.push({ key: 'shared', label: '共', cards: [...containers.sharedCardViews] })
    }
    return list
  })

  /** 挂载用：所有盒卡各挂一份 BoxCard（浮窗由 store 的 popupCardId 决定出哪一张） */
  const anchorCards = computed<AuxCardView[]>(() => groups.value.flatMap((g) => g.cards))

  return { showsAllSides, groups, anchorCards, iconPath: boxIconPath }
}
