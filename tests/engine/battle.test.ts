import { describe, expect, it } from 'vitest'

import { chartsCrt, rulesConstants } from '@/data'
import type { HexRef } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import {
  BATTLE_SEQUENCE,
  allocateBattleLosses,
  antiTankMultiplier,
  battleArOf,
  battleColumnIndex,
  battleCombatSupply,
  battleModifiedDice,
  battleRatioLabel,
  declareBattleAr,
  declareBattleTerrain,
  defenderMayIgnoreOptions,
  exploitEligibility,
  planRetreatDestinations,
  resolveAdvanceAfterCombat,
  resolveBattleDice,
  resolveBattleSurprise,
  resolveOptionChoice,
  resolveRetreat,
  retreatPathTo,
  unitBattleStrength,
  validateBattleComposition,
  type BattleFacts,
  type BattleUnitView,
  type RetreatFacts,
} from '@/engine/rules'

/**
 * 战斗判定与结算（B12，OCS 9.0）测试
 *
 * 断言到条文一级：9.1 构成 / 9.5 战斗补给 / 9.6 AR / 9.4 地形与战力（含 9.4d 方括号、9.4e 反坦克、
 * 9.11d 多军力减半、9.5a 断补）/ 9.7 攻防比 / 9.8 奇袭横移 / 9.9 查表 / 9.10 选项 / 9.11 损失 /
 * 9.12 撤退 / 9.12g 推进 / 9.13 进击。地形成本与倍率取自 charts-tec.json 真实值。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

const DEFENDER_HEX: HexRef = { col: 36, row: 14 }
const ATTACKER_HEX: HexRef = { col: 36, row: 13 }

function unit(over: Partial<BattleUnitView> = {}): BattleUnitView {
  return {
    id: 'u1',
    side: 'axis',
    hex: ATTACKER_HEX,
    attackerType: 'other',
    attack: 10,
    ar: 4,
    dg: false,
    mode: 'combat',
    printedSteps: 1,
    steps: 1,
    re: 1,
    internalStocks: null,
    outOfSupply: false,
    mobility: 'leg',
    attackCapable: true,
    ...over,
  }
}

function defender(over: Partial<BattleUnitView> = {}): BattleUnitView {
  return unit({ id: 'd1', side: 'soviet', hex: DEFENDER_HEX, ...over })
}

function facts(over: Partial<BattleFacts> = {}): BattleFacts {
  return {
    canEnterForAttack: () => true,
    hedgehogLevelAt: () => 0,
    hexsideTerrainsBetween: () => [],
    hexTerrainsAt: () => ['Open'],
    defenderAtLevelAt: () => 'none',
    // 9.1c：缺省＝空账本（本环节还没打过）；账本本身在下面的 9.1c 用例里逐条喂
    attackedThisSegmentBy: () => false,
    attackedThisSegmentAt: () => false,
    ...over,
  }
}

const OPEN_COLUMNS = chartsCrt.crt.terrainColumns.Open!

/* ────────────────────────────── 9.1 战斗构成 ────────────────────────────── */

describe('9.1 战斗构成：限制与合法性', () => {
  it('正常构成：相邻攻击、单防御格、防御格内全部单位参战（9.1c/9.1d）', () => {
    const outcome = validateBattleComposition({
      attackers: [unit(), unit({ id: 'u2', hex: ATTACKER_HEX })],
      defenders: [defender()],
      facts: facts(),
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.data.defendingHex).toEqual(DEFENDER_HEX)
      expect(outcome.data.attackerIds).toEqual(['u1', 'u2'])
      expect(outcome.data.attackerHexes).toEqual([ATTACKER_HEX])
    }
  })

  it('无攻方/无守方（9.1b/9.1d）', () => {
    expect(
      validateBattleComposition({ attackers: [], defenders: [defender()], facts: facts() }),
    ).toMatchObject({ ok: false, rule: '9.1b', reason: 'noAttacker' })
    expect(
      validateBattleComposition({ attackers: [unit()], defenders: [], facts: facts() }),
    ).toMatchObject({
      ok: false,
      rule: '9.1d',
      reason: 'noDefender',
    })
  })

  it('9.1c：守方必须同格；攻方不得重复；一次只打一个格', () => {
    expect(
      validateBattleComposition({
        attackers: [unit()],
        defenders: [defender(), defender({ id: 'd2', hex: { col: 20, row: 20 } })],
        facts: facts(),
      }),
    ).toMatchObject({ ok: false, rule: '9.1c', reason: 'defendersInMultipleHexes' })
    expect(
      validateBattleComposition({
        attackers: [unit(), unit()],
        defenders: [defender()],
        facts: facts(),
      }),
    ).toMatchObject({ ok: false, reason: 'duplicateAttacker:u1' })
  })

  it('9.1a：不能打自己人', () => {
    expect(
      validateBattleComposition({
        attackers: [unit({ side: 'soviet' })],
        defenders: [defender()],
        facts: facts(),
      }),
    ).toMatchObject({ ok: false, rule: '9.1a', reason: 'friendlyFire:u1' })
  })

  it('9.1e：战略模式 / 未释放的预备 / 只能防御的单位不能攻击', () => {
    expect(
      validateBattleComposition({
        attackers: [unit({ mode: 'strat' })],
        defenders: [defender()],
        facts: facts(),
      }),
    ).toMatchObject({ ok: false, reason: 'stratCannotAttack:u1' })
    expect(
      validateBattleComposition({
        attackers: [unit({ mode: 'reserve' })],
        defenders: [defender()],
        facts: facts(),
      }),
    ).toMatchObject({ ok: false, reason: 'unreleasedReserveCannotAttack:u1' })
    expect(
      validateBattleComposition({
        attackers: [unit({ mode: 'reserve', releasedFromReserve: true })],
        defenders: [defender()],
        facts: facts(),
      }).ok,
    ).toBe(true)
    expect(
      validateBattleComposition({
        attackers: [unit({ attackCapable: false })],
        defenders: [defender()],
        facts: facts(),
      }),
    ).toMatchObject({ ok: false, reason: 'defenseOnlyUnit:u1' })
  })

  it('9.1f / 9.3a：不能进入的格不得攻击（含只能沿路进入者）', () => {
    expect(
      validateBattleComposition({
        attackers: [unit()],
        defenders: [defender()],
        facts: facts({ canEnterForAttack: () => false }),
      }),
    ).toMatchObject({ ok: false, rule: '9.1f', reason: 'cannotEnterDefendingHex:u1' })
  })
})

