import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { resolveAdvanceAfterCombat } from '@/engine/rules'

/**
 * B33：**突袭推进收束**（用户报告 #16）
 *
 * 「当前玩家单位**突袭被消灭后**无法卡在战后推进，**单位都死了还无法结束战斗交互**，
 *   点别的各种还是出现未正常停止的突袭推进，况且**突袭的推进是强制的**，
 *   也不该出现可选是否推进的按钮」。
 *
 * 病根：`resolveAdvanceAfterCombat` 在突袭分支里"无人可推"时一律 `fail('9.12g-A')`
 * ⇒ 参突单位被全灭的突袭**永远走不完 9.2**（会话框一直挂着、推进格一直画），
 * 玩家只能靠「放弃本场战斗」脱身。修法：**候选为空 ＝ 合法地不推进**（`mandatory: true` 照给），
 * 「有候选却没人付过战斗补给」才拒。
 */

describe('B33：9.12g-D 突袭的推进收束（引擎）', () => {
  it('★ 参突单位全灭（候选为空）⇒ **合法收束**：advanceUnitIds 空、mandatory 仍为真', () => {
    const outcome = resolveAdvanceAfterCombat({
      attackType: 'overrun',
      defendingHexCleared: true,
      attackerRetreated: false,
      candidates: [],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.advanceUnitIds).toEqual([])
    expect(outcome.data.mandatory).toBe(true)
  })

  it('★ 有候选却没人付战斗补给 ⇒ 照旧拒绝（9.12g-A 没被这次修复放宽）', () => {
    const outcome = resolveAdvanceAfterCombat({
      attackType: 'overrun',
      defendingHexCleared: true,
      attackerRetreated: false,
      candidates: [{ id: 'a1', paidCombatSupply: false }],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.rule).toBe('9.12g-A')
    expect(outcome.reason).toBe('noUnitPaidCombatSupply')
  })

  it('★ 常规战斗**不受影响**：候选为空且未指定 ⇒ 不推进、且非强制', () => {
    const outcome = resolveAdvanceAfterCombat({
      attackType: 'regular',
      defendingHexCleared: true,
      attackerRetreated: false,
      candidates: [],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.advanceUnitIds).toEqual([])
    expect(outcome.data.mandatory).toBe(false)
  })

  it('★ 付过补给的突袭照旧全员推进（mandatory 为真）', () => {
    const outcome = resolveAdvanceAfterCombat({
      attackType: 'overrun',
      defendingHexCleared: true,
      attackerRetreated: false,
      candidates: [
        { id: 'a1', paidCombatSupply: true },
        { id: 'a2', paidCombatSupply: true },
      ],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.advanceUnitIds).toEqual(['a1', 'a2'])
    expect(outcome.data.mandatory).toBe(true)
  })
})

describe('B33：界面不给"不推进"（源码守卫）', () => {
  it('★ 小窗的「不推进」在突袭下不出现；战斗面板有强制口径提示', () => {
    const pop = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(pop).toContain('workbench.combatAdvanceMandatory')
    const panel = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    expect(panel).toContain('workbench.combatAdvanceMandatory')
    expect(panel).toContain('9.12g-D')
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(store).toContain("state.attackType === 'overrun'")
  })
})
