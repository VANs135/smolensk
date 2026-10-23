import type { HexRef, Side } from '@/data'

import type { BaseMode, MovementSegmentPhase, Orientation } from './modes'
import type { HexsideCrossing, MobilityType } from './terrain'

/**
 * 移动模块的输入/输出类型（B7）
 *
 * 设计口径：移动是**纯函数 + 视图输入**——引擎不直接读 GameState 全量，
 * 而由调用方（命令层/查询层）把需要的字段汇成下面的**视图**（与 zoc.ts 的 ZocSource 同思路），
 * 这样移动逻辑可脱离整局状态独立测试，也避免复制单位库字段全集。
 */

/* ────────────────────────────── 地图事实 ────────────────────────────── */

/**
 * 地图事实提供者（6.2 的「格内地形 / 格边地形」来源）
 *
 * 把「这一格、这条格边是什么地形」从移动逻辑里分出去：移动只消费语义化的 crossing，
 * 不关心 map-layers.json 的字段形状；默认实现见 map-facts.ts。
 */
export interface MapFacts {
  /** 是否在图内（地图四边削角 + 62 个半格；判据同引擎 isOnMap） */
  onMap(hex: HexRef): boolean
  /** 格内地形集合（契约：只含格内地形，供 6.2d 取最贵 / 9.3b 候选） */
  terrainsAt(hex: HexRef): readonly string[]
  /** 两格之间的格边（含河/湖与承载路铁）；两格不相邻或该边无要素时返回 null */
  crossingBetween(a: HexRef, b: HexRef): HexsideCrossing | null
}

/* ────────────────────────────── 单位视图 ────────────────────────────── */

/**
 * 移动期单位视图
 *
 * 只收录移动与模式判定真正用到的字段；`mode/orientation/dg/exploit/releasedFromReserve`
 * 与 state-types 的 `Unit` 一一对应（`unit.mode`→mode、`unit.face`→orientation、
 * `unit.dg`→dg、`unit.exploit`→exploit），不新增顶层字段。
 */
export interface MoveUnitView {
  id: string
  side: Side
  /** 是否战斗单位（4.5b：只有「友方战斗单位」能抵消敌方 ZOC） */
  isCombat: boolean
  /** 是否可攻击（4.4/3.2b：括注战斗值、战略模式、预备模式任一命中即不具攻击能力） */
  attackCapable: boolean
  /** 是否有追溯补给（12.6；4.5：断补单位不投射 ZOC） */
  hasTraceSupply: boolean
  /** 图上位置；不在图上（容器内）为 null */
  hex: HexRef | null
  /** 机动类型（3.1a） */
  mobility: MobilityType
  /** 朝向那一面的原始 MA（未按模式修正；6.1b） */
  ma: number
  /** 团级当量（4.6；4.8 堆叠上限按 RE 计） */
  re: number
  /** 模式（5.5–5.8；`combat/move` 时兼作朝向） */
  mode: BaseMode
  /** 朝向（5.7a） */
  orientation: Orientation
  /** 混乱（5.10） */
  dg: boolean
  /** 进击（5.9） */
  exploit: boolean
  /** 本阶段刚被释放的预备（5.7b） */
  releasedFromReserve: boolean
  /** 是否已加注燃料（12.5；仅「轮式/履带 MP 的战斗单位」需要） */
  fuelled: boolean
  /**
   * 4.5b：本阶段已承诺「之后不再消耗 MP」
   *
   * 用于「垫人」——格内留一个己方战斗单位抵消该格敌方 ZOC，代价是该单位本阶段起不得再消耗 MP。
   */
  mpLockedThisPhase: boolean
  /**
   * 12.7：该单位**当前以延补队面在场**
   *
   * 「延补队不能移动（也不能用于其他运输点数本身的用途）」；12.7d 给出唯一出路——
   * 翻回到运输点数面（翻面消耗一半 MA）之后才可移动。故这只是「此刻在延补队面」的时点事实，
   * 缺省 false（普通单位与已翻回运输点数面的单位）。
   */
  isExtenderFace?: boolean
}

/** 移动上下文 */
export interface MoveContext {
  /** 当前移动环节属于哪个阶段（2.2：C 移动 / E 反应 / G 进击） */
  phase: MovementSegmentPhase
  /** 当前行动方（2.2 阶段玩家） */
  activeSide: Side
  /** 地图事实 */
  map: MapFacts
  /** 全部单位（含不在图上的） */
  units: readonly MoveUnitView[]
  /**
   * 12.6 追溯补给可用性（5.8b：战略模式单位必须在当前拥有追溯补给的格内结束移动）
   *
   * 追溯补给属 12.6/12.8，由补给模块提供；未接入时省略本项即**不施加 5.8b 检查**
   * （宁可少判，也不臆造一张补给网）。
   */
  traceSupplyAt?: (hex: HexRef, side: Side) => boolean
  /**
   * 专规 1.1b：**安全边缘格**（作为补给源的地图边格）
   *
   * 「敌方地面单位**不得进入**；这些格可以被常规战斗攻击，但**不可被突袭**（因为可能需要推进）。」
   * 按归属列出：移动方只看**对手**那一组。省略本项即不施加该检查。
   */
  safeEdgeHexesBySide?: { readonly axis: readonly HexRef[]; readonly soviet: readonly HexRef[] }
  /**
   * 13.8b：**架桥生效格**（按归属）——有工程能力的本方单位所在格
   *
   * 「当与一个大河相邻时，具有工程能力的单位会自动将大河格边的 MP 消耗降至小河格边的 MP 消耗……
   *   只有友方单位移动**进入或离开**工程能力单位所在格时，移动消耗才能降低。」
   * ⇒ 调用方给出这些格（并把专规 3.5 的建造标记「桥」面一并算进去，语义与 HQ 架桥相同），
   * 引擎只在「本步的出格或入格在其中」时降级；省略即视为无桥（不臆造）。
   */
  bridgedHexesBySide?: { readonly axis: readonly HexRef[]; readonly soviet: readonly HexRef[] }
}

