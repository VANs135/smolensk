import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useHotseatStore, useSetupStore } from '@/stores'

/** 2026-11-09：对局模式前移到「选剧本」，初设开始即锁定 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

function newStores() {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), hotseat: useHotseatStore() }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('对局模式：选剧本时定、初设前必须定', () => {
  it('未选模式：不能进初设，且给出缺口说明', () => {
    const { setup, hotseat } = newStores()
    expect(hotseat.mode).toBeNull()
    expect(hotseat.modeReady).toBe(false)
    expect(hotseat.modeIssue).toContain('对局模式')
    expect(setup.enterSetup('1')).toBe(false)
    expect(setup.lastAction?.detail ?? '').toContain('对局模式')
    expect(setup.finished).toBe(false)
  })

  it('PVE：未指定 AI 方不能进初设；指定后可进', () => {
    const { setup, hotseat } = newStores()
    expect(hotseat.setMode('pve')).toBe(true)
    expect(hotseat.modeReady).toBe(false)
    expect(setup.enterSetup('1')).toBe(false)

    expect(hotseat.setAiSide('axis')).toBe(true)
    expect(hotseat.modeReady).toBe(true)
    expect(hotseat.modeIssue).toBeNull()
    expect(setup.enterSetup('1')).toBe(true)
    expect(hotseat.setupLocked).toBe(true)
  })

  it('初设一旦开始：改模式、改 AI 方都被拒，原值不变', () => {
    const { setup, hotseat } = newStores()
    expect(hotseat.setMode('solo')).toBe(true)
    expect(setup.enterSetup('1')).toBe(true)

    expect(hotseat.setupLocked).toBe(true)
    expect(hotseat.setMode('pvp')).toBe(false)
    expect(hotseat.mode).toBe('solo')
    expect(hotseat.setAiSide('axis')).toBe(false)
    expect(hotseat.aiSide).toBeNull()
  })

  it('预设归属：PVP/solo 不预设任何人，PVE 只预设 AI 方', () => {
    const { hotseat } = newStores()

    expect(hotseat.setMode('pvp')).toBe(true)
    expect(hotseat.canPreset).toBe(false)
    expect(hotseat.presetSide).toBeNull()

    expect(hotseat.setMode('solo')).toBe(true)
    expect(hotseat.canPreset).toBe(false)
    expect(hotseat.presetSide).toBeNull()

    expect(hotseat.setMode('pve')).toBe(true)
    expect(hotseat.setAiSide('soviet')).toBe(true)
    expect(hotseat.canPreset).toBe(true)
    expect(hotseat.presetSide).toBe('soviet')
  })

  // PVE「只预设 AI 方」的落位行为由 tests/flows/ai-pve.test.ts 的
  // openAxisOnlyGame 覆盖（onlySide=axis 后苏联侧仍待落位）；这里只钉选边口径。
})

describe('界面接线：模式在选剧本页、顶栏只读、预设按 AI 方', () => {
  it('选剧本页：模式单选带初设后禁用；PVE 追加 AI 方单选', () => {
    const source = readSource('../../src/views/ScenarioSetupView.vue')
    expect(source).toContain('hotseat.setMode(item.key)')
    expect(source).toContain(':disabled="hotseat.setupLocked"')
    expect(source).toContain("hotseat.mode === 'pve'")
    expect(source).toContain('hotseat.setAiSide(item.side)')
    expect(source).toContain('初设已开始，对局模式锁定')
  })

  it('棋桌顶栏：不再有 AI 开关，只读展示当前模式，AI 方由模式推出', () => {
    const source = readSource('../../src/views/GameTableView.vue')
    expect(source).not.toContain('v-model="aiControlMode"')
    expect(source).not.toContain('>双方<')
    expect(source).toContain("hotseat.mode === 'pve' && hotseat.aiSide !== null")
    expect(source).toContain('data-testid="match-mode"')
  })

  it('初设栏：非 PVE 不出现「一键预设初设」，PVE 只传 AI 方', () => {
    const source = readSource('../../src/components/game/DecisionQueue.vue')
    expect(source).toContain('v-if="hotseat.canPreset && !setup.finished"')
    expect(source).toContain('presetSelfSetupNow({ onlySide: hotseat.presetSide })')
    // 用户 2026-11-11：入口只此一处，初设面板不再画按钮
    const panel = readSource('../../src/components/setup/SetupPanel.vue')
    expect(panel).not.toContain('presetSelfSetupNow(')
  })
})
