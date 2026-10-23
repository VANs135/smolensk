import { describe, expect, it } from 'vitest'

import {
  HIDDEN_FROM_OPPONENT,
  FOG_RULE,
  STACK_ORDER_RULE,
  hexDisplay,
  hiddenInfoPolicy,
  otherSide,
  rollVisibleTo,
  sideLabel,
  stackOrderIssues,
  topActivePlaneOf,
  topCombatUnitOf,
  visibleUnitIds,
  type ConsensusDecision,
  type FogUnitView,
  type StackFacts,
} from '@/engine/rules'

/**
 * 切方与信息展示纪律（W7 C13）——**条款级**核对
 *
 * 逐条对着 4.9a / 4.8b / 4.9b / 4.9e 与专规 1.4 断言：
 *   · 4.9a：敌方堆叠只见「环形工事 + 最上方战斗模式可攻击单位（无 ZOC 单位时退为最上方战斗单位）
 *     + 最上方激活飞机」，可知战略模式/DG/断补，**不知**部队储备与损失军力；
 *   · 4.8b：堆叠顺序的四条法定要求（C 有 ZOC 者置顶 / D 无敌方地面相邻时 HQ 可置顶 / E 激活飞机置顶 /
 *     F 工事置顶）；
 *   · 4.9b：参战格只公开**数值**，不展示算子；
 *   · 4.9e / 专规 1.4：共识开关把「秘密掷骰」「隐藏地图外盒」译成纪律。
 */

/** 造一枚堆叠视图（默认：普通战斗单位、战斗模式、投射 ZOC） */
function unit(overrides: Partial<FogUnitView> & { id: string }): FogUnitView {
  return {
    side: 'axis',
    kind: 'ground',
    isCombat: true,
    attackCapable: true,
    inCombatMode: true,
    projectsZoc: true,
    ...overrides,
  }
}

/** 该格无相邻敌方地面单位（4.8b D 的默认事实） */
const NO_ENEMY_ADJACENT: StackFacts = { enemyGroundUnitAdjacent: false }
const ENEMY_ADJACENT: StackFacts = { enemyGroundUnitAdjacent: true }

