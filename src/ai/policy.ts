/**
 * B3：基线 AI 的**纯决策层**
 *
 * 纪律（硬约束）：
 * - 本文件只吃**只读快照**、只吐一个 `AiAction`，不引用任何 store、不掷骰、不用 `Math.random`；
 * - 合法性判据一律来自快照里的既有投影（`groupReachable` / `legalActionsView` / `barrageUnitChoices` /
 *   `combatRequirement` / `spDumps` …），本文件**不新增规则判据**；
 * - tie-break 只用稳定键（格号、型号；`instanceId` 含时间戳**不能**当先后判据）——
 *   快照里所有「需要挑一个」的列表都由驱动按「格号 + 型号」排好，本文件不再重排。
 */
import { hexDistance } from '@/engine/hex-geometry'

export type AiSide = 'axis' | 'soviet'

/**
 * B4：**控制方**（界面下拉的唯一取值域）
 *
 * `off`＝不接管；`axis`/`soviet`＝只替一方行动；`both`＝双 AI 对打（B3 行为）。
 */
export type AiControlMode = 'off' | 'axis' | 'soviet' | 'both'

export function aiControlsSide(mode: AiControlMode, side: AiSide): boolean {
  return mode === 'both' || (mode !== 'off' && mode === side)
}

/** 面向玩家的方名（等待文案用） */
export function sideLabelOf(side: AiSide): string {
  return side === 'axis' ? '轴心国' : '苏联'
}

export interface AiHex {
  col: number
  row: number
}

export const hexKeyOf = (hex: AiHex): string => `${String(hex.col)}.${String(hex.row)}`

/** 稳定排序：先按格号，再按 id（绝不按传入顺序） */
export const compareHex = (a: AiHex, b: AiHex): number => a.col - b.col || a.row - b.row

export interface AiAirSnapshot {
  /** 已宣布、尚未收束的任务（需按 14.2f C→G 继续推进） */
  inProgress: boolean
  /** 本回合本阶段是否已经飞过任务（14.1c：一架一阶段一次；回归驱动每阶段只飞一次） */
  flownThisPhase: boolean
  /** 14.7d 低空扫射按原文只在**移动阶段**宣布（进击阶段的轰炸走 G 进击轰炸，不由本策略发起） */
  inMovementPhase: boolean
  /** 2.2a：天气受限时不飞低空扫射（与 `canHipShoot` 同一口径，不放宽天气） */
  weatherNormal: boolean
  /** 本环节要打的敌方守格（稳定序第一个） */
  target: AiHex | null
  /** 参与本次任务的飞机（稳定序第一个） */
  aircraftId: string | null
}

export interface AiMoveSnapshot {
  /** 移动交互仍在进行（且未 finished） */
  active: boolean
  /** 本次移动已经落过子（一个单位只落一次，落子后直接结束） */
  hasStepped: boolean
  selectedIds: readonly string[]
  reachableHexes: readonly AiHex[]
  /** 本环节已尝试开拔的单位（稳定序） */
  triedUnits: readonly string[]
  /** 本环节已尝试落子的格 */
  triedTargets: readonly string[]
  /** 本环节可参与移动的单位（已过滤 movementEnded / 敌方） */
  candidates: readonly string[]
  enemyHexes: readonly AiHex[]
}

export interface AiBarrageSnapshot {
  state: { step: string; kind: string; targetHex: AiHex | null; costT: number } | null
  choices: readonly { unitId: string; disabled: boolean }[]
  selectedUnitIds: readonly string[]
  targetHex: AiHex | null
  supplyDumpIds: readonly string[]
  /** 本环节已尝试过的目标格（失败后换下一个） */
  triedTargets: readonly string[]
  enemyHexes: readonly AiHex[]
  outcomeStepLosses: number
  lossTargets: readonly { unitId: string; steps: number }[]
}

export interface AiCombatSnapshot {
  state: { step: string; finished: boolean; declaredAttackerArUnitId?: string } | null
  defenderHex: AiHex | null
  adjacentDefenderHexes: readonly AiHex[]
  attackerDumpIds: readonly string[]
  defenderDumpIds: readonly string[]
  /** 9.5/12.4：两侧已确认的付款（AI 只答自己控制的一方） */
  attackerSupplyConfirmed: boolean
  defenderSupplyConfirmed: boolean
  requirement: { side: 'attacker' | 'defender'; losses: number; options: number } | null
  retreatPlans: readonly {
    unitId: string
    /** 该撤退单位所属阵营角色（9.12：攻方先撤、守方后撤） */
    role: 'attacker' | 'defender'
    chosen: AiHex | null
    destinations: readonly {
      hex: AiHex
      forcedDestruction: boolean
      inEnemyZoc: boolean
      path: readonly AiHex[]
    }[]
  }[]
  triedDefenderHexes: readonly string[]
}

export interface AiSupplySnapshot {
  planLoaded: boolean
  recoverySettled: boolean
  feedingSettled: boolean
  duties: readonly {
    key: string
    applied: boolean
    rolled: boolean
    needAllocation: boolean
    lossesKind: string
    lossesSteps: number
    units: readonly { id: string; steps: number }[]
  }[]
}

/**
 * B4：每个「需要决定」的动作归属哪一方（布尔＝该方是否由 AI 控制）
 *
 * 换算全在 driver 里做，事实只来自既有投影；策略层只按布尔值放行或停下。
 */
export interface AiControlSnapshot {
  /** 当前行动/结算方（`activeSide`） */
  activeSide: boolean
  /** 盘面提问的应答方（`session.question.responder`） */
  responder: boolean
  /** 战斗中攻方（＝activeSide） */
  attacker: boolean
  /** 战斗中守方（`combatDefenderSide`） */
  defender: boolean
  /** 战斗 `losses`/`options` 的当前结算方（`combatRequirement.side`） */
  requirement: boolean
  /** 未选齐的撤退计划所涉各方 */
  retreat: boolean
  /** 初设当前光标方（`setupSideCursor`） */
  setup: boolean
}

