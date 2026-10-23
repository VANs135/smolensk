import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * B38 初设收尾（用户口径 #5「初设框不能拖；**结束后不自动关**」、#8「编队卡车如果默认全满载
 * 则不需要玩家选择」；方案 §3 B38 步骤 1–4）
 *
 * 规则依据（原文已核）：通规 **IV-D**「`Organic Trucks start "full" only if a scenario explicitly
 * states that they do`」、专规 **Setup Note C**「Special Scenario Rules will say if organic trucks are
 * Empty or Full」、**13.2h** 的满载面记法（正面 `${n}F`）⇒ 剧本页明示时**不由玩家决定**。
 *
 * ★ 一条**测法边界（如实）**：本仓库不挂组件渲染测试 ⇒ "框真的能拖、落满后真的收起"由**源码守卫**
 *   （指针事件 + `clampDockOffset` + `v-show` + 「完成初设」按钮）钉住；拖动回弹的**几何**不重复测
 *   （复用唯一会话框那套，`tests/components/dock-position.test.ts` 已覆盖）。
 */
const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

describe('B38：卡车装载按剧本页（用户口径 #8）', () => {
  it('★ 剧本页明示全满载 ⇒ 生效名单＝全集（不勾也算对）；全空载 ⇒ 空名单', () => {
    const { setup } = newStores()

    setup.selectScenario('1')
    expect(setup.truckLoadMode).toBe('all_loaded')
    expect(setup.effectiveFullTruckIds).toHaveLength(setup.setupTrucks.length)

    setup.selectScenario('7')
    expect(setup.truckLoadMode).toBe('all_unloaded')
    expect(setup.effectiveFullTruckIds).toEqual([])
  })

  it('★ 自选的剧本（choose_loaded）⇒ 生效名单＝玩家勾的那几辆（脚本不插手）', () => {
    const { setup } = newStores()
    setup.selectScenario('3')
    expect(setup.truckLoadMode).toBe('choose_loaded')
    const first = setup.setupTrucks[0]!.instanceId
    setup.toggleTruckFull(first, true)
    expect(setup.effectiveFullTruckIds).toEqual([first])
    setup.toggleTruckFull(first, false)
    expect(setup.effectiveFullTruckIds).toEqual([])
  })

  it('★ 卡车待决项只在 choose_loaded 出现（全满载/全空载不问玩家）', () => {
    const { setup } = newStores()
    setup.selectScenario('1')
    expect(setup.decisionQueue.find((stack) => stack.key === 'truck')?.items).toEqual([])
    setup.selectScenario('3')
    expect(
      setup.decisionQueue.find((stack) => stack.key === 'truck')?.items.length ?? 0,
    ).toBeGreaterThan(0)
  })
})

describe('B38：开局被拒后初设仍可改（`startGameNow` 先开局、再收初设）', () => {
  it('★ 开局失败 ⇒ `finished` 仍为 false（玩家回得去改初设）', () => {
    const { setup } = newStores()
    setup.selectScenario('1')
    // 不落初设直接开局：引擎按 2.2 拒绝（盘面不合法）⇒ 收束**不该**发生
    expect(setup.finished).toBe(false)
    const ok = setup.startGameNow()
    if (!ok) {
      expect(setup.finished).toBe(false)
      expect(setup.lastAction?.ok).toBe(false)
    } else {
      // 若这一局恰好能开（夹具下不太可能），则"开局成功才收束"同样成立
      expect(setup.finished).toBe(true)
    }
  })

  it('★ 源码守卫：`startGameNow` 里 `startGame()` 在 `finishSetup()` **之前**', () => {
    const store = readFileSync('src/stores/setup.ts', 'utf8')
    const at = store.indexOf('function startGameNow')
    expect(at).toBeGreaterThan(0)
    const body = store.slice(at, at + 1600)
    /*
     * 只在**代码**上比次序：注释里也提到 `finishSetup()`（说明"修前是先收束"）⇒
     * 锚点取带上下文的代码串，免得被说明文字误判（这个坑本轮踩过一次）。
     */
    const start = body.indexOf('game.startGame()')
    const finish = body.indexOf('if (!finished.value) finishSetup()')
    expect(start).toBeGreaterThan(0)
    expect(finish).toBeGreaterThan(0)
    expect(start).toBeLessThan(finish)
  })
})

describe('B38：初设框可拖 + 落满给「完成初设」（源码守卫）', () => {
  const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')

  it('★ 标题栏拖动（复用 `clampDockOffset`，不另写一份回弹）', () => {
    expect(queue).toContain("import { clampDockOffset } from '@/components/map/dock-position'")
    expect(queue).toContain('@pointerdown="onPointerDown"')
    expect(queue).toContain('@pointermove="onPointerMove"')
    expect(queue).toContain('@pointerup="onPointerUp"')
    expect(queue).toContain('setPointerCapture')
    expect(queue).toContain('clampDockOffset({')
    expect(queue).toContain('cursor: move')
  })

  it('★ 落满（`allPlaced`）⇒ 收起列表、就地给「完成初设」按钮（调 `startGameNow`）', () => {
    expect(queue).toContain('const allPlaced = computed(() => pendingTotal.value === 0)')
    expect(queue).toContain('v-show="!allPlaced"')
    expect(queue).toContain('@click="setup.startGameNow()"')
    expect(queue).toContain('完成初设')
    // 初设收束后本框由视图的条件移除（"结束后自动关"）
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).toContain('<DecisionQueue v-if="setup.applied && !setup.finished" />')
  })

  it('★ `SetupPanel` 里那份重复的"应满载数"已删（判据只有 store 一处）', () => {
    const panel = readFileSync('src/components/setup/SetupPanel.vue', 'utf8')
    expect(panel).not.toContain('const requiredFull = computed')
    expect(panel).toContain('setup.requiredFullTrucks')
  })
})
