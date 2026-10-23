import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import {
  assignAirMission,
  extenderIsASupplySource,
  hasVillageOrCity,
  railSupplyPath,
  resolveAirCargoDrop,
  resolveAirCombatRounds,
  type AirBaseView,
  type AirMissionAircraftView,
  type AirMissionCargo,
  type AirMissionKind,
  type RailSupplyFacts,
  type SupplyMobility,
} from '@/engine/rules'
import type { GamePhase } from '@/engine/state-types'

/**
 * C9 补全部分的条款级测试（14.3e 逐轮空战 / 14.10 空投 / 12.7a-B/C + 13.3c 铁路卸货格）
 *
 * 全部用注入式夹具与**手给骰面**，不读真实地图，逐条对到规则章节。
 */

const hex = (col: number, row: number): HexRef => ({ col, row })
const at = (row: number): HexRef => hex(36, row)
const TARGET = at(13)

function plane(
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
    ...(overrides.transportCapacity === undefined
      ? {}
      : { transportCapacity: overrides.transportCapacity }),
    ...overrides,
  }
}

const ownBase: AirBaseView = { id: 'base-1', hex: TARGET, side: 'axis', level: 2 }

/* ────────────────────────────── 14.3e 逐轮空战 ────────────────────────────── */

describe('14.3e：空战逐轮推进', () => {
  it('单轮：修正骰 ≤6 ⇒ 攻击方返航；一方清空即结束（14.3e-D）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [{ id: 'a1', airCombatRating: 3, canInitiateAirCombat: true }],
      defenderAircraft: [{ id: 'd1', airCombatRating: 3, canInitiateAirCombat: true }],
      dice: [{ die: 5, lossDie: 2 }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rounds).toHaveLength(1)
    expect(result.data.rounds[0]).toMatchObject({
      round: 1,
      attackerAircraftId: 'a1',
      defenderAircraftId: 'd1',
      modifiedRoll: 5,
      abortSide: 'attacker',
      returnedAttackerIds: ['a1'],
      returnedDefenderIds: [],
      lossRoll: 2,
      stepLossIds: [],
    })
    expect(result.data.stopReason).toBe('oneSideOnly')
    expect(result.data.survivingAttackerIds).toEqual([])
    expect(result.data.survivingDefenderIds).toEqual(['d1'])
  })

  it('多轮：逐轮消耗到一方清空（14.3e-D 每对一轮）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [
        { id: 'a1', airCombatRating: 5, canInitiateAirCombat: true },
        { id: 'a2', airCombatRating: 4, canInitiateAirCombat: true },
      ],
      defenderAircraft: [
        { id: 'd1', airCombatRating: 1, canInitiateAirCombat: true },
        { id: 'd2', airCombatRating: 1, canInitiateAirCombat: true },
      ],
      // 9 + 5 − 1 = 13 ≥ 8 ⇒ 守方返航；第二轮同理
      dice: [
        { die: 9, lossDie: 3 },
        { die: 9, lossDie: 6 },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rounds).toHaveLength(2)
    expect(result.data.rounds[1]?.stepLossIds).toEqual(['d2']) // 损失骰 6 ⇒ 返航者损失军力
    expect(result.data.survivingAttackerIds).toEqual(['a1', 'a2'])
    expect(result.data.survivingDefenderIds).toEqual([])
    expect(result.data.stopReason).toBe('oneSideOnly')
  })

  it('14.3a：双方都只剩括号空战值 ⇒ 不掷骰即结束（互不理睬）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [{ id: 'a1', airCombatRating: 2, canInitiateAirCombat: false }],
      defenderAircraft: [{ id: 'd1', airCombatRating: 1, canInitiateAirCombat: false }],
      dice: [{ die: 12 }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rounds).toEqual([])
    expect(result.data.stopReason).toBe('noCombatCapability')
    expect(result.data.survivingAttackerIds).toEqual(['a1'])
    expect(result.data.survivingDefenderIds).toEqual(['d1'])
  })

  it('14.3e-B：攻击方只能点**非括号**的飞机（点名括号机即拒）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [
        { id: 'a1', airCombatRating: 3, canInitiateAirCombat: true },
        { id: 'a2', airCombatRating: 2, canInitiateAirCombat: false },
      ],
      defenderAircraft: [{ id: 'd1', airCombatRating: 1, canInitiateAirCombat: true }],
      dice: [{ die: 9 }],
      picks: [{ attackerAircraftId: 'a2' }],
    })
    expect(result).toMatchObject({
      ok: false,
      rule: '14.3e-B',
      reason: 'attackerMustPickNonBracketedAircraft:a2',
    })
  })

  it('14.3e-B：防守方可点**任意**一架（含括号空战值）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [{ id: 'a1', airCombatRating: 4, canInitiateAirCombat: true }],
      defenderAircraft: [
        { id: 'd1', airCombatRating: 5, canInitiateAirCombat: true },
        { id: 'd2', airCombatRating: 1, canInitiateAirCombat: false },
      ],
      dice: [{ die: 9, lossDie: 1 }],
      picks: [{ attackerAircraftId: 'a1', defenderAircraftId: 'd2' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rounds[0]).toMatchObject({ defenderAircraftId: 'd2', abortSide: 'defender' })
  })

  it('骰面用尽时停下并说明（调用方需继续供给骰面）', () => {
    const result = resolveAirCombatRounds({
      attackerSide: 'axis',
      attackerAircraft: [{ id: 'a1', airCombatRating: 9, canInitiateAirCombat: true }],
      defenderAircraft: [{ id: 'd1', airCombatRating: 1, canInitiateAirCombat: true }],
      dice: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rounds).toEqual([])
    expect(result.data.stopReason).toBe('diceExhausted')
  })
})