/** 初设阶段：待落位的抽签西移编队（ch10；缺落点时由 AI 按候选补一个） */
export interface AiSetupSnapshot {
  /**
   * 初设仍在进行（会话尚未建立）
   *
   * 两段式下「确认初设」先收束初设窗、但不建会话（等抽签），此时
   * `initialSetupInProgress` 已是 false —— 故这里用「会话未建 + 初设窗/抽签/待落位任一在」判。
   */
  active: boolean
  /** 分方游标仍停在某一方（该方自由项与飞机还要落） */
  cursorActive: boolean
  /** 还有待落位的自由项 / 飞机（枚数） */
  remaining: number
  /** 「抽取编队」入口此刻可见（两段式第二段） */
  drawVisible: boolean
  /** 抽签后仍缺落点的西移编队（稳定序） */
  shiftFormationIds: readonly string[]
}

/** A 飞机整备：一个可整备基地的确定性候选 */
export interface AiRefitBase {
  baseId: string
  hex: AiHex
  /** 该基地全部非激活飞机（稳定序；一步整备完，别一枚一枚来） */
  aircraftIds: readonly string[]
  /** 第一座可付款补给站（稳定序） */
  dumpId: string
}

/** B 增援：到货落位的一条（未投放、未试过） */
export interface AiArrivalEntry {
  index: number
  /** 地图落点（候选稳定序第一个；null ⇒ 只能进图外空军盒） */
  hex: AiHex | null
  /** 该条目可放图外空军盒（1.4a） */
  airBox: boolean
}

/** B 增援：到货 SP（免费铁运 + 余额）与补给列车 */
export interface AiReinSupplySnapshot {
  /** 1.6b 补给表当日到货 SP */
  sp: number
  /** 已勾选的免费铁运城市格 */
  picked: readonly AiHex[]
  /** 可勾选的免费铁运城市格（稳定序） */
  cityCandidates: readonly AiHex[]
  /** 余额的落点（图边补给源格；无则 null） */
  edgeHex: AiHex | null
  /** 落点计划此刻是否已可落账（`freeRailPlan !== null`） */
  planReady: boolean
  /** 3.4b：德军到货须逐格选归属再落账 */
  panzerGroupRulesOn: boolean
  /** 3.4b：按格合并后的归属目标（稳定序） */
  groupTargets: readonly {
    hexText: string
    sp: number
    group: 'guderian' | 'hoth' | null
  }[]
  /** 3.6 补给列车：待落的 2 SP */
  trainPending: boolean
  /** 3.6：可卸货铁路格（稳定序） */
  trainHexes: readonly AiHex[]
  /** 3.6：3.4b 生效且尚未选归属 */
  trainGroupRequired: boolean
}

/**
 * 批 2：C 段支线（移动环节里除「逐格移动」之外的可用动作）
 *
 * 每个字段都只留「一个」经既有投影筛过的候选：策略层只按固定顺序取用，
 * 不在决策里重算规则，也不会把入口必然拒绝的组合发出去。
 */
export interface AiMoveBranchSnapshot {
  /** 5.4：换模式（strat→move 以便开拔；已结束且邻敌的 move→combat 转入战斗姿态） */
  modeSwitch: { unitId: string; mode: 'move' | 'combat' } | null
  /** 8.0：移动中可突袭、且本环节未试过的相邻敌格（稳定序） */
  overrunTargets: readonly AiHex[]
  /** 13.3e：单位铁路运输一条（已排除无路 / 不划算者） */
  railUnit: { unitId: string; toHex: AiHex } | null
  /** 13.3e：SP 铁路货运一条 */
  railSp: { dumpId: string; amount: number; toHex: AiHex } | null
  /** 13.2f：装卸一条（load 优先，卸货只在同格无补给站时做，避免装上又卸下） */
  transport: { pointId: string; mode: 'load' | 'unload'; amount: number } | null
  /** 专规 3.5：建造标记一条（只在轴方、且本阶段还没有任何单位移动之前） */
  constructionMarker: { marker: 'bridge' | 'airStrip'; hex: AiHex } | null
  /** 13.3f：本阶段刚走入非本方轨距格的铁路修理单位 */
  gauge: { unitId: string; hex: AiHex } | null
}

/** B 增援：重建 / 整编候选（一次只给一个，避免每步全量预演） */
export interface AiRebuildSnapshot {
  unitId: string
  kind: 'airBox' | 'dead' | 'onMap'
  /** 死亡堆重建的合法落点（`kind==='dead'` 时必有） */
  hex: AiHex | null
  consolidate: { keepId: string; removeId: string } | null
}

