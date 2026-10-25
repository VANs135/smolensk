import { aircraft, mapConfig, mapLayers, markers, unitsAxis, unitsSoviet } from '@/data'
import type { AircraftRecord, DeepReadonly, HexRef, Side, UnitRecord } from '@/data'
import { areAdjacent, hexDistance } from '@/engine/hex-geometry'
import { roll2d6, type RngDraw } from '@/engine/rng'
import { turnDate } from '@/engine/turn-driver'
import { GAME_PHASES } from '@/engine/state-types'
import type { AirStatus, GamePhase, InternalStocks, RngState } from '@/engine/state-types'
import { tokenImageUrl } from '@/render/token-images'
import {
  availableMa,
  bestCombatTerrainForDefender,
  bridgedCrossing,
  canEngineer,
  canMoveInPhase,
  canReleaseReserve,
  combatTerrainCandidates,
  combatHexsideTerrains,
  computeReachableHexes,
  createMapFacts,
  createRailGraph,
  createTraceSupplyFacts,
  densityReOf,
  evaluateStep,
  exertsZoc,
  extenderConnectsBack,
  extenderRangeMpOf,
  inEnemyZocAt,
  inEnemyZocForRetreat,
  isCorrectSpotter,
  isMobileUnit,
  legMpDistanceWithinRadius,
  modeUnitClass,
  needsFuelToMove,
  resolveCombat,
  resolveCombatTerrain,
  selectMovementTerrain,
  type ActionKind,
  type AirBaseView,
  type AirMissionAircraftView,
  type AtLevel,
  type BarrageUnitRequest,
  type BaseMode,
  type BattleFacts,
  type BattleUnitView,
  type BreakdownSideView,
  type CombatLine,
  type CombatResult,
  type ConsolidationGroundView,
  type ExtenderView,
  type FuelMethod,
  type LegalityRequest,
  type LegalityUnit,
  type ModeState,
  type ModeUnitClass,
  type ModeUnitProfile,
  type MoveContext,
  type MoveUnitRuntime,
  type MoveUnitView,
  type MovementSegmentPhase,
  type NkvdDefenseUnitView,
  type RailSupplyFacts,
  type RailNeighborSource,
  type ReachableHex,
  type RetreatFacts,
  type StepOutcome,
  type SupplyMobility,
  type TargetHexFacts,
  type ThrowHqView,
  type TraceSupplyFacts,
  type TraceSupplySourceView,
  type TraceSupplyUnitView,
} from '@/engine/rules'

/**
 * 骨架操作台（U0）的**纯逻辑**：摆子 → 引擎输入 → 引擎结论
 *
 * 分工（CODE_SPEC 分层）：
 *   - 本文件：**无状态**的换算，把操作台摆出的算子折成引擎能吃的视图/上下文，
 *     并把引擎结论（MP 消耗、骰点、战果）整理成可直接显示的形状；
 *   - stores/workbench.ts：持状态（摆子、当前方、日志、RNG）并调用本文件；
 *   - views/WorkbenchView.vue：只画图与收点击，**不做任何规则计算**。
 *
 * 「不得无中生有」的落法：操作台自己不定任何数值——MA/AR/战斗值取自单位库，
 * 取费/合法性/战果一律问引擎（evaluateStep / checkLegality / resolveCombat），
 * 本文件只做字段搬运与展示整形。
 */

/* ────────────────────────────── 单位记录 → 操作台算子 ────────────────────────────── */

/** 单位记录视图：数据层的只读记录或测试用部分字段（不手写第二份接口） */
export type UnitRecordView = Partial<DeepReadonly<UnitRecord>> & { id: string }

/** 机动类型映射（3.1a：数据层写 tracked，引擎口径写 track） */
const MOBILITY_BY_CLASS: Record<string, MoveUnitView['mobility']> = {
  leg: 'leg',
  truck: 'truck',
  tracked: 'track',
}

/** 单位的两面（5.0：战斗面 / 移动面） */
export type UnitFace = 'combat' | 'move'

/**
 * 3.1a 机动类型（**逐面**）
 *
 * 「颜色表示地面单位的移动类型……**算子一面和另一面的颜色可能不同**」⇒ 机动类型随面而异
 * （本作已落值记录里 48 条 leg↔truck、24 条 truck↔leg 两面不同）。取值优先级：
 *   ① 该面的 `mobilityByFace[face]`；② 记录级 `classes.movementClass`（缺面时的回退）；③ 徒步。
 */
export function mobilityOf(
  record: UnitRecordView,
  face: UnitFace = 'combat',
): MoveUnitView['mobility'] {
  const className = record.mobilityByFace?.[face] ?? record.classes?.movementClass
  return (className !== undefined ? MOBILITY_BY_CLASS[className] : undefined) ?? 'leg'
}

/** 是否战斗单位（3.2：优先取 isCombat，缺省按「有无非战斗分类」推断） */
export function isCombatUnit(record: UnitRecordView): boolean {
  if (typeof record.isCombat === 'boolean') return record.isCombat
  return record.noncombatKind === undefined || record.noncombatKind === null
}

/**
 * 13.0：是否**运输单位**（运输点数 / 编内卡车 / 延补队）
 *
 * 用户 2026-09-15 裁定：「**运输单位只有移动模式，没有战斗模式**，参见规则书 13.0」。
 * 故这三类的模式恒为 `move`，且它们的「两面」**不表示战斗/移动**：
 *   · 编内卡车：两面是**满载 1F-45 / 空载 1-45**（13.2h 印法）⇒ 面由**装载**决定；
 *   · 普通运输点数：**单面**（数据里 `images.back = null`），点数不同才是不同算子；
 *   · 延补队：两面是**延补队面 / 5 点运输点数面**（12.7），按记录整体切换、不走朝向。
 */
export function isTransportUnit(record: UnitRecordView): boolean {
  const kind = record.noncombatKind ?? null
  return kind === 'transport_point' || kind === 'organic_truck' || kind === 'supply_extender'
}

/** 团当量（4.6）：取单位库 reSize；缺失按 0（非战斗单位不计入堆叠上限） */
export function reOf(record: UnitRecordView): number {
  return record.reSize ?? 0
}

/** 某一面的印值（5.0：战斗面 / 移动面） */
export interface FaceFactors {
  attack: number
  ar: number
  ma: number
  /**
   * 3.1a：该面的**机动类型**（印值 MA 的取色判定；两面可能不同）
   *
   * 与 `attack/ar/ma` 同属「朝向那一面的印值」⇒ 与 `raw` 一起刷新，引擎按 `raw.mobility` 读。
   */
  mobility: MoveUnitView['mobility']
  /** 炮兵轰炸值与射程（仅火炮单位有） */
  barrage?: number
  range?: number
}

/**
 * 取某面的印值（缺项按 0，**不做任何规则推演**）
 *
 * ★ **单面算子**（运输点数、延补队、各种中立标记：数据里 `images.back = null`，且没有
 *   `factors.move`）只有一面印值，两个朝向读到的都是它——否则强制「运输单位恒为移动模式」
 *   （13.0）后，`raw.ma` 会变成 0，运输点数会被自己定死不动。
 */
export function faceFactorsOf(record: UnitRecordView, face: UnitFace): FaceFactors {
  const both = record.factors ?? {}
  const isSingleFaced = both.move === undefined
  const factorSet =
    face === 'combat' ? (both.combat ?? both.move) : isSingleFaced ? both.combat : both.move
  const barrage = factorSet?.barrage ?? undefined
  const range = factorSet?.range ?? undefined
  return {
    attack: factorSet?.attack ?? 0,
    ar: factorSet?.ar ?? 0,
    ma: factorSet?.ma ?? 0,
    mobility: mobilityOf(record, face),
    ...(barrage === undefined ? {} : { barrage }),
    ...(range === undefined ? {} : { range }),
  }
}

/** 9.4d 攻击方类别（数据层 classes.combatClass 三档；缺省 other） */
export type CombatClass = 'armor' | 'mech' | 'other'

/** 操作台摆出的算子 */
export interface ConsoleUnit {
  /** 实例 id（同一算子可摆多份；引擎用 id 索引，故直接拿它当引擎单位 id） */
  instanceId: string
  /** 单位库主键 */
  unitId: string
  /** 显示名（中文名优先，退回英文名，再退回主键） */
  name: string
  /**
   * 算子图档（单位库 `images`；渲染按朝向取正面/背面）
   *
   * 只做**透传**：画不画、画多大由渲染层决定（CODE_SPEC §3.1 渲染只读）。
   */
  images: { front: string | null; back: string | null } | null
  side: Side
  hex: HexRef
  isCombat: boolean
  attackCapable: boolean
  /** 非战斗单位类型（4.8 的「每格 1 港口/基地/工事」用） */
  noncombatKind?: string | null
  /**
   * 3.1a：**创建时**那一面的机动类型（= `faces[创建面].mobility`）
   *
   * ★ 引擎**不读**这个字段——机动类型随朝向变（`raw.mobility`），唯一读点是 `effectiveMobilityOf`。
   *   保留它只为**旧存档**（`raw` 里还没有 `mobility` 的时候）能退回修前的记录级口径。
   */
  mobility: MoveUnitView['mobility']
  /** 9.4d 攻击方类别 */
  combatClass: CombatClass
  re: number
  /** 模式状态（5.x：基础面 + 层叠标记） */
  mode: ModeState
  /** 朝向那一面的印值（= `faces[朝向]`；5.4a：一切数值以朝向那一面为基准） */
  raw: FaceFactors
  /** 两面的印值（5.4a / 5.7a：改朝向即改读哪一面；模式切换后须刷新 `raw`） */
  faces: { combat: FaceFactors; move: FaceFactors }
  /** 12.5a：是否已加注燃料 */
  fuelled: boolean
  /**
   * 12.5c：这枚燃料是用**哪种方法**加的（决定持续期；`null` = 未按规则记账，按持续到清理阶段处理）
   *
   * - `formation`（12.5c-A）/ `hq`（12.5c-B）：持续到**下一个友方清理阶段**（12.5d 才移除标记）；
   * - `singleUnit`（12.5c-C）：**只在当前阶段有效** ⇒ 换阶段即失效。
   */
  fuelMethod: FuelMethod | null
  /**
   * 4.5 / 12.6 / 12.8：该单位**此刻是否有补给**（断补则为 false）
   *
   * 消费方：9.5a/12.8d 战斗值减半、4.5 断补不投射 ZOC、12.8e 突围资格、界面断补图标。
   * 写入点（唯一一处）：`workbench.markTraceSupply`——由 12.3a/b 拖取成功置真、
   * 由 12.6c/d 断补处置按引擎结论落盘。
   * ★ 创建时的初值 `true` 只是「开局视为有补给」的**起始假设**，不是规则结论：
   *   12.6 的逐单位评估在补给阶段做（见接线计划 P1-1）。
   */
  hasTraceSupply: boolean
  /**
   * 12.8e：该单位**连续无追溯补给**的起点回合（`null` ＝ 此刻有补给或从未断补）
   *
   * 「在一个单位发现自己没有追溯补给的**第一个回合**（不是在『吃图上补给』之后，也不是在使用补给储备或
   *   树皮汤等特殊的追溯补给方式之后），上述条件将被免除，且成功概率会提高，即获得 **+1 的掷骰修正**，
   *   并且**运输点数也允许进行突围**。」
   * ⇒ 判定"是不是首回合"＝ `cutSinceTurn === turn`（**回合**级，不是"此刻是否有补给"）。
   * 由 `workbench.refreshTraceSupply` 维护：有补给即清 `null`；无补给且尚未记录则落当前回合。
   * ★ 修前突围资格取的是 `!unit.hasTraceSupply`（＝"此刻无补给"）⇒ 任何断补单位永远白拿首回合豁免。
   */
  cutSinceTurn: number | null
  /**
   * 12.6h：该单位被**空投**（14.10）下来的那一回合
   *
   * 「进行计划中的空投（14.10b）的单位，**在被空投那个回合中不需要追溯补给**。」
   * ⇒ 与当前回合相等时豁免追溯补给判定（不被标断补、不计入断补连续期）。
   */
  airDropExemptTurn: number | null
  /**
   * 12.8e 括注：该单位本回合靠**特殊续命**维生（12.6c 吃图上补给 / 12.10e 部队储备 / 21.10 补给缓存）
   *
   * 「（不是在『吃图上补给』之后，也不是在使用补给储备或树皮汤等特殊的追溯补给方式之后）」——
   * 这三种方式**不构成**追溯补给，故那一回合**不算**"被切断的第一个回合"。
   */
  sustainedBySpecialSupplyTurn: number | null
  /** 13.8a：是否具备工程能力（5.10e 与工程类动作判定用） */
  engineerCapable: boolean
  /** 6.1a/6.1b：本阶段已消耗的 MP（MA 是一阶段的**总额度**，不是单步额度） */
  mpSpent: number
  /** 本阶段本轮移动是否已结束（4.5a-A 强制停止 / 6.1c 最小移动 / 6.2b All 地形耗尽 / 6.1f 掉队） */
  movementEnded: boolean
  /**
   * 4.5b：本阶段已承诺「之后不再消耗 MP」（**垫人**抵消敌方 ZOC 的代价）
   *
   * 该格内只要有一个处于此状态的己方战斗单位，敌方 ZOC 即被抵消。
   */
  mpLockedThisPhase: boolean
  /** 单位库的规则化标签（5.5c 补员 / 5.7f 运输点数 / 6.1b 设施等模式归类用） */
  specialized: readonly string[]
  /**
   * 3.1c：所属**多单位编队**的番号（`null` ＝ 不属于任何多单位编队）
   *
   * 由**数据**定死（用户 2026-09-17 裁定：「编队单位肯定是定死的」），玩家不可声明。
   * 用途：3.2f 的"独立单位"判据（12.5c-B/12.5e 的 HQ 法只覆盖独立单位）、12.6f 的编队同源。
   */
  formation: string | null
  /** 印值军力点数（3.2d：多军力单位 9.11d 的减半判据） */
  printedSteps: number
  /** 当前剩余军力（9.11 损失后递减；0 = 应移入死亡堆） */
  steps: number
  /** 部队储备（12.10；null = 未判定） */
  internalStocks: InternalStocks
  /** 反坦克效果等级（9.4e：重 / 轻 / 无） */
  atEffects: AtLevel
  /** 非战斗单位等级（16.0 环形工事等级用；无则 0） */
  noncombatLevel: number
  /**
   * 12.1a：SP 算子的**当前点数**（数据层 `noncombatDetails.spValue`；非 SP 为 0）
   *
   * 用于渲染选图（不同点数对应不同算子图）与拆并补给台；点数变了图就要跟着变。
   */
  noncombatSp: number
  /**
   * 9.14c：运输点算子的**点数**（数据层 `noncombatDetails.transport`；非运输点为 0）
   *
   * 夺取表按「MA > 10 = 卡车列 / MA ≤ 10 = 马车列」**先合并同类再掷骰**，本项是该算子的点数份额。
   */
  noncombatTransport: number
  /** 9.14c：运输点类别（`truck` / `wagon`；非运输点为 null，由数据层给出） */
  noncombatTransportKind: string | null
  /**
   * 13.2f：该运输点数**当前装载的 SP**（吨位；未装为 0）
   *
   * 「运输点数在一个格内装载/卸载任意数量的 SP 时，需支付它印刷 MA 的 10%」——装卸是**点数自身的**状态，
   * 故记账落在算子上。★ 修前这笔账根本不存在（`specialObjectsAt` 里 `loadedSpT` 恒写 0），
   * 于是 9.14 的夺取表从运输点算子上「夺取到」的 SP 恒为 0，而 13.6c 的「到货满载 SP」也只是一句提示。
   */
  loadedSpT: number
  /**
   * 13.1b：HQ 的**印值投递距离**（战斗面与移动面不同；非 HQ 为 null）
   *
   * 12.3b 的投递距离就是它；按**当前朝上的那一面**取（5.4a：一切数值以朝向面为基准）。
   */
  throwRange: { combatFace: number; moveFace: number } | null
  /**
   * 单位库的能力标签（`special_abilities`；专规 2.3b 的 NKVD 判据取自此）
   *
   * 与 `specialized` 分开保留：`specialized` 是**模式/规模分类**（replacement/hq/breakdown…），
   * `specialAbilities` 是**规则能力**（nkvd_border_forced_roll 等），两者判据不同，不可混用。
   */
  specialAbilities: readonly string[]
  /**
   * 专规 2.4：Slow Mobilization 的**锁定**师
   *
   * 「被锁的师不能移动、不能移动（也不能拆出 breakdown）」⇒ 锁定期间不得移动，也不得创建拆分单位；
   * 按表 2-2 逐日解锁（玩家自选具体哪个师）。
   */
  locked: boolean
  /** 13.5c：AR 后是否有黄点（`rebuildable === false` ⇒ 摧毁即永久移除，不可重建） */
  rebuildable: boolean
  /**
   * 13.5e：该卡车是否**因敌方行动**被摧毁或夺取
   *
   * 「只有被敌方行动摧毁（或夺取）的卡车才能以这种方式重建，因此玩家拥有的卡车数量永远不能
   *   超过剧本提供给他的数量」⇒ 由裁判在摧毁时置真（缺省 false ＝ 不能重建）。
   */
  destroyedByEnemy: boolean
  /**
   * 装甲集群归属（Smolensk 专规 3.4：`guderian` = 2nd Panzer Group / `hoth` = 3rd Panzer Group）
   *
   * 取自**素材库的编队目录**（由 `sync-units` 落到单位数据）⇒ 玩家不必逐个声明编队归属；
   * 非装甲集群单位（步兵师 / 独立单位 / 中立单位）为 null。
   */
  panzerGroup: 'guderian' | 'hoth' | null
  /**
   * 13.5：**补员算子标记**（`null` ＝ 普通算子）
   *
   * §5-D（用户 2026-10-25 裁定「规则字面，一次掷骰给 5 点就摆 5 枚」）：补员从"账本数字"
   * 升级为**盘面算子**——每 1 点 Pax / Eq 就是一枚独立的 `Pax Repl` / `EQ Repl` 算子，
   * 与普通算子同链移动、堆叠、被攻击、被轰炸摧毁。判据只用这一个字段（不另立实体类型），
   * 于是移动/战斗/损失/渲染全部复用既有链路，只在下列几处按 13.5 特判：
   *   · 恒为**移动模式**（「补员永远无法进入战斗模式」）⇒ 创建即 move，切面被拒；
   *   · 被摧毁 ⇒ **直接消灭移除，不进死亡堆**（用户裁定）；
   *   · 重建时按「所在格内的枚数」供给（13.5a「所需补员必须都在一个格中」由结构保证）。
   */
  replKind: ReplKind | null
}

/** 13.5：补员种类（Pax＝人员补员 / Eq＝装备补员；Ftr/Tac 按专规 1.6 只走账本，不做盘面算子） */
export type ReplKind = 'pax' | 'eq'

/** 是否补员算子（§5-D：盘面补员的唯一判据） */
export function isReplUnit(unit: { replKind?: ReplKind | null }): boolean {
  return unit.replKind != null
}