/* ────────────────────────────── 14.10 空投货物与计划 ────────────────────────────── */

describe('14.10a/14.10b：空投的货物资格与计划', () => {
  const transport = plane({
    id: 'tp1',
    baseHex: TARGET,
    aircraftType: 'Tpt',
    transportCapacity: 3,
    canBarrage: false,
  })

  const request = (overrides: {
    kind?: AirMissionKind
    phase?: GamePhase
    /* 第五批批 C 切片 2：直接沿用引擎的货物类型（含 14.9c 的 mode/ma 字段） */
    cargo?: AirMissionCargo[]
    airdropPlan?: {
      targetHex: HexRef
      plannedTurn: number
      scheduledTurn: number
      currentTurn: number
    }
    side?: Side
  }) =>
    assignAirMission({
      side: overrides.side ?? 'axis',
      phase: overrides.phase ?? 'movement',
      kind: overrides.kind ?? 'air_drop',
      targetHex: TARGET,
      flyingAllowed: true,
      aircraft: [transport],
      bases: [ownBase],
      ...(overrides.cargo === undefined ? {} : { cargo: overrides.cargo }),
      ...(overrides.airdropPlan === undefined ? {} : { airdropPlan: overrides.airdropPlan }),
    })

  it('14.10a：只有 SP 与标有「空降/Para」的**战斗单位**可空投', () => {
    /*
     * ★ 契约变更（第五批批 C 切片 2，**收紧不是放宽**）：14.9c「处于移动模式的战斗单位也可以空运」
     *   ⇒ 单位货物先过 14.9c（模式 + 步行 MP）再看 14.10a 的 Para 资格 —— 夹具补上前者。
     */
    expect(
      request({
        cargo: [
          { id: 'c1', kind: 'unit', isCombat: true, paraCapable: false, mode: 'move', ma: 3 },
        ],
      }),
    ).toMatchObject({ ok: false, rule: '14.10a', reason: 'cargoNotParaCapable:c1' })
    // 非战斗单位（如补给点）不得空投
    expect(
      request({
        cargo: [
          { id: 'c2', kind: 'unit', isCombat: false, paraCapable: true, mode: 'move', ma: 3 },
        ],
      }),
    ).toMatchObject({ ok: false, rule: '14.10a', reason: 'cargoNotParaCapable:c2' })
    // SP 空投合法，且**不需要计划**（14.10b 重要提示：补给空投从不需要预先计划）
    expect(request({ cargo: [{ id: 'c3', kind: 'sp', t: 2 }] }).ok).toBe(true)
  })

  it('14.10b：空投战斗单位须在移动阶段且须有计划、提前两回合', () => {
    // ★ 契约变更（第五批批 C 切片 2）：同上 —— 单位货物先过 14.9c 的"移动模式 + 步行 MP"
    const paraUnit = {
      id: 'u1',
      kind: 'unit' as const,
      isCombat: true,
      paraCapable: true,
      mode: 'move' as const,
      ma: 3,
    }
    expect(request({ cargo: [paraUnit] })).toMatchObject({
      ok: false,
      rule: '14.10b',
      reason: 'plannedAirdropRequiresPlan',
    })
    // 14.10b：空投战斗单位只能在**移动阶段**（反应/进击阶段虽可执行其它任务，但不得空投单位）
    expect(request({ phase: 'reaction', cargo: [paraUnit] })).toMatchObject({
      ok: false,
      rule: '14.10b',
      reason: 'plannedAirdropOnlyInMovementPhase',
    })
    // 只提前 1 回合 ⇒ 太晚
    expect(
      request({
        cargo: [paraUnit],
        airdropPlan: { targetHex: TARGET, plannedTurn: 4, scheduledTurn: 5, currentTurn: 5 },
      }),
    ).toMatchObject({ ok: false, reason: 'airdropPlanTooLate:1' })
    // 计划格不符
    expect(
      request({
        cargo: [paraUnit],
        airdropPlan: { targetHex: at(20), plannedTurn: 3, scheduledTurn: 5, currentTurn: 5 },
      }),
    ).toMatchObject({ ok: false, reason: 'airdropPlanTargetMismatch' })
    // 提前两回合且执行回合＝计划回合 ⇒ 合法
    const ok = request({
      cargo: [paraUnit],
      airdropPlan: { targetHex: TARGET, plannedTurn: 3, scheduledTurn: 5, currentTurn: 5 },
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.data.cargo).toHaveLength(1)
      /* B44（14.9e-C）：本夹具的任务格就在起飞基地上（距离 0 ≤ 航程一半）⇒ 容量翻倍（3 → 6） */
      expect(ok.data.cargoCapacity).toBe(6)
    }
  })

  it('14.9a：装载量不得超过总运输容量', () => {
    /*
     * B44（14.9e-C）：本夹具的任务格距起飞基地 0 格 ≤ 航程一半 ⇒ 该机容量**翻倍**（3 → 6），
     * 故"超载"的样本量取 **7 T**（修前写的是 4 T —— 那是容量恒为印值 3 的旧口径）。
     */
    expect(request({ cargo: [{ id: 'c1', kind: 'sp', t: 7 }] })).toMatchObject({
      ok: false,
      rule: '14.9a',
      reason: 'cargoExceedsCapacity:7>6',
    })
  })
})

