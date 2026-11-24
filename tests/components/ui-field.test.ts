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
    expect(src).toMatch(/function stepBy\(/)
    /*
     * 12.1a / 13.2a（2026-11-24 修 review P2）：面额可以**不是整数**（0.25 SP = 1 T）⇒
     * 步进必须按 `step` 的面额走，且 `max` 在步进分支同样夹取（修前 `max` 只绑在验证页
     * 的 `<input>` 上，正式界面一路「＋」可越过上限）。
     */
    expect(src).toMatch(/const stride = computed/)
    expect(src).toMatch(/const ceiling = computed/)
    expect(src).toMatch(/delta \* stride\.value/)
    expect(src).toMatch(/upper === null \? next : Math\.min\(next, upper\)/)
    expect(src).toMatch(/v-else[^>]*class="ui-field-readonly"/)
    expect(src).toMatch(/useUiMode\(\)/)
  })

  it('SupplyPanel：装卸量按 0.25 面额步进并带上限（13.2a / 13.2f 的"部分补给"）', () => {
    const src = read('src/components/supply/SupplyPanel.vue')
    /*
     * 2026-11-24 修 review P2：引擎已接受「0.25 的整数倍」，若面板只把 label 改成
     * "可填 0.25 的倍数"、而 UiField 收不到 `step`/`max`，正式界面仍只能 0.25 或整 SP 跳变。
     * 这里钉两处数量框（装载量 / 卸载量）的面额与上限都真的送进去了。
     */
    expect(src.match(/min="0\.25"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(src.match(/step="0\.25"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(src).toMatch(/:max="transportLoadable"/)
    expect(src).toMatch(/:max="transportUnloadable"/)
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
    /*
     * 用户 2026-11-12：任务格改为地图高亮点选，**手输格号的整体路径已删除**，
     * 因此不再要求 AirPanel 保留 `useUiMode()` / verify 分支；仍要求：
     *   · 飞机清单每行带算子缩略图；
     *   · 只读 span 仍在；
     *   · 剩余 <input 只能是 checkbox/radio。
     */
    expect(src).toMatch(/air-row__thumb/)
    expect(src.match(/class="ui-field-readonly"/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*<input\b/.test(lines[i] ?? '')) continue
      const block = lines.slice(i, i + 8).join('\n')
      const isCheckboxOrRadio = /type="(checkbox|radio)"/.test(block)
      expect(isCheckboxOrRadio, `AirPanel 第 ${i + 1} 行出现非勾选输入：\n${block}`).toBe(true)
    }
  })

  it('CombatPanel：攻/守「可用 T」读数已删除', () => {
    const src = read('src/components/combat/CombatPanel.vue')
    expect(src).not.toContain('可用 T')
    expect(src).not.toContain('attackerAvailableT')
    expect(src).not.toContain('defenderAvailableT')
  })

  it('BarragePanel：3 处已走 UiField（14.1a 摆放块已删；受损选择已改点算子图）', () => {
    const src = read('src/components/barrage/BarragePanel.vue')
    expect(src).toMatch(/import UiField from/)
    // 用户 2026-11-22：受损单位改成「点算子图分配 1 点」⇒ 原先逐单位的数值输入（第 4 处
    // UiField）随 `OpsLossPicker` 一起移出本面板，合法降为 3。剩下的仍是数值输入
    //（基地等级 / 港口伤害 / 逐机掷骰），依旧全部走 UiField。
    expect(src.match(/<UiField\b/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    // G2：摆放飞机的裁判工具整块删除 ⇒ 本面板不再有基地格输入
    expect(src).not.toMatch(/airPlacement/)
  })

  it('其余面板：专规(5)/补给(9) 的数值与格号已走 UiField', () => {
    const cases: Array<[string, number]> = [
      // 批 A：收纳盒标记格与死亡堆返场改「点地图选格」⇒ ContainersPanel 已无手输格号
      // （不再引入 UiField，见下一条守卫）。
      // 用户 2026-11-12：Shells 入口迁至炮击面板②（21.10 付款接线）后，
      // 专规面板的 Shells 表单（投递成本 / 追溯勾选）移除 ⇒ UiField 由 8 合法降为 7。
      // 用户 2026-11-13（F5）：Forage 入口迁到补给阶段面板，旧的手填 HQ 格 / 投递距离两枚也删掉
      // ⇒ 专规面板再无补给缓存输入，UiField 再降为 5。
      ['src/components/exclusive/ExclusiveRulesPanel.vue', 5],
      // 用户 2026-11-11：补员格 / 图边源格 / 方面军落点全改「点地图选格」⇒ 增援面板已无手打格号
      // 用户 2026-11-11：铁路运货的卸货格改点地图 ⇒ 又少一处手打格号
      // 批 3：延补队转换格 / 补给源格 / 轨距目标格也改点地图 ⇒ 12 合法降为 9（仍是「数值走 UiField」）
      ['src/components/supply/SupplyPanel.vue', 9],
    ]
    for (const [file, min] of cases) {
      const src = read(file)
      expect(src, `${file} 未引入 UiField`).toMatch(/import UiField from/)
      const uses = src.match(/<UiField\b/g)?.length ?? 0
      expect(uses, `${file} 的 UiField 用量不足（${uses} < ${min}）`).toBeGreaterThanOrEqual(min)
    }
  })

  it('批 A：ContainersPanel 标记格与死亡堆返场只走地图 ⇒ 不再有 UiField / 手输格号', () => {
    const src = read('src/components/containers/ContainersPanel.vue')
    expect(src).not.toMatch(/import UiField from/)
    expect(src).not.toMatch(/v-model="workbench\.formationMarkerHexText"/)
    expect(src).toContain('beginFormationMarkerHexPickNow')
    expect(src).toContain('beginDeadPileReturnHexPickNow')
  })

  it('条 24：数字型默认步进；销毁量按 12.11a 固定为全部（不再有只读输入）；拆分规模保留普通输入', () => {
    const src = read('src/components/supply/SupplyPanel.vue')
    // 批 3：旧「只读空输入 + 留空＝全部」等价于「永远全部」，直接收成一行状态，不再摆一个点不动的框
    expect(src).not.toMatch(/v-model="destroyT"/)
    expect(src).toContain('全部 SP')
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

  it('ReinforcementPanel：第三段不再开重建/整编大窗（v7.1 §4.3）+ 到货行出图（§5-A）', () => {
    const src = read('src/components/reinforcement/ReinforcementPanel.vue')
    // 重建＝死亡堆/盘面右键；整编＝盘面多选右键 ⇒ 面板不再有行键下拉、候选阵列、付费按钮
    expect(src).not.toMatch(/rebuildChartRows/)
    expect(src).not.toMatch(/rebuildRowChoices/)
    expect(src).not.toMatch(/workbench\.rebuildUnitNow\(\{/)
    expect(src).not.toMatch(/workbench\.consolidateUnitsNow\(/)
    expect(src).toMatch(/item="reinforce:endRebuild"/)
    expect(src).toMatch(/workbench\.endRebuildSegmentNow\(\)/)
    expect(src).toMatch(/rebuild-free-pax/)
    expect(src).toMatch(/rebuild-free-eq/)
    // §5-A：到货行按"显示名自动匹配"出图
    expect(src).toMatch(/arrivalImageUrl/)
    expect(src).toMatch(/arrival-thumb/)
  })

  it('SupplyPanel：D 段逐单位补给明细可展开（单位 / 格 / 判定 / 断补处置）', () => {
    const src = read('src/components/supply/SupplyPanel.vue')
    // 修前只有一行汇总（恢复 / 剩余 T / 断补 置·除 / 损耗格数），逐单位判定只在日志里
    expect(src).toMatch(/supplyAssessmentRows/)
    expect(src).toMatch(/逐单位明细/)
    expect(src).toMatch(/断补处置/)
  })

  it('SaveLoadDialog：初设中不能存档要说明原因与替代，不只写「未建会话」', () => {
    const src = read('src/components/save/SaveLoadDialog.vue')
    expect(src).toMatch(/初设中/)
    expect(src).toMatch(/先完成.*初设.*确认/)
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

  it('ExclusiveRulesPanel：3.4 装甲集群归属自动（对局台不铺算子/集群两个下拉）', () => {
    const src = read('src/components/exclusive/ExclusiveRulesPanel.vue')
    expect(src).toMatch(/const panzerGroupChoice = ref<'' \| 'guderian' \| 'hoth'>\(''\)/)
    expect(src).not.toMatch(/panzerGroupChoice = ref<'guderian' \| 'hoth'>\('guderian'\)/)
    // 归属取自算子数据；两个下拉只在裁判工具态出现
    expect(src).toMatch(/v-if="actsPanzer && showsReferee" class="row"/)
    expect(src).not.toMatch(/<div v-if="actsPanzer" class="row">/)
  })
})
