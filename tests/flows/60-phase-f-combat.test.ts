import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  ACTIONS_BY_PHASE,
  AIR_BASE_CAPTURE_DRM,
  BATTLE_SEQUENCE,
  COMBAT_STEP_IDS,
  checkTiming,
  createMapFacts,
  exploitEligibility,
  selectMovementTerrain,
  tokensText,
  transportGroupOf,
} from '@/engine/rules'
import { combatRecord, groundRecord, label, newConsole, placeGround } from './sop-harness'
import { actionGateOf, type ActionKey, type ConsolePhase } from '@/stores'

/**
 * 环节 Ⓕ：**战斗**（F 段）——OCS 9.0 章：9.0 / 9.1 / 9.2 / 9.5–9.13 / 9.14 / 10.1a
 *
 * F 段只有两件事：**炮兵轰炸**（10.1a：F 段只允许炮兵来源）与**常规战斗**（9.2 九步）。
 * 本文件先固定段闸与九步顺序，再走一遍完整的九步流程，并核对 9.13 的进击标记与 9.14 的特殊战斗判据。
 * 单独运行：`npx vitest run tests/flows/60-phase-f-combat.test.ts`
 */

const mapFacts = createMapFacts()

function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  return selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  }).ok
}

/** 防御格：六邻皆图内且有格内战斗地形（便于构造 9.4b 与撤退） */
const DEFENDER_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

/** 攻击格：防御格的图内邻格，且步兵可进入（9.1f） */
const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    if (canEnter('leg', candidate, DEFENDER_HEX)) return candidate
  }
  throw new Error('防御格没有「步兵可进入」的图内邻格')
})()

/** 从 `from` 向某方向直线走 `count` 格（9.12：完整撤退距离） */
function straightPath(from: HexRef, count: number): HexRef[] {
  for (const direction of HEX_DIRECTIONS) {
    const path: HexRef[] = []
    let current = from
    let valid = true
    for (let index = 0; index < count; index += 1) {
      const next = neighbor(current, direction)
      if (
        !isOnMap(next) ||
        !mapLayers.hexes.some((h) => h.col === next.col && h.row === next.row)
      ) {
        valid = false
        break
      }
      path.push(next)
      current = next
    }
    if (valid && hexDistance(from, current) === count) return path
  }
  throw new Error(`找不到 ${count} 格的直线撤退路径`)
}

type Store = ReturnType<typeof newConsole>

const attackerRecord = () =>
  groundRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )

const defenderRecord = () =>
  groundRecord('soviet', (record) => record.isCombat === true && record.attackCapable === true)

