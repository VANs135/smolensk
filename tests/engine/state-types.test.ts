import { describe, expect, it } from 'vitest'

import { markers, unitsAxis, unitsSoviet } from '@/data'
import { assertNever } from '@/shared'

import { isSuccess, succeed } from '@/engine/result-types'
import { GAME_PHASES, PRE_TURN_SEGMENTS } from '@/engine/state-types'
import type {
  GamePhase,
  GameSession,
  GameState,
  Marker,
  ReadonlyGameSession,
  ReadonlyGameState,
  ReadonlyMarker,
  ReadonlyRecords,
  ReadonlyStack,
  ReadonlyUnit,
  Records,
  Stack,
  Unit,
} from '@/engine/state-types'

/**
 * 状态模型（B1）测试
 *
 * 类型只有编译期存在，故本文件有双重职责：
 *   1. 夹具构造 → 由 vue-tsc 校验模型字段齐备、可独立构造（类型契约的编译期护栏）；
 *   2. 运行时断言 → 校验阶段顺序与源库 2.2 流程表一致、位置表达互斥等不变量。
 */

/* ── 夹具（数值取自已核实数据：专规 1.2 铁路容量 / 剧本初设） ── */

/** 图上的地面单位（含 dg / 断补 / 模式等运行状态） */
function createOnMapUnit(): Unit {
  return {
    id: 'de-pz-3-krd',
    recordId: 'de-pz-3-krd',
    kind: 'ground',
    side: 'axis',
    hex: { col: 36, row: 13 },
    container: null,
    face: 'combat',
    mode: 'combat',
    steps: 2,
    re: 2,
    dg: false,
    outOfSupply: false,
    internalStocks: null,
    fuel: false,
    exploit: false,
    airStatus: null,
  }
}

/** 死亡堆里的单位（不在图上，位置由容器表达） */
function createDeadPileUnit(): Unit {
  return {
    ...createOnMapUnit(),
    id: 'ru-tk-57',
    recordId: 'ru-tk-57',
    side: 'soviet',
    hex: null,
    container: { kind: 'deadPile' },
    steps: 0,
  }
}

/** 空军实例（激活状态非空；位置为所在空军基地格） */
function createAirUnit(): Unit {
  return {
    id: 'ax-air-ju-87b',
    recordId: 'ax-aircraft-ge-ju-87b',
    kind: 'air',
    side: 'axis',
    hex: { col: 2, row: 2 },
    container: null,
    face: 'combat',
    mode: 'move',
    steps: 2,
    re: 0,
    dg: false,
    outOfSupply: false,
    internalStocks: null,
    fuel: false,
    exploit: false,
    airStatus: 'active',
  }
}

function createStack(): Stack {
  return {
    hex: { col: 36, row: 13 },
    unitIds: ['de-pz-3-krd'],
    hedgehogLevel: 1,
  }
}

function createOnMapMarker(): Marker {
  return {
    id: 'marker-1',
    recordId: 'mk-15',
    side: 'neutral',
    hex: { col: 20, row: 7 },
    track: null,
  }
}

function createTrackMarker(): Marker {
  return {
    id: 'marker-2',
    recordId: 'mk-14',
    side: 'axis',
    hex: null,
    track: { track: 'railCapacity', position: 2 },
  }
}

function createRecords(): Records {
  return {
    turn: 1,
    phase: 'preTurn',
    preTurnSegment: 'weatherDetermination',
    activeSide: 'axis',
    firstPlayer: 'axis',
    weather: { air: 'normal', ground: 'good' },
    // 专规 1.2：提升前 轴 0 / 苏 2
    railCapacity: { axis: 0, soviet: 2 },
    markerTracks: {},
    victoryLocations: [{ hex: { col: 36, row: 13 }, controlledBy: 'soviet', listed: true }],
    counters: {
      reserveMarkers: { axis: 14, soviet: 0 },
      supplyCache: { axis: 2, soviet: 2 },
      constructionMarkers: 3,
    },
  }
}

function createState(): GameState {
  return {
    scenarioId: '1',
    records: createRecords(),
    units: [createOnMapUnit(), createDeadPileUnit(), createAirUnit()],
    stacks: [createStack()],
    markers: [createOnMapMarker(), createTrackMarker()],
    rng: { seed: 19410708, state: 19410708, drawCount: 0 },
  }
}