export interface AiSnapshot {
  turn: number
  phase: string
  segment: string
  segmentStepIndex: number
  activeSide: AiSide
  /** 当前战斗的守方（仅战斗相关动作使用） */
  defenderSide: AiSide
  terminated: boolean
  awaitingOptionIds: readonly string[]
  /** 盘面提问的应答方与题面（无提问时 responder 为 null） */
  awaitingResponder: AiSide | null
  awaitingPrompt: string
  /** 初设阶段（批 1） */
  setup: AiSetupSnapshot
  /** A 整备候选（批 1） */
  refit: { bases: readonly AiRefitBase[] }
  /** B 增援（批 1） */
  rein: {
    arrival: { removalsPending: boolean; entries: readonly AiArrivalEntry[] }
    supply: AiReinSupplySnapshot
    rebuild: AiRebuildSnapshot | null
  }
  /**
   * 4.8a：超堆叠待处理（13.6 到场豁免由引擎在增援阶段判掉，故这里只会在须解决的阶段出现）
   *
   * `active` 仅当**所有**超堆叠格都属于当前行动方（否则勾选提交会因别格未处理被整批拒绝）。
   */
  overstack: { active: boolean }
  /** 初设还剩多少枚待落位（自由项 + 飞机） */
  setupRemaining: number
  /** B4：控制权（见 `AiControlSnapshot`） */
  control: AiControlSnapshot
  setupInProgress: boolean
  /** 会话停在回合准备（天气 / 先手判定，2.2 / 2.3）——此时只能推进，不能按旧环节行动 */
  locked: boolean
  can: ReadonlySet<string>
  advanceAvailable: boolean
  specialPending: boolean
  reserveUnitIds: readonly string[]
  reserveTriedUnitIds: readonly string[]
  move: AiMoveSnapshot
  /** 批 2：C 段支线（换模式 / 突袭 / 铁路 / 装卸 / 建造标记 / 换轨） */
  branch: AiMoveBranchSnapshot
  air: AiAirSnapshot
  barrage: AiBarrageSnapshot
  combat: AiCombatSnapshot
  supply: AiSupplySnapshot
}

export type AiAction =
  | { kind: 'answer'; optionId: string }
  | { kind: 'advance' }
  | { kind: 'preset' }
  | { kind: 'modeChange'; unitId: string }
  | { kind: 'moveBegin'; unitId: string }
  | { kind: 'moveClick'; hex: AiHex }
  | { kind: 'moveFinish' }
  /* 批 2：C 段支线（换模式 / 突袭 / 铁路 / 装卸 / 建造标记 / 换轨） */
  | { kind: 'modeChangeTo'; unitId: string; mode: 'move' | 'combat' }
  | { kind: 'overrun'; hex: AiHex }
  | { kind: 'railMove'; unitId: string; toHex: AiHex }
  | { kind: 'railMoveSp'; dumpId: string; amount: number; toHex: AiHex }
  | { kind: 'transportLoad'; pointId: string; amount: number }
  | { kind: 'transportUnload'; pointId: string; amount: number }
  | { kind: 'constructionMarker'; marker: 'bridge' | 'airStrip'; hex: AiHex }
  | { kind: 'gaugeConvert'; unitId: string; hex: AiHex }
  | { kind: 'specialConfirm' }
  /* 批 1：初设（一键预设 → 抽签 → 确认/开局） */
  | { kind: 'setupPreset' }
  | { kind: 'setupDraw' }
  | { kind: 'setupConfirm' }
  | { kind: 'setupShiftPlace'; formationId: string }
  /* 批 1：A 整备（15.1；一步式 refitBaseNow） */
  | { kind: 'refitBase'; baseId: string; aircraftIds: readonly string[]; dumpId: string }
  /* 批 1：B 到货落位（13.6 / 1.6a） */
  | { kind: 'arrivalRemovals' }
  | { kind: 'arrivalPlace'; index: number; hex: AiHex | null }
  | { kind: 'arrivalSkip'; index: number }
  /* 批 1：B 到货 SP（专规 2.1 / 3.1）与 3.6 补给列车 */
  | { kind: 'supplyArrivalPick'; hex: AiHex }
  | { kind: 'supplyArrivalGroup'; hexText: string; group: 'guderian' | 'hoth' }
  | { kind: 'supplyArrivals' }
  | { kind: 'supplyTrainGroup'; group: 'guderian' | 'hoth' }
  | { kind: 'supplyTrainPlace'; hex: AiHex }
  /* 批 1：B 重建 / 整编（13.5 / 13.9） */
  | { kind: 'rebuild'; unitId: string; mode: 'airBox' | 'dead' | 'onMap'; hex: AiHex | null }
  | { kind: 'consolidate'; keepId: string; removeId: string }
  /** 4.8a：按默认取舍（先毁 RE 最大的）把超堆叠格压回 10 RE 以内 */
  | { kind: 'overstackDestroy' }
  /** 14.2f：宣布并推进一次空军任务（低空扫射；C→G 由驱动逐段推进） */
  | { kind: 'airMission'; target: AiHex | null; aircraftId: string | null }
  | { kind: 'barrageTarget'; hex: AiHex }
  | { kind: 'barrageToggleUnit'; unitId: string }
  | { kind: 'barrageBegin' }
  | { kind: 'barrageSupply'; dumpId: string | null }
  | { kind: 'barrageShifts' }
  | { kind: 'barrageDice' }
  | { kind: 'barrageOutcome'; losses: readonly { unitId: string; steps: number }[] }
  | { kind: 'barrageCancel' }
  | { kind: 'combatSelect'; hex: AiHex }
  | { kind: 'combatBegin' }
  | {
      kind: 'combatSupply'
      /**
       * 该动作由谁作答：`attacker` / `defender` ＝只落自己一侧；
       * `advance` ＝双方都归 AI，落好两侧后推进（9.5）。
       */
      side: 'attacker' | 'defender' | 'advance'
      attackerDumpId: string | null
      defenderDumpId: string | null
    }
  | { kind: 'combatDeclareAr'; side: 'attacker' | 'defender' }
  | { kind: 'combatAutoResolve' }
  | { kind: 'combatLosses' }
  | { kind: 'combatOptions'; retreatHexes: number; lossPoints: number; ignoreOptions: boolean }
  | { kind: 'combatRetreatPaths'; paths: readonly { unitId: string; path: readonly AiHex[] }[] }
  | { kind: 'combatAdvance' }
  | { kind: 'combatSkip' }
  | { kind: 'supplyPlan' }
  | { kind: 'supplyRecovery' }
  | { kind: 'supplyFeeding' }
  | { kind: 'attritionRoll'; key: string }
  | {
      kind: 'attritionApply'
      key: string
      allocation: readonly { unitId: string; steps: number }[]
    }
  /** B4：玩家控制的决定 ⇒ 停下并给出等待文案（不提交任何动作） */
  | { kind: 'wait'; reason: string }
  | { kind: 'none' }

