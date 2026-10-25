import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * ★ 2026-10-25 实测踩过的坑：`<template v-if="showsX">` 与 `</template>` 被塞成**相邻的一对**
 *   （prettier 之后长成 `<template v-if="showsX"> </template>`），语法合法、构建也过，
 *   但**段里什么都没有** —— 界面表现就是"这一节永远不出现"，而字符串守卫照样绿。
 *
 * 于是这里立两条**结构**不变量（不是查字面量）：
 *   ① 每个分段块（`showsX` / `showsBoxActions(...)` / `segmentIn([...])`）的**正文非空**；
 *   ② 每个动作按钮必须落在**它自己那一段**里（不能落进别的段、也不能落在段外）。
 */

/**
 * 把 HTML 注释抹成空白（注释里可能出现 `<template>` 这种字样，不能算标签）
 *
 * ★ 必须**保留换行**：抹成等长空格会把多行注释压成一行，后面的行号全错位，
 *   配对区间就会和 `text.indexOf` 算出的行号对不上（这个坑实测踩过一次）。
 */
function maskComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (matched) => matched.replace(/[^\n]/g, ' '))
}

interface Block {
  /** 段名（`v-if` 里的表达式原文） */
  expr: string
  /** 开标签所在行（1 起） */
  openLine: number
  /** 闭标签所在行 */
  closeLine: number
  /** 段内去掉空白后的正文 */
  body: string
}

/**
 * 找出 `v-if` 里带指定前缀的分段块（**按行做同标签深度配对**）
 *
 * 段可能挂在 `<template>` 上（整段），也可能挂在 `<div class="row">` 上（一行动作），
 * 所以这里按"开标签自己的标签名"配对，不假定一定是 `template`。
 */
function blocksOf(text: string, prefix: string): Block[] {
  const lines = maskComments(text).split('\n')
  const raw = text.split('\n')
  const blocks: Block[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const opened = lines[i]!.match(/<(\w[\w-]*)\b[^>]*\bv-if="([^"]+)"/)
    if (opened === null || !opened[2]!.startsWith(prefix)) continue
    const tag = opened[1]!
    const openRe = new RegExp(`<${tag}\\b`, 'g')
    const closeRe = new RegExp(`</${tag}>`, 'g')
    let depth = 0
    let close = -1
    for (let j = i; j < lines.length; j += 1) {
      const opens = (lines[j]!.match(openRe) ?? []).length
      const closes = (lines[j]!.match(closeRe) ?? []).length
      // 开闭同行的空块（正是那个坑）：先 +1 再 −1，depth 归零 ⇒ 立即判定为空段
      depth += opens - closes
      if (depth === 0) {
        close = j
        break
      }
    }
    expect(close, `${opened[2]} 那一段没有闭合`).toBeGreaterThan(0)
    blocks.push({
      expr: opened[2]!,
      openLine: i + 1,
      closeLine: close + 1,
      body: raw
        .slice(i, close + 1)
        .join('\n')
        .replace(new RegExp(`<${tag}\\b[^>]*>`, 'g'), '')
        .replace(new RegExp(`</${tag}>`, 'g'), '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim(),
    })
  }
  return blocks
}

/** 某个内容标记落在哪一段里（不落在任何分段块内则返回 `null`） */
function sectionOf(text: string, marker: string, prefix: string): string | null {
  const at = text.indexOf(marker)
  expect(at, `${marker} 不在面板里`).toBeGreaterThanOrEqual(0)
  const line = text.slice(0, at).split('\n').length
  const hit = blocksOf(text, prefix)
    .filter((block) => line > block.openLine && line < block.closeLine)
    .sort((a, b) => b.openLine - a.openLine)[0]
  return hit === undefined ? null : hit.expr
}

