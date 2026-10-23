import { rulesConstants } from '@/data'
import type { Side } from '@/data'

/**
 * 模式（OCS 5.0 章）——基础模式 + 层叠标记、完整影响矩阵、模式切换合法性
 *
 * 条文出处均为**中文规则书**（CODE_SPEC §5 术语表以中文规则书为唯一来源）。
 * 分层口径：以下全部为**通规基线**；专规覆盖仅 2.3e 一处（见 canSwitchMode）。
 *
 * ## 一、结构：基础模式 + 至多一个层叠标记
 *
 * 5.5/5.6 把**战斗模式**与**移动模式**定义为算子的两个面（朝向），它们是一切数值的**基础**；
 * 5.7/5.8/5.9/5.10 的预备/战略/进击/DG 是**叠在基础之上的标记**，同一时刻至多一个。
 * 5.4a 说得很清楚：「一个带有模式标记的单位使用战斗或移动模式的**基础值**（称为『朝向』该面朝上的
 * 模式），但它**只处于标记所指的模式**中。」
 *
 * 由此得到两条贯穿全节的性质：
 *   ① **数值基准**永远取自**朝向那一面**（战斗面或移动面）；
 *   ② **模式效果**由**生效模式**（＝标记所指模式；无标记时即基础模式）决定。
 * 典型例子（规则书原文）：处于 DG 模式的单位即使朝向战斗面也**不是**战斗模式，
 * 因此永远不能铁路移动（铁路移动需要移动模式）。
 *
 * ## 二、主动 / 被动（5.3）
 *   - **主动模式**：战斗、移动、战略、预备 —— 玩家可在移动阶段主动选择（5.4）。
 *   - **被动模式**：DG、进击 —— 不可选择，只会因战斗、撤退、轰炸的结果「自然发生」，
 *     并**替代当前模式**；其标记只能在该玩家的清理阶段移除（5.4 / 5.9 / 5.10）。
 *
 * ## 三、完整影响矩阵（★ 逐格标条文；也是 MODE_MARKER_EFFECTS 的实现依据）
 *
 * | 生效模式 | 战斗值(攻) | 防御值 | 轰炸值 | 行动值 | 移动值 | 攻击 | 突袭 | 轰炸 | ZOC | 铁路/空运/海运 | 工程·轨距 | 与环工事堆叠 | 图外吃补 |
 * |---|---|---|---|---|---|---|---|---|---|---|---|---|---|
 * | 战斗模式（基础） | ×1 | ×1 | ×1 | ±0 | ×1 | 可 | 可 | 可 | **有**（5.5e） | 不可（5.5a） | 需战斗模式（5.5b） | 可 | 可 |
 * | 移动模式（基础） | ×1 | ×1 | ×1 | ±0 | ×1 | 可 | 可 | 可 | **无**（5.5e 反向） | **可**（5.6a） | 不可 | 可 | 可 |
 * | 预备·未释放 | 不可攻 | **×1/2**（5.7） | 不可轰 | ±0 | **×1/4**（5.7） | **否**（5.7） | **否**（5.7） | **否**（5.7） | **无**（4.5「其他模式」） | 不可（5.7e） | 不可 | **不可**（5.7g） | 可 |
 * | 预备·已释放 | ×1 | ×1 | ×1 | ±0 | 反应 ×1/2 进击 ×1（5.7b） | 可 | 可 | 可 | **由基础模式决定**（5.7b 已回战斗/移动模式） | 朝向移动面则可 | 需战斗模式 | 可 | 可 |
 * | 战略 | **0**（5.8） | **0** | 不可轰 | **0** | **×2**（5.8） | **否** | **否** | **否** | **无**（4.5） | 不可（5.8d） | 不可 | 可 | **不可**（5.8b） |
 * | 进击 | ×1 | ×1 | ×1 | ±0 | **×1/2**（5.9） | 可 | 可 | 可 | **保留基础模式**（5.9c） | 不可（由 5.6a 推导） | 需战斗模式 | 可 | 可 |
 * | DG | **×1/2**（5.10b-A） | ×1/2 | ×1/2 | **−1**（5.10b-B） | ×1/2 | 可 | **否**（5.10b-C） | 可 | **无**（4.5 + 5.4a） | 不可（5.10d） | 朝向战斗面则可（5.10e） | 可 | 可 |
 *
 * 说明几处**由规则推导而非原文直陈**的格子（已在代码注释里标注）：
 *   - 进击模式的「铁路/空运/海运」：5.6a 要求「采用移动模式」，而进击单位只处于进击模式（5.4a），
 *     故不可 —— 规则书未直接写这一句，属推导。
 *   - 进击模式的「工程/轨距」：5.5b 要求「必须在战斗模式下」，同理不可（推导）。
 *   - 预备释放后：标记已移除（5.7b），效果回到基础模式，只有移动值受 5.7b 的阶段限制。
 *
 * ## 四、★ ZOC 口径（用户裁定 2026-09-13）
 *   「**DG 模式无 ZOC**；**进击模式是例外**——单位是**战斗模式**（面）且附加了进击模式，**就有控制区**。」
 *   对应 4.5「战斗模式下的可攻击单位拥有 ZOC……其他模式下的单位没有 ZOC（例外：进击模式 5.9c）」
 *   与 5.9c「获得进击标记后，单位如果有 ZOC，则 ZOC 保持不变」：进击**不改变**基础模式带来的 ZOC，
 *   故 `zoc: 'fromBase'`；DG/预备/战略一律无 ZOC（`zoc: 'none'`）。
 */

/* ────────────────────────────── 常量（数值唯一来源 rules-constants.json） ────────────────────────────── */

