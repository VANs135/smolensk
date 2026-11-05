import { describe, expect, it } from 'vitest'

import { breakoutReactivityProbe, breakoutSnapshots } from './breakout-index-fixture'

/**
 * 12.8e-A「档 1（索引化 + 脱响应式）」的等价性闸门
 *
 * 基准由**未改造代码**生成后固化于此；改造后必须逐字符一致（含候选顺序、判定与拒绝理由）。
 * 场景覆盖：可突围 / 不可突围、追踪友军相邻/同格/非战斗、敌方战斗单位/AEZOC/非战斗、
 * 双方阵营、边界格、无友军。
 */
const BASELINE = `# S1 axis 相邻追踪友军
a-trap | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
order: a-trap

# S2 soviet 3 格外追踪友军
s-trap | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
order: s-trap

# S3 口袋：敌战斗单位环绕
p-trap | reject | pathHasEnemyCombatUnit:p-trap（12.8e） | pathHasEnemyCombatUnit:p-trap（12.8e）
order: p-trap

# S4 单侧敌战斗单位挡路
b-trap | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
order: b-trap

# S5 轮式：EZOC 未抵消
e-trap | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形、无未被抵消的 EZOC）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
order: e-trap

# S6 轮式：EZOC 被抵消
c-trap | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形、无未被抵消的 EZOC）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
c-cancel | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
order: c-trap>c-cancel

# S9 与追踪友军同格
same-trap | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
order: same-trap

# S10 追踪友军为非战斗运输单位
tr-trap | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
order: tr-trap

# S11 相邻敌方非战斗单位
nc-trap | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
order: nc-trap

# S7 边界格
edge-trap | ok | - | 12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形）；最近有追溯补给的友方战斗单位 0 格 ≤ 15 格
order: edge-trap

# S8 无追踪友军
lonely | reject | noTracedCombatFriendWithinRange:lonely:none（12.8e） | noTracedCombatFriendWithinRange:lonely:none（12.8e）
order: lonely`

describe('12.8e-A 档 1：索引化前后逐单位等价', () => {
  it('候选集合、顺序、逐候选判定与理由完全一致', () => {
    expect(breakoutSnapshots()).toBe(BASELINE)
  })

  it('依赖追踪仍在：非候选单位的补给状态变化必须改变结论', () => {
    const { before, after } = breakoutReactivityProbe()
    expect(before).toContain('r-trap:true:')
    expect(after).not.toBe(before)
    expect(after).toContain('noTracedCombatFriendWithinRange:r-trap')
  })
})
