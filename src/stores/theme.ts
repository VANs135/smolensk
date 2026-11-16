import { defineStore } from 'pinia'
import { ref } from 'vue'

import { browserStorage } from '@/shared'

/**
 * 界面主题（用户 2026-11-17：默认浅色，深色保留为可切换主题）
 *
 * 只改界面外壳：`data-theme` 由 `tokens.css` 的 `:root[data-theme='dark']` 接管，
 * 地图渲染层的配色不读这里。玩家选择写入 localStorage，下次进入沿用。
 */

export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'smolensk.theme'

/** 读玩家上次的选择；没有 / 非法值一律浅色 */
function storedMode(): ThemeMode {
  return browserStorage()?.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
}

/** 挂到根元素（Node 测试环境无 document 时静默跳过） */
function applyMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = mode
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(storedMode())

  /** 切换主题并记住选择 */
  function setMode(next: ThemeMode): void {
    mode.value = next
    browserStorage()?.setItem(STORAGE_KEY, next)
    applyMode(next)
  }

  // 进店即生效（App 装配时创建，早于首次渲染）
  applyMode(mode.value)

  return { mode, setMode }
})
