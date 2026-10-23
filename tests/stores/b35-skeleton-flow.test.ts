import { readFileSync, readdirSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { auxCards, panelScans } from '@/data'
import { useWorkbenchStore } from '@/stores'

/**
 * B35 切片 B：对局台骨架（流程条上移 / 删工具按钮 / 删纯文字面板 / 右栏收窄）
 *
 * 用户口径 2026-09-16：
 *   #6「流程框画出一条直线放地图窗口的上方……里面只留下关键字……（仅限空军）这种括号里的字不用加」；
 *   #10「地图窗口上方的**移动和战斗按钮在对局界面是不需要的**。测试界面才需要」；
 *   #18「对局窗口不要出现太多规则文字，有标题即可」。
 *
 * ★ 一条**测法边界（如实）**：本仓库**不挂组件渲染测试** ⇒ "流程条真的画在地图上方、且只剩关键字"
 *   只由**源码守卫 + 人眼在浏览器里看**（没有像素级断言）；`combatPickActive` 的**语义**
 *   （本环节允许 `combat.declare`）由 store 级用例钉住 —— 它引用的就是闸门表 `allowedActionsOf`，
 *   与 `requireAction` 同源，故"界面判据"与"闸门判据"不会走散。
 */
describe('B35：流程条 / 工具按钮 / 纯文字面板（源码守卫）', () => {
  it('★ 流程条挂在地图上方，且是 `bar` 形态（只留阶段 / 环节 / 推进 / 一行提示）', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).toContain('<FlowStrip variant="bar" />')
    // 位置：模板里 FlowStrip 必须在 <MapCanvas> **之前**
    expect(game.indexOf('<FlowStrip variant="bar" />')).toBeLessThan(game.indexOf('<MapCanvas'))

    const strip = readFileSync('src/components/session/FlowStrip.vue', 'utf8')
    expect(strip).toContain("variant?: 'panel' | 'bar'")
    expect(strip).toContain("const isBar = computed<boolean>(() => props.variant === 'bar')")
    const barStart = strip.indexOf('<div v-if="isBar" class="bar">')
    const barEnd = strip.indexOf('<BasePanel v-else title="流程条（2.2 流程表）">')
    expect(barStart).toBeGreaterThan(0)
    expect(barEnd).toBeGreaterThan(barStart)
    const bar = strip.slice(barStart, barEnd)
    // bar 里只有四样（＋被拒时的一行）
    expect(bar).toContain('bareLabel(phaseLabel)')
    expect(bar).toContain('bareLabel(segmentLabel)')
    expect(bar).toContain('进入下一环节')
    expect(bar).toContain('mapView.actionHint')
    // 阶段灯 / 日志 / 重置 / 5.0b 勾选 / 共识提示**不在** bar 里
    for (const heavy of [
      'strip__cell',
      '会话日志',
      'resetGame()',
      'earlyDecisionMet',
      'agreedRecorded',
    ]) {
      expect(bar, `bar 里不该有 ${heavy}`).not.toContain(heavy)
    }
    // 去括号（口径 #6：「（仅限空军）这种括号里的字不用加」）
    expect(strip).toContain('function bareLabel(text: string): string')
    expect(strip).toContain("text.replace(/（[^）]*）/gu, '')")
  })

  it('★ 对局台不再有"移动 / 战斗"工具按钮；点地图算不算选战斗改由**闸门**推', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).not.toContain('TOOL_OPTIONS')
    expect(game).not.toContain('workbench.setTool(')
    expect(game).not.toContain('tool === option.key')

    // 判据点全部改看派生量（不再让玩家先切工具）
    const mapView = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(mapView).not.toContain("workbench.tool === 'battle'")
    expect(mapView).toContain('workbench.combatPickActive')
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).not.toContain("workbench.tool === 'battle'")
    expect(popover).toContain('workbench.combatPickActive')

    // `tool` 本体保留（验证页与流程用例仍靠它；只是不再出现在对局台的按钮上）
    const wb = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(wb).toContain("const tool = ref<'move' | 'place' | 'battle'>('move')")
    expect(wb).toContain('const combatPickActive = computed<boolean>(')
    expect(wb).toContain("allowedActionsOf(segmentGateQuery.value).has('combat.declare')")
  })

  it('★ 5 处纯文字面板已删；右栏收到 320px（口径 #18）', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    for (const dead of [
      '局况与观察方（4.9a）',
      '燃料与补给来源（12.5 / 12.3a）',
      '已**不再作任何付款来源**',
      '侧栏不再常驻这两块控件',
      '结算进行中：',
    ]) {
      expect(game, `还有纯文字面板残留：${dead}`).not.toContain(dead)
    }
    expect(game).toContain('grid-template-columns: minmax(0, 1fr) 320px;')
    expect(game).not.toContain('grid-template-columns: minmax(0, 1fr) 400px;')
  })
})