describe('14.10d：空投/空运成功检定（表 17-4）', () => {
  const cargo = [
    { id: 'c1', kind: 'sp' as const, t: 1 },
    { id: 'c2', kind: 'sp' as const, t: 1 },
  ]

  it('逐件掷 2 骰：成功置入、失败摧毁', () => {
    const result = resolveAirCargoDrop({
      cargo,
      friendlyAtPhaseStart: true,
      closedTerrain: false,
      side: 'axis',
      dice: [5, 4], // 己方 Clear 需 5+
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0]).toMatchObject({ id: 'c1', success: true, fate: 'placed' })
    expect(result.data.items[1]).toMatchObject({ id: 'c2', success: false, fate: 'destroyed' })
  })

  it('表 17-4 DRM：苏军空投 −1、滑翔机 +1、可选 21.12e 地形', () => {
    const soviet = resolveAirCargoDrop({
      cargo: [cargo[0]!],
      friendlyAtPhaseStart: true,
      closedTerrain: false,
      side: 'soviet',
      dice: [5],
    })
    expect(soviet.ok).toBe(true)
    if (soviet.ok) expect(soviet.data.items[0]).toMatchObject({ modified: 4, success: false })

    const glider = resolveAirCargoDrop({
      cargo: [cargo[0]!],
      friendlyAtPhaseStart: true,
      closedTerrain: true, // Friendly+Closed 需 6+
      side: 'axis',
      glider: true,
      dice: [5],
    })
    expect(glider.ok).toBe(true)
    if (glider.ok) expect(glider.data.items[0]).toMatchObject({ modified: 6, success: true })

    const terrain = resolveAirCargoDrop({
      cargo: [cargo[0]!],
      friendlyAtPhaseStart: true,
      closedTerrain: false,
      side: 'axis',
      optionalTerrainDrm: -2,
      dice: [5],
    })
    expect(terrain.ok).toBe(true)
    if (terrain.ok) expect(terrain.data.items[0]).toMatchObject({ modified: 3, success: false })
  })

  it('14.10d：降在**敌方战斗单位**上的货物一律摧毁（无视掷骰）', () => {
    const result = resolveAirCargoDrop({
      cargo: [cargo[0]!],
      friendlyAtPhaseStart: false,
      closedTerrain: false,
      side: 'axis',
      enemyCombatUnitInHex: true,
      dice: [12],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0]).toMatchObject({ success: false, fate: 'destroyed' })
    expect(result.data.destroyedOnEnemyCombatUnitIds).toEqual(['c1'])
  })

  it('骰面缺件即拒（每件必须各掷一次）', () => {
    expect(
      resolveAirCargoDrop({
        cargo,
        friendlyAtPhaseStart: true,
        closedTerrain: false,
        side: 'axis',
        dice: [5],
      }),
    ).toMatchObject({ ok: false, rule: '14.10d', reason: 'missingCargoDice:c2' })
  })
})