/** 决策的可读签名（死锁判据用；与盘面状态无关） */
export function actionKeyOf(action: AiAction): string {
  switch (action.kind) {
    case 'answer':
      return `answer:${action.optionId}`
    case 'modeChange':
      return `modeChange:${action.unitId}`
    case 'moveBegin':
      return `moveBegin:${action.unitId}`
    case 'moveClick':
      return `moveClick:${hexKeyOf(action.hex)}`
    case 'modeChangeTo':
      return `modeChangeTo:${action.unitId}:${action.mode}`
    case 'overrun':
      return `overrun:${hexKeyOf(action.hex)}`
    case 'railMove':
      return `railMove:${action.unitId}:${hexKeyOf(action.toHex)}`
    case 'railMoveSp':
      return `railMoveSp:${action.dumpId}:${hexKeyOf(action.toHex)}`
    case 'transportLoad':
      return `transportLoad:${action.pointId}`
    case 'transportUnload':
      return `transportUnload:${action.pointId}`
    case 'constructionMarker':
      return `constructionMarker:${action.marker}:${hexKeyOf(action.hex)}`
    case 'gaugeConvert':
      return `gaugeConvert:${action.unitId}:${hexKeyOf(action.hex)}`
    case 'barrageTarget':
      return `barrageTarget:${hexKeyOf(action.hex)}`
    case 'barrageToggleUnit':
      return `barrageToggleUnit:${action.unitId}`
    case 'combatSelect':
      return `combatSelect:${hexKeyOf(action.hex)}`
    case 'attritionRoll':
      return `attritionRoll:${action.key}`
    case 'attritionApply':
      return `attritionApply:${action.key}`
    case 'barrageSupply':
      return `barrageSupply:${action.dumpId ?? 'none'}`
    case 'combatSupply':
      return `combatSupply:${action.side}:${action.attackerDumpId ?? 'none'}:${action.defenderDumpId ?? 'none'}`
    case 'setupShiftPlace':
      return `setupShiftPlace:${action.formationId}`
    case 'refitBase':
      return `refitBase:${action.baseId}`
    case 'arrivalPlace':
      return `arrivalPlace:${String(action.index)}:${action.hex === null ? 'box' : hexKeyOf(action.hex)}`
    case 'arrivalSkip':
      return `arrivalSkip:${String(action.index)}`
    case 'supplyArrivalPick':
      return `supplyArrivalPick:${hexKeyOf(action.hex)}`
    case 'supplyArrivalGroup':
      return `supplyArrivalGroup:${action.hexText}:${action.group}`
    case 'supplyTrainGroup':
      return `supplyTrainGroup:${action.group}`
    case 'supplyTrainPlace':
      return `supplyTrainPlace:${hexKeyOf(action.hex)}`
    case 'rebuild':
      return `rebuild:${action.mode}:${action.unitId}`
    case 'consolidate':
      return `consolidate:${action.keepId}:${action.removeId}`
    default:
      return action.kind
  }
}

/** 距离最近敌格的格数（仅作为「往最近敌军方向走」的启发式，不是规则判据） */
function nearestEnemyDistance(hex: AiHex, enemyHexes: readonly AiHex[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const enemy of enemyHexes) best = Math.min(best, hexDistance(hex, enemy))
  return best
}

/**
 * 移动落子：在 `groupReachable.hexes` 里取「离最近敌军最近」的一格；并列按格号稳定排序。
 * 已尝试过的格跳过；没有则返回 null（由驱动结束本次移动）。
 */
function pickMoveTarget(snapshot: AiSnapshot): AiHex | null {
  const tried = new Set(snapshot.move.triedTargets)
  const options = snapshot.move.reachableHexes
    .filter((hex) => !tried.has(hexKeyOf(hex)))
    .slice()
    .sort(
      (a, b) =>
        nearestEnemyDistance(a, snapshot.move.enemyHexes) -
          nearestEnemyDistance(b, snapshot.move.enemyHexes) || compareHex(a, b),
    )
  return options[0] ?? null
}

/** 撤退落点：优先「不被消灭且不进敌方 ZOC」，其次「不被消灭」，最后才接受会被消灭的落点 */
function pickRetreatDestination(
  destinations: readonly {
    hex: AiHex
    forcedDestruction: boolean
    inEnemyZoc: boolean
    path: readonly AiHex[]
  }[],
): readonly AiHex[] | null {
  const rank = (item: { forcedDestruction: boolean; inEnemyZoc: boolean }): number =>
    item.forcedDestruction ? 2 : item.inEnemyZoc ? 1 : 0
  const sorted = destinations
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || compareHex(a.hex, b.hex))
  return sorted[0]?.path ?? null
}

/** B4：玩家侧的待办 ⇒ 返回 `wait`（不提交、不改盘面） */
function waitForSide(side: AiSide, what: string): AiAction {
  return { kind: 'wait', reason: `等待玩家（${sideLabelOf(side)}）${what}` }
}

/**
 * 批 1：A 整备（15.1）
 *
 * 只在本环节的闸门放行时行动；每基地每阶段一次（引擎同判 15.1A，驱动按记忆跳过）。
 */
function decideRefit(snapshot: AiSnapshot): AiAction | null {
  if (!snapshot.can.has('air.refit')) return null
  const base = snapshot.refit.bases[0]
  if (base === undefined) return null
  return {
    kind: 'refitBase',
    baseId: base.baseId,
    aircraftIds: base.aircraftIds,
    dumpId: base.dumpId,
  }
}

