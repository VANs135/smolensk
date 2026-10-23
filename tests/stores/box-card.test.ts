import { existsSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { auxCards } from '@/data'
import { REGION_OF_BOX, boxOfRegion } from '@/engine/rules'
import { useContainersStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { auxCardImageUrl } from '@/components/game/aux-card-image'

/**
 * B12：盒卡（辅助卡卡面 + 分区 + 区内容物）与底部托盘
 *
 * 用户口径⑧：「盒与表格都显示在**地图窗口下方**，但**每个也可以折叠**」；④「盒也是折叠打开（**同时只展开一张**）」。
 *
 * 本文件钉四件事：
 *   ① **分区↔盒**的对应表齐备（数据侧 15 个分区种类都能查到去处，或**如实标注**没有）；
 *   ② 卡面投影：每张卡的每个分区都给出矩形 / 规则号 / 区内容物（区内容物**按栏**取自引擎名册）；
 *   ③ 卡面图 URL 与已拷进 `public/aux-cards/` 的图档**对得上**（脚本搬过、数据引用的名字一致）；
 *   ④ 折叠：同时只展开一张（`cardOpenId` 语义）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    containers: useContainersStore(),
    setup: useSetupStore(),
    workbench: useWorkbenchStore(),
  }
}

describe('B12：分区 ↔ 盒的对应', () => {
  it('数据侧出现过的分区种类都在对应表里（不猜、也不留悬空）', () => {
    const kinds = new Set<string>()
    for (const card of auxCards.cards) for (const region of card.regions) kinds.add(region.boxKind)
    expect(kinds.size).toBeGreaterThan(0)
    for (const kind of kinds) {
      /*
       * B31c：`capacity_track` 是**记录轨**（Rail-Sea-Cap 卡上的 1SP–10SP / 0T–3T），
       * 它不是"装算子的盒"，故不落 `REGION_OF_BOX`；容量标记由 store 的运力格投影点灯。
       */
      if (kind === 'capacity_track') continue
      expect(REGION_OF_BOX[kind], `分区 ${kind} 在对应表里没有去处`).toBeDefined()
      expect(boxOfRegion(kind)).not.toBeNull()
    }
    // 反空转：对应表里的种类都要有规则号（不许留空当占位）
    for (const [kind, target] of Object.entries(REGION_OF_BOX)) {
      expect(target.rule.length, `${kind} 缺规则号`).toBeGreaterThan(0)
    }
  })

  it('空军盒按 14.1a 分成 Active / Inactive 两栏（不是同一栏）', () => {
    const active = boxOfRegion('air_box_active')!
    const inactive = boxOfRegion('air_box_inactive')!
    expect(active.boxKind).toBe('airBox')
    expect(inactive.boxKind).toBe('airBox')
    expect(active.sectionId).not.toBe(inactive.sectionId)
  })

  it('不对应盒栏的分区**如实标注**（如"标记存放"装的是标记，不是名册里的单位）', () => {
    expect(boxOfRegion('markers')!.sectionId).toBeNull()
  })
})