/** 混乱：行动值修正（5.10b-B：行动值减 1） */
export const DG_AR_MOD = rulesConstants.modes.dgArMod
/** 混乱：战斗值倍率（5.10b-A：战斗值、轰炸值、移动值减半） */
export const DG_COMBAT_MULT = rulesConstants.modes.dgCombatMult
/** 混乱：移动值倍率 */
export const DG_MA_MULT = rulesConstants.modes.dgMaMult
/** 混乱：轰炸值倍率 */
export const DG_BARRAGE_MULT = rulesConstants.modes.dgBarrageMult
/** 战略模式：移动力 ×2（5.8） */
export const STRAT_MA_MULT = rulesConstants.modes.stratMaMult
/** 预备模式：防御 ×1/2（5.7：被攻击时以战斗值的一半进行防御） */
export const RESERVE_DEFEND_MULT = rulesConstants.modes.reserveDefendMult
/** 预备模式：常规移动阶段 ×1/4（5.7） */
export const RESERVE_MA_NORMAL_MULT = rulesConstants.modes.reserveMaNormalMult
/** 预备模式：反应阶段释放后 ×1/2（5.7b-B） */
export const RESERVE_MA_REACTION_MULT = rulesConstants.modes.reserveMaReactionMult
/** 预备模式：进击阶段释放后 ×1（5.7b-A：拥有完整的移动能力） */
export const RESERVE_MA_EXPLOIT_MULT = rulesConstants.modes.reserveMaExploitMult
/** 进击模式：移动 ×1/2（5.9） */
export const EXPLOIT_MA_MULT = rulesConstants.modes.exploitMaMult

/** 苏军可进入战略模式的起始日（**专规覆盖 2.3e**：8 月 1 日回合之前苏军不得进入战略模式） */
export const SOVIET_STRAT_MODE_FROM = rulesConstants.smolensk.sovietStratModeFrom

/* ────────────────────────────── 词表 ────────────────────────────── */

/**
 * 主动模式（5.3）
 *
 * 与 CODE_SPEC 术语表的「模式」取值一致，也与 state-types.UnitMode 一致（未新增顶层字段）。
 */
export type BaseMode = 'combat' | 'move' | 'reserve' | 'strat'

/** 主动模式全集（5.3；顺序照规则书列举：战斗、移动、战略、预备） */
export const VOLUNTARY_MODES = ['combat', 'move', 'strat', 'reserve'] as const

/** 被动模式（5.3：DG 与进击） */
export const INVOLUNTARY_MODES = ['dg', 'exploit'] as const

/** 被动模式类型 */
export type InvoluntaryMode = (typeof INVOLUNTARY_MODES)[number]

/**
 * 层叠模式标记（5.7–5.10）
 *
 * 叠在**基础模式**（战斗面/移动面）之上，同一时刻至多一个；被被动模式覆盖时其他标记会被移除（5.10）。
 */
export type ModeMarker = InvoluntaryMode | 'reserve' | 'strat'

/** 生效模式（5.4a）：带被动标记时被动模式替代当前模式 */
export type EffectiveMode = BaseMode | InvoluntaryMode

/** 朝向（5.4a）：朝上的那一面 —— 决定读取哪一面的基础值 */
export type Orientation = 'combat' | 'move'

/**
 * 移动环节阶段（2.2 流程表：C 移动阶段 / E 反应阶段 / G 进击阶段各有移动环节）
 *
 * 命名照流程表段落，与 state-types.GamePhase 的 movement/reaction/exploitation 对应。
 */
export type MovementSegmentPhase = 'movement' | 'reaction' | 'exploitation'

/**
 * 模式判定所需的单位类别（只为模式合法性服务，不复制单位库字段全集）
 *
 * 判据来源（5.5c / 5.6b / 5.7f / 5.8c / 6.1b）：
 *   - repl           补员单位：不能进入战斗模式、永远朝向移动模式（5.5c / 5.6b）
 *   - transportPoint 运输点数：同上，且不能进入预备（5.7f）、不能进入战略（5.8c）
 *   - organicTruck   编内卡车：运输点数里唯一可进入预备的例外（5.7f）
 *   - facility       无 MA 设施（SP / 港口 / 空军基地 / 环形工事）：不可移动或撤退（6.1b）
 *   - combat         其余战斗单位
 */
export type ModeUnitClass = 'combat' | 'repl' | 'transportPoint' | 'organicTruck' | 'facility'

/** 归类所需的单位最小视图（字段名照数据层 units-*.json） */
export interface ModeUnitProfile {
  /** 是否战斗单位（unitFamily === 'ground_combat' 的语义） */
  isCombat?: boolean
  /** 规则化分类标签（units-*.json 的 specialized，含 'replacement'） */
  specialized?: readonly string[]
  /** 非战斗单位类型（units-*.json 的 noncombatKind） */
  noncombatKind?: string | null
  /** 印制移动力（MA；0 或缺失 = 无 MA） */
  ma?: number | null
}

/* ────────────────────────────── 模式状态 ────────────────────────────── */

/** 模式状态（正交输入：基础模式/朝向 + 两个被动标记） */
export interface ModeState {
  /** 主动模式；`mode ∈ {combat, move}` 时同时表示朝向（基础模式） */
  mode: BaseMode
  /** 朝向：朝上的面（5.7a 预备可任选；5.8 战略必须移动面） */
  orientation: Orientation
  /** 混乱标记（被动，5.10） */
  dg: boolean
  /** 进击标记（被动，5.9） */
  exploit: boolean
  /**
   * 本阶段刚被释放的预备（5.7b）
   *
   * 释放会把单位变回战斗/移动模式（标记已移除），但该阶段内的 MA 受 5.7b 限制：
   * 反应阶段 ×1/2、进击阶段 ×1。故以「本阶段释放」这一时点事实表达。
   */
  releasedFromReserve?: boolean
}

/**
 * 模式矩阵查询所需的最小状态（`ModeState` 的**结构子集**）
 *
 * 战斗与轰炸路径只持有「模式 + DG + 是否本阶段释放的预备」（见 `BattleUnitView`），
 * 没有 `orientation` 与 `exploit`，故矩阵查询的入参必须收窄到这个子集——
 * 但**实现仍只有一条**（`activeMarker` → `canonicalMode`），不得为战斗路径另写一份优先级，
 * 否则「模式矩阵」会出现两套口径。
 *
 * 两个字段的取舍理由：
 *   - `orientation` 缺省按 `combat`：它只在「预备**已释放**」时被 `canonicalMode` 用来折回
 *     基础行，而两个基础行（战斗/移动）的数值倍率相同（`BASE_MODE_EFFECT`），故不影响结论；
 *   - `exploit` 在矩阵中的战斗/防御/轰炸倍率均为 1，与基础行等价，故战斗/轰炸路径可不传。
 *     ★ 若将来进击行改出非 1 的倍率，**必须**把它补进战斗路径的调用点。
 */