/**
 * 批 D 切片 1（方案 §3 批 D 步骤 1、步骤 2、步骤 4）
 *
 * 「界面收口」三件事：① 右栏那份 panel 形态流程条**删掉**（只留地图上方那条线）；
 * ② 盒图按口径 #12 收口（算子贴图 18 → 32–40px、分区底不再盖卡面、去掉分区标签上的规则号）；
 * ③ 辅助卡：删孤儿图（`public/aux-cards/` 里没有任何清单引用的那张）、改掉陈旧 note
 * （托盘里的"数据表"那一面在 B35 切片 A 已删，note 却还写着"下方数据表…"）。
 */
describe('批 D 切片 1：界面收口（右栏 / 盒图 / 辅助卡）', () => {
  it('① 右栏只留只读信息：`<FlowStrip />` 那一份已从对局台删除，bar 那份仍在地图上方', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    // 只有 bar 形态那一处（模板里 `<FlowStrip variant="bar" />` **恰好一次**）
    expect((game.match(/<FlowStrip/g) ?? []).length).toBe(1)
    expect(game).toContain('<FlowStrip variant="bar" />')
    // panel 形态本身仍留给引擎验证页
    const bench = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(bench).toContain('<FlowStrip stepwise />')
    expect(readFileSync('src/components/session/FlowStrip.vue', 'utf8')).toContain(
      "variant?: 'panel' | 'bar'",
    )
  })

  it('② 盒图：算子 32–40px（按显示宽度分档）、分区底不盖卡面、分区标签无规则号', () => {
    const face = readFileSync('src/components/game/BoxCardFace.vue', 'utf8')
    // 尺寸：18px 一律 → 按宽度分档的 computed（托盘 32 / 浮窗 40）
    expect(face).not.toContain('width: 18px')
    expect(face).toContain(
      'const unitSizePx = computed<number>(() => (props.width >= 420 ? 40 : 32))',
    )
    expect(face).toContain(':style="{ width: `${unitSizePx}px`, height: `${unitSizePx}px` }"')
    // 分区底：不再铺白底（卡面透出来）
    expect(face).not.toContain('rgb(255 255 255 / 0.72)')
    expect(face).not.toContain('background: rgb(255 255 255')
    // 分区标签：规则号那一段已删（样式与模板都不留）
    expect(face).not.toContain('face__region-rule')
    expect(face).toContain('{{ region.label }}')
  })

  it('③ 辅助卡：`public/aux-cards/` 里没有"没人引用"的孤儿图，且旧 note 已改', () => {
    const declared = new Set<string>()
    for (const card of auxCards.cards) declared.add(card.image)
    for (const scan of panelScans.scans) declared.add(scan.image)
    const onDisk = readdirSync('public/aux-cards')
    const orphans = onDisk.filter((name) => !declared.has(name))
    expect(orphans, '这些图没有任何清单引用（同步脚本只拷不删，删条目会留孤儿）').toEqual([])
    // note 不再提"数据表"那一面（B35 切片 A 已把它从托盘删掉）
    const stale = panelScans.scans.filter((scan) => (scan.note ?? '').includes('数据表'))
    expect(stale.map((scan) => scan.id)).toEqual([])
  })
})

describe('B35：`combatPickActive` 的语义（＝本环节允不允许宣布战斗）', () => {
  const newStore = () => {
    setActivePinia(createPinia())
    return useWorkbenchStore()
  }

  it('★ 走到 F 战斗段的战斗环节 ⇒ true；C 移动段的移动环节 ⇒ false', () => {
    const store = newStore()
    store.setPhase('combat')
    const combatIndex = store.playerSegmentSteps.findIndex((step) => step.id === 'combat.combat')
    if (combatIndex < 0) throw new Error('F 段没有战斗环节？')
    expect(store.setSegmentStepIndex(combatIndex)).toBe(true)
    expect(store.combatPickActive).toBe(true)

    // C 移动段的移动环节：本环节只放行移动类动作 ⇒ 不算在选战斗
    store.setPhase('movement')
    const moveIndex = store.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.modeAndMovement',
    )
    if (moveIndex < 0) throw new Error('C 段没有移动环节？')
    expect(store.setSegmentStepIndex(moveIndex)).toBe(true)
    expect(store.combatPickActive).toBe(false)
  })
})
