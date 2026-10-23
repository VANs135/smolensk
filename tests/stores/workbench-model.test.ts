import { describe, expect, it } from 'vitest'

import { chartsCrt, mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { createRngState } from '@/engine/rng'
import { checkLegality, bestCombatTerrainForDefender, inEnemyZocAt } from '@/engine/rules'
import { boardNeighbors } from '@/render/map-layout'
import {
  TURN_TRACK,
  availableMaOf,
  buildLegalityRequest,
  buildMoveContext,
  createRetreatFacts,
  defenseTerrainChoices,
  defaultDefenseTerrain,
  effectiveMobilityOf,
  faceFactorsOf,
  hedgehogLevelAt,
  hexsideTerrainNames,
  isCityHex,
  isCombatUnit,
  mobilityOf,
  needsFuelOf,
  reachableHexesOf,
  reOf,
  resolveBattle,
  stepUnit,
  targetHexFacts,
  toConsoleUnit,
  toMoveUnitView,
  turnDateOf,
  unitChoices,
  type UnitRecordView,
} from '@/stores/workbench-model'

/**
 * 骨架操作台（U0）纯逻辑测试
 *
 * 断言口径：操作台**自带零规则**——印值直接搬单位库、取费/合法性/战果全部问引擎。
 * 故这里既测「搬运是否正确」，也测「引擎结论是否真的被用上」（骰点、修正骰、拒绝原因）。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

/**
 * 夹具：把这一枚标为**已加注燃料**（12.5c）
 *
 * B18b 起 `toConsoleUnit` 的缺省是"未加注"（修前缺省 `fuelled: true`，那让 12.5a 永不发问）。
 * 本文件的用例考察的是 6.1/6.1a/4.5a-A/可达格这些判据，**不是**燃料支付，
 * 故在这里把燃料这一层**显式**摆好——要考察 12.5a 的用例（`12.5a：…不能消耗 MP`）自己写 `fuelled: false`。
 */
function fuelledFixture<T extends { fuelled: boolean }>(unit: T): T {
  unit.fuelled = true
  return unit
}

/** 一个最小的单位库记录（字段名照 data/schema/units.schema.ts） */
const RECORD: UnitRecordView = {
  id: 'test-armor-rgt',
  nameZh: '测试装甲团',
  side: 'axis',
  isCombat: true,
  attackCapable: true,
  classes: { combatClass: 'armor', movementClass: 'tracked' },
  reSize: 3,
  specialized: [],
  status: 'valued',
  factors: {
    combat: { attack: 10, ar: 4, ma: 5 },
    move: { attack: 4, ar: 4, ma: 10 },
  },
}

/** 找一个图内格（取产物格清单的首格，保证一定在图上） */
const HEX: HexRef = { col: mapLayers.hexes[0]!.col, row: mapLayers.hexes[0]!.row }

/* ────────────────────────────── 记录 → 算子 ────────────────────────────── */

describe('单位记录 → 操作台算子（只搬字段，不推演）', () => {
  it('3.1a 机动类型：数据层走 tracked，引擎口径是 track', () => {
    expect(mobilityOf(RECORD)).toBe('track')
    expect(mobilityOf({ id: 'x', classes: { movementClass: 'leg' } })).toBe('leg')
    expect(mobilityOf({ id: 'x', classes: { movementClass: 'truck' } })).toBe('truck')
    expect(mobilityOf({ id: 'x' })).toBe('leg')
  })

  it('3.1a 机动类型**逐面**：两面可以不同，逐面值优先于记录级', () => {
    const twoFaced: UnitRecordView = {
      id: 'x',
      classes: { movementClass: 'leg' },
      mobilityByFace: { combat: 'leg', move: 'truck' },
    }
    expect(mobilityOf(twoFaced, 'combat')).toBe('leg')
    expect(mobilityOf(twoFaced, 'move')).toBe('truck')
    // 缺省面＝战斗面（与 toConsoleUnit 的缺省朝向一致）
    expect(mobilityOf(twoFaced)).toBe('leg')
    // 逐面值缺一面 ⇒ **只那一面**回退记录级（不整条丢弃）
    const partial: UnitRecordView = {
      id: 'x',
      classes: { movementClass: 'tracked' },
      mobilityByFace: { move: 'leg' },
    }
    expect(mobilityOf(partial, 'combat')).toBe('track')
    expect(mobilityOf(partial, 'move')).toBe('leg')
    // 逐面无值 ⇒ 记录级
    expect(
      mobilityOf({ id: 'x', classes: { movementClass: 'truck' }, mobilityByFace: {} }, 'move'),
    ).toBe('truck')
  })

  it('3.1a：逐面机动类型随印值一起挂在 `faceFactorsOf` 的返回值上', () => {
    const record: UnitRecordView = {
      id: 'x',
      classes: { movementClass: 'leg' },
      mobilityByFace: { combat: 'leg', move: 'truck' },
      factors: { combat: { attack: 3, ar: 3, ma: 3 }, move: { attack: 1, ar: 3, ma: 6 } },
    }
    expect(faceFactorsOf(record, 'combat')).toMatchObject({ ma: 3, mobility: 'leg' })
    expect(faceFactorsOf(record, 'move')).toMatchObject({ ma: 6, mobility: 'truck' })
  })

  it('3.2 战斗单位判定：优先 isCombat，缺省按有无非战斗分类', () => {
    expect(isCombatUnit(RECORD)).toBe(true)
    expect(isCombatUnit({ id: 'x', isCombat: false, noncombatKind: null })).toBe(false)
    expect(isCombatUnit({ id: 'x', noncombatKind: 'sp' })).toBe(false)
    expect(isCombatUnit({ id: 'x' })).toBe(true)
  })

  it('4.6 团当量取 reSize，缺失按 0', () => {
    expect(reOf(RECORD)).toBe(3)
    expect(reOf({ id: 'x' })).toBe(0)
  })

  it('5.0 两个面的印值各自独立（战斗面 10-4-5 / 移动面 4-4-10）', () => {
    expect(faceFactorsOf(RECORD, 'combat')).toMatchObject({ attack: 10, ar: 4, ma: 5 })
    expect(faceFactorsOf(RECORD, 'move')).toMatchObject({ attack: 4, ar: 4, ma: 10 })
    // 炮兵面才有轰炸值与射程
    expect(
      faceFactorsOf({ id: 'x', factors: { combat: { barrage: 6, range: 3 } } }, 'combat'),
    ).toMatchObject({
      barrage: 6,
      range: 3,
    })
  })

  it('摆放：朝向决定印值；模式初值为「该面 + 战斗模式/移动模式」（5.5/5.6）', () => {
    const combatFace = toConsoleUnit({ record: RECORD, instanceId: 'i1', hex: HEX, side: 'axis' })
    expect(combatFace).toMatchObject({
      name: '测试装甲团',
      mobility: 'track',
      combatClass: 'armor',
      re: 3,
      attackCapable: true,
      mode: { mode: 'combat', orientation: 'combat', dg: false, exploit: false },
      raw: { attack: 10, ar: 4, ma: 5 },
      // B18b（12.5c）：**新上场的单位默认未加注燃料**（修前是 `fuelled: true` 的便利缺省，
      // 那让 12.5a 永不发问）；需要"已加注"的夹具请显式写 `unit.fuelled = true`
      fuelled: false,
      hasTraceSupply: true,
    })
    const moveFace = toConsoleUnit({
      record: RECORD,
      instanceId: 'i2',
      hex: HEX,
      side: 'axis',
      face: 'move',
    })
    expect(moveFace.raw).toMatchObject({ attack: 4, ma: 10 })
    expect(moveFace.mode.mode).toBe('move')
  })

  it('3.1a 逐面：`raw.mobility` 随朝向变，`effectiveMobilityOf` 是引擎唯一读点', () => {
    const record: UnitRecordView = {
      ...RECORD,
      classes: { combatClass: 'other', movementClass: 'leg' },
      mobilityByFace: { combat: 'leg', move: 'truck' },
    }
    const unit = toConsoleUnit({ record, instanceId: 'i9', hex: HEX, side: 'soviet' })
    // 初始朝向战斗面 ⇒ 战斗面的值
    expect(unit.mobility).toBe('leg')
    expect(unit.raw.mobility).toBe('leg')
    expect(unit.faces.move.mobility).toBe('truck')
    expect(effectiveMobilityOf(unit)).toBe('leg')
    // 5.4a：换朝向 ⇒ `raw` 整体换成那一面（机动类型随之）
    unit.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
    unit.raw = unit.faces[unit.mode.orientation]
    expect(effectiveMobilityOf(unit)).toBe('truck')
    // 12.5a 燃料与 4.5a-A 轮式必停都经视图取该值
    expect(needsFuelOf(unit)).toBe(true)
  })

  it('3.1a：旧存档（`raw` 里没有 `mobility`）退回 `unit.mobility`，不崩', () => {
    const unit = toConsoleUnit({ record: RECORD, instanceId: 'i10', hex: HEX, side: 'axis' })
    // 模拟旧存档：raw 只有 4 个数值字段
    unit.raw = { attack: 10, ar: 4, ma: 5 } as typeof unit.raw
    expect(effectiveMobilityOf(unit)).toBe(unit.mobility)
  })

  it('中立算子（side=both）按调用方指定的方上场', () => {
    const neutral = toConsoleUnit({
      record: { ...RECORD, side: 'both' },
      instanceId: 'i3',
      hex: HEX,
      side: 'soviet',
    })
    expect(neutral.side).toBe('soviet')
  })

  it('单位列表只列已落值/已核对的记录，且按方取库', () => {
    for (const record of unitChoices('axis')) {
      expect(['valued', 'verified']).toContain(record.status)
    }
    expect(unitChoices('soviet').length).toBeGreaterThan(0)
  })

  it('算子 → 引擎移动视图：模式与朝向逐字段对应（B7 契约）', () => {
    const unit = toConsoleUnit({ record: RECORD, instanceId: 'i1', hex: HEX, side: 'axis' })
    expect(toMoveUnitView(unit)).toMatchObject({
      id: 'i1',
      side: 'axis',
      isCombat: true,
      attackCapable: true,
      hasTraceSupply: true,
      mobility: 'track',
      ma: 5,
      re: 3,
      mode: 'combat',
      orientation: 'combat',
      dg: false,
      exploit: false,
      // B18b：缺省是"未加注"（12.5c）——移动视图**透传**它，不替规则做任何假设
      fuelled: false,
    })
  })
})

/* ────────────────────────────── 走一步 ────────────────────────────── */

describe('走一步（6.x）：结论一律来自引擎', () => {
  it('走一步：进入相邻图内格：给出正数 MP 消耗与规则编号', () => {
    const unit = fuelledFixture(
      toConsoleUnit({ record: RECORD, instanceId: 'i1', hex: HEX, side: 'axis' }),
    )
    const context = buildMoveContext({ units: [unit], activeSide: 'axis', phase: 'movement' })
    const target = boardNeighbors(HEX)[0]!
    const outcome = stepUnit(context, 'i1', target)
    if (outcome.ok) {
      expect(outcome.cost).toBeGreaterThan(0)
      expect(outcome.hexCost).toBeGreaterThanOrEqual(0)
      expect(outcome.mustEndMove === true || outcome.mustEndMove === false).toBe(true)
    } else {
      // 即便被拒绝，也必须带上规则编号（引擎的失败形状）
      expect(outcome.rule.length).toBeGreaterThan(0)
      expect(outcome.reason.length).toBeGreaterThan(0)
    }
  })

  it('不相邻/图外：按 6.1 或专规入口规则拒绝，且带原因码', () => {
    const unit = fuelledFixture(
      toConsoleUnit({ record: RECORD, instanceId: 'i1', hex: HEX, side: 'axis' }),
    )
    const context = buildMoveContext({ units: [unit], activeSide: 'axis', phase: 'movement' })
    const far = { col: HEX.col + 5, row: HEX.row + 3 }
    const outcome = stepUnit(context, 'i1', far)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(['notAdjacent', 'destinationOffMap']).toContain(outcome.reason)
  })

  it('12.5a：未加注燃料的履带战斗单位不能消耗 MP（操作台把 fuelled 关掉即可复现）', () => {
    const unit = {
      ...toConsoleUnit({ record: RECORD, instanceId: 'i1', hex: HEX, side: 'axis' }),
      fuelled: false,
    }
    const context = buildMoveContext({ units: [unit], activeSide: 'axis', phase: 'movement' })
    const outcome = stepUnit(context, 'i1', boardNeighbors(HEX)[0]!)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('needsFuel')
  })
})

/* ────────────────────────────── 前置校验（B21） ────────────────────────────── */

describe('动作前置校验：把摆子现状折成 B21 的请求', () => {
  it('敌方战斗单位占据目标格 ⇒ 4.8c 违规', () => {
    const attacker = toConsoleUnit({ record: RECORD, instanceId: 'a1', hex: HEX, side: 'axis' })
    const target = boardNeighbors(HEX)[0]!
    const defender = toConsoleUnit({
      record: { ...RECORD, id: 'test-soviet-rgt', side: 'soviet' },
      instanceId: 'd1',
      hex: target,
      side: 'soviet',
    })
    const units = [attacker, defender]
    const context = buildMoveContext({ units, activeSide: 'axis', phase: 'movement' })
    const verdict = checkLegality(
      buildLegalityRequest({
        action: 'move',
        unit: attacker,
        context,
        units,
        date: '1941-07-08',
        target,
        fuelPaid: true,
      }),
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.violations.some((violation) => violation.rule === '4.8c')).toBe(true)
    }
  })

  it('相邻的敌方战斗单位会把目标格标成敌方 ZOC（4.5 投射条件全部满足时）', () => {
    const mover = toConsoleUnit({ record: RECORD, instanceId: 'm1', hex: HEX, side: 'axis' })
    const enemyHex = boardNeighbors(HEX)[0]!
    const enemy = toConsoleUnit({
      record: { ...RECORD, id: 'enemy', side: 'soviet' },
      instanceId: 'e1',
      hex: enemyHex,
      side: 'soviet',
    })
    const units = [mover, enemy]
    const context = buildMoveContext({ units, activeSide: 'axis', phase: 'movement' })
    // 目标格取「与敌相邻、但不是敌所在格」——单位不把 ZOC 投射到自身格（4.5a）
    const target = HEX
    const request = buildLegalityRequest({
      action: 'move',
      unit: mover,
      context,
      units,
      date: '1941-07-08',
      target,
      fuelPaid: true,
    })
    expect(request.inEnemyZoc).toBe(true)
    // 敌所在格自身不受其 ZOC 覆盖
    expect(inEnemyZocAt(context, enemyHex, 'axis')).toBe(false)
    expect(request.phase).toBe('movement')
    expect(request.side).toBe('axis')
    expect(request.target?.hex).toEqual(target)
  })

  it('阶段可显式覆盖：F 战斗段的 attack 通过时机族（移动上下文的 phase 只能是 C/E/G）', () => {
    const attacker = toConsoleUnit({ record: RECORD, instanceId: 'a1', hex: HEX, side: 'axis' })
    const enemyHex = boardNeighbors(HEX)[0]!
    const defender = toConsoleUnit({
      record: { ...RECORD, id: 'def' },
      instanceId: 'd1',
      hex: enemyHex,
      side: 'soviet',
    })
    const units = [attacker, defender]
    const context = buildMoveContext({ units, activeSide: 'axis', phase: 'movement' })
    const request = (phase: 'movement' | 'combat'): ReturnType<typeof buildLegalityRequest> =>
      buildLegalityRequest({
        action: 'attack',
        unit: attacker,
        context,
        units,
        date: '1941-07-08',
        target: enemyHex,
        phase,
      })
    // F 段：attack 是许可动作（2.2）
    expect(request('combat').phase).toBe('combat')
    expect(checkLegality(request('combat')).ok).toBe(true)
    // C 段：attack 不在许可集合内（2.2）
    expect(checkLegality(request('movement')).ok).toBe(false)
  })
})

