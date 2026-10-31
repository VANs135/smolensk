import { describe, expect, it } from 'vitest'

import { chartsTec } from '@/data'
import { attackMultiplier } from '@/engine/rules'

/**
 * TEC（地形效果表）= **印表逐格核对**（2026-11-01）
 *
 * 判据来源：`Smolensk TEC.png`（游戏里由 `panel-scans.json` 的 `tec` 在 tec 屏显示）。
 * 印表列头：`Feature | Combat Line | Movement: Track / Truck / Leg | Special Modifiers: Armor / Mech / Other`。
 *
 * 图例（印表下端，与通规 **9.4d** 一致）：
 *   · `[x#]` —— **攻击**乘括号内倍率；**防御读作 ×1**（9.4d：「如果地形效果有括号（如 [x2]），
 *     则该修正只适用于攻击中的单位。在防御时，所有带此类括号内的修正，都读作 x1」）；
 *   · `P` —— Movement Prohibited；`*` —— 该列机动为 P 时，攻方须**沿路**才能进入/攻击（OCS 9.1f）；
 *   · `ot` —— Dependent on other terrain in hex（本身不给数值）。
 *
 * 为什么钉住：TEC 是每一格移动与每一场战斗的乘数来源。**括号与不括号差的是守方倍率**
 * ——2026-11-01 就抓到 `Swamp` 三列被误标成带括号（守方按 ×1），而印表是 `x 1/2*`（守方也 ×1/2）。
 */

/** 印表 13 行（原文照抄；`[x1/2]` 表示带括号＝仅攻方） */
const PRINTED = [
  ['Open', 'Open', '1', '1', '1', '[x2]', '[x2]', 'x1'],
  ['Woods', 'Close', '2', '3', '1', 'x1', 'x1', 'x1'],
  ['Forest', 'Close', '3', '4', '2', 'x1/2', 'x1', 'x1'],
  ['Swamp', 'Very Close', 'P', 'P', '3', 'x1/2', 'x1/2', 'x1'],
  ['Village', 'Close', 'ot', 'ot', 'ot', 'x1', 'x1', 'x1'],
  ['Minor City', 'Very Close', 'ot', 'ot', 'ot', 'x1/2', '[x1/2]', 'x1'],
  ['Major City', 'Extr Close', 'ot', 'ot', 'ot', 'x1/3', '[x1/2]', 'x1'],
  ['Secondary Road', 'ot', '1/2', '1/2', '1/2', 'ot', 'ot', 'ot'],
  ['Track', 'ot', '1', '1', '1', 'ot', 'ot', 'ot'],
  ['Railroad', 'ot', '1', '1', '1', 'ot', 'ot', 'ot'],
  ['Minor River', 'ot', '+3', '+5', '+1', '[x1/2]', '[x1/2]', '[x1/2]'],
  ['Major River', 'ot', 'P', 'P', 'All', '[x1/4]', '[x1/3]', '[x1/2]'],
  ['Lake/Blocked', 'ot', 'P', 'P', 'P', '[x1/4]', '[x1/4]', '[x1/4]'],
] as const

type MpCell = { kind: string; value?: number }
type AttackCell = { kind: string; mult?: readonly number[]; attackerOnly?: boolean }

function renderMp(cell: MpCell): string {
  switch (cell.kind) {
    case 'fixed':
      // 印表用分数写法（Secondary Road 的 1/2），数据存的是 0.5 ⇒ 按印表渲染再比
      return cell.value === 0.5 ? '1/2' : String(cell.value ?? '?')
    case 'prohibited':
      return 'P'
    case 'otherTerrain':
      return 'ot'
    case 'delta':
      return `+${String(cell.value ?? '?')}`
    case 'all':
      return 'All'
    default:
      return cell.kind
  }
}

function renderAttack(cell: AttackCell): string {
  if (cell.kind !== 'multiplier') return cell.kind === 'otherTerrain' ? 'ot' : cell.kind
  const [num = 1, den = 1] = cell.mult ?? []
  const body = den === 1 ? `x${String(num)}` : `x${String(num)}/${String(den)}`
  return cell.attackerOnly === true ? `[${body}]` : body
}

describe('TEC 与 `Smolensk TEC.png` 逐格一致', () => {
  it('★ 13 行 × 7 列全部照印表（含括号＝仅攻方）', () => {
    const actual = chartsTec.tec.features.map((feature) => [
      feature.feature,
      feature.combatLine,
      renderMp(feature.mp.track as MpCell),
      renderMp(feature.mp.truck as MpCell),
      renderMp(feature.mp.leg as MpCell),
      renderAttack(feature.attack.armor as AttackCell),
      renderAttack(feature.attack.mech as AttackCell),
      renderAttack(feature.attack.other as AttackCell),
    ])
    expect(actual).toEqual(PRINTED.map((row) => [...row]))
  })

  it('★ 9.4d：**无括号**的地形守方也吃倍率（Swamp 守方 ×1/2），有括号的守方读作 ×1', () => {
    // Swamp 印表没有方括号 ⇒ 攻守都 ×1/2
    expect(attackMultiplier('Swamp', 'armor', 'attacker')).toBe(0.5)
    expect(attackMultiplier('Swamp', 'armor', 'defender')).toBe(0.5)
    expect(attackMultiplier('Swamp', 'mech', 'defender')).toBe(0.5)
    // Forest 的 Armor 也是无括号（守方 ×1/2），Mech 无括号 ×1
    expect(attackMultiplier('Forest', 'armor', 'defender')).toBe(0.5)
    // Open 的 [x2] 带括号 ⇒ 守方 ×1
    expect(attackMultiplier('Open', 'armor', 'attacker')).toBe(2)
    expect(attackMultiplier('Open', 'armor', 'defender')).toBe(1)
    // Minor City：Armor 无括号（守方 ×1/2）、Mech 带括号（守方 ×1）
    expect(attackMultiplier('Minor City', 'armor', 'defender')).toBe(0.5)
    expect(attackMultiplier('Minor City', 'mech', 'defender')).toBe(1)
    // Major River / Lake：三列都带括号 ⇒ 守方一律 ×1
    for (const type of ['armor', 'mech', 'other'] as const) {
      expect(attackMultiplier('Major River', type, 'defender')).toBe(1)
      expect(attackMultiplier('Lake/Blocked', type, 'defender')).toBe(1)
    }
  })
})
