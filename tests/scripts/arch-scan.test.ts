import { describe, expect, it } from 'vitest'

import {
  RULE_LITERAL_SOURCE,
  ZERO_CALL_WHITELIST,
  cssTokensOf,
  exportedValuesOf,
  scanCssVariables,
  scanRuleLiterals,
  scanStaleWhitelist,
  scanZeroCallExports,
  scriptSectionOf,
  whitelistKeyOf,
} from '../../scripts/arch-scan.mjs'

/**
 * 架构扫描（M10①）：三类「眼睛看不见的退化」要能**红灯**
 *
 * 逐项都先造一个**故意的错**（清单 §11① 的验收口径），确认扫描抓得到；
 * 再用真实场景断言不误报（展示用的规则号、局部 CSS 变量、白名单内的旧账都不该红）。
 */

describe('M10①(a)：组件里比较规则字面量', () => {
  it('故意在组件 script 里比较规则号 ⇒ 红灯，且给出行号', () => {
    const vue = [
      '<script setup lang="ts">',
      'const blocked = computed(() => {',
      "  if (workbench.phase === 'movement') return false", // 正常的字符串比较：不报
      "  return workbench.lastRule === '9.5a'", // ★ 规则字面量比较：报
      '})',
      '</script>',
    ].join('\n')
    const issues = scanRuleLiterals({ sources: new Map([['src/components/x/Foo.vue', vue]]) })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'ruleLiteral', line: 4 })
    expect(issues[0]!.detail).toContain('9.5a')
  })

  it('展示用的规则号（`rule="9.2"` 标签、提示文案）不报', () => {
    const vue = [
      '<script setup lang="ts">',
      "const tag = { rule: '13.3f' }", // 属性赋值：展示内容，不报
      '</script>',
      '<template><BasePanel rule="9.2">见 6.1 与 专规 2.4</BasePanel></template>',
    ].join('\n')
    expect(scanRuleLiterals({ sources: new Map([['src/views/V.vue', vue]]) })).toEqual([])
  })

  it('`case` / `includes` 形态也算比较', () => {
    const vue = `<script>
switch (rule) {
  case '6.1': return true
  default: return ['9.5a'].includes(rule)
}
</script>`
    expect(scanRuleLiterals({ sources: new Map([['src/components/a.vue', vue]]) })).toHaveLength(2)
  })

  it('正则口径：认 `6.1` / `9.5a` / `13.2f` / `专规 2.4`', () => {
    const pattern = new RegExp(`^${RULE_LITERAL_SOURCE}$`)
    for (const ok of ['6.1', '9.5a', '13.2f', '专规 2.4', '1.3a', '12.7b-A'])
      expect(pattern.test(ok), ok).toBe(true)
    for (const bad of ['movement', 'x.y', '6', '6.1.2', 'A9.2'])
      expect(pattern.test(bad), bad).toBe(false)
  })

  it('`scriptSectionOf` 只取 script 段（template 里的内容不参与规则字面量扫描）', () => {
    const vue = '<template><b>9.5a</b></template>\n<script>const x = 1\n</script>'
    expect(scriptSectionOf(vue)).toContain('const x = 1')
    expect(scriptSectionOf(vue)).not.toContain('9.5a')
  })
})

describe('M10①(b)：未定义的 CSS 变量', () => {
  it('故意写一个 --color-nope ⇒ 红灯；已定义的变量不报', () => {
    const sources = new Map([
      [
        'src/components/x/Foo.vue',
        '.a { border: 1px solid var(--color-rule); color: var(--color-nope); }',
      ],
    ])
    const issues = scanCssVariables({ sources, defined: new Set(['--color-rule']) })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'cssVariable' })
    expect(issues[0]!.detail).toContain('--color-nope')
  })

  it('组件 scoped 里自定义的局部变量算已定义（不误报）', () => {
    const sources = new Map([
      ['src/components/x/Foo.vue', '.a { --local-gap: 4px; gap: var(--local-gap); }'],
    ])
    expect(
      scanCssVariables({ sources, defined: cssTokensOf(sources.get('src/components/x/Foo.vue')!) }),
    ).toEqual([])
  })

  it('cssTokensOf 取 `--name:` 声明', () => {
    const tokens = cssTokensOf(':root { --color-rule: #ccc; --space-2: 8px }')
    expect([...tokens].sort()).toEqual(['--color-rule', '--space-2'])
  })
})

