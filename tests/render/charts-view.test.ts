import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { chartsCrt, chartsSupplyRepl, chartsTables, chartsTec, markers } from '@/data'
import {
  arrivalTableView,
  chartSources,
  crtResultCodes,
  crtViews,
  gridTableViews,
  rebuildTableViews,
  replTableViews,
  specialReplTableViews,
  supplyTableViews,
  tecLegend,
  tecTableView,
  turnWeatherTableView,
} from '@/render/charts-view'
import { useWorkbenchStore } from '@/stores'

/**
 * B16：**表格屏的只读投影**（方案 §5 底部托盘「表格」段 + §6「`charts.*` 视图模型」）
 *
 * 五屏的目标是「玩家在需要时能就地对照表」：CRT（含六个同伴表）/ 补给与补员 / TEC / 回合与天气 / 到货。
 *
 * 本文件钉三件事：
 *   ① **与数据文件逐格一致**（防手抄——方案 §8 的门禁就是这么要求的）：行数、列数、单元格文本；
 *   ② **不丢行**：CRT 的四条地形线各摊一张、六张网格表都在、补给与补员两方都在；
 *   ③ **右栏只读**（B16c）：胜利面板默认**不含任何可写控件**，裁判工具只在验证页那一份上出现。
 */

describe('B16：CRT 与六张同伴表', () => {
  it('★ CRT：四条地形线各一张，行/列/单元格与数据文件逐格一致', () => {
    const views = crtViews()
    expect(views).toHaveLength(4)
    for (const view of views) {
      expect(view.rows).toEqual([...chartsCrt.crt.diceRows])
      const line = view.title.replace('CRT（9.9）· ', '')
      expect(view.columns).toEqual([...(chartsCrt.crt.terrainColumns[line] ?? [])])
      expect(view.cells).toHaveLength(chartsCrt.crt.matrix.length)
      // 逐格比对（任取几行也全量比：矩阵不大，比全了才叫"防手抄"）
      view.cells.forEach((row, index) => {
        expect(row).toEqual([...chartsCrt.crt.matrix[index]!])
      })
    }
  })

  it('CRT 结果代码释义照录数据（有就给，没有就空）', () => {
    const codes = crtResultCodes()
    const expected = Object.entries(chartsCrt.crt.resultCodes ?? {})
    expect(codes).toHaveLength(expected.length)
    for (const item of codes) expect(item.text).not.toBe('')
  })

  it('★ 六张网格表（轰炸 / 对设施 / 夺取 / 防空 / 奇袭 / 损耗）都在，且行列表头一致', () => {
    const views = gridTableViews()
    expect(views.map((view) => view.id)).toEqual(chartsTables.tables.map((table) => table.id))
    for (const view of views) {
      const source = chartsTables.tables.find((table) => table.id === view.id)!
      expect(view.rows).toEqual(source.rows.map((row) => String(row)))
      expect(view.columns).toEqual([...(source.columns ?? [])])
      expect(view.cells).toEqual(source.grid.map((row) => [...row]))
    }
  })
})

describe('B16：补给与补员屏', () => {
  it('★ 补给表：两方各一张，8/19 前后两列来自数据', () => {
    const views = supplyTableViews()
    expect(views.map((view) => view.id)).toEqual(['supply-axis', 'supply-soviet'])
    for (const view of views) {
      const side = view.id.endsWith('axis') ? 'axis' : 'soviet'
      const source = chartsSupplyRepl.supply[side]
      expect(view.rows).toEqual([...source.rows])
      expect(view.columns).toEqual(['8/19 前', '8/19 起'])
      expect(view.cells).toEqual(
        source.rows.map((_row, index) => [
          String(source.spBefore19Aug[index] ?? ''),
          String(source.spFrom19Aug[index] ?? ''),
        ]),
      )
    }
  })

  it('★ 补员表：行数＝值域数、列＝四类补员，单元格照录', () => {
    for (const view of replTableViews()) {
      const side = view.id.endsWith('axis') ? 'axis' : 'soviet'
      const source = chartsSupplyRepl.repl[side]
      expect(view.columns).toEqual([...source.columns])
      expect(view.rows).toHaveLength(source.rows.length)
      expect(view.cells).toEqual(source.grid.map((row) => row.map((value) => String(value))))
    }
  })

  it('特殊补员与重建表都在（专规 1.6c / 13.5）', () => {
    expect(specialReplTableViews()).toHaveLength(2)
    for (const view of rebuildTableViews()) {
      expect(view.rows.length).toBeGreaterThan(0)
      expect(view.columns).toEqual(['重建方式'])
      // 每一行都要有可读文本（费用或来源），不留空单元格
      for (const row of view.cells) expect(row[0]).not.toBe('')
    }
  })
})

