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
  /** 开标签自己的标签名（决定"多长才算有内容"，见 `minBody`） */
  tag: string
  /** 开标签所在行（1 起） */
  openLine: number
  /** 闭标签所在行 */
  closeLine: number
  /** 段内去掉空白后的正文 */
  body: string
}

/**
 * 这一块"算不算有内容"的门槛
 *
 * 整段块（`<template>` / `<div class="row">`）要求 > 20 个字符——专抓
 * "开闭被压成相邻一对"那种形态；**单个控件**（按钮 / 输入 / 标签）本身就是内容，
 * `开始移动` 这类四字标签也算有内容 ⇒ 门槛降到 1。
 */
function minBody(block: Block): number {
  return ['BaseButton', 'input', 'label', 'select', 'UiField'].includes(block.tag) ? 1 : 20
}

/** 文本里第 `index` 个字符所在的行（1 基） */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/**
 * 找出 `v-if` 里带指定前缀的分段块（按**同名标签**做深度配对）
 *
 * 段可能挂在 `<template>` 上（整段），也可能挂在 `<div class="row">` / `<BaseButton>` 上
 * （一行动作 / 一个按钮），所以按"开标签自己的标签名"配对，不假定一定是 `template`。
 *
 * ★ 必须按**整段文本**扫开标签，不能按行匹配：仓库里几乎每个按钮都是
 *   `<BaseButton\n  v-if="showsReferee"\n  @click=…\n>` 这种**多行开标签**，按行找 `<tag`
 *   会整块漏掉（第一版就是这么漏的 —— 假绿的正是"裁判件没被门盖住"这种）。
 * ★ 开标签的正则要放行**属性值里的 `>`**（`v-if="… .length > 0"` 很常见），
 *   否则会在那个 `>` 处截断，`v-if` 的收尾引号就丢了。
 */
function blocksOf(text: string, prefix: string): Block[] {
  const masked = maskComments(text)
  const blocks: Block[] = []
  const openRe = /<(\w[\w-]*)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/g

  for (let m = openRe.exec(masked); m !== null; m = openRe.exec(masked)) {
    const tag = m[1]!
    const tagText = m[0]
    const cond = tagText.match(/\bv-if="([^"]+)"/)
    if (cond === null || !cond[1]!.startsWith(prefix)) continue
    const openLine = lineOf(masked, m.index)

    // 自闭合（`<input … />`）：块就是它自己那一行，正文按"它本身"算（叶子控件不是空段）
    if (tagText.endsWith('/>')) {
      blocks.push({
        expr: cond[1]!,
        tag,
        openLine,
        closeLine: lineOf(masked, m.index + tagText.length),
        body: tagText,
      })
      continue
    }

    const pairRe = new RegExp(`<${tag}\\b|</${tag}>`, 'g')
    pairRe.lastIndex = m.index
    let depth = 0
    let closeIndex = -1
    for (let p = pairRe.exec(masked); p !== null; p = pairRe.exec(masked)) {
      depth += p[0].startsWith('</') ? -1 : 1
      if (depth === 0) {
        closeIndex = p.index
        break
      }
    }
    expect(closeIndex, `${cond[1]} 那一段没有闭合`).toBeGreaterThan(0)

    blocks.push({
      expr: cond[1]!,
      tag,
      openLine,
      closeLine: lineOf(masked, closeIndex),
      /*
       * 正文＝**开闭之间的原文**（只抹掉注释、压空白），**保留内部标签**：
       * 一个"只有按钮、没有文字"的段（`<div v-if="canMove"><BaseButton…/></div>`）
       * 也是**有内容**的；若把内部标签一起剥掉，就会把这种段误判成空段。
       */
      body: masked
        .slice(m.index + tagText.length, closeIndex)
        .replace(/\s+/g, ' ')
        .trim(),
    })
  }
  return blocks
}

/**
 * 由**内到外**列出所有把 `marker` 包住的同前缀块
 *
 * 用途：一个按钮可能**嵌套**在两道门里（例 `showsSp` 段里再套 `showsReferee`），
 * 只看最内那道就会丢掉"它属哪个操作段"的信息。
 */
