import { describe, expect, it } from 'vitest'

import {
  attackMultiplier,
  bestCombatTerrainForDefender,
  combatHexsideTerrains,
  combatLineOf,
  combatTerrainCandidates,
  hasCombatMultiplier,
  isBridgeCrossing,
  isHexTerrain,
  isHexsideTerrain,
  movementTerrainRank,
  requiresRoadToEnter,
  resolveCombatTerrain,
  selectMovementTerrain,
  selectTerrainLabel,
  tecFeature,
  tecFeatureNames,
} from '@/engine/rules'

/**
 * 地形选取引擎测试（通规 4.3：6.2d / 9.3b / 9.4d / 9.1f）
 *
 * 两个选用规则的差别是本文件的核心断言：
 *   6.2d 移动 —— 引擎自动取最贵，符号多少无关，忽略城市/村庄 nub，沿路改用道路成本；
 *   9.3b 战斗 —— 防御方手选，格边地形永不进候选，非城市/村庄格忽略其符号。
 */
describe('6.2d 移动地形选取', () => {
  it('单一地形按机动类型取成本', () => {
    expect(selectMovementTerrain({ terrainsPresent: ['Open'], mobility: 'track' })).toMatchObject({
      ok: true,
      terrain: 'Open',
      mp: 1,
    })
    expect(selectMovementTerrain({ terrainsPresent: ['Swamp'], mobility: 'leg' })).toMatchObject({
      ok: true,
      terrain: 'Swamp',
      mp: 3,
    })
  })

  it('格内多地形取最贵，且随机动类型变化', () => {
    expect(
      selectMovementTerrain({ terrainsPresent: ['Open', 'Woods'], mobility: 'track' }),
    ).toMatchObject({
      terrain: 'Woods',
      mp: 2,
    })
    expect(
      selectMovementTerrain({ terrainsPresent: ['Open', 'Woods'], mobility: 'truck' }),
    ).toMatchObject({
      terrain: 'Woods',
      mp: 3,
    })
    // Leg 下 Woods 与 Open 同为 1 MP，但地形名仍取 Woods（排序更高）
    expect(
      selectMovementTerrain({ terrainsPresent: ['Open', 'Woods'], mobility: 'leg' }),
    ).toMatchObject({
      terrain: 'Woods',
      mp: 1,
    })
    expect(
      selectMovementTerrain({ terrainsPresent: ['Open', 'Forest'], mobility: 'truck' }),
    ).toMatchObject({ terrain: 'Forest', mp: 4 })
  })

  it('Swamp 对履带/轮式是禁入（P），不是高成本', () => {
    const r = selectMovementTerrain({ terrainsPresent: ['Woods', 'Swamp'], mobility: 'track' })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'prohibited', terrain: 'Swamp', requiresRoad: true })
  })

  it('6.2d 例外：忽略城市/村庄 nub（其 MP 为 ot）', () => {
    expect(
      selectMovementTerrain({ terrainsPresent: ['Open', 'Village'], mobility: 'track' }),
    ).toMatchObject({
      terrain: 'Open',
      mp: 1,
    })
    expect(
      selectMovementTerrain({ terrainsPresent: ['Woods', 'Minor City'], mobility: 'track' }),
    ).toMatchObject({ terrain: 'Woods', mp: 2 })
  })

  it('6.2a 道路优先：沿路时改用道路成本（含无法直接进入的沼泽）', () => {
    const r = selectMovementTerrain({
      terrainsPresent: ['Swamp'],
      mobility: 'track',
      crossing: { routes: ['Secondary Road'] },
      followingRoad: true,
    })
    expect(r).toMatchObject({
      ok: true,
      terrain: 'Secondary Road',
      mp: 0.5,
      roadOverride: true,
      hexTerrain: 'Swamp',
    })
  })

  it('跨小河追加 MP，不改变格内地形成本', () => {
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'truck',
        crossing: { river: 'Minor River' },
      }),
    ).toMatchObject({ ok: true, terrain: 'Open', mp: 1, hexsideDelta: 5, bridge: false })
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'leg',
        crossing: { river: 'Minor River' },
      }),
    ).toMatchObject({ hexsideDelta: 1 })
  })

  it('跨大河：无桥禁行；有桥则河效果整个取消，按所走道路计费', () => {
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'track',
        crossing: { river: 'Major River' },
      }),
    ).toMatchObject({ ok: false, reason: 'prohibited', terrain: 'Major River' })

    // ★ 桥就是那条路，过桥必经之：调用方不必声明沿路，费用即按所走道路计
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'track',
        crossing: { river: 'Major River', routes: ['Secondary Road'] },
      }),
    ).toMatchObject({
      ok: true,
      terrain: 'Secondary Road',
      mp: 0.5,
      hexsideDelta: 0,
      totalMp: 0.5,
      bridge: true,
      crossedOnBridge: true,
    })
    // 声明沿路与不声明结果相同（不存在「有桥却不沿路」的情形）
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'track',
        crossing: { river: 'Major River', routes: ['Secondary Road'] },
        followingRoad: true,
      }),
    ).toMatchObject({ ok: true, terrain: 'Secondary Road', mp: 0.5, crossedOnBridge: true })
  })

  it('过河消耗与目标格消耗是两笔相加（totalMp = mp + hexsideDelta）', () => {
    // 跨小河不打折：Woods 目标格 3 + 小河 +5 = 8（Truck）
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Woods'],
        mobility: 'truck',
        crossing: { river: 'Minor River' },
      }),
    ).toMatchObject({ ok: true, mp: 3, hexsideDelta: 5, totalMp: 8 })
    // 同一格边有桥：过桥必经那条路 → 河效果取消，且按该路计费（Track 1 MP）
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Woods'],
        mobility: 'truck',
        crossing: { river: 'Minor River', routes: ['Track'] },
      }),
    ).toMatchObject({
      ok: true,
      terrain: 'Track',
      mp: 1,
      hexsideDelta: 0,
      totalMp: 1,
      bridge: true,
      crossedOnBridge: true,
    })
  })

  it('原文 MP 为 All（大河/步兵）：可通行但耗尽全部 MA，且不可 overrun', () => {
    const r = selectMovementTerrain({
      terrainsPresent: ['Open'],
      mobility: 'leg',
      crossing: { river: 'Major River' },
    })
    expect(r).toMatchObject({ ok: true, spendsAllMp: true, hexsideDelta: 0 })
    // 8.1a：All 不可 overrun
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'leg',
        crossing: { river: 'Major River' },
        forOverrun: true,
      }),
    ).toMatchObject({ ok: false, reason: 'prohibited' })
  })

  it('未知地形名必须显式失败，不得静默当 1 MP', () => {
    expect(selectMovementTerrain({ terrainsPresent: ['Rough'], mobility: 'track' })).toMatchObject({
      ok: false,
      reason: 'unknownTerrain',
      terrain: 'Rough',
    })
  })

  it('排序权重：Swamp ≻ Forest ≻ Woods ≻ Open（三种机动一致）', () => {
    expect(movementTerrainRank('Swamp')).toBe(Number.POSITIVE_INFINITY)
    expect(movementTerrainRank('Forest')).toBeGreaterThan(movementTerrainRank('Woods'))
    expect(movementTerrainRank('Woods')).toBeGreaterThan(movementTerrainRank('Open'))
    expect(selectTerrainLabel(['Open', 'Woods', 'Swamp'])).toBe('Swamp')
    expect(selectTerrainLabel(['Open', 'Village'])).toBe('Open')
  })
})

