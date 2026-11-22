import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { scenarios } from '@/data'
import { useWorkbenchStore } from '@/stores'

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`
const parse = (text: string): HexRef => {
  const [col, row] = text.split('.').map(Number)
  return { col: col!, row: row! }
}

/** 标记格列表（`Marker.hex` 声明可空，端头标记一定带格，这里只取有格的） */
const markerLabels = (markers: readonly { hex: HexRef | null }[]): string[] =>
  markers.flatMap((marker) => (marker.hex === null ? [] : [label(marker.hex)])).sort()

/**
 * 13.3d / 13.3f：Railhead 标记与剧本页印的端头一致
 *
 * 剧本页 `Converted Axis Rails: A to B` 的 B 端就是初设 Railhead 所在格（`setup.railheads`），
 * 端头推导必须逐一复现它们——包括交汇格（剧本 7 的 18.18 / Orsha，有三个已换轨邻格、
 * 往北 18.19 仍是宽轨），逐格法会把它当交汇点跳过，故 store 侧合用了段端法。
 */
function boot(id: string): ReturnType<typeof useWorkbenchStore> {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  store.setScenarioId(id)
  store.seedConvertedRailsNow()
  return store
}

describe('13.3f：railhead 标记 = 剧本页端头（逐剧本）', () => {
  for (const scenario of scenarios.scenarios) {
    if (scenario.setup.railheads === undefined) continue
    it(`剧本 ${scenario.id}：${scenario.setup.railheads.hexes.join(' / ')}`, () => {
      const store = boot(scenario.id)
      const printed = scenario.setup.railheads!.hexes.map((text) => label(parse(text))).sort()
      expect(markerLabels(store.railheadMarkers)).toEqual(printed)
    })
  }

  it('剧本 7：18.18（Orsha）在列，且标记 id 与 hex 同源', () => {
    const store = boot('7')
    expect(markerLabels(store.railheadMarkers)).toContain('18.18')
    const orsha = store.railheadMarkers.find(
      (marker) => marker.hex !== null && label(marker.hex) === '18.18',
    )
    expect(orsha, '剧本 7 缺 18.18（Orsha）端头').toBeTruthy()
    expect(orsha!.id).toBe('mk-38:18.18')
    expect(orsha!.recordId).toBe('mk-38')
  })

  it('剧本 7：越段推进 18.19 ⇒ 段端 18.18 让位、新前沿 18.19 出现', () => {
    const store = boot('7')
    expect(markerLabels(store.railheadMarkers)).toContain('18.18')
    store.convertedRailHexes.push(label({ col: 18, row: 19 }))
    expect(markerLabels(store.railheadMarkers)).not.toContain('18.18')
    expect(markerLabels(store.railheadMarkers)).toContain('18.19')
  })

  it('清空换轨账本后不再出端头（标记是账本的派生事实）', () => {
    const store = boot('7')
    expect(store.railheadMarkers.length).toBeGreaterThan(0)
    store.clearConvertedRailsNow()
    expect(store.railheadMarkers).toEqual([])
  })
})
