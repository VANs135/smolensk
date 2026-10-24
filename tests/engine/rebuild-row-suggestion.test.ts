import { describe, expect, it } from 'vitest'

import { rebuildChartRows, rebuildRow, suggestRebuildRow } from '@/engine/rules'
import { recordNameOf, unitChoices, type UnitRecordView } from '@/stores'

/**
 * 13.5：**「建议行键」的判据**（`suggestRebuildRow`）
 *
 * 背景：本作工程库没有「算子 → 重建表行」的映射，重建行键原本只能人工选；而重建**费用完全由行决定**，
 * 选错就是静默算错（例如坦克营按「Infantry Div step」扣成 2x Pax）。
 *
 * 这里的判据只做「记录自身的分类字段 → 重建表里**唯一**那一行」，判不出来就返回 null（交人工）。
 * 故本组用例同时钉两件事：①**能推的必须推对**；②**推不出的必须返回 null**（不许为凑覆盖率瞎猜）。
 */

/** 按印刷名取一条真实记录（用真实单位库，不造数） */
function recordOf(side: 'axis' | 'soviet', name: string): UnitRecordView {
  const found = unitChoices(side).find((item) => recordNameOf(item) === name)
  if (found === undefined) throw new Error(`单位库里没有「${name}」`)
  return found
}

function hintOf(side: 'axis' | 'soviet', name: string) {
  const record = recordOf(side, name)
  return {
    side,
    branch: record.branch ?? null,
    echelon: record.echelon ?? null,
    specialized: record.specialized ?? [],
    name: recordNameOf(record),
    isTransportPoint: record.noncombatKind === 'transport_point',
  }
}

describe('13.5：轴心各兵种 → 重建表行（能推的推对）', () => {
  const cases: Array<[string, string]> = [
    ['Ge 5 Inf Div', 'Infantry Div step'],
    ['Ge HQ 5th Corps', 'HQ (any size or type)'],
    ['Ge 3.Pz I-6 Pz', 'Panzer Bn'],
    ['Ge 100 Flm Bn', 'Flm Panzer Bn'],
    ['Ge 521 PJ Bn', 'PJ Bn'],
    ['Ge Lehr Aufk Bn', 'Aufk (Arm Recon) Bn'],
    ['Ge 10.Mtr 10 Arm Rec', 'Arm Car Bn'],
    ['Ge 51 Werfer Rgt', 'Werfer Rgt'],
    ['Ge 3 Werfer Bn', 'Werfer Bn'],
    ['Ge 1.Cav 1 Bikes', 'Bicycle Cavalry Bn'],
    ['Ge 1.Cav I-1 Cav', 'Cavalry Bn'],
    ['Ge 43 Pioneer Bn', 'Pio Bn'],
    ['Ge I-2 RR Bn', 'RR Bn'],
    ['Ge 221 Sec Div', 'Sec Div step'],
    ['Ge 5 MG Bn', 'MG Bn'],
    ['Ge SS.R R MC', 'Krd (Motorcycle) Bn'],
    ['Ge Truck 3', 'Transport Points'],
    ['Ge 4-4-3 Breakdown', 'Breakdown Rgt'],
  ]
  for (const [name, row] of cases) {
    it(`${name} ⇒ ${row}`, () => {
      expect(suggestRebuildRow(hintOf('axis', name))).toBe(row)
    })
  }
})