/* ────────────────────────────── 9.5 / 12.4 战斗补给 ────────────────────────────── */

describe('9.5 / 12.4 战斗补给：攻方全额才可攻、守方可选择不付', () => {
  it('攻方按攻击军力点数 1T/step；守方 2T，总 RE ≤1 时 1T', () => {
    const outcome = battleCombatSupply({
      attackers: [unit({ steps: 2 }), unit({ id: 'u2', steps: 1 })],
      defenders: [defender({ re: 2 })],
      attackerAvailableT: 3,
      defenderProvides: true,
      defenderAvailableT: 2,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.data.attackerRequiredT).toBe(3)
      expect(outcome.data.defenderRequiredT).toBe(2)
      expect(outcome.data.defenderPaid).toBe(true)
      expect(outcome.data.defenderMultiplier).toBe(1)
    }
    const smallDefender = battleCombatSupply({
      attackers: [unit({ steps: 1 })],
      defenders: [defender({ re: 0.5 })],
      attackerAvailableT: 1,
      defenderProvides: true,
      defenderAvailableT: 1,
    })
    expect(smallDefender.ok && smallDefender.data.defenderRequiredT).toBe(1)
  })

  it('12.4：攻方付不足 ⇒ 取消攻击', () => {
    expect(
      battleCombatSupply({
        attackers: [unit({ steps: 3 })],
        defenders: [defender()],
        attackerAvailableT: 1,
        defenderProvides: false,
        defenderAvailableT: 0,
      }),
    ).toMatchObject({ ok: false, rule: '12.4', reason: 'attackSupplyNotFull' })
  })

  it('9.5-B：守方不付（或无补给）⇒ 以一半战斗值防御', () => {
    const outcome = battleCombatSupply({
      attackers: [unit()],
      defenders: [defender({ re: 2 })],
      attackerAvailableT: 1,
      defenderProvides: false,
      defenderAvailableT: 5,
    })
    expect(outcome.ok && outcome.data).toMatchObject({
      defenderPaid: false,
      defenderMultiplier: 0.5,
    })
  })
})

/* ────────────────────────────── 9.6 行动值 ────────────────────────────── */

describe('9.6 / 9.6a 行动值：DRM 与模式修正', () => {
  it('9.6a：DG −1；战略模式归 0', () => {
    expect(battleArOf({ ar: 4, dg: false, mode: 'combat' })).toBe(4)
    expect(battleArOf({ ar: 4, dg: true, mode: 'combat' })).toBe(3)
    expect(battleArOf({ ar: 4, dg: true, mode: 'strat' })).toBe(0)
  })

  it('DRM ＝ 攻方 AR − 守方 AR；AR 单位必须参战（9.6）', () => {
    const outcome = declareBattleAr({
      attackers: [unit({ ar: 5 })],
      defenders: [defender({ ar: 2 })],
      attackerUnitId: 'u1',
      defenderUnitId: 'd1',
    })
    expect(outcome.ok && outcome.data).toEqual({ attackerAr: 5, defenderAr: 2, drm: 3 })
    expect(
      declareBattleAr({
        attackers: [unit()],
        defenders: [defender()],
        attackerUnitId: 'nope',
        defenderUnitId: 'd1',
      }),
    ).toMatchObject({ ok: false, reason: 'attackerArUnitNotInBattle:nope' })
    expect(
      declareBattleAr({
        attackers: [unit()],
        defenders: [defender()],
        attackerUnitId: 'u1',
        defenderUnitId: 'nope',
      }),
    ).toMatchObject({ ok: false, reason: 'defenderArUnitNotInBattle:nope' })
  })
})

/* ────────────────────────────── 9.3b / 9.4 地形与战力 ────────────────────────────── */