describe('9.3b 战斗地形选取', () => {
  it('候选集只含格内地形，格边地形永不进候选', () => {
    expect(combatTerrainCandidates({ terrainsPresent: ['Open', 'Woods'] })).toEqual([
      'Open',
      'Woods',
    ])
    expect(
      combatTerrainCandidates({ terrainsPresent: ['Open', 'Minor River', 'Railroad'] }),
    ).toEqual(['Open'])
    expect(combatTerrainCandidates({ terrainsPresent: ['Swamp', 'Major River'] })).toEqual([
      'Swamp',
    ])
  })

  it('非城市/村庄格忽略城市/村庄符号（spillover 例外）', () => {
    expect(combatTerrainCandidates({ terrainsPresent: ['Open', 'Village'] })).toEqual(['Open'])
    expect(
      combatTerrainCandidates({ terrainsPresent: ['Open', 'Village'], cityHex: true }),
    ).toEqual(['Open', 'Village'])
  })

  it('防御方选定的地形决定 Combat Line', () => {
    expect(
      resolveCombatTerrain({ terrainsPresent: ['Open', 'Woods'], chosen: 'Woods' }),
    ).toMatchObject({
      ok: true,
      combatLine: 'Close',
    })
    expect(
      resolveCombatTerrain({ terrainsPresent: ['Open', 'Woods'], chosen: 'Open' }),
    ).toMatchObject({
      combatLine: 'Open',
    })
    expect(
      resolveCombatTerrain({ terrainsPresent: ['Swamp', 'Woods'], chosen: 'Swamp' }),
    ).toMatchObject({
      combatLine: 'Very Close',
    })
    expect(
      resolveCombatTerrain({
        terrainsPresent: ['Major City'],
        chosen: 'Major City',
        cityHex: true,
      }),
    ).toMatchObject({ ok: true, combatLine: 'Extr Close' })
    // 未标 cityHex 时城市符号按溢出忽略 → 无候选（9.3b spillover 例外）
    expect(
      resolveCombatTerrain({ terrainsPresent: ['Major City'], chosen: 'Major City' }),
    ).toMatchObject({
      ok: false,
      reason: 'noCandidate',
    })
  })

  it('选非候选者（格边地形）被拒', () => {
    expect(
      resolveCombatTerrain({ terrainsPresent: ['Open', 'Minor River'], chosen: 'Minor River' }),
    ).toMatchObject({ ok: false, reason: 'notACandidate' })
  })

  it('攻方倍率随选定地形变化', () => {
    const open = resolveCombatTerrain({ terrainsPresent: ['Open'], chosen: 'Open' })
    expect(open).toMatchObject({ attackerMultipliers: { armor: 2, mech: 2, other: 1 } })
    const forest = resolveCombatTerrain({ terrainsPresent: ['Forest'], chosen: 'Forest' })
    expect(forest).toMatchObject({ attackerMultipliers: { armor: 0.5, mech: 1, other: 1 } })
  })

  it('防御方默认策略：取战斗线更不利攻方者', () => {
    expect(bestCombatTerrainForDefender({ terrainsPresent: ['Open', 'Woods'] })).toBe('Woods')
    // 非 cityHex 格的城市符号被忽略 → 只剩 Open/Swamp
    expect(bestCombatTerrainForDefender({ terrainsPresent: ['Open', 'Swamp', 'Major City'] })).toBe(
      'Swamp',
    )
    expect(
      bestCombatTerrainForDefender({
        terrainsPresent: ['Open', 'Swamp', 'Major City'],
        cityHex: true,
      }),
    ).toBe('Major City')
  })
})

