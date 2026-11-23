import type { CounterPickerItem } from '@/components/game'
import { counterImageUrlOf, type ConsoleAirUnit } from '@/stores'

/**
 * 14.3e-B 守方（对手）自己点名时，面板上那张**只读**阵列怎么摆（用户 2026-11-23 第 6 批）
 *
 * 「空战时是能看到对方单位的，对方选不代表看不到」——守方由 AI / 脚本接管时，
 * 点名不是玩家的操作，但"对方有哪些机、派了哪一架"必须看得见。修前这一侧整块被收掉，
 * 面板只剩一句"由对手操作"，玩家连对方带了几架都不知道。
 *
 * 选中＝已记录的点名（脚本 / PvE 会写进 `airCombatPicks`）；没记录时按引擎缺省
 * （ACV 最高）标出来 —— 玩家看到的就是实际交手的那一架。名字只进 title，图上不叠字。
 *
 * 单独成模块而不是塞进 `AirPanel.vue`：那张面板已顶到 `max-lines` 上限，纯投影逻辑搬出来
 * 不改任何规则（组件仍只做「把 store 算好的东西画出来」）。
 */
export function buildDefenderDisplayItems(
  planes: readonly ConsoleAirUnit[],
  pickedId: string | null,
): readonly CounterPickerItem[] {
  const fallback =
    [...planes].sort((a, b) => b.airCombatRating - a.airCombatRating)[0]?.instanceId ?? null
  const chosen = pickedId ?? fallback
  return planes.map((air) => ({
    id: air.instanceId,
    imageUrl: counterImageUrlOf(air),
    name: `${air.name}（ACV ${air.airCombatRating}）${air.instanceId === chosen ? '｜对手点名' : ''}`,
    selected: air.instanceId === chosen,
    hex: air.hex,
  }))
}