describe('9.4 地形宣布：攻方逐堆叠（格内或格边）、守方只选格内', () => {
  it('缺省＝全用守方选定的格内地形，并给出战斗表横行', () => {
    const outcome = declareBattleTerrain({
      attackers: [unit()],
      defenders: [defender()],
      facts: facts({ hexTerrainsAt: () => ['Woods'] }),
    })
    expect(outcome.ok && outcome.data).toMatchObject({
      defenderTerrain: 'Woods',
      combatLine: 'Close',
    })
  })

  it('9.4b：攻击堆叠可改用所穿越的格边地形；不在候选集内则报错', () => {
    const withRiver = declareBattleTerrain({
      attackers: [unit()],
      defenders: [defender()],
      facts: facts({
        hexTerrainsAt: () => ['Woods'],
        hexsideTerrainsBetween: () => ['Minor River'],
      }),
      stackChoices: [{ hex: ATTACKER_HEX, kind: 'hexside', terrain: 'Minor River' }],
    })
    expect(withRiver.ok && withRiver.data.attackerTerrainByHex[0]).toMatchObject({
      terrain: 'Minor River',
      kind: 'hexside',
    })
    expect(
      declareBattleTerrain({
        attackers: [unit()],
        defenders: [defender()],
        facts: facts({ hexTerrainsAt: () => ['Woods'] }),
        stackChoices: [{ hex: ATTACKER_HEX, kind: 'hexside', terrain: 'Minor River' }],
      }),
    ).toMatchObject({ ok: false, rule: '9.4b' })
  })

  it('9.4c：守方只能选格内地形（选格边地形即非法）', () => {
    expect(
      declareBattleTerrain({
        attackers: [unit()],
        defenders: [defender()],
        facts: facts({
          hexTerrainsAt: () => ['Woods'],
          hexsideTerrainsBetween: () => ['Minor River'],
        }),
        defenderTerrain: 'Minor River',
      }),
    ).toMatchObject({ ok: false, rule: '9.4c' })
  })

  it('★ 9.4b：铁路/小路/大路不产生战斗修正，故不得作为格边地形选项', () => {
    // 该格边既有铁路又无河：引擎筛掉后候选为空 ⇒ 选它即非法
    expect(
      declareBattleTerrain({
        attackers: [unit()],
        defenders: [defender()],
        facts: facts({
          hexTerrainsAt: () => ['Woods'],
          hexsideTerrainsBetween: () => ['Railroad', 'Secondary Road', 'Track'],
        }),
        stackChoices: [{ hex: ATTACKER_HEX, kind: 'hexside', terrain: 'Railroad' }],
      }),
    ).toMatchObject({ ok: false, rule: '9.4b', reason: 'stackTerrainNotCandidate:Railroad' })

    // 同一格边「河 + 路」时只剩河可用（过河攻方 ×1/2）
    const mixed = declareBattleTerrain({
      attackers: [unit({ attackerType: 'armor', attack: 10 })],
      defenders: [defender()],
      facts: facts({
        hexTerrainsAt: () => ['Open'],
        hexsideTerrainsBetween: () => ['Minor River', 'Secondary Road'],
      }),
      stackChoices: [{ hex: ATTACKER_HEX, kind: 'hexside', terrain: 'Minor River' }],
    })
    expect(mixed.ok).toBe(true)
    if (!mixed.ok) return
    expect(mixed.data.attackerMultiplierByHex[0]).toMatchObject({ armor: 0.5 })
  })
})

describe('9.4 / 9.4d / 9.4e / 9.11d / 9.5a 单单位战力', () => {
  it('9.4d：开阔地攻方装甲/机械化 ×2；守方读作 ×1', () => {
    expect(
      unitBattleStrength({
        unit: unit({ attackerType: 'armor', attack: 10 }),
        role: 'attacker',
        terrain: 'Open',
        combatSupplyPaid: true,
      }).strength,
    ).toBe(20)
    expect(
      unitBattleStrength({
        unit: defender({ attackerType: 'armor', attack: 10 }),
        role: 'defender',
        terrain: 'Open',
        combatSupplyPaid: true,
      }).strength,
    ).toBe(10)
  })

  it('9.4e：守方轻型 AT 时装甲仍 ×2、机械化降 ×1.5；重型 AT 时两者都 ×1.5', () => {
    expect(antiTankMultiplier(2, 'armor', 'light')).toBe(2)
    expect(antiTankMultiplier(2, 'mech', 'light')).toBe(1.5)
    expect(antiTankMultiplier(2, 'armor', 'heavy')).toBe(1.5)
    expect(antiTankMultiplier(2, 'mech', 'heavy')).toBe(1.5)
    expect(antiTankMultiplier(2, 'other', 'heavy')).toBe(2)
    expect(
      unitBattleStrength({
        unit: unit({ attackerType: 'mech', attack: 10 }),
        role: 'attacker',
        terrain: 'Open',
        defenderAtLevel: 'light',
        combatSupplyPaid: true,
      }).strength,
    ).toBe(15)
  })

  it('9.11d：多军力单位攻方有损失即减半；守方损失达印值一半才减半（规则书 14-4-3 例）', () => {
    const attackerLost = unitBattleStrength({
      unit: unit({ printedSteps: 3, steps: 2 }),
      role: 'attacker',
      terrain: 'Open',
      combatSupplyPaid: true,
    })
    expect(attackerLost.strength).toBe(5) // 10 → 攻方减半
    const defenderLost1 = unitBattleStrength({
      unit: defender({ printedSteps: 3, steps: 2 }),
      role: 'defender',
      terrain: 'Open',
      combatSupplyPaid: true,
    })
    expect(defenderLost1.strength).toBe(10) // 只损失 1 点：防御不减半
    const defenderLost2 = unitBattleStrength({
      unit: defender({ printedSteps: 3, steps: 1 }),
      role: 'defender',
      terrain: 'Open',
      combatSupplyPaid: true,
    })
    expect(defenderLost2.strength).toBe(5)
  })

  it('9.5-A / 9.5a：无战斗补给的攻方不能攻击；守方未付 ½；断补再 ½（无补给的断补守方 ¼）', () => {
    expect(
      unitBattleStrength({
        unit: unit(),
        role: 'attacker',
        terrain: 'Open',
        combatSupplyPaid: false,
      }),
    ).toMatchObject({ cannotAttack: true, rule: '9.5-A' })
    expect(
      unitBattleStrength({
        unit: defender({ attack: 8 }),
        role: 'defender',
        terrain: 'Open',
        combatSupplyPaid: false,
      }).strength,
    ).toBe(4)
    expect(
      unitBattleStrength({
        unit: defender({ attack: 8, outOfSupply: true }),
        role: 'defender',
        terrain: 'Open',
        combatSupplyPaid: true,
      }).strength,
    ).toBe(4)
    expect(
      unitBattleStrength({
        unit: defender({ attack: 8, outOfSupply: true }),
        role: 'defender',
        terrain: 'Open',
        combatSupplyPaid: false,
      }).strength,
    ).toBe(2)
  })
})

/* ────────────────────────────── 9.7 攻防比与列位 ────────────────────────────── */