describe('9.4d 倍率括号只作用于攻方', () => {
  it('Open 的 [x2] 攻方有效、守方读作 x1', () => {
    expect(attackMultiplier('Open', 'armor', 'attacker')).toBe(2)
    expect(attackMultiplier('Open', 'armor', 'defender')).toBe(1)
    expect(attackMultiplier('Open', 'mech', 'attacker')).toBe(2)
  })

  it('Forest 的 x1/2 不带括号 → 攻防同用，且守方也读 1/2', () => {
    expect(attackMultiplier('Forest', 'armor', 'attacker')).toBe(0.5)
    expect(attackMultiplier('Forest', 'armor', 'defender')).toBe(0.5)
  })

  it('Minor City 的 [x1/2] 仅攻方', () => {
    expect(attackMultiplier('Minor City', 'mech', 'attacker')).toBe(0.5)
    expect(attackMultiplier('Minor City', 'mech', 'defender')).toBe(1)
  })

  it('ot 行不产生倍率 → 1', () => {
    expect(attackMultiplier('Secondary Road', 'armor', 'attacker')).toBe(1)
  })

  it('★ 铁路/小路/大路不是战斗地形：只与移动与补给有关（用户 2026-09-13 裁定）', () => {
    // TEC attack 行全为 ot ⇒ 不产生任何战斗修正
    for (const name of ['Railroad', 'Track', 'Secondary Road']) {
      expect(hasCombatMultiplier(name)).toBe(false)
      expect(attackMultiplier(name, 'armor', 'attacker')).toBe(1)
      expect(attackMultiplier(name, 'mech', 'attacker')).toBe(1)
      expect(attackMultiplier(name, 'other', 'attacker')).toBe(1)
    }
    // 格边地形里**只有河/湖**会产生战斗修正
    expect(combatHexsideTerrains(['Minor River', 'Railroad', 'Track', 'Secondary Road'])).toEqual([
      'Minor River',
    ])
    expect(combatHexsideTerrains(['Major River', 'Lake/Blocked'])).toEqual([
      'Major River',
      'Lake/Blocked',
    ])
    expect(combatHexsideTerrains([])).toEqual([])
    // 格内地形照常有修正（本函数也用于说明「哪些地形会进战斗」）
    expect(hasCombatMultiplier('Woods')).toBe(true)
    expect(hasCombatMultiplier('Open')).toBe(true)
    expect(hasCombatMultiplier('不存在的怪地形')).toBe(false)
  })
})