/* ────────────────────────────── 结果形状 ────────────────────────────── */

/** 移动被拒的原因（每条都可追溯到规则条文） */
export type MoveRejectReason =
  /** 找不到该单位 */
  | 'unitNotFound'
  /** 单位不在图上（容器内 / 已消灭） */
  | 'notOnMap'
  /** 6.1b：无 MA 单位（SP/港口/空军基地/环形工事）不可移动 */
  | 'immobile'
  /** 6.1b/6.1c：MA 不大于 0 */
  | 'noMa'
  /** 6.0/6.3a/7.0a/11.0a：该阶段无权移动该单位 */
  | 'phaseNotAllowed'
  /** 12.5a：需要燃料而未加注 |
   */
  | 'needsFuel'
  /** 4.5b：该单位已承诺本阶段不再消耗 MP（垫人代价） */
  | 'mpLocked'
  /** 6.1：移动必须沿连续格，目标格与当前位置不相邻 */
  | 'notAdjacent'
  /** 6.3b / 8.0：目标格被敌方战斗单位占据（须以突袭处理，不能直接走进） */
  | 'enemyOccupied'
  /** 5.8a：战略模式单位不可移动（或撤退）进入敌方 ZOC */
  | 'stratIntoEzoc'
  /** 4.4 / 8.1：该单位不可攻击（无攻击值 / 括注 / 战略或预备模式） */
  | 'notAttackCapable'
  /** 目标格不在图内（含 offMapStub 一侧） */
  | 'destinationOffMap'
  /** 6.2c：禁入格或禁入格边 */
  | 'prohibited'
  /** 地形名未在 TEC 登记（数据问题，不静默当 1 MP） */
  | 'unknownTerrain'
  /** 6.1d：互逆性——目标格回不到当前格 |
   */
  | 'reciprocity'
  /** 4.8：目标格堆叠超限 |
   */
  | 'stackingLimit'
  /** 6.1a：MP 不足（且不适用 6.1c 最小移动） */
  | 'notEnoughMp'
  /** 6.2d：目标格无可用地形（数据为空） */
  | 'noTerrain'
  /** 5.8b：战略模式单位必须在当前有追溯补给的格内结束移动 */
  | 'stratMustEndInSupply'
  /** 12.7：延补队面不可移动（须先翻回运输点数面，翻面消耗一半 MA，见 12.7d） */
  | 'extenderCannotMove'
  /** 专规 1.1b：敌方安全边缘格（作为补给源的地图边格）不可被敌方地面单位进入（含突袭） */
  | 'enemySafeEdge'

/** 单步移动成功 */
export interface StepSuccess {
  ok: true
  /** 本步消耗的 MP（6.1a：进入格 + 穿越格边） */
  cost: number
  /** 格内部分（沿路时即所走道路的费率） */
  hexCost: number
  /** 格边追加部分（6.2b；沿路时被忽略） */
  hexsideCost: number
  /** 是否走了 6.2a 道路优先 */
  roadOverride: boolean
  /** 是否走了桥（桥 = 河/湖格边 + 路或铁路） */
  crossedOnBridge: boolean
  /** 是否借 6.1c 最小移动（MP 不足仍走一格） */
  minimumMove: boolean
  /** 该步是否耗尽全部残余 MA（地形列写 All） */
  spendsAllMp: boolean
  /** 进入后是否被未抵消的敌方 ZOC 强制停止（4.5a-A：轮式） */
  forcedStop: boolean
  /** 该步之后本轮移动必须结束（4.5a-A 强制停止；5.8b 战略模式落到无追溯补给的格） */
  mustEndMove: boolean
  /**
   * 本步是否造成**暂时超堆叠**（4.8a）
   *
   * 「超堆叠，是指在任何环节或阶段结束时，某一格内的战斗单位超过 10RE」，
   * 且「单位在移动过程中可以暂时地超堆叠」→ 故这不是逐步禁令，而是**阶段末义务**：
   * 由 legality.stackingObligations() 在环节/阶段结束时结算（增援阶段例外，13.6）。
   */
  createsOverstack: boolean
}

/** 单步移动失败 */
export interface StepFailure {
  ok: false
  reason: MoveRejectReason
  /** 规则条文号（如 '6.1c' / '4.5a-A'） */
  rule: string
  /** 补充说明（地形名、RE 数等） */
  detail?: string
}

/** 单步移动判定结果 */
export type StepOutcome = StepSuccess | StepFailure

/** 可到达格（UI 接口的输出单元） */
export interface ReachableHex {
  /** 目标格 */
  hex: HexRef
  /** 走到该格累计消耗的 MP */
  mpSpent: number
  /** 是否只能靠 6.1c 最小移动到达（UI 可另色标注） */
  minimumMove: boolean
  /** 到达后是否被迫停止（4.5a-A：进入未抵消敌方 ZOC 的轮式单位） */
  forcedStop: boolean
  /** 从起点到该格的格序列（含起点；供 UI 画路径与逐格回放） */
  path: HexRef[]
}

/** 可到达格查询结果 */
export type ReachabilityResult =
  | {
      ok: true
      /** 本阶段该单位的可用 MA（6.1h：未取整） */
      ma: number
      /** 已消耗 MP */
      mpSpent: number
      /** 剩余 MP（可为小数） */
      mpRemaining: number
      /** 可到达格（按距离→MP 升序） */
      reachable: ReachableHex[]
    }
  | StepFailure