function sectionsOf(text: string, marker: string, prefix: string): string[] {
  const at = text.indexOf(marker)
  expect(at, `${marker} 不在面板里`).toBeGreaterThanOrEqual(0)
  const line = text.slice(0, at).split('\n').length
  return blocksOf(text, prefix)
    .filter((block) => line > block.openLine && line < block.closeLine)
    .sort((a, b) => b.openLine - a.openLine)
    .map((block) => block.expr)
}

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
      expect(
        block.body.length,
        `${block.expr}（第 ${block.openLine} 行，<${block.tag}>）是空段`,
      ).toBeGreaterThan(minBody(block) - 1)
    }
  })

  it('★ SupplyPanel：每个动作按钮落在**它自己那个段**里（不串段、不落段外）', () => {
    const panel = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')

    /** 玩家动作：最内那道门就是它所属的**操作段** */
    const expectSection: readonly [string, string][] = [
      ['workbench.destructDumpNow(', 'showsDumpBlow'],
      ['workbench.mergeTransportPointsNow()', 'showsTransport'],
      ['workbench.loadTransportPointNow()', 'showsLoadUnload'],
      ['workbench.convertTransportToExtenderNow(', 'showsExtender'],
    ]
    for (const [marker, flag] of expectSection) {
      expect(sectionOf(panel, marker, 'shows'), `${marker} 应落在 ${flag} 段里`).toBe(flag)
    }

    /*
     * 裁判工具（12.1b 建站 / 移除、12.6a 补给源、13.3f 换轨账本）：
     * 最内那道门是 `showsReferee`，但它**仍必须留在自己那个操作段里**
     * （对局台不铺 ≠ 可以飘到别的段去）。
     */
    const expectReferee: readonly [string, string][] = [
      ['workbench.addSpDump()', 'showsSp'],
      ['workbench.removeSpDump(', 'showsSp'],
      ['workbench.addSupplySource()', 'showsLedger'],
      ['workbench.removeSupplySource(', 'showsLedger'],
      ['workbench.seedConvertedRailsNow()', 'showsLedger'],
      ['workbench.clearConvertedRailsNow()', 'showsLedger'],
    ]
    for (const [marker, outer] of expectReferee) {
      const chain = sectionsOf(panel, marker, 'shows')
      expect(chain[0], `${marker} 应由 showsReferee 收（对局台不铺）`).toBe('showsReferee')
      expect(chain, `${marker} 还应留在 ${outer} 段里`).toContain(outer)
    }
  })

  it('★ ExclusiveRulesPanel：五节的动作门都**有正文**', () => {
    const panel = readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8')
    const blocks = blocksOf(panel, 'acts')
    for (const flag of ['actsPanzer', 'actsSecurity', 'actsHedgehog', 'actsMarker', 'actsCache']) {
      const hit = blocks.find((block) => block.expr === flag)
      expect(hit, `ExclusiveRulesPanel 缺 ${flag} 段`).toBeDefined()
      expect(hit!.body.length, `${flag} 是空段`).toBeGreaterThan(minBody(hit!) - 1)
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
      expect(
        block.body.length,
        `${block.expr}（第 ${block.openLine} 行，<${block.tag}>）是空段`,
      ).toBeGreaterThan(minBody(block) - 1)
    }
  })

  it('★ AirPanel：任务分配表单（14.2f-A/B）只在 A–B 两步出现，宣布后收起', () => {
    const panel = readFileSync('src/components/air/AirPanel.vue', 'utf8')
    /*
     * 用户 2026-10-25：修前「任务类型 / 任务格 / 参战机 / 执行任务」整块**永远在**
     * ——哪怕任务已宣布、正在 14.2f-C 的空战 / 拦截 / 防空里逐轮结算。
     * 判据取自引擎步骤机（`airState.step` ∈ declare / move，或尚未宣布）。
     */
    expect(panel).toContain('showsAssign')
    for (const step of ["'declare'", "'move'"]) {
      expect(panel, `showsAssign 应认步骤 ${step}`).toContain(step)
    }
    expect(panel).toContain('workbench.airState?.step')

    // 段里必须有真内容（不是被压成空对），且"选任务类型"确实落在里面
    const blocks = blocksOf(panel, 'showsAssign')
    expect(blocks.length, 'AirPanel 应有 showsAssign 的分段块').toBeGreaterThanOrEqual(1)
    for (const block of blocks) {
      expect(
        block.body.length,
        `${block.expr}（第 ${block.openLine} 行，<${block.tag}>）是空段`,
      ).toBeGreaterThan(minBody(block) - 1)
    }
    expect(sectionOf(panel, 'workbench.runAirMissionWithKind(', 'showsAssign')).toBe('showsAssign')
    // 中段要有"表单已收起"的说明（不静默消失）
    expect(panel).toContain('v-if="!showsAssign"')
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
      expect(
        block.body.length,
        `${block.expr}（第 ${block.openLine} 行，<${block.tag}>）是空段`,
      ).toBeGreaterThan(minBody(block) - 1)
    }
  })
})
