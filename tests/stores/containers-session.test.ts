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
    /** 门的两种写法都算（`showsBoxActions` 是"再按展开的卡过滤一层"的更窄门） */
    const hasGate = (text: string): boolean =>
      text.includes('showsActions') || text.includes('showsBoxActions')

    const isGated = (marker: string): boolean => {
      const at = panel.indexOf(marker)
      if (at < 0) throw new Error(`${marker} 不在面板里`)
      // 写法一：门就挂在按钮自己身上 ⇒ 就近 800 字符内出现
      if (hasGate(panel.slice(Math.max(0, at - 800), at))) return true
      const heading = panel.lastIndexOf('block-title', at)
      if (heading < 0) return false
      // 写法二：门挂在**本节内**的某个 div/行上（标题之后、动作之前出现门）
      if (hasGate(panel.slice(heading, at))) return true
      // 写法三：整段包起来（门开在**本节标题之前**）
      return /<template v-if="shows(Box)?Actions/.test(
        panel.slice(Math.max(0, heading - 400), heading),
      )
    }

    for (const marker of [
      'containers.advanceTurnMarker()',
      'containers.setWeatherMarker(',
      'containers.applyRailCapacityForDate()',
      'workbench.returnFromDeadPileNow({',
      'workbench.removeForeverNow(',
      'containers.drawFormations(',
      '@click="hideNow()"',
      'containers.resetContainers()',
    ]) {
      expect(isGated(marker), `${marker} 应由某道 showsActions 门管着`).toBe(true)
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
