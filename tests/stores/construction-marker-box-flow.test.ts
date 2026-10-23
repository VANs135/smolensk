import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useContainersStore,
  useWorkbenchStore,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * 批 D 切片 2（用户 9.16 #15）：**标记盒装建造标记 + "盒里拾起 → 点图落位 → 二选一"**
 *
 * 病灶（族⑤原文）：建造标记本身能落盘 / 上地图 / 被摧毁，但
 *   ① **标记盒是空的** —— 投影对 `sectionId === null` 的分区（`markers` 就映到这里）一律给空数组
 *      ⇒ 盒卡上看不到"还剩几枚建造标记"；
 *   ② 落位入口只有专规面板里那套「**文本格号 + `<select>` 二选一 + 按钮**」，而那个 `select` 绑的是
 *      **组件局部 ref** ⇒ 界面之外的路径（盒内会话框）拿不到选择（房规①：值要被 store 动作读、
 *      又要被界面写 ⇒ 必须是 **store 字段**）。
 *
 * 专规 3.5 原文要点：剧本 1/2 各 **3 枚**；可在**任一轴方移动阶段**、**单位移动之前**放进一个有
 * **轴方战斗单位**的格；**免费**；桥按 13.8b（HQ 架桥）、简易机场按 15.2；**每枚只能用一次、不可重建**；
 * 只有**苏军战斗单位进入其格**才会被毁。
 *
 * ## 测法边界（如实交代）
 *   · 用真实地图与真实单位库；落位格只在内圈挑（角落格的通行/追溯判据会给出奇怪结果 —— B32 的教训）；
 *   · **不覆盖**"点击盒卡上那一枚"的像素级热区：按 §4.7「**盒卡只负责『选谁』，动作进会话框**」，
 *     本切片的"拾起"落在**盒内动作会话框**（展开标记盒卡即出现）—— 卡面本身保持只读，靠人眼核对观感；
 *   · 桥的 13.8b 地形效果与简易机场 15.2 的六条特性由各自章节的机制承担（本切片只钉"落盘 + 记账"）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { containers: useContainersStore(), workbench: useWorkbenchStore() }
}

/** 内圈一格（六邻皆图内） */
const CORE_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    if (hex.col < 6 || hex.row < 6 || hex.col > 56 || hex.row > 30) return false
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到内圈格')
  return { col: found.col, row: found.row }
})()

/** 轴方战斗单位（3.5 要求落点格里有它） */
const axisCombatRecord = () =>
  unitChoices('axis').find((record) => record.isCombat === true && record.attackCapable === true)!

