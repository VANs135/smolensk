import { Capacitor } from '@capacitor/core'

/**
 * 运行平台判定（2026-11-19：安卓触摸屏适配）
 *
 * 只做一件事：把「当前跑在哪个壳里」写到 `document.documentElement.dataset.platform`，
 * 供 `styles/android.css` 用属性选择器整段启用 Material 3 触摸尺度。
 *
 * 纪律：
 *   · **不改任何业务状态**，不参与规则判定；
 *   · 浏览器（含手机浏览器）一律 `web`，桌面观感不受影响；
 *   · `Capacitor.getPlatform()` 在纯 Web 下返回 `web`，在安卓壳里返回 `android`。
 */
export type RuntimePlatform = 'android' | 'ios' | 'web'

/** 当前平台（不依赖 DOM，可在测试里直接调） */
export function detectPlatform(): RuntimePlatform {
  const platform = Capacitor.getPlatform()
  if (platform === 'android') return 'android'
  if (platform === 'ios') return 'ios'
  return 'web'
}

/** 把平台挂到根元素（应用装配时调用一次） */
export function applyPlatformAttribute(root?: HTMLElement): void {
  const target = root ?? (typeof document === 'undefined' ? null : document.documentElement)
  if (target === null) return
  target.dataset.platform = detectPlatform()
}

/** 是否安卓壳（组件里只有“禁用桌面拖拽”这类交互分派会用） */
export function isAndroidPlatform(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.dataset.platform === 'android'
}
