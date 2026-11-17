import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const popover = (): string => readFileSync('src/components/game/MapActionPopover.vue', 'utf8')

/**
 * 堆叠窗文字清理（用户 2026-11-18 口径 B）
 *
 * 窗内只留：标题、按钮、排开的算子。说明 / 提示 / 状态描述 / 凑数字段名全部删掉；
 * 条款号收进标题右侧的 `?`（`ruleTags`），需要让玩家读到的东西改成算子上的角标/选中态。
 */
describe('堆叠窗只留标题、按钮、算子', () => {
  it('★ 不再有段落式说明与分块小标题', () => {
    const src = popover()
    const stack = src.slice(src.indexOf(':rule="ruleTags"'))
    expect(stack).not.toContain('<h4')
    expect(stack).not.toContain('<h5')
    expect(stack).not.toContain('<p')
    expect(stack).not.toContain('muted num')
    expect(stack).not.toContain('class="ok num"')
  })

  it('★ 整备/转场/参突/9.14 的说明文字全部删掉', () => {
    const src = popover()
    for (const text of [
      '本阶段已整备',
      '此刻不能整备',
      '已选 ',
      '航程 ',
      '突袭时谁参战',
      '合法落点',
      '进入方：',
      '运输点 · ',
      '（未选）',
    ]) {
      expect(src, `仍残留：${text}`).not.toContain(text)
    }
  })

  it('★ 条款号只从标题的 `?` 出（按当前出现的块拼）', () => {
    const src = popover()
    expect(src).toContain(':rule="ruleTags"')
    expect(src).toContain("rules.push('8.1g / 8.1h')")
    expect(src).toContain("rules.push('15.1')")
    expect(src).toContain("rules.push('14.11 / 1.4a')")
    expect(src).toContain("if (special.value !== null) return '9.14'")
  })

  it('★ 必须让玩家读到的值走角标/选中态，不占文字行', () => {
    const src = popover()
    expect(src).toContain('chip__badge')
    expect(src).toContain('chip--on')
    // 点数 / 航程 / 落点只在 title 与角标
    expect(src).toContain('{{ counter.points }}')
    expect(src).toContain('{{ air.rangeHexes }}')
    expect(src).toContain("item.chosen === null ? '—' : hexLabel(item.chosen)")
  })

  it('★ 9.14 即时结清结果只进行动日志，窗内与 `?` 都不重复', () => {
    const src = popover()
    // 窗内不渲染 notes（唯一载体是 `pushLog`，见 workbench 的 9.14 分支）
    expect(src).not.toContain('special.notes')
    expect(src).not.toContain('v-for="(note')
    // `?` 只放掷骰与按表点数，不放结清结果
    expect(src).toContain(':rule-note="ruleDetail"')
    expect(src).toContain('掷 ${split.group.die} → ${split.group.percent}%')
  })

  it('★ 9.14c 精确/不精确＝绿/红描边，不写字', () => {
    const src = popover()
    expect(src).toContain("'chip--ok': counter.exact")
    expect(src).toContain("'chip--bad': !counter.exact")
    expect(src).toMatch(/\.chip--ok\s*\{[^}]*--color-accent-2/)
    expect(src).toMatch(/\.chip--bad\s*\{[^}]*--color-accent/)
  })

  it('★ `?` 的 title 由宿主编出（规则号 + 悬停补充）', () => {
    const map = readFileSync('src/components/map/MapPopover.vue', 'utf8')
    expect(map).toContain('ruleNote?: string')
    expect(map).toMatch(/规则 \$\{props\.rule\} · \$\{props\.ruleNote\}/)
  })
})