/** 批 1：B 到货落位（13.6 / 1.6a） */
function decideArrival(snapshot: AiSnapshot): AiAction | null {
  if (!snapshot.can.has('rein.arrival')) return null
  if (snapshot.rein.arrival.removalsPending) return { kind: 'arrivalRemovals' }
  const entry = snapshot.rein.arrival.entries[0]
  if (entry === undefined) return null
  if (entry.hex !== null) return { kind: 'arrivalPlace', index: entry.index, hex: entry.hex }
  if (entry.airBox) return { kind: 'arrivalPlace', index: entry.index, hex: null }
  // 该条目此刻地图与图外盒都无处可放：记一次跳过，交给「进入下一环节」
  return { kind: 'arrivalSkip', index: entry.index }
}

/**
 * 3.4b：德军到货 SP 的**默认归属**
 *
 * Supply Table 到货须在两集群间均分、奇数点归 Guderian（原文 + `applySupplyArrivalsNow` 同判）。
 * 归属只能按**整格**记，故先在未定格里找一组 SP 之和恰为 Guderian 配额的目标；
 * 找不到（格太大分不开）就返回 null，交给「结束本段/放弃」而不是硬塞一个会被拒的组合。
 */
function pickArrivalSpGroup(
  targets: AiReinSupplySnapshot['groupTargets'],
): { hexText: string; group: 'guderian' | 'hoth' } | null {
  const pending = targets.filter((target) => target.group === null)
  if (pending.length === 0) return null
  const total = targets.reduce((sum, target) => sum + target.sp, 0)
  const fixedG = targets.reduce(
    (sum, target) => sum + (target.group === 'guderian' ? target.sp : 0),
    0,
  )
  const need = Math.ceil(total / 2) - fixedG
  if (need < 0) return null
  // 稳定序 DFS：优先把靠前的格记为 Guderian，求一组和恰为 need 的整格
  const chosen = new Set<number>()
  const solve = (index: number, remaining: number): boolean => {
    if (remaining === 0) return true
    if (index >= pending.length || remaining < 0) return false
    const target = pending[index]!
    if (target.sp <= remaining) {
      chosen.add(index)
      if (solve(index + 1, remaining - target.sp)) return true
      chosen.delete(index)
    }
    return solve(index + 1, remaining)
  }
  const first = pending[0]!
  if (need === 0) return { hexText: first.hexText, group: 'hoth' }
  if (!solve(0, need)) return null
  return { hexText: first.hexText, group: chosen.has(0) ? 'guderian' : 'hoth' }
}

/** 批 1：B 到货 SP（免费铁运城市格每格 1 点 → 余额落图边源格 → 归属 → 落账） */
function decideReinSupply(snapshot: AiSnapshot): AiAction | null {
  const supply = snapshot.rein.supply
  if (!snapshot.can.has('rein.supplyArrival') && !snapshot.can.has('rein.supplyTrain')) return null
  if (supply.sp > 0) {
    // 原文：城市格每格 1 SP 免费铁运；余额落图边补给源格
    const limit = Math.min(supply.sp, supply.cityCandidates.length)
    if (supply.picked.length < limit) {
      const pickedKeys = new Set(supply.picked.map(hexKeyOf))
      const next = supply.cityCandidates.map((hex) => hex).sort(compareHex)[supply.picked.length]
      if (next !== undefined && !pickedKeys.has(hexKeyOf(next)))
        return { kind: 'supplyArrivalPick', hex: next }
    }
    if (supply.panzerGroupRulesOn) {
      const group = pickArrivalSpGroup(supply.groupTargets)
      if (group !== null) return { kind: 'supplyArrivalGroup', ...group }
    }
    if (supply.planReady) return { kind: 'supplyArrivals' }
  }
  if (supply.trainPending && supply.trainHexes.length > 0) {
    if (supply.trainGroupRequired) return { kind: 'supplyTrainGroup', group: 'guderian' }
    const hex = supply.trainHexes.map((item) => item).sort(compareHex)[0]!
    return { kind: 'supplyTrainPlace', hex }
  }
  return null
}

/** 批 1：B 重建 / 整编（13.5 / 13.9） */
function decideRebuild(snapshot: AiSnapshot): AiAction | null {
  if (!snapshot.can.has('rein.rebuild')) return null
  const rebuild = snapshot.rein.rebuild
  if (rebuild === null) return null
  if (rebuild.consolidate !== null) return { kind: 'consolidate', ...rebuild.consolidate }
  return { kind: 'rebuild', unitId: rebuild.unitId, mode: rebuild.kind, hex: rebuild.hex }
}

/** 批 2：C 段支线（建造标记 → 换模式 → 铁路 → 装卸；都在逐格移动之前） */
function decideMoveBranches(snapshot: AiSnapshot): AiAction | null {
  // 已宣布的空军任务要先收尾（14.2f）；期间别插地面支线，避免撞互斥
  if (snapshot.air.inProgress) return null
  const branch = snapshot.branch
  // 专规 3.5：建造标记必须在**任何单位移动之前**使用
  if (branch.constructionMarker !== null)
    return { kind: 'constructionMarker', ...branch.constructionMarker }
  if (branch.modeSwitch !== null) return { kind: 'modeChangeTo', ...branch.modeSwitch }
  if (branch.railUnit !== null) {
    const { unitId, toHex } = branch.railUnit
    return { kind: 'railMove', unitId, toHex }
  }
  if (branch.railSp !== null) {
    const { dumpId, amount, toHex } = branch.railSp
    return { kind: 'railMoveSp', dumpId, amount, toHex }
  }
  if (branch.transport !== null) {
    const { pointId, mode, amount } = branch.transport
    return mode === 'load'
      ? { kind: 'transportLoad', pointId, amount }
      : { kind: 'transportUnload', pointId, amount }
  }
  return null
}

