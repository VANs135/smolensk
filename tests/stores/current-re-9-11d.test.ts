import { describe, expect, it } from 'vitest'

import { battleCombatSupply } from '@/engine/rules/battle'
import type { HexRef } from '@/data'
import { toBattleUnitView, toConsoleUnit, unitChoices } from '@/stores'

/**
 * A4-02 / 9.11d：**当前 RE 规模 = 印刷 RE − 已损失的军力**
 *
 * 原文（9.11d）：「一个**多军力师**当前的 RE 规模，等于该单位印刷的 RE 规模减去已损失的军力。」
 * 战斗补给的守方成本（12.4）按守方总 RE 计：总 RE ≤ 1 时 1T，否则 2T —— 所以损失后的 RE
 * 必须回落，否则一支 2 步师损失一步后仍按 2 RE 收 2T。
 *
 * 本作单位库里，所有多步单位的 `reSize` 都等于印刷步数；这里用 48 坦克师（2 步 / 2 RE）钉住
 * `toBattleUnitView` 交给引擎的 `re` 是**当前值**。
 */

const HEX: HexRef = { col: 40, row: 20 }

function tankDivision() {
  const record = unitChoices('soviet').find((unit) => unit.id === 'su-armor_tk-ru-48-tk-div')
  if (record === undefined) throw new Error('单位库里找不到 su-armor_tk-ru-48-tk-div')
  return toConsoleUnit({ record, instanceId: 'su-armor_tk-ru-48-tk-div', hex: HEX, side: 'soviet' })
}

describe('9.11d：当前 RE 随损失回落', () => {
  it('2 步 / 2 RE 的师：满员 2 RE，损失 1 步后 1 RE', () => {
    const unit = tankDivision()
    expect(toBattleUnitView(unit, 1).re).toBe(2)
    unit.steps = 1
    expect(toBattleUnitView(unit, 1).re).toBe(1)
  })

  it('9.5 / 12.4：守方总 RE 由 2 回落到 1 ⇒ 战斗补给成本从 2T 降为 1T', () => {
    const unit = tankDivision()
    const attacker = tankDivision()
    const supply = (defenderReUnit: typeof unit) =>
      battleCombatSupply({
        attackers: [toBattleUnitView(attacker, 1)],
        defenders: [toBattleUnitView(defenderReUnit, 1)],
        attackerAvailableT: 10,
        defenderProvides: true,
        defenderAvailableT: 10,
      })

    const full = supply(unit)
    expect(full.ok && full.data.defenderRequiredT).toBe(2)

    unit.steps = 1
    const reduced = supply(unit)
    expect(reduced.ok && reduced.data.defenderRequiredT).toBe(1)
  })
})