describe('B16：TEC 屏', () => {
  it('★ 列＝三种机动模式的 MP + 三种攻方类别的修正 + 战斗线；行＝地形逐条', () => {
    const view = tecTableView()
    expect(view.rows).toEqual(chartsTec.tec.features.map((feature) => feature.feature))
    expect(view.columns).toEqual([
      ...chartsTec.tec.mobilityModes.map((mode) => `MP·${mode}`),
      ...chartsTec.tec.attackerTypes.map((type) => `攻·${type}`),
      '战斗线',
    ])
    expect(view.cells).toHaveLength(chartsTec.tec.features.length)
    for (const row of view.cells) {
      // 每格都要有文本：MP 三列 + 攻三列 + 战斗线（数据里全有）
      for (const cell of row) expect(typeof cell).toBe('string')
      expect(row[row.length - 1]).not.toBe('')
    }
  })

  it('TEC 图例照录数据（键值一一对应）', () => {
    const legend = tecLegend()
    expect(legend).toHaveLength(Object.keys(chartsTec.tec.legend ?? {}).length)
  })
})

describe('B16：回合与天气屏', () => {
  it('★ 行＝回合轨逐格；三列＝日期 / 天气档 / 铁路容量（容量按专规 1.2 的提升日期切换）', () => {
    const view = turnWeatherTableView()
    expect(view.rows).toEqual(markers.turnTrack.map((row) => `${String(row.turn)} 回合`))
    expect(view.columns).toEqual(['日期', '天气（1d6）', '铁路容量 轴 / 苏'])
    expect(view.cells).toHaveLength(markers.turnTrack.length)
    for (const [index, row] of view.cells.entries()) {
      expect(row[0]).toBe(markers.turnTrack[index]!.date)
      expect(row[1]).toContain('受限飞行')
      expect(row[2]).toMatch(/\d+ \/ \d+/)
    }
  })
})

describe('B16：到货屏', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    workbench = useWorkbenchStore()
  })

  it('没有到达计划 ⇒ 返回 null（托盘显示"当日无到货卡"）', () => {
    expect(arrivalTableView(null)).toBeNull()
  })

  it('★ 有计划时逐条列出（数量 / 落点 / 备注），行数与计划一致', () => {
    /*
     * 到达卡按日期给（13.6）⇒ 逐个回合试到有卡的那一天（不写死"第几回合有货"，
     * 那是数据的事；本用例要钉的是**映射**，不是"哪天有卡"）。
     */
    let plan = null
    for (let turn = 1; turn <= 19 && plan === null; turn += 1) {
      workbench.setTurn(turn)
      workbench.setPhase('reinforcement')
      plan = workbench.arrivalPlan
    }
    expect(plan, '19 个回合里应当至少有一天有到达卡（否则本用例无从验证）').not.toBeNull()

    const view = arrivalTableView(plan)
    expect(view).not.toBeNull()
    expect(view!.rows).toHaveLength(plan!.units.length)
    expect(view!.columns).toEqual(['数量', '落点', '备注'])
    for (const row of view!.cells) {
      expect(row[0]).toMatch(/^\d+×$/)
      expect(row[1]).not.toBe('')
    }
  })
})