function decideBarrageSettlement(snapshot: AiSnapshot): AiAction | null {
  const state = snapshot.barrage.state
  if (state === null || state.step === 'done') return null
  // 炮击是**当前行动方**的动作；玩家侧的炮击结算不得由 AI 代办
  if (!snapshot.control.activeSide) return waitForSide(snapshot.activeSide, '结算本次炮击（10.0）')
  switch (state.step) {
    case 'supply':
      if (
        state.kind === 'artillery' &&
        state.costT > 0 &&
        snapshot.barrage.supplyDumpIds.length === 0
      )
        return { kind: 'barrageCancel' }
      return { kind: 'barrageSupply', dumpId: snapshot.barrage.supplyDumpIds[0] ?? null }
    case 'shifts':
      return { kind: 'barrageShifts' }
    case 'dice':
      return { kind: 'barrageDice' }
    case 'outcome': {
      const losses: { unitId: string; steps: number }[] = []
      let remaining = snapshot.barrage.outcomeStepLosses
      for (const target of snapshot.barrage.lossTargets) {
        if (remaining <= 0) break
        const take = Math.min(remaining, target.steps)
        if (take <= 0) continue
        losses.push({ unitId: target.unitId, steps: take })
        remaining -= take
      }
      return { kind: 'barrageOutcome', losses }
    }
    default:
      return null
  }
}

function decideCombatSettlement(snapshot: AiSnapshot): AiAction | null {
  const state = snapshot.combat.state
  if (state === null || state.finished) return null
  const attacker = snapshot.activeSide
  const opponent = snapshot.defenderSide
  switch (state.step) {
    case 'combatSupply': {
      /*
       * 12.4 / 9.5b：付不付、从哪付由**该方自己**选（守方可拒付、改为半战斗值防御）。
       * 故 AI 只能答 `control` 归它的一侧；旧实现只看 `control.attacker` 就一票确认两侧，
       * PVE 里 AI 攻方会把人类守方的付款一并代答（自动扣/自动拒付），玩家再没有落点入口。
       */
      const attackerAi = snapshot.control.attacker
      const defenderAi = snapshot.control.defender
      // 双方都归 AI（自对打）：一次落两侧并推进，保持旧行为与步数
      if (attackerAi && defenderAi) {
        const attackerDumpId = snapshot.combat.attackerDumpIds[0]
        if (attackerDumpId === undefined) return { kind: 'combatSkip' }
        return {
          kind: 'combatSupply',
          side: 'advance',
          attackerDumpId,
          defenderDumpId: snapshot.combat.defenderDumpIds[0] ?? null,
        }
      }
      // 攻方还没确认：AI 攻方先落攻方；攻方归玩家则停手
      if (!snapshot.combat.attackerSupplyConfirmed) {
        if (!attackerAi) return waitForSide(attacker, '选择战斗补给（9.5）')
        const attackerDumpId = snapshot.combat.attackerDumpIds[0]
        if (attackerDumpId === undefined) return { kind: 'combatSkip' }
        return {
          kind: 'combatSupply',
          side: 'attacker',
          attackerDumpId,
          defenderDumpId: null,
        }
      }
      // 攻方已确认 ⇒ 守方归 AI 才落；归玩家则等玩家自己确认
      if (defenderAi && !snapshot.combat.defenderSupplyConfirmed) {
        return {
          kind: 'combatSupply',
          side: 'defender',
          attackerDumpId: null,
          defenderDumpId: snapshot.combat.defenderDumpIds[0] ?? null,
        }
      }
      if (!snapshot.combat.defenderSupplyConfirmed)
        return waitForSide(opponent, '选择战斗补给（9.5）')
      // 两侧都已确认 ⇒ 「进入行动值」是机械步骤（9.6），AI 可代点（不替任何一方做选择）
      return { kind: 'combatSupply', side: 'advance', attackerDumpId: null, defenderDumpId: null }
    }
    case 'declareAr':
      if (state.declaredAttackerArUnitId === undefined) {
        if (!snapshot.control.attacker) return waitForSide(attacker, '宣布攻方 AR（9.6）')
        return { kind: 'combatDeclareAr', side: 'attacker' }
      }
      if (!snapshot.control.defender) return waitForSide(opponent, '宣布守方 AR（9.6）')
      return { kind: 'combatDeclareAr', side: 'defender' }
    case 'declareTerrain':
    case 'surprise':
    case 'battleDice':
      // 纯自动结算（无输入、无选择）：不受控制权限制
      return { kind: 'combatAutoResolve' }
    case 'losses': {
      const requirement = snapshot.combat.requirement
      if (requirement === null) return null
      const owner = requirement.side === 'attacker' ? attacker : opponent
      if (!snapshot.control.requirement) return waitForSide(owner, '确认损失分配（9.11）')
      return { kind: 'combatLosses' }
    }
    case 'options': {
      const requirement = snapshot.combat.requirement
      if (requirement === null) return null
      const owner = requirement.side === 'attacker' ? attacker : opponent
      if (!snapshot.control.requirement) return waitForSide(owner, '选择战斗选项（9.10）')
      return {
        kind: 'combatOptions',
        retreatHexes: requirement.options,
        lossPoints: 0,
        ignoreOptions: false,
      }
    }
    case 'retreat': {
      const pending = snapshot.combat.retreatPlans.filter((plan) => plan.chosen === null)
      if (!snapshot.control.retreat) {
        const role = pending[0]?.role ?? 'defender'
        return waitForSide(role === 'attacker' ? attacker : opponent, '选择撤退落点（9.12）')
      }
      const paths: { unitId: string; path: readonly AiHex[] }[] = []
      for (const plan of snapshot.combat.retreatPlans) {
        const path = plan.chosen === null ? pickRetreatDestination(plan.destinations) : null
        if (path !== null) paths.push({ unitId: plan.unitId, path })
      }
      return { kind: 'combatRetreatPaths', paths }
    }
    case 'advance':
      if (!snapshot.control.attacker) return waitForSide(attacker, '选择进攻推进格（9.13）')
      return { kind: 'combatAdvance' }
    default:
      return null
  }
}

