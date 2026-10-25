import { globSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { refereeToolsIn } from '@/components/ui-mode'
import { UNGATED_ACTIONS } from '@/stores/action-wiring'

/**
 * **裁判工具的统一门：`showsReferee`**
 *
 * 用户 2026-10-25：「把 referee 类里对局台不该出现的按钮（addSpDump、setVictoryControlNow 等）
 * 在 UI 层**统一**按 `showsReferee` 收掉」。
 *
 * ## 判据为什么是 ui-mode 而不是 `only === null`
 *   对局台有三处**不带 `only`** 的挂载（`<ReinforcementPanel />` 的 reinforce 会话、
 *   `<BarragePanel />`、`<VictoryPanel />`）⇒ 拿 `only === null` 当"验证页"会把裁判件放进对局台。
 *   而"对局台 formal / 验证页 verify"是**宿主的属性**，两个视图都声明了。
 *
 * ## 本文件钉三件事
 *   ① **纯判据真值表**：`refereeToolsIn`（formal ⇒ 不显示，verify ⇒ 显示）；
 *   ② **逐条落地**：账本里 `kind === 'referee'` 的每一个入口，凡在组件模板里能点到，
 *      都必须落在 `showsReferee` 门内；**`playerStep` 反之**（一个都不许被这道门罩住，
 *      否则对局台会把"玩家要做的事"锁死）；
 *   ③ 每个含裁判件的面板都确实取了 `useRefereeTools()`（而不是各写一套判据）。
 */

/** 组件模板（`<script setup>` 之后的部分；SFC 的模板一定在脚本之后） */
function splitSfc(text: string): { script: string; template: string } {
  const at = text.indexOf('<template>')
  return at < 0
    ? { script: text, template: '' }
    : { script: text.slice(0, at), template: text.slice(at) }
}

/** 把 HTML 注释抹成空白（**保留换行**，否则后面行号会错位） */
function maskComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (matched) => matched.replace(/[^\n]/g, ' '))
}

interface Block {
  expr: string
  openLine: number
  closeLine: number
}

/** 文本里第 `index` 个字符所在的行（1 基） */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/**
 * 模板里所有"`v-if` 表达式提到 `showsReferee`"的分段块
 *
 * ★ 必须按**整段文本**扫开标签，不能按行匹配：仓库里几乎每个按钮都是
 *   `<BaseButton\n  v-if="showsReferee"\n  …\n>` 这种**多行开标签**，
 *   按行找 `<tag` 会漏掉（第一版就是这么漏的，报了一堆假红）。
 *   自闭合标签（`<input … />`）单独处理：块就是它自己那一行。
 *
 * 允许 `v-if="showsReferee && 其它条件"`（盒会话那种"再叠一层"的写法），
 * 所以匹配的是**表达式是否提到**这个门，而不是"恰好等于"。
 */
function refereeBlocks(template: string): Block[] {
  const masked = maskComments(template)
  const out: Block[] = []
  /*
   * 开标签的正则必须**放行属性值里的 `>`**：`v-if="… .length > 0"` 这种写法很常见，
   * 用 `[^>]*` 会在那个 `>` 处截断，于是 `v-if` 的收尾引号不见了、整块被判为"没门"。
   */
  const openRe = /<(\w[\w-]*)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/g
  let m: RegExpExecArray | null = openRe.exec(masked)
  while (m !== null) {
    const tag = m[1]!
    const tagText = m[0]
    const cond = tagText.match(/\bv-if="([^"]+)"/)
    if (cond !== null && /\bshowsReferee\b/.test(cond[1]!)) {
      const openLine = lineOf(masked, m.index)
      if (tagText.endsWith('/>')) {
        out.push({ expr: cond[1]!, openLine, closeLine: lineOf(masked, m.index + tagText.length) })
      } else {
        const pairRe = new RegExp(`<${tag}\\b|</${tag}>`, 'g')
        pairRe.lastIndex = m.index
        let depth = 0
        let closeIndex = -1
        let p: RegExpExecArray | null = pairRe.exec(masked)
        while (p !== null) {
          depth += p[0].startsWith('</') ? -1 : 1
          if (depth === 0) {
            closeIndex = p.index
            break
          }
          p = pairRe.exec(masked)
        }
        if (closeIndex > 0) {
          out.push({ expr: cond[1]!, openLine, closeLine: lineOf(masked, closeIndex) })
        }
      }
    }
    m = openRe.exec(masked)
  }
  return out
}

/** 某一行是否落在这道门里 */
function gatedAt(blocks: readonly Block[], line: number): boolean {
  return blocks.some((block) => line >= block.openLine && line <= block.closeLine)
}

/** 文本里所有 `needle` 出现的 1 基行号 */
function linesWith(text: string, needle: RegExp): number[] {
  const out: number[] = []
  text.split('\n').forEach((line, index) => {
    if (needle.test(line)) out.push(index + 1)
  })
  return out
}

/**
 * 组件里"能点到 `storeFn`"的模板行号
 *
 * 两种写法都要覆盖：
 *   · 模板**直接**调 `workbench.foo(` / `containers.foo(`；
 *   · 模板调**组件内的包装函数**（`@click="declarePanzerGroup()"` ⇒ 包装里再调 store）。
 *     包装函数的识别：脚本段里该调用回溯到最近的 `function NAME(` / `const NAME =`。
 */
