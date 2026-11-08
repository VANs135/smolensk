import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '@/shared'
import { SAVE_SLOT_KEY, useGameSessionStore, useHotseatStore } from '@/stores'

/**
 * 2026-11-09：对局模式随存档保存 / 恢复
 *
 * - 有模式 ⇒ 原样读回，且对局已开始 ⇒ 保持锁定；
 * - 无模式字段 ⇒ 读成「未设置」，要求重选后才放行（AI 不接管、热坐遮罩不按 PVP 口径）。
 */

function boot() {
  setActivePinia(createPinia())
  const hotseat = useHotseatStore()
  const session = useGameSessionStore()
  const storage = createMemoryStorage()
  session.setSaveStorage(storage)
  return { hotseat, session, storage }
}

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

describe('对局模式：随存档保存与恢复', () => {
  it('写档含 hotseat；读回后模式与 AI 方原样保持，并视为已锁定', () => {
    const first = boot()
    expect(first.hotseat.setMode('pve')).toBe(true)
    expect(first.hotseat.setAiSide('soviet')).toBe(true)
    first.session.startGame()
    expect(first.session.saveNow()).toBe(true)

    const text = first.storage.getItem(SAVE_SLOT_KEY) ?? ''
    expect((JSON.parse(text) as Record<string, unknown>)['hotseat']).toEqual({
      mode: 'pve',
      aiSide: 'soviet',
    })

    const second = boot()
    second.session.setSaveStorage(first.storage)
    expect(second.session.loadNow()).toBe(true)
    expect(second.hotseat.mode).toBe('pve')
    expect(second.hotseat.aiSide).toBe('soviet')
    expect(second.hotseat.setupLocked).toBe(true)
  })

  it('档里没有模式：读档后为未设置，拒绝继续（AI 不接管、热坐不按 PVP 生效）', () => {
    const first = boot()
    expect(first.hotseat.setMode('solo')).toBe(true)
    first.session.startGame()
    expect(first.session.saveNow()).toBe(true)

    const parsed = JSON.parse(first.storage.getItem(SAVE_SLOT_KEY) ?? '{}') as Record<
      string,
      unknown
    >
    delete parsed['hotseat']
    first.storage.setItem(SAVE_SLOT_KEY, JSON.stringify(parsed))

    expect(first.hotseat.setMode('pvp')).toBe(true)
    expect(first.session.loadNow()).toBe(true)
    expect(first.hotseat.mode).toBeNull()
    expect(first.hotseat.setupLocked).toBe(false)
    expect(first.hotseat.modeReady).toBe(false)
    expect(first.hotseat.hotseatEnabled).toBe(false)
  })
})

describe('棋桌：模式未设置时的继续闸门', () => {
  it('棋桌有待选模式的闸门；确认按钮在选齐前禁用；未设置不按 PVP 口径启用热坐', () => {
    const view = readSource('../../src/views/GameTableView.vue')
    expect(view).toContain('data-testid="mode-gate"')
    expect(view).toContain(':disabled="!hotseat.modeReady"')

    const store = readSource('../../src/stores/hotseat.ts')
    expect(store).toContain("mode.value === 'pvp' || mode.value === 'pve'")
  })
})