describe('B12：卡面投影（分区 + 区内容物）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    stores.setup.selectScenario('1')
  })

  it('每张卡都有卡面尺寸、图档名与分区（矩形在卡面内）', () => {
    const cards = stores.containers.cardViews
    expect(cards).toHaveLength(auxCards.cards.length)
    for (const card of cards) {
      expect(card.imageSize.w).toBeGreaterThan(0)
      expect(card.image.length).toBeGreaterThan(0)
      expect(card.regions.length).toBeGreaterThan(0)
      for (const region of card.regions) {
        expect(region.rect.w).toBeGreaterThan(0)
        expect(region.rect.x + region.rect.w).toBeLessThanOrEqual(card.imageSize.w)
        expect(region.rect.y + region.rect.h).toBeLessThanOrEqual(card.imageSize.h)
      }
    }
  })

  it('★ 区内容物**按栏**取自引擎名册：分区装的是它对应的那个盒那一栏的单位', () => {
    const { containers } = stores
    // 轴心死人堆：卡上 1 个分区，内容＝deadPile 盒 main 栏
    const deadCard = containers.cardViews.find((card) => card.id === 'axis-dead-pile')!
    const deadRegion = deadCard.regions[0]!
    const deadBox = containers.boxOf('deadPile', 'axis')!
    expect(deadRegion.units.map((unit) => unit.unitId)).toEqual(
      deadBox.holdings.filter((holding) => holding.sectionId === 'main').map((unit) => unit.unitId),
    )

    // 空军盒：激活/未激活两栏各取各的
    const airCard = containers.cardViews.find((card) => card.id === 'axis-airfields')!
    const active = airCard.regions.find((region) => region.kind === 'air_box_active')!
    const inactive = airCard.regions.find((region) => region.kind === 'air_box_inactive')!
    for (const region of [active, inactive]) {
      expect(region.rule).toBe('14.1a')
      for (const unit of region.units) {
        expect(unit.sectionId).toBe(region.kind === 'air_box_active' ? 'active' : 'inactive')
      }
    }
  })

  it('空区如实分两种：**结构性缺盒/缺栏**必须写明原因；"盒在、栏里暂时没东西"就是 0（不臆造内容）', () => {
    for (const card of stores.containers.cardViews) {
      for (const region of card.regions) {
        const target = boxOfRegion(region.kind)
        /*
         * B31c：`capacity_track`（Rail-Sea-Cap 卡上的格）不是盒的分区 —— 它是对局里
         * **放标记的记录轨格**（当前容量所在格由界面点灯），既不"缺盒"也不"缺栏"。
         */
        if (region.kind === 'capacity_track') {
          expect(region.units).toEqual([])
          continue
        }
        /*
         * ★ 契约变更（批 D 切片 2，用户 9.16 #15，**不是放宽**）：`markers`（标记存放盒）**不再算"结构性缺栏"**——
         *   它装的正是**建造标记**（专规 3.5：剧本 1/2 各 3 枚），投影按剩余枚数给内容物。
         *   本条替它加两条**新**判据：必须有说明；轴方卡上的枚数＝`workbench.constructionMarkers`。
         *   其余 `sectionId === null` 的分区照旧必须"有说明 + 无内容物"。
         */
        if (region.kind === 'markers') {
          expect(region.note, `${card.id}/${region.id} 标记盒没有说明`).not.toBeNull()
          if (card.side === 'axis') {
            expect(region.units).toHaveLength(stores.workbench.constructionMarkers)
            expect(region.units[0]?.unitId).toBe('construction-marker:1')
          } else {
            expect(region.units).toEqual([])
            expect(region.note ?? '').toContain('轴方')
          }
          continue
        }
        if (target === null || target.sectionId === null) {
          // 结构性缺：必须给出说明，且**不许有内容物**
          expect(region.note, `${card.id}/${region.id} 结构性缺栏却没说明`).not.toBeNull()
          expect(region.units).toEqual([])
          continue
        }
        if (region.units.length > 0) continue
        // 盒在、栏空：允许 note 为 null（那就是"这一栏暂时没东西"），但结论必须是"盒确实存在"
        const box = stores.containers.boxOf(target.boxKind, card.side ?? undefined)
        expect(box, `${card.id}/${region.id} 没有对应的盒，却也没有说明`).not.toBeNull()
      }
    }
  })
})

describe('B12：卡面图（URL 与产物目录）', () => {
  it('URL 编码后仍指向 `/aux-cards/` 下的图（名字含空格与大写）', () => {
    const url = auxCardImageUrl('German Dead Pile.png')
    expect(url.startsWith('/aux-cards/')).toBe(true)
    // 空格被编码（否则某些环境取不到图）
    expect(url).not.toContain(' ')
    expect(decodeURIComponent(url.slice('/aux-cards/'.length))).toBe('German Dead Pile.png')
  })

  it('数据侧引用的 6 张图都在 `public/aux-cards/` 里（脚本搬过、名字对得上）', () => {
    // 读产物目录：这条守的是"图真的进了可服务目录"，不是"数据里写了名字"
    for (const card of auxCards.cards) {
      expect(existsSync(`public/aux-cards/${card.image}`), `缺卡面图：${card.image}`).toBe(true)
    }
  })
})

describe('B12：折叠（同时只展开一张卡）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    stores.setup.selectScenario('1')
  })

  it('默认一张都不展开；点一张即展开它，点第二张即换过去（只留一张）', () => {
    const { containers } = stores
    expect(containers.cardOpenId).toBeNull()

    containers.toggleCardOpen('axis-dead-pile')
    expect(containers.cardOpenId).toBe('axis-dead-pile')

    containers.toggleCardOpen('soviet-dead-pile')
    expect(containers.cardOpenId).toBe('soviet-dead-pile')

    // 再点同一张 ⇒ 收起
    containers.toggleCardOpen('soviet-dead-pile')
    expect(containers.cardOpenId).toBeNull()
  })
})