function clickLinesOf(text: string, storeFn: string): number[] {
  const { script, template } = splitSfc(text)
  if (template === '') return []
  // 注释里也会出现 `containers.advanceTurnMarker()` 这种字样 ⇒ 先抹掉注释再找"能点到的呼叫"
  const visible = maskComments(template)
  const call = new RegExp(`\\.${storeFn}\\(`)

  const lines = [...linesWith(visible, call)]

  const scriptLines = script.split('\n')
  const wrappers = new Set<string>()
  scriptLines.forEach((line, index) => {
    if (!call.test(line)) return
    for (let i = index; i >= 0; i -= 1) {
      const hit = scriptLines[i]!.match(
        /(?:function\s+([a-zA-Z0-9_]+)\s*\(|const\s+([a-zA-Z0-9_]+)\s*=(?!=))/,
      )
      if (hit !== null) {
        wrappers.add((hit[1] ?? hit[2])!)
        break
      }
    }
  })
  for (const wrapper of wrappers) {
    lines.push(...linesWith(visible, new RegExp(`\\b${wrapper}\\(`)))
  }
  return [...new Set(lines)].sort((a, b) => a - b)
}

/** 组件文件（相对仓库根） */
const COMPONENTS = globSync('src/components/**/*.vue').map((path) => path.replace(/\\/g, '/'))

const kindOf = (name: string): string => UNGATED_ACTIONS[name]?.kind ?? '（未登记）'

describe('裁判工具的统一门 `showsReferee`（用户 2026-10-25）', () => {
  it('① 纯判据：formal（对局台）不显示，verify（验证页）显示', () => {
    expect(refereeToolsIn('formal')).toBe(false)
    expect(refereeToolsIn('verify')).toBe(true)
  })

  it('② 账本：referee 与 playerStep 是两类，都非空', () => {
    const entries = Object.entries(UNGATED_ACTIONS)
    const referee = entries.filter(([, entry]) => entry.kind === 'referee').map(([name]) => name)
    const player = entries.filter(([, entry]) => entry.kind === 'playerStep').map(([name]) => name)
    expect(referee.length).toBeGreaterThan(0)
    expect(player.length).toBeGreaterThan(0)
    // 被误收会把流程锁死的五条必须留在 playerStep 里
    for (const name of [
      'placePendingReplNow',
      'pickFreeRailEdgeHex',
      'pickSupplyTrainHex',
      'rollVariableReplNow',
      'setUnitLockedNow',
      'unlockSlowMobilizationNow',
      'setDumpPanzerGroupNow',
    ]) {
      expect(kindOf(name), `${name} 应是玩家步骤（对局台要留）`).toBe('playerStep')
    }
  })

  it('③ ★ 每个 referee 件在模板里都落在 `showsReferee` 门内（漏一个就红）', () => {
    const offenders: string[] = []

    for (const path of COMPONENTS) {
      const text = readFileSync(path, 'utf8')
      const blocks = refereeBlocks(splitSfc(text).template)
      for (const [name, entry] of Object.entries(UNGATED_ACTIONS)) {
        if (entry.kind !== 'referee') continue
        for (const line of clickLinesOf(text, name)) {
          if (!gatedAt(blocks, line)) offenders.push(`${path}:${String(line)} → ${name}`)
        }
      }
    }

    expect(
      offenders,
      `这些裁判件在对局台会露出来（不在 showsReferee 门内）：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('④ ★ `playerStep` 一个都不许被 `showsReferee` 罩住（否则对局台没法操作）', () => {
    const offenders: string[] = []

    for (const path of COMPONENTS) {
      const text = readFileSync(path, 'utf8')
      const blocks = refereeBlocks(splitSfc(text).template)
      for (const [name, entry] of Object.entries(UNGATED_ACTIONS)) {
        if (entry.kind !== 'playerStep') continue
        for (const line of clickLinesOf(text, name)) {
          if (gatedAt(blocks, line)) offenders.push(`${path}:${String(line)} → ${name}`)
        }
      }
    }

    expect(
      offenders,
      `这些是玩家步骤，被裁判门收掉了（流程会锁死）：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('⑤ 含裁判件的面板统一取 `useRefereeTools()`（不各写一套判据）', () => {
    for (const file of [
      'src/components/air/AirPanel.vue',
      'src/components/barrage/BarragePanel.vue',
      'src/components/containers/ContainersPanel.vue',
      'src/components/exclusive/ExclusiveRulesPanel.vue',
      'src/components/reinforcement/ReinforcementPanel.vue',
      'src/components/supply/SupplyPanel.vue',
      'src/components/victory/VictoryPanel.vue',
    ]) {
      const text = readFileSync(file, 'utf8')
      expect(text, `${file} 没用统一判据`).toContain('useRefereeTools')
      expect(text, `${file} 没有 showsReferee 门`).toContain('showsReferee')
      /*
       * 旧判据不许残留：`showsReferee` **本身**不能再由 `only === null` 推出。
       * （`showsPlace` / `showsRefit` / `showsCheck` 那些**分段**门仍可以这么写 ——
       *   那是"这一段要不要画"，与"这是不是裁判件"是两件事，AirPanel 就同时有两者。）
       */
      const code = splitSfc(text)
        .script.replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      expect(code, `${file} 的 showsReferee 仍在用 only === null`).not.toMatch(
        /showsReferee[^\n]*props\.only === null/,
      )
    }
  })

  it('⑥ 对局台与验证页各自声明了 ui-mode（门的上游不能断）', () => {
    const table = readFileSync('src/views/GameTableView.vue', 'utf8')
    const bench = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(table).toMatch(/provideUiMode\('formal'\)/)
    expect(bench).toMatch(/provideUiMode\('verify'\)/)
  })
})