function createSession(): GameSession {
  return {
    meta: {
      sessionId: 'session-1',
      createdAt: '1941-07-08T00:00:00.000Z',
      updatedAt: '1941-07-08T00:00:00.000Z',
      schemaVersion: 1,
    },
    state: createState(),
    log: [
      {
        turn: 1,
        phase: 'preTurn',
        side: 'axis',
        action: 'weatherDetermination',
        rolls: [{ count: 1, faces: [4], total: 4 }],
        outcome: succeed('1.5', { die: 4, air: 'normal', ground: 'good' }),
      },
    ],
    status: { form: 'created' },
  }
}

/** 阶段 → 2.2 流程表标签（穷尽 switch：新增阶段未处理即编译失败） */
function phaseLabel(phase: GamePhase): string {
  switch (phase) {
    case 'preTurn':
      return 'Pre-Turn'
    case 'aircraftRefit':
      return 'A. Aircraft Refit Phase'
    case 'reinforcement':
      return 'B. Reinforcement Phase'
    case 'movement':
      return 'C. Movement Phase'
    case 'supply':
      return 'D. Supply Phase'
    case 'reaction':
      return 'E. Reaction Phase'
    case 'combat':
      return 'F. Combat Phase'
    case 'exploitation':
      return 'G. Exploitation Phase'
    case 'cleanUp':
      return 'H. Clean Up Phase'
    case 'turnEnd':
      return 'Turn End'
    default:
      return assertNever(phase)
  }
}

describe('流程阶段（2.2 流程表）', () => {
  it('阶段顺序与源库 charts.json → tables.sop 一致', () => {
    expect([...GAME_PHASES]).toEqual([
      'preTurn',
      'aircraftRefit',
      'reinforcement',
      'movement',
      'supply',
      'reaction',
      'combat',
      'exploitation',
      'cleanUp',
      'turnEnd',
    ])
  })

  it('Pre-Turn 子步骤为天气判定 → 先手判定', () => {
    expect([...PRE_TURN_SEGMENTS]).toEqual(['weatherDetermination', 'firstPlayerDetermination'])
  })

  it('阶段标签可穷举（A–H 齐备）', () => {
    expect(GAME_PHASES.map(phaseLabel)).toEqual([
      'Pre-Turn',
      'A. Aircraft Refit Phase',
      'B. Reinforcement Phase',
      'C. Movement Phase',
      'D. Supply Phase',
      'E. Reaction Phase',
      'F. Combat Phase',
      'G. Exploitation Phase',
      'H. Clean Up Phase',
      'Turn End',
    ])
  })
})

describe('Unit / Stack / Marker 位置表达', () => {
  it('图上单位：hex 非空且 container 为 null（互斥）', () => {
    const unit = createOnMapUnit()
    expect(unit.hex).toEqual({ col: 36, row: 13 })
    expect(unit.container).toBeNull()
    expect(unit.airStatus).toBeNull()
  })

  it('图外容器单位：hex 为 null 且 container 标明去处', () => {
    const unit = createDeadPileUnit()
    expect(unit.hex).toBeNull()
    expect(unit.container).toEqual({ kind: 'deadPile' })
    expect(unit.steps).toBe(0)
  })

  it('空军单位带激活状态（14.1a）', () => {
    const air = createAirUnit()
    expect(air.kind).toBe('air')
    expect(air.airStatus).toBe('active')
  })

  it('堆叠记录格内单位与工事等级（16.0）', () => {
    const stack = createStack()
    expect(stack.hex).toEqual({ col: 36, row: 13 })
    expect(stack.unitIds).toContain('de-pz-3-krd')
    expect(stack.hedgehogLevel).toBe(1)
  })

  it('标记可位于图上，也可位于记录轨（两种表达互斥）', () => {
    const onMap = createOnMapMarker()
    expect(onMap.hex).not.toBeNull()
    expect(onMap.track).toBeNull()

    const onTrack = createTrackMarker()
    expect(onTrack.hex).toBeNull()
    expect(onTrack.track).toEqual({ track: 'railCapacity', position: 2 })
  })
})