describe('9.7 / 9.7a / 9.14a 攻防比与列位', () => {
  it('9.7 + 4.2：除以较小值后**四舍五入**（小数 ≥ .5 进位），并按 4.2 的两例复核', () => {
    // 4.2 原文例：9.75 : 2 = 4.875 → 5:1
    expect(battleRatioLabel(9.75, 2)).toBe('5:1')
    // 4.2 原文例：15:6 = 2.5 → 3:1
    expect(battleRatioLabel(15, 6)).toBe('3:1')
    expect(battleRatioLabel(30, 10)).toBe('3:1')
    expect(battleRatioLabel(10, 30)).toBe('1:3')
    expect(battleRatioLabel(10, 10)).toBe('1:1')
    // 20:12 = 1.667 → 2:1（不是向下取整的 1:1）
    expect(battleRatioLabel(20, 12)).toBe('2:1')
    expect(battleRatioLabel(12, 20)).toBe('1:2')
    // 小数 < .5 仍向下
    expect(battleRatioLabel(14, 10)).toBe('1:1')
    expect(battleRatioLabel(19, 10)).toBe('2:1')
  })

  it('9.7a：取「小于或等于取整后比值」的最大列；低于最小列归入最小列（9.7b）', () => {
    const threeToOne = OPEN_COLUMNS.indexOf('3:1')
    expect(threeToOne).toBeGreaterThanOrEqual(0)
    expect(battleColumnIndex(OPEN_COLUMNS, 30, 10)).toMatchObject({
      index: threeToOne,
      rule: '9.7a',
    })
    expect(battleColumnIndex(OPEN_COLUMNS, 1, 100)).toMatchObject({ index: 0, rule: '9.7a' })
    // 4.875 → 5:1（Open 列含 5:1）
    expect(OPEN_COLUMNS[battleColumnIndex(OPEN_COLUMNS, 9.75, 2).index]).toBe('5:1')
  })

  it('9.14a：被攻击方战斗值为 0 ⇒ 最右列；攻击方为 0 ⇒ 最左列', () => {
    expect(battleColumnIndex(OPEN_COLUMNS, 10, 0)).toMatchObject({
      index: OPEN_COLUMNS.length - 1,
      rule: '9.14a',
    })
    expect(battleColumnIndex(OPEN_COLUMNS, 0, 10)).toMatchObject({ index: 0, rule: '9.14a' })
  })
})

/* ────────────────────────────── 9.8 / 9.9 横移与查表 ────────────────────────────── */

describe('9.8 / 9.1g / 9.9 奇袭横移与战斗表', () => {
  it('攻方奇袭向右横移、守方向左；越界夹回（9.1g）', () => {
    const attackerSurprise = resolveBattleSurprise({
      die: 12,
      arDifferential: 0,
      attackType: 'regular',
      defenderInHedgehog: false,
      shiftDie: 3,
      columnIndex: 4,
      columnCount: OPEN_COLUMNS.length,
    })
    expect(attackerSurprise).toMatchObject({
      side: 'attacker',
      shift: 3,
      columnIndex: 7,
      clamped: false,
    })

    const defenderSurprise = resolveBattleSurprise({
      die: 12,
      arDifferential: 0,
      attackType: 'regular',
      defenderInHedgehog: true,
      shiftDie: 1,
      columnIndex: 4,
      columnCount: OPEN_COLUMNS.length,
    })
    // 12 −1 = 11 ⇒ 仍为攻方奇袭；此处只验证 −1 生效（改守方奇袭见下表）
    expect(defenderSurprise.side).toBe('attacker')

    const clipped = resolveBattleSurprise({
      die: 2,
      arDifferential: 0,
      attackType: 'regular',
      defenderInHedgehog: true,
      shiftDie: 6,
      columnIndex: 1,
      columnCount: OPEN_COLUMNS.length,
    })
    expect(clipped).toMatchObject({ side: 'defender', shift: -6, columnIndex: 0, clamped: true })
  })

  it('9.9：修正骰 ＝ 2d6 + 攻方 AR − 守方 AR − 环形工事完整等级', () => {
    expect(
      battleModifiedDice({ die: 7, attackerAr: 5, defenderAr: 1, hedgehogLevel: 2 }),
    ).toMatchObject({
      modifiedDice: 9,
      rule: '9.9',
    })
    expect(() =>
      battleModifiedDice({ die: 1, attackerAr: 0, defenderAr: 0, hedgehogLevel: 0 }),
    ).toThrowError(/2–12/)
  })

  it('9.9：用横移后的列位标签直接取列，结果可解析', () => {
    const outcome = resolveBattleDice({
      die: 7,
      attackerAr: 5,
      defenderAr: 0,
      hedgehogLevel: 0,
      combatLine: 'Open',
      columnLabel: '4:1',
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.data.modifiedDice).toBe(12)
      expect(outcome.data.ratio).toBe('4:1')
      expect(outcome.data.raw.length).toBeGreaterThan(0)
    }
  })

  it('9.2 流程清单按规则顺序列出九步', () => {
    expect(BATTLE_SEQUENCE.map((item) => item.step)).toEqual([
      'composition',
      'combatSupply',
      'declareAr',
      'declareTerrain',
      'surprise',
      'battleDice',
      'losses',
      'options',
      'retreat',
      'advance',
    ])
  })
})

/* ────────────────────────────── 9.11 损失 / 9.10 选项 ────────────────────────────── */

describe('9.11 损失分配：AR 单位承受第一点，之后逐点均摊', () => {
  it('9.11c：AR 单位先受第一点，随后所有单位各承受一点（规则书例：3 军力师 + 1 军力单位，2 点损失）', () => {
    const result = allocateBattleLosses({
      required: 2,
      units: [
        { id: 'div', steps: 3 },
        { id: 'bn', steps: 1 },
      ],
      arUnitId: 'div',
    })
    expect(result.allocation).toEqual([
      { unitId: 'div', steps: 1 },
      { unitId: 'bn', steps: 1 },
    ])
    expect(result.eliminated).toEqual(['bn'])
    expect(result.ignored).toBe(0)
  })

  it('9.11b：超出承受能力的损失被忽略（规则书例：4 点损失 vs 3 军力 ⇒ 全灭，超出忽略）', () => {
    const result = allocateBattleLosses({
      required: 4,
      units: [{ id: 'div', steps: 3 }],
      arUnitId: 'div',
    })
    expect(result.totalLost).toBe(3)
    expect(result.eliminated).toEqual(['div'])
    expect(result.ignored).toBe(1)
  })

  it('无 AR 单位时按输入顺序', () => {
    const result = allocateBattleLosses({
      required: 1,
      units: [
        { id: 'a', steps: 2 },
        { id: 'b', steps: 2 },
      ],
    })
    expect(result.allocation).toEqual([{ unitId: 'a', steps: 1 }])
  })
})

