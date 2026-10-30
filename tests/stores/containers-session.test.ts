import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useContainersStore, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * B17a-2：**盒内动作进会话框**（方案 §4.7「在盒卡里点到需要规则判定的动作 ⇒ 不弹第二个面板，
 * 而是在地图页展开那一个会话框；**盒卡只负责『选谁』**」）
 *
 * 触发判据＝托盘里**展开着一张盒卡**（`containers.cardOpenId`）：展开本身就是在说"我要对这个盒做点什么"。
 * 收起（`Esc`/×）＝把那张卡也合上（它正是这个会话的触发源），并记在环节键上。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    workbench: useWorkbenchStore(),
    mapView: useMapViewStore(),
    containers: useContainersStore(),
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B17a-2：盒卡展开 ⇒ 盒内动作会话', () => {
  it('★ 没有展开盒卡时不出会话；展开一张即出现「盒内动作」', () => {
    const { mapView, containers } = newStores()
    expect(mapView.session).toBeNull()

    const card = containers.cardViews[0]
    expect(card, '本剧本应当有盒卡').toBeDefined()
    containers.toggleCardOpen(card!.id)
    expect(mapView.session).toMatchObject({ kind: 'containers' })
    expect(mapView.session?.title).toContain('盒内动作')
  })

  it('★ 收起（`Esc`/×）：会话消失、那张盒卡也合上', () => {
    const { mapView, containers } = newStores()
    containers.toggleCardOpen(containers.cardViews[0]!.id)
    expect(mapView.session?.kind).toBe('containers')

    expect(mapView.cancelSession()).toBe(true)
    expect(containers.cardOpenId).toBeNull()
    expect(mapView.session).toBeNull()
  })

  it('★ C-1：展开盒卡后，`openCardBoxKinds` 必须给出**引擎盒名**（否则盒内动作全被滤掉）', () => {
    const { containers } = newStores()
    /*
     * 回执（2026-10-30 实测 BUG）：这里原先只返回数据侧分区名（`dead_pile` / `air_box_active` …），
     * 而面板按引擎名（`deadPile` / `airBox` …）过滤 ⇒ `includes` 永不命中 ⇒
     * "展开任意盒卡，会话里一个动作都没有"（1.4a/1.4b/1.6c/13.7/20.0a/死亡堆返场全消失）。
     * 该用例按"每个盒名都能被 `showsBoxActions` 命中"来钉住归一。
     */
    const deadPileCard = containers.cardViews.find((card) =>
      card.regions.some((region) => region.kind === 'dead_pile'),
    )
    expect(deadPileCard, '本剧本应当有死亡堆盒卡').toBeDefined()
    containers.toggleCardOpen(deadPileCard!.id)
    const kinds = containers.openCardBoxKinds
    expect(kinds).toContain('deadPile')
    // 原始分区名仍保留（`showsBoxActions('markers')` 这类"按分区"的调用要靠它）
    expect(kinds).toContain('dead_pile')
  })

  it('换环节后收起态失效（会话不会被"上次的收起"永久压住）', () => {
    const { workbench, mapView, containers } = newStores()
    const cards = containers.cardViews
    expect(cards.length).toBeGreaterThan(1)
    containers.toggleCardOpen(cards[0]!.id)
    mapView.cancelSession()
    expect(mapView.session).toBeNull()

    // 换一个**不同的**阶段 ⇒ 环节键变 ⇒ 收起失效；盒卡再展开即重现
    //（★ 不能用 `setPhase('movement')`：新 store 的默认阶段就是它，环节键不会变）
    workbench.setPhase(workbench.phase === 'movement' ? 'combat' : 'movement')
    containers.toggleCardOpen(cards[1]!.id)
    expect(mapView.session?.kind).toBe('containers')
  })
})

