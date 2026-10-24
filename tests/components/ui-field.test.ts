import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 条 24 / §5-F：正式/验证模式的**落码守卫**。
 *
 * 仓库不打 DOM（`environment: 'node'`），故这里按"源码守卫"验证机制。
 * 真正的分模式渲染由 `UiField.vue` 里的 `uiMode === 'verify'` 分支承担：
 *   验证页 → 可编辑 `<input>`；正式界面 → 只读 `<span class="ui-field-readonly">`。
 */
const root = join(process.cwd())
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

describe('条 24：正式/验证模式门控', () => {
  it('UiField：验证页渲染 input、正式界面数字型默认步进（readonly 例外）', () => {
    const src = read('src/components/UiField.vue')
    expect(src).toMatch(/v-if="uiMode === 'verify'"/)
    expect(src).toMatch(/<input/)
    expect(src).toMatch(/v-else-if="useStepper"/)
    expect(src).toMatch(/const useStepper = computed/)
    expect(src).toMatch(/props\.type === 'number'/)
    expect(src).toMatch(/function step\(/)
    expect(src).toMatch(/v-else[^>]*class="ui-field-readonly"/)
    expect(src).toMatch(/useUiMode\(\)/)
  })

  it('全局样式提供 .ui-field-readonly（各面板的只读 span 复用）', () => {
    const css = read('src/styles/base.css')
    expect(css).toMatch(/\.ui-field-readonly\s*\{/)
  })

  it('两个宿主视图各自声明模式：对局台 formal / 验证页 verify', () => {
    expect(read('src/views/GameTableView.vue')).toMatch(/provideUiMode\(\s*'formal'\s*\)/)
    expect(read('src/views/WorkbenchView.vue')).toMatch(/provideUiMode\(\s*'verify'\s*\)/)
  })

  it('AirPanel：手输文本/数字已走 UiField 或双分支只读（不再有裸 input）', () => {
    const src = read('src/components/air/AirPanel.vue')
    // 采用门控
    expect(src).toMatch(/useUiMode\(\)/)
    // 条 24「单位信息改图」：飞机清单每行带算子缩略图
    expect(src).toMatch(/air-row__thumb/)
    // @change 类字段（任务格/返航格）走 v-if=verify + 只读 span
    expect(src).toMatch(/v-if="uiMode === 'verify'"/)
    expect(src.match(/class="ui-field-readonly"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    // 剩余 <input 只应是 checkbox（游戏动作），或落在 verify 分支内。
    // 逐行核对：凡以 `<input` 起头且非 checkbox 的，必须紧邻 v-if="uiMode === 'verify'"。
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*<input\b/.test(lines[i] ?? '')) continue
      const block = lines.slice(i, i + 8).join('\n')
      const isCheckboxOrRadio = /type="(checkbox|radio)"/.test(block)
      if (isCheckboxOrRadio) continue
      // 文本/数字输入：其标签内（紧随的几行）应带 v-if="uiMode === 'verify'"
      const near = lines.slice(i, i + 4).join('\n')
      expect(near, `AirPanel 第 ${i + 1} 行的文本输入未门控：\n${block}`).toMatch(
        /v-if="uiMode === 'verify'"/,
      )
    }
  })

  it('CombatPanel：攻/守可用 T 两个数值已走 UiField', () => {
    const src = read('src/components/combat/CombatPanel.vue')
    expect(src).toMatch(/import UiField from/)
    expect(src.match(/<UiField\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('BarragePanel：5 处（含补了点图按钮的基地格）已走 UiField', () => {
    const src = read('src/components/barrage/BarragePanel.vue')
    expect(src).toMatch(/import UiField from/)
    expect(src.match(/<UiField\b/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
    // 基地格已补「点地图选基地格」按钮 ⇒ 正式界面不必手输
    expect(src).toMatch(/beginAirPlacementHexPickNow/)
    expect(src).not.toMatch(/<input v-model="workbench\.airPlacement\.hexText"/)
  })

  it('其余面板：容器(2)/专规(8)/增援(8)/补给(13) 的数值与格号已走 UiField', () => {
    const cases: Array<[string, number]> = [
      ['src/components/containers/ContainersPanel.vue', 2],
      ['src/components/exclusive/ExclusiveRulesPanel.vue', 8],
      ['src/components/reinforcement/ReinforcementPanel.vue', 8],
      ['src/components/supply/SupplyPanel.vue', 13],
    ]
    for (const [file, min] of cases) {
      const src = read(file)
      expect(src, `${file} 未引入 UiField`).toMatch(/import UiField from/)
      const uses = src.match(/<UiField\b/g)?.length ?? 0
      expect(uses, `${file} 的 UiField 用量不足（${uses} < ${min}）`).toBeGreaterThanOrEqual(min)
    }
  })

  it('条 24：数字型默认步进；销毁量（空=全部）强制只读；拆分规模保留普通输入', () => {
    const src = read('src/components/supply/SupplyPanel.vue')
    // 销毁量：空 = 全部，步进表达不了 ⇒ 显式 readonly
    expect(src).toMatch(/v-model="destroyT"[\s\S]{0,140}?readonly/)
    // 拆分规模是列表，保留普通输入（否则 13.2c 在正式界面不可用）
    expect(src).toMatch(/v-model="workbench\.transportPointInputs\.splitSizesText"/)
  })

  it('条 24：真实选择的数值改「点选」（拆分 AR / 装货 SP / 空投回合）', () => {
    const containers = read('src/components/containers/ContainersPanel.vue')
    expect(containers).toMatch(/BREAKDOWN_AR_LEVELS/)
    expect(containers).toMatch(/@click="breakdownAr = ar"/)
    expect(containers).not.toMatch(/v-model="breakdownAr"/)

    const air = read('src/components/air/AirPanel.vue')
    expect(air).toMatch(/function adjustCargoSp/)
    expect(air).toMatch(/adjustAirNum\('airdropPlannedTurn'/)
    expect(air).not.toMatch(/v-model="workbench\.airInputs\.cargoSpT"/)
  })

  it('SetupPanel：西移落点已补「点地图选落点」+ 只读分支（§5-E 补缺）', () => {
    const src = read('src/components/setup/SetupPanel.vue')
    expect(src).toMatch(/function pickShiftWestHex/)
    expect(src).toMatch(/beginHexPick\(\{/)
    expect(src).toMatch(/点地图选落点/)
    expect(src).toMatch(/v-if="uiMode === 'verify'"/)
    expect(src).toMatch(/class="ui-field-readonly"/)
  })

  it('ReinforcementPanel：重建行键从重建表数据取下拉（§5-B）+ 到货行出图（§5-A）', () => {
    const src = read('src/components/reinforcement/ReinforcementPanel.vue')
    expect(src).toMatch(/rebuildChartRows/)
    expect(src).toMatch(/v-for="row in rebuildRowChoices"/)
    expect(src).not.toMatch(/<input v-model="rebuildType"/)
    /*
     * 13.5：**不替裁判默认一行**。修前 `ref('Infantry Div step')`，重建坦克营不动下拉就按
     * 那一行的「2x Pax」扣款（静默扣错费用）⇒ 默认必须是空串，且未选行时按钮禁用。
     */
    expect(src).toMatch(/const rebuildType = ref\(''\)/)
    expect(src).not.toMatch(/ref\('Infantry Div step'\)/)
    // 未选行、或该候选是 13.5c 的永久不可重建 ⇒ 按钮禁用
    expect(src).toMatch(/const canRebuildNow = computed<boolean>/)
    expect(src).toMatch(/:disabled="!canRebuildNow"/)
    expect(src).toMatch(/rebuildCandidateBlocked/)
    // 13.5c：不可重建的候选在算子图阵列里**置灰并给原因**（不静默隐藏、也不让人点进引擎再被拒）
    expect(src).toMatch(/rebuildable === false/)
    /*
     * §5-B：**建议行只能由裁判显式采用**（引擎 `suggestRebuildRow` 出建议，界面不自动写值）。
     * 断言"写 rebuildType 的地方只有那一次点击"——若将来有人加 watch 自动采用，这里会红。
     */
    expect(src).toMatch(/suggestRebuildRow/)
    expect(src).toMatch(/采用建议/)
    expect(src.match(/rebuildType = rebuildSuggestion/g)?.length ?? 0).toBe(1)
    // §5-A：到货行按"显示名自动匹配"出图
    expect(src).toMatch(/arrivalImageUrl/)
    expect(src).toMatch(/arrival-thumb/)
  })

  it('ContainersPanel：编队收纳改「盒选」（正式界面点选图上单位、验证页保留文本框）', () => {
    const src = read('src/components/containers/ContainersPanel.vue')
    expect(src).toMatch(/function hideNowFromBox/)
    expect(src).toMatch(/formationUnitsOnMap/)
    expect(src).toMatch(/toggleFormationHide/)
    expect(src).toMatch(/formation-chip/)
    // 3 个 id 文本框只在验证页
    expect(src).toMatch(/v-if="uiMode === 'verify'"/)
  })

  it('ExclusiveRulesPanel：3.4 装甲集群**不替裁判默认**（修前默认 Guderian）', () => {
    const src = read('src/components/exclusive/ExclusiveRulesPanel.vue')
    expect(src).toMatch(/const panzerGroupChoice = ref<'' \| 'guderian' \| 'hoth'>\(''\)/)
    expect(src).not.toMatch(/panzerGroupChoice = ref<'guderian' \| 'hoth'>\('guderian'\)/)
    expect(src).toMatch(/:disabled="panzerUnitId === '' \|\| panzerGroupChoice === ''"/)
  })
})