describe('分段块的**结构**不变量（空块 / 段错位都会红）', () => {
  it('★ SupplyPanel：五个操作段都**有正文**（不是被压成 `<template v-if> </template>`）', () => {
    const panel = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    const blocks = blocksOf(panel, 'shows')
    const flags = blocks.map((block) => block.expr)
    for (const flag of ['showsSp', 'showsDumpBlow', 'showsTransport', 'showsLoadUnload']) {
      expect(flags, `SupplyPanel 缺 ${flag} 这一段`).toContain(flag)
    }
    expect(flags, 'SupplyPanel 缺 showsExtender 这一段').toContain('showsExtender')
    for (const block of blocks) {
      expect(block.body.length, `${block.expr}（第 ${block.openLine} 行）是空段`).toBeGreaterThan(
        20,
      )
    }
  })

  it('★ SupplyPanel：每个动作按钮落在**它自己那个段**里（不串段、不落段外）', () => {
    const panel = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    const expectSection: readonly [string, string][] = [
      ['workbench.addSpDump()', 'showsSp'],
      ['workbench.destructDumpNow(', 'showsDumpBlow'],
      ['workbench.mergeTransportPointsNow()', 'showsTransport'],
      ['workbench.loadTransportPointNow()', 'showsLoadUnload'],
      ['workbench.convertTransportToExtenderNow(', 'showsExtender'],
    ]
    for (const [marker, flag] of expectSection) {
      expect(sectionOf(panel, marker, 'shows'), `${marker} 应落在 ${flag} 段里`).toBe(flag)
    }
  })

  it('★ ExclusiveRulesPanel：五节的动作门都**有正文**', () => {
    const panel = readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8')
    const blocks = blocksOf(panel, 'acts')
    for (const flag of ['actsPanzer', 'actsSecurity', 'actsHedgehog', 'actsMarker', 'actsCache']) {
      const hit = blocks.find((block) => block.expr === flag)
      expect(hit, `ExclusiveRulesPanel 缺 ${flag} 段`).toBeDefined()
      expect(hit!.body.length, `${flag} 是空段`).toBeGreaterThan(10)
    }
  })

  it('★ MovePanel：每块都挂在**本环节闸门**上，且块内确有正文', () => {
    const panel = readFileSync('src/components/move/MovePanel.vue', 'utf8')
    /*
     * ★ 用户 2026-10-25「每个阶段/环节只能出现该环节可用 UI」：
     *   修前移动面板一屏铺开（改模式 / 开始移动 / 释放预备 / 燃料 / 收束），
     *   在 B 增援、D 补给、F 战斗等环节照旧全显 —— 点了才被闸门拒。
     *   现在每块问 `actionAllowedNow(...)`：5.4a 改模式只在 C 段；6.1/8.0/12.5 跟 C/E/G 移动环节；
     *   5.7b 释放预备**只在 E/G**（修前在 C 段也显）。
     */
    for (const flag of [
      'canChangeMode',
      'canMove',
      'canOverrun',
      'canReleaseReserve',
      'canPayFuel',
    ]) {
      expect(panel, `MovePanel 缺 ${flag} 投影`).toContain(flag)
    }
    for (const key of ['move.modeChange', 'move.order', 'move.overrun', 'reserve.release']) {
      expect(panel, `MovePanel 没问 ${key} 的闸门`).toContain(`actionAllowedNow('${key}')`)
    }
    expect(panel).toContain("actionAllowedNow('supply.fuel')")

    // 燃料块：整块在 `canPayFuel` 之内，付款按钮不能在段外
    const fuel = sectionOf(panel, 'workbench.payFuel()', 'canPayFuel')
    expect(fuel, '燃料付款按钮应落在 canPayFuel 段里').toBe('canPayFuel')
    /*
     * 5.7b 那一处是**按钮自带 `v-if`**（不是一个整段块）⇒ 判法看"按钮自己的开标签"，
     * 用 `sectionOf` 会返回 null（那说明写成了段块，反而与预期不符）。
     */
    const release = panel.indexOf('workbench.releaseReserveNow()')
    expect(release).toBeGreaterThan(0)
    const releaseTag = panel.lastIndexOf('<BaseButton', release)
    expect(panel.slice(releaseTag, release)).toContain('v-if="canReleaseReserve"')

    const blocks = blocksOf(panel, 'can')
    expect(blocks.length, '移动面板应有若干按闸门收敛的块').toBeGreaterThanOrEqual(2)
    for (const block of blocks) {
      expect(block.body.length, `${block.expr}（第 ${block.openLine} 行）是空段`).toBeGreaterThan(
        20,
      )
    }
  })

  it('★ ContainersPanel：记录轨的三类"改表"按钮是**裁判工具**，只有验证页才铺', () => {
    const panel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    /*
     * 2.2 回合推进 / 1.5 天气 / 专规 1.2 铁路容量**都由系统自动结算**
     * （`docs/阶段-环节-操作矩阵.md` 的"只有这 6 个环节是自动结算"）。
     * 它们的"手动改值"入口只该在验证页（`only === null`）出现；
     * 对局台的盒会话（`only="actions"`）铺出来，就是"展开一张盒卡顺带能改回合/天气/运力"。
     */
    expect(panel).toContain('showsReferee')
    expect(panel).toContain('props.only === null')

    /** 某个点击入口最近的那道 `v-if`（按钮自带的门） */
    const gateOf = (marker: string): string => {
      const at = panel.indexOf(marker)
      expect(at, `${marker} 不在面板里`).toBeGreaterThanOrEqual(0)
      const before = panel.slice(0, at)
      const hit = before.lastIndexOf('v-if="')
      expect(hit, `${marker} 前面没有 v-if 门`).toBeGreaterThanOrEqual(0)
      const quote = hit + 'v-if="'.length
      return before.slice(quote, before.indexOf('"', quote))
    }

    for (const marker of [
      'containers.advanceTurnMarker()',
      "containers.setWeatherMarker('normal')",
      "containers.setWeatherMarker('limited')",
      'containers.setRailCapacity(',
      'containers.applyRailCapacityForDate()',
      'containers.resetContainers()',
    ]) {
      expect(gateOf(marker), `${marker} 应挂裁判工具门`).toBe('showsReferee')
    }
  })

  it('★ ReinforcementPanel：每个 `segmentIn(...)` 块都**有正文**', () => {
    const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    const blocks = blocksOf(panel, 'workbench.segmentIn(')
    expect(blocks.length, '增援面板应有按环节收敛的分段块').toBeGreaterThanOrEqual(5)
    for (const block of blocks) {
      expect(block.body.length, `${block.expr}（第 ${block.openLine} 行）是空段`).toBeGreaterThan(
        20,
      )
    }
  })
})
