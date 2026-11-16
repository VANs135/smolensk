import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { planSetupPlacement, setupEntryViews } from '@/engine/rules'
import { targetHexFacts, toConsoleUnit, toLegalityUnit, unitChoices } from '@/stores'

/**
 * 4.8 / 4.6 / 9.11d：堆叠 RE 的计数口径
 *
 * 原文（OCS v4.3）：
 *   · 4.8：`The maximum number of combat units allowed to stack in a hex is 10 RE.`
 *   · 4.6：`Only ground combat units have RE sizes... Multi-step units have their RE size shown
 *     on the counter. Battalions are 1/2 RE.` ⇒ **每个单位按自己的 RE 计**；
 *     没有任何「同一编队合并算一个师/一个整体」的口径。
 *   · 9.11d：`A multi-step division's current RE size is the unit's printed RE size minus the
 *     steps it has lost.` ⇒ 减步师按**当前 RE** 计入堆叠。
 *
 * 本作的多单位编队（如 3PZ）在单位库里就是共享同一 `formation` 的多个算子；
 * 堆叠时必须逐算子相加，**不能**按编队合并（那是 10.0a 轰炸密度的口径，不是 4.8 堆叠）。
 */

const HEX: HexRef = { col: 36, row: 13 }

function place(id: string, instanceId = id) {
  const record = unitChoices('axis').find((unit) => unit.id === id)
  if (record === undefined) throw new Error(`单位库里找不到 ${id}`)
  return toConsoleUnit({ record, instanceId, hex: HEX, side: 'axis' })
}

/** 3PZ 编队内的 5 个战斗算子：0.5×3 + 1 + 1 = 3.5 RE */
const PZ3_UNITS = [
  'ax-armor_pz-ge-3-pz-i-6-pz',
  'ax-armor_pz-ge-3-pz-ii-6-pz',
  'ax-armor_pz-ge-3-pz-iii-6-pz',
  'ax-armor_pz-ge-3-pz-3-mot-inf',
  'ax-armor_pz-ge-3-pz-75-arty',
]

describe('4.8 / 4.6：同格多单位逐单位计 RE（同编队不合并）', () => {
  it('3PZ 的 5 个算子合计 3.5 RE，再与 4 步独立师同格 ⇒ 7.5 RE', () => {
    const units = [...PZ3_UNITS.map((id) => place(id)), place('ax-infantry-ge-5-inf-div')]
    expect(targetHexFacts(units, HEX, 'axis').friendlyCombatRe).toBe(7.5)
  })

  it('同一编队内每个算子各计一次：3 个 1/2 RE 算子 ⇒ 1.5 RE，不按一个整体计 1', () => {
    const units = PZ3_UNITS.slice(0, 3).map((id) => place(id))
    expect(targetHexFacts(units, HEX, 'axis').friendlyCombatRe).toBe(1.5)
  })

  it('不同编队的算子同样逐单位相加（无跨编队合并/拆分）', () => {
    const units = [
      place('ax-armor_pz-ge-3-pz-i-6-pz', 'a'),
      place('ax-infantry-ge-5-inf-div', 'b'),
      place('ax-infantry-ge-167-inf-div', 'c'),
    ]
    expect(targetHexFacts(units, HEX, 'axis').friendlyCombatRe).toBe(0.5 + 4 + 4)
  })
})

describe('9.11d：减步师按当前 RE（印刷 − 已损）计入堆叠', () => {
  it('三个 4 步师各缺 1 步 ⇒ 3×3 = 9 RE（不是印刷 12 RE）', () => {
    const units = ['a', 'b', 'c'].map((id) => {
      const unit = place('ax-infantry-ge-5-inf-div', id)
      unit.steps = 3
      return unit
    })
    expect(targetHexFacts(units, HEX, 'axis').friendlyCombatRe).toBe(9)
  })

  it('合法性单位视图带的是当前 RE（9.11d），不是印刷值', () => {
    const unit = place('ax-infantry-ge-5-inf-div')
    unit.steps = 2
    expect(toLegalityUnit(unit).re).toBe(2)
  })
})

describe('初设 IV-F：减步师按当前 RE 判 10 RE 上限', () => {
  it('剧本 3 的 167 师（−1 step，印刷 4 ⇒ 当前 3）与 6.5 RE 同格 ⇒ 9.5，允许', () => {
    const entry = setupEntryViews('3', 'axis').find((view) =>
      view.pieces.some((piece) => piece.unitId === 'ax-infantry-ge-167-inf-div'),
    )
    expect(entry).toBeDefined()
    const outcome = planSetupPlacement({
      entry: entry!,
      targetHex: { col: 2, row: 2 },
      facts: { existingRe: () => 6.5, canEnter: () => true },
    })
    expect(outcome.ok).toBe(true)
  })
})
