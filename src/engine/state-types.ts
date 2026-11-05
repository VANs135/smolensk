import type { DeepReadonly, HexRef, MarkerSide, Side, UnitSide } from '@/data'

import type { OutcomeData, RuleOutcome } from './result-types'
import type { SessionStatus } from './session-types'

/**
 * 状态模型与类型（B1）
 *
 * 引擎的内核是「纯函数 + 状态进 / 状态出」：本文件只定义**运行状态的数据形状**，
 * 不含任何计算逻辑（计算在 engine/rules、engine/tables）。规范依据：
 *   - CODE_SPEC.md §2：engine 为纯 TS，禁引 Vue / Pinia / DOM / Canvas / 网络 / Math.random
 *   - CODE_SPEC.md §5：标识符一律照术语表，不另造同义词（mode / dg / step / re / hedgehogLevel…）
 *   - CODE_SPEC.md §4：六角格坐标一律对象 { col, row }，禁拼字符串作键
 *
 * 静态数值（印值 / 编制 / 表格）不在此重复：状态里只留 `recordId` 引用
 * （地面 → units-*.json 的 id；空军 → aircraft.json 的 aircraftId），
 * 避免「手写第二份接口」（CODE_SPEC §3.4）。
 */

/* ────────────────────────────── 词表（与术语表对齐） ────────────────────────────── */

/**
 * 模式（5.5–5.8）
 *
 * combat 战斗 / move 移动 / reserve 预备 / strat 战略。
 * 预备模式的释放倍率见 5.7；战略模式移动 ×2 见 5.8。
 */
export type UnitMode = 'combat' | 'move' | 'reserve' | 'strat'

/** 单位当前面（算子双面：战斗面 / 移动面；印值在 units-*.json 的 factors 下） */
export type UnitFace = 'combat' | 'move'

/** 单位类别：地面单位 / 空军型别（本作空军以「型别 × 军力」表示） */
export type UnitKind = 'ground' | 'air'

/** 空军激活状态（14.1a）：非激活空军不可执行任务 */
export type AirStatus = 'active' | 'inactive'

/** 部队储备（12.10）：low 低 / exhausted 耗尽；null 表示未判定 */
export type InternalStocks = 'low' | 'exhausted' | null

/** 地图外盒（专规 1.4）：air 空军盒 / edge 边缘盒 */
export type OffMapBox = 'air' | 'edge'

/** 边缘盒名称（专规 1.4b；仅苏方地面单位可进入） */
export type EdgeBox = 'northeast' | 'southeast'

/** 先手 / 后手（2.3 先手判定 / Setup Notes A） */
export type Initiative = 'first' | 'second'

/**
 * 游戏流程阶段顺序（2.2 流程表，源库 charts.json → tables.sop）
 *
 * Pre-Turn（天气判定 → 先手判定）→ 行动方回合 A–H → 第二方（角色互换）→ 回合结束。
 * 单一来源：阶段枚举与顺序都由本常量派生，新增阶段只改这里。
 */
export const GAME_PHASES = [
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
] as const

/** 游戏流程阶段（2.2）：A 整备 / B 增援 / C 移动 / D 补给 / E 反应 / F 战斗 / G 进击 / H 清理 */
export type GamePhase = (typeof GAME_PHASES)[number]

/** Pre-Turn 子步骤（2.2 流程表） */
export const PRE_TURN_SEGMENTS = ['weatherDetermination', 'firstPlayerDetermination'] as const

/** Pre-Turn 子步骤类型（2.2）：天气判定 / 先手判定 */
export type PreTurnSegment = (typeof PRE_TURN_SEGMENTS)[number]

/** 空中条件（专规 1.5 / 17.0）：受限飞行 / 正常飞行 */
export type FlightWeather = 'normal' | 'limited'

/** 地面条件（专规 1.5：本作地面恒为良好） */
export type GroundWeather = 'good'

/** 记录轨标识（markers.json：19 回合轨 / 铁路容量轨） */
export type RecordTrackId = 'turnTrack' | 'railCapacity'