function decideBarrageStart(snapshot: AiSnapshot): AiAction | null {
  if (!snapshot.can.has('barrage.declare')) return null
  // 只有真正的**轰炸环节**才由「点地图」选目标（移动环节里的 air/ship 轰炸走另一条入口，基线不碰）
  if (!snapshot.segment.endsWith('.barrage')) return null
  if (snapshot.barrage.state !== null) return null
  // 快照里的合法参炸单位已按「格号 + 型号」稳定排序（见 driver），此处不再按 instanceId 重排
  const legalUnits = snapshot.barrage.choices
    .filter((choice) => !choice.disabled)
    .map((choice) => choice.unitId)
  if (legalUnits.length === 0) return null
  if (snapshot.barrage.enemyHexes.length === 0) return null

  const tried = new Set(snapshot.barrage.triedTargets)
  const target = snapshot.barrage.targetHex
  const untriedEnemies = snapshot.barrage.enemyHexes
    .slice()
    .sort(compareHex)
    .filter((hex) => !tried.has(hexKeyOf(hex)))
  if (target === null || tried.has(hexKeyOf(target))) {
    const next = untriedEnemies[0]
    return next === undefined ? null : { kind: 'barrageTarget', hex: next }
  }
  if (snapshot.barrage.selectedUnitIds.length === 0)
    return { kind: 'barrageToggleUnit', unitId: legalUnits[0]! }
  return { kind: 'barrageBegin' }
}

function decideCombatStart(snapshot: AiSnapshot): AiAction | null {
  if (!snapshot.can.has('combat.declare')) return null
  const tried = new Set(snapshot.combat.triedDefenderHexes)
  const untried = snapshot.combat.adjacentDefenderHexes
    .slice()
    .sort(compareHex)
    .filter((hex) => !tried.has(hexKeyOf(hex)))
  if (snapshot.combat.defenderHex !== null) {
    if (snapshot.combat.state !== null) return null
    if (tried.has(hexKeyOf(snapshot.combat.defenderHex))) return { kind: 'combatSkip' }
    if (snapshot.combat.attackerDumpIds.length === 0) return { kind: 'combatSkip' }
    return { kind: 'combatBegin' }
  }
  const next = untried[0]
  return next === undefined ? null : { kind: 'combatSelect', hex: next }
}

function decideSupply(snapshot: AiSnapshot): AiAction | null {
  if (snapshot.phase !== 'supply') return null
  const segment = snapshot.segment
  // 12.10e：恢复只在 D 段第一环
  if (segment === 'supply.recovery') {
    if (!snapshot.supply.planLoaded) return { kind: 'supplyPlan' }
    if (!snapshot.supply.recoverySettled) return { kind: 'supplyRecovery' }
    return null
  }
  // 12.6 / 12.8：喂养 + 断补损耗只在 D 段第二环（补给检定）
  if (segment !== 'supply.check') return null
  if (!snapshot.supply.planLoaded) return { kind: 'supplyPlan' }
  if (!snapshot.supply.feedingSettled) return { kind: 'supplyFeeding' }
  for (const duty of snapshot.supply.duties) {
    if (duty.applied) continue
    const key = duty.key
    if (!duty.rolled) return { kind: 'attritionRoll', key }
    const allocation: { unitId: string; steps: number }[] = []
    if (duty.needAllocation) {
      let remaining = duty.lossesKind === 'allSteps' ? Number.POSITIVE_INFINITY : duty.lossesSteps
      for (const unit of duty.units) {
        if (remaining <= 0) break
        const take = Math.min(remaining, unit.steps)
        if (take <= 0) continue
        allocation.push({ unitId: unit.id, steps: take })
        remaining -= take
      }
    }
    return { kind: 'attritionApply', key, allocation }
  }
  return null
}

/**
 * B3 基线策略：一次只给**一个**动作；优先级与任务书一致。
 *
 * 说明：本函数不做长链搜索、不预测合法性；任何「提交被拒」都由驱动记录后换下一个候选。
 *
 * B4：每个分支先按 `snapshot.control` 判**该决定归谁**——玩家控制的决定一律返回 `wait`，
 * 纯流程（锁定推进 / 空环节推进 / 自动结算）不受控制权限制。
 */
