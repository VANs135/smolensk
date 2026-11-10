import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * #10 / #7（用户 2026-11-10）：「移动准备窗」
 *
 * 现场：点一格即进移动准备窗并**直接展开「支付燃料」**（来源阵列 / 三种方法 / 大段说明全在屏上）；
 * 说明文字过多。
 *
 * 口径（用户原话）：「点格不该直接展开「支付燃料」；说明文字下屏，只留单位与按钮。」
 *
 * 测法边界：本仓库不挂组件渲染测试 ⇒ 这里钉**源码形态**（默认收起的状态位、门的位置、
 * 说明段落的先后顺序），像素与手感靠人眼。
 */

const panel = () => readFileSync('src/components/move/MovePanel.vue', 'utf8')

describe('#10 点格不再直接展开「支付燃料」', () => {
  it('★ 付款区默认收起：`fuelOpen` 初始为假，付款内容在 `v-if="fuelOpen"` 之内', () => {
    const text = panel()
    // 修前：付款区的门只有 `fuelPaymentDue` ⇒ 点格即张满
    expect(text).toMatch(/const fuelOpen = ref\(false\)/)
    const gate = text.indexOf('v-if="fuelOpen"')
    expect(gate).toBeGreaterThan(0)
    expect(text.indexOf('workbench.payFuel()')).toBeGreaterThan(gate)
  })

  it('★ 只留一行「加油」按钮：按钮带未加注枚数，且不再把来源读数挤在付款行里', () => {
    const text = panel()
    expect(text).toContain('加油（未加注')
    expect(text).toContain('收起加油')
    // 付款行只留按钮（来源读数已上移到开关行 ⇒ 源码里排在付款按钮之前）
    expect(text.indexOf('获批来源')).toBeLessThan(text.indexOf('支付燃料 · 未加注'))
  })

  it('付款完（不再缺油）自动收起：watch `fuelPaymentDue`', () => {
    expect(panel()).toMatch(/watch\(\s*\(\) => workbench\.fuelPaymentDue/)
  })
})

describe('#7 说明文字下屏，只留单位与按钮', () => {
  it('★ 燃料说明不再压在付款区上方（旧的行内段已移走）', () => {
    const text = panel()
    expect(text).not.toContain('加油后才能移动。')
  })

  it('★ 燃料 / 结束移动的说明沉到面板末尾（排在付款按钮与收束按钮之后）', () => {
    const text = panel()
    const fuelNote = text.indexOf('燃料：什么时候付、付几次')
    const withdrawNote = text.indexOf('结束 / 撤销 / 放弃本次移动')
    expect(fuelNote).toBeGreaterThan(text.indexOf('workbench.payFuel()'))
    expect(withdrawNote).toBeGreaterThan(text.indexOf('workbench.abortMoveNow()'))
    // 说明是折叠体（RuleNote），不是又一屏行内文字
    expect(text.slice(fuelNote - 60, fuelNote)).toContain('RuleNote')
  })

  it('★ 收束步只留按钮：`abortMoveNow` 之后到段末不再挂 muted 说明块', () => {
    const text = panel()
    const start = text.indexOf('workbench.abortMoveNow()')
    const end = text.indexOf('</SessionStep>', start)
    expect(end).toBeGreaterThan(start)
    expect(text.slice(start, end)).not.toContain('class="muted"')
  })
})