/* ────────────────────────────── 位置与容器 ────────────────────────────── */

/**
 * 图外容器（不在图上的去处）
 *
 * - deadPile 死亡堆（到达表 Remove）
 * - setupDrawPile 初设抽取堆（剧本初设的多单位编队抽取片）
 * - reinforcementQueue 待入场队列（到达表已列但尚未入场）
 * - offMapBox 地图外盒（专规 1.4；air 空军盒，edge 需指明 northeast / southeast）
 */
export type UnitContainer =
  | { kind: 'deadPile' }
  | { kind: 'setupDrawPile' }
  | { kind: 'reinforcementQueue' }
  | { kind: 'offMapBox'; box: OffMapBox; edgeBox?: EdgeBox }

/* ────────────────────────────── Unit ────────────────────────────── */

/**
 * 单位运行实例
 *
 * 唯一静态来源是数据层（recordId → units-*.json / aircraft.json）；
 * 本类型只承载**随对局变化的部分**（位置、模式、军力、混乱、补给…）。
 * id 命名见 CODE_SPEC §4：`<国籍>-<兵种>-<番号>[-<部件>]`。
 */
export interface Unit {
  /** 运行实例 id（创建后不变） */
  id: string
  /** 静态数值引用：地面 → units-*.json 的 id；空军 → aircraft.json 的 aircraftId */
  recordId: string
  /** 单位类别（地面 / 空军） */
  kind: UnitKind
  /**
   * 归属方（与静态记录一致，冗余保存以便按方快速筛选）
   *
   * 用 UnitSide（含 `both`）：源库把 SP / 空军基地 / 工事等中立算子标为 both（双方通用），
   * 窄的 Side 装不下它们。`both` 只表示「双方都可支配」，不代表第三个阵营。
   */
  side: UnitSide

  /** 图上位置；不在图上（处于容器内）为 null */
  hex: HexRef | null
  /** 图外容器；在图上时为 null */
  container: UnitContainer | null

  /** 当前面（双面算子） */
  face: UnitFace
  /** 模式（5.5–5.8） */
  mode: UnitMode

  /** 剩余军力（3.2）；0 表示已被消灭（应移入死亡堆） */
  steps: number
  /** 团级当量（4.6）；非战斗单位为 0 */
  re: number

  /** 混乱（5.10）：攻/移/轰减半，行动值 -1 */
  dg: boolean
  /** 断补（12.8）：跨补给层级结算 */
  outOfSupply: boolean
  /** 部队储备（12.10） */
  internalStocks: InternalStocks
  /** 燃料补给（12.5）：已加注燃料（fuelled marker）；阶段末依规则翻面/移除 */
  fuel: boolean
  /** 进击标记（9.13 / 11.0）：进击阶段结束后清理 */
  exploit: boolean

  /** 空军激活状态（14.1a）；地面单位恒为 null */
  airStatus: AirStatus | null
}

/* ────────────────────────────── Stack ────────────────────────────── */

/**
 * 堆叠（4.8）
 *
 * 每格一项；堆叠上限（RE）判定由引擎按 4.8 计算，状态里只记录当前构成。
 * 环形工事等级含地图印刷工事（map-layers.json printedHedgehogs）与玩家建造（16.0）的合算结果。
 */
export interface Stack {
  /** 所在格（对象坐标，禁拼字符串作键） */
  hex: HexRef
  /** 格内单位实例 id（含非战斗单位） */
  unitIds: string[]
  /** 格内环形工事当前等级（16.0）；0 = 无 */
  hedgehogLevel: number
}

/* ────────────────────────────── Marker ────────────────────────────── */

/** 标记在记录轨上的位置 */
export interface MarkerTrackRef {
  /** 所属记录轨（markers.json：turnTrack / railCapacity） */
  track: RecordTrackId
  /** 轨位（整数；铁路容量轨为容量点数） */
  position: number
}

/**
 * 标记运行实例
 *
 * 静态来源：markers.json（47 件保留标记）；同一 static 标记可在地图上出现多枚，
 * 故运行实例 id 与 recordId 分开。
 */