describe('W7 C13：4.9a 敌方堆叠的可见性', () => {
  it('C13：只见「最上方战斗模式的可攻击单位」——其下的算子一律不可见', () => {
    const stack = [
      unit({ id: 'top', attackCapable: true }),
      unit({ id: 'hidden-1' }),
      unit({ id: 'hidden-2' }),
    ]
    const display = hexDisplay({
      viewer: 'soviet',
      hex: { col: 1, row: 1 },
      units: stack,
      facts: NO_ENEMY_ADJACENT,
    })
    expect(display.mode).toBe('topOnly')
    if (display.mode !== 'topOnly') return
    expect(display.top?.id).toBe('top')
    expect(display.rule).toBe(FOG_RULE)
    // 4.9a：永远不能看穿敌方堆叠 ⇒ 枚数不公开
    expect(display.stackSizeHidden).toBe(true)
    expect(display.denied).toEqual([...HIDDEN_FROM_OPPONENT])
  })

  it('C13：堆叠内单位均无 ZOC ⇒ 退为「最上方的战斗单位」（4.9a 括注）', () => {
    const stack = [
      unit({ id: 'non-combat', isCombat: false, attackCapable: false, projectsZoc: false }),
      unit({ id: 'top-combat', projectsZoc: false, inCombatMode: false }),
      unit({ id: 'lower-combat', projectsZoc: false, inCombatMode: false }),
    ]
    expect(topCombatUnitOf(stack)?.id).toBe('top-combat')
  })

  it('C13：有 ZOC 单位时，可见的是「最上方战斗模式的可攻击单位」而非普通最上方', () => {
    const stack = [
      // 最上方是一个已 DG（非战斗模式）的单位 ⇒ 它不是 4.9a 的那个「可攻击单位」
      unit({ id: 'dg-unit', inCombatMode: false, projectsZoc: false, dg: true }),
      unit({ id: 'zoc-unit', inCombatMode: true, attackCapable: true, projectsZoc: true }),
    ]
    expect(topCombatUnitOf(stack)?.id).toBe('zoc-unit')
  })

  it('C13：最上方激活飞机单独可见；非激活飞机不可见（4.9a + 4.8b E）', () => {
    const stack = [
      unit({ id: 'ground' }),
      unit({
        id: 'plane-inactive',
        kind: 'air',
        isCombat: false,
        attackCapable: false,
        projectsZoc: false,
        airStatus: 'inactive',
      }),
    ]
    expect(topActivePlaneOf(stack)).toBeNull()
    const withActive = [
      ...stack,
      unit({
        id: 'plane-active',
        kind: 'air',
        isCombat: false,
        attackCapable: false,
        projectsZoc: false,
        airStatus: 'active',
      }),
    ]
    expect(topActivePlaneOf(withActive)?.id).toBe('plane-active')
    expect(visibleUnitIds({ viewer: 'soviet', units: withActive })).toEqual([
      'ground',
      'plane-active',
    ])
  })

  it('C13：4.9a 可知的战略模式 / DG / 断补与「不知」的储备、损失军力', () => {
    const stack = [
      unit({
        id: 'top',
        mode: 'strat',
        dg: true,
        outOfSupply: true,
        steps: 1,
        printedSteps: 3,
        internalStocks: 'low',
      }),
    ]
    const display = hexDisplay({
      viewer: 'soviet',
      hex: { col: 2, row: 2 },
      units: stack,
      facts: NO_ENEMY_ADJACENT,
    })
    expect(display.mode).toBe('topOnly')
    if (display.mode !== 'topOnly') return
    expect(display.topFlags).toEqual({ strat: true, dg: true, outOfSupply: true })
    // 4.9a：队部储备与已损失军力**不在**公开范围内（字段仍在场，但由 denied 明示禁止展示）
    expect(display.denied.join('｜')).toContain('部队储备')
    expect(display.denied.join('｜')).toContain('已损失的军力')
  })

  it('C13：己方堆叠全见（4.9a 只约束敌方堆叠）；环形工事对双方都可见', () => {
    const stack = [
      unit({ id: 'own-1' }),
      unit({ id: 'own-2' }),
      unit({
        id: 'hh',
        isHedgehog: true,
        isCombat: false,
        attackCapable: false,
        projectsZoc: false,
      }),
    ]
    const display = hexDisplay({
      viewer: 'axis',
      hex: { col: 3, row: 3 },
      units: stack,
      facts: NO_ENEMY_ADJACENT,
    })
    expect(display.mode).toBe('full')
    if (display.mode !== 'full') return
    expect(display.units).toHaveLength(3)
    expect(display.hedgehog).toBe(true)
    // 对手看到同一格时：工事可见（4.9a 明文），但只见最上方战斗单位
    const enemyView = hexDisplay({
      viewer: 'soviet',
      hex: { col: 3, row: 3 },
      units: stack,
      facts: NO_ENEMY_ADJACENT,
    })
    expect(enemyView.mode).toBe('topOnly')
    expect(enemyView.mode === 'topOnly' && enemyView.hedgehog).toBe(true)
    expect(enemyView.mode === 'topOnly' && enemyView.top?.id).toBe('own-1')
  })

  it('C13：4.8b「必须告知对手该格是否产生 ZOC」', () => {
    const withZoc = hexDisplay({
      viewer: 'soviet',
      hex: { col: 4, row: 4 },
      units: [unit({ id: 'z' })],
      facts: NO_ENEMY_ADJACENT,
    })
    const withoutZoc = hexDisplay({
      viewer: 'soviet',
      hex: { col: 4, row: 4 },
      units: [unit({ id: 'nz', projectsZoc: false, inCombatMode: false })],
      facts: NO_ENEMY_ADJACENT,
    })
    expect(withZoc.mode === 'topOnly' && withZoc.hasZoc).toBe(true)
    expect(withoutZoc.mode === 'topOnly' && withoutZoc.hasZoc).toBe(false)
  })
})

describe('W7 C13：4.8b 堆叠顺序（只提示，不替玩家重排）', () => {
  it('C13：有 ZOC 的单位不在最上方 ⇒ 提示 4.8b C', () => {
    const issues = stackOrderIssues(
      [unit({ id: 'top', projectsZoc: false, inCombatMode: false }), unit({ id: 'zoc' })],
      NO_ENEMY_ADJACENT,
    )
    expect(issues.map((issue) => issue.rule)).toContain(STACK_ORDER_RULE)
    expect(issues[0]?.detail).toContain('4.8b C')
  })

  it('C13：无 ZOC 单位时，HQ 在**无**相邻敌方地面单位时可以在最上方（4.8b D）', () => {
    // 4.8b D 的 HQ 判据取**显示名**（引擎不猜兵种：调用方按单位库给名字）
    const hq = unit({ id: 'hq', name: 'HQ 9th Army', projectsZoc: false, inCombatMode: false })
    const other = unit({ id: 'inf', projectsZoc: false, inCombatMode: false })
    expect(stackOrderIssues([hq, other], NO_ENEMY_ADJACENT)).toEqual([])
    const withEnemy = stackOrderIssues([hq, other], ENEMY_ADJACENT)
    expect(withEnemy[0]?.detail).toContain('4.8b D')
  })

  it('C13：激活飞机在地面单位之下 ⇒ 提示 4.8b E；工事不在最上方 ⇒ 提示 4.8b F', () => {
    const planeBelow = stackOrderIssues(
      [unit({ id: 'g' }), unit({ id: 'p', kind: 'air', airStatus: 'active', projectsZoc: false })],
      NO_ENEMY_ADJACENT,
    )
    expect(planeBelow.map((issue) => issue.detail).join('｜')).toContain('4.8b E')

    const hedgehogBelow = stackOrderIssues(
      [
        unit({ id: 'g' }),
        unit({
          id: 'hh',
          isHedgehog: true,
          isCombat: false,
          attackCapable: false,
          projectsZoc: false,
        }),
      ],
      NO_ENEMY_ADJACENT,
    )
    expect(hedgehogBelow.map((issue) => issue.detail).join('｜')).toContain('4.8b F')
  })

  it('C13：合规的堆叠无提示（顺序由所有者自行安排，引擎不重排）', () => {
    const issues = stackOrderIssues(
      [unit({ id: 'zoc' }), unit({ id: 'other', projectsZoc: false })],
      NO_ENEMY_ADJACENT,
    )
    expect(issues).toEqual([])
  })
})