/**
 * 单位记录的**显示名**（中文名 → 英文名 → **算子上的印刷名** → 主键）
 *
 * ★ 唯一实现：`toConsoleUnit` 的 `name`、到达卡的条目匹配、专规 2.3c 的编制转化对号都走这里，
 *   不得各处再写一遍（三处各写一遍时，2.3c 的对号就与显示名漂移了）。
 * ★ `vassalName` 是**算子上印的名字**（如 `Ru 107 Mot Div`）：本作绝大多数记录没有 nameZh/nameEn，
 *   故必须在退回主键**之前**用它——否则界面会显示主键（`su-motorized-ru-107-mot-div`）这种
 *   对玩家无意义的字符串（实测专规 2.3c 的面板文本即如此）。
 */
export function recordNameOf(record: UnitRecordView): string {
  return record.nameZh ?? record.nameEn ?? record.vassalName ?? record.id
}

/**
 * 13.6 / §5-A：**单位名的规则化归一**（到达卡条目 ↔ 算子库记录的匹配用）
 *
 * 为什么需要：到达卡面名**不带方前缀**（"5 Inf Div"），而算子库的印刷名**带**（"Ge 5 Inf Div"）——
 * 精确相等匹配实测 **0/90**（轴）、**0/117**（苏）⇒ 玩家永远要手选"库中型号"。
 * 这里只做**几件确定的事**：去掉方前缀（Ge/Ru/So/Fi/It/Hu/Ro/Ax/Su）、折叠空白、转小写。
 * ★ 匹配方仍有"**归一后唯一命中**"守卫：同名歧义 ⇒ 不匹配（绝不猜一个）。
 */