describe('9.10 选项：撤退格数与损失军力任意组合，总数必须满足', () => {
  it('9.10a：o2 可由「1 点损失 + 1 格撤退」满足；组合不足或超出均非法', () => {
    expect(resolveOptionChoice({ points: 2, retreatHexes: 1, lossPoints: 1 })).toMatchObject({
      ok: true,
    })
    expect(resolveOptionChoice({ points: 2, retreatHexes: 2, lossPoints: 0 }).ok).toBe(true)
    expect(resolveOptionChoice({ points: 2, retreatHexes: 0, lossPoints: 2 }).ok).toBe(true)
    expect(resolveOptionChoice({ points: 2, retreatHexes: 1, lossPoints: 0 })).toMatchObject({
      ok: false,
      rule: '9.10a',
    })
    expect(resolveOptionChoice({ points: 2, retreatHexes: -1, lossPoints: 3 }).ok).toBe(false)
  })

  it('9.10c：攻方撤退或未完成全部选项 ⇒ 守方可忽略自己的选项', () => {
    expect(
      defenderMayIgnoreOptions({ attackerRetreated: true, attackerCompleted: true }).mayIgnore,
    ).toBe(true)
    expect(
      defenderMayIgnoreOptions({ attackerRetreated: false, attackerCompleted: false }).mayIgnore,
    ).toBe(true)
    expect(
      defenderMayIgnoreOptions({ attackerRetreated: false, attackerCompleted: true }).mayIgnore,
    ).toBe(false)
  })

  it('9.10d / 9.13 / 9.13b：进击标记的取得与忽略条件', () => {
    const base = {
      eThreshold: 4,
      // 9.13 逐单位：参战单位各自的 AR / DG（不再是单个 attackerAr/attackerDg）
      attackers: [{ unitId: 'a1', ar: 5, dg: false }],
      attackerRetreatedInOptions: false,
      attackerAllOptionsAsLosses: true,
      attackType: 'regular' as const,
      phase: 'combat' as const,
      attackerHexes: [ATTACKER_HEX],
    }
    const granted = exploitEligibility(base)
    expect(granted.ok && granted.data.granted).toBe(true)
    expect(granted.ok && granted.data.grantedUnitIds).toEqual(['a1'])
    const noE = exploitEligibility({ ...base, eThreshold: undefined })
    expect(noE.ok && noE.data.reason).toBe('noEResult')
    const lowAr = exploitEligibility({ ...base, attackers: [{ unitId: 'a1', ar: 3, dg: false }] })
    expect(lowAr.ok && lowAr.data.reason).toBe('arBelowThreshold')
    const dg = exploitEligibility({ ...base, attackers: [{ unitId: 'a1', ar: 5, dg: true }] })
    expect(dg.ok && dg.data.reason).toBe('attackerDg')
    expect(dg.rule).toBe('9.13b-A')
    expect(exploitEligibility({ ...base, attackType: 'overrun' }).rule).toBe('9.13b-B')
    expect(exploitEligibility({ ...base, phase: 'exploitation' }).rule).toBe('9.13b-B')
    expect(exploitEligibility({ ...base, attackerRetreatedInOptions: true }).rule).toBe('9.10d')
    expect(exploitEligibility({ ...base, attackerAllOptionsAsLosses: false }).rule).toBe('9.10d')
    // 9.13b-C：三个堆叠，或两个堆叠不相邻 ⇒ 忽略进击
    expect(
      exploitEligibility({
        ...base,
        attackerHexes: [ATTACKER_HEX, { col: 37, row: 13 }, { col: 35, row: 14 }],
      }).rule,
    ).toBe('9.13b-C')
    expect(
      exploitEligibility({
        ...base,
        attackerHexes: [ATTACKER_HEX, { col: 20, row: 20 }],
      }).rule,
    ).toBe('9.13b-C')
    // 两个相邻堆叠则可以取得
    expect(
      exploitEligibility({ ...base, attackerHexes: [ATTACKER_HEX, { col: 36, row: 14 }] }).ok,
    ).toBe(true)
    expect(rulesConstants.combat.hedgehogSurpriseDrm).toBe(-1)
  })

  it('9.13：进击标记是**逐单位**的——AR 5 与 AR 4 各得一个（修前只给 1 个）', () => {
    const outcome = exploitEligibility({
      eThreshold: 4,
      attackers: [
        { unitId: 'ar5', ar: 5, dg: false },
        { unitId: 'ar4', ar: 4, dg: false },
      ],
      attackerRetreatedInOptions: false,
      attackerAllOptionsAsLosses: true,
      attackType: 'regular',
      phase: 'combat',
      attackerHexes: [ATTACKER_HEX],
    })
    expect(outcome.ok && outcome.data.grantedUnitIds).toEqual(['ar5', 'ar4'])
  })

  it('9.13b-A：DG 者不标记，但**同战的非 DG 同伴照常结算**', () => {
    const build = (eThreshold: number) =>
      exploitEligibility({
        eThreshold,
        attackers: [
          { unitId: 'dg5', ar: 5, dg: true },
          { unitId: 'ok4', ar: 4, dg: false },
        ],
        attackerRetreatedInOptions: false,
        attackerAllOptionsAsLosses: true,
        attackType: 'regular',
        phase: 'combat',
        attackerHexes: [ATTACKER_HEX],
      })
    // 阈值 5：只有 dg5 够格，而它 DG ⇒ 无人取得
    const onlyDg = build(5)
    expect(onlyDg.ok && onlyDg.data.grantedUnitIds).toEqual([])
    expect(onlyDg.ok && onlyDg.data.reason).toBe('attackerDg')
    // 阈值 4：未 DG 的 ok4 够格 ⇒ 由它取得（9.13b-A 括注）
    const withMate = build(4)
    expect(withMate.ok && withMate.data.grantedUnitIds).toEqual(['ok4'])
  })
})