/** 摆好攻守并选定防御格（9.1） */
function setupBattle(store: Store, phase: 'combat' | 'exploitation' = 'combat') {
  store.setPhase(phase)
  // B8：F/G 段首环是炮击 ⇒ 宣告战斗前先进该段的**战斗环节**
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.setFuelPool(0, 20)
  const attacker = placeGround(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  const defender = placeGround(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  store.clickHex(ATTACKER_HEX)
  store.clickHex(DEFENDER_HEX)
  return { attacker, defender }
}

/**
 * 12.4 / 12.6：为双方各放一座足量补给站并声明为战斗补给来源
 *
 * 战斗补给只能从**己方补给站**经 12.3a 直接拖取 / 12.3b HQ 投递扣除
 * （除专规补给储备标记 1.7 / 21.10 外不存在凭空可用的池子），故夹具必须真摆出补给站。
 * ★ 须在 `beginCombatNow()` 之后调用（来源候选按当前战斗的攻守方分派）。
 */
function declareSupplyForBoth(store: Store): void {
  if (!store.spDumps.some((dump) => dump.id === 'sd-axis'))
    store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  if (!store.spDumps.some((dump) => dump.id === 'sd-soviet'))
    store.spDumps.push({ id: 'sd-soviet', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

/** 9.10：优先用军力损失满足选项；军力不够时才用撤退 */
function driveOptions(store: Store, side: 'attacker' | 'defender') {
  const requirement = store.combatRequirement
  if (requirement === null) throw new Error('此刻不该没有损失/选项需求')
  const units = side === 'attacker' ? store.combatAttackers : store.battleDefenders
  const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
  if (requirement.options <= capacity) {
    store.combatInputs.optionRetreatHexes = 0
    store.combatInputs.optionLossPoints = requirement.options
  } else {
    store.combatInputs.optionRetreatHexes = requirement.options
    store.combatInputs.optionLossPoints = 0
  }
  expect(store.confirmCombatOptions()).toBe(true)
}

/**
 * B8：把 store 放到**本段里允许做该动作的那个环节**
 *
 * 段内动作只在对应环节放行（用户口径：「每个环节只能执行该环节能进行的操作」）。
 * 用 B7 的闸门表反查环节，而不是写死序号或环节名。
 */
function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

describe('Ⓕ F 段许可动作与段闸（2.2 / 9.0 / 10.1a）', () => {
  it('2.2：F 段只有轰炸与攻击（没有移动/整备/铁路）', () => {
    expect([...ACTIONS_BY_PHASE.combat]).toEqual(['barrage', 'attack', 'breakdown'])
    for (const action of ['move', 'railTransport', 'engineer', 'refit'] as const) {
      const violations = checkTiming({
        action,
        side: 'axis',
        activeSide: 'axis',
        phase: 'combat',
        date: '1941-07-12',
      })
      expect(violations.map((item) => item.reason)).toContain('actionNotInSegment')
    }
  })

  it('10.1a：F 段只允许**炮兵**轰炸（空中/舰炮在 F 段非法）', () => {
    const artillery = checkTiming({
      action: 'barrage',
      barrageSource: 'artillery',
      side: 'axis',
      activeSide: 'axis',
      phase: 'combat',
      date: '1941-07-12',
    })
    expect(artillery).toEqual([])
    for (const source of ['air', 'ship'] as const) {
      const violations = checkTiming({
        action: 'barrage',
        barrageSource: source,
        side: 'axis',
        activeSide: 'axis',
        phase: 'combat',
        date: '1941-07-12',
      })
      expect(violations.map((item) => item.reason)).toContain('barrageSourceNotAllowedInSegment')
    }
  })

  it('9.0：非战斗段不能发起常规战斗（C 移动段被拒）；F 与 G 段可（G 段也有战斗环节）', () => {
    const store: Store = newConsole()
    setupBattle(store, 'combat')

    // 退回移动段 ⇒ 9.0 拦下
    store.setPhase('movement')
    store.setTool('battle')
    store.clickHex(ATTACKER_HEX)
    store.clickHex(DEFENDER_HEX)
    expect(store.beginCombatNow()).toBe(false)
    // ★ B8：段/环节不对由**统一闸门**拦下（引擎的 9.0 判断不再被走到）
    expect(store.actionRefusal).toMatchObject({ key: 'combat.declare', rule: '9.2' })

    // F 段 ⇒ 通过
    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    store.clickHex(ATTACKER_HEX)
    store.clickHex(DEFENDER_HEX)
    expect(store.beginCombatNow()).toBe(true)
    store.cancelCombat()

    // G 段 ⇒ 也通过（2.2：G 段有战斗环节）
    store.setPhase('exploitation')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    store.clickHex(ATTACKER_HEX)
    store.clickHex(DEFENDER_HEX)
    expect(store.beginCombatNow()).toBe(true)
  })

  it('9.2：九步顺序与引擎清单一字不差（COMBAT_STEP_IDS ≡ BATTLE_SEQUENCE）', () => {
    expect([...COMBAT_STEP_IDS]).toEqual(BATTLE_SEQUENCE.map((item) => item.step))
    expect([...COMBAT_STEP_IDS]).toEqual([
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

describe('Ⓕ 9.2 九步流程端到端（9.1 → 9.12g）', () => {
  it('顺序推进：构成 → 补给 → AR → 地形 → 奇袭 → 掷骰 → 损失 → 选项 → 撤退 → 推进', () => {
    const store: Store = newConsole()
    setupBattle(store, 'combat')

    expect(store.beginCombatNow()).toBe(true)
    // 9.1 构成已在发起时完成，待办落在第 2 步（战斗补给）
    expect(store.combatState!.step).toBe('combatSupply')
    expect(store.combatState!.composition.attackerIds).toEqual(['a1'])

    // 12.4：声明双方的补给站来源（战斗补给只能从己方补给站扣）
    declareSupplyForBoth(store)

    // 9.5：双方战斗补给（守方可拒付 ⇒ 半值防御）
    expect(store.confirmCombatSupply()).toBe(true)
    expect(store.combatState!.step).toBe('declareAr')

    // 9.6：攻方先宣布 AR，守方后宣布
    store.combatInputs.attackerArUnitId = 'a1'
    expect(store.declareCombatArStep('attacker')).toBe(true)
    store.combatInputs.defenderArUnitId = store.battleDefenders[0]!.instanceId
    expect(store.declareCombatArStep('defender')).toBe(true)
    expect(store.combatState!.step).toBe('declareTerrain')

    // 9.4b/c：宣布地形与初始攻防比
    expect(store.declareCombatTerrainStep()).toBe(true)
    expect(store.combatState!.step).toBe('surprise')

    // 9.8：奇袭（发生奇袭须再掷横移骰）
    expect(store.rollCombatSurprise()).toBe(true)
    if (store.combatAwaitingShiftDie) expect(store.rollCombatShiftDie()).toBe(true)
    expect(store.combatState!.step).toBe('battleDice')

    // 9.9：掷战斗骰
    expect(store.rollCombatDice()).toBe(true)
    expect(store.combatState!.step).toBe('losses')
    expect(store.combatSummary).not.toBeNull()

    // 9.10b：攻方先结算（强制损失 → 选项），守方后
    expect(store.combatState!.resolution.stage).toBe('attackerLosses')
    expect(store.confirmCombatLosses()).toBe(true)
    expect(store.combatState!.resolution.stage).toBe('attackerOptions')
    driveOptions(store, 'attacker')
    expect(store.combatState!.resolution.stage).toBe('defenderLosses')
    expect(store.confirmCombatLosses()).toBe(true)
    expect(store.combatState!.resolution.stage).toBe('defenderOptions')
    driveOptions(store, 'defender')
    expect(store.combatState!.step).toBe('retreat')

    // 9.12：撤退（按需求给直线路径）
    const requirement = store.combatRetreatRequirement
    const paths: Record<string, string> = {}
    if (requirement.attacker > 0)
      for (const unit of store.combatAttackers)
        paths[unit.instanceId] = straightPath(unit.hex, requirement.attacker)
          .map((hex) => label(hex))
          .join(',')
    if (requirement.defender > 0)
      for (const unit of store.battleDefenders)
        paths[unit.instanceId] = straightPath(unit.hex, requirement.defender)
          .map((hex) => label(hex))
          .join(',')
    store.combatInputs.retreatPaths = paths
    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatState!.step).toBe('advance')

    // 9.12g：战后推进（本测试不推进）
    store.combatInputs.advanceUnitIds = []
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState!.finished).toBe(true)
  })

  it('9.2：步骤未到就调用后一步即被拒（顺序不可颠倒）', () => {
    const store: Store = newConsole()
    setupBattle(store, 'combat')
    expect(store.beginCombatNow()).toBe(true)
    store.combatInputs.attackerArUnitId = 'a1'
    expect(store.declareCombatArStep('attacker')).toBe(false)
    expect(store.rollCombatDice()).toBe(false)
    expect(store.confirmCombatLosses()).toBe(false)
  })

  it('9.5：攻方付不出全额战斗补给 ⇒ 取消攻击（12.4）', () => {
    const store: Store = newConsole()
    setupBattle(store, 'combat')
    expect(store.beginCombatNow()).toBe(true)
    store.combatInputs.attackerAvailableT = 0
    expect(store.confirmCombatSupply()).toBe(false)
    expect(store.combatError).toMatchObject({ rule: '12.4' })
    expect(store.combatState!.step).toBe('combatSupply')
  })
})

describe('Ⓕ 9.13 / 9.14：进击标记与特殊战斗判据', () => {
  it('9.13b-B：`e#` 只对**战斗阶段**发起的攻击生效（进击阶段的攻击不给进击标记）', () => {
    const base = {
      eThreshold: 3,
      // 9.13 逐单位：参战单位各自的 AR / DG
      attackers: [{ unitId: 'a1', ar: 4, dg: false }],
      attackerRetreatedInOptions: false,
      attackerAllOptionsAsLosses: true,
      attackType: 'regular' as const,
      attackerHexes: [ATTACKER_HEX],
    }
    const inCombat = exploitEligibility({ ...base, phase: 'combat' })
    expect(inCombat.ok).toBe(true)
    if (inCombat.ok) expect(inCombat.data).toMatchObject({ granted: true })

    const inExploitation = exploitEligibility({ ...base, phase: 'exploitation' })
    expect(inExploitation.ok).toBe(true)
    if (inExploitation.ok)
      expect(inExploitation.data).toMatchObject({
        granted: false,
        reason: 'exploitOnlyInCombatPhase',
      })

    // 9.13b-A：攻击单位 DG 不给标记；9.10d：选项全选损失才给
    const dg = exploitEligibility({
      ...base,
      phase: 'combat',
      attackers: [{ unitId: 'a1', ar: 4, dg: true }],
    })
    if (dg.ok) expect(dg.data.reason).toBe('attackerDg')
    const mixed = exploitEligibility({
      ...base,
      phase: 'combat',
      attackerAllOptionsAsLosses: false,
    })
    if (mixed.ok) expect(mixed.data.reason).toBe('optionsNotAllLosses')
  })

  it('9.13b-C：三个以上攻击格、或两个攻击格不相邻 ⇒ 永不产生进击结果', () => {
    const base = {
      eThreshold: 3,
      attackers: [{ unitId: 'a1', ar: 4, dg: false }],
      attackerRetreatedInOptions: false,
      attackerAllOptionsAsLosses: true,
      attackType: 'regular' as const,
      phase: 'combat' as const,
    }
    const three = exploitEligibility({
      ...base,
      attackerHexes: [ATTACKER_HEX, DEFENDER_HEX, straightPath(DEFENDER_HEX, 3)[2]!],
    })
    if (three.ok) expect(three.data.reason).toBe('moreThanTwoStacks')

    const far = straightPath(DEFENDER_HEX, 3)[2]!
    const notAdjacent = exploitEligibility({ ...base, attackerHexes: [ATTACKER_HEX, far] })
    if (notAdjacent.ok) expect(notAdjacent.data.reason).toBe('twoStacksNotAdjacent')
  })

  it('9.14a：运输点夺取按**印值 MA** 分组（MA > 10 为卡车、否则为马车）；表 17-6 基地夺取 +2 DRM', () => {
    expect(transportGroupOf(11)).toBe('trucks')
    expect(transportGroupOf(12)).toBe('trucks')
    expect(transportGroupOf(10)).toBe('wagons')
    expect(transportGroupOf(3)).toBe('wagons')
    // 表 17-6：该机为激活 +2、由战后推进夺取 +2（常数唯一来源 rules-constants.combat.airBaseCaptureDrm）
    expect(AIR_BASE_CAPTURE_DRM).toMatchObject({ active: 2, byAdvanceAfterCombat: 2 })
    // 运输点数文本按 12.1a 换算（1 SP = 4 T）
    expect(tokensText(4)).toBe('1 SP')
    expect(tokensText(6)).toBe('1 SP + 2 T')
  })

  it('9.14c：可攻击单位进入含敌方补给站/运输点的格 ⇒ 该格物体按 9.14 处置（实体判据可用）', () => {
    // 用真实单位库确认「可攻击单位」判据存在（9.14 的统一前提）
    const attacker = groundRecord('axis', (record) => record.attackCapable === true)
    expect(attacker.attackCapable).toBe(true)
    // 战斗单位不能混淆为运输点（单位库的 noncombatKind 分类）
    expect(combatRecord('axis').noncombatKind ?? null).toBeNull()
  })
})

describe('Ⓕ 9.12f：撤退穿越敌方非战斗单位 ⇒ 按 9.14 处置（批 F·E1）', () => {
  /**
   * 规则原文（通规 9.12f，第二段）
   * 「撤退穿越**非战斗单位、飞机和舰船**时，同**移动时**穿越它们那样进行处理（根据 9.14）。」
   *
   * ⇒ 移动时是**逐格**触发 9.14（`triggerSpecialCombatAfterStep` 每走一格问一次），
   *   故撤退也沿撤退路径逐格触发；处置对象与判据完全复用移动那份，不另造流程。
   * 第一段（不可穿越「战斗开始时」含敌方战斗单位的格）早已由 `combatStartSnapshot` 落地。
   */

  /** 强攻方（高攻防比 ⇒ CRT 给攻方选项，从而能用「撤退」满足 9.10a） */
  const strongAttackerRecord = () =>
    groundRecord(
      'axis',
      (record) =>
        record.isCombat === true &&
        record.attackCapable === true &&
        (record.factors?.combat?.attack ?? 0) >= 8,
    )

  /**
   * 弱守方（1 步；被强制损失消灭 ⇒ 守方选项按 9.10c 可忽略）
   *
   * ★ 下限 `attack >= 2` 不可去掉：战斗值 0 的补充队会让攻防比冲到最右列（9.14a），
   *   CRT 只给**攻方**进击结果而**不给攻方选项** ⇒ 本用例要的「攻方以撤退满足选项」无从构造。
   */
  const weakDefenderRecord = () =>
    groundRecord('soviet', (record) => {
      const attack = record.factors?.combat?.attack ?? 99
      const ar = record.factors?.combat?.ar ?? 99
      return record.isCombat === true && attack >= 2 && attack <= 3 && ar <= 2
    })

  /** 该格对该机动类型是否**非禁入**（与 `RetreatFacts#prohibitedFor` 同一判据：9.12 禁入者被消灭） */
  function notProhibited(mobility: 'leg' | 'truck' | 'track', hex: HexRef): boolean {
    const result = selectMovementTerrain({
      terrainsPresent: mapFacts.terrainsAt(hex),
      mobility,
      crossing: null,
      followingRoad: false,
      forOverrun: false,
    })
    return result.ok || result.reason !== 'prohibited'
  }

  /** 从 `from` 直线走 `count` 格，避开 `avoid`，且每格都非禁入（9.12f 第一段 + 9.12 禁入消灭） */
  function straightPathAvoiding(
    from: HexRef,
    count: number,
    avoid: readonly HexRef[],
    mobility: 'leg' | 'truck' | 'track',
  ): HexRef[] {
    for (const direction of HEX_DIRECTIONS) {
      const path: HexRef[] = []
      let current = from
      let valid = true
      for (let index = 0; index < count; index += 1) {
        const next = neighbor(current, direction)
        if (
          !isOnMap(next) ||
          !mapLayers.hexes.some((h) => h.col === next.col && h.row === next.row) ||
          !notProhibited(mobility, next)
        ) {
          valid = false
          break
        }
        path.push(next)
        current = next
      }
      if (!valid || hexDistance(from, current) !== count) continue
      if (path.some((hex) => avoid.some((item) => item.col === hex.col && item.row === hex.row)))
        continue
      return path
    }
    throw new Error(`找不到避开指定格的 ${count} 格直线撤退路径`)
  }

  /** 走到「撤退」步：攻方把**全部选项选为撤退**（9.10a 允许的满足方式之一） */
  function driveToAttackerRetreat(store: Store): {
    distance: number
    mobility: 'leg' | 'truck' | 'track'
  } {
    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    store.setFuelPool(0, 20)
    const attacker = placeGround(store, strongAttackerRecord(), ATTACKER_HEX, 'axis', 'a1')
    placeGround(store, weakDefenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
    store.clickHex(ATTACKER_HEX)
    store.clickHex(DEFENDER_HEX)
    expect(store.beginCombatNow()).toBe(true)
    declareSupplyForBoth(store)

    expect(store.confirmCombatSupply()).toBe(true)
    store.combatInputs.attackerArUnitId = 'a1'
    expect(store.declareCombatArStep('attacker')).toBe(true)
    store.combatInputs.defenderArUnitId = 'd1'
    expect(store.declareCombatArStep('defender')).toBe(true)
    expect(store.declareCombatTerrainStep()).toBe(true)
    expect(store.rollCombatSurprise()).toBe(true)
    if (store.combatAwaitingShiftDie) expect(store.rollCombatShiftDie()).toBe(true)
    expect(store.rollCombatDice()).toBe(true)

    // 9.10b：攻方先结算（强制损失 → 选项）
    expect(store.confirmCombatLosses()).toBe(true)
    const requirement = store.combatRequirement
    expect(requirement?.side).toBe('attacker')
    const distance = requirement?.options ?? 0
    expect(distance).toBeGreaterThan(0)
    store.combatInputs.optionRetreatHexes = distance
    store.combatInputs.optionLossPoints = 0
    expect(store.confirmCombatOptions()).toBe(true)

    // 守方结算（本夹具里守方被强制损失消灭 ⇒ 其选项按 9.10c 可忽略）
    expect(store.confirmCombatLosses()).toBe(true)
    if (store.combatState?.resolution.stage === 'defenderOptions') {
      store.combatInputs.ignoreOptions = true
      expect(store.confirmCombatOptions()).toBe(true)
    }
    expect(store.combatState?.step).toBe('retreat')
    expect(store.combatRetreatRequirement.attacker).toBe(distance)
    return { distance, mobility: attacker.raw.mobility as 'leg' | 'truck' | 'track' }
  }

  it('撤退**途经**有敌方补给站的格 ⇒ 该补给站按 9.14b 处置（夺取/摧毁，不再留在原主账上）', () => {
    const store: Store = newConsole()
    const { distance, mobility } = driveToAttackerRetreat(store)
    const path = straightPathAvoiding(ATTACKER_HEX, distance, [DEFENDER_HEX], mobility)

    // 9.12f：在撤退**途经的第一格**放一座苏军补给站（敌方非战斗单位）
    const dumpId = 'sd-soviet-retreat'
    store.spDumps.push({ id: dumpId, hex: { ...path[0]! }, side: 'soviet', sp: 4, t: 0 })

    store.combatInputs.retreatPaths = { a1: path.map(label).join(',') }
    expect(store.confirmCombatRetreats()).toBe(true)
    // 前提：攻方确实活着退到了落点（否则「可攻击单位进入」无从谈起）
    const mover = store.units.find((item) => item.instanceId === 'a1')
    expect(mover?.steps ?? 0).toBeGreaterThan(0)
    expect(`${mover?.hex.col}.${mover?.hex.row}`).toBe(label(path[path.length - 1]!))

    // 9.14b：夺取值进进入方账本，其余摧毁 ⇒ 无论如何这座苏军补给站都不再存在
    expect(store.spDumps.some((item) => item.id === dumpId)).toBe(false)
  })

  it('对照：撤退途经**空**格 ⇒ 不触发 9.14（盘面补给站不变）', () => {
    const store: Store = newConsole()
    const { distance, mobility } = driveToAttackerRetreat(store)
    const path = straightPathAvoiding(ATTACKER_HEX, distance, [DEFENDER_HEX], mobility)

    const before = store.spDumps.map((item) => item.id).sort()
    store.combatInputs.retreatPaths = { a1: path.map(label).join(',') }
    expect(store.confirmCombatRetreats()).toBe(true)

    expect(store.spDumps.map((item) => item.id).sort()).toEqual(before)
  })

  it('「穿越」判据：单位已不在该格时，不给途经名单即不处置（9.14 的前提是可攻击单位进入）', () => {
    const store: Store = newConsole()
    const attacker = placeGround(store, strongAttackerRecord(), ATTACKER_HEX, 'axis', 'a1')
    const target = straightPathAvoiding(ATTACKER_HEX, 1, [DEFENDER_HEX], attacker.raw.mobility)[0]!
    store.spDumps.push({ id: 'sd-soviet-far', hex: { ...target }, side: 'soviet', sp: 4, t: 0 })

    // 该格没有己方可攻击单位 ⇒ 处置不成立（9.14 的统一前提）
    expect(store.resolveSpecialCombatAt(target, 'axis')).toBe(false)
    expect(store.spDumps.some((item) => item.id === 'sd-soviet-far')).toBe(true)
    // 给了「途经名单」⇒ 按 9.12f 的「同移动时穿越那样处理」成立
    expect(store.resolveSpecialCombatAt(target, 'axis', false, ['a1'])).toBe(true)
    expect(store.spDumps.some((item) => item.id === 'sd-soviet-far')).toBe(false)
  })
})
