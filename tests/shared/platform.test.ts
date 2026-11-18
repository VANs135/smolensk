import { describe, expect, it } from 'vitest'

import { applyPlatformAttribute, detectPlatform } from '@/shared/platform'

/**
 * 平台判定（2026-11-19 安卓适配）
 *
 * 只钉一件事实：纯 Web / Node 下必须是 `web`，不能把桌面误判成安卓而启用触摸样式。
 * Capacitor 原生壳的 `android` 分支由壳自身保证，无需在单测里伪造原生环境。
 */
describe('平台判定', () => {
  it('Node / 浏览器环境是 web', () => {
    expect(detectPlatform()).toBe('web')
  })

  it('applyPlatformAttribute 把平台写到根元素 dataset', () => {
    const root = { dataset: {} } as unknown as HTMLElement
    applyPlatformAttribute(root)
    expect(root.dataset.platform).toBe('web')
  })
})