describe('B16：数据来源自检', () => {
  it('表格数据文件的版本都能报出来（托盘折叠头上会写版本）', () => {
    const sources = chartSources()
    expect(sources.map((item) => item.file)).toEqual([
      'charts-crt.json',
      'charts-tables.json',
      'charts-supply-repl.json',
      'charts-tec.json',
      // B22：印卡扫描图的清单也是一份来源（表格屏能直接看原卡）
      'panel-scans.json',
    ])
    for (const item of sources) expect(item.version).not.toBe('')
  })
})

describe('B16：托盘与右栏的接线（源码守卫）', () => {
  /**
   * ★ B35（用户口径 #11「辅助卡只放卡图」）：投影表那一面**从托盘搬到引擎验证页** ⇒
   * 本守卫跟着搬家：判据不变（这套投影由一个真实界面消费、组件不自己解析数据文件），
   * 另加一条"托盘不再渲染表"，把两边的分工钉住（托盘＝印卡原卡；验证页＝行 × 列投影）。
   */
  it('★ 引擎投影表在**验证页**上被这套投影消费（托盘只画卡图）', () => {
    const verify = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(verify).toContain("from '@/render/charts-view'")
    expect(verify).toContain('crtViews()')
    expect(verify).toContain('gridTableViews()')
    expect(verify).toContain('supplyTableViews()')
    expect(verify).toContain('tecTableView()')
    expect(verify).toContain('turnWeatherTableView()')
    expect(verify).toContain('arrivalTableView(workbench.arrivalPlan)')
    expect(verify).toContain('ChartsTable')

    const tray = readFileSync('src/components/game/BottomTray.vue', 'utf8')
    // 托盘仍在**逐屏切换**，但只画卡图（不自己解析数据文件、不画表）
    expect(tray).toContain('screen = item.key')
    expect(tray).not.toContain('crtViews()')
    expect(tray).not.toContain('tray__table')
  })

  it('★ 右栏只读：对局台的胜利面板**不带** `referee`，验证页那一份才带', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    const verify = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(game).toContain('<VictoryPanel />')
    expect(game).not.toContain('<VictoryPanel referee')
    expect(verify).toContain('<VictoryPanel referee />')
  })

  it('★ 面板本身默认不含可写控件：三个写入动作都在 `showsReferee` 门里', () => {
    const panel = readFileSync('src/components/victory/VictoryPanel.vue', 'utf8')
    /*
     * ★ 2026-10-25（用户）：「referee 类里对局台不该出现的按钮在 UI 层**统一**按 `showsReferee`」。
     * 修前这里是面板自己的一套判据（`v-if="props.referee"`）——只要某处挂载忘了不传 `referee`，
     * 对局台就会露出改账本的按钮。现在 `showsReferee` 由 **ui-mode** 推（验证页才对），
     * `referee` 属性降级为宿主的**额外**开关（两者都要为真）。
     */
    const gate = panel.indexOf('v-if="showsReferee"')
    expect(gate).toBeGreaterThan(0)
    expect(panel, 'showsReferee 必须由统一判据推出').toContain('useRefereeTools()')
    expect(panel, 'referee 属性仍是宿主的额外开关').toContain('props.referee')
    for (const call of [
      'workbench.refreshVictoryControlNow()',
      'workbench.setVictoryControlNow(',
      'workbench.checkVictoryNow(',
    ]) {
      const at = panel.indexOf(call)
      expect(at, `${call} 应在裁判件分支内`).toBeGreaterThan(gate)
    }
  })

  it('★ 5.0c 的控制改为**触发**（进入即记账）＋ 开局按剧本与战线播种（B17-1）', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    // 触发：位置键 + 同步 flush（否则同一 tick 里紧跟的判定读到旧账本）
    expect(store).toContain('victoryOccupancyKey')
    expect(store).toContain("{ flush: 'sync' }")
    // 播种：且必须排在 `victoryHexes` 之后（TDZ 那条教训写在注释里）
    const declared = store.indexOf('const victoryHexes = computed')
    const seeded = store.indexOf('seedVictoryControlFromScenario()')
    expect(declared).toBeGreaterThan(0)
    expect(seeded).toBeGreaterThan(declared)
  })
})
