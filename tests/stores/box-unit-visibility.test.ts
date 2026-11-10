import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useContainersStore, useWorkbenchStore } from '@/stores'

/**
 * ⑤ 盒内单位（用户 2026-11-09）
 *
 * 现场：图外各盒（死亡堆 / 空军盒 / 东北·东南入场盒）显示成**空框**，盒里已有单位却看不到。
 *
 * 根因（修前）：`BoxCardFace` 只在 `counterImages.get(url) !== null` 时才画 `<img>`，
 * 而盒内算子的图**从来没有被预载**（只预载了卡面图）⇒ 每枚都落到空占位 `span`。
 *
 * 本组用例钉住：
 *   · 盒内单位在 store 侧确实有内容（不是数据/入盒入口的问题）；
 *   · 卡面**会把盒内算子的图读进来**并画出来（源码守卫，与 `box-textures.test.ts` 同一套做法）；
 *   · 盒内算子可点选、可右键（沿用既有「展开盒卡 → 盒内动作会话」口径）；
 *   · 按方过滤：方别卡只含本方盒；死亡堆双方可见（既有事实）。
 */

const ROOT = join(__dirname, '..', '..')
const FACE = readFileSync(join(ROOT, 'src/components/game/BoxCardFace.vue'), 'utf8')

const HEX: HexRef = { col: 30, row: 12 }

function recordOf() {
  const found = unitChoices('axis').find((record) => record.isCombat === true)
  if (found === undefined) throw new Error('单位库中没有轴心国战斗单位')
  return found
}

function setup() {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), containers: useContainersStore() }
}

describe('⑤ 盒内单位：看得见、点得到', () => {
  it('★ 入盒后盒内可见：死亡堆有条目，卡面分区拿到贴图 URL', () => {
    const { workbench, containers } = setup()
    const unit = toConsoleUnit({
      record: recordOf(),
      instanceId: 'ax-dead-1',
      hex: HEX,
      side: 'axis',
    })
    workbench.deadPile.push(unit)

    const inPile = containers.deadPileUnits.axis.find((item) => item.id === 'ax-dead-1')
    expect(inPile, '死亡堆里应有刚入盒的算子').toBeDefined()

    const deadCard = containers.cardViews.find((item) =>
      item.regions.some((region) => region.units.some((u) => u.unitId === 'ax-dead-1')),
    )
    expect(deadCard, '应有一张卡的某个分区装着这枚算子').toBeDefined()
    const holding = deadCard!.regions
      .flatMap((region) => region.units)
      .find((item) => item.unitId === 'ax-dead-1')!
    expect(holding.imageUrl, '盒内算子必须带贴图 URL（组件不再拼文件名）').not.toBeNull()
  })

  it('★ 卡面把盒内算子的图读进来（修前从不预载 ⇒ 空框）', () => {
    expect(FACE).toContain('counterImages.preload')
    // 预载的 URL 必须来自 `region.units[].imageUrl`，不能只有卡面图
    expect(FACE).toMatch(/regions[\s\S]{0,120}units[\s\S]{0,120}imageUrl/)
  })

  it('★ 盒内算子可点选、右键出既有盒内动作（不再只是一张静态图）', () => {
    expect(FACE).toContain('@click')
    expect(FACE).toContain('@contextmenu')
    expect(FACE).toContain('face__unit--picked')
  })

  it('★ 盒内多枚全部排开（堆叠不截断，靠换行铺开）', () => {
    const { workbench, containers } = setup()
    for (const index of [1, 2, 3]) {
      workbench.deadPile.push(
        toConsoleUnit({
          record: recordOf(),
          instanceId: `ax-dead-${index}`,
          hex: HEX,
          side: 'axis',
        }),
      )
    }
    const region = containers.cardViews
      .flatMap((card) => card.regions)
      .find((item) => item.units.some((unit) => unit.unitId === 'ax-dead-1'))
    expect(region, '死亡堆分区应存在').toBeDefined()
    const ids = region!.units.map((unit) => unit.unitId)
    expect(ids).toEqual(expect.arrayContaining(['ax-dead-1', 'ax-dead-2', 'ax-dead-3']))
    // 卡面逐枚渲染（`v-for`）+ 自动换行（flex-wrap），不做"只显示前 N 枚"
    expect(FACE).toContain('v-for="unit in region.units"')
    expect(FACE).toContain('flex-wrap: wrap')
  })

  it('★ 按方过滤对盒生效；死亡堆双方可见', () => {
    const { workbench, containers } = setup()
    const axisUnit = toConsoleUnit({
      record: recordOf(),
      instanceId: 'ax-dead-1',
      hex: HEX,
      side: 'axis',
    })
    workbench.deadPile.push(axisUnit)

    // 方别卡只装本方盒：轴方卡里看得到这枚，苏方卡里看不到
    const inAxis = containers
      .cardViewsOf('axis')
      .some((card) => card.regions.some((r) => r.units.some((u) => u.unitId === 'ax-dead-1')))
    const inSoviet = containers
      .cardViewsOf('soviet')
      .some((card) => card.regions.some((r) => r.units.some((u) => u.unitId === 'ax-dead-1')))
    expect(inAxis).toBe(true)
    expect(inSoviet).toBe(false)

    // 死亡堆对双方可见：同一枚在两个视角的名册里都在（不因视角被滤掉）
    expect(containers.deadPileUnits.axis.some((u) => u.id === 'ax-dead-1')).toBe(true)
    expect(containers.deadPileUnits.soviet).toBeDefined()
  })

  it('★ 浮窗右上角关闭 × 不会被标题栏拖拽吃掉点击（用户 2026-11-10）', () => {
    /*
     * 现场：部分图外盒（浮窗形态）的关闭 × 点不动。
     * 根因：× 在标题栏内，标题栏 `pointerdown` 里 `setPointerCapture` ⇒ 后续 pointerup/click
     * 改派给标题栏，按钮自己的 click 永远收不到。修法：× 的 pointerdown 必须 `.stop`，
     * 且拖拽入口对关闭按钮再挡一次（双保险，不靠 z-index）。
     */
    const card = readFileSync(join(ROOT, 'src/components/game/BoxCard.vue'), 'utf8')
    expect(card).toMatch(/boxpopup__close[^>]*@pointerdown\.stop/)
    expect(card).toMatch(/onPopupPointerDown[\s\S]{0,400}boxpopup__close/)
  })
})
