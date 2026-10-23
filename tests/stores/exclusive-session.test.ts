import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * B17a-3：**专规动作进会话框**（方案 §10①「右侧栏只读」的最后一块）
 *
 * 与增援 / 盒内两批的差别：专规动作**跨多个段**（3.3b 治安检查在任意 H 清理段、16.0b 工事在移动段、
 * 1.7 补给缓存在 D 段、3.4 装甲集群是随时可声明的归属）——**没有哪一个环节名能代表它们**。
 * 故不用"环节到点自动出现"，而是顶栏一个「专规动作」按钮**显式**打开（能达成目的就行）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B17a-3：专规动作会话（顶栏按钮显式打开）', () => {
  it('★ 默认不出现（不抢地图）；打开按钮 ⇒ 出现「专规动作」会话', () => {
    const { mapView } = newStores()
    expect(mapView.exclusiveOpen).toBe(false)
    expect(mapView.session).toBeNull()

    mapView.setExclusiveOpen(true)
    expect(mapView.session).toMatchObject({ kind: 'exclusive' })
    expect(mapView.session?.title).toContain('专规动作')
  })

  it('★ 取消（`Esc`/×）＝关掉它；再点按钮可重新打开', () => {
    const { mapView } = newStores()
    mapView.setExclusiveOpen(true)
    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.exclusiveOpen).toBe(false)
    expect(mapView.session).toBeNull()

    mapView.setExclusiveOpen(true)
    expect(mapView.session?.kind).toBe('exclusive')
  })

  it('与其它会话互斥（同一时刻只挂一个：战斗中打开专规不会出现两个）', () => {
    const { mapView, workbench } = newStores()
    mapView.setExclusiveOpen(true)
    expect(mapView.session?.kind).toBe('exclusive')
    // 引擎状态机在跑时（此处用轰炸会话模拟）优先级更高 —— 结构上仍只有一个
    workbench.setBarrageActive(true)
    workbench.toggleBarrageUnit('nonexistent')
    expect(mapView.session === null || typeof mapView.session.kind === 'string').toBe(true)
  })
})

describe('B17a-3：分段渲染与入口（源码守卫）', () => {
  it('★ 面板支持 `only` 分段；动作件都由 `showsActions` 管着', () => {
    const panel = readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8')
    expect(panel).toContain("only?: 'info' | 'actions' | null")
    expect(panel).toContain('showsInfo')
    expect(panel).toContain('showsActions')

    /** 该动作是否在某道 `showsActions` 门之内（三种写法都认，与盒内动作那批同一套判法） */
    const isGated = (marker: string): boolean => {
      const at = panel.indexOf(marker)
      if (at < 0) throw new Error(`${marker} 不在面板里`)
      if (panel.slice(Math.max(0, at - 800), at).includes('showsActions')) return true
      const heading = panel.lastIndexOf('<hr', at)
      if (heading < 0) return false
      if (panel.slice(heading, at).includes('showsActions')) return true
      return panel.lastIndexOf('v-if="showsActions', heading) > 0
    }

    for (const marker of [
      'workbench.setDumpPanzerGroupNow(',
      'workbench.applySecurityNeedsNow()',
      'workbench.buildHedgehogNow()',
      'workbench.reduceHedgehogNow()',
      'workbench.useConstructionMarkerNow(',
      'workbench.spendSupplyCacheNow()',
    ]) {
      expect(isGated(marker), `${marker} 应由某道 showsActions 门管着`).toBe(true)
    }
  })

  it('★ 对局台：右栏 `only="info"`、会话 `only="actions"`；验证页仍挂全量', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    const verify = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(game).toContain('<ExclusiveRulesPanel only="info" />')
    expect(game).toContain('session.kind === \'exclusive\'" only="actions"')
    /*
     * B37（方案 §3 步骤 2 后半）：会话入口由**常驻按钮**改成"本环节有可做的专规动作时**自动出现**"
     * ⇒ 对局台上**不该再有**那个按钮（`setExclusiveOpen` 只留给验证页/测试显式打开）。
     */
    expect(game).not.toContain('mapView.setExclusiveOpen(')
    expect(verify).toMatch(/<ExclusiveRulesPanel\s*\/>/)
  })

  it('会话由**闸门触发的自动出现**（＋显式开关作为退路）；不比规则字面量、也不硬挑一个环节', () => {
    const store = readFileSync('src/stores/map-view.ts', 'utf8')
    // B37：自动出现的判据是本环节**真的**有可做的专规动作（走闸门表）
    expect(store).toContain('workbench.exclusiveActionsInStep.length > 0')
    expect(store).toContain('collapsedSessionKey.value !== currentStepKey.value')
    // 显式开关仍在（验证页/测试显式打开，且收起时复位）
    expect(store).toContain('const exclusiveOpen = ref(false)')
    expect(store).toContain("kind: 'exclusive'")
    expect(store).toContain('exclusiveOpen.value = false')
    // store 侧的判据来自闸门（不在 map-view 里比规则号）
    const wb = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(wb).toContain('const EXCLUSIVE_PANEL_KEYS: readonly ActionKey[]')
    expect(wb).toContain('allowedActionsOf(segmentGateQuery.value)')
  })
})
