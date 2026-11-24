import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { actionLabel } from '@/render/action-labels'

/**
 * UI-4（2026-11-25）：战报里的动作一律走中文名，未知键写「未分类」
 *
 * 仓库无组件挂载测试 ⇒ 判据分两半：
 *   ① 映射函数本身：已知键给中文、空/未知键给「未分类」、不退回英文；
 *   ② 战报面板：行头、动作下拉、重放分歧三处都用 `actionLabel(...)`，不再裸渲染 `entry.action`。
 */
describe('UI-4：战报动作走中文映射', () => {
  it('已知键给中文名，未知键与空串给「未分类」', () => {
    expect(actionLabel('move')).toBe('移动')
    expect(actionLabel('combatDice')).toBe('战斗掷骰')
    expect(actionLabel('skip+default')).toBe('跳过（采用缺省）')
    expect(actionLabel('not-a-real-key')).toBe('未分类')
    expect(actionLabel('')).toBe('未分类')
    // 不把英文键原样吐回去
    expect(actionLabel('not-a-real-key')).not.toContain('not-a-real-key')
  })

  it('战报面板三处渲染都经 actionLabel，不再裸渲染键', () => {
    const panel = readFileSync('src/components/session/SettlementLogPanel.vue', 'utf8')
    expect(panel).toContain('{{ actionLabel(entry.action) }}')
    expect(panel).toContain('{{ actionLabel(action) }}')
    expect(panel).toContain('{{ actionLabel(replay.firstDivergence.action) }}')
    expect(panel).not.toContain('{{ entry.action }}')
    expect(panel).not.toContain('{{ replay.firstDivergence.action }}')
  })
})