export interface Marker {
  /** 运行实例 id（创建后不变） */
  id: string
  /** 静态引用：markers.json 的标记 id */
  recordId: string
  /**
   * 归属方
   *
   * 用 MarkerSide（含 `neutral` 通用磁贴与 `both` 双方通用标记）：markers.json 里
   * 进击标记、耗尽标记等标为 both（双方通用），铁路端点/建设标记亦然；窄的 Side 装不下。
   */
  side: MarkerSide
  /** 图上位置；在记录轨或容器中为 null */
  hex: HexRef | null
  /** 记录轨位置；不在轨上为 null */
  track: MarkerTrackRef | null
}

/* ────────────────────────────── Records（记录轨与计数） ────────────────────────────── */

/** 当前天气（专规 1.5） */
export interface WeatherState {
  /** 空中条件 */
  air: FlightWeather
  /** 地面条件（本作恒为 good） */
  ground: GroundWeather
}

/** 胜利格控制状态（5.0c：格内有无可攻击单位；空格取最后控制者） */
export interface VictoryLocationState {
  hex: HexRef
  /** 当前控制方 */
  controlledBy: Side
  /** 是否属于本剧本的胜利格清单（scenarios.json victory） */
  listed: boolean
}

/**
 * 双方资源计数（开局由剧本初设决定，见 scenarios.json scenarios[].setup）
 */
export interface RecordCounters {
  /** Reserve 标记可用数（5.7；剧本初设 setup.reserveMarkers） */
  reserveMarkers: Record<Side, number>
  /** Supply Cache 标记数（1.7；剧本初设 setup.supplyCache） */
  supplyCache: Record<Side, number>
  /** 建造标记可用数（3.5；剧本初设 setup.constructionMarkers） */
  constructionMarkers: number
}

/**
 * 记录轨与计数（辅助卡「记录轨」）
 *
 * 回合轨 / 铁路容量轨 / 各标记轨位 / 胜利格控制 / 双方资源计数。
 */
export interface Records {
  /** 回合轨：当前回合号（1 起，共 19 回合） */
  turn: number
  /** 当前流程阶段（2.2） */
  phase: GamePhase
  /** Pre-Turn 子步骤；非 preTurn 阶段为 null */
  preTurnSegment: PreTurnSegment | null
  /**
   * 当前行动方（2.2 Player Turn / Second Player）
   *
   * Pre-Turn 与 Turn-End 期间无行动方（先手尚未判定 / 回合已结束），故可为 null。
   * 「当前处于先手方回合还是后手方回合」由 `activeSide === firstPlayer` 判定（见 turn-driver）。
   */
  activeSide: Side | null
  /**
   * 本回合先手方（2.2 First Player Determination / 2.3）
   *
   * 进入 Pre-Turn 时清空（回合推进后须重新判定）；先手判定完成（首回合剧本指定、
   * 常规回合由胜者选择）后写入。为空期间禁止进入玩家回合（见 turn-driver.nextPhase）。
   */
  firstPlayer: Side | null
  /** 当前天气（专规 1.5） */
  weather: WeatherState
  /**
   * 铁路容量记录轨（13.3b / 专规 1.2）：双方当前可用点数
   * （提升前 轴 0 / 苏 2；1941-07-19 起 轴 1 / 苏 3）
   */
  railCapacity: Record<Side, number>
  /** 标记在记录轨上的位置：标记实例 id → 轨位；不在轨上者不出现 */
  markerTracks: Record<string, number>
  /** 胜利格控制状态（5.0c；清单来自 scenarios.json victory） */
  victoryLocations: VictoryLocationState[]
  /** 双方资源计数 */
  counters: RecordCounters
}

/* ────────────────────────────── GameState ────────────────────────────── */

/**
 * 随机数生成器状态（B2；掷骰必须可重放，CODE_SPEC §3.3）
 *
 * - `seed`：初始种子（32 位无符号整数），入存档便于人工复现与逐条核对；
 * - `state`：PRNG 内部状态（32 位无符号），续玩以此为准（避免每次抽取都从种子重推）；
 * - `drawCount`：已抽取次数（PRNG 步数），审计与「从头复算」的游标。
 *
 * 算法与接口的唯一实现在 engine/rng.ts；本类型只描述它在状态中的形状。
 */
