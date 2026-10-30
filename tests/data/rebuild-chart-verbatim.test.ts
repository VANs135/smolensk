import { describe, expect, it } from 'vitest'

import { chartsSupplyRepl } from '@/data'

/**
 * 重建费用表 = **印表逐行核对**（2026-10-31）
 *
 * 判据来源（两张印卡扫描图，游戏里已由 `panel-scans.json` 的 `rebuilds-axis` / `rebuilds-soviet` 显示）：
 *   · `Smolensk Axis rebuilds.png`
 *   · `Smolensk Soviet rebuilds.png`
 *
 * 为什么要这条用例：重建费用**完全由这张表决定**（通规 13.5a「重建的补员费用因单位类型和规模而异，
 * 会总结在每款游戏的**重建表**中」），而多军力单位按 **step** 计价（13.5b「可重建任意数量的军力，
 * 前提是有足够的补员」；行键就写着 `…Div **step**`）。数据一改，钱就错，且错得没声音
 * （本仓库就出过"4 军力师满血重建只扣 2 Pax"的少收账）。故这里把**行序、行键、费用、文案**
 * 全部按印表钉住，任何漂移都会红。
 *
 * 两张表末的注释一致：`Reminder: A Ftr or Tac repl only rebuilds 1 step.`
 */

/** 印表（原文照抄；顺序即印表自上而下） */
const PRINTED = {
  axis: [
    ['Aircraft', 'only via Repl Table'],
    ['Anti-Tank Bn (German)', '1x Eq'],
    ['Artillery Rgt or Bde', '2x Eq'],
    ['Arm Car Bn', '1x Eq'],
    ['Assault Gun (AG) Bn', '1x Eq'],
    ['Aufk (Arm Recon) Bn', 'Special (1.6c)'],
    ['Bicycle Cavalry Bn', '1x Pax'],
    ['Breakdown Rgt', 'return to pool'],
    ['Cavalry Bn', '1x Pax'],
    ['Flm Panzer Bn', 'No Rebuild'],
    ['HQ (any size or type)', '1x Eq + 1 Pax'],
    ['Infantry Bde or Rgt', '2x Pax'],
    ['Infantry Div step', '2x Pax'],
    ['Krd (Motorcycle) Bn', 'Special (1.6c)'],
    ['MG Bn', '1x Pax'],
    ['Mtn Inf Div step', '2x Pax'],
    ['Panzer Bn', '1x Eq'],
    ['PG (Arm Inf) Rgt', '1x Eq + 1 Pax'],
    ['Pio Bn', '2x Pax'],
    ['PJ Bn', '1x Eq'],
    ['RR Bn', '1x Pax'],
    ['Sec Rgt', '1x Pax'],
    ['Sec Div step', '1x Pax'],
    ['Transport Points', 'see OCS 13.5e'],
    ['Werfer Bn', '1x Eq'],
    ['Werfer Rgt', '2x Eq'],
  ],
  soviet: [
    ['Aircraft', 'only via Repl Table'],
    ['AT Alarm Rgt', 'Special (see 1.6c)'],
    ['Artillery Rgt or Bde', '2x Eq'],
    ['Arm Car Bn', '1x Eq'],
    ['Arm Recon Bn (Soviet)', '1x Eq'],
    ['Breakdown Rgt', 'return to pool'],
    ['Cavalry Div (Soviet)', '2x Pax'],
    ['HQ (any size or type)', '1x Eq + 1 Pax'],
    ['Infantry Div step', '2x Pax'],
    ['Infantry Div (Red)', 'No Rebuild'],
    ['Infantry Rgt', '2x Pax'],
    ['Militia Div step', '1x Pax'],
    ['Militia Alarm Rgt', 'Special (see 1.6c)'],
    ['Motorcycle (MC) Rgt', '2x Pax'],
    ['Mtn Inf Div step', '2x Pax'],
    ['NKVD Border Rgt', 'No Rebuild'],
    ['Para Inf Bde (Soviet)', '3x Pax'],
    ['RR Rgt', '1x Pax'],
    ['Sec Rgt', '1x Pax'],
    ['Tank Alarm Bn', 'Special (see 1.6c)'],
    ['Tank Bn, Rgt, or Bde', '1x Eq'],
    ['Tank Div step', '1x Eq + 1 Pax'],
    ['Transport Points', 'see OCS 13.5e'],
    ['UR Bde', '1x Pax'],
  ],
} as const