export type ModeMatrixInput = Pick<ModeState, 'mode'> & {
  dg?: boolean
  exploit?: boolean
  releasedFromReserve?: boolean
  orientation?: Orientation
}

/**
 * 基础模式（朝向）：数值基准所在的那一面（5.4a）
 *
 * `mode ∈ {combat, move}` 时模式本身就是朝向；预备/战略的朝向另由 `orientation` 给出。
 */
export function baseOrientation(state: ModeMatrixInput): Orientation {
  if (state.mode === 'combat' || state.mode === 'move') return state.mode
  return state.orientation ?? 'combat'
}

/** 生效模式（5.4a）：被动模式替代当前模式 */
export function effectiveMode(state: ModeState): EffectiveMode {
  if (state.dg) return 'dg'
  if (state.exploit) return 'exploit'
  return state.mode
}

/** 是否处于主动模式（5.3） */
export function isVoluntaryMode(mode: EffectiveMode): boolean {
  return (VOLUNTARY_MODES as readonly string[]).includes(mode)
}

/** 是否处于被动模式（5.3） */
export function isInvoluntaryMode(mode: EffectiveMode): boolean {
  return (INVOLUNTARY_MODES as readonly string[]).includes(mode)
}

/** 模式状态自相矛盾的类型（用于数据/命令校验） */
export type ModeIssue =
  /** 5.10b-C：DG 单位无法获得进击模式 → 两标记互斥 */
  | 'dgWithExploit'
  /** 5.10：DG 会「从该堆叠中移除其他所有模式标记」→ DG 与预备/战略不能并存 */
  | 'dgWithModeMarker'
  /** 5.9（保持当前朝向）＋ 5.7b（释放即移除预备标记）→ 进击与预备/战略不能并存 */
  | 'exploitWithModeMarker'
  /** 5.8：战略模式下单位的朝向必须是移动模式面 */
  | 'stratMustFaceMove'
  /** 5.5 / 5.6：战斗/移动模式就定义在对应那一面上，模式与朝向必须一致 */
  | 'baseModeFaceMismatch'
  /** 5.10c：运输点数不受 DG 影响，永远不会处于该模式 */
  | 'transportPointInDg'

/**
 * 校验模式状态（把「不可叠加」写成可判定的不变量）
 *
 * 规则依据：5.10「从该堆叠中移除其他所有模式标记」、5.10b-C「无法获得进击模式」、
 * 5.9「保持单位当前移动或战斗面朝向不变」、5.7b「释放即移除预备标记」、5.8「朝向必须是移动面」、
 * 5.10c「运输点数……永远不会处于该模式」。
 *
 * @param unitClass 可选；给出后可额外校验与单位类别相关的限制（5.10c）
 */
export function validateModeState(state: ModeState, unitClass?: ModeUnitClass): ModeIssue[] {
  const issues: ModeIssue[] = []
  if (state.dg && state.exploit) issues.push('dgWithExploit')
  if (state.dg && (state.mode === 'reserve' || state.mode === 'strat'))
    issues.push('dgWithModeMarker')
  if (state.exploit && (state.mode === 'reserve' || state.mode === 'strat'))
    issues.push('exploitWithModeMarker')
  if (state.mode === 'strat' && state.orientation !== 'move') issues.push('stratMustFaceMove')
  if (state.mode === 'combat' && state.orientation !== 'combat') issues.push('baseModeFaceMismatch')
  if (state.mode === 'move' && state.orientation !== 'move') issues.push('baseModeFaceMismatch')
  if (unitClass === 'transportPoint' && state.dg) issues.push('transportPointInDg')
  return issues
}

/* ────────────────────────────── 影响矩阵（机器可读版） ────────────────────────────── */

/** ZOC 取值：`fromBase` = 由基础模式决定（战斗面则有，5.5e/5.9c）；`none` = 一律无 */
export type ZocRule = 'fromBase' | 'none'

/** 铁路/空运/海运：`moveModeOnly` = 需处于移动模式（5.6a）；`none` = 不可 */
export type TransportRule = 'moveModeOnly' | 'none'

/** 工程与轨距转换（5.5b / 5.10e） */
export type EngineeringRule =
  /** 必须在战斗模式下（5.5b） */
  | 'combatModeOnly'
  /** 朝向为战斗面即可（5.10e 对 DG 的例外） */
  | 'combatOrientedOnly'
  /** 不可 */
  | 'none'

/** 单个模式的影响（矩阵的一行） */
export interface ModeEffect {
  /** 该行对应的生效模式；`base` 表示「基础模式本身（战斗/移动）」 */
  mode: EffectiveMode | 'base'
  /** 条文出处 */
  rule: string
  /** 战斗值（进攻）倍率 */
  combatMult: number
  /** 防御值倍率 */
  defenseMult: number
  /** 轰炸值倍率 */
  barrageMult: number
  /** 行动值修正（叠加在印值 AR 上） */
  arMod: number
  /** 移动值倍率（预备另有阶段规则，见 maMultiplier） */
  maMult: number
  /** 是否可攻击 */
  canAttack: boolean
  /** 是否可突袭 */
  canOverrun: boolean
  /** 是否可轰炸 */
  canBarrage: boolean
  /** ZOC 规则 */
  zoc: ZocRule
  /** 铁路/空运/海运规则 */
  transport: TransportRule
  /** 工程与轨距转换规则 */
  engineering: EngineeringRule
  /** 能否与环形工事堆叠（5.7g：仅预备禁止） */
  canStackWithHedgehog: boolean
  /** 是否必须在拥有追溯补给的格结束移动（5.8b / 12.6e：仅战略） */
  mustEndMoveInSupply: boolean
}