describe('B17a-2：分段渲染与入口（源码守卫）', () => {
  it('★ 13.7 / 3.5：玩家动作不得被套进 `showsReferee` 的模板里（修前 3.5 与 13.7 整块不可达）', () => {
    /*
     * 回执（2026-10-30）：`showsReferee && showsBoxActions('scenarioDrawBox')` 那段
     * 「剧本抽取盒（裁判重抽）」把 ④ 编队收纳盒（13.7）与 ④b 建造标记（专规 3.5）**一起包住**了。
     * 正式对局台 `showsReferee === false` ⇒ 这两块永远不铺 ⇒ 玩家侧完全没有入口。
     * 该用例按"最近的一层 `<template` 不得含 showsReferee"来钉住，防止再被顺手包进去。
     */
    const panel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    const markers = [
      "showsBoxActions('markers')",
      "showsBoxActions('scenarioDrawBox') || showsBoxActions('formationBox')",
    ]
    for (const marker of markers) {
      const at = panel.indexOf(marker)
      expect(at, `面板里应保留 ${marker}`).toBeGreaterThan(-1)
      const open = panel.lastIndexOf('<template', at)
      expect(open).toBeGreaterThan(-1)
      expect(panel.slice(open, at)).not.toContain('showsReferee')
    }
    // 裁判重抽那半仍只给裁判（别把裁掉的门一起删了）
    const drawAt = panel.indexOf("showsReferee && showsBoxActions('scenarioDrawBox')")
    expect(drawAt).toBeGreaterThan(-1)
  })

  it('★ 面板支持 `only` 分段，动作件都由 `showsActions` 管着', () => {
    const panel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    expect(panel).toContain("only?: 'info' | 'actions' | null")
    expect(panel).toContain('showsInfo')
    expect(panel).toContain('showsActions')
    /*
     * 两道检查合起来才算数：
     *   ① **数量**：门至少有 12 处（本批逐个加的门：记录轨 4、逐项动作 4、盒操作区 5、两个整段 2…）；
     *   ② **作用域**：每个动作都在某道门的范围内——逐项门用"标记前 200 字符内出现 `showsActions`"判，
     *      整段门（`<template v-if="showsActions">` 包起来的两个 section）用"开闭之间"判。
     *   ★ 别用"最近一个 `</template>` 之后"这种启发式：本文件里 template 很多，
     *     属性式的门（`v-if="showsActions"` 挂在按钮上）根本没有闭合标签，那种判法会假红。
     */
    /*
     * B35 切片 C-1：逐项动作的门从 `showsActions` **细化**成 `showsBoxActions('kind')`
     * （＝ showsActions **且** 该盒属于当前展开卡覆盖的盒）⇒ 门更窄、不是更宽：
     * 数量按"两种门之和"数，`isGated` 也认两种写法（`showsBoxActions` 内部就是 `showsActions.value`）。
     */
    const gateCount =
      (panel.match(/showsActions/g)?.length ?? 0) + (panel.match(/showsBoxActions/g)?.length ?? 0)
    expect(gateCount).toBeGreaterThanOrEqual(12)

    /** 该动作是否在某道 `showsActions` 门之内（三种写法都认） */
    /*
     * ★ 2026-10-25：门分两类 ——
     *   · **动作门** `showsActions` / `showsBoxActions`（盒动作、返场、抽签…）；
     *   · **裁判工具门** `showsReferee`：记录轨的"手动改表"（2.2 回合推进 / 1.5 天气 /
     *     专规 1.2 铁路容量）与"重置全部盒子" —— 这些**都由系统自动结算**
     *     （`docs/阶段-环节-操作矩阵.md` 的"只有这 6 个环节是自动结算"），
     *     所以只挂在验证页（`only === null`），对局台的盒会话里不铺。
     */
    const ACTION_GATES = ['showsActions', 'showsBoxActions'] as const
    const REFEREE_GATES = ['showsReferee'] as const

    const hasGate = (text: string, gates: readonly string[]): boolean =>
      gates.some((gate) => text.includes(gate))

    const isGated = (marker: string, gates: readonly string[]): boolean => {
      const at = panel.indexOf(marker)
      if (at < 0) throw new Error(`${marker} 不在面板里`)
      // 写法一：门就挂在按钮自己身上 ⇒ 就近 800 字符内出现
      if (hasGate(panel.slice(Math.max(0, at - 800), at), gates)) return true
      const heading = panel.lastIndexOf('block-title', at)
      if (heading < 0) return false
      // 写法二：门挂在**本节内**的某个 div/行上（标题之后、动作之前出现门）
      if (hasGate(panel.slice(heading, at), gates)) return true
      // 写法三：整段包起来（门开在**本节标题之前**）
      const window = panel.slice(Math.max(0, heading - 400), heading)
      return gates.some((gate) => window.includes(`v-if="${gate}`))
    }

    for (const [marker, gates] of [
      ['containers.advanceTurnMarker()', REFEREE_GATES],
      ['containers.setWeatherMarker(', REFEREE_GATES],
      ['containers.applyRailCapacityForDate()', REFEREE_GATES],
      ['containers.resetContainers()', REFEREE_GATES],
      ['workbench.returnFromDeadPileNow({', ACTION_GATES],
      ['workbench.removeForeverNow(', ACTION_GATES],
      /*
       * ★ 2026-10-25：编队抽签已移到**初设自动执行**（`setup.runSetupDraws`）⇒ 对局台这里
       * 的「抽签 / 落盘」是**裁判重抽的退路**，归 `showsReferee`（对局台不铺、验证页保留）。
       */
      ['containers.drawFormations(', REFEREE_GATES],
      ['@click="hideNow()"', ACTION_GATES],
    ] as const) {
      expect(isGated(marker, gates), `${marker} 应由 ${gates.join(' / ')} 门管着`).toBe(true)
    }
  })

  it('★ 对局台：右栏 `only="info"`、会话 `only="actions"`；验证页仍挂全量', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    const verify = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(game).toContain('<ContainersPanel only="info" />')
    expect(game).toContain('session.kind === \'containers\'" only="actions"')
    expect(verify).toMatch(/<ContainersPanel\s*\/>/)
  })

  it('会话路由按**盒卡展开态**判断，收起时把卡一并合上', () => {
    const store = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(store).toContain('containers.cardOpenId !== null')
    expect(store).toContain("kind: 'containers'")
    expect(store).toContain('containers.cardOpenId = null')
  })
})