/* ────────────────────────────── 12.7a-B/C + 13.3c 铁路卸货格 ────────────────────────────── */

/** 一条竖列铁路 36.0–36.1–36.2…（格边有轨）；`breaks` 里的格与其余格断开 */
function railFacts(input: {
  railRows: readonly number[]
  /** 铁路格边断开处：`[上格行, 下格行]` 对之间不再有轨 */
  breaks?: readonly (readonly [number, number])[]
  sources: readonly HexRef[]
  cities?: readonly number[]
  controlled?: (hex: HexRef) => boolean
  zoc?: readonly HexRef[]
  extenders?: readonly { hex: HexRef; rangeMp: number; mobility?: SupplyMobility }[]
  /**
   * 覆盖 12.7b 的回连判定（默认按本夹具的走廊：每步 1 MP ⇒ MP 距离＝格距）
   *
   * 用于钉住「`rail-supply` 只按注入的判定决定回连」——若有人把格数距离逻辑加回去，
   * 下面那条守门用例会立刻变红。
   */
  connectsBack?: (input: { extenderHex: HexRef; hex: HexRef; rangeMp: number }) => boolean
  /**
   * 13.3f：轨距不可用的格（默认全部可用）
   *
   * 生产上这是「苏宽轨／德标准轨」的逐格账面状态；本夹具用它测「轨距把铁路路径切断」这一条。
   */
  gaugeUnusable?: readonly HexRef[]
  /** 13.3f：按方给轨距可用性（优先于 `gaugeUnusable`；用于测「双方结论相反」） */
  gaugeUsable?: (hex: HexRef, side: Side) => boolean
  side?: Side
}): RailSupplyFacts {
  const side = input.side ?? 'axis'
  const railSet = new Set(input.railRows)
  const citySet = new Set(input.cities ?? [])
  const zocSet = new Set((input.zoc ?? []).map((item) => `${item.col}.${item.row}`))
  const gaugeUnusableSet = new Set(
    (input.gaugeUnusable ?? []).map((item) => `${item.col}.${item.row}`),
  )
  const broken = new Set(
    (input.breaks ?? []).map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`),
  )
  return {
    terrainsPresentAt: (ref) => (citySet.has(ref.row) ? ['Village'] : ['Open']),
    isControlledBy: (ref) => (input.controlled === undefined ? true : input.controlled(ref)),
    isRailHex: (ref) => ref.col === 36 && railSet.has(ref.row),
    railGaugeUsable: (ref, requested) =>
      input.gaugeUsable !== undefined
        ? input.gaugeUsable(ref, requested)
        : !gaugeUnusableSet.has(`${ref.col}.${ref.row}`),
    railNeighbors: (ref) => {
      if (ref.col !== 36) return []
      const found: HexRef[] = []
      for (const delta of [-1, 1]) {
        const row = ref.row + delta
        if (!railSet.has(row)) continue
        if (broken.has(`${Math.min(ref.row, row)}-${Math.max(ref.row, row)}`)) continue
        found.push(at(row))
      }
      return found
    },
    inUnnegatedEnemyZoc: (ref) => zocSet.has(`${ref.col}.${ref.row}`),
    baseSourceHexes: (requested) => (requested === side ? input.sources : []),
    extenderLinks: (requested) =>
      requested === side
        ? (input.extenders ?? []).map((item) => ({
            hex: item.hex,
            rangeMp: item.rangeMp,
            mobility: item.mobility ?? 'truck',
          }))
        : [],
    /*
     * 12.7b：本夹具的走廊每步 1 MP，故 MP 距离＝格距（成本模型由夹具自持）；
     * 生产代码里这一项由 `trace-supply.extenderConnectsBack` 按地形成本给出。
     */
    extenderConnectsBack: (call) =>
      input.connectsBack === undefined
        ? hexDistance(call.extenderHex, call.hex) <= call.rangeMp
        : input.connectsBack(call),
  }
}

describe('13.3c + 12.7a-B/C：铁路补给线与火车卸货格', () => {
  it('13.3c：铁路可达 ∧ 村庄/城市 ∧ 受控 ∧ 无未抵消敌 ZOC ⇒ 火车卸货格', () => {
    const path = railSupplyPath(
      railFacts({
        railRows: [0, 1, 2, 3],
        sources: [at(0)],
        cities: [3],
        zoc: [at(1)], // 36.1 有敌方 ZOC ⇒ 铁路路径在此中断
      }),
      'axis',
    )
    expect(path.railReachableHexes.map((item) => item.row)).toEqual([0])
    expect(path.detrainableHexes).toEqual([])
    expect(path.rule).toBe('13.3c')
  })

  it('13.3c：未被抵消的敌 ZOC 断链；受控且为村庄者成为卸货格', () => {
    const path = railSupplyPath(
      railFacts({ railRows: [0, 1, 2, 3], sources: [at(0)], cities: [2] }),
      'axis',
    )
    expect(path.railReachableHexes.map((item) => item.row)).toEqual([0, 1, 2, 3])
    expect(path.detrainableHexes.map((item) => item.row)).toEqual([2])
    expect(hasVillageOrCity(['Village'])).toBe(true)
    expect(hasVillageOrCity(['Minor City'])).toBe(true)
    // 不被本方控制 ⇒ 不能作卸货格（13.3c②）
    const notControlled = railSupplyPath(
      railFacts({
        railRows: [0, 1, 2],
        sources: [at(0)],
        cities: [2],
        controlled: (ref) => ref.row !== 2,
      }),
      'axis',
    )
    expect(notControlled.detrainableHexes).toEqual([])
  })

  it('12.7a-B：延补队把后段铁路接到前段铁路，使前段铁路成为火车卸货格', () => {
    // 后段铁路 36.0–36.1（补给源在 36.0）；断口在 36.1 与 36.3 之间；
    // 延补队放在 36.2（12.7b：连接的前方），距离 20 MP ⇒ 够到后段
    const facts = railFacts({
      railRows: [0, 1, 3],
      breaks: [[1, 3]],
      sources: [at(0)],
      cities: [3],
      extenders: [{ hex: at(2), rangeMp: 20 }],
    })
    const path = railSupplyPath(facts, 'axis')
    // 沿铁路可达 0、1；经延补队（36.2）接上前段铁路 36.3
    expect(path.railReachableHexes.map((item) => item.row)).toEqual([0, 1, 2, 3])
    expect(path.usedExtenderHexes).toEqual([at(2)])
    expect(path.detrainableHexes.map((item) => item.row)).toEqual([3])
    expect(
      extenderIsASupplySource({
        extenderHex: at(2),
        rangeMp: 20,
        mobility: 'truck',
        side: 'axis',
        baseSourceHexes: [at(0)],
        detrainableHexes: [],
        facts,
      }),
    ).toBe(true)
  })

  it('12.7b 守门：rail-supply 的延补队回连**只**按注入的判定（不得自持格数距离）', () => {
    const build = (connects: boolean) =>
      railFacts({
        railRows: [0, 1, 3],
        breaks: [[1, 3]],
        sources: [at(0)],
        cities: [3],
        extenders: [{ hex: at(2), rangeMp: 20 }],
        connectsBack: () => connects,
      })

    // 判定为"连得上" ⇒ 延补队被采用、前段铁路接通
    const connected = railSupplyPath(build(true), 'axis')
    expect(connected.usedExtenderHexes).toEqual([at(2)])
    expect(connected.railReachableHexes.map((item) => item.row)).toEqual([0, 1, 2, 3])

    /*
     * 判定为"连不上" ⇒ 即使**格距**只有 1 格（远小于 rangeMp 20）也不得接通。
     * 这钉住了「唯一口径」：若有人把 `hexDistance ≤ rangeMp` 那套格数距离加回 rail-supply，
     * 本断言会立刻变红。
     */
    const rejected = railSupplyPath(build(false), 'axis')
    expect(rejected.usedExtenderHexes).toEqual([])
    expect(rejected.railReachableHexes.map((item) => item.row)).toEqual([0, 1])
  })

  it('13.3c：火车卸货格须**先是铁路格**——延补队所在的非铁路村庄格不算', () => {
    /*
     * 12.7a-B/C 的典型布置：延补队被放在断口前方的一个村庄/城市格里（12.7b「永远放在连接的前方」），
     * 而**该格本身不在铁路上**。它当然会被接进 `railReachableHexes`（延补队所在格即新的连接点），
     * 但 13.3c 的三条前置条件里第一条是「该格有**由铁路构成的路径**延伸至补给源」——
     * 格内没有任何铁路格边 ⇒ 不得成为火车卸货格，进而不构成 12.6a② 的补给源。
     */
    const path = railSupplyPath(
      railFacts({
        railRows: [0, 1, 3],
        breaks: [[1, 3]],
        sources: [at(0)],
        cities: [2, 3], // 36.2＝延补队所在且**非铁路格**；36.3＝铁路格
        extenders: [{ hex: at(2), rangeMp: 20 }],
      }),
      'axis',
    )
    // 延补队确实把 36.0–36.1 与 36.3 接通（否则本条用例测不到卸货格判定）
    expect(path.usedExtenderHexes).toEqual([at(2)])
    expect(path.railReachableHexes.map((item) => item.row)).toEqual([0, 1, 2, 3])
    const rows = path.detrainableHexes.map((item) => item.row)
    expect(rows).toContain(3) // 36.3：既是铁路格又有村庄 ⇒ 火车卸货格
    expect(rows).not.toContain(2) // 36.2：非铁路格 ⇒ 不得作火车卸货格（缺此判据时会被误判）
  })

  it('13.3f／专规 1.2：轨距不可用的铁路格**不作起点**、也不得被扩展进入', () => {
    /*
     * 专规 1.2：「就铁路运货**与获得追溯补给**而言，苏方只能使用宽轨铁路，轴方只能使用标准轨铁路。」
     * ⇒ 13.3c③ 的「由铁路构成的路径」必须是**本方可用轨距**的铁路格连成 —— 补给源是这条路径的端点，
     *   同样在「路径」之内，故轨距不可用的源格不得作起点。
     */
    const facts = railFacts({
      railRows: [0, 1, 2, 3],
      sources: [at(0)],
      cities: [3],
      gaugeUnusable: [at(0)], // 36.0（补给源）轨距非本方可用
    })
    const path = railSupplyPath(facts, 'axis')
    expect(path.railReachableHexes).toEqual([]) // 起点即被挡下 ⇒ 一格都沿不出
    expect(path.detrainableHexes).toEqual([])
  })

  it('13.3f／专规 1.2：路径中段轨距不可用 ⇒ 铁路在此**断开**，后段不作卸货格', () => {
    const facts = railFacts({
      railRows: [0, 1, 2, 3],
      sources: [at(0)],
      cities: [1, 3],
      gaugeUnusable: [at(2)], // 36.2 轨距非本方可用 ⇒ 断在中间
    })
    const path = railSupplyPath(facts, 'axis')
    expect(path.railReachableHexes.map((item) => item.row)).toEqual([0, 1])
    expect(path.detrainableHexes.map((item) => item.row)).toEqual([1]) // 36.3 够不到了
  })

  it('13.3f／专规 1.2：同一条铁路对两方结论**相反**（一方可用、另一方不可用）', () => {
    // 同一张图、同一段铁路：轨距只给苏方可用（本作印刷宽轨）⇒ 苏方通、轴方一格不通
    const build = (usable: Side) =>
      railFacts({
        railRows: [0, 1, 2, 3],
        sources: [at(0)],
        cities: [3],
        side: 'soviet',
        gaugeUsable: (_hex, requested) => requested === usable,
      })
    expect(
      railSupplyPath(build('soviet'), 'soviet').detrainableHexes.map((item) => item.row),
    ).toEqual([3])
    expect(railSupplyPath(build('axis'), 'soviet').railReachableHexes).toEqual([])
  })

  it('13.3f：延补队**自身**不受轨距约束，但它接续的前段铁路格受约束', () => {
    /*
     * 12.7b：延补队是汽车/马车队而非铁路，故它所在格不做轨距判定；
     * 但 12.7a-B 的「前段铁路」仍是铁路 ⇒ 该段轨距不可用时不得因延补队而「接通」。
     */
    const blocked = railSupplyPath(
      railFacts({
        railRows: [0, 1, 3],
        breaks: [[1, 3]],
        sources: [at(0)],
        cities: [3],
        extenders: [{ hex: at(2), rangeMp: 20 }],
        gaugeUnusable: [at(3)], // 前段铁路轨距不可用
      }),
      'axis',
    )
    expect(blocked.usedExtenderHexes).toEqual([at(2)]) // 延补队本身被采用（它不在铁路上）
    expect(blocked.railReachableHexes.map((item) => item.row)).toEqual([0, 1, 2])
    expect(blocked.detrainableHexes).toEqual([]) // 36.3 未接通 ⇒ 无卸货格

    // 同一条布置，若前段铁路轨距可用 ⇒ 接通并产出卸货格（证明上面挡的是轨距而非别的）
    const open = railSupplyPath(
      railFacts({
        railRows: [0, 1, 3],
        breaks: [[1, 3]],
        sources: [at(0)],
        cities: [3],
        extenders: [{ hex: at(2), rangeMp: 20 }],
      }),
      'axis',
    )
    expect(open.detrainableHexes.map((item) => item.row)).toEqual([3])
  })

  it('12.7a-B：延补队够不到后段铁路（距离不足）⇒ 前段铁路不接通', () => {
    const path = railSupplyPath(
      railFacts({
        railRows: [0, 1, 3],
        breaks: [[1, 3]],
        sources: [at(0)],
        cities: [3],
        // 延补队放在断口前方，但其距离 0 ⇒ 够不到后段铁路 36.1（相距 1）
        extenders: [{ hex: at(2), rangeMp: 0 }],
      }),
      'axis',
    )
    expect(path.railReachableHexes.map((item) => item.row)).toEqual([0, 1])
    expect(path.detrainableHexes).toEqual([])
    expect(path.usedExtenderHexes).toEqual([])
  })

  it('12.7a-C：延补队接在**补给源**与一段孤铁路之间 ⇒ 该段铁路成为卸货格来源', () => {
    // 补给源在 36.10（专规源格），孤铁路 36.6–36.7（村庄在 36.7）；延补队 36.8 距源 2 ≤ 3
    const path = railSupplyPath(
      railFacts({
        railRows: [6, 7],
        sources: [at(10)],
        cities: [7],
        extenders: [{ hex: at(8), rangeMp: 3 }],
      }),
      'axis',
    )
    // 36.10（源）→ 延补队 36.8（距 2 ≤ 3）→ 相邻的铁路格 36.7 → 沿铁路到 36.6
    expect(path.railReachableHexes.map((item) => item.row).sort((a, b) => a - b)).toEqual([
      6, 7, 8, 10,
    ])
    expect(path.detrainableHexes.map((item) => item.row)).toEqual([7])
  })

  it('12.6a①：本方没有补给源 ⇒ 铁路可达集为空', () => {
    const path = railSupplyPath(
      railFacts({ railRows: [0, 1], sources: [at(0)], cities: [1], side: 'soviet' }),
      'axis',
    )
    expect(path.railReachableHexes).toEqual([])
    expect(path.detrainableHexes).toEqual([])
  })
})