/** 基础模式本身（战斗模式 / 移动模式）——数值与能力全部照印值，只有 ZOC 与运输看朝向 */
export const BASE_MODE_EFFECT: ModeEffect = {
  mode: 'base',
  rule: '5.5/5.6/5.5a/5.5e/5.6a/5.5b',
  combatMult: 1,
  defenseMult: 1,
  barrageMult: 1,
  arMod: 0,
  maMult: 1,
  canAttack: true,
  canOverrun: true,
  canBarrage: true,
  zoc: 'fromBase',
  transport: 'moveModeOnly',
  engineering: 'combatModeOnly',
  canStackWithHedgehog: true,
  mustEndMoveInSupply: false,
}

/** 层叠标记模式的影响（预备 / 战略 / 进击 / DG）——矩阵的四个非基础行 */
export const MODE_MARKER_EFFECTS: Record<ModeMarker, ModeEffect> = {
  reserve: {
    mode: 'reserve',
    rule: '5.7 / 5.7e / 5.7g / 4.5',
    combatMult: 1, // 攻击值本身不改写，只是「不允许攻击」（见 canAttack）
    defenseMult: RESERVE_DEFEND_MULT,
    barrageMult: 1,
    arMod: 0,
    maMult: RESERVE_MA_NORMAL_MULT,
    canAttack: false,
    canOverrun: false,
    canBarrage: false,
    zoc: 'none',
    transport: 'none',
    engineering: 'none',
    canStackWithHedgehog: false,
    mustEndMoveInSupply: false,
  },
  strat: {
    mode: 'strat',
    rule: '5.8 / 5.8b / 5.8d',
    combatMult: 0, // 战斗值与行动值降为零（5.8）
    defenseMult: 0,
    barrageMult: 0,
    arMod: 0, // 行动值「降为零」由 resolveModeStats 直接置 0，故此处不加修正
    maMult: STRAT_MA_MULT,
    canAttack: false,
    canOverrun: false,
    canBarrage: false,
    zoc: 'none',
    transport: 'none',
    engineering: 'none',
    canStackWithHedgehog: true,
    mustEndMoveInSupply: true,
  },
  exploit: {
    mode: 'exploit',
    rule: '5.9 / 5.9c',
    combatMult: 1, // 战斗与轰炸值正常不变（5.9）
    defenseMult: 1,
    barrageMult: 1,
    arMod: 0,
    maMult: EXPLOIT_MA_MULT,
    canAttack: true,
    canOverrun: true,
    canBarrage: true,
    zoc: 'fromBase', // 5.9c：保留原有的 ZOC（★ 用户裁定：战斗面 + 进击 → 有控制区）
    transport: 'none', // 5.6a 要求移动模式，而进击单位只处于进击模式（5.4a）→ 推导
    engineering: 'combatModeOnly', // 5.5b 要求战斗模式 → 推导
    canStackWithHedgehog: true,
    mustEndMoveInSupply: false,
  },
  dg: {
    mode: 'dg',
    rule: '5.10b / 5.10d / 5.10e / 4.5',
    combatMult: DG_COMBAT_MULT,
    defenseMult: DG_COMBAT_MULT,
    barrageMult: DG_BARRAGE_MULT,
    arMod: DG_AR_MOD,
    maMult: DG_MA_MULT,
    canAttack: true, // 5.10b 未禁止攻击
    canOverrun: false, // 5.10b-C
    canBarrage: true,
    zoc: 'none', // ★ 用户裁定：DG 无 ZOC（4.5 + 5.4a）
    transport: 'none', // 5.10d
    engineering: 'combatOrientedOnly', // 5.10e：朝向战斗面时仍可施工/修铁/重建
    canStackWithHedgehog: true,
    mustEndMoveInSupply: false,
  },
}

/**
 * 查该状态生效的影响行（5.4a）
 *
 * - 无被动标记 → 基础模式行（战斗/移动）；
 * - 预备**已释放** → 标记已移除（5.7b），效果回到基础模式行（只有 MA 受 5.7b 限制）；
 * - 其余 → 对应标记行。
 */
export function modeEffect(state: ModeMatrixInput): ModeEffect {
  const marker = activeMarker(state)
  return marker === null ? BASE_MODE_EFFECT : MODE_MARKER_EFFECTS[marker]
}

/**
 * 规范模式（5.7b）——把「已释放的预备」折回其**朝向**那一面
 *
 * 5.7b：「只需移除它的预备标记：该单位现在即处于战斗模式或移动模式，取决于它的朝向（5.7a）。」
 * 故 `mode === 'reserve' && releasedFromReserve` 只是本引擎用来记录「本阶段刚释放」的临时表示，
 * **规范模式**应当是朝向那一面。凡按 UnitMode 口径判断「处于哪个模式」的地方
 * （ZOC 投射、突袭资格、铁路运输等）都必须先过这一层，否则会把已释放的预备误判成仍在预备模式。
 */
export function canonicalMode(state: ModeMatrixInput): BaseMode {
  if (state.mode === 'reserve' && state.releasedFromReserve === true)
    return state.orientation ?? 'combat'
  return state.mode
}

/**
 * 当前生效的层叠标记（5.4a / 5.7b）
 *
 * 预备**已释放**视同无标记 —— 5.7b：「只需移除它的预备标记：该单位现在即处于战斗模式或移动模式」。
 */
export function activeMarker(state: ModeMatrixInput): ModeMarker | null {
  if (state.dg) return 'dg'
  if (state.exploit) return 'exploit'
  const mode = canonicalMode(state)
  if (mode === 'reserve') return 'reserve'
  if (mode === 'strat') return 'strat'
  return null
}

/** 5.9 / 5.10：是否带有该层叠标记（供调用方少写判断） */
export function hasMarker(state: ModeState, marker: ModeMarker): boolean {
  return activeMarker(state) === marker
}