describe('归属侧词汇（数据 ↔ 运行实例）', () => {
  it('源库出现的算子 side 值（含 both 中立算子）就是运行模型的取值域', () => {
    const unitSides = new Set([...unitsAxis.units, ...unitsSoviet.units].map((u) => u.side))
    expect([...unitSides].sort()).toEqual(['axis', 'both', 'soviet'])
  })

  it('源库出现的标记 side 值（neutral 通用磁贴 / both 双方通用）就是运行模型的取值域', () => {
    const markerSides = new Set(
      markers.markers
        .map((m) => m.side)
        .filter((side): side is NonNullable<typeof side> => Boolean(side)),
    )
    expect([...markerSides].sort()).toEqual(['axis', 'both', 'neutral', 'soviet'])
  })

  it('both 的中立算子可作运行实例（SP / 空军基地 / 工事，双方通用）', () => {
    const neutralSp: Unit = { ...createOnMapUnit(), id: 'neutral-supply-sp-1', side: 'both' }
    expect(neutralSp.side).toBe('both')

    const bothMarker: Marker = { ...createOnMapMarker(), id: 'marker-3', side: 'both' }
    expect(bothMarker.side).toBe('both')
  })
})

describe('Records（记录轨与计数）', () => {
  it('开局记录：第 1 回合 Pre-Turn、天气正常、铁路容量 轴 0 / 苏 2（专规 1.2）', () => {
    const records = createRecords()
    expect(records.turn).toBe(1)
    expect(records.phase).toBe('preTurn')
    expect(records.preTurnSegment).toBe('weatherDetermination')
    expect(records.weather).toEqual({ air: 'normal', ground: 'good' })
    expect(records.railCapacity).toEqual({ axis: 0, soviet: 2 })
  })

  it('计数来自剧本初设（Reserve 14/0、Supply Cache 各 2、建造标记 3）', () => {
    const { counters } = createRecords()
    expect(counters.reserveMarkers).toEqual({ axis: 14, soviet: 0 })
    expect(counters.supplyCache).toEqual({ axis: 2, soviet: 2 })
    expect(counters.constructionMarkers).toBe(3)
  })

  it('胜利格控制记录控制方与是否属清单（5.0c）', () => {
    const [control] = createRecords().victoryLocations
    expect(control).toEqual({ hex: { col: 36, row: 13 }, controlledBy: 'soviet', listed: true })
  })
})

describe('GameState / 会话 / 只读视图', () => {
  it('状态含剧本 / 记录 / 单位 / 堆叠 / 标记 / RNG 六项', () => {
    const state = createState()
    expect(Object.keys(state).sort()).toEqual([
      'markers',
      'records',
      'rng',
      'scenarioId',
      'stacks',
      'units',
    ])
    expect(state.rng).toEqual({ seed: 19410708, state: 19410708, drawCount: 0 })
  })

  it('会话 = 元信息 + 状态 + 日志 + 形态；日志含掷骰与统一结果形状', () => {
    const session = createSession()
    expect(session.meta.sessionId).toBe('session-1')
    expect(session.meta.schemaVersion).toBe(1)
    expect(session.status).toEqual({ form: 'created' })
    expect(session.log).toHaveLength(1)

    const entry = session.log[0]!
    expect(entry.rolls[0]).toEqual({ count: 1, faces: [4], total: 4 })
    expect(entry.outcome.ok).toBe(true)
    expect(entry.outcome.rule).toBe('1.5')
    expect(isSuccess(entry.outcome)).toBe(true)
  })

  it('只读视图可用同一实例赋值（编译期递归只读；运行期读值不变）', () => {
    const state = createState()
    const view: ReadonlyGameState = state
    expect(view.records.turn).toBe(1)
    expect(view.units[0]?.hex).toEqual({ col: 36, row: 13 })

    const session = createSession()
    const sessionView: ReadonlyGameSession = session
    expect(sessionView.state.scenarioId).toBe('1')
  })

  it('各子模型都有对应只读视图类型（可赋值）', () => {
    const unit: ReadonlyUnit = createOnMapUnit()
    const stack: ReadonlyStack = createStack()
    const marker: ReadonlyMarker = createOnMapMarker()
    const records: ReadonlyRecords = createRecords()
    expect(unit.id).toBe('de-pz-3-krd')
    expect(stack.hedgehogLevel).toBe(1)
    expect(marker.recordId).toBe('mk-15')
    expect(records.activeSide).toBe('axis')
  })
})