export function normalizeUnitName(name: string | null | undefined): string {
  return (name ?? '')
    .trim()
    .replace(/^(?:Ge|Ru|So|Fi|It|Hu|Ro|Ax|Su)\s+/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * 13.6 / §5-A：**兵种/编成的同义词归一表**（卡面用词 ↔ 算子库印刷用词）
 *
 * 只收"两边确实同一件事、只是写法不同"的对应，**不做语义推断**：
 * - `Inf`（卡面）↔ `Rifle`（苏军库）——同一批步兵师，库内统一叫 Rifle Div；
 * - `Mtr`/`Motorized`（卡面）↔ `Mot`（库）；
 * - `Mil` ↔ `Militia`、`Abn`/`Para` ↔ `Airborne`、`Mtn` ↔ `Mountain`、
 *   `AT`/`PJ` ↔ `AntiTank`、`Tk` ↔ `Tank`、`Pz` ↔ `Panzer`、`Cav` ↔ `Cavalry`、`Arty` ↔ `Artillery`。
 * ★ 表里没有的词**不做任何假设**（原样保留），故不会把"A 兵种"匹配成"B 兵种"。
 */
const UNIT_NAME_ALIASES: Readonly<Record<string, string>> = {
  inf: 'rifle',
  mil: 'militia',
  mtr: 'mot',
  motorized: 'mot',
  mtn: 'mountain',
  abn: 'airborne',
  para: 'airborne',
  tk: 'tank',
  pz: 'panzer',
  cav: 'cavalry',
  arty: 'artillery',
  at: 'antitank',
  pj: 'antitank',
  bde: 'brigade',
  rgt: 'regiment',
  bn: 'battalion',
  co: 'company',
  div: 'division',
}

/** 归一化时**丢弃**的修饰词（对"哪一枚算子"没有区分力） */
const UNIT_NAME_NOISE = new Set([
  'each',
  'step',
  'loaded',
  'with',
  'sp',
  '2x',
  '3x',
  '4x',
  'see',
  'and',
  'the',
  'points',
  'point',
  'markers',
  'reserve',
])

/**
 * 13.6 / §5-A：**单位名的词集键**（顺序无关、强度无关）
 *
 * 与 `normalizeUnitName` 的区别：卡面与库里的**词序不同、多带强度/修饰**——
 * 如卡面 `5th Corps HQ` vs 库 `Ge HQ 5th Corps`；卡面 `1 NKVD Inf Rgt` vs 库 `Ru 1 NKVD Mot Inf Rgt`；
 * 卡面 `194 Mtn Inf Div` vs 库 `Ru 194 Mtn Div`。所以键必须**丢顺序、丢强度**。
 *
 * 确定地做这几件事（每一条都能对回原文，不做语义猜测）：
 * 1. 去方前缀、小写、`1.Cav` 的点当分隔、`/` 当分隔；
 * 2. 丢**括号内容**（`(2)-2-2`、`(see 2.4)`、`(9, 12)`）；
 * 3. 丢**纯强度数码**（`12-2-2`）、丢只由数字与连字符组成的残片；
 * 4. 序数词归基数（`5th`→`5`、`53rd`→`53`）；
 * 5. 走同义词表（`Inf`→`rifle`…）；`4M` 在含 militia 时归 `4`（民兵师的"M"是编成标记）；
 * 6. 丢修饰词（`loaded with SP`、`each -1 step`、`2x`…）。
 *
 * 结果按字典序拼接成字符串，可直接当 Map 键比较。
 */
export function unitNameKey(name: string | null | undefined): string {
  const raw = normalizeUnitName(name)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\./g, ' ')
    .replace(/['’]/g, '')
    .replace(/\//g, ' ')
  // 字母之间的连字符是分隔（`2-8 PJ`→`2 8 PJ`、`I-1` 保留编号语义则不动）
  const spaced = /[a-z]-[a-z]/.test(raw) ? raw.replace(/-/g, ' ') : raw
  const tokens: string[] = []
  for (const rawToken of spaced.split(/[\s,]+/)) {
    let token = rawToken.replace(/^[.,;:-]+|[.,;:-]+$/g, '')
    if (token === '' || UNIT_NAME_NOISE.has(token)) continue
    // 纯强度数码（12-2-2 / 2-1-3）与"数字+连字符"残片（-2-2）
    if (token.includes('-') && /^[\d-]+$/.test(token)) continue
    token = token.replace(/^(\d+)(?:st|nd|rd|th)$/, '$1')
    tokens.push(UNIT_NAME_ALIASES[token] ?? token)
  }
  // 民兵：`4M Mil Div` 的 "4M" 就是 `4`（含 militia 才归，避免动到别的番号）
  const keyed = tokens.includes('militia')
    ? tokens.map((token) => token.replace(/^(\d+)m$/, '$1'))
    : tokens
  return [...new Set(keyed)].sort().join(' ')
}

/** 词集键切成 set（子集容错比较用） */
export function unitNameTokenSet(name: string | null | undefined): Set<string> {
  const key = unitNameKey(name)
  return new Set(key === '' ? [] : key.split(' '))
}

/** 由单位记录造一个操作台算子（默认朝向战斗面、战斗模式，补给与燃料视为已就绪） */
export function toConsoleUnit(input: {
  record: UnitRecordView
  instanceId: string
  hex: HexRef
  /** 归属方（中立算子 side='both' 时由调用方指定按哪一方上场） */
  side: Side
  face?: 'combat' | 'move'
}): ConsoleUnit {
  /*
   * 13.0（用户 2026-09-15 裁定）：**运输单位只有移动模式**，不因调用方传了 combat 面就变成战斗模式
   * 13.5（§5-D）：**补员算子同样恒为移动模式**——「补员永远无法进入战斗模式，但可以进入所有其他模式」。
   *   两条都写死在这里（创建即 move），切换面由 store 的 `switchUnitMode` 拒绝。
   */
  const face: UnitFace =
    isTransportUnit(input.record) || replKindOfRecord(input.record) !== null
      ? 'move'
      : (input.face ?? 'combat')
  const { record } = input
  const faces = { combat: faceFactorsOf(record, 'combat'), move: faceFactorsOf(record, 'move') }
  return {
    instanceId: input.instanceId,
    unitId: record.id,
    name: recordNameOf(record),
    images:
      record.images === undefined || record.images === null
        ? null
        : { front: record.images.front ?? null, back: record.images.back ?? null },
    side: input.side,
    hex: input.hex,
    isCombat: isCombatUnit(record),
    attackCapable: record.attackCapable === true,
    noncombatKind: record.noncombatKind ?? null,
    mobility: mobilityOf(record),
    combatClass: record.classes?.combatClass ?? 'other',
    re: reOf(record),
    mode: { mode: face, orientation: face, dg: false, exploit: false },
    raw: faces[face],
    faces,
    /*
     * 12.5a / 12.5c（用户 2026-09-16 指正）：**新上场的单位默认"未加注燃料"**。
     *
     * 修前这里是 `fuelled: true` 的便利缺省（注释写着"视为持续到本方清理阶段"）⇒
     * 后果是**燃料这条规则整局都不会被触发**：轮式/履带战斗单位随便动，12.5a 的
     * 「即使就移动一格也必须先付」永远不会问玩家，`payFuel` 也就没有存在的必要。
     * 12.5c 说得明确：「在发生燃料消耗的**任何阶段**，单位都应在**燃料消耗时**支付」
     * ⇒ 未付就是未加注，由玩家在耗 MP 的当口付（编队法/HQ 法/单独单位法三选一）。
     * 12.5f 亦同：增援部署不需燃料，但**移动离开入场格时**要付。
     * 需要"已加注"的场合（测试夹具 / 裁判订正）请**显式**写 `unit.fuelled = true`。
     */
    fuelled: false,
    fuelMethod: null,
    hasTraceSupply: true,
    /*
     * 12.8e / 12.6h（批 F 切片 5）：**断补状态的逐回合跟踪**——三件事分三个字段，互不覆盖：
     *   · `cutSinceTurn`：**连续无追溯补给的起点回合**（"发现自己没有追溯补给的第一个回合"）；
     *   · `airDropExemptTurn`：被空投的那一回合（12.6h：该回合**不需要**追溯补给）；
     *   · `sustainedBySpecialSupplyTurn`：本回合靠**特殊续命**维生（12.6c 吃图上补给 / 12.10e 部队储备 /
     *     21.10 补给缓存）——12.8e 括注明写这三种方式**不算**"被切断的第一个回合"。
     * 三个字段都由 `workbench.refreshTraceSupply` / 各自的落盘动作**当场算定**，不由玩家声明。
     */
    cutSinceTurn: null,
    airDropExemptTurn: null,
    sustainedBySpecialSupplyTurn: null,
    /*
     * 13.8a / 13.8 首段：**工程能力**的适格单位
     *
     * 「**指挥部和工程兵 (Engineer)** 是唯二可执行工程能力（架桥、建造和创建火车卸货格）的单位。
     *   相似的类型单位，如**铁路修理单位**、突击工兵单位、**工兵单位(Pioneer)** 和空降/滑翔机工程兵
     *   单位，**不能**执行本节所列的能力。」
     * ⇒ 本作单位库里 engineering 相关的算子只有 `Ge 43 Pioneer Bn`（Pioneer）与 `*-RR-*`（铁路修理），
     *   两者按原文**都不能**；本作**没有** Engineer 类型的算子 ⇒ 13.8 族只认**指挥部**。
     *   （铁路修理单位的那一族是 **13.3f/13.3g 换轨**，判据在 store 的 `isRailRepairUnit`，
     *     与 13.8 族是两回事 —— 修前这里把 `rail_repair` 也算进来，等于让 Pioneer/铁路修理也能施工。）
     * B43：本条即第三批方案 §2.3 C-1 的修复（先核过 13.3g 换轨：`legality.ts` 的 `railConversion`
     *   分支只认 `unit.railRepair`，故收窄本标志**不影响换轨**）。
     */
    engineerCapable: (record.specialized ?? []).includes('hq'),
    mpSpent: 0,
    movementEnded: false,
    // 4.5b：垫人承诺由玩家在界面上显式许诺（见 store 的 lockZocNegation）
    mpLockedThisPhase: false,
    specialized: record.specialized ?? [],
    // 3.1c：编队归属由**数据**定死（缺键 ＝ 不属于任何多单位编队）；3.2f 的独立单位判据取此处
    formation: record.formation ?? null,
    printedSteps: record.steps?.total ?? 1,
    steps: record.steps?.total ?? 1,
    internalStocks: null,
    atEffects: record.atEffects ?? 'none',
    noncombatLevel: record.noncombatDetails?.level ?? 0,
    // 12.1a：SP 点数（渲染选图 + 拆并补给台用）
    noncombatSp: record.noncombatDetails?.spValue ?? 0,
    // 9.14c：运输点算子的**点数**与类别（卡车/马车）——夺取表按点数分组掷骰
    noncombatTransport: record.noncombatDetails?.transport ?? 0,
    noncombatTransportKind: record.noncombatDetails?.transportKind ?? null,
    // 13.2f：装卸 SP 的状态，初始为空载（13.6c 的「到货满载」由投放路径显式设定）
    loadedSpT: 0,
    // 13.1b：只对带印值投递距离的记录落值（其余为 null，避免把普通单位误当 HQ）
    throwRange: (() => {
      const range = record.throwRange
      if (range === undefined || range === null) return null
      return { combatFace: range.combatFace ?? 0, moveFace: range.moveFace ?? 0 }
    })(),
    // 规则能力标签（专规 2.3b 的 NKVD 判据取自此）
    specialAbilities: record.specialAbilities ?? [],
    // 专规 2.4：锁定状态由裁判在 Slow Mobilization 期间逐个设置（缺省不锁）
    locked: false,
    // 13.5c：AR 后有黄点的单位不可重建（数据层 rebuildable === false）
    rebuildable: record.rebuildable !== false,
    // 13.5e：卡车须「因敌方行动被摧毁/夺取」才可重建（由裁判在摧毁时置真）
    destroyedByEnemy: false,
    // 3.4：装甲集群归属（取自素材库编队目录 ⇒ 落进单位数据；玩家不用设置）
    panzerGroup: record.panzerGroup ?? null,
    /*
     * 13.5 / §5-D：补员算子标记。
     * 补员记录（`branch === 'replacement'`）按 Pax / EQ 两族区分；**创建即移动模式**
     * （13.5「补员永远无法进入战斗模式」）——与运输点数同一处理（13.0 用户裁定）。
     */
    replKind: replKindOfRecord(record),
  }
}

/**
 * §5-D：这条记录是哪一种补员算子（`null` ＝ 不是补员）
 *
 * 判据只用单位库的结构化字段：`branch === 'replacement'` + 印刷名里的 `Pax` / `EQ`
 * （两侧各两条：`Ge/Ru Pax Repl`、`Ge/Ru EQ Repl`），不靠猜。
 */
export function replKindOfRecord(record: UnitRecordView): ReplKind | null {
  if (record.branch !== 'replacement') return null
  const name = (record.vassalName ?? record.nameEn ?? record.nameZh ?? record.id).toUpperCase()
  if (/\bPAX\b/.test(name)) return 'pax'
  if (/\bEQ\b/.test(name)) return 'eq'
  return null
}

/** §5-D：该方的补员算子记录（每点一枚；库里没有 ⇒ null，调用方据此拒绝摆放） */
export function replRecordOf(side: Side, kind: ReplKind): UnitRecordView | null {
  const wanted = kind === 'pax' ? 'pax' : 'eq'
  // 直取原始库（不经 `unitChoices`：那里按 §5-D 把补员滤掉了）
  const source = side === 'axis' ? unitsAxis.units : unitsSoviet.units
  return (
    source.find(
      (record) =>
        (record.status === 'valued' || record.status === 'verified') &&
        replKindOfRecord(record) === wanted,
    ) ?? null
  )
}

/** 摆子清单里可选的单位（按方取单位库；只列已落值/已核对的记录） */
export function unitChoices(side: Side): UnitRecordView[] {
  const source = side === 'axis' ? unitsAxis.units : unitsSoviet.units
  return source.filter(
    (record) =>
      (record.status === 'valued' || record.status === 'verified') &&
      /*
       * §5-D：**补员算子不进挑选清单**——它只由"掷可变补员表 → 放置"产生（13.5），
       * 不是裁判从库里挑来摆子的对象（到达/拆分/初设都不该出现它）。
       * ★ 也顺带避免夹具谓词误取：`Pax Repl` 同样是 leg/可攻击/MA 5，
       *   出现在通用清单里会让"随便挑一个步兵/摩托化单位"的测试挑到它。
       */
      record.branch !== 'replacement',
  )
}

/* ────────────────────────────── 操作反馈（M9②） ────────────────────────────── */

/** 一条操作反馈（界面按 tone 上色、按 rule 显示规则号） */
export interface FeedbackRow {
  id: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  text: string
  /** 规则编号（无则 null） */
  rule: string | null
}

/**
 * 组装「操作反馈」区要显示的行（M9②）
 *
 * 两个来源合成一列，**最新的在最上面**：
 *   ① 当前被拒的一步（`moveBlocked`：移动/开拔被拒的原因代码 + 规则号）——置顶且标 danger；
 *   ② 操作台日志最近 `limit` 条（引擎落下的、带规则号的解释）。
 *
 * ★ 纯函数、只做取景与排序：文本与规则号都是引擎/store 已经算好的，界面不得改写判据。
 */
export function feedbackRowsOf(input: {
  log: readonly { id: string; kind: FeedbackRow['tone']; text: string; rule?: string }[]
  moveBlocked?: { rule: string; reason: string } | null
  limit?: number
}): FeedbackRow[] {
  const rows: FeedbackRow[] = []
  if (input.moveBlocked !== undefined && input.moveBlocked !== null) {
    rows.push({
      id: 'move-blocked',
      tone: 'danger',
      text: `这一步被拒：${input.moveBlocked.reason}`,
      rule: input.moveBlocked.rule,
    })
  }
  for (const entry of input.log.slice(0, input.limit ?? 6)) {
    rows.push({
      id: entry.id,
      tone: entry.kind,
      text: entry.text,
      rule: entry.rule ?? null,
    })
  }
  return rows
}

/* ────────────────────────────── 地图内就地提示（B9） ────────────────────────────── */

/** 地图内就地一行的提示（给渲染层用；无提示时上层传 null） */
export interface MapHint {
  text: string
  /** 规则编号（有则原样显示，方便玩家翻条文） */
  rule: string | null
  /** 语气：拒绝=warning、移动受阻=danger（与操作反馈区的 tone 同词表） */
  tone: 'warning' | 'danger'
}

/**
 * 把"当前被拒的一步"折成**地图内一行提示**（B9）
 *
 * 用户口径：「任何被拒的操作都在**原地**给一行规则号提示（不弹窗、不离开地图）」——
 * 故这一行必须画在地图上，而不是只在侧栏反馈区里。两个来源，取更贴"刚发生的事"的那个：
 *   ① `refusal`（B8 的统一闸门）：说明"这个动作此刻只能在「X 段 · Y 环节」做"；
 *   ② `moveBlocked`：说明"这一格为什么走不到/开拔不了"。
 *
 * ★ 纯函数：文本与规则号都是 store 已经算好的，界面只做取舍与拼装。
 */
export function mapHintOf(input: {
  refusal?: { key: string; rule: string; reason: string } | null
  moveBlocked?: { rule: string; reason: string } | null
}): MapHint | null {
  const refusal = input.refusal ?? null
  if (refusal !== null) {
    return {
      text: `本环节不能做这一步：${refusal.reason}`,
      rule: refusal.rule,
      tone: 'warning',
    }
  }
  const blocked = input.moveBlocked ?? null
  if (blocked !== null) {
    return { text: `这一步被拒：${blocked.reason}`, rule: blocked.rule, tone: 'danger' }
  }
  return null
}

/* ────────────────────────────── 操作台算子 → 引擎视图 ────────────────────────────── */

/**
 * 3.1a：单位**此刻生效**的机动类型（按朝向那一面）
 *
 * ★ 唯一读点：全仓凡「引擎要机动类型」处（6.2 TEC 列 / 4.5a-A 轮式 EZOC 必停 / 12.5a 燃料 /
 *   4.7b 铁路当量 / 9.14d 位移）都从这里取，不读 `unit.mobility`。
 * `raw` 就是「朝向那一面的印值」（5.4a），模式切换与换朝向时由 store 刷新 ⇒ 无须另设缓存字段。
 * 旧存档的 `raw` 里没有 `mobility` ⇒ 退回 `unit.mobility`（修前的记录级口径，只降级不崩）。
 */
export function effectiveMobilityOf(unit: ConsoleUnit): MoveUnitView['mobility'] {
  return unit.raw?.mobility ?? unit.mobility
}

/** 操作台算子 → 引擎移动视图（MoveUnitView） */
export function toMoveUnitView(unit: ConsoleUnit): MoveUnitView {
  return {
    id: unit.instanceId,
    side: unit.side,
    isCombat: unit.isCombat,
    attackCapable: unit.attackCapable,
    hasTraceSupply: unit.hasTraceSupply,
    hex: unit.hex,
    mobility: effectiveMobilityOf(unit),
    ma: unit.raw.ma,
    re: unit.re,
    mode: unit.mode.mode,
    orientation: unit.mode.orientation,
    dg: unit.mode.dg,
    exploit: unit.mode.exploit,
    releasedFromReserve: unit.mode.releasedFromReserve === true,
    fuelled: unit.fuelled,
    // 4.5b：垫人承诺（一旦许诺，该单位本阶段起不能再消耗 MP，也不可再移动）
    mpLockedThisPhase: unit.mpLockedThisPhase,
    // 12.7 的延补队面不由操作台模拟：摆上来的算子按运输点数面处理，故 isExtenderFace 缺省为 false
  }
}

/**
 * C5：参移单位的运行态（`move-interaction.ts` 的输入视图）
 *
 * 与 `state-types.Unit` 的对应：`spentMp`→（本阶段累计已耗 MP）、`ended`→`movementEnded`。
 */
export function toMoveRuntime(unit: ConsoleUnit): MoveUnitRuntime {
  return {
    unitId: unit.instanceId,
    hex: unit.hex,
    spentMp: unit.mpSpent,
    ended: unit.movementEnded,
  }
}

/**
 * 5.5c/5.7f/5.8c/6.1b：该单位的模式归类
 *
 * 判据交给引擎的 `modeUnitClass`（唯一实现），本函数只把操作台算子折成它的输入视图。
 */
export function modeUnitClassOf(unit: ConsoleUnit): ModeUnitClass {
  return modeUnitClass({
    isCombat: unit.isCombat,
    specialized: unit.specialized,
    noncombatKind: unit.noncombatKind ?? null,
    ma: unit.raw.ma,
  })
}

/** 12.5a：该单位要消耗 MP 是否必须先付燃料（轮式/履带 MP 的**战斗单位**） */
export function needsFuelOf(unit: ConsoleUnit): boolean {
  return needsFuelToMove(toMoveUnitView(unit))
}

/**
 * 12.5c：加油方法的**中文说明**（界面用）
 *
 * 三种方法的代价与持续期不同（单独单位法只在本阶段有效；编队/HQ 法持续到本方清理阶段
 * ——见 `fuelExpiresOnPhaseChange`），界面必须把它说清，否则玩家分不清"为什么这枚油下个阶段没了"。
 * 判据不在这里（判据只有一处：引擎 `fuel.ts`），本函数只给文案。
 */
export function fuelMethodLabelOf(method: FuelMethod | null): string {
  if (method === 'formation') return '编队法（12.5c-A）'
  if (method === 'hq') return '指挥部法（12.5c-B）'
  if (method === 'singleUnit') return '单独单位法（12.5c-C）'
  return ''
}

/**
 * 13.8b：**架桥生效格**（按归属）——有工程能力的本方单位所在格 + 建造标记的「桥」面
 *
 * 「当与一个大河相邻时，具有工程能力的单位会自动将大河格边的 MP 消耗降至小河格边的 MP 消耗……
 *   只有友方单位移动**进入或离开**工程能力单位所在格时，移动消耗才能降低。」
 *
 * ★ 谁算「具有工程能力」，按 **13.8 首段**从严：「**指挥部和工程兵 (Engineer)** 是唯二可执行工程能力
 *   （架桥、建造和创建火车卸货格）的单位。相似的类型单位，如**铁路修理单位**、突击工兵单位、
 *   **工兵单位(Pioneer)** 和空降/滑翔机工程兵单位，**不能**执行本节所列的能力。」
 *   本作单位库里**没有** Engineer 类型的算子（engineering 相关的只有 `Ge 43 Pioneer Bn`＝Pioneer、
 *   `*-RR-*`＝铁路修理，两者按原文都**不能**）⇒ 架桥只有**指挥部**。专规 3.5 的建造标记「桥」面
 *   亦写明「按 OCS 13.8b 的 **HQ** 架桥处理」。
 *   ⇒ 故这里**不**复用 store 的 `engineerCapable`（它把 `rail_repair` 也算进来了，那是 13.3f 换轨
 *   那一族的口径，两者适用范围不同 —— 已在回执 §17.69 登记待单独核）。
 *
 * 模式门槛走 `canEngineer`（13.8a：战斗模式，或 DG 但朝向战斗面）；**不**用 `canEngineerInPhase` ——
 * 后者要 `moveContext` 当输入，而本函数的输出正是 `moveContext` 的一部分（会成环）。
 */
export function bridgedHexesBySide(
  units: readonly ConsoleUnit[],
  /** 专规 3.5：已放置的建造标记里**桥那一面**的格 */
  bridgeMarkerHexes: readonly HexRef[] = [],
): { axis: HexRef[]; soviet: HexRef[] } {
  const out: { axis: HexRef[]; soviet: HexRef[] } = { axis: [], soviet: [] }
  for (const unit of units) {
    if (!(unit.specialized ?? []).includes('hq')) continue
    if (!canEngineer(unit.mode)) continue
    out[unit.side].push(unit.hex)
  }
  // 专规 3.5：建造标记仅轴方可用（该规则的原文限制），故只进 axis 那一组
  for (const hex of bridgeMarkerHexes) out.axis.push(hex)
  return out
}

/** 构造移动上下文（B7）；地图事实用产品数据的默认实现 */
export function buildMoveContext(input: {
  units: readonly ConsoleUnit[]
  activeSide: Side
  phase: MoveContext['phase']
  /** 专规 1.1b：双方的安全边缘格（作为补给源的地图边格）——敌方地面单位不得进入 */
  safeEdgeHexesBySide?: { readonly axis: readonly HexRef[]; readonly soviet: readonly HexRef[] }
  /**
   * 13.8b：架桥生效格（见 `bridgedHexesBySide`）
   *
   * ★ 缺省**不注入** ⇒ 引擎视为无桥、河流按原价收费（宁可少判也不臆造桥）；
   * 调用方必须用 `bridgedHexesBySide(units, 建造标记的桥面格)` 注入，且与
   * `createBattleFacts` 用**同一份**（否则"能走过去"与"能打过去"会不一致）。
   */
  bridgedHexesBySide?: { readonly axis: readonly HexRef[]; readonly soviet: readonly HexRef[] }
  /**
   * 5.8b：该格此刻是否有**追溯补给**（引擎用它判「战略模式单位必须停在有补给的格」）
   *
   * ★ 缺省**不注入**，而 `move.ts` 的判据写成
   *   `if (mustEndMoveInSupply(state) && context.traceSupplyAt !== undefined)` ——
   *   于是不注入时那条规则**永远不生效**（实测：战略模式单位可以随便停在断补格）。
   *   调用方必须用与 12.6 同一份事实（`createTraceSupplyAt(supplyFacts)`）注入，
   *   不得另建一份。
   */
  traceSupplyAt?: (hex: HexRef, side: Side) => boolean
}): MoveContext {
  return {
    phase: input.phase,
    activeSide: input.activeSide,
    map: createMapFacts(),
    units: input.units.map(toMoveUnitView),
    ...(input.safeEdgeHexesBySide === undefined
      ? {}
      : { safeEdgeHexesBySide: input.safeEdgeHexesBySide }),
    ...(input.bridgedHexesBySide === undefined
      ? {}
      : { bridgedHexesBySide: input.bridgedHexesBySide }),
    ...(input.traceSupplyAt === undefined ? {} : { traceSupplyAt: input.traceSupplyAt }),
  }
}

/** 走一步：**直接问引擎**（6.1/6.2/4.5a-A/12.5a…）；mpSpent 用于 6.1a/6.1b 的阶段额度判定 */
export function stepUnit(
  context: MoveContext,
  instanceId: string,
  to: HexRef,
  options: { mpSpent?: number } = {},
): StepOutcome {
  return evaluateStep(context, instanceId, to, options)
}

/** 本阶段该单位的可用 MA（6.1h 不取整；供界面显示额度） */
export function availableMaOf(unit: ConsoleUnit, phase: MovementSegmentPhase): number {
  return availableMa(toMoveUnitView(unit), phase)
}

/**
 * 选中单位的**可到达格**（B7 的 UI 接口：点击单位后标识可到达格）
 *
 * 一律走引擎的 `computeReachableHexes`（与逐格 `evaluateStep` 同一套判据），
 * 故「高亮的格」与「真的能走进去」永远一致；不再用「相邻六格」冒充可到达格。
 *
 * ★ 6.1a：可到达格必须按**剩余额度**判——引擎的 BFS 以「本阶段起点」建模（`mpSpent` 从 0 起算），
 *   故这里按该单位已耗 MP 过滤：`节点累计消耗 ≤ 可用 MA − 已耗 MP`。
 *   （也正因为引擎在 `mpSpent === 0` 时才允许 6.1c 最小移动，已耗过 MP 时过滤会自然排除这类格。）
 *
 * 以下情形返回空集，由调用方决定是否再叠加阶段门槛（F 战斗段无移动环节）：
 *   - 未选中单位；
 *   - 本轮移动已结束（4.5a-A / 6.1c / 6.2b）；
 *   - 剩余额度为 0，或引擎判定该单位此刻不可移动（阶段/模式/燃料/MA，`computeReachableHexes` 失败）。
 */
export function reachableHexesOf(
  context: MoveContext,
  unit: ConsoleUnit | null,
): readonly ReachableHex[] {
  if (unit === null || unit.movementEnded) return []
  const result = computeReachableHexes(context, unit.instanceId)
  if (!result.ok) return []
  const remaining = result.ma - unit.mpSpent
  if (remaining <= 0) return []
  return result.reachable.filter((node) => node.mpSpent <= remaining)
}

/* ────────────────────────────── 合法性请求（B21） ────────────────────────────── */

/** 移动环节 → 2.2 流程阶段名（U0 只在这三段里切；三者都是 GamePhase 的成员，故为恒等映射） */
export function gamePhaseOf(phase: MoveContext['phase']): GamePhase {
  return phase
}

/** 统计某格的堆叠与敌方占据事实（4.8 / 4.8c） */
export function targetHexFacts(
  units: readonly ConsoleUnit[],
  hex: HexRef,
  side: Side,
  excludeInstanceId?: string,
): TargetHexFacts {
  let friendlyCombatRe = 0
  let enemyCombatUnits = 0
  let enemyNonCombatUnits = 0
  let ports = 0
  let airBases = 0
  let hedgehogs = 0
  for (const unit of units) {
    if (unit.hex.col !== hex.col || unit.hex.row !== hex.row) continue
    if (unit.side === side) {
      if (unit.instanceId !== excludeInstanceId && unit.isCombat) friendlyCombatRe += unit.re
      // 4.8 的「每格 1 港口」只对 port 成立；★ 本作无港口（TTW 1.1c：无海运，港口仅作地形属性），
      //   故 ports 恒为 0；**不可**把补给点/运输点等非战斗单位算成港口（SP 本可任意堆叠）。
      if (unit.noncombatKind === 'port') ports += 1
      if (unit.noncombatKind === 'air_base') airBases += 1
      if (unit.noncombatKind === 'hedgehog') hedgehogs += 1
      continue
    }
    if (unit.isCombat) enemyCombatUnits += 1
    else enemyNonCombatUnits += 1
  }
  return {
    hex,
    friendlyCombatRe,
    enemyCombatUnits,
    enemyNonCombatUnits,
    ports,
    airBases,
    hedgehogs,
  }
}

/** 操作台算子 → 合法性层的单位视图 */
export function toLegalityUnit(unit: ConsoleUnit): LegalityUnit {
  return {
    id: unit.instanceId,
    isCombat: unit.isCombat,
    attackCapable: unit.attackCapable,
    mobility: effectiveMobilityOf(unit),
    mode: unit.mode,
    re: unit.re,
    raw: unit.raw,
    engineerCapable: unit.engineerCapable,
    noncombatKind: unit.noncombatKind ?? null,
  }
}

/**
 * 构造合法性请求（B21 的唯一入口 `checkLegality` 的输入）
 *
 * 「所在格是否处于未抵消的敌方 ZOC」直接问引擎（move.inEnemyZocAt），
 * 不在此重判 4.5/4.5b。
 */
export function buildLegalityRequest(input: {
  action: ActionKind
  unit: ConsoleUnit
  context: MoveContext
  units: readonly ConsoleUnit[]
  date: string
  /** 目标格（走一步/打一仗用）；省略表示对单位所在格自身判定 */
  target?: HexRef
  modeTarget?: BaseMode
  /** 移动/突袭所需燃料是否已付（12.5a/b）：U0 以单位的 fuelled 旗标为准 */
  fuelPaid?: boolean
  /**
   * 显式阶段（2.2 SOP 段）
   *
   * 默认取移动上下文的阶段；但 **F 战斗段没有移动环节**，移动上下文的 phase 只能是 C/E/G，
   * 故凡在移动环节之外发起动作（如 F 段进攻）必须显式给出，否则会被时机族误判成 C 段。
   */
  phase?: GamePhase
}): LegalityRequest {
  const hex = input.target ?? input.unit.hex
  return {
    action: input.action,
    side: input.unit.side,
    phase: input.phase ?? gamePhaseOf(input.context.phase),
    activeSide: input.context.activeSide,
    date: input.date,
    units: [toLegalityUnit(input.unit)],
    target: targetHexFacts(input.units, hex, input.unit.side, input.unit.instanceId),
    inEnemyZoc: inEnemyZocAt(input.context, hex, input.unit.side),
    ...(input.modeTarget === undefined ? {} : { modeTarget: input.modeTarget }),
    ...(input.fuelPaid === undefined ? {} : { fuelPaid: input.fuelPaid }),
  }
}

/* ────────────────────────────── C6 战斗交互：事实与视图 ────────────────────────────── */

/**
 * 操作台算子 → 战斗单位视图（9.1/9.4/9.5/9.6/9.11）
 *
 * ★ `attack` 必须是**已按模式折算**的战斗值（5.5–5.10）：本函数按朝向那一面的印值取，
 *   DG 由 `dg` 字段单独带出（引擎按 5.10b-A 处理减半的只有模式影响矩阵，见 battle.unitBattleStrength）。
 */
export function toBattleUnitView(unit: ConsoleUnit): BattleUnitView {
  return {
    id: unit.instanceId,
    side: unit.side,
    hex: unit.hex,
    attackerType: unit.combatClass,
    attack: unit.raw.attack,
    ar: unit.raw.ar,
    dg: unit.mode.dg,
    mode: unit.mode.mode,
    releasedFromReserve: unit.mode.releasedFromReserve === true,
    printedSteps: unit.printedSteps,
    steps: unit.steps,
    re: unit.re,
    internalStocks: unit.internalStocks,
    outOfSupply: !unit.hasTraceSupply,
    mobility: effectiveMobilityOf(unit),
    attackCapable: unit.attackCapable,
    // 规则能力标签（专规 2.3b 的 NKVD 判据取自此；引擎在 9.6 / 9.10 步消费）
    specialAbilities: unit.specialAbilities,
  }
}

/**
 * 地图事实的**只读单例**
 *
 * `map-layers.json` 是静态产品数据（加载期已 Zod 校验并深度冻结），构建一次即可复用；
 * 战斗事实与格边地形名都从这里取，保证与引擎 `MapFacts.crossingBetween` 同一口径（不再自持映射表）。
 */
let cachedMapFacts: ReturnType<typeof createMapFacts> | null = null
function mapFacts(): ReturnType<typeof createMapFacts> {
  cachedMapFacts ??= createMapFacts()
  return cachedMapFacts
}

/**
 * 13.8d：建造半径的**步行 MP** 距离（**无视敌方 ZOC**）
 *
 * 唯一实现是引擎的 `legMpDistanceWithinRadius`；本处只喂**地图事实只读单例**，
 * 保证「量半径用的地形」与「6.2 移动取费的地形」是同一份数据（不另建映射表）。
 * ★ 机动类型**不由调用方给**：13.8d 的 2 格一律按**步行价目**量（用户 2026-09-15 裁定：
 *   那是**专门针对工程能力**的限制，与 6.2「按该单位自身机动类型取费」是两套口径）——
 *   修前这里收 `mobility` 形参、调用方传执行者朝向面的机动类型，口径是错的。
 * 返回 `null` ＝ 在 2 格半径内不可达（含被禁入地形隔断）。
 */
export function constructionLegMpDistance(from: HexRef, to: HexRef): number | null {
  return legMpDistanceWithinRadius({ map: mapFacts(), from, to })
}

/**
 * 9.4b：攻方堆叠可选「所穿越的格边地形」作修正（无则空数组）
 *
 * ★ 只返回**会产生战斗修正**的格边地形——河 / 湖（TEC attack 行给出真实倍率）。
 *   **铁路 / 小路 / 大路**的 attack 行为 `ot`（不产生任何数值），它们只与移动消耗（6.2a）、
 *   9.1f「只能沿路进入并攻击」、补给路径（12.3d）有关，**不得**出现在 9.4b 的选项里
 *   （引擎 `combatHexsideTerrains` 是唯一筛法，界面与 `BattleFacts` 共用它 ⇒ 不会漂移）。
 */
export function hexsideTerrainNames(from: HexRef, to: HexRef): string[] {
  const crossing = mapFacts().crossingBetween(from, to)
  if (crossing === null) return []
  const names: string[] = []
  if (crossing.river !== undefined && crossing.river !== null) names.push(crossing.river)
  if (crossing.routes !== undefined) names.push(...crossing.routes)
  return combatHexsideTerrains(names)
}

/** 9.4e 的等级秩：无 < 轻 < 重 */
const AT_RANK: Record<AtLevel, number> = { none: 0, light: 1, heavy: 2 }
/**
 * 9.4e：防御格的**反坦克等级** = 格内**防御方**单位中的最高者
 *
 * 「重型反坦克效果：所有黄色符号单位、带坦克标志的红色符号单位、带反坦克符号的单位、带防空符号的单位，
 *   以及**环形工事**都拥有此效果」——故格内有环形工事时直接是重型。
 *
 * 环形工事是格内设施（4.8：一格至多 1 个；可为中立算子），故工事判定看**全格**；
 * AT 等级只取 `defenderSide` 一方（攻方单位在防御格内的情况不存在，但接口保持严格）。
 */
export function defenderAtLevelAt(
  units: readonly ConsoleUnit[],
  hex: HexRef,
  defenderSide: Side,
): AtLevel {
  if (hedgehogLevelAt(units, hex) > 0) return 'heavy'
  let best: AtLevel = 'none'
  for (const unit of units) {
    if (!sameHexRef(unit.hex, hex)) continue
    if (unit.side !== defenderSide) continue
    if (AT_RANK[unit.atEffects] > AT_RANK[best]) best = unit.atEffects
  }
  return best
}

/**
 * 构造战斗事实（9.1f / 9.4b / 9.4c / 9.4e / 9.9）
 *
 * 全部取自地图产物与单位库，不臆造：地形名一律用 TEC 名（`charts-tec.json` 的 feature）。
 */
export function createBattleFacts(input: {
  units: readonly ConsoleUnit[]
  /** 防御方阵营（9.4e 只取防御方单位的 AT 等级） */
  defenderSide: Side
  /**
   * 13.8b：架桥生效格（与 `buildMoveContext` 用**同一份**，由 `bridgedHexesBySide` 产出）
   *
   * 「架桥对**战斗地形效果**没有影响，但在**没有桥就无法攻击**的情况下，可通过架桥能力而**允许发动攻击**。」
   * ⇒ 这里只把降级后的 crossing 交给「能否进入」这一判（9.1f 的门槛），列位/地形效果仍按原格边算
   * （`hexsideTerrainsBetween` / `hexTerrainsAt` 一律不降级）。
   */
  bridgedHexesBySide?: { readonly axis: readonly HexRef[]; readonly soviet: readonly HexRef[] }
  /**
   * 9.1c：本**战斗环节**已攻击过的单位 id / 已**被攻击**过的格（账本由调用方持有，空＝尚未开打）
   *
   * 与 10.0e-A/B 的轰炸账本同一口径：格用 `列.行` 键（`barragedHexesThisPhase` 就是这么存的）。
   * 缺省＝空账本 ⇒ 本环节的第一仗照常放行；一旦调用方喂进来，`beginCombat` 就会拒
   * 「同一单位第二次攻击」与「同一格第二次被攻击」。
   */
  attackedUnitIdsThisSegment?: readonly string[]
  attackedHexesThisSegment?: readonly string[]
}): BattleFacts {
  const map = mapFacts()
  /** 13.8b：攻方这一侧的架桥格（空 ⇒ 无桥，取原 crossing） */
  const bridgedFor = (side: Side): ReadonlySet<string> =>
    new Set((input.bridgedHexesBySide?.[side] ?? []).map((hex) => `${hex.col}.${hex.row}`))
  // 9.1c：两个账本各折成一个 Set（判据在构成校验里逐单位跑，每次线性扫数组会白费）
  const attackedUnits = new Set(input.attackedUnitIdsThisSegment ?? [])
  const attackedHexes = new Set(input.attackedHexesThisSegment ?? [])
  return {
    // 9.1f：「能移动进入」才能攻击；只能靠**道路**进入者仍可常规战斗（8.1c 只禁突袭）
    canEnterForAttack: (view, from, to) => {
      const keys = bridgedFor(view.side)
      const touchesEngineerHex =
        keys.has(`${from.col}.${from.row}`) || keys.has(`${to.col}.${to.row}`)
      const result = selectMovementTerrain({
        terrainsPresent: map.terrainsAt(to),
        mobility: view.mobility,
        crossing: bridgedCrossing(map.crossingBetween(from, to), {
          touchesEngineerHex,
          bridgePresent: true,
          // 13.8b / 8.1c：攻击单位不得借架桥过河**突袭**；本判只问"能否攻击"，
          // 故按常规战斗（forOverrun: false）——突袭那一侧由 8.1b/8.1c 的地形判据另行拦下。
          forOverrun: false,
        }),
        followingRoad: true,
        forOverrun: false,
      })
      return result.ok
    },
    // 9.9：环形工事完整等级（印刷工事 + 摆上的工事算子，取高者）
    hedgehogLevelAt: (hex) =>
      Math.max(printedHedgehogLevelAt(hex), hedgehogLevelAt(input.units, hex)),
    // 9.4b：攻方堆叠可改用所穿越的格边地形
    hexsideTerrainsBetween: (from, to) => hexsideTerrainNames(from, to),
    // 9.4b/9.4c：格内地形候选
    hexTerrainsAt: (hex) => map.terrainsAt(hex),
    // 9.4e：防御格反坦克等级（工事看全格，AT 只取防御方）
    defenderAtLevelAt: (hex) => defenderAtLevelAt(input.units, hex, input.defenderSide),
    // 9.1c：本战斗环节的攻击账本（只读查询；记账在会话层，见 `attackedUnitIdsThisPhase`）
    attackedThisSegmentBy: (unitId) => attackedUnits.has(unitId),
    attackedThisSegmentAt: (hex) => attackedHexes.has(`${hex.col}.${hex.row}`),
  }
}

/** 格号比较（对象坐标不便用 ===） */
function sameHexRef(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}

/** 印刷永久工事等级（专规 1.3a；无则 0） */
export function printedHedgehogLevelAt(hex: HexRef): number {
  const found = mapLayers.printedHedgehogs.find(
    (item) => item.col === hex.col && item.row === hex.row,
  )
  return found?.level ?? 0
}

/**
 * 9.1a / 9.0：能攻击 `defenderHex` 的己方单位
 *
 * 「要进行战斗的话，**攻击单位必须与被攻击的格相邻**」（9.0）；只列可攻击（3.2b 带括号者只能防御）
 * 且相邻的单位，供界面「一键取全部相邻攻方」用（9.1c：一个格可被任意数量相邻格攻击）。
 */
export function attackersForHex(
  units: readonly ConsoleUnit[],
  defenderHex: HexRef,
  activeSide: Side,
): ConsoleUnit[] {
  return units.filter(
    (unit) =>
      unit.side === activeSide &&
      unit.isCombat &&
      unit.attackCapable &&
      areAdjacent(unit.hex, defenderHex),
  )
}

/**
 * 9.12 撤退事实（注入 `battle.ts` 的 `RetreatFacts`）
 *
 * 全部取自摆子与移动上下文，不臆造：
 *   - 9.12f「撤退不可穿越**在战斗开始时**包含敌方战斗单位的格（因此撤退不能穿越攻击单位承受
 *     损失或选项后空出的格）」→ 由调用方传 `combatStartSnapshot`（战斗开始那一刻的盘面快照）；
 *     缺省退回「当前盘面」（仅供不涉及该条的调用方使用）；
 *   - 9.12e「进入敌方 ZOC」→ 用引擎 `inEnemyZocForRetreat`：**不计 4.5b 抵消**
 *     （原文：「此 ZOC 效果无法被友方战斗单位『抵消』，也不受地形影响」）；
 *   - 9.12「禁止进入的地形」→ 复用引擎 `selectMovementTerrain`（只把 `prohibited` 当禁入，
 *     未知地形等数据问题不在此冒充规则禁入）；
 *   - 9.12e「恰好在该格的友方战斗单位一并 DG」→ 排除正在撤退的这些单位；
 *   - 9.12b「在任何模式下都不可移动者直接消灭」→ 两个面的 MA 均为 0 即视为不可移动。
 */
export function createRetreatFacts(input: {
  units: readonly ConsoleUnit[]
  context: MoveContext
  /** 正在撤退的单位 id（9.12e 的「同格友军」不含它们自身） */
  retreatingUnitIds: readonly string[]
  /**
   * 9.12f：**战斗开始时**的盘面快照（只用到「格 / 归属 / 是否战斗单位」三件事）
   *
   * 给了就用它判「战斗开始时该格是否有敌方战斗单位」；未给则退回当前盘面。
   * 这正是原文强调的那条：攻方被打空后腾出的格**仍然**挡住撤退。
   */
  combatStartSnapshot?: readonly {
    hex: HexRef
    side: Side
    isCombat: boolean
  }[]
}): RetreatFacts {
  /** 9.12f 的判定源：战斗开始快照（优先）或当前盘面 */
  const enemyCombatSources: readonly { hex: HexRef; side: Side; isCombat: boolean }[] =
    input.combatStartSnapshot ??
    input.units.map((unit) => ({ hex: unit.hex, side: unit.side, isCombat: unit.isCombat }))
  return {
    enemyCombatUnitAt: (hex, side) =>
      enemyCombatSources.some(
        (item) => item.isCombat && item.side !== side && sameHexRef(item.hex, hex),
      ),
    inEnemyZocAt: (hex, side) => inEnemyZocForRetreat(input.context, hex, side),
    prohibitedFor: (mobility, hex) => {
      const result = selectMovementTerrain({
        terrainsPresent: terrainsAt(hex),
        mobility,
        crossing: null,
        followingRoad: false,
        forOverrun: false,
      })
      return !result.ok && result.reason === 'prohibited'
    },
    friendlyCombatUnitsAt: (hex, side) =>
      input.units
        .filter(
          (unit) =>
            unit.isCombat &&
            unit.side === side &&
            sameHexRef(unit.hex, hex) &&
            !input.retreatingUnitIds.includes(unit.instanceId),
        )
        .map((unit) => unit.instanceId),
    immobile: (unitId) => {
      const unit = input.units.find((item) => item.instanceId === unitId)
      if (unit === undefined) return true
      return unit.faces.combat.ma === 0 && unit.faces.move.ma === 0
    },
  }
}

/**
 * 撤退路径文本 → 格序列（界面输入解析）
 *
 * 约定格式：`列.行` 以逗号/空格分隔，如 `36.12,36.11`（**不含起始格**；长度即完整撤退距离）。
 * 非法片段直接跳过（由引擎按长度不符报 9.12 拒绝，不在 UI 里另造一套校验）。
 */
export function parseHexPath(text: string): HexRef[] {
  const path: HexRef[] = []
  for (const part of text.split(/[,\s;，、]+/)) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const [colText, rowText] = trimmed.split('.')
    const col = Number(colText)
    const row = Number(rowText)
    if (!Number.isInteger(col) || !Number.isInteger(row)) continue
    path.push({ col, row })
  }
  return path
}

/* ────────────────────────────── C7 轰炸交互：事实与视图 ────────────────────────────── */

/** 敌对方（轰炸的「敌方」＝当前行动方的对手） */
function opposingSide(side: Side): Side {
  return side === 'axis' ? 'soviet' : 'axis'
}

/**
 * 13.4a：该单位此刻是否处于**预备或战略模式**（火炮处于这两种模式不得轰炸）
 *
 * 判据只有这一处：`toBarrageUnitRequest` 的 `inReserveOrStrat` 与面板的灰显说明共用它，
 * 免得两边各写一遍 `mode === 'reserve' || mode === 'strat'`（那种重复迟早一边漏改）。
 */
export function isInReserveOrStrat(unit: ConsoleUnit): boolean {
  return unit.mode.mode === 'reserve' || unit.mode.mode === 'strat'
}

/**
 * 操作台算子 → 参炸单位请求（10.0e-B / 10.1a / 13.4a）
 *
 *   - `printedValue` 取**当前朝向面**的印刷轰炸值（10.0e-B：不得以低于印刷值轰炸）；
 *   - `dg` / `mode` / `releasedFromReserve` 供 5.10b-A / 5.8 在引擎内折算（**此处不折半**，
 *     否则会折两次；DG 印值 5 ⇒ 引擎合并后得 2.5 ⇒ 按 4.2 取整为 3）；
 *   - `distanceHexes` 取到目标格的**格距**（10.1a：火炮射程以格为单位、不受天气与地形影响）；
 *   - `inReserveOrStrat` 对应 13.4a（火炮处于预备/战略模式不得轰炸）；
 *   - `rangeFromBase`（10.2b 短程 +1）与 `strategicBomber` 需要「飞机归属哪个基地」这一运行期事实，
 *     操作台当前没有该数据源，故**留空**（即不享短程加成）——宁可少给，不做臆造；数据补齐后由调用方传入。
 *
 * ★ 本函数不传 `assignedValue` / `splitValue` / `belowPrintedValue`：界面当前没有「分配轰炸值」入口，
 *   故 10.0e-B 的两条禁令（不得拆分、不得低于印刷值）恒被满足。**若将来加入该入口**，
 *   这两项必须按**折算后**的有效印值比较（DG 的有效印值是折半的），不能比原始印值。
 */
export function toBarrageUnitRequest(unit: ConsoleUnit, targetHex: HexRef): BarrageUnitRequest {
  return {
    unitId: unit.instanceId,
    printedValue: unit.raw.barrage ?? 0,
    dg: unit.mode.dg,
    mode: unit.mode.mode,
    releasedFromReserve: unit.mode.releasedFromReserve === true,
    inReserveOrStrat: isInReserveOrStrat(unit),
    distanceHexes: hexDistance(unit.hex, targetHex),
    rangeHexes: unit.raw.range ?? 0,
    // 专规 2.3d（第五批 A4）：所在格 + `sov_artillery_stack_to_combine` 标签 ⇒
    // 引擎判"带标签苏军炮兵 ≥2 时须同堆叠"（Smolensk_Rules_v1.1.txt:329-331）
    hex: unit.hex,
    sovArtilleryStackToCombine: (unit.specialAbilities ?? []).includes(
      'sov_artillery_stack_to_combine',
    ),
  }
}

/**
 * 10.0b：`activeSide`（**轰炸方**）在目标格是否有「正确的观察员」
 *
 * 「与目标格**相邻**的，且未装载于登陆艇的任何**友方战斗单位**」——友方＝轰炸方，故按轰炸方逐个筛。
 */
export function barrageSpotterAt(
  units: readonly ConsoleUnit[],
  targetHex: HexRef,
  activeSide: Side,
): boolean {
  return units.some((unit) =>
    isCorrectSpotter({
      side: unit.side,
      hex: unit.hex,
      targetHex,
      isCombat: unit.isCombat,
      friendlySide: activeSide,
    }),
  )
}

/**
 * 10.0a：目标格内**战斗单位**的密度 RE（只算战斗单位；单个师/编队计入密度时封顶 3 RE）
 *
 * 编队分组需要「单位属哪个师/编队」的数据；操作台当前无此字段，故按**单单位成组**传入
 * ⇒ 多单位编队会被按算子分别计入（偏高）。单师封顶 3 RE 的规则本身仍由 `densityReOf` 保证。
 */
export function barrageDensityReIn(units: readonly ConsoleUnit[], hex: HexRef, side: Side): number {
  return densityReOf(
    units
      .filter((unit) => unit.side === side && sameHexRef(unit.hex, hex))
      .map((unit) => ({ isCombat: unit.isCombat, re: unit.re })),
  )
}

/**
 * 构造轰炸事实（10.0a / 10.0b）
 *
 * 与 C6 的 `createBattleFacts` 同规：一律取自地图产物与操作台算子，不臆造；
 * 环形工事等级取「印刷永久工事（专规 1.3a）」与「摆上的工事算子」之**高者**（与 9.9 口径一致）。
 */
export function createBarrageFacts(input: {
  units: readonly ConsoleUnit[]
  /** **轰炸方**阵营 */
  activeSide: Side
}): {
  /** 10.0a：目标格内战斗单位的密度 RE */
  enemyREInHex: (hex: HexRef) => number
  /** 10.0a：目标格环形工事等级（任意等级 ⇒ 左移 1 列） */
  hedgehogLevelInHex: (hex: HexRef) => number
  /** 10.0a：目标格内是否有单位为战略模式（有 ⇒ 右移 3 列） */
  stratModeInHex: (hex: HexRef) => boolean
  /** 10.0b：轰炸方在目标格是否有正确的观察员 */
  hasSpotter: (hex: HexRef) => boolean
} {
  const targetSide = opposingSide(input.activeSide)
  return {
    enemyREInHex: (hex) => barrageDensityReIn(input.units, hex, targetSide),
    hedgehogLevelInHex: (hex) =>
      Math.max(printedHedgehogLevelAt(hex), hedgehogLevelAt(input.units, hex)),
    stratModeInHex: (hex) =>
      input.units.some((unit) => sameHexRef(unit.hex, hex) && unit.mode.mode === 'strat'),
    hasSpotter: (hex) => barrageSpotterAt(input.units, hex, input.activeSide),
  }
}

/* ────────────────────────────── C7 空军：10.2b 短程加成的数据源（A5 空军专表 + 14.1） ────────────────────────────── */

/** 机型记录视图（数据层只读记录或测试用部分字段；不手写第二份接口） */
export type AircraftRecordView = Partial<DeepReadonly<AircraftRecord>> & { aircraftId: string }

/**
 * 空军算子（运行期实例：A5 空军专表的印值 + 14.1a 的部署位置）
 *
 * ★ 与地面算子（`ConsoleUnit`）分开建模：飞机没有移动模式/MA/ZOC 等地面属性，
 *   其轰炸相关的印值在 `src/data/aircraft.json`（不是 `units-*.json`）。
 *
 * ★ `hex` 同时是它的**空军基地格**（14.1a：飞机算子停在其空军基地上），故 `baseHex` 不另存。
 */
export interface ConsoleAirUnit {
  instanceId: string
  aircraftId: string
  name: string
  /**
   * 算子图档（空军专表 `images`；渲染按此取图，与地面算子同口径）
   *
   * 只做透传：画不画由渲染层决定（CODE_SPEC §3.1 渲染只读）。
   */
  images: { front: string | null; back: string | null } | null
  side: Side
  /**
   * 14.1a：飞机算子**停在其空军基地格**（激活的放在空军基地算子上方、非激活的放下方）
   *
   * ⇒ 此格**就是** 10.2b 所说的「它们基地」，也是 C9 的起飞/返航基地格。
   */
  hex: HexRef
  /** 14.1：机型代号（F 战斗机 / T 战术轰炸机 / **S 战略轰炸机** / Tpt 运输机 / comb 组合） */
  aircraftType: string
  /** 14.1a：激活/非激活（整备后转激活；出击/返航后转非激活） */
  airStatus: AirStatus
  /** 14.2e：本阶段已执行的任务数（≥1 ⇒ 本阶段不能再执行任务） */
  missionsFlownThisPhase: number
  /** 14.3e：空战值（**正面印值**；减损后用减损面值 → `airCombatRatingOf`） */
  airCombatRating: number
  /** 14.1b/14.3e：**减损面**（1 step）的空战值（null ＝ 与正面相同） */
  airCombatRatingBack: number | null
  /** 14.3a：能否发起空战（带括号空战值为 false） */
  canInitiateAirCombat: boolean
  /** 14.4c：可否产生巡逻区（战斗机） */
  canPatrolZone: boolean
  /** 14.7b：可否轰炸 */
  canBarrage: boolean
  /** 14.7d：可否低空扫射（苏军另有专规 2.2a） */
  canHipShoot: boolean
  /** 14.10：可否空投 */
  canAirDrop: boolean
  /** 印刷轰炸值（10.0e-B：不得低于它轰炸；减损后用减损面值 → `airBarrageStrengthOf`） */
  barrageStrength: number
  /** 14.1b/14.4f：**减损面**（1 step）的轰炸值（null ＝ 与正面相同） */
  barrageStrengthBack: number | null
  /** 14.1：航程（格）——与 10.2b 的「10 格短程」是两回事，勿混用 */
  rangeHexes: number
  /** 14.9a：运输容量（T；非运输机为 0） */
  transportCapacity: number
  /** 14.4f/14.4g：减损面（1 step）的运输容量（T；null ＝ 与正面相同） */
  transportCapacityBack: number | null
  /** 14.1b：军力（飞机通常 2；运行时随损失递减） */
  steps: number
  /** 14.1b：**印值**军力（飞机通常 2；IL.2 等单军力机为 1）——「是否已减损」的判据基准 */
  printedSteps: number
}

/** 该方可选机型（A5 空军专表） */
export function aircraftChoices(side: Side): AircraftRecordView[] {
  return aircraft.aircraft.filter((item) => item.side === side)
}

/**
 * **参战机**的可选性（B14：空军面板的算子图阵列要逐机说明「为什么点不动」）
 *
 * 三道闸的结论逐机算好（14.2f 加机窗口 / 14.2a 合计上限 / 14.2e 一阶段一次），
 * `disabledReason` 为 null 即此刻可以加进任务。**已选中的恒可点**（取消勾选不受任何闸限制）。
 */
export interface AirMissionJoinChoice {
  /** 该机（面板据它取图、名字与所在格） */
  air: ConsoleAirUnit
  /** 是否已在本次任务的参战名单里 */
  selected: boolean
  /** 此刻不能加进任务的原因（null = 可以加）；点它由面板就地出一行灰提示 */
  disabledReason: string | null
}

/**
 * 死亡堆条目：**地面算子与空军算子共用同一个死亡堆**（用户裁定）
 *
 * 依据：OCS 14.1b 里被消灭的飞机与地面单位一样进入死亡堆并可重建，
 * 故死亡堆不是「地面专用容器」。两者以 `unitId`（地面）/ `aircraftId`（空军）区分。
 */
export type DeadPileEntry = ConsoleUnit | ConsoleAirUnit

/** 判别：空军条目带 `aircraftId`，地面条目带 `unitId` */
export function isAirDeadPileEntry(entry: DeadPileEntry): entry is ConsoleAirUnit {
  return 'aircraftId' in entry
}

/** 机型记录 → 空军算子（摆放时调用；位置即其基地格，见 14.1a） */
export function toConsoleAirUnit(input: {
  aircraft: AircraftRecordView
  instanceId: string
  hex: HexRef
  side: Side
  /** 14.1a：摆放时的激活状态（缺省非激活——须经整备 15.1 才能出击） */
  airStatus?: AirStatus
}): ConsoleAirUnit {
  const record = input.aircraft
  const abilities = record.airAbilities ?? {}
  return {
    instanceId: input.instanceId,
    aircraftId: record.aircraftId,
    name: record.name ?? record.aircraftId,
    images:
      record.images === undefined || record.images === null
        ? null
        : { front: record.images.front ?? null, back: record.images.back ?? null },
    side: input.side,
    hex: { ...input.hex },
    aircraftType: record.aircraftType ?? '',
    // 14.1a：默认非激活（新到的飞机须在整备阶段整备后才激活）
    airStatus: input.airStatus ?? 'inactive',
    missionsFlownThisPhase: 0,
    airCombatRating: record.airCombatRating ?? 0,
    airCombatRatingBack: record.airCombatRatingBack ?? null,
    // 14.3a：能力位缺席时按「空战值 0 视为带括号」保守处理（宁可少给，不做臆造）
    canInitiateAirCombat: abilities.canInitiateAirCombat ?? (record.airCombatRating ?? 0) > 0,
    canPatrolZone: abilities.canPatrolZone ?? false,
    canBarrage: abilities.canBarrage ?? (record.barrageStrength ?? 0) > 0,
    canHipShoot: abilities.canHipShoot ?? false,
    canAirDrop: abilities.canAirDrop ?? false,
    barrageStrength: record.barrageStrength ?? 0,
    barrageStrengthBack: record.barrageStrengthBack ?? null,
    rangeHexes: record.rangeHexes ?? 0,
    transportCapacity: record.transportCapacity ?? 0,
    transportCapacityBack: record.transportCapacityBack ?? null,
    steps: record.steps ?? 2,
    printedSteps: record.steps ?? 2,
  }
}

/* ────────────────────────────── 14.1b：减损面取值（第五批批 C 切片 1） ────────────────────────────── */

/**
 * 14.1b：该机的**印值**军力（「每个飞机算子都有两点军力」；IL.2 等单军力机为 1）
 *
 * ★ 旧存档（加字段之前写出的）没有 `printedSteps` ⇒ 按标准 2 兜底；那一档里能"减损"的
 *   都是 2 军力机（单军力机一损即毁、不会留下减损态），故兜底不会造成误判。
 */
export function airPrintedStepsOf(air: ConsoleAirUnit): number {
  return air.printedSteps ?? 2
}

/**
 * 14.1b/14.4f：该机**此刻朝上那一面**的轰炸值
 *
 * 「使用算子的反面 (减损面)来表示军力损失」（14.1b）；「剩下一 点军力的飞机将**使用其
 * 减少后的数值**来完成任务」（14.4f）⇒ 减损（`steps < 印值军力`）时取背面值；
 * **没有背面数据**（含旧存档）时回退正面值。
 */
export function airBarrageStrengthOf(air: ConsoleAirUnit): number {
  return air.steps < airPrintedStepsOf(air)
    ? (air.barrageStrengthBack ?? air.barrageStrength)
    : air.barrageStrength
}

/** 14.1b/14.3e：该机**此刻朝上那一面**的空战值（判据同 `airBarrageStrengthOf`） */
export function airCombatRatingOf(air: ConsoleAirUnit): number {
  return air.steps < airPrintedStepsOf(air)
    ? (air.airCombatRatingBack ?? air.airCombatRating)
    : air.airCombatRating
}

/**
 * 14.1e：是否**战略轰炸机**（机型代号 **S**）
 *
 * 规则书 14.1：「游戏中有五种类型的飞机……**战略轰炸机 (S)** 主要用于空军轰炸，但受到不能低空扫射等
 * 规则限制。见 14.1e」⇒ 唯一依据是 A5 专表里的机型代号 `S`，不做名字猜测。
 *
 * 战略轰炸机在轰炸里有两处特殊（本模块只提供事实，判定在引擎）：
 *   - 10.2b：**永不享受**短程 +1；
 *   - 14.1e-A / 10.0b：其轰炸**总被认为没有观察员**⇒ 左移 3 列。
 */
export function isStrategicBomberAircraft(aircraftType: string): boolean {
  return aircraftType.trim().toUpperCase() === 'S'
}

/**
 * 10.2b：该机距其**基地**的格数（= 目标格到该机所在格的格距）
 *
 * 依据链：14.1a 飞机算子停在其**空军基地格**（⇒ `air.hex` 即基地格）；10.2a 空中任务时
 * 「空军单位需要**放置在目标上**来结算它们的轰炸」⇒ 判「飞机是否在基地 10 格以内」即判
 * **目标格**与**基地格**的距离。航程是否够（`rangeHexes`）另判，两者不可混为一谈。
 */
export function airRangeFromBase(air: ConsoleAirUnit, targetHex: HexRef): number {
  return hexDistance(air.hex, targetHex)
}

/**
 * 空军算子 → 参炸单位请求（10.0e-B 印刷轰炸值 / 10.2b 距基地格数 / 14.1e 战略轰炸机）
 *
 * 与 `toBarrageUnitRequest`（地面）的分工：只有空军带 `rangeFromBase`（10.2b），
 * 火炮的射程由 10.1a 的 `canBarrageAtRange` 另判，不在此处冒充。
 */
export function toAirBarrageUnitRequest(
  air: ConsoleAirUnit,
  targetHex: HexRef,
): BarrageUnitRequest {
  return {
    unitId: air.instanceId,
    // 14.1b/14.4f：减损机用**减损面**的轰炸值（`airBarrageStrengthOf` 唯一判据）
    printedValue: airBarrageStrengthOf(air),
    ...(isStrategicBomberAircraft(air.aircraftType) ? { strategicBomber: true } : {}),
    rangeFromBase: airRangeFromBase(air, targetHex),
  }
}

/** 格序列 → 撤退路径文本（界面回显） */
export function formatHexPath(path: readonly HexRef[]): string {
  return path.map((hex) => `${hex.col}.${hex.row}`).join(',')
}

/* ────────────────────────────── C8 补给交互与 SP 管理：事实与视图 ────────────────────────────── */

/**
 * 13.1b：HQ 的**印值投递距离**（MP）——按**当前朝上的那一面**取
 *
 * 「投递距离印在算子的底部左边（战斗面与移动面不同）」；5.4a：一切数值以朝向那一面为基准。
 * 非 HQ（无印值投递距离）返回 0。
 */
export function throwRangeMpOf(unit: ConsoleUnit): number {
  if (unit.throwRange === null) return 0
  return unit.mode.orientation === 'move' ? unit.throwRange.moveFace : unit.throwRange.combatFace
}

/** 是否指挥部（13.1b：数据层 `specialized` 含 `hq`，或带印值投递距离） */
export function isHqUnit(unit: ConsoleUnit): boolean {
  return unit.specialized.includes('hq') || unit.throwRange !== null
}

/** 是否延补队（12.7：数据层 `noncombatKind = supply_extender`） */
export function isExtenderUnit(unit: ConsoleUnit): boolean {
  return unit.noncombatKind === 'supply_extender'
}

/** 操作台算子 → 13.9 合并视图（带**两面**印值；13.9 要比的是两个单位之间的一致，不是同一单位两面） */
export function toConsolidationGroundView(unit: ConsoleUnit): ConsolidationGroundView {
  return {
    id: unit.instanceId,
    combatFace: {
      attack: unit.faces.combat.attack,
      ar: unit.faces.combat.ar,
      ma: unit.faces.combat.ma,
      ...(unit.faces.combat.barrage === undefined ? {} : { barrage: unit.faces.combat.barrage }),
    },
    moveFace: {
      attack: unit.faces.move.attack,
      ar: unit.faces.move.ar,
      ma: unit.faces.move.ma,
      ...(unit.faces.move.barrage === undefined ? {} : { barrage: unit.faces.move.barrage }),
    },
    internalStocks: unit.internalStocks,
    dg: unit.mode.dg,
    locationKey: `${unit.hex.col}.${unit.hex.row}`,
    steps: unit.steps,
    printedSteps: unit.printedSteps,
    // 13.9-2/3：所属多单位编队（本作操作台不模拟编队标记 ⇒ 一律视为独立单位）
    formationId: null,
    isOrganicTruck: unit.noncombatKind === 'organic_truck',
  }
}

/** 操作台算子 → 20.0 拆分/吸收视图（类型用 3.2a 的 `combatClass`） */
export function toBreakdownSideView(unit: ConsoleUnit, nationality: string): BreakdownSideView {
  return {
    id: unit.instanceId,
    side: unit.side,
    nationality,
    classKind: unit.combatClass,
    ar: unit.raw.ar,
    steps: unit.steps,
    printedSteps: unit.printedSteps,
    dg: unit.mode.dg,
    internalStocks: unit.internalStocks,
    mode: unit.mode.mode,
  }
}

/**
 * 战斗视图 → 专规 2.3b 的防御单位视图
 *
 * 判据只取数据层的能力标签（`special_abilities: ["nkvd_border_forced_roll"]`），
 * 与 `specialized`（模式/规模分类）分开保留，避免把分类当能力用。
 */
export function toNkvdDefenseView(unit: {
  id?: string
  instanceId?: string
  specialAbilities?: readonly string[] | null
  specialized?: readonly string[] | null
}): NkvdDefenseUnitView {
  return {
    // 操作台算子用 instanceId、战斗视图用 id，二者在引擎里都是同一个单位标识
    id: unit.id ?? unit.instanceId ?? '',
    specialAbilities: unit.specialAbilities ?? [],
    specialized: unit.specialized ?? [],
  }
}

/**
 * 操作台算子 → 追溯补给单位视图（B10 的 `TraceSupplyFacts` 输入）
 *
 *   - 4.5 的「是否处于战斗模式」统一交 `modes.exertsZoc` 裁定（勿传原始模式字段）；
 *   - 4.5b 的抵消由 trace-supply 内部按「格内有己方战斗单位」处理，无需在此表达。
 */
export function toTraceSupplyUnitView(unit: ConsoleUnit): TraceSupplyUnitView {
  return {
    id: unit.instanceId,
    side: unit.side,
    hex: unit.hex,
    isCombat: unit.isCombat,
    attackCapable: unit.attackCapable,
    inCombatMode: exertsZoc(unit.mode),
    hasTraceSupply: unit.hasTraceSupply,
  }
}

/**
 * 操作台算子 → 可投递的指挥部视图（12.3b）
 *
 * ★ 数据缺口（不得无中生有）：12.3a 的例外是「投递距离为**步行或履带**的指挥部用对应移动类型计数」，
 *   即投递距离有**颜色**之分；本作单位库未单列该颜色，故一律按 12.3a 的**默认口径**（轮式 MP）计，
 *   有数据时由调用方经 `throwMobility` 覆盖。投递距离本身取自 13.1b 印值（`throwRangeMpOf`）。
 */
export function toThrowHqView(
  unit: ConsoleUnit,
  options: { throwMobility?: SupplyMobility } = {},
): ThrowHqView {
  return {
    hex: unit.hex,
    side: unit.side,
    mode: unit.mode.mode,
    mobility: effectiveMobilityOf(unit),
    throwRangeMp: throwRangeMpOf(unit),
    throwMobility: options.throwMobility ?? 'truck',
  }
}

/**
 * 操作台算子 → 延补队视图（12.7b：距离＝印值 MA）
 *
 * 「延补队印在 5 点运输点算子的背面，其距离就是该算子印的 MA」⇒ 取 `factors.combat.ma`
 * （本作 `*-extender-truck` MA 20 / 轮式，`*-extender-wagon` MA 10 / 徒步），由
 * `trace-supply#extenderRangeMpOf` 校验后使用，不另造数字。
 */
export function toExtenderView(unit: ConsoleUnit): ExtenderView {
  return {
    hex: unit.hex,
    side: unit.side,
    mobility: effectiveMobilityOf(unit),
    rangeMp: extenderRangeMpOf({ ma: unit.faces.combat.ma }),
  }
}

/**
 * 构造追溯补给事实（C8 的判定与可视化**共用同一份事实**）
 *
 * 输入分工（「不得无中生有」）：
 *   - **dumps**（12.1b 含 SP 的位置）：操作台的 SP 账本（玩家可编辑）；
 *   - **throwHqs**（12.3b）：摆上来的 HQ 算子（投递距离取 13.1b 印值）；
 *   - **extenders**（12.7）：摆上来的延补队算子（距离取印值 MA）；
 *   - **sources**（12.6a①②）：基础补给源格必须由调用方给出——它们来自**专规/剧本**，
 *     单位库里没有，故不在此臆造（操作台由玩家声明后传入）。
 */
export function createSupplyFacts(input: {
  units: readonly ConsoleUnit[]
  /** 12.1b：含 SP 的位置 */
  dumps: readonly { hex: HexRef; side: Side }[]
  /** 12.6a①②：基础补给源格（专规/剧本数据；无则空数组） */
  sources?: readonly TraceSupplySourceView[]
  /** 12.3a 例外：各 HQ 投递距离所用的机动类型（缺省轮式） */
  throwMobilityByHq?: (unit: ConsoleUnit) => SupplyMobility | undefined
}): TraceSupplyFacts {
  return createTraceSupplyFacts({
    units: input.units.map(toTraceSupplyUnitView),
    dumps: input.dumps,
    throwHqs: input.units.filter(isHqUnit).map((unit) => {
      const mobility = input.throwMobilityByHq?.(unit)
      return toThrowHqView(unit, mobility === undefined ? {} : { throwMobility: mobility })
    }),
    extenders: input.units.filter(isExtenderUnit).map(toExtenderView),
    sources: input.sources ?? [],
  })
}

/* ────────────────────────────── C9 空军交互：事实与视图 ────────────────────────────── */

/**
 * 14.1：是否**战斗机**（机型代号 `F`）
 *
 * 「战斗机(F)是唯一能执行拦截任务，以及能在空战中进行攻击的空军单位」——故 14.6 战机扫荡与
 * 14.11「战斗机在正常距离内保持激活」都以机型代号 F 为准；组合型 `comb` 按 14.1 是
 * 「战术轰炸机 + 运输机」的组合，不按战斗机处理。
 */
export function isFighterAircraft(aircraftType: string): boolean {
  return aircraftType.trim().toUpperCase() === 'F'
}

/** 空军算子 → 任务机视图（C9 引擎输入；字段一一对应，不做换算） */
export function toAirMissionAircraftView(air: ConsoleAirUnit): AirMissionAircraftView {
  return {
    id: air.instanceId,
    side: air.side,
    airStatus: air.airStatus,
    // 14.1a：飞机所在格即其空军基地格（本作不为飞机另存基地字段）
    baseHex: air.hex,
    missionsFlownThisPhase: air.missionsFlownThisPhase,
    aircraftType: air.aircraftType,
    // 14.1b/14.3e：减损机用**减损面**的空战值（14.4f 的"使用其减少后的数值"同源一处判据）
    airCombatRating: airCombatRatingOf(air),
    canInitiateAirCombat: air.canInitiateAirCombat,
    rangeHexes: air.rangeHexes,
    steps: air.steps,
    canBarrage: air.canBarrage,
    canHipShoot: air.canHipShoot,
    canAirDrop: air.canAirDrop,
    canPatrolZone: air.canPatrolZone,
    transportCapacity: air.transportCapacity,
    transportCapacityBack: air.transportCapacityBack,
    isStrategicBomber: isStrategicBomberAircraft(air.aircraftType),
  }
}

/**
 * 操作台算子 → 空军基地视图（15.0）
 *
 * ★ **基地归属权**：空军基地在单位库里是**中立算子**（`side='both'`），其运行期归属＝该算子被摆放时
 *   指定的那一方（`ConsoleUnit.side`）——被 9.14f 夺取后翻面即改这一项。本函数只做搬运，不猜归属。
 *
 * 15.2 的**简易机场**在本作单位库里没有独立算子（它由 15.2A 的工程作业修建），故本函数不产出
 * `isAirstrip`；需要时由调用方按「本局已修建的简易机场格」显式覆盖（对象展开即可）。
 */
export function toAirBaseView(unit: ConsoleUnit): AirBaseView {
  return {
    id: unit.instanceId,
    hex: unit.hex,
    // ★ 归属方＝该空军基地算子当前的归属（摆放时按己方、被夺取后翻面）
    side: unit.side,
    level: unit.noncombatLevel,
  }
}

/* ────────────────────────────── C9 铁路补给：13.3c / 12.7a-B/C ────────────────────────────── */

/**
 * 铁路邻接索引（13.3a）：**唯一实现**在引擎 `rail.ts#createRailGraph`，本处只做一次性缓存
 *
 * 修前这里自建了一份「筛 `rail === true` 再连边」的表，与 `createRailFacts` 内部那份并存——
 * 同一条「哪格有铁路、谁与谁以铁路相接」的规则抄了两遍。
 */
let railAdjacency: ReturnType<typeof createRailGraph> | null = null

function railGraph(): ReturnType<typeof createRailGraph> {
  railAdjacency ??= createRailGraph(mapLayers)
  return railAdjacency
}

/** 该格是否有铁路格边（13.3a：至少一条格边有轨即为铁路格） */
export function isRailHexAt(hex: HexRef): boolean {
  return railGraph().isRailHex(hex)
}

/** 与 `hex` 有铁路格边相连的邻格（13.3a） */
export function railNeighborHexes(hex: HexRef): HexRef[] {
  return [...railGraph().railNeighbors(hex)]
}

/** 铁路邻接来源（`engine/rules/rail.ts#convertedRailRun` 的静态图层注入点） */
export const railNeighborSource: RailNeighborSource = { railNeighbors: railNeighborHexes }

/**
 * 专规 1.2 剧本页的换轨走线原文 → 两个端点
 *
 * 原文形如 `'01.03 to 2.02'`（「列.行」，行可补零也可不补；大小写与多余空白容忍）。
 * 解析不出来即返回 `null`——由调用方决定报错还是跳过，**不猜**。
 */
export function parseConvertedRailRun(text: string): { from: HexRef; to: HexRef } | null {
  const parts = text.split(/\s+to\s+/i)
  if (parts.length !== 2) return null
  const endpoints = parts.map((part) => /^(\d{1,2})\.(\d{1,2})$/.exec(part.trim()))
  if (endpoints.some((match) => match === null)) return null
  const [from, to] = endpoints.map((match) => ({
    col: Number(match![1]),
    row: Number(match![2]),
  }))
  return { from: from!, to: to! }
}

/**
 * 构造铁路补给事实（13.3c / 12.7a-B/C）——判定与界面共用
 *
 * 输入分工（「不得无中生有」）：
 *   - **sources**（12.6a①）：边缘铁路格 / 专规补给源格 —— 来自专规与剧本，由玩家声明；
 *   - **extenders**（12.7）：摆上来的延补队算子（距离取印值 MA，12.7b）；
 *   - **controlByHex**（13.3h）：格的控制方 —— 操作台无历史控制记录，故由调用方给出
 *     （缺省返回 null ＝各方都不控制 ⇒ 该格不能作火车卸货格，宁可少给）；
 *   - **zocAt**（13.3c③）：**未被抵消**的敌方 ZOC —— 调用方须按 4.5b 抵消后给出；
 *   - **railGaugeUsable**（13.3f／专规 1.2）：该格轨距是否为本方可用 —— 缺省**全部不可用**
 *     （宁可少给：轨距账本未接线时不得凭空放行，否则整条宽轨网都会白送给轴方）。
 */
export function createRailSupplyFacts(input: {
  sources: readonly { hex: HexRef; side: Side }[]
  extenders: readonly ExtenderView[]
  controlByHex?: (hex: HexRef) => Side | null
  zocAt?: (hex: HexRef, side: Side) => boolean
  /**
   * 13.3f／专规 1.2：该铁路格的轨距是否为本方可用
   *
   * 缺省 `() => false`（**宁少勿多**）：本字段缺失意味着调用方没有轨距账本，
   * 此时若默认放行，苏方的宽轨网就会被轴方按「可用」消费掉。
   */
  railGaugeUsable?: (hex: HexRef, side: Side) => boolean
  /**
   * 12.7b：延补队回连距离的**唯一实现**来源
   *
   * `rail-supply` 不得自持"格数 ≤ rangeMp"那套口径——本字段把 trace-supply 的
   * `extenderConnectsBack`（MP 沿补给路径、含 12.7g「相邻即可」）注入进去，
   * 使 12.7b 在整仓只有一条实现。
   */
  traceFacts: TraceSupplyFacts
}): RailSupplyFacts {
  return {
    terrainsPresentAt: (hex) =>
      mapLayers.hexes.find((item) => item.col === hex.col && item.row === hex.row)
        ?.terrainsPresent ?? [],
    isControlledBy: (hex, side) => input.controlByHex?.(hex) === side,
    isRailHex: (hex) => isRailHexAt(hex),
    railNeighbors: (hex) => railNeighborHexes(hex),
    inUnnegatedEnemyZoc: (hex, side) => input.zocAt?.(hex, side) ?? false,
    railGaugeUsable: (hex, side) => input.railGaugeUsable?.(hex, side) ?? false,
    baseSourceHexes: (side) =>
      input.sources.filter((source) => source.side === side).map((source) => source.hex),
    extenderLinks: (side) =>
      input.extenders
        .filter((extender) => extender.side === side)
        .map((extender) => ({
          hex: extender.hex,
          rangeMp: extender.rangeMp,
          mobility: extender.mobility,
        })),
    extenderConnectsBack: ({ extenderHex, hex, side, mobility, rangeMp }) =>
      extenderConnectsBack(input.traceFacts, {
        extenderHex,
        hex,
        side,
        mobility,
        rangeMp,
      }),
  }
}

/* ────────────────────────────── 打一仗（9.0） ────────────────────────────── */

/** 战斗打点输入 */
export interface BattleInput {
  rng: RngState
  attackers: readonly ConsoleUnit[]
  defenders: readonly ConsoleUnit[]
  /** 防御方选定的地形（9.3b 由防御方从候选集中选） */
  chosenTerrain: string
  /** 守方环形工事等级（16.0；无则 0） */
  hedgehogLevel?: number
  /** 9.6：攻方选定的参战单位行动值（省略则取参与单位中最高者，仅供默认展示） */
  attackerAr?: number
  /** 9.6：守方选定的参战单位行动值（省略则取参与单位中最高者，仅供默认展示） */
  defenderAr?: number
}

/** 战斗打点报告（可直接显示） */
export interface BattleReport {
  rule: CombatResult
  /** 2d6 明细 */
  dice: { count: number; faces: number[]; total: number }
  /** 攻方实际军力（已按 9.4d 地形倍率修正） */
  attackerStrength: number
  defenderStrength: number
  /** 各攻方单位所用的地形倍率（9.4d） */
  multipliers: number[]
  /** 所用地形与由此得到的 Combat Table 列位（9.3b） */
  terrain: string
  terrainLine: CombatLine
  /** 攻守所用行动值（9.6：各取参与单位中最高者） */
  attackerAR: number
  defenderAR: number
  hedgehogLevel: number
}

/** 战斗打点结果 */
export type BattleOutcome =
  { ok: true; report: BattleReport; rng: RngState } | { ok: false; reason: string }

/** 参与单位中最高行动值（9.6 由玩家指定其一；操作台默认取最高） */
function bestAr(units: readonly ConsoleUnit[]): number {
  return units.reduce((best, unit) => Math.max(best, unit.raw.ar), 0)
}

/**
 * 该格环形工事等级（16.0 / 9.9）
 *
 * 环形工事是格内设施（4.8：一格至多 1 个），其等级由 CRT 修正骰「− 守方工事等级」体现。
 */
export function hedgehogLevelAt(units: readonly ConsoleUnit[], hex: HexRef): number {
  let level = 0
  for (const unit of units) {
    if (unit.hex.col !== hex.col || unit.hex.row !== hex.row) continue
    if (unit.noncombatKind === 'hedgehog') level = Math.max(level, unit.noncombatLevel)
  }
  return level
}

/**
 * 打一仗：掷 2d6 → 按 9.3b 取列位、9.4d 修军力 → 查 9.9 战斗表
 *
 * 随机数一律走引擎 RNG（B2：种子入存档、可复算），**不碰 Math.random**。
 *
 * ★ 这是「一键查表」的便捷入口（供 U0 快速看战果）；**完整的 9.2 九步流程**（补给 → 行动值 →
 *   逐堆叠地形 → 奇袭 → 结果 → 选项 → 撤退 → 推进）在 `engine/rules/combat-interaction.ts`，
 *   C6 的战斗面板走那条路径。两条路径共用 `resolveCombat` 的取列与查表，故不会口径漂移。
 */
export function resolveBattle(input: BattleInput): BattleOutcome {
  if (input.attackers.length === 0 || input.defenders.length === 0)
    return { ok: false, reason: '攻守双方都必须至少有一个单位' }

  const defenderHex = input.defenders[0]!.hex
  const terrainsPresent = terrainsAt(defenderHex)
  const terrain = resolveCombatTerrain({
    terrainsPresent,
    // 9.3b：格内印有城市/村庄符号即按城市格计入候选，否则视为溢出而忽略
    cityHex: isCityHex(defenderHex),
    chosen: input.chosenTerrain,
  })
  if (terrain.ok === false)
    return { ok: false, reason: `地形不能作为防御地形：${input.chosenTerrain}` }

  // 9.4d：地形倍率修正攻方军力（按攻方部队类别逐单位乘）
  const multipliers = input.attackers.map(
    (unit) => terrain.attackerMultipliers[combatClassOf(unit)] ?? 1,
  )
  const attackerStrength = input.attackers.reduce(
    (sum, unit, index) => sum + unit.raw.attack * multipliers[index]!,
    0,
  )
  const defenderStrength = input.defenders.reduce((sum, unit) => sum + unit.raw.attack, 0)

  const draw: RngDraw<{ count: number; faces: number[]; total: number }> = roll2d6(input.rng)
  // 9.6：行动值由双方各自指定参战单位；调用方未指定时退回「取最高」供默认展示
  const attackerAR = input.attackerAr ?? bestAr(input.attackers)
  const defenderAR = input.defenderAr ?? bestAr(input.defenders)

  const rule = resolveCombat({
    die: draw.value.total,
    attackerAR,
    defenderAR,
    hedgehogLevel: input.hedgehogLevel ?? 0,
    terrainLine: terrain.combatLine,
    attackerA: attackerStrength,
    defenderA: defenderStrength,
  })

  return {
    ok: true,
    rng: draw.rng,
    report: {
      rule,
      dice: draw.value,
      attackerStrength,
      defenderStrength,
      multipliers,
      terrain: terrain.terrain,
      terrainLine: terrain.combatLine,
      attackerAR,
      defenderAR,
      hedgehogLevel: input.hedgehogLevel ?? 0,
    },
  }
}

/** 由操作台算子取 9.4d 类别 */
function combatClassOf(unit: ConsoleUnit): CombatClass {
  return unit.combatClass
}

/** 某格格内地形（取自地图产物；无记录时为空数组） */
export function terrainsAt(hex: HexRef): readonly string[] {
  const found = mapLayers.hexes.find((item) => item.col === hex.col && item.row === hex.row)
  return found?.terrainsPresent ?? []
}

/** 该格是否为城市/村庄格（9.3b：非城市格的城/村符号视为溢出而忽略） */
export function isCityHex(hex: HexRef): boolean {
  return terrainsAt(hex).some((name) => name.includes('City') || name === 'Village')
}

/** 防御地形候选（9.3b：河/湖/路/铁是格边地形，永不进候选） */
export function defenseTerrainChoices(hex: HexRef): string[] {
  return combatTerrainCandidates({
    terrainsPresent: terrainsAt(hex),
    cityHex: isCityHex(hex),
  })
}

/**
 * 该格默认防御地形（9.3b）
 *
 * 9.3b 规定地形由**防御方**从候选集中选；操作台给一个「对防御方最有利」的初始值
 * （问引擎的 bestCombatTerrainForDefender，**不用 6.2d 的移动取费口径**），玩家可在界面上改。
 */
export function defaultDefenseTerrain(hex: HexRef): string {
  const input = { terrainsPresent: terrainsAt(hex), cityHex: isCityHex(hex) }
  return bestCombatTerrainForDefender(input) ?? combatTerrainCandidates(input)[0] ?? ''
}

/** 供界面显示的格号（与地图标定一致：col.row） */
export function hexLabel(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

/** 地图尺寸（供视口与缩放滑杆显示） */
export const MAP_META = {
  bounds: mapConfig.bounds,
  entryLetters: Object.keys(mapConfig.entryHexes ?? {}),
  victoryLocations: mapConfig.victoryLocations,
} as const

/* ────────────────────────────── 回合轨（2.2） ────────────────────────────── */

/**
 * 回合轨：turn → ISO 日期
 *
 * ★ 唯一来源是工程数据 markers.json 的 turnTrack（半周日号，1–19）。**不可自行按固定天数推算**：
 *   日号 `1-5-8-12-15-19-22-26-29` **每月重复**（回合1=07-08、2=07-12、3=07-15、4=07-19、
 *   5=07-22、8=**08-01**、17=**09-01**、19=09-08，游戏自 8 Jul 起、至 8 Sep 止），
 *   而日期是专规闸门的唯一输入（专规 2.3e 苏军 08-01 起可战略模式；专规 1.2 铁路容量 07-19 提升）。
 */
export const TURN_TRACK: readonly { turn: number; date: string }[] = markers.turnTrack

/* ────────────────────────────── 面板选图（B13） ────────────────────────────── */

/**
 * 算子 → 算子图 URL（**面板侧**选图的唯一入口）
 *
 * 与地图的 `token-layer` 走**同一条**选图实现（`token-images#tokenImageUrl`）：
 * SP 按当前点数、空军基地按当前等级、编内卡车按装载面、其余按朝向那一面。
 * 为什么要有这一层：地图那边从 `UnitToken` 选图，而面板手上是 `ConsoleUnit`——
 * 两边各拼一次文件名迟早会漂移（选错面正是最容易出的那种错）。
 *
 * 取不到图（记录里没有图档名）返回 null：调用方退回"只写名字"，不臆造文件名。
 */
export function counterImageUrlOf(unit: ConsoleUnit | ConsoleAirUnit): string | null {
  return tokenImageUrl({
    side: unit.side,
    face: orientationFaceOf(unit),
    images: unit.images ?? null,
    noncombatKind: 'noncombatKind' in unit ? (unit.noncombatKind ?? null) : null,
    spPoints: 'noncombatSp' in unit ? (unit.noncombatSp ?? null) : null,
    noncombatLevel: 'noncombatLevel' in unit ? (unit.noncombatLevel ?? null) : null,
    loadedSpT: 'loadedSpT' in unit ? (unit.loadedSpT ?? null) : null,
  })
}

/** 地面算子的当前朝向（5.4a：图随朝向那一面）；飞机与其它无朝向的恒取正面 */
function orientationFaceOf(unit: ConsoleUnit | ConsoleAirUnit): 'combat' | 'move' {
  return 'mode' in unit && unit.mode.orientation === 'move' ? 'move' : 'combat'
}

/**
 * **SP 账本条目** → 算子图 URL（B14：补给站也是"选一枚算子"的位置）
 *
 * 补给站在操作台里是**账本条目**（`SpDump`），没有实例、也没有单位库记录，
 * 但 12.1a 的拆并本来就是"多枚等额 SP 算子"的抽象 ⇒ 图上就用**当前点数的 SP 算子图**
 * （点数不同图不同，与地图上的 SP 算子同口径）。结构化入参，免得为此把 `SpDump` 搬进本模块。
 */
export function spDumpImageUrlOf(dump: { side: Side; sp: number }): string | null {
  return tokenImageUrl({ side: dump.side, face: 'combat', noncombatKind: 'sp', spPoints: dump.sp })
}

/**
 * **机型库记录** → 算子图 URL（B14：空军面板的「摆放飞机」手上是**库记录**、不是实例）
 *
 * 与 `counterImageUrlOf` 走同一条 `tokenImageUrl`（面板侧选图的唯一入口仍是它）：
 * 飞机没有朝向（恒取正面）、也没有 SP/基地等级这类「图随当前数值走」的属性，
 * 故只透传 `side` 与 `images` 两项。`side` 由调用方给——记录视图的字段可缺省，
 * 而选图必须知道去哪个图档目录取文件（`axis` / `soviet`）。
 */
export function aircraftRecordImageUrlOf(record: AircraftRecordView, side: Side): string | null {
  return tokenImageUrl({ side, face: 'combat', images: record.images ?? null })
}

/**
 * 第 n 回合的日期（越界时收敛到轨内首/末回合）
 *
 * ★ 口径唯一（M2①）：**回合 → 日期的映射只有引擎 `turn-driver.ts#turnDate` 一处实现**，
 *   本函数只额外做「越界夹取」（操作台的回合号可由界面随手拨动，夹取比抛错更合用），
 *   然后把映射本身交给引擎。此前这里另有一份 `TURN_TRACK.find(...)`，与引擎那份并存 ——
 *   两处都读同一份 `markers.turnTrack`，但**越界行为相反**（本处夹取、引擎抛错），
 *   而日期是专规闸门（专规 1.2 铁路容量、专规 2.3e 战略模式）的**唯一输入**，不得有两套。
 */
export function turnDateOf(turn: number): string {
  const first = TURN_TRACK[0]
  const last = TURN_TRACK[TURN_TRACK.length - 1]
  if (first === undefined || last === undefined) return ''
  const clamped = Math.min(last.turn, Math.max(first.turn, Math.trunc(turn)))
  return turnDate(clamped)
}

/* ────────────────────────────── 阶段闸门（B7：动作族 × 环节） ────────────────────────────── */

/**
 * 界面**动作族**（阶段闸门的键）
 *
 * 与引擎的 `ActionKind` 分工不同、**不替代它**：
 *   · `ActionKind`（`engine/rules/legality.ts`）＝**时机合法性**的词表，判"这个动作在这一段合不合法"；
 *   · `ActionKey`（本处）＝**界面动作族**，判"此刻这个环节里，这条操作该不该给玩家点"，
 *     粒度贴着界面走（例如 `supply.draw` 在引擎里是 `supplyTrace` + `hqThrow` 两个 kind）。
 * 两者的**对应关系由测试钉住**（见 `ACTION_KEY_KIND`）：每个键必须能说出它在引擎里对应哪些 kind，
 * 免得界面自造一套"看起来像规则"的动作。
 */
export type ActionKey =
  /* A 整备（15.1 / 15.4） */
  | 'air.refit'
  | 'air.baseReduce'
  /* B 增援（13.6 / 13.5 / 20.0c / 专规 13.7 / 1.6c / 2.3c） */
  | 'rein.arrival'
  | 'rein.supplyArrival'
  | 'rein.rebuild'
  | 'rein.formationDraw'
  | 'rein.specialRepl'
  | 'rein.frontalReserves'
  /* C 移动（12.8e / 5.4a / 6.x / 8.0 / 13.x / 15.3 / 16.0 / 20.0a / 12.11a） */
  | 'move.breakout'
  | 'move.modeChange'
  | 'move.order'
  | 'move.overrun'
  | 'move.railTransport'
  | 'move.railConversion'
  | 'move.loadUnload'
  /* 13.2c：运输点数的合并 / 拆分（只在**移动阶段**；不耗 MP） */
  | 'move.transportMerge'
  | 'move.construction'
  | 'move.hedgehog'
  | 'move.breakdown'
  | 'move.dumpBlow'
  /* 12.7a/d（第五批批 B 切片 2）：运输点数 ⇄ 延补队的双向转换 */
  | 'move.extenderConvert'
  /* 轰炸（10.0；段限定见 BARRAGE_SOURCES_BY_PHASE） */
  | 'barrage.declare'
  /* F/G 战斗（9.x / 11.0） */
  | 'combat.declare'
  /* D 补给（12.10e / 12.6 / 12.8；**燃料不在本段**，12.5c 见下） */
  | 'supply.recovery'
  | 'supply.draw'
  | 'supply.fuel'
  | 'supply.attrition'
  /* E/G 预备（5.7b） */
  | 'reserve.release'
  /* 空中任务（14.2e） */
  | 'air.mission'
  /* 专规（B37：把"按时机分散"的三条补上闸门） */
  | 'exclusive.forage'
  | 'exclusive.panzerObligation'

/** 这一环的**行动者**是谁（2.2：E 反应段是**非行动方**的回合） */
export type ActionRole = 'active' | 'nonActive'

/** 某动作族在哪个（段，环节）被允许 */
export interface ActionGateWhere {
  /** 段（2.2 的 A–H / Pre-Turn / Turn End） */
  phase: GamePhase
  /** 环节 id（唯一出处：`engine/rules/sop-segments.ts` 的 `SopSegmentStep.id`） */
  segment: string
  /** 行动者（缺省 `active`） */
  role?: ActionRole
  /** 只对某一方存在（缺省＝双方）；B 段的抽取类动作按方不同 */
  sides?: readonly Side[]
  /**
   * **段末**（B37 新增的时机类别）
   *
   * `'end'` ＝ 该动作只在「**本段的最后一个环节**」才交给玩家（查询方用
   * `ActionGateQuery.atSegmentEnd` 声明"此刻是不是段末"）。
   * 为什么需要这一类：3.4a 的分界线义务原文是**相位末**结算的事 —— 它既不是"随时可做"，
   * 也不是"整段都能做"，用现有的 (段, 环节) 二元组表达不出来。
   */
  at?: 'end'
}

/** 一个动作族的闸门条目（逐条带规则号：界面只查表，不比较规则号） */
export interface ActionGate {
  key: ActionKey
  /** 界面用语（简短） */
  label: string
  /** 规则出处（条文号） */
  rule: string
  /** 允许它的去处（空数组＝**永不交给玩家点**，如 B 段的掷骰与事件） */
  where: readonly ActionGateWhere[]
}

/**
 * **阶段闸门表**（B7；§4.1.3 的「环节 × 动作族」矩阵）
 *
 * 纪律：**每个键的去处必须落在 `sop-segments.ts` 里真实存在的环节 id 上**，且
 * 每个"给玩家点的"键至少有一个去处——两条都由测试钉住（`tests/stores/phase-gate.test.ts`）。
 * 界面侧的用法只有一句：`allowedActionsOf({phase, segment, role, side}).has(key)`。
 */
export const ACTION_GATES: readonly ActionGate[] = [
  {
    key: 'air.refit',
    label: '整备基地飞机',
    rule: '15.1',
    where: [{ phase: 'aircraftRefit', segment: 'aircraftRefit.refit' }],
  },
  {
    key: 'air.baseReduce',
    label: '缩减己方空军基地',
    rule: '15.4',
    where: [{ phase: 'movement', segment: 'movement.modeAndMovement' }],
  },
  {
    key: 'rein.arrival',
    label: '到货落位',
    rule: '13.6',
    where: [{ phase: 'reinforcement', segment: 'reinforcement.arrival' }],
  },
  {
    // 批 F 切片 3：补给表到货 SP 的**免费铁运落点**（专规 2.1 / 3.1 + 通规 13.3c）与
    // 3.6 补给列车的 2 SP。与"到货落位"（13.6 的到达卡投放）同一环节 —— 补给表 SP 也属当日到货。
    key: 'rein.supplyArrival',
    label: '到货 SP 落位（免费铁运）',
    rule: '专规 2.1 / 3.1',
    where: [{ phase: 'reinforcement', segment: 'reinforcement.arrival' }],
  },
  {
    key: 'rein.rebuild',
    label: '重建 / 整编',
    rule: '13.5 / 13.9',
    where: [{ phase: 'reinforcement', segment: 'reinforcement.rebuild' }],
  },
  {
    key: 'rein.formationDraw',
    label: '编队抽取',
    rule: '专规 13.7',
    where: [{ phase: 'reinforcement', segment: 'reinforcement.formationDraw', sides: ['axis'] }],
  },
  {
    key: 'rein.specialRepl',
    label: '特殊补员抽取',
    rule: '专规 1.6c',
    where: [{ phase: 'reinforcement', segment: 'reinforcement.specialRepl', sides: ['soviet'] }],
  },
  {
    key: 'rein.frontalReserves',
    label: '领取方面军预备队',
    rule: '专规 2.3c',
    where: [
      { phase: 'reinforcement', segment: 'reinforcement.frontalReserves', sides: ['soviet'] },
    ],
  },
  {
    key: 'move.breakout',
    label: '突围尝试',
    rule: '12.8e',
    where: [{ phase: 'movement', segment: 'movement.breakout' }],
  },
  {
    key: 'move.modeChange',
    label: '改模式 / 翻朝向',
    rule: '5.4a',
    where: [{ phase: 'movement', segment: 'movement.modeAndMovement' }],
  },
  {
    key: 'move.order',
    label: '移动',
    rule: '6.x',
    where: [
      { phase: 'movement', segment: 'movement.modeAndMovement' },
      { phase: 'reaction', segment: 'reaction.movement', role: 'nonActive' },
      { phase: 'exploitation', segment: 'exploitation.movement' },
    ],
  },
  {
    key: 'move.overrun',
    label: '突袭',
    rule: '8.0',
    /*
     * 8.0 首句：「突袭是在**各个移动环节**中，可能发生的一种战斗形式。」
     * ⇒ C 移动 / E 反应 / G 进击 三个移动环节**都要给**（引擎 `OVERRUN_SEGMENTS` 同口径）；
     *   修前缺 E 反应 ⇒ 反应阶段的轮式单位按 4.5a-A 停车后**无处突袭**（第六批 BUG ①）。
     */
    where: [
      { phase: 'movement', segment: 'movement.modeAndMovement' },
      { phase: 'reaction', segment: 'reaction.movement', role: 'nonActive' },
      { phase: 'exploitation', segment: 'exploitation.movement' },
    ],
  },
  {
    key: 'move.railTransport',
    label: '铁路运输',
    rule: '13.3',
    where: [{ phase: 'movement', segment: 'movement.modeAndMovement' }],
  },
  {
    key: 'move.railConversion',
    label: '换轨',
    rule: '13.3f',
    where: [{ phase: 'movement', segment: 'movement.modeAndMovement' }],
  },
  {
    key: 'move.loadUnload',
    label: '装载 / 卸载 SP',
    rule: '13.2f',
    where: [{ phase: 'movement', segment: 'movement.modeAndMovement' }],
  },
  {
    // 13.2c 原文：「合并与拆分 不消耗 MP，但**只能在友方移动阶段**中进行，且所有所涉及的
    // 运输点数必须在同一格内」。★ 只取 `movement.modeAndMovement`：E 反应段与 G 进击段
    // 分别是「反应阶段」「进击阶段」，与原文的「移动阶段」不是同一段（不失之于宽）。
    key: 'move.transportMerge',
    label: '合并 / 拆分运输点数',
    rule: '13.2c',
    where: [{ phase: 'movement', segment: 'movement.modeAndMovement' }],
  },
  {
    key: 'move.construction',
    label: '建造（基地 / 简易机场 / 建造标记）',
    rule: '13.8d / 15.3 / 15.2 / 专规 3.5',
    where: [{ phase: 'movement', segment: 'movement.modeAndMovement' }],
  },
  {
    key: 'move.hedgehog',
    label: '修建 / 缩减环形工事',
    rule: '16.0b·c',
    where: [{ phase: 'movement', segment: 'movement.modeAndMovement' }],
  },
  {
    key: 'move.breakdown',
    label: '创建拆分单位',
    rule: '20.0a',
    where: [
      { phase: 'movement', segment: 'movement.modeAndMovement' },
      { phase: 'combat', segment: 'combat.combat' },
      { phase: 'exploitation', segment: 'exploitation.combat' },
    ],
  },
  {
    key: 'move.dumpBlow',
    label: '销毁己方补给站',
    rule: '12.11a',
    where: [
      { phase: 'movement', segment: 'movement.modeAndMovement' },
      { phase: 'reaction', segment: 'reaction.movement', role: 'nonActive' },
      { phase: 'exploitation', segment: 'exploitation.movement' },
    ],
  },
  {
    // 第五批批 B 切片 2：12.7a「将运输点数转换为延补队只能在该玩家的**移动阶段**中进行……
    // 此操作消耗 1/2 的 MA」；12.7d 的翻面同理。环节与 `engine/rules/extender.ts#EXTENDER_SEGMENTS`
    // （movement / reaction / exploitation 三个移动环节）同口径 —— 引擎判一次、UI 闸放一次，双层同源。
    key: 'move.extenderConvert',
    label: '运输点数 ⇄ 延补队',
    rule: '12.7a·d',
    where: [
      { phase: 'movement', segment: 'movement.modeAndMovement' },
      { phase: 'reaction', segment: 'reaction.movement', role: 'nonActive' },
      { phase: 'exploitation', segment: 'exploitation.movement' },
    ],
  },
  {
    key: 'barrage.declare',
    label: '宣布轰炸',
    rule: '10.0',
    where: [
      // 段限定（SOP 原文）：C 段仅空中与舰炮、F 段仅炮兵、E/G 不限
      { phase: 'movement', segment: 'movement.barrage' },
      /*
       * ★ G①（2026-09-19）：**C 段的移动环节**也放行宣布轰炸 —— 依据 10.0b / 14.7d：
       *   低空扫射是"在**移动环节**里对地面单位的一次轰炸"（`missionSegmentOf('hip_shoot')` 也是
       *   `movementSegment`），引擎的 `BARRAGE_SOURCES_BY_PHASE.movement` 亦为 `['air','ship']`。
       *   炮兵在移动段仍会被引擎按 10.0e-D 拒（`wrongPhaseForartillery:movement`），且界面按段只给
       *   空中/舰炮来源 ⇒ 不会出现"点了必被拒"的按钮。
       */
      { phase: 'movement', segment: 'movement.modeAndMovement' },
      { phase: 'reaction', segment: 'reaction.barrage', role: 'nonActive' },
      { phase: 'combat', segment: 'combat.barrage' },
      { phase: 'exploitation', segment: 'exploitation.barrage' },
    ],
  },
  {
    key: 'combat.declare',
    label: '宣告并结算战斗',
    rule: '9.2',
    where: [
      { phase: 'combat', segment: 'combat.combat' },
      { phase: 'exploitation', segment: 'exploitation.combat' },
    ],
  },
  {
    // 12.10e：D 段第一环的**恢复部队储备**（低下/耗尽 ⇒ ready）
    key: 'supply.recovery',
    label: '恢复部队储备',
    rule: '12.10e',
    where: [{ phase: 'supply', segment: 'supply.recovery' }],
  },
  {
    key: 'supply.draw',
    label: '拖取 / 投递补给',
    rule: '12.3a·b',
    where: [
      // 12.10e-B：「只要是低下或耗尽单位**可拖取**，或**可投递** SP 至这些单位的补给站，均需要按规则去恢复」
      { phase: 'supply', segment: 'supply.recovery' },
      // 12.6：「直接拖取（12.3a）和指挥部投递（12.3b）均可用于追溯补给的接收与分配」
      { phase: 'supply', segment: 'supply.check' },
    ],
  },
  {
    key: 'supply.fuel',
    label: '加油',
    rule: '12.5',
    where: [
      /*
       * ★ 12.5c：「在发生燃料消耗的**任何阶段**，单位都应在燃料消耗时支付对应的燃料补给」
       *   ⇒ 付款只发生在**会用燃料的环节**：C/E/G 三段的**移动环节**
       *   （12.5a/12.5f：开拔与离开入场格前必须已付，`needsFuelToMove`）。
       *
       * ★ H④（用户 2026-09-19 口径）：**D 补给段原先那个「加油」环节已删除** ——
       *   「燃料环节不应该存在，未加油单位是在移动前加油」。故本键**不再**挂任何 supply 环节：
       *   D 段（12.10e 恢复 / 12.6 检定）不发生燃料消耗，也就没有付款时机。
       */
      { phase: 'movement', segment: 'movement.modeAndMovement' },
      { phase: 'reaction', segment: 'reaction.movement', role: 'nonActive' },
      { phase: 'exploitation', segment: 'exploitation.movement' },
    ],
  },
  {
    key: 'supply.attrition',
    label: '断补损耗处置',
    rule: '12.8b',
    // 12.8a：「在补给阶段中……会被标记为断补，并检查损耗」⇒ 属 D 段第二环（补给检定）
    where: [{ phase: 'supply', segment: 'supply.check' }],
  },
  {
    key: 'reserve.release',
    label: '释放预备',
    rule: '5.7b',
    where: [
      { phase: 'reaction', segment: 'reaction.movement', role: 'nonActive' },
      { phase: 'exploitation', segment: 'exploitation.movement' },
    ],
  },
  {
    // B37：1.7 / 21.10 补给缓存的 Forage —— 只在补给段（与引擎 forageOnlyInSupplyPhase 同口径）
    key: 'exclusive.forage',
    label: '补给缓存：Forage（就地取给）',
    rule: '专规 1.7 / 21.10',
    where: [
      { phase: 'supply', segment: 'supply.recovery' },
      { phase: 'supply', segment: 'supply.check' },
    ],
  },
  {
    // B37：3.4a 分界线义务 —— **段末**结算（对方在错误一侧/与他集群相邻 ⇒ 须投 DG）
    key: 'exclusive.panzerObligation',
    label: '3.4a 分界线义务（段末结算）',
    rule: '专规 3.4a',
    where: [
      /*
       * 3.4a 的义务是**相位末**的事 ⇒ 把该段**全部玩家环节**都列上、并标 `at: 'end'`：
       * 只有走到本段最后一个玩家环节时才放行（`atSegmentEnd`），段中一律不放。
       * 为什么不写"最后一个环节的 id"：段的玩家环节随剧本与 `skipWhenIdle` 跳过规则变化，
       * 写死某一个 id 会在链变短时失效 —— 列全 + 段末判据才是稳的。
       */
      { phase: 'movement', segment: 'movement.breakout', sides: ['axis'], at: 'end' },
      { phase: 'movement', segment: 'movement.modeAndMovement', sides: ['axis'], at: 'end' },
      { phase: 'movement', segment: 'movement.barrage', sides: ['axis'], at: 'end' },
      { phase: 'exploitation', segment: 'exploitation.movement', sides: ['axis'], at: 'end' },
      { phase: 'exploitation', segment: 'exploitation.barrage', sides: ['axis'], at: 'end' },
      { phase: 'exploitation', segment: 'exploitation.combat', sides: ['axis'], at: 'end' },
    ],
  },
  {
    key: 'air.mission',
    label: '执行空军任务',
    rule: '14.2e',
    where: [
      // 14.2e：任务按环节分派（低空扫射/空运/空投/基地转移/战机扫荡在移动环节，空军轰炸等在轰炸环节）
      { phase: 'movement', segment: 'movement.modeAndMovement' },
      { phase: 'movement', segment: 'movement.barrage' },
      { phase: 'reaction', segment: 'reaction.movement', role: 'nonActive' },
      { phase: 'reaction', segment: 'reaction.barrage', role: 'nonActive' },
      /*
       * ★ G① 契约变更（2026-09-19）：**F 段轰炸环节不再放行空中任务**。
       *   2.2 SOP 的 F 段括注是「Barrage (artillery only, no air)」，引擎的 `barrageEligibility`
       *   也只在移动/反应/进击段放行空军轰炸（10.0e-C，`wrongPhaseForair:combat`）。
       *   修前这里挂着 `{ phase: 'combat', segment: 'combat.barrage' }` ⇒ 界面放出按钮、引擎必然拒，
       *   玩家看到的是"点了就被拒"。空中轰炸在 C 段的轰炸环节宣布（见上一条 `movement.barrage`）。
       */
      { phase: 'exploitation', segment: 'exploitation.movement' },
      { phase: 'exploitation', segment: 'exploitation.barrage' },
    ],
  },
]

/**
 * 动作族 → 引擎的时机词表（`ActionKind`）
 *
 * 两个词表**必须能对上**（测试逐键检查）：界面键不许凭空发明"像规则的东西"。
 * 空数组＝该键在引擎的时机表里**没有对应 kind**（B6 已登记的缺口，见下）；
 * 这些键仍要出现在闸门表里（界面确实有这块操作），但要在测试里**显式列出**才允许为空。
 *
 * ★ **20.0d 吸收拆分单位不是环节动作**：原文「减损的多军力单位在**任何阶段结束时**都必须吸收……
 *   **只有在这些时机**才能吸收拆分单位」⇒ 它是**段末的强制收束**，本表**不设** `rein.absorb` 这类键。
 *   store 侧由 `settleAbsorbObligationsNow` / `absorbBreakdownNow`（`timing: 'segmentEnd'`）实现，
 *   按 20.0d **不按环节设闸**。20.0a 的**创建**才有环节（C 段「开始移动」、F/G 段的战斗环节）。
 */
export const ACTION_KEY_KIND: Readonly<Record<ActionKey, readonly ActionKind[]>> = {
  'air.refit': ['refit'],
  'air.baseReduce': [], // 15.4 缩减：engine/rules 里无 kind（`move.construction` 一族未含）
  'rein.arrival': ['arrival'],
  'rein.supplyArrival': [], // 专规 2.1/3.1 落点：时机表未收（非"由单位执行"的动作）
  'rein.rebuild': ['rebuild', 'consolidate'],
  'rein.formationDraw': [], // 专规 13.7 抽签：时机表未收（非"由单位执行"的动作）
  'rein.specialRepl': [], // 专规 1.6c：同上
  'rein.frontalReserves': [], // 专规 2.3c：同上
  'move.breakout': ['breakout'],
  'move.modeChange': ['modeChange'],
  'move.order': ['move'],
  'move.overrun': ['overrun'],
  'move.railTransport': ['railTransport'],
  'move.railConversion': ['railConversion'],
  'move.loadUnload': ['loadUnload'],
  // 13.2c：合并/拆分不耗 MP、无单位执行 ⇒ 时机表未收（属补给子系统；环节闸由本表 `where` 判）
  'move.transportMerge': [],
  'move.construction': ['engineer'],
  'move.hedgehog': ['buildHedgehog'],
  'move.breakdown': ['breakdown'],
  'move.dumpBlow': [], // 12.11a：销毁补给站，时机表未收（属补给子系统）
  'move.extenderConvert': [], // 12.7a/d：延补队转换/翻面，时机表未收（属补给子系统；环节闸由 EXTENDER_SEGMENTS 判）
  'barrage.declare': ['barrage'],
  'combat.declare': ['attack'],
  'supply.draw': ['supplyTrace', 'hqThrow'],
  'supply.recovery': [], // 12.10e 恢复部队储备：时机表未收（属补给子系统）
  'supply.fuel': ['fuel'],
  'supply.attrition': [], // 12.8b 损耗分配：时机表未收
  'reserve.release': ['reserveRelease'],
  'air.mission': ['airMission'],
  // B37：专规两条时机（Forage / 3.4a 段末义务）—— 引擎时机表里没有对应 kind（已登记在 ACTION_KEYS_WITHOUT_KIND）
  'exclusive.forage': [],
  'exclusive.panzerObligation': [],
}

/** 允许"在引擎时机表里没有对应 kind"的键（逐个登记；新增即须在此说明理由） */
export const ACTION_KEYS_WITHOUT_KIND: readonly ActionKey[] = [
  // B37：专规的三条时机（3.3b 移除 / 1.7 Forage / 3.4a 段末义务）——
  // 它们的"时机"由本节新加的 `at: 'end'` 与 H/补给段的（段, 环节）表达，
  // 引擎的时机表（ACTIONS_BY_PHASE）里没有对应 kind。
  'exclusive.forage',
  'exclusive.panzerObligation',
  'air.baseReduce',
  'rein.formationDraw',
  'rein.specialRepl',
  'rein.frontalReserves',
  // 批 F 切片 3：专规 2.1/3.1 的到货 SP 落点（免费铁运）——同上，非"由单位执行"的动作
  'rein.supplyArrival',
  'move.dumpBlow',
  // 第五批批 B 切片 2（12.7a/d）：延补队转换/翻面 —— 同上，属"SP/运输点子的转换"而非"由单位执行"的动作
  'move.extenderConvert',
  // ★ 2026-10-25（13.2c）：运输点数的合并/拆分 —— 不耗 MP、也不由单位执行（时机表无 kind）
  'move.transportMerge',
  'supply.attrition',
  // H④（12.10e）：恢复部队储备 —— 同上，属"SP 分配"而非"由单位执行"的动作
  'supply.recovery',
]

/**
 * **store 层没有实现入口**的动作族（B8 补闸门时发现，逐个登记）
 *
 * 这些键在规则上真实存在（B6 的环节链里也有它们的位置），但 store 里**一处调用都没有**
 * ⇒ B8 无从给它们补环节闸门（要补的是**实现**，不是闸门）。登记在此是为了让缺口可见：
 * 否则界面照 `allowedActionsOf` 放行，玩家会点到一个什么都不做的按钮。
 */
export const ACTION_KEYS_WITHOUT_STORE_ENTRY: readonly ActionKey[] = [
  // 批 E 切片 2：`rein.formationDraw` **已接线** —— `containers.drawAndApplyStepNow()`
  // （B 增援段该环节内：抽签 → 落盘 → 回写初设台账），故从本表**删除**。
  'rein.specialRepl', // 专规 1.6c：store 里 specialRepl 出现 0 次
  // B47（2026-09-17）：`move.breakout` 已接线（store 的 `breakoutNow` / `breakoutCandidates`），
  // 故从本表**删除** —— 这条守卫（`phase-gate-wiring.test.ts`）就是逼着删的那只手。
]

/** 闸门查询（界面只传这四个量：段 / 环节 / 行动者 / 本方） */
export interface ActionGateQuery {
  phase: GamePhase
  /** 环节 id（`SopSegmentStep.id`） */
  segment: string
  /** 行动者（E 反应段为 `nonActive`） */
  role: ActionRole
  /** 本方（用于按方限定的动作族） */
  side?: Side
  /**
   * 此刻是不是**本段的最后一个环节**（B37）
   *
   * 只有它显式为 `true` 时，标了 `at: 'end'` 的动作族才会被放行 —— 默认不声明即"不是段末"，
   * 免得别处的调用方在段中就把"段末才结算的事"放出去。
   */
  atSegmentEnd?: boolean
}

/**
 * **本环节允许的动作族**（B7 的唯一取用入口，纯函数）
 *
 * 语义：给定"现在在哪一段的哪一环节、谁是行动者、本方是谁"，返回玩家此刻**能点的动作族集合**。
 * 界面只做 `has(key)` 判断（架构门禁禁止组件里比较规则号，故规则号也一并由此表给出）。
 */
export function allowedActionsOf(query: ActionGateQuery): ReadonlySet<ActionKey> {
  const allowed = new Set<ActionKey>()
  for (const gate of ACTION_GATES) {
    for (const where of gate.where) {
      if (where.phase !== query.phase || where.segment !== query.segment) continue
      if ((where.role ?? 'active') !== query.role) continue
      if (
        where.sides !== undefined &&
        query.side !== undefined &&
        !where.sides.includes(query.side)
      )
        continue
      // B37：段末类动作只在"段末"放行（查询方不声明即视为段中）
      if (where.at === 'end' && query.atSegmentEnd !== true) continue
      allowed.add(gate.key)
      break
    }
  }
  return allowed
}

/** 取某动作族的闸门条目（界面要显示"这条为什么现在不能点"时用它拿规则号） */
export function actionGateOf(key: ActionKey): ActionGate {
  const found = ACTION_GATES.find((gate) => gate.key === key)
  if (found === undefined) throw new RangeError(`闸门表里没有这个动作族：${key}`)
  return found
}

/** 该动作族此刻是否允许（`allowedActionsOf` 的便捷包装） */
export function isActionAllowed(query: ActionGateQuery, key: ActionKey): boolean {
  return allowedActionsOf(query).has(key)
}

/**
 * 环节 id → 所属阶段（`movement.modeAndMovement` ⇒ `movement`）
 *
 * 环节 id 的前缀就是阶段（`sop-segments` 的 `phase.id`），故按第一个 `.` 切即可；
 * 认不出的前缀返回 `null`（调用方据此"不猜"）。
 */
export function phaseOfSegment(stepId: string): GamePhase | null {
  const head = stepId.split('.')[0] ?? ''
  return (GAME_PHASES as readonly string[]).includes(head) ? (head as GamePhase) : null
}

/**
 * **某环节允许的动作族**（用户 2026-10-25：「按规则书分清楚每个阶段\环节有哪些操作」）
 *
 * 这是"环节 ↔ 操作"的**唯一派生出入口**：界面不比较规则号、也不自己拼阶段名，
 * 一律问本函数（或其 store 投影 `workbench.segmentActionKeys`）。
 *
 * 依据链：`ACTION_GATES.where`（每条动作族的规则原文位置）⇒ 本函数 ⇒
 *   · UI 显隐/禁用（`actionAllowedNow` 同源）；
 *   · `docs/阶段-环节-操作矩阵.md`（文档也由这条链生成）。
 *
 * @param stepId 环节 id（`SopSegmentStep.id`）
 * @param side   本方（按方限定的动作族才会被筛掉；不传＝不按方筛）
 * @param role   行动者（E 反应段是 `nonActive`）
 * @param atSegmentEnd 此刻是不是本段最后一个环节（`at: 'end'` 的动作族只在此放行）
 */
export function actionKeysOfSegment(
  stepId: string,
  side?: Side,
  role: ActionRole = 'active',
  atSegmentEnd = false,
): ReadonlySet<ActionKey> {
  const phase = phaseOfSegment(stepId)
  if (phase === null) return new Set<ActionKey>()
  return allowedActionsOf({
    phase,
    segment: stepId,
    role,
    ...(side === undefined ? {} : { side }),
    atSegmentEnd,
  })
}

/* ────────────────────────────── 阶段闸门（B7：算子参与判定） ────────────────────────────── */

/**
 * 「这个算子此刻能不能被拾起」的结论
 *
 * `ok:false` 时给**规则号 + 一句人话**：界面照口径只在地图内就地冒一行灰提示（不弹窗、不换页），
 * 不参与本环节的算子**不高亮、点击不产生会话框**（用户口径：不参与环节的算子无法点击）。
 */
export type ParticipationVerdict =
  { ok: true; rule: string } | { ok: false; rule: string; reason: string }

const cannotParticipate = (rule: string, reason: string): ParticipationVerdict => ({
  ok: false,
  rule,
  reason,
})

/** 参与判定输入（地面算子） */
export interface ParticipationQuery {
  unit: ConsoleUnit
  phase: GamePhase
  /** 环节 id（`SopSegmentStep.id`） */
  segment: string
  /** 当前行动方（2.2：反应段的行动者是**非**行动方） */
  activeSide: Side
  /**
   * 9.1c：本**战斗环节**已攻击过的单位 id（账本由 store 持有，缺省＝空账本）
   *
   * 原文「在一个战斗环节中，同一个单位只能攻击一次」⇒ 已攻击过的单位在本环节**不再可拾起**
   * （用户口径 9.17⑤：「战斗环节只列**没攻击过**的可攻击战斗单位」）。
   * ★ 只影响战斗环节：同一份账本对突袭**不适用**（9.1c 下一条：移动环节同一单位可多次突袭），
   *   而 `combat.combat` / `exploitation.combat` 两个环节 id 本身就只出现在**战斗环节**上。
   */
  attackedUnitIds?: readonly string[]
}

/** 该算子当前的印值面是否有轰炸值（10.0：能轰炸的单位） */
function hasBarrageFactor(unit: ConsoleUnit): boolean {
  return (unit.raw.barrage ?? 0) > 0
}

/**
 * 造引擎的模式归类输入（`modeUnitClass` / `isMobileUnit` 的入参）
 *
 * 为什么在这里造一次：那两个谓词吃的是**同一个 profile**（"归哪类"与"有没有 MA"是两条判据），
 * 各造一份就会漂移；本函数是 ConsoleUnit → profile 的唯一换算处。
 */
function modeProfileOf(unit: ConsoleUnit): ModeUnitProfile {
  return {
    isCombat: unit.isCombat,
    specialized: unit.specialized,
    noncombatKind: unit.noncombatKind ?? null,
    ma: unit.raw.ma,
  }
}

/** 该算子能否作为"可攻击的攻方"（9.1b：可攻击 + 印刷战斗值 > 0 + 未动） */
function canBeAttacker(unit: ConsoleUnit): boolean {
  return unit.attackCapable && unit.raw.attack > 0 && !unit.movementEnded
}

/**
 * **算子在本环节是否参与**（B7；§4.1.7）
 *
 * 这是**第一层**资格（能不能被拾起）。刻意做**粗**且**可读**：
 *   · 第二层＝具体动作的闸门（B8 给每个动作补 `requirePhase`，按 `ActionKey` 判）；
 *   · 第三层＝引擎既有的细判（`canOverrun` / `canBreakout` / `checkLegality` … 在动作真正执行时判）。
 * 粗判必须**保守**（绝不放行明显不该点的东西），但不必**完备**——故每一处都用引擎已有的谓词
 * （`canMoveInPhase` / `canReleaseReserve` / `isMobileUnit` / `canEngineer` …）拼装，不另立判据。
 */
export function participatesIn(query: ParticipationQuery): ParticipationVerdict {
  const { unit, phase, segment, activeSide } = query
  const friendly = unit.side === activeSide

  // 2.2 / 2.3：判定与清理环节没有可动的算子
  if (phase === 'preTurn' || phase === 'cleanUp' || phase === 'turnEnd') {
    return cannotParticipate(
      '2.2',
      '本环节没有可动的算子（天气 / 先手判定 / 清理都是引擎自动结算）',
    )
  }

  // 专规 2.4：被锁定的师一概不能动（也不能拆出 breakdown）
  if (unit.locked) return cannotParticipate('专规 2.4', '该师处于 Slow Mobilization 锁定状态')

  switch (segment) {
    /* ── A 飞机整备：只点基地与飞机，**地面单位一律不可点**（备忘 #4 的原话） ── */
    case 'aircraftRefit.refit':
      return unit.noncombatKind === 'air_base'
        ? { ok: true, rule: '15.1' }
        : cannotParticipate('15.1', '整备段只点空军基地（与基地内的飞机）；地面单位本环节不参与')

    /* ── B 增援：本环节的对象是"待入场的条目"，故图上算子不可点 ── */
    case 'reinforcement.arrival':
    case 'reinforcement.rebuild':
    case 'reinforcement.absorbBreakdown':
    case 'reinforcement.formationDraw':
    case 'reinforcement.specialRepl':
    case 'reinforcement.frontalReserves':
      return cannotParticipate('13.6', '增援段的对象是待入场条目与盒内算子，图上算子本环节不参与')

    /* ── C 移动 · 突围（12.8e：只有**无追溯补给**的战斗单位可尝试） ── */
    case 'movement.breakout':
      if (!friendly) return cannotParticipate('6.0', '突围只能由当前阶段玩家的单位尝试')
      if (unit.hasTraceSupply)
        return cannotParticipate('12.8e', '该单位有追溯补给，无从突围（12.8e 只对断补单位）')
      if (!unit.isCombat) return cannotParticipate('12.8e', '非战斗单位不能突围')
      return { ok: true, rule: '12.8e' }

    /* ── C 移动 · 模式与移动（6.0 / 5.4a / 13.x / 16.0 / 20.0a） ── */
    case 'movement.modeAndMovement': {
      const verdict = canMoveInPhase({ state: unit.mode, side: unit.side, activeSide }, 'movement')
      if (!verdict.ok) return cannotParticipate(verdict.rule, verdict.reason)
      if (!isMobileUnit(modeProfileOf(unit)))
        return cannotParticipate('6.1b', '该算子没有 MA（设施类不可移动）')
      if (unit.movementEnded) return cannotParticipate('6.1', '该单位本轮移动已结束')
      return { ok: true, rule: '6.0' }
    }

    /* ── C 移动 · 轰炸（SOP 原文：air & ship only）⇒ 地面算子不参与 ── */
    case 'movement.barrage':
      return cannotParticipate('10.0', '移动段的轰炸限空中与舰炮（SOP 原文），地面算子不参与')

    /* ── D 补给 · 第一环：恢复部队储备（12.10e） ── */
    case 'supply.recovery':
      /*
       * 12.10e：恢复的**对象**是带 low/exhausted 标志的单位，但本环同时承担 12.10e-B 的
       * 直接拖取 / 指挥部投递（SP 可能由 HQ 投给那些单位）⇒ 参与集合**不**收窄到"只有低/耗尽单位"
       * 之外的判据（谁低谁耗尽由计划与落盘点名，界面只负责让人点得到它们与投入 SP 的指挥部）。
       */
      if (!friendly) return cannotParticipate('12.10e', '只能为本方单位恢复部队储备')
      return { ok: true, rule: '12.10e' }

    /* ── D 补给 · 第二环：补给检定（12.6 判定 → 12.6c/d 处置 → 12.8 损耗） ── */
    case 'supply.check': {
      if (!friendly) return cannotParticipate('12.6', '只能对本方单位做补给检定')
      /*
       * 12.6 要求**每个**战斗单位都检一遍（不是只有断补的才检）；12.8 的损耗只落在断补堆叠上，
       * 但那一步的名单由 `oosAttritionDuty` 这类计划给出，不在"谁能点"这一层收窄。
       */
      return { ok: true, rule: '12.6' }
    }

    /* ── E 反应 · 反应移动（6.3a：非行动方；7.0a：已释放预备） ── */
    case 'reaction.movement': {
      const verdict = canMoveInPhase({ state: unit.mode, side: unit.side, activeSide }, 'reaction')
      if (!verdict.ok) return cannotParticipate(verdict.rule, verdict.reason)
      if (!isMobileUnit(modeProfileOf(unit)))
        return cannotParticipate('6.1b', '该算子没有 MA（设施类不可移动）')
      if (unit.movementEnded) return cannotParticipate('6.1', '该单位本轮移动已结束')
      return { ok: true, rule: '7.0a' }
    }
    /* ── E 反应 · 反应轰炸（非行动方的炮兵 / 空中） ── */
    case 'reaction.barrage':
      if (friendly) return cannotParticipate('6.3a', '反应段由非阶段玩家行动')
      if (!hasBarrageFactor(unit)) return cannotParticipate('10.0', '该单位没有轰炸值')
      return { ok: true, rule: '10.0' }

    /* ── F 战斗 · 炮击环节（SOP 原文：artillery only） ── */
    case 'combat.barrage':
      if (!friendly) return cannotParticipate('9.0', '战斗段由当前阶段玩家行动')
      if (!hasBarrageFactor(unit)) return cannotParticipate('10.0', '炮击环节只点有轰炸值的炮兵')
      return { ok: true, rule: '10.0' }

    /* ── F 战斗 · 战斗环节（9.1b：可攻击 + 印刷战斗值 + 未动；9.1c：本环节未攻击过） ── */
    case 'combat.combat':
      if (!friendly) return cannotParticipate('9.1b', '敌方算子只读（4.9a）')
      if (query.attackedUnitIds?.includes(unit.instanceId) === true)
        return cannotParticipate('9.1c', '该单位在本战斗环节已攻击过（一个单位只能攻击一次）')
      if (!canBeAttacker(unit))
        return cannotParticipate('9.1b', '该单位不可攻击（无印刷战斗值或本轮已移动）')
      return { ok: true, rule: '9.1b' }

    /* ── G 进击（11.0a：进击标记单位或已释放预备） ── */
    case 'exploitation.movement': {
      const verdict = canMoveInPhase(
        { state: unit.mode, side: unit.side, activeSide },
        'exploitation',
      )
      if (!verdict.ok) return cannotParticipate(verdict.rule, verdict.reason)
      if (!isMobileUnit(modeProfileOf(unit)))
        return cannotParticipate('6.1b', '该算子没有 MA（设施类不可移动）')
      if (unit.movementEnded) return cannotParticipate('6.1', '该单位本轮移动已结束')
      return { ok: true, rule: '11.0a' }
    }
    case 'exploitation.barrage':
      if (!friendly) return cannotParticipate('11.0', '进击段由当前阶段玩家行动')
      if (!hasBarrageFactor(unit)) return cannotParticipate('10.0', '该单位没有轰炸值')
      return { ok: true, rule: '10.0' }
    case 'exploitation.combat':
      if (!friendly) return cannotParticipate('11.0', '进击段由当前阶段玩家行动')
      if (query.attackedUnitIds?.includes(unit.instanceId) === true)
        return cannotParticipate('9.1c', '该单位在本战斗环节已攻击过（一个单位只能攻击一次）')
      if (!canBeAttacker(unit))
        return cannotParticipate('11.0', '该单位不可攻击（无印刷战斗值或本轮已移动）')
      return { ok: true, rule: '11.0' }

    default:
      // 未登记的环节＝本批没做判定：**明确拒绝**并指向环节表，不静默放行
      return cannotParticipate('B7', `未登记的环节 ${segment}：请在 sop-segments.ts 里登记后补判定`)
  }
}

/**
 * **释放预备**是否可做（5.7b；E 反应 / G 进击两段专用）
 *
 * 与 `participatesIn` 分开：释放是"把预备标记摘掉"这个**动作**的资格，不是"这枚算子能不能被拾起"。
 * 判据直接走引擎的 `canReleaseReserve`（5.7b-A/B 的 MA 倍率也由它给）。
 */
export function canReleaseReserveNow(
  unit: ConsoleUnit,
  phase: GamePhase,
  activeSide: Side,
): ParticipationVerdict {
  if (phase !== 'reaction' && phase !== 'exploitation') {
    return cannotParticipate('5.7b', '只有反应 / 进击阶段能释放预备')
  }
  const verdict = canReleaseReserve({
    state: unit.mode,
    side: unit.side,
    activeSide,
    phase,
  })
  if (!verdict.ok) return cannotParticipate(verdict.rule, verdict.reason)
  return { ok: true, rule: verdict.rule }
}
