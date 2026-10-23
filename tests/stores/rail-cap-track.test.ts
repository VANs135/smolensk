import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useContainersStore, useWorkbenchStore } from '@/stores'

/**
 * B31c：**运力记录轨**（用户 2026-09-16 交付标定 + 口径）
 *
 * 「`Rail-Sea-Cap.boxes.json` 这个我标定好了，**运力标记显示在这上面，会根据当前使用情况自动推格子**」。
 *
 * 三件事：
 *   ① 标定进了**源库**（`…斯摩棱斯克工程数据库\aux_cards.json` 7 张卡）→ 同步脚本生成产物，
 *      故"渲染侧照标定摆"这条链与其余 6 张卡完全同源；
 *   ② 卡是 **`side: 'both'`**（双方共用：一张卡上两组轨）⇒ 走 `sharedCardViews`，与两侧的方别卡分列；
 *   ③ **当前格由引擎给的当前容量点灯**（`railCapTrackView` 的 `current`，随专规 1.2 的日期/升级日变），
 *      界面不自己算 —— 这就是"自动推格子"。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), containers: useContainersStore() }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B31c：运力记录轨（Rail-Sea-Cap）', () => {
  it('★ 卡与 14 个格都在产物里（标定经源库 → 同步脚本进来，不是手写）', () => {
    const { containers } = newStores()
    const card = containers.cardViews.find((view) => view.id === 'rail-sea-cap')
    expect(card, 'rail-sea-cap 卡应在产物里').toBeDefined()
    expect(card?.side).toBeNull() // side: 'both' ⇒ 投影成 null（双方共用）
    expect(card?.regions).toHaveLength(14)
    // 格标照用户标定原样（1SP–10SP 主轨 + 0T–3T 副轨）
    const labels = card!.regions.map((region) => region.label)
    expect(labels.slice(0, 3)).toEqual(['1SP', '2SP', '3SP'])
    expect(labels.slice(10)).toEqual(['0T', '1T', '2T', '3T'])
  })

  it('★ 共用卡单独一列（不与方别卡混列）', () => {
    const { containers } = newStores()
    const shared = containers.sharedCardViews.map((card) => card.id)
    expect(shared).toEqual(['rail-sea-cap'])
    for (const side of ['axis', 'soviet'] as const) {
      expect(containers.cardViewsOf(side).every((card) => card.id !== 'rail-sea-cap')).toBe(true)
    }
  })

  it('★ 运力标记**自动推格子**：点灯的那一格＝引擎给的当前容量（不是界面自己算的）', () => {
    const { workbench, containers } = newStores()

    // 当前容量（苏联，初始 2；专规 1.2 的升级在 19 Jul）
    const cell = containers.railCapCell
    expect(cell).not.toBeNull()
    const litLabels = () =>
      containers.cardViews
        .find((view) => view.id === 'rail-sea-cap')!
        .regions.filter((region) => region.active === true)
        .map((region) => region.label)

    // 该格与 railCapCell 一致（主轨：标签的数字部分）
    for (const label of litLabels()) {
      expect(label.replace(/[^0-9]/g, '')).toBe(cell)
    }

    // 换到另一方的容量（切方）⇒ 点灯格随之变（若两方容量相同则不构成反例，故只在不同时断言）
    const before = containers.railCapCell
    workbench.switchSide()
    const after = containers.railCapCell
    if (before !== after) {
      const now = containers.cardViews
        .find((view) => view.id === 'rail-sea-cap')!
        .regions.filter((region) => region.active === true)
        .map((region) => region.label.replace(/[^0-9]/g, ''))
      expect(now).toEqual([after])
    }
  })

  it('★ 源码守卫：托盘把共用卡单列一行；活动格用金色标记画出来', () => {
    const tray = readFileSync('src/components/game/BottomTray.vue', 'utf8')
    expect(tray).toContain('containers.sharedCardViews')
    expect(tray).toContain('共用')
    // B35 切片 C-2：卡面抽成 `BoxCardFace.vue` ⇒ 金色活动格画在那一件里（类名前缀随之变）
    const face = readFileSync('src/components/game/BoxCardFace.vue', 'utf8')
    expect(face).toContain("'face__region--active': region.active === true")
    expect(face).toContain('.face__region--active')
    const store = readFileSync('src/stores/containers.ts', 'utf8')
    expect(store).toContain('const railCapCell = computed')
    expect(store).toContain("region.boxKind === 'capacity_track'")
  })
})
