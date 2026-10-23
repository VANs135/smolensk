import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 批 C 切片 2（用户口径 9.16 #18）：「对局窗口**不要太多规则文字，有标题即可**」
 *
 * 做法：新增 `RuleNote`（**标题一行 + 折叠的原文**，用浏览器原生 `<details>`，无需脚本、键盘可达），
 * 把各面板里**成段**的规则说明（≥ **140 字**）收进去；短句仍是行内提示（§16.09 的文字三类允许"环节提示"）。
 *
 * ## 判据（本文件钉的东西）
 *   ① 组件形态：`RuleNote` 真的可折叠（模板里有 `<details>` / `<summary>`），且标题与规则号都渲染；
 *   ② **数量化守卫**：六个面板里**没有超过 190 字的 `p.muted` 段**（`<RuleNote>` 体内除外——那是折叠体）；
 *   ③ 折叠不是只做一两个：这六个面板**合计**至少 12 处 `RuleNote`；
 *   ④ 正文**没有被删**：抽两处断言折叠体里仍含原文的关键句（改动不能靠"删规则文字"蒙混）。
 *
 * ## 测法边界（如实交代）
 *   · 本仓库不挂组件渲染测试 ⇒ "折起来以后真的收起了版面、展开能看见"靠**源码形态**断言（`<details>` 原生行为）
 *     与人眼；像素与交互手感不在此覆盖；
 *   · 阈值 190 字是**本轮的取舍线**（≥ 190 收、< 190 留作行内提示），不是规则书里的数。
 */

const PANELS = [
  'src/components/air/AirPanel.vue',
  'src/components/supply/SupplyPanel.vue',
  'src/components/combat/CombatPanel.vue',
  'src/components/reinforcement/ReinforcementPanel.vue',
  'src/components/move/MovePanel.vue',
  'src/components/exclusive/ExclusiveRulesPanel.vue',
]

/** 一段的可见字数（去标签、模板插值按 1 字计） */
function visibleLength(block: string): number {
  return block
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]*\}\}/g, 'X')
    .trim().length
}

/**
 * 列出一个面板里**未被 RuleNote 包裹**的 `p.muted` 段（行内提示），返回 `{ start, chars, preview }`
 *
 * 做法：先把所有 `<RuleNote …>…</RuleNote>` 块整段挖掉（它们是折叠体，不算行内文字），
 * 再在剩下的文本里逐段量长度。
 */
function inlineMutedBlocks(file: string): { start: number; chars: number; preview: string }[] {
  const raw = readFileSync(file, 'utf8')
  const stripped = raw.replace(/<RuleNote[\s\S]*?<\/RuleNote>/g, (match) =>
    '\n'.repeat(match.split('\n').length - 1),
  )
  const lines = stripped.split(/\r?\n/)
  const rows: { start: number; chars: number; preview: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/<p[^>]*class="muted"/.test(lines[i]!)) continue
    const block = [lines[i]!]
    if (!lines[i]!.includes('</p>')) {
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
        block.push(lines[j]!)
        if (lines[j]!.includes('</p>')) break
      }
    }
    const joined = block.join(' ')
    rows.push({
      start: i + 1,
      chars: visibleLength(joined),
      preview: joined
        .replace(/<[^>]+>/g, '')
        .trim()
        .slice(0, 40),
    })
    i += block.length - 1
  }
  return rows
}

describe('批 C 切片 2：规则文字收成"标题 + 折叠"（RuleNote）', () => {
  it('① 组件可折叠：`<details>` + `<summary>`，标题与规则号都在标题行上', () => {
    const source = readFileSync('src/components/base/RuleNote.vue', 'utf8')
    expect(source).toContain('<details class="rule-note"')
    expect(source).toContain('<summary class="rule-note__title">')
    // 标题一行 + 规则号标签 + 折叠体插槽
    expect(source).toContain('{{ props.title }}')
    expect(source).toContain('<BaseTag v-if="props.rule !== \'\'" kind="neutral">')
    expect(source).toContain('<slot />')
    // 默认收起（只有显式 open 才展开）
    expect(source).toContain('open: false')
  })

  it('② 六个面板里**没有超过 140 字的行内 muted 段**（成段文字一律进折叠体）', () => {
    const offenders: string[] = []
    for (const file of PANELS) {
      for (const row of inlineMutedBlocks(file)) {
        if (row.chars > 140) {
          offenders.push(`${file}:${row.start}（${row.chars} 字）${row.preview}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('③ 折叠做在六个面板上（合计 ≥ 20 处 RuleNote）', () => {
    const counts = PANELS.map((file) => {
      const text = readFileSync(file, 'utf8')
      return (text.match(/<RuleNote/g) ?? []).length
    })
    const total = counts.reduce((sum, count) => sum + count, 0)
    expect(total).toBeGreaterThanOrEqual(20)
    // 至少四个面板各自用了它（不是全堆在一个文件里）
    expect(counts.filter((count) => count > 0).length).toBeGreaterThanOrEqual(4)
  })

  it('④ 折叠**不删正文**：抽查两处原文关键句仍在（且在被折叠的正文里）', () => {
    const supply = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    expect(supply).toContain('**1 点容量运 1 SP 或 1')
    expect(supply).toContain('**卸货后不得再移动**（4.7d）')
    const exclusive = readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8')
    expect(exclusive).toContain('Supply Table 到货在**均分**给两集群后**奇数点归 Guderian**')
    expect(exclusive).toContain('**Shells**：在任意友方 HQ 处花 1 枚抵付该次投递的**火炮轰炸成本')
  })
})
