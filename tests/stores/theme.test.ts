import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryStorage } from '@/shared'
import { useThemeStore } from '@/stores'

/**
 * 主题 store（用户 2026-11-17）
 *
 * 默认浅色；深色保留为可切换主题；玩家选择写入 localStorage，下次进来沿用。
 */

function fakeDocument(): { documentElement: { dataset: Record<string, string> } } {
  return { documentElement: { dataset: {} } }
}

function stubEnv(storage = createMemoryStorage()) {
  vi.stubGlobal('localStorage', storage)
  const doc = fakeDocument()
  vi.stubGlobal('document', doc)
  return { storage, doc }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('主题 store：默认浅色，深色可切换并记住', () => {
  it('首次进入默认浅色，并把 data-theme 挂到根元素', () => {
    const { storage, doc } = stubEnv()
    const theme = useThemeStore()
    expect(theme.mode).toBe('light')
    expect(doc.documentElement.dataset.theme).toBe('light')
    expect(storage.getItem('smolensk.theme')).toBeNull()
  })

  it('切到深色后写入 localStorage 并立即生效', () => {
    const { storage, doc } = stubEnv()
    const theme = useThemeStore()
    theme.setMode('dark')
    expect(theme.mode).toBe('dark')
    expect(doc.documentElement.dataset.theme).toBe('dark')
    expect(storage.getItem('smolensk.theme')).toBe('dark')
  })

  it('下次进入沿用上次选择（dark）', () => {
    const { doc } = stubEnv(createMemoryStorage({ 'smolensk.theme': 'dark' }))
    const theme = useThemeStore()
    expect(theme.mode).toBe('dark')
    expect(doc.documentElement.dataset.theme).toBe('dark')
  })

  it('非法存档值按默认浅色处理', () => {
    const { doc } = stubEnv(createMemoryStorage({ 'smolensk.theme': 'purple' }))
    const theme = useThemeStore()
    expect(theme.mode).toBe('light')
    expect(doc.documentElement.dataset.theme).toBe('light')
  })

  it('无 DOM / 无存储的环境不抛错（Node 测试基线）', () => {
    setActivePinia(createPinia())
    const theme = useThemeStore()
    expect(theme.mode).toBe('light')
    expect(() => theme.setMode('dark')).not.toThrow()
  })
})