describe('9.1f 格子属性（图例 *）', () => {
  it('Swamp：履带/轮式必须沿路才能进入，步兵不受限', () => {
    expect(requiresRoadToEnter('Swamp', 'track')).toBe(true)
    expect(requiresRoadToEnter('Swamp', 'truck')).toBe(true)
    expect(requiresRoadToEnter('Swamp', 'leg')).toBe(false)
  })

  it('无星号的地形不产生沿路限制', () => {
    expect(requiresRoadToEnter('Forest', 'track')).toBe(false)
    expect(requiresRoadToEnter('Open', 'track')).toBe(false)
  })
})

describe('桥梁＝联通河格边的路（用户裁定 2026-09-12）', () => {
  it('桥不设独立字段，由「河/湖格边 + 有路/铁」推出', () => {
    // map_edges.json 的一条真实记录形状 → 引擎侧 crossing
    const record = {
      edge_terrain: 'river',
      river_class: 'major',
      road_subclass: 'Secondary Road',
      road_present: true,
      rail_present: false,
    }
    const crossing = {
      river: record.river_class === 'major' ? 'Major River' : 'Minor River',
      routes: [
        ...(record.road_present ? [record.road_subclass] : []),
        ...(record.rail_present ? ['Railroad'] : []),
      ],
    }
    expect(crossing).toEqual({ river: 'Major River', routes: ['Secondary Road'] })
    expect(isBridgeCrossing(crossing)).toBe(true)
  })

  it('无河的格边即使有路也不是桥', () => {
    expect(isBridgeCrossing({ river: null, routes: ['Track', 'Railroad'] })).toBe(false)
  })

  it('多路并存时取最便宜的一条（Secondary Road 优于 Track/Railroad）', () => {
    const r = selectMovementTerrain({
      terrainsPresent: ['Open'],
      mobility: 'track',
      crossing: { river: 'Minor River', routes: ['Railroad', 'Secondary Road', 'Track'] },
      followingRoad: true,
    })
    expect(r).toMatchObject({ ok: true, terrain: 'Secondary Road', mp: 0.5, crossedOnBridge: true })
  })

  it('过桥费看所走的那条路（viaRoute 点名）；未点名或不在其中则用最省的', () => {
    const crossing = { river: 'Minor River', routes: ['Secondary Road', 'Track'] } as const
    // 走小路 → 付小路的 1 MP（不是大路的 0.5）
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'track',
        crossing,
        followingRoad: true,
        viaRoute: 'Track',
      }),
    ).toMatchObject({ ok: true, terrain: 'Track', mp: 1, crossedOnBridge: true })
    // 未点名 → 默认最省
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'track',
        crossing,
        followingRoad: true,
      }),
    ).toMatchObject({ terrain: 'Secondary Road', mp: 0.5 })
    // 点名的路不在这条格边上 → 退回最省
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'track',
        crossing,
        followingRoad: true,
        viaRoute: 'Railroad',
      }),
    ).toMatchObject({ terrain: 'Secondary Road', mp: 0.5 })
  })

  it('8.1c：overrun 时不给道路折扣（但桥不在受限之列）', () => {
    // 沿大路跨小河：正常移动 0.5 MP；overrun 不给道路折扣 → 按目标格成本 Woods 2
    // （该格边有大路＝有桥，故河效果本就取消，过河消耗 0）
    const crossing = { river: 'Minor River', routes: ['Secondary Road'] } as const
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Woods'],
        mobility: 'track',
        crossing,
        followingRoad: true,
        forOverrun: true,
      }),
    ).toMatchObject({
      ok: true,
      terrain: 'Woods',
      mp: 2,
      roadOverride: false,
      bridge: true,
      crossedOnBridge: false,
      hexsideDelta: 0,
      totalMp: 2,
    })

    // 无桥的小河：过河消耗照算 → Woods 2 + 小河 +3 = 5，远超 3 MP 门槛故不可 overrun
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Woods'],
        mobility: 'track',
        crossing: { river: 'Minor River' },
        forOverrun: true,
      }),
    ).toMatchObject({ ok: true, mp: 2, hexsideDelta: 3, totalMp: 5, bridge: false })

    // 有桥的大河：桥把河效果整个取消，overrun 也照此算——不是 P
    expect(
      selectMovementTerrain({
        terrainsPresent: ['Open'],
        mobility: 'track',
        crossing: { river: 'Major River', routes: ['Secondary Road'] },
        followingRoad: true,
        forOverrun: true,
      }),
    ).toMatchObject({ ok: true, terrain: 'Open', mp: 1, totalMp: 1, bridge: true })
  })

  it('过桥不追加河流成本；不过桥的小河仍 +N', () => {
    const onBridge = selectMovementTerrain({
      terrainsPresent: ['Woods'],
      mobility: 'truck',
      crossing: { river: 'Minor River', routes: ['Track'] },
      followingRoad: true,
    })
    expect(onBridge).toMatchObject({ ok: true, terrain: 'Track', mp: 1, hexsideDelta: 0 })

    const ford = selectMovementTerrain({
      terrainsPresent: ['Woods'],
      mobility: 'truck',
      crossing: { river: 'Minor River' },
    })
    expect(ford).toMatchObject({ ok: true, terrain: 'Woods', mp: 3, hexsideDelta: 5 })
  })
})

describe('TEC 索引', () => {
  it('查得到 13 行，查不到的名字返回 null', () => {
    expect(tecFeatureNames()).toHaveLength(13)
    expect(tecFeature('Swamp')).not.toBeNull()
    expect(tecFeature('Mountain')).toBeNull()
  })

  it('格内 / 格边 判定', () => {
    expect(isHexTerrain('Swamp')).toBe(true)
    expect(isHexTerrain('Minor River')).toBe(false)
    expect(isHexsideTerrain('Minor River')).toBe(true)
    expect(isHexsideTerrain('Woods')).toBe(false)
  })

  it('格边地形无独立战斗线（ot）', () => {
    expect(combatLineOf('Minor River')).toBeNull()
    expect(combatLineOf('Woods')).toBe('Close')
  })
})