/** 5.5：是否**处于战斗模式**（基础模式为战斗面且没有层叠标记；预备释放后即回战斗/移动模式） */
export function isInCombatMode(state: ModeState): boolean {
  return activeMarker(state) === null && baseOrientation(state) === 'combat'
}

/** 5.6：是否**处于移动模式**（基础模式为移动面且没有层叠标记） */
export function isInMoveMode(state: ModeState): boolean {
  return activeMarker(state) === null && baseOrientation(state) === 'move'
}

/** 按生效模式取影响行（供 UI / 表驱动展示；`combat`/`move` 返回基础模式行） */
export function modeEffectsFor(mode: EffectiveMode): ModeEffect {
  if (mode === 'combat' || mode === 'move') return BASE_MODE_EFFECT
  return MODE_MARKER_EFFECTS[mode]
}

/* ────────────────────────────── 矩阵派生的判定 ────────────────────────────── */

/** 4.5 / 5.5e / 5.9c：是否投射 ZOC（进击保留基础模式；DG/预备/战略一律无） */
export function exertsZoc(state: ModeState): boolean {
  return modeEffect(state).zoc === 'fromBase' && baseOrientation(state) === 'combat'
}

/** 5.6a / 5.5a / 5.7e / 5.8d / 5.10d：能否使用铁路、空运、海运（需处于移动模式） */
export function canUseTransport(state: ModeState): boolean {
  return modeEffect(state).transport === 'moveModeOnly' && isInMoveMode(state)
}

/** 5.5b / 5.10e：能否转换轨距 */
export function canConvertGauge(state: ModeState): boolean {
  return canEngineer(state)
}

/** 5.5b / 5.10e：能否执行工程能力（架桥、修铁端、施工） */
export function canEngineer(state: ModeState): boolean {
  const rule = modeEffect(state).engineering
  if (rule === 'none') return false
  if (rule === 'combatModeOnly') return isInCombatMode(state)
  return baseOrientation(state) === 'combat' // DG：朝向战斗面即可（5.10e）
}

/** 5.7g：任何移动环节结束时，预备模式单位不可与环形工事堆叠 */
export function canStackWithHedgehog(state: ModeState): boolean {
  return modeEffect(state).canStackWithHedgehog
}

/** 5.8b / 12.6e：战略模式单位必须在当前拥有追溯补给的格内结束移动 */
export function mustEndMoveInSupply(state: ModeState): boolean {
  return modeEffect(state).mustEndMoveInSupply
}

/* ────────────────────────────── MA 与数值 ────────────────────────────── */

/**
 * MA 倍率（5.7 / 5.8 / 5.9 / 5.10b-A；**不取整**，6.1h）
 *
 * 组合规则：同一时刻只可能有一个模式标记生效（5.10 移除其他标记），故倍率不叠加；
 * 唯有预备的倍率随阶段与「是否已释放」变化（5.7 / 5.7b），故在此单独展开。
 *
 * 优先级（自高到低）：混乱 → 战略 → 预备未释放 → 进击 → 刚释放的预备 → 基础模式。
 * 「进击」排在「刚释放的预备」之前：进击阶段是**先移动后战斗**（2.2 流程表 G 段），
 * 单位在同一阶段既移动又拿到进击标记的情形不存在，但一旦带进击标记就按 5.9「使用其 MA 的一半移动」。
 */
export function maMultiplier(state: ModeState, phase: MovementSegmentPhase): number {
  const marker = activeMarker(state)
  // 混乱（5.10b-A）：移动值减半；DG 与预备/战略/进击互斥，故不再乘其他倍率
  if (marker === 'dg') return DG_MA_MULT
  // 战略（5.8）：×2
  if (marker === 'strat') return STRAT_MA_MULT
  // 预备（5.7）：未释放只能在本方移动阶段动 1/4；反应/进击阶段须先释放（5.7b）
  if (marker === 'reserve') return phase === 'movement' ? RESERVE_MA_NORMAL_MULT : 0
  // 进击（5.9）：×1/2
  if (marker === 'exploit') return EXPLOIT_MA_MULT
  // 刚释放的预备（5.7b）：标记已移除、回到基础模式，但本阶段 MA 受 5.7b 限制
  if (state.releasedFromReserve === true) {
    if (phase === 'reaction') return RESERVE_MA_REACTION_MULT
    if (phase === 'exploitation') return RESERVE_MA_EXPLOIT_MULT
  }
  return BASE_MODE_EFFECT.maMult
}

/** 单位基础印值（某一面的原始值） */
export interface UnitRawStats {
  attack: number
  ar: number
  ma: number
  barrage?: number
}

/** 按模式改写后的数值与合法性 */
export interface ModeAdjustedStats {
  /** 进攻时使用的战斗值（战略模式为 0，5.8） */
  attack: number
  /** 防御时使用的战斗值（预备未释放减半，5.7；战略模式为 0，5.8） */
  defense: number
  /** 行动值（DG 减 1，5.10b-B；战略模式为 0，5.8） */
  ar: number
  /** 当前可用 MA（= 原始 MA × maMultiplier，**未取整**，6.1h） */
  ma: number
  /** 轰炸值（DG 减半，5.10b-A；战略模式不可轰炸，5.8） */
  barrage?: number
  /** 能否攻击（5.7：预备被释放前不能攻击；5.8：战略不能攻击） */
  canAttack: boolean
  /** 能否轰炸（同上） */
  canBarrage: boolean
  /** 能否突袭（8.1 需战斗/移动/进击模式；5.10b-C DG 不能突袭） */
  canOverrun: boolean
  /** 是否投射 ZOC（4.5 + 5.5e + 5.9c；★ 用户裁定的 DG 口径见文件头） */
  exertsZoc: boolean
  /** 是否混乱（供 UI 标记） */
  disorganized: boolean
  /** 本阶段生效的 MA 倍率（未取整；供 UI 显示 1/4、1/2、×2 等） */
  maMultiplier: number
  /** 生效模式（5.4a） */
  effectiveMode: EffectiveMode
}