/** B8：把 store 放到本段里允许做该动作的那个环节（3.5 只在 C 段的「模式与移动」环节放行） */
function goToActionStep(
  store: ReturnType<typeof newStores>['workbench'],
  key: 'move.construction',
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

function place(
  store: ReturnType<typeof newStores>['workbench'],
  instanceId: string,
  hex: HexRef,
): ConsoleUnit {
  const unit = toConsoleUnit({ record: axisCombatRecord(), instanceId, hex, side: 'axis' })
  store.units.push(unit)
  return unit
}

describe('批 D 切片 2：建造标记（标记盒 → 二选一 → 点图落位）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('★ 标记盒**有内容**了：轴方卡显示未放置的建造标记（枚数＝剩余数），苏方卡如实说明', () => {
    const axisCard = stores.containers
      .cardViewsOf('axis')
      .find((card) => card.id === 'axis-offboard')!
    const markers = axisCard.regions.find((region) => region.kind === 'markers')!
    // 剧本 1 初设 3 枚（本组 store 未换剧本 ⇒ 取剧本初设值）
    const remaining = stores.workbench.constructionMarkers
    expect(remaining).toBeGreaterThan(0)
    expect(markers.units).toHaveLength(remaining)
    expect(markers.units[0]?.unitId).toBe('construction-marker:1')
    expect(markers.units[0]?.name).toContain('二选一')
    expect(markers.note).toContain('拾起并落位')

    const sovietCard = stores.containers
      .cardViewsOf('soviet')
      .find((card) => card.id === 'soviet-offboard')!
    const sovietMarkers = sovietCard.regions.find((region) => region.kind === 'markers')!
    expect(sovietMarkers.units).toEqual([])
    expect(sovietMarkers.note).toContain('轴方')

    // 落一枚之后盒里少一枚（盒里装的是**未放置**的那些）
    place(stores.workbench, 'a1', CORE_HEX)
    stores.workbench.setPhase('movement' as ConsolePhase)
    expect(stores.workbench.armConstructionMarkerNow('bridge')).toBeUndefined()
    expect(stores.workbench.pickHexFor(CORE_HEX)).toBe(true)
    expect(stores.workbench.constructionMarkerHexText).toBe(`${CORE_HEX.col}.${CORE_HEX.row}`)
  })

  it('★ 二选一是 **store 字段**（房规①）：面板与会话框共用一份，落盘用的是它', () => {
    const panel = readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8')
    // 面板不再有局部 `markerKind`，绑的是 store 字段；落盘也读 store
    expect(panel).not.toContain('const markerKind = ref<')
    expect(panel).toContain('v-model="workbench.constructionMarkerKind"')
    expect(panel).toContain('workbench.useConstructionMarkerNow(')
    expect(panel).toContain('workbench.constructionMarkerKind,')
    // 会话框那一段也走同一份状态
    const box = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    expect(box).toContain("workbench.armConstructionMarkerNow('bridge')")
    expect(box).toContain("workbench.armConstructionMarkerNow('airStrip')")
    expect(box).toContain('workbench.constructionMarkerPicked')
  })

  it('★ 拾起 → 点地图落位：候选＝**有轴方战斗单位的格**；落盘记 kind、枚数减一、"已拾起"复位', () => {
    const workbench = stores.workbench
    const unit = place(workbench, 'a1', CORE_HEX)
    workbench.setPhase('movement' as ConsolePhase)
    goToActionStep(workbench, 'move.construction')
    expect(unit.isCombat).toBe(true)

    const before = workbench.constructionMarkers
    // 拾起（二选一：简易机场）⇒ 当场开好待点格
    expect(workbench.armConstructionMarkerNow('airStrip')).toBeUndefined()
    expect(workbench.constructionMarkerKind).toBe('airStrip')
    expect(workbench.constructionMarkerPicked).toBe(true)
    expect(workbench.hexPickView).toMatchObject({ rule: '专规 3.5' })

    /*
     * 候选＝"有轴方战斗单位的格"：点**空格**不写回（待点态照旧挂着 —— `pickHexFor` 对"这一击被待点态
     * 消化但没命中"返回 **true**，与"没有待点态"的 false 区分开），点该格才写回。
     */
    const empty: HexRef = neighbor(CORE_HEX, HEX_DIRECTIONS[0]!)
    expect(workbench.pickHexFor(empty)).toBe(true)
    expect(workbench.constructionMarkerHexText).toBe('')
    expect(
      workbench.log.some((entry) => entry.text.includes('不是「放置建造标记的格」的候选格')),
    ).toBe(true)
    expect(workbench.pickHexFor(CORE_HEX)).toBe(true)
    expect(workbench.constructionMarkerHexText).toBe(`${CORE_HEX.col}.${CORE_HEX.row}`)

    expect(
      workbench.useConstructionMarkerNow(
        workbench.constructionMarkerKind,
        workbench.constructionMarkerHexText,
      ),
    ).toBe(true)
    expect(workbench.constructionMarkers).toBe(before - 1)
    expect(workbench.constructionMarkerPieces.at(-1)).toMatchObject({
      kind: 'airStrip',
      hex: CORE_HEX,
    })
    // 落位成功 ⇒ 收起"已拾起"的高亮
    expect(workbench.constructionMarkerPicked).toBe(false)
  })

  it('★ 专用规则：桥与简易机场都能落（kind 逐次可改），且**枚数用尽后被拒**', () => {
    const workbench = stores.workbench
    place(workbench, 'a1', CORE_HEX)
    workbench.setPhase('movement' as ConsolePhase)
    goToActionStep(workbench, 'move.construction')

    // 逐枚放完（剧本 1 = 3 枚）：桥 → 机场 → 桥
    const kinds = ['bridge', 'airStrip', 'bridge'] as const
    for (const kind of kinds) {
      workbench.armConstructionMarkerNow(kind)
      workbench.pickHexFor(CORE_HEX)
      expect(
        workbench.useConstructionMarkerNow(
          workbench.constructionMarkerKind,
          workbench.constructionMarkerHexText,
        ),
      ).toBe(true)
    }
    expect(workbench.constructionMarkers).toBe(0)
    expect(workbench.constructionMarkerPieces.map((piece) => piece.kind)).toEqual([...kinds])

    // 用尽 ⇒ 再想拾起也放不下（引擎按 3.5 的"枚数"前提拒）
    workbench.armConstructionMarkerNow('bridge')
    workbench.pickHexFor(CORE_HEX)
    expect(
      workbench.useConstructionMarkerNow(
        workbench.constructionMarkerKind,
        workbench.constructionMarkerHexText,
      ),
    ).toBe(false)
    expect(workbench.constructionMarkerPieces).toHaveLength(3)
  })
})