describe('W7 C13：4.9b 参战格的公开数值', () => {
  it('C13：参战格附上 AR / 反坦克效果 / 战斗值总值，且不展示算子（4.9b）', () => {
    const reveal = {
      rule: '4.9b',
      actionRating: 4,
      atEffects: 'heavy',
      totalStrength: 20,
      countersRevealed: false as const,
      detail: '样例',
    }
    const display = hexDisplay({
      viewer: 'soviet',
      hex: { col: 5, row: 5 },
      units: [unit({ id: 'enemy' })],
      facts: NO_ENEMY_ADJACENT,
      reveal,
    })
    expect(display.mode).toBe('topOnly')
    if (display.mode !== 'topOnly') return
    expect(display.reveal).toMatchObject({
      actionRating: 4,
      totalStrength: 20,
      countersRevealed: false,
    })
    // 未参战 ⇒ 无 reveal（「未参战敌方堆叠明细隐藏」）
    const notInCombat = hexDisplay({
      viewer: 'soviet',
      hex: { col: 5, row: 5 },
      units: [unit({ id: 'enemy' })],
      facts: NO_ENEMY_ADJACENT,
    })
    expect(notInCombat.mode === 'topOnly' && notInCombat.reveal).toBeNull()
  })
})

describe('W7 C13：共识开关 → 信息纪律（专规 4.0 / 1.4 / 4.9e）', () => {
  const decisions = (adopted: (item: string) => boolean): ConsensusDecision[] => [
    { item: '地图外盒是否隐藏（1.4）', adopted: adopted('1.4') },
    { item: '秘密掷骰（4.9e）', adopted: adopted('4.9e') },
    { item: '同步操作回合（2.4）', adopted: adopted('2.4') },
    { item: '可选规则与房规（4.1a、4.1b、4.1c、4.2a、4.2b、4.2c、4.3）', adopted: adopted('4.1') },
  ]

  it('C13：未作答 / 不采纳都**不启用**纪律（默认态：公开掷骰、盒可见）', () => {
    const policy = hiddenInfoPolicy([
      { item: '地图外盒是否隐藏（1.4）', adopted: null },
      { item: '秘密掷骰（4.9e）', adopted: false },
    ])
    expect(policy.hideOffMapBoxes).toBe(false)
    expect(policy.secretRolls).toBe(false)
    expect(policy.optionalRules).toEqual([])
    expect(policy.detail).toContain('未启用')
  })

  it('C13：全部采纳 ⇒ 隐藏盒 1.4 + 秘密掷骰 4.9e + 同步回合 2.4 + 可选规则全键', () => {
    const keys = ['4.1a', '4.1b', '4.1c', '4.2a', '4.2b', '4.2c', '4.3']
    const policy = hiddenInfoPolicy(
      decisions(() => true),
      keys,
    )
    expect(policy).toMatchObject({ hideOffMapBoxes: true, secretRolls: true, simulcast: true })
    expect(policy.optionalRules).toEqual(keys)
    expect(policy.detail).toContain('地图外盒对对手隐藏')
    expect(policy.detail).toContain('掷骰秘密进行')
  })

  it('C13：4.9e 秘密掷骰 ⇒ 只有掷骰方可见骰面', () => {
    const secret = hiddenInfoPolicy(decisions((item) => item === '4.9e'))
    expect(rollVisibleTo({ viewer: 'axis', rollingSide: 'axis', policy: secret })).toBe(true)
    expect(rollVisibleTo({ viewer: 'soviet', rollingSide: 'axis', policy: secret })).toBe(false)
    // 未启用 ⇒ 一律可见（4.9e「玩家通常公开进行掷骰」）
    const open = hiddenInfoPolicy([])
    expect(rollVisibleTo({ viewer: 'soviet', rollingSide: 'axis', policy: open })).toBe(true)
  })
})

describe('W7 C13：切方辅助', () => {
  it('C13：另一方与方名（2.2 交接用）', () => {
    expect(otherSide('axis')).toBe('soviet')
    expect(otherSide('soviet')).toBe('axis')
    expect(sideLabel('axis')).toBe('轴心国')
    expect(sideLabel('soviet')).toBe('苏联')
  })
})
