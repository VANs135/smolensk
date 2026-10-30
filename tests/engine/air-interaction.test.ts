import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import {
  airTransportProfile,
  AIR_INTERACTION_STEPS,
  PATROL_ZONE_MAX_HEXES,
  activeAircraftInBase,
  activeStackingLimitOf,
  airBaseAt,
  airCombatAttackerSide,
  airCombatOccursAt,
  airInteractionChecklist,
  assignAirMission,
  baseOfAircraft,
  beginAirInteraction,
  checkAircraftOrigin,
  completeAirReturnStep,
  confirmMissionStep,
  declareAirCombatStep,
  declareInterceptionStep,
  hasReachedAirInteractionStep,
  inPatrolZoneOf,
  isFriendlyAirBase,
  patrolZoneHexes,
  patrolZoneSources,
  planAirBaseReduction,
  planBaseRefit,
  planBaseTransfer,
  planInterceptionResponse,
  resolveFlakLoss,
  resolveFlakResponse,
  resolveAirCombatRounds,
  resolveFlakStep,
  resolveInterception,
  type AirBaseView,
  type AirInteractionState,
  type AirMissionAircraftView,
  type AirMissionCargo,
  type AirMissionKind,
} from '@/engine/rules'

/**
 * 空军交互（C9，OCS 14.0 / 15.0）测试
 *
 * 断言到**条文**一级：14.1a/c（归属与返航）、14.2a/d/e（堆叠·距离·每阶段一次）、14.2f（A–G 顺序）、
 * 14.3a/c（括号空战值与攻守互换）、14.4a/c（受防空影响的任务与巡逻区）、14.4e/f（防空命中与任务损失表）、
 * 14.5（拦截资格与战后状态）、14.6、14.7c、14.11 与 15.1/15.2/15.4。
 *
 * 逻辑测试**不读真实地图**：基地/飞机/目标格全部手给，距离一律用引擎的 `hexDistance` 表达，
 * 使「越界」类断言不受地图形状影响。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

const hex = (col: number, row: number): HexRef => ({ col, row })

/** 任务格（随便取一处图内格；距离断言全部用 hexDistance 表达，不依赖地形） */
const TARGET = hex(36, 13)
/** 远基地：与 TARGET 的格距由 hexDistance 算出（测试内不写死） */
const FAR = hex(36, 40)

function makeBase(overrides: Partial<AirBaseView> & { hex: HexRef }): AirBaseView {
  return {
    id: overrides.id ?? `base-${overrides.hex.col}.${overrides.hex.row}`,
    side: overrides.side ?? 'axis',
    level: overrides.level ?? 2,
    ...overrides,
  }
}

function makePlane(
  overrides: Partial<AirMissionAircraftView> & { id: string; baseHex: HexRef },
): AirMissionAircraftView {
  return {
    side: overrides.side ?? 'axis',
    airStatus: overrides.airStatus ?? 'active',
    missionsFlownThisPhase: overrides.missionsFlownThisPhase ?? 0,
    aircraftType: overrides.aircraftType ?? 'F',
    airCombatRating: overrides.airCombatRating ?? 3,
    canInitiateAirCombat: overrides.canInitiateAirCombat ?? true,
    rangeHexes: overrides.rangeHexes ?? 30,
    steps: overrides.steps ?? 2,
    canBarrage: overrides.canBarrage ?? true,
    canHipShoot: overrides.canHipShoot ?? false,
    canAirDrop: overrides.canAirDrop ?? false,
    canPatrolZone: overrides.canPatrolZone ?? true,
    ...(overrides.transportCapacity === undefined
      ? {}
      : { transportCapacity: overrides.transportCapacity }),
    ...(overrides.isStrategicBomber === undefined
      ? {}
      : { isStrategicBomber: overrides.isStrategicBomber }),
    ...overrides,
  }
}

/** 一次合法的任务请求（各用例按需覆盖字段） */
function missionRequest(overrides: {
  kind?: AirMissionKind
  side?: Side
  phase?: 'movement' | 'reaction' | 'exploitation' | 'combat' | 'aircraftRefit'
  flyingAllowed?: boolean
  weatherNormal?: boolean
  aircraft: readonly AirMissionAircraftView[]
  bases: readonly AirBaseView[]
  targetHex?: HexRef
  /** 14.9a/14.9c（第五批批 C 切片 2）：货物清单（含单位货物的 mode/ma 判据字段） */
  cargo?: readonly AirMissionCargo[]
}) {
  return {
    side: overrides.side ?? ('axis' as Side),
    phase: overrides.phase ?? ('movement' as const),
    kind: overrides.kind ?? ('barrage' as AirMissionKind),
    targetHex: overrides.targetHex ?? TARGET,
    flyingAllowed: overrides.flyingAllowed ?? true,
    weatherNormal: overrides.weatherNormal ?? true,
    aircraft: overrides.aircraft,
    bases: overrides.bases,
    ...(overrides.cargo === undefined ? {} : { cargo: overrides.cargo }),
  }
}

/** 开始一次任务交互（指定参战机与基地；失败即抛，供后续步骤复用） */
function beginPlane(
  plane: AirMissionAircraftView,
  bases: readonly AirBaseView[],
): AirInteractionState {
  const result = beginAirInteraction(missionRequest({ aircraft: [plane], bases }))
  if (!result.ok) throw new Error(`任务分配应当成功：${result.reason}`)
  return result.data
}

/** 推进到 14.2f-G（返航）步：空战（不发生）→ 拦截（不拦）→ 防空（不命中）→ 结算 */
function advanceToReturn(
  state: AirInteractionState,
  plane: AirMissionAircraftView,
  bases: readonly AirBaseView[],
): AirInteractionState {
  const combat = declareAirCombatStep(state, {
    friendlyAircraft: [plane],
    enemyActiveCount: 0,
    enemyCanInitiate: false,
    enemyAirBaseInHex: false,
  })
  if (!combat.ok) throw new Error(`空战步失败：${combat.reason}`)
  const interception = declareInterceptionStep(combat.data.state, {
    response: planInterceptionResponse({
      side: 'soviet',
      missionKind: 'barrage',
      missionHex: TARGET,
      alreadyIntercepted: false,
      aircraft: [],
      bases,
    }),
    declared: false,
  })
  if (!interception.ok) throw new Error(`拦截步失败：${interception.reason}`)
  const flak = resolveFlakStep(interception.data.state, {
    inEnemyPatrolZone: false,
    missionAircraft: [{ id: plane.id, barrageStrength: 0 }],
    die2d6: 2,
  })
  if (!flak.ok) throw new Error(`防空步失败：${flak.reason}`)
  const resolved = confirmMissionStep(flak.data.state, { note: '' })
  if (!resolved.ok) throw new Error(`结算步失败：${resolved.reason}`)
  return resolved.data.state
}

/* ────────────────────────────── 14.1a / 14.1c 基地归属权 ────────────────────────────── */
describe('14.1a/14.1c 基地归属权：一切基地用途都要求本方基地', () => {
  it('归属判定只看运行期归属方（中立算子由占有一方决定）', () => {
    const own = makeBase({ hex: TARGET, side: 'axis' })
    const enemy = makeBase({ hex: TARGET, side: 'soviet' })
    expect(isFriendlyAirBase(own, 'axis')).toBe(true)
    expect(isFriendlyAirBase(enemy, 'axis')).toBe(false)
  })

  it('15.0a：一格至多一个空军基地 ⇒ airBaseAt 取首个即唯一', () => {
    const bases = [makeBase({ hex: TARGET, id: 'b1' }), makeBase({ hex: hex(36, 30), id: 'b2' })]
    expect(airBaseAt(bases, TARGET)?.id).toBe('b1')
    expect(airBaseAt(bases, hex(1, 1))).toBeNull()
  })

  it('14.1a：起飞格没有空军基地 ⇒ aircraftNotInAirBaseHex', () => {
    const plane = makePlane({ id: 'p1', baseHex: hex(10, 10) })
    expect(checkAircraftOrigin({ aircraft: plane, side: 'axis', bases: [] })).toMatchObject({
      ok: false,
      rule: '14.1a',
      reason: 'aircraftNotInAirBaseHex:p1',
    })
  })

  it('14.1a：停在**敌方**基地格内 ⇒ aircraftBaseNotFriendly（激活状态只在友方基地成立）', () => {
    const plane = makePlane({ id: 'p1', baseHex: TARGET })
    const bases = [makeBase({ hex: TARGET, side: 'soviet' })]
    expect(checkAircraftOrigin({ aircraft: plane, side: 'axis', bases })).toMatchObject({
      ok: false,
      reason: 'aircraftBaseNotFriendly:p1',
    })
    // 任务分配同样拦下（同一判据）
    expect(assignAirMission(missionRequest({ aircraft: [plane], bases }))).toMatchObject({
      ok: false,
      reason: 'aircraftBaseNotFriendly:p1',
    })
  })

  it('14.1a：本方基地格内可以起飞，且能取回该基地', () => {
    const plane = makePlane({ id: 'p1', baseHex: TARGET })
    const bases = [makeBase({ hex: TARGET })]
    expect(checkAircraftOrigin({ aircraft: plane, side: 'axis', bases }).ok).toBe(true)
    expect(baseOfAircraft(plane, bases)?.hex).toEqual(TARGET)
  })

  it('14.2a：激活堆叠上限 = 4 + 等级（简易机场恒 4）', () => {
    expect(activeStackingLimitOf(makeBase({ hex: TARGET, level: 1 }))).toBe(5)
    expect(activeStackingLimitOf(makeBase({ hex: TARGET, level: 3 }))).toBe(7)
    expect(activeStackingLimitOf(makeBase({ hex: TARGET, level: 0, isAirstrip: true }))).toBe(4)
  })

  it('14.2a：只数该基地格内的**激活**飞机', () => {
    const aircraft = [
      makePlane({ id: 'a', baseHex: TARGET }),
      makePlane({ id: 'b', baseHex: TARGET, airStatus: 'inactive' }),
      makePlane({ id: 'c', baseHex: FAR, side: 'soviet' }),
    ]
    expect(activeAircraftInBase(aircraft, TARGET)).toBe(1)
  })
})