/** 把数据里的 cost 渲染成印表那种写法（用于"费用 ↔ 文案"互校） */
function renderCost(entry: {
  kind: string
  cost?: readonly { resource: string; amount: number }[]
  label?: string
}): string {
  const nameOf = (resource: string): string =>
    resource === 'pax' ? 'Pax' : resource === 'eq' ? 'Eq' : resource
  switch (entry.kind) {
    case 'normal':
      /*
       * 印表的写法是「1x Eq + 1 Pax」——**只有首项带 'x'**，后续项是裸数量
       * （单项目行则一律带 x，如「2x Pax」）。这里照印表写法渲染，才能与 sourceLabel 逐字互校。
       */
      return (entry.cost ?? [])
        .map(
          (item, index) =>
            `${String(item.amount)}${index === 0 ? 'x' : ''} ${nameOf(item.resource)}`,
        )
        .join(' + ')
    case 'none':
      return 'No Rebuild'
    case 'pool':
      return 'return to pool'
    case 'replOnly':
      return 'only via Repl Table'
    case 'special':
      return 'Special'
    case 'regulation':
      return entry.label ?? 'see OCS 13.5e'
    default:
      return entry.kind
  }
}

describe('重建费用表（13.5a/13.5b）与印表逐行一致', () => {
  it('★ 轴心国 26 行：行序、行键、费用文案与 `Smolensk Axis rebuilds.png` 一致', () => {
    const rows = chartsSupplyRepl.rebuild.axis
    expect(rows.map((row) => [row.unitType, row.sourceLabel])).toEqual(PRINTED.axis)
  })

  it('★ 苏联 24 行：行序、行键、费用文案与 `Smolensk Soviet rebuilds.png` 一致', () => {
    const rows = chartsSupplyRepl.rebuild.soviet
    expect(rows.map((row) => [row.unitType, row.sourceLabel])).toEqual(PRINTED.soviet)
  })

  it('费用金额与文案互校（`1x Eq + 1 Pax` 这类写法不得与 cost 脱节）', () => {
    for (const side of ['axis', 'soviet'] as const) {
      for (const row of chartsSupplyRepl.rebuild[side]) {
        const rendered = renderCost(row.rebuild)
        // Special / 无重建 / 回池 这几类的 cost 为空，文案自带说明，故只在「有金额」时逐字比
        if (row.rebuild.kind === 'normal')
          expect(rendered, `${side}:${row.unitType}`).toBe(row.sourceLabel)
        else expect(row.sourceLabel).toContain(rendered === 'Special' ? 'Special' : rendered)
      }
    }
  })

  it('多军力行（`…Div step`）存在且为每点军力计价 —— 13.5b 的按 step 计费依赖行键', () => {
    const axisStep = chartsSupplyRepl.rebuild.axis.filter((row) => /step/i.test(row.unitType))
    const sovietStep = chartsSupplyRepl.rebuild.soviet.filter((row) => /step/i.test(row.unitType))
    // 轴方：Infantry Div step / Mtn Inf Div step / Sec Div step
    expect(axisStep.map((row) => row.unitType)).toEqual([
      'Infantry Div step',
      'Mtn Inf Div step',
      'Sec Div step',
    ])
    // 苏方：Infantry Div step / Militia Div step / Mtn Inf Div step / Tank Div step
    expect(sovietStep.map((row) => row.unitType)).toEqual([
      'Infantry Div step',
      'Militia Div step',
      'Mtn Inf Div step',
      'Tank Div step',
    ])
    for (const row of [...axisStep, ...sovietStep]) expect(row.rebuild.kind).toBe('normal')
  })

  it('13.5c 的 No Rebuild 行与用户裁定的 `rebuildable: false` 名单一致', () => {
    // 用户 2026-10-24：「该字段是对的，只有少数单位不能重建」
    expect(
      chartsSupplyRepl.rebuild.axis
        .filter((row) => row.rebuild.kind === 'none')
        .map((row) => row.unitType),
    ).toEqual(['Flm Panzer Bn'])
    expect(
      chartsSupplyRepl.rebuild.soviet
        .filter((row) => row.rebuild.kind === 'none')
        .map((row) => row.unitType),
    ).toEqual(['Infantry Div (Red)', 'NKVD Border Rgt'])
  })
})