describe('13.5：苏军各兵种 → 重建表行（含表里被拆成多行的亚型）', () => {
  const cases: Array<[string, string]> = [
    ['Ru 13 Tk Div', 'Tank Div step'],
    ['Ru 121 Tk Bde', 'Tank Bn, Rgt, or Bde'],
    // 表里 `Tank Alarm Bn` 是独立一行（Special 1.6c），不能并进常规坦克行
    ['Ru Tk Alarm 2-1-3', 'Tank Alarm Bn'],
    ['Ru 21 Mtn Cav Div', 'Cavalry Div (Soviet)'],
    ['Ru 58 UR Bde', 'UR Bde'],
    ['Ru 38 NKVD Border Gds', 'NKVD Border Rgt'],
    ['Ru 1 Militia Div', 'Militia Div step'],
    ['Ru Mil Alarm 3-1-1', 'Militia Alarm Rgt'],
    ['Ru 9 MC Rgt', 'Motorcycle (MC) Rgt'],
    ['Ru 194 Mtn Div', 'Mtn Inf Div step'],
    ['Ru 76 NKVD Sec', 'Sec Rgt'],
    ['Ru AT Alarm (2)-2-2', 'AT Alarm Rgt'],
    ['Ru 1.Mot 93 Recon', 'Arm Recon Bn (Soviet)'],
    ['Ru 7 Para Inf Bde', 'Para Inf Bde (Soviet)'],
    ['West RR Rgt', 'RR Rgt'],
    ['Ru Arty Bde', 'Artillery Rgt or Bde'],
    ['Ru Truck 3', 'Transport Points'],
    ['Ru 3-3-3 Breakdown', 'Breakdown Rgt'],
  ]
  for (const [name, row] of cases) {
    it(`${name} ⇒ ${row}`, () => {
      expect(suggestRebuildRow(hintOf('soviet', name))).toBe(row)
    })
  }
})

describe('13.5：推不出唯一行 ⇒ 一律 null（交人工选行，不猜）', () => {
  const ambiguous: Array<['axis' | 'soviet', string]> = [
    // 表里没有"装甲团"一行（armor_pz / rgt）
    ['axis', 'Ge 3.Pz 3 Mot Inf'],
    // 摩托化团的费用在两行之间不同：PG (Arm Inf) Rgt 1Eq+1Pax vs Infantry Bde or Rgt 2Pax
    ['axis', 'Ge 10.Mtr 20 Mot Inf'],
    // 师属炮兵团（specialized=artillery 但兵种不是 artillery）不能按装甲行计
    ['axis', 'Ge 3.Pz 75 Arty'],
    // 苏军步兵师在表里分 `Infantry Div step`（2Pax）与 `Infantry Div (Red)`（No Rebuild）两行，字段分辨不出
    ['soviet', 'Ru 6 Rifle Div'],
    // 表里没有"摩托化师"一行
    ['soviet', 'Ru 69 Mot Div'],
    ['soviet', 'Ru 1.Mot 20 Mot Inf'],
    // 表里没有空军基地行（本来也不必重建）
    ['axis', 'Airbase 1'],
    ['soviet', 'Airbase 1'],
  ]
  for (const [side, name] of ambiguous) {
    it(`${name} ⇒ null`, () => {
      expect(suggestRebuildRow(hintOf(side, name))).toBeNull()
    })
  }

  it('飞机恒为 Aircraft 行（专规 1.6 Notes：只经 Repl Table）', () => {
    expect(suggestRebuildRow({ side: 'axis', isAircraft: true })).toBe('Aircraft')
    expect(suggestRebuildRow({ side: 'soviet', isAircraft: true })).toBe('Aircraft')
  })
})

describe('13.5：建议行必定是**本方重建表里真实存在**的行（不许造行键）', () => {
  it('全量扫描两方单位库：返回的每个建议都能在表里查到', () => {
    for (const side of ['axis', 'soviet'] as const) {
      const rows = rebuildChartRows(side).map((row) => row.unitType)
      let suggested = 0
      for (const record of unitChoices(side)) {
        const suggestion = suggestRebuildRow({
          side,
          branch: record.branch ?? null,
          echelon: record.echelon ?? null,
          specialized: record.specialized ?? [],
          name: recordNameOf(record),
          isTransportPoint: record.noncombatKind === 'transport_point',
        })
        if (suggestion === null) continue
        suggested += 1
        expect(
          rows,
          `${recordNameOf(record)} 的建议行「${suggestion}」不在 ${side} 表里`,
        ).toContain(suggestion)
        expect(rebuildRow(side, suggestion)).not.toBeNull()
      }
      /*
       * 覆盖率下限（实测：轴 142/231、苏 111/218 有唯一建议）。未给建议的正是**不该猜**的那些：
       * 轴心的摩托化团/营（两行费用不同）、`armor_pz/rgt`（表里无装甲团行）、师属炮兵；
       * 苏军的步兵师（表里 step 与 (Red) 两行并存）。故下限只防"大幅退化"，不追求高覆盖。
       */
      expect(suggested).toBeGreaterThan(side === 'axis' ? 135 : 105)
    }
  })
})
