/**
 * 交互收口 批 B：窗内残留说明句与条款号清扫
 *
 * 用户口径（2026-11-16）：窗内不放描述性文字；条款号收进 `?`；空态用「—」。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')
const visible = (path: string): string =>
  read(path)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

describe('批 B：窗内文案收口', () => {
  it('流程条空日志不再给教学句', () => {
    const strip = read('src/components/session/FlowStrip.vue')
    expect(strip).not.toContain('尚无日志（先点「开局」）。')
    expect(strip).toContain('class="muted">—</p>')
  })

  it('增援面板去掉整段说明，标题条款进 ?', () => {
    const panel = visible('src/components/reinforcement/ReinforcementPanel.vue')
    expect(panel).not.toContain('到达投放、重建与合并都在')
    expect(panel).not.toContain('增援与编制（13.5')
    expect(panel).toContain('<RuleTip rule="13.5"')
  })

  it('补给面板的断补说明收进折叠体，选项与按钮不带条款号', () => {
    const panel = visible('src/components/supply/SupplyPanel.vue')
    expect(panel).not.toContain('吃图上补给（12.6c，需')
    expect(panel).not.toContain('接受断补（12.6d）')
    expect(panel).not.toContain('确认断补处置（12.6c/d）')
    expect(panel).not.toContain('本阶段没有需要掷损耗的断补堆叠（12.8a/b）。')
    expect(panel).toContain('<RuleNote')
  })

  it('初设表头条款号进 ?', () => {
    const panel = visible('src/components/setup/SetupPanel.vue')
    expect(panel).not.toContain('归属（12.1d）')
    expect(panel).toContain('<RuleTip rule="12.1d"')
  })

  it('新建标记的桥不再在选项里挂条款号', () => {
    const panel = visible('src/components/containers/ContainersPanel.vue')
    expect(panel).not.toContain('桥（13.8b）')
    expect(panel).not.toContain('简易机场（15.2）')
  })
})