export interface RngState {
  seed: number
  state: number
  drawCount: number
}

/**
 * 游戏状态（一局对局的全部运行数据）
 *
 * 引擎以「纯函数 + 状态进 / 状态出」方式工作：命令接收 GameState，返回新的 GameState 与日志。
 * 只读投影见本文件末的 ReadonlyGameState（供 render / stores 使用）。
 */
export interface GameState {
  /** 剧本标识（scenarios.json 的 id，如 '1'） */
  scenarioId: string
  /** 记录轨与计数 */
  records: Records
  /** 全部单位实例（含处于图外容器者） */
  units: Unit[]
  /** 图上堆叠（每格一项） */
  stacks: Stack[]
  /** 全部标记实例（含记录轨上的） */
  markers: Marker[]
  /** 随机数生成器状态 */
  rng: RngState
}

/* ────────────────────────────── 会话（Session） ────────────────────────────── */

/** 掷骰记录（可重放；引擎 rng 产出） */
export interface DiceRoll {
  /** 骰数 */
  count: number
  /** 骰面（如 [3, 4]） */
  faces: number[]
  /** 合计 */
  total: number
}

/** 会话日志条目（整局回归比对「结算结果与日志」，CODE_SPEC §7） */
export interface SessionLogEntry {
  /** 发生时的回合号 */
  turn: number
  /** 发生时的阶段（2.2） */
  phase: GamePhase
  /** 行动方 */
  side: Side
  /** 动作标识（由引擎各命令写入，如 'move' / 'barrage' / 'combat'） */
  action: string
  /** 该动作的掷骰（无掷骰为空数组）；可重放 */
  rolls: DiceRoll[]
  /** 结算结果（B3 统一结果形状；规则引用见 outcome.rule，待处理项见 outcome.pending） */
  outcome: RuleOutcome<OutcomeData>
}

/** 会话元信息（存档头） */
export interface SessionMeta {
  /** 会话 id（shared 的 createId 生成） */
  sessionId: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 最近写入时间（ISO 8601）；由存档层盖章——引擎无时钟，形态迁移不改动本字段 */
  updatedAt: string
  /**
   * 会话**数据模型**版本（GameState / 日志条目的字段版本）
   *
   * 与 engine/session.ts 的 `SESSION_SAVE_VERSION`（存档**容器**格式版本）分工不同：
   * 前者管「会话内部字段变了没有」，后者管「存档文件外壳能不能读」。
   * 二者都与数据管线的 DATA_VERSION 相互独立（数据是内容，存档是对局）。
   */
  schemaVersion: number
}

/**
 * 会话（一局对局的完整可存档单元）
 *
 * 存档 = 元信息 + 状态 + 日志；固定种子回放时，
 * 由 seed 与日志中的掷骰结果即可复现整局（CODE_SPEC §3.3 / §7）。
 */
export interface GameSession {
  meta: SessionMeta
  state: GameState
  log: SessionLogEntry[]
  /** 会话形态（B4 四种：created / advancing / awaiting / terminated，见 session-types） */
  status: SessionStatus
}

/* ────────────────────────────── 只读视图（render / stores 用） ────────────────────────────── */

/**
 * 只读视图类型
 *
 * 与数据层同款 DeepReadonly（src/data/freeze.ts）：静态类型层递归只读，
 * 运行层配合 Object.freeze 兜底。render 与 stores 一律消费只读视图，
 * 保证「UI 不重算规则、render 无状态写入」（CODE_SPEC §2 / §3.1）。
 */
export type ReadonlyGameState = DeepReadonly<GameState>
export type ReadonlyUnit = DeepReadonly<Unit>
export type ReadonlyStack = DeepReadonly<Stack>
export type ReadonlyMarker = DeepReadonly<Marker>
export type ReadonlyRecords = DeepReadonly<Records>
export type ReadonlyGameSession = DeepReadonly<GameSession>
