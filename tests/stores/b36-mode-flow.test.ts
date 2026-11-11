import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useHotseatStore, useWorkbenchStore } from '@/stores'

/**
 * B36：**SOLO / PVP / PVE**（用户口径 #7「在选剧本页面再加个选项，内容为 solo、PVP、PVE」）
 *
 * 规则依据（原文已核）：4.9a 是「不得看穿**敌方**堆叠」，专规 1.4 是「地图外盒**双方同意可隐藏**」——
 * 两条都是**对手之间**的约定 ⇒ 单人局（solo）**没有对手可隐瞒**，读成"全可见"是照原文的自然结论。
 * pvp 与现状一致；pve 本轮**只登记枚举**（界面明示未实现）。
 *
 * ★ 一条**测法边界（如实）**：本仓库不挂组件渲染测试 ⇒ "选剧本页那一排单选长什么样"只由源码守卫 + 人眼。
 * ★ 用户 2026-11-11 口径：换手**不再遮屏、不再自动切视角**（整条交接链已删），本文件只钉"模式 → 可见性纪律"。
 */
const HEX: HexRef = { col: 10, row: 10 }

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), hotseat: useHotseatStore() }
}

/** 摆一枚**敌方**战斗单位（用来验"看不看得穿"） */
function placeEnemy(store: ReturnType<typeof newStores>['workbench']): void {
  const record = unitChoices('soviet')[0]!
  store.units.push(toConsoleUnit({ record, instanceId: 'e1', hex: HEX, side: 'soviet' }))
}

describe('B36：模式（solo / pvp / pve）', () => {
  it('★ 缺省未选模式；选定 pvp 后只影响可见性纪律，不遮屏', () => {
    const { workbench, hotseat } = newStores()
    // 2026-11-09：模式前移到选剧本，缺省必须是「未选」，不得默认替玩家选 pvp
    expect(hotseat.mode).toBeNull()
    expect(hotseat.modeReady).toBe(false)
    expect(hotseat.setMode('pvp')).toBe(true)
    expect(hotseat.hotseatEnabled).toBe(true)

    // 2026-11-11：行动方翻面不再带动观察方，也不再有任何遮罩判据
    workbench.setActiveSide('axis')
    workbench.switchSide()
    expect(hotseat.viewerSide).toBe('axis')
    expect('handoffPending' in hotseat).toBe(false)
  })

  it('★ solo：可见性纪律放宽（换手同样不遮屏、不自动切视角）', () => {
    const { workbench, hotseat } = newStores()
    hotseat.setMode('solo')
    expect(hotseat.hotseatEnabled).toBe(false)

    workbench.setActiveSide('axis')
    workbench.switchSide()
    expect(hotseat.viewerSide).toBe('axis')
  })

  it('★ solo：**双方内容都可见**（4.9a 的裁剪与"看穿堆叠"提示都关掉）', () => {
    const { workbench, hotseat } = newStores()
    placeEnemy(workbench)
    workbench.setActiveSide('axis')

    // pvp：敌方格被裁到"最上方单位"，且提示有隐藏内容
    expect(hotseat.visibleUnitIdsInHex(HEX)).toEqual(['e1']) // 只有那枚敌机 → 仍是它
    expect(hotseat.hasHiddenContent(HEX)).toBe(true)

    // solo：全可见、无隐藏提示
    hotseat.setMode('solo')
    expect(hotseat.fogDisabled).toBe(true)
    expect(hotseat.visibleUnitIdsInHex(HEX)).toEqual(['e1'])
    expect(hotseat.hasHiddenContent(HEX)).toBe(false)
    // 展示结论也走"全见"那一支（引擎的 `viewer: null`）
    expect(hotseat.displayOf(HEX).mode).toBe('full')
  })

  it('★ pvp 的裁剪**未被改动**：敌方格多于两枚时只给最上方两枚', () => {
    const { workbench, hotseat } = newStores()
    const record = unitChoices('soviet')[0]!
    workbench.units.push(
      toConsoleUnit({ record, instanceId: 'e1', hex: HEX, side: 'soviet' }),
      toConsoleUnit({ record, instanceId: 'e2', hex: HEX, side: 'soviet' }),
      toConsoleUnit({ record, instanceId: 'e3', hex: HEX, side: 'soviet' }),
    )
    workbench.setActiveSide('axis')
    expect(hotseat.visibleUnitIdsInHex(HEX)).toEqual(['e1'])
    expect(hotseat.hasHiddenContent(HEX)).toBe(true)

    // 换成 solo：三枚都可见
    hotseat.setMode('solo')
    expect(hotseat.visibleUnitIdsInHex(HEX)).toEqual(['e1', 'e2', 'e3'])
  })

  it('★ 模式仍可切到 pve（AI 方由选剧本页指定）', () => {
    const { hotseat } = newStores()
    hotseat.setMode('pve')
    expect(hotseat.mode).toBe('pve')
    expect(hotseat.hotseatEnabled).toBe(true)
  })

  it('★ 三个模式都有中文名与说明；pve 写明 AI 方由玩家指定', () => {
    const { hotseat } = newStores()
    expect(hotseat.MODE_LABELS.map((item) => item.key)).toEqual(['solo', 'pvp', 'pve'])
    for (const item of hotseat.MODE_LABELS) {
      expect(item.label).not.toBe('')
      expect(item.note).not.toBe('')
    }
    const pve = hotseat.MODE_LABELS.find((item) => item.key === 'pve')!
    expect(pve.note).toContain('AI 打一方')
  })
})

describe('B36：接线（源码守卫）', () => {
  it('★ 选剧本页有模式单选；对局台与热键都**没有**交接链（整条移除）', () => {
    const setupView = readFileSync('src/views/ScenarioSetupView.vue', 'utf8')
    expect(setupView).toContain('hotseat.MODE_LABELS')
    expect(setupView).toContain('<ul class="modes">')
    expect(setupView).toContain('type="radio"')
    expect(setupView).toContain('@change="hotseat.setMode(item.key)"')

    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).not.toContain('beginHandoff')
    expect(game).toContain("hotseat.setViewerSide('axis')")
    expect(game).toContain("hotseat.setViewerSide('soviet')")

    const hotkeys = readFileSync('src/stores/hotkeys.ts', 'utf8')
    expect(hotkeys).not.toContain('beginHandoff')
    expect(hotkeys).not.toContain('handoffPending')
  })

  it('★ 战雾那条"无观察方 ⇒ 不裁剪"的分支在**引擎**里（不在 store 里自己拼）', () => {
    const fog = readFileSync('src/engine/rules/fog.ts', 'utf8')
    expect(fog).toContain('viewer: Side | null')
    expect(fog).toContain('if (input.viewer === null)')
    const store = readFileSync('src/stores/hotseat.ts', 'utf8')
    expect(store).toContain('const fogDisabled = computed<boolean>')
    expect(store).toContain('viewer: fogDisabled.value ? null : viewerSide.value')
    // store 里不自己裁剪（枚举/过滤算子 id 那种写法不该出现）
    expect(store).not.toContain('.map((unit) => unit.id)')
  })
})