/* ────────────────────────────── 9.12 撤退 / 9.12g 推进 ────────────────────────────── */

const retreatFacts = (over: Partial<RetreatFacts> = {}): RetreatFacts => ({
  enemyCombatUnitAt: () => false,
  inEnemyZocAt: () => false,
  prohibitedFor: () => false,
  friendlyCombatUnitsAt: () => [],
  immobile: () => false,
  ...over,
})

describe('9.12 撤退：完整距离、DG、敌方 ZOC 与被消灭', () => {
  const retreatUnit = {
    id: 'u1',
    side: 'axis' as const,
    hex: ATTACKER_HEX,
    mobility: 'leg' as const,
    dg: false,
  }

  it('9.12a：撤退 2 格 ⇒ DG；只撤 1 格且无敌方 ZOC ⇒ 不 DG', () => {
    const two = resolveRetreat({
      unit: retreatUnit,
      path: [
        { col: 36, row: 12 },
        { col: 36, row: 11 },
      ],
      facts: retreatFacts(),
    })
    expect(two).toMatchObject({ destroyed: false, gainsDg: true, hex: { col: 36, row: 11 } })
    const one = resolveRetreat({
      unit: retreatUnit,
      path: [{ col: 36, row: 12 }],
      facts: retreatFacts(),
    })
    expect(one).toMatchObject({ destroyed: false, gainsDg: false })
  })

  it('9.12：必须穿过敌方战斗单位格或禁入地形 ⇒ 被消灭', () => {
    expect(
      resolveRetreat({
        unit: retreatUnit,
        path: [
          { col: 36, row: 12 },
          { col: 36, row: 11 },
        ],
        facts: retreatFacts({ enemyCombatUnitAt: (hex) => hex.row === 11 }),
      }),
    ).toMatchObject({ destroyed: true, hex: null, rule: '9.12' })
    expect(
      resolveRetreat({
        unit: retreatUnit,
        path: [{ col: 36, row: 12 }],
        facts: retreatFacts({ prohibitedFor: () => true }),
      }),
    ).toMatchObject({ destroyed: true })
  })

  it('9.12e：进入敌方 ZOC ⇒ DG，且「恰好」在该格的友方战斗单位一并 DG；此前已 DG ⇒ 额外损失 1 军力', () => {
    const result = resolveRetreat({
      unit: retreatUnit,
      path: [{ col: 36, row: 12 }],
      facts: retreatFacts({
        inEnemyZocAt: () => true,
        friendlyCombatUnitsAt: () => ['ally1', 'ally2'],
      }),
    })
    expect(result).toMatchObject({ gainsDg: true, dgCompanions: ['ally1', 'ally2'], extraLoss: 0 })
    const alreadyDg = resolveRetreat({
      unit: { ...retreatUnit, dg: true },
      path: [{ col: 36, row: 12 }],
      facts: retreatFacts({ inEnemyZocAt: () => true }),
    })
    expect(alreadyDg).toMatchObject({ gainsDg: true, extraLoss: 1 })
  })

  it('9.12b：任何模式下都不可移动的单位被迫撤退 ⇒ 直接消灭', () => {
    expect(
      resolveRetreat({
        unit: retreatUnit,
        path: [{ col: 36, row: 12 }],
        facts: retreatFacts({ immobile: () => true }),
      }),
    ).toMatchObject({ destroyed: true, rule: '9.12b' })
  })

  it('9.12e 次序：第 2 格本身即敌方 ZOC 时不算「进入前已 DG」⇒ 不额外损失；此前已 DG 才损失 1 点', () => {
    // 两格撤退，第 2 格（11）在敌方 ZOC 内；起始未 DG ⇒ 该格 ZOC 的 DG 与 9.12a 的 DG 同时发生，不额外损失
    expect(
      resolveRetreat({
        unit: retreatUnit,
        path: [
          { col: 36, row: 12 },
          { col: 36, row: 11 },
        ],
        facts: retreatFacts({ inEnemyZocAt: (hex) => hex.row === 11 }),
      }),
    ).toMatchObject({ gainsDg: true, extraLoss: 0 })

    // 起始即 DG ⇒ 进入 ZOC 前已是 DG ⇒ 损失 1 点
    expect(
      resolveRetreat({
        unit: { ...retreatUnit, dg: true },
        path: [{ col: 36, row: 12 }],
        facts: retreatFacts({ inEnemyZocAt: () => true }),
      }),
    ).toMatchObject({ extraLoss: 1 })

    // 连续进入两个 ZOC 格，该堆叠仍只损失 1 点（原文「该堆栈损失一点军力」）
    expect(
      resolveRetreat({
        unit: { ...retreatUnit, dg: true },
        path: [
          { col: 36, row: 12 },
          { col: 36, row: 11 },
        ],
        facts: retreatFacts({ inEnemyZocAt: () => true }),
      }).extraLoss,
    ).toBe(1)
  })

  it('9.12：完整撤退距离——落点与起始格的直线距离必须等于撤退格数', () => {
    // 直线 1 格 ✓
    expect(
      resolveRetreat({ unit: retreatUnit, path: [{ col: 36, row: 12 }], facts: retreatFacts() })
        .fullRetreatDistanceMet,
    ).toBe(true)
    // 之字形 2 步、落点直线距离恰好 2 ✓（路径不必是直线）
    expect(
      resolveRetreat({
        unit: retreatUnit,
        path: [
          { col: 36, row: 12 },
          { col: 35, row: 12 },
        ],
        facts: retreatFacts(),
      }).fullRetreatDistanceMet,
    ).toBe(true)
    // 走了 2 步却回到起点（直线距离 0 ≠ 2）⇒ 不满足完整撤退距离
    expect(
      resolveRetreat({
        unit: retreatUnit,
        path: [
          { col: 36, row: 12 },
          { col: 36, row: 13 },
        ],
        facts: retreatFacts(),
      }).fullRetreatDistanceMet,
    ).toBe(false)
  })
})