/* ────────────────────────────── 14.4c 巡逻区 ────────────────────────────── */

describe('专规 1.4a：图外空军盒起飞的飞机「从对应列入场」（先扣 20/30 格）', () => {
  /*
   * 原文：「Moving between the Soviet player's Red Air Force Box and the map's 62.xx row costs
   * 20 hexes of range. … the Axis … 01.xx row costs 30 hexes of range.」
   * 用户 2026-10-30 口径：「从对应行入场，剩余航程 = 航程 − 盒到那一行的航程。」
   * ⇒ 判据等价于 `盒航程 + 列差 ≤ 印刷航程`；本作 62 是**列号**（地图 rows 0–35 / cols 1–62）。
   */
  it('★ 苏方盒：入场列 62、代价 20 格；剩余航程 = 印刷航程 − 20', () => {
    const edge = hex(62, TARGET.row)
    // 62 列 → 36 列 = 26 格（同一行，格距恰为列差）
    const ok = makePlane({
      id: 'p1',
      side: 'soviet',
      baseHex: edge,
      rangeHexes: 50,
      offMap: { edgeCol: 62, rangeCost: 20 },
    })
    const accepted = assignAirMission(
      missionRequest({ side: 'soviet', aircraft: [ok], bases: [], targetHex: TARGET }),
    )
    expect(accepted.ok).toBe(true)
    expect(accepted.ok && accepted.data.origins[0]).toMatchObject({
      aircraftId: 'p1',
      baseHex: edge,
      distanceHexes: 26,
      rangeHexes: 30, // 50 − 20
      fromOffMapBox: true,
    })

    // 射程 45 ⇒ 剩 25 < 26 ⇒ 够不着（若忘了扣 20 格，这条会被误放行）
    const short = makePlane({
      id: 'p2',
      side: 'soviet',
      baseHex: edge,
      rangeHexes: 45,
      offMap: { edgeCol: 62, rangeCost: 20 },
    })
    const rejected = assignAirMission(
      missionRequest({ side: 'soviet', aircraft: [short], bases: [], targetHex: TARGET }),
    )
    expect(rejected.ok).toBe(false)
    expect(rejected.ok === false && rejected.rule).toBe('专规 1.4a')
  })

  it('★ 轴方盒：入场列 1、代价 30 格；射程不足 30 格连场都进不来', () => {
    const edge = hex(1, TARGET.row)
    // 1 列 → 36 列 = 35 格；印刷 70 ⇒ 剩 40 ≥ 35
    const ok = makePlane({
      id: 'a1',
      side: 'axis',
      baseHex: edge,
      rangeHexes: 70,
      offMap: { edgeCol: 1, rangeCost: 30 },
    })
    expect(
      assignAirMission(
        missionRequest({ side: 'axis', aircraft: [ok], bases: [], targetHex: TARGET }),
      ).ok,
    ).toBe(true)

    const tooShort = makePlane({
      id: 'a2',
      side: 'axis',
      baseHex: edge,
      rangeHexes: 25,
      offMap: { edgeCol: 1, rangeCost: 30 },
    })
    const r = assignAirMission(
      missionRequest({ side: 'axis', aircraft: [tooShort], bases: [], targetHex: TARGET }),
    )
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('offMapOriginBeyondRange')
  })
})

describe('14.4c 巡逻区：本方基地 + 激活战斗机 + 10 格', () => {
  const ownBase = makeBase({ hex: TARGET })

  it('基地格内须有激活战斗机（且是本方的）才产生巡逻区', () => {
    const fighter = makePlane({ id: 'f1', baseHex: TARGET })
    expect(patrolZoneSources({ side: 'axis', bases: [ownBase], aircraft: [fighter] })).toHaveLength(
      1,
    )
    // 只有非激活战斗机 ⇒ 无巡逻区
    expect(
      patrolZoneSources({
        side: 'axis',
        bases: [ownBase],
        aircraft: [makePlane({ id: 'f2', baseHex: TARGET, airStatus: 'inactive' })],
      }),
    ).toHaveLength(0)
    // 轰炸机不产生巡逻区（14.1：战斗机是唯一能攻击者）
    expect(
      patrolZoneSources({
        side: 'axis',
        bases: [ownBase],
        aircraft: [makePlane({ id: 'b1', baseHex: TARGET, canPatrolZone: false })],
      }),
    ).toHaveLength(0)
    // 敌方基地不产生本方的巡逻区（★ 归属权）
    expect(
      patrolZoneSources({
        side: 'axis',
        bases: [makeBase({ hex: TARGET, side: 'soviet' })],
        aircraft: [fighter],
      }),
    ).toHaveLength(0)
  })

  it('半径取 rules-constants 的 patrolZoneMaxHexes（10）', () => {
    const fighter = makePlane({ id: 'f1', baseHex: TARGET })
    expect(
      patrolZoneSources({ side: 'axis', bases: [ownBase], aircraft: [fighter] })[0]?.radiusHexes,
    ).toBe(PATROL_ZONE_MAX_HEXES)
    expect(PATROL_ZONE_MAX_HEXES).toBe(10)
  })

  it('在/不在巡逻区按格距判定，并给界面铺色用的格集合', () => {
    const fighter = makePlane({ id: 'f1', baseHex: TARGET })
    const input = { side: 'axis', bases: [ownBase], aircraft: [fighter] } as const
    expect(inPatrolZoneOf({ ...input, hex: TARGET })).toBe(true)
    // 恰在半径上（同列向下 PATROL_ZONE_MAX_HEXES 格）
    expect(
      inPatrolZoneOf({ ...input, hex: hex(TARGET.col, TARGET.row + PATROL_ZONE_MAX_HEXES) }),
    ).toBe(true)
    expect(
      inPatrolZoneOf({ ...input, hex: hex(TARGET.col, TARGET.row + PATROL_ZONE_MAX_HEXES + 1) }),
    ).toBe(false)

    const hexes = patrolZoneHexes(input)
    expect(hexes.length).toBeGreaterThan(1)
    expect(hexes.some((item) => item.col === TARGET.col && item.row === TARGET.row)).toBe(true)
    expect(
      hexes.some(
        (item) => item.col === TARGET.col && item.row === TARGET.row + PATROL_ZONE_MAX_HEXES + 1,
      ),
    ).toBe(false)
  })
})

/* ────────────────────────────── 14.2f-A/B 任务分配 ────────────────────────────── */