export function decideAiAction(snapshot: AiSnapshot): AiAction {
  if (snapshot.terminated) return { kind: 'none' }

  // 1) 盘面提问：受控方才作答；否则明确告诉玩家在等什么
  if (snapshot.awaitingOptionIds.length > 0) {
    if (!snapshot.control.responder) {
      const responder = snapshot.awaitingResponder ?? snapshot.activeSide
      return waitForSide(responder, `作答：${snapshot.awaitingPrompt || '盘面提问'}`)
    }
    return { kind: 'answer', optionId: snapshot.awaitingOptionIds[0]! }
  }

  // 会话停在回合准备（天气/先手判定）：workbench 仍挂着上一环节的旧闸门，只能交给推进
  if (snapshot.locked) return { kind: 'advance' }

  // 2) 未结算的战斗 / 轰炸 / 补给义务 → 先结清（各分支内部再按归属方判控制权）
  if (snapshot.specialPending) {
    if (!snapshot.control.activeSide) return waitForSide(snapshot.activeSide, '确认战斗专规（9.4）')
    return { kind: 'specialConfirm' }
  }
  const combatSettle = decideCombatSettlement(snapshot)
  if (combatSettle !== null) return combatSettle
  const barrageSettle = decideBarrageSettlement(snapshot)
  if (barrageSettle !== null) return barrageSettle

  // 3) 初设：预设 → 抽签（ch10/ch11）→ 确认/开局（两段式）
  if (snapshot.setup.active) {
    if (!snapshot.control.setup)
      return {
        kind: 'wait',
        reason: `等待玩家完成初设：还剩 ${String(snapshot.setupRemaining)} 枚待落位`,
      }
    // 分方游标仍在某一方：先落该方自由项与飞机（无自由项时这一调用只做「确认该方」）
    if (snapshot.setup.cursorActive) return { kind: 'setupPreset' }
    // 抽签后仍缺落点的西移编队（ch10）：按初设面板同一入口给一个候选
    const shift = snapshot.setup.shiftFormationIds[0]
    if (shift !== undefined) return { kind: 'setupShiftPlace', formationId: shift }
    if (snapshot.setup.drawVisible) return { kind: 'setupDraw' }
    return { kind: 'setupConfirm' }
  }

  // 正在移动 → 已经落子就直接结束；否则落第一子（玩家侧的移动 AI 不接手）
  if (snapshot.move.active) {
    if (!snapshot.control.activeSide)
      return waitForSide(snapshot.activeSide, '完成本次移动（4/5/7）')
    // 8.0：尚未落子时先看能否突袭相邻敌格（突袭结算仍走后面的 combat 链）
    if (!snapshot.move.hasStepped) {
      const target = snapshot.branch.overrunTargets[0]
      if (target !== undefined) return { kind: 'overrun', hex: target }
    }
    if (snapshot.move.hasStepped) {
      // 13.3f：铁路修理单位刚走入非本方轨距格 ⇒ 先换轨，再结束本次移动
      if (snapshot.branch.gauge !== null) return { kind: 'gaugeConvert', ...snapshot.branch.gauge }
      return { kind: 'moveFinish' }
    }
    const target = pickMoveTarget(snapshot)
    return target === null ? { kind: 'moveFinish' } : { kind: 'moveClick', hex: target }
  }

  // B4：以下动作都属于**当前行动方**——玩家控制时停手；空环节仍按纯流程推进
  if (!snapshot.control.activeSide) {
    if (snapshot.advanceAvailable && snapshot.can.size === 0) return { kind: 'advance' }
    return waitForSide(snapshot.activeSide, '行动：本环节尚有可做动作')
  }

  // 3.5) 批 1：A 整备 / B 到货落位 / 到货 SP / 补给列车 / 重建整编
  //      （各分支内部只看 `can` 里的闸门与既有投影；闸门不放行时自然落到后面的主链）
  const refit = decideRefit(snapshot)
  if (refit !== null) return refit
  const arrival = decideArrival(snapshot)
  if (arrival !== null) return arrival
  const reinSupply = decideReinSupply(snapshot)
  if (reinSupply !== null) return reinSupply
  const rebuild = decideRebuild(snapshot)
  if (rebuild !== null) return rebuild
  // 4.8a：超堆叠不解决就推进不了（13.6 到场豁免只覆盖增援段）；按默认取舍先压回限内
  if (snapshot.overstack.active) return { kind: 'overstackDestroy' }

  // 3.6) 批 2：C 段支线（建造标记 / 换模式 / 铁路 / 装卸；闸门不放行时自然落到后面的主链）
  const branch = decideMoveBranches(snapshot)
  if (branch !== null) return branch

  // 4) 空军任务（14.2f）：已宣布的推进收尾；否则在允许宣布的环节打一次低空扫射
  //    天气受限时引擎本就不放行 `air.mission`，这里不另设天气判据（按原文不飞）
  if (
    snapshot.air.inProgress ||
    (!snapshot.air.flownThisPhase &&
      snapshot.air.inMovementPhase &&
      snapshot.air.weatherNormal &&
      snapshot.can.has('air.mission') &&
      snapshot.air.target !== null &&
      snapshot.air.aircraftId !== null)
  )
    return {
      kind: 'airMission',
      target: snapshot.air.inProgress ? null : snapshot.air.target,
      aircraftId: snapshot.air.inProgress ? null : snapshot.air.aircraftId,
    }

  // 5) 预备 → 战斗（只在闸门放行的环节；每环节每单位只试一次）
  if (snapshot.can.has('move.modeChange')) {
    // 快照已按「格号 + 型号」稳定排序（instanceId 含时间戳，不能当先后判据）
    const unitId = snapshot.reserveUnitIds.find((id) => !snapshot.reserveTriedUnitIds.includes(id))
    if (unitId !== undefined) return { kind: 'modeChange', unitId }
  }

  // 5) 移动：每环节最多 4 个单位；候选按「格号 + 型号」稳定排序（见 driver）
  if (snapshot.can.has('move.order') && snapshot.move.triedUnits.length < 4) {
    const unitId = snapshot.move.candidates.find((id) => !snapshot.move.triedUnits.includes(id))
    if (unitId !== undefined) return { kind: 'moveBegin', unitId }
  }

  // 6) 炮击（有合法参炸单位时）
  const barrageStart = decideBarrageStart(snapshot)
  if (barrageStart !== null) return barrageStart

  // 7) 战斗（仅相邻、有补给时声明；失败由驱动记录并换下一格）
  const combatStart = decideCombatStart(snapshot)
  if (combatStart !== null) return combatStart

  // 8) 补给付款 / 喂养 / 损耗
  const supply = decideSupply(snapshot)
  if (supply !== null) return supply

  // 9) 推进
  if (snapshot.advanceAvailable) return { kind: 'advance' }

  return { kind: 'none' }
}