describe('9.12g 战后推进', () => {
  it('防御格未清空 ⇒ 不推进；攻方在选项中撤退 ⇒ 不得推进（9.12g-B）', () => {
    expect(
      resolveAdvanceAfterCombat({
        attackType: 'regular',
        defendingHexCleared: false,
        attackerRetreated: false,
        candidates: [{ id: 'u1', paidCombatSupply: true }],
      }),
    ).toMatchObject({ ok: true })
    expect(
      resolveAdvanceAfterCombat({
        attackType: 'regular',
        defendingHexCleared: true,
        attackerRetreated: true,
        candidates: [{ id: 'u1', paidCombatSupply: true }],
      }),
    ).toMatchObject({ ok: false, rule: '9.12g-B' })
  })

  it('9.12g-D：突袭后必须推进（且只有付了战斗补给者能推进）；常规战斗可自愿选择', () => {
    const overrun = resolveAdvanceAfterCombat({
      attackType: 'overrun',
      defendingHexCleared: true,
      attackerRetreated: false,
      candidates: [
        { id: 'paid', paidCombatSupply: true },
        { id: 'unpaid', paidCombatSupply: false },
      ],
    })
    expect(overrun.ok && overrun.data).toMatchObject({ advanceUnitIds: ['paid'], mandatory: true })

    const regular = resolveAdvanceAfterCombat({
      attackType: 'regular',
      defendingHexCleared: true,
      attackerRetreated: false,
      candidates: [{ id: 'paid', paidCombatSupply: true }],
      chosenUnitIds: [],
    })
    expect(regular.ok && regular.data).toMatchObject({ advanceUnitIds: [], mandatory: false })
  })

  it('9.12g-A：选了没付战斗补给的单位推进 ⇒ 非法', () => {
    expect(
      resolveAdvanceAfterCombat({
        attackType: 'regular',
        defendingHexCleared: true,
        attackerRetreated: false,
        candidates: [{ id: 'unpaid', paidCombatSupply: false }],
        chosenUnitIds: ['unpaid'],
      }),
    ).toMatchObject({ ok: false, rule: '9.12g-A' })
  })
})

/* ────────── 9.12 撤退落点规划（地图优先交互：画「安全格 / 有 ZOC 影响格」） ────────── */

describe('9.12 撤退落点规划：完整撤退距离、路径与 ZOC 分类', () => {
  const from: HexRef = { col: 36, row: 13 }

  it('planRetreatDestinations：全部落点的直线距离都等于撤退格数，且各自给出等长合法路径', () => {
    const plans = planRetreatDestinations({
      from,
      distance: 2,
      mobility: 'leg',
      side: 'axis',
      facts: retreatFacts(),
    })
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      expect(hexDistance(from, plan.hex)).toBe(2)
      expect(plan.path).toHaveLength(2)
      expect(plan.path[plan.path.length - 1]).toEqual(plan.hex)
    }
  })

  it('9.12e：落点是否在敌方 ZOC 内由事实层给出（界面据此区分安全格 / 有 ZOC 影响格）', () => {
    const plans = planRetreatDestinations({
      from,
      distance: 1,
      mobility: 'leg',
      side: 'axis',
      // 只把「行号更小」的落点当作处于敌方 ZOC（构造一个可判定的子集）
      facts: retreatFacts({ inEnemyZocAt: (hex) => hex.row < from.row }),
    })
    expect(plans.length).toBeGreaterThan(0)
    expect(plans.some((plan) => plan.inEnemyZoc)).toBe(true)
    expect(plans.some((plan) => !plan.inEnemyZoc)).toBe(true)
    for (const plan of plans) expect(plan.inEnemyZoc).toBe(plan.hex.row < from.row)
  })

  it('9.12：被禁入地形或敌方战斗单位挡住的落点仍列出，但标为「选了会被消灭」（9.12 明文允许该结局）', () => {
    const all = planRetreatDestinations({
      from,
      distance: 1,
      mobility: 'leg',
      side: 'axis',
      facts: retreatFacts(),
    })
    const target = all[0]!.hex
    const blockedByTerrain = planRetreatDestinations({
      from,
      distance: 1,
      mobility: 'leg',
      side: 'axis',
      facts: retreatFacts({
        prohibitedFor: (_mobility, hex) => hex.col === target.col && hex.row === target.row,
      }),
    })
    const terrainRow = blockedByTerrain.find(
      (plan) => plan.hex.col === target.col && plan.hex.row === target.row,
    )
    // 9.12：「如果单位撤退时，必须穿过敌方占据的格或禁入地形，则消灭这些单位」⇒ 是合法结局，故仍在列
    expect(terrainRow).toBeDefined()
    expect(terrainRow!.forcedDestruction).toBe(true)

    const blockedByEnemy = planRetreatDestinations({
      from,
      distance: 1,
      mobility: 'leg',
      side: 'axis',
      facts: retreatFacts({
        enemyCombatUnitAt: (hex) => hex.col === target.col && hex.row === target.row,
      }),
    })
    const enemyRow = blockedByEnemy.find(
      (plan) => plan.hex.col === target.col && plan.hex.row === target.row,
    )
    expect(enemyRow).toBeDefined()
    expect(enemyRow!.forcedDestruction).toBe(true)
    // 干净路径的落点不会被标成必死
    expect(all.every((plan) => plan.forcedDestruction === false)).toBe(true)
  })

  it('9.12b：不可移动单位仍给出落点（但全部标为「被迫撤退 ⇒ 被消灭」）；撤退格数 0 与 blocked 判据照旧剔除', () => {
    const immobile = planRetreatDestinations({
      from,
      distance: 1,
      mobility: 'leg',
      side: 'axis',
      facts: retreatFacts(),
      immobile: true,
    })
    // 9.12b：任何模式下都不可移动者被迫撤退时被直接摧毁 ⇒ 落点照列，但一律标必死
    expect(immobile.length).toBeGreaterThan(0)
    expect(immobile.every((plan) => plan.forcedDestruction)).toBe(true)
    expect(
      planRetreatDestinations({
        from,
        distance: 0,
        mobility: 'leg',
        side: 'axis',
        facts: retreatFacts(),
      }),
    ).toEqual([])
    const blocked = planRetreatDestinations({
      from,
      distance: 1,
      mobility: 'leg',
      side: 'axis',
      facts: retreatFacts(),
      blocked: () => true,
    })
    expect(blocked).toEqual([])
  })

  it('retreatPathTo：直线距离不等于撤退格数 ⇒ 无合法路径（9.12 的完整撤退距离是硬条件）', () => {
    const to = { col: 36, row: 12 }
    expect(hexDistance(from, to)).toBe(1)
    expect(
      retreatPathTo({
        from,
        to,
        distance: 1,
        mobility: 'leg',
        side: 'axis',
        facts: retreatFacts(),
      }),
    ).toEqual([to])
    expect(
      retreatPathTo({
        from,
        to,
        distance: 2,
        mobility: 'leg',
        side: 'axis',
        facts: retreatFacts(),
      }),
    ).toBeNull()
    expect(
      retreatPathTo({
        from,
        to,
        distance: 1,
        mobility: 'leg',
        side: 'axis',
        facts: retreatFacts({ prohibitedFor: () => true }),
      }),
    ).toBeNull()
  })

  it('规划出的路径交给 9.12 判定器复核：合法且满足完整撤退距离', () => {
    const plans = planRetreatDestinations({
      from,
      distance: 2,
      mobility: 'leg',
      side: 'axis',
      facts: retreatFacts(),
    })
    for (const plan of plans) {
      const result = resolveRetreat({
        unit: { id: 'u1', side: 'axis', hex: from, mobility: 'leg', dg: false },
        path: plan.path,
        facts: retreatFacts(),
      })
      expect(result).toMatchObject({
        destroyed: false,
        fullRetreatDistanceMet: true,
        hex: plan.hex,
      })
    }
  })
})