describe('14.2f-A/B 任务分配：机数·距离·阶段·天候·能力', () => {
  const bases = [makeBase({ hex: TARGET })]
  const planeAtBase = makePlane({ id: 'p1', baseHex: TARGET })

  it('14.2e：同一阶段的机能否再执行任务；14.1a：非激活不得出击；14.1b：军力归零即除名', () => {
    expect(
      assignAirMission(
        missionRequest({
          aircraft: [makePlane({ id: 'p1', baseHex: TARGET, missionsFlownThisPhase: 1 })],
          bases,
        }),
      ),
    ).toMatchObject({ ok: false, rule: '14.2e', reason: 'aircraftAlreadyFlewMissionThisPhase:p1' })
    expect(
      assignAirMission(
        missionRequest({
          aircraft: [makePlane({ id: 'p1', baseHex: TARGET, airStatus: 'inactive' })],
          bases,
        }),
      ),
    ).toMatchObject({ ok: false, rule: '14.1a', reason: 'aircraftNotActive:p1' })
    expect(
      assignAirMission(
        missionRequest({ aircraft: [makePlane({ id: 'p1', baseHex: TARGET, steps: 0 })], bases }),
      ),
    ).toMatchObject({ ok: false, rule: '14.1b', reason: 'aircraftEliminated:p1' })
  })

  it('14.2a：一次任务合计 ≤4 架，且至少 1 架', () => {
    const five = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => makePlane({ id, baseHex: TARGET }))
    expect(assignAirMission(missionRequest({ aircraft: five, bases }))).toMatchObject({
      ok: false,
      rule: '14.2a',
      reason: 'missionAircraftLimitExceeded:5',
    })
    expect(assignAirMission(missionRequest({ aircraft: [], bases }))).toMatchObject({
      ok: false,
      reason: 'noAircraftInMission',
    })
    expect(assignAirMission(missionRequest({ aircraft: five.slice(0, 4), bases })).ok).toBe(true)
  })

  it('14.2d：距任务格超过航程即拒（距离自起飞基地起算）', () => {
    const farBase = makeBase({ hex: FAR })
    const distance = hexDistance(FAR, TARGET)
    expect(distance).toBeGreaterThan(0)
    const plane = makePlane({ id: 'p1', baseHex: FAR, rangeHexes: distance - 1 })
    expect(assignAirMission(missionRequest({ aircraft: [plane], bases: [farBase] }))).toMatchObject(
      {
        ok: false,
        rule: '14.2d',
        reason: `aircraftOutOfRange:p1:${distance}>${distance - 1}`,
      },
    )
    expect(
      assignAirMission(
        missionRequest({
          aircraft: [makePlane({ id: 'p1', baseHex: FAR, rangeHexes: distance })],
          bases: [farBase],
        }),
      ).ok,
    ).toBe(true)
  })

  it('14.1f：天气禁飞即不可宣布任务', () => {
    expect(
      assignAirMission(missionRequest({ aircraft: [planeAtBase], bases, flyingAllowed: false })),
    ).toMatchObject({ ok: false, rule: '14.1f', reason: 'weatherProhibitsFlying' })
  })

  it('14.1g：只在移动/进击/反应阶段出击；专规 2.2c：苏军不得在反应/进击出击', () => {
    expect(
      assignAirMission(missionRequest({ aircraft: [planeAtBase], bases, phase: 'combat' })),
    ).toMatchObject({ ok: false, rule: '14.1g', reason: 'missionsNotAllowedInPhase:combat' })
    const sovietPlane = makePlane({ id: 'p1', baseHex: TARGET, side: 'soviet' })
    const sovietBase = makeBase({ hex: TARGET, side: 'soviet' })
    expect(
      assignAirMission(
        missionRequest({
          side: 'soviet',
          phase: 'reaction',
          aircraft: [sovietPlane],
          bases: [sovietBase],
        }),
      ),
    ).toMatchObject({ ok: false, rule: '2.2c', reason: 'sovietNoReactionOrExploitationMission' })
    // 苏军在**移动阶段**可以出击（专规只禁反应/进击）
    expect(
      assignAirMission(
        missionRequest({
          side: 'soviet',
          phase: 'movement',
          aircraft: [sovietPlane],
          bases: [sovietBase],
        }),
      ).ok,
    ).toBe(true)
  })

  it('14.5 / 14.11：拦截与基地转移不走「任务分配」入口', () => {
    expect(
      assignAirMission(missionRequest({ kind: 'interception', aircraft: [planeAtBase], bases })),
    ).toMatchObject({ ok: false, reason: 'interceptionIsNotADeclaredMission' })
    expect(
      assignAirMission(missionRequest({ kind: 'base_transfer', aircraft: [planeAtBase], bases })),
    ).toMatchObject({ ok: false, reason: 'baseTransferUsesDedicatedPlan' })
  })

  it('任务类型的能力门槛（14.7b/14.7d/14.9a/14.6 + 专规 2.2a/b）', () => {
    const bomber = makePlane({ id: 'b1', baseHex: TARGET, canBarrage: true })
    const noBarrage = makePlane({ id: 't1', baseHex: TARGET, canBarrage: false })
    expect(
      assignAirMission(missionRequest({ kind: 'barrage', aircraft: [noBarrage], bases })),
    ).toMatchObject({ ok: false, reason: 'noBarrageCapableAircraft' })
    expect(
      assignAirMission(missionRequest({ kind: 'trainbusting', aircraft: [bomber], bases })).ok,
    ).toBe(true)

    // 低空扫射：须有具备该能力的机，且专规 2.2a 禁苏军
    expect(
      assignAirMission(missionRequest({ kind: 'hip_shoot', aircraft: [bomber], bases })),
    ).toMatchObject({ ok: false, rule: '14.7d', reason: 'noHipShootCapableAircraft' })
    expect(
      assignAirMission(
        missionRequest({
          kind: 'hip_shoot',
          aircraft: [makePlane({ id: 'h1', baseHex: TARGET, canHipShoot: true })],
          bases,
        }),
      ).ok,
    ).toBe(true)
    expect(
      assignAirMission(
        missionRequest({
          kind: 'hip_shoot',
          side: 'soviet',
          aircraft: [makePlane({ id: 'h1', baseHex: TARGET, side: 'soviet', canHipShoot: true })],
          bases: [makeBase({ hex: TARGET, side: 'soviet' })],
        }),
      ),
    ).toMatchObject({ ok: false, rule: '2.2a', reason: 'hipShootNotAllowedForSideOrWeather' })

    // 空运：须至少 1 架有运力（战斗机可护航，14.2e 不限制机种）
    expect(
      assignAirMission(missionRequest({ kind: 'air_transport', aircraft: [bomber], bases })),
    ).toMatchObject({ ok: false, rule: '14.9a', reason: 'noTransportCapableAircraft' })
    const transport = makePlane({
      id: 'tp1',
      baseHex: TARGET,
      transportCapacity: 3,
      canBarrage: false,
    })
    const escort = makePlane({ id: 'f1', baseHex: TARGET, transportCapacity: 0 })
    const transportMission = assignAirMission(
      missionRequest({ kind: 'air_transport', aircraft: [transport, escort], bases }),
    )
    expect(transportMission.ok).toBe(true)
    if (transportMission.ok) {
      /*
       * B44（14.9e-C）：本夹具的任务格就在起飞基地上（距离 0 ≤ 航程的一半）⇒ 该机**运输容量翻倍**
       * （3 → 6）。修前这里恒为印值 3 —— 等于把 14.9e-C 的加倍整条漏掉。
       * 护航机运力为 0，不参与折算。
       */
      expect(transportMission.data.cargoCapacity).toBe(6)
      expect(transportMission.data.aircraftIds).toEqual(['tp1', 'f1'])
    }
    // 空投：苏军不得计划空投（专规 2.2b）
    expect(
      assignAirMission(
        missionRequest({
          kind: 'air_drop',
          side: 'soviet',
          aircraft: [
            makePlane({ id: 'tp1', baseHex: TARGET, side: 'soviet', transportCapacity: 2 }),
          ],
          bases: [makeBase({ hex: TARGET, side: 'soviet' })],
        }),
      ),
    ).toMatchObject({ ok: false, rule: '2.2b', reason: 'plannedAirdropNotAllowedForSide' })

    // 战机扫荡：须至少 1 架能发起空战（14.6 + 14.1）
    expect(
      assignAirMission(
        missionRequest({
          kind: 'fighter_sweep',
          aircraft: [makePlane({ id: 'b1', baseHex: TARGET, canInitiateAirCombat: false })],
          bases,
        }),
      ),
    ).toMatchObject({ ok: false, rule: '14.6', reason: 'noAirCombatCapableAircraft' })
  })

  it('14.7c：逐机给出起飞基地与距离，并汇总「是否全在 10 格内」与最大距离', () => {
    const near = makeBase({ hex: TARGET })
    const farBase = makeBase({ hex: FAR })
    const distance = hexDistance(FAR, TARGET)
    const result = assignAirMission(
      missionRequest({
        aircraft: [makePlane({ id: 'p1', baseHex: TARGET }), makePlane({ id: 'p2', baseHex: FAR })],
        bases: [near, farBase],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.origins).toEqual([
      { aircraftId: 'p1', baseHex: TARGET, distanceHexes: 0, rangeHexes: 30 },
      { aircraftId: 'p2', baseHex: FAR, distanceHexes: distance, rangeHexes: 30 },
    ])
    expect(result.data.maxDistanceHexes).toBe(distance)
    expect(result.data.allWithinShortRange).toBe(distance <= 10)
    expect(result.data.rule).toBe('14.2f-A')
  })
})

/* ────────────────────────────── 14.3a/14.3c 空战角色 ────────────────────────────── */

describe('14.3a/14.3c 空战：括号空战值与攻守互换', () => {
  it('攻击方有非括号值 ⇒ 角色不变', () => {
    const roles = airCombatAttackerSide({
      initiatorSide: 'axis',
      attackerCanInitiate: true,
      defenderCanInitiate: false,
    })
    expect(roles).toMatchObject({
      attackerSide: 'axis',
      defenderSide: 'soviet',
      swapped: false,
      noCombat: false,
    })
    expect(roles.rule).toBe('14.3c')
  })

  it('攻击方全为括号值 ⇒ 攻守互换', () => {
    const roles = airCombatAttackerSide({
      initiatorSide: 'axis',
      attackerCanInitiate: false,
      defenderCanInitiate: true,
    })
    expect(roles).toMatchObject({ attackerSide: 'soviet', defenderSide: 'axis', swapped: true })
    expect(roles.noCombat).toBe(false)
  })

  it('双方全为括号值 ⇒ 不发生空战（互不理睬，任务继续）', () => {
    const roles = airCombatAttackerSide({
      initiatorSide: 'axis',
      attackerCanInitiate: false,
      defenderCanInitiate: false,
    })
    expect(roles).toMatchObject({
      attackerSide: null,
      defenderSide: null,
      noCombat: true,
      rule: '14.3a',
    })
  })

  it('14.3：任务格内没有**敌方**空军基地就不发生空战（★ 归属权）', () => {
    expect(
      airCombatOccursAt({ friendlyActiveCount: 1, enemyActiveCount: 1, enemyAirBaseInHex: false }),
    ).toBe(false)
    expect(
      airCombatOccursAt({ friendlyActiveCount: 1, enemyActiveCount: 1, enemyAirBaseInHex: true }),
    ).toBe(true)
    // 本方基地（非敌方）不算敌方据点；且一方无激活飞机也不会打起来
    expect(
      airCombatOccursAt({ friendlyActiveCount: 1, enemyActiveCount: 0, enemyAirBaseInHex: true }),
    ).toBe(false)
  })
})

/* ────────────────────────────── 14.5 拦截应答 ────────────────────────────── */

describe('14.5/14.4a/14.4c 拦截应答', () => {
  const base = makeBase({ hex: TARGET, side: 'soviet' })
  const fighter = makePlane({ id: 'f1', baseHex: TARGET, side: 'soviet' })
  const baseInput = {
    side: 'soviet' as Side,
    missionKind: 'barrage' as AirMissionKind,
    missionHex: hex(TARGET.col, TARGET.row + 3),
    alreadyIntercepted: false,
    aircraft: [fighter],
    bases: [base],
  }

  it('任务受防空影响 + 任务格在巡逻区内 + 有激活战斗机 ⇒ 可拦（一次一架）', () => {
    const response = planInterceptionResponse(baseInput)
    expect(response.eligible).toBe(true)
    expect(response.eligibleFighterIds).toEqual(['f1'])
    expect(response.rule).toBe('14.5')
  })

  it('14.5：每个任务只能被拦截一次', () => {
    expect(planInterceptionResponse({ ...baseInput, alreadyIntercepted: true })).toMatchObject({
      eligible: false,
      reason: 'missionAlreadyIntercepted',
    })
  })

  it('14.5/14.4c：任务格在巡逻区外不可拦', () => {
    expect(
      planInterceptionResponse({
        ...baseInput,
        missionHex: hex(TARGET.col, TARGET.row + PATROL_ZONE_MAX_HEXES + 1),
      }),
    ).toMatchObject({ eligible: false, reason: 'missionHexOutsidePatrolZone' })
  })

  it('14.4a：战机扫荡不可被拦截（该类任务不受防空影响）', () => {
    expect(planInterceptionResponse({ ...baseInput, missionKind: 'fighter_sweep' })).toMatchObject({
      eligible: false,
      rule: '14.4a',
      reason: 'missionNotFlakAffected:fighter_sweep',
    })
  })

  it('14.5/14.4c：没有激活战斗机（或只有轰炸机）就没有巡逻区 ⇒ 不可拦', () => {
    expect(
      planInterceptionResponse({
        ...baseInput,
        aircraft: [makePlane({ id: 'b1', baseHex: TARGET, side: 'soviet', canPatrolZone: false })],
      }),
    ).toMatchObject({ eligible: false, reason: 'missionHexOutsidePatrolZone' })
    // ★ 归属权：战斗机停在**敌方**基地格时不产生巡逻区，也不可出击
    expect(
      planInterceptionResponse({
        ...baseInput,
        bases: [makeBase({ hex: TARGET, side: 'axis' })],
      }),
    ).toMatchObject({ eligible: false, reason: 'missionHexOutsidePatrolZone' })
  })

  it('14.5/14.3e：拦截的单轮结算与战后状态（胜=保持激活，败/双方返航=非激活）', () => {
    const win = resolveInterception({
      interceptor: { id: 'f1', airCombatRating: 3 },
      defender: { id: 'e1', airCombatRating: 3 },
      die: 9,
      lossDie: 6,
    })
    expect(win.ok).toBe(true)
    if (win.ok) {
      expect(win.data.combat.abortSide).toBe('defender')
      expect(win.data.interceptorWon).toBe(true)
      expect(win.data.interceptorAirStatus).toBe('active')
      expect(win.data.interceptorCountsAsMission).toBe(false)
    }

    const lose = resolveInterception({
      interceptor: { id: 'f1', airCombatRating: 3 },
      defender: { id: 'e1', airCombatRating: 3 },
      die: 5,
    })
    expect(lose.ok).toBe(true)
    if (lose.ok) {
      expect(lose.data.combat.abortSide).toBe('attacker')
      expect(lose.data.interceptorAirStatus).toBe('inactive')
    }

    // 修正骰 = 7 ⇒ 双方返航：拦截未成功 ⇒ 非激活（14.1c 的例外只给「成功完成一次拦截」者）
    const both = resolveInterception({
      interceptor: { id: 'f1', airCombatRating: 3 },
      defender: { id: 'e1', airCombatRating: 3 },
      die: 7,
    })
    expect(both.ok).toBe(true)
    if (both.ok) {
      expect(both.data.combat.abortSide).toBe('both')
      expect(both.data.interceptorWon).toBe(false)
      expect(both.data.interceptorAirStatus).toBe('inactive')
    }
  })

  it('14.3e-B：没有可迎战的防守机时不能结算空战', () => {
    expect(
      resolveInterception({
        interceptor: { id: 'f1', airCombatRating: 3 },
        defender: null,
        die: 9,
      }),
    ).toMatchObject({ ok: false, rule: '14.3e-B', reason: 'noDefendingAircraftInAirCombat' })
  })
})

/* ────────────────────────────── 14.4e/14.4f 防空应答 ────────────────────────────── */

describe('14.4a/e/f 防空应答', () => {
  it('14.4a：不受防空影响的任务（战机扫荡 / 巡逻区外的空运）直接跳过', () => {
    expect(
      resolveFlakResponse({
        kind: 'fighter_sweep',
        inEnemyPatrolZone: true,
        missionAircraft: [{ id: 'p1', barrageStrength: 3 }],
        die2d6: 12,
      }),
    ).toMatchObject({ applies: false, hit: false, rule: '14.4a' })
    expect(
      resolveFlakResponse({
        kind: 'air_transport',
        inEnemyPatrolZone: false,
        missionAircraft: [{ id: 'p1', barrageStrength: 0 }],
        die2d6: 12,
      }),
    ).toMatchObject({ applies: false, hit: false })
    // 进了敌方巡逻区 ⇒ 空运也受影响
    expect(
      resolveFlakResponse({
        kind: 'air_transport',
        inEnemyPatrolZone: true,
        missionAircraft: [{ id: 'p1', barrageStrength: 0 }],
        die2d6: 12,
      }).applies,
    ).toBe(true)
  })

  it('14.4e 表 17-3：修正 = 三机以上+1、目标有 HQ+1、基地等级每级+1、巡逻区内按任务有无战斗机 +1/+2', () => {
    const input = {
      kind: 'barrage' as AirMissionKind,
      inEnemyPatrolZone: true,
      missionHasFighter: true,
      missionAircraft: [
        { id: 'p1', barrageStrength: 3 },
        { id: 'p2', barrageStrength: 2 },
        { id: 'p3', barrageStrength: 1 },
      ],
      targetHasHQ: true,
      targetAirBaseLevel: 2,
      die2d6: 6,
    }
    const hit = resolveFlakResponse(input)
    expect(hit.drm).toBe(1 + 1 + 2 + 1) // 三机 1 + HQ 1 + 基地 2 级 2 + 任务编有战斗机 1
    expect(hit.modifiedDie).toBe(6 + 5)
    expect(hit.hit).toBe(true)
    expect(hit.rule).toBe('14.4f')

    // 任务编成**无战斗机** ⇒ +2（其余不变）；且 2 骰不足时不命中
    const miss = resolveFlakResponse({
      ...input,
      missionHasFighter: false,
      die2d6: 3,
    })
    expect(miss.drm).toBe(1 + 1 + 2 + 2)
    expect(miss.hit).toBe(false)
    expect(miss.rule).toBe('14.4e')
  })

  it('14.4e/f：单机任务命中即该机（表内无 1 架行，自明）', () => {
    const result = resolveFlakResponse({
      kind: 'barrage',
      inEnemyPatrolZone: false,
      missionAircraft: [{ id: 'p1', barrageStrength: 4 }],
      die2d6: 12,
    })
    expect(result).toMatchObject({ hit: true, lossAircraftId: 'p1', lossCode: '#1' })
  })

  it('14.4f：查任务损失表（行＝架数，列＝损失骰；#n 按输入顺序）', () => {
    const two = [
      { id: 'p1', barrageStrength: 3 },
      { id: 'p2', barrageStrength: 1 },
    ]
    expect(resolveFlakLoss(two, 1)).toEqual({ aircraftId: 'p1', code: '#1' })
    expect(resolveFlakLoss(two, 5)).toEqual({ aircraftId: 'p2', code: '#2' })

    const four = [
      { id: 'p1', barrageStrength: 5 },
      { id: 'p2', barrageStrength: 1 },
      { id: 'p3', barrageStrength: 3 },
      { id: 'p4', barrageStrength: 2 },
    ]
    expect(resolveFlakLoss(four, 2)).toEqual({ aircraftId: 'p2', code: '#2' })
    // 格值 W/S＝最弱/最强（按轰炸值）
    expect(resolveFlakLoss(four, 5)).toEqual({ aircraftId: 'p2', code: 'W' })
    expect(resolveFlakLoss(four, 6)).toEqual({ aircraftId: 'p1', code: 'S' })
    expect(resolveFlakLoss([], 3)).toEqual({ aircraftId: null, code: null })
  })
})

/* ────────────────────────────── 15.1 整备额度 ────────────────────────────── */

describe('15.1/15.2B/14.2a 整备额度', () => {
  const inactive = [
    { id: 'a1', side: 'axis' as Side },
    { id: 'a2', side: 'axis' as Side },
    { id: 'a3', side: 'axis' as Side },
  ]

  it('15.1：只在**本方**基地整备（★ 归属权）', () => {
    expect(
      planBaseRefit({
        base: makeBase({ hex: TARGET, side: 'soviet' }),
        side: 'axis',
        phase: 'aircraftRefit',
        inactiveAircraft: inactive,
        activeAircraftInBase: 0,
        requested: 1,
        availableT: 1,
      }),
    ).toMatchObject({ ok: false, rule: '15.1', reason: 'refitAtEnemyAirBase:base-36.13' })
  })

  it('15.1A：只在飞机整备阶段；每基地每阶段一次；15.1C：未抵消敌方 ZOC 内不可整备', () => {
    const common = {
      base: makeBase({ hex: TARGET }),
      side: 'axis' as Side,
      inactiveAircraft: inactive,
      activeAircraftInBase: 0,
      requested: 1,
      availableT: 1,
    }
    expect(planBaseRefit({ ...common, phase: 'movement' })).toMatchObject({
      ok: false,
      rule: '15.1A',
      reason: 'refitOnlyInAircraftRefitPhase',
    })
    expect(
      planBaseRefit({
        ...common,
        phase: 'aircraftRefit',
        base: makeBase({ hex: TARGET, refitDoneThisPhase: true }),
      }),
    ).toMatchObject({ ok: false, reason: 'baseAlreadyRefitThisPhase' })
    expect(
      planBaseRefit({
        ...common,
        phase: 'aircraftRefit',
        base: makeBase({ hex: TARGET, inUnnegatedEnemyZoc: true }),
      }),
    ).toMatchObject({ ok: false, rule: '15.1C', reason: 'unnegatedEnemyZoc' })
  })

  it('15.1B：容量＝等级×2、费用恒定 1T；超容量 / T 不足即拒', () => {
    // 2 级基地容量 4；请求 3 架合法
    const ok = planBaseRefit({
      base: makeBase({ hex: TARGET, level: 2 }),
      side: 'axis',
      phase: 'aircraftRefit',
      inactiveAircraft: inactive,
      activeAircraftInBase: 0,
      requested: 3,
      availableT: 1,
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.data.capacity).toBe(4)
      expect(ok.data.costT).toBe(1)
      expect(ok.data.activateAircraftIds).toEqual(['a1', 'a2', 'a3'])
      expect(ok.data.rule).toBe('15.1')
    }
    // 1 级基地容量 2；请求 3 架超容量
    expect(
      planBaseRefit({
        base: makeBase({ hex: TARGET, level: 1 }),
        side: 'axis',
        phase: 'aircraftRefit',
        inactiveAircraft: inactive,
        activeAircraftInBase: 0,
        requested: 3,
        availableT: 1,
      }),
    ).toMatchObject({ ok: false, rule: '15.1B', reason: 'refitCapacityExceeded:2' })
    // T 不足
    expect(
      planBaseRefit({
        base: makeBase({ hex: TARGET }),
        side: 'axis',
        phase: 'aircraftRefit',
        inactiveAircraft: inactive,
        activeAircraftInBase: 0,
        requested: 1,
        availableT: 0,
      }),
    ).toMatchObject({ ok: false, rule: '15.1B', reason: 'insufficientRefitT' })
  })

  it('15.2B：简易机场每阶段只整备 1 架', () => {
    expect(
      planBaseRefit({
        base: makeBase({ hex: TARGET, level: 0, isAirstrip: true }),
        side: 'axis',
        phase: 'aircraftRefit',
        inactiveAircraft: inactive,
        activeAircraftInBase: 0,
        requested: 2,
        availableT: 1,
      }),
    ).toMatchObject({ ok: false, rule: '15.1B', reason: 'refitCapacityExceeded:1' })
  })

  it('14.2a：整备后激活堆叠不得超限（4 + 等级）', () => {
    expect(
      planBaseRefit({
        base: makeBase({ hex: TARGET, level: 1 }),
        side: 'axis',
        phase: 'aircraftRefit',
        inactiveAircraft: inactive,
        activeAircraftInBase: 5, // 1 级基地上限 5，已满
        requested: 1,
        availableT: 1,
      }),
    ).toMatchObject({ ok: false, rule: '14.2a', reason: 'activeStackingLimitExceeded:6>5' })
  })

  it('15.1B：非激活机不足 / 未选任何机时的原因码', () => {
    const base = {
      base: makeBase({ hex: TARGET }),
      side: 'axis' as Side,
      phase: 'aircraftRefit' as const,
      availableT: 1,
      activeAircraftInBase: 0,
    }
    expect(planBaseRefit({ ...base, inactiveAircraft: [], requested: 1 })).toMatchObject({
      ok: false,
      reason: 'noInactiveAircraftAtBase',
    })
    expect(planBaseRefit({ ...base, inactiveAircraft: inactive, requested: 0 })).toMatchObject({
      ok: false,
      reason: 'nothingRequestedToRefit',
    })
    expect(planBaseRefit({ ...base, inactiveAircraft: inactive, requested: 4 })).toMatchObject({
      ok: false,
      reason: 'notEnoughInactiveAircraft:4>3',
    })
  })
})

/* ────────────────────────────── 14.11 基地转移 ────────────────────────────── */

describe('14.11 基地转移（含归属权与堆叠）', () => {
  const fromBase = makeBase({ hex: TARGET, level: 2 })
  const toBase = makeBase({ hex: hex(36, 20), level: 2 })
  const distance = hexDistance(TARGET, fromBase.hex)

  it('14.11：两端都必须是**本方**基地', () => {
    expect(
      planBaseTransfer({
        side: 'axis',
        aircraft: { id: 'p1', isFighter: true, rangeHexes: 20 },
        fromBase: makeBase({ hex: TARGET, side: 'soviet' }),
        toBase,
        activeAircraftAtDestination: 0,
      }),
    ).toMatchObject({ ok: false, reason: 'transferFromEnemyAirBase:base-36.13' })
    expect(
      planBaseTransfer({
        side: 'axis',
        aircraft: { id: 'p1', isFighter: true, rangeHexes: 20 },
        fromBase,
        toBase: makeBase({ hex: hex(36, 20), side: 'soviet' }),
        activeAircraftAtDestination: 0,
      }),
    ).toMatchObject({ ok: false, reason: 'transferToEnemyAirBase:base-36.20' })
  })

  it('14.11：距离超过航程 2 倍即不可转移', () => {
    const far = hexDistance(toBase.hex, fromBase.hex)
    const result = planBaseTransfer({
      side: 'axis',
      aircraft: { id: 'p1', isFighter: true, rangeHexes: 1 },
      fromBase,
      toBase,
      activeAircraftAtDestination: 0,
    })
    expect(result).toMatchObject({ ok: false, rule: '14.11', reason: `beyondDoubleRange:${far}>2` })
    expect(distance).toBe(0)
  })

  it('14.11：战斗机在正常距离内保持激活；超出正常距离（仍在 2 倍内）或其他机种 ⇒ 非激活', () => {
    const far = hexDistance(fromBase.hex, toBase.hex)
    const fighterInRange = planBaseTransfer({
      side: 'axis',
      aircraft: { id: 'f1', isFighter: true, rangeHexes: far },
      fromBase,
      toBase,
      activeAircraftAtDestination: 0,
    })
    expect(fighterInRange.ok).toBe(true)
    if (fighterInRange.ok) {
      expect(fighterInRange.data.airStatus).toBe('active')
      expect(fighterInRange.data.maxDistanceHexes).toBe(far * 2)
    }

    const fighterBeyondNormal = planBaseTransfer({
      side: 'axis',
      aircraft: { id: 'f1', isFighter: true, rangeHexes: far - 1 },
      fromBase,
      toBase,
      activeAircraftAtDestination: 0,
    })
    expect(fighterBeyondNormal.ok).toBe(true)
    if (fighterBeyondNormal.ok) expect(fighterBeyondNormal.data.airStatus).toBe('inactive')

    const bomberInRange = planBaseTransfer({
      side: 'axis',
      aircraft: { id: 'b1', isFighter: false, rangeHexes: far * 2 },
      fromBase,
      toBase,
      activeAircraftAtDestination: 0,
    })
    expect(bomberInRange.ok).toBe(true)
    if (bomberInRange.ok) expect(bomberInRange.data.airStatus).toBe('inactive')
  })

  it('14.2a：转移后仍激活时，目标基地的激活堆叠不得超限', () => {
    const far = hexDistance(fromBase.hex, toBase.hex)
    expect(
      planBaseTransfer({
        side: 'axis',
        aircraft: { id: 'f1', isFighter: true, rangeHexes: far },
        fromBase,
        toBase: makeBase({ hex: toBase.hex, level: 1 }),
        activeAircraftAtDestination: 5, // 1 级上限 5，已满
      }),
    ).toMatchObject({ ok: false, rule: '14.2a', reason: 'activeStackingLimitExceeded:6>5' })
  })
})

/* ────────────────────────────── 15.4 基地缩减 ────────────────────────────── */

describe('15.4/15.2E 基地缩减', () => {
  const workers = [{ id: 'w1', re: 1, mode: 'combat' as const, movedThisPhase: false }]

  it('15.4：只能缩减**本方**基地；15.2E：简易机场永不缩减', () => {
    expect(
      planAirBaseReduction({
        side: 'axis',
        base: makeBase({ hex: TARGET, side: 'soviet' }),
        phase: 'movement',
        operatingUnits: workers,
      }),
    ).toMatchObject({ ok: false, rule: '15.4', reason: 'reduceEnemyAirBase:base-36.13' })
    expect(
      planAirBaseReduction({
        side: 'axis',
        base: makeBase({ hex: TARGET, level: 0, isAirstrip: true }),
        phase: 'movement',
        operatingUnits: workers,
      }),
    ).toMatchObject({ ok: false, rule: '15.2E', reason: 'airstripCannotBeReduced' })
  })

  it('15.4：成功降一级并只约束被指定的单位（不耗 SP）', () => {
    const result = planAirBaseReduction({
      side: 'axis',
      base: makeBase({ hex: TARGET, level: 3 }),
      phase: 'movement',
      operatingUnits: workers,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.levelAfter).toBe(2)
      expect(result.data.immobileUnitIds).toEqual(['w1'])
      expect(result.data.rule).toBe('15.4')
    }
  })

  it('15.4：非移动阶段 / 每阶段一次 / 15.0c：不得低于 1 级', () => {
    const base = {
      side: 'axis' as Side,
      base: makeBase({ hex: TARGET, level: 2 }),
      operatingUnits: workers,
    }
    expect(planAirBaseReduction({ ...base, phase: 'combat' })).toMatchObject({
      ok: false,
      reason: 'reductionOnlyInMovementPhase',
    })
    expect(
      planAirBaseReduction({
        ...base,
        phase: 'movement',
        base: makeBase({ hex: TARGET, level: 2, reducedThisPhase: true }),
      }),
    ).toMatchObject({ ok: false, reason: 'baseAlreadyReducedThisPhase' })
    expect(
      planAirBaseReduction({
        ...base,
        phase: 'movement',
        base: makeBase({ hex: TARGET, level: 1 }),
      }),
    ).toMatchObject({ ok: false, rule: '15.0c', reason: 'airBaseLevelCannotGoBelowOne' })
  })
})

/* ────────────────────────────── 14.2f A–G 交互状态机 ────────────────────────────── */

describe('14.2f A–G：任务交互状态机', () => {
  const bases = [makeBase({ hex: TARGET })]
  const plane = makePlane({ id: 'p1', baseHex: TARGET })

  const begin = (): AirInteractionState => {
    const result = beginAirInteraction(missionRequest({ aircraft: [plane], bases }))
    if (!result.ok) throw new Error('任务分配应当成功')
    return result.data
  }

  it('步骤清单为 14.2f 的 A–G + 结束，且 `step` 表示下一步待办', () => {
    expect(AIR_INTERACTION_STEPS).toEqual([
      'declare',
      'move',
      'airCombat',
      'interception',
      'flak',
      'resolveMission',
      'returnToBase',
      'done',
    ])
    const state = begin()
    expect(state.step).toBe('airCombat')
    expect(hasReachedAirInteractionStep(state, 'airCombat')).toBe(true)
    expect(hasReachedAirInteractionStep(state, 'interception')).toBe(false)
    expect(airInteractionChecklist(state).map((item) => item.done)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
  })

  it('任务分配失败时不会进入流程（原因码透传）', () => {
    expect(
      beginAirInteraction(
        missionRequest({
          aircraft: [makePlane({ id: 'p1', baseHex: TARGET, airStatus: 'inactive' })],
          bases,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'aircraftNotActive:p1' })
  })

  it('步骤顺序不可颠倒（未到该步即被拒）', () => {
    const state = begin()
    expect(
      declareInterceptionStep(state, {
        response: planInterceptionResponse({
          side: 'soviet',
          missionKind: 'barrage',
          missionHex: TARGET,
          alreadyIntercepted: false,
          aircraft: [],
          bases,
        }),
        declared: false,
      }),
    ).toMatchObject({ ok: false, reason: 'notAtInterceptionStep:airCombat' })
    expect(confirmMissionStep(state, { note: 'x' })).toMatchObject({
      ok: false,
      reason: 'notAtResolveMissionStep:airCombat',
    })
    expect(
      resolveFlakStep(state, { inEnemyPatrolZone: false, missionAircraft: [], die2d6: 12 }),
    ).toMatchObject({ ok: false, reason: 'notAtFlakStep:airCombat' })
    expect(completeAirReturnStep(state, { returns: [], bases })).toMatchObject({
      ok: false,
      reason: 'notAtReturnToBaseStep:airCombat',
    })
  })

  it('14.2f A–G 走通：空战（无敌方基地⇒不发生）→ 拦截（不拦）→ 防空 → 结算 → 返航', () => {
    let state = begin()

    // C 空战：任务格内没有敌方空军基地 ⇒ 不发生（14.3）
    const combat = declareAirCombatStep(state, {
      friendlyAircraft: [plane],
      enemyActiveCount: 1,
      enemyCanInitiate: true,
      enemyAirBaseInHex: false,
    })
    expect(combat.ok).toBe(true)
    if (!combat.ok) return
    state = combat.data.state
    expect(state.combat).toMatchObject({ occurs: false, enemyAirBaseInHex: false })
    expect(state.step).toBe('interception')

    // D 拦截：拦截方（苏方）没有战斗机 ⇒ 不合格，选择「不拦截」
    const response = planInterceptionResponse({
      side: 'soviet',
      missionKind: 'barrage',
      missionHex: TARGET,
      alreadyIntercepted: false,
      aircraft: [],
      bases,
    })
    const interception = declareInterceptionStep(state, { response, declared: false })
    expect(interception.ok).toBe(true)
    if (!interception.ok) return
    state = interception.data.state
    expect(state.interception).toMatchObject({ declared: false, interceptorId: null })
    expect(state.step).toBe('flak')

    // E 防空：2 骰 12 ⇒ 命中（14.4e）
    const flak = resolveFlakStep(state, {
      inEnemyPatrolZone: false,
      missionAircraft: [{ id: 'p1', barrageStrength: 4 }],
      die2d6: 12,
    })
    expect(flak.ok).toBe(true)
    if (!flak.ok) return
    state = flak.data.state
    expect(flak.data.flak).toMatchObject({ hit: true, lossAircraftId: 'p1' })
    expect(state.step).toBe('resolveMission')

    // F 结算任务（结果由调用方写入）
    const resolved = confirmMissionStep(state, { note: '轰炸：格值 DG' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    state = resolved.data.state
    expect(state.missionNote).toBe('轰炸：格值 DG')
    expect(state.step).toBe('returnToBase')

    // G 返航：回本方基地 ⇒ 常规任务变为非激活
    const returned = completeAirReturnStep(state, {
      returns: [{ aircraftId: 'p1', baseHex: TARGET }],
      bases,
    })
    expect(returned.ok).toBe(true)
    if (!returned.ok) return
    expect(returned.data.inactiveAircraftIds).toEqual(['p1'])
    expect(returned.data.state.step).toBe('done')
    expect(returned.data.state.finished).toBe(true)
  })

  it('14.1c：返航目的地必须是**本方**基地、且在该机航程内（★ 归属权）', () => {
    const atReturn = advanceToReturn(begin(), plane, bases)
    // 目的地不是空军基地
    expect(
      completeAirReturnStep(atReturn, {
        returns: [{ aircraftId: 'p1', baseHex: hex(1, 1) }],
        bases,
      }),
    ).toMatchObject({ ok: false, rule: '14.1c', reason: 'returnHexNotAirBase:p1' })
    // 目的地是敌方基地
    expect(
      completeAirReturnStep(atReturn, {
        returns: [{ aircraftId: 'p1', baseHex: TARGET }],
        bases: [makeBase({ hex: TARGET, side: 'soviet' })],
      }),
    ).toMatchObject({ ok: false, rule: '14.1c', reason: 'returnToEnemyAirBase:p1' })
    // 未知飞机
    expect(
      completeAirReturnStep(atReturn, {
        returns: [{ aircraftId: 'nope', baseHex: TARGET }],
        bases,
      }),
    ).toMatchObject({ ok: false, reason: 'unknownMissionAircraft:nope' })

    // 目的地超出该机航程（距离自**任务格**起算）：航程 = 该基地距离 − 1
    const farBase = makeBase({ hex: FAR })
    const distance = hexDistance(TARGET, FAR)
    const shortRangePlane = makePlane({
      id: 'p1',
      baseHex: TARGET,
      rangeHexes: distance - 1,
    })
    const shortState = advanceToReturn(
      beginPlane(shortRangePlane, [makeBase({ hex: TARGET })]),
      shortRangePlane,
      [makeBase({ hex: TARGET })],
    )
    expect(
      completeAirReturnStep(shortState, {
        returns: [{ aircraftId: 'p1', baseHex: FAR }],
        bases: [farBase],
      }),
    ).toMatchObject({
      ok: false,
      rule: '14.1c',
      reason: `returnOutOfRange:p1:${distance}>${distance - 1}`,
    })
  })

  it('14.1c 例外：成功拦截的战斗机返航后保持激活（由调用方声明）', () => {
    const atReturn = advanceToReturn(begin(), plane, bases)
    const returned = completeAirReturnStep(atReturn, {
      returns: [{ aircraftId: 'p1', baseHex: TARGET }],
      bases,
      stayActiveIds: ['p1'],
    })
    expect(returned.ok).toBe(true)
    if (returned.ok) expect(returned.data.inactiveAircraftIds).toEqual([])
  })

  it('14.5：候选拦截机不合法即拒（且未声明拦截时不需要机）', () => {
    const state = begin()
    const combat = declareAirCombatStep(state, {
      friendlyAircraft: [plane],
      enemyActiveCount: 0,
      enemyCanInitiate: false,
      enemyAirBaseInHex: false,
    })
    if (!combat.ok) throw new Error('空战步失败')
    const eligible = {
      eligible: true,
      eligibleFighterIds: ['f1'],
      rule: '14.5',
      detail: '',
    }
    expect(
      declareInterceptionStep(combat.data.state, {
        response: eligible,
        declared: true,
        interceptorId: 'f2',
      }),
    ).toMatchObject({ ok: false, reason: 'interceptorNotEligible:f2' })
    expect(
      declareInterceptionStep(combat.data.state, { response: eligible, declared: true }),
    ).toMatchObject({ ok: false, reason: 'interceptorNotChosen' })
    expect(
      declareInterceptionStep(combat.data.state, {
        response: {
          ...eligible,
          eligible: false,
          eligibleFighterIds: [],
          reason: 'missionHexOutsidePatrolZone',
        },
        declared: true,
        interceptorId: 'f1',
      }),
    ).toMatchObject({ ok: false, reason: 'missionHexOutsidePatrolZone' })
  })
})

/**
 * 14.3e-B：**逐轮点名**（攻方非括号机 / 守方任选 / 未点名取 ACV 最高）
 *
 * 原文 B：「**攻击方**（14.3c）选择他的一个**非括号**的空军单位，然后**防御方选择任意一个**
 * 他的空军单位。这些就是**当前战斗轮**中使用的飞机」；D：「对相同或不同的飞机们**重复 B 和 C 步骤**
 * （为每对进行一轮战斗），直到一方或另一方在该格内成为唯一的一方」。
 *
 * ★ 一条**测法边界（如实）**：这里只用**合成机队**（`{ id, airCombatRating, canInitiateAirCombat }`）
 *   钉"点名被采纳 / 缺省取 ACV 最高 / 非法点名被拒"这三件事，**不**覆盖"点名与盘面机队一致"
 *   （那要 store 的场次夹具，归 `tests/stores/air-interaction-flow.test.ts`）；骰面用固定值注入，
 *   故结论可复算（不依赖 RNG）。
 */
describe('14.3e-B：逐轮点名（picks）', () => {
  const plane = (id: string, airCombatRating: number, canInitiateAirCombat = true) => ({
    id,
    airCombatRating,
    canInitiateAirCombat,
  })
  /** 固定骰面：够跑满 6 轮（每轮 2 骰 + 损失骰） */
  const DICE = Array.from({ length: 6 }, () => ({ die: 4, lossDie: 3 }))

  it('★ 攻方点名被采纳（点名的那一架就是本轮参战的那一架）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      // a1 的 ACV 更高 ⇒ 不点名时引擎会取 a1，故"取到 a2"只可能是点名生效
      attackerAircraft: [plane('a1', 4), plane('a2', 2)],
      defenderAircraft: [plane('d1', 3)],
      dice: DICE,
      picks: [{ attackerAircraftId: 'a2', defenderAircraftId: 'd1' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rounds[0]?.attackerAircraftId).toBe('a2')
    expect(result.data.rounds[0]?.defenderAircraftId).toBe('d1')
  })

  it('★ 未点名 ⇒ 双方各取 **ACV 最高**（引擎的缺省口径）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [plane('a1', 4), plane('a2', 2)],
      defenderAircraft: [plane('d1', 3), plane('d2', 1)],
      dice: DICE,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rounds[0]?.attackerAircraftId).toBe('a1')
    expect(result.data.rounds[0]?.defenderAircraftId).toBe('d1')
  })

  it('★ 攻方**不得**点名括号值的飞机（14.3a / 14.3e-B）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [plane('a1', 4), plane('a2', 2, false)],
      defenderAircraft: [plane('d1', 3)],
      dice: DICE,
      picks: [{ attackerAircraftId: 'a2' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rule).toBe('14.3e-B')
    expect(result.reason).toBe('attackerMustPickNonBracketedAircraft:a2')
  })

  it('★ 守方**任选**：连括号值的飞机也能被点名迎战', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [plane('a1', 4)],
      defenderAircraft: [plane('d1', 3), plane('d2', 1, false)],
      dice: DICE,
      picks: [{ defenderAircraftId: 'd2' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rounds[0]?.defenderAircraftId).toBe('d2')
  })

  it('★ 点名不在场的飞机 ⇒ 拒绝（守方那一侧给的是"找不到"）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [plane('a1', 4)],
      defenderAircraft: [plane('d1', 3)],
      dice: DICE,
      picks: [{ defenderAircraftId: '不存在' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('defenderAircraftNotFound:不存在')
  })

  it('★ 攻方无可发起空战的飞机 ⇒ 直接结束（14.3a：互不理睬），不给骰面也成立', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [plane('a1', 2, false)],
      defenderAircraft: [plane('d1', 3)],
      dice: DICE,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rounds).toHaveLength(0)
    expect(result.data.stopReason).toBe('noCombatCapability')
  })
})

/* ────────── B44（14.9e）：空运/空投的三种飞法（逐机判定） ────────── */

/**
 * 原文 **14.9e**：「空运任务可飞往任何友方空军基地。**将每个飞机分开处理**，任务格可以……
 *   A) 任务格可以在**飞机距离的两倍**内，前提是飞机在**目的地空军基地变为非激活**，或
 *   B) 任务格可以在飞机的**正常距离**内……或
 *   C) 任务格可以在**飞机距离的一半**内，在这种情况下，飞机的**运输容量将翻倍**，
 *      并返回其**距离一半内**的基地。」
 *
 * 测法边界：本组只钉**档位判据**（距离∶航程 ⇒ 档位、容量倍率、返航上限、是否在目的地变非激活）；
 *   "容量倍率如何进任务总量"与"1 格距离的整条任务链"由既有 14.2f-A/B 组与 store 的用例覆盖。
 */
describe('B44（14.9e）：空运/空投的三种飞法', () => {
  it('★ 半程内 ⇒ C 档（容量翻倍、返航限半程）；正常距离内 ⇒ B 档；再远 ⇒ A 档（目的地变非激活）', () => {
    // C 档：距离 ≤ 航程一半
    expect(airTransportProfile({ distanceHexes: 3, rangeHexes: 10 })).toMatchObject({
      profile: 'C',
      capacityMultiplier: 2,
      endsInactiveAtDestination: false,
      returnRangeHexes: 5,
    })
    // 边界：正好一半 ⇒ 仍是 C 档（原文"在飞机距离的一半内"含端点）
    expect(airTransportProfile({ distanceHexes: 5, rangeHexes: 10 }).profile).toBe('C')
    // B 档：一半 < 距离 ≤ 航程
    expect(airTransportProfile({ distanceHexes: 7, rangeHexes: 10 })).toMatchObject({
      profile: 'B',
      capacityMultiplier: 1,
      returnRangeHexes: 10,
    })
    // A 档：航程 < 距离 ≤ 两倍航程 ⇒ 双程飞法（在目的地空军基地变非激活、不返航）
    expect(airTransportProfile({ distanceHexes: 15, rangeHexes: 10 })).toMatchObject({
      profile: 'A',
      capacityMultiplier: 1,
      endsInactiveAtDestination: true,
      returnRangeHexes: 0,
    })
  })

  it('★ 超出两倍航程 ⇒ 去不了（profile 为 null，容量倍率退回 1）', () => {
    const beyond = airTransportProfile({ distanceHexes: 21, rangeHexes: 10 })
    expect(beyond.profile).toBeNull()
    expect(beyond.capacityMultiplier).toBe(1)
    expect(beyond.detail).toContain('两倍')
  })
})

/* ────────────────────────────── 14.9c / 14.9e（第五批批 C 切片 2） ────────────────────────────── */

describe('14.9c / 14.9e：空运的货物资格与返航档位（第五批批 C 切片 2）', () => {
  /*
   * 14.9c：「补给点数可以被空运，处于**移动模式**的战斗单位也可以空运，
   *   前提是其 MA 为 **10 或以下的步行 MP**。」
   * 14.9e：空运任务的三档飞法（A 双程变非激活 / B 正常 / C 半程容量翻倍），
   *   返航距离按**档位**收紧（C 档限半程；A 档不返航）。
   * ★ 测法边界：本文件不读地图 —— 坐标可出图内（距离一律用 hexDistance 表达）；
   *   运输机 range 60 ⇒ C 档 ≤30、B 档 (30,60]、A 档 (60,120]。
   */
  type TransportOver = Partial<Omit<Parameters<typeof makePlane>[0], 'id' | 'baseHex'>> & {
    id?: string
    baseHex?: HexRef
  }
  const transport = (over: TransportOver = {}) =>
    makePlane({
      ...over,
      id: over.id ?? 'p1',
      baseHex: over.baseHex ?? hex(36, 33),
      aircraftType: 'Tpt',
      transportCapacity: 2,
      rangeHexes: 60,
    })

  const beginTransport = (
    plane: AirMissionAircraftView,
    over: { cargo?: readonly AirMissionCargo[] } = {},
  ): AirInteractionState => {
    const result = beginAirInteraction(
      missionRequest({
        kind: 'air_transport',
        aircraft: [plane],
        bases: [makeBase({ hex: plane.baseHex })],
        ...over,
      }),
    )
    if (!result.ok) throw new Error('任务分配应当成功：' + result.reason)
    return result.data
  }

  it('14.9c：空运的单位货物须**移动模式**、且**步行 MA ≤ 10**', () => {
    const plane = transport({})
    const bases = [makeBase({ hex: plane.baseHex })]
    const unitCargo = (over: Partial<AirMissionCargo>): AirMissionCargo => ({
      id: 'u1',
      kind: 'unit',
      isCombat: true,
      ma: 3,
      mode: 'combat',
      ...over,
    })
    // ① 战斗模式 ⇒ 拒（修前过）
    expect(
      beginAirInteraction(
        missionRequest({ kind: 'air_transport', aircraft: [plane], bases, cargo: [unitCargo({})] }),
      ),
    ).toMatchObject({ ok: false, rule: '14.9c', reason: 'cargoUnitNotInMoveMode:u1' })
    // ② 移动模式 + 步行 MA 3 ⇒ 过
    expect(
      beginAirInteraction(
        missionRequest({
          kind: 'air_transport',
          aircraft: [plane],
          bases,
          cargo: [unitCargo({ mode: 'move' })],
        }),
      ).ok,
    ).toBe(true)
    // ③ 移动模式但步行 MA 12 ⇒ 拒（判据层真值表；本作数据战斗面 MA 全 ≤10，故只能在此层钉）
    expect(
      beginAirInteraction(
        missionRequest({
          kind: 'air_transport',
          aircraft: [plane],
          bases,
          cargo: [unitCargo({ mode: 'move', ma: 12 })],
        }),
      ),
    ).toMatchObject({ ok: false, rule: '14.9c', reason: 'cargoUnitMaAboveTen:u1' })
  })

  it('14.9e-C：半程档（距离 ≤ range/2）返航限半程 ⇒ 超出即拒、半程内放行', () => {
    const plane = transport({}) // hex(36,33) 距 TARGET(36,13) 20 ⇒ C 档（≤30）
    const farBase = makeBase({ hex: hex(36, 73) }) // 距 TARGET 60 > 30
    const nearBase = makeBase({ hex: hex(36, 43) }) // 距 TARGET 30 ＝限值
    const atReturn = advanceToReturn(beginTransport(plane), plane, [
      makeBase({ hex: plane.baseHex }),
    ])
    expect(
      completeAirReturnStep(atReturn, {
        returns: [{ aircraftId: 'p1', baseHex: farBase.hex }],
        bases: [farBase],
      }),
    ).toMatchObject({
      ok: false,
      rule: '14.9e-C',
      reason: 'returnBeyondProfileRange:p1:60>30',
    })
    expect(
      completeAirReturnStep(atReturn, {
        returns: [{ aircraftId: 'p1', baseHex: nearBase.hex }],
        bases: [nearBase],
      }).ok,
    ).toBe(true)
  })

  it('14.9e-A：双程档不得返航 ⇒ 出现在 returns 即拒；缺省时列入 stayedAircraftIds', () => {
    const plane = transport({ baseHex: hex(36, 113) }) // 距 TARGET 100 ⇒ A 档（(60,120]）
    const bases = [makeBase({ hex: plane.baseHex })]
    const atReturn = advanceToReturn(beginTransport(plane), plane, bases)
    expect(
      completeAirReturnStep(atReturn, {
        returns: [{ aircraftId: 'p1', baseHex: plane.baseHex }],
        bases,
      }),
    ).toMatchObject({
      ok: false,
      rule: '14.9e-A',
      reason: 'twoWayAircraftMustStayAtDestination:p1',
    })
    const done = completeAirReturnStep(atReturn, { returns: [], bases })
    expect(done.ok).toBe(true)
    if (done.ok) expect(done.data.stayedAircraftIds).toEqual(['p1'])
  })

  it('14.9e 不影响非运输任务：轰炸返航仍按 14.2d 的正常航程', () => {
    const plane = makePlane({ id: 'p1', baseHex: hex(36, 33), rangeHexes: 60 })
    const farBase = makeBase({ hex: hex(36, 73) }) // 距 TARGET 60 ≤ range ⇒ 仍可返航
    const atReturn = advanceToReturn(beginPlane(plane, [makeBase({ hex: plane.baseHex })]), plane, [
      makeBase({ hex: plane.baseHex }),
    ])
    expect(
      completeAirReturnStep(atReturn, {
        returns: [{ aircraftId: 'p1', baseHex: farBase.hex }],
        bases: [farBase],
      }).ok,
    ).toBe(true)
  })
})

/* ────────────────────────────── 14.7d-B（第五批批 C 切片 3） ────────────────────────────── */

describe('14.7d-B：低空扫射必须由单独一个飞机完成（第五批批 C 切片 3）', () => {
  const hipShooter = (id: string) => makePlane({ id, baseHex: TARGET, canHipShoot: true })
  const hipBases = [makeBase({ hex: TARGET })]

  it('两机扫射 ⇒ 拒（14.7d-B）；单机 ⇒ 放行', () => {
    expect(
      beginAirInteraction(
        missionRequest({
          kind: 'hip_shoot',
          aircraft: [hipShooter('p1'), hipShooter('p2')],
          bases: hipBases,
        }),
      ),
    ).toMatchObject({ ok: false, rule: '14.7d-B', reason: 'hipShootMustBeSingleAircraft:2' })
    expect(
      beginAirInteraction(
        missionRequest({ kind: 'hip_shoot', aircraft: [hipShooter('p1')], bases: hipBases }),
      ).ok,
    ).toBe(true)
  })
})