describe('M10①(c)：零调用导出与白名单', () => {
  it('故意新增一个零调用导出 ⇒ 红灯', () => {
    const sources = new Map([
      ['src/engine/rules/new.ts', 'export function neverCalledHelper(): void {}\n'],
    ])
    const issues = scanZeroCallExports({ sources, whitelist: [] })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'zeroCallExport' })
    expect(issues[0]!.detail).toContain('neverCalledHelper')
  })

  it('被其它文件引用 / 仅被测试引用 ⇒ 不算零调用', () => {
    const sources = new Map([
      [
        'src/engine/rules/a.ts',
        'export function usedBySrc() {}\nexport function usedByTest() {}\n',
      ],
      ['src/stores/consumer.ts', 'import { usedBySrc } from "@/engine/rules/a"\nusedBySrc()\n'],
      ['tests/engine/a.test.ts', 'import { usedByTest } from "@/engine/rules/a"\nusedByTest()\n'],
    ])
    expect(scanZeroCallExports({ sources, whitelist: [] })).toEqual([])
  })

  it('白名单内的旧账不报；白名单外的同类符号仍报', () => {
    const sources = new Map([
      [
        'src/engine/rules/a.ts',
        'export const LEGACY_VALUE = 1\nexport const BRAND_NEW_VALUE = 2\n',
      ],
    ])
    const whitelist = [whitelistKeyOf('src/engine/rules/a.ts', 'LEGACY_VALUE')]
    const issues = scanZeroCallExports({ sources, whitelist })
    expect(issues.map((item) => item.detail)).toEqual([expect.stringContaining('BRAND_NEW_VALUE')])
  })

  it('只扫 src/{engine,stores,render,data}（组件与脚本不在射程内）', () => {
    const sources = new Map([['src/components/Foo.vue', 'export const X = 1\n']])
    expect(scanZeroCallExports({ sources, whitelist: [] })).toEqual([])
  })

  it('形态：白名单是「文件\t符号」且**只减不增**（B45 起由陈旧检查逼着删）', () => {
    /*
     * B45：34 → **28** —— 已接线的 6 条（`AIR_BASE_UNLOAD_T_PER_LEVEL_PER_PHASE` 等）被
     * `scanStaleWhitelist` 报出后删净。这里守住**历史峰值 34** 这个上限即可：本表的纪律是"只允许删"。
     */
    expect(ZERO_CALL_WHITELIST.length).toBeLessThanOrEqual(34)
    for (const key of ZERO_CALL_WHITELIST) {
      expect(key).toMatch(/^src\/(engine|stores|render|data)\/.+\.ts\t[A-Za-z_$][\w$]*$/)
    }
  })

  it('exportedValuesOf 只认值导出（类型导出不算）', () => {
    const names = exportedValuesOf(
      'export function f() {}\nexport const C = 1\nexport interface I {}\nexport type T = 1\n',
    ).map((item) => item.name)
    expect(names).toEqual(['f', 'C'])
  })
})

/* ────────── B45：「零调用白名单」的**陈旧项**也要红（接线后必须删那一行） ────────── */

/**
 * 为什么要有这一关：`ZERO_CALL_WHITELIST` 的纪律是「只允许删，不允许加」，但只靠人自觉 —— 接线之后
 * 那一行很容易被忘记（§17.71 的卸载常量、§17.79 的逐机飞法都属这一类）。陈旧项报出来，白名单才会
 * 随接线自然收敛：本轮一跑就从 34 条收敛到 28 条。
 */
describe('B45：白名单陈旧检查', () => {
  it('白名单条目已接线 ⇒ 红灯（提示删除）；仍零调用 ⇒ 不报', () => {
    const wired = [
      'export const WIRED = 1',
      'console.log(WIRED)', // 同文件内就被用了 ⇒ 计数 ≥ 2 ⇒ 白名单该删
    ].join('\n')
    const stillDead = 'export const STILL_DEAD = 1'
    const sources = new Map([
      ['src/engine/rules/x.ts', wired],
      ['src/engine/rules/y.ts', stillDead],
    ])
    const whitelist = ['src/engine/rules/x.ts\tWIRED', 'src/engine/rules/y.ts\tSTILL_DEAD']
    const issues = scanStaleWhitelist({ sources, whitelist })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'staleWhitelist', file: 'src/engine/rules/x.ts' })
    expect(issues[0]!.detail).toContain('应删除')
  })

  it('白名单指向的文件/导出已不存在 ⇒ 也红灯（条目失效）', () => {
    const sources = new Map([['src/engine/rules/z.ts', 'export const OTHER = 1']])
    const issues = scanStaleWhitelist({ sources, whitelist: ['src/engine/rules/z.ts\tGONE'] })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.detail).toContain('已失效')
  })
})
