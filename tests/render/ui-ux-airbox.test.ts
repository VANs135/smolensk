/**
 * 地图外空军盒三处修复（用户 2026-11-16）
 *
 * ① 激活态画在算子本身（未激活压暗），不再用算子下方 I/A 小字；
 * ② 盒内右键有真实出口：`CounterPicker` 发 context ⇒ 名册摆出 14.11 转场（无可用项则不摆）；
 * ③ 「返场落点（死亡堆 → 图）」是 1.6c 的死亡堆动作，不再漏进空军盒窗口。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('空军盒三处修复', () => {
  it('① 激活态改用算子压暗，去掉 I/A 角标', () => {
    const roster = read('src/components/air/AircraftRoster.vue')
    expect(roster).not.toContain('badge: air.airStatus')
    expect(roster).toContain("dimmed: air.airStatus !== 'active'")

    const picker = read('src/components/game/CounterPicker.vue')
    expect(picker).toContain('dimmed?: boolean')
    expect(picker).toContain("'picker__cell--dim': item.dimmed === true")
    expect(picker).toContain('picker__cell--dim {')
  })

  it('② 盒内右键接上既有 14.11 转场（无可用项不出现）', () => {
    const picker = read('src/components/game/CounterPicker.vue')
    expect(picker).toContain("(e: 'context', id: string): void")
    expect(picker).toContain('@contextmenu.prevent="emit(\'context\', item.id)"')

    const roster = read('src/components/air/AircraftRoster.vue')
    expect(roster).toContain('@context="onContext"')
    expect(roster).toContain('canTransferToBase')
    expect(roster).toContain('v-if="canTransferToBase"')
    expect(roster).toContain('mapView.startBoxTransfer')
  })

  it('③ 返场落点只属于死亡堆，不漏进空军盒窗口', () => {
    const panel = read('src/components/containers/ContainersPanel.vue')
    // 2026-11-18：死亡堆改成盒贴图右键菜单 ⇒ 会话窗（actions）里不再铺这条；验证/裁判页仍可点
    expect(panel).toContain(
      '<div v-if="props.only !== \'actions\' && showsBoxActions(\'deadPile\')" class="field">',
    )
    expect(panel).toContain('返场落点（死亡堆 → 图）')
    expect(read('src/stores/map-view.ts')).toContain("'deadPile.returnHex'")
  })
})
