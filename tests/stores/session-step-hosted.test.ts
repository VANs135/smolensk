import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { sessionStepVisible } from '@/stores'

/**
 * 批二 ②：不该出现的出现了
 *
 * 现场（用户截图）：轴方 B 段「补给列车落点」窗，内容却是 13.9 整编 + 苏方 2.3c 方面军预备队。
 * 根因：`SessionStep` 把「没有宿主」和「宿主无待决」都当成 `gate === null` ⇒ 全量渲染。
 * 本节只钉判据与模板形态；像素靠人眼。
 */
describe('宿主会话：无待决 ≠ 全量渲染', () => {
  it('无宿主（验证页 / 右栏）仍全量渲染', () => {
    expect(sessionStepVisible(false, null, 'reinforce:consolidation')).toBe(true)
  })

  it('有宿主且无待决：任何节都不渲染（不再整块铺出）', () => {
    expect(sessionStepVisible(true, null, 'reinforce:consolidation')).toBe(false)
    expect(sessionStepVisible(true, null, 'reinforce:frontalReserves')).toBe(false)
  })

  it('有宿主：只渲染当前暴露项', () => {
    expect(sessionStepVisible(true, 'reinforce:consolidation', 'reinforce:consolidation')).toBe(
      true,
    )
    expect(sessionStepVisible(true, 'reinforce:consolidation', 'reinforce:frontalReserves')).toBe(
      false,
    )
  })
})

describe('游戏桌 dock：无待决时给完成态，不留空窗', () => {
  it('★ dock 有「本环节已完成」分支', () => {
    const dock = readFileSync('src/components/map/MapDock.vue', 'utf8')
    expect(dock).toContain('sessionStep === null')
    expect(dock).toContain('本环节已完成')
  })
})

describe('轴方增援窗：2.3c 块只属于苏方', () => {
  it('★ 方面军预备队 SessionStep 带 activeSide 判据', () => {
    const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    const at = panel.indexOf('title="方面军预备队')
    expect(at).toBeGreaterThan(-1)
    const stepOpen = panel.lastIndexOf('<SessionStep', at)
    expect(stepOpen).toBeGreaterThan(-1)
    expect(panel.slice(stepOpen, at)).toMatch(/activeSide === 'soviet'/)
  })
})
