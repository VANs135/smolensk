import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * #10 / #7（用户 2026-11-10）：「移动准备窗」
 *
 * 现场与口径：
 *   · #10 点一格即进移动准备窗并**直接展开「支付燃料」**；
 *   · 后续更正：**加油不是"点选某一步"，而是右键菜单里的一项** ⇒ 移动准备窗不再承载付款区，
 *     「点单位/点格 → 移动窗口 → 直接跳到加油流程」这条入口整体删掉。
 *
 * 测法边界：本仓库不挂组件渲染测试 ⇒ 这里钉**源码形态**（付款区已移出、说明仍在末尾），
 * 像素与手感靠人眼。
 */

const movePanel = () => readFileSync('src/components/move/MovePanel.vue', 'utf8')
const fuelPanel = () => readFileSync('src/components/fuel/FuelPanel.vue', 'utf8')

describe('#10 移动准备窗不再承载「支付燃料」（入口改为右键）', () => {
  it('★ 付款区已移出：移动窗不再出现 payFuel / 加油按钮 / 来源阵列', () => {
    const text = movePanel()
    expect(text).not.toContain('workbench.payFuel()')
    expect(text).not.toContain('加油（未加注')
    expect(text).not.toContain('UI_COPY.paySource')
    expect(text).not.toContain('item="move:fuel"')
  })

  it('★ 加油窗存在且只做这一法：受注单位 + 来源 + 付款 + 确认', () => {
    const text = fuelPanel()
    expect(text).toContain('workbench.payFuel()')
    expect(text).toContain('workbench.pickFuelDump')
    expect(text).toContain('workbench.fuelSubjectId')
    expect(text).toContain('mapView.cancelSession()')
  })

  it('★ 点选单位/格子不再自动进入加油流程：会话里没有 fuelPaymentDue 自动跳转', () => {
    const mapView = readFileSync('src/stores/map-view.ts', 'utf8')
    // 旧自动跳转（kind:'move' + 标题「移动 / 燃料」）已删
    expect(mapView).not.toContain('移动 / 燃料（6.1 / 12.5）')
    // 加油会话由右键受注单位驱动
    expect(mapView).toContain('workbench.fuelSubjectId !== null')
  })
})

describe('#7 说明文字下屏，只留单位与按钮', () => {
  it('★ 结束移动的说明沉到面板末尾（排在收束按钮之后，且是折叠体）', () => {
    const text = movePanel()
    const note = text.indexOf('结束 / 撤销 / 放弃本次移动')
    expect(note).toBeGreaterThan(text.indexOf('workbench.abortMoveNow()'))
    expect(text.slice(note - 60, note)).toContain('RuleNote')
  })

  it('★ 收束步只留按钮：`abortMoveNow` 之后到段末不再挂 muted 说明块', () => {
    const text = movePanel()
    const start = text.indexOf('workbench.abortMoveNow()')
    const end = text.indexOf('</SessionStep>', start)
    expect(end).toBeGreaterThan(start)
    expect(text.slice(start, end)).not.toContain('class="muted"')
  })

  it('★ 加油窗的规则原文在末尾折叠，屏上只有单位与按钮', () => {
    const text = fuelPanel()
    const note = text.indexOf('燃料：三种付法与时点')
    expect(note).toBeGreaterThan(text.indexOf('workbench.payFuel()'))
    expect(text.slice(note - 60, note)).toContain('RuleNote')
  })
})