/**
 * 按模式改写单位数值（5.5–5.10）
 *
 * 一律以**朝向那一面的原始值**为基准（5.4a），再按影响矩阵施加倍率/修正。
 * 减半一律不取整（6.1h）；行动值减 1 按规则书字面**不做下限截断**
 * （规则只写「行动值减 1」，未规定不得为负；若需截断应由用户裁定）。
 */
export function resolveModeStats(
  raw: UnitRawStats,
  state: ModeState,
  phase: MovementSegmentPhase,
): ModeAdjustedStats {
  const effect = modeEffect(state)
  const multiplier = maMultiplier(state, phase)
  const mode = effectiveMode(state)

  const attack = raw.attack * effect.combatMult
  const barrage = raw.barrage === undefined ? undefined : raw.barrage * effect.barrageMult
  // 战略模式「战斗值与行动值均降为零」（5.8）：用直接置零表达，避免倍率相乘的歧义
  const isStrat = mode === 'strat' || effect.mode === 'strat'

  return {
    attack: isStrat ? 0 : attack,
    defense: isStrat ? 0 : raw.attack * effect.defenseMult,
    ar: isStrat ? 0 : raw.ar + effect.arMod,
    ma: raw.ma * multiplier,
    barrage: isStrat ? undefined : barrage,
    canAttack: effect.canAttack,
    canBarrage: effect.canBarrage,
    canOverrun: effect.canOverrun,
    exertsZoc: exertsZoc(state),
    disorganized: state.dg,
    maMultiplier: multiplier,
    effectiveMode: mode,
  }
}

/* ────────────────────────────── 阶段与模式可动性 ────────────────────────────── */

/** 阶段可动性判定输入 */
export interface PhaseMoveInput {
  state: ModeState
  /** 该单位所属方 */
  side: Side
  /** 当前行动方（2.2 阶段玩家） */
  activeSide: Side
}

/**
 * 该单位在当前移动环节能否移动（6.0 / 6.3a / 7.0a / 11.0a）
 *
 *  - C 移动阶段：阶段玩家可动其任意地面单位（6.0）
 *  - E 反应阶段：**只有非阶段玩家**的单位可动（6.3a），且**只有被释放的预备单位**（7.0a）
 *  - G 进击阶段：只有阶段玩家的**进击模式单位**（11.0a）与被释放的预备单位（11.0a/5.7b-A）
 */
export function canMoveInPhase(
  input: PhaseMoveInput,
  phase: MovementSegmentPhase,
): { ok: true } | { ok: false; rule: string; reason: string } {
  const { state, side, activeSide } = input
  if (phase === 'movement') {
    if (side !== activeSide)
      return { ok: false, rule: '6.0', reason: '移动阶段只能移动当前阶段玩家的地面单位' }
    return { ok: true }
  }
  if (phase === 'reaction') {
    // 6.3a：只有非阶段玩家的单位才能在反应阶段中移动
    if (side === activeSide)
      return { ok: false, rule: '6.3a', reason: '反应阶段只能移动非阶段玩家的单位' }
    // 7.0a：此阶段唯一可以行动的地面单位，是非阶段玩家释放的预备模式单位
    if (state.releasedFromReserve !== true)
      return { ok: false, rule: '7.0a', reason: '反应阶段只有被释放的预备单位可以移动' }
    return { ok: true }
  }
  // 进击阶段（11.0a）
  if (side !== activeSide)
    return { ok: false, rule: '11.0a', reason: '进击阶段只能移动当前阶段玩家的单位' }
  if (!state.exploit && state.releasedFromReserve !== true)
    return { ok: false, rule: '11.0a', reason: '进击阶段只有进击模式单位或被释放的预备可以移动' }
  return { ok: true }
}

/* ────────────────────────────── 释放预备（5.7b） ────────────────────────────── */

/** 释放预备的裁定输入（5.7b） */
export interface ReserveReleaseInput {
  /** 待释放单位的模式状态 */
  state: ModeState
  /** 该单位所属方 */
  side: Side
  /** 当前阶段玩家 */
  activeSide: Side
  /** 当前移动环节阶段（5.7b：只有反应 / 进击两个阶段可释放） */
  phase: MovementSegmentPhase
}

/** 释放预备的裁定结果（成功时给出释放后的模式状态与该阶段的 MA 倍率） */
export type ReserveReleaseVerdict =
  | { ok: true; rule: string; mode: ModeState; maMult: number }
  | { ok: false; rule: string; reason: string }

/**
 * 能否释放预备、以及释放后的状态（通规 5.7b）
 *
 * 条文：5.7b「被玩家『释放』的预备模式单位可在**该玩家的反应阶段或进击阶段**使用。要释放一个
 *   单位时，**只需移除它的预备标记**：该单位现在即处于战斗模式或移动模式，取决于它的朝向（5.7a）。
 *   玩家可以先释放一个单位并让其移动与突袭，然后再决定是否释放其他预备单位。」
 *   - 5.7b-A 进击阶段：拥有完整的移动 / 轰炸 / 战斗能力（MA ×1）；
 *   - 5.7b-B 反应阶段：以**一半的 MA** 移动（MA ×1/2）。
 *
 * 行动者身份同 6.3a / 11.0a：反应阶段是**非阶段玩家**的回合，进击阶段是**阶段玩家**的回合，
 * 故各自只能释放**自己的**预备。移动阶段不可释放（5.4 明文「在移动阶段之外，不允许进行其他
 * 形式的主动模式切换」，而释放属反应 / 进击阶段的专门动作）。
 *
 * 释放不产生新标记（是**摘掉**标记），故沿用本引擎的既有表示：保留 `mode: 'reserve'` 并把
 * `releasedFromReserve` 置真 —— `canonicalMode` / `activeMarker` 会把它折回朝向那一面（5.7b）。
 */
