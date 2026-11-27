import { computed, type ComputedRef } from 'vue'

import { useHotseatStore, useOnlineStore } from '@/stores'

import type { BoxRailGroup } from './box-rail'

/**
 * 联机棋桌的 UI 隔离投影
 *
 * 只做两件界面层的事，不参与规则：
 *   · `onlineWaiting`：不是本机写入窗口时，收起会改盘面的窗口与「进入下一环节」；
 *   · `boxRailGroups`：左栏只列本阵营 + 共用盒，避免从盒入口看对方盒。
 *
 * 判据与 `online.canWrite` 同源（初设游标 / 待答方 / 战斗角色 / 环节方）；
 * 可信玩家前提下不在这里做任何防作弊校验。
 */
export function useOnlineTableIsolation(allGroups: ComputedRef<BoxRailGroup[]>): {
  onlineWaiting: ComputedRef<boolean>
  boxRailGroups: ComputedRef<readonly BoxRailGroup[]>
} {
  const online = useOnlineStore()
  const hotseat = useHotseatStore()

  const onlineWaiting = computed<boolean>(
    () => online.active && !online.canWrite && online.stage !== 'setup',
  )
  const boxRailGroups = computed<readonly BoxRailGroup[]>(() =>
    online.active
      ? allGroups.value.filter(
          (group) => group.key === hotseat.viewerSide || group.key === 'shared',
        )
      : allGroups.value,
  )

  return { onlineWaiting, boxRailGroups }
}