/* ────────────────────────────── 打一仗 ────────────────────────────── */

describe('打一仗（9.3b/9.4d/9.9）：骰点走引擎 RNG，可复算', () => {
  const defenderHex: HexRef = { col: mapLayers.hexes[3]!.col, row: mapLayers.hexes[3]!.row }
  const attacker = toConsoleUnit({
    record: RECORD,
    instanceId: 'a1',
    hex: defenderHex,
    side: 'axis',
  })
  const defender = toConsoleUnit({
    record: { ...RECORD, id: 'def', side: 'soviet' },
    instanceId: 'd1',
    hex: defenderHex,
    side: 'soviet',
  })

  it('守方格有可选地形，默认地形取自该格候选集（9.3b）', () => {
    const choices = defenseTerrainChoices(defenderHex)
    expect(choices.length).toBeGreaterThan(0)
    expect(choices).toContain(defaultDefenseTerrain(defenderHex))
  })

  it('骰点＝两枚 d6、修正骰＝2d6＋攻方 AR − 守方 AR − 工事等级（9.9）', () => {
    const terrain = defaultDefenseTerrain(defenderHex)
    const outcome = resolveBattle({
      rng: createRngState(1),
      attackers: [attacker],
      defenders: [defender],
      chosenTerrain: terrain,
      hedgehogLevel: 1,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const { report } = outcome
    expect(report.dice.faces).toHaveLength(2)
    for (const face of report.dice.faces) {
      expect(face).toBeGreaterThanOrEqual(1)
      expect(face).toBeLessThanOrEqual(6)
    }
    expect(report.dice.total).toBe(report.dice.faces[0]! + report.dice.faces[1]!)
    expect(report.rule.modifiedDice).toBe(
      report.dice.total + report.attackerAR - report.defenderAR - report.hedgehogLevel,
    )
    expect(report.rule.raw.length).toBeGreaterThan(0)
  })

  it('9.4d：攻方军力按地形倍率修正（装甲 vs 开阔地 1 倍）', () => {
    const terrain = defaultDefenseTerrain(defenderHex)
    const outcome = resolveBattle({
      rng: createRngState(7),
      attackers: [attacker],
      defenders: [defender],
      chosenTerrain: terrain,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // 记录里只有攻方一个单位，故军力＝印值 × 该地形对 armor 的倍率
    expect(outcome.report.attackerStrength).toBeCloseTo(
      attacker.raw.attack * outcome.report.multipliers[0]!,
      6,
    )
    expect(outcome.report.defenderStrength).toBe(defender.raw.attack)
  })

  it('B2 可复算：同种子同输入 ⇒ 同骰点与同战果', () => {
    const terrain = defaultDefenseTerrain(defenderHex)
    const input = {
      attackers: [attacker],
      defenders: [defender],
      chosenTerrain: terrain,
    }
    const first = resolveBattle({ rng: createRngState(20260913), ...input })
    const second = resolveBattle({ rng: createRngState(20260913), ...input })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.report.dice).toEqual(first.report.dice)
    expect(second.report.rule.raw).toBe(first.report.rule.raw)
    expect(second.rng).toEqual(first.rng)
  })

  it('非法输入：攻守缺一或地形不可选时报错而不静默出结果', () => {
    expect(
      resolveBattle({
        rng: createRngState(1),
        attackers: [],
        defenders: [defender],
        chosenTerrain: 'Open',
      }),
    ).toMatchObject({ ok: false })
    expect(
      resolveBattle({
        rng: createRngState(1),
        attackers: [attacker],
        defenders: [defender],
        chosenTerrain: '不存在的天气',
      }),
    ).toMatchObject({ ok: false })
  })

  it('9.14a：战斗值为零仍可参战（4.4）——守方为 0 ⇒ 最右列、攻方为 0 ⇒ 最左列', () => {
    // 攻方 0 军力：9.14a 从**最左列**开始（Open 行的最左列是 `1:5`）
    const zeroAttacker = toConsoleUnit({
      record: { id: 'zero', side: 'axis', factors: { combat: { attack: 0, ar: 0, ma: 5 } } },
      instanceId: 'z1',
      hex: defenderHex,
      side: 'axis',
    })
    const attackerZero = resolveBattle({
      rng: createRngState(1),
      attackers: [zeroAttacker],
      defenders: [defender],
      chosenTerrain: defaultDefenseTerrain(defenderHex),
    })
    expect(attackerZero.ok).toBe(true)
    if (attackerZero.ok) {
      const columns = chartsCrt.crt.terrainColumns[attackerZero.report.terrainLine]!
      expect(attackerZero.report.rule.ratio).toBe(columns[0])
    }

    // 守方 0 军力：9.14a 从**最右列**开始（Open 行的最右列是 `13:1`）
    const zeroDefender = toConsoleUnit({
      record: { id: 'zero-d', side: 'soviet', factors: { combat: { attack: 0, ar: 0, ma: 0 } } },
      instanceId: 'z2',
      hex: defenderHex,
      side: 'soviet',
    })
    const defenderZero = resolveBattle({
      rng: createRngState(1),
      attackers: [attacker],
      defenders: [zeroDefender],
      chosenTerrain: defaultDefenseTerrain(defenderHex),
    })
    expect(defenderZero.ok).toBe(true)
    if (defenderZero.ok) {
      const columns = chartsCrt.crt.terrainColumns[defenderZero.report.terrainLine]!
      expect(defenderZero.report.rule.ratio).toBe(columns[columns.length - 1])
    }
  })

  it('9.6：行动值按调用方指定，未指定才退回「取最高」', () => {
    const terrain = defaultDefenseTerrain(defenderHex)
    const specified = resolveBattle({
      rng: createRngState(5),
      attackers: [attacker],
      defenders: [defender],
      chosenTerrain: terrain,
      attackerAr: 1,
      defenderAr: 6,
    })
    expect(specified.ok).toBe(true)
    if (specified.ok) {
      expect(specified.report.attackerAR).toBe(1)
      expect(specified.report.defenderAR).toBe(6)
    }
  })

  it('16.0/9.9：环形工事等级取守方格的工事（一格至多 1 个）', () => {
    const hedgehog = toConsoleUnit({
      record: {
        id: 'hh',
        isCombat: false,
        attackCapable: false,
        noncombatKind: 'hedgehog',
        noncombatDetails: { level: 2 },
      },
      instanceId: 'h1',
      hex: defenderHex,
      side: 'soviet',
    })
    expect(hedgehog.noncombatLevel).toBe(2)
    expect(hedgehogLevelAt([hedgehog], defenderHex)).toBe(2)
    expect(hedgehogLevelAt([hedgehog], HEX)).toBe(0)
  })
})

/* ────────────────────────────── 阶段额度（6.1a/6.1b） ────────────────────────────── */

describe('阶段额度：MA 是一阶段的总额度，不是单步额度（6.1a/6.1b）', () => {
  it('新摆放的算子额度为 0 且未结束移动；可用 MA 来自引擎', () => {
    const unit = toConsoleUnit({ record: RECORD, instanceId: 'i1', hex: HEX, side: 'axis' })
    expect(unit.mpSpent).toBe(0)
    expect(unit.movementEnded).toBe(false)
    expect(availableMaOf(unit, 'movement')).toBe(RECORD.factors!.combat!.ma)
  })

  it('已耗 MP 计入后，走一步因超出剩余额度被拒（notEnoughMp）', () => {
    // 取一个连通性明确的格（36.13，位于图内腹地）
    const moveHex: HexRef = { col: 36, row: 13 }
    const unit = fuelledFixture(
      toConsoleUnit({ record: RECORD, instanceId: 'i1', hex: moveHex, side: 'axis' }),
    )
    const context = buildMoveContext({ units: [unit], activeSide: 'axis', phase: 'movement' })
    const target = boardNeighbors(moveHex).find(
      (hex) => stepUnit(context, 'i1', hex, { mpSpent: 0 }).ok,
    )
    expect(target).toBeDefined()
    if (target === undefined) return
    // 额度耗尽后，同一格不再可走（6.1a/6.1b：MA 是阶段总额度）
    const spent = stepUnit(context, 'i1', target, { mpSpent: 999 })
    expect(spent.ok).toBe(false)
    if (!spent.ok) expect(spent.reason).toBe('notEnoughMp')
  })
})

/* ────────────────────────────── 回合轨（2.2） ────────────────────────────── */

describe('回合轨：日期取自工程数据 turnTrack（半周轨，不可按固定天数推算）', () => {
  it('轨长与已知锚点（回合 1/2/4/8/17/19）', () => {
    expect(TURN_TRACK.length).toBe(19)
    expect(turnDateOf(1)).toBe('1941-07-08')
    // 若按「每回合 +2 天」会算成 1941-07-10，实为 07-12
    expect(turnDateOf(2)).toBe('1941-07-12')
    // 专规 1.2 铁路容量提升日（专规 1.2）
    expect(turnDateOf(4)).toBe('1941-07-19')
    // 专规 2.3e 苏军可进入战略模式的起点＝**8 月 1 日回合本身**（月内日号取轮盘 sectors）
    expect(turnDateOf(8)).toBe('1941-08-01')
    expect(turnDateOf(17)).toBe('1941-09-01')
    expect(turnDateOf(19)).toBe('1941-09-08')
  })

  it('越界收敛到轨内首/末回合', () => {
    expect(turnDateOf(0)).toBe('1941-07-08')
    expect(turnDateOf(99)).toBe('1941-09-08')
  })
})

/* ────────────────────────────── 可到达格（B7 UI 接口） ────────────────────────────── */

describe('可到达格（B7）：结论全部来自引擎，且按剩余额度收敛（6.1a）', () => {
  const moveHex: HexRef = { col: 36, row: 13 }
  const unit = fuelledFixture(
    toConsoleUnit({ record: RECORD, instanceId: 'i1', hex: moveHex, side: 'axis' }),
  )
  const context = buildMoveContext({ units: [unit], activeSide: 'axis', phase: 'movement' })

  it('可动单位：集合非空、每格累计 MP 为正、且不含起点格', () => {
    const reachable = reachableHexesOf(context, unit)
    expect(reachable.length).toBeGreaterThan(0)
    for (const node of reachable) {
      expect(node.mpSpent).toBeGreaterThan(0)
      expect(node.hex).not.toEqual(moveHex)
    }
  })

  it('未选中 / 本轮移动已结束（4.5a-A、6.1c）：空集', () => {
    expect(reachableHexesOf(context, null)).toHaveLength(0)
    expect(reachableHexesOf(context, { ...unit, movementEnded: true })).toHaveLength(0)
  })

  it('剩余额度为 0 时为空集；剩余额度减小时集合收敛（不是「相邻六格」）', () => {
    expect(reachableHexesOf(context, { ...unit, mpSpent: unit.raw.ma })).toHaveLength(0)
    const full = reachableHexesOf(context, unit)
    const half = reachableHexesOf(context, { ...unit, mpSpent: Math.ceil(unit.raw.ma / 2) })
    const remaining = unit.raw.ma - Math.ceil(unit.raw.ma / 2)
    expect(half.length).toBeLessThan(full.length)
    for (const node of half) expect(node.mpSpent).toBeLessThanOrEqual(remaining)
  })
})

/* ────────────────────────────── 4.8 堆叠事实：本作无港口 ────────────────────────────── */

describe('4.8 堆叠事实：本作无港口，非战斗单位不得算作 ports', () => {
  const hex: HexRef = { col: 36, row: 13 }

  it('补给点（sp）不计入 ports；空军基地与环形工事照常计入', () => {
    const sp = toConsoleUnit({
      record: { id: 'sp', isCombat: false, noncombatKind: 'sp' },
      instanceId: 's1',
      hex,
      side: 'axis',
    })
    expect(targetHexFacts([sp], hex, 'axis').ports).toBe(0)
    const airBase = toConsoleUnit({
      record: { id: 'ab', isCombat: false, noncombatKind: 'air_base' },
      instanceId: 'a1',
      hex,
      side: 'axis',
    })
    expect(targetHexFacts([airBase], hex, 'axis').airBases).toBe(1)
    const hedgehog = toConsoleUnit({
      record: { id: 'hh', isCombat: false, noncombatKind: 'hedgehog' },
      instanceId: 'h1',
      hex,
      side: 'axis',
    })
    expect(targetHexFacts([hedgehog], hex, 'axis').hedgehogs).toBe(1)
  })
})

describe('防御地形默认值走战斗口径（9.3b），不是移动取费口径（6.2d）', () => {
  const probes: HexRef[] = [HEX, { col: mapLayers.hexes[5]!.col, row: mapLayers.hexes[5]!.row }]

  it('默认值必须是候选集之一，且等于引擎的「对防御方最有利」', () => {
    for (const hex of probes) {
      const choices = defenseTerrainChoices(hex)
      const fallback = defaultDefenseTerrain(hex)
      expect(choices).toContain(fallback)
      const present =
        mapLayers.hexes.find((item) => item.col === hex.col && item.row === hex.row)
          ?.terrainsPresent ?? []
      const best = bestCombatTerrainForDefender({
        terrainsPresent: present,
        cityHex: isCityHex(hex),
      })
      // 引擎口径一致（best 为 null 时退化为候选首项）
      expect(fallback).toBe(best ?? choices[0])
    }
  })
})

describe('9.4b 格边地形选项：只列河/湖（铁路·小路·大路不产生战斗修正）', () => {
  it('全图所有格边：返回的格边地形名里绝不出现铁路/小路/大路', () => {
    const forbidden = new Set(['Railroad', 'Track', 'Secondary Road'])
    const bad: string[] = []
    for (const edge of mapLayers.edges) {
      for (const name of hexsideTerrainNames(edge.a, edge.b)) {
        if (forbidden.has(name))
          bad.push(`${edge.a.col}.${edge.a.row}|${edge.b.col}.${edge.b.row}:${name}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('有河有路的格边：只剩河；只有路的格边：空数组', () => {
    let riverWithRoad: { from: HexRef; to: HexRef } | null = null
    let roadOnly: { from: HexRef; to: HexRef } | null = null
    for (const edge of mapLayers.edges) {
      const hasRiver = edge.river !== undefined
      const hasRoute = edge.road !== undefined || edge.rail === true
      if (hasRiver && hasRoute && riverWithRoad === null)
        riverWithRoad = { from: edge.a, to: edge.b }
      if (!hasRiver && hasRoute && roadOnly === null) roadOnly = { from: edge.a, to: edge.b }
    }
    // 地图上确实存在两类格边（否则本用例没有意义）
    expect(riverWithRoad).not.toBeNull()
    expect(roadOnly).not.toBeNull()

    const riverNames = hexsideTerrainNames(riverWithRoad!.from, riverWithRoad!.to)
    expect(riverNames).toHaveLength(1)
    expect(riverNames[0]).toContain('River')
    expect(hexsideTerrainNames(roadOnly!.from, roadOnly!.to)).toEqual([])
  })
})

/* ────────────── 9.12e / 9.12f：撤退事实（ZOC 不可抵消 + 战斗开始时快照） ────────────── */

describe('9.12e / 9.12f：撤退事实的两条硬口径', () => {
  /** 与 HEX 相邻的图内格（撤退穿越/ ZOC 判定用） */
  const NEIGHBOR: HexRef = boardNeighbors(HEX)[0]!

  const combatUnit = (
    instanceId: string,
    hex: HexRef,
    side: 'axis' | 'soviet',
  ): ReturnType<typeof toConsoleUnit> => toConsoleUnit({ record: RECORD, instanceId, hex, side })

  it('9.12e：撤退 ZOC **不计 4.5b 抵消**（与普通移动判据不同）', () => {
    // 邻格有敌方战斗单位 ⇒ HEX 处于敌 ZOC；HEX 内有一个已承诺不耗 MP 的己方战斗单位（4.5b 抵消者）
    const enemyUnit = combatUnit('e1', NEIGHBOR, 'soviet')
    const friend = combatUnit('f1', HEX, 'axis')
    friend.mpLockedThisPhase = true
    const units = [enemyUnit, friend]
    const context = buildMoveContext({ units, activeSide: 'axis', phase: 'movement' })

    // 普通移动：4.5b 抵消生效 ⇒ 不算敌方 ZOC
    expect(inEnemyZocAt(context, HEX, 'axis')).toBe(false)
    // 9.12e：撤退判据不接受抵消（原文：「此 ZOC 效果无法被友方战斗单位『抵消』」）
    const facts = createRetreatFacts({ units, context, retreatingUnitIds: [] })
    expect(facts.inEnemyZocAt(HEX, 'axis')).toBe(true)
  })

  it('9.12f：以「战斗开始时」的快照判定敌方战斗单位所在格（攻方被打空后腾出的格仍然挡路）', () => {
    const context = buildMoveContext({ units: [], activeSide: 'axis', phase: 'movement' })
    // 盘面上已经空了，但战斗开始时该格有敌方战斗单位
    const withSnapshot = createRetreatFacts({
      units: [],
      context,
      retreatingUnitIds: [],
      combatStartSnapshot: [{ hex: NEIGHBOR, side: 'soviet', isCombat: true }],
    })
    expect(withSnapshot.enemyCombatUnitAt(NEIGHBOR, 'axis')).toBe(true)
    // 只算**敌方**：同一快照对苏方而言不是敌方战斗单位
    expect(withSnapshot.enemyCombatUnitAt(NEIGHBOR, 'soviet')).toBe(false)
    // 非战斗单位不挡路（9.12f 只禁「敌方战斗单位」）
    const nonCombat = createRetreatFacts({
      units: [],
      context,
      retreatingUnitIds: [],
      combatStartSnapshot: [{ hex: NEIGHBOR, side: 'soviet', isCombat: false }],
    })
    expect(nonCombat.enemyCombatUnitAt(NEIGHBOR, 'axis')).toBe(false)
    // 未给快照 ⇒ 退回当前盘面（无敌人 ⇒ 不挡）
    const live = createRetreatFacts({ units: [], context, retreatingUnitIds: [] })
    expect(live.enemyCombatUnitAt(NEIGHBOR, 'axis')).toBe(false)
  })
})