export function canReleaseReserve(input: ReserveReleaseInput): ReserveReleaseVerdict {
  const { state, side, activeSide, phase } = input

  // 5.7b：只有反应 / 进击两个阶段可释放，且各自只能释放本方
  if (phase === 'reaction') {
    if (side === activeSide)
      return { ok: false, rule: '6.3a', reason: '反应阶段只能由非阶段玩家释放自己的预备' }
  } else if (phase === 'exploitation') {
    if (side !== activeSide)
      return { ok: false, rule: '11.0a', reason: '进击阶段只能由阶段玩家释放自己的预备' }
  } else {
    return { ok: false, rule: '5.7b', reason: `${phase} 阶段不能释放预备（只在反应 / 进击阶段）` }
  }

  // 须确为预备模式，且本阶段尚未释放
  if (state.mode !== 'reserve')
    return { ok: false, rule: '5.7b', reason: '该单位不处于预备模式，无需释放' }
  if (state.releasedFromReserve === true)
    return { ok: false, rule: '5.7b', reason: '该单位本阶段已经释放过了' }

  // 5.7b：释放＝移除预备标记 → 回朝向那一面；该阶段 MA 受 5.7b-A/B 限制
  const mode: ModeState = { ...state, releasedFromReserve: true }
  return { ok: true, rule: '5.7b', mode, maMult: maMultiplier(mode, phase) }
}

/**
 * 清理「本阶段刚释放」的时点事实（5.7b）
 *
 * `releasedFromReserve` 记录的是「**本阶段**刚被释放」——换阶段即失效：释放本身已把预备标记
 * 永久摘掉（5.7b），此后该单位就是普通的战斗 / 移动模式单位，**不得**再凭这个陈旧旗标进入
 * 反应 / 进击阶段（否则 6.3a / 7.0a / 11.0a 的移动者身份判定会被绕过）。
 */
export function clearReleasedFromReserve(state: ModeState): ModeState {
  if (state.releasedFromReserve !== true) return state
  return { ...state, releasedFromReserve: false }
}

/* ────────────────────────────── 不可移动状态 ────────────────────────────── */

/** 6.1b：SP、港口、空军基地、环形工事没有 MA，因此不可移动或撤退 */
export function isMobileUnit(profile: ModeUnitProfile): boolean {
  if (modeUnitClass(profile) === 'facility') return false
  const ma = profile.ma ?? 0
  return ma > 0
}

/** 按印值/类别归类模式单位（见 ModeUnitClass 注释） */
export function modeUnitClass(profile: ModeUnitProfile): ModeUnitClass {
  const kind = profile.noncombatKind ?? null
  if (kind === 'sp' || kind === 'air_base' || kind === 'hedgehog' || kind === 'port')
    return 'facility'
  if (kind === 'organic_truck') return 'organicTruck'
  if (kind === 'transport_point' || kind === 'supply_extender') return 'transportPoint'
  if ((profile.specialized ?? []).includes('replacement')) return 'repl'
  return 'combat'
}

/* ────────────────────────────── 被动模式的施加 ────────────────────────────── */

/** 承受 DG 结果后应保留的模式标记（5.10 / 5.10c） */
export type MarkersAfterDg =
  /** 5.10：从该堆叠中移除其他所有模式标记 → 只剩 DG */
  | 'dgOnly'
  /** 5.10c：编内卡车即使处于预备模式，该格承受 DG 时也只是**失去预备标记**（自己不受 DG 影响） */
  | 'loseReserveMarkerOnly'

/**
 * 5.10 / 5.10c：该单位承受 DG 结果后模式标记怎么变
 *
 * - 一般单位（含预备/战略/进击单位）：**移除其他所有模式标记**，只留 DG（5.10）——
 *   这正是「被动模式会替代当前的模式」的落地，也解释了为何 DG 与预备/战略/进击不可叠加。
 * - 运输点数不受 DG 影响（5.10c）；其中处于预备模式的**编内卡车**失去预备标记。
 */
export function markersAfterDg(unit: {
  unitClass: ModeUnitClass
  state: ModeState
}): MarkersAfterDg {
  if (unit.unitClass === 'transportPoint') return 'loseReserveMarkerOnly'
  return 'dgOnly'
}

/* ────────────────────────────── 模式切换合法性 ────────────────────────────── */

/** 模式切换请求 */
export interface ModeSwitchRequest {
  /** 目标模式（只能是主动模式；被动模式不可被选择，5.4） */
  to: BaseMode
  /** 目标朝向（5.7a 预备可任选；战斗/移动/战略受 5.5/5.6/5.8 约束） */
  orientation: Orientation
  /** 所在格是否处于**未被抵消**的敌方 ZOC（4.5b 抵消后即不算） */
  inEnemyZoc: boolean
  unitClass: ModeUnitClass
  side: Side
  /** 当前阶段（模式切换只允许在移动阶段，5.4） */
  phase: MovementSegmentPhase
  /** 当前日期（ISO，专规 2.3e 用）；缺省表示不判时点类专规限制 */
  date?: string
}

/** 模式切换判定结果 */
export type ModeSwitchResult = { ok: true } | { ok: false; rule: string; reason: string }

/**
 * 能否切换主动模式（5.4 + 4.5a-I/J + 5.5c + 5.7c/5.7f + 5.8/5.8a/5.8c + 专规 2.3e）
 *
 * 5.4：处于四种主动模式的单位可在**移动阶段**中、在**每个单位或堆叠开始移动时**切换模式；
 *      在移动阶段之外不允许其他形式的主动模式切换；**模式切换不消耗 MP**。
 * （本函数只判「能不能切」，切换发生在移动开始时这一时序由移动模块调用点保证。）
 */
