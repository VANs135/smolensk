import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 界面收尾·批 2 守卫：窗内只留当前决定与控件
 *
 * 用户 2026-11-15 口径：
 *   · 窗内不放描述性 / 教学式文字；规则说明删掉；
 *   · 条款号只进 `?` / `title`；
 *   · 不可用项不出现；流程条推进被阻断时改成状态行（不是灰按钮）。
 *
 * 测法边界：本仓库不挂组件渲染测试，故这里钉**源码形态**（与既有 render 守卫一致）；
 * 像素与手感仍靠人眼验收。
 */

const read = (path: string): string => readFileSync(path, 'utf8')
const templateOf = (path: string): string => {
  const source = read(path)
  const start = source.indexOf('<template>')
  const end = source.lastIndexOf('</template>')
  expect(start, `${path} 没有根 template`).toBeGreaterThan(-1)
  /* 模板注释不渲染，不能算“窗内文字”；去掉后再断言 */
  return source.slice(start, end).replace(/<!--[\s\S]*?-->/g, '')
}
const absent = (path: string, needle: string): void =>
  expect(read(path), `${path} 仍含「${needle}」`).not.toContain(needle)
const absentInTemplate = (path: string, needle: string): void =>
  expect(templateOf(path), `${path} 模板仍含「${needle}」`).not.toContain(needle)

describe('批 2：窗内只留当前决定与控件', () => {
  it('剧本页删掉教学摘要与模式说明，条款号不进正文', () => {
    absent('src/views/ScenarioSetupView.vue', 'introSummary')
    absent('src/views/ScenarioSetupView.vue', '两格维捷布斯克')
    absent('src/views/ScenarioSetupView.vue', 'Minor Victory')
    absent('src/views/ScenarioSetupView.vue', '§4.9a')
    absent('src/views/ScenarioSetupView.vue', '初设已开始，对局模式锁定')
    absent('src/views/ScenarioSetupView.vue', ':disabled="selected === null"')
  })

  it('存档窗不再出现 Markdown 星号、原始枚举与教学说明', () => {
    absentInTemplate('src/components/save/SaveLoadDialog.vue', '**')
    absentInTemplate('src/components/save/SaveLoadDialog.vue', '本作只有一个存档槽')
    absentInTemplate('src/components/save/SaveLoadDialog.vue', '{{ errorInfo.kind }}')
    absentInTemplate('src/components/save/SaveLoadDialog.vue', ':disabled="!canSave"')
    absentInTemplate('src/components/save/SaveLoadDialog.vue', ':disabled="!slotUsable"')
  })

  it('初设队列删掉操作说明与正文条款号', () => {
    absentInTemplate('src/components/game/DecisionQueue.vue', '点击高亮格落位')
    absentInTemplate('src/components/game/DecisionQueue.vue', 'ch10 / ch11')
    absentInTemplate('src/components/game/DecisionQueue.vue', '§13.2h')
    absentInTemplate('src/components/game/DecisionQueue.vue', '（3.4b）')
    absentInTemplate('src/components/game/DecisionQueue.vue', ':disabled="!omitConfirmed')
  })

  it('地图小窗只渲染可用动作，删掉说明段落', () => {
    absent('src/components/game/MapActionPopover.vue', '本环节无可用动作')
    absent('src/components/game/MapActionPopover.vue', '这一格正是')
    absent('src/components/game/MapActionPopover.vue', '（9.14：')
    absent('src/components/game/MapActionPopover.vue', ':disabled="item.disabledReason !== null"')
  })

  it('战斗窗删掉一次性结算说明与按钮里的条款号', () => {
    absent('src/components/combat/CombatPanel.vue', '本场战斗须一次打完')
    absent('src/components/combat/CombatPanel.vue', '行使 9.10c')
    absent('src/components/combat/CombatPanel.vue', '确认后本场战斗须一次打完')
    absent('src/components/combat/CombatPanel.vue', ':disabled="cancelBlocker !== null"')
  })

  it('流程条推进被阻断时改状态行，条上不再露出条款号', () => {
    const flow = read('src/components/session/FlowStrip.vue')
    expect(flow).toContain('bar__block')
    expect(flow).toContain('v-if="showAdvance"')
    expect(flow).toMatch(
      /const showAdvance = computed\(\s*\(\) =>\s*flow\.value\.canAdvance\s*&&\s*liveBlock\.value === null/,
    )
    expect(flow).not.toContain('class="bar__rule num"')
  })

  it('操作反馈：中文语义名，不再把 info/success 当标签文字', () => {
    const strip = read('src/components/game/ActionFeedbackStrip.vue')
    expect(strip).toContain('TONE_LABELS')
    expect(strip).not.toContain('{{ row.tone }}')
    absent('src/components/game/ActionFeedbackStrip.vue', '暂无反馈')
  })

  it('超堆叠窗删掉说明与灰按钮', () => {
    absent('src/components/game/OverstackPanel.vue', '环节末：')
    absent('src/components/game/OverstackPanel.vue', '没有“忽略”')
    absent('src/components/game/OverstackPanel.vue', ':disabled="!workbench.overstackSettled"')
  })

  it('突围窗删掉标题条款号、顶部说明与提示里的规则号', () => {
    absent('src/components/breakout/BreakoutPanel.vue', '突围（12.8e）')
    absent('src/components/breakout/BreakoutPanel.vue', '突围环节：地图上')
    absent('src/components/breakout/BreakoutPanel.vue', 'hint="12.8e')
  })

  it('会话步骤不再渲染第二行“该怎么做”（批 4 起只留一行当前决定）', () => {
    const step = read('src/components/session/SessionStep.vue')
    // 批 2 的原意：不铺教学式第二行；批 4 把决定行收成一行 `step__decision`，只输出 decision 一句话
    expect(step).not.toContain('{{ step.why }}')
    expect(step.match(/class="step__decision"/g) ?? []).toHaveLength(1)
    expect(step).toContain('{{ step.decision }}')
  })
})