/**
 * 模式折算进战斗值（B1：5.10b-A / 5.7 / 5.8）
 *
 * 这三条此前**只在模式矩阵里算着、没人用**：`resolveModeStats` 的数值被丢弃，
 * 战斗路径直接读印值，于是 DG 单位按满值攻防、预备守方不减半、战略守方不为零。
 */
describe('5.10b-A / 5.7 / 5.8：模式折算进战斗值', () => {
  /** 印值 A10 / 战斗模式 / Open / 已付战斗补给 ⇒ 无修正时就是 10 */
  const base = { terrain: 'Open', combatSupplyPaid: true } as const

  const strengthOf = (over: Parameters<typeof unit>[0], role: 'attacker' | 'defender'): number =>
    unitBattleStrength({ ...base, unit: unit(over), role }).strength

  it('对照：战斗模式无标记 ⇒ 印值', () => {
    expect(strengthOf({}, 'attacker')).toBe(10)
    expect(strengthOf({}, 'defender')).toBe(10)
  })

  it('5.10b-A：DG 单位的战斗值减半（攻守两个角色都生效）', () => {
    expect(strengthOf({ dg: true }, 'attacker')).toBe(5)
    expect(strengthOf({ dg: true }, 'defender')).toBe(5)
  })

  it('5.7：预备**未释放**的守方防御减半，而攻方不受影响', () => {
    const reserve = { mode: 'reserve' } as const
    expect(strengthOf(reserve, 'defender')).toBe(5)
    // 攻方倍率不变（预备不得攻击由 9.1e 拦，本函数只负责数值）
    expect(strengthOf(reserve, 'attacker')).toBe(10)
  })

  it('5.7b：预备**已释放**的守方回到印值（标记已移除）', () => {
    expect(strengthOf({ mode: 'reserve', releasedFromReserve: true }, 'defender')).toBe(10)
  })

  it('5.8：战略模式的战斗值降为零', () => {
    expect(strengthOf({ mode: 'strat' }, 'attacker')).toBe(0)
    expect(strengthOf({ mode: 'strat' }, 'defender')).toBe(0)
  })

  it('模式倍率与 9.11d 多军力减半、9.5a 断补减半同为乘法，可叠加', () => {
    // DG(×½) × 9.11d 攻方有损失(×½) ⇒ 10 × ½ × ½ = 2.5
    expect(strengthOf({ dg: true, printedSteps: 2, steps: 1 }, 'attacker')).toBe(2.5)
    // DG(×½) × 断补(×½) ⇒ 守方 10 × ½ × ½ = 2.5
    expect(strengthOf({ dg: true, outOfSupply: true }, 'defender')).toBe(2.5)
  })

  it('攻方未付战斗补给仍按 9.5-A 直接不可攻击（先于模式折算）', () => {
    const outcome = unitBattleStrength({
      unit: unit({ dg: true }),
      role: 'attacker',
      terrain: 'Open',
      combatSupplyPaid: false,
    })
    expect(outcome).toMatchObject({ strength: 0, rule: '9.5-A', cannotAttack: true })
  })
})