export function canSwitchMode(req: ModeSwitchRequest): ModeSwitchResult {
  // 5.4：模式切换只发生在移动阶段
  if (req.phase !== 'movement')
    return { ok: false, rule: '5.4', reason: '主动模式切换只能在本方移动阶段进行' }

  // 5.8：战略模式朝向必须是移动面
  if (req.to === 'strat' && req.orientation !== 'move')
    return { ok: false, rule: '5.8', reason: '战略模式下单位朝向必须是移动模式面' }

  // 5.5 / 5.6：战斗模式与移动模式各定义在对应面上
  if (req.to === 'combat' && req.orientation !== 'combat')
    return { ok: false, rule: '5.5', reason: '进入战斗模式必须朝向战斗面' }
  if (req.to === 'move' && req.orientation !== 'move')
    return { ok: false, rule: '5.6', reason: '进入移动模式必须朝向移动面' }

  // 6.1b：无 MA 设施（SP/港口/空军基地/环形工事）不可移动，也不参与模式切换
  if (req.unitClass === 'facility')
    return { ok: false, rule: '6.1b', reason: 'SP/港口/空军基地/环形工事没有 MA，不可移动或撤退' }

  // 5.5c：补员单位和运输点数不能进入战斗模式
  if (req.to === 'combat' && (req.unitClass === 'repl' || req.unitClass === 'transportPoint'))
    return { ok: false, rule: '5.5c', reason: '补员单位与运输点数不能进入战斗模式' }

  // 5.7f：运输点数不允许进入预备模式（例外：编内卡车）
  if (req.to === 'reserve' && req.unitClass === 'transportPoint')
    return { ok: false, rule: '5.7f', reason: '运输点数不允许进入预备模式（编内卡车除外）' }

  // 5.8c：运输点数不能进入战略模式
  if (req.to === 'strat' && req.unitClass === 'transportPoint')
    return { ok: false, rule: '5.8c', reason: '运输点数不能进入战略模式' }

  // 4.5a-I / 5.7c：单位不可以在敌方 ZOC 内进入预备模式
  if (req.to === 'reserve' && req.inEnemyZoc)
    return { ok: false, rule: '5.7c', reason: '不可在敌方 ZOC 内进入预备模式（4.5a-I）' }

  // 4.5a-J / 5.8a：单位不可以在敌方 ZOC 内进入战略模式
  if (req.to === 'strat' && req.inEnemyZoc)
    return { ok: false, rule: '5.8a', reason: '不可在敌方 ZOC 内进入战略模式（4.5a-J）' }

  // 专规 2.3e（覆盖通规 5.8）：8 月 1 日回合之前苏军不得进入战略模式
  if (req.to === 'strat' && req.side === 'soviet' && req.date !== undefined) {
    if (req.date < SOVIET_STRAT_MODE_FROM)
      return {
        ok: false,
        rule: '专规 2.3e',
        reason: `8 月 1 日回合（${SOVIET_STRAT_MODE_FROM}）之前苏军不得进入战略模式`,
      }
  }

  return { ok: true }
}

/**
 * 模式切换是否消耗 MP（5.4：「模式的切换不消耗 MP」）
 *
 * 单列成函数是为了让移动模块显式引用条文，避免以后被误加费用。
 */
export function modeSwitchCost(): number {
  return 0
}

/** 「只改朝向、不改模式」的判定输入 */
export interface OrientationFlipInput {
  state: ModeState
  /** 当前阶段（5.4 末句与 5.7a 都只允许在移动阶段改朝向） */
  phase: MovementSegmentPhase
  /**
   * 该单位是否在**本回合内**刚进入预备（5.7a）
   *
   * 5.7a：「该朝向（朝向战斗模式或移动模式）在该玩家的**下一个移动阶段之前**无法再切换。」
   * 引擎不自行记录「何时进入预备」，故由调用方给出这一时点事实。
   */
  enteredReserveThisTurn?: boolean
}

/**
 * 能否「只改朝向而不改变模式」（5.4 末句 / 5.7a）
 *
 * 这是模式小节里最容易被漏掉的一条：**带标记的单位改朝向 ≠ 切换模式**。
 *   - **DG**（5.4 末句）：「在移动阶段中，处于 DG 模式的单位可以改变朝向，即在算子的战斗面和
 *     移动面之间切换朝向」——它**仍处于 DG 模式**，只是换个面来读基础值。
 *   - **预备**（5.7a）：进入预备时可翻任意面；该朝向到**下一个移动阶段**前不能再切换，
 *     即到了下一个移动阶段（且非本回合刚进入）就可以再翻。
 *   - **战略**（5.8）：朝向必须是移动面，故不可翻。
 *   - **战斗/移动模式**（5.5/5.6）：朝向就是模式本身，改朝向＝换模式，请走 canSwitchMode。
 */
export function canFlipOrientation(
  input: OrientationFlipInput,
): { ok: true; rule: string } | { ok: false; rule: string; reason: string } {
  const { state, phase } = input
  // 5.4 末句 / 5.7a：改朝向只发生在移动阶段
  if (phase !== 'movement')
    return { ok: false, rule: '5.4', reason: '改变朝向只能在本方移动阶段进行' }

  const marker = activeMarker(state)
  if (marker === 'dg') return { ok: true, rule: '5.4' }
  if (marker === 'reserve') {
    if (input.enteredReserveThisTurn === true)
      return {
        ok: false,
        rule: '5.7a',
        reason: '本回合刚进入预备，该朝向在下一个移动阶段之前无法再切换',
      }
    return { ok: true, rule: '5.7a' }
  }
  if (marker === 'strat')
    return { ok: false, rule: '5.8', reason: '战略模式下单位朝向必须是移动模式面，不可更改' }
  return {
    ok: false,
    rule: '5.5/5.6',
    reason: '战斗/移动模式下朝向即模式本身，改朝向请用模式切换（canSwitchMode）',
  }
}

/**
 * 翻开朝向（5.4 末句 / 5.7a）——只改朝向，保持模式状态不变
 *
 * 供命令层在 canFlipOrientation 通过后调用；`mode ∈ {combat, move}` 时模式兼作朝向，
 * 故该两模式下必须同步改 `mode`（但那属于「换模式」，应走 canSwitchMode，本函数不处理）。
 */
export function flipOrientation(state: ModeState): ModeState {
  const orientation: Orientation = state.orientation === 'combat' ? 'move' : 'combat'
  if (state.mode === 'combat' || state.mode === 'move') {
    return { ...state, mode: orientation, orientation }
  }
  return { ...state, orientation }
}
