import { defineStore } from 'pinia'
import { computed, ref, watch, type Ref } from 'vue'

import type { HexRef, RailGauge, Side } from '@/data'
import { mapConfig, mapLayers, rulesConstants, scenarios } from '@/data'
import {
  HEX_DIRECTIONS,
  allMapHexes,
  areAdjacent,
  hexDistance,
  isNorthEdge,
  isSouthEdge,
  isWestEdge,
  neighbor,
  neighbors,
  sameHex,
} from '@/engine/hex-geometry'
import { DERIVATION_KEY, type Derivation } from '@/engine/derivation'
import { combatDerivation, surpriseDerivation } from '@/engine/derivation-builders'
import { createRngState, roll1d6, roll2d6 } from '@/engine/rng'
// B37：分界线的渲染投影类型（渲染层只画被给的东西）
import type { BoundaryLine } from '@/render/map-render'
import { createRailFacts, createTraceSupplyAt } from '@/engine/rules'
// B8：环节链（当前环节由本文件的 `segmentStep` 从这张表推出）
import { sopStepById, sopStepsOf, type SopSegmentStep } from '@/engine/rules'
import {
  fail,
  succeed,
  type PendingEffect,
  type RuleFailure,
  type RuleOutcome,
} from '@/engine/result-types'
import type {
  AirStatus,
  DiceRoll,
  GamePhase,
  RngState,
  SessionLogEntry,
  VictoryLocationState,
} from '@/engine/state-types'
import {
  // 批 A 切片 2：段内轰炸来源（SOP：C 段 air & ship only / F 段 artillery only）
  BARRAGE_SOURCES_BY_PHASE,
  DIRECT_DRAW_RANGE_MP,
  SP_TO_T,
  airBaseBuildCostSp,
  claimFrontalReserves,
  constructionTaskCostsSp,
  frontalReservesBatch,
  planAirBaseBuild,
  planAirstripBuild,
  planAirstripUpgrade,
  planHedgehogBuild,
  planHedgehogReduce,
  printedPermanentHedgehogAt,
  PANZER_GROUP_CONSTRAINT_END,
  checkPanzerGroupSpPayment,
  // B50（用户 2026-09-17）：3.4b 是 4.1a 的**可选项** ⇒ 生效与否＝日期窗口 × 开局共识
  panzerGroupRulesActive,
  PANZER_GROUP_OPTION_ITEM,
  validateConstructionBase,
  EXTENDER_REQUIRED_POINTS,
  isVariableExitActive,
  addReplHoldings,
  airInteractionChecklist,
  airTransportTerrainIsClosed,
  // B44（14.9e）：逐机飞法（A 双程 / B 正常 / C 半程容量翻倍）
  airTransportProfile,
  // 批 F 切片 6（14.4f/14.4g）：减损面容量、容量变化后的货物损失
  transportCapacityOf,
  planCargoLoss,
  validateCargoLossChoice,
  activeAircraftInBase,
  allocateBattleLosses,
  applyModeSwitch,
  barrageStepChecklist,
  barrageTerrainLines,
  beginAirInteraction,
  beginBarrage,
  beginCombat,
  beginMove,
  beginSupplyCheck,
  canFlipOrientation,
  // H⑤（14.1a）：非激活飞机不能执行任务（选择闸 / 候选阵列 / 宣布任务共用同一判据）
  canFlyMission,
  canJoinRetreat,
  canAddAircraftAtStep,
  canJoinMission,
  canPerformMissionThisPhase,
  canVoluntarilyReturn,
  missionSegmentOf,
  nkvdArRequired,
  splitOverrunStack,
  canReleaseReserve,
  canSwitchModeNow,
  canThrowViaHQ,
  // B42（13.2g-B）：编内卡车的 SP 只许同一多单位编队内的单位拖取
  canDrawFromCarrier,
  // B47（12.8e）：突围 —— 判据全在引擎（`breakout.ts`），本层只备 A/B 的事实并落盘
  canBreakout,
  resolveBreakout,
  createMapFacts,
  // 批 F 切片 1（专规 3.4）：分界线沿**多轨铁路折线** —— 路径从数据推（渲染与判据共用同一条）
  createMultiTrackRailFacts,
  panzerGroupBoundaryPath,
  inEnemyZocAt,
  selectMovementTerrain,
  type BreakoutConditions,
  type BreakoutEligibility,
  type BreakoutPathFacts,
  cancelMove as revertInteraction,
  checkDefenderArChoice,
  checkLegality,
  chooseSupplySource,
  isSavableRepl,
  clearNonSavableRepl,
  clearReleasedFromReserve,
  completeAirReturnStep,
  computeCombatSupplyCost,
  // 批 B 切片 2：补给链的"获取即付款"费率取自引擎的 12.5c 计价（不另写一份费率）
  computeFuelCost,
  confirmMissionStep,
  canAttemptDumpDestruction,
  // 第五批批 B 切片 2（12.7a/d）：延补队转换的**环节闸**与生成格的**来源连通**判据（引擎唯一实现）
  canConvertTransportToExtender,
  canCreateExtenderAt,
  dumpDestructionPercent,
  extenderDisplacementCandidates,
  forageAvailable,
  needsFuelToMove,
  planDumpDestruction,
  planSupplyPhase,
  resolveAttrition,
  validateAttritionAllocation,
  confirmOosResolution,
  confirmSupplyPickup,
  // G②（12.3b）：把补给投到**每一个**受益单位 —— 逐单位算投递距离，故用单目标版
  countSupplyDistance,
  countSupplyDistanceToAny,
  currentResolver,
  declareAirCombatStep,
  declareBarrageShifts,
  declareCombatAr,
  declareCombatTerrain,
  declareInterceptionStep,
  describeCost,
  drawableDumpsFor,
  emptyReplHoldings,
  endMoveEarly,
  flipOrientation,
  fuelExpiresOnPhaseChange,
  // 12.5c（用户 2026-09-17）：三种加油法各自的适用范围
  fuelMethodAvailability,
  // 12.5c-A（I①）：编队法的覆盖判据（该单位是否属于本次付款覆盖的那个编队）
  formationFuelCovers,
  getPrintedHedgehog,
  holdingsToT,
  inPatrolZoneOf,
  isConvertibleTransportPoint,
  // B40（3.2f / 12.5c-B / 12.5e）：独立单位判据（HQ 法只覆盖它）
  isIndependentUnit,
  // B40（12.5c-B / 12.5e）：HQ 法覆盖谁（指挥部自己 + 独立单位）
  hqFuelCovers,
  // B40（12.6f / 13.7a）：编队追溯补给的同源取舍（分组由调用方给）
  formationTraceTradeoff,
  isEnemySafeEdgeHex,
  isFacilityBarrage,
  isLegal,
  isNkvdBorderRegiment,
  lossesOf,
  markersAfterDg,
  mergeTransportPoints,
  needsRetreat,
  nkvdDefenderOptionOverride,
  optionsOf,
  patrolZoneHexes,
  planArrivals,
  planAirBaseReduction,
  planAirUnload,
  planBarrageOutcome,
  planBarrageSupply,
  planBaseRefit,
  planBaseTransfer,
  breakdownAbsorbObligations,
  planBreakdownAbsorb,
  planBreakdownCreate,
  planCombatSupply,
  planCombatSupplyFunding,
  planConsolidation,
  planConvertTransportToExtender,
  planFlipExtenderToTransport,
  planFuelPayment,
  planInterceptionResponse,
  planLosses,
  planOptions,
  planRebuild,
  planRetreatDestinations,
  planSlowMobilization,
  planSpMerge,
  planSpPayment,
  planSpSplit,
  planStep,
  planTransportSplit,
  planVariableReinforcement,
  previewStep,
  railSupplyPath,
  reachableForMove,
  reachableNodeAt,
  resolveAdvance,
  resolveAirCargoDrop,
  resolveAirCombatRounds,
  resolveArrivalPlacement,
  resolveBarrageDice,
  resolveBaseTransfer,
  resolveCombatDice,
  resolveFlakStep,
  resolveInterception,
  resolveRetreats,
  resolveSpecialCombat,
  resolveSurprise,
  stepChecklist,
  supplyCoverage,
  supplyStepChecklist,
  transportDisplacementCandidates,
  transportGroupOf,
  undoMoveStep as revertInteractionStep,
  validateGaugeConversion,
  validateRailMovement,
  validateTransportPointLoad,
  validateTransportPointUnload,
  convertedRailRun,
  // W6 B19：Smolensk 专规机制
  addSupplyCache,
  allVictoryConditionHexes,
  breakdownPoolTotal,
  checkRedAirForceMission,
  checkSecurityNeeds,
  cleanupPatchById,
  dividingLineObligations,
  checkTurnEndVictory,
  checkTurnStartVictory,
  controlOfHex,
  evaluateFinalVictory,
  exclusiveTimingCalendar,
  initialSupplyCacheHoldings,
  isCleanUpNoop,
  isScenarioFinalTurn,
  listedVictoryHexes,
  planCleanUp,
  planConstructionMarkerUse,
  isConstructionMarkerDestroyed,
  planFreeRailArrivals,
  railCapacitiesOn,
  removalAllowedNow,
  removalReasonOf,
  requiresTraceSupply,
  scenarioTurnRange,
  splitSupplyTableSp,
  distributeTransportCargo,
  splitTransportPoint,
  summarizeVictoryControl,
  supplySourceStatuses,
  timingsOn,
  traceCoverageHas,
  traceCoverageHexes,
  useSupplyCacheAsForage,
  useSupplyCacheAsShells,
  type AirBaseReductionPlan,
  type AirBaseView,
  type AirCombatWindow,
  type AirMissionSegment,
  type AirInteractionState,
  type AirMissionAircraftView,
  type AirMissionCargo,
  type AirMissionKind,
  type AirMissionPhase,
  type ArrivalPlacementFacts,
  type ArrivalPlacementResult,
  type ArrivalPlan,
  type BarrageInteractionState,
  type BarrageKind,
  type BarrageTargetKind,
  type BarrageUnitPatch,
  type BaseRefitPlan,
  type BaseTransferPlan,
  type BaseMode,
  type BaseSourceKind,
  type BattleUnitView,
  type BreakdownCreateTiming,
  type CombatStep,
  type CombatInteractionState,
  type CombatLine,
  type CombatRole,
  type ConstructionExecutor,
  type ConstructionTask,
  type CombatUnitPatch,
  type ConsolidationPlan,
  type FacilityPatch,
  type FreeRailCandidate,
  type FreeRailPlan,
  type FuelMethod,
  type FrontalReservesBatch,
  type DrawableDump,
  type SupplyMobility,
  type GroupReachable,
  type InterceptionResponse,
  type LegalityVerdict,
  type MoveInteractionState,
  type MoveStepRecord,
  type MoveUnitRuntime,
  type MovementSegmentPhase,
  type OosAction,
  type Orientation,
  type RebuildPlan,
  type RailCargoView,
  type ReplHoldings,
  type RetreatDestinationPlan,
  type RetreatFacts,
  type SpHoldings,
  type SpecialObjectView,
  type StackTerrainChoice,
  type StepPreview,
  type SupplyInteractionState,
  type SupplyPhasePlan,
  type SupplyPurpose,
  type SupplyReachableHex,
  type SupplySourceOption,
  type SupplySourceKind,
  type TransportGroupResult,
  type TransportKind,
  type TransportPointActor,
  type VariableReinforcementPlan,
  // W6 B19：Smolensk 专规机制
  type DividingLineObligation,
  type ExclusiveTimingEntry,
  type PanzerGroup,
  type PanzerGroupSpPurpose,
  type PanzerGroupBoundary,
  type PanzerGroupUnitView,
  type RedAirForceCheckResult,
  type SecurityCheckCityView,
  type SecurityNeedsResult,
  type TrainbustingRemovalReason,
  type SupplyCacheHoldings,
  type SupplyCacheUse,
  type SupplyShutdownFacts,
  type SupplySourceStatus,
  type TrainbustingMarkerView,
  // W6 B20：胜利判定
  type ScenarioTurnRange,
  type VictoryAssessment,
  type VictoryControlLookup,
  type VictoryControlSummary,
  // W7 C16：移动中的突袭（8.0/8.1）
  applyOverrunMove,
  OVERRUN_COST_MP,
  overrunEligibility,
  planOverrunMove,
  resolveOverrunAftermath,
  // 第六批条 20：10.1a 火炮射程（界面只用它"说清楚"，裁决仍在引擎）
  canBarrageAtRange,
  // B8：环节链与闸门表（判据的唯一出处；本 store 只查表，不自己写"哪个动作归哪一段"）
} from '@/engine/rules'
import { createId } from '@/shared'

import { opponentOf } from '@/engine/turn-driver'

import { useGameSessionStore, type AdvanceOutcome as SessionAdvanceOutcome } from './session'

import type { AttritionResult } from '@/engine/tables/attrition'

import {
  TURN_TRACK,
  airRangeFromBase,
  aircraftChoices,
  attackersForHex,
  availableMaOf,
  bridgedHexesBySide,
  buildLegalityRequest,
  buildMoveContext,
  constructionLegMpDistance,
  createBarrageFacts,
  createBattleFacts,
  createRetreatFacts,
  createSupplyFacts,
  createRailSupplyFacts,
  defaultDefenseTerrain,
  defenseTerrainChoices,
  effectiveMobilityOf,
  hedgehogLevelAt,
  hexLabel,
  hexsideTerrainNames,
  isExtenderUnit,
  isFighterAircraft,
  isHqUnit,
  // B14b：13.4a 预备/战略模式判据（参炸单位阵列的灰显原因与引擎请求共用一处）
  isInReserveOrStrat,
  isRailHexAt,
  isStrategicBomberAircraft,
  modeUnitClassOf,
  parseConvertedRailRun,
  parseHexPath,
  printedHedgehogLevelAt,
  railNeighborHexes,
  railNeighborSource,
  recordNameOf,
  resolveBattle,
  toAirBarrageUnitRequest,
  // 第五批批 C 切片 1（14.1b）：减损机的**当前面**取值（轰炸/空战）与印值军力判据
  airBarrageStrengthOf,
  airCombatRatingOf,
  airPrintedStepsOf,
  // 12.5a：耗油判据（B18b「未加注的耗油单位」取它，不另写一份）
  needsFuelOf,
  toAirBaseView,
  toAirMissionAircraftView,
  toBarrageUnitRequest,
  isAirDeadPileEntry,
  toBattleUnitView,
  toBreakdownSideView,
  toConsolidationGroundView,
  toConsoleAirUnit,
  toConsoleUnit,
  toMoveRuntime,
  toMoveUnitView,
  toExtenderView,
  toNkvdDefenseView,
  toThrowHqView,
  terrainsAt,
  turnDateOf,
  unitChoices,
  type AircraftRecordView,
  // B14：空军面板的「参战机」算子图阵列（逐机给出可选性与原因）
  type AirMissionJoinChoice,
  type BattleReport,
  type ConsoleAirUnit,
  type ConsoleUnit,
  type DeadPileEntry,
  type UnitRecordView,
  // B9：算子参与判定（与闸门表同一套判据；界面灰显与拾取过滤都用它）
  participatesIn,
  mapHintOf,
  type MapHint,
  // B8：环节闸门表（判据唯一出处）
  actionGateOf,
  allowedActionsOf,
  type ActionGate,
  type ActionGateQuery,
  type ActionKey,
} from './workbench-model'

/**
 * 骨架操作台（U0）状态
 *
 * 定位：**让引擎有可点的验证入口**——不是最终界面，但每一步都必须真实经过引擎：
 *   · 走一步 → `evaluateStep`（6.1/6.2/4.5a-A/12.5a…），显示本次 MP 消耗与拒绝原因；
 *   · 打一仗 → `roll2d6`（B2 种子化 RNG）+ `resolveCombat`（9.9），显示骰点与战果；
 *   · 每次动作前 → `checkLegality`（B21 七族前置校验），把违规/提示/义务一并列出。
 *
 * 纪律：本 store **不做规则计算**（CODE_SPEC：UI 无规则计算），只持状态、调引擎、记日志；
 * 种子与掷骰次数全部留在本 store，可复算（B2）。
 */

/** 操作台日志条目（按类别着色） */
export interface WorkbenchLogEntry {
  id: string
  kind: 'info' | 'success' | 'warning' | 'danger'
  /** 规则编号（有则显示，便于对着规则书核对） */
  rule?: string
  text: string
  /**
   * 结算复核过程（W7 C11：骰点 / 计算过程 / 规则编号 / 修正来源）
   *
   * 有则界面可展开逐项复核；由 `engine/derivation-builders.ts` 的构造器给出
   * （与引擎实际用的算式同源，不是另写一遍规则）。
   */
  derivation?: Derivation
}

/** C5：一步移动的展示快照（全部来自引擎给出的步骤记录，界面不重算规则） */
export interface MoveStepSnapshot {
  kind: MoveStepRecord['kind']
  from: HexRef
  to: HexRef
  /** 随行单位名 */
  movedNames: string[]
  /** 掉队单位名（6.1f：留在经过的格中） */
  droppedNames: string[]
  /** 进入未抵消敌方 ZOC 被迫停止的单位名（4.5a-A） */
  zocStoppedNames: string[]
  /** 各随行单位本步消耗的 MP 文本 */
  costText: string
  rules: string[]
}

/**
 * 操作台可选阶段（2.2 SOP 段的一个子集）
 *
 * B 增援（到达表执行 13.6 / 可变增援 1.6b / 特殊补员 1.6c / 重建 13.5 / 合并 13.9）、
 * C 移动 / E 反应 / G 进击 三段是**移动环节**（6.0/6.3a/11.0a）；F 战斗段只有轰炸与常规战斗（9.0），
 * 不能移动；A **飞机整备阶段**（15.1A）是整备的唯一时机，同样没有移动环节。
 */
export type ConsolePhase =
  | 'aircraftRefit'
  | 'reinforcement'
  | 'movement'
  | 'supply'
  | 'reaction'
  | 'combat'
  | 'exploitation'
  | 'cleanUp'

/**
 * 2.2：**没有移动环节**的段（A 整备 / B 增援 / D 补给 / F 战斗 / H 清理）
 *
 * 「有移动环节」的段只有 C 移动 / E 反应 / G 进击（6.0/6.3a/11.0a）；
 * 其余段落到 `movementPhaseOf` 只为给引擎一个合法枚举值，移动本身由 `beginMoveFor` 拦下。
 */
const NO_MOVEMENT_PHASES: readonly ConsolePhase[] = [
  'aircraftRefit',
  'reinforcement',
  'supply',
  'combat',
  'cleanUp',
]

/**
 * 可突袭目标提示（与渲染层 `render/token-layer.ts` 的 `OverrunTargetHint` **同形**）
 *
 * 刻意用本地结构类型而不是从 render 导入：依赖方向是 `stores → engine`，
 * 状态层不该反向依赖渲染层；两侧同形由 TS 结构化类型自动对接（`MovementOverlay.overrunTargets`）。
 */
export interface WorkbenchOverrunTarget {
  hex: HexRef
  mpCost: number
  adjacentToPath: boolean
}

/**
 * W7 C16：**一名**需撤退单位的落点规划（9.12；地图优先交互）
 *
 * `destinations` 来自引擎 `planRetreatDestinations`（已在完整撤退距离上的合法落点），
 * `chosen` 是玩家当前已点选的落点（null＝未选）。
 */
export interface CombatRetreatUnitPlan {
  unitId: string
  label: string
  /** 起始格（撤退格号的起点） */
  from: HexRef
  /** 已选落点（null＝未选） */
  chosen: HexRef | null
  /** 该单位可选的落点（含路径、是否在敌方 ZOC 内、是否会被消灭） */
  destinations: RetreatDestinationPlan[]
}

/**
 * W7 C16 + 9.12d：跟随撤退者（随其同格的主撤退单位一起撤）
 *
 * 界面只做展示：路径自动沿用宿主的（9.12c「以一整个堆叠进行撤退」），故无「chosen」。
 */
export interface CombatRetreatTagalongPlan {
  unitId: string
  label: string
  /** 宿主（同格的主撤退单位） */
  hostId: string
  hostLabel: string
}

/**
 * W7 C16：**一方**的撤退落点规划（9.12c：双方各自撤自己的单位；攻方先、守方后）
 *
 * `safe` / `zoc` / `doomed` 是该方全部参与者落点的并集：界面据此在地图上分别渲染
 * 「安全撤退格」「有控制区影响的撤退格」（9.12e）与「选了会被消灭的落点」（9.12/9.12b）。
 */
export interface CombatRetreatSidePlan {
  side: CombatRole
  /** 9.12：该方需要的撤退格数（＝9.10a 选项里的撤退格数） */
  distance: number
  units: CombatRetreatUnitPlan[]
  /** 9.12d：已点选随该方撤退的跟随者 */
  tagalongs: CombatRetreatTagalongPlan[]
  /** 该方是否每个单位都已选好落点（齐了才允许确认撤退） */
  complete: boolean
  safe: HexRef[]
  zoc: HexRef[]
  /** 9.12 / 9.12b：选了会被消灭的落点（界面单独标注） */
  doomed: HexRef[]
}

/**
 * 9.14c：运输点组的**算子级分配**（哪些被夺取、哪些被位移）
 *
 * 规则把「混合类型时哪些被夺取」交给**拥有者玩家**选择，故界面须让他能改；
 * 默认值取引擎 `planTransportSplit` 的方案（能精确拼出表值时即精确）。
 */
export interface SpecialTransportSplit {
  group: TransportGroupResult
  /** 该组算子的**原主**（9.14c 的「拥有者玩家」；取消勾选时按它复原归属） */
  ownerSide: Side
  counters: { id: string; label: string; points: number; loadedT: number }[]
  /** 玩家当前勾选为「被夺取」的算子 */
  capturedIds: string[]
  exact: boolean
  detail: string
}

/** 9.14c/d：待玩家选择**落点**的位移项（在地图上点格） */
export interface SpecialDisplacementItem {
  unitId: string
  label: string
  kind: 'transport' | 'extender'
  detail: string
  /** 合法落点（9.14c：格距 ≤ 上限的任意图内格；9.14d：特殊拖取距离内且该格有追溯补给） */
  candidates: HexRef[]
  chosen: HexRef | null
}

/** 9.14：一次「进入敌方设施格」触发的全部待决事项 */
export interface SpecialCombatPending {
  hex: HexRef
  enteringSide: Side
  /** 9.14c：各运输点组的分配（玩家可改） */
  splits: SpecialTransportSplit[]
  /** 9.14c/d：待选落点的位移项 */
  items: SpecialDisplacementItem[]
  /** 即时处置的说明（dump/基地/工事的夺取与摧毁） */
  notes: string[]
  /** 本次掷骰（展示与复核） */
  dice: { dump?: number; trucks?: number; wagons?: number }
}

/**
 * 移动环节阶段的映射（6.0/6.3a/11.0a）
 *
 * A 整备段、B 增援段、D 补给段、F 战斗段、H 清理段都**没有移动环节**，故落到 `movement`
 * 只为给引擎一个合法枚举值；移动本身在 `beginMoveFor` 里按非移动段明确拦下（同 C5 既有做法）。
 */
export function movementPhaseOf(phase: ConsolePhase): MovementSegmentPhase {
  switch (phase) {
    case 'movement':
    case 'reaction':
    case 'exploitation':
      return phase
    default:
      return 'movement'
  }
}

/**
 * 空军任务可发生的三个环节（14.1g：C 移动 / E 反应 / G 进击）
 *
 * 其余段（A 整备 / B 增援 / D 补给 / F 战斗 / H 清理）不会宣布空军任务，故返回 null，
 * 供专规 2.2 的阵营层预检跳过。
 */
function airMissionPhaseOf(phase: ConsolePhase): AirMissionPhase | null {
  return phase === 'movement' || phase === 'reaction' || phase === 'exploitation' ? phase : null
}

/** 已选定的交战（9.3b 地形与 9.6 行动值在此由双方选定后再结算） */
export interface BattleTarget {
  hex: HexRef
  /** 目标格内参与防御的单位（实例 id，按摆放顺序） */
  defenderIds: string[]
}

/**
 * C6：一场战斗里的玩家输入（界面 v-model 绑定）
 *
 * 纪律：本项**只承载玩家的选择**，不含任何规则结论；一切数值与可行性由引擎裁决
 * （`combat-interaction.ts` 的九步状态机）。
 */
export interface CombatInputs {
  /** 12.4：攻方本阶段可动用的 T（SP 与可动用部队储备之和） */
  attackerAvailableT: number
  /**
   * 12.10a：攻方是否**动用部队储备**补齐图上补给的缺口
   *
   * 勾上后由 `planCombatSupplyFunding` 逐单位定"图上付 / 储备付"：图上能全额付清的单位**必须**
   * 走图上（12.10a），付不清的改用储备并按 12.10b 降一级标记；已耗尽者无法再用（12.10c）
   * ⇒ 整笔拒绝（12.4：付不出全额就不能攻击）。
   */
  attackerUsesInternalStocks: boolean
  /** 9.5-B：守方是否愿意支付战斗补给（不付 ⇒ 以一半战斗值防御） */
  defenderProvides: boolean
  /** 12.4：守方本阶段可动用的 T */
  defenderAvailableT: number
  /** 12.10a：守方是否动用部队储备（口径同攻方） */
  defenderUsesInternalStocks: boolean
  /** 9.6：攻方 AR 单位 id（null＝未宣布） */
  attackerArUnitId: string | null
  /** 9.6：守方 AR 单位 id（null＝未宣布） */
  defenderArUnitId: string | null
  /** 9.4b：逐攻击堆叠地形（键＝`列.行`；缺项＝沿用守方格地形） */
  stackTerrain: Record<string, { kind: 'hex' | 'hexside'; terrain: string }>
  /** 9.4c：守方防御地形（决定战斗表横行） */
  defenderTerrain: string
  /** 9.10a：选项 —— 撤退格数 */
  optionRetreatHexes: number
  /** 9.10a：选项 —— 以军力损失满足的点数 */
  optionLossPoints: number
  /**
   * 9.11a/9.11c（第五批 A3）：选项损失的**逐单位分配**（unitId → 点数；全 0/缺省＝按规范分配）。
   * 给出正数时由引擎按 `validateBattleLossAllocation` 严格校验（AR 先受第一点、均匀展开）。
   */
  optionLossAllocation: Record<string, number>
  /** 9.10c：守方行使「忽略选项」（仅当 9.10c 给予该权利时合法） */
  ignoreOptions: boolean
  /** 9.12：撤退路径（unitId → `列.行,...`，**不含起始格**；长度＝完整撤退距离） */
  retreatPaths: Record<string, string>
  /** 9.12e：额外 1 点军力损失的承受者（从候选 DG 单位中选） */
  /** 9.11a（批 F 切片 2）：把"多受的那一点"改派给这一枚（null＝按规范分配） */
  lossTakerId: string | null
  extraLossTakerId: string | null

  /** 9.12g：战后推进单位 id（常规战斗可空＝不推进） */
  advanceUnitIds: string[]
}

/** C6：本场战斗的初始输入（未臆造任何数值：可用 T 由玩家填入 / 由演示补给池带入） */
function createCombatInputs(): CombatInputs {
  return {
    attackerAvailableT: 0,
    attackerUsesInternalStocks: false,
    defenderProvides: true,
    defenderAvailableT: 0,
    defenderUsesInternalStocks: false,
    attackerArUnitId: null,
    defenderArUnitId: null,
    stackTerrain: {},
    defenderTerrain: '',
    optionRetreatHexes: 0,
    optionLossPoints: 0,
    optionLossAllocation: {},
    ignoreOptions: false,
    retreatPaths: {},
    lossTakerId: null,
    extraLossTakerId: null,
    advanceUnitIds: [],
  }
}

/**
 * C7：一次轰炸里的玩家输入（界面 v-model 绑定）
 *
 * 纪律同 C6：本项**只承载玩家的选择**，不含任何规则结论；横移、成本、结果一律由引擎裁决
 * （`barrage-interaction.ts` 的 10.0 通用流程状态机）。
 */
export interface BarrageInputs {
  /** 10.1b：轰炸方可动用的 T（只能来自 SP：同一 HQ 或同一 dump，不含部队储备） */
  availableT: number
  /** 10.1b-A：补给是否来自同一指挥部 */
  fromSameHq: boolean
  /** 10.1b-A：不用指挥部时是否来自同一补给站 */
  fromSameDump: boolean
  /** 10.1b-C：是否动用了部队储备（明令禁止） */
  usedInternalStocks: boolean
  /** 10.0b：是否有正确的观察员（由 `createBarrageFacts` 填，界面只读） */
  hasSpotter: boolean
  /** 10.0a：**目标玩家**选择的地形线（'' = 未选，按不移处理） */
  terrainLine: CombatLine | ''
  /** 10.0e-A：该格本阶段是否已被轰炸过 */
  hexAlreadyBarragedThisPhase: boolean
  /** 10.0b/C：本次是否为低空扫射（须有正确观察员） */
  hipShoot: boolean
  /** 10.0：轰炸骰（战斗单位 2d6 之和；设施 1d6） */
  die: number | null
  /** 10.0a：`1/2` 的取整骰（1–6） */
  halfDie: number | null
  /** 10.0a：损失分配（unitId → 军力点数） */
  losses: Record<string, number>
  /* ── 10.0c 对设施 ── */
  /** 10.0c-A：空军基地当前等级 */
  baseLevel: number
  /** 10.0c-A：目标是否为简易机场（永不降级） */
  isAirstrip: boolean
  /** 10.0c-B：港口既有累计伤害（0–4） */
  portDamageBefore: number
  /** 10.0c-A：格内每架飞机的掷骰（unitId → 1d6） */
  aircraftRolls: Record<string, number>
}

/** C7：本次轰炸的初始输入（数值一律由玩家填入，界面不代猜） */
function createBarrageInputs(): BarrageInputs {
  return {
    availableT: 0,
    fromSameHq: true,
    fromSameDump: false,
    usedInternalStocks: false,
    hasSpotter: false,
    terrainLine: '',
    hexAlreadyBarragedThisPhase: false,
    hipShoot: false,
    die: null,
    halfDie: null,
    losses: {},
    baseLevel: 1,
    isAirstrip: false,
    portDamageBefore: 0,
    aircraftRolls: {},
  }
}

/** 攻守角色名（日志与提示用） */
function roleLabel(role: CombatRole): string {
  return role === 'attacker' ? '攻方' : '守方'
}

/**
 * C8：一条 **SP 持仓**（12.1b：任何含 SP 的位置都是补给站）
 *
 * 本操作台用账本（`spDumps`）代替盘面上的 SP 算子：12.1a 的拆分/找零需要**多枚**等额算子，
 * 拼图式的算子摆放在操作台里无法表达，故以账本为唯一记账处（引擎只看持仓数值，与算子无关）。
 */
export interface SpDump {
  id: string
  hex: HexRef
  side: Side
  /** 整 SP 数 */
  sp: number
  /** 补给指示物数（T） */
  t: number
  /**
   * B32 步骤 5（12.1b / 13.2f）：该来源是**装载在某枚运输算子上**的 SP ⇒ 这里放那枚算子的实例 id
   *
   * 它的 id 形如 "unit:<实例id>"；扣款走 setSpDumpHoldings 的分流（写回该算子的 loadedSpT），
   * 不在 SP 账本里另立条目。
   */
  carriedBy?: string
  /**
   * 13.2g-B：承运算子是不是**编内卡车**（编内卡车 ⇒ 只许**同一多单位编队**内的单位拖取）
   *
   * 判据只有一处：引擎 `canDrawFromCarrier`。常规运输点数不带此项（照 13.2f/12.1b 照常可拖）。
   */
  carrierIsOrganicTruck?: boolean
  /** 13.2g-B：承运算子的编队番号（3.1c；`null` ＝ 无编队 ⇒ 它的 SP 谁都拖不走） */
  carrierFormation?: string | null
}

/**
 * C8：一条**基础补给源**声明（12.6a①②）
 *
 * 来源格来自**专规/剧本**（边缘铁路格、专规列出的补给源格、火车卸货格），单位库里没有该数据，
 * 故由玩家在操作台声明——不臆造。
 */
export interface SupplySourceDecl {
  id: string
  hex: HexRef
  side: Side
  kind: BaseSourceKind
}

/**
 * C8：一次补给交互里的玩家输入（界面 v-model 绑定）
 *
 * 纪律同 C6/C7：本项**只承载玩家的选择**，不含任何规则结论；来源是否可用、要付多少、
 * 能不能吃图上补给一律由引擎裁决（`supply-interaction.ts`）。
 */
export interface SupplyInputs {
  /** 12.1a：本次要拆成 T 的整 SP 数（拆分/找零） */
  spToSplit: number
  /**
   * 12.3：本次拖取/投递的 T 数
   *
   * ★ 批 B 切片 2（裁定⑤）：**只有"数量即内容"的用途才用它**（12.10 补充部队储备 / 13.8 建造费用）；
   *   燃料（12.5）/ 整备（15.1）/ 战斗（12.4）的 T 数由**费率**算（见 `supplyPickupRequirement`）。
   */
  amountT: number
  /** 12.3：用途（燃料/战斗/整备/部队储备/建造） */
  purpose: SupplyPurpose
  /** 12.3b：投递时**实际被扣 SP 的补给站**（HQ 先按 12.3a 从它拖取，再前送） */
  payFromDumpId: string | null
  /** 12.6c/d：断补处置去向 */
  oosAction: OosAction
}

/**
 * C8：本次补给交互的初始输入（数值一律由玩家填入，界面不代猜）
 *
 * ★ 批 B 切片 2：**`forImmediateUse` 这个字段已删** —— 12.3b-A「指挥部只能投递需要立即被使用的
 *   补给」是**规则强制的必答项**（裁定②：不允许预取）⇒ 由 store 恒传 `true`，
 *   不再做成面板上一个"可以取消的勾选框"（取消即被引擎拒，等于给玩家一个必然踩的坑）。
 */
function createSupplyInputs(): SupplyInputs {
  return {
    spToSplit: 0,
    amountT: 1,
    purpose: 'fuel',
    payFromDumpId: null,
    oosAction: 'eatOffTheMap',
  }
}

/** C8：12.6 判定结论的中文名（供界面显示；键为引擎的 `status` 值） */
const SUPPLY_STATUS_LABELS: Record<string, string> = {
  inSupply: '有追溯补给（12.6a）',
  canEatOffTheMap: '无追溯补给，可吃图上补给（12.6c）',
  outOfSupply: '断补（12.6d）',
  notRequired: '不需补给（12.0）',
}

/**
 * C9：空军交互里的玩家输入（界面 v-model 绑定）
 *
 * 纪律同 C6/C7/C8：本项**只承载玩家的选择与骰面**，不含任何规则结论；装备/归属/距离/命中
 * 一律由引擎裁定（`air-interaction.ts`）。
 */
export interface AirInputs {
  /** 14.1f：天气是否允许飞行（受限飞行一律禁飞） */
  flyingAllowed: boolean
  /** 14.7d：天气是否「正常」（专规 3.2a 轴方低空扫射的前提） */
  weatherNormal: boolean
  /** 14.2f-A：任务格（`列.行`文本） */
  targetHexText: string
  /** 14.2f-D：拦截方是否决定拦截（14.5：不强制） */
  interceptDeclared: boolean
  /**
   * 14.3e-B：**任务方点名的迎战机**（从参战飞机中任选一架；null ＝ 交引擎按 ACV 最高自动取）
   *
   * 条文：「防守方（任务方）从参战机中**指定一架**迎战」⇒ 这是玩家的**选择**，不是掷骰，
   * 故 B29 把它透出来（修前 store 里写死"名单第一架"）。
   */
  namedDefenderId: string | null
  /**
   * 14.3e-B：**逐轮点名的参战机**（下标＝第几轮；该轮不给字段 ⇒ 引擎按 ACV 最高自动取）
   *
   * 原文 B：「攻击方选择他的一个**非括号**的空军单位，然后防御方选择**任意一个**他的空军单位；
   * 这些就是**当前战斗轮**中使用的飞机」+ D：「**为每对进行一轮战斗**，直到一方成为唯一的一方」
   * ⇒ 点名是逐轮的玩家选择。攻方**只有非括号机**可选（引擎会拒括号机，见
   * `attackerMustPickNonBracketedAircraft`），守方任选。
   */
  airCombatPicks: { attackerAircraftId: string | null; defenderAircraftId: string | null }[]
  /** 14.2f-D：出动的拦截机实例 id（单架，14.5） */
  interceptorId: string | null
  /** 14.5/14.3e：拦截空战的 2 骰（留空＝自动掷） */
  interceptDie: number | null
  /** 14.3e-C：拦截空战的损失骰（留空＝自动掷） */
  interceptLossDie: number | null
  /** 14.2f-E：防空 2 骰之和（留空＝自动掷） */
  flakDie: number | null
  /** 14.2f-E：14.4f 的损失归属骰（留空＝自动掷） */
  lossDie: number | null
  /** 14.4e：目标格内有 HQ（+1） */
  targetHasHQ: boolean
  /** 14.4e：目标格印刷防空值 */
  printedFlakValue: number
  /** 14.2f-F：任务本身的结果说明（由玩家记入，如 C7 的轰炸结论） */
  missionNote: string
  /** 15.1B：本次整备请求的架数（逐基地操作） */
  refitCount: number
  /**
   * 15.1B：本次整备**勾选的具体飞机**（实例 id；空数组 = 按 `refitCount` 自动取前 N 架）
   *
   * 用户口径：「点机场整备按钮 → 勾选要整备的飞机」⇒ 玩家点的就是这几架。
   */
  refitAircraftIds: string[]
  /** 15.1B：付款补给站（SP 账本条目 id；缺省＝自动取最近可拖取者） */
  refitDumpId: string | null
  /** 14.11：基地转移的目的地（`列.行`文本） */
  transferToHexText: string
  /** 15.4：被指定执行缩减的地面单位实例 id（多不退、少必须补） */
  reductionUnitIds: string[]
  /** 14.2f-G：逐机返航目的地（实例 id → `列.行`文本） */
  returnHexText: Record<string, string>
  /** 14.9a：本次空运/空投装载的 **SP（T）** */
  cargoSpT: number
  /**
   * 14.9f / 15.0b-C 的例外：**超出卸载限额的那部分货物由"在目的地格变为非激活"的运输机承运**
   *
   * 原文：「如果货物超过此限额，**如果超出部分对应的运输机在目的地格变为非激活状态**，则可以卸载
   *   超额部分的货物。」（14.9e-A 的双程飞法即在目的地变非激活）
   */
  unloadOverLimitInactive: boolean
  /** 14.10a：本次空投的**战斗单位**（从己方已摆放单位中勾选） */
  cargoUnitIds: string[]
  /** 14.10a：勾选单位是否标有「空降/Para」标识（本作单位库未印该标识，故由玩家声明） */
  cargoUnitsParaCapable: boolean
  /** 14.10b：空投计划的制定回合（须比执行回合早 ≥2） */
  airdropPlannedTurn: number
  /** 14.10b：计划执行回合 */
  airdropScheduledTurn: number
  /** 14.10d：逐件 2 骰和（留空自动掷；按货物件数依次取用） */
  cargoDice: number | null
  /** 表 17-4：目标格在**本阶段开始时**有己方单位（Friendly 列） */
  targetFriendlyAtPhaseStart: boolean
  /** 14.10e-E：滑翔机降落（+1） */
  gliderLanding: boolean
  /** 可选 21.12e：目标格地形 DRM（0＝不用该可选规则） */
  optionalTerrainDrm: number
  /** 14.10d：目标格内有**敌方战斗单位**（在其上着陆的货物摧毁） */
  enemyCombatUnitInTarget: boolean
  /** 9.14f：本次夺取是否**战后推进**所致（+2 DRM，表 17-6） */
  baseCaptureByAdvance: boolean
  /** 9.14f：逐机 2 骰（留空自动掷） */
  baseCaptureDice: number | null
}

/** C9：本次空军交互的初始输入（数值一律由玩家填入，界面不代猜） */
function createAirInputs(): AirInputs {
  return {
    flyingAllowed: true,
    weatherNormal: true,
    targetHexText: '',
    interceptDeclared: false,
    namedDefenderId: null,
    airCombatPicks: [],
    interceptorId: null,
    interceptDie: null,
    interceptLossDie: null,
    flakDie: null,
    lossDie: null,
    targetHasHQ: false,
    printedFlakValue: 0,
    missionNote: '',
    refitCount: 1,
    refitAircraftIds: [],
    refitDumpId: null,
    transferToHexText: '',
    reductionUnitIds: [],
    returnHexText: {},
    cargoSpT: 0,
    unloadOverLimitInactive: false,
    cargoUnitIds: [],
    cargoUnitsParaCapable: true,
    airdropPlannedTurn: 0,
    airdropScheduledTurn: 0,
    cargoDice: null,
    targetFriendlyAtPhaseStart: true,
    gliderLanding: false,
    optionalTerrainDrm: 0,
    enemyCombatUnitInTarget: false,
    baseCaptureByAdvance: false,
    baseCaptureDice: null,
  }
}

/** C9：14.2e 的任务类型中文名（拦截与基地转移不在「任务分配」入口，另走专用操作） */
const AIR_MISSION_KIND_LABELS: Record<string, string> = {
  barrage: '空军轰炸（14.7b）',
  hip_shoot: '低空扫射（14.7d）',
  trainbusting: '运输破坏（14.8）',
  air_transport: '空运（14.9）',
  air_drop: '空投（14.10）',
  fighter_sweep: '战机扫荡（14.6）',
  base_transfer: '基地转移（14.11）',
  interception: '拦截（14.5）',
}

/** C9：14.1a 激活状态中文名 */
const AIR_STATUS_LABELS: Record<string, string> = {
  active: '激活（14.1a）',
  inactive: '非激活（14.1a）',
}

const DEFAULT_SEED = 20260913

/**
 * 2.1a：补给源关闭判据的地图事实
 *
 * 只依赖产品数据（`map-config.entryHexes` 与图内格清单），**与对局状态无关**，
 * 故放在模块级：这样"安全边剔除已关闭源"与"补给源当日状态"两处用的是同一份事实，
 * 不会因声明顺序产生前向引用。
 */
const SHUTDOWN_FACTS: SupplyShutdownFacts = {
  entryLHexes: (mapConfig.entryHexes?.L ?? []).map((hex) => ({ ...hex })),
  entryEHexes: (mapConfig.entryHexes?.E ?? []).map((hex) => ({ ...hex })),
  // 南缘＝没有图内南邻（奇数列没有第 0 行，故不能用 row === bounds.rowStart）
  isSouthEdge: (hex) => isSouthEdge(hex),
}

/** B37：专规面板的分节标识（与面板里的 6 节一一对应） */
export type ExclusiveSection =
  'panzer' | 'security' | 'hedgehog' | 'constructionMarker' | 'supplyCache' | 'airRestriction'

export const useWorkbenchStore = defineStore('workbench', () => {
  // ── 对局骨架状态（2.2 流程：当前方 / 阶段 / 回合 / 日期） ──
  //
  // ★ 联调（**单一权威**）：有会话时，「当前方 / 阶段 / 回合」以**会话的记录轨 `Records`** 为准，
  //   这里只做投影；无会话时退回本地演练值（未开局也能独立演练，与既有测试口径一致）。
  //   写入方向相反：手动切方 / 切段 / 改回合经 `session.patchRecords` 落回记录轨。
  //   缝法与下方随机数完全一致（读：会话优先；写：有会话则写会话），故两处口径统一。
  const localActiveSide = ref<Side>('axis')
  const localPhase = ref<ConsolePhase>('movement')
  const localTurn = ref(1)

  // ── 随机数（B2：种子入存档、可复算；禁 Math.random） ──
  //
  // ⑭ 接线：**唯一骰源**。会话日志（D2）的重放是「按日志逐条、以 `session.state.rng` 这
  // **同一颗** PRNG 重掷并比对骰面」，故只要开着会话，操作台的掷骰就必须推进会话那颗 PRNG
  // （否则重放读到的是一颗没被用过的 PRNG，必然报分歧）。没有会话时退回操作台自带的演示种子，
  // 未开局也能独立演练。实现上把这三个量做成「读：会话优先；写：有会话则写会话」的读写器，
  // 于是既有的 `rng.value = draw.rng` / `drawCount.value += 1` 写法无需改动即自动走会话。
  const session = useGameSessionStore()
  const localSeed = ref(DEFAULT_SEED)
  const localRng = ref<RngState>(createRngState(DEFAULT_SEED))
  /** 本地演练用的已掷骰次数（有会话时以会话 RNG 的 drawCount 为准） */
  const localDrawCount = ref(0)

  /* ── 联调：流程事实的**投影**（2.2）—— 有会话时读记录轨、无会话时读本地演练值 ── */

  /**
   * 2.2 阶段 → 操作台段（投影口径）
   *
   * 会话的 `GamePhase` 多出两个**没有行动段**的环节：`preTurn`（天气 / 先手判定）与
   * `turnEnd`（回合收束）。操作台的 `ConsolePhase` 只有 A–H 八段，故：
   *   · `preTurn` ⇒ `null`（沿用本地段：判定环节不改变「盘面上现在能做哪一段的事」）；
   *   · `turnEnd` ⇒ 归入 `cleanUp`（收束动作都发生在 H 清理段）。
   */
  function consolePhaseOf(gamePhase: GamePhase): ConsolePhase | null {
    if (gamePhase === 'preTurn') return null
    if (gamePhase === 'turnEnd') return 'cleanUp'
    return gamePhase
  }

  /** 当前方（切方按钮）：决定「谁可以动」与合法性层的行动者判定 */
  const activeSide = computed<Side>({
    get: () => session.records?.activeSide ?? localActiveSide.value,
    set: (next) => {
      if (!session.patchRecords({ activeSide: next })) localActiveSide.value = next
    },
  })

  /** 当前阶段（2.2 SOP 段） */
  const phase = computed<ConsolePhase>({
    get: () => {
      const fromRecords = session.records === null ? null : consolePhaseOf(session.records.phase)
      return fromRecords ?? localPhase.value
    },
    set: (next) => {
      if (!session.patchRecords({ phase: next })) localPhase.value = next
    },
  })

  /**
   * 2.2：本环节**没有行动段**（会话停在 `preTurn` 判定环节）
   *
   * 2.2 流程表里 `preTurn`（天气判定 → 先手判定）**不属于 A–H 任何一段**，此刻玩家手上
   * 没有任何可做的事。而上面 `phase` 的投影在 `preTurn` 时只能撤回本地演练值，开机即
   * 「沿用 `localPhase` 的初值 `movement`」——于是**判定还没做完，移动环节就已经放行**
   * （实测：开局即点单位可走 38 格，而切到 D 补给段同样的单位可走 0 格）。
   *
   * 故此处给出**显式的「无段」**：一切段闸动作（移动 / 轰炸 / 空军 / 增援类 …）
   * 在锁定期间一律拒绝并给 `2.2`，而不是「沿用上一次的段」。
   */
  const segmentLocked = computed<boolean>(() => session.records?.phase === 'preTurn')

  /** 锁定期间统一的拒绝口径（供各段闸入口复用，保证规则号与文案一致） */
  function refuseWhileLocked(action: string): false {
    const reason = `会话停在回合准备环节（天气 / 先手判定），该环节没有行动段（2.2）：不能${action}`
    moveBlocked.value = { rule: '2.2', reason }
    pushLog('warning', reason, '2.2')
    return false
  }

  /** 回合号（1–19，第 1 回合 = 1941-07-08） */
  const turn = computed<number>({
    get: () => session.records?.turn ?? localTurn.value,
    set: (next) => {
      if (!session.patchRecords({ turn: next })) localTurn.value = next
    },
  })

  /**
   * 当前日期（ISO；引擎的时点 / 容量判定都用它）
   *
   * **由回合号派生**（回合轨是唯一来源）：此前 `date` 与 `turn` 是两个各自赋值的量，
   * 一旦有一条路径只改其一就会漂移；改为派生后不可能不一致。
   */
  const date = computed<string>(() => turnDateOf(turn.value))

  const seed = computed<number>({
    get: () => session.session?.state.rng.seed ?? localSeed.value,
    set: (next) => {
      if (session.session === null) {
        localSeed.value = next
        localRng.value = createRngState(next)
      } else {
        session.setSessionRng(createRngState(next))
      }
    },
  })

  /**
   * ⑭ 接线：**已掷未报**的骰子缓冲（`recordSettlement` 消费它）
   *
   * 操作台里有几处是「先掷骰、再交引擎裁决」；若引擎拒绝（步骤不符等），那颗骰子已经消耗掉、
   * 却没有结算条目 —— D2 的重放会因此与实际序列错位。故在**骰源写入**这一唯一收口点
   * 就把本次推进还原成 `DiceRoll` 存进缓冲，由下一笔结算一并入账（顺序即掷骰顺序）。
   */
  const pendingRolls: DiceRoll[] = []

  /**
   * 由「掷骰前 / 掷骰后」两个 RNG 状态还原本次掷出的骰子
   *
   * 操作台的掷骰全部是 `roll1d6` / `roll2d6`（无其它抽取），而 `drawCount` 每枚骰 +1，
   * 故按推进步数即可判定是 1d6 还是 2d6，再用同一颗 PRNG 复算一次取骰面；
   * 复算结果的状态对不上（例如换种子、或罕见的拒绝采样多推了一步）则返回 null，不臆造。
   */
  function detectDraw(prev: RngState, next: RngState): DiceRoll | null {
    if (next.seed !== prev.seed) return null
    const delta = next.drawCount - prev.drawCount
    if (delta !== 1 && delta !== 2) return null
    const candidate = delta === 1 ? roll1d6(prev) : roll2d6(prev)
    return candidate.rng.state === next.state ? candidate.value : null
  }

  const rng = computed<RngState>({
    get: () => session.session?.state.rng ?? localRng.value,
    set: (next) => {
      const drawn = detectDraw(rng.value, next)
      if (drawn !== null) pendingRolls.push(drawn)
      if (session.session === null) localRng.value = next
      else session.setSessionRng(next)
    },
  })
  /**
   * 已掷骰次数（复算用）
   *
   * 有会话时读会话 RNG 的 `drawCount`——引擎的掷骰函数自己会 +1，故 `drawCount.value += 1`
   * 在此等价于「读到最新值」（写入被忽略，避免与引擎重复计数）。
   */
  const drawCount = computed<number>({
    get: () => session.session?.state.rng.drawCount ?? localDrawCount.value,
    set: (next) => {
      if (session.session === null) localDrawCount.value = next
    },
  })

  // ── 摆子 ──
  const units = ref<ConsoleUnit[]>([])
  /** 当前选中的算子实例 id */
  const selectedId = ref<string | null>(null)
  /** 待摆放的单位库记录（从单位列表里点选后进入「摆放模式」） */
  const pendingRecord = ref<UnitRecordView | null>(null)
  /** 工具模式：点地图时做什么（放大镜/摆子/打一仗） */
  const tool = ref<'move' | 'place' | 'battle'>('move')

  // ── 结果与日志 ──
  /** C5：最近一步的展示快照（撤销后为 null） */
  const lastStep = ref<MoveStepSnapshot | null>(null)
  const lastBattle = ref<BattleReport | null>(null)
  const log = ref<WorkbenchLogEntry[]>([])

  // ── C5 移动交互（W4 C5） ──
  /**
   * 本次移动的记账（null = 尚未开始移动）
   *
   * 单位的位置与 MP 始终写在 `units` 上（引擎给出的 patches 由本 store 落盘），
   * 本项只保存「参移名单 + 起始格 + 步骤历史」，**撤销即还原历史快照**。
   */
  const moveInteraction = ref<MoveInteractionState | null>(null)
  /** 悬停格（用于路径与消耗预览） */
  const hoverHex = ref<HexRef | null>(null)
  /** 4.5a-A：待玩家确认的「进入未抵消敌方 ZOC」（确认后从 remainingPath 继续沿路径走） */
  const pendingZocConfirm = ref<{
    to: HexRef
    preview: StepPreview
    /** 以 `to` 为起点的剩余路径（含 `to`），用于确认后继续推进 */
    remainingPath: HexRef[]
  } | null>(null)
  /**
   * 4.5a-A：**本次移动中因进入未抵消敌方 ZOC 而被迫停车**的单位 id
   *
   * 原文（`_ocs_v43_clean.txt:508-515`）：「拥有轮式 MP 类型的单位，在进入一个敌方 ZOC 后，
   * 要么必须在此处**结束移动**，要么必须**进行突袭**。如果选择突袭，则每次突袭后，还能进行
   * 下一次突袭，以此方式单位能连续通过多个 ZOC。」
   *
   * ⇒ 「停车」与「还能突袭」是**同一次移动**里的两个分支，不是互斥的两件事。
   *   停车由 `planStep` 把运行态的 `ended` 置真（→ 状态层 `movementEnded`），
   *   而它同时意味着「这一枚仍被允许改用突袭」——本账本就是那句"仍被允许"的唯一来源：
   *   修前突袭候选只取 `activeMoveUnits`（`movementEnded` 为假者）⇒ 停车后 `overrunTargets`
   *   恒为空，4.5a-A 的后一半**实际不可达**（第六批条 14）。
   */
  const zocStoppedMoveUnitIds = ref<string[]>([])
  /** 是否按堆叠选择（同一格内当前方的全部单位一起移动；6.1） */
  const stackSelect = ref(false)
  /**
   * C5：堆叠取子（6.1 / 8.1g / 8.1h）——点堆叠格后**先选哪几枚开拔**，再由玩家确认
   *
   * 为什么需要它：
   *   - 6.1f 的玩家说明「若想让每个单位分别移动到不同的位置，就不要以堆叠形式开始移动」，
   *     故必须能在开拔前拆分堆叠；
   *   - 8.1h 允许「不参与突袭的友方单位留在格内」，而 `canOverrun` 要求**每一名参突者**都合格
   *     ⇒ 只要整堆叠里混有一枚不可攻击的单位（卡车/炮兵/HQ…），整堆突袭会被整体否决；
   *     能按单位取子才可能按 8.1g/8.1h 只让合格者参突。
   * 非空时界面在堆叠处给出勾选清单；确认后以所选子集 `beginMoveFor`。
   */
  const movePick = ref<{ hex: HexRef; ids: string[] } | null>(null)
  /** 上次移动被拒/受阻的原因（供界面显示） */
  const moveBlocked = ref<{ rule: string; reason: string } | null>(null)
  /**
   * 演示用补给池（12.5c 的 SP / T）
   *
   * 真实补给账本属 B10/B11（追溯补给与补给阶段）；操作台只用它演示「付得出 / 付不出」，
   * 故初值为 0，由玩家在界面填入 —— **不臆造数值**。
   */
  const fuelPool = ref<{ sp: number; t: number }>({ sp: 0, t: 0 })

  // ── 打一仗的选定（9.3b 由防御方选地形；9.6 由双方各选一个参战单位的行动值）──
  /** 已选定的交战国标格（null = 尚未选定） */
  const battleTarget = ref<BattleTarget | null>(null)
  /** 防御方选定的地形（9.3b；选定目标格时先置为「对防御方最有利」的默认值） */
  const battleTerrain = ref<string>('')
  /** 防御方选定的行动值来源单位（9.6；null = 取参战单位中最高者） */
  const battleDefenderArId = ref<string | null>(null)

  // ── C6 战斗交互（W4 C6：9.2 九步流程；引擎状态机在 combat-interaction.ts） ──
  /** 战斗工具的模式：quick＝一键查表（9.9 便捷入口）；full＝9.2 九步完整流程 */
  const battleMode = ref<'quick' | 'full'>('full')
  /** C6：参战攻方单位 id（可跨多个相邻攻击格；9.1b 允许只取堆叠中的一部分） */
  const combatAttackerIds = ref<string[]>([])
  /** C6：战斗交互状态机（null＝未开始） */
  const combatState = ref<CombatInteractionState | null>(null)
  /** C6：最近一次被引擎拒绝的步骤（供界面提示；成功后清空） */
  const combatError = ref<{ rule: string; reason: string } | null>(null)
  /** C6：奇袭骰的骰值（9.8 发生奇袭后须再掷横移骰，故暂存以便第二步复算） */
  const combatSurpriseDie = ref<number | null>(null)
  /** C6：奇袭骰的实掷骰面（W7 C11：复核过程要展示「掷了什么」，只存合计不够） */
  const combatSurpriseRoll = ref<DiceRoll | null>(null)
  /** C6：横移骰的实掷骰面（W7 C11） */
  const combatShiftRoll = ref<DiceRoll | null>(null)
  /** C6：战斗骰（9.9）的实掷骰面（W7 C11） */
  const combatDiceRoll = ref<DiceRoll | null>(null)
  /** C6：等待横移骰（9.8：发生奇袭时须再掷 1 骰） */
  const combatAwaitingShiftDie = ref(false)
  /** C6：玩家在本场战斗里的各项输入（界面 v-model 绑定） */
  const combatInputs = ref<CombatInputs>(createCombatInputs())

  // ── C7 轰炸交互（W5 C7：10.0 通用流程；引擎状态机在 barrage-interaction.ts） ──
  /** C7：轰炸工具是否已开启（点「轰炸」按钮进入；<CombatPanel/> 走九步）*/
  const barrageActive = ref(false)
  /** C7：参炸单位类别（10.0e-F：一次轰炸只能同一类型） */
  const barrageKind = ref<BarrageKind>('artillery')
  /** C7：10.0d 宣布的整体目标（决定用哪张表） */
  const barrageTargetKind = ref<BarrageTargetKind>('combatUnits')
  /** C7：参炸单位 id（当前方，可只取一部分） */
  const barrageUnitIds = ref<string[]>([])
  /** C7：轰炸交互状态机（null＝未开始） */
  const barrageState = ref<BarrageInteractionState | null>(null)
  /** C7：最近一次被引擎拒绝的步骤（供界面提示；成功后清空） */
  const barrageError = ref<{ rule: string; reason: string } | null>(null)
  /** C7：玩家在本场轰炸里的各项输入（界面 v-model 绑定） */
  const barrageInputs = ref<BarrageInputs>(createBarrageInputs())

  /**
   * **10.0e-A/B 的轰炸账本**（按阶段；A 组接线 2026-09-16）
   *
   * 条文：「每格每阶段只允许被轰炸**一次**；**已宣布但被防空/拦截完全摧毁或返航的任务也算**」
   * （10.0e-A）、「一个单位每阶段只能轰炸一次、不能拆分轰炸值」（10.0e-B）。
   *
   * ★ 修前这两条**只靠面板上的一个玩家勾选**自报（`barrageInputs.hexAlreadyBarragedThisPhase`），
   *   不勾就没人拦 ⇒ 同一格/同一单位能在同一个阶段里反复轰炸。
   *   现在由本账本按阶段记账、直接喂给引擎的 `BarrageFacts`（引擎侧的判定位一直在，缺的是喂它的人）。
   *   记账时点＝**付完补给之后**：10.1b 明写「付不出则全部取消，且**不视为已轰炸过**」。
   *   换阶段 / 换回合 / 复位即清空（与 `gaugeConversionsThisPhase` 等同一口径）。
   */
  const barragedHexesThisPhase = ref<string[]>([])
  const barragedUnitIdsThisPhase = ref<string[]>([])

  /** 账本的可读投影（界面上"本阶段已轰炸：N 格 / M 单位"，也是留痕） */
  const barragePhaseLedger = computed(() => ({
    hexes: [...barragedHexesThisPhase.value],
    unitIds: [...barragedUnitIdsThisPhase.value],
  }))

  /**
   * **9.1c 的战斗环节攻击账本**（按环节；与上面 10.0e-A/B 的轰炸账本同族）
   *
   * 条文：「在一个战斗环节中，**同一个单位只能攻击一次，同一格只能被攻击一次**。一个格可以被任意
   * 数量的相邻格攻击，由攻击方玩家决定。」紧接的下一条把**移动环节的突袭**排除在外 ——「在一个移动
   * 环节中，同一个单位可以进行多次突袭，突袭同一个格的次数没有限制」⇒ 本账本只在**常规战斗**上生效
   * （8.1 的突袭不受限），且只在**战斗环节**内有意义。
   *
   * 记账时点＝**战斗补给这一关过了之后**（9.5b：付不出全额就「减少参战单位、动用部队储备、或者根本
   * 不攻击」⇒ 那份被"根本不攻击"作废的战斗不该占掉本环节的这一次；与 10.1b 的轰炸账本同口径）。
   * 换环节 / 换段 / 换方 / 换回合即清空（`clearAttackPhaseLedger`）。
   */
  const attackedUnitIdsThisPhase = ref<string[]>([])
  const attackedHexesThisPhase = ref<string[]>([])

  /** 账本的可读投影（界面"本环节已攻击：N 单位 / M 格"，也是留痕） */
  const attackPhaseLedger = computed(() => ({
    unitIds: [...attackedUnitIdsThisPhase.value],
    hexes: [...attackedHexesThisPhase.value],
  }))
  /** C7：待取整骰（10.0a：`1/2` 结果须再掷 1 骰） */
  const barrageAwaitingHalfDie = ref(false)
  /**
   * C7：**空军算子**（14.1a：摆在**空军基地格**上，其所在格即 10.2b 所说的「它们基地」）
   *
   * 飞机的印值来自 `aircraft.json`（A5 空军专表），与地面算子库（`units-*.json`）分开。
   */
  const airUnits = ref<ConsoleAirUnit[]>([])
  /** C7：参炸**飞机** id（与地面参炸单位分开收集；10.0e-F 的同类型限制由引擎裁决） */
  const barrageAirIds = ref<string[]>([])
  /** C7：摆放飞机的输入（机型 id + 基地格文本 `列.行`） */
  const airPlacement = ref<{ aircraftId: string | null; hexText: string }>({
    aircraftId: null,
    hexText: '',
  })

  // ── B27：通用「待点格」——凡是要一个格号的动作，都在**那一刻**让玩家点地图 ──

  /**
   * B27（用户口径 2026-09-16 #9）：
   * 「目前 UI 里需要玩家输入格子编号的所有项目全改为在该操作发生时玩家点击地图上格子作为选择，
   *   交互一定要简洁、有效、可靠」。
   *
   * 机制只有三件事：
   *   · `beginHexPick`：**由动作自己**声明"现在要选一个格"（用途名、规则号、候选、写回回调）；
   *   · `pickHexFor`：地图点击分派调它 —— 命中候选就写回并收态，否则就地一行提示；
   *   · `cancelHexPick`：Esc / 取消按钮退态。
   *
   * ★ 分层：候选与写回都由 **store 的动作**给出（`beginXxxHexPickNow(...)` 一族），组件只调它们；
   *   于是"这条规则的候选是什么"永远只有一处，组件里不会冒出第二个判据。
   * ★ 候选 `'any'` ＝ 合法性由**引擎在提交时**校验（13.6 的入场格由裁判按卡面判定、
   *   12.1b「任何含 SP 的位置都是补给站」…），此时地图不预筛也不铺高亮，只把"点哪儿"这件事
   *   从手打格号变成点一下。
   */
  type HexPickCandidates = readonly HexRef[] | 'any'

  interface PendingHexPick {
    /** 用途名（界面显示"正在选格：<label>"） */
    label: string
    /** 规则号（提示里带上，玩家知道凭什么） */
    rule: string
    candidates: HexPickCandidates
    /** 命中后写回（返回是否真的写成功；false ⇒ 保留待点态） */
    apply: (hex: HexRef) => boolean
  }

  const pendingHexPick = ref<PendingHexPick | null>(null)

  /** 待点格的界面投影（不含回调；组件只读它画提示与高亮） */
  const hexPickView = computed<{
    label: string
    rule: string
    candidates: HexPickCandidates
  } | null>(() => {
    const pick = pendingHexPick.value
    if (pick === null) return null
    return { label: pick.label, rule: pick.rule, candidates: pick.candidates }
  })

  /** 一句提示（地图内与流程条共用；没有待点态时为空串） */
  const hexPickHint = computed<string>(() => {
    const view = hexPickView.value
    if (view === null) return ''
    const where = view.candidates === 'any' ? '点地图上任意一格' : '点地图上高亮的格'
    return `正在选格：${view.label}（${view.rule}）｜${where}；Esc 取消`
  })

  /** 开始一次待点格（只有本 store 的动作会调） */
  function beginHexPick(pick: PendingHexPick): void {
    pendingHexPick.value = pick
    pushLog('info', `请在**地图上点一格**：${pick.label}（${pick.rule}）`, pick.rule)
  }

  /** 退掉待点态（Esc / 取消按钮） */
  function cancelHexPick(): boolean {
    const pick = pendingHexPick.value
    if (pick === null) return false
    pendingHexPick.value = null
    pushLog('info', `已取消选格：${pick.label}`, '—')
    return true
  }

  /** 格号文本（写回各输入用的统一格式：`列.行`） */
  function hexTextOf(hex: HexRef): string {
    return `${hex.col}.${hex.row}`
  }

  /**
   * 地图点了一格：若正在待点 ⇒ 命中即写回
   *
   * @returns 该次点击是否被待点态消费（false ⇒ 交回常规的地图点击分派）
   */
  function pickHexFor(hex: HexRef): boolean {
    const pick = pendingHexPick.value
    if (pick === null) return false
    const hit =
      pick.candidates === 'any' ||
      pick.candidates.some((candidate) => candidate.col === hex.col && candidate.row === hex.row)
    if (!hit) {
      pushLog(
        'warning',
        `${hexTextOf(hex)} 不是「${pick.label}」的候选格（${pick.rule}）`,
        pick.rule,
      )
      return true
    }
    if (!pick.apply(hex)) return true
    pendingHexPick.value = null
    return true
  }

  /* ── 各动作的待点格入口（B27a：目标状态已在 store 的那些） ── */

  /** 13.6：到达投放的落点（引擎先解算，玩家/裁判可改；改哪格由卡面判定 ⇒ 候选为"任意格"） */
  function beginArrivalHexPickNow(index: number): void {
    beginHexPick({
      label: `增援到达落点（第 ${String(index + 1)} 条）`,
      rule: '13.6',
      candidates: 'any',
      apply: (hex) => {
        setArrivalHexOverride(index, hexTextOf(hex))
        return true
      },
    })
  }

  /** 16.0b/c：环形工事的修建 / 缩减格（合法性由 `planHedgehogBuild` 在提交时判） */
  function beginHedgehogHexPickNow(purpose: 'build' | 'reduce'): void {
    beginHexPick({
      label: purpose === 'build' ? '修建环形工事的格' : '缩减环形工事的格',
      rule: purpose === 'build' ? '16.0b' : '16.0c',
      candidates: 'any',
      apply: (hex) => {
        hedgehogInputs.value = { ...hedgehogInputs.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 12.1b：新增补给站（任何含 SP 的位置都是补给站 ⇒ 候选任意格） */
  function beginSpDumpHexPickNow(): void {
    beginHexPick({
      label: '新补给站所在格',
      rule: '12.1b',
      candidates: 'any',
      apply: (hex) => {
        spDumpDraft.value = { ...spDumpDraft.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 12.6a①②：基础补给源声明（边缘铁路格等，合法性在提交时判） */
  function beginSupplySourceHexPickNow(): void {
    beginHexPick({
      label: '基础补给源所在格',
      rule: '12.6a',
      candidates: 'any',
      apply: (hex) => {
        supplySourceDraft.value = { ...supplySourceDraft.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 13.3a/e：铁路运货的卸货格（13.3f/h 的控制与轨距在提交时判） */
  function beginRailMoveHexPickNow(): void {
    beginHexPick({
      label: '铁路运货的卸货格',
      rule: '13.3a',
      candidates: 'any',
      apply: (hex) => {
        railMoveInputs.value = { ...railMoveInputs.value, toHexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 1.7 / 21.10：花掉补给缓存的位置（须在友方 HQ 处，提交时判） */
  function beginSupplyCacheHexPickNow(): void {
    beginHexPick({
      label: '使用补给缓存的位置',
      rule: '1.7',
      candidates: 'any',
      apply: (hex) => {
        supplyCacheInputs.value = { ...supplyCacheInputs.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 专规 2.3c：方面军预备队的落点（同 13.6 的到达解算） */
  function beginFrontalReservesHexPickNow(): void {
    beginHexPick({
      label: '方面军预备队落点',
      rule: '专规 2.3c',
      candidates: 'any',
      apply: (hex) => {
        frontalReservesInputs.value = {
          ...frontalReservesInputs.value,
          hexText: hexTextOf(hex),
        }
        return true
      },
    })
  }

  /** 14.1a：摆放飞机的空军基地格（候选＝本方**已有的**空军基地格，真能预筛） */
  function beginAirPlacementHexPickNow(): void {
    beginHexPick({
      label: '停放飞机的空军基地格',
      rule: '14.1a',
      candidates: ownAirBases.value.map((base) => ({ col: base.hex.col, row: base.hex.row })),
      apply: (hex) => {
        airPlacement.value = { ...airPlacement.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 14.11：飞机转移的目的地（航程在提交时判） */
  function beginAirTransferHexPickNow(): void {
    beginHexPick({
      label: '飞机转移的目的地',
      rule: '14.11',
      candidates: 'any',
      apply: (hex) => {
        airInputs.value = { ...airInputs.value, transferToHexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 14.1c：返航基地格（留空＝回原起飞基地；合法性在提交时判） */
  function beginAirReturnHexPickNow(aircraftId: string): void {
    beginHexPick({
      label: '返航基地格',
      rule: '14.1c',
      candidates: 'any',
      apply: (hex) => {
        airInputs.value = {
          ...airInputs.value,
          returnHexText: { ...airInputs.value.returnHexText, [aircraftId]: hexTextOf(hex) },
        }
        return true
      },
    })
  }

  /** 15.2A / 15.3：修建空军基地 / 简易机场升格的格（工程兵距离在提交时判） */
  function beginAirBaseHexPickNow(): void {
    beginHexPick({
      label: '修建 / 升格空军设施的格',
      rule: '15.2A / 15.3',
      candidates: 'any',
      apply: (hex) => {
        constructionInputs.value = { ...constructionInputs.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  // ── C8 补给交互与 SP 管理（W5 C8：OCS 12.0 章；引擎状态机在 supply-interaction.ts） ──
  /**
   * C8：补给工具是否已开启
   *
   * ★ 用户口径：正式游戏界面里**必要模块默认开启**（补给是每回合必做的判定，
   * 不该让玩家先找开关）⇒ 默认 `true`。
   */
  const supplyActive = ref(true)
  /** C8：SP 账本（12.1b：含 SP 的位置即补给站；12.1a 的拆分/加总在此逐条结算） */
  const spDumps = ref<SpDump[]>([])
  /** C8：基础补给源声明（12.6a①②；来自专规/剧本，操作台由玩家声明） */
  const supplySourceDecls = ref<SupplySourceDecl[]>([])
  /** C8：正在做补给检查的单位实例 id */
  const supplyUnitId = ref<string | null>(null)
  /** C8：补给交互状态机（null＝未开始） */
  const supplyState = ref<SupplyInteractionState | null>(null)
  /** C8：最近一次被引擎拒绝的步骤（供界面提示；成功后清空） */
  const supplyError = ref<{ rule: string; reason: string } | null>(null)
  /** C8：玩家在本次补给交互里的各项输入（界面 v-model 绑定） */
  const supplyInputs = ref<SupplyInputs>(createSupplyInputs())
  /** C8：界面上悬停预览的来源序号（用于把该来源的覆盖范围画到地图上；null＝用已选来源） */
  const supplyPreviewIndex = ref<number | null>(null)
  /** C8：新增 SP 账本条目的输入（格号文本 + SP/T 数） */
  const spDumpDraft = ref<{ hexText: string; sp: number; t: number }>({ hexText: '', sp: 1, t: 0 })
  /** C8：新增基础补给源声明的输入（格号文本 + 类别） */
  const supplySourceDraft = ref<{ hexText: string; kind: BaseSourceKind }>({
    hexText: '',
    kind: 'supplySourceHex',
  })

  /* ── C8b：D 段**补给阶段总计划**（12.1–12.2 / 12.6 / 12.8 / 12.10e） ── */

  /**
   * 本阶段的补给阶段计划（引擎 `planSupplyPhase` 的结论；null＝尚未载入）
   *
   * 顺序由引擎给死（12.10e-A：**恢复优先于以 SP 代 trace**）：
   *   ① 部队储备强制恢复 → ② 逐单位补给评估（12.6）→ ③ 吃图上补给分配（12.6c）
   *   → ④ 断补标记置/除（12.6d）→ ⑤ 需掷损耗的堆叠（12.8a/b）。
   */
  const supplyPhasePlan = ref<SupplyPhasePlan | null>(null)
  /** 载入计划时的错误（统一形状：rule + reason） */
  const supplyPhaseError = ref<{ rule: string; reason: string } | null>(null)
  /**
   * D 段输入：本阶段可用于「恢复 + 吃图上补给」的 T 与逐单位的"自愿吃图上补给"选择
   *
   * 可用 T 由玩家声明，但**上限是己方补给站的实有量**（12.3a/12.3b 是仅有的两条取补途径，
   * 不存在凭空可用的池子）；落盘时逐站扣减，扣不动即整笔拒绝。
   */
  const supplyPhaseInputs = ref<{ availableT: number; eatOffTheMap: Record<string, boolean> }>({
    availableT: 0,
    eatOffTheMap: {},
  })
  /** 12.11a：本阶段各补给站的销毁尝试次数（每阶段每站只能尝试一次） */
  const dumpDestructionAttempts = ref<Record<string, number>>({})

  /**
   * 12.8b：逐格损耗的**掷骰与分摊**输入（键＝`列.行`）
   *
   * 损耗表要 2 骰 + 修正（格中断补军力 ≥5 时 +3）；结果「代表该堆叠**必须损失的军力点数总量**」，
   * 由拥有者决定哪些断补单位承受（12.8b：**没有**"AR 最高者必须承受"的要求）。
   */
  const attritionInputs = ref<Record<string, { die: number; allocation: Record<string, number> }>>(
    {},
  )
  /** 12.8b：逐格已掷出的损耗结果（供界面显示与分摊校验） */
  const attritionResults = ref<
    Record<
      string,
      { die: number; modifiedDice: number; drm: number; raw: string; losses: AttritionResult }
    >
  >({})

  // ── C9 空军交互（W6 C9：OCS 14.0 / 15.0；引擎状态机在 air-interaction.ts） ──
  /**
   * C9：空军工具是否已开启
   *
   * ★ 用户口径：正式游戏界面里**必要模块默认开启**⇒ 默认 `true`（巡逻区与空军交互随时可用）。
   */
  const airActive = ref(true)
  /** C9：任务类型（14.2e；拦截与基地转移不走此入口） */
  const airMissionKind = ref<AirMissionKind>('barrage')
  /** C9：任务格（14.2f-B 的目标；null＝未定） */
  const airTargetHex = ref<HexRef | null>(null)
  /** C9：参战飞机实例 id（14.2a：一次任务合计 ≤4 架） */
  const airMissionAirIds = ref<string[]>([])
  /** C9：任务交互状态机（14.2f A–G；null＝未开始） */
  const airState = ref<AirInteractionState | null>(null)
  /** C9：最近一次被引擎拒绝的步骤（供界面提示；成功后清空） */
  const airError = ref<{ rule: string; reason: string } | null>(null)
  /** C9：玩家在本次空军交互里的各项输入（界面 v-model 绑定） */
  const airInputs = ref<AirInputs>(createAirInputs())
  /** C9：本阶段已完成整备的基地 id（15.1A：每基地每整备阶段一次） */
  const refitDoneBaseIds = ref<string[]>([])
  /**
   * C9：正在整备的那个基地 id（15.1；null = 没有进行中的整备）
   *
   * 用户口径：「整备阶段点击机场的整备按钮 → 勾选要整备的飞机 → 点地图上高亮的可用补给消耗」
   * ⇒ 本字段就是这个「已点开、正在选飞机 / 选补给」的中间态。
   */
  const refitTargetBaseId = ref<string | null>(null)
  /** C9：本阶段已缩减过的基地 id（15.4：同一友方基地每阶段一次） */
  const reducedBaseIds = ref<string[]>([])
  /** C9：被声明为**简易机场**的基地 id（15.2；本作单位库无独立算子，由玩家声明） */
  const airstripBaseIds = ref<string[]>([])
  /** C9：最近一次整备结论（供界面显示） */
  const lastRefit = ref<BaseRefitPlan | null>(null)
  /** C9：最近一次基地转移结论 */
  const lastTransfer = ref<BaseTransferPlan | null>(null)
  /** C9：最近一次基地缩减结论 */
  const lastReduction = ref<AirBaseReductionPlan | null>(null)

  // ── 派生 ──
  /** 选中的算子 */
  const selectedUnit = computed(
    () => units.value.find((unit) => unit.instanceId === selectedId.value) ?? null,
  )
  /** 当前方可选的单位库记录 */
  const choices = computed(() => unitChoices(activeSide.value))
  /**
   * 13.8b：**架桥生效格**（按归属）——有工程能力的本方单位所在格 + 建造标记的「桥」面
   *
   * 修前 `bridgedCrossing` 在 `src/` 内**零调用**：规则写了、单测测了，但走路时没人用 ⇒
   * 大河/小河永远按原价收费，"HQ 在河边架桥"这条规则整局不生效。这里把它接进移动上下文与战斗事实
   * 的**同一份**判据（"能走过去"与"能打过去"必须同源）。
   * ★ 判据只用**模式级**的 `canEngineer`（`bridgedHexesBySide` 内部），不用 `canEngineerInPhase`：
   *   后者要 `moveContext` 当输入，而本 computed 正是它的一部分（会成环）。
   */
  const bridgedHexes = computed(() =>
    bridgedHexesBySide(
      units.value,
      constructionMarkerPieces.value
        .filter((piece) => piece.kind === 'bridge')
        .map((piece) => piece.hex),
    ),
  )
  /** 当前移动上下文（每次派生都重建，保证与摆子/切方一致） */
  const moveContext = computed(() =>
    buildMoveContext({
      units: units.value,
      activeSide: activeSide.value,
      // F 战斗段与 A 整备段没有移动环节（2.2）：映射为 movement 只为给 computed 一个合法值，
      // 移动本身已在 moveOneStep 里按非移动段明确拦下。
      phase: movementPhaseOf(phase.value),
      // 专规 1.1b：敌方安全边缘格（作为补给源的地图边格）不得被敌方地面单位进入
      safeEdgeHexesBySide: safeEdgeHexesBySide.value,
      // 13.8b：架桥（与 createBattleFacts 同一份，见上面的 computed）
      bridgedHexesBySide: bridgedHexes.value,
      /*
       * 5.8b：战略模式单位**必须**在有追溯补给的格上结束移动。
       * 引擎的判据写在 `move.ts`，但要求调用方注入 `traceSupplyAt` —— 不注入则那条 if
       * 永远进不去（修前实测：战略模式单位可以随便停在断补格）。
       * 这里注入的是与 12.6 同一份事实（`createTraceSupplyAt(supplyFacts)`，见 C9 段）。
       */
      traceSupplyAt: (hex, side) => traceSupplyAtForMove.value(hex, side),
    }),
  )
  /** 已选定交战的守方单位（9.3b/9.6 用；按实例 id 保持摆放顺序） */
  const battleDefenders = computed<ConsoleUnit[]>(() => {
    const target = battleTarget.value
    if (target === null) return []
    return target.defenderIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
  })

  /* ── C6 战斗交互：派生（一切结论来自引擎；此处只做视图整形） ── */

  /**
   * C6：参战攻方单位
   *
   * 未开始时＝玩家点选集合（9.1b 可取堆叠的一部分）；已开始时＝构成锁定后的名单
   * （9.5b 允许在付不出全额补给时**减少参战单位**，故以 `composition` 为准）。
   */
  const combatAttackers = computed<ConsoleUnit[]>(() => {
    const state = combatState.value
    const ids = state === null ? combatAttackerIds.value : state.composition.attackerIds
    return ids
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
  })

  /** C6：防御方阵营（9.4e 的 AT 判定只取该方单位；攻方即当前方，故守方为其对手） */
  const combatDefenderSide = computed<Side>(() => {
    const first = battleDefenders.value[0]
    if (first !== undefined) return first.side
    return activeSide.value === 'axis' ? 'soviet' : 'axis'
  })

  /** C6：攻方/守方单位视图（引擎 `BattleUnitView`；随落盘自动刷新） */
  const combatAttackerViews = computed<BattleUnitView[]>(() =>
    combatAttackers.value.map(toBattleUnitView),
  )
  const combatDefenderViews = computed<BattleUnitView[]>(() =>
    battleDefenders.value.map(toBattleUnitView),
  )

  /** C6：战斗事实（9.1f/9.4b/9.4c/9.4e/9.9）——取自地图产物与单位库，不臆造 */
  const combatFacts = computed(() =>
    createBattleFacts({
      units: units.value,
      defenderSide: combatDefenderSide.value,
      // 13.8b：与 moveContext 用**同一份**架桥格（否则"能走过去"与"能打过去"会不一致）
      bridgedHexesBySide: bridgedHexes.value,
      /*
       * 9.1c：本战斗环节的攻击账本 ⇒ 引擎在 `beginCombat` 里拒"同一单位第二次攻击 / 同一格第二次被攻击"。
       * 账本是 store 事实（引擎不持状态），故在这里喂进去——**判据只有一处**，界面不另写一份。
       */
      attackedUnitIdsThisSegment: attackedUnitIdsThisPhase.value,
      attackedHexesThisSegment: attackedHexesThisPhase.value,
    }),
  )

  /** C6：9.2 九步清单（含本步已否；供界面按规则顺序提示） */
  const combatChecklist = computed(() =>
    combatState.value === null ? [] : stepChecklist(combatState.value),
  )

  /** C6：当前该由哪一方结算（9.10b：攻方先、守方后） */
  const combatResolver = computed<CombatRole | null>(() =>
    combatState.value === null ? null : currentResolver(combatState.value),
  )

  /** C6：本步所需的强制损失点数与选项点数（当前结算方） */
  const combatRequirement = computed<{
    side: CombatRole
    losses: number
    options: number
  } | null>(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined) return null
    const side = currentResolver(state)
    return {
      side,
      losses: lossesOf(state.dice.result, side),
      options: optionsOf(state.dice.result, side),
    }
  })

  /**
   * C6：当前结算方的**规范损失分配**（9.11c）
   *
   * 9.11c 的两条限制（AR 单位先受第一点；每人各受一点后才有人受第二点）在给定各单位军力后
   * 唯一确定分布，故界面直接展示引擎给出的规范值（9.11a 的「拥有者选择」在此只剩确认）。
   */
  const combatCanonicalLosses = computed<{ unitId: string; steps: number }[]>(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined) return []
    const stage = state.resolution.stage
    if (stage !== 'attackerLosses' && stage !== 'defenderLosses') return []
    const side = currentResolver(state)
    const views = side === 'attacker' ? combatAttackerViews.value : combatDefenderViews.value
    const arUnitId = side === 'attacker' ? state.ar?.attackerUnitId : state.ar?.defenderUnitId
    return allocateBattleLosses({
      required: lossesOf(state.dice.result, side),
      units: views.map((unit) => ({ id: unit.id, steps: unit.steps })),
      ...(arUnitId === undefined ? {} : { arUnitId }),
    }).allocation
  })

  /**
   * 9.11a（批 F 切片 2）：**能把"多受的那一点"改派给谁**（拥有者的选择权）
   *
   * 原文：「**在 9.11c 的限制范围内**，由**拥有者玩家**决定由哪个或哪些单位承受军力损失」；
   * 9.11c 的两条约束是"AR 单位先受第一点"与"各受一点之后才有人受第二点"。
   * ⇒ 当规范分配里**某单位受 2 点**而有**别的单位只受 1 点**时，把那一点**换一枚单位承受**
   *   （两枚互换点数）仍是合规分配 —— 这就是玩家可选的余地。
   * 候选＝「规范分配里点数＝最多者 − 1」的那些单位（互换后步数多重集不变）；没有这种单位时为空。
   */
  const combatLossSwapChoices = computed<{ unitId: string; label: string }[]>(() => {
    const canonical = combatCanonicalLosses.value
    if (canonical.length === 0) return []
    const max = Math.max(...canonical.map((item) => item.steps))
    if (max < 2) return []
    const extras = canonical.filter((item) => item.steps === max)
    // 多受者只有一枚时，"改成谁"＝点数＝max−1 的那些单位；多受者有多枚时，让玩家在多受者之间对调没有意义 ⇒ 仍给 max−1 的候选
    return canonical
      .filter((item) => item.steps === max - 1 && item.steps >= 1)
      .filter((item) => !extras.some((extra) => extra.unitId === item.unitId))
      .map((item) => ({ unitId: item.unitId, label: nameOf(item.unitId) }))
  })

  /**
   * 9.11a：把规范分配按"玩家指定的承受者"改派 —— 从**点数最多**的那一枚移一点给指定单位
   *
   * 只做"平移一点"（不改总量、不改多重集），故一定满足 9.11c 的两条约束；
   * 引擎侧仍会再校验一遍（`validateBattleLossAllocation`），界面不代它下结论。
   */
  function combatLossAllocationNow(): { unitId: string; steps: number }[] | undefined {
    const canonical = combatCanonicalLosses.value
    const chosen = combatInputs.value.lossTakerId
    if (chosen === null || canonical.length === 0) return undefined
    if (!combatLossSwapChoices.value.some((item) => item.unitId === chosen)) return undefined
    const max = Math.max(...canonical.map((item) => item.steps))
    const extra = canonical.find((item) => item.steps === max)
    if (extra === undefined) return undefined
    return canonical.map((item) => {
      if (item.unitId === extra.unitId) return { ...item, steps: item.steps - 1 }
      if (item.unitId === chosen) return { ...item, steps: item.steps + 1 }
      return { ...item }
    })
  }

  /** C6：CRT 结果摘要（9.9；可直接显示） */
  const combatSummary = computed(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined) return null
    const result = state.dice.result
    return {
      die: state.dice.die,
      modifiedDice: state.dice.modifiedDice,
      raw: result.raw,
      terrainLine: state.odds?.terrain.combatLine ?? '',
      ratio: state.surprise?.finalColumnLabel ?? state.odds?.oddsLabel ?? '',
      surprise: state.surprise ?? null,
      attacker: {
        losses: lossesOf(result, 'attacker'),
        options: optionsOf(result, 'attacker'),
        exploit: result.attacker.exploitationAR,
        optionTaken: state.resolution.attacker.option ?? null,
      },
      defender: {
        losses: lossesOf(result, 'defender'),
        options: optionsOf(result, 'defender'),
        dg: result.defender.disorganized,
        optionTaken: state.resolution.defender.option ?? null,
        ignorable: state.resolution.defender.optionIgnorable === true,
        ignored: state.resolution.defender.optionIgnored === true,
      },
    }
  })

  /**
   * C6：本次战斗的**结算复核过程**（W7 C11）
   *
   * 奇袭已判 ⇒ 给奇袭段；战斗骰已掷 ⇒ 给战斗段（含取列与查表）。
   * 逐项字段全部取自引擎已算出的结论（`state.ar` / `state.odds` / `state.surprise` / `state.dice`），
   * 骰面取自本 store 的真实掷骰记录 —— 界面据此展开复核，不重算任何规则。
   */
  const combatReview = computed<Derivation | null>(() => {
    const state = combatState.value
    if (state === null) return null

    if (state.dice !== undefined) {
      const ar = state.ar
      return combatDerivation({
        roll: combatDiceRoll.value,
        die: state.dice.die,
        attackerAr: ar?.attackerAr ?? 0,
        attackerArSource: ar === undefined ? '未指定' : `攻方 AR 单位 ${nameOf(ar.attackerUnitId)}`,
        defenderAr: ar?.defenderAr ?? 0,
        defenderArSource: ar === undefined ? '未指定' : `守方 AR 单位 ${nameOf(ar.defenderUnitId)}`,
        hedgehogLevel: state.hedgehogLevel,
        modifiedDice: state.dice.modifiedDice,
        raw: state.dice.result.raw,
        terrainLine: state.dice.result.terrainLine,
        columnLabel: state.surprise?.finalColumnLabel ?? state.odds?.columnLabel ?? '',
        ...(state.odds === undefined ? {} : { oddsLabel: state.odds.oddsLabel }),
        ...(state.odds === undefined ? {} : { terrain: state.odds.terrain.defenderTerrain }),
        ...(state.odds === undefined
          ? {}
          : {
              attackerStrength: state.odds.attackerTotal,
              defenderStrength: state.odds.defenderTotal,
              attackerStrengthById: state.odds.attackerStrengthById.map((item) => ({
                unitId: item.unitId,
                strength: item.strength,
              })),
            }),
      })
    }

    if (state.surprise !== undefined) {
      return surpriseDerivation({
        roll: combatSurpriseRoll.value,
        die: combatSurpriseDie.value ?? 0,
        arDifferential: state.ar?.drm ?? 0,
        defenderInHedgehog: state.defenderInHedgehog,
        side: state.surprise.side,
        shiftRoll: combatShiftRoll.value,
        shift: state.surprise.shift,
      })
    }

    return null
  })

  /** C6：攻方/守方的 AR 候选（9.6：每方只能选一个参战单位） */
  const combatAttackerArOptions = computed(() =>
    combatAttackers.value.map((unit) => ({
      id: unit.instanceId,
      label: `${unit.name}（AR${unit.raw.ar}${unit.mode.dg ? '，DG−1' : ''}）`,
    })),
  )
  const combatDefenderArOptions = computed(() =>
    battleDefenders.value.map((unit) => ({
      id: unit.instanceId,
      label: `${unit.name}（AR${unit.raw.ar}${unit.mode.dg ? '，DG−1' : ''}）`,
    })),
  )

  /**
   * 专规 2.3b：守方堆叠内是否有 **NKVD 边防团**（有则行动值单位必须由它担任）
   *
   * 取引擎的 `nkvdArRequired`（判据即 2.3b 的强制候选集）；并据此把**候选表收窄到那几个单位**——
   * 界面上于是根本选不出违规的行动值单位（权威否决仍是引擎的 `checkDefenderArChoice`）。
   */
  const nkvdArRequiredNow = computed<boolean>(() =>
    nkvdArRequired(combatNkvdDefenders.value.map(toNkvdDefenseView)),
  )

  /** 2.3b：守方**可选的**行动值单位（被迫时只剩 NKVD 边防团） */
  const combatDefenderArChoices = computed(() =>
    nkvdArRequiredNow.value
      ? combatDefenderArOptions.value.filter((option) =>
          combatNkvdDefenders.value.some((unit) => unit.instanceId === option.id),
        )
      : combatDefenderArOptions.value,
  )

  /**
   * B30：**默认的行动值单位**（9.6；用户口径 2026-09-16 #19「可选的前提下默认选交战双方 AR 最高的单位」）
   *
   * 判据只有一条：取该方**可选集合**里 `raw.ar` 最大者（并列取先，与引擎的 `pickHighestAcv` 同口径）。
   * 守方走 `combatDefenderArChoices`——那一条已经把专规 2.3b（NKVD 在场时行动值单位必须由它担任）
   * 收窄过了，故默认值天然合法。
   */
  function defaultArUnitIdOf(side: CombatRole): string | null {
    const rows = side === 'attacker' ? combatAttackerArOptions.value : combatDefenderArChoices.value
    const pool = rows
      .map((row) => units.value.find((unit) => unit.instanceId === row.id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
    if (pool.length === 0) return null
    return pool.reduce((best, unit) => (unit.raw.ar > best.raw.ar ? unit : best), pool[0]!)
      .instanceId
  }

  /** C6：守方格的地形候选（9.4c：**只能**格内地形） */
  const combatDefenderTerrainOptions = computed<string[]>(() => {
    const target = battleTarget.value
    if (target === null) return []
    return [...combatFacts.value.hexTerrainsAt(target.hex)]
  })

  /**
   * C6：逐攻击堆叠的地形候选（9.4b）
   *
   * 「可以是**防御格内**的地形（如山丘或树林），或者是该堆叠的**攻击穿越的格边地形**」——
   * 故候选 = 防御格内地形 ∪ 该堆叠与防御格之间的格边地形（二者只能选其一，不累计）。
   */
  const combatStackTerrainOptions = computed<
    { key: string; label: string; options: { kind: 'hex' | 'hexside'; terrain: string }[] }[]
  >(() => {
    const target = battleTarget.value
    if (target === null) return []
    return combatAttackers.value.map((unit) => ({
      key: hexLabel(unit.hex),
      label: `${hexLabel(unit.hex)}（${unit.name}）`,
      options: [
        ...combatDefenderTerrainOptions.value.map((terrain) => ({
          kind: 'hex' as const,
          terrain,
        })),
        ...hexsideTerrainNames(unit.hex, target.hex).map((terrain) => ({
          kind: 'hexside' as const,
          terrain,
        })),
      ],
    }))
  })

  /**
   * B33（9.12g-D）：这次的战后推进是不是**强制**的
   *
   * 突袭成功后**必须**推进（规则原文 9.12g-D）；常规战斗由拥有者选择（可都不推）。
   * 界面据此隐藏「不推进」，并把按钮改成"必须推进并收束"。
   */
  const combatAdvanceMandatory = computed<boolean>(() => {
    const state = combatState.value
    if (state === null) return false
    return state.attackType === 'overrun'
  })

  /**
   * C6：**仍在进行中的**战斗步（已收束 ⇒ null）—— 界面渲染战斗块时只读它
   *
   * 为什么需要它（2026-09-18 修，用户报「战斗框里的『确认推进并收束』点了没反应、会话框一直在」）：
   * 引擎在推进步把 `finished` 置真，但**刻意不改写 `step`**（仍是 `advance`，历史与既有用例都依赖它）——
   * 于是"按 `combatState?.step` 渲染"的就近小窗会在战斗**已收束**之后继续挂着推进块与收束按钮；
   * 再点一次只是把同一笔推进又跑一遍（幂等、界面无变化）⇒ 看起来"点了没反应"。
   * ★ 判据只有这一处：`combatState === null || finished ⇒ null`。
   */
  const combatLiveStep = computed<CombatStep | null>(() => {
    const state = combatState.value
    if (state === null || state.finished) return null
    return state.step
  })

  /** C6：需要撤退的格数（9.12：撤退格数＝剩余选项数） */
  const combatRetreatRequirement = computed(() => {
    const state = combatState.value
    if (state === null) return { attacker: 0, defender: 0 }
    return {
      attacker: state.resolution.attacker.option?.retreatHexes ?? 0,
      defender: state.resolution.defender.option?.retreatHexes ?? 0,
    }
  })

  /*
   * ★ 已删（2026-09-16）`combatRetreatingUnits`：它是给战斗面板那一列 `列.行,列.行` 文本框
   *   准备的扁名单。撤退改成**地图点格**后（用户口径），面板读的是 `combatRetreatPlans`
   *   （含每人的候选落点与已选落点），这份只够显示名字的名单没有调用方了 ⇒ 删掉，
   *   免得留一条"无人使用的第二口径"。
   */

  /**
   * 9.12f：**战斗开始时**的盘面快照（格/归属/是否战斗单位）——「撤退不可穿越战斗开始时含敌方
   * 战斗单位的格」的唯一依据（因此不能穿越攻方承受损失或选项后腾空的格）
   */
  const combatStartSnapshot = ref<
    { hex: HexRef; side: Side; isCombat: boolean; instanceId: string; name: string }[]
  >([])

  /** 拍下 9.12f 的战斗开始快照（9.2 第 1 步成立时调用；此后任意损失都不影响它） */
  function captureCombatStartSnapshot(): void {
    combatStartSnapshot.value = units.value.map((unit) => ({
      hex: { col: unit.hex.col, row: unit.hex.row },
      side: unit.side,
      isCombat: unit.isCombat,
      instanceId: unit.instanceId,
      name: unit.name,
    }))
  }

  /** C6（9.12d）：已点选「加入撤退」的跟随者（未参战战斗单位 / 编内卡车） */
  const combatTagalongIds = ref<string[]>([])

  /**
   * C6（9.12d）：**可以跟随撤退**的候选
   *
   * 「未参加战斗的战斗单位和编内卡车可以在它们所在格中加入撤退」⇒ 候选须同时满足：
   *   ① 与该方某一**参战撤退单位同格**；② 不是参战者本人；③ 是战斗单位或编内卡车
   *   （`canJoinRetreat`，其余非战斗单位必须留在原格）。
   */
  const combatTagalongCandidates = computed<
    { unit: ConsoleUnit; side: CombatRole; hostId: string; hostLabel: string }[]
  >(() => {
    const state = combatState.value
    if (state === null) return []
    const out: { unit: ConsoleUnit; side: CombatRole; hostId: string; hostLabel: string }[] = []
    for (const side of ['attacker', 'defender'] as const) {
      if (!needsRetreat(state, side)) continue
      const stack = side === 'attacker' ? combatAttackers.value : battleDefenders.value
      const participantIds = new Set(stack.map((unit) => unit.instanceId))
      for (const unit of units.value) {
        if (participantIds.has(unit.instanceId)) continue
        if (!canJoinRetreat(unit).ok) continue
        const host = stack.find(
          (item) => item.hex.col === unit.hex.col && item.hex.row === unit.hex.row,
        )
        if (host === undefined) continue
        out.push({ unit, side, hostId: host.instanceId, hostLabel: host.name })
      }
    }
    return out
  })

  /** C6（9.12d）：加入/移出「跟随撤退」名单 */
  function toggleCombatTagalong(unitId: string): void {
    if (combatTagalongIds.value.includes(unitId)) {
      combatTagalongIds.value = combatTagalongIds.value.filter((id) => id !== unitId)
      return
    }
    const candidate = combatTagalongCandidates.value.find((item) => item.unit.instanceId === unitId)
    if (candidate === undefined) {
      pushLog('warning', '该单位不能跟随撤退（9.12d：仅未参战战斗单位与编内卡车可加入）', '9.12d')
      return
    }
    combatTagalongIds.value = [...combatTagalongIds.value, unitId]
    pushLog(
      'info',
      `${candidate.unit.name} 加入撤退（9.12d：与 ${candidate.hostLabel} 同格，随该堆叠一起撤）`,
      '9.12d',
    )
  }

  /** C6：撤退事实（9.12/9.12b/9.12e/9.12f；注入引擎） */
  const combatRetreatFacts = computed<RetreatFacts>(() => {
    const state = combatState.value
    const retreating: string[] = []
    if (state !== null) {
      if (needsRetreat(state, 'attacker')) retreating.push(...state.composition.attackerIds)
      if (needsRetreat(state, 'defender')) retreating.push(...state.composition.defenderIds)
    }
    // 9.12d：跟随撤退的单位也参与「撤退中的这一堆」
    retreating.push(...combatTagalongIds.value)
    return createRetreatFacts({
      units: units.value,
      context: moveContext.value,
      retreatingUnitIds: retreating,
      // 9.12f：用「战斗开始时」的快照判「该格当时是否有敌方战斗单位」
      combatStartSnapshot: combatStartSnapshot.value,
    })
  })

  /** C6：防御格是否已空（9.12g：全被消灭或撤退才可推进） */
  const combatDefendingHexCleared = computed(() => {
    const target = battleTarget.value
    if (target === null) return false
    return !units.value.some(
      (unit) =>
        unit.side === combatDefenderSide.value &&
        unit.isCombat &&
        unit.steps > 0 &&
        unit.hex.col === target.hex.col &&
        unit.hex.row === target.hex.row,
    )
  })

  /** C6：可推进的候选单位（9.12g-A：只有付了战斗补给的攻击单位才能推进；9.12b：不可移动者不能） */
  const combatAdvanceCandidates = computed<
    { id: string; label: string; paid: boolean; immobile: boolean }[]
  >(() => {
    const state = combatState.value
    if (state === null) return []
    const paid = state.supply?.attacker.paid === true
    return combatAttackers.value.map((unit) => ({
      id: unit.instanceId,
      label: unit.name,
      paid,
      // 9.12b 末句：在任何模式下都不可移动的单位也无法战后推进
      immobile: combatRetreatFacts.value.immobile(unit.instanceId),
    }))
  })

  /**
   * B14c（用户口径⑪）：**战后推进**的算子图阵列数据（9.12g-A / 9.12b 的两条否决转成人话）
   *
   * 候选就是 `combatAdvanceCandidates`（`paid` / `immobile` 两个事实已经算好），
   * 本 getter 只把两条否决翻成给玩家看的原因：
   *   · **9.12g-A** 未付战斗补给的单位不得推进（含战斗值为零者）；
   *   · **9.12b** 末句「在任何模式下都不可移动的单位」也不得推进。
   * 两条否决都由引擎在 `confirmCombatAdvance` 里裁定（灰显只是提前告知）。
   */
  const combatAdvanceChoices = computed<
    readonly { unit: ConsoleUnit; selected: boolean; disabledReason: string | null }[]
  >(() =>
    combatAdvanceCandidates.value.flatMap((candidate) => {
      const unit = units.value.find((item) => item.instanceId === candidate.id)
      if (unit === undefined) return []
      return [
        {
          unit,
          selected: combatInputs.value.advanceUnitIds.includes(candidate.id),
          disabledReason: !candidate.paid
            ? '9.12g-A：该单位未付战斗补给 ⇒ 不得推进'
            : candidate.immobile
              ? '9.12b：在任何模式下都不可移动的单位不得推进'
              : null,
        },
      ]
    }),
  )

  /* ──────────── W7 C16：战斗收尾的**地图优先**交互（撤退落点 / 推进格 / 补给站） ──────────── */

  /**
   * 9.12g：战后推进格（防御格已清空 ⇒ 攻方可推进到这里；否则 null）
   *
   * 数据来源：`combatDefendingHexCleared`（9.12g 的「全被消灭或撤退」事实）+ 选定的防御格坐标；
   * 是否**可以**推进仍由引擎 `resolveAdvance` 在下一步裁决（本项只是把它画到地图上）。
   * 专规 1.1b：防御格若是敌方安全边缘格（补给源边格）⇒ 不可进入，故不给推进格。
   */
  const combatAdvanceHex = computed<HexRef | null>(() => {
    const target = battleTarget.value
    if (target === null) return null
    if (!combatDefendingHexCleared.value) return null
    const hex = { col: target.hex.col, row: target.hex.row }
    if (isEnemySafeEdgeHex(moveContext.value, hex, activeSide.value)) return null
    return hex
  })

  /** 9.12：某方需撤退的单位的落点规划（地图优先交互数据源） */
  const combatRetreatPlans = computed<CombatRetreatSidePlan[]>(() => {
    const state = combatState.value
    if (state === null) return []
    const plans: CombatRetreatSidePlan[] = []
    for (const side of ['attacker', 'defender'] as const) {
      // 9.12c/9.12e：攻方先撤、守方后撤；该方撤退格数为 0 则不参与
      if (!needsRetreat(state, side)) continue
      const record = side === 'attacker' ? state.resolution.attacker : state.resolution.defender
      const distance = record.option?.retreatHexes ?? 0
      if (distance <= 0) continue
      const sideUnits = side === 'attacker' ? combatAttackers.value : battleDefenders.value
      const rows: CombatRetreatUnitPlan[] = sideUnits.map((unit) => {
        const escaped = combatInputs.value.retreatPaths[unit.instanceId] ?? ''
        const chosen = parseHexPath(escaped)
        return {
          unitId: unit.instanceId,
          label: unit.name,
          from: { col: unit.hex.col, row: unit.hex.row },
          chosen: chosen.length > 0 ? chosen[chosen.length - 1]! : null,
          destinations: planRetreatDestinations({
            from: unit.hex,
            distance,
            mobility: effectiveMobilityOf(unit),
            side: unit.side,
            facts: combatRetreatFacts.value,
            immobile: combatRetreatFacts.value.immobile(unit.instanceId),
          }),
        }
      })
      // 地图上画「该方能退到哪」的并集：安全格 / 有 ZOC 影响格 / 选了会被消灭的格
      const safe: HexRef[] = []
      const zoc: HexRef[] = []
      const doomed: HexRef[] = []
      for (const row of rows) {
        for (const destination of row.destinations) {
          const bucket = destination.forcedDestruction
            ? doomed
            : destination.inEnemyZoc
              ? zoc
              : safe
          if (!bucket.some((hex) => sameHex(hex, destination.hex))) bucket.push(destination.hex)
        }
      }
      // 9.12d：跟随者（随其同格宿主一起撤；路径自动沿用宿主）
      const tagalongs: CombatRetreatTagalongPlan[] = combatTagalongIds.value.flatMap((id) => {
        const candidate = combatTagalongCandidates.value.find(
          (item) => item.unit.instanceId === id && item.side === side,
        )
        return candidate === undefined
          ? []
          : [
              {
                unitId: candidate.unit.instanceId,
                label: candidate.unit.name,
                hostId: candidate.hostId,
                hostLabel: candidate.hostLabel,
              },
            ]
      })
      plans.push({
        side,
        distance,
        units: rows,
        tagalongs,
        complete: rows.every((row) => row.chosen !== null),
        safe,
        zoc,
        doomed,
      })
    }
    return plans
  })

  /*
   * ★ 已删（2026-09-16）`combatRetreatSide`：它取 `combatRetreatPlans[0]`（永远是攻方），
   *   而界面真正该跟着走的是「**第一个未选齐的一方**」（`map-view.retreatSidePlan`）——
   *   两个口径并存时，攻方选齐后"地图已切到守方、小窗还列攻方"。现在只留一处（在 map-view）。
   */

  /**
   * C16：战斗补给按方给出的**可动用补给站**
   *
   * 条文（12.4 前段）：「**直接拖取(12.3a)和指挥部投递(12.3b)都可用于接收及分配战斗补给(9.5)**」
   * ⇒ 该方在**本战斗格**能取到的 SP 来源有两类：
   *   - **12.3a 直接拖取**：本格（或其相邻格，12.3c）在拖取距离内能直接拖到的补给站；
   *   - **12.3b HQ 投递**：本方可投递的 HQ 能拖到、且能把补给**投递到本格**的那些补给站
   *     （HQ 自身须能拖取、非战略模式、且非"由别的 HQ 投递获得"，12.3b-C/D）。
   *
   * ★ 原实现只写「该方**全部**补给站」：既不校验距离（可在全图任意远处付款，违反 12.3a），
   *   也**完全漏掉 HQ 投递**这条合法途径。
   */
  const combatSupplyDumps = computed<{ side: CombatRole; dumps: SpDump[] }[]>(() => {
    const defenderSide = combatDefenderSide.value
    const attackerSide = activeSide.value

    /**
     * 该方在本次战斗能动员的补给站（12.3a ∪ 12.3b；13.2g-B 的编内卡车资格同样在 `deliverableDumpsFor` 里）
     *
     * ★ G②（2026-09-19）：改用**受益单位**（参战的那一叠）而不是"防御格及其邻格"作锚点 ——
     *   12.3b 的投递距离是"从指挥部到**需要补给的部队**处"算的，且 13.2g-B 的编队资格也是**按单位**写的。
     *   修前那版还会让非同编队的同伴蹭到编内卡车上的油（用 `some` 判"堆叠里有没有同编队单位"）。
     */
    const fundableDumps = (side: Side): SpDump[] =>
      deliverableDumpsFor(side, combatBeneficiariesOf(side))

    return [
      { side: 'attacker' as const, dumps: fundableDumps(attackerSide) },
      { side: 'defender' as const, dumps: fundableDumps(defenderSide) },
    ]
  })

  /** C16：已点选为战斗补给来源的补给站 id（null＝未选） */
  const combatSupplyDumpIds = ref<{ attacker: string | null; defender: string | null }>({
    attacker: null,
    defender: null,
  })

  /**
   * C16：点地图上的某个撤退落点 ⇒ 为该单位写入 9.12 撤退路径
   *
   * 路径由引擎 `planRetreatDestinations` 给出（单调走法，长度恰等于完整撤退距离），
   * 本函数只把它写成 `combatInputs.retreatPaths` 的文本（与手填格号走的是同一条输入）。
   */
  function setRetreatDestinationNow(unitId: string, hex: HexRef): boolean {
    for (const plan of combatRetreatPlans.value) {
      const row = plan.units.find((item) => item.unitId === unitId)
      if (row === undefined) continue
      const destination = row.destinations.find((item) => sameHex(item.hex, hex))
      if (destination === undefined) {
        pushLog(
          'warning',
          `${hexLabel(hex)} 不是 ${row.label} 的合法撤退落点（9.12：落点须在完整撤退距离上、且路径可走）`,
          '9.12',
        )
        return false
      }
      combatInputs.value = {
        ...combatInputs.value,
        retreatPaths: {
          ...combatInputs.value.retreatPaths,
          [unitId]: destination.path.map((item) => hexLabel(item)).join(','),
        },
      }
      pushLog(
        'info',
        `${row.label} 撤退至 ${hexLabel(hex)}（${plan.distance} 格）` +
          (destination.inEnemyZoc ? '；该格在敌方 ZOC 内 ⇒ 进入即 DG（9.12e）' : ''),
        '9.12',
      )
      return true
    }
    return false
  }

  /** C16：清掉某单位的撤退落点（重新选） */
  function clearRetreatDestinationNow(unitId: string): void {
    const next = { ...combatInputs.value.retreatPaths }
    delete next[unitId]
    combatInputs.value = { ...combatInputs.value, retreatPaths: next }
  }

  /**
   * C16：点地图上的**推进格** ⇒ 按 9.12g-A 选出可推进的单位（付了战斗补给者）
   *
   * 常规战斗可自愿不推进，故只写候选、由玩家再确认；突袭后必须推进（8.1f 的强制进格）。
   */
  function advanceNow(hex: HexRef): boolean {
    const target = combatAdvanceHex.value
    if (target === null || !sameHex(target, hex)) {
      pushLog('warning', '防御方尚未离开该格（9.12g：全被消灭或撤退后才可推进）', '9.12g')
      return false
    }
    const eligible = combatAdvanceCandidates.value.filter((item) => item.paid)
    if (eligible.length === 0) {
      pushLog('warning', '没有付过战斗补给的攻击单位可以推进（9.12g-A）', '9.12g-A')
      return false
    }
    combatInputs.value = { ...combatInputs.value, advanceUnitIds: eligible.map((item) => item.id) }
    pushLog('info', `准备推进（9.12g）：${eligible.map((item) => item.label).join('、')}`, '9.12g')
    return true
  }

  /** C16：放弃推进（9.12g：常规战斗可都不推） */
  function clearAdvanceNow(): void {
    combatInputs.value = { ...combatInputs.value, advanceUnitIds: [] }
  }

  /**
   * C16：点地图上的**补给站** ⇒ 声明战斗补给的付款来源（12.4）
   *
   * 12.4 的战斗补给是 T；本函数把该补给站的 T 持仓写入引擎输入（`attackerAvailableT` /
   * `defenderAvailableT`），并记下被点的那一枚（供地图高亮与界面显示）。
   * 「付不付得出 / 够不够」仍由引擎 `planCombatSupply` 裁决。
   */
  function pickCombatSupplyDump(side: CombatRole, dumpId: string): boolean {
    const entry = combatSupplyDumps.value.find((item) => item.side === side)
    const dump = entry?.dumps.find((item) => item.id === dumpId)
    if (dump === undefined) {
      pushLog('warning', '该补给站不属于这一方（12.1b）', '12.1b')
      return false
    }
    combatSupplyDumpIds.value = { ...combatSupplyDumpIds.value, [side]: dumpId }
    // 12.1a：可用量必须**含 SP 折算**（1 SP = 4 T）——原先只取 `dump.t`，
    // 于是「4 SP + 0 T」的补给站会被报成 0 T，合法的攻击被 12.4 拒掉
    const availableT = holdingsToT({ sp: dump.sp, t: dump.t })
    combatInputs.value =
      side === 'attacker'
        ? { ...combatInputs.value, attackerAvailableT: availableT }
        : { ...combatInputs.value, defenderAvailableT: availableT }
    pushLog(
      'info',
      `${side === 'attacker' ? '攻方' : '守方'}战斗补给来源：${hexLabel(dump.hex)}（${dump.sp} SP / ${dump.t} T = ${availableT} T）`,
      '12.4',
    )
    return true
  }

  /**
   * C16：清掉战斗补给的来源声明（改回手填 T）
   *
   * ★ 「改回手填」是**真的清干净**：既撤掉被点的那一枚补给站（`combatSupplyDumpIds`），
   *   也把它之前写进引擎输入的可用 T **归零**——否则界面上来源已撤销、T 却还是那座站的数量，
   *   玩家会在不知情的情况下用着一座已撤销的来源付费。
   */
  function clearCombatSupplyDump(side: CombatRole): void {
    combatSupplyDumpIds.value = { ...combatSupplyDumpIds.value, [side]: null }
    combatInputs.value =
      side === 'attacker'
        ? { ...combatInputs.value, attackerAvailableT: 0 }
        : { ...combatInputs.value, defenderAvailableT: 0 }
  }

  /* ── C7 轰炸交互：派生（一切结论来自引擎；此处只做视图整形） ── */

  /** C7：参炸单位（当前方；随落盘自动刷新） */
  const barrageUnits = computed<ConsoleUnit[]>(() => {
    const state = barrageState.value
    const ids = state === null ? barrageUnitIds.value : state.units.map((unit) => unit.unitId)
    return ids
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
  })

  /**
   * B14b（用户口径⑪）：**参炸单位**的算子图阵列数据（可选性由引擎判据逐枚转述）
   *
   * 候选＝当前方**有印刷轰炸值**的单位（`raw.barrage > 0`，10.0e-B 的印值基准）。
   * 灰显原因有两个：**13.4a**（火炮处于预备/战略模式不得轰炸）与**专规 2.3d**（第五批 A4：
   * 已选一枚带 `sov_artillery_stack_to_combine` 标签的苏炮 ⇒ 其它格的带标签苏炮不得并入合并齐射）。
   * 2.3d 的最终裁决在引擎 `beginBarrage`（同一次宣布里判），此处只做同口径的**提前灰显**。
   *
   * ★ **不在这里替引擎判**别的（10.0e-A/B 的逐格/逐单位账本、10.0e-F 的类别相符）——
   *   那些引擎目前没接线，若在此处拦下来，界面会比引擎"更严"，反而掩盖规则缺口（已登记待改）。
   */
  const barrageUnitChoices = computed<
    readonly { unit: ConsoleUnit; selected: boolean; disabledReason: string | null }[]
  >(() => {
    /*
     * 10.0e-F：一次轰炸只能用**同一类型** ⇒ 候选按**当前单位类别**收口：
     * 选了"空军"就不该再列火炮（H②：用户报"炮兵轰炸时结算页面上还有空军"，这是它的镜像面）。
     */
    if (barrageKind.value !== 'artillery') return []
    // 专规 2.3d：已选的带标签苏炮的所在格（合并齐射的"锚点"；标签在 ConsoleUnit 顶层，与 NKVD 判据同源）
    const anchor = units.value.find(
      (unit) =>
        barrageUnitIds.value.includes(unit.instanceId) &&
        (unit.specialAbilities ?? []).includes('sov_artillery_stack_to_combine'),
    )
    const target = barrageTargetHex.value
    return units.value
      .filter((unit) => unit.side === activeSide.value && (unit.raw.barrage ?? 0) > 0)
      .map((unit) => ({
        unit,
        selected: barrageUnitIds.value.includes(unit.instanceId),
        /*
         * 10.1a（第六批条 20）：候选**按射程标出够不着者**（引擎侧同一条判据已在 `beginBarrage` 生效）。
         *   界面只做"说清楚"，最终裁决仍在引擎（CODE_SPEC §3.1：规则结算只在引擎）。
         *   目标格未选定时无从判距离 ⇒ 不标。
         */
        disabledReason: isInReserveOrStrat(unit)
          ? '13.4a：预备/战略模式的火炮不得轰炸'
          : target !== null &&
              unit.raw.range !== undefined &&
              !canBarrageAtRange({
                rangeHexes: unit.raw.range,
                distanceHexes: hexDistance(unit.hex, target),
              })
            ? `10.1a：射程 ${unit.raw.range} 格，目标在 ${hexDistance(unit.hex, target)} 格外`
            : anchor !== undefined &&
                unit.instanceId !== anchor.instanceId &&
                (unit.specialAbilities ?? []).includes('sov_artillery_stack_to_combine') &&
                !sameHex(unit.hex, anchor.hex)
              ? '专规 2.3d：苏军炮兵合并轰炸须同堆叠（与已选参炸炮同格）'
              : null,
      }))
  })

  /**
   * C7：**本环节里点地图选定的**轰炸目标格（10.0d）
   *
   * ★ 批 A 切片 2（用户口径「正式界面由环节驱动」）：修前 `barrageTargetHex` 直接取 `battleTarget?.hex` ——
   *   于是对局台一旦删掉"打一仗"工具按钮，**炮兵连目标格都点不了**（面板还提示"去工具里点"）。
   *   现在改为"**轰炸环节里点格**"为第一来源；`battleTarget` 降为**后备**（验证页与既有夹具仍可用它）。
   */
  const barragePickHex = ref<HexRef | null>(null)

  /** C7：轰炸目标格（环节点格优先；缺省退回战斗目标，兼容验证页与既有夹具） */
  const barrageTargetHex = computed<HexRef | null>(
    () => barragePickHex.value ?? battleTarget.value?.hex ?? null,
  )

  /**
   * C7：轰炸事实（10.0a 密度 / 工事 / 战略模式；10.0b 观察员）
   *
   * 目标格未定时给出「无事实」的桩（全部返回中性值），避免界面在未选目标时误算横移。
   */
  const barrageFacts = computed(() =>
    createBarrageFacts({ units: units.value, activeSide: activeSide.value }),
  )

  /** C7：目标格的密度 RE / 工事等级 / 战略模式 / 观察员（供界面显示与横移预览） */
  const barrageTargetFacts = computed(() => {
    const hex = barrageTargetHex.value
    if (hex === null) {
      return { enemyREInHex: 0, hedgehogLevel: 0, stratModeInHex: false, hasSpotter: false }
    }
    return {
      enemyREInHex: barrageFacts.value.enemyREInHex(hex),
      hedgehogLevel: barrageFacts.value.hedgehogLevelInHex(hex),
      stratModeInHex: barrageFacts.value.stratModeInHex(hex),
      hasSpotter: barrageFacts.value.hasSpotter(hex),
    }
  })

  /** C7：步骤清单（10.0 通用流程；给界面打勾用） */
  const barrageChecklist = computed(() =>
    barrageState.value === null ? [] : barrageStepChecklist(barrageState.value),
  )

  /**
   * B39 / A-1：**宣布的轰炸目标类别**能不能落在该格 —— 按盘面事实判（10.0c / 10.0d）
   *
   * 引擎只判"这一类型与参炸单位是否匹配"，它**不持盘面** ⇒ 这一层必须在宣布前给：
   *   · `airBase`：该格须有**空军基地**（印刷的或算子，都由 `airBases` 投影给出）；
   *   · `trainbusting`：该格须有**铁路**（14.8c 的运输破坏标记只能落在铁路格上）；
   *   · `combatUnits`：任何格都可以宣布（表 10.0a 打的是战斗单位）；
   *   · `port`：**本作数据里没有港口字段**（地图数据只有 terrain/terrainsPresent/city —— 见
   *     `src/data/schema/map-layers.schema.ts`）⇒ **判不了**，故不拦，只在这里如实标注缺口。
   */
  const barrageTargetKindIssue = computed<{ rule: string; reason: string } | null>(() => {
    const hex = barrageTargetHex.value
    if (hex === null) return null
    const kind = barrageTargetKind.value
    if (kind === 'airBase') {
      const hasBase = airBases.value.some((base) => sameHex(base.hex, hex))
      if (!hasBase) return { rule: '10.0c', reason: `空袭目标宣布为"空军基地"，但该格没有空军基地` }
      return null
    }
    if (kind === 'trainbusting') {
      if (!railMoveFacts.value.hasRail(hex))
        return { rule: '14.8c', reason: `空袭目标宣布为"运输破坏"，但该格没有铁路` }
      return null
    }
    return null
  })

  /**
   * C7：10.0a 目标玩家**可选**的地形线
   *
   * 「由目标玩家选择可能提供横移的地形」⇒ 选项只来自目标格**实际存在**的格内地形
   * （与 9.3b 的候选集同源），避免任取最有利的一条白拿左移。
   */
  const barrageTerrainLineOptions = computed<CombatLine[]>(() => {
    const hex = barrageTargetHex.value
    if (hex === null) return []
    return barrageTerrainLines(defenseTerrainChoices(hex))
  })

  /* ── C7 空军：10.2b 短程加成的数据源 ── */

  /** C7：可选机型（A5 空军专表；当前方） */
  const airUnitChoices = computed<AircraftRecordView[]>(() => aircraftChoices(activeSide.value))

  /** C7：参炸飞机（当前方、**当前面**有轰炸值者；随落盘自动刷新）——**只有类别＝空军时才给**（10.0e-F） */
  const barrageAirCandidates = computed<ConsoleAirUnit[]>(() =>
    barrageKind.value === 'air'
      ? airUnits.value.filter(
          (unit) => unit.side === activeSide.value && airBarrageStrengthOf(unit) > 0,
        )
      : [],
  )

  /** C7：本次实际选中的参炸飞机 */
  const barrageAirUnits = computed<ConsoleAirUnit[]>(() => {
    const state = barrageState.value
    const ids = state === null ? barrageAirIds.value : state.units.map((unit) => unit.unitId)
    return ids
      .map((id) => airUnits.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleAirUnit => unit !== undefined)
  })

  /**
   * C7：参炸飞机的 10.2b 事实（距基地格数 / 是否战略轰炸机）
   *
   * 「距基地格数」= 飞机所在格（14.1a：即其空军基地格）到目标格的格距；
   * 引擎会用**最远者**判「所有飞机都在 10 格以内」，并对战略轰炸机（14.1e）永不给予 +1。
   */
  const barrageAirFacts = computed(() => {
    const target = barrageTargetHex.value
    return barrageAirCandidates.value.map((unit) => {
      const distance = target === null ? null : airRangeFromBase(unit, target)
      return {
        id: unit.instanceId,
        name: unit.name,
        aircraftType: unit.aircraftType,
        /** 10.2b：距其基地（= 所在格）的格数；目标格未选时为 null */
        rangeFromBase: distance,
        /** 14.1e：战略轰炸机（10.2b 永不享受短程 +1） */
        strategic: isStrategicBomberAircraft(unit.aircraftType),
        /** 14.1：航程是否够到目标格（够不到则本不该出击） */
        inRange: distance === null ? null : distance <= unit.rangeHexes,
      }
    })
  })

  /**
   * B14b（用户口径⑪）：**参炸飞机**的算子图阵列数据
   *
   * 直接建在 `barrageAirFacts` 上（10.2b 的距基地格数 / 14.1e 战略轰炸机 / 14.1 航程够不够），
   * 再并进「本次选中与否」与灰显原因：**航程够不到目标格**的飞机不可参炸（14.1）。
   */
  const barrageAirChoices = computed(() =>
    barrageAirFacts.value.map((fact) => ({
      ...fact,
      selected: barrageAirIds.value.includes(fact.id),
      disabledReason: fact.inRange === false ? '14.1：该机航程够不到目标格' : null,
    })),
  )

  /** C7：结果摘要（格值 / 横移后列位 / 成本 / 损失，供界面显示） */
  const barrageSummary = computed(() => {
    const state = barrageState.value
    if (state === null) return null
    const outcome = state.outcome
    return {
      /** 本次整体目标与所用表（10.0d） */
      targetKind: state.targetKind,
      facility: isFacilityBarrage(state),
      totalValue: state.totalValue,
      initialColumnLabel: state.table.columnLabel,
      costT: state.table.costT,
      shifts: state.shifts,
      finalColumn: state.finalColumn,
      die: state.dice?.die ?? null,
      halfDie: state.dice?.halfDie ?? null,
      code: state.result?.code ?? null,
      /** 10.0a 的解释（DG / 损失点数）；设施轰炸为 null */
      unitOutcome: outcome?.table === 'barrage' ? outcome.value : null,
      /** 10.0c 的设施结果 */
      facilityOutcome: outcome?.table === 'barrage-vs-facility' ? outcome.value : null,
      losses: state.losses,
      finished: state.finished,
    }
  })

  /** C7：当前该谁操作（轰炸方始终是当前方；10.0a 的地形与损失由**目标玩家**选） */
  const barrageRequiresDefenderInput = computed<boolean>(() => {
    const state = barrageState.value
    if (state === null) return false
    // 10.0a：地形横移与损失承受单位都由**目标玩家**（防御方）选择
    return state.step === 'shifts' || state.step === 'outcome'
  })

  /* ── C8 补给交互与 SP 管理：派生（一切结论来自引擎；此处只做视图整形） ── */

  /** C8：当前方的 SP 账本条目（12.1b） */
  const spDumpsOfSide = computed<SpDump[]>(() =>
    spDumps.value.filter((dump) => dump.side === activeSide.value),
  )

  /**
   * 12.1b + 13.2f：**装载在运输点数上的 SP 也是补给站**（"SP 使用前并不需要被卸载"）
   *
   * 每枚 loadedSpT > 0 的算子按其所在格生成一条来源（id 前缀 "unit:"）：
   *   · 13.2g：编内卡车恒 1 SP（数据侧运力就是 1）；通用运输点数"有几点运力就是几"（用户裁定）；
   *   · 13.2b：运输点数**永不需要燃料**，故它自己不进"要加油的单位"集合（needsFuelOf 早已如此）。
   *
   * ★ 一个**如实边界**：与补给站账本条目**同格**时，按格映射（12.3a 的判据是格）会取到账本那一条 ——
   *   界面一律按格选来源，故两者同格时"选到哪一条"不确定；实际盘面极少出现，登记在案。
   */
  const carriedSpDumps = computed<SpDump[]>(() =>
    units.value
      .filter((unit) => unit.loadedSpT > 0)
      .map((unit) => ({
        id: 'unit:' + unit.instanceId,
        hex: unit.hex,
        side: unit.side,
        sp: Math.floor(unit.loadedSpT / SP_TO_T),
        t: unit.loadedSpT % SP_TO_T,
        carriedBy: unit.instanceId,
        // 13.2g-B：编内卡车的 SP **只许同一多单位编队**内的单位拖取（判据在引擎 `canDrawFromCarrier`）
        carrierIsOrganicTruck: unit.noncombatKind === 'organic_truck',
        carrierFormation: unit.formation,
      })),
  )

  /** 12.1b：**全部**含 SP 的位置（账本条目 + 装载在运输点数上的）——取补与候选一律走这一份 */
  const allSpDumps = computed<SpDump[]>(() => [...spDumps.value, ...carriedSpDumps.value])

  /** C8：被检查的单位（null＝未开始） */
  const supplyUnit = computed<ConsoleUnit | null>(() => {
    const id = supplyUnitId.value
    return id === null ? null : (units.value.find((unit) => unit.instanceId === id) ?? null)
  })

  /**
   * C8：**追溯补给事实**（12.1b / 12.3b / 12.6a / 12.7）
   *
   * 判定与可视化**共用同一份事实**，避免口径漂移：
   *   - dumps ← SP 账本（12.1b）；
   *   - throwHqs ← 摆好的 HQ 算子（投递距离取 13.1b 印值）；
   *   - extenders ← 摆好的延补队算子（距离取印值 MA，12.7b）；
   *   - sources ← 玩家声明的 12.6a① 源 + **由 13.3c 派生的火车卸货格**（12.6a②；
   *     见下方 `railSupply`：铁路可达 ∧ 村庄/城市/港口/工程 HQ ∧ 受控 ∧ 无未抵消敌 ZOC）。
   */
  const supplyFacts = computed(() =>
    createSupplyFacts({
      units: units.value,
      // 12.1b：含 SP 的位置 —— **账本条目 + 装载在运输点数上的**（B32 步骤 5）
      dumps: allSpDumps.value.map((dump) => ({ hex: dump.hex, side: dump.side })),
      sources: [
        ...supplySourceDecls.value
          .filter((decl) => decl.kind !== 'detrainable')
          .map((decl) => ({ hex: decl.hex, side: decl.side, kind: decl.kind })),
        // 13.3c / 12.6a②：铁路派生的火车卸货格（当前方）
        ...railSupply.value.detrainableHexes.map((hex) => ({
          hex,
          side: activeSide.value,
          kind: 'detrainable' as const,
        })),
      ],
    }),
  )

  /**
   * C9：只用于**敌方 ZOC 判定**的追溯事实（不含派生的卸货格，避免与 `railSupply` 循环依赖）
   */
  const zocOnlySupplyFacts = computed(() =>
    createSupplyFacts({
      units: units.value,
      // 12.1b：含 SP 的位置 —— **账本条目 + 装载在运输点数上的**（B32 步骤 5）
      dumps: allSpDumps.value.map((dump) => ({ hex: dump.hex, side: dump.side })),
      sources: supplySourceDecls.value
        .filter((decl) => decl.kind !== 'detrainable')
        .map((decl) => ({ hex: decl.hex, side: decl.side, kind: decl.kind })),
    }),
  )

  /**
   * C9：铁路补给事实（13.3a / 13.3c / 12.7a-B/C）
   *
   * - sources ← 12.6a① 的边缘铁路格/专规补给源格（玩家声明，**不含**派生的卸货格，否则自洽循环）；
   * - extenders ← 摆好的延补队（12.7b：距离＝印值 MA）；
   * - controlByHex（13.3h）：操作台无控制历史，按「格内仅有单方战斗单位」近似，其余视为未控制
   *   （宁可少给：未控制 ⇒ 不作火车卸货格）；
   * - zocAt（13.3c③）：复用追溯事实的 `inEnemyZoc`（已按 4.5b 处理「格内有己方战斗单位即抵消」）。
   */
  const railSupplyFacts = computed(() =>
    createRailSupplyFacts({
      sources: supplySourceDecls.value
        .filter((decl) => decl.kind !== 'detrainable')
        .map((decl) => ({ hex: decl.hex, side: decl.side })),
      extenders: units.value.filter(isExtenderUnit).map(toExtenderView),
      controlByHex: (hex) => {
        const sides = new Set(
          units.value
            .filter((unit) => unit.isCombat && sameHex(unit.hex, hex))
            .map((unit) => unit.side),
        )
        return sides.size === 1 ? ([...sides][0] ?? null) : null
      },
      zocAt: (hex, side) => zocOnlySupplyFacts.value.inEnemyZoc(hex, side),
      // 13.3f／专规 1.2：轨距只回答「谁能用这条铁路」（与 13.3a 多轨的运量费用无关）
      railGaugeUsable: (hex, side) => isRailGaugeUsableAt(hex, side),
      // 12.7b：延补队回连距离用 trace-supply 的**同一实现**（MP 沿补给路径），不使用格数近似
      traceFacts: zocOnlySupplyFacts.value,
    }),
  )

  /** C9：铁路补给线与**火车卸货格**（13.3c / 12.7a-B/C；当前方视角） */
  const railSupply = computed(() => railSupplyPath(railSupplyFacts.value, activeSide.value))

  /** C9：火车卸货格（13.3c）——已连接的铁路格，可作 12.6a① 补给源 */
  const detrainableHexes = computed(() => railSupply.value.detrainableHexes)

  /**
   * 12.6 / 5.8b：**追溯补给的逐格判定**（与 `supplyFacts` 同源，一处构造、多处消费）
   *
   * 消费方：装备 `traceSupplyAt` 的移动上下文（5.8b 战略模式须停在有补给的格）、
   * 9.14d 特殊战斗的落点条件。两者必须问**同一份**事实，否则「同一个格，一处说有补给、
   * 另一处说没有」。
   */
  const traceSupplyAtForMove = computed(() => createTraceSupplyAt(supplyFacts.value))

  /* ────────────────── C9b：轨距账本（13.3f / 专规 1.2） ────────────────── */

  /**
   * 印刷轨距（专规 1.2：本作地图铁路「最初除剧本初设另有注明者外，全部为宽轨」）
   *
   * 规则常量是权威来源；`map-layers.json` 顶层 `railGauge` 是同值的图层副本，
   * 两者不一致即数据有误——由 `tests/data/...` 的一致性用例钉住，代码只读常量。
   */
  const printedRailGauge: RailGauge = rulesConstants.smolensk.railGauge.printed

  /** 换轨的**目标**轨距＝非印刷轨距的那一种（本作：印刷宽轨 ⇒ 转换后为标准轨） */
  const convertedRailGauge: RailGauge = printedRailGauge === 'broad' ? 'standard' : 'broad'

  /**
   * C9b：**已换轨的格**（13.3f）——本作即「宽轨 → 标准轨」的逐格账本
   *
   * 为什么需要它：专规 1.2 明言就「铁路运货**与获得追溯补给**」而言，苏方**只能**用宽轨、
   * 轴方**只能**用标准轨。印刷图全是宽轨，轴方要能用铁路就必须先换轨——换轨状态是**运行期**的，
   * 数据层只有印刷值，故必须在此记账（写入点：剧本初设 `convertedAxisRails` 的推导结果、
   * 13.3f 转换动作、裁判手工订正）。
   *
   * ★ 与 13.3a 的「多轨／单轨」严格分开：那是**地形**，管**运量费用**；本账本只管**谁能用**。
   *
   * ★ 账本是**单向**的：只记「已换成标准轨」的格。13.3f 的转换动作按本方轨距入账或出账
   *   （轴方入账、苏方出账），故苏方把轴方换过的轨换回来时账本会**缩短**——见 `convertRailGaugeNow`。
   */
  const convertedRailHexes = ref<string[]>([])

  /** 已换轨格的索引（O(1) 查询用） */
  const convertedRailKeySet = computed<Set<string>>(() => new Set(convertedRailHexes.value))

  /** C9b：本阶段各单位的换轨格数（13.3g-D 每阶段 ≤ min(4, MA) 格的账本；换阶段即清零） */
  const gaugeConversionsThisPhase = ref<{ instanceId: string; count: number }[]>([])

  /**
   * 13.3g-A：**本阶段被换过轨的格**（按格记账；换阶段即清零）
   *
   * 原文：「一个铁路修理单位可在移动阶段将铁路移动与轨距转换结合起来。（例外：如果**用于铁路移动的格**
   * 刚刚在**当前阶段内**进行了轨距转换，则不能这样做。**不能接力！**）」
   * ⇒ 判这条例外需要"哪些格是本阶段换的"，而 `gaugeConversionsThisPhase` 是**按算子**计数的、
   *   答不了这个问题（§17.85 登记的缺口）⇒ 另记一本**按格**的阶段账本。
   */
  const convertedHexesThisPhase = ref<string[]>([])

  /**
   * 13.3g-A：本阶段各铁路修理单位**用铁路移动走过**的"刚换过轨的格"
   *
   * 引擎的入参是布尔（`usedNewlyConvertedRailThisPhase`）⇒ 这一手由 store 判定并留账
   * （哪个单位、走过哪些格）。按**单位**记：另一个单位没走过这些格，就不受这条例外牵连。
   */
  const railMovedNewTrackThisPhase = ref<{ instanceId: string; hexes: string[] }[]>([])

  /** 13.3f：该格**此刻**的轨距（印刷值 ⊕ 换轨账本） */
  function railGaugeAt(hex: HexRef): RailGauge {
    return convertedRailKeySet.value.has(hexLabel(hex)) ? convertedRailGauge : printedRailGauge
  }

  /**
   * 13.3f / 专规 1.2：`side` 在 `hex` 能否使用这条铁路
   *
   * 这就是「谁可以用」的全部内容——轨距**不**参与运量费用（费用侧是多轨/单轨地形，13.3a）。
   */
  function isRailGaugeUsableAt(hex: HexRef, side: Side): boolean {
    return rulesConstants.smolensk.railGauge.usableBySide[side] === railGaugeAt(hex)
  }

  /**
   * C9b：推导某剧本的初设换轨格清单（纯推导，不写日志、不触发重判）
   *
   * 剧本页只给两个端点，给的是**那一条铁路线**；逐格清单由引擎沿铁路邻接图取唯一最短路径
   * （`convertedRailRun`，分叉或不连通即失败——把不该给的格标成已换轨，等于把整段铁路白送给轴方）。
   * 任一走线失败即整体作废（`keys` 为空）并把原因放进 `problems`，由调用方决定告警口径。
   */
  function deriveConvertedRailHexes(id: string): {
    keys: string[]
    problems: string[]
    runs: number
  } {
    const decl = scenarios.scenarios.find((item) => item.id === id)?.setup.convertedAxisRails
    if (decl === undefined) return { keys: [], problems: [], runs: 0 }
    const keys: string[] = []
    const problems: string[] = []
    let runs = 0
    for (const run of decl.runs) {
      const endpoints = parseConvertedRailRun(run)
      if (endpoints === null) {
        problems.push(`${run}（端点原文无法解析，期望「列.行 to 列.行」）`)
        continue
      }
      const outcome = convertedRailRun(railNeighborSource, endpoints)
      if (!outcome.ok) {
        problems.push(`${run}（${outcome.reason}）`)
        continue
      }
      runs += 1
      for (const hex of outcome.data.hexes) keys.push(hexLabel(hex))
    }
    return problems.length > 0
      ? { keys: [], problems, runs }
      : { keys: [...new Set(keys)], problems, runs }
  }

  /**
   * C9b：剧本初设换轨（专规 1.2 剧本页 `Converted Axis Rails: A to B`）
   *
   * 剧本页只给两个端点，给的是**那一条铁路线**；逐格清单由引擎沿铁路邻接图取唯一最短路径
   * （`convertedRailRun`，分叉即失败）。本动作**清空并重算**账本，故重复调用幂等；
   * 解析或推导失败时账本置空（宁可少给：不给轴方任何未证成的铁路使用权）并逐条告警。
   */
  function seedConvertedRailsNow(): boolean {
    const derived = deriveConvertedRailHexes(scenarioId.value)
    const decl = scenarios.scenarios.find((item) => item.id === scenarioId.value)?.setup
      .convertedAxisRails
    convertedRailHexes.value = derived.keys
    if (derived.problems.length > 0) {
      for (const problem of derived.problems)
        pushLog('warning', `初设换轨未能推导：${problem}——账本保持为空（宁可少给）`, '13.3f')
      return false
    }
    pushLog(
      'info',
      decl === undefined
        ? `剧本 ${scenarioId.value} 未登记初设换轨（专规 1.2：除初设注明者外全部为宽轨）⇒ 换轨账本为空`
        : `初设换轨：剧本 ${scenarioId.value} 共 ${decl.runs.length} 段走线 → ${derived.keys.length} 格转为标准轨` +
            `（专规 1.2：轴方只能使用标准轨，苏方只能使用宽轨）`,
      '专规 1.2',
    )
    return true
  }

  /** C9b：清空换轨账本（裁判订正用；13.3f 的初设之外不应有「已换轨」） */
  function clearConvertedRailsNow(): void {
    const before = convertedRailHexes.value.length
    convertedRailHexes.value = []
    pushLog('info', `换轨账本已清空（原 ${before} 格）——铁路恢复印刷轨距（专规 1.2）`, '13.3f')
  }

  /** 13.3g：该实例是否为**铁路修理单位**（数据标记 `specialized` 含 `'rail_repair'`） */
  function isRailRepairUnit(instanceId: string): boolean {
    return (
      units.value
        .find((unit) => unit.instanceId === instanceId)
        ?.specialized.includes('rail_repair') ?? false
    )
  }

  /**
   * C9b：13.3f／13.3g 轨距转换（铁路修理单位**移动进入**铁路格即转换该格）
   *
   * - 转换不消耗 SP 也不消耗额外 MP（13.3f-B）；
   * - 敌方 ZOC 内不可转换且**不可抵消**（13.3f-A）；
   * - 仅移动阶段，每阶段至多 `min(4, 当前 MA)` 格，且不得「接力」（13.3g-A/D）；
   * - 须处于战斗模式，或 DG 但朝向战斗面（13.3g-D via 5.10e）。
   *
   * 数据侧：三支铁路修理单位（苏 West RR Rgt、德 I-2 / II-2 RR Bn）已于 2026-09-15 入库并推进到
   * `valued`，`specialized` 均含 `'rail_repair'`（印值经用户裁定）⇒ 本条与 13.3g 的铁路例外均已生效。
   */
  function convertRailGaugeNow(instanceId: string, targetHexText: string): boolean {
    if (!requireAction('move.railConversion', '换轨')) return false
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) {
      pushLog('warning', `轨距转换：找不到单位实例 ${instanceId}`, '13.3f')
      return false
    }
    const hex = parseHexPath(targetHexText)[0]
    if (hex === undefined) {
      pushLog('warning', `轨距转换：目标格格式应为「列.行」，收到「${targetHexText}」`, '13.3f')
      return false
    }
    const outcome = validateGaugeConversion({
      phase: phase.value as GamePhase,
      unit: { id: unit.instanceId, side: unit.side },
      targetHex: hex,
      convertedThisPhase:
        gaugeConversionsThisPhase.value.find((item) => item.instanceId === instanceId)?.count ?? 0,
      mode: unit.mode.mode,
      orientation: unit.mode.orientation,
      dg: unit.mode.dg,
      currentMa: unit.raw.ma,
      usedNewlyConvertedRailThisPhase:
        (railMovedNewTrackThisPhase.value.find((item) => item.instanceId === instanceId)?.hexes
          .length ?? 0) > 0,
      facts: {
        hasRail: (ref) => isRailHexAt(ref),
        inEnemyZoc: (ref, side) => zocOnlySupplyFacts.value.inEnemyZoc(ref, side),
        isRailRepairUnit: (id) => isRailRepairUnit(id),
      },
    })
    if (!outcome.ok) {
      pushLog('warning', `轨距转换被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const key = hexLabel(hex)
    /**
     * 13.3f：双方**各换各的**轨距——账本的语义是「该格已换成标准轨（轴方可用）」，
     * 故轴方转换＝入账，苏方转换＝**出账**（恢复印刷宽轨）。
     * 按**本方可用轨距**判定（不写死阵营），印刷轨距若改则行为自动跟随。
     */
    const wasOwnGauge = isRailGaugeUsableAt(hex, unit.side)
    if (rulesConstants.smolensk.railGauge.usableBySide[unit.side] === convertedRailGauge) {
      if (!convertedRailHexes.value.includes(key)) convertedRailHexes.value.push(key)
    } else {
      convertedRailHexes.value = convertedRailHexes.value.filter((item) => item !== key)
    }
    const previous =
      gaugeConversionsThisPhase.value.find((item) => item.instanceId === instanceId)?.count ?? 0
    gaugeConversionsThisPhase.value = [
      ...gaugeConversionsThisPhase.value.filter((item) => item.instanceId !== instanceId),
      { instanceId, count: previous + 1 },
    ]
    // 13.3g-A：本阶段"刚换过轨的格"按格记账（同一格重复转换不重复记账）
    if (!convertedHexesThisPhase.value.includes(key))
      convertedHexesThisPhase.value = [...convertedHexesThisPhase.value, key]
    pushLog(
      'info',
      `${outcome.data.detail}；` +
        (wasOwnGauge
          ? '该格原就是本方轨距，转换后仍供本方使用'
          : isRailGaugeUsableAt(hex, unit.side)
            ? '该格现已可供本方铁路使用'
            : '该格轨距仍非本方可用'),
      '13.3f',
    )
    // 换轨会改变铁路补给线（谁能用这条铁路）⇒ 立刻重判追溯补给
    refreshTraceSupply('轨距转换（13.3f）')
    return true
  }

  /* ────────── C9c：13.3 铁路运货（13.3a 容量 / 13.3b 移动阶段 / 13.3e 三步） ────────── */

  /**
   * 13.3e：铁路运货的玩家输入（卸货格 / SP 货量 / SP 的起运补给站）
   *
   * 货物本身取「当前选中单位」（单位货）或「指定补给站」（SP 货）——与 13.3a 允许的三类货物
   * （战斗单位 / 运输点数 / SP）一致；运输点数作货物见本节的登记。
   */
  const railMoveInputs = ref<{ toHexText: string; spAmount: number; fromDumpId: string | null }>({
    toHexText: '',
    spAmount: 1,
    fromDumpId: null,
  })

  /** 13.3 的错误（统一形状） */
  const railMoveError = ref<{ rule: string; reason: string } | null>(null)

  /**
   * 13.3b：**本回合**各方已用的铁路容量点数
   *
   * 「每个铁路运量点数可以运输一个 SP 或 RE，距离不限」＋当日容量（1.2：轴 0/苏 2，7 月 19 日起
   * 轴 1/苏 3）⇒ 额度是**按回合**计的，故换回合清零（与 16.0b/c 的每回合额度同构）。
   */
  const railCapSpentThisTurn = ref<{ side: Side; points: number }[]>([])

  /** 13.3b：该方本回合已用 / 剩余容量点数 */
  function railCapUsedBy(side: Side): number {
    return railCapSpentThisTurn.value.find((item) => item.side === side)?.points ?? 0
  }
  const railCapRemaining = computed<{ axis: number; soviet: number }>(() => ({
    axis: railCapToday.value.axis - railCapUsedBy('axis'),
    soviet: railCapToday.value.soviet - railCapUsedBy('soviet'),
  }))

  /**
   * 13.3：铁路运货的运行期事实（`RailFacts` 的**唯一组装点**）
   *
   * 静态图层（哪格有铁路 / 两格是否以铁路相接）由引擎 `createRailFacts` 从 `map-layers` 建索引；
   * 运行期六项分别取仓里既有结论：
   *   · 13.3h 控制 ← 补给层的 `controlByHex`（同格**唯一**战斗单位所属方；两侧各有即无人控制）；
   *   · 13.3f 轨距 ← `isRailGaugeUsableAt`（专规 1.2 的轨距账本，与 13.3f 的转换共用）；
   *   · EZOC ← `zocOnlySupplyFacts.inEnemyZoc`（按 4.5b 抵消后；★ 13.3c 末句：**运货时不可抵消**，
   *     但那份事实本身已按 4.5b 处理，故此处与条文仍有细微差别，见本节的登记）；
   *   · 敌方战斗单位 ← 盘面推出；
   *   · 13.3c 可火车卸货格 ← 补给层的 `detrainableHexes`（**同一份结论**，不另立一条判据）；
   *   · 14.8 运输破坏区 ← `trainbustingMarks`。
   */
  const railMoveFacts = computed(() =>
    createRailFacts({
      isControlled: (hex, side) => railSupplyFacts.value.isControlledBy(hex, side),
      railGaugeUsable: (hex, side) => isRailGaugeUsableAt(hex, side),
      inEnemyZoc: (hex, side) => zocOnlySupplyFacts.value.inEnemyZoc(hex, side),
      hasEnemyCombatUnit: (hex, side) =>
        units.value.some((unit) => unit.side !== side && unit.isCombat && sameHex(unit.hex, hex)),
      // 13.3c 的结论由补给层按**当前行动方**给出；13.3b 也只允许本方使用自己的铁路容量
      isDetrainable: (hex, side) =>
        side === activeSide.value &&
        railSupply.value.detrainableHexes.some((item) => sameHex(item, hex)),
      isRailRepairUnit: (id) => isRailRepairUnit(id),
      isTrainbusting: (hex) => hasTrainbustingAt(hex),
    }),
  )

  /**
   * 13.3e-2：沿铁路的最短**待检**路径（只作提案，裁定仍在引擎）
   *
   * BFS 走引擎的铁路邻接（`railNeighborHexes` → `createRailGraph`），并跳过按同一批事实**已不可能通行**
   * 的格（错误轨距 / 未控制 / 敌方战斗单位 / EZOC）；终点照给，让引擎给出准确的拒绝理由。
   * ★ 刻意不在这里下结论：本函数只回答「有没有一条看起来能走的路」，合法性一律交
   *   `validateRailMovement`（与逐格移动的「BFS 提案 + 引擎裁定」同一模式）。
   */
  /**
   * 13.3e-2：沿铁路的最短**待检**路径（只作提案，裁定仍在引擎）
   *
   * BFS 走引擎的铁路邻接（`railNeighborHexes` → `createRailGraph`），并跳过按同一批事实**已不可能通行**
   * 的格（错误轨距 / 未控制 / 敌方战斗单位 / EZOC）；终点照给，让引擎给出准确的拒绝理由。
   * ★ 刻意不在这里下结论：本函数只回答「有没有一条看起来能走的路」，合法性一律交
   *   `validateRailMovement`（与逐格移动的「BFS 提案 + 引擎裁定」同一模式）。
   *
   * ★ 13.3a 的路径选择：**先试「全程多轨」**（整条路都走在多轨格边上 ⇒ 容量费减半），
   *   找不到才退回普通最短待检路径。理由：容量费与距离无关，只在**全程多轨**时减半，
   *   故全程多轨的那条路永远不比别的路贵——这是玩家会选的那条。两次搜索都只作提案，
   *   合法性仍由 `validateRailMovement` 裁定。
   */
  function railPathBetween(from: HexRef, to: HexRef, side: Side): HexRef[] | null {
    const facts = railMoveFacts.value
    const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
    const goal = key(to)

    /** `multiOnly` = 只走多轨格边（用于先试「全程多轨」） */
    function search(multiOnly: boolean): HexRef[] | null {
      const previous = new Map<string, HexRef>()
      const seen = new Set<string>([key(from)])
      const queue: HexRef[] = [from]
      while (queue.length > 0) {
        const hex = queue.shift()!
        if (key(hex) === goal) break
        for (const next of railNeighborHexes(hex)) {
          const nextKey = key(next)
          if (seen.has(nextKey)) continue
          if (multiOnly && !facts.isMultiTrackEdge(hex, next)) continue
          if (nextKey !== goal) {
            if (!facts.railGaugeUsable(next, side)) continue
            if (!facts.isControlled(next, side)) continue
            if (facts.hasEnemyCombatUnit(next, side)) continue
            if (facts.inEnemyZoc(next, side)) continue
          }
          seen.add(nextKey)
          previous.set(nextKey, hex)
          queue.push(next)
        }
      }
      if (!seen.has(goal)) return null
      const path: HexRef[] = [to]
      let cursor = to
      while (key(cursor) !== key(from)) {
        const before = previous.get(key(cursor))
        if (before === undefined) return null
        path.unshift(before)
        cursor = before
      }
      return path
    }

    return search(true) ?? search(false)
  }

  /** 13.3e：最近一次铁路运货的结论（界面回执） */
  const lastRailMove = ref<{
    rule: string
    detail: string
    cost: number
    path: HexRef[]
  } | null>(null)

  /* ────────── 13.2f：运输点数装载 / 卸载 SP ────────── */

  /** 13.2f 的输入（哪一个运输点数、装/卸多少 SP） */
  const transportLoadInputs = ref<{ pointId: string | null; amount: number }>({
    pointId: null,
    amount: 1,
  })

  /** 13.2f 的错误（统一形状） */
  const transportLoadError = ref<{ rule: string; reason: string } | null>(null)

  /** 13.2f：该运输点数算子 → 引擎的 `TransportPointActor`（唯一组装点） */
  function transportPointActorOf(unit: ConsoleUnit): TransportPointActor {
    return {
      id: unit.instanceId,
      type: transportKindOf(unit),
      // 13.2f：「支付它**印刷 MA** 的 10%」——按印值而非当前值（故取朝向面印值）
      printedMa: unit.raw.ma,
      // 13.2g：编内卡车（13.2g-A 永远不能在地图上卸载）
      isOrganicTruck: unit.noncombatKind === 'organic_truck',
    }
  }

  /**
   * 13.2f：**装载 SP**（运输点数与补给站同格；支付印刷 MA 的 10%）
   *
   * 「运输点数必须与**补给站**位于同一格中才能装载 SP」「运输点数可在**任何格**内装载」
   * ⇒ 位置前提只有「同格有补给站」。装载的 SP 从该站扣、记到点数的 `loadedSpT` 上。
   */
  function loadTransportPointNow(): boolean {
    if (!requireAction('move.loadUnload', '装载 SP')) return false
    const unit = units.value.find((item) => item.instanceId === transportLoadInputs.value.pointId)
    if (unit === undefined) {
      pushLog('warning', '先选择要装载的运输点数（13.2f）', '13.2f')
      return false
    }
    const dump = spDumps.value.find(
      (item) => item.side === unit.side && sameHex(item.hex, unit.hex),
    )
    const outcome = validateTransportPointLoad({
      transportPoint: transportPointActorOf(unit),
      dumpInHex: dump !== undefined,
    })
    if (!outcome.ok) {
      transportLoadError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `装载被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const amount = Math.max(1, Math.trunc(transportLoadInputs.value.amount))
    const payment = planSpPayment({
      holdings: { sp: dump?.sp ?? 0, t: dump?.t ?? 0 },
      wantT: amount * SP_TO_T,
    })
    if (dump === undefined || !payment.ok) {
      transportLoadError.value = { rule: '13.2f', reason: 'loadNotPayable' }
      pushLog(
        'warning',
        `该站的 SP 不足 ${amount} 点（装载不消耗 SP 之外的东西，但货得真的在站上；13.2f）`,
        '13.2f',
      )
      return false
    }
    setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
    unit.loadedSpT += amount * SP_TO_T
    // 13.2f：装载要支付印刷 MA 的 10%（按 6.1a 计入本阶段已耗 MP）
    unit.mpSpent += outcome.data.cost
    transportLoadError.value = null
    pushLog(
      'success',
      `${unit.name} 装载 ${amount} SP（${outcome.data.detail}）⇒ 已载 ${unit.loadedSpT / SP_TO_T} SP；付款站 ${hexLabel(dump.hex)}`,
      outcome.rule,
    )
    recordSettlement({
      action: 'transportLoad',
      rule: outcome.rule,
      data: {
        pointId: unit.instanceId,
        sp: amount,
        costMp: outcome.data.cost,
        dumpHex: { ...dump.hex },
      },
    })
    return true
  }

  /**
   * 13.2f：**卸载 SP**（只在含友方战斗单位/港口/空军基地/已卸载补给站的格；同样支付 10% 印值 MA）
   *
   * 13.2g-A：**编内卡车永远不能在地图上卸载它们的 SP**（引擎按 `isOrganicTruck` 拒）。
   */
  function unloadTransportPointNow(): boolean {
    if (!requireAction('move.loadUnload', '卸载 SP')) return false
    const unit = units.value.find((item) => item.instanceId === transportLoadInputs.value.pointId)
    if (unit === undefined) {
      pushLog('warning', '先选择要卸载的运输点数（13.2f）', '13.2f')
      return false
    }
    // 13.2f：「只能在包含**友方战斗单位、港口、空军基地或已经有已卸载的补给站**的格内卸载」
    const hasFriendlyCombat = units.value.some(
      (item) => item.side === unit.side && item.isCombat && sameHex(item.hex, unit.hex),
    )
    const hasFacility = airBases.value.some((base) => sameHex(base.hex, unit.hex))
    const hasDump = spDumps.value.some(
      (item) => item.side === unit.side && sameHex(item.hex, unit.hex),
    )
    const outcome = validateTransportPointUnload({
      transportPoint: transportPointActorOf(unit),
      hexAllowsUnload: hasFriendlyCombat || hasFacility || hasDump,
    })
    if (!outcome.ok) {
      transportLoadError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `卸载被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const amount = Math.max(1, Math.trunc(transportLoadInputs.value.amount))
    const loaded = unit.loadedSpT / SP_TO_T
    if (loaded < amount) {
      transportLoadError.value = {
        rule: '13.2f',
        reason: `unloadExceedsLoaded:${amount}>${loaded}`,
      }
      pushLog('warning', `该点数只载了 ${loaded} SP，卸不出 ${amount} SP（13.2f）`, '13.2f')
      return false
    }
    unit.loadedSpT -= amount * SP_TO_T
    grantSpDumpT(unit.hex, unit.side, amount * SP_TO_T)
    unit.mpSpent += outcome.data.cost
    transportLoadError.value = null
    pushLog(
      'success',
      `${unit.name} 卸载 ${amount} SP（${outcome.data.detail}）⇒ 余载 ${unit.loadedSpT / SP_TO_T} SP；落 ${hexLabel(unit.hex)}`,
      outcome.rule,
    )
    recordSettlement({
      action: 'transportUnload',
      rule: outcome.rule,
      data: {
        pointId: unit.instanceId,
        sp: amount,
        costMp: outcome.data.cost,
        hex: { ...unit.hex },
      },
    })
    return true
  }

  /**
   * 4.7d：本阶段**已用铁路运输过**的单位实例 id
   *
   * 「同一个阶段不能使用超过一种运输类型」是**跨动作的阶段级记账**（引擎自注：须由命令层累计，
   * 因为 `rail.ts` 是无状态纯函数）。此处把它落成阶段账本，供界面提示与规则登记。
   */
  const railMovedUnitIdsThisPhase = ref<string[]>([])

  /**
   * 13.3e：**执行一次铁路运货**（登车 → 沿铁路移动 → 卸货，三步同阶段）
   *
   * 货类两种（13.3a）：**单位**（当前选中者）与 **SP**（指定补给站里的若干点）。
   * 硬条件全由引擎判（`validateRailMovement`：13.3b 移动阶段、13.3e 的登车/沿途/卸货、
   * 5.6a 移动模式、5.10d 非 DG、13.3e-1 登车前 ≤ 半 MA、13.3f 轨距、13.3h 控制）；
   * 本处负责：提案路径、**扣铁路容量**（13.3b 的当日额度）、落盘（改货物位置/账本）与留痕。
   */
  function railMoveNow(kind: 'unit' | 'sp' | 'transportPoint'): boolean {
    if (!requireAction('move.railTransport', '铁路运输')) return false
    const to = parseHexPath(railMoveInputs.value.toHexText)[0]
    if (to === undefined) {
      railMoveError.value = { rule: '13.3e', reason: 'railMoveNeedsDestination' }
      pushLog(
        'warning',
        `铁路运货须给卸货格「列.行」，收到「${railMoveInputs.value.toHexText}」（13.3e）`,
        '13.3e',
      )
      return false
    }
    const side = activeSide.value
    const facts = railMoveFacts.value

    // 货物：单位（选中者）或 SP（指定站）
    let from: HexRef
    let cargo: RailCargoView
    if (kind === 'unit') {
      const unit = selectedUnit.value
      if (unit === null) {
        railMoveError.value = { rule: '13.3e', reason: 'railMoveNeedsSelectedUnit' }
        pushLog('warning', '铁路运货（单位）：请先在地图上选中要运输的单位（13.3e）', '13.3e')
        return false
      }
      if (unit.side !== side) {
        railMoveError.value = { rule: '13.3b', reason: 'railMoveOnlyOwnUnits' }
        pushLog('warning', `${unit.name} 不是本方单位（13.3b 只用本方铁路容量）`, '13.3b')
        return false
      }
      from = unit.hex
      cargo = {
        kind: 'unit',
        id: unit.instanceId,
        side,
        re: unit.re,
        // 4.7b：运输当量按**移动模式下的印刷 MA** ⇒ 机动类型也取**移动面**（3.1a 两面可能不同：
        //   如「移动面 leg MA 2」的单位属 4.7b 的短腿减半，而按记录级 truck 会算成全价）
        mobility: unit.faces.move.mobility,
        // 4.7b：运输当量按**移动模式下的印刷 MA**（故取移动面印值，不取当前朝向面）
        moveMa: unit.faces.move.ma,
        mode: unit.mode.mode,
        dg: unit.mode.dg,
        // 13.3e-1：当前生效面的印刷 MA 与登车前已耗 MP
        currentMa: unit.raw.ma,
        preLoadMp: unit.mpSpent,
      }
    } else if (kind === 'transportPoint') {
      /*
       * B-3（13.3a / 4.7）：**以运输点数本身作货物** —— 当量＝它的**运力点数**（size）；
       * 通用前提（登车格可卸货 / 轨距 / 控制 / 无敌军与 EZOC）与容量成本都复用同一条链，
       * 故这里只把「哪一枚、多大」补齐（与 unit / sp 两条同构）。
       */
      const unit = selectedUnit.value
      if (unit === null) {
        railMoveError.value = { rule: '13.3e', reason: 'railMoveNeedsSelectedTransportPoint' }
        pushLog('warning', '铁路运货（运输点数）：请先在地图上选中那枚运输点数（13.3e）', '13.3e')
        return false
      }
      // 13.3b：只用**本方**的铁路容量；运输点数＝运力点数 > 0 的非战斗单位
      if (unit.side !== side || unit.noncombatTransport <= 0) {
        railMoveError.value = { rule: '13.3b', reason: 'railMoveNeedsOwnTransportPoint' }
        pushLog(
          'warning',
          unit.name +
            ' 不是本方的运输点数（13.3b 只用本方铁路容量；运输点数看 noncombatTransport > 0）',
          '13.3b',
        )
        return false
      }
      from = unit.hex
      cargo = { kind: 'transportPoint', id: unit.instanceId, side, size: unit.noncombatTransport }
    } else {
      const dump = spDumps.value.find((item) => item.id === railMoveInputs.value.fromDumpId) ?? null
      if (dump === null || dump.side !== side) {
        railMoveError.value = { rule: '13.3a', reason: 'railMoveSpNeedsOwnDump' }
        pushLog('warning', 'SP 铁路运货：请先指定**己方**的起运补给站（13.3a）', '13.3a')
        return false
      }
      const amount = Math.max(1, Math.trunc(railMoveInputs.value.spAmount))
      from = dump.hex
      cargo = { kind: 'sp', id: dump.id, side, amount }
    }

    const path = railPathBetween(from, to, side)
    if (path === null) {
      railMoveError.value = { rule: '13.3e', reason: 'noRailPath' }
      pushLog(
        'warning',
        `${hexLabel(from)} → ${hexLabel(to)} 之间没有一条可用的铁路路径（13.3e-2：须相连、轨距正确、受控、无敌军与 EZOC）`,
        '13.3e',
      )
      return false
    }
    const outcome = validateRailMovement({
      phase: phase.value as GamePhase,
      cargo,
      from,
      to,
      path,
      facts,
    })
    if (!outcome.ok) {
      railMoveError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `铁路运货被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    // 13.3b：当日额度（1.2）——超出即拒，**不改动任何货物**
    const remaining = railCapRemaining.value[side]
    if (outcome.data.cost > remaining) {
      railMoveError.value = {
        rule: '13.3b',
        reason: `railCapExceeded:${outcome.data.cost}>${remaining}`,
      }
      pushLog(
        'warning',
        `铁路容量不足：本次需 ${outcome.data.cost} 点、本回合余 ${remaining} 点（13.3b；当日额度 ${railCapToday.value[side]}）`,
        '13.3b',
      )
      return false
    }

    // ── 落盘 ──
    // B-3：运输点数货物与单位货物一样是**把那枚算子挪过去**（13.3e-3 卸货）
    if (cargo.kind === 'unit' || cargo.kind === 'transportPoint') {
      const unit = units.value.find((item) => item.instanceId === cargo.id)
      if (unit !== undefined) {
        unit.hex = { col: to.col, row: to.row }
        // 4.7d / 13.3e-3：卸货后不得再移动（13.3g-B 的铁路修理单位例外，其剩余 MP 已由引擎给出）
        unit.movementEnded = outcome.data.postDetrainMp <= 0
        railMovedUnitIdsThisPhase.value = [
          ...new Set([...railMovedUnitIdsThisPhase.value, unit.instanceId]),
        ]
        /*
         * 13.3g-A：铁路修理单位用铁路移动走过"本阶段刚换过轨的格" ⇒ 记账，
         * 此后它再换轨会被 13.3g-A 拦下（"不能接力"）。
         * ★ 取值范围按原文的**「用于铁路移动的格」**取**整条路径（含登车格）**；
         *   引擎入参的注释写的是"进入过"，若日后要收窄成"仅进入段"，只改这一处 filter 即可。
         */
        if (isRailRepairUnit(unit.instanceId)) {
          const walkedKeys = path
            .map((hex) => hexLabel(hex))
            .filter((text) => convertedHexesThisPhase.value.includes(text))
          if (walkedKeys.length > 0) {
            const before =
              railMovedNewTrackThisPhase.value.find((item) => item.instanceId === unit.instanceId)
                ?.hexes ?? []
            railMovedNewTrackThisPhase.value = [
              ...railMovedNewTrackThisPhase.value.filter(
                (item) => item.instanceId !== unit.instanceId,
              ),
              { instanceId: unit.instanceId, hexes: [...new Set([...before, ...walkedKeys])] },
            ]
          }
        }
      }
    } else {
      const amountT = cargo.amount * SP_TO_T
      const dump = spDumps.value.find((item) => item.id === railMoveInputs.value.fromDumpId) ?? null
      const payment = planSpPayment({
        holdings: { sp: dump?.sp ?? 0, t: dump?.t ?? 0 },
        wantT: amountT,
      })
      if (dump === null || !payment.ok) {
        railMoveError.value = { rule: '13.3a', reason: 'railMoveSpNotPayable' }
        pushLog('warning', 'SP 铁路运货：起运站的 SP 不足（13.3a）', '13.3a')
        return false
      }
      setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
      grantSpDumpT(to, side, amountT)
    }
    railCapSpentThisTurn.value = [
      ...railCapSpentThisTurn.value.filter((item) => item.side !== side),
      { side, points: railCapUsedBy(side) + outcome.data.cost },
    ]
    railMoveError.value = null
    lastRailMove.value = {
      rule: outcome.data.rule,
      detail: outcome.data.detail,
      cost: outcome.data.cost,
      path: path.map((hex) => ({ ...hex })),
    }
    pushLog(
      'success',
      `${outcome.data.detail}；${hexLabel(from)} → ${hexLabel(to)}（${path.length - 1} 格）｜` +
        `本回合已用容量 ${railCapUsedBy(side)}/${railCapToday.value[side]}`,
      outcome.data.rule,
    )
    recordSettlement({
      action: 'railMove',
      rule: outcome.data.rule,
      data: {
        cargoKind: cargo.kind,
        cargoId: cargo.id,
        from: { ...from },
        to: { ...to },
        hexes: path.length,
        cost: outcome.data.cost,
        equivalent: outcome.data.equivalent,
        factor: outcome.data.factor,
      },
    })
    return true
  }

  /** C8：步骤清单（12.6 判定 → 12.3 选源/拖取 → 12.6c/d 断补处置；给界面打勾用） */
  const supplyChecklist = computed(() =>
    supplyState.value === null ? [] : supplyStepChecklist(supplyState.value),
  )

  /** C8：来源清单（含距离与路径；可用性由引擎逐条裁定） */
  const supplySources = computed<SupplySourceOption[]>(() => supplyState.value?.sources ?? [])

  /** C8：地图上要画的那条来源（优先界面预览项，其次已选项） */
  const supplyFocusSource = computed<SupplySourceOption | null>(() => {
    const state = supplyState.value
    if (state === null) return null
    const index = supplyPreviewIndex.value
    if (index !== null) return state.sources[index] ?? null
    return state.chosenSource ?? null
  })

  /**
   * C8：焦点来源的**投递/拖取覆盖范围**（12.3d：沿补给路径逐格移动能到的全部格）
   *
   * 供地图铺色「这个补给站/指挥部能够到哪」——与单点判定共用 `supplyCoverage`（同一 `stepMp`）。
   */
  const supplyCoverageHexes = computed<SupplyReachableHex[]>(() => {
    const state = supplyState.value
    const source = supplyFocusSource.value
    if (state === null || source === null) return []
    const hex = source.hex
    if (hex === null) return []
    // 12.3a：直接拖取按**轮式 MP** 计（5 MP）
    if (source.kind === 'dump')
      return supplyCoverage(supplyFacts.value, {
        from: hex,
        side: state.side,
        mobility: 'truck',
        maxMp: DIRECT_DRAW_RANGE_MP,
      })
    // 12.3b：投递按 HQ 的印值投递距离与「颜色所示的机动类型」计
    if (source.kind === 'hqThrow') {
      const hq = units.value.find(
        (unit) => unit.side === state.side && sameHex(unit.hex, hex) && isHqUnit(unit),
      )
      if (hq === undefined) return []
      const view = toThrowHqView(hq)
      return supplyCoverage(supplyFacts.value, {
        from: hex,
        side: state.side,
        mobility: view.throwMobility,
        maxMp: view.throwRangeMp,
      })
    }
    // 12.6a 的追溯源只提供连通性（没有距离上限），不画覆盖范围
    return []
  })

  /**
   * 13.2g-B：把来源表里**编内卡车**那几条按"拖取者"复核一遍（裁定③）
   *
   * 编内卡车**可以**作为来源（12.1b「任何含有 SP 的位置……都被称为补给站」，含装在车上的）
   * 供 **12.5 燃料**与 **12.4 战斗补给**取用，但 13.2g-B 明写「只允许**同一多单位编队**内的单位
   * 拖取它们的 SP」，且**不能投递**（它不是指挥部）。引擎的来源表只认"含 SP 的位置"、
   * 不知道拖取者是谁 ⇒ 在这里逐条复核（判据仍只有一处：引擎 `canDrawFromCarrier`）。
   *
   * ★ 不静默删掉：标成 `ok: false` 并写明 `13.2g-B` 与原因，玩家点它时能看到"为什么拖不了"。
   */
  function reviewCarrierSources(
    sources: readonly SupplySourceOption[],
    drawer: ConsoleUnit,
  ): SupplySourceOption[] {
    return sources.map((source) => {
      if (source.kind !== 'dump' || source.hex === null) return source
      const dump = allSpDumps.value.find(
        (item) => item.side === drawer.side && sameHex(item.hex, source.hex!),
      )
      if (dump === undefined || dump.carrierIsOrganicTruck !== true) return source
      const allowed = canDrawFromCarrier({
        carrierIsOrganicTruck: true,
        carrierFormation: dump.carrierFormation ?? null,
        drawerFormation: drawer.formation,
      })
      if (allowed) return source
      return {
        ...source,
        ok: false,
        rule: '13.2g-B',
        reason: 'carrierFormationMismatch',
        detail:
          `${source.detail}｜13.2g-B：编内卡车的 SP 只许**同一多单位编队**内的单位拖取` +
          `（本车编队 ${dump.carrierFormation ?? '—'}，本单位编队 ${drawer.formation ?? '—'}）`,
      }
    })
  }

  /**
   * 12.3a：该格该方能**直接拖到**的补给站（引擎结论原样，含距离与路径）
   *
   * 唯一可达性判据是引擎的 `drawableDumpsFor`（12.3a 的 5 MP 直拖 + 12.3c 的「相邻即可」）。
   * 本函数只是把「用哪份地图事实」这一句固定下来——修前这句话在仓里抄了四遍
   * （HQ 投递候选 / 吃图上补给的最近站 / 机场整备付款 / 作战格付款），任一处漏了 `.filter(ok)`
   * 都会让「拖不到」的补给站混进候选。
   */
  function drawableDumpsAt(hex: HexRef, side: Side, mobility?: SupplyMobility): DrawableDump[] {
    return drawableDumpsFor(supplyFacts.value, {
      hex,
      side,
      ...(mobility === undefined ? {} : { mobility }),
    }).filter((dump) => dump.ok)
  }

  /**
   * 12.3a：把上一项映射回**补给站账本条目**（按格匹配；账本是 `spDumps` 的唯一来源）
   *
   * ★ 13.2g-B（B42）：给了 `drawer` 时，装载在**编内卡车**上的来源还要过一遍"同一多单位编队"的资格 ——
   *   「只允许**同一多单位编队内的单位**拖取它们的 SP」（判据在引擎 `canDrawFromCarrier`，此处只消费结论）。
   *   不给 `drawer`（例如"这座站在哪"的纯地理查询）则不施加该项检查。
   */
  function drawableSpDumpsAt(
    hex: HexRef,
    side: Side,
    mobility?: SupplyMobility,
    drawer?: ConsoleUnit | null,
  ): SpDump[] {
    const keys = new Set(drawableDumpsAt(hex, side, mobility).map((dump) => hexLabel(dump.hex)))
    // 12.1b（B32 步骤 5）：**装载在运输点数上的 SP** 同样是可拖取的来源
    return allSpDumps.value.filter(
      (dump) =>
        dump.side === side &&
        keys.has(hexLabel(dump.hex)) &&
        (drawer === undefined ||
          drawer === null ||
          canDrawFromCarrier({
            carrierIsOrganicTruck: dump.carrierIsOrganicTruck === true,
            carrierFormation: dump.carrierFormation ?? null,
            drawerFormation: drawer.formation,
          })),
    )
  }

  /**
   * C8：投递时的**付款补给站**候选（12.3b：HQ 先按 12.3a 从补给站拖取 SP，再前送给目标单位）
   *
   * 结论由引擎 `drawableDumpsFor` 给出（把「该格」换成 HQ 所在格），与 HQ 能否投递的判据同源。
   */
  const supplyPayDumpCandidates = computed<SpDump[]>(() => {
    const state = supplyState.value
    if (state === null) return []
    const source = state.chosenSource
    if (source === undefined || source.kind !== 'hqThrow') return []
    const hex = source.hex
    if (hex === null) return []
    const hq = units.value.find(
      (unit) => unit.side === state.side && sameHex(unit.hex, hex) && isHqUnit(unit),
    )
    const mobility = hq === undefined ? 'truck' : toThrowHqView(hq).throwMobility
    /*
     * ★ 批 B 切片 2：把指挥部自己作为**拖取者**传进去 —— 13.2g 末句「玩家可以使用指挥部，将装载于
     *   编内卡车的补给，投递给同一多单位编队内的单位」⇒ 指挥部从编内卡车拖取同样受 13.2g-B 的
     *   "同一多单位编队"约束（判据还是那一条 `canDrawFromCarrier`）。
     */
    return drawableSpDumpsAt(hex, state.side, mobility, hq ?? null)
  })

  /**
   * B14d（用户口径⑪）：在算子图阵列里**点选/再点取消**投递的付款补给站
   *
   * 旧下拉的第一项是「（自动）」＝`payFromDumpId: null`（由引擎取候选第一座），阵列没有"空档"
   * ⇒ 用「点同一座即回到自动」补上这条退路（与轰炸面板的付款站、15.4 的被指定单位同一手感）。
   */
  function toggleSupplyPayDump(dumpId: string): void {
    const current = supplyInputs.value.payFromDumpId
    supplyInputs.value = {
      ...supplyInputs.value,
      payFromDumpId: current === dumpId ? null : dumpId,
    }
  }

  /**
   * C8：吃图上补给（12.6c）的付款补给站
   *
   * 12.6c 的前提是「单位在补给站的拖取或投递距离内」⇒ 取该单位能拖到的**最近**那个补给站付款
   * （多个都在距离内时任选其一皆合法，取最近者仅为确定性）。
   *
   * ★ 抽成具名函数是为了让 `beginSupplyCheckNow` 能在**评估之前**就知道付款站——
   *   12.6c 的批量费率要按「已从**同一补给站**喂过的 RE」取整（见 `oosFedReByDump`）。
   */
  function nearestDrawableDump(hex: HexRef, side: Side): SpDump | null {
    const drawable = drawableDumpsAt(hex, side)
    if (drawable.length === 0) return null
    const nearest = drawable.reduce((a, b) =>
      (a.distanceMp ?? Number.POSITIVE_INFINITY) <= (b.distanceMp ?? Number.POSITIVE_INFINITY)
        ? a
        : b,
    )
    return (
      allSpDumps.value.find((dump) => dump.side === side && sameHex(dump.hex, nearest.hex)) ?? null
    )
  }

  /**
   * 12.6c：本环节各补给站**已喂过的 RE 总量**（批量费率取整用）
   *
   * 条文「每消耗 1T，就可以为最多 2RE ……所有小数向上取整；例如，**6.5 的 RE 需消耗 4T**」
   * ——6.5 RE 只能是**一批单位合计**，故取整作用在批次总量上。界面是一个单位一次地喂，
   * 故用本账本累计"同一补给站本环节已喂了多少 RE"，收费时只付**增量**
   * （`ceil((已喂+本次)/2) − ceil(已喂/2)`），累计恰等于批量口径。
   * 换阶段即清空（批次以本环节为单位）。
   */
  const oosFedReByDump = ref<Record<string, number>>({})

  /** 该补给站本环节已喂的 RE 总量 */
  function fedReOf(dumpId: string | null): number {
    return dumpId === null ? 0 : (oosFedReByDump.value[dumpId] ?? 0)
  }

  /** 12.6c：吃图上补给的付款站（供界面显示） */
  const supplyOosPayDump = computed<SpDump | null>(() => {
    const state = supplyState.value
    if (state === null) return null
    return nearestDrawableDump(state.unitHex, state.side)
  })

  /** C8：结论摘要（12.6 判定 / 12.3 结算 / 12.6c-d 处置；供界面显示） */
  const supplySummary = computed(() => {
    const state = supplyState.value
    if (state === null) return null
    return {
      step: state.step,
      branch: state.branch,
      unitHex: state.unitHex,
      /** 12.6 的判定结论（inSupply / canEatOffTheMap / outOfSupply / notRequired） */
      status: state.assessment.status,
      /** 12.6 追溯结论（含所连到的源） */
      trace: state.assessment.trace,
      /** 12.6c：能否吃图上补给及其代价 */
      canEatOffTheMap: state.assessment.canEatOffTheMap,
      eatingCostT: state.assessment.eatingCostT,
      sourceCount: state.sources.length,
      chosenSource: state.chosenSource ?? null,
      pickup: state.pickup ?? null,
      oos: state.oos ?? null,
      finished: state.finished,
    }
  })

  /**
   * 12.3 + 12.4 / 12.5 / 15.1：本次拖取/投递**应付多少 T**（用户 2026-09-17 裁定⑤「获取即付款」）
   *
   * 「在玩家任何需要补给（追溯补给、**燃料**、**战斗**、建造、补充部队储备，或**飞机整备**）的时候，
   *   都需要使用直接拖取和指挥部投递中的同一种相同的机制进行补给」（12.3 重要提示）
   * ⇒ **获取与用途是同一个动作的两面**，费率由**用途**决定：
   *   · **燃料（12.5）** ⇒ 12.5c-C **单独单位法**：每单位 1 T（本条链是**逐单位**的；
   *     整编队的 12.5c-A 与 HQ 的 12.5c-B 在移动面板里按整编队/指挥部整批付）。判据走引擎
   *     `computeFuelCost`——**费率不在这里另写一份**；
   *   · **飞机整备（15.1）** ⇒ 1 T（15.1B，与 `refitBaseNow` 的 `availableT: 1` 同一口径）；
   *   · **战斗补给（12.4）** ⇒ **不在本链付**（裁定⑥：只在战斗会话内付）⇒ 返回 null，调用方按 12.4 拒绝；
   *   · **补充部队储备（12.10）/ 建造（13.8）** ⇒ **数量即内容** ⇒ 用玩家填的 T 数（补多少储备、
   *     修什么工事），这两条是裁定⑤明许保留手填的例外。
   *
   * ★ 为什么不能再让玩家手填 T 数：12.4/12.5 的费率是死的 ⇒ 自由填 T 数＝允许少付
   *   （修前那条链只扣玩家声明的数字，扣 1T 也能把一辆坦克"加油"）。
   */
  const supplyPickupRequirement = computed<{
    /** 应付 T（`manual` 为真时是玩家填的那个数） */
    t: number
    rule: string
    detail: string
    /** 数量即内容（12.10 储备 / 13.8 建造）⇒ 由玩家填；其余由费率算 */
    manual: boolean
  } | null>(() => {
    const purpose = supplyInputs.value.purpose
    // 12.4 / 裁定⑥：战斗补给只在战斗会话内付（本链不付）
    if (purpose === 'combat') return null
    if (purpose === 'fuel') {
      const cost = computeFuelCost({ method: 'singleUnit', unitsNeedingFuel: 1 })
      if (!cost.ok) return null
      return {
        t: cost.t,
        rule: cost.rule,
        detail: '12.5c-C 单独单位法：每单位 1 T（只在本阶段有效，12.5c-C/12.5d）',
        manual: false,
      }
    }
    if (purpose === 'refit') {
      return { t: 1, rule: '15.1B', detail: '15.1B：整备一次付 1 T', manual: false }
    }
    const manual = Math.max(0, Math.trunc(supplyInputs.value.amountT))
    return purpose === 'internalStocks'
      ? {
          t: manual,
          rule: '12.10',
          detail: `12.10：补给多少部队储备就付多少 T（数量即内容）`,
          manual: true,
        }
      : {
          t: manual,
          rule: '13.8',
          detail: `13.8：建造费用按数量付（数量即内容）`,
          manual: true,
        }
  })

  /* ── C9 空军交互：派生（一切结论来自引擎；此处只做视图整形） ── */

  /** C9：对手方 */
  const enemySide = computed<Side>(() => (activeSide.value === 'axis' ? 'soviet' : 'axis'))

  /** C9：全部飞机视图（双方；引擎内部按阵营过滤） */
  const allAirViews = computed<AirMissionAircraftView[]>(() =>
    airUnits.value.map(toAirMissionAircraftView),
  )

  /** C9：当前方的飞机 */
  const ownAirUnits = computed<ConsoleAirUnit[]>(() =>
    airUnits.value.filter((air) => air.side === activeSide.value),
  )

  /**
   * C9：全部空军基地（★ 基地归属权）
   *
   * 归属方＝该空军基地算子被摆放/翻面后的 `side`（15.0：中立算子由占有一方决定）；
   * 15.2 的**简易机场**在本作单位库没有独立算子，故由玩家逐格声明（`airstripBaseIds`），
   * 声明后按 15.2 的能力处理：无防空值（等级 0）、整备 1 架、激活堆叠 4、永不缩减；
   * 15.1C 的「未抵消敌方 ZOC」由追溯事实的 `inEnemyZoc`（含 4.5b 抵消）逐基地填入。
   */
  const airBases = computed<AirBaseView[]>(() =>
    units.value
      .filter((unit) => unit.noncombatKind === 'air_base')
      .map(toAirBaseView)
      .map((base) => {
        const airstrip = airstripBaseIds.value.includes(base.id)
        return {
          ...base,
          inUnnegatedEnemyZoc: zocOnlySupplyFacts.value.inEnemyZoc(base.hex, base.side),
          ...(airstrip ? { level: 0, isAirstrip: true } : {}),
        }
      }),
  )

  /** C9：当前方的空军基地 */
  const ownAirBases = computed<AirBaseView[]>(() =>
    airBases.value.filter((base) => base.side === activeSide.value),
  )

  /**
   * 14.9e：**逐机档位**（A 双程 / B 正常 / C 半程）
   *
   * 「空运任务可飞往任何友方空军基地。**将每个飞机分开处理**，任务格可以……A) 两倍距离内（目的地变
   *   非激活）/ B) 正常距离内 / C) 一半距离内（**运输容量翻倍**）。」
   * 判据只有一处（引擎 `airTransportProfile`）；本投影只把 `origins` 里逐机的距离与航程喂进去，
   * 供界面逐机显示，并让 14.9f 的例外可以由"有没有 A 档"推出（§17.71 的如实边界②）。
   */
  const airTransportProfiles = computed<
    { aircraftId: string; profile: string; capacityMultiplier: number; detail: string }[]
  >(() => {
    const assignment = airState.value?.assignment
    if (assignment === undefined) return []
    return assignment.origins.map((origin) => {
      const result = airTransportProfile({
        distanceHexes: origin.distanceHexes,
        rangeHexes: origin.rangeHexes,
      })
      return {
        aircraftId: origin.aircraftId,
        profile: result.profile ?? '—',
        capacityMultiplier: result.capacityMultiplier,
        detail: result.detail,
      }
    })
  })

  /** 14.9e-A：本次任务里**在目的地变非激活**（双程飞法）的飞机 —— 14.9f 的例外交给它判 */
  const airOverLimitAircraftInactive = computed<boolean>(() =>
    airTransportProfiles.value.some((item) => item.profile === 'A'),
  )

  /** C9：本次任务的参战机（未开始时＝点选集合；已开始时＝分配结论里的名单） */
  const airMissionAirUnits = computed<ConsoleAirUnit[]>(() => {
    const state = airState.value
    const ids = state === null ? airMissionAirIds.value : state.assignment.aircraftIds
    return ids
      .map((id) => airUnits.value.find((air) => air.instanceId === id))
      .filter((air): air is ConsoleAirUnit => air !== undefined)
  })

  /**
   * 14.3e-B：本场空战里**攻方**在场的飞机（逐轮点名的候选取此）
   *
   * 攻方由引擎给（`combat.roles.attackerSide`，14.3c 的资格判定在引擎里），
   * 本投影只做"哪一方 / 格内哪几架"的搬运 —— 界面据此铺阵列，缺省仍可全自动。
   */
  const airCombatAttackerPlanes = computed<ConsoleAirUnit[]>(() => {
    const hex = airTargetHex.value
    const side = airState.value?.combat?.roles.attackerSide ?? null
    if (hex === null || side === null) return []
    return airUnitsInHex(hex, side)
  })

  /** 14.3e-B：本场空战里**守方**在场的飞机（守方**任选**，含括号值的飞机） */
  const airCombatDefenderPlanes = computed<ConsoleAirUnit[]>(() => {
    const hex = airTargetHex.value
    const side = airState.value?.combat?.roles.defenderSide ?? null
    if (hex === null || side === null) return []
    return airUnitsInHex(hex, side)
  })

  /**
   * 14.3e-B：逐轮点名的**轮数上界**（双方在场机数之和）
   *
   * 实际轮数由骰面与返航决定（14.3e-D：直到一方成为该格唯一一方），故这是"最多可能几轮"，
   * 界面按它铺点名的行数；少铺的行玩家不点名，即交给引擎自动。
   */
  const airCombatRoundBudget = computed<number>(
    () => airCombatAttackerPlanes.value.length + airCombatDefenderPlanes.value.length,
  )

  /**
   * 14.5 / 14.3e-B：**迎战拦截机的那一架任务机**（拦截空战里的守方）
   *
   * 缺省口径与引擎**一致**：ACV 最高（`resolveAirCombatRounds` 的 `pickHighestAcv`）。
   * ★ 修前 store 在未点名时回落"任务机名单第一架"，与引擎的缺省不一致 ——
   *   同一件事两处不同答案，玩家看到的那一架与实际交手的那一架可能不是同一架。
   */
  const airInterceptionDefender = computed<ConsoleAirUnit | null>(() => {
    const named = airInputs.value.namedDefenderId
    if (named !== null) {
      return airMissionAirUnits.value.find((air) => air.instanceId === named) ?? null
    }
    const planes = airMissionAirUnits.value
    if (planes.length === 0) return null
    // 14.1b：ACV 取**当前面**（减损机用减损面值；与引擎 `pickHighestAcv` 的入参同源）
    return planes.reduce((best, plane) =>
      airCombatRatingOf(plane) > airCombatRatingOf(best) ? plane : best,
    )
  })

  /**
   * 14.10a：把某枚单位加入 / 移出**本次的货物**（面板点算子图阵列直连这里）
   *
   * 只做清单维护：资格（Para 声明）、运力、计划回合、目标格全部由引擎在**宣布任务**时判。
   */
  function toggleAirCargoUnit(instanceId: string): void {
    const ids = airInputs.value.cargoUnitIds
    airInputs.value = {
      ...airInputs.value,
      cargoUnitIds: ids.includes(instanceId)
        ? ids.filter((id) => id !== instanceId)
        : [...ids, instanceId],
    }
  }

  /**
   * 14.9c（第五批批 C 切片 2）：**可作单位货物的本方单位**
   *
   * 候选＝图上本方**地面战斗**单位且**处于移动模式**——「处于**移动模式**的战斗单位也可以空运，
   * 前提是其 MA 为 **10 或以下的步行 MP**」。本作数据里战斗面 MA 最大 10 ⇒ "步行 MP≤10" 恒满足
   * （判据层真值表在引擎 `missionCargoCheck` 里钉），候选只筛"模式"这一半；
   * 空投另有 Para 资格（由玩家在界面上声明 `airInputs.cargoUnitsParaCapable`），不在此预筛。
   */
  const airCargoUnitChoices = computed<ConsoleUnit[]>(() =>
    units.value.filter(
      (unit) => unit.side === activeSide.value && unit.isCombat && unit.mode.mode === 'move',
    ),
  )

  /** C9：任务编成里是否编有战斗机（14.4e 表 17-3 的 +1/+2 分档以此为准） */
  const airMissionHasFighter = computed<boolean>(() =>
    airMissionAirUnits.value.some((air) => isFighterAircraft(air.aircraftType)),
  )

  /** C9：步骤清单（14.2f A–G；给界面打勾用） */
  const airChecklist = computed(() =>
    airState.value === null ? [] : airInteractionChecklist(airState.value),
  )

  /** C9：任务格是否位于对手的巡逻区内（14.4a/14.4e ⇒ 防空加强；也是拦截的前提） */
  const airTargetInEnemyPatrolZone = computed<boolean>(() => {
    const hex = airTargetHex.value
    if (hex === null) return false
    return inPatrolZoneOf({
      hex,
      side: enemySide.value,
      bases: airBases.value,
      aircraft: allAirViews.value,
    })
  })

  /** C9：对手的拦截资格与候选拦截机（14.5；null＝任务格未定） */
  const airInterceptionResponse = computed<InterceptionResponse | null>(() => {
    const hex = airTargetHex.value
    if (hex === null) return null
    return planInterceptionResponse({
      side: enemySide.value,
      missionKind: airMissionKind.value,
      missionHex: hex,
      // 14.5：一次任务只能被拦截一次；操作台在声明拦截后即由 `airState` 记录下来
      alreadyIntercepted: airState.value?.interception?.declared === true,
      aircraft: allAirViews.value,
      bases: airBases.value,
    })
  })

  /** C9：可作为拦截机的对手飞机（14.5：一次仅一架） */
  const airInterceptorCandidates = computed<ConsoleAirUnit[]>(() => {
    const response = airInterceptionResponse.value
    if (response === null) return []
    return response.eligibleFighterIds
      .map((id) => airUnits.value.find((air) => air.instanceId === id))
      .filter((air): air is ConsoleAirUnit => air !== undefined)
  })

  /** C9：任务格的空军基地等级（14.4e 的 +# 项；简易机场为 0，15.2F） */
  const airTargetBaseLevel = computed<number>(() => {
    const hex = airTargetHex.value
    if (hex === null) return 0
    return airBases.value.find((base) => sameHex(base.hex, hex))?.level ?? 0
  })

  /** C9：任务格的空中设施**是否为简易机场**（15.2F：不能提供任何防空值） */
  const airTargetBaseIsAirstrip = computed<boolean>(() => {
    const hex = airTargetHex.value
    if (hex === null) return false
    return airBases.value.find((base) => sameHex(base.hex, hex))?.isAirstrip === true
  })

  /**
   * C9：任务格内的**敌方**空中/基地事实（14.3 空战前提）
   *
   * 全部由**盘面**推出（不再手工填数字）：敌方激活机数、是否有可发起空战的机、是否有敌方基地。
   * 14.3：任务格内没有敌方基地就不会发生空战。
   */
  const airEnemyAtTarget = computed<{
    activeAircraft: number
    canInitiate: boolean
    hasAirBase: boolean
  }>(() => {
    const hex = airTargetHex.value
    if (hex === null) return { activeAircraft: 0, canInitiate: false, hasAirBase: false }
    const aircraft = airUnits.value.filter(
      (air) =>
        air.side === enemySide.value &&
        air.airStatus === 'active' &&
        air.steps > 0 &&
        sameHex(air.hex, hex),
    )
    return {
      activeAircraft: aircraft.length,
      canInitiate: aircraft.some((air) => air.canInitiateAirCombat),
      hasAirBase: airBases.value.some(
        (base) => base.side === enemySide.value && sameHex(base.hex, hex),
      ),
    }
  })

  /** C9：可被夺取的**敌方**空军基地（9.14f：敌方可攻击单位已进入该格） */
  const capturableEnemyAirBases = computed<AirBaseView[]>(() =>
    airBases.value.filter((base) => base.side === enemySide.value),
  )

  /** C9：当前方的巡逻区覆盖格（14.4c；供地图铺色） */
  const airPatrolZoneHexes = computed<HexRef[]>(() =>
    patrolZoneHexes({ side: activeSide.value, bases: airBases.value, aircraft: allAirViews.value }),
  )

  /** C9：对手的巡逻区覆盖格（14.4c；供地图铺色） */
  const airEnemyPatrolZoneHexes = computed<HexRef[]>(() =>
    patrolZoneHexes({ side: enemySide.value, bases: airBases.value, aircraft: allAirViews.value }),
  )

  /** C9：某基地格内的非激活飞机（15.1B：由玩家选择整备哪些） */
  const airInactiveAtBase = computed<(baseId: string) => ConsoleAirUnit[]>(
    () => (baseId: string) => {
      const base = airBases.value.find((item) => item.id === baseId)
      if (base === undefined) return []
      return airUnits.value.filter(
        (air) =>
          air.side === base.side && air.airStatus === 'inactive' && sameHex(air.hex, base.hex),
      )
    },
  )

  /**
   * C9：某基地的**整备付款补给站**候选（15.1B：1T/基地）
   *
   * 15.1 只规定费用，取用仍走 12.3 的补给渠道：「图上补给……可通过**直接拖取或从指挥部投递**
   * 获得」⇒ 候选＝ 12.3a 直拖可达的站 **∪** 12.3b 指挥部投递可达的站（第五批 B1 补上后半，
   * 判据与燃料链 `hqDeliveryDumpKeys` 共用一处；修前只有直拖半边 ⇒ 基地 5MP 内无站但
   * 在某 HQ 投递距离内时合法整备被拒）。
   */
  const airRefitPayDumps = computed<(baseId: string) => SpDump[]>(() => (baseId: string) => {
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) return []
    const drawable = drawableDumpsFor(supplyFacts.value, {
      hex: base.hex,
      side: base.side,
    }).filter((dump) => dump.ok)
    const keys = new Set(drawable.map((dump) => hexLabel(dump.hex)))
    // 12.3b：该基地格同时处在某指挥部的投递距离内 ⇒ 该 HQ 拖得到的站也是合法付款来源
    for (const key of hqDeliveryDumpKeys(base.side, [base])) keys.add(key)
    return spDumps.value.filter(
      (dump) => dump.side === base.side && keys.has(hexLabel(dump.hex)) && dump.sp + dump.t > 0,
    )
  })

  /** C9：某基地格内**可被指定**执行缩减的地面单位（15.4：战斗模式且本阶段未移动） */
  const airReductionCandidates = computed<(baseId: string) => ConsoleUnit[]>(
    () => (baseId: string) => {
      const base = airBases.value.find((item) => item.id === baseId)
      if (base === undefined) return []
      return units.value.filter(
        (unit) =>
          unit.side === base.side &&
          unit.isCombat &&
          !unit.movementEnded &&
          sameHex(unit.hex, base.hex),
      )
    },
  )

  /** C9：本阶段已完成整备的基地（15.1A；视图用） */
  const refitDoneBases = computed(() =>
    ownAirBases.value.filter((base) => refitDoneBaseIds.value.includes(base.id)),
  )

  /* ── 15.1 整备的交互三件套（点基地 → 勾飞机 → 点地图上的补给付款） ── */

  /** 正在整备的基地（null = 没有进行中的整备） */
  const refitBase = computed(() =>
    refitTargetBaseId.value === null
      ? null
      : (airBases.value.find((base) => base.id === refitTargetBaseId.value) ?? null),
  )

  /** 该基地格内可勾选整备的非激活飞机（15.1B） */
  const refitCandidates = computed<readonly ConsoleAirUnit[]>(() =>
    refitTargetBaseId.value === null ? [] : airInactiveAtBase.value(refitTargetBaseId.value),
  )

  /** 已勾选要整备的飞机实例 id */
  const refitSelectedIds = computed<string[]>(() => airInputs.value.refitAircraftIds)

  /** 该基地可付款的补给站（15.1B：1T；地图上金黄方框高亮，点它即付款并结算） */
  const refitPayDumps = computed<readonly SpDump[]>(() =>
    refitTargetBaseId.value === null ? [] : airRefitPayDumps.value(refitTargetBaseId.value),
  )

  /** C9：本阶段已缩减过的基地（15.4；视图用） */
  const reducedBases = computed(() =>
    ownAirBases.value.filter((base) => reducedBaseIds.value.includes(base.id)),
  )

  /**
   * C5：全部单位的运行态视图（引擎 `move-interaction` 函数的输入）
   *
   * 与 `state-types.Unit` 的对应：`spentMp`→（本阶段累计已耗 MP）、`ended`→`movementEnded`。
   */
  const moveRuntime = computed<MoveUnitRuntime[]>(() => units.value.map(toMoveRuntime))
  /**
   * C5：本次移动的可到达范围（堆叠取并集；6.1/6.1b/6.1f）
   *
   * 结论全部来自引擎 `reachableForMove`（底层是 `computeReachableHexes`，与逐格 `evaluateStep`
   * 同一套判据）；F 战斗段没有移动环节（2.2），故此处不会存在「已经开始移动」的状态。
   */
  const groupReachable = computed<GroupReachable>(() => {
    const interaction = moveInteraction.value
    if (interaction === null) return { units: [], hexes: [] }
    // 2.2：回合准备环节没有行动段 ⇒ 不给出任何可走格（否则界面会"看起来能走"）
    if (segmentLocked.value) return { units: [], hexes: [] }
    return reachableForMove({
      context: moveContext.value,
      interaction,
      runtime: moveRuntime.value,
    })
  })

  /** C5：参移单位（选中顺序；界面显示与模式/燃料面板用） */
  const moveUnits = computed<ConsoleUnit[]>(() => {
    const interaction = moveInteraction.value
    if (interaction === null) return []
    return interaction.unitIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
  })

  /** C5：仍在本轮移动中的参移单位（未结束） */
  const activeMoveUnits = computed<ConsoleUnit[]>(() =>
    moveUnits.value.filter((unit) => !unit.movementEnded),
  )

  /**
   * 4.5a-A：**可发起突袭**的参移单位（第六批条 14）
   *
   * ＝ 仍在移动者 **加上** 「本轮因进入未抵消敌方 ZOC 而被迫停车」者。
   *   后者由 `zocStoppedMoveUnitIds` 记账：它们的 `movementEnded` 已被 `planStep` 置真，
   *   但 4.5a-A 明写这一枚「要么结束移动、要么进行突袭」⇒ 停车**不等于**丧失突袭资格。
   *   （反过来，因 6.1f 主动放下、8.1f 选项撤退、走完 MA 等而结束的单位**不在**账本里 ⇒ 不再可突袭。）
   */
  const overrunCandidateUnits = computed<ConsoleUnit[]>(() =>
    moveUnits.value.filter(
      (unit) => !unit.movementEnded || zocStoppedMoveUnitIds.value.includes(unit.instanceId),
    ),
  )

  /** 突袭发起格（4.5a-A：停车后仍在原地 ⇒ 取候选里第一枚的当前格） */
  const overrunStackHex = computed<HexRef | null>(() => {
    const unit = overrunCandidateUnits.value[0]
    return unit === undefined ? null : { col: unit.hex.col, row: unit.hex.row }
  })

  /** C5：悬停格的单步预览（路径与消耗预览；不在范围内则为 null） */
  const stepPreview = computed<StepPreview | null>(() => {
    const interaction = moveInteraction.value
    const hover = hoverHex.value
    if (interaction === null || hover === null) return null
    const node = reachableNodeAt(groupReachable.value.hexes, hover)
    if (node === null) return null
    return previewStep({
      context: moveContext.value,
      interaction,
      runtime: moveRuntime.value,
      to: hover,
      path: node.path,
    })
  })

  /**
   * C5：悬停格对应的**可到达节点**（路径 + 累计 MP）
   *
   * 悬停远处格时「单步预览」会因不相邻而判 blocked，故界面要的是这个：
   * 路径与走过去的**累计消耗**（6.1a）；单步明细只在相邻时才有意义。
   */
  const hoverNode = computed(() => {
    const hover = hoverHex.value
    if (hover === null) return null
    return reachableNodeAt(groupReachable.value.hexes, hover)
  })
  /** 当前方在选中算子处的合法性（B21 探针：不选单位时不判） */
  const selectedLegality = computed<LegalityVerdict | null>(() => {
    const unit = selectedUnit.value
    if (unit === null) return null
    return checkLegality(
      buildLegalityRequest({
        action: 'move',
        unit,
        context: moveContext.value,
        units: units.value,
        date: date.value,
        fuelPaid: unit.fuelled,
        phase: phase.value,
      }),
    )
  })

  function pushLog(
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ): void {
    log.value.unshift({
      id: createId('log'),
      kind,
      text,
      ...(rule === undefined ? {} : { rule }),
      ...(derivation === undefined ? {} : { derivation }),
    })
    if (log.value.length > 60) log.value.length = 60
  }

  /**
   * ⑭ 接线：把操作台的**一笔结算**写进会话日志（D2 的检索与重放随即覆盖它）
   *
   * 与会话日志条目同构：`turn / phase / side / action / rolls / outcome`。其中 `turn/phase`
   * 取操作台**自己的局面钟**——操作台是裁判台，它记的是「这手棋发生在哪一段」。
   *
   * `rolls`：**以骰源缓冲为准**（见 `pendingRolls`）——凡是「掷了骰」就必有记录，
   * 因为操作台里有几处是「先掷骰、再问引擎」，若引擎拒绝则那一步没有结算条目；
   * 缓冲会把这类骰子顺延记进下一笔结算，保证 D2 的重放不会因漏记而与实际序列错位。
   * 缓冲为空时才用调用方给的 `input.rolls`（两处内容等价，只是兜底不同）。
   *
   * **未开局**（没有会话）时静默跳过，操作台照常独立演练。
   *
   * @param input.action 审计标签（如 `move` / `combat` / `barrage` / `fuel` / `cleanUp`）
   * @param input.data   结算数据（进 `outcome.data`；放复核过程时用 `[DERIVATION_KEY]`）
   * @returns 是否真的入账（未开局 ⇒ false）
   */
  function recordSettlement(input: {
    action: string
    rule: string
    side?: Side
    rolls?: readonly DiceRoll[]
    pending?: PendingEffect[]
    data?: Record<string, unknown>
  }): boolean {
    const rolls = pendingRolls.length > 0 ? pendingRolls.splice(0) : [...(input.rolls ?? [])]
    const entry: SessionLogEntry = {
      turn: turn.value,
      phase: phase.value,
      side: input.side ?? activeSide.value,
      action: input.action,
      rolls,
      outcome: succeed(input.rule, input.data ?? {}, [...(input.pending ?? [])]),
    }
    return session.appendSettlement(entry)
  }

  /** 该格的算子（按摆放顺序） */
  function unitsAt(hex: HexRef): ConsoleUnit[] {
    return units.value.filter((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row)
  }

  /* ────────────────────────────── W7 C16：移动中的突袭（8.0 / 8.1） ────────────────────────────── */

  /**
   * 本次突袭的托管信息（结算完就地记账用）
   *
   * 突袭是「移动里夹一仗」：宣布时先记下参突者与突袭前的剩余 MP，
   * 等 C6 九步走完（推进步）再把这些换算成移动记账（8.1a 扣 3 MP、8.0 必须进格、8.1f 结束移动）。
   */
  const overrunContext = ref<{
    target: HexRef
    participantIds: string[]
    mpRemainingBefore: number
    runtimeBefore: MoveUnitRuntime[]
  } | null>(null)

  /**
   * 条 17（批 F·F2）：4.5a 标记——**突袭强行进入敌方 ZOC 的格**后，该格的单位
   * 「不得离开、须再突袭或停」（8.0 的进入是强制的，故 4.5a 的约束在其后就位）。
   *
   * 仅作**事实标记 + UI 提示**用（不改移动引擎的 ZOC 停车逻辑）：突袭记账把单位落进
   * `context.target` 且该格处于敌方 ZOC 时置位；新开一场突袭（重置意图）或移动交互收束时清掉。
   */
  const overrunZocHeldHex = ref<HexRef | null>(null)

  /** 4.5a：当前移动交互里是否有一格"须再突袭或停"的 ZOC 约束（UI 提示用） */
  const overrunZocHeld = computed(() =>
    overrunZocHeldHex.value === null ? null : { ...overrunZocHeldHex.value },
  )

  /**
   * 8.1g：本次突袭的**参突单位**（空数组 ＝ 仍在移动的全部单位）
   *
   * 「一个堆叠进行突袭时，堆叠中的**部分单位**可以留在原地（8.1h：它们仍计入 4.8a，
   *  但不参突、也不受结果影响）」——故这是一份显式选择，而不是「整堆叠一律参突」。
   */
  const overrunParticipantIds = ref<string[]>([])

  /** 8.1g：勾选/取消一个参突单位 */
  function toggleOverrunParticipant(instanceId: string): void {
    overrunParticipantIds.value = overrunParticipantIds.value.includes(instanceId)
      ? overrunParticipantIds.value.filter((id) => id !== instanceId)
      : [...overrunParticipantIds.value, instanceId]
  }

  /** 8.1g：本格的参突/留驻拆分（引擎 `splitOverrunStack` 的唯一消费点；供界面显示） */
  const overrunSplitNow = computed(() => {
    const hex = overrunStackHex.value
    if (hex === null) return null
    // 4.5a-A：同上 —— 停车者仍可作为参突者被勾选
    const movingIds = overrunCandidateUnits.value.map((unit) => unit.instanceId)
    const chosen =
      overrunParticipantIds.value.length > 0
        ? overrunParticipantIds.value.filter((id) => movingIds.includes(id))
        : movingIds
    return splitOverrunStack({
      side: activeSide.value,
      friendlyUnits: unitsAt(hex).map((unit) => ({
        id: unit.instanceId,
        re: unit.re,
        isCombat: unit.isCombat,
      })),
      participantIds: chosen,
    })
  })

  /** 本次移动中活跃单位的**当前格**（整堆叠移动 ⇒ 取第一枚活跃单位的位置） */
  const moveStackHex = computed<HexRef | null>(() => {
    const unit = overrunCandidateUnits.value[0] ?? activeMoveUnits.value[0]
    return unit === undefined ? null : { col: unit.hex.col, row: unit.hex.row }
  })

  /**
   * **突袭候选**里**最紧**的剩余 MP（8.1a：参突者都要 ≥3 MP，故取最小值当门槛）
   *
   * ★ 4.5a-A（第六批条 14）：因进 ZOC 停车的单位（`movementEnded` 为真、但在
   *   `zocStoppedMoveUnitIds` 账本里）**仍要计入**——它们正是"停车后改突袭"的那一批。
   */
  const moveMinRemainingMp = computed<number>(() => {
    const interaction = moveInteraction.value
    if (interaction === null) return 0
    let min = Number.POSITIVE_INFINITY
    for (const id of interaction.unitIds) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit === undefined) continue
      if (unit.movementEnded && !zocStoppedMoveUnitIds.value.includes(id)) continue
      const ma = availableMaOf(unit, movementPhaseOf(phase.value))
      min = Math.min(min, ma - unit.mpSpent)
    }
    return Number.isFinite(min) ? min : 0
  })

  /**
   * 可突袭目标（8.0 / 8.1）——移动中随位置实时重算
   *
   * 候选＝当前格的相邻敌方格 **加上** 悬停/预览终点相邻的敌方格（后者点它会先沿路径走过去再突袭）。
   * 资格一律交给 `engine/rules/overrun.ts#overrunEligibility`（本层不重算规则），
   * 界面据此画紫环（`overrunTargets`），玩家点它即发起突袭。
   */
  const overrunTargets = computed<WorkbenchOverrunTarget[]>(() => {
    const interaction = moveInteraction.value
    const from = overrunStackHex.value
    if (interaction === null || from === null) return []
    // 4.5a-A：候选＝仍在动者 **＋** 本次因进 ZOC 停车者（后者仍可选择突袭）
    const participants = overrunCandidateUnits.value.map((unit) => unit.instanceId)
    if (participants.length === 0) return []
    const mpRemaining = moveMinRemainingMp.value
    if (mpRemaining < 1) return []

    const anchors: { hex: HexRef; adjacent: boolean }[] = neighbors(from).map((item) => ({
      hex: item.hex,
      adjacent: true,
    }))
    const preview = stepPreview.value?.to ?? hoverNode.value?.hex ?? null
    if (preview !== null && !sameHex(preview, from)) {
      for (const item of neighbors(preview)) {
        if (!anchors.some((anchor) => sameHex(anchor.hex, item.hex))) {
          anchors.push({ hex: item.hex, adjacent: false })
        }
      }
    }

    const found: WorkbenchOverrunTarget[] = []
    for (const anchor of anchors) {
      const defenders = unitsAt(anchor.hex).filter(
        (unit) => unit.side !== activeSide.value && unit.isCombat,
      )
      if (defenders.length === 0) continue
      const eligibility = overrunEligibility({
        phase: movementPhaseOf(phase.value),
        context: moveContext.value,
        unitIds: participants,
        target: anchor.hex,
        mpRemaining,
        // 6.1：本次移动的单位是在**同一格**一起开拔的（界面只允许选中一堆叠 ⇒ 恒为真）
        startedStackedTogether: true,
        defenders: defenders.map((unit) => ({ id: unit.instanceId, isCombat: unit.isCombat })),
      })
      if (eligibility.ok) {
        found.push({ hex: anchor.hex, mpCost: eligibility.mpCost, adjacentToPath: anchor.adjacent })
      }
    }
    return found
  })

  /** 该格是否在本次移动的可突袭目标里（界面点选判定用） */
  const overrunTargetHexes = computed<HexRef[]>(() => overrunTargets.value.map((hint) => hint.hex))

  /**
   * 条 21（批 F·F2）：战斗段「可攻击位置」高亮（随选人实时算）
   *
   * 触发：战斗工具已开（`battleMode` 非 null）且尚未选定防御格（`battleTarget` 为 null）。
   * 含义：把「当前攻方选择集能合法攻击的敌方战斗单位所在格」实时算出来画到地图上，
   * 玩家点它即 `selectCombatDefenderHex` 选定防御格（9.0/9.1）。
   *
   * 攻方选择集：
   *   · 已点选攻方（`combatAttackerIds` 非空）⇒ 取该集合（群攻要求**全部**攻方都邻接防御格，故取交集）；
   *   · 尚未点选 ⇒ 取全部己方战斗单位（「本方可攻击的格」全集，便于玩家先点防御格再自动收攻方）。
   *
   * 每枚候选防御格的合法性一律交给引擎 `checkLegality`（`action:'attack'`），本层不重算规则。
   * 只在战斗工具态、且未选防御格时给（选定后高亮即撤，避免与战斗流程图层打架）。
   */
  const combatAttackableHexes = computed<HexRef[]>(() => {
    // 战斗工具（「打一仗」）激活、且尚未选定防御格时，才把可攻击位置画到地图上
    if (tool.value !== 'battle') return []
    if (battleTarget.value !== null) return []
    const side = activeSide.value
    const attackers =
      combatAttackerIds.value.length > 0
        ? combatAttackerIds.value
            .map((id) => units.value.find((unit) => unit.instanceId === id))
            .filter((unit): unit is ConsoleUnit => unit !== undefined)
        : units.value.filter((unit) => unit.side === side && unit.isCombat && unit.steps > 0)
    if (attackers.length === 0) return []
    // 候选防御格＝所有敌方战斗单位所在格（去重）
    const enemyHexKey = new Map<string, HexRef>()
    for (const unit of units.value) {
      if (unit.side !== side && unit.isCombat && unit.steps > 0) {
        enemyHexKey.set(`${unit.hex.col}.${unit.hex.row}`, unit.hex)
      }
    }
    const result: HexRef[] = []
    for (const hex of enemyHexKey.values()) {
      const adjacencyOk = attackers.every((unit) => areAdjacent(unit.hex, hex))
      const someAdjacent = attackers.some((unit) => areAdjacent(unit.hex, hex))
      // 群攻（已点选）→ 全部攻方须邻接且该格合法；未点选 → 任一己方邻接且合法即可
      const candidateOk = combatAttackerIds.value.length > 0 ? adjacencyOk : someAdjacent
      if (!candidateOk) continue
      const legal = attackers.some((unit) => {
        if (!areAdjacent(unit.hex, hex)) return false
        const verdict = checkLegality(
          buildLegalityRequest({
            action: 'attack',
            unit,
            context: moveContext.value,
            units: units.value,
            date: date.value,
            target: hex,
            phase: phase.value,
          }),
        )
        return verdict.ok
      })
      if (legal) result.push(hex)
    }
    return result
  })

  /**
   * 发起突袭（8.0 / 8.1a）
   *
   * 流程：资格判定（引擎）→ 记下突袭前状态 → 以 `attackType:'overrun'` 走 9.2 九步流程
   * （与常规战斗同一条路，只是奇袭表用 9.8 的 overrun 行、且 9.13b-B 不给进击标记）；
   * 结算到推进步时再由 `settleOverrunMove` 把 3 MP 与进格记回移动交互。
   *
   * ★ **8.1g / 8.1h 的堆叠拆分**：参突单位由 `overrunParticipantIds` 指定（缺省＝仍在移动的全部
   *   单位，此时行为与修前一致）；未被指定的单位**留在原格**（8.1h：仍计入 4.8a，但不参突、
   *   也不受突袭结果影响）。拆分口径的唯一实现是引擎的 `splitOverrunStack`。
   */
  function overrunNow(hex: HexRef): boolean {
    if (!requireAction('move.overrun', '突袭')) return false
    // 条 17（批 F·F2）：新开一场突袭＝"再突袭"意图，旧的 4.5a 约束作废
    overrunZocHeldHex.value = null
    const interaction = moveInteraction.value
    // 4.5a-A：发起格取突袭候选（含"进 ZOC 停车但仍可突袭"者），不是 `activeMoveUnits`
    const from = overrunStackHex.value
    if (interaction === null || from === null) {
      pushLog('warning', '先选中己方单位/堆叠并开始移动，再点相邻敌方格发起突袭（8.0）', '8.0')
      return false
    }
    // 9.2 未收束时不得再开一场：否则前一场会被静默顶掉（其结果与记账都丢）
    if (combatState.value !== null && !combatState.value.finished) {
      pushLog(
        'warning',
        `本场战斗（${hexLabel(battleTarget.value?.hex ?? from)}）尚未结算完 9.2 流程：` +
          `请先走完推进步，或点「放弃本场战斗 / 突袭」`,
        '9.2',
      )
      return false
    }
    // 若点的是「沿预览路径走过去后才相邻」的格，先走过去（6.1 逐格移动）
    if (!areAdjacent(from, hex)) {
      const preview = stepPreview.value
      if (preview === null || !sameHex(preview.to, hex)) {
        pushLog(
          'warning',
          `${hexLabel(hex)} 与当前格不相邻：先走到它旁边的格，再点它发起突袭（8.0）`,
          '8.0',
        )
        return false
      }
    }

    /*
     * 8.1g / 8.1h：参突单位是**仍在移动的单位中被指定的一批**；未指定时＝全部（与修前一致）。
     * 拆分（谁参突 / 谁留驻 / 原格战斗 RE）的唯一实现是引擎的 `splitOverrunStack`。
     */
    // 4.5a-A：参突候选含"进 ZOC 停车"者（停车 ≠ 丧失突袭资格）
    const movingIds = overrunCandidateUnits.value.map((unit) => unit.instanceId)
    const chosen =
      overrunParticipantIds.value.length > 0
        ? overrunParticipantIds.value.filter((id) => movingIds.includes(id))
        : movingIds
    const split = splitOverrunStack({
      side: activeSide.value,
      friendlyUnits: unitsAt(from).map((unit) => ({
        id: unit.instanceId,
        re: unit.re,
        isCombat: unit.isCombat,
      })),
      participantIds: chosen,
    })
    const participants = [...split.participantIds]
    if (participants.length === 0) {
      pushLog('warning', '没有仍在移动中的单位可以突袭（6.1g）', '6.1g')
      return false
    }
    const defenders = unitsAt(hex).filter((unit) => unit.side !== activeSide.value && unit.isCombat)
    const eligibility = overrunEligibility({
      phase: movementPhaseOf(phase.value),
      context: moveContext.value,
      unitIds: participants,
      target: hex,
      mpRemaining: moveMinRemainingMp.value,
      startedStackedTogether: true,
      defenders: defenders.map((unit) => ({ id: unit.instanceId, isCombat: unit.isCombat })),
    })
    if (!eligibility.ok) {
      combatError.value = { rule: eligibility.rule, reason: eligibility.reason }
      pushLog(
        'warning',
        `不能突袭 ${hexLabel(hex)}：${eligibility.reason}（${eligibility.rule}）`,
        eligibility.rule,
      )
      return false
    }

    // 记下突袭前状态（结算后据此记账；撤销一步也能整步还原）
    overrunContext.value = {
      target: { ...hex },
      participantIds: [...participants],
      mpRemainingBefore: moveMinRemainingMp.value,
      runtimeBefore: moveRuntime.value
        .filter((unit) => participants.includes(unit.unitId))
        .map((unit) => ({ ...unit, hex: { ...unit.hex } })),
    }
    battleTarget.value = {
      hex,
      defenderIds: defenders.map((unit) => unit.instanceId),
    }
    combatAttackerIds.value = [...participants]
    battleMode.value = 'full'
    const composed = acceptCombat(
      beginCombat({
        attackers: combatAttackers.value.map(toBattleUnitView),
        defenders: battleDefenders.value.map(toBattleUnitView),
        facts: combatFacts.value,
        attackType: 'overrun',
        phase: phase.value,
      }),
      '突袭构成',
    )
    if (composed === null) {
      overrunContext.value = null
      return false
    }
    combatState.value = composed
    // 9.12f：突袭也是一种战斗 ⇒ 同样在「战斗开始时」拍快照
    captureCombatStartSnapshot()
    combatSurpriseDie.value = null
    combatAwaitingShiftDie.value = false
    const inputs = createCombatInputs()
    /*
     * B30：行动值单位**预填为双方 AR 最高者**（9.6 的选择仍是玩家的动作 —— 面板可改，
     * 只是不再逼玩家从零挑一个）。放在这里而不是 UI：它是"盘面事实"的推导，且验证页同样受益。
     */
    inputs.attackerArUnitId = defaultArUnitIdOf('attacker')
    inputs.defenderArUnitId = defaultArUnitIdOf('defender')
    /*
     * 12.4 / 12.6：**战斗补给只能从己方补给站扣**（12.3a 直接拖取 / 12.3b HQ 投递）。
     * 除专规的补给储备标记（1.7 / 21.10：Shells 抵付炮击成本、Forage 在补给阶段提供追溯补给）外，
     * SP 不存在「凭空可用的池子」。故未声明来源时可用量为 **0**，由引擎按 12.4 裁决
     * （攻方付不出 ⇒ 不能攻击；守方付不出 ⇒ 以一半战斗值防御，9.5-B）。
     */
    inputs.attackerAvailableT = 0
    inputs.defenderAvailableT = 0
    inputs.defenderTerrain = defaultDefenseTerrain(hex)
    combatInputs.value = inputs
    pushLog(
      'info',
      `发起突袭（8.0）：${participants.length} 个参突单位 → ${hexLabel(hex)}（守方 ${defenders.length} 个）；` +
        `每次 3 MP（8.1a），请按 9.2 九步结算`,
      '8.0',
    )
    if (split.stayIds.length > 0) {
      // 8.1h：留驻单位仍计入原格 4.8a 的战斗 RE，但不参突、也不受结果影响
      pushLog(
        'info',
        `8.1g/h：留驻 ${split.stayIds.length} 个单位（原格战斗 RE ${split.originStackRe}）`,
        '8.1h',
      )
    }
    // ⑭ 接线：突袭的宣布入会话日志（8.0；本笔不掷骰，骰子在 9.2 九步里逐笔记账）
    recordSettlement({
      action: 'overrun',
      rule: '8.0',
      data: {
        stage: 'declare',
        target: { ...hex },
        participantIds: [...participants],
        defenderIds: defenders.map((unit) => unit.instanceId),
        mpRemainingBefore: moveMinRemainingMp.value,
      },
    })
    return true
  }

  /**
   * 突袭结算后把移动记账落盘（8.1a 3 MP / 8.0 必须进格 / 8.1f 结束移动 / 8.1g 只动参突者）
   *
   * `defenderLeftHex` 由推进步的结论给出（防御格已清空）；`attackerRetreatedInOptions`
   * 取本场战斗的选项结算结论（9.10c：攻方用选项撤退后不再进格）。
   */
  function settleOverrunMove(defenderLeftHex: boolean): boolean {
    const context = overrunContext.value
    const interaction = moveInteraction.value
    if (context === null) return false
    const state = combatState.value
    // 9.10c：攻方用选项撤退 ⇒ 不进防御格（8.1f 同时让其在当前阶段的移动结束）
    const attackerRetreated = (state?.resolution.attacker.option?.retreatHexes ?? 0) > 0
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore: context.mpRemainingBefore,
      attackerRetreatedInOptions: attackerRetreated,
      defenderLeftHex,
    })
    const plan = planOverrunMove({
      runtime: context.runtimeBefore,
      participantIds: context.participantIds,
      target: context.target,
      aftermath,
    })
    if (plan.missingParticipantIds.length > 0) {
      pushLog(
        'warning',
        `突袭记账：活跃单位里找不到参突者 ${plan.missingParticipantIds.join('、')} ⇒ 这些单位未记账`,
        '8.1g',
      )
    }
    // 参突单位若已在战斗中阵亡/移出盘面 ⇒ 8.1a 的 3 MP 与 8.0 的进格都**没有对象可记**。
    // 此时必须就地收束，否则移动交互会挂着一批已不存在的 id（界面卡在「移动中」）。
    const liveParticipantIds = plan.participantIds.filter((id) =>
      moveRuntime.value.some((unit) => unit.unitId === id),
    )
    if (liveParticipantIds.length === 0) {
      pushLog(
        'warning',
        `参突单位已不在盘面（阵亡或移除）⇒ 突袭无需记账；本次移动就地收束（8.1a）`,
        '8.1a',
      )
      const current = moveInteraction.value
      if (current !== null) {
        const closed = endMoveEarly({ interaction: current, runtime: moveRuntime.value })
        applyMovePatches(closed.patches)
        moveInteraction.value = closed.interaction
      }
      overrunContext.value = null
      pushLog('info', plan.detail, plan.rule)
      // ⑭ 接线：参突者已不在盘面 ⇒ 8.1a 的 3 MP 与 8.0 的进格无对象可记（本笔无骰）
      recordSettlement({
        action: 'overrun',
        rule: plan.rule,
        data: {
          stage: 'settle',
          participantsGone: true,
          mayContinueMoving: plan.mayContinueMoving,
          defenderLeftHex,
          attackerRetreated,
          detail: plan.detail,
        },
      })
      return true
    }
    if (interaction !== null) {
      const applied = applyOverrunMove({ interaction, runtime: moveRuntime.value, plan })
      if (applied.ok) {
        moveInteraction.value = applied.data.interaction
        applyMovePatches(applied.data.patches)
        /*
         * 4.5a-A：突袭记账落盘后，这一枚**不再处于"进 ZOC 停车"状态**——
         *   它要么已进防御方格（8.0）、要么原地相持，总之这次"停车"已用掉。
         *   不摘掉的话，随后它因别的原因结束移动时仍会被当成可突袭者（账本失真）。
         *   若它真的进了新的敌方 ZOC，下一步 `planStep` 会重新记账。
         */
        zocStoppedMoveUnitIds.value = zocStoppedMoveUnitIds.value.filter(
          (id) => !context.participantIds.includes(id),
        )
        /*
         * 条 17（批 F·F2）：4.5a 标记。防御方离格 ⇒ 参突者强行进入防御方格（8.0 的进入是强制的）；
         * 若该格处于敌方 ZOC（"挺进 ZOC"），按 4.5a 此单位"不得离开、须再突袭或停"。
         * 仅置事实标记（UI 提示用），不改移动引擎的 ZOC 停车逻辑。
         */
        if (defenderLeftHex && inEnemyZocAt(moveContext.value, context.target, activeSide.value)) {
          overrunZocHeldHex.value = { ...context.target }
          pushLog(
            'warning',
            `4.5a：突袭进入 ${hexLabel(context.target)}（敌方 ZOC）⇒ 该单位不得离开、须再突袭或停`,
            '4.5a',
          )
        }
      } else {
        pushLog('warning', `突袭记账被拒：${applied.reason}（${applied.rule}）`, applied.rule)
      }
    } else {
      // 移动交互已在别处清空 ⇒ 3 MP 与进格无处落盘。静默跳开会让人以为「结算过了」，
      // 故显式报出（8.1a 的 MP 未记、8.0 的进格未做），便于就地补记。
      pushLog(
        'warning',
        `突袭记账无法落盘：本次移动交互已结束（${plan.mayContinueMoving ? '仍可再动' : '本阶段移动结束'}）；` +
          `8.1a 的 ${OVERRUN_COST_MP} MP 与 8.0 的进格需按 ${plan.participantIds.length} 枚参突单位补记`,
        '8.1a',
      )
    }
    overrunContext.value = null
    pushLog('info', plan.detail, plan.rule)
    // ⑭ 接线：突袭记账（8.1a 的 3 MP / 8.0 的进格 / 8.1f 的收束）入会话日志（本笔无骰）
    recordSettlement({
      action: 'overrun',
      rule: plan.rule,
      data: {
        stage: 'settle',
        participantIds: [...plan.participantIds],
        missingParticipantIds: [...plan.missingParticipantIds],
        mayContinueMoving: plan.mayContinueMoving,
        defenderLeftHex,
        attackerRetreated,
        detail: plan.detail,
      },
    })
    // 8.1f：不撤退就继续移动（剩余不足 3 MP 只是不能再突袭，不结束移动）；只有选了撤退才结束
    if (!plan.mayContinueMoving && moveInteraction.value !== null) {
      pushLog('info', `突袭后剩余 MP 不足以再次突袭（8.1a）⇒ 仍可继续移动，只是不能再突袭`, '8.1a')
    }
    return true
  }

  /** 放弃本次突袭（关掉战斗流程即撤销「突袭前」的托管信息；MP 尚未记账，故无需回滚） */
  function cancelOverrunContext(): void {
    overrunContext.value = null
  }

  /** C5：该格中**当前方**的算子（按摆放顺序；可整堆叠移动作战） */
  function friendlyUnitsAt(hex: HexRef): ConsoleUnit[] {
    return unitsAt(hex).filter((unit) => unit.side === activeSide.value)
  }

  /** C5：清空本次移动交互（选子变化 / 换阶段 / 换方 / 重置时调用） */
  function clearMoveInteraction(): void {
    moveInteraction.value = null
    movePick.value = null
    pendingZocConfirm.value = null
    moveBlocked.value = null
    lastStep.value = null
    // 4.5a-A：本次移动已收束 ⇒ 停车账本随之作废
    zocStoppedMoveUnitIds.value = []
    // 条 17（批 F·F2）：移动收束 ⇒ 4.5a 标记作废
    overrunZocHeldHex.value = null
  }

  /**
   * 清空所有单位的「本阶段已耗 MP」与「本轮已结束移动」标记
   *
   * 依据 6.1b：MA 是**一个阶段**可消耗的 MP 总额度 → 换方/换阶段/换回合时全体重置；
   * 4.5a-A / 6.1c / 6.2b 的「必须停止」也只在本轮移动内有效，故一并清除。
   * 4.5b：垫人的「本阶段不再消耗 MP」承诺同样止于本阶段结束。
   * 14.2e：飞机「每个阶段只能执行一次任务」同属阶段级事实，一并清零。
   */
  function resetMovementTracking(): void {
    for (const unit of units.value) {
      unit.mpSpent = 0
      unit.movementEnded = false
      unit.mpLockedThisPhase = false
      // 5.7b：`releasedFromReserve` 只表示「本阶段刚释放」，换段/换方/换回合即失效——
      // 释放本身已把预备标记永久摘掉，陈旧旗标会让该单位凭空获得反应/进击阶段的移动资格
      unit.mode = clearReleasedFromReserve(unit.mode)
      // 12.5c-C：单单位法的燃料「只在当前阶段有效」⇒ 换段/换方/换回合即失效；
      // 编队法 / HQ 法（12.5c-A/B）持续到**本方清理阶段**，不在此清（见 H 段 planCleanUp，12.5d）
      if (unit.fuelled && unit.fuelMethod !== null && fuelExpiresOnPhaseChange(unit.fuelMethod)) {
        unit.fuelled = false
        unit.fuelMethod = null
      }
    }
    for (const air of airUnits.value) air.missionsFlownThisPhase = 0
    moveInteraction.value = null
    pendingZocConfirm.value = null
    moveBlocked.value = null
    lastStep.value = null
    hoverHex.value = null
    // 4.5a-A：停车账本只在本轮移动内有效（换段/换方/换回合 ⇒ 新的移动）
    zocStoppedMoveUnitIds.value = []
  }

  /** 切方（2.3/2.2：先手方与后手方轮流；U0 直接手动切换） */
  function switchSide(): void {
    activeSide.value = activeSide.value === 'axis' ? 'soviet' : 'axis'
    selectedId.value = null
    pendingRecord.value = null
    battleTarget.value = null
    lastStep.value = null
    lastBattle.value = null
    resetMovementTracking()
    clearCombat()
    clearBarrage()
    clearSupply()
    clearAir()
    // 15.1A / 15.4：整备与缩减都是「每基地每阶段一次」，换阶段即清零
    refitDoneBaseIds.value = []
    reducedBaseIds.value = []
    // 13.8d：一格一任务按**移动阶段**计，换阶段即清零
    constructionPhaseLedger.value = { hexes: [], task: null }
    constructionError.value = null
    // 15.1 整备交互的中间态一并收束（换方后不该还停在「选飞机」）
    refitTargetBaseId.value = null
    // 10.0e-A/B：换方＝进入对方的阶段序列 ⇒ 轰炸账本同样归零（与 `resetSegmentTransient` 同口径）
    clearBarragePhaseLedger()
    pushLog('info', `切方 → ${activeSide.value === 'axis' ? '轴心国' : '苏联'}`)
  }
  /**
   * W7 C13：把当前行动方设为**指定方**（热坐交接用）
   *
   * 与 `switchSide()`（翻转）区分：交接屏确认后要落到**明确的一方**，连点两次不会转回原方。
   * 清理动作与 `switchSide` 完全一致（走同一个函数，避免两处漂移）。
   */
  function setActiveSide(side: Side): void {
    if (activeSide.value === side) return
    switchSide()
  }

  /** 阶段名（照 2.2 流程表） */
  const PHASE_LABELS: Record<ConsolePhase, string> = {
    aircraftRefit: 'A 飞机整备',
    reinforcement: 'B 增援',
    movement: 'C 移动',
    supply: 'D 补给',
    reaction: 'E 反应',
    combat: 'F 战斗',
    exploitation: 'G 进击',
    cleanUp: 'H 清理',
  }

  /** 主动模式名（5.3） */
  const MODE_LABELS: Record<BaseMode, string> = {
    combat: '战斗模式',
    move: '移动模式',
    reserve: '预备模式',
    strat: '战略模式',
  }

  /** 加油方法名（12.5c） */
  const FUEL_METHOD_LABELS: Record<FuelMethod, string> = {
    formation: '编队法',
    hq: 'HQ 法',
    singleUnit: '单单位法',
  }

  /**
   * 换段 / 换方 / 换回合时清掉**盘面上的中间态**
   *
   * 依据：段内的半截动作不能带到下一段——一场打到一半的战斗、一次走到一半的移动、
   * 已选好的防御格，都属于"上一步的现场"。原先这套清理只写在 `setPhase()` 里（手动切段用），
   * B5 起「进入下一环节」也会换段，故抽出来两处共用，避免两条路径各清一半。
   */
  function resetSegmentTransient(): void {
    battleTarget.value = null
    lastStep.value = null
    resetMovementTracking()
    clearCombat()
    clearBarrage()
    clearSupply()
    clearAir()
    // 15.1A / 15.4：整备与缩减都是「每基地每阶段一次」，换阶段即清零
    refitDoneBaseIds.value = []
    reducedBaseIds.value = []
    // 14.9f / 15.0b-C：空运卸载限额是「**每个移动环节**每基地」⇒ 换环节即清零
    airUnloadLedger.value = {}
    // 13.8d：一格一任务按**移动阶段**计，换阶段即清零
    constructionPhaseLedger.value = { hexes: [], task: null }
    constructionError.value = null
    refitTargetBaseId.value = null
    // 9.1c：攻击账本按**战斗环节**计 ⇒ 换段 / 换方 / 换回合即清零（同段的换环节见 `stepToNextSegmentStep`）
    clearAttackPhaseLedger()
    /*
     * 10.0e-A/B：轰炸账本按**阶段**计（每格 / 每单位每阶段一次）⇒ 换段即清零。
     * ★ 修前（第六批条 23）本行只写在 `setPhase()` 里，而**正式推进换段走的是
     *   `advanceSegmentNow()` → `session.advanceToNextStop()` → 本函数**，那条路径根本不清
     *   ⇒ C 段空军炸过的格到 F 段仍在账本里，10.0e-A 把炮兵的合法轰炸一并拒掉。
     *   现在 `setPhase` / `setTurn` / 换段共用这一个清零点，两条路径口径一致。
     */
    clearBarragePhaseLedger()
  }

  /**
   * **唯一「进入下一环节」**（B5；用户口径「点击自动进入下一环节，不需要额外的按钮」）
   *
   * 做三件事，顺序不能颠倒：
   *   ① 会话**连跑到下一个需要玩家的地方**（自动段一路结算完：天气 / 清理 / 换回合）；
   *   ② 若回合 / 阶段 / 行动方真的动了 ⇒ 清掉盘面中间态（上一步的现场不能带过来）；
   *   ③ 记一行日志（含"连跑了几步、停在哪"），让自动段的过程可追溯。
   *
   * 有**进行中的会话框**（战斗 / 轰炸）时拒绝：那次操作属于当前段，段没了它就没了；
   * 请先走完或按 Esc 放弃（规则号照 9.2 / 10.0 给，不自己编）。
   */
  function advanceSegmentNow(): SessionAdvanceOutcome | null {
    if (combatState.value !== null && !combatState.value.finished) {
      pushLog('warning', '战斗结算进行中：先走完 9.2 流程或按 Esc 放弃，再进入下一环节', '9.2')
      return null
    }
    if (barrageState.value !== null && !barrageState.value.finished) {
      pushLog('warning', '轰炸结算进行中：先走完 10.0 流程或按 Esc 放弃，再进入下一环节', '10.0')
      return null
    }
    /*
     * B8：先在**本段内**推进环节（用户口径：不想做这一环就点同一个按钮过去），
     * 环节全部走完才推进会话步（换段）。环节是**段内**的进度，故不消耗会话步（steps = 0），
     * 返回的 `stoppedBy: 'player'` 如实表示"仍停在需要玩家的环节上"。
     */
    if (stepToNextSegmentStep()) return { steps: 0, stoppedBy: 'player', driver: 'player' }
    const before = `${turn.value}|${phase.value}|${activeSide.value}`
    const outcome = session.advanceToNextStop()
    const after = `${turn.value}|${phase.value}|${activeSide.value}`
    if (outcome.steps > 0 && after !== before) resetSegmentTransient()
    if (outcome.steps > 0) {
      pushLog(
        'info',
        `进入下一环节：自动段连跑 ${outcome.steps} 步 → 停在${stopLabel(outcome)}`,
        '2.2',
      )
    }
    return outcome
  }

  /** 连跑去向的中文说法（界面与日志共用一处，免得两处口径漂移） */
  function stopLabel(outcome: SessionAdvanceOutcome): string {
    if (outcome.stoppedBy === 'question') return `待答（${session.question?.rule ?? '2.3'}）`
    if (outcome.stoppedBy === 'terminated') return '本局终止（5.0a / 5.0b）'
    if (outcome.stoppedBy === 'refused') return `内核拒绝（${session.error?.reason ?? '未知'}）`
    if (outcome.stoppedBy === 'limit') return '连跑上限（异常，请报告）'
    const step = session.guidance
    return step === null ? '玩家环节' : `${step.step.label}（${step.step.rule}）`
  }

  /** 切阶段（2.2 SOP 段；换段即重置各单位的 MA 额度） */
  function setPhase(next: ConsolePhase): void {
    phase.value = next
    resetSegmentTransient()
    pushLog('info', `阶段 → ${PHASE_LABELS[next]}`)
    /*
     * 12.6 / 12.8e：追溯补给的**自动重判时点**（补给网一过段就可能变，标记不能过期）
     *   - 进入**补给阶段**：12.6 的评估时点；
     *   - 进入**移动阶段**：该段的首环节即**突围环节**，12.8e 括注明写「在此环节中检查追溯补给」，
     *     故此刻的标记必须是新鲜的。待 P1-3 把突围环节独立成子步后，本钩子再下移到该子步。
     */
    if (next === 'supply') refreshTraceSupply('进入补给阶段')
    else if (next === 'movement') refreshTraceSupply('进入移动阶段（突围环节复查）')
    // 12.6c：批量费率的"本环节"以段为单位 ⇒ 换阶段即清空已喂 RE 账本
    oosFedReByDump.value = {}
    // 12.11a（第五批 B1）：销毁补给站的限额是「**每个阶段**每站一次」⇒ 换阶段即清空尝试账本
    // （修前从不清零 ⇒ 同一站被永久拒绝，"每阶段一次"实际成了"每局一次"）
    dumpDestructionAttempts.value = {}
    // 13.3g-D：换轨上限是「每**移动阶段** ≤ min(4, MA) 格」⇒ 换阶段即清零计数
    gaugeConversionsThisPhase.value = []
    // 13.3g-A：同上 —— 换阶段后，"本阶段刚换过轨的格"与"走过这些格的单位"都不再算数
    convertedHexesThisPhase.value = []
    railMovedNewTrackThisPhase.value = []
    // 4.7d：铁路运输的「同一阶段只用一种运输类型」按阶段记账 ⇒ 换阶段即清零
    railMovedUnitIdsThisPhase.value = []
    // 10.0e-A/B：轰炸账本按**阶段**计（每格/每单位每阶段一次）⇒ 换阶段即清零
    // （已并入上面的 `resetSegmentTransient()`，此处不再重复调，保持单一清零点）
    /*
     * ★ 12.5d（用户 2026-09-20 裁定）：**燃料窗口不随换阶段清零** ——
     *   编队标记 / 指挥部燃料标记都「持续到**下一个友方清理阶段**」，而"下一个友方清理阶段"可能
     *   落在**另一个阶段的半场**之后（例：敌方回合的己方反应阶段付的油，要活到己方回合的移动阶段，
     *   直到**己方**清理阶段才翻回）。故 `hqFuelThrows` / `formationFuelThrows` 都**不在本函数里清**，
     *   而是在 `runCleanUpNow`（本方清理、与 `fuelled` 标记同一处落盘）里按方清。
     */
  }

  /** 清空 10.0e-A/B 的轰炸账本（换段 / 换阶段 / 换回合 / 复位时调用；现由 `resetSegmentTransient` 统一清） */
  function clearBarragePhaseLedger(): void {
    barragedHexesThisPhase.value = []
    barragedUnitIdsThisPhase.value = []
  }

  /** 清空 9.1c 的攻击账本（换环节 / 换段 / 换方 / 换回合时调用） */
  function clearAttackPhaseLedger(): void {
    attackedUnitIdsThisPhase.value = []
    attackedHexesThisPhase.value = []
  }

  /**
   * 记一笔 9.1c（**战斗补给付过之后**调用；一场战斗只走到这里一次）
   *
   * 记的是**最终参战名单**（9.5b 允许在补给步减少参战单位 ⇒ 以那份减少后的名单为准）与**被攻击的格**。
   */
  function recordAttackThisSegment(attackerIds: readonly string[], defendingHex: HexRef): void {
    attackedUnitIdsThisPhase.value = [
      ...new Set([...attackedUnitIdsThisPhase.value, ...attackerIds]),
    ]
    attackedHexesThisPhase.value = [
      ...new Set([...attackedHexesThisPhase.value, `${defendingHex.col}.${defendingHex.row}`]),
    ]
  }

  /**
   * 设置回合号与对应日期
   *
   * ★ 日期取自工程数据 markers.json 的 turnTrack（**半周轨**：日号 `1-5-8-12-15-19-22-26-29`
   *   每月重复 ⇒ 1=07-08、2=07-12、7=07-29、8=**08-01**、17=**09-01**…），
   *   绝不能按固定天数推算——日期是专规闸门的唯一输入（专规 2.3e 战略模式、专规 1.2 铁路容量）。
   */
  function setTurn(next: number): void {
    const first = TURN_TRACK[0]?.turn ?? 1
    const last = TURN_TRACK[TURN_TRACK.length - 1]?.turn ?? first
    const clamped = Math.min(last, Math.max(first, Math.trunc(next)))
    turn.value = clamped
    lastStep.value = null
    resetMovementTracking()
    /*
     * 16.0b/c：工事修建/缩减的额度是「**每格每回合**」⇒ 换回合即清零。
     * ★ 本账本按**格**键（`hedgehogTurnLedger`），故必须在这里显式清，否则"本回合已提升"会跨回合一直拦。
     */
    hedgehogTurnLedger.value = {}
    // 15.3：空军基地的「每回合 +1 级」同样是按格按回合的额度
    airBaseTurnLedger.value = {}
    // 13.8d：一格一任务按移动阶段计 ⇒ 新回合＝新的移动环节
    constructionPhaseLedger.value = { hexes: [], task: null }
    constructionError.value = null
    // 10.0e-A/B：轰炸账本按阶段计 ⇒ 新回合也是新的阶段序列（与 13.8d 同口径）
    clearBarragePhaseLedger()
    // 9.1c：攻击账本按环节计 ⇒ 新回合必然是新的战斗环节（与上面同口径）
    clearAttackPhaseLedger()
    /*
     * ★ 12.5d（用户 2026-09-20 裁定）：燃料窗口**也不随换回合清零** ——
     *   标记持续到"下一个**友方**清理阶段"，而付款可以发生在**敌方半场**的己方反应阶段
     *   （例：后手方在第一半场的反应阶段投递 ⇒ 己方清理阶段在下一次己方半场）
     *   ⇒ 该窗口会正常跨过回合边界，清零只发生在那次清理（见 `runCleanUpNow`）。
     */
    // 13.3b：铁路容量是「**每回合**每方若干点」（1.2）⇒ 换回合即清零
    railCapSpentThisTurn.value = []
    // 专规 2.1/3.1：到货 SP 的落点按**回合**清（每回合的补给表到货各落各的）
    freeRailPicked.value = []
    supplyArrivalSp.value = 0
    supplyTrainHex.value = null
    // ⑬ 接线：回合变了，5.0b 的时点（19 Aug 起）与 5.0a 的末回合判定都随之变，重推结论
    pushVictoryToSessionNow()
    pushLog('info', `回合 ${clamped}（${date.value}）`)
  }

  /** 选一个单位库记录进入摆放模式（自动切到摆子工具） */
  function pickRecord(record: UnitRecordView): void {
    pendingRecord.value = record
    tool.value = 'place'
    pushLog('info', `待摆放：${record.nameZh ?? record.id}（点地图空格放置）`)
  }

  /** 切工具模式 */
  function setTool(next: 'move' | 'place' | 'battle'): void {
    tool.value = next
    pushLog('info', `工具 → ${{ move: '选格/走一步', place: '摆算子', battle: '打一仗' }[next]}`)
  }

  /** 在指定格摆放待摆放的单位 */
  function placeAt(hex: HexRef): boolean {
    const record = pendingRecord.value
    if (record === null) return false
    // 中立算子（side='both'）由玩家指定按当前方上场
    const side: Side = record.side === 'both' ? activeSide.value : (record.side ?? activeSide.value)
    const unit = toConsoleUnit({ record, instanceId: createId('u'), hex, side })
    // 摆放方以单位库的 side 为准；若与当前方不一致，提示但不拦（便于快速对比双方）
    units.value.push(unit)
    selectedId.value = unit.instanceId
    pendingRecord.value = null
    battleTarget.value = null
    pushLog(
      'success',
      `摆放 ${unit.name} @ ${hex.col}.${hex.row}（A${unit.raw.attack} AR${unit.raw.ar} MA${unit.raw.ma}，${effectiveMobilityOf(unit)}，${unit.re}RE）`,
    )
    // 12.3b / 12.7：HQ 与延补队都是**补给源**，摆上即改变补给网 ⇒ 重判（其余算子不影响）
    if (affectsSupplyNet(unit)) refreshTraceSupply(`摆上 ${unit.name}`)
    return true
  }

  /** 移除某格最上面的算子 */
  function removeAt(hex: HexRef): boolean {
    const index = [...units.value]
      .reverse()
      .findIndex((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row)
    if (index === -1) return false
    const realIndex = units.value.length - 1 - index
    const [removed] = units.value.splice(realIndex, 1)
    if (removed !== undefined && selectedId.value === removed.instanceId) selectedId.value = null
    battleTarget.value = null
    pushLog('info', `移除 ${removed?.name ?? '算子'} @ ${hex.col}.${hex.row}`)
    // 12.3b / 12.7：HQ 或延补队被移除 ⇒ 补给网变化 ⇒ 重判
    if (removed !== undefined && affectsSupplyNet(removed))
      refreshTraceSupply(`移除 ${removed.name}`)
    return true
  }

  /* ──────────────── C5 移动交互：选子 → 范围 → 逐格 → 结束/撤销 ──────────────── */

  /** 单位实例 id → 显示名 */
  function nameOf(unitId: string): string {
    return units.value.find((item) => item.instanceId === unitId)?.name ?? unitId
  }

  /** 界面用：单位实例 id → 显示名（与 `nameOf` 同源，导出供面板直接调用而不自行查表） */
  function unitNameOf(unitId: string): string {
    return nameOf(unitId)
  }

  /** 把引擎给出的运行态变更落盘到单位上（引擎不写状态，CODE_SPEC §3.1） */
  function applyMovePatches(patches: readonly MoveUnitRuntime[]): void {
    for (const patch of patches) {
      const unit = units.value.find((item) => item.instanceId === patch.unitId)
      if (unit === undefined) continue
      unit.hex = { ...patch.hex }
      unit.mpSpent = patch.spentMp
      unit.movementEnded = patch.ended
      // 专规 3.5：进入建造标记格即触发毁伤判定
      noteUnitEnteredHex(unit, patch.hex)
    }
  }

  /**
   * 开始一次移动（1 个单位或 1 个堆叠，6.1）
   *
   * 可行性一律问引擎 `beginMove`（阶段 6.0 / MA 6.1b / 垫人锁 4.5b / 燃料 12.5a / 延补队面 12.7）；
   * 失败时把原因留在 `moveBlocked` 供界面显示，不静默。
   */
  function beginMoveFor(unitIds: readonly string[]): boolean {
    // 2.2：回合准备环节（天气 / 先手判定）不属于任何段 ⇒ 先于「段」判断题拦下
    if (segmentLocked.value) return refuseWhileLocked('移动')
    // 2.2：A 整备 / B 增援 / D 补给 / F 战斗 / H 清理都没有移动环节（只有 C/E/G 有）
    if (NO_MOVEMENT_PHASES.includes(phase.value)) {
      const reason = `${PHASE_LABELS[phase.value]}段没有移动环节，不能移动（2.2）`
      moveBlocked.value = { rule: '2.2', reason }
      pushLog('warning', reason, '2.2')
      return false
    }
    // 专规 2.4：Slow Mobilization 锁定的师不能移动（也不能拆出 breakdown）
    const locked = unitIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined && unit.locked)
    if (locked.length > 0) {
      const reason = `被锁定的师不能移动：${locked.map((unit) => unit.name).join('、')}（专规 2.4）`
      moveBlocked.value = { rule: '专规 2.4', reason }
      pushLog('warning', reason, '专规 2.4')
      return false
    }
    /*
     * B8：**环节级**闸门。上面的 `NO_MOVEMENT_PHASES` 只判"这一段有没有移动环节"
     * （A/B/D/F/H 没有），这里再判"这一段**当前这一环**允不允许移动"——C 段的首环是
     * **突围**（12.8e「before any other movement」），那一刻不该放行常规移动。
     * 两条判据都保留：段级那条给出更贴切的原因码（如 `moveBlocked` 的 2.2），环节级这条管细粒度。
     */
    if (!requireAction('move.order', '移动')) return false
    const result = beginMove({ context: moveContext.value, unitIds, runtime: moveRuntime.value })
    if (!result.ok) {
      moveInteraction.value = null
      moveBlocked.value = { rule: result.rule, reason: result.reason }
      pushLog('warning', `不能移动：${result.reason}（${result.rule}）`, result.rule)
      return false
    }
    moveInteraction.value = result.data
    moveBlocked.value = null
    pendingZocConfirm.value = null
    return true
  }

  /** 因燃料/模式等原因没能开始移动时，条件满足后自动重试，省得玩家再点一次 */
  function retryBeginMove(): void {
    if (moveInteraction.value !== null) return
    /*
     * ★ B26：重试的对象必须与**付款口径**一致（`moveUnits → movePick.ids → selectedUnit`，见 `fuelTargets`）。
     *   修前这里只取 `selectedUnit`（＝堆叠顶上一枚）⇒ 一堆叠付完油后**只有顶上一枚开拔**，
     *   其余既没加油也没跟上，玩家再点那一堆叠又只会看到"这是当前所在格"。
     *   这正是用户报告「点击堆叠总是默认移动第一个单位、无法选中堆叠其它单位」的直接机制。
     */
    const ids =
      moveUnits.value.length > 0
        ? moveUnits.value.map((unit) => unit.instanceId)
        : (movePick.value?.ids ??
          (selectedUnit.value === null ? [] : [selectedUnit.value.instanceId]))
    if (ids.length === 0) return
    beginMoveFor(ids)
  }

  /**
   * C5：选中某格的单位作为开拔候选（6.1）
   *
   * ★ 条 10（M1）：**只建立取子清单，不自动开拔**——旧口径「点格即开始移动」已作废
   *   （裁定表 ②），玩家勾选（地图上点枚）或单选后，必须点移动会话里的「开始移动」按钮才真正开拔；
   *   保留条 18 的"点回本单位即停 + 惰性清理"。三种情形都只写 `movePick`：
   *   - 该格只有一枚 ⇒ 候选即这一枚；
   *   - 多枚且未开「整堆叠」 ⇒ 候选先放顶上一枚，玩家在地图上逐枚勾选；
   *   - 多枚且已开「整堆叠」 ⇒ 整堆叠一起作为候选。
   */
  function selectForMove(hex: HexRef): void {
    const friendlies = friendlyUnitsAt(hex)
    if (friendlies.length === 0) return
    const last = friendlies[friendlies.length - 1]!
    const ids =
      friendlies.length > 1 && !stackSelect.value
        ? [last.instanceId]
        : (stackSelect.value ? friendlies : [last]).map((unit) => unit.instanceId)
    movePick.value = { hex: { col: hex.col, row: hex.row }, ids }
    selectedId.value = last.instanceId
    lastStep.value = null
    pushLog(
      'info',
      `${hex.col}.${hex.row} 已选 ${ids.length} 枚待开拔（6.1）：${ids.length > 1 ? '在地图上点枚勾选' : '单选'}，点「开始移动」才开拔`,
      '6.1',
    )
  }

  /* ──────────── C5：堆叠取子（6.1f / 8.1g / 8.1h） ──────────── */

  /** 当前取子清单所在格（用于界面判断是否显示该块） */
  const movePickHex = computed<HexRef | null>(() => movePick.value?.hex ?? null)
  /** 取子清单的候选单位（该格当前方全部算子，按摆放顺序） */
  const movePickChoices = computed<ConsoleUnit[]>(() => {
    const pick = movePick.value
    if (pick === null) return []
    return friendlyUnitsAt(pick.hex)
  })
  /** 勾选/取消一枚（至少保留一枚，避免空选择） */
  function toggleMovePick(unitId: string): void {
    const pick = movePick.value
    if (pick === null) return
    if (pick.ids.includes(unitId)) {
      if (pick.ids.length === 1) return
      pick.ids = pick.ids.filter((id) => id !== unitId)
    } else {
      pick.ids = [...pick.ids, unitId]
    }
  }
  /** 只选这一枚（点「只动这一枚」即「就它动」，不需要先勾上） */
  function setMovePickOnly(unitId: string): void {
    const pick = movePick.value
    if (pick === null) return
    pick.ids = [unitId]
  }
  /** 全选（等价于点「整堆叠」）——B26：可传入"参与集合"，此时只全选参与本环节的那些 */
  function setMovePickAll(onlyIds?: readonly string[]): void {
    const pick = movePick.value
    if (pick === null) return
    const here = friendlyUnitsAt(pick.hex).map((unit) => unit.instanceId)
    pick.ids = onlyIds === undefined ? here : here.filter((id) => onlyIds.includes(id))
  }

  /**
   * B26：为某格**建立或同步**取子清单（地图上"就地摊开"时用）
   *
   * 为什么需要它：B26 把"点堆叠"改成**先摊开**（看这一格）再谈开拔，于是摊开那一击不再经过
   * `selectForMove` ⇒ 取子清单不会自动出现，而"开始移动"与小窗的勾选列表都要它。
   * 本函数只写 `movePick`（**不碰任何引擎状态、不开始移动**）：
   *   · 入参即"地图上圈出来的那些"（摊开时＝参与本环节的集合）；
   *   · 全部不合格或缺省时退回"顶上一枚"（与 `selectForMove` 的默认一致）；
   *   · 该格没有己方算子 ⇒ 清掉清单。
   */
  function beginMovePick(hex: HexRef, ids: readonly string[]): void {
    const here = friendlyUnitsAt(hex).map((unit) => unit.instanceId)
    if (here.length === 0) {
      movePick.value = null
      return
    }
    const picked = ids.filter((id) => here.includes(id))
    movePick.value = {
      hex: { col: hex.col, row: hex.row },
      ids: picked.length > 0 ? picked : [here[here.length - 1]!],
    }
  }
  /**
   * 直接给定取子集合（B3：地图上的就地展开把它当**唯一选择集**来驱动）
   *
   * 与 `toggleMovePick` 的差别：这里**允许空集**。地图上把最后一枚也点掉是合法操作
   * （玩家只是把这一格全放掉），空集时「确认开拔」按 6.1 给出提示，而不是静默改回"全选"。
   */
  function setMovePickIds(ids: readonly string[]): void {
    const pick = movePick.value
    if (pick === null) return
    pick.ids = [...ids]
  }
  /** 放弃取子（不移动任何人） */
  function cancelMovePick(): void {
    movePick.value = null
  }
  /** 确认取子 ⇒ 以所选子集开拔（其余留驻；8.1h 的留驻单位不受本次移动/突袭影响） */
  function confirmMovePick(): boolean {
    const pick = movePick.value
    if (pick === null) return false
    const ids = friendlyUnitsAt(pick.hex)
      .filter((unit) => pick.ids.includes(unit.instanceId))
      .map((unit) => unit.instanceId)
    if (ids.length === 0) {
      pushLog('warning', '至少要勾选一枚才能开始移动（6.1）', '6.1')
      return false
    }
    const hex = { ...pick.hex }
    const names = friendlyUnitsAt(hex)
      .filter((unit) => ids.includes(unit.instanceId))
      .map((unit) => unit.name)
      .join(' + ')
    /*
     * ★ B26：取子清单**开拔成功之后**才清（修前先清）——
     *   开拔被拒（12.5a 缺燃料 / 5.4 模式 / 阶段闸门）时，清单必须留着：
     *   玩家的付款受益集（`fuelTargets` 走 `movePick.ids`）与"重试开拔"（`retryBeginMove`）
     *   都要靠它，否则一堆叠付完油只剩顶上一枚能动（用户报告的那条）。
     */
    if (!beginMoveFor(ids)) {
      // 开拔被拒：原因已由 beginMoveFor 写入 moveBlocked，此处不重复报错
      return false
    }
    movePick.value = null
    pushLog(
      'info',
      `开始移动：${names} @ ${hex.col}.${hex.row}` +
        `${ids.length > 1 ? `（自堆叠中取 ${ids.length} 枚，6.1）` : ''}`,
      '6.1',
    )
    return true
  }

  /** C5：把步骤记录折成可显示的文本 */
  function stepTextOf(record: MoveStepRecord): string {
    if (record.kind === 'end') return '结束本次移动（6.1）'
    const parts = [
      `${record.movedIds.map(nameOf).join(' + ')} → ${record.to.col}.${record.to.row}`,
      `${record.movedIds.map((id) => `${nameOf(id)} 消耗 ${record.costById[id] ?? 0} MP`).join('；')}`,
    ]
    if (record.droppedIds.length > 0)
      parts.push(`走不动而留在原格：${record.droppedIds.map(nameOf).join('、')}（6.1f）`)
    if (record.zocStoppedIds.length > 0)
      parts.push(`进入敌方 ZOC 被迫停止：${record.zocStoppedIds.map(nameOf).join('、')}（4.5a-A）`)
    return parts.join('；')
  }

  /** C5：步骤记录 → 界面快照 */
  function snapshotOf(record: MoveStepRecord): MoveStepSnapshot {
    return {
      kind: record.kind,
      from: { ...record.from },
      to: { ...record.to },
      movedNames: record.movedIds.map(nameOf),
      droppedNames: record.droppedIds.map(nameOf),
      zocStoppedNames: record.zocStoppedIds.map(nameOf),
      costText: record.movedIds
        .map((id) => `${nameOf(id)} ${record.costById[id] ?? 0} MP`)
        .join('；'),
      rules: [...record.rules],
    }
  }

  /** C5：提交一步（引擎给出 patches 与新的交互状态） */
  function commitStep(to: HexRef, path: readonly HexRef[]): boolean {
    const interaction = moveInteraction.value
    if (interaction === null) return false
    const result = planStep({
      context: moveContext.value,
      interaction,
      runtime: moveRuntime.value,
      to,
      path,
    })
    if (!result.ok) {
      moveBlocked.value = { rule: result.rule, reason: result.reason }
      pushLog(
        'danger',
        `走 ${to.col}.${to.row} 不合法：${result.reason}（${result.rule}）`,
        result.rule,
      )
      return false
    }
    applyMovePatches(result.data.patches)
    moveInteraction.value = result.data.interaction
    pendingZocConfirm.value = null
    moveBlocked.value = null
    /*
     * 4.5a-A：把这一步**因进敌方 ZOC 被迫停车**的单位记进本轮账本 ——
     *   它们随后仍可选择"突袭"（原文的两个分支），`overrunCandidateUnits` 据此把它们留在候选里。
     *   `planStep` 已把它们的运行态 `ended` 置真，若不记这一笔，停车后 `overrunTargets` 会变成空集。
     */
    if (result.data.record.zocStoppedIds.length > 0) {
      zocStoppedMoveUnitIds.value = [
        ...new Set([...zocStoppedMoveUnitIds.value, ...result.data.record.zocStoppedIds]),
      ]
      /*
       * ★ 同一条 4.5a-A 的另一半：`planStep` 见"全体 ended"就把交互标成 `finished`，
       *   而 `applyOverrunMove` / `planStep` 都**拒绝**已 finished 的交互 ⇒ 停车后连突袭也一起被锁死。
       *   原文给的正是两个分支（停止 / 突袭）⇒ 只要本次有因 ZOC 停车者，交互就**不算收束**。
       *   ★ 不会因此放开普通移动：`reachableForMove` 仍按运行态的 `ended` 过滤
       *     （`move-interaction.ts:233`），停车的单位依旧走不了下一格。
       */
      if (moveInteraction.value?.finished === true) {
        moveInteraction.value = { ...moveInteraction.value, finished: false }
      }
    }
    lastStep.value = snapshotOf(result.data.record)
    pushLog('success', stepTextOf(result.data.record), result.data.record.rules[0] ?? '6.1')
    // ⑭ 接线：本步移动（6.1 逐格移动）入会话日志（本笔不掷骰；MP 消耗按 costById 复核）
    recordSettlement({
      action: 'move',
      rule: result.data.record.rules[0] ?? '6.1',
      data: {
        stage: 'step',
        from: { ...result.data.record.from },
        to: { ...result.data.record.to },
        movedIds: [...result.data.record.movedIds],
        droppedIds: [...result.data.record.droppedIds],
        zocStoppedIds: [...result.data.record.zocStoppedIds],
        costById: { ...result.data.record.costById },
      },
    })
    // 9.14：进入的格若有**敌方设施/后勤目标**（补给站/运输点/延补队/工事/空军基地）⇒ 触发特殊战斗
    triggerSpecialCombatAfterStep(to, result.data.record.movedIds)
    return true
  }

  /**
   * 9.14：移动进入某格后的**特殊战斗**触发
   *
   * 前提（规则原文）：「（敌方）可攻击单位**进入**该格」——故要传本次**实际移动**的单位
   * （`movedIds`），由进入方阵营与 `attackCapable` 决定是否成立；引擎会再核一遍。
   * 位移落点由玩家在地图上选（`specialPending`），因此移动路径在待决清空前应当停住。
   */
  function triggerSpecialCombatAfterStep(to: HexRef, movedIds: readonly string[]): void {
    if (specialPending.value !== null) return
    const enteringSide = movedIds
      .map((id) => units.value.find((unit) => unit.instanceId === id)?.side)
      .find((side) => side !== undefined)
    if (enteringSide === undefined) return
    resolveSpecialCombatAt(to, enteringSide)
  }

  /**
   * 沿路径逐格推进（点远处的可达格 = 沿预览路径一直走过去；6.1 逐格移动）
   *
   * 每一格都重新问引擎（`previewStep`）——「走一格、范围重算一次」由此自然成立；
   * 遇到 4.5a-A 的敌方 ZOC 会**停下来先问玩家**，确认后从该步继续。
   * `path` 含起点，故从下标 1 起。
   */
  function advanceAlongPath(path: readonly HexRef[]): void {
    for (let index = 1; index < path.length; index += 1) {
      if (moveInteraction.value === null) return
      if (activeMoveUnits.value.length === 0) return
      const to = path[index]!
      const preview = previewStep({
        context: moveContext.value,
        interaction: moveInteraction.value,
        runtime: moveRuntime.value,
        to,
        path: path.slice(0, index + 1),
      })
      if (!preview.ok) {
        const blocked = preview.blocked
        if (blocked !== undefined) {
          moveBlocked.value = { rule: blocked.rule, reason: blocked.reason }
          pushLog(
            'warning',
            `走到 ${to.col}.${to.row} 停住：${blocked.reason}（${blocked.rule}）`,
            blocked.rule,
          )
        }
        return
      }
      // 4.5a-A：进入未抵消敌方 ZOC 前先确认
      if (preview.needsConfirm) {
        pendingZocConfirm.value = { to, preview, remainingPath: path.slice(index) }
        return
      }
      if (!commitStep(to, path.slice(0, index + 1))) return
      // 9.14：该步触发了设施夺取的待决（位移落点待选）⇒ 停住推进，先让玩家处置
      if (specialPending.value !== null) return
    }
  }

  /** C5：点击某格走动（移动交互入口） */
  function tryMoveTo(hex: HexRef): void {
    const interaction = moveInteraction.value
    if (interaction === null) return
    const node = reachableNodeAt(groupReachable.value.hexes, hex)
    if (node === null) {
      // 不在可到达范围内：给出引擎对该单步的判定，说明为什么不能走
      const probe = previewStep({
        context: moveContext.value,
        interaction,
        runtime: moveRuntime.value,
        to: hex,
      })
      const blocked = probe.blocked
      const blockedInfo =
        blocked === undefined
          ? { rule: '6.1', reason: '该格不在本次移动的可到达范围内' }
          : {
              rule: blocked.rule,
              reason: `${blocked.reason}${blocked.detail === undefined ? '' : `（${blocked.detail}）`}`,
            }
      moveBlocked.value = blockedInfo
      pushLog(
        'warning',
        `不能走到 ${hex.col}.${hex.row}：${blockedInfo.reason}（${blockedInfo.rule}）`,
        blockedInfo.rule,
      )
      return
    }
    advanceAlongPath(node.path)
  }

  /** C5：确认进入敌方 ZOC（4.5a-A 的「就地停止」分支） */
  function confirmZocEntry(): void {
    const pending = pendingZocConfirm.value
    if (pending === null) return
    pushLog(
      'warning',
      `确认进入 ${pending.to.col}.${pending.to.row} 的敌方 ZOC：轮式单位进入后**就地停止**，` +
        `此后仍可选择**突袭**相邻敌方格（4.5a-A 的两个分支；每次突袭后还能再突袭，可连续穿越多个 ZOC）`,
      '4.5a-A',
    )
    const remaining = pending.remainingPath
    if (!commitStep(pending.to, pending.preview.path)) return
    // 4.5a-A 只停住轮式单位；同行而仍能移动的步行/履带单位继续沿原路径走
    if (remaining.length > 1) advanceAlongPath(remaining)
  }

  /** C5：放弃进入敌方 ZOC（留在原格） */
  function dismissZocConfirm(): void {
    const pending = pendingZocConfirm.value
    if (pending === null) return
    pendingZocConfirm.value = null
    pushLog(
      'info',
      `放弃进入 ${pending.to.col}.${pending.to.row}（4.5a-A 要求进入后就地停止，玩家选择留在原格）`,
      '4.5a-A',
    )
  }

  /** C5：撤销上一步（还原该步提交前的运行态快照） */
  function undoLastStep(): void {
    const interaction = moveInteraction.value
    if (interaction === null) return
    if (interaction.steps.length === 0) {
      pushLog('info', '本次移动还没有可撤销的步骤')
      return
    }
    const reverted = revertInteractionStep(interaction)
    applyMovePatches(reverted.patches)
    moveInteraction.value = reverted.interaction
    pendingZocConfirm.value = null
    moveBlocked.value = null
    lastStep.value = null
    // 4.5a-A：撤销这一步 ⇒ 它带来的"进 ZOC 停车"记账一并对销（账本只反映**当前**盘面）
    zocStoppedMoveUnitIds.value = zocStoppedMoveUnitIds.value.filter(
      (id) => !interaction.steps[interaction.steps.length - 1]?.zocStoppedIds.includes(id),
    )
    pushLog('info', '撤销一步（还原运行态快照）', '6.1')
  }

  /** C5：取消整次移动（回到开始移动之前） */
  function cancelWholeMove(): void {
    const interaction = moveInteraction.value
    if (interaction === null) return
    const reverted = revertInteraction(interaction)
    applyMovePatches(reverted.patches)
    moveInteraction.value = reverted.interaction
    pendingZocConfirm.value = null
    moveBlocked.value = null
    lastStep.value = null
    // 4.5a-A：整次移动还原 ⇒ 停车账本随之清空
    zocStoppedMoveUnitIds.value = []
    pushLog('info', '取消本次移动（全部还原）', '6.1')
  }

  /**
   * B15a：**放弃本次移动并退出移动态**（地图会话框的「取消」＝ `Esc`，方案 §4.3）
   *
   * 与 `cancelWholeMove` 的区别：那个**只把盘面还原**（单位仍处于"已选中、可继续走"的移动态，
   * 引擎验证页的按钮就是它）；本动作在还原之后**再清掉本次交互** ⇒ 地图上的移动会话随之收起。
   * 两者都落到同一份 `revertInteraction`（唯一实现），不存在两套"还原"。
   */
  function abortMoveNow(): boolean {
    if (moveInteraction.value === null) return false
    cancelWholeMove()
    clearMoveInteraction()
    return true
  }

  /** C5：结束当前单位/堆叠的移动（6.1 末句；仍可撤销） */
  function finishMove(): void {
    if (moveInteraction.value === null) return
    /*
     * 8.1a：突袭的 3 MP 是在 9.2 推进步记账的 ⇒ 战斗未收束就结束移动会让这笔账无处落盘。
     *
     * ★ 批 A 切片 1（2026-09-18 修）：这里原先**只记一行日志就 return** —— 玩家点「结束移动 / 收束」
     *   在界面上看起来**毫无反应**（会话框挡住日志时更是如此）。现在按**事实**分两路：
     *   · 战斗已结束或已放弃（`combatState` 为 null 或 `finished`）⇒ 托管信息本就该清 ⇒
     *     先 `settleOverrunMove` 就地收束，再照常结束移动（并顺带维持不变量：
     *     `overrunContext !== null ⇒ 战斗仍在进行`）；
     *   · 战斗仍在进行 ⇒ **可见地**拒绝：写 `moveBlocked`（对局台的状态条会显示它）+ 日志，
     *     并明确给出两条出路。
     */
    if (overrunContext.value !== null) {
      const combat = combatState.value
      if (combat === null || combat.finished) {
        settleOverrunMove(combatDefendingHexCleared.value)
      } else {
        const reason =
          '本场突袭尚未收束（8.0）：请先走完 9.2 流程的推进步，或点「放弃本场战斗 / 突袭」后再结束移动；' +
          '否则 8.1a 的 3 MP 与 8.0 的进格都无法记账'
        moveBlocked.value = { rule: '8.1a', reason }
        pushLog('warning', reason, '8.1a')
        return
      }
    }
    // 收束可能已经把本次移动就近结束（参突者全灭那一路）⇒ 重新读取，避免二次落盘
    const interaction = moveInteraction.value
    if (interaction === null || interaction.finished) return
    // 走到这里说明本步能落地 ⇒ 清掉上一次的拒绝原因（moveBlocked 是当前这一步被拒的显示位）
    moveBlocked.value = null
    const names = moveUnits.value.map((unit) => unit.name).join(' + ')
    const result = endMoveEarly({ interaction, runtime: moveRuntime.value })
    applyMovePatches(result.patches)
    moveInteraction.value = result.interaction
    pendingZocConfirm.value = null
    /*
     * 4.5a-A：玩家主动「结束移动」＝选了原文的两个分支中的**前者**（就地结束移动）
     * ⇒ 停车账本随之作废，这些单位此后不再出现在突袭候选里（否则界面会一直挂紫环）。
     */
    zocStoppedMoveUnitIds.value = []
    if (result.record !== null) lastStep.value = snapshotOf(result.record)
    pushLog('info', `结束移动：${names}`, '6.1')
    // ⑭ 接线：结束本次移动（6.1 末句）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'move',
      rule: '6.1',
      data: {
        stage: 'endMove',
        unitIds: moveUnits.value.map((unit) => unit.instanceId),
      },
    })
  }

  /** C5：悬停格（路径与消耗预览） */
  function setHoverHex(hex: HexRef | null): void {
    hoverHex.value = hex
  }

  /**
   * 6.1f：把某一枚从**正在移动的堆叠**里「放下」（就地停住，其余继续走）
   *
   * 规则依据：6.1f「离开堆叠即不得再移动」——移动中的堆叠本就允许「走不动的留下、其余继续」
   * （`planStep` 的 `droppedIds` 就是这条），本函数是玩家**主动**的那一版：走到半路把某几枚留在当前格。
   *
   * 实现只做一件事：把该单位的 `movementEnded` 置真。引擎侧无需新规则——
   * `reachableForMove` 的 `activeUnitIds` 本就按 `ended` 过滤，故它自动退出后续移动与突袭资格。
   */
  function dropUnitFromMove(instanceId: string): boolean {
    const interaction = moveInteraction.value
    if (interaction === null) {
      pushLog('warning', '当前没有正在进行的移动（6.1）')
      return false
    }
    if (!interaction.unitIds.includes(instanceId)) {
      pushLog('warning', '该单位不在本次移动中')
      return false
    }
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return false
    if (unit.movementEnded) {
      pushLog('info', `${unit.name} 本次移动已经结束，无需再放下`)
      return false
    }
    unit.movementEnded = true
    pushLog(
      'success',
      `${unit.name} 就地放下（停在 ${hexLabel(unit.hex)}，本次移动结束；其余单位继续走，6.1f）`,
      '6.1f',
    )
    // ⑭ 接线：放下（6.1f）入会话日志（无骰）
    recordSettlement({
      action: 'move',
      rule: '6.1f',
      data: { stage: 'drop', unitId: instanceId, hex: { ...unit.hex } },
    })
    // 全部放完 ⇒ 本次移动就地收束（不必再点「结束移动」）
    if (activeMoveUnits.value.length === 0) finishMove()
    return true
  }

  /** C5：选择方式 —— 单个单位 / 整堆叠（6.1） */
  function setStackSelect(on: boolean): void {
    stackSelect.value = on
    pushLog(
      'info',
      on ? '选择方式 → 整堆叠（同格内当前方全部单位一起移动，6.1）' : '选择方式 → 单个单位',
    )
  }

  /**
   * C5：切换主动模式（5.4：只在本方移动阶段、且在该单位开始移动时；切换不消耗 MP）
   *
   * ★ 条 9（M1）：**按选中集合批量**切换——优先作用于「取子清单」（`movePick.ids`，即开始移动前
   *   玩家在地图上勾选的那一组），没有取子清单时退回单枚 `selectedUnit`。这样多选的单位能一次切完，
   *   且 5.4a 的"开始移动前可随意改"才落得到实处。
   * 引擎 `canSwitchModeNow` 已支持 reserve/strat（5.7a / 5.8），故 combat/move/reserve/strat 四向都走同一批处理。
   */
  function switchUnitMode(to: BaseMode, orientation?: Orientation): void {
    if (!requireAction('move.modeChange', '改模式')) return
    // 批量目标：取子清单（开始移动前的选中集合）优先；否则单枚选中单位
    const ids =
      movePick.value !== null
        ? movePick.value.ids
        : selectedUnit.value === null
          ? []
          : [selectedUnit.value.instanceId]
    if (ids.length === 0) {
      pushLog('warning', '先选中要改模式的算子（在地图上勾选，或在移动中的单位里选一枚）')
      return
    }
    let okCount = 0
    for (const id of ids) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit === undefined) continue
      // 朝向：战斗/移动面＝模式本身；战略必为移动面（5.8）；预备可任选（5.7a）
      const target: Orientation =
        to === 'combat'
          ? 'combat'
          : to === 'move'
            ? 'move'
            : to === 'strat'
              ? 'move'
              : (orientation ?? unit.mode.orientation)
      const verdict = canSwitchModeNow({
        context: moveContext.value,
        unitId: id,
        runtime: moveRuntime.value,
        to,
        orientation: target,
        unitClass: modeUnitClassOf(unit),
        date: date.value,
      })
      if (!verdict.ok) {
        pushLog(
          'warning',
          `${unit.name} 不能切换到${MODE_LABELS[to]}：${verdict.reason}（${verdict.rule}）`,
          verdict.rule,
        )
        continue
      }
      unit.mode = applyModeSwitch(unit.mode, to, target)
      // 5.4a：一切数值以朝向那一面为基准 → 换面后刷新印值缓存
      unit.raw = unit.faces[unit.mode.orientation]
      okCount += 1
    }
    if (okCount > 0) {
      pushLog(
        'success',
        `已将 ${okCount} 枚切换到${MODE_LABELS[to]}（5.4 切换不消耗 MP；可开始移动前随意改）`,
        '5.4',
      )
    }
    // 条 10（M1）：模式切换不再自动开拔——改由「开始移动」按钮显式触发（与 retryBeginMove 解耦）
  }

  /**
   * E5：释放预备（5.7b）——把选中的预备模式单位的预备标记摘掉
   *
   * 「被玩家『释放』的预备模式单位可在该玩家的**反应阶段或进击阶段**使用……只需移除它的预备标记」
   * （5.7b）。故只在本方反应阶段（非阶段玩家，MA ×1/2）或进击阶段（阶段玩家，MA ×1）可行；
   * 判据全在引擎 `canReleaseReserve`，本函数只落盘 + 记账。
   */
  function releaseReserveNow(): boolean {
    if (!requireAction('reserve.release', '释放预备')) return false
    const unit = selectedUnit.value
    if (unit === null) {
      pushLog('warning', '先选中一个算子')
      return false
    }
    const current = phase.value
    if (current !== 'reaction' && current !== 'exploitation') {
      pushLog(
        'warning',
        `不能释放预备：${PHASE_LABELS[current]} 不是反应 / 进击阶段（5.7b）`,
        '5.7b',
      )
      return false
    }
    const verdict = canReleaseReserve({
      state: unit.mode,
      side: unit.side,
      activeSide: activeSide.value,
      phase: current,
    })
    if (!verdict.ok) {
      pushLog('warning', `不能释放预备：${verdict.reason}（${verdict.rule}）`, verdict.rule)
      return false
    }
    unit.mode = verdict.mode
    pushLog(
      'success',
      `${unit.name} 已释放预备（5.7b）：回到朝向面，本阶段 MA ×${verdict.maMult}`,
      '5.7b',
    )
    // ⑭ 接线：释放预备（5.7b）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'reserveRelease',
      rule: '5.7b',
      data: {
        unitId: unit.instanceId,
        maMult: verdict.maMult,
        phase: current,
      },
    })
    /*
     * 释放成功后自动重试开拔（与付款同款）：非阶段玩家的已释放预备在反应/进击段可动，
     * 玩家点它→释放→直接进入移动交互，省得再点一次「开始移动」。
     * ★ 条 10（M1）只解耦 `switchUnitMode` 尾部的 `retryBeginMove`；释放预备的重试**保留**——
     *   非阶段玩家单位点格只按「查看」选中（不进 `movePick`），`confirmMovePick` 无从开拔，
     *   故这里仍走 `selectedUnit` 自动重试（见 50-phase-e「端到端释放预备」用例）。
     */
    retryBeginMove()
    return true
  }

  /** C5：只改朝向而不改模式（5.4 末句 DG / 5.7a 预备） */
  function flipUnitOrientation(): void {
    if (!requireAction('move.modeChange', '翻朝向')) return
    const unit = selectedUnit.value
    if (unit === null) return
    const verdict = canFlipOrientation({ state: unit.mode, phase: moveContext.value.phase })
    if (!verdict.ok) {
      pushLog('warning', `不能改变朝向：${verdict.reason}（${verdict.rule}）`, verdict.rule)
      return
    }
    unit.mode = flipOrientation(unit.mode)
    unit.raw = unit.faces[unit.mode.orientation]
    pushLog(
      'success',
      `${unit.name} 朝向 → ${unit.mode.orientation === 'combat' ? '战斗面' : '移动面'}（${verdict.rule}）`,
      verdict.rule,
    )
  }

  /**
   * C5：付燃料（12.5c 三法）——费用由引擎算，本 store 只**从声明的补给站**扣款并打标记
   *
   * ★ 12.3a/12.3b 是仅有的两条取补途径（用户裁定：「补给只能从**己方补给站**扣」）——
   *   与 12.4 的战斗补给同一条纪律：**没有来源就付不出**，不存在"手填一个数字就算付了"的池子。
   *   原先这里从 `fuelPool` 扣：账本不变、同一份数字可反复"支付"，3.4b 也无从校验。
   */
  function payFuel(
    method: FuelMethod = fuelMethodEffective.value,
    commonSource: boolean = fuelSourcePartition.value.shared,
  ): void {
    // 12.5a/12.5f：加油在 C/E/G 三段的**移动环节**当场付（H④ 起 D 段那个「加油」环节已删，
    // 12.5c：付款绑在消耗时刻，而补给段不发生燃料消耗）
    if (!requireAction('supply.fuel', '付燃料')) return
    const targets = fuelTargets.value
    if (targets.length === 0) {
      pushLog('warning', '先选中要加油的单位（或开始移动一个堆叠）')
      return
    }
    /*
     * 12.5c（用户 2026-09-17 的界面口径）：**点谁决定能点哪一法** ——
     *   单独单位法对任何单位都成立；编队法要"一整个多单位编队"；HQ 法要选中里有指挥部、
     *   且其余受益单位都是独立单位（3.2f）。判据在引擎 `fuelMethodAvailability`（唯一实现），
     *   这里**当场拦**（界面之外的路径也一致），并把不可用的原因原文照给。
     */
    const availability = fuelMethodChoices.value.find((item) => item.method === method)
    if (availability !== undefined && !availability.available) {
      pushLog('danger', availability.reason ?? `12.5c：${method} 法对当前受益单位不成立`, '12.5c')
      return
    }
    /*
     * ★ B32 步骤 4（12.5c-A / **13.7a**）：编队法与 HQ 法都要求"**全体受益单位共用同一来源**"
     *   （同一指挥部投递 或 同一站直接拖取）。修前这由玩家**勾一个复选框**声明 —— 那就等于
     *   "自己说同源就算同源"。现在按**盘面事实**算（`fuelSourcePartition`）；
     *   不满足时照 13.7a 的第二句给话术：能共用的那部分走编队法，**其余必须改用单独单位法**。
     */
    if (method !== 'singleUnit') {
      const partition = fuelSourcePartition.value
      if (!partition.shared) {
        const namesOf = (ids: readonly string[]): string =>
          ids.map((id) => units.value.find((unit) => unit.instanceId === id)?.name ?? id).join('、')
        pushLog(
          'danger',
          `13.7a：这些受益单位**不是同一个来源**（须同一指挥部投递或同一站直接拖取）⇒ ` +
            `${namesOf(partition.commonUnitIds)} 可走${method === 'hq' ? 'HQ' : '编队'}法，` +
            `${namesOf(partition.singleUnitIds)} 必须改用**单独单位法**（各 1 T）`,
          '13.7a',
        )
        return
      }
    }
    /*
     * 12.5c-B / 12.5e：**HQ 法只覆盖独立单位**（3.2f）——指挥部自己也算独立单位（无编队、单军力）。
     * 编队单位（3.1c）与多军力单位（3.2d）走不了 HQ 法：要么编队法（12.5c-A），要么单独单位法（12.5c-C）。
     * 这里必须**当场拦住**（不能只在候选里藏起来）：界面之外的路径（脚本/宏/读档后重算）也要一致。
     */
    if (method === 'hq') {
      const ineligible = targets.filter((target) => !isIndependentUnitOf(target))
      if (ineligible.length > 0) {
        pushLog(
          'danger',
          `12.5c-B/12.5e：HQ 法只覆盖**独立单位**（3.2f：不属多单位编队、也非多军力单位）⇒ ` +
            `${ineligible.map((unit) => `${unit.name}${unit.formation === null ? '' : `（编队 ${unit.formation}）`}`).join('、')}` +
            ` 不能用 HQ 法；请改用编队法（12.5c-A）或单独单位法（12.5c-C，每单位 1 T）`,
          '12.5c-B',
        )
        return
      }
      /*
       * 12.5e + 12.5d（用户 2026-09-20 裁定）：**燃料窗口持续到本方清理阶段结束** ——
       *   · 窗口内**换位置**投递 ⇒ 按 12.5e 拒（「每个阶段中只能在单独一个位置投递」）；
       *   · 窗口内**同位置**再投 ⇒ 按 12.5c-B 拒：该指挥部已补给（再付只是白花 1SP），
       *     未被覆盖的独立单位走 12.5c-C（每枚 1T）。
       */
      const paidHq = targets.find((target) => isHqUnit(target))
      if (paidHq !== undefined) {
        const previous = hqFuelThrows.value[paidHq.instanceId]
        const originKey = hexLabel(paidHq.hex)
        if (previous !== undefined) {
          pushLog(
            'danger',
            previous.originKey !== originKey
              ? `12.5e：${paidHq.name} 的**燃料窗口**内已在 ${previous.originKey} 投递过 —— ` +
                  `燃料已补给的指挥部**每个阶段只能在单独一个位置**投递（本次不改动任何账本）；` +
                  `若要换位置，请在它移动**开始前**选定投递基点（起始格或结束格）`
              : `12.5c-B：${paidHq.name} 的**燃料窗口**还没结束（${previous.originKey} 投递，覆盖 ` +
                  `${String(previous.coveredIds.length)} 枚）—— 12.5d 明写指挥部燃料标记要到**本方清理阶段**才移除 ⇒ ` +
                  `窗口内**无需重复付款**（本次不改动任何账本）；未被它覆盖的独立单位请用 **12.5c-C 单独单位法**（每枚 1T）`,
            previous.originKey !== originKey ? '12.5e' : '12.5c-B',
          )
          return
        }
      }
    }
    const dump = fuelDump.value
    if (dump === null) {
      pushLog(
        'danger',
        '12.3a：燃料必须从**己方补给站**取 ⇒ 先在「燃料付款来源」里点选一座补给站（不存在凭空可用的池子）',
        '12.3a',
      )
      return
    }
    /*
     * 12.5c-A（I①）：**整编队每阶段只付一次编队法**。
     * 原文把"来源不同的那些单位"明确路由到**单独单位法**（每单位 1T），而不是再买一次编队油；
     * 编队标记（13.7 的燃料已补给面）也只翻一次 ⇒ 已付过的编队再点编队法即拒（账本一字未动）。
     */
    const fuelFormation = method === 'formation' ? (targets[0]?.formation ?? null) : null
    if (method === 'formation' && fuelFormation !== null) {
      const previous = formationFuelThrows.value[fuelFormation]
      if (previous !== undefined) {
        pushLog(
          'danger',
          `12.5c-A：编队 ${fuelFormation} 的**编队油窗口**还没结束（上次来源 ${previous.sourceLabel}，` +
            `覆盖 ${String(previous.coveredIds.length)} 枚）—— 12.5d 明写编队标记要到**本方清理阶段**才翻回，` +
            `期间**一整个编队只付 1SP** ⇒ 本次不改动任何账本；该编队其余成员请按 ` +
            `**12.5c-C 单独单位法**（每枚 1T）付`,
          '12.5c-A',
        )
        return
      }
    }
    /*
     * 12.3a：加油的 SP 只能来自**受益单位自己方**的补给站，且必须是这些单位**拖得到**的那一座
     * （5 MP 直拖或相邻，12.3c）。
     * ★ 判据不取 `activeSide`——反应段（7.0a）里为**已释放的预备**加油时，行动方是对手，
     *   而油钱仍由该预备单位自己一方出（本例：轴方回合的反应段给苏军预备队加油）。
     */
    const beneficiarySides = new Set(targets.map((unit) => unit.side))
    if (beneficiarySides.size !== 1 || !beneficiarySides.has(dump.side)) {
      pushLog(
        'danger',
        `12.3a：${hexLabel(dump.hex)} 的补给属于${dump.side === 'axis' ? '轴心国' : '苏联'}，` +
          `不能用来给${[...beneficiarySides].map((side) => (side === 'axis' ? '轴心国' : '苏联')).join('、')}的单位加油`,
        '12.3a',
      )
      return
    }
    const reachable = new Set(fuelDumpChoices.value.map((item) => item.id))
    if (!reachable.has(dump.id)) {
      /*
       * B32 步骤 3：**按方法给话术** —— 三种方法的可达性口径不同，一句"5 MP 直拖"会误导：
       *   · 单单位法（12.5c-C）：受益单位自己 5 MP 直拖或相邻（12.3a/12.3c）；
       *   · HQ 法（12.5c-B/12.5e）：该站须由**某座 HQ**拖得到，且该 HQ 的**印刷投递距离**
       *     覆盖**全部**受益单位；投递距离还要在"所有独立单位移动开始前"一次算定；
       *   · 编队法（12.5c-A/13.7a）：**全体受益单位共用同一来源**（同一 HQ 投递或同一站直拖）；
       *     做不到时按 13.7a —— **同源的那部分**走编队法、**其余**改单独单位法。
       */
      const methodReason =
        method === 'hq'
          ? '12.5c-B/12.5e：HQ 法要求这座站是**某座指挥部拖得到**的，且该指挥部的**投递距离覆盖全部受益单位**（投递距离须在所有独立单位移动开始前一次算定）'
          : method === 'formation'
            ? '12.5c-A/13.7a：编队法要求**全体受益单位共用同一来源**（同一指挥部投递或同一站直接拖取）；做不到时，只让**同源的那部分**用编队法，其余按 13.7a 改用单独单位法'
            : '12.5c-C：单独单位法要求每个受益单位**自己**在 5 MP 直拖距离内或相邻（12.3a/12.3c）'
      pushLog('danger', `燃料付款来源不可达：${hexLabel(dump.hex)} —— ${methodReason}`, '12.5c')
      pushLog(
        'info',
        `可达的候选：${fuelDumpChoices.value.map((item) => hexLabel(item.hex)).join('、') || '（无）'}`,
        '12.3a',
      )
      return
    }
    const plan = planFuelPayment({
      context: moveContext.value,
      unitIds: targets.map((unit) => unit.instanceId),
      method,
      commonSource,
      /*
       * 12.1a：计价单位是 **T**（1 SP = 4 T），而 `planFuelPayment` 按 `{sp, t}` **分项**比较。
       * `computeFuelCost` 的三种方法只会给出**其中一项**（单单位法给 T、编队/HQ 法给 SP），
       * 故这里把两种面额各按最宽口径给足，且不会重复计价：
       *   · `availableSp` = 整 SP 数（编队/HQ 法要的就是整 SP）；
       *   · `availableT` = 该站**总吨位**（单单位法可按 12.1a 拆分一个整 SP 找零）。
       */
      availableSp: dump.sp,
      availableT: holdingsToT({ sp: dump.sp, t: dump.t }),
    })
    if (!plan.ok) {
      pushLog('danger', `燃料支付失败：${plan.reason}（${plan.rule}）`, plan.rule)
      return
    }
    // 3.4b：错误集群的 SP 不得支付**多单位编队**的燃油成本
    const restricted = panzerGroupSpGate({
      dumpId: dump.id,
      purpose: 'fuel',
      beneficiaryUnitIds: plan.data.unitIds,
    })
    if (restricted !== null) {
      pushLog(
        'danger',
        `燃料付款被拒（3.4b）：${panzerGroupSpRefusal(restricted, '燃油', dump.id)}——本次不改动任何账本`,
        '3.4b',
      )
      return
    }
    // 12.1a：走统一扣款入口（必要时找零）
    const payment = planSpPayment({
      holdings: { sp: dump.sp, t: dump.t },
      wantT: plan.data.costSp * SP_TO_T + plan.data.costT,
    })
    if (!payment.ok) {
      pushLog(
        'danger',
        `燃料付款失败：${payment.reason}（${payment.rule}）——本次不改动任何账本`,
        payment.rule,
      )
      return
    }
    setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
    /*
     * 12.5c-B / 12.5e：**HQ 法的覆盖集在付款这一刻算定** ——
     *   原文：「支付 1SP，为**指挥部自己**，及它投递距离内的**所有独立单位**提供燃料补给」；
     *         「**投递距离在所有的独立单位移动开始前计算**」。
     *   ⇒ 覆盖的是"此刻在投递距离内的**所有**独立单位"（**不只是玩家点选的那几枚**），
     *     且距离**此后不再重算**（单位走开也仍已加注、走来的也不算 —— 这正是 12.5e 的算定口径）。
     */
    const paidHq = method === 'hq' ? (targets.find((unit) => isHqUnit(unit)) ?? null) : null
    /*
     * 12.5c-A（I①，用户 2026-09-18 第 7 条）：编队法的覆盖集在付款这一刻按**盘面事实**算定 ——
     *   同编队、且能从本次付款的这座站取到的**全部**单位（含未被点选的、含徒步面的摩托化单位）；
     *   范围之外的成员不覆盖（它们日后开拔按 12.5c-C 单独单位法付）。
     */
    const formationCoverage =
      method === 'formation' ? formationFuelCoverageSet(targets, dump) : null
    const coveredIds =
      paidHq !== null
        ? hqFuelCoverageSet(paidHq).map((unit) => unit.instanceId)
        : formationCoverage !== null
          ? formationCoverage.covered.map((unit) => unit.instanceId)
          : [...plan.data.unitIds]
    for (const unitId of coveredIds) {
      const unit = units.value.find((item) => item.instanceId === unitId)
      if (unit !== undefined) {
        unit.fuelled = true
        // 12.5c：记下加油方法——持续期由它决定（单单位法=只本阶段；编队/HQ 法=到本方清理阶段）
        unit.fuelMethod = method
      }
    }
    if (paidHq !== null) {
      // 12.5e/12.5d：记下**投递基点**与覆盖集 —— 窗口持续到**本方清理阶段**（`runCleanUpNow` 才清）
      hqFuelThrows.value = {
        ...hqFuelThrows.value,
        [paidHq.instanceId]: { side: paidHq.side, originKey: hexLabel(paidHq.hex), coveredIds },
      }
    }
    if (formationCoverage !== null && fuelFormation !== null) {
      // 12.5c-A（I①）：记下该编队的编队油（来源 + 覆盖集）—— 窗口内再点编队法即拒
      formationFuelThrows.value = {
        ...formationFuelThrows.value,
        [fuelFormation]: {
          side: targets[0]!.side,
          sourceKey: formationCoverage.sourceKey ?? '（未定）',
          sourceLabel:
            formationCoverage.sourceKey === null
              ? '（未定）'
              : (fuelSourceKeysOfUnit(targets[0]!).get(formationCoverage.sourceKey) ?? '（未定）'),
          coveredIds,
        },
      }
      const leftOut = formationCoverage.leftOut.filter(
        (unit) => !coveredIds.includes(unit.instanceId),
      )
      if (leftOut.length > 0) {
        pushLog(
          'info',
          `12.5c-A：编队 ${fuelFormation} 中另有 ${String(leftOut.length)} 枚**不在本次来源范围内**` +
            `（${leftOut.map((unit) => `${unit.name}@${hexLabel(unit.hex)}`).join('、')}）—— ` +
            `按 12.5c-A 它们**不参与**本次编队加油，日后开拔须用 **12.5c-C 单独单位法**（每枚 1T）`,
          '12.5c-A',
        )
      }
    }
    pushLog(
      'success',
      `燃料已付（${FUEL_METHOD_LABELS[method]}：${plan.data.costSp} SP / ${plan.data.costT} T，${plan.data.rule}）；` +
        `付款站 ${hexLabel(dump.hex)} → ${coveredIds.map(nameOf).join('、')}` +
        (paidHq === null
          ? ''
          : `（12.5e：投递基点 ${hexLabel(paidHq.hex)}，本阶段覆盖 ${String(coveredIds.length)} 枚，` +
            `含投递距离内**未被点选**的独立单位）`),
      plan.data.rule,
    )
    // ⑭ 接线：燃料支付（12.5c 三法）入会话日志（本笔不掷骰；费用按规则复核）
    recordSettlement({
      action: 'fuel',
      rule: plan.data.rule,
      data: {
        method,
        commonSource,
        costSp: plan.data.costSp,
        costT: plan.data.costT,
        unitIds: [...plan.data.unitIds],
        // 12.5e：HQ 法的"付费覆盖集"（含未被点选的独立单位）与投递基点一并留痕
        ...(paidHq === null
          ? {}
          : { coveredUnitIds: coveredIds, throwOriginHex: { ...paidHq.hex } }),
        dumpHex: { ...dump.hex },
      },
    })
    retryBeginMove()
  }

  /**
   * 12.5：燃料的**付款来源**（点选一座己方补给站 ⇒ 沿用 12.4 的同一套「声明来源」纪律）
   */
  const fuelDumpId = ref<string | null>(null)

  /**
   * 12.5e：**已投递过燃料的指挥部** ⇒ `{ 投递基点, 付费覆盖集 }`
   *
   * 原文：「燃料已补给的指挥部在**每个阶段**中，只能在**单独一个位置**上投递燃料补给。这会影响
   *   移动中的指挥部，它必须选择从移动**起始格**或者移动**结束格**处投递燃料补给。」
   * ⇒ 记下基点，同窗口内换位置再投递即按 12.5e 拒（**不扣款**）。
   *
   * ★ **持续期（用户 2026-09-20 裁定）**：与 `fuelled` 标记**同寿** ——
   *   12.5c-B 的指挥部燃料标记「持续到**下一个友方清理阶段**」（12.5d 才移除），
   *   用户原话：「**HQ 加油也是到己方清理阶段结束后**」。
   *   ⇒ 本台账**只在"本方清理阶段"随标记一起清**（在 `runCleanUpNow` 里），既不在换阶段清、也不在换回合清：
   *     反应阶段投递的油可以活着跨过半场（甚至回合边界）。窗口内同一指挥部**不再重复付款**
   *     （已补给 ⇒ 再付只是白花 1SP；未被覆盖的独立单位走 12.5c-C，每枚 1T）。
   */
  const hqFuelThrows = ref<
    Record<string, { side: Side; originKey: string; coveredIds: readonly string[] }>
  >({})

  /**
   * 12.5c-A（I①）：**已用编队法付过的编队** ⇒ `{ 来源键, 投递/拖取话术, 覆盖集 }`
   *
   * 「为一整个多单位编队支付 1SP，便可为**整个**多单位编队提供燃料补给」＋「这些使用**不同来源**的单位
   *   只能按**单独单位燃料补给法**来获得燃料补给」⇒ **一次编队加油只买一次**：
   *   已付过的编队再点编队法即拒（本次不改动任何账本），它的其余成员走 12.5c-C（每枚 1T）。
   *
   * ★ **持续期（用户 2026-09-20 裁定）**：不是"一个阶段"，而是与 `fuelled` 标记**同寿** ——
   *   12.5c-A 的编队标记「持续到**下一个友方清理阶段**」（12.5d 才翻回）。用户举的例子：
   *   「同一个回合里在**敌方回合的己方反应阶段**移动环节编队加油，那么到**己方回合移动环节**，
   *   当时按编队加油的单位**仍是加油**，未加油的该编队单位**只能单独加油**，一直到燃料状态重置的
   *   **己方清理阶段**结束后，下次该编队单位要移动时再重新算编队加油」。
   *   ⇒ 本台账**只在"本方清理阶段"随标记一起清**（在 `runCleanUpNow` 里，与 `fuelled` 同一处落盘），
   *     既不在换阶段清、也不在换回合清。
   */
  const formationFuelThrows = ref<
    Record<
      string,
      { side: Side; sourceKey: string; sourceLabel: string; coveredIds: readonly string[] }
    >
  >({})

  /**
   * 12.5e：该指挥部此刻的**付费覆盖集**（HQ 自己 + 投递距离内的**所有独立单位**）
   *
   * 判据全部复用既有唯一实现：`isIndependentUnitOf`（3.2f）、`toThrowHqView`（13.1b 的投递距离与移动类型）、
   * `countSupplyDistanceToAny`（12.3b 的投递路径计数，按投递机动类型）。
   * ★ 调用时点＝**付款那一刻**（"投递距离在所有的独立单位移动开始前计算"）⇒ 覆盖集一经算定便不再重算。
   */
  function hqFuelCoverageSet(hq: ConsoleUnit): ConsoleUnit[] {
    const facts = supplyFacts.value
    const hqView = toThrowHqView(hq)
    const covered: ConsoleUnit[] = [hq]
    for (const unit of units.value) {
      if (unit.side !== hq.side || unit.instanceId === hq.instanceId) continue
      if (!isIndependentUnitOf(unit)) continue
      const reach = countSupplyDistanceToAny(facts, {
        from: hq.hex,
        targets: [unit.hex],
        side: unit.side,
        mobility: hqView.throwMobility,
        maxMp: hqView.throwRangeMp,
      })
      if (reach.ok) covered.push(unit)
    }
    return covered
  }

  /** 12.5e：某指挥部本阶段的投递基点（未投递过则 null），供界面显示 */
  function hqFuelThrowOriginOf(hqInstanceId: string): HexRef | null {
    const entry = hqFuelThrows.value[hqInstanceId]
    if (entry === undefined) return null
    const parts = entry.originKey.split('.')
    const col = Number(parts[0])
    const row = Number(parts[1])
    return Number.isInteger(col) && Number.isInteger(row) ? { col, row } : null
  }

  /** 12.5c-A（I①）：某编队本阶段是否已用编队法付过油（供界面如实说明"其余成员要走单独单位法"） */
  function formationFuelThrowOf(
    formationId: string,
  ): { sourceKey: string; sourceLabel: string; coveredIds: readonly string[] } | null {
    return formationFuelThrows.value[formationId] ?? null
  }

  /**
   * 12.5c-A：本次编队付款的**来源键** —— 全体受益单位共有、且与付款站一致的那个（直接拖取优先）
   *
   * 原文把"同一个来源"定成两种：**同一个指挥部**（投递）或**同一个补给站**（直接拖取）。
   * 付款站是玩家点的那座站 ⇒ 直接拖取优先（键 `dump:<格号>`）；否则退回"拖得到这座站的 HQ 投递"
   * （键 `hq:<id>`，12.3b）。两者都不成立 ⇒ null（调用方按"只覆盖点选的单位"处理并如实说明）。
   */
  function formationSourceAnchorFor(targets: readonly ConsoleUnit[], dump: SpDump): string | null {
    const directKey = `dump:${hexLabel(dump.hex)}`
    const keySets = targets.map((unit) => fuelSourceKeysOfUnit(unit))
    const shared = (key: string): boolean => keySets.every((keys) => keys.has(key))
    if (shared(directKey)) return directKey
    for (const key of keySets[0]?.keys() ?? []) {
      if (!key.startsWith('hq:')) continue
      if (!shared(key)) continue
      const hq = units.value.find((unit) => `hq:${unit.instanceId}` === key)
      if (hq === undefined) continue
      const drawsThisDump = drawableDumpsAt(hq.hex, hq.side, toThrowHqView(hq).throwMobility).some(
        (candidate) => sameHex(candidate.hex, dump.hex),
      )
      if (drawsThisDump) return key
    }
    return null
  }

  /**
   * 12.5c-A（用户 2026-09-18 第 7 条）：编队法的**覆盖集**
   *
   * 「为一整个多单位编队支付 1SP，便可为整个多单位编队提供燃料补给」＋「检查每个单位使用了哪个指挥部
   *   或补给站进行补给的投递或拖取」⇒ 覆盖 = 该编队中**能从本次付款的来源取到**的全部单位：
   *   · 含**未被点选**的同编队单位（这就是用户要的"自动加油"）；
   *   · 含当前朝向为**徒步面**的摩托化单位 —— 12.5a 说的是"要消耗轮式/履带 MP 就得先付"，
   *     与它此刻哪一面朝上无关（日后转移动面开拔时油必须已经加好）；
   *   · **来源之外**的同编队单位**不覆盖**（12.5c-A 后半句 ⇒ 它们日后开拔按 12.5c-C 单独单位法付）。
   */
  function formationFuelCoverageSet(
    targets: readonly ConsoleUnit[],
    dump: SpDump,
  ): { sourceKey: string | null; covered: ConsoleUnit[]; leftOut: ConsoleUnit[] } {
    const formation = targets[0]?.formation ?? null
    if (formation === null) return { sourceKey: null, covered: [], leftOut: [] }
    const sourceKey = formationSourceAnchorFor(targets, dump)
    const members = units.value.filter((unit) =>
      formationFuelCovers({ unitFormation: unit.formation, fuelFormation: formation }),
    )
    if (sourceKey === null) return { sourceKey: null, covered: [], leftOut: members }
    const covered: ConsoleUnit[] = []
    const leftOut: ConsoleUnit[] = []
    for (const unit of members) {
      if (fuelSourceKeysOfUnit(unit).has(sourceKey)) covered.push(unit)
      else leftOut.push(unit)
    }
    return { sourceKey, covered, leftOut }
  }

  /**
   * 12.5：本次加油的**受益单位**（开拔的堆叠 > 已勾选的堆叠 > 选中的那一枚）
   *
   * 与 `payFuel` 取用同一份口径（那里用它算费用），这里用它算**可达性**——
   * 两处若各写一份「哪些单位要加油」，可达性就会与实际付款的单位集漂移。
   *
   * ★ B18b：把**取子清单**（`movePick`，6.1f）插在中间。原先只看 `moveUnits`（= 已经开始移动）
   *   与 `selectedUnit`（= 单一枚）：于是"整堆叠因缺燃料开拔失败"时，受益集只剩**一枚**，
   *   玩家得给同一堆叠付好几次油（12.5c-C 允许，但明显不是玩家想要的），
   *   A/B 两种"整编队/整指挥部"的方法更是无从谈起。
   */
  const fuelTargets = computed<ConsoleUnit[]>(() => {
    if (moveUnits.value.length > 0) return moveUnits.value
    const picked = movePick.value
    if (picked !== null && picked.ids.length > 0) {
      return picked.ids
        .map((id) => units.value.find((unit) => unit.instanceId === id))
        .filter((unit): unit is ConsoleUnit => unit !== undefined)
    }
    return selectedUnit.value === null ? [] : [selectedUnit.value]
  })

  /**
   * 3.2f：该单位是不是**独立单位**（判据只有一处：引擎的 `isIndependentUnit`）
   *
   * 「任何既不属于多单位编队 (3.1c) 也不属于多军力单位 (3.2d) 的单位都是『独立单位』。
   *   这在**燃料补给 (12.5e)** 中很重要。」⇒ 编队归属（`formation`，**数据定死**）与印值军力两项都看。
   * 用户 2026-09-17 裁定：「编队单位肯定是定死的……**编队单位是无法利用 HQ 补给法的**」。
   */
  function isIndependentUnitOf(unit: ConsoleUnit): boolean {
    return isIndependentUnit({ formation: unit.formation, printedSteps: unit.printedSteps })
  }

  /**
   * B18b（12.5a）：本次要动的单位里**有人耗油且未加注** ⇒ 此刻该把「付燃料」摆到台面上
   *
   * 只算**当前方**的单位（选到敌方算子时不该弹出付油面板）；12.5a 说得很直白：
   * 轮式/履带**战斗单位**只要消耗 MP 就必须已付燃料，「即使就移动一格」——
   * 所以这条不是"补给阶段的准备工作"，而是**每一次开拔前的当场动作**（12.5c）。
   */
  const fuelPendingUnits = computed<ConsoleUnit[]>(() =>
    fuelTargets.value.filter(
      (unit) => unit.side === activeSide.value && needsFuelOf(unit) && !unit.fuelled,
    ),
  )

  /** 12.5c：此刻是否该显示「支付燃料」这一手（有未加注的耗油单位） */
  const fuelPaymentDue = computed<boolean>(() => fuelPendingUnits.value.length > 0)

  /**
   * 12.0：**受补给单位**的候选（只有战斗单位需要追溯补给）
   *
   * 12.0 的「重要提示」写得很明白：「只有战斗单位需要补给。非战斗单位、空军单位和海军战斗单位
   * **永远不会**消耗 SP，永远不需要追溯补给」。故这个清单**只列战斗单位**——
   * 修前面板列的是"当前方全部算子"，于是 SP、卡车、延补队、空军基地都能被选进来做补给检查，
   * 引擎只好逐个回一句「不需追溯补给」（12.0 的 `notRequired`），白费玩家一遍点击。
   * 判据用引擎的 `requiresTraceSupply`（唯一出处），不在这里写 `isCombat` 的同义判断。
   */
  const supplyCheckCandidates = computed<ConsoleUnit[]>(() =>
    units.value.filter(
      (unit) => unit.side === activeSide.value && requiresTraceSupply({ isCombat: unit.isCombat }),
    ),
  )

  /**
   * 12.5：可作燃料付款来源的补给站
   *
   * ★ 12.3a：燃料同样只能从**单位拖得到**的补给站取（5 MP 直拖或相邻；12.3c）。
   *   修前这里给的是「该方**全部**补给站」——于是可以在全图任意远处付款，
   *   与 12.4 战斗补给早已修好的同一条纪律不一致（那一侧有 `combatSupplyDumps` 筛可达性）。
   *   12.5c-A/B 要求受益单位**共用同一来源**，故取各受益单位都能拖到的**交集**。
   */
  /**
   * 12.5c：本次加油用**哪种方法**（玩家选择；界面在移动面板的燃料段）
   *
   * ★ B32：原先它是 `MovePanel.vue` 的**组件局部 ref** —— 而候选集（`fuelDumpChoices`）与
   *   校验/扣款（`payFuel`）都在 store，方法在组件里 ⇒ 候选没法按方法分派
   *   （HQ 法该用"**HQ 够得着**"的补给站，而不是"受益单位自己 5 MP 内够得着"的）。
   */
  const fuelMethod = ref<FuelMethod>('singleUnit')

  /**
   * 12.5c：三种加油法对**本次受益单位集**的可用性（用户 2026-09-17 的界面口径）
   *
   * 用户原话：「需要加油的单位点击时未加油都可以点**单独法**，**编队单位**有额外的**编队加油法**，
   *   点击 **HQ** 时才能加 **HQ 法**，因为 HQ 要移动本身也要按自身属性和规则来判断。」
   * 判据只有一处：引擎 `fuelMethodAvailability`（12.5c-A/B/C + 3.2f，本层只把盘面事实喂进去）。
   */
  const fuelMethodChoices = computed(() =>
    fuelMethodAvailability({
      targets: fuelTargets.value.map((unit) => ({
        isHq: isHqUnit(unit),
        formation: unit.formation,
        isIndependent: isIndependentUnitOf(unit),
      })),
    }),
  )

  /**
   * 12.5c：**实际生效**的方法
   *
   * 选中的那一法对当前受益单位集不成立时退回**单独单位法**（12.5c-C：「**任何单位都可以使用此方法**」）
   * —— 这样"选了一法再去点别的单位"不会把玩家卡在一个点不动的按钮上。
   */
  const fuelMethodEffective = computed<FuelMethod>(() => {
    const chosen = fuelMethod.value
    const entry = fuelMethodChoices.value.find((item) => item.method === chosen)
    return entry !== undefined && entry.available ? chosen : 'singleUnit'
  })

  /*
   * ★ B32 步骤 4：**已删** `fuelCommonSource`（玩家勾"来源共用"的那个复选框）——
   *   13.7a / 12.5c-A 要求按**盘面事实**算出"哪些单位共用同一来源"，而不是由玩家声明。
   *   现在这份划分由 `fuelSourcePartition` 给出（同源组 / 需单独付组）。
   */

  /**
   * 12.3a/12.3b：某单位**此刻能从哪些来源取到油**（键 → 一句人话）
   *
   * 键的两种形态：
   *   · `dump:<格号>` —— 它自己 5 MP 直拖或相邻（12.3a/12.3c，按**轮式 MP** 计）；
   *   · `hq:<实例id>` —— 某座指挥部先按 12.3a 拖到 SP（12.3b），再按印值投递距离投给它。
   *
   * ★ 唯一出处（I① 收口）：`fuelSourcePartition`（13.7a 的同源划分）与 12.5c-A 的**编队覆盖集**
   *   共用本函数 —— 修前这段判据只写在 `fuelSourcePartition` 里（且只对**已点选**的受益单位算），
   *   于是"编队的其余成员能不能从这次付款的来源取到"根本无从判断。
   */
  function fuelSourceKeysOfUnit(unit: ConsoleUnit): Map<string, string> {
    const side = unit.side
    const facts = supplyFacts.value
    const keys = new Map<string, string>()
    // 12.3a：它自己直拖得到的补给站
    for (const dump of drawableSpDumpsAt(unit.hex, side, undefined, unit)) {
      keys.set(`dump:${hexLabel(dump.hex)}`, `补给站 ${hexLabel(dump.hex)}（直接拖取，12.3a）`)
    }
    // 12.3b/12.5e：覆盖它的 HQ（先按 12.3a 拖到 SP，再按印值投递距离投给它）
    for (const hq of units.value.filter((item) => item.side === side && isHqUnit(item))) {
      const hqView = toThrowHqView(hq)
      const reach = countSupplyDistanceToAny(facts, {
        from: hq.hex,
        targets: [unit.hex],
        side,
        mobility: hqView.throwMobility,
        maxMp: hqView.throwRangeMp,
      })
      if (!reach.ok) continue
      if (hqView.throwRangeMp <= 0) continue
      const verdict = canThrowViaHQ({
        hqMode: hq.mode.mode,
        distanceMp: reach.mp,
        throwRangeMp: hqView.throwRangeMp,
        ...(hqView.receivedByThrow === undefined
          ? {}
          : { receivedByThrow: hqView.receivedByThrow }),
      })
      if (!verdict.ok) continue
      const drawable = drawableDumpsFor(facts, {
        hex: hq.hex,
        side,
        mobility: hqView.throwMobility,
      }).filter((dump) => dump.ok)
      if (drawable.length === 0) continue
      keys.set(
        `hq:${hq.instanceId}`,
        `指挥部投递 ${hq.name}（载 ${hexLabel(hq.hex)}，12.3b/12.5e）`,
      )
    }
    return keys
  }

  /**
   * 13.7a / 12.5c-A：本次加油的受益单位按**来源**分组（同源组 / 需单独付组）
   *
   * 「多单位编队中的战斗单位必须从**同一个指挥部或同一个直接拖取的补给来源**获得燃料补给；
   *   做不到时，编队的**一部分**用编队法，**其余**用单独单位法。」
   *
   * 每个单位的"可用来源"由引擎判（与候选集同一条实现）：
   *   · `dump:<格号>` —— 它自己 5 MP 直拖或相邻得到的补给站（12.3a/12.3c）；
   *   · `hq:<实例id>` —— 覆盖它的那座 HQ（12.3b 投递：HQ 拖得到 + 投递距离够，12.5e）。
   * 全体交集非空 ⇒ **同源**（`shared: true`，取交集里覆盖单位最多的那个来源）；
   * 交集为空 ⇒ **拆组**（`shared: false`）：能共用同一来源的最大一组走编队法，其余按 13.7a 单独付。
   */
  const fuelSourcePartition = computed<{
    shared: boolean
    /** 建议作为"编队法/ HQ 法"共用来源的那个键（无则 null） */
    commonKey: string | null
    /** 可共用该来源的单位（同源组） */
    commonUnitIds: readonly string[]
    /** 余下必须走**单独单位法**的单位（13.7a 后半句） */
    singleUnitIds: readonly string[]
    /** 每座来源的键 → 一句人话（给日志与界面用） */
    labels: Readonly<Record<string, string>>
  }>(() => {
    const targets = fuelTargets.value
    const empty = {
      shared: false,
      commonKey: null,
      commonUnitIds: [] as readonly string[],
      singleUnitIds: [] as readonly string[],
      labels: {} as Readonly<Record<string, string>>,
    }
    if (targets.length === 0) return empty
    const sides = new Set(targets.map((unit) => unit.side))
    if (sides.size !== 1) return empty

    const labels: Record<string, string> = {}
    const keysOf = new Map<string, Set<string>>()
    for (const unit of targets) {
      const keys = new Set<string>()
      for (const [key, label] of fuelSourceKeysOfUnit(unit)) {
        keys.add(key)
        labels[key] = label
      }
      keysOf.set(unit.instanceId, keys)
    }

    // 全体交集（用数组做：Set 在这个三元里会被 TS 窄化成 never）
    let common: string[] | null = null
    for (const keys of keysOf.values()) {
      const list = [...keys]
      common = common === null ? list : common.filter((key) => list.includes(key))
    }
    const shared = common !== null && common.length > 0

    // 覆盖单位数最多的来源（交集为空时用来挑"能共用的最大一组"）
    const coverage = new Map<string, string[]>()
    for (const unit of targets) {
      for (const key of keysOf.get(unit.instanceId) ?? []) {
        coverage.set(key, [...(coverage.get(key) ?? []), unit.instanceId])
      }
    }
    let bestKey: string | null = null
    for (const [key, ids] of coverage) {
      if (bestKey === null || ids.length > (coverage.get(bestKey)?.length ?? 0)) bestKey = key
    }
    const chosen = shared ? common![0]! : bestKey
    const commonUnitIds = chosen === null ? [] : (coverage.get(chosen) ?? [])
    const singleUnitIds = targets
      .map((unit) => unit.instanceId)
      .filter((id) => !commonUnitIds.includes(id))

    return {
      shared,
      commonKey: chosen,
      commonUnitIds,
      singleUnitIds,
      labels,
    }
  })

  /* ────────── B47（12.8e）：突围尝试 ────────── */

  /** 12.8e：本次突围的骰值（留空即自动掷；供裁判订正 / 复算） */
  const breakoutInputs = ref<{ die: number | null; returnDie: number | null }>({
    die: null,
    returnDie: null,
  })

  /**
   * 12.8e：**成功突围后离图、等待返场**的单位
   *
   * 「成功的单位**离图**，并在未来的某个回合**作为增援返回**」（保留军力损失标记、清除其他标记）。
   * 它们**不进死亡堆**（那不是"被消灭"，也不该出现在重建候选里）⇒ 单列一张表，
   * 到回合由 `deployBreakoutReturnNow` 按**增援入场**的规则放回。
   */
  const breakoutReturns = ref<{ unit: ConsoleUnit; returnsOnTurn: number }[]>([])

  /**
   * 12.8e-A：从该单位所在格出发，按**移动模式的 MA 类型**判"长度任意的路径"
   *
   * 原文：「必须有一条**长度任意**的路径……路径上必须**没有敌方战斗单位**，也**没有移动禁入的地形**
   *   （以该突围单位**移动模式**的 MA 类型判断）。如果是**轮式 MP** 单位，这条路径上还必须没有
   *   **未被抵消的 EZOC**。」
   *
   * 做法：**两趟洪泛** ——
   *   ① **干净洪泛**：避开上述三类障碍格，若能摸到"有追溯补给的友方单位" ⇒ 存在这样的路径（A 成立）；
   *   ② **无限制洪泛**：只为给失败原因取证（记录路上遇到哪些障碍），若它连一个"有追溯补给的友方单位"
   *      都摸不到，则 A 的两项事实一律报 false —— 让引擎按 **B（15 格内）** 去判，不臆造原因。
   */
  function breakoutPathFacts(unit: ConsoleUnit): {
    path: BreakoutPathFacts
    reachedTracedFriend: boolean
  } {
    const map = createMapFacts()
    const mobility = unit.faces.move.mobility // 12.8e-A：以**移动模式**的 MA 类型判
    const side = unit.side
    const isTracedFriend = (hex: HexRef): boolean =>
      !sameHex(hex, unit.hex) &&
      units.value.some(
        (other) => other.side === side && other.hasTraceSupply && sameHex(other.hex, hex),
      )
    const enemyCombatAt = (hex: HexRef): boolean =>
      units.value.some((other) => other.side !== side && other.isCombat && sameHex(other.hex, hex))
    const ezocAt = (hex: HexRef): boolean =>
      mobility === 'truck' && inEnemyZocAt(moveContext.value, hex, side)
    const stepPassable = (from: HexRef, to: HexRef): boolean =>
      selectMovementTerrain({
        terrainsPresent: map.terrainsAt(to),
        mobility,
        crossing: map.crossingBetween(from, to),
        followingRoad: false,
        forOverrun: false,
      }).ok
    const flood = (
      avoidObstacles: boolean,
    ): {
      reached: boolean
      hasEnemyCombatUnit: boolean
      hasProhibitedTerrain: boolean
      hasUnnegatedEzoc: boolean
    } => {
      const seen = new Set<string>([hexLabel(unit.hex)])
      const queue: HexRef[] = [unit.hex]
      let hasEnemyCombatUnit = false
      let hasProhibitedTerrain = false
      let hasUnnegatedEzoc = false
      while (queue.length > 0) {
        const current = queue.shift()!
        if (isTracedFriend(current)) {
          return { reached: true, hasEnemyCombatUnit, hasProhibitedTerrain, hasUnnegatedEzoc }
        }
        for (const direction of HEX_DIRECTIONS) {
          const next = neighbor(current, direction)
          if (!map.onMap(next) || seen.has(hexLabel(next))) continue
          if (enemyCombatAt(next)) {
            hasEnemyCombatUnit = true
            if (avoidObstacles) continue
          }
          if (!stepPassable(current, next)) {
            hasProhibitedTerrain = true
            if (avoidObstacles) continue
          }
          if (ezocAt(next)) {
            hasUnnegatedEzoc = true
            if (avoidObstacles) continue
          }
          seen.add(hexLabel(next))
          queue.push(next)
        }
      }
      return { reached: false, hasEnemyCombatUnit, hasProhibitedTerrain, hasUnnegatedEzoc }
    }

    const clean = flood(true)
    if (clean.reached) {
      return {
        reachedTracedFriend: true,
        path: {
          mobility,
          hasEnemyCombatUnit: false,
          hasProhibitedTerrain: false,
          hasUnnegatedEzoc: false,
        },
      }
    }
    const unrestricted = flood(false)
    if (unrestricted.reached) {
      // 路存在但不干净 ⇒ 把**取证到**的障碍报给引擎（它据此给出带条文号的拒绝理由）
      return {
        reachedTracedFriend: false,
        path: {
          mobility,
          hasEnemyCombatUnit: unrestricted.hasEnemyCombatUnit,
          hasProhibitedTerrain: unrestricted.hasProhibitedTerrain,
          hasUnnegatedEzoc: unrestricted.hasUnnegatedEzoc,
        },
      }
    }
    // 连无限制洪泛都摸不到 ⇒ A 的两项事实一律 false，让引擎按 B 判（不臆造原因）
    return {
      reachedTracedFriend: false,
      path: {
        mobility,
        hasEnemyCombatUnit: false,
        hasProhibitedTerrain: false,
        hasUnnegatedEzoc: false,
      },
    }
  }

  /** 12.8e-B：最近的"**有追溯补给的友方战斗单位**"的**直线**距离（格；无 ⇒ null） */
  function nearestTracedCombatFriendDistance(unit: ConsoleUnit): number | null {
    let best: number | null = null
    for (const other of units.value) {
      if (other.side !== unit.side || !other.isCombat || !other.hasTraceSupply) continue
      const distance = hexDistance(unit.hex, other.hex)
      if (best === null || distance < best) best = distance
    }
    return best
  }

  /**
   * 12.8e：该单位此刻是否处于「发现没有追溯补给的**第一个回合**」
   *
   * 判据＝`cutSinceTurn === 当前回合`（**连续**无补给的起点），且本回合**不是**靠特殊方式续命
   * （12.6c/12.10e/21.10 —— 括注明写那三种方式不给本豁免）。
   * 修前由调用方写 `!unit.hasTraceSupply`（＝此刻无补给）⇒ 任何断补单位永远白拿豁免。
   */
  function isFirstTurnOfBeingCut(unit: ConsoleUnit): boolean {
    return (
      (unit.cutSinceTurn ?? null) === turn.value &&
      (unit.sustainedBySpecialSupplyTurn ?? null) !== turn.value
    )
  }

  /**
   * 12.8e：该单位此刻的突围资格
   *
   * 判据一律交给引擎（`canBreakout`）：调用方只负责把 12.8e-A/B 的**事实**备齐。
   * 「断补首回合豁免」由 `isFirstTurnOfBeingCut` 判（**连续**无补给的起点回合，见 12.8e 括注）。
   */
  function breakoutVerdictOf(unit: ConsoleUnit): RuleOutcome<BreakoutEligibility> {
    const { path, reachedTracedFriend } = breakoutPathFacts(unit)
    const conditions: BreakoutConditions = {
      path,
      nearestTracedCombatFriendDistance: reachedTracedFriend
        ? 0
        : nearestTracedCombatFriendDistance(unit),
    }
    return canBreakout({
      phase: phase.value,
      unit: {
        id: unit.instanceId,
        isCombat: unit.isCombat,
        isTransportPoint: unit.noncombatKind === 'transport_point',
        moveMa: unit.faces.move.ma,
        hasTraceSupply: unit.hasTraceSupply,
      },
      /* 12.8e：首回合＝**连续**无补给的起点回合（且非靠 12.6c/12.10e/21.10 续命的那一回合） */
      firstTurnOutOfSupply: isFirstTurnOfBeingCut(unit),
      conditions,
    })
  }

  /** 12.8e：本方可尝试突围的单位（含结论与原因，供界面阵列逐条灰显） */
  const breakoutCandidates = computed<
    { unit: ConsoleUnit; ok: boolean; reason: string | null; detail: string }[]
  >(() => {
    return units.value
      .filter((unit) => unit.side === activeSide.value && !unit.hasTraceSupply)
      .map((unit) => {
        const verdict = breakoutVerdictOf(unit)
        return {
          unit,
          ok: verdict.ok,
          reason: verdict.ok ? null : `${verdict.reason}（${verdict.rule}）`,
          detail: verdict.ok ? verdict.data.detail : `${verdict.reason}（${verdict.rule}）`,
        }
      })
  })

  /**
   * 12.8e：**宣布一次突围尝试**（逐单位；运输点数须逐个分别掷骰 ⇒ 本动作一次只处理一个实例）
   *
   * 落盘：失败 ⇒ 进死亡堆（可正常重建）；成功 ⇒ **离图**并登记返场回合（保留军力损失、清除其他标记）。
   * 界面上必须**只在突围环节**可用（动作闸 `move.breakout` 只挂在 `movement.breakout`）。
   */
  function breakoutNow(instanceId: string): boolean {
    if (!requireAction('move.breakout', '突围尝试')) return false
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) {
      pushLog('warning', `突围：找不到单位实例 ${instanceId}（12.8e）`, '12.8e')
      return false
    }
    const verdict = breakoutVerdictOf(unit)
    if (!verdict.ok) {
      pushLog('danger', `突围被拒：${verdict.reason}（${verdict.rule}）`, verdict.rule)
      return false
    }
    const inputs = breakoutInputs.value
    const die = inputs.die ?? drawD6()
    const firstTurn = verdict.data.firstTurn
    const resolution = resolveBreakout({
      die,
      firstTurnOutOfSupply: firstTurn,
      currentTurn: turn.value,
      ...(inputs.returnDie === null ? {} : { returnDie: inputs.returnDie }),
      lastTurn: TURN_TRACK[TURN_TRACK.length - 1]?.turn,
    })
    // 成功且未给返场骰 ⇒ 引擎要求**再掷一次**（12.8e：为每个成功单位再掷一骰）
    const returnDie =
      resolution.pendingReturnDie && inputs.returnDie === null ? drawD6() : inputs.returnDie
    const final =
      resolution.pendingReturnDie && returnDie !== null
        ? resolveBreakout({
            die,
            firstTurnOutOfSupply: firstTurn,
            currentTurn: turn.value,
            returnDie,
            lastTurn: TURN_TRACK[TURN_TRACK.length - 1]?.turn,
          })
        : resolution
    const attempt = final.attempt
    if (attempt.success) {
      breakoutReturns.value = [
        ...breakoutReturns.value,
        {
          unit,
          returnsOnTurn: final.returnInfo?.returnsOnTurn ?? turn.value + (returnDie ?? 0),
        },
      ]
      units.value = units.value.filter((item) => item.instanceId !== unit.instanceId)
      refreshTraceSupply(`12.8e 突围离图：${unit.name}`)
      pushLog('success', `${unit.name} 突围成功：${attempt.detail}`, '12.8e')
      pushLog('info', final.returnInfo?.detail ?? '（未定返场回合）', '12.8e')
    } else {
      eliminateEntry(unit, '12.8e', `${unit.name} 突围失败，进入死亡堆（12.8e）`)
      pushLog('danger', `${unit.name} 突围失败：${attempt.detail}`, '12.8e')
    }
    recordSettlement({
      action: 'breakoutAttempt',
      rule: '12.8e',
      rolls: [{ count: 1, faces: [die], total: die }],
      data: {
        unitId: unit.instanceId,
        die,
        modifiedDie: attempt.modifiedDie,
        success: attempt.success,
        disposition: attempt.disposition,
        returnsOnTurn: final.returnInfo?.returnsOnTurn ?? null,
      },
    })
    return true
  }

  /**
   * 12.8e：把**到期的**突围单位按**增援入场**的规则放回地图
   *
   * 「……作为增援返回」⇒ 落点走 13.6b 的入场规则（本方**地图边缘入场格**、且未被敌方单位阻挡）；
   * 回合未到（`turn < returnsOnTurn`）一律拒绝。
   */
  function deployBreakoutReturnNow(instanceId: string, hexText: string): boolean {
    const entry = breakoutReturns.value.find((item) => item.unit.instanceId === instanceId)
    if (entry === undefined) {
      pushLog('warning', `返场：待返场清单里没有 ${instanceId}（12.8e）`, '12.8e')
      return false
    }
    if (turn.value < entry.returnsOnTurn) {
      pushLog(
        'danger',
        `${entry.unit.name} 要到回合 ${entry.returnsOnTurn} 才能返场（12.8e）`,
        '12.8e',
      )
      return false
    }
    const hex = parseHexPath(hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `落点格号应为「列.行」：${hexText}`, '13.6b')
      return false
    }
    const facts = arrivalFacts.value
    const isOwnEntryHex = facts.edgeSupplySourceHexes().some((item) => sameHex(item, hex))
    if (!isOwnEntryHex) {
      pushLog(
        'danger',
        `${hexLabel(hex)} 不是本方的地图边缘入场格（12.8e 按增援返回 / 专规 2.1·3.1）`,
        '12.8e',
      )
      return false
    }
    if (facts.isBlocked(hex)) {
      pushLog(
        'danger',
        `${hexLabel(hex)} 被敌方单位阻挡：按 13.6b 请改选最近的未被阻挡边缘格`,
        '13.6b',
      )
      return false
    }
    const unit = entry.unit
    unit.hex = { ...hex }
    unit.hasTraceSupply = true
    unit.movementEnded = true
    // 12.8e 末段：返回时**清除其他标记**（DG 等），军力损失**保留**（本作的军力由 `steps` 承载，故不动）
    unit.mode = { ...unit.mode, dg: false }
    units.value = [...units.value, unit]
    breakoutReturns.value = breakoutReturns.value.filter(
      (item) => item.unit.instanceId !== instanceId,
    )
    refreshTraceSupply(`12.8e 突围返场：${unit.name}`)
    pushLog(
      'success',
      `${unit.name} 于回合 ${turn.value} 作为增援返场 ${hexLabel(hex)}（12.8e）`,
      '12.8e',
    )
    return true
  }

  const fuelDumpChoices = computed<SpDump[]>(() => {
    const targets = fuelTargets.value
    if (targets.length === 0) return []
    const sides = new Set(targets.map((unit) => unit.side))
    if (sides.size !== 1) return []
    const side = [...sides][0]!
    /*
     * ★ B32（12.5c-B / 12.5e）：**指挥部法**的候选是"**指挥部够得着**的补给站" ——
     *   HQ 先按 12.3a 拖取（5 MP 直拖或相邻，按其**投递移动类型**计数），再按**印刷投递距离**
     *   把补给投给受益单位；受益单位自己离补给站多远都不影响。
     *   修前一律按"受益单位自己 5 MP 直拖"取交集 ⇒ **只有 HQ 够得着的坦克群一分油也取不到**
     *   （用户报告 #1 的第一句：「移动阶段时未能正确从 HQ 获得燃油补给」）。
     *
     *   判据与 12.3b 的补给投递**同源**：`countSupplyDistanceToAny` 算 HQ 到每个受益单位的
     *   投递距离（取最远者；任一个够不到，这座 HQ 就作废），`canThrowViaHQ` 判该 HQ 此刻
     *   能不能投递（战术模式/是否由投递获得…），`drawableDumpsFor` 给 HQ 自己拖得到的补给站。
     */
    if (fuelMethod.value === 'hq') {
      const facts = supplyFacts.value
      const picked = new Map<string, SpDump>()
      /*
       * 12.5c-B / 12.5e（用户 2026-09-17 裁定）：HQ 法只覆盖「**指挥部自己** + 投递距离内的
       * **所有独立单位**（3.2f）」。**编队单位（3.1c）与多军力单位（3.2d）都不在覆盖内** ——
       * 它们要么走编队法（12.5c-A，整编队 1SP），要么走单独单位法（12.5c-C，每单位 1T；
       * 该条明写「无论它是独立单位、多军力单位，还是多单位编队中的单位」）。
       * 判据只有一处（引擎 `hqFuelCovers`）：受益单位要么**就是这台指挥部自己**，要么是独立单位；
       * 只要有一个不合格，这台 HQ 就不算覆盖（不给"半个 HQ 法"）。
       */
      for (const hq of units.value.filter((unit) => unit.side === side && isHqUnit(unit))) {
        const hqIneligible = targets.filter(
          (target) =>
            !hqFuelCovers({
              targetIsTheHq: target.instanceId === hq.instanceId,
              targetIsIndependent: isIndependentUnitOf(target),
            }),
        )
        if (hqIneligible.length > 0) continue
        const hqView = toThrowHqView(hq)
        let worstMp = 0
        let coversAll = true
        for (const target of targets) {
          const reach = countSupplyDistanceToAny(facts, {
            from: hq.hex,
            targets: [target.hex],
            side,
            mobility: hqView.throwMobility,
            maxMp: hqView.throwRangeMp,
          })
          if (!reach.ok) {
            coversAll = false
            break
          }
          worstMp = Math.max(worstMp, reach.mp)
        }
        if (!coversAll) continue
        const throwVerdict = canThrowViaHQ({
          hqMode: hq.mode.mode,
          distanceMp: worstMp,
          throwRangeMp: hqView.throwRangeMp,
          ...(hqView.receivedByThrow === undefined
            ? {}
            : { receivedByThrow: hqView.receivedByThrow }),
        })
        if (!throwVerdict.ok) continue
        const drawable = drawableDumpsFor(facts, {
          hex: hq.hex,
          side,
          mobility: hqView.throwMobility,
        })
        const keys = new Set(drawable.filter((dump) => dump.ok).map((dump) => hexLabel(dump.hex)))
        /*
         * 12.1b：「任何含 SP 的位置（未装载**或装在运输点数上**）都是补给站」⇒ 这里必须遍历
         * `allSpDumps`（账本条目 + 装载来源）。修前只遍历 `spDumps` ⇒ 坦克群唯一够得着的油
         * 若正装在编队卡车上，HQ 法**一分也取不到**（与单单位法那一支不一致）。
         */
        for (const dump of allSpDumps.value) {
          if (dump.side === side && keys.has(hexLabel(dump.hex))) picked.set(dump.id, dump)
        }
      }
      return [...picked.values()]
    }
    let common: SpDump[] | null = null
    for (const unit of targets) {
      const drawable = new Set(
        drawableSpDumpsAt(unit.hex, side, undefined, unit).map((dump) => dump.id),
      )
      common =
        common === null
          ? allSpDumps.value.filter((dump) => drawable.has(dump.id))
          : common.filter((dump) => drawable.has(dump.id))
    }
    return common ?? []
  })

  /** 12.5：点选的燃料付款补给站（未选或该站已不存在 ⇒ null） */
  const fuelDump = computed<SpDump | null>(
    // 12.1b（B32 步骤 5）：来源可能是**装载在运输点数上的 SP** ⇒ 已选条目也要从 allSpDumps 里找
    () => allSpDumps.value.find((dump) => dump.id === fuelDumpId.value) ?? null,
  )

  /**
   * 12.5c-A（I①）：**编队法的覆盖预览**（界面在付款前如实说明"这一付会覆盖谁"）
   *
   * 用户 2026-09-18 第 7 条要的正是"点一枚编队单位付编队法 ⇒ 同编队、在本来源范围内的其余单位
   * 也一并加注；范围外的同编队单位不参与"。故这里把同一处判据（`formationFuelCoverageSet`）
   * 的结论摊给界面：`coveredIds`（将被覆盖）/ `leftOutIds`（不参与，日后要单独付）。
   */
  const fuelFormationCoverage = computed<{
    formation: string
    sourceKey: string | null
    sourceLabel: string
    coveredIds: readonly string[]
    leftOutIds: readonly string[]
  } | null>(() => {
    if (fuelMethod.value !== 'formation') return null
    const dump = fuelDump.value
    const targets = fuelTargets.value
    if (dump === null || targets.length === 0) return null
    const formation = targets[0]?.formation ?? null
    if (formation === null) return null
    const { sourceKey, covered, leftOut } = formationFuelCoverageSet(targets, dump)
    return {
      formation,
      sourceKey,
      sourceLabel:
        sourceKey === null
          ? '（未定：本来源既不是这些单位的直接拖取站，也不是某座拖得到它的指挥部的投递范围）'
          : (fuelSourceKeysOfUnit(targets[0]!).get(sourceKey) ?? '（未定）'),
      coveredIds: covered.map((unit) => unit.instanceId),
      leftOutIds: leftOut
        .filter((unit) => !covered.some((item) => item.instanceId === unit.instanceId))
        .map((unit) => unit.instanceId),
    }
  })

  /** 12.5：声明燃料的付款来源（12.3a：只能来自**受益方自己**的补给站——见 `payFuel` 的校验） */
  function pickFuelDump(dumpId: string | null): boolean {
    if (dumpId === null) {
      fuelDumpId.value = null
      return true
    }
    // 12.1b（B32 步骤 5）：来源也可能是**装载在运输点数上的 SP**（id 前缀 "unit:"）
    const dump = allSpDumps.value.find((item) => item.id === dumpId)
    if (dump === undefined) {
      pushLog('warning', `找不到补给来源 ${dumpId}（12.1b）`, '12.1b')
      return false
    }
    fuelDumpId.value = dumpId
    pushLog(
      'info',
      `燃料付款来源：${hexLabel(dump.hex)}${dump.carriedBy === undefined ? '' : '（装载在运输点数上，12.1b）'}（${dump.side === 'axis' ? '轴' : '苏'}｜${dump.sp} SP + ${dump.t} T = ${holdingsToT({ sp: dump.sp, t: dump.t })} T）`,
      '12.5',
    )
    return true
  }

  /**
   * C5：演示用补给池（SP / T）
   *
   * ★ **12.3a 之后已无任何付款路径使用它**（战斗补给、燃料、轰炸、建造都改从声明的补给站扣）。
   *   保留它只为两件事：① 骨架界面的历史显示；② 回归用例里「共用池不得充作任何来源」的锚点。
   *   新增付款请一律走「声明补给站 → `planSpPayment`」，不要往这里写。
   */
  function setFuelPool(sp: number, t: number): void {
    fuelPool.value = { sp: Math.max(0, sp), t: Math.max(0, t) }
  }

  /** C5：直接改某单位的燃料状态（便于制造「未加注」情形，12.5a） */
  function setUnitFuelled(instanceId: string, fuelled: boolean): void {
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return
    unit.fuelled = fuelled
    // 12.5c：本开关不按规则记账（`null` ⇒ 视为持续到本方清理阶段，与既有行为一致）；
    // 要精确控制持续期（单单位法只本阶段）请用「付燃料」走 payFuel
    unit.fuelMethod = null
    pushLog('info', `${unit.name} → ${fuelled ? '已加注燃料' : '未加注燃料'}（12.5a）`, '12.5a')
    retryBeginMove()
  }

  /** 4.5b：以某单位许诺「本阶段不再消耗 MP」，抵消其所在格的敌方 ZOC */
  function lockZocNegation(instanceId: string): void {
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return
    if (!unit.isCombat) {
      pushLog('warning', `${unit.name} 不是战斗单位，不能用于抵消敌方 ZOC（4.5b）`, '4.5b')
      return
    }
    unit.mpLockedThisPhase = true
    pushLog(
      'info',
      `${unit.name} 许诺本阶段不再消耗 MP → 抵消 ${unit.hex.col}.${unit.hex.row} 格的敌方 ZOC（4.5b）`,
      '4.5b',
    )
  }

  /**
   * 「打一仗」的点击分派（C6 九步流程的选格）
   *
   * ★ 批 A 切片 2：本函数是**唯一实现** —— 验证页的"工具＝battle"与对局台**战斗环节**的点击都调它，
   *   不再各写一遍"点敌方格选防御格 / 点己方单位加减攻方"。
   */
  function battleToolClick(hex: HexRef): void {
    // C6 九步流程进行中：先按 9.2 结算完（或明确放弃），避免盘面在流程中途漂移
    if (combatState.value !== null) {
      pushLog('warning', '本场战斗进行中：请先结算完 9.2 流程，或点「放弃本场战斗」', '9.2')
      return
    }
    if (battleMode.value === 'full') {
      // C6：点敌方格＝选防御格；点己方算子＝加入/移出攻方（9.1b）
      const atHex = unitsAt(hex)
      if (atHex.some((unit) => unit.side !== activeSide.value)) {
        selectCombatDefenderHex(hex)
        return
      }
      if (atHex.some((unit) => unit.side === activeSide.value)) {
        const pick = [...atHex].reverse().find((unit) => unit.side === activeSide.value)!
        toggleCombatAttacker(pick.instanceId)
        return
      }
      battleTarget.value = null
      pushLog('info', `${hexLabel(hex)} 是空格；点己方算子加入攻方，点敌方算子所在格选定防御格`)
      return
    }
    // quick：一键查表（9.9 便捷入口）——点己方算子设为攻方，再点敌方格选定交战
    const top = [...units.value]
      .reverse()
      .find((item) => item.hex.col === hex.col && item.hex.row === hex.row)
    const attacker = selectedUnit.value
    if (top !== undefined && (attacker === null || top.side === activeSide.value)) {
      selectedId.value = top.instanceId
      battleTarget.value = null
      pushLog('info', `攻方 → ${top.name} @ ${hex.col}.${hex.row}（再点敌方算子所在格选定交战）`)
      return
    }
    openBattle(hex)
  }

  /**
   * 点地图：按工具模式分派（摆子 / 打一仗 / C5 移动交互）
   *
   * C5 的交互流（用户需求）：
   *   选单位或堆叠 → 显示可移动范围 → 点格逐格移动（每格重算范围）→ 不想走了点「结束移动」。
   * 全部规则结论来自引擎（`move-interaction` 系列函数），本函数只做分派与落盘。
   */
  function clickHex(hex: HexRef): void {
    /*
     * ★ 批 A 切片 2（用户口径「正式界面由流程驱动」）：**环节优先**，其余照旧 ——
     *   ① 当前环节是某段的**轰炸环节** ⇒ 点地图＝选**轰炸目标格**（10.0d）；
     *   ② 当前环节是**战斗环节** ⇒ 点敌方格＝选防御格、点己方单位＝加入/移出攻方（9.1b/c）。
     *   对局台因此**不需要任何工具切换**；验证页的工具分派与对局台的移动交互都排在后面、原样保留。
     */
    if (isBarrageSegment.value) {
      pickBarrageTargetAt(hex)
      return
    }
    if (isCombatPickSegment.value) {
      battleToolClick(hex)
      return
    }
    if (tool.value === 'place') {
      if (pendingRecord.value === null) {
        pushLog('warning', '先从单位列表选一个算子，再点地图摆放')
        return
      }
      placeAt(hex)
      return
    }
    if (tool.value === 'battle') {
      battleToolClick(hex)
      return
    }

    // C5：已在移动中 → 这一点是「走到该格」
    let interaction = moveInteraction.value
    // 6.1 末句：一个单位/堆叠结束移动后再动下一个 —— 若上一轮已 finished，
    // 则点地图意味着玩家要开始新动作（选别的单位或发起突袭），此时惰性清空
    // 上轮 interaction，让后续分派正确落到「选单位 / 突袭目标」分支。
    if (interaction !== null && interaction.finished) {
      clearMoveInteraction()
      interaction = null
    }
    if (interaction !== null) {
      const staying = interaction.unitIds
        .map((id) => units.value.find((item) => item.instanceId === id))
        .find(
          (unit) =>
            unit !== undefined &&
            !unit.movementEnded &&
            unit.hex.col === hex.col &&
            unit.hex.row === hex.row,
        )
      if (staying !== undefined) {
        /*
         * ★ B26（用户口径 2026-09-16 #21）：「**点选单位移动落子后，再点击单位即移动结束**，
         *   不需要额外的移动结束按钮」。所以点到自己所在格＝收束本次移动（不是报错）。
         * 加一条"至少走过一步"的判据：刚点开还没动就再点一下，不该把这次移动关掉
         * （那时玩家多半是想换人/换格，弹一句提示更合适）。
         */
        if (interaction.steps.length === 0) {
          pushLog('info', '还没移动：点高亮格走一格（6.1）；点别的己方算子可换人', '6.1')
          return
        }
        finishMove()
        // 8.1a：突袭未收束时 `finishMove` 会拒绝并已就地给出原因 ⇒ 不再补一句"已结束"
        if (moveInteraction.value?.finished !== true) return
        pushLog('info', '再点本单位 ＝ 结束本次移动（6.1）', '6.1')
        return
      }
      tryMoveTo(hex)
      return
    }

    // C5：未开始移动 → 选单位或堆叠（当前方优先；6.1 可单独或以堆叠移动）
    if (friendlyUnitsAt(hex).length > 0) {
      selectForMove(hex)
      return
    }
    const atHex = [...units.value]
      .reverse()
      .find((item) => item.hex.col === hex.col && item.hex.row === hex.row)
    selectedId.value = atHex?.instanceId ?? null
    clearMoveInteraction()
    pushLog(
      'info',
      atHex === undefined
        ? `选中格 ${hex.col}.${hex.row}（空格）`
        : `选中 ${atHex.name}（非当前方，仅供查看，不能移动）`,
    )
  }

  /** 把 B21 的违规项折成一行可读文本 */
  function violationText(verdict: Extract<LegalityVerdict, { ok: false }>): string {
    return verdict.violations
      .map(
        (violation) =>
          `${violation.family}:${violation.detail ?? violation.reason}（${violation.rule}）`,
      )
      .join('；')
  }

  /**
   * 选定交战（9.0/9.1）：校验 9.1a 相邻、3.2b 可攻击，并按 B21 判时机/模式
   *
   * 通过后只**记下目标**，由面板确认 9.3b 地形与 9.6 行动值后再结算（防御方有选择权）。
   */
  function openBattle(defenderHex: HexRef): void {
    // 9.1：宣告交战在战斗段的「战斗环节」（F 段首环是炮击，那一刻还不能宣告战斗）
    if (!requireAction('combat.declare', '宣告交战')) return
    const attacker = selectedUnit.value
    if (attacker === null) {
      pushLog('warning', '先选中一个算子作为攻方（点己方算子）')
      return
    }
    const defenders = unitsAt(defenderHex)
    if (defenders.length === 0) {
      pushLog('warning', `${defenderHex.col}.${defenderHex.row} 没有守方单位`)
      return
    }
    if (defenders[0]!.side === attacker.side) {
      pushLog('warning', '攻守必须为敌对双方')
      return
    }
    // 9.1a：进攻必须由相邻格的单位发起
    if (!areAdjacent(attacker.hex, defenderHex)) {
      pushLog(
        'warning',
        `${attacker.name} @ ${attacker.hex.col}.${attacker.hex.row} 与 ${defenderHex.col}.${defenderHex.row} 不相邻，不能进攻（9.1a）`,
        '9.1a',
      )
      return
    }
    // 3.2b/9.4：无攻击能力或战斗值为 0 的单位不能进攻（也避免把 0 军力送进 CRT）
    if (!attacker.attackCapable || attacker.raw.attack <= 0) {
      pushLog(
        'warning',
        `${attacker.name} 不可进攻（attackCapable=${attacker.attackCapable}，战斗值 ${attacker.raw.attack}）`,
        '3.2b',
      )
      return
    }
    // 2.2 时机（常规战斗仅 F/G 段）+ 5.x 模式：统一问 B21
    const verdict = checkLegality(
      buildLegalityRequest({
        action: 'attack',
        unit: attacker,
        context: moveContext.value,
        units: units.value,
        date: date.value,
        target: defenderHex,
        // F 战斗段没有移动环节，必须显式给出当前 SOP 段，否则会被当成 C 段
        phase: phase.value,
      }),
    )
    if (!verdict.ok) {
      pushLog('danger', `不能进攻：${violationText(verdict)}`, verdict.violations[0]!.rule)
      return
    }
    battleTarget.value = { hex: defenderHex, defenderIds: defenders.map((unit) => unit.instanceId) }
    // 9.3b：地形由防御方选，先给「对防御方最有利」的默认值；9.6：行动值默认取最高（null）
    battleTerrain.value = defaultDefenseTerrain(defenderHex)
    battleDefenderArId.value = null
    pushLog(
      'info',
      `选定交战：${attacker.name} → ${defenderHex.col}.${defenderHex.row}（守方 ${defenders.length} 个）；确认地形/行动值后点「结算战斗」`,
      '9.1',
    )
  }

  /** 结算已选定的交战（9.3b 地形 + 9.6 行动值 + 16.0 环形工事 + 9.9 CRT） */
  function resolveBattleNow(): void {
    const attacker = selectedUnit.value
    const target = battleTarget.value
    if (attacker === null || target === null) {
      pushLog('warning', '尚未选定交战（先选攻方，再点敌方算子所在格）')
      return
    }
    const defenders = battleDefenders.value
    if (defenders.length === 0) {
      pushLog('warning', '守方单位已不在目标格，请重新选定交战')
      battleTarget.value = null
      return
    }
    const chosenTerrain =
      battleTerrain.value !== '' ? battleTerrain.value : defaultDefenseTerrain(target.hex)
    // 9.6：守方指定的参战单位（未指定则由引擎退回「取最高」）
    const defenderArUnit = defenders.find((unit) => unit.instanceId === battleDefenderArId.value)
    const outcome = resolveBattle({
      rng: rng.value,
      attackers: [attacker],
      defenders,
      chosenTerrain,
      // 16.0/9.9：守方环形工事等级（含专规 1.3a 的**地图印刷永久工事**，与 createBattleFacts 同口径）
      hedgehogLevel: Math.max(
        printedHedgehogLevelAt(target.hex),
        hedgehogLevelAt(units.value, target.hex),
      ),
      // 9.6：攻方只有 1 个参战单位；守方按玩家指定
      attackerAr: attacker.raw.ar,
      ...(defenderArUnit === undefined ? {} : { defenderAr: defenderArUnit.raw.ar }),
    })
    if (!outcome.ok) {
      pushLog('danger', `打不起来：${outcome.reason}`, '9.9')
      return
    }
    rng.value = outcome.rng
    drawCount.value += 1
    lastBattle.value = outcome.report
    const report = outcome.report
    pushLog(
      'success',
      `2d6 = ${report.dice.faces.join('+')} = ${report.dice.total}；修正骰 ${report.rule.modifiedDice}（AR ${report.attackerAR}−${report.defenderAR}，工事 ${report.hedgehogLevel}）；` +
        `地形 ${report.terrain}（${report.terrainLine}）；军力 ${report.attackerStrength} : ${report.defenderStrength} = ${report.rule.ratio}；` +
        `CRT「${report.rule.raw}」→ 攻方 L${report.rule.attacker.losses}${report.rule.attacker.hasOption ? ' + 选项' : ''}` +
        `${report.rule.attacker.exploitationAR === undefined ? '' : ` e${report.rule.attacker.exploitationAR}`}` +
        `／守方 L${report.rule.defender.losses}${report.rule.defender.hasOption ? ' + 选项' : ''}` +
        `${report.rule.defender.disorganized ? ' + DG' : ''}`,
      '9.9',
    )
    // ⑭ 接线：一键查表（9.9 战斗表）入会话日志；rolls 取引擎报告的 2d6
    recordSettlement({
      action: 'combatDice',
      rule: '9.9',
      rolls: [report.dice],
      data: {
        mode: 'quick',
        terrain: report.terrain,
        attackerAR: report.attackerAR,
        defenderAR: report.defenderAR,
        hedgehogLevel: report.hedgehogLevel,
        modifiedDice: report.rule.modifiedDice,
        ratio: report.rule.ratio,
        raw: report.rule.raw,
        attackerLosses: report.rule.attacker.losses,
        defenderLosses: report.rule.defender.losses,
        defenderDisorganized: report.rule.defender.disorganized,
      },
    })
  }

  /* ──────────────── C6 战斗交互：选子 → 9.2 九步流程动作（全部问引擎） ──────────────── */

  /** C6：切战斗工具模式（quick＝一键查表 9.9；full＝9.2 九步完整流程） */
  function setBattleMode(next: 'quick' | 'full'): void {
    battleMode.value = next
    clearCombat()
    battleTarget.value = null
    pushLog(
      'info',
      next === 'full' ? '战斗工具 → 九步完整流程（9.2）' : '战斗工具 → 一键查表（9.9）',
    )
  }

  /** C6：清空本场战斗的全部交互状态（换方/换阶段/重置/关闭时调用） */
  function clearCombat(): void {
    resetOptionDraft()
    combatAttackerIds.value = []
    combatState.value = null
    combatError.value = null
    combatSurpriseDie.value = null
    combatSurpriseRoll.value = null
    combatShiftRoll.value = null
    combatDiceRoll.value = null
    combatAwaitingShiftDie.value = false
    combatInputs.value = createCombatInputs()
    // W7 C16：战斗补给的来源声明随本场战斗一并作废
    combatSupplyDumpIds.value = { attacker: null, defender: null }
    // 9.12d / 9.12f：跟随者名单与「战斗开始时」快照随之作废
    combatTagalongIds.value = []
    combatStartSnapshot.value = []
    // 选定目标一并清掉：战斗结束后防御格可能已易手，留着旧目标会误导下一次选择
    battleTarget.value = null
  }

  /**
   * 淘汰落盘：把**被摧毁**的算子移出盘面并**放进死亡堆**（唯一入口）
   *
   * ★ 为什么必须集中一处：死亡堆是 13.5 重建与专规 1.6c「随机重建一个师」的**唯一来源**
   *   （`containers.rebuildCandidates` / `freeSpecialReplPool(deadPile)`，界面上的 C12 死亡堆盒
   *   也直接读它）。原先战斗、轰炸、空投三处淘汰各自只做 `splice`/`filter` 并打一句
   *   「移入死亡堆」，盘面里却查不到该单位——规则链就断在这里，且因为断言只看结论、
   *   不看盘面账本，2255 个用例全绿也发现不了。
   * ★ **地面与空军共用本入口与同一个死亡堆**（用户裁定；依据 14.1b 飞机亦可重建）：
   *   按判别字段决定从 `units` 还是 `airUnits` 移除，并顺带清掉与它绑定的选中/任务态。
   * ★ `text` 由调用方给出（各条的规则出处不同），但「进死亡堆」这一动作由本函数保证。
   */
  function eliminateEntry(entry: DeadPileEntry, rule: string, text: string): void {
    if (isAirDeadPileEntry(entry)) {
      airUnits.value = airUnits.value.filter((item) => item.instanceId !== entry.instanceId)
      airMissionAirIds.value = airMissionAirIds.value.filter((id) => id !== entry.instanceId)
    } else {
      units.value = units.value.filter((item) => item.instanceId !== entry.instanceId)
      // 选中态可能正指着这个单位；不清会留下悬空选中
      if (selectedId.value === entry.instanceId) selectedId.value = null
    }
    deadPile.value = [...deadPile.value, entry]
    pushLog('danger', text, rule)
    // 12.3b / 12.7：被摧毁的 HQ 或延补队是**补给源**，少一个源就要重判全场
    if (!isAirDeadPileEntry(entry) && affectsSupplyNet(entry))
      refreshTraceSupply(`${entry.name} 被摧毁`)
  }

  /**
   * 5.10 / 5.10c：给单位施加 **DG**（混乱模式）——**被动模式替代当前模式**
   *
   * 条文：「可用 DG 标记来标记混乱模式，并**保持单位当前移动或战斗面的朝向**。
   *   **从该堆叠中移除其他所有模式标记**。」5.10c：运输点数不受 DG 影响，
   *   其中处于预备模式的**编内卡车**只是失去预备标记。
   *
   * ★ 此前两处施加点都只做 `unit.mode.dg = true`，**不清** 预备 / 战略 / 进击标记 ——
   *   于是 DG 与被动的模式标记叠加，B1 修好的模式折算会错上加错
   *   （战略模式战斗值应为 0，却按 DG ×½ 或预备 ×½ 算）。判据本身早已写在
   *   `engine/rules/modes.ts#markersAfterDg` 里，本函数是它的**唯一落盘点**。
   */
  function applyDgToUnit(unit: ConsoleUnit): void {
    const markers = markersAfterDg({ unitClass: modeUnitClassOf(unit), state: unit.mode })
    if (markers === 'loseReserveMarkerOnly') {
      // 5.10c：运输点数不受 DG 影响；处于预备模式的编内卡车失去预备标记
      if (unit.mode.mode === 'reserve')
        unit.mode = { ...unit.mode, mode: unit.mode.orientation, releasedFromReserve: false }
      return
    }
    // 5.10：移除其他所有模式标记（预备 / 战略 / 进击），朝向不变，只留 DG
    unit.mode = {
      mode: unit.mode.orientation,
      orientation: unit.mode.orientation,
      dg: true,
      exploit: false,
      releasedFromReserve: false,
    }
  }

  /** C6：把引擎给出的战斗变更落盘（引擎不写状态，CODE_SPEC §3.1）；军力归零者移入死亡堆（9.11） */
  function applyCombatPatches(patches: readonly CombatUnitPatch[]): void {
    const eliminated: ConsoleUnit[] = []
    for (const patch of patches) {
      const unit = units.value.find((item) => item.instanceId === patch.unitId)
      if (unit === undefined) continue
      if (patch.steps !== undefined) {
        unit.steps = patch.steps
        if (patch.steps <= 0) eliminated.push(unit)
      }
      if (patch.hex !== undefined) {
        unit.hex = { ...patch.hex }
        // 专规 3.5：战斗后推进/撤退同样是"进入某格"
        noteUnitEnteredHex(unit, patch.hex)
      }
      if (patch.dg === true) applyDgToUnit(unit)
      if (patch.exploit === true) unit.mode.exploit = true
    }
    for (const unit of eliminated)
      eliminateEntry(unit, '9.11', `${unit.name} 军力归零，移入死亡堆（9.11）`)
  }

  /** C6：扣某单位若干点军力（9.12e 额外损失等；绝对值写回） */
  function takeCombatLoss(unitId: string, points: number): void {
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) return
    applyCombatPatches([{ unitId, steps: Math.max(0, unit.steps - points) }])
  }

  /** C6：统一收引擎结论（失败即记 `combatError` 与日志并返回 null） */
  function acceptCombat<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      combatError.value = null
      return outcome.data
    }
    combatError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /** C6：点选/取消一个攻方单位（9.1a 只有当前方；9.1b 可取堆叠的一部分；9.0 须与防御格相邻） */
  function toggleCombatAttacker(unitId: string): void {
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) return
    if (unit.side !== activeSide.value) {
      pushLog('warning', '只有当前方的单位可以攻击（9.1a）', '9.1a')
      return
    }
    if (!unit.isCombat || !unit.attackCapable) {
      pushLog('warning', `${unit.name} 不可攻击（3.2b/9.1e）`, '9.1e')
      return
    }
    const target = battleTarget.value
    if (target !== null && !areAdjacent(unit.hex, target.hex)) {
      pushLog(
        'warning',
        `${unit.name} 与防御格 ${hexLabel(target.hex)} 不相邻，不能攻击（9.0）`,
        '9.0',
      )
      return
    }
    if (combatAttackerIds.value.includes(unitId)) {
      combatAttackerIds.value = combatAttackerIds.value.filter((id) => id !== unitId)
      pushLog('info', `移出攻方：${unit.name}`)
    } else {
      combatAttackerIds.value = [...combatAttackerIds.value, unitId]
      pushLog(
        'info',
        `加入攻方：${unit.name}${target === null ? '（再点敌方格选定防御格）' : ''}`,
        '9.1b',
      )
    }
    selectedId.value = unitId
    combatState.value = null
    combatError.value = null
  }

  /**
   * C6：9.5b 减员 —— 补给步里勾选/取消参战攻方
   *
   * 与 `toggleCombatAttacker` 的区别：此时构成已锁定，本动作**只改玩家意图**，
   * 提交时由引擎 `planCombatSupply({ attackerUnitIds })` 校验子集合法性，不在此重置战斗状态。
   */
  function toggleCombatSupplyAttacker(unitId: string): void {
    if (combatAttackerIds.value.includes(unitId)) {
      if (combatAttackerIds.value.length <= 1) {
        pushLog('warning', '至少要保留一个参战单位（9.1b）', '9.5b')
        return
      }
      combatAttackerIds.value = combatAttackerIds.value.filter((id) => id !== unitId)
      pushLog('info', `移出参战：${nameOf(unitId)}（9.5b 减员）`, '9.5b')
      return
    }
    combatAttackerIds.value = [...combatAttackerIds.value, unitId]
    pushLog('info', `加入参战：${nameOf(unitId)}（9.5b）`, '9.5b')
  }

  /**
   * B15b：把地图上**某一格**的选择集**镜像**到战斗的参与集合（方案 §4.2）
   *
   * 「选择集就是后续动作的参与集合：战斗/炮击/补给/移动共用同一套「展开 + 选择」，
   *  不存在「面板里再选一次」」——地图上摊开的那一圈金色边框就是参与者名单。
   *
   * 语义是**逐格同步**（不是覆盖全局名单）：只把**该格**的单位按选择集增删，
   * 别格的参战单位原样保留（多格联合攻击时，玩家会分别在各格摊开选）。
   * 两步都落到既有的 `toggleCombatAttacker`（9.1 选攻方）/ `toggleCombatSupplyAttacker`（9.5b 减员）
   * —— 那两个动作各自带着自己的合法性（9.1a 归属 / 9.1e 可攻击 / 9.0 相邻 / 9.1b 至少留一枚），
   * 所以镜像**不会**绕过它们，也不会产生第二套判定。
   */
  function syncCombatParticipants(hex: HexRef, selectedIds: readonly string[]): void {
    const atHex = unitsAt(hex).filter((unit) => unit.side === activeSide.value)
    if (atHex.length === 0) return
    const locked = combatState.value !== null && combatState.value.step === 'combatSupply'
    for (const unit of atHex) {
      const wanted = selectedIds.includes(unit.instanceId)
      const has = combatAttackerIds.value.includes(unit.instanceId)
      if (wanted === has) continue
      if (locked) toggleCombatSupplyAttacker(unit.instanceId)
      else toggleCombatAttacker(unit.instanceId)
    }
  }

  /** C6：选定防御格（9.0：只能攻击含敌方**战斗**单位的格；非战斗单位走 9.14 特殊战斗） */
  function selectCombatDefenderHex(hex: HexRef): void {
    const atHex = unitsAt(hex)
    const enemyCombat = atHex.filter(
      (unit) => unit.side !== activeSide.value && unit.isCombat && unit.steps > 0,
    )
    if (enemyCombat.length === 0) {
      pushLog(
        'warning',
        atHex.length === 0
          ? `${hexLabel(hex)} 没有单位`
          : `${hexLabel(hex)} 没有敌方战斗单位：常规战斗不适用（9.0；非战斗单位走 9.14 特殊战斗）`,
        '9.0',
      )
      return
    }
    // 9.0：已有攻方时，逐个复核与防御格的相邻性（不相邻者不得参战）
    const notAdjacent = combatAttackerIds.value.filter((id) => {
      const unit = units.value.find((item) => item.instanceId === id)
      return unit !== undefined && !areAdjacent(unit.hex, hex)
    })
    if (notAdjacent.length > 0) {
      pushLog(
        'warning',
        `已选攻方中 ${notAdjacent.map(nameOf).join('、')} 与 ${hexLabel(hex)} 不相邻（9.0）`,
        '9.0',
      )
      return
    }
    if (combatAttackerIds.value.length === 0) {
      const auto = attackersForHex(units.value, hex, activeSide.value)
      if (auto.length === 0) {
        pushLog('warning', `没有与 ${hexLabel(hex)} 相邻的可攻击己方单位（9.0/9.1a）`, '9.1a')
        return
      }
      combatAttackerIds.value = auto.map((unit) => unit.instanceId)
    }
    battleTarget.value = { hex, defenderIds: enemyCombat.map((unit) => unit.instanceId) }
    combatState.value = null
    combatError.value = null
    combatInputs.value.defenderTerrain = defaultDefenseTerrain(hex)
    combatInputs.value.stackTerrain = {}
    combatInputs.value.retreatPaths = {}
    pushLog(
      'info',
      `选定防御格 ${hexLabel(hex)}（守方 ${enemyCombat.length} 个战斗单位）；攻方 ${combatAttackerIds.value.length} 个。点「开始战斗」进入 9.2 九步流程`,
      '9.1',
    )
  }

  /** C6 第 1 步：开始战斗（9.1 战斗构成） */
  function beginCombatNow(): boolean {
    if (!requireAction('combat.declare', '开始战斗')) return false
    const target = battleTarget.value
    if (target === null) {
      pushLog('warning', '尚未选定防御格（在「打一仗」工具下点敌方格）', '9.1')
      return false
    }
    if (phase.value !== 'combat' && phase.value !== 'exploitation') {
      const reason = `常规战斗只在战斗阶段与进击阶段的战斗环节进行（当前 ${PHASE_LABELS[phase.value]}，9.0）`
      combatError.value = { rule: '9.0', reason }
      pushLog('warning', reason, '9.0')
      return false
    }
    const attackers = combatAttackers.value
    if (attackers.length === 0) {
      pushLog('warning', '先点己方算子把它们加入攻方（9.1b）', '9.1b')
      return false
    }
    const defenders = battleDefenders.value
    if (defenders.length === 0) {
      pushLog('warning', '防御格内没有敌方战斗单位（9.0）', '9.0')
      battleTarget.value = null
      return false
    }
    // 9.0：攻击单位必须与被攻击的格相邻（引擎 9.1 构成不含此判据，故在此按规则拦下）
    const notAdjacent = attackers.filter((unit) => !areAdjacent(unit.hex, target.hex))
    if (notAdjacent.length > 0) {
      const reason = `攻击单位必须与被攻击的格相邻：${notAdjacent.map((unit) => unit.name).join('、')}`
      combatError.value = { rule: '9.0', reason }
      pushLog('warning', `${reason}（9.0）`, '9.0')
      return false
    }
    const composition = acceptCombat(
      beginCombat({
        attackers: attackers.map(toBattleUnitView),
        defenders: defenders.map(toBattleUnitView),
        facts: combatFacts.value,
        attackType: 'regular',
        phase: phase.value,
      }),
      '战斗构成',
    )
    if (composition === null) return false
    combatState.value = composition
    // 9.12f：此刻即「战斗开始时」⇒ 拍快照（撤退穿越只认它）
    captureCombatStartSnapshot()
    combatSurpriseDie.value = null
    combatAwaitingShiftDie.value = false
    const inputs = createCombatInputs()
    /*
     * B30：行动值单位**预填为双方 AR 最高者**（9.6 的选择仍是玩家的动作 —— 面板可改，
     * 只是不再逼玩家从零挑一个）。放在这里而不是 UI：它是"盘面事实"的推导，验证页同样受益。
     */
    inputs.attackerArUnitId = defaultArUnitIdOf('attacker')
    inputs.defenderArUnitId = defaultArUnitIdOf('defender')
    /*
     * 12.4 / 12.6：**战斗补给只能从己方补给站扣**（12.3a 直接拖取 / 12.3b HQ 投递）。
     * 除专规的补给储备标记（1.7 / 21.10：Shells 抵付炮击成本、Forage 在补给阶段提供追溯补给）外，
     * SP 不存在「凭空可用的池子」。故未声明来源时可用量为 **0**，由引擎按 12.4 裁决
     * （攻方付不出 ⇒ 不能攻击；守方付不出 ⇒ 以一半战斗值防御，9.5-B）。
     */
    inputs.attackerAvailableT = 0
    inputs.defenderAvailableT = 0
    inputs.defenderTerrain = defaultDefenseTerrain(target.hex)
    combatInputs.value = inputs
    pushLog(
      'info',
      `开始战斗（9.2 第 1 步）：攻方 ${attackers.length} 个 → 防御格 ${hexLabel(target.hex)}（守方 ${defenders.length} 个）。请确认战斗补给（9.5/12.4）`,
      '9.1',
    )
    // ⑭ 接线：战斗构成（9.1）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatDeclare',
      rule: '9.1',
      data: {
        attackType: 'regular',
        targetHex: { ...target.hex },
        attackerIds: attackers.map((unit) => unit.instanceId),
        defenderIds: defenders.map((unit) => unit.instanceId),
        step: composition.step,
      },
    })
    return true
  }

  /** C6 第 2 步：确认战斗补给（9.5/12.4；守方可拒付 ⇒ 以一半战斗值防御） */
  function confirmCombatSupply(): boolean {
    const state = combatState.value
    if (state === null) return false
    // 9.5b：付不出全额时可减少参战单位（界面通过勾选攻方实现）
    const reduced = combatAttackerIds.value.filter((id) =>
      state.composition.attackerIds.includes(id),
    )
    const useReduction = reduced.length > 0 && reduced.length < state.composition.attackerIds.length

    /*
     * 12.10：**先算"图上 + 可动用部队储备"能凑多少**，再把它喂给引擎。
     *
     * 次序很重要：引擎的 9.5/12.4 判据（`battleCombatSupply`）看到 `attackerAvailableT` 不足
     * 整笔就拒（12.4「无法满足完整战斗补给消耗要求的单位无法攻击」），所以"动用储备"这件事
     * **必须体现在喂进去的可用量里**——否则勾了也会被引擎先挡掉。
     *
     * 逐单位定"图上付 / 储备付"由引擎的 `planCombatSupplyFunding` 给结论（12.10a/b/c/g/h 都在
     * 那里，含规则书的两个例子）；本处只做两件事：① 把总额喂给引擎；② 引擎接受后按结论落盘。
     */
    const attackerPlan = combatInputs.value.attackerUsesInternalStocks
      ? planCombatSupplyFunding({
          units: combatAttackerViews.value.map((unit) => ({
            unitId: unit.id,
            requiredT: unit.steps,
            internalStocks: unit.internalStocks ?? null,
          })),
          availableMapT: combatInputs.value.attackerAvailableT,
        })
      : null
    if (attackerPlan !== null && !attackerPlan.ok) {
      pushLog(
        'danger',
        `攻方动用部队储备被拒：${attackerPlan.reason}（${attackerPlan.rule}）`,
        attackerPlan.rule,
      )
      return false
    }
    const attackerEffectiveT =
      attackerPlan === null
        ? combatInputs.value.attackerAvailableT
        : attackerPlan.data.funding.reduce((sum, item) => sum + item.t, 0)

    const defenderViews = combatDefenderViews.value
    const defenderPlan =
      combatInputs.value.defenderUsesInternalStocks && combatInputs.value.defenderProvides
        ? planCombatSupplyFunding({
            // 守方是一次性需求（12.4「每次战斗的消耗合计为 2T」）：记在首个守方单位名下
            units: defenderViews.slice(0, 1).map((unit) => ({
              unitId: unit.id,
              // 12.4：守方一次性需求 2T（≤1RE 取 1T）——走 M2④ 收敛后的唯一成本函数
              requiredT: computeCombatSupplyCost({
                attackerSteps: 0,
                defenderRE: defenderViews.reduce((sum, item) => sum + item.re, 0),
              }).defenderT,
              internalStocks: unit.internalStocks ?? null,
            })),
            availableMapT: combatInputs.value.defenderAvailableT,
          })
        : null
    if (defenderPlan !== null && !defenderPlan.ok) {
      pushLog(
        'danger',
        `守方动用部队储备被拒：${defenderPlan.reason}（${defenderPlan.rule}）`,
        defenderPlan.rule,
      )
      return false
    }
    const defenderEffectiveT =
      defenderPlan === null
        ? combatInputs.value.defenderAvailableT
        : defenderPlan.data.funding.reduce((sum, item) => sum + item.t, 0)

    const data = acceptCombat(
      planCombatSupply(state, {
        attackers: combatAttackerViews.value,
        defenders: combatDefenderViews.value,
        attackerAvailableT: attackerEffectiveT,
        defenderProvides: combatInputs.value.defenderProvides,
        defenderAvailableT: defenderEffectiveT,
        ...(useReduction ? { attackerUnitIds: reduced } : {}),
      }),
      '战斗补给',
    )
    if (data === null) return false
    combatState.value = data.state
    if (useReduction) combatAttackerIds.value = [...data.state.composition.attackerIds]
    const supply = data.state.supply!

    /*
     * 12.4 / 12.6：**攻守各自付款，且扣款只能落在己方补给站上**。
     *
     * 12.3a 直接拖取 / 12.3b HQ 投递是仅有的两条取补途径；除专规的补给储备标记
     * （1.7 / 21.10 的 Shells 与 Forage，各由引擎的专用动作处理）外，SP 不存在
     * 「凭空可用的池子」——共用演示池不得充作战斗补给的付款来源。
     *
     * 原先这里从 `fuelPool` 扣并带 `Math.max(0, …)` 夹断：声明了来源却不动它
     * （同一座站可反复"支付"），池子不够时又夹到 0（**攻击照样通过＝免费攻击**）。
     * 现在：**先全部校验、再一次性落盘**（避免只扣一半的半截状态），不足即整笔拒绝。
     */
    const needs = new Map<string, { dumpId: string; wantT: number }>()
    const addNeed = (dumpId: string | null, wantT: number): void => {
      if (wantT <= 0) return
      if (dumpId === null) throw new Error(`12.4：引擎判定需付 ${wantT} T，但该方未声明补给站来源`)
      needs.set(dumpId, { dumpId, wantT: (needs.get(dumpId)?.wantT ?? 0) + wantT })
    }

    /*
     * 12.10：**部队储备**补上图上的缺口（只有拿不到所需图上 SP 时才能用，12.10a）。
     *
     * 计划在上方**已经算过**（必须早于引擎调用，见那里的注释），这里只落盘：
     *   · 图上部分从**该方声明的补给站**扣（12.3）；无计划（未勾选）时按全额需求扣；
     *   · 用储备的单位按 12.10b **降一级**（ready→low→exhausted）；
     *   · 12.10h：凑不满任何单位的图上 T 会被一并消耗（引擎已计入 `mapTUsed`）。
     */
    addNeed(
      combatSupplyDumpIds.value.attacker,
      attackerPlan === null ? supply.attacker.requiredT : attackerPlan.data.mapTUsed,
    )
    addNeed(
      combatSupplyDumpIds.value.defender,
      defenderPlan === null
        ? supply.defender.paid
          ? supply.defender.requiredT
          : 0
        : defenderPlan.data.mapTUsed,
    )

    const settled: { dumpId: string; after: SpHoldings }[] = []
    for (const need of needs.values()) {
      const holdings = spDumps.value.find((item) => item.id === need.dumpId) ?? null
      if (holdings === null) {
        pushLog('danger', '战斗补给付款失败：声明的补给站已不存在（12.1b）', '12.4')
        return false
      }
      /*
       * 3.4b：错误集群的 SP 不能支付**多单位编队**的战斗成本。
       * 受益方＝攻方的付款看攻击堆叠、守方的付款看防御堆叠（哪一方付、就按哪一方的编队判）。
       */
      const payerIsAttacker = need.dumpId === combatSupplyDumpIds.value.attacker
      const beneficiaries = payerIsAttacker
        ? combatAttackers.value.map((unit) => unit.instanceId)
        : (battleTarget.value?.defenderIds ?? [])
      const restricted = panzerGroupSpGate({
        dumpId: need.dumpId,
        purpose: 'combat',
        beneficiaryUnitIds: beneficiaries,
      })
      if (restricted !== null) {
        pushLog(
          'danger',
          `战斗补给付款被拒（3.4b）：${panzerGroupSpRefusal(restricted, '战斗', need.dumpId)}——本次不改动任何账本`,
          '3.4b',
        )
        return false
      }
      const payment = planSpPayment({
        holdings: { sp: holdings.sp, t: holdings.t },
        wantT: need.wantT,
      })
      if (!payment.ok) {
        pushLog(
          'danger',
          `战斗补给付不出 ${need.wantT} T：${payment.reason}（${payment.rule}）——本次不改动任何账本`,
          payment.rule,
        )
        return false
      }
      settled.push({ dumpId: need.dumpId, after: payment.data.holdingsAfter })
    }
    for (const item of settled) setSpDumpHoldings(item.dumpId, item.after)

    // 12.10b：动用储备的单位降一级（ready→low、low→exhausted）——落盘在图上扣款之后
    for (const plan of [attackerPlan?.data ?? null, defenderPlan?.data ?? null]) {
      if (plan === null) continue
      for (const item of plan.funding) {
        if (item.source !== 'stocks' || item.to === null) continue
        const unit = units.value.find((entry) => entry.instanceId === item.unitId)
        if (unit === undefined) continue
        unit.internalStocks = item.to
      }
      pushLog('info', `12.10 部队储备：${plan.detail}`, plan.rule)
    }

    pushLog(
      'success',
      `战斗补给（9.5/12.4）：攻方付 ${supply.attacker.requiredT} T；守方` +
        (supply.defender.paid
          ? `付 ${supply.defender.requiredT} T`
          : '选择不付 ⇒ 以一半战斗值防御（9.5-B）'),
      '9.5',
    )
    // ⑭ 接线：战斗补给（9.5 / 12.4）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatSupply',
      rule: '9.5',
      data: {
        attackerRequiredT: supply.attacker.requiredT,
        defenderPaid: supply.defender.paid,
        defenderRequiredT: supply.defender.requiredT,
        attackerUnitIds: [...data.state.composition.attackerIds],
      },
    })
    /*
     * 9.1c 记账：走到这里＝战斗补给这一关过了 ⇒ 这一仗"打出去了"。
     * 之所以**不在宣布时**就记：9.5b 允许付不出时「减少参战单位 / 用部队储备 / **根本不攻击**」，
     * 那份作废的战斗不该占掉本环节的这一次（与 10.1b 的轰炸账本同一时点口径）。
     */
    recordAttackThisSegment(data.state.composition.attackerIds, data.state.composition.defendingHex)
    return true
  }

  /** C6 第 3 步：宣布行动值（9.6：攻方先、守方后；每方只能选一个参战单位） */
  function declareCombatArStep(side: CombatRole): boolean {
    const state = combatState.value
    if (state === null) return false
    const inputs = combatInputs.value
    if (inputs.attackerArUnitId === null) {
      pushLog('warning', '先选择攻方的行动值单位（9.6）', '9.6')
      return false
    }
    if (side === 'attacker') {
      const pending = acceptCombat(
        declareCombatAr(state, {
          attackers: combatAttackerViews.value,
          defenders: combatDefenderViews.value,
          attackerUnitId: inputs.attackerArUnitId,
        }),
        '攻方宣布行动值',
      )
      if (pending === null) return false
      pushLog(
        'info',
        `攻方宣布行动值单位：${nameOf(inputs.attackerArUnitId)}（9.6：按规则由守方后宣布）`,
        '9.6',
      )
      // ⑭ 接线：攻方宣布行动值（9.6，前半）入会话日志（本笔不掷骰）
      recordSettlement({
        action: 'combatAr',
        rule: '9.6',
        data: {
          side: 'attacker',
          attackerArUnitId: inputs.attackerArUnitId,
          step: pending.state.step,
        },
      })
      return true
    }
    if (inputs.defenderArUnitId === null) {
      pushLog('warning', '先选择守方的行动值单位（9.6）', '9.6')
      return false
    }
    // 专规 2.3b：守方堆叠内有 NKVD 边防团时，它**必须**担任行动值单位
    const nkvdCheck = checkDefenderArChoice(
      combatDefenderViews.value.map(toNkvdDefenseView),
      inputs.defenderArUnitId,
    )
    if (!nkvdCheck.ok) {
      combatError.value = { rule: nkvdCheck.rule, reason: nkvdCheck.reason }
      pushLog(
        'danger',
        `守方行动值单位被拒：${nkvdCheck.reason}（${nkvdCheck.rule}：NKVD 边防团被攻击时必须担任行动值单位）`,
        nkvdCheck.rule,
      )
      return false
    }
    if (nkvdCheck.data.forced) {
      pushLog(
        'warning',
        `${nameOf(inputs.defenderArUnitId)} 担任行动值单位（专规 2.3b：NKVD 边防团被攻击时必须担任）；代价是**所有防御选项都须当作损失吃下**`,
        '专规 2.3b',
      )
    }
    const data = acceptCombat(
      declareCombatAr(state, {
        attackers: combatAttackerViews.value,
        defenders: combatDefenderViews.value,
        attackerUnitId: inputs.attackerArUnitId,
        defenderUnitId: inputs.defenderArUnitId,
      }),
      '守方宣布行动值',
    )
    if (data === null) return false
    combatState.value = data.state
    const ar = data.state.ar!
    pushLog(
      'success',
      `行动值（9.6）：攻方 ${ar.attackerAr} − 守方 ${ar.defenderAr} ⇒ DRM ${ar.drm}`,
      '9.6',
    )
    // ⑭ 接线：双方行动值宣布（9.6）入会话日志（本笔不掷骰；NKVD 强制见专规 2.3b）
    recordSettlement({
      action: 'combatAr',
      rule: '9.6',
      data: {
        side: 'defender',
        attackerArUnitId: inputs.attackerArUnitId,
        defenderArUnitId: inputs.defenderArUnitId,
        attackerAr: ar.attackerAr,
        defenderAr: ar.defenderAr,
        drm: ar.drm,
        nkvdForced: nkvdCheck.data.forced,
      },
    })
    return true
  }

  /** C6 第 4 步：宣布地形并确定初始攻防比（9.4b 逐堆叠 / 9.4c 守方格 / 9.7） */
  /**
   * B30：**地形确认之后自动连跑到战果**（用户口径 #19）
   *
   * 「选中 AR 之后选地形也是玩家操作，但是**攻防比 / 奇袭 / 战斗骰**这三步是骰子和查表，做成自动的」
   * ⇒ 本函数依次调既有的**单一实现**（不另写一套规则）：
   *   `declareCombatTerrainStep`（含 9.7 的初始攻防比）→ `rollCombatSurprise`（9.8；出奇袭时自动补横移骰）
   *   → `rollCombatDice`（9.9），停在 **`losses`（战果）** 步等玩家分配与选项。
   *
   * 骰面一律走种子化 `rng`（B28 的口径），结算日志可复算；任何一步被拒即**就地停下并保留原因**
   * （`combatError` + 日志），不会把状态推成半截。
   */
  function autoResolveCombatToOutcome(): boolean {
    const state = combatState.value
    if (state === null) return false
    if (state.step === 'declareAr') return false
    if (state.step === 'declareTerrain' && !declareCombatTerrainStep()) return false
    // 9.8：奇袭（含"发生奇袭 ⇒ 再掷横移骰"的那一次补掷）
    if (combatState.value?.step === 'surprise') {
      if (!rollCombatSurprise()) return false
      if (combatAwaitingShiftDie.value && !rollCombatShiftDie()) return false
    }
    // 9.9：战斗骰
    if (combatState.value?.step === 'battleDice' && !rollCombatDice()) return false
    return true
  }

  function declareCombatTerrainStep(): boolean {
    const state = combatState.value
    if (state === null) return false
    const target = battleTarget.value
    if (target === null) return false
    const stackChoices: StackTerrainChoice[] = []
    for (const [key, choice] of Object.entries(combatInputs.value.stackTerrain)) {
      const [colText, rowText] = key.split('.')
      const col = Number(colText)
      const row = Number(rowText)
      if (!Number.isInteger(col) || !Number.isInteger(row)) continue
      stackChoices.push({ hex: { col, row }, kind: choice.kind, terrain: choice.terrain })
    }
    const data = acceptCombat(
      declareCombatTerrain(state, {
        attackers: combatAttackerViews.value,
        defenders: combatDefenderViews.value,
        facts: combatFacts.value,
        ...(stackChoices.length === 0 ? {} : { stackChoices }),
        defenderTerrain:
          combatInputs.value.defenderTerrain === ''
            ? defaultDefenseTerrain(target.hex)
            : combatInputs.value.defenderTerrain,
      }),
      '地形宣布',
    )
    if (data === null) return false
    combatState.value = data.state
    const odds = data.state.odds!
    pushLog(
      'success',
      `地形（9.4）：守方格 ${odds.terrain.defenderTerrain}（${odds.terrain.combatLine}）；` +
        `军力 ${odds.attackerTotal}（${odds.attackerStrengthById
          .map((item) => `${nameOf(item.unitId)} ${item.strength}`)
          .join('、')}）: ${odds.defenderTotal}（${odds.defenderStrengthById
          .map((item) => `${nameOf(item.unitId)} ${item.strength}`)
          .join('、')}）⇒ ${odds.oddsLabel}`,
      '9.4',
    )
    // ⑭ 接线：地形宣布与初始攻防比（9.4 / 9.7）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatTerrain',
      rule: '9.4',
      data: {
        defenderTerrain: odds.terrain.defenderTerrain,
        combatLine: odds.terrain.combatLine,
        attackerTotal: odds.attackerTotal,
        defenderTotal: odds.defenderTotal,
        oddsLabel: odds.oddsLabel,
      },
    })
    return true
  }

  /**
   * C6：把奇袭结论写进日志（9.8；附 W7 C11 的复核过程）
   *
   * ⑭ 接线：`rolls` 由调用方传入本步**真实掷出**的骰子（奇袭 2d6 或横移 1d6），
   * 避免用 `combatSurpriseRoll`/`combatShiftRoll` 这两个跨场残留的展示缓存拼骰面。
   */
  function logCombatSurprise(state: CombatInteractionState, rolls: readonly DiceRoll[]): void {
    const surprise = state.surprise
    if (surprise === undefined) return
    const derivation = surpriseDerivation({
      roll: combatSurpriseRoll.value,
      die: combatSurpriseDie.value ?? 0,
      arDifferential: state.ar?.drm ?? 0,
      defenderInHedgehog: state.defenderInHedgehog,
      side: surprise.side,
      shiftRoll: combatShiftRoll.value,
      shift: surprise.shift,
    })
    if (surprise.side === null) {
      pushLog(
        'info',
        `奇袭判定（9.8）：无奇袭；列位 ${surprise.finalColumnLabel}`,
        '9.8',
        derivation,
      )
      // ⑭ 接线：奇袭判定（9.8，无奇袭）入会话日志；rolls＝本步真实掷出的骰子
      recordSettlement({
        action: 'combatSurprise',
        rule: '9.8',
        rolls: [...rolls],
        data: {
          [DERIVATION_KEY]: derivation,
          side: null,
          finalColumnLabel: surprise.finalColumnLabel,
        },
      })
      return
    }
    pushLog(
      'success',
      `奇袭（9.8）：${roleLabel(surprise.side === 'attacker' ? 'attacker' : 'defender')}奇袭，` +
        `横移 ${surprise.shift >= 0 ? '+' : ''}${surprise.shift} 列 ⇒ ${surprise.finalColumnLabel}` +
        `${surprise.clamped ? '（超出表范围，按 9.1g 取端列）' : ''}`,
      '9.8',
      derivation,
    )
    // ⑭ 接线：奇袭判定（9.8，含横移）入会话日志；rolls＝本步真实掷出的骰子
    recordSettlement({
      action: 'combatSurprise',
      rule: '9.8',
      rolls: [...rolls],
      data: {
        [DERIVATION_KEY]: derivation,
        side: surprise.side,
        shift: surprise.shift,
        finalColumnLabel: surprise.finalColumnLabel,
        clamped: surprise.clamped,
      },
    })
  }

  /** C6 第 6 步：奇袭判定（9.8）；发生奇袭时须再掷 1 骰做横移 */
  function rollCombatSurprise(): boolean {
    const state = combatState.value
    if (state === null) return false
    if (combatAwaitingShiftDie.value) return rollCombatShiftDie()
    const draw = roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    combatSurpriseDie.value = draw.value.total
    combatSurpriseRoll.value = draw.value
    const data = acceptCombat(resolveSurprise(state, { die: draw.value.total }), '奇袭判定')
    if (data === null) return false
    if (data.awaitingShiftDie) {
      combatAwaitingShiftDie.value = true
      // 此处引擎尚未给出奇袭方（要等横移骰），故不附复核过程 —— 不臆造结论
      pushLog(
        'warning',
        `奇袭判定 2d6 = ${draw.value.faces.join('+')} = ${draw.value.total}（DRM ${state.ar?.drm ?? 0}）：发生奇袭，须再掷 1 骰做横移（9.8）`,
        '9.8',
      )
      // ⑭ 接线：本笔只掷了奇袭 2d6（横移骰在下一步）⇒ rolls 只报这一颗
      recordSettlement({
        action: 'combatSurprise',
        rule: '9.8',
        rolls: [draw.value],
        data: {
          die: draw.value.total,
          drm: state.ar?.drm ?? 0,
          awaitingShiftDie: true,
        },
      })
      return true
    }
    combatState.value = data.state
    combatAwaitingShiftDie.value = false
    logCombatSurprise(data.state, [draw.value])
    return true
  }

  /** C6 第 6 步（续）：横移骰（9.8） */
  function rollCombatShiftDie(): boolean {
    const state = combatState.value
    const die = combatSurpriseDie.value
    if (state === null || die === null) return false
    const draw = roll1d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    combatShiftRoll.value = draw.value
    const data = acceptCombat(
      resolveSurprise(state, { die, shiftDie: draw.value.total }),
      '奇袭横移',
    )
    if (data === null) return false
    combatState.value = data.state
    combatAwaitingShiftDie.value = false
    pushLog('info', `横移骰 = ${draw.value.total}（9.8）`, '9.8')
    logCombatSurprise(data.state, [draw.value])
    return true
  }

  /** C6 第 7 步：战斗掷骰（9.9：2d6 + AR 差 − 环形工事完整等级） */
  function rollCombatDice(): boolean {
    const state = combatState.value
    if (state === null) return false
    const draw = roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    combatDiceRoll.value = draw.value
    const data = acceptCombat(resolveCombatDice(state, { die: draw.value.total }), '战斗掷骰')
    if (data === null) return false
    combatState.value = data.state
    // 9.12a：战斗表 DG ⇒ 全部防御单位立即 DG（必须在撤退之前落盘，9.12e 要用这一事实）
    applyCombatPatches(data.patches)
    const dice = data.state.dice!
    const ar = data.state.ar
    // W7 C11：附着本次战斗的复核过程（骰点 / 修正项与来源 / 合计 / 取列查表 / 结果）
    const derivation = combatDerivation({
      roll: draw.value,
      die: dice.die,
      attackerAr: ar?.attackerAr ?? 0,
      attackerArSource: ar === undefined ? '未指定' : `攻方 AR 单位 ${nameOf(ar.attackerUnitId)}`,
      defenderAr: ar?.defenderAr ?? 0,
      defenderArSource: ar === undefined ? '未指定' : `守方 AR 单位 ${nameOf(ar.defenderUnitId)}`,
      hedgehogLevel: state.hedgehogLevel,
      modifiedDice: dice.modifiedDice,
      raw: dice.result.raw,
      terrainLine: dice.result.terrainLine,
      columnLabel: data.state.surprise?.finalColumnLabel ?? data.state.odds?.columnLabel ?? '',
      ...(data.state.odds === undefined ? {} : { oddsLabel: data.state.odds.oddsLabel }),
      ...(data.state.odds === undefined
        ? {}
        : { terrain: data.state.odds.terrain.defenderTerrain }),
    })
    pushLog(
      'success',
      `战斗掷骰（9.9）：2d6 = ${draw.value.faces.join('+')} = ${draw.value.total}；` +
        `修正骰 ${dice.modifiedDice}（AR ${state.ar?.attackerAr ?? 0}−${state.ar?.defenderAr ?? 0}，工事 −${state.hedgehogLevel}）⇒ CRT「${dice.result.raw}」`,
      '9.9',
      derivation,
    )
    // ⑭ 接线：战斗掷骰（9.9）入会话日志；rolls＝本次 2d6，data 附逐项复核过程；
    // 9.10 的选项仍未结清 ⇒ 挂 pending（按 CRT 给出的选项点数分别给攻守双方）
    const pending: PendingEffect[] = []
    if (optionsOf(dice.result, 'attacker') > 0)
      pending.push({
        kind: 'option',
        unitIds: [...data.state.composition.attackerIds],
        rule: '9.10',
      })
    if (optionsOf(dice.result, 'defender') > 0)
      pending.push({
        kind: 'option',
        unitIds: [...data.state.composition.defenderIds],
        rule: '9.10',
      })
    recordSettlement({
      action: 'combatDice',
      rule: '9.9',
      rolls: [draw.value],
      pending,
      data: {
        [DERIVATION_KEY]: derivation,
        modifiedDice: dice.modifiedDice,
        raw: dice.result.raw,
      },
    })
    return true
  }

  /** C6 第 8 步（a）：强制军力损失（9.11c：AR 单位先受第一点；每人各受一点后才有人受第二点） */
  function confirmCombatLosses(): boolean {
    const state = combatState.value
    if (state === null) return false
    const side = currentResolver(state)
    const allocation = combatLossAllocationNow()
    const data = acceptCombat(
      planLosses(state, {
        units: [...combatAttackerViews.value, ...combatDefenderViews.value],
        // 9.11a：玩家把"多受的那一点"改派给别人时，把这份分配交给引擎校验（它判 9.11c 的两条约束）
        ...(allocation === undefined ? {} : { allocation }),
      }),
      '强制损失结算',
    )
    if (data === null) return false
    combatState.value = data.state
    const record = data.state.resolution[side]
    const detail = (record.forcedLosses ?? [])
      .map((item) => `${nameOf(item.unitId)} −${item.steps}`)
      .join('、')
    applyCombatPatches(data.patches)
    pushLog(
      data.rule === '9.10c' ? 'warning' : 'success',
      `${roleLabel(side)}强制损失（9.11c）：${detail === '' ? '无' : detail}` +
        `${(record.ignoredLosses ?? 0) > 0 ? `；超出承受范围的 ${record.ignoredLosses} 点忽略（9.11b）` : ''}` +
        /*
         * 9.10c 例 B：攻方在承受选项前被摧毁 ⇒ 防御者可忽略其选项 ⇒ 攻方选项页**不再出现**
         * （修前会停在一个填不动的选项页上，只能靠"死人撤退"凑过 9.10a）。
         */
        (record.optionsSkipped === 'attackerWipedOut'
          ? '；攻方已全灭 ⇒ **跳过攻方的选项**（9.10c 例 B：防御者可以忽略），直接进守方结算'
          : ''),
      data.rule === '9.10c' ? '9.10c' : '9.11c',
    )
    // ⑭ 接线：强制军力损失（9.11c）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatLosses',
      rule: data.rule === '9.10c' ? '9.10c' : '9.11c',
      data: {
        side,
        forcedLosses: (record.forcedLosses ?? []).map((item) => ({
          unitId: item.unitId,
          steps: item.steps,
        })),
        ignoredLosses: record.ignoredLosses ?? 0,
        optionsSkipped: record.optionsSkipped ?? null,
      },
    })
    return true
  }

  /** C6 第 8 步（b）：选项结算（9.10a 撤退格数与损失军力任意组合；9.10c 守方可忽略） */
  /**
   * 9.10/9.11a（第五批 A3）：**当前结算方**的参战单位（选项损失的分配候选；面板逐单位输入用）。
   * 名字在这里拼好 ⇒ 面板不自己查单位（与「面板不数数」同一纪律）。
   */
  const combatOptionLossTargets = computed<(BattleUnitView & { name: string })[]>(() => {
    const state = combatState.value
    if (state === null || state.step !== 'options') return []
    const views =
      state.resolution.stage === 'defenderOptions'
        ? combatDefenderViews.value
        : combatAttackerViews.value
    return views.map((view) => ({
      ...view,
      name: units.value.find((unit) => unit.instanceId === view.id)?.name ?? view.id,
    }))
  })

  function confirmCombatOptions(): boolean {
    const state = combatState.value
    if (state === null) return false
    const side = currentResolver(state)
    const inputs = combatInputs.value
    // 专规 2.3b：NKVD 边防团担任守方行动值单位时，守方全部选项**必须**吃成军力损失
    const nkvdOverride =
      side === 'defender' && state.dice !== undefined
        ? nkvdDefenderOptionOverride({
            defenderArUnitId: state.ar?.defenderUnitId ?? '',
            defenders: combatDefenderViews.value.map(toNkvdDefenseView),
            optionPoints: optionsOf(state.dice.result, 'defender'),
          })
        : null
    if (nkvdOverride !== null && inputs.ignoreOptions) {
      combatError.value = {
        rule: '专规 2.3b',
        reason: 'nkvdArUnitForbidsIgnoringOptions',
      }
      pushLog(
        'danger',
        'NKVD 边防团担任行动值单位时，守方不得行使 9.10c 的「忽略选项」权利（专规 2.3b：包括本可因攻方撤退而抵消的选项）',
        '专规 2.3b',
      )
      return false
    }
    const data = acceptCombat(
      planOptions(state, {
        units: side === 'attacker' ? combatAttackerViews.value : combatDefenderViews.value,
        retreatHexes: nkvdOverride === null ? inputs.optionRetreatHexes : nkvdOverride.retreatHexes,
        lossPoints: nkvdOverride === null ? inputs.optionLossPoints : nkvdOverride.lossPoints,
        // 9.11a/9.11c（第五批 A3）：玩家给了逐单位分配才上交 ⇒ 引擎严格校验；
        // 全 0（缺省）时不传 ⇒ 引擎按规范分配（AR 优先＋均匀展开），NKVD 覆盖路径同样适用
        ...(Object.values(inputs.optionLossAllocation).some((steps) => steps > 0)
          ? {
              lossAllocation: Object.entries(inputs.optionLossAllocation)
                .filter(([, steps]) => steps > 0)
                .map(([unitId, steps]) => ({ unitId, steps })),
            }
          : {}),
        ...(side === 'defender' && inputs.ignoreOptions ? { ignore: true } : {}),
      }),
      '选项结算',
    )
    if (data === null) return false
    combatState.value = data.state
    applyCombatPatches(data.patches)
    if (nkvdOverride !== null) pushLog('warning', nkvdOverride.detail, '专规 2.3b')
    if (data.rule === '9.10c') {
      pushLog('info', '守方行使 9.10c：忽略自己的选项', '9.10c')
    } else {
      const taken = data.state.resolution[side].option
      pushLog(
        'success',
        `${roleLabel(side)}选项（${data.rule}）：共 ${taken?.points ?? 0} 点 = 撤退 ${taken?.retreatHexes ?? 0} 格 + 损失 ${taken?.lossPoints ?? 0} 军力`,
        data.rule,
      )
    }
    // ⑭ 接线：选项结算（9.10 / 9.10c；NKVD 强制吃损失见专规 2.3b）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatOptions',
      rule: data.rule,
      data: {
        side,
        ignored: data.rule === '9.10c',
        nkvdForced: nkvdOverride !== null,
        points: data.state.resolution[side].option?.points ?? 0,
        retreatHexes: data.state.resolution[side].option?.retreatHexes ?? 0,
        lossPoints: data.state.resolution[side].option?.lossPoints ?? 0,
      },
    })
    // 复位选项输入，供另一方使用
    combatInputs.value.optionRetreatHexes = 0
    combatInputs.value.optionLossPoints = 0
    combatInputs.value.optionLossAllocation = {}
    combatInputs.value.ignoreOptions = false
    resetOptionDraft()
    return true
  }

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * 条 15/16（批 F·F1）：选项战果页「草稿账本」＋「受损 / 撤退（1 格）」双按钮
   *
   * 用户口径：选项点数的消耗改成**逐次点选**（点单位图即受损、点可撤退格即撤退），
   * 每次应用只进**草稿账本**（不落盘）；最后按「提交」才一次性交给引擎
   * （`planOptions` 仍是一发结算，引擎不改）。
   *
   * 草稿直接寄居在 `combatInputs.option*` 三个字段上（提交路径完全复用旧链路），
   * 另配 `optionDraftLog` 记流水供「撤销上一次」。
   * ───────────────────────────────────────────────────────────────────────────
   */

  /** 草稿应用模式：idle＝待选 / loss＝点单位图受损 / retreat＝点可撤退格撤退 */
  const optionDraftMode = ref<'idle' | 'loss' | 'retreat'>('idle')
  /** 草稿流水（逐次应用；撤销按此回退） */
  const optionDraftLog = ref<{ kind: 'loss' | 'retreat'; unitId?: string; amount: number }[]>([])

  /** 当前结算方的可用选项点数（9.10a） */
  const optionDraftPoints = computed(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined || state.step !== 'options') return 0
    return optionsOf(state.dice.result, currentResolver(state))
  })

  /** 草稿已用点数 */
  const optionDraftUsed = computed(
    () => combatInputs.value.optionLossPoints + combatInputs.value.optionRetreatHexes,
  )

  /** 草稿剩余点数（9.10a：总数必须完全满足 ⇒ 提交时须为 0） */
  const optionDraftRemaining = computed(() =>
    Math.max(0, optionDraftPoints.value - optionDraftUsed.value),
  )

  /** 草稿流水（面板展示用；最新在末尾） */
  const optionDraftEntries = computed(() =>
    optionDraftLog.value.map((entry, index) => ({
      index,
      kind: entry.kind,
      unitId: entry.unitId ?? null,
      amount: entry.amount,
      label:
        entry.kind === 'loss'
          ? `${nameOf(entry.unitId ?? '')} 受损 ${entry.amount} 军力`
          : `撤退 ${entry.amount} 格`,
    })),
  )

  /** 切换应用模式（再点一次同一模式＝收起） */
  function setOptionDraftMode(mode: 'idle' | 'loss' | 'retreat'): void {
    optionDraftMode.value = optionDraftMode.value === mode ? 'idle' : mode
  }

  /** 草稿层容量护栏：该单位当前军力（9.11d 的承受上限由提交时引擎严格校验） */
  function optionLossRoomOf(unitId: string): number {
    const target = combatOptionLossTargets.value.find((item) => item.id === unitId)
    return target === undefined ? 0 : Math.max(0, target.steps)
  }

  /**
   * 「受损」：给某参战单位记 1 点军力损失（草稿；9.11a 的逐单位分配）
   *
   * 约束（草稿层只做护栏，严格校验仍归提交时的 `validateBattleLossAllocation`）：
   * ① 剩余选项点数 > 0；② 该单位还有军力可损。
   */
  function applyOptionDraftLoss(unitId: string): boolean {
    const state = combatState.value
    if (state === null || state.step !== 'options') return false
    if (optionDraftRemaining.value <= 0) return false
    if (optionLossRoomOf(unitId) - (combatInputs.value.optionLossAllocation[unitId] ?? 0) <= 0) {
      return false
    }
    combatInputs.value.optionLossAllocation = {
      ...combatInputs.value.optionLossAllocation,
      [unitId]: (combatInputs.value.optionLossAllocation[unitId] ?? 0) + 1,
    }
    combatInputs.value.optionLossPoints += 1
    optionDraftLog.value = [...optionDraftLog.value, { kind: 'loss', unitId, amount: 1 }]
    return true
  }

  /** 「撤退（1 格）」：记 distance 格撤退（草稿；点数不够时按剩余截断） */
  function applyOptionDraftRetreat(distance = 1): boolean {
    const state = combatState.value
    if (state === null || state.step !== 'options') return false
    const room = optionDraftRemaining.value
    if (room <= 0) return false
    const applied = Math.min(Math.max(1, Math.round(distance)), room)
    combatInputs.value.optionRetreatHexes += applied
    optionDraftLog.value = [...optionDraftLog.value, { kind: 'retreat', amount: applied }]
    return true
  }

  /** 点地图上的高亮撤退格 ⇒ 按该格距起点的直线距离记撤退（点数不够截断） */
  function applyOptionDraftRetreatAt(hex: HexRef): boolean {
    const preview = optionDraftRetreatPreview.value
    if (preview === null) return false
    const distance = preview.distanceOf[`${hex.col},${hex.row}`]
    if (distance === undefined) return false
    return applyOptionDraftRetreat(distance)
  }

  /** 撤销上一次草稿应用（流水末条按 amount 精确回退） */
  function undoOptionDraftLast(): boolean {
    const last = optionDraftLog.value[optionDraftLog.value.length - 1]
    if (last === undefined) return false
    optionDraftLog.value = optionDraftLog.value.slice(0, -1)
    if (last.kind === 'loss' && last.unitId !== undefined) {
      const next = (combatInputs.value.optionLossAllocation[last.unitId] ?? 0) - last.amount
      const allocation = { ...combatInputs.value.optionLossAllocation }
      if (next <= 0) delete allocation[last.unitId]
      else allocation[last.unitId] = next
      combatInputs.value.optionLossAllocation = allocation
      combatInputs.value.optionLossPoints = Math.max(
        0,
        combatInputs.value.optionLossPoints - last.amount,
      )
    } else {
      combatInputs.value.optionRetreatHexes = Math.max(
        0,
        combatInputs.value.optionRetreatHexes - last.amount,
      )
    }
    return true
  }

  /** 收起草稿（提交后 / 离开选项步 / 清理战斗时调用） */
  function resetOptionDraft(): void {
    optionDraftMode.value = 'idle'
    optionDraftLog.value = []
  }

  /**
   * 条 15/16（批 F·F1）：「撤退」草稿模式下，地图上铺「本堆叠可撤退格」预览。
   *
   * 取当前结算方各参战单位在 **1..剩余点数** 各距离上撤退落点（`planRetreatDestinations`，
   * 9.12）的并集；每格记**最小直线距离** ⇒ 玩家点格即按该距离消耗点数。
   * 分类沿用撤退步的三色（安全 / 敌方 ZOC / 必被消灭 9.12b）。
   */
  const optionDraftRetreatPreview = computed<{
    safe: HexRef[]
    zoc: HexRef[]
    doomed: HexRef[]
    distanceOf: Record<string, number>
  } | null>(() => {
    const state = combatState.value
    if (state === null || state.step !== 'options' || optionDraftMode.value !== 'retreat') {
      return null
    }
    const side = currentResolver(state)
    const views = side === 'attacker' ? combatAttackerViews.value : combatDefenderViews.value
    const maxDistance = Math.max(1, optionDraftRemaining.value)
    const byKey = new Map<
      string,
      { hex: HexRef; distance: number; kind: 'safe' | 'zoc' | 'doomed' }
    >()
    const keyOf = (hex: HexRef) => `${hex.col},${hex.row}`
    for (const view of views) {
      for (let distance = 1; distance <= maxDistance; distance += 1) {
        for (const destination of planRetreatDestinations({
          from: view.hex,
          distance,
          mobility: view.mobility,
          side: view.side,
          facts: combatRetreatFacts.value,
          immobile: combatRetreatFacts.value.immobile(view.id),
        })) {
          const key = keyOf(destination.hex)
          const kind = destination.forcedDestruction
            ? 'doomed'
            : destination.inEnemyZoc
              ? 'zoc'
              : 'safe'
          const prev = byKey.get(key)
          if (prev === undefined || distance < prev.distance) {
            byKey.set(key, { hex: { ...destination.hex }, distance, kind })
          } else if (distance === prev.distance && kind === 'doomed' && prev.kind !== 'doomed') {
            byKey.set(key, { ...prev, kind })
          }
        }
      }
    }
    const safe: HexRef[] = []
    const zoc: HexRef[] = []
    const doomed: HexRef[] = []
    const distanceOf: Record<string, number> = {}
    for (const item of byKey.values()) {
      if (item.kind === 'doomed') doomed.push(item.hex)
      else if (item.kind === 'zoc') zoc.push(item.hex)
      else safe.push(item.hex)
      distanceOf[keyOf(item.hex)] = item.distance
    }
    return { safe, zoc, doomed, distanceOf }
  })

  /**
   * 9.10c 例 B / 条 16（批 F·F1）：攻方参战单位是否已全灭。
   *
   * 此时守方选项页给「不选 / 结束战斗」一键：无人需撤、无人可推 ⇒ 一键收尾。
   */
  const attackerWipedNow = computed(() => {
    const state = combatState.value
    if (state === null || state.resolution.stage !== 'defenderOptions') return false
    return combatAttackerViews.value.every((view) => view.steps <= 0)
  })

  /**
   * 条 16（批 F·F1）：「结束战斗」一键（仅攻方全灭的守方选项页可用）。
   *
   * 走既有链路：9.10c 忽略守方选项 → 无人需撤 → 无可推进单位 ⇒ 战斗自动收束
   * （`confirmCombatRetreats` 尾部对「一个可推进单位都没有」直接收整场）。
   */
  function concludeCombatAfterWipe(): boolean {
    const state = combatState.value
    if (state === null || !attackerWipedNow.value) return false
    combatInputs.value.ignoreOptions = true
    if (!confirmCombatOptions()) return false
    if (combatState.value?.step === 'retreat' && !confirmCombatRetreats()) return false
    // 「一个可推进单位都没有」时 confirmCombatRetreats 已自行收束（finished=true）⇒ 不重复推进
    if (
      combatState.value !== null &&
      combatState.value.finished !== true &&
      combatState.value.step === 'advance'
    ) {
      if (!confirmCombatAdvance()) return false
    }
    return combatState.value?.finished === true
  }
  /** C6 第 9 步：撤退（9.12：撤退格数＝剩余选项数；落点须满足完整撤退距离） */
  function confirmCombatRetreats(): boolean {
    const state = combatState.value
    if (state === null) return false
    const paths = Object.entries(combatInputs.value.retreatPaths)
      .map(([unitId, text]) => ({ unitId, path: parseHexPath(text) }))
      .filter((item) => item.path.length > 0)
    const data = acceptCombat(
      resolveRetreats(state, {
        // 9.12d：跟随者不是参战者，故这里给**全部盘面单位**（引擎只认构成里的参战者，
        // 但仍然需要能在名单里找到跟随者）
        units: units.value.map(toBattleUnitView),
        paths,
        facts: combatRetreatFacts.value,
        // 9.12d：加入撤退的跟随者（未参战战斗单位 / 编内卡车）
        ...(combatTagalongIds.value.length === 0 ? {} : { tagalongIds: combatTagalongIds.value }),
      }),
      '撤退',
    )
    if (data === null) return false
    combatState.value = data.state
    applyCombatPatches(data.patches)
    for (const result of data.results) {
      pushLog(
        result.destroyed ? 'danger' : 'info',
        result.destroyed
          ? `${nameOf(result.unitId)} 撤退时穿过敌方单位或禁入地形，被消灭（9.12）`
          : `${nameOf(result.unitId)} 撤退至 ${result.hex === null ? '—' : hexLabel(result.hex)}` +
              `${result.gainsDg ? '，并 DG（9.12a/9.12e）' : ''}` +
              `${result.fullRetreatDistanceMet ? '' : '（完整撤退距离不满足）'}`,
        '9.12',
      )
    }
    // 9.12d：跟随者随堆叠一起落地（本函数不另记，engine 的 results 已含它们）
    if (combatTagalongIds.value.length > 0) {
      pushLog(
        'info',
        `9.12d 跟随撤退：${combatTagalongIds.value.map(nameOf).join('、')} 随其所在堆叠一起撤退`,
        '9.12d',
      )
    }
    // 9.12e：撤退堆叠在进入敌方 ZOC 前已有 DG 单位 ⇒ 该堆叠损失 1 点，由拥有者从候选 DG 单位中选
    const extra = data.extraLoss
    if (extra.points > 0) {
      const chosen = combatInputs.value.extraLossTakerId
      const taker =
        chosen !== null && extra.eligibleUnitIds.includes(chosen)
          ? chosen
          : extra.eligibleUnitIds[0]
      if (taker !== undefined) {
        takeCombatLoss(taker, extra.points)
        pushLog(
          'warning',
          `9.12e：撤退堆叠进入敌方 ZOC 前已有 DG 单位 ⇒ 该堆叠损失 ${extra.points} 点军力（由 ${nameOf(taker)} 承受）`,
          '9.12e',
        )
      }
    }
    // ⑭ 接线：撤退结算（9.12）入会话日志（本笔不掷骰）；防御格若已清空 ⇒ 9.12g 推进仍待决
    recordSettlement({
      action: 'combatRetreat',
      rule: '9.12',
      pending: combatDefendingHexCleared.value
        ? [
            {
              kind: 'advanceAfterCombat',
              unitIds: [...state.composition.attackerIds],
              rule: '9.12g',
            },
          ]
        : [],
      data: {
        results: data.results.map((result) => ({
          unitId: result.unitId,
          hex: result.hex === null ? null : { ...result.hex },
          destroyed: result.destroyed,
          gainsDg: result.gainsDg,
          fullRetreatDistanceMet: result.fullRetreatDistanceMet,
        })),
        tagalongIds: [...combatTagalongIds.value],
        extraLossPoints: extra.points,
      },
    })
    /*
     * 9.12g-D：「常规战斗后并非必须如此，由拥有者玩家选择哪些攻击单位进行推进（**如果有的话**）。」
     * ⇒ **一个可推进的单位都没有**时，这一页没有任何可选项（只能"不推进"）⇒ 直接收束整场战斗：
     *   攻方被全灭后的收尾正走这条（用户 2026-09-18 报的第 2 条：没有继续挺进流程的意义）。
     */
    if (combatAdvanceCandidates.value.length === 0) {
      pushLog(
        'info',
        '9.12g：「如果有的话」——没有可推进的攻方单位 ⇒ 本次战斗直接结束（不再走推进步）',
        '9.12g',
      )
      return confirmCombatAdvance()
    }
    return true
  }

  /** C6 第 9 步：战后推进与进击标记（9.12g / 9.13） */
  function confirmCombatAdvance(): boolean {
    const state = combatState.value
    if (state === null) return false
    const arUnit = units.value.find((unit) => unit.instanceId === state.ar?.attackerUnitId)
    const candidates = combatAdvanceCandidates.value.map((item) => ({
      id: item.id,
      paidCombatSupply: item.paid,
      // 9.12b：任何模式下都不可移动者不得战后推进
      immobile: item.immobile,
    }))
    const chosen = combatInputs.value.advanceUnitIds
    const data = acceptCombat(
      resolveAdvance(state, {
        defendingHexCleared: combatDefendingHexCleared.value,
        candidates,
        ...(chosen.length === 0 ? {} : { chosenUnitIds: chosen }),
        // 专规 1.1b：防御格若是敌方安全边缘格（补给源边格）⇒ 不得推进进去
        advanceIntoForbiddenHex: isEnemySafeEdgeHex(
          moveContext.value,
          battleTarget.value?.hex ?? { col: 0, row: 0 },
          activeSide.value,
        ),
        // 9.13b-A：攻方 AR 单位处于 DG ⇒ 不给进击标记
        attackerArDg: arUnit?.mode.dg === true,
        /*
         * 9.13：进击标记是**逐单位**的（图表第 2 页 `e# Attackers with action ratings of # or more
         *   are exploitation marked`；9.13b-A 又规定"非 DG 的攻击单位可正常结算"）⇒ 把参战攻方
         *   各自的 AR / DG 一并交给引擎，由它按单位发补丁。此前引擎只能看"宣布的 AR 单位"一个，
         *   于是 AR 5 与 AR 4 一起攻击时**只有 1 个单位**被标记。
         */
        attackerUnits: combatAttackers.value.map((unit) => ({
          unitId: unit.instanceId,
          ar: unit.raw.ar,
          dg: unit.mode.dg,
        })),
      }),
      '战后推进',
    )
    if (data === null) {
      // W7 C16：推进被拒（例如 9.12g-B「攻方在选项中撤退」）时，**突袭的 3 MP 与 8.0 后果仍须记账** ——
      // 否则突袭会卡在托管态、MP 永不扣除，也无法继续移动（8.1a/8.1f）。
      if (overrunContext.value !== null) settleOverrunMove(combatDefendingHexCleared.value)
      return false
    }
    combatState.value = data.state
    applyCombatPatches(data.patches)
    // 9.12g-C：推进进入防御格后，立即按 9.14 处置该格（夺取环形工事 9.14e / 空军基地 9.14f /
    //   补给站 9.14b / 运输点与延补队 9.14c-d；位移落点由玩家在地图上选）
    const entered = battleTarget.value?.hex ?? null
    if (entered !== null && data.advanceUnitIds.length > 0) {
      resolveSpecialCombatAt(entered, activeSide.value, true)
    }
    pushLog(
      'success',
      `战后推进（9.12g）：${data.advanceUnitIds.length === 0 ? '不推进' : data.advanceUnitIds.map(nameOf).join('、')}` +
        `${data.state.advance?.mandatory === true ? '（突袭后必须推进）' : ''}；` +
        `进击标记（9.13）：${data.exploit.granted ? '授予 AR 单位' : `不授予（${data.exploit.reason}）`}`,
      '9.12g',
    )
    // ⑭ 接线：战后推进与进击标记（9.12g / 9.13）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatAdvance',
      rule: '9.12g',
      data: {
        advanceUnitIds: [...data.advanceUnitIds],
        mandatory: data.state.advance?.mandatory === true,
        exploitGranted: data.exploit.granted,
        exploitReason: data.exploit.reason,
      },
    })
    // W7 C16：若本场是**突袭**（8.0），推进步就是它的收束点 ⇒ 把 3 MP 与进格记回移动交互
    if (overrunContext.value !== null) {
      // 「防御方是否离开该格」取事实（推进步落盘后重算，8.0 的进入判据就是它）
      settleOverrunMove(combatDefendingHexCleared.value)
    }
    return true
  }

  /** C6：放弃本场战斗（中止 9.2 流程；已落盘的结果不自动回滚） */
  function cancelCombat(): void {
    // W7 C16：放弃突袭只丢托管信息（3 MP 尚未记账，故无需回滚）
    if (overrunContext.value !== null) {
      cancelOverrunContext()
      pushLog('info', '放弃本场突袭：未记账 ⇒ 不消耗 MP（8.1a）', '8.1a')
    }
    clearCombat()
    pushLog('info', '放弃本场战斗（9.2 流程中止）', '9.2')
  }

  /* ──────────────── C7 轰炸交互：选子 → 10.0 通用流程动作（全部问引擎） ──────────────── */

  /** C7：开/关轰炸工具（开启时清空上一场） */
  function setBarrageActive(on: boolean): void {
    barrageActive.value = on
    clearBarrage()
    pushLog('info', on ? '轰炸工具已开启（10.0 通用流程）' : '轰炸工具已关闭', '10.0')
  }

  /**
   * C7：清空本场轰炸的全部交互状态（换方/换阶段/重置/关闭时调用；不卸载已摆放的飞机）
   *
   * ★ 注意：**不清 10.0e-A/B 的账本**（`barragedHexesThisPhase` / `barragedUnitIdsThisPhase`）。
   *   它记的是"这一格/这一单位**本阶段**已轰炸过"，属阶段级事实；清它的是 `setPhase`/`setTurn`/复位。
   *   混在一起会让"关掉轰炸工具再打开"就能绕过每阶段一次的限制。
   */
  function clearBarrage(): void {
    barrageUnitIds.value = []
    barrageAirIds.value = []
    barrageState.value = null
    barrageError.value = null
    barrageAwaitingHalfDie.value = false
    barrageInputs.value = createBarrageInputs()
    /*
     * ★ 第六批条 23-②：修前**不清** `barrageKind` / `barrageTargetKind` ⇒
     *   一场低空扫射（kind 会带成 `'air'`，hipShoot 为 true）结束后，这两个选择器仍停在
     *   上一次的取值上；换段后炮兵候选/目标表按**残留的** `'air'` 去列，界面与引擎口径分叉。
     *   10.0e-F 与 10.0d 都是「一次轰炸内」的声明 ⇒ 一场结束（或换段）即应回到默认值。
     */
    barrageKind.value = 'artillery'
    barrageTargetKind.value = 'combatUnits'
  }

  /** C7：统一收引擎结论（失败即记 `barrageError` 与日志并返回 null） */
  function acceptBarrage<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      barrageError.value = null
      return outcome.data
    }
    barrageError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /** C7：把引擎给出的轰炸变更落盘（DG 与军力损失；军力归零者移入死亡堆） */
  function applyBarragePatches(patches: readonly BarrageUnitPatch[]): void {
    const eliminated: ConsoleUnit[] = []
    for (const patch of patches) {
      const unit = units.value.find((item) => item.instanceId === patch.unitId)
      if (unit === undefined) continue
      if (patch.steps !== undefined) {
        unit.steps = patch.steps
        if (patch.steps <= 0) eliminated.push(unit)
      }
      if (patch.dg === true) applyDgToUnit(unit)
    }
    for (const unit of eliminated)
      eliminateEntry(unit, '10.0a', `${unit.name} 军力归零，移入死亡堆（10.0a）`)
  }

  /** C7：选/取消一个参炸单位（10.0e-F 的同类型限制由引擎裁决；此处只收集选择） */
  function toggleBarrageUnit(unitId: string): void {
    if (barrageUnitIds.value.includes(unitId)) {
      barrageUnitIds.value = barrageUnitIds.value.filter((id) => id !== unitId)
    } else {
      barrageUnitIds.value = [...barrageUnitIds.value, unitId]
    }
    // 选择变化即作废进行中的流程（与 C6 换选同规）
    barrageState.value = null
    barrageError.value = null
  }

  /* ── C7 空军：摆放与参炸勾选（14.1a / 10.2b） ── */

  /**
   * C7：摆放一架飞机到指定**基地格**（14.1a）
   *
   * 「飞机的模式表示方式是，将激活的飞机算子放在**空军基地算子**的上方，或将非激活的放在下方」
   * ⇒ 飞机在图上就位于其空军基地格，该格即 10.2b 判定用的「它们基地」。
   */
  function addAirUnit(aircraftId: string | null, hexText: string): boolean {
    const record = airUnitChoices.value.find((item) => item.aircraftId === aircraftId)
    if (record === undefined) {
      pushLog('warning', '请先选择机型（A5 空军专表）', '14.1')
      return false
    }
    const hex = parseHexPath(hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `基地格格式应为「列.行」（如 36.13），收到「${hexText}」`, '14.1a')
      return false
    }
    const unit = toConsoleAirUnit({
      aircraft: record,
      instanceId: createId('air'),
      hex,
      side: activeSide.value,
    })
    airUnits.value = [...airUnits.value, unit]
    pushLog(
      'info',
      `摆放飞机 ${unit.name}（机型 ${unit.aircraftType}，轰炸 ${unit.barrageStrength}，航程 ${unit.rangeHexes}）` +
        `于 ${hexLabel(hex)}（14.1a：该格即其空军基地格）`,
      '14.1a',
    )
    return true
  }

  /** C7：移除一架飞机（连带取消其参炸勾选） */
  function removeAirUnit(instanceId: string): void {
    const unit = airUnits.value.find((item) => item.instanceId === instanceId)
    airUnits.value = airUnits.value.filter((item) => item.instanceId !== instanceId)
    barrageAirIds.value = barrageAirIds.value.filter((id) => id !== instanceId)
    barrageState.value = null
    if (unit !== undefined) pushLog('info', `移除飞机 ${unit.name}`, '14.1')
  }

  /** C7：勾选/取消一架参炸飞机（10.2b 的短程判定随之更新） */
  function toggleBarrageAirUnit(instanceId: string): void {
    if (barrageAirIds.value.includes(instanceId)) {
      barrageAirIds.value = barrageAirIds.value.filter((id) => id !== instanceId)
    } else {
      barrageAirIds.value = [...barrageAirIds.value, instanceId]
    }
    barrageState.value = null
    barrageError.value = null
  }

  /**
   * B15c：把地图上**某一格**的选择集**镜像**到参炸名单（方案 §4.2「选择集就是参与集合」）
   *
   * 逐格同步：只按选择集增删**该格**的候选（候选表就是 `barrageUnitChoices` —— 同一份判据，
   * 不在界面里另筛一次）；别格的参炸单位原样保留（多格联合炮击时各自摊开选）。
   * 落点仍是既有的 `toggleBarrageUnit`（10.0e-F 的同类型限制与 10.0e-A/B 的账本由引擎在宣布时裁）
   * ⇒ 镜像不产生第二套判定。
   */
  function syncBarrageParticipants(hex: HexRef, selectedIds: readonly string[]): void {
    const candidates = barrageUnitChoices.value
      .map((choice) => choice.unit)
      .filter((unit) => sameHex(unit.hex, hex))
    for (const unit of candidates) {
      const wanted = selectedIds.includes(unit.instanceId)
      const has = barrageUnitIds.value.includes(unit.instanceId)
      if (wanted !== has) toggleBarrageUnit(unit.instanceId)
    }
  }

  /**
   * B15c：清掉**尚未宣布**的参炸选择（会话框的「取消」；宣布之后用 `cancelBarrage`）
   *
   * 为什么单列一个：`barrageState === null` 时没有引擎状态可取消，但玩家仍需要一条"我选错了、
   * 全部退掉"的退路（方案 §4.3「Esc = 取消当前会话」）。
   */
  function clearBarrageSelectionNow(): void {
    barrageUnitIds.value = []
    barrageAirIds.value = []
    barrageState.value = null
    barrageError.value = null
    pushLog('info', '退掉本次轰炸的参炸选子（10.0：尚未宣布，无账可回滚）', '10.0')
  }

  /** C7：切参炸单位类别（10.0e-F）与整体目标（10.0d）——换选即作废进行中的流程 */ function setBarrageKind(
    kind: BarrageKind,
  ): void {
    barrageKind.value = kind
    barrageState.value = null
    barrageError.value = null
  }

  function setBarrageTargetKind(kind: BarrageTargetKind): void {
    barrageTargetKind.value = kind
    barrageState.value = null
    barrageError.value = null
  }

  /** C7 第 1 步：宣布整体目标与轰炸值分配（10.0d / 10.0e） */
  function beginBarrageNow(): boolean {
    // 10.0：轰炸在**当前段的轰炸环节**（C 段限空中与舰炮、F 段限炮兵，来源限定由引擎判）
    if (!requireAction('barrage.declare', '宣布轰炸')) return false
    const targetHex = barrageTargetHex.value
    if (targetHex === null) {
      pushLog('warning', '请先选定轰炸目标格（10.0d）', '10.0d')
      return false
    }
    // B39 / A-1：先按**盘面**核对"整体目标"是否与该格相符（10.0c / 10.0d）
    const targetIssue = barrageTargetKindIssue.value
    if (targetIssue !== null) {
      barrageError.value = { rule: targetIssue.rule, reason: 'targetKindNotInHex' }
      pushLog(
        'warning',
        `宣布轰炸被拒：${targetIssue.reason}（${targetIssue.rule}）`,
        targetIssue.rule,
      )
      return false
    }
    const firingGround = barrageUnits.value
    const firingAir = barrageAirUnits.value
    if (firingGround.length === 0 && firingAir.length === 0) {
      pushLog('warning', '请先选择参炸单位（10.0：地面点选算子 / 空中勾选飞机）', '10.0')
      return false
    }
    const inputs = barrageInputs.value
    const targetKey = `${targetHex.col}.${targetHex.row}`
    const firingIds = [
      ...firingGround.map((unit) => unit.instanceId),
      ...firingAir.map((unit) => unit.instanceId),
    ]
    const data = acceptBarrage(
      beginBarrage({
        kind: barrageKind.value,
        phase: phase.value,
        targetKind: barrageTargetKind.value,
        targetHex,
        units: [
          // 10.1a：地面（火炮）不带距基地事实，其射程由引擎另行判定
          ...firingGround.map((unit) => toBarrageUnitRequest(unit, targetHex)),
          // 10.2b / 14.1e：空军带「距其基地（= 所在格）格数」与「是否战略轰炸机」
          ...firingAir.map((unit) => toAirBarrageUnitRequest(unit, targetHex)),
        ],
        facts: {
          /*
           * 10.0e-A：该格本阶段是否已被轰炸过 ⇒ 取**账本**（A 组接线）；
           * `inputs.hexAlreadyBarragedThisPhase` 保留为**裁判补记**入口（如手工改正漏记的一场），
           * 但它不再是唯一来源——不勾也拦得住。
           * 10.0b 低空扫射的例外由引擎判（`hipShoot` 时放行）。
           */
          hexAlreadyBarragedThisPhase:
            barragedHexesThisPhase.value.includes(targetKey) || inputs.hexAlreadyBarragedThisPhase,
          // 10.0e-B：任一参炸单位本阶段已经轰炸过 ⇒ 重复参炸（也就是"把轰炸值拆分到多次"）
          unitAlreadyBarragedThisPhase: firingIds.some((id) =>
            barragedUnitIdsThisPhase.value.includes(id),
          ),
          hipShoot: inputs.hipShoot,
          hasSpotter: barrageTargetFacts.value.hasSpotter,
          // 10.0e-F：一次轰炸只能用同一类型 ⇒ 地面与空中同时参炸即是混类型（事实可判，无须玩家勾选）
          mixedKinds: firingGround.length > 0 && firingAir.length > 0,
        },
      }),
      '宣布轰炸',
    )
    if (data === null) return false
    barrageState.value = data
    pushLog(
      'info',
      `宣布轰炸（10.0d）：目标${data.targetKind === 'combatUnits' ? '战斗单位' : targetKindLabel(data.targetKind)}；` +
        `轰炸值 ${data.totalValue} ⇒ 初始列 ${data.table.columnLabel}，成本 ${data.table.costT} T` +
        `（${firingGround.length} 个地面单位 + ${firingAir.length} 架飞机，类型 ${data.kind}）`,
      '10.0',
    )
    // ⑭ 接线：轰炸宣布与轰炸值分配（10.0d / 10.0e）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'barrageDeclare',
      rule: '10.0',
      data: {
        kind: data.kind,
        targetKind: data.targetKind,
        targetHex: { ...targetHex },
        totalValue: data.totalValue,
        initialColumn: data.table.initialColumn,
        columnLabel: data.table.columnLabel,
        costT: data.table.costT,
        groundUnitIds: firingGround.map((unit) => unit.instanceId),
        airUnitIds: firingAir.map((unit) => unit.instanceId),
      },
    })
    return true
  }

  /**
   * 12.3a ∪ 12.3b：**一组受益单位**（炮击的参炸火炮 / 战斗的参战堆叠）能为之付款的补给站
   *
   * 「**直接拖取 (12.3a) 和指挥部投递 (12.3b) 都可用于**接收及分配战斗补给」（12.4）；
   * 「多个单位同时轰炸时，补给必须来自**同一个指挥部**。如果不使用指挥部，则需要来自**同一个补给站**」（10.1b-A）。
   * ⇒ 只有在"同一个来源"下才成立，故：
   *   · **直拖支**：取**每个**受益单位各自 5 MP 直拖（或相邻，12.3c）可达的**交集**；
   *   · **HQ 投递支**：本部 HQ 能按 12.3a 拖到该站（含 12.3b-C/D 的两条限制，由 `canThrowViaHQ` 判），
   *     且按印刷投递距离能把补给投到**每一个**受益单位（12.3c 的相邻也计入）；
   * 两条并集 —— 这正是"多门火炮分散时经同一指挥部付款"（10.1b-A）缺的那一半。
   *
   * ★ 13.2g-B（编内卡车）：「只允许**同一多单位编队内的单位拖取**它们的 SP」⇒ 判据按**受益单位逐个**过
   *   （修前战斗侧用的是"参战堆叠里**有没有**同编队单位"，会让非同编队的同伴蹭到该车的油）；
   *   13.2g 末句同时允许「用指挥部把编内卡车的补给投递给同一编队内的单位」，故 HQ 支同样只受这一条限制。
   */
  /**
   * 12.3b：**经 HQ 投递**可用的补给站（格键集合）
   *
   * 某座 HQ 成立的条件：① 它自己能按 12.3a 拖到那座站（含 12.3b-C/D 的两条限制，`canThrowViaHQ` 判）；
   * ② 它能把补给投到**每一个**受益单位（印刷投递距离，或 12.3c 的相邻）。
   *
   * ★ 受益者只按**所在格**参与判据（12.3b 的投递距离以格计）⇒ 参数放宽为 `{ hex }`，
   *   既收盘上算子（`ConsoleUnit`），也收 15.1 整备那一路的基地投影（`AirBaseView`）。
   */
  function hqDeliveryDumpKeys(side: Side, beneficiaries: readonly { hex: HexRef }[]): Set<string> {
    const facts = supplyFacts.value
    const keys = new Set<string>()
    if (beneficiaries.length === 0) return keys
    for (const hq of units.value.filter((unit) => unit.side === side && isHqUnit(unit))) {
      const hqView = toThrowHqView(hq)
      const coversAll = beneficiaries.every((unit) => {
        const reach = countSupplyDistance(facts, {
          from: hq.hex,
          to: unit.hex,
          side,
          mobility: hqView.throwMobility,
          maxMp: hqView.throwRangeMp,
        })
        if (!reach.ok) return false
        return canThrowViaHQ({
          hqMode: hq.mode.mode,
          distanceMp: reach.mp,
          throwRangeMp: hqView.throwRangeMp,
          ...(hqView.receivedByThrow === undefined
            ? {}
            : { receivedByThrow: hqView.receivedByThrow }),
        }).ok
      })
      if (!coversAll) continue
      for (const entry of drawableDumpsFor(facts, {
        hex: hq.hex,
        side,
        mobility: hqView.throwMobility,
      }))
        if (entry.ok) keys.add(hexLabel(entry.hex))
    }
    return keys
  }

  function deliverableDumpsFor(side: Side, beneficiaries: readonly ConsoleUnit[]): SpDump[] {
    if (beneficiaries.length === 0) return []
    const facts = supplyFacts.value
    const keys = new Set<string>()
    // ① 12.3a：**每个**受益单位都能自己拖到的站（同一次付款只有一个来源 ⇒ 取交集）
    const direct = beneficiaries.map(
      (unit) =>
        new Set(
          drawableDumpsFor(facts, { hex: unit.hex, side })
            .filter((entry) => entry.ok)
            .map((entry) => hexLabel(entry.hex)),
        ),
    )
    const first = direct[0]
    if (first !== undefined) {
      for (const key of first) {
        if (direct.every((set) => set.has(key))) keys.add(key)
      }
    }
    // ② 12.3b：HQ 投递（HQ 自己拖得到 + 覆盖每一个受益单位）
    for (const key of hqDeliveryDumpKeys(side, beneficiaries)) keys.add(key)
    // ③ 12.1b/13.2g-B：落到具体账本条目上，并对编内卡车来源逐个受益单位验编队资格
    return allSpDumps.value.filter(
      (dump) =>
        dump.side === side &&
        keys.has(hexLabel(dump.hex)) &&
        (dump.carrierIsOrganicTruck !== true ||
          beneficiaries.every((unit) =>
            canDrawFromCarrier({
              carrierIsOrganicTruck: true,
              carrierFormation: dump.carrierFormation ?? null,
              drawerFormation: unit.formation,
            }),
          )),
    )
  }

  /** 12.4 / 10.1b-A：该方在该次交互里的**受益单位**（炮击＝参炸火炮；战斗＝参战的那一叠） */
  function combatBeneficiariesOf(side: Side): ConsoleUnit[] {
    return side === activeSide.value
      ? combatAttackers.value
      : units.value.filter((unit) =>
          (battleTarget.value?.defenderIds ?? []).includes(unit.instanceId),
        )
  }

  /**
   * C7：轰炸战斗补给的**付款来源**（10.1b：只能来自 SP，且只能是同一 HQ 或同一 dump）
   */
  const barrageSupplyDumpId = ref<string | null>(null)

  /**
   * C7：可作轰炸付款来源的补给站
   *
   * ★ 10.1b-A 要求「来自**同一指挥部**或**同一补给站**」⇒ 这一座站必须被**每个**参炸地面单位
   *   拖得到（12.3a 的 5 MP 直拖或相邻；12.3c）。修前这里给的是「该方**全部**补给站」，
   *   等于可以在全图任意远处给一场轰炸付款。
   *   10.2c：空军轰炸无补给消耗 ⇒ 空军参炸时不需要来源（候选给空集即可）。
   */
  const barrageSupplyDumpChoices = computed<SpDump[]>(() => {
    if (barrageState.value?.kind !== 'artillery') return []
    const units = barrageUnits.value
    if (units.length === 0) return []
    /*
     * 10.1b-A：「多个单位同时轰炸时，补给必须来自**同一个指挥部**。如果不使用指挥部，则需要来自**同一个补给站**。」
     * ⇒ 直拖支取交集、HQ 投递支由 `deliverableDumpsFor` 一并给出（修前**没有** HQ 支：多门炮分散时
     *   根本选不出来源，炮击补给这一步永远过不去）。
     */
    return deliverableDumpsFor(activeSide.value, units)
  })

  /**
   * 10.1b-A：这批来源里哪些是**经 HQ 投递**达成的（付款时据此声明 `fromSameHq`）
   *
   * 判据与 `deliverableDumpsFor` 的 ② 支**同源**（同一个 `hqDeliveryDumpKeys`），故不会与候选漂移。
   */
  const barrageSupplyHqChoices = computed<SpDump[]>(() => {
    if (barrageState.value?.kind !== 'artillery') return []
    const firingUnits = barrageUnits.value
    if (firingUnits.length === 0) return []
    const keys = hqDeliveryDumpKeys(activeSide.value, firingUnits)
    return spDumps.value.filter((dump) => keys.has(hexLabel(dump.hex)))
  })

  /** C7：点选的轰炸付款补给站（未选或已不存在 ⇒ null） */
  const barrageSupplyDump = computed<SpDump | null>(
    () => spDumps.value.find((dump) => dump.id === barrageSupplyDumpId.value) ?? null,
  )

  /** C7：声明轰炸的付款来源（12.3a：只能是自己方的补给站） */
  function pickBarrageSupplyDump(dumpId: string | null): boolean {
    if (dumpId === null) {
      barrageSupplyDumpId.value = null
      return true
    }
    const dump = spDumps.value.find((item) => item.id === dumpId)
    if (dump === undefined || dump.side !== activeSide.value) {
      pushLog(
        'warning',
        `该补给站不是 ${activeSide.value === 'axis' ? '轴心国' : '苏联'}的（12.3a）`,
        '12.3a',
      )
      return false
    }
    barrageSupplyDumpId.value = dumpId
    /*
     * 10.1b-A：这一座站是经哪一支进来的 —— 「来自同一指挥部」还是「来自同一补给站」。
     * 两条支命中哪条就声明哪条（修前恒为 `fromSameDump: true`，"同一指挥部"那半从未被表达）。
     */
    const viaHq = barrageSupplyHqChoices.value.some((item) => item.id === dumpId)
    barrageInputs.value = {
      ...barrageInputs.value,
      availableT: holdingsToT({ sp: dump.sp, t: dump.t }),
      fromSameHq: viaHq,
      fromSameDump: !viaHq,
    }
    pushLog(
      'info',
      `轰炸补给来源：${hexLabel(dump.hex)}（${dump.sp} SP + ${dump.t} T = ${holdingsToT({ sp: dump.sp, t: dump.t })} T）`,
      '10.1b',
    )
    return true
  }

  /**
   * B14b（用户口径⑪）：在算子图阵列里**点选/再点取消**轰炸的付款来源
   *
   * 旧界面的下拉有一个「（未声明 ⇒ 火炮付不出）」的空档，阵列没有空档可言 ⇒
   * 用「点同一座站即取消」补上这条退路（与 15.4 被指定单位、参战机的阵列同一手感）。
   */
  function toggleBarrageSupplyDump(dumpId: string): void {
    if (barrageSupplyDumpId.value === dumpId) {
      pickBarrageSupplyDump(null)
      return
    }
    pickBarrageSupplyDump(dumpId)
  }

  /** C7 第 2 步：按初始列支付火炮战斗补给（10.1b；空军/海军免费 10.2c）
   *
   * ★ 12.3a/12.3b 是仅有的两条取补途径 ⇒ 火炮的这笔 T **必须落到一座声明的补给站上**。
   *   原先 `barrageInputs.availableT` 是玩家手填的裸数字：引擎把状态标成 `paid: true`，
   *   而**没有任何一步扣款** ⇒ 那是一次**免费轰炸**。现在：选站 ⇒ 可用量由该站持仓推出 ⇒
   *   付完从该站扣（与 12.4 的战斗补给同一条纪律）。
   */
  function confirmBarrageSupplyStep(): boolean {
    const state = barrageState.value
    if (state === null) return false
    const inputs = barrageInputs.value
    const dump = barrageSupplyDump.value
    // 10.2c：空军轰炸无需战斗补给 ⇒ 不要求来源；火炮按初始列收费 ⇒ 必须先有来源
    if (state.kind === 'artillery' && state.table.costT > 0) {
      if (dump === null) {
        barrageError.value = { rule: '12.3a', reason: 'barrageSupplyNeedsADump' }
        pushLog(
          'danger',
          '12.3a：火炮的战斗补给必须从**己方补给站**取 ⇒ 先在「轰炸补给来源」里点选一座补给站',
          '12.3a',
        )
        return false
      }
      // 10.1b-A / 12.3a：这一座站必须被**每个**参炸单位拖得到（同一来源）
      if (!barrageSupplyDumpChoices.value.some((item) => item.id === dump.id)) {
        barrageError.value = { rule: '12.3a', reason: 'barrageSupplyDumpOutOfRange' }
        pushLog(
          'danger',
          `12.3a/10.1b-A：参炸单位拖不到 ${hexLabel(dump.hex)}（须 5 MP 直拖内或相邻，且各参炸单位共用同一来源）` +
            `⇒ 可达的候选：${barrageSupplyDumpChoices.value.map((item) => hexLabel(item.hex)).join('、') || '（无）'}`,
          '12.3a',
        )
        return false
      }
      // 3.4b：错误集群的 SP 不得支付多单位编队的轰炸成本（受益方＝本次参炸单位）
      const restricted = panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'barrage',
        beneficiaryUnitIds: state.units.map((unit) => unit.unitId),
      })
      if (restricted !== null) {
        barrageError.value = { rule: restricted.rule, reason: restricted.reason }
        pushLog(
          'danger',
          `轰炸补给被拒（3.4b）：${panzerGroupSpRefusal(restricted, '轰炸', dump.id)}——本次不改动任何账本`,
          '3.4b',
        )
        return false
      }
    }
    const data = acceptBarrage(
      planBarrageSupply(state, {
        // 12.1a：可用量按所选站的持仓（含 SP 折算）推出，不再采信手填数字
        availableT: dump === null ? inputs.availableT : holdingsToT({ sp: dump.sp, t: dump.t }),
        fromSameHq: inputs.fromSameHq,
        fromSameDump: inputs.fromSameDump,
        usedInternalStocks: inputs.usedInternalStocks,
      }),
      '轰炸补给',
    )
    if (data === null) return false
    barrageState.value = data.state
    const supply = data.state.supply
    // 10.1b：付了就真扣（原先只把状态标成已付，账本分文不动 ⇒ 免费轰炸）
    if (supply?.paid === true && supply.waived !== true && supply.requiredT > 0) {
      if (dump === null) {
        barrageError.value = { rule: '12.3a', reason: 'barrageSupplyNeedsADump' }
        pushLog('danger', '12.3a：这笔轰炸补给没有付款来源，交易取消', '12.3a')
        return false
      }
      const payment = planSpPayment({
        holdings: { sp: dump.sp, t: dump.t },
        wantT: supply.requiredT,
      })
      if (!payment.ok) {
        barrageError.value = { rule: payment.rule, reason: payment.reason }
        pushLog(
          'danger',
          `轰炸补给付不出 ${supply.requiredT} T：${payment.reason}（${payment.rule}）——本次不改动任何账本`,
          payment.rule,
        )
        return false
      }
      setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
      pushLog(
        'info',
        `10.1b：从 ${hexLabel(dump.hex)} 扣 ${supply.requiredT} T 作本次轰炸的战斗补给`,
        '10.1b',
      )
    }
    pushLog(
      'success',
      supply?.waived === true
        ? `轰炸无需战斗补给（10.2c：空军轰炸）`
        : `按初始列支付战斗补给 ${supply?.requiredT ?? 0} T（10.1b）`,
      supply?.rule ?? '10.1b',
    )
    // ⑭ 接线：轰炸战斗补给（10.1b / 10.2c）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'barrageSupply',
      rule: supply?.rule ?? '10.1b',
      data: {
        waived: supply?.waived === true,
        requiredT: supply?.requiredT ?? 0,
      },
    })
    /*
     * 10.0e-A/B 记账（A 组接线）：走到这里＝补给这一关过了（或空军免补给）⇒ 从此刻起这一格
     * 与这些单位在本阶段"已轰炸过"。之所以**不在宣布时**就记：10.1b 明写「付不出则全部取消，
     * 且**不视为已轰炸过**」——宣布了却付不出补给的那一场，不该占用本阶段的这一次。
     * 10.0e-A 的例外（已宣布但被防空完全摧毁/返航也算）也在这个时点之后，故一并覆盖。
     */
    const barragedHex = barrageTargetHex.value
    /*
     * ★ 14.7d-A（第六批条 23-③）：「低空扫射**不计入**每个阶段内对一个格最多一次轰炸的限制。」
     *   ⇒ 低空扫射**不写格账本**（否则同格第二次低空扫射会被 10.0e-A 拒掉，正是修前的表现）。
     *   ★ 但 10.0e-B「一个单位在一个阶段只能进行一次轰炸」**没有**给低空扫射开口子
     *     （10.0e-A 的例外只写了反舰船轰炸与低空扫射）⇒ 单位账本照记。
     *   另注：10.0e-A 的另一处例外是**反舰船轰炸（18.3）**，本作无海军单位，暂不接线（如实登记）。
     */
    if (barragedHex !== null && inputs.hipShoot !== true) {
      const key = `${barragedHex.col}.${barragedHex.row}`
      barragedHexesThisPhase.value = [...new Set([...barragedHexesThisPhase.value, key])]
    }
    barragedUnitIdsThisPhase.value = [
      ...new Set([
        ...barragedUnitIdsThisPhase.value,
        ...data.state.units.map((unit) => unit.unitId),
      ]),
    ]
    return true
  }

  /** C7 第 3 步：确认列横移（10.0a 目标玩家选地形 / 10.0b 观察员 / 10.2b 短程） */
  function confirmBarrageShiftsStep(): boolean {
    const state = barrageState.value
    if (state === null) return false
    const inputs = barrageInputs.value
    const facts = barrageTargetFacts.value
    const targetHex = barrageTargetHex.value
    const data = acceptBarrage(
      declareBarrageShifts(state, {
        enemyREInHex: facts.enemyREInHex,
        hedgehogLevel: facts.hedgehogLevel,
        stratModeInHex: facts.stratModeInHex,
        hasSpotter: facts.hasSpotter,
        // 10.0a：地形横移只能取自**目标格内**的地形（候选集与 9.3b 一致）
        ...(targetHex === null ? {} : { terrainCandidates: defenseTerrainChoices(targetHex) }),
        ...(inputs.terrainLine === '' ? {} : { terrainLine: inputs.terrainLine }),
      }),
      '列横移',
    )
    if (data === null) return false
    barrageState.value = data.state
    const shifts = data.state.shifts
    pushLog(
      isFacilityBarrage(data.state) ? 'info' : 'success',
      isFacilityBarrage(data.state)
        ? '对设施轰炸无横移、不需观察员（10.0c）'
        : `列横移合计 ${shifts?.total ?? 0}（${(shifts?.detail ?? []).join('；') || '无'}）` +
            ` ⇒ 最终列 ${data.state.finalColumn}（初始 ${data.state.table.initialColumn}）`,
      isFacilityBarrage(data.state) ? '10.0c' : '10.0a',
    )
    // ⑭ 接线：列横移（10.0a / 10.0b / 10.0c）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'barrageShifts',
      rule: isFacilityBarrage(data.state) ? '10.0c' : '10.0a',
      data: {
        facility: isFacilityBarrage(data.state),
        shiftTotal: shifts?.total ?? 0,
        finalColumn: data.state.finalColumn,
        initialColumn: data.state.table.initialColumn,
      },
    })
    return true
  }

  /** C7：按目标类别掷骰（10.0a 2 骰 / 10.0c 1 骰），并推进 rng 与计数 */
  function drawBarrageDie(state: BarrageInteractionState): number {
    // 10.0c：对设施掷一个骰子；10.0a：对战斗单位掷两枚骰子
    const draw = isFacilityBarrage(state) ? roll1d6(rng.value) : roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }

  /**
   * B28：**12.11a 的销毁骰**（1d6）——一律自动，不再让玩家填骰面
   *
   * 与 `drawBarrageDie` 同一套：走种子化 `rng` 并按掷骰计数，骰面可在结算日志里复算。
   */
  function drawDumpDestructionDie(): number {
    const draw = roll1d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }

  /**
   * C7 第 4 步：掷骰结算（10.0a / 10.0c）
   *
   * `1/2` 结果须再掷取整骰（10.0a）：本动作在需要时**自动补掷**，玩家若想自定骰值可先填 `inputs.die`/`halfDie`。
   */
  function rollBarrageDiceStep(): boolean {
    const state = barrageState.value
    if (state === null) return false
    const inputs = barrageInputs.value
    // ⑭ 接线：`drawBarrageDie` 只回报数字（不改它）⇒ 先记下掷骰前的骰源，按同一颗 PRNG
    // 复算出 DiceRoll（10.0c 1 骰 / 10.0a 2 骰）供会话日志复算
    const rngBefore = rng.value
    let cursor = rngBefore
    const rolls: DiceRoll[] = []
    const die = inputs.die ?? drawBarrageDie(state)
    if (inputs.die === null) {
      const derived = isFacilityBarrage(state) ? roll1d6(cursor) : roll2d6(cursor)
      rolls.push(derived.value)
      cursor = derived.rng
    }

    let data = acceptBarrage(
      resolveBarrageDice(state, {
        die,
        ...(inputs.halfDie === null ? {} : { halfDie: inputs.halfDie }),
      }),
      '掷骰',
    )
    if (data === null) return false
    if (data.awaitingHalfDie) {
      const halfDie = inputs.halfDie ?? drawBarrageDie(state)
      if (inputs.halfDie === null) {
        const derived = isFacilityBarrage(state) ? roll1d6(cursor) : roll2d6(cursor)
        rolls.push(derived.value)
        cursor = derived.rng
      }
      data = acceptBarrage(resolveBarrageDice(state, { die, halfDie }), '取整骰')
      if (data === null) return false
    }
    barrageState.value = data.state
    barrageAwaitingHalfDie.value = data.awaitingHalfDie
    const result = data.state.result
    pushLog(
      'success',
      `掷骰 ${die}${isFacilityBarrage(state) ? '（1 骰，10.0c）' : '（2 骰，10.0a）'}` +
        ` ⇒ 格值 ${result?.code ?? '?'}` +
        `${data.state.dice?.halfDie === undefined ? '' : `（取整骰 ${data.state.dice.halfDie}）`}`,
      isFacilityBarrage(state) ? '10.0c' : '10.0a',
    )
    // ⑭ 接线：轰炸掷骰（10.0a / 10.0c）入会话日志；rolls＝本笔真实掷出的骰子（含 10.0a 的取整骰）
    recordSettlement({
      action: 'barrageDice',
      rule: isFacilityBarrage(state) ? '10.0c' : '10.0a',
      rolls,
      data: {
        facility: isFacilityBarrage(state),
        die,
        halfDie: data.state.dice?.halfDie ?? null,
        code: result?.code ?? null,
      },
    })
    return true
  }

  /** C7：把设施结果写进日志（10.0c A/B/C） */
  function logFacilityPatch(patch: FacilityPatch): void {
    if (patch.baseLevelAfter !== undefined)
      pushLog('success', `空军基地降级至 ${patch.baseLevelAfter} 级（10.0c-A）`, '10.0c-A')
    if (patch.portDamage !== undefined)
      pushLog('success', `港口累计伤害 ${patch.portDamage}（上限 4；10.0c-B）`, '10.0c-B')
    if (patch.trainbustingPlaced === true)
      pushLog('success', '放置运输破坏标记（10.0c-C；14.8c 于下一敌方清理阶段移除）', '10.0c-C')
  }

  /**
   * 10.0a：损失承受者＝**目标格内的敌方战斗单位**（原文：「他还需要选择**堆叠中的**哪些战斗单位
   * 来承受此次轰炸造成的军力损失」，`_ocs_v43_clean.txt:1573-1574`）
   *
   * ★ 修前面板的损失输入取 `battleDefenders`（9.x 战斗工具的守方）⇒ 正常对局（无战斗会话）里
   *   输入清单为空，出「#」点数结果时 ⑤ 永远填不满＝死锁；引擎校验本来就按目标格判
   *   ⇒ 现在投影与 `confirmBarrageOutcomeStep` 的 `eligibleUnitIds` **共用这一处**口径，面板只读它。
   */
  const barrageLossTargets = computed<ConsoleUnit[]>(() => {
    const state = barrageState.value
    if (state === null) return []
    return units.value.filter(
      (unit) =>
        unit.side !== activeSide.value && sameHex(unit.hex, state.targetHex) && unit.isCombat,
    )
  })

  /**
   * 10.0c-A：目标格内**所有敌方飞机**（「检查该格内所有敌方飞机的损失情况。对每个飞机分别掷骰」，
   * txt:1595-1600）⇒ 面板逐机掷骰输入的候选（修前同样错取 `battleDefenders`＝地面单位清单）。
   */
  const barrageAircraftRollTargets = computed<ConsoleAirUnit[]>(() => {
    const state = barrageState.value
    if (state === null) return []
    return airUnits.value.filter(
      (air) => air.side !== activeSide.value && sameHex(air.hex, state.targetHex),
    )
  })

  /** C7 第 5 步：结果确认（10.0a 损失分配 / 10.0c 设施结果）并落盘 */
  function confirmBarrageOutcomeStep(): boolean {
    const state = barrageState.value
    if (state === null) return false
    const inputs = barrageInputs.value
    // 10.0a：损失承受者只能是**目标格内的敌方战斗单位**（与面板输入共用同一投影）
    const eligibleUnitIds = barrageLossTargets.value.map((unit) => unit.instanceId)
    const losses = Object.entries(inputs.losses)
      .map(([unitId, steps]) => ({ unitId, steps }))
      .filter((loss) => loss.steps > 0)
    const aircraft = Object.entries(inputs.aircraftRolls).map(([id, roll]) => ({ id, roll }))

    const data = acceptBarrage(
      planBarrageOutcome(state, {
        eligibleUnitIds,
        losses,
        baseLevel: inputs.baseLevel,
        isAirstrip: inputs.isAirstrip,
        portDamageBefore: inputs.portDamageBefore,
        aircraft,
      }),
      '结果确认',
    )
    if (data === null) return false
    barrageState.value = data.state
    applyBarragePatches(data.patches)
    // 10.0c-A：括号结果 ⇒ 格内掷骰 ≥# 的飞机各损 1 军力（引擎逐机判定；修前在交互层被丢弃、从未落盘）
    const aircraftLossIds = data.aircraftLossIds ?? []
    for (const id of aircraftLossIds) applyAirStepLoss(id)
    if (aircraftLossIds.length > 0)
      pushLog(
        'warning',
        `10.0c-A：${aircraftLossIds.length} 架飞机掷骰达标 ⇒ 各损失 1 点军力`,
        '10.0c-A',
      )
    if (data.facility !== undefined) logFacilityPatch(data.facility)

    const outcome = data.state.outcome
    if (outcome?.table === 'barrage') {
      pushLog(
        'success',
        `轰炸结果（10.0a）：${outcome.value.detail}` +
          `${outcome.value.stepLosses > 0 ? `；承受者 ${losses.map((loss) => `${nameOf(loss.unitId)} ${loss.steps} 点`).join('、')}` : ''}`,
        '10.0a',
      )
    } else if (outcome?.table === 'barrage-vs-facility') {
      pushLog('success', `对设施轰炸结果（10.0c）：${outcome.value.detail}`, outcome.value.rule)
    }
    // ⑭ 接线：轰炸结果确认（10.0a 损失分配 / 10.0c 设施结果）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'barrageOutcome',
      rule:
        outcome === undefined
          ? '10.0a'
          : outcome.table === 'barrage-vs-facility'
            ? outcome.value.rule
            : '10.0a',
      data: {
        table: outcome?.table ?? null,
        detail: outcome?.value.detail ?? null,
        losses: losses.map((loss) => ({ unitId: loss.unitId, steps: loss.steps })),
        ...(aircraftLossIds.length > 0 ? { aircraftLossIds } : {}),
        facilityPatch:
          data.facility === undefined
            ? null
            : {
                baseLevelAfter: data.facility.baseLevelAfter ?? null,
                portDamage: data.facility.portDamage ?? null,
                trainbustingPlaced: data.facility.trainbustingPlaced === true,
              },
      },
    })
    return true
  }

  /** C7：放弃本次轰炸（中止 10.0 流程；已落盘的结果不自动回滚） */
  function cancelBarrage(): void {
    clearBarrage()
    pushLog('info', '放弃本次轰炸（10.0 流程中止）', '10.0')
  }

  /** C7：整体目标名（日志用） */
  function targetKindLabel(kind: BarrageTargetKind): string {
    if (kind === 'airBase') return '空军基地'
    if (kind === 'port') return '港口'
    if (kind === 'trainbusting') return '运输破坏'
    return '战斗单位'
  }

  /* ──────────────── C8 补给交互与 SP 管理：账本 → 12.1a → 12.6/12.3 流程（全部问引擎） ──────────────── */

  /** C8：开/关补给工具（开启时清空上一场；账本与来源声明保留） */
  function setSupplyActive(on: boolean): void {
    supplyActive.value = on
    clearSupply()
    pushLog('info', on ? '补给工具已开启（12.0 章）' : '补给工具已关闭', '12.0')
  }

  /** C8：清空本次补给交互（SP 账本与来源声明保留；换方/换阶段/重置/关闭时调用） */
  function clearSupply(): void {
    supplyUnitId.value = null
    supplyState.value = null
    supplyError.value = null
    supplyPreviewIndex.value = null
    supplyInputs.value = createSupplyInputs()
  }

  /** C8：统一收引擎结论（失败即记 `supplyError` 与日志并返回 null） */
  function acceptSupply<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      supplyError.value = null
      return outcome.data
    }
    supplyError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /**
   * 12.1b：在指定格落一条 SP 账本条目（**唯一入口**——手工添加与空运卸载共用同一套簿记）
   *
   * 「任何含有 SP 的位置……都被称为补给站」⇒ 无论 SP 是玩家手工摆的，还是空运卸下来的，
   * 落盘形态与 3.4b 的装甲集群待办都要一致（否则同一批 SP 因来源不同而待遇不同）。
   */
  function addSpAtHex(input: {
    hex: HexRef
    side: Side
    sp: number
    t: number
    /** 日志里说明来源（如「14.9f 空运卸载」）；缺省按手工新增 */
    source?: string
  }): string | null {
    const sp = Math.max(0, Math.trunc(input.sp))
    const t = Math.max(0, Math.trunc(input.t))
    if (sp === 0 && t === 0) return null
    const id = createId('sp')
    spDumps.value = [...spDumps.value, { id, hex: input.hex, side: input.side, sp, t }]
    /*
     * 3.4b：在局中新落的**轴方** SP 属「新到的轴方 SP」⇒ 必须立即归属某一装甲集群。
     * 这里只**登记待办**并提示（不阻断落盘：补给站本身合法，受限的是它去付什么账），
     * 玩家在专规面板一键归属后即从待办里消失。
     */
    // B50：3.4b 未启用（共识未采纳）时**不登记待办** —— 约束与界面都不该出现
    if (panzerGroupRulesOn.value && input.side === 'axis') {
      pendingSpGroupAssignment.value = [...new Set([...pendingSpGroupAssignment.value, id])]
      pushLog(
        'warning',
        `新到的轴方 SP：${hexLabel(input.hex)} 尚未归属装甲集群（3.4b）⇒ 请在本面板为它声明归属；` +
          `未归属前它不能支付多单位编队的燃油/战斗/轰炸成本`,
        '3.4b',
      )
    }
    pushLog(
      'info',
      `新增补给站 ${hexLabel(input.hex)}：${String(sp)} SP + ${String(t)} T（${input.source ?? '12.1b'}）`,
      '12.1b',
    )
    return id
  }

  /** C8：新增一条 SP 账本条目（12.1b：任何含 SP 的位置都是补给站） */
  function addSpDump(): boolean {
    const draft = spDumpDraft.value
    const hex = parseHexPath(draft.hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `补给站格号应为「列.行」（如 36.13），收到「${draft.hexText}」`, '12.1b')
      return false
    }
    const sp = Math.max(0, Math.trunc(draft.sp))
    const t = Math.max(0, Math.trunc(draft.t))
    if (sp === 0 && t === 0) {
      pushLog('warning', 'SP 与 T 不能同时为 0（12.1a：1 SP = 4 T）', '12.1a')
      return false
    }
    return addSpAtHex({ hex, side: activeSide.value, sp, t }) !== null
  }

  /** C8：移除一条 SP 账本条目 */
  function removeSpDump(id: string): void {
    const found = spDumps.value.find((dump) => dump.id === id)
    spDumps.value = spDumps.value.filter((dump) => dump.id !== id)
    if (found !== undefined) {
      pushLog('info', `移除补给站 ${hexLabel(found.hex)}（${found.sp} SP + ${found.t} T）`, '12.1b')
      // 12.1b：补给站即**源**，移除即补给网变化 ⇒ 重判
      refreshTraceSupply(`移除补给站 ${hexLabel(found.hex)}`)
    }
  }

  /**
   * C8：初设的 SP **整批落账**（12.1b / 12.1c / 12.1d）
   *
   * ## 为什么需要这个入口（修的是什么）
   *   初设阶段把剧本页的 SP 落成**盘面算子**（`stores/setup.ts` 的 `countersFor`），并记在
   *   **setup store 自己的台账**里；而「付款/拖取/追溯」这些**用账之处**读的是本 store 的
   *   `spDumps` 账本（本店的设计口径：账本＝唯一记账处）。两者不通 ⇒ 初设摆在地图上的 SP
   *   **不被认作补给站**，表现为整备付款「可付款补给站：0 处」（15.1B）、战斗补给与 12.3a
   *   拖取也看不到它。本动作把 setup 的台账整批写进账本，把这条路接通。
   *
   * ## 口径
   *   · 12.1b：**任何含 SP 的位置**（无论是否装载）都是补给站 ⇒ 初设的 SP 位置一律落账；
   *   · 12.1a：1 SP = 4 T ⇒ 只记整 SP 数，`t` 置 0（拆分/找零由账本动作负责）；
   *   · **整批替换**而非追加：setup 的台账是该时刻盘面 SP 的全集，重复落账会导致翻倍；
   *   · **此处不做全场追溯重判**：初设期全场重判很贵（逐单位算覆盖集），而追溯结论的判定时点是
   *     进入补给阶段/移动阶段（见 `refreshTraceSupply` 的触发时点）与玩家手动 `evaluateTraceSupplyNow`；
   *     本动作只负责把「账本」与「初设台账」对齐，让付款/拖取的候选项看得见这些 SP。
   */
  function landSetupSpDumps(
    dumps: readonly { id: string; hex: HexRef; side: Side; points: number }[],
  ): void {
    spDumps.value = dumps.map((dump) => ({
      id: dump.id,
      hex: { ...dump.hex },
      side: dump.side,
      sp: Math.max(0, Math.trunc(dump.points)),
      t: 0,
    }))
    if (dumps.length === 0) return
    pushLog('info', `初设 SP 落账：${dumps.length} 处补给站（12.1b / 12.1c / 12.1d）`, '12.1b')
  }

  /** C8：清空 SP 账本（初设重置用；同上不在初设期做全场重判） */
  function clearSpDumps(reason = '账本清空'): void {
    if (spDumps.value.length === 0) return
    spDumps.value = []
    pushLog('info', `SP 账本清空（${reason}）`, '12.1b')
  }

  /** C8：直接改写某条 SP 账本（界面手填 SP/T；只是收玩家输入，不做规则运算） */
  function setSpDumpHoldings(id: string, holdings: SpHoldings): void {
    /*
     * B32 步骤 5（12.1b / 13.2f）：来源可以是**装载在运输点数上的 SP**（id 前缀 "unit:"）⇒
     * 写回那枚算子的 loadedSpT（12.1a 的 SP↔T 换算由 holdingsToT 兜住），并照常"用尽即重判补给网"。
     * 所有付款路径共用本函数，故一处分流即全覆盖。
     */
    if (id.startsWith('unit:')) {
      const target = units.value.find((unit) => 'unit:' + unit.instanceId === id)
      if (target === undefined) return
      target.loadedSpT = holdingsToT({ sp: holdings.sp, t: holdings.t })
      if (target.loadedSpT <= 0) refreshTraceSupply(target.name + ' 的装载补给用尽')
      return
    }
    spDumps.value = spDumps.value.map((dump) =>
      dump.id === id ? { ...dump, sp: holdings.sp, t: holdings.t } : dump,
    )
    /*
     * 12.1b：**含 SP 的位置才是补给站**（12.3a 的拖取对象、12.6c 的吃图上补给来源）。
     *
     * ★ 口径说明（勿夸大本钩子）：**补给站不是"追溯补给"的来源**——12.6a①②③ 的源是补给源格与
     *   延补队，故补给站用尽**不改变** `hasTraceSupply` 的结论。它改变的是 12.3a 拖取与
     *   12.6c 吃图上补给的**可行性**，而那两项由补给面板在 `beginSupplyCheckNow` 时按**实时事实**
     *   现算，本来就是新鲜的。
     *   此处仍重判一次，是让"补给网变动即刷新"这一条规则保持**单一收口**（本函数是所有扣款路径的
     *   唯一写点，挂这里不必在七八个付款点各写一遍），成本是两次反向洪泛，可忽略。
     */
    if (holdings.sp <= 0 && holdings.t <= 0) {
      const dump = spDumps.value.find((item) => item.id === id)
      refreshTraceSupply(`补给站 ${dump === undefined ? id : hexLabel(dump.hex)} 用尽（12.1b）`)
    }
  }

  /** C8 12.1a：**加总**（T 满 4 并为等额 SP，减少堆叠） */
  function mergeSpDumpHoldings(id: string): boolean {
    const dump = spDumps.value.find((item) => item.id === id)
    if (dump === undefined) return false
    const data = acceptSupply(planSpMerge({ holdings: { sp: dump.sp, t: dump.t } }), '加总 SP')
    if (data === null) return false
    setSpDumpHoldings(id, data.holdings)
    pushLog('success', `${hexLabel(dump.hex)} ${data.detail}`, '12.1a')
    return true
  }

  /**
   * 9.14b：把**夺取到的 T** 记到某格某方的账本上（该格该方无账本则新建）
   *
   * 9.14b：被夺取的部分「归敌方玩家」，未被夺取的部分**被摧毁**——故夺取额是**新账本**
   * （与原账本无关，原账本随后整条删除）。落盘后再按 12.1a 加总（T 满 4 并为等额 SP）。
   */
  function grantSpDumpT(hex: HexRef, side: Side, t: number): void {
    const amount = Math.max(0, Math.trunc(t))
    if (amount === 0) return
    const existing = spDumps.value.find((item) => item.side === side && sameHex(item.hex, hex))
    if (existing === undefined) {
      spDumps.value = [
        ...spDumps.value,
        { id: createId('sp'), hex: { col: hex.col, row: hex.row }, side, sp: 0, t: amount },
      ]
    } else {
      spDumps.value = spDumps.value.map((item) =>
        item.id === existing.id ? { ...item, t: item.t + amount } : item,
      )
    }
    const target = spDumps.value.find((item) => item.side === side && sameHex(item.hex, hex))
    if (target !== undefined) mergeSpDumpHoldings(target.id)
  }

  /** C8 12.1a：**拆分**（把整 SP 找零为 T，总额不变；可支付零钱） */
  function splitSpDumpHoldings(id: string, spToSplit: number): boolean {
    const dump = spDumps.value.find((item) => item.id === id)
    if (dump === undefined) return false
    const data = acceptSupply(
      planSpSplit({ holdings: { sp: dump.sp, t: dump.t }, spToSplit: Math.trunc(spToSplit) }),
      '拆分 SP',
    )
    if (data === null) return false
    setSpDumpHoldings(id, data.holdings)
    pushLog('success', `${hexLabel(dump.hex)} ${data.detail}`, '12.1a')
    return true
  }

  /** C8：新增一条基础补给源声明（12.6a①②；来源格来自专规/剧本，故由玩家声明） */
  function addSupplySource(): boolean {
    const draft = supplySourceDraft.value
    const hex = parseHexPath(draft.hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `补给源格号应为「列.行」（如 36.13），收到「${draft.hexText}」`, '12.6a')
      return false
    }
    supplySourceDecls.value = [
      ...supplySourceDecls.value,
      { id: createId('src'), hex, side: activeSide.value, kind: draft.kind },
    ]
    pushLog(
      'info',
      `声明补给源 ${hexLabel(hex)}（${supplySourceKindLabel(draft.kind)}，12.6a）`,
      '12.6a',
    )
    return true
  }

  /** C8：移除一条基础补给源声明 */
  function removeSupplySource(id: string): void {
    const found = supplySourceDecls.value.find((decl) => decl.id === id)
    supplySourceDecls.value = supplySourceDecls.value.filter((decl) => decl.id !== id)
    if (found !== undefined)
      pushLog('info', `移除补给源 ${hexLabel(found.hex)}（${found.kind}）`, '12.6a')
  }

  /** C8：悬停预览某个来源（把它的覆盖范围画到地图上；null＝回到已选来源） */
  function setSupplyPreview(index: number | null): void {
    supplyPreviewIndex.value = index
  }

  /** C8 第 1 步：对该单位做**补给检查**（12.6 判定 + 来源枚举；结论决定分支） */
  function beginSupplyCheckNow(unitId: string): boolean {
    if (!requireAction('supply.draw', '补给检查（拖取 / 投递）')) return false
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) {
      pushLog('warning', `找不到单位 ${unitId}（12.6）`, '12.6')
      return false
    }
    if (unit.side !== activeSide.value) {
      pushLog('warning', '只能对**当前方**的单位做补给检查（12.6：补给按方归属）', '12.6')
      return false
    }
    const data = acceptSupply(
      beginSupplyCheck({
        side: activeSide.value,
        phase: phase.value,
        unit: {
          id: unit.instanceId,
          side: unit.side,
          hex: unit.hex,
          isCombat: unit.isCombat,
          re: unit.re,
          mode: unit.mode.mode,
        },
        facts: supplyFacts.value,
        // 12.6c：把"同一补给站本环节已喂过的 RE"带进评估，使显示的代价就是**本次增量**
        alreadyFedRe: fedReOf(nearestDrawableDump(unit.hex, unit.side)?.id ?? null),
      }),
      '补给检查',
    )
    if (data === null) return false
    supplyUnitId.value = unitId
    supplyState.value = { ...data, sources: reviewCarrierSources(data.sources, unit) }
    supplyPreviewIndex.value = null
    pushLog(
      'info',
      `${unit.name} @ ${hexLabel(unit.hex)}：${supplyStatusLabel(data.assessment.status)}` +
        `（${data.assessment.rule}）｜来源 ${data.sources.length} 条｜分支 ${data.branch}`,
      data.assessment.rule,
    )
    // ⑭ 接线：补给检查/追溯判定（12.6）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyTrace',
      rule: data.assessment.rule,
      data: {
        unitId,
        status: data.assessment.status,
        branch: data.branch,
        sourceCount: data.sources.length,
      },
    })
    return true
  }

  /** C8 第 2 步：选定来源（12.3a/b/c；只做选择，不改状态） */
  function chooseSupplySourceNow(index: number): boolean {
    const state = supplyState.value
    if (state === null) return false
    const data = acceptSupply(chooseSupplySource(state, { index }), '选择来源')
    if (data === null) return false
    supplyState.value = data.state
    supplyPreviewIndex.value = null
    // 12.3b：换来源即重置付款补给站（改由 `supplyPayDumpCandidates` 的默认值接管）
    supplyInputs.value = { ...supplyInputs.value, payFromDumpId: null }
    const source = data.state.chosenSource
    pushLog(
      'info',
      `选定来源：${source === undefined ? '—' : supplySourceLabel(source)}`,
      source?.rule ?? '12.3',
    )
    return true
  }

  /** C8：本次拖取/投递的**付款补给站**（12.3a 直接从它拖取；12.3b 由 HQ 从它拖取后再前送） */
  function resolvePayDump(
    source: SupplySourceOption,
    candidates: readonly SpDump[],
  ): SpDump | null {
    if (source.kind === 'dump') {
      const hex = source.hex
      if (hex === null) return null
      return spDumpsOfSide.value.find((dump) => sameHex(dump.hex, hex)) ?? null
    }
    if (source.kind === 'hqThrow') {
      if (candidates.length === 0) return null
      const chosen = candidates.find((dump) => dump.id === supplyInputs.value.payFromDumpId)
      return chosen ?? candidates[0]!
    }
    // 12.6a 的追溯源与 12.6c 的吃图上补给都不在这里扣款（后者走 `confirmOosResolutionNow`）
    return null
  }

  /**
   * 12.8d：把「该单位此刻是否有补给」这一结论落到单位上（唯一写入口）
   *
   * 消费方：`battle.unitBattleStrength`（断补战斗值 ×½）、`zoc`（断补不投射 ZOC）、
   * `map-view` / `hotseat`（断补图标）、`breakout.canBreakout`（须无追溯补给方可突围）。
   *
   * ★ 原先该字段在 `toConsoleUnit` 里恒为 `true`，且全库**没有任何一处写 false**
   *   ⇒ 12.8 整条链（减半 / 无 ZOC / 逐回合损耗 / 突围资格 / 断补图标）全部空转。
   *   本函数与补给面板的两条结论对接：12.3a/b 拖取成功 ⇒ 有补给；
   *   12.6c/d 断补处置 ⇒ 按引擎的 `markedOutOfSupply` 落盘。
   */
  function markTraceSupply(instanceId: string | null, hasTraceSupply: boolean): void {
    if (instanceId === null) return
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return
    unit.hasTraceSupply = hasTraceSupply
    // 12.8e：12.3a/b 拖取成功（有补给）⇒ 连续断补期结束；标记为断补时起点由 `refreshTraceSupply` 落值
    if (hasTraceSupply) unit.cutSinceTurn = null
    else if ((unit.cutSinceTurn ?? null) === null) unit.cutSinceTurn = turn.value
  }

  /**
   * 12.8e 括注：把「本回合靠**特殊续命**维生」记到单位上
   *
   * 三种方式：**12.6c 吃图上补给**（`applySupplyPhaseFeedingNow`）、**12.10e 部队储备恢复**
   * （`applySupplyPhaseRecoveryNow`）、**21.10 补给缓存**（Forage / Shells）。它们不构成追溯补给，
   * 但按 12.8e 的括注，这些单位在续命当回合**不算**"被切断的第一个回合"⇒ 首回合豁免顺延。
   */
  function markSustainedBySpecialSupply(instanceIds: readonly string[]): void {
    if (instanceIds.length === 0) return
    const keys = new Set(instanceIds)
    for (const unit of units.value) {
      if (keys.has(unit.instanceId)) unit.sustainedBySpecialSupplyTurn = turn.value
    }
  }

  /** C8 第 3 步：结算拖取/投递（12.3），扣付款补给站的 SP 并把余额交回账本 */
  function confirmSupplyPickupNow(): boolean {
    const state = supplyState.value
    if (state === null) return false
    const source = state.chosenSource
    if (source === undefined) {
      pushLog('warning', '请先选定来源（12.3a/b）', '12.3')
      return false
    }
    const pay = resolvePayDump(source, supplyPayDumpCandidates.value)
    if (pay === null) {
      pushLog('warning', '找不到可付款的补给站（12.1b：只有含 SP 的位置才能被拖取/投递）', '12.1b')
      return false
    }
    const inputs = supplyInputs.value
    /*
     * 裁定⑤「获取即付款」：**T 数由用途的费率算**，玩家不再手填（12.4/12.5 的费率是死的，
     * 手填等于允许少付）；只有 12.10 储备 / 13.8 建造这类"数量即内容"的用途才用手填值。
     * 裁定⑥：战斗补给**不在本链付**（只在战斗会话内付）⇒ 这里按 12.4 拒绝。
     */
    const requirement = supplyPickupRequirement.value
    if (requirement === null) {
      pushLog(
        'danger',
        '12.4：战斗补给在**战斗的当口**支付（9.5 的「战斗补给」步 / 12.4），不在补给检查里预付 —— ' +
          '请在战斗会话的「战斗补给（12.4）」里点补给站付款',
        '12.4',
      )
      return false
    }
    const amountT = requirement.manual ? Math.trunc(inputs.amountT) : requirement.t
    if (amountT <= 0) {
      pushLog('warning', '待拖取/投递的 T 数应为正数（12.3a：「所需补给」）', '12.3')
      return false
    }
    const data = acceptSupply(
      confirmSupplyPickup(state, {
        holdings: { sp: pay.sp, t: pay.t },
        amountT,
        purpose: inputs.purpose,
        /*
         * 12.3b-A + 裁定②：拖取/投递**必须当场用于某个用途** ⇒ 立即使用是**结构性恒真**
         * （修前是面板上一个可以取消的勾选框 ⇒ 取消即被 12.3b-A 拒，等于把一个必答项做成了选项）。
         */
        forImmediateUse: true,
      }),
      '拖取/投递',
    )
    if (data === null) return false
    setSpDumpHoldings(pay.id, data.pickup.sourceAfter)
    supplyState.value = data.state
    // 12.3a/b：拖取/投递成功 ⇒ 该单位本回合已有补给（清除可能残留的断补标记）
    markTraceSupply(supplyUnitId.value, true)
    pushLog(
      'success',
      `拖取/投递 ${data.pickup.deliveredT} T（付款站 ${hexLabel(pay.hex)}；${requirement.detail}）；${data.pickup.detail}`,
      data.pickup.rule,
    )
    /*
     * ★ 批 B 切片 2 的**核心**：把**用途落到状态**（修前扣完款就结束了 ⇒ 玩家看到"扣了 SP 但单位
     *   还是不能走"）。12.3 重要提示把"获取"与"用途"写成同一个动作的两面，故这里当场生效。
     */
    const target = units.value.find((unit) => unit.instanceId === supplyUnitId.value) ?? null
    let purposeApplied: Record<string, unknown> = {}
    if (target !== null && inputs.purpose === 'fuel') {
      // 12.5c-C：单单位法，状态只在本阶段有效（12.5d 单单位法不进编队标记）
      target.fuelled = true
      target.fuelMethod = 'singleUnit'
      /*
       * 「取完补给立刻开拔」：**只在确有开拔意图时**重试（取子清单/正在移动/就是选中那一枚）——
       * 否则会拿一次"当前环节不允许移动"的拒绝去打扰玩家（补给段本来就不能移动，见 2.2）。
       */
      const wasPending =
        moveUnits.value.some((unit) => unit.instanceId === target.instanceId) ||
        (movePick.value?.ids ?? []).includes(target.instanceId) ||
        selectedUnit.value?.instanceId === target.instanceId
      if (wasPending) retryBeginMove()
      pushLog(
        'success',
        `${target.name} 已加注（12.5c-C：1 T）；燃料已补给状态**只在本阶段有效**（12.5c-C）` +
          `${wasPending ? '；已按当前开拔意图重试移动' : '；现在可以移动'}`,
        '12.5c-C',
      )
      purposeApplied = { fuelApplied: true, fuelMethod: 'singleUnit' }
    }
    // ⑭ 接线：拖取 / HQ 投递（12.3a / 12.3b）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyPickup',
      rule: data.pickup.rule,
      data: {
        unitId: supplyUnitId.value,
        sourceKind: source.kind,
        payDumpHex: { ...pay.hex },
        deliveredT: data.pickup.deliveredT,
        purpose: inputs.purpose,
        // 裁定②：立即使用是恒真项；这里如实记进会话日志（留痕）
        forImmediateUse: true,
        rateRule: requirement.rule,
        manualAmount: requirement.manual,
        ...purposeApplied,
        detail: data.pickup.detail,
      },
    })
    return true
  }

  /** C8 分支 B：断补处置（12.6c 吃图上补给 / 12.6d 接受断补） */
  function confirmOosResolutionNow(): boolean {
    const state = supplyState.value
    if (state === null) return false
    const inputs = supplyInputs.value
    const pay = supplyOosPayDump.value
    // 12.6c：本批已从该站喂过多少 RE —— 收费取**增量**，累计恰等于批量费率
    const fedBefore = fedReOf(pay === null ? null : pay.id)
    const data = acceptSupply(
      confirmOosResolution(state, {
        holdings: pay === null ? { sp: 0, t: 0 } : { sp: pay.sp, t: pay.t },
        action: inputs.oosAction,
        alreadyFedRe: fedBefore,
      }),
      '断补处置',
    )
    if (data === null) return false
    if (data.resolution.action === 'eatOffTheMap' && pay !== null) {
      setSpDumpHoldings(pay.id, data.resolution.holdingsAfter)
      // 记账：本单位已从该站被喂过（下次同站收费只付增量）
      oosFedReByDump.value = { ...oosFedReByDump.value, [pay.id]: fedBefore + state.assessment.re }
    }
    supplyState.value = data.state
    // 12.6c/d：把断补结论**落到单位上**（原先只进日志 ⇒ 12.8 的效果与逐回合损耗无处生效）。
    // `acceptOutOfSupply` ⇒ 标记断补（hasTraceSupply=false）；`eatOffTheMap` ⇒ 已被喂饱、未标记断补。
    markTraceSupply(supplyUnitId.value, !data.resolution.markedOutOfSupply)
    pushLog(
      data.resolution.markedOutOfSupply ? 'warning' : 'success',
      `断补处置：${data.resolution.detail}` +
        (pay === null ? '' : `（付款站 ${hexLabel(pay.hex)}）`),
      data.resolution.rule,
    )
    // ⑭ 接线：断补结算（12.6c 吃图上补给 / 12.6d 接受断补）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyOos',
      rule: data.resolution.rule,
      data: {
        unitId: supplyUnitId.value,
        action: data.resolution.action,
        markedOutOfSupply: data.resolution.markedOutOfSupply,
        payDumpHex: pay === null ? null : { ...pay.hex },
        detail: data.resolution.detail,
      },
    })
    return true
  }

  /**
   * 12.6 / 12.8：对**全场单位**重新判定追溯补给并落盘（内部实现，带触发原因）
   *
   * ## 为什么需要它
   * 这是让 12.8 那一整条链真正生效的开关：断补战斗值 ×½（9.5a/12.8d）、断补不投射 ZOC（4.5）、
   * 12.8e 突围资格（须"无追溯补给"）、界面断补图标。此前只有玩家在补给面板**逐个检查过**的单位
   * 才有标记，其余单位的 `hasTraceSupply` 一直停在创建初值 `true` ⇒ 对它们整条链是空转的。
   *
   * ## 口径
   * 判据与补给面板**同一份事实、同一实现**（`traceCoverageHexes` 覆盖集，按方各算一次），
   * 故不存在两套口径；机动类型按 12.3a 的缺省（**轮式 MP**）。
   * 12.9：**非战斗单位不受补给约束**，故它们恒视为有补给。
   *
   * ## 触发时点（`reason` 落进日志，便于复核"这次是谁推动的"）
   * 除界面手动触发外，补给网一旦变化就必须重判，否则标记会过期。已挂钩的自动时点：
   *   - **进入补给阶段**（12.6 的评估时点）；
   *   - **进入移动阶段**（＝**突围环节**：12.8e 括注「在此环节中检查追溯补给」，故此处必须新鲜；
   *     待 P1-3 把突围环节独立成子步后，本钩子应下移到该子步）；
   *   - **延补队崩溃**（12.7：延补队本身是补给源，崩溃/位移会改变补给网）；
   *   - **指挥部或延补队摆上/移除/被摧毁**（12.3b 投递源、12.7 延补队源变动）；
   *   - **补给站用尽或被移除**（12.1b：含 SP 的位置才是补给站；用尽即不再是源）。
   */
  /**
   * 12.6f：本侧各**多单位编队**里被"同源取舍"排除掉的单位（须吃图上补给，否则断补）
   *
   * 判据只有一处：引擎 `formationTraceTradeoff`（分组由本函数给 —— 它只吃"已分好组的单位列表"）。
   * 分组键＝`unit.formation`（3.1c 的多单位编队番号，**由数据定死**；用户 2026-09-17 裁定）。
   * 编队只有 1 个战斗单位时无从谈"同源"，直接跳过（不给单人编队编戏）。
   */
  function formationTraceDeniedIds(side: Side, reason: string): Set<string> {
    const byFormation = new Map<string, ConsoleUnit[]>()
    for (const unit of units.value) {
      if (unit.side !== side) continue
      if (!requiresTraceSupply(unit)) continue
      const formation = unit.formation
      if (formation === null) continue
      const members = byFormation.get(formation)
      if (members === undefined) byFormation.set(formation, [unit])
      else members.push(unit)
    }
    const denied = new Set<string>()
    for (const [formation, members] of byFormation) {
      if (members.length < 2) continue
      const result = formationTraceTradeoff(supplyFacts.value, {
        side,
        // 与补给网的覆盖集同口径（`traceCoverageHexes` 也按 truck 算）
        mobility: 'truck',
        units: members.map((unit) => ({ id: unit.instanceId, hex: unit.hex })),
      })
      if (result.sameSource) continue
      for (const id of result.uncoveredUnitIds) denied.add(id)
      const namesOf = (ids: readonly string[]): string =>
        ids.map((id) => units.value.find((unit) => unit.instanceId === id)?.name ?? id).join('、')
      pushLog(
        'warning',
        `12.6f：编队 ${formation} 的战斗单位**未 trace 到同一来源**（${reason}）⇒ ` +
          `${namesOf(result.coveredUnitIds)} 仍获追溯补给` +
          (result.commonSource === null
            ? ''
            : `（共同来源 ${hexLabel(result.commonSource.hex)}）`) +
          `，${namesOf(result.uncoveredUnitIds)} 必须**吃图上补给**（12.6c），否则断补（12.6d）`,
        '12.6f',
      )
    }
    return denied
  }

  function refreshTraceSupply(reason: string): number {
    let outOfSupply = 0
    for (const side of ['axis', 'soviet'] as const) {
      const covered = traceCoverageHexes(supplyFacts.value, { side, mobility: 'truck' })
      /*
       * 12.6f（＝13.7a 的**追溯补给那一半**）：「多单位编队中的所有战斗单位需要追溯补给线到**同一个**
       *   指挥部，或直接拖取**同一个**补给来源。如果无法做到这一点，则应选择该编队中的一部分单位进行
       *   『免费』的追溯补给，而编队中其他单位则必须使用图上补给，不然其他单位就会断补。」
       * 修前引擎的 `formationTraceTradeoff` **零调用** ⇒ 编队各单位各判各的，这条从不发生（§17.73）。
       */
      const denied = formationTraceDeniedIds(side, reason)
      for (const unit of units.value) {
        if (unit.side !== side) continue
        /*
         * 12.6h：**被空投的那个回合不需要追溯补给**（14.10b 的计划空投）；跨回合即自然失效。
         * 12.8e 括注：本回合靠 12.6c 吃图上补给 / 12.10e 部队储备 / 21.10 缓存**续命**者不算断补
         *   （那三种方式不构成追溯补给，但也不该让它们在续命当回合被标断补）。
         */
        const airDroppedThisTurn = (unit.airDropExemptTurn ?? null) === turn.value
        const sustainedThisTurn = (unit.sustainedBySpecialSupplyTurn ?? null) === turn.value
        const inSupply =
          airDroppedThisTurn ||
          sustainedThisTurn ||
          !requiresTraceSupply(unit) ||
          (traceCoverageHas(covered, unit.hex) && !denied.has(unit.instanceId))
        unit.hasTraceSupply = inSupply
        /*
         * 12.8e：维护「连续无追溯补给的起点回合」。
         * 有补给（含空投/续命的豁免期）⇒ 连续期结束；无补给且尚未记录 ⇒ 本回合就是它的第一个断补回合。
         * 只在"由有到无"时落值，故跨回合不变（＝连续计数），恢复后再次断补才会重新落新的回合。
         */
        if (inSupply) unit.cutSinceTurn = null
        else if ((unit.cutSinceTurn ?? null) === null) unit.cutSinceTurn = turn.value
        if (!inSupply) outOfSupply += 1
      }
    }
    pushLog('info', `追溯补给重判（12.6，${reason}）：断补 ${outOfSupply} 个单位`, '12.6')
    // ⑭ 接线：全场补给判定（12.6）入会话日志（本笔不掷骰）
    recordSettlement({ action: 'supplyTrace', rule: '12.6', data: { reason, outOfSupply } })
    return outOfSupply
  }

  /**
   * 12.6 / 12.8：**手动**触发全场追溯补给判定（与自动触发同一实现）
   *
   * 自动时点见 `refreshTraceSupply` 的说明；本入口供裁判在任意时刻重判。
   *
   * @returns 本次判定为断补的单位数
   */
  function evaluateTraceSupplyNow(): number {
    return refreshTraceSupply('手动重判')
  }

  /* ────────── C8b：D 段**补给阶段总计划**（12.1–12.2 / 12.6 / 12.8 / 12.10e / 12.11a） ────────── */

  /**
   * 第五批批 B 切片 3（12.10e-B / 12.0）：本段计划的**付款对象** ——
   * ①部队储备低下/耗尽（待恢复）或 ②玩家勾选了吃图上补给的**战斗单位**（只有战斗单位取补）。
   */
  const supplyPhaseParticipants = computed<ConsoleUnit[]>(() =>
    units.value.filter(
      (unit) =>
        unit.side === activeSide.value &&
        unit.isCombat &&
        (unit.internalStocks !== null ||
          supplyPhaseInputs.value.eatOffTheMap[unit.instanceId] === true),
    ),
  )

  /**
   * 当前方在本阶段**可用于恢复与喂食的补给站**（＝各参与者**可达站**的**并集**）
   *
   * 可达＝12.3a 直接拖取（5 MP 内或相邻）∪ 12.3b 指挥部投递（`deliverableDumpsFor` 的唯一实现）。
   *
   * ★ 第五批批 B 切片 3：修前这里是"己方**全部**补给站"（全边池）⇒ 池里含千里之外的站、
   *   `payFromSideDumps` 又按站序从全边扣 ⇒ SP 隔空转移；现在池只含"够得着参与者"的站，
   *   且落盘改为**逐单位**从其各自的可达站付款（见 `payFromUnitReachableDumps`）。
   */
  const supplyPhasePayableDumps = computed<SpDump[]>(() => {
    const seen = new Map<string, SpDump>()
    for (const unit of supplyPhaseParticipants.value) {
      for (const dump of deliverableDumpsFor(unit.side, [unit])) seen.set(dump.id, dump)
    }
    return [...seen.values()]
  })

  /** 当前方在本阶段**可用于恢复与喂食的 T 上限**（＝付款对象可达站并集的 T 折算合计） */
  const supplyPhaseAvailableCap = computed<number>(() =>
    supplyPhasePayableDumps.value.reduce(
      (sum, dump) => sum + holdingsToT({ sp: dump.sp, t: dump.t }),
      0,
    ),
  )

  /**
   * C8b：载入**补给阶段总计划**（12.1–12.2 的 D 段骨架）
   *
   * 引擎一次给出全段结论（顺序由 12.10e-A 定死：**恢复优先于以 SP 代 trace**）：
   * 恢复 → 逐单位评估（12.6）→ 吃图上补给分配（12.6c）→ 断补标记置/除（12.6d）→ 损耗义务（12.8a/b）。
   * 本动作只**算**不落盘；落盘各自走 `applySupplyPhaseRecoveryNow` / 既有的断补处置路径。
   */
  function planSupplyPhaseNow(): boolean {
    if (!requireAction('supply.draw', '补给阶段总计划')) return false
    const side = activeSide.value
    const mine = units.value.filter((unit) => unit.side === side)
    const outcome = planSupplyPhase(supplyFacts.value, {
      activeSide: side,
      units: mine.map((unit) => ({
        id: unit.instanceId,
        side: unit.side,
        hex: unit.hex,
        isCombat: unit.isCombat,
        steps: unit.steps,
        re: unit.re,
        ar: unit.raw.ar,
        mode: unit.mode.mode,
        internalStocks: unit.internalStocks,
        outOfSupply: !unit.hasTraceSupply,
        multiStep: unit.steps > 1,
      })),
      mobility: 'truck',
      /*
       * 12.10e-A：恢复**强制**且优先级最高（「各单位必须尽可能地恢复部队储备，与将 SP 用于追溯
       * 补给的替代相比，将 SP 用于恢复部队储备的优先级更高」）⇒ 未声明（0）时按**己方补给站
       * 的全部实有量**给额；声明正数则取它与实有量的较小值（模拟"某些站本阶段不可得"）。
       */
      availableT:
        supplyPhaseInputs.value.availableT > 0
          ? Math.min(supplyPhaseInputs.value.availableT, supplyPhaseAvailableCap.value)
          : supplyPhaseAvailableCap.value,
      // 12.6c 游戏说明：吃图上补给**永不强迫** ⇒ 逐单位的自愿选择
      eatOffTheMap: (unitId) => supplyPhaseInputs.value.eatOffTheMap[unitId] === true,
      // 12.10e-B：「只要是低下或耗尽单位**可拖取，或可投递 SP 至这些单位**的补给站，均需要按规则去恢复」
      // ⇒ 两半都算（第五批批 B 切片 3 起；修前只判直拖）。编内卡车上的 SP 例外由
      // `deliverableDumpsFor` 的 13.2g-B 资格校验承担。
      canDraw: (unitId) => {
        const unit = mine.find((item) => item.instanceId === unitId)
        if (unit === undefined) return false
        return deliverableDumpsFor(side, [unit]).length > 0
      },
    })
    supplyPhasePlan.value = outcome
    supplyPhaseError.value = null
    pushLog('info', `D 段补给阶段总计划（12.1–12.2）：${outcome.detail}`, '12.10e/12.6/12.8')
    return true
  }

  /** C8b：清空 D 段计划（改输入后重载；不自动回滚已落盘的结算） */
  function clearSupplyPhasePlan(): void {
    supplyPhasePlan.value = null
    supplyPhaseError.value = null
  }

  /**
   * C8b：落盘 **12.10e 部队储备强制恢复**（本段的第一步，且是**强制**项）
   *
   * 「在拥有部队储备低下或耗尽单位的玩家的补给阶段中，如果有了可用的 SP（可通过直接拖取或从指挥部
   *   投递），则要将标记为低下或耗尽的单位的部队储备进行恢复」——故这不是选项：计划里
   *   `canDraw` 为真者必须恢复；`spentT` 与 12.10e-C 的**浪费**一并从己方补给站扣。
   */
  function applySupplyPhaseRecoveryNow(): boolean {
    // 12.10e：恢复部队储备是 D 段**第一环**（H④ 起）——12.10e-A 的优先次序由此强制：
    // 「将 SP 用于恢复部队储备的优先级更高」⇒ 这一手在第二环（补给检定）里做不出来
    if (!requireAction('supply.recovery', '恢复部队储备')) return false
    const plan = supplyPhasePlan.value
    if (plan === null) {
      pushLog('warning', '先载入 D 段补给阶段总计划（12.1–12.2）', '12.10e')
      return false
    }
    const recovery = plan.internalStocks
    /*
     * 12.10e-C：「如果现有一些 SP，但**不足以完全恢复**内部储备，则需要**消耗现有的全部补给**。
     *   只有一个 T，则将直接被浪费掉」——故**不能**因为"没恢复成任何单位"就跳过付款：
     *   `spentT > 0` 时那点补给照样要扣（它就是被浪费掉的那部分）。
     *
     * ★ 第五批批 B 切片 3（12.10e/12.3a·b）：付款只走**可达站** ——「可通过直接拖取或从指挥部投递」
     *   ⇒ 池＝参与者可达站的并集（`supplyPhasePayableDumps`）；充足时**逐单位**从其**各自**的可达站
     *   付款（`payFromUnitReachableDumps`）。修前从**全边**站序扣 ⇒ SP 隔空转移。
     */
    if (recovery.recoveries.length === 0 && recovery.spentT <= 0) {
      pushLog('info', '12.10e：本阶段没有需要恢复的部队储备（也没有可消耗的补给）', '12.10e')
      return true
    }
    // 池级不足（12.10e-C）：花光**可达站**的全部（spentT 即计划时可达站合计）
    if (recovery.wastedT > 0) {
      const paid = payFromSideDumps(recovery.spentT, supplyPhasePayableDumps.value)
      if (paid === null) return false
      pushLog(
        'success',
        `12.10e 部队储备恢复：可达站 SP 不足 ⇒ 按 12.10e-C 消耗现有的全部补给（${recovery.spentT} T，` +
          `其中 ${recovery.wastedT} T 浪费）；仍未恢复 ${recovery.unmet.length} 个；付款站 ${paid}`,
        '12.10e',
      )
      return true
    }
    // 池充足：逐单位从**各自的可达站**付款（同站被多单位共享时按序花，付不出者降级并如实登记）
    const appliedIds: string[] = []
    const degradedIds: string[] = []
    const stations: string[] = []
    for (const item of recovery.recoveries) {
      const unit = units.value.find((entry) => entry.instanceId === item.unitId)
      if (unit === undefined) {
        degradedIds.push(item.unitId)
        continue
      }
      const paid = payFromUnitReachableDumps(unit, item.costT)
      if (paid === null) {
        // 12.10e-C：付不出完全恢复 ⇒ 花光该单位可达站的余额（现值），然后如实降级
        const ownT = deliverableDumpsFor(unit.side, [unit]).reduce(
          (sum, dump) => sum + holdingsToT({ sp: dump.sp, t: dump.t }),
          0,
        )
        payFromUnitReachableDumps(unit, ownT)
        degradedIds.push(item.unitId)
        continue
      }
      unit.internalStocks = item.to === 'ready' ? null : 'low'
      appliedIds.push(item.unitId)
      if (paid !== '（无需付款）') stations.push(paid)
    }
    // 12.8e 括注：12.10e 部队储备恢复也是"特殊续命" ⇒ 本回合不算被切断的第一回合
    markSustainedBySpecialSupply(appliedIds)
    pushLog(
      'success',
      `12.10e 部队储备恢复：${appliedIds.length} 个单位（${recovery.recoveries
        .filter((item) => appliedIds.includes(item.unitId))
        .map((item) => `${item.unitId} ${item.from}→${item.to}`)
        .join('、')}）；消耗 ${recovery.spentT} T` +
        (recovery.unmet.length > 0 ? `；仍未恢复 ${recovery.unmet.length} 个` : '') +
        (degradedIds.length > 0
          ? `；另有 ${degradedIds.length} 个因**各自的可达站**不足在落盘时降级（已按 12.10e-C 花光其可达余额）`
          : '') +
        `；付款站 ${stations.join('、') || '（无）'}`,
      '12.10e',
    )
    return true
  }

  /**
   * C8b：从**己方补给站**按序扣 T（12.3a/12.3b 是仅有的取补途径；不存在凭空池子）
   *
   * 逐站 `planSpPayment` 试扣，凑不齐即**整笔拒绝**（先试算再落盘，避免半截状态）。
   * 返回付款站清单（供日志）；失败返回 null。
   *
   * ★ 第五批批 B 切片 3：`allowed` 把可扣的站限死在**付款对象的可达站并集**内
   *   （12.10e-C 的池级浪费情形用；逐单位付款走 `payFromUnitReachableDumps`）。
   */
  function payFromSideDumps(wantT: number, allowed?: readonly SpDump[]): string | null {
    if (wantT <= 0) return '（无需付款）'
    let remaining = wantT
    const plans: { id: string; after: SpHoldings }[] = []
    for (const dump of allowed ?? spDumpsOfSide.value) {
      if (remaining <= 0) break
      const payment = planSpPayment({
        holdings: { sp: dump.sp, t: dump.t },
        wantT: Math.min(remaining, holdingsToT({ sp: dump.sp, t: dump.t })),
      })
      if (!payment.ok) continue
      plans.push({ id: dump.id, after: payment.data.holdingsAfter })
      remaining -= holdingsToT({ sp: dump.sp, t: dump.t }) - holdingsToT(payment.data.holdingsAfter)
    }
    if (remaining > 0) {
      pushLog(
        'danger',
        `补给不足以支付 ${wantT} T（缺 ${remaining} T）：12.3a/12.3b 只能从己方补给站取 ⇒ 本次不改动任何账本`,
        '12.4',
      )
      return null
    }
    for (const item of plans) setSpDumpHoldings(item.id, item.after)
    return plans
      .map((item) =>
        hexLabel(spDumps.value.find((d) => d.id === item.id)?.hex ?? { col: 0, row: 0 }),
      )
      .join('、')
  }

  /**
   * 第五批批 B 切片 3（12.10e/12.6c × 12.3a·b）：从**该单位自己的可达站**按序扣 T
   *
   * 「如果有了可用的 SP（可通过**直接拖取或从指挥部投递**）」（12.10e）⇒ 付款来源必须对
   * **受益单位本人**可达（`deliverableDumpsFor(side, [unit])`＝12.3a 直拖 ∪ 12.3b 投递）。
   * 凑不齐即**整笔拒绝**（先试算再落盘，与 `payFromSideDumps` 同规）并返回 null；
   * 成功返回付款站清单（供日志）。
   */
  function payFromUnitReachableDumps(unit: ConsoleUnit, wantT: number): string | null {
    if (wantT <= 0) return '（无需付款）'
    let remaining = wantT
    const plans: { id: string; after: SpHoldings }[] = []
    for (const dump of deliverableDumpsFor(unit.side, [unit])) {
      if (remaining <= 0) break
      const payment = planSpPayment({
        holdings: { sp: dump.sp, t: dump.t },
        wantT: Math.min(remaining, holdingsToT({ sp: dump.sp, t: dump.t })),
      })
      if (!payment.ok) continue
      plans.push({ id: dump.id, after: payment.data.holdingsAfter })
      remaining -= holdingsToT({ sp: dump.sp, t: dump.t }) - holdingsToT(payment.data.holdingsAfter)
    }
    if (remaining > 0) return null
    for (const item of plans) setSpDumpHoldings(item.id, item.after)
    return plans
      .map((item) =>
        hexLabel(spDumps.value.find((d) => d.id === item.id)?.hex ?? { col: 0, row: 0 }),
      )
      .join('、')
  }

  /**
   * C8b：**12.11a 销毁补给站**
   *
   * 「玩家可尝试销毁补给站中的全部 SP，或只尝试销毁其中部分的 SP……这只能在该玩家的
   *   移动、反应和进击阶段中的**移动环节**进行。玩家在每个阶段中，只能每个补给站只能尝试销毁一次。」
   * 掷 1 骰查销毁表得百分比；损失按 T 取整到最近；**运输点数不能以此方式摧毁**。
   *
   * ★ B28（用户口径 2026-09-16 #9「所有的随机数抽取一律自动结算」）：两个参数都改为**可选** ——
   *   骰面缺省即**当场掷**（走 `rng`，可复算），请求量缺省即**全部 SP**。
   *   于是正式界面里这条动作**不需要玩家填任何数字**；"只销毁一部分"仍是规则允许的，
   *   由界面的"全部 / 可改的数字"承担 —— 改数字是**选择**，不是掷骰。
   */
  function destructDumpNow(dumpId: string, requestedT?: number, die?: number): boolean {
    // 12.11a：只在己方移动/反应/进击阶段的**移动环节**
    if (!requireAction('move.dumpBlow', '销毁补给站')) return false
    const dump = spDumps.value.find((item) => item.id === dumpId)
    if (dump === undefined) {
      pushLog('warning', `找不到补给站 ${dumpId}（12.11a）`, '12.11a')
      return false
    }
    if (dump.side !== activeSide.value) {
      pushLog('warning', '只能销毁**己方**的补给站（12.11a）', '12.11a')
      return false
    }
    const verdict = canAttemptDumpDestruction({
      /*
       * ★ 必须传**真实段**：`movementPhaseOf` 会把非移动段也映成 `'movement'`（那只是给引擎一个
       *   合法枚举值），若照抄它，12.11a 的"只在移动环节"闸门将**永远通过**。
       */
      segment: phase.value as MovementSegmentPhase,
      attemptsThisPhase: dumpDestructionAttempts.value[dumpId] ?? 0,
    })
    if (!verdict.ok) {
      pushLog('warning', `销毁补给站被拒：${verdict.detail}（${verdict.rule}）`, verdict.rule)
      return false
    }
    // 12.11a：只销毁 SP（运输点数不受此影响）；请求量以 SP 折算的 T 为准
    const spT = holdingsToT({ sp: dump.sp, t: 0 })
    // B28：骰面缺省＝现掷；请求量缺省＝全部 SP
    const rolled = die ?? drawDumpDestructionDie()
    const wantT = Math.min(Math.max(0, requestedT ?? spT), spT)
    if (wantT <= 0) {
      pushLog('warning', '该补给站没有可销毁的 SP（12.11a：运输点数不能以此方式摧毁）', '12.11a')
      return false
    }
    const result = planDumpDestruction({
      requestedT: wantT,
      percent: dumpDestructionPercent(rolled),
    })
    if (!result.ok) {
      pushLog('warning', `销毁补给站被拒：${result.detail}（${result.rule}）`, result.rule)
      return false
    }
    const after = planSpPayment({ holdings: { sp: dump.sp, t: dump.t }, wantT: result.destroyedT })
    if (!after.ok) {
      pushLog('danger', `销毁量 ${result.destroyedT} T 超过该站持有（12.11a）`, '12.11a')
      return false
    }
    setSpDumpHoldings(dumpId, after.data.holdingsAfter)
    dumpDestructionAttempts.value = {
      ...dumpDestructionAttempts.value,
      [dumpId]: (dumpDestructionAttempts.value[dumpId] ?? 0) + 1,
    }
    pushLog(
      'success',
      `12.11a 销毁补给站 ${hexLabel(dump.hex)}：掷 ${String(rolled)} → ${result.detail}；` +
        `余 ${after.data.holdingsAfter.sp} SP + ${after.data.holdingsAfter.t} T`,
      '12.11a',
    )
    refreshTraceSupply(`销毁补给站 ${hexLabel(dump.hex)}`)
    return true
  }

  /**
   * C8b：**一键落盘 ③ 喂食（12.6c）与 ④ 断补标记（12.6d）**
   *
   * 计划里的 `feeding` 只含玩家**自愿**勾选吃图上补给的单位（12.6c 游戏说明：**永不强迫**），
   * `affordable` 为真者才真被喂饱；喂饱的 T 从己方补给站按序扣（12.3a/12.3b 是仅有取补途径）。
   * 标记的落盘一律走**唯一写点** `markTraceSupply`（与逐单位交互路径同源，不另开一条）。
   *
   * ★ 落盘后**不**再 `refreshTraceSupply`：本计划就是这一段的判定结论，立刻重判会把它覆盖掉
   *   （下一段或手动重判时自然会按新事实重算）。
   */
  function applySupplyPhaseFeedingNow(): boolean {
    if (!requireAction('supply.draw', '吃图上补给')) return false
    const plan = supplyPhasePlan.value
    if (plan === null) {
      pushLog('warning', '先载入 D 段补给阶段总计划（12.1–12.2）', '12.6c')
      return false
    }
    const fed = plan.feeding.filter((item) => item.affordable)
    const skipped = plan.feeding.length - fed.length
    // ★ 第五批批 B 切片 3（12.6c × 12.3a·b）：**逐单位**从其**各自的可达站**付款
    //   （喂食的 T「直接拖取和指挥部投递均可用于追溯补给的接收与分配」）；修前从全边站序扣。
    //   同一站被多单位共享、先行单位花光后付不出者 ⇒ 落盘降级（不喂、仍置断补标），如实登记。
    const appliedIds: string[] = []
    const degradedIds: string[] = []
    const stations: string[] = []
    let totalT = 0
    for (const item of fed) {
      const unit = units.value.find((entry) => entry.instanceId === item.unitId)
      const paid = unit === undefined ? null : payFromUnitReachableDumps(unit, item.costT)
      if (paid === null) {
        degradedIds.push(item.unitId)
        continue
      }
      totalT += item.costT
      appliedIds.push(item.unitId)
      if (paid !== '（无需付款）') stations.push(paid)
    }

    // 12.6d：恢复者摘标、新断补者置标（单一写入点）
    for (const unitId of plan.outOfSupply.clear) markTraceSupply(unitId, true)
    for (const unitId of plan.outOfSupply.mark) markTraceSupply(unitId, false)
    // 落盘降级者（计划说付得起、自己的可达站却付不出）⇒ 仍置断补标（如实登记）
    for (const unitId of degradedIds) markTraceSupply(unitId, false)
    // 12.8e 括注：被喂饱者属"靠吃图上补给续命" ⇒ 本回合不算被切断的第一回合
    markSustainedBySpecialSupply(appliedIds)

    pushLog(
      'success',
      `12.6c/12.6d 补给阶段落盘：喂食 ${appliedIds.length} 个单位（共 ${totalT} T，付款站 ${
        stations.join('、') || '（无）'
      }）` +
        (skipped > 0 ? `；另有 ${skipped} 个单位因 T 不足未喂` : '') +
        (degradedIds.length > 0
          ? `；另有 ${degradedIds.length} 个因各自的可达站不足未喂（降级置断补）`
          : '') +
        `；断补 置 ${plan.outOfSupply.mark.length + degradedIds.length} / 除 ${plan.outOfSupply.clear.length}`,
      '12.6c',
    )
    return true
  }

  /**
   * 21.10：**Forage 可用性提示**（补给阶段 + 该 HQ 正处断补首回合 + 仍有补给缓存）
   *
   * 引擎的 `forageAvailable` 自注「供界面在补给阶段提示可用性，真正的合法性判定仍在
   * `useSupplyCacheAsForage` 内」——故本处只**提示**，不代替那一步判定。
   */
  const forageHints = computed<{ hqId: string; hex: HexRef }[]>(() => {
    const side = activeSide.value
    const holdings = supplyCacheHoldings.value
    return units.value
      .filter(
        (unit) =>
          unit.side === side &&
          isHqUnit(unit) &&
          forageAvailable({
            phase: phase.value,
            // 21.10：「敌军切断该 HQ 补给的第一个回合」＝ 真跟踪的连续断补起点（12.8e 同源判据）
            firstTurnOfBeingCut: isFirstTurnOfBeingCut(unit),
            holdings,
            side,
          }),
      )
      .map((unit) => ({ hqId: unit.instanceId, hex: unit.hex }))
  })

  /* ────────── C8c：12.8b 损耗（断补堆叠逐格掷骰与分摊） ────────── */

  /** 某格的损耗输入（缺省：骰面 7＝2d6 期望值居中；分摊为空） */
  function attritionInputOf(key: string): { die: number; allocation: Record<string, number> } {
    return attritionInputs.value[key] ?? { die: 7, allocation: {} }
  }

  function setAttritionDie(hexKey: string, die: number): void {
    attritionInputs.value = {
      ...attritionInputs.value,
      [hexKey]: { ...attritionInputOf(hexKey), die: Math.min(12, Math.max(2, Math.trunc(die))) },
    }
  }

  function setAttritionAllocation(hexKey: string, unitId: string, steps: number): void {
    const current = attritionInputOf(hexKey)
    attritionInputs.value = {
      ...attritionInputs.value,
      [hexKey]: {
        ...current,
        allocation: { ...current.allocation, [unitId]: Math.max(0, Math.trunc(steps)) },
      },
    }
  }

  /**
   * C8c：**12.8b 掷损耗骰**（逐格）
   *
   * 「掷两枚骰子，使用标为断补的单位中**行动值最高**单位的行动值，找到对应的一列，并计算格中的
   *   断补单位的**军力数量**」；修正照 12.8b 的表注（断补军力 ≥5 时 +3）。取列用的 AR 由计划里的
   * `attritionDuty.bestAr` 给出（12.8c：DG 不修正 AR，战略模式按 0）——**不由本处复述**。
   *
   * 骰面**自动**（B28：用户口径 2026-09-16 #9「所有的随机数抽取一律自动结算」）——
   * 走种子化 `rng`，结果落在 `attritionResults[hexKey].die` 与结算日志里，可复算。
   * 需要钉某个骰值的场合（验证页 / 既有用例）**显式传第三个参数** `die`。
   */
  function rollAttritionNow(hexKey: string, die?: number): boolean {
    const duty = supplyPhasePlan.value?.attritionDuty.find(
      (item) => `${item.hex.col}.${item.hex.row}` === hexKey,
    )
    if (duty === undefined) {
      pushLog('warning', `${hexKey} 不在本阶段需掷损耗的格之列（12.8a/b）`, '12.8b')
      return false
    }
    // B28：缺省即现掷 2d6（与其它掷骰同一套：走 rng 并按掷骰计数）
    let rolledDie = die ?? 0
    if (die === undefined) {
      const draw = roll2d6(rng.value)
      rng.value = draw.rng
      drawCount.value += 1
      rolledDie = draw.value.total
    }
    const outcome = resolveAttrition({
      die: rolledDie,
      bestAr: duty.bestAr,
      oosSteps: duty.oosSteps,
    })
    attritionResults.value = { ...attritionResults.value, [hexKey]: { die: rolledDie, ...outcome } }
    pushLog(
      'info',
      `12.8b 损耗判定 ${hexKey}：2 骰 ${rolledDie}${outcome.drm > 0 ? ` + ${outcome.drm}（断补军力 ≥5）` : ''}` +
        ` = ${outcome.modifiedDice} ⇒ ${outcome.raw}（取列 AR ${duty.bestAr}，断补 ${duty.oosSteps} 军力）`,
      '12.8b',
    )
    return true
  }

  /**
   * C8c：**12.8b 分摊落盘**（把该格必须损失的军力点数分给具体单位）
   *
   * 「堆叠的拥有者玩家可以选择如何让该堆叠中的断补单位承受这些损失。**没有**让 AR 最高的单位
   *   必须承受损失的要求。」故只校验「分摊合法且恰好满足义务」（引擎 `validateAttritionAllocation`），
   * 然后逐单位扣军力；军力归零者经**唯一漏斗** `eliminateEntry` 进死亡堆（9.11）。
   */
  function applyAttritionNow(hexKey: string): boolean {
    if (!requireAction('supply.attrition', '断补损耗处置')) return false
    const duty = supplyPhasePlan.value?.attritionDuty.find(
      (item) => `${item.hex.col}.${item.hex.row}` === hexKey,
    )
    if (duty === undefined) {
      pushLog('warning', `${hexKey} 不在本阶段需掷损耗的格之列（12.8a/b）`, '12.8b')
      return false
    }
    const rolled = attritionResults.value[hexKey]
    if (rolled === undefined) {
      pushLog('warning', `先掷 ${hexKey} 的损耗骰（12.8b）`, '12.8b')
      return false
    }
    // 12.8b：可分摊的只有**该格的断补单位**，且以**现有军力**为上限
    const present = duty.unitIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
    const required = rolled.losses.kind === 'allSteps' ? ('all' as const) : rolled.losses.steps
    const allocation = attritionInputOf(hexKey).allocation
    const verdict = validateAttritionAllocation({
      required,
      units: present.map((unit) => ({ id: unit.instanceId, steps: unit.steps })),
      allocation,
    })
    if (!verdict.ok) {
      pushLog('warning', `12.8b 分摊被拒：${verdict.detail}（${verdict.rule}）`, verdict.rule)
      return false
    }
    for (const unit of present) {
      const loss = allocation[unit.instanceId] ?? 0
      if (loss > 0) unit.steps -= loss
    }
    for (const unit of present)
      if (unit.steps <= 0)
        eliminateEntry(unit, '12.8b', `${unit.name} 损耗归零，移入死亡堆（12.8b）`)
    pushLog('success', `12.8b 损耗落盘 ${hexKey}：${verdict.detail}`, '12.8b')
    // 战损即变动盘面：补给网可能因此变化（HQ/延补队被消灭）
    refreshTraceSupply(`12.8b 损耗 ${hexKey}`)
    return true
  }

  /* ────────── C8d：13.2c 运输点数的合并 / 拆分（含 12.7 的双向转换） ────────── */

  /**
   * 13.2c：本方的运输点数算子（当前方；供合并 / 拆分挑选）
   *
   * 分类用引擎的 `modeUnitClass`（唯一实现）：`transportPoint`＝常规运输点数，
   * `organicTruck`＝**编内卡车**——后者按 13.2c 末句**永远不能与常规卡车合并/拆分**。
   *
   * ★ 再排掉**延补队**：12.7 里延补队与其 5 点运输点数是**同一枚算子的两面**，引擎的
   *   `modeUnitClass` 因此把延补队也归入 `transportPoint`；但「合并/拆分」只作用于运输点数那一面
   *   （延补队的转换走 12.7a/12.7d 的两个动作），故此处显式排除。
   */
  const transportPointsOfSide = computed<ConsoleUnit[]>(() =>
    units.value.filter(
      (unit) =>
        unit.side === activeSide.value &&
        modeUnitClassOf(unit) === 'transportPoint' &&
        !isExtenderUnit(unit),
    ),
  )

  /** 13.2c / 12.7 的玩家输入（合并选中的 id、拆分目标与各份规模、转换目标） */
  const transportPointInputs = ref<{
    mergeIds: string[]
    splitId: string | null
    splitSizesText: string
    convertId: string | null
  }>({ mergeIds: [], splitId: null, splitSizesText: '', convertId: null })

  function toggleTransportMerge(id: string): void {
    const current = transportPointInputs.value.mergeIds
    transportPointInputs.value = {
      ...transportPointInputs.value,
      mergeIds: current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    }
  }

  /** 按型号与规模找算子库里的运输点数记录（13.2c 的「游戏提供算子的数量限制内」） */
  function transportRecordFor(
    kind: string,
    size: number,
    side: Side,
  ): ReturnType<typeof unitChoices>[number] | null {
    return (
      unitChoices(side).find(
        (record) =>
          record.noncombatDetails?.transport === size &&
          (record.noncombatDetails?.transportKind ?? null) === kind,
      ) ?? null
    )
  }

  /** 该单位的运输点数型号（数据层 `noncombatDetails.transportKind`） */
  function transportKindOf(unit: ConsoleUnit): string {
    return unit.noncombatTransportKind ?? 'truck'
  }

  /**
   * 13.2c：**合并运输点数**
   *
   * 「合并与拆分**不消耗 MP**，但只能在**友方移动阶段**中进行，且所有涉及的运输点数必须在**同一格**内。
   *   ……不同类型的运输点数永远不能合并为同一个算子，这一限制也包括编内卡车。」
   * 引擎给判据（`mergeTransportPoints`），本处负责**换算子**：把选中的若干枚移出盘面、
   * 换成该规模的那一枚记录——**算子库里没有该规模就拒绝**（这是规则的原文限制，不是我们的取舍）。
   */
  function mergeTransportPointsNow(): boolean {
    const picked = transportPointInputs.value.mergeIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
    const outcome = mergeTransportPoints({
      phase: phase.value,
      side: activeSide.value,
      activeSide: activeSide.value,
      points: picked.map((unit) => ({
        id: unit.instanceId,
        type: transportKindOf(unit),
        size: unit.noncombatTransport,
        hex: unit.hex,
      })),
    })
    if (!outcome.ok) {
      pushLog('warning', `运输点数合并被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const record = transportRecordFor(outcome.data.type, outcome.data.size, activeSide.value)
    if (record === null) {
      pushLog(
        'warning',
        `算子库里没有「${outcome.data.type} ${outcome.data.size}」的运输点数算子（13.2c：合并只能在游戏提供算子的数量限制内进行）`,
        '13.2c',
      )
      return false
    }
    const hex = picked[0]!.hex
    // 13.2c + 用户 2026-09-15 裁定：合并**保货**——新算子的装载量 = 各份之和（修前直接丢货）
    const mergedCargoT = picked.reduce((sum, item) => sum + item.loadedSpT, 0)
    units.value = units.value.filter(
      (unit) => !picked.some((item) => item.instanceId === unit.instanceId),
    )
    const merged = toConsoleUnit({
      record,
      instanceId: createId('tp'),
      hex,
      side: activeSide.value,
    })
    merged.loadedSpT = mergedCargoT
    units.value = [...units.value, merged]
    transportPointInputs.value = { ...transportPointInputs.value, mergeIds: [] }
    pushLog(
      'success',
      `${outcome.data.detail}；换成「${record.vassalName ?? record.id}」` +
        (mergedCargoT > 0 ? `，已装 SP 随并入（${mergedCargoT / SP_TO_T} SP）` : ''),
      outcome.rule,
    )
    return true
  }

  /**
   * 13.2c：**拆分运输点数**
   *
   * 约束与合并相同，并额外要求各份规模为正且**合计等于原规模**。同样换算子：原枚移出、
   * 按各份规模各放一枚（缺任一规模的算子即整笔拒绝，且**原算子不动**——先全部校验再落盘）。
   */
  function splitTransportPointNow(): boolean {
    const id = transportPointInputs.value.splitId
    const unit = units.value.find((item) => item.instanceId === id) ?? null
    if (unit === null) {
      pushLog('warning', '先选择要拆分的运输点数（13.2c）', '13.2c')
      return false
    }
    const sizes = transportPointInputs.value.splitSizesText
      .split(/[\s,，+]+/)
      .filter((text) => text !== '')
      .map((text) => Number(text))
    const outcome = splitTransportPoint({
      phase: phase.value,
      side: activeSide.value,
      activeSide: activeSide.value,
      point: {
        id: unit.instanceId,
        type: transportKindOf(unit),
        size: unit.noncombatTransport,
      },
      sizes,
    })
    if (!outcome.ok) {
      pushLog('warning', `运输点数拆分被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const records = outcome.data.sizes.map((size) =>
      transportRecordFor(outcome.data.type, size, activeSide.value),
    )
    const missing = outcome.data.sizes.filter((_, index) => records[index] === null)
    if (missing.length > 0) {
      pushLog(
        'warning',
        `算子库里没有「${outcome.data.type} ${missing.join(' / ')}」的运输点数算子 ⇒ 整笔拒绝，原算子不动（13.2c）`,
        '13.2c',
      )
      return false
    }
    units.value = units.value.filter((item) => item.instanceId !== unit.instanceId)
    /*
     * 13.2c + 用户 2026-09-15 裁定：拆分**保货**（修前直接丢货）
     *
     * 「运输点数可以自由拆分……先按实体来几点给几点」⇒ 已装 SP 按「1 点运力装 1 SP」逐份装填，
     * **总数不变**（末份兜底；13.2f 对装载量没有上限）。分配口径在引擎 `distributeTransportCargo`。
     */
    const cargoSp = distributeTransportCargo({
      cargoSp: unit.loadedSpT / SP_TO_T,
      sizes: outcome.data.sizes,
    })
    units.value = [
      ...units.value,
      ...records.map((record, index) => {
        const piece = toConsoleUnit({
          record: record!,
          instanceId: createId('tp'),
          hex: unit.hex,
          side: activeSide.value,
        })
        piece.loadedSpT = (cargoSp[index] ?? 0) * SP_TO_T
        return piece
      }),
    ]
    transportPointInputs.value = {
      ...transportPointInputs.value,
      splitId: null,
      splitSizesText: '',
    }
    pushLog(
      'success',
      `${outcome.data.detail}；换成 ${records.length} 枚` +
        (unit.loadedSpT > 0
          ? `，已装 ${unit.loadedSpT / SP_TO_T} SP 按 ${cargoSp.join(' + ')} 分到各份（13.2c）`
          : ''),
      outcome.rule,
    )
    return true
  }

  /* ────────── C8e：12.7 延补队 ⇄ 运输点数的双向转换 ────────── */

  /** 12.7a：某格**当前方**的通用运输点数（编内卡车不算，5.7f/13.2c） */
  function convertibleTransportPointsAt(hex: HexRef): ConsoleUnit[] {
    return units.value.filter(
      (unit) =>
        unit.side === activeSide.value &&
        sameHex(unit.hex, hex) &&
        isConvertibleTransportPoint({
          noncombatKind: unit.noncombatKind ?? null,
          transportKind: unit.noncombatTransportKind ?? null,
        }),
    )
  }

  /** 12.7：某方某型号的延补队算子 record（引擎不写死 id，由状态层按记录搜索） */
  function extenderRecordFor(kind: TransportKind, side: Side): UnitRecordView | null {
    return (
      unitChoices(side).find(
        (record) =>
          record.noncombatKind === 'supply_extender' &&
          (record.noncombatDetails?.transportKind ?? 'truck') === kind,
      ) ?? null
    )
  }

  /**
   * 12.7a：**运输点数 → 延补队**
   *
   * 「将合计至少 5 点运输点数移动到**同一格**中后，即可将这些运输点数转换为延补队。
   *   此操作消耗 **1/2 的 MA**。」点数可任意拆分，故引擎会取「和最小且 ≥ 消耗量」的那组算子移走，
   * 余数留在原格（`leftoverPlacement` 给出面额拆分）。
   */
  function convertTransportToExtenderNow(hexText: string, kind: TransportKind, count = 1): boolean {
    // 12.7a：转换只在**移动阶段**（C/E/G 三个移动环节）——与引擎 `EXTENDER_SEGMENTS` 同口径的 UI 闸
    if (!requireAction('move.extenderConvert', '运输点数转延补队')) return false
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      pushLog('warning', `转换格号应为「列.行」，收到「${hexText}」（12.7a）`, '12.7a')
      return false
    }
    /*
     * 12.7d：**载有 SP 的运输点不能转延补队**（必须先卸载）——判据在引擎：它会把装载者**滤出凑数**，
     * 并在"因此不够、而算上装载者就够"时报 `12.7d / loadedMustUnloadFirst`。
     * 这里不再自作主张地整笔拒绝（同格另有空车时，转换本就合法）。
     */
    const entries = convertibleTransportPointsAt(hex)
    const record = extenderRecordFor(kind, activeSide.value)
    if (record === null) {
      pushLog('warning', `算子库里没有「${kind}」延补队算子（12.7a）`, '12.7a')
      return false
    }
    const entryInputs = entries.map((unit) => ({
      id: unit.instanceId,
      kind: (unit.noncombatTransportKind ?? 'truck') as TransportKind,
      points: unit.noncombatTransport,
      // 12.7d：载有 SP 的运输点**不能**转延补队（必须先卸载）——判据在引擎
      loaded: unit.loadedSpT > 0,
    }))
    /*
     * 12.7a（第五批批 B 切片 2）：**环节闸由引擎再判一次**（`EXTENDER_SEGMENTS`）——
     * "引擎判 + UI 闸"双层同源；`wrongSegment` 的失败话术由此给出（引擎是判据唯一出处）。
     */
    const gate = canConvertTransportToExtender({
      phase: phase.value as MovementSegmentPhase,
      entries: entryInputs,
    })
    if (!gate.ok) {
      pushLog('warning', `运输点数转延补队被拒：${gate.reason}（${gate.rule}）`, gate.rule)
      return false
    }
    /*
     * 12.7d（第五批批 B 切片 2）：「延补队在**生成时**，如果此时它所在格无法与一个追溯补给的
     * 补给来源格相连，则不能在该格内生成延补队」⇒ 用**即将生成的那一面**的机动类型判连通
     * （卡车延补队＝轮式、马车延补队＝徒步——与数据层印值一致）。
     */
    const connectivity = canCreateExtenderAt(supplyFacts.value, {
      hex,
      side: activeSide.value,
      mobility: kind === 'truck' ? 'truck' : 'leg',
    })
    if (!connectivity.ok) {
      pushLog(
        'warning',
        `运输点数转延补队被拒：${connectivity.reason}（${connectivity.rule}：生成格与补给来源不相连）`,
        connectivity.rule,
      )
      return false
    }
    const outcome = planConvertTransportToExtender({
      kind,
      count,
      entries: entryInputs,
      newRecordId: record.id,
    })
    if (!outcome.ok) {
      pushLog('warning', `运输点数转延补队被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const plan = outcome.data
    // 移走被消耗的算子，余量按引擎给的面额重建
    const removed = new Set(plan.swaps.map((swap) => swap.transportUnitId))
    units.value = units.value.filter((unit) => !removed.has(unit.instanceId))
    for (const size of plan.leftoverPlacement) {
      const leftoverRecord = transportRecordFor(kind, size, activeSide.value)
      if (leftoverRecord === null) {
        pushLog(
          'warning',
          `算子库里没有「${kind} ${size}」的运输点数算子 ⇒ 余量 ${size} 点无法落盘（12.7a）`,
          '12.7a',
        )
        return false
      }
      units.value = [
        ...units.value,
        toConsoleUnit({
          record: leftoverRecord,
          instanceId: createId('tp'),
          hex,
          side: activeSide.value,
        }),
      ]
    }
    // 新延补队：12.7a 的 1/2 MA 代价**按队计**（`totalCostMa = 队数 × 每队代价`）。
    // ★ 12.7b：延补队的距离就是它的**印值 MA**，印在**战斗面** ⇒ 以战斗面摆放。
    // ★ 第五批批 B 切片 2：修前无论 `count` 是多少都只落 **1 枚**（却按 count 扣点）⇒ 现在逐队落盘。
    const created: ConsoleUnit[] = []
    for (let i = 0; i < plan.extenderCount; i += 1) {
      const extender = toConsoleUnit({
        record,
        instanceId: createId('ext'),
        hex,
        side: activeSide.value,
        face: 'combat',
      })
      extender.mpSpent = plan.totalCostMa / plan.extenderCount
      created.push(extender)
    }
    units.value = [...units.value, ...created]
    pushLog('success', `${plan.detail}；换成「${record.vassalName ?? record.id}」`, plan.rule)
    refreshTraceSupply(`12.7a 转换出延补队`)
    return true
  }

  /**
   * 12.7d：**延补队 → 5 点运输点数**（玩家主动翻面）
   *
   * 「移动环节内」+「消耗一半 MA」（引擎给 `costMa`）；9.14d 的**被动**崩溃走
   * `resolveSpecialCombatAt` 的位移流程（那里 `playerInitiated: false`、代价 0）。
   */
  function flipExtenderToTransport(extenderId: string): boolean {
    const extender = units.value.find((unit) => unit.instanceId === extenderId)
    if (extender === undefined || !isExtenderUnit(extender)) {
      pushLog('warning', '请选择一个延补队算子（12.7d）', '12.7d')
      return false
    }
    const kind = (extender.noncombatTransportKind ?? 'truck') as TransportKind
    const record = transportRecordFor(kind, EXTENDER_REQUIRED_POINTS, activeSide.value)
    if (record === null) {
      pushLog('warning', `算子库里没有「${kind} 5」的运输点数算子（12.7d）`, '12.7d')
      return false
    }
    const outcome = planFlipExtenderToTransport({
      phase: phase.value as MovementSegmentPhase,
      kind,
      // 12.7d：翻面代价取延补队**自身印值 MA**（12.7b：印在**战斗面**）
      extenderMa: extender.faces.combat.ma,
      transportRecordId: record.id,
      playerInitiated: true,
    })
    if (!outcome.ok) {
      pushLog('warning', `延补队翻面被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    units.value = units.value.filter((unit) => unit.instanceId !== extender.instanceId)
    units.value = [
      ...units.value,
      toConsoleUnit({
        record,
        instanceId: createId('tp'),
        hex: extender.hex,
        side: activeSide.value,
      }),
    ]
    pushLog(
      'success',
      `${outcome.data.detail}；消耗 ${outcome.data.costMa} MA（12.7d：自身 MA ×½）`,
      outcome.data.rule,
    )
    refreshTraceSupply('12.7d 延补队翻面')
    return true
  }

  /**
   * 9.14d：把延补队**翻面到「常规运输点数的一面」**
   *
   * 「在新的格内，要将延补队翻面到其常规运输点数的一面。」
   * 数据层里这两面是**两条独立的记录**（`ax-extender-truck` ↔ 5 点卡车运输点数），
   * 故"翻面"＝把该算子换成 5 点运输点数的那一枚。12.7a 末句：崩溃的延补队可作为运输点数使用。
   *
   * @returns 是否成功（算子库缺该面额时失败，由调用方决定报错口径）
   */
  function flipExtenderRecordInPlace(unit: ConsoleUnit, hex: HexRef): boolean {
    const kind = (unit.noncombatTransportKind ?? 'truck') as TransportKind
    const record = transportRecordFor(kind, EXTENDER_REQUIRED_POINTS, activeSide.value)
    if (record === null) return false
    units.value = [
      ...units.value.filter((item) => item.instanceId !== unit.instanceId),
      toConsoleUnit({
        record,
        instanceId: createId('tp'),
        hex: { col: hex.col, row: hex.row },
        side: unit.side,
      }),
    ]
    return true
  }

  /**
   * 9.14d：**移动阶段的主动崩溃**（用户裁定：延补队不能移动，崩溃流程替代常规移动）
   *
   * 条文：「**在延补队的常规移动时，玩家也可以选择使用与崩溃相同的流程，替代常规移动**
   *   （这在延补队没有追溯补给时很有用）。将已崩溃的延补队位移到该延补队**特殊拖取距离内**的任意格中，
   *   前提是**该格此时拥有追溯补给**。敌方单位、ZOC 和禁入地形对位移均无影响，且不会产生损失或被夺取。
   *   在新的格内，要将延补队翻面到其常规运输点数的一面。」
   * 「重要提示：如果不存在"合法"格，则**无法进行崩溃**。此时应在原格内不动，将延补队翻面，
   *   让它根据 9.14c 的规则进行夺取的判定。」
   *
   * 判据与被动路径**同源**：候选＝`extenderDisplacementCandidates`（12.7b 距离，无视敌方/ZOC/禁入地形）
   * ∩ 该格有追溯补给；落点由玩家在地图上点选（走既有的 `setSpecialDisplacement` 与 `confirmSpecialCombatNow`）。
   */
  function collapseExtenderNow(extenderId: string): boolean {
    const unit = units.value.find((item) => item.instanceId === extenderId)
    if (unit === undefined || !isExtenderUnit(unit)) {
      pushLog('warning', '请选择一个延补队算子（9.14d）', '9.14d')
      return false
    }
    // 9.14d：主动崩溃发生在「延补队的**常规移动**时」⇒ 三个移动环节内
    if (!['movement', 'reaction', 'exploitation'].includes(phase.value)) {
      pushLog(
        'warning',
        `主动崩溃只在移动环节进行（当前 ${PHASE_LABELS[phase.value]}，9.14d）`,
        '9.14d',
      )
      return false
    }
    const traceSupplyAt = createTraceSupplyAt(supplyFacts.value)
    const withinRange = extenderDisplacementCandidates(
      { hex: unit.hex, rangeMp: unit.faces.combat.ma },
      mapLayers.hexes.map((item) => ({ col: item.col, row: item.row })),
    )
    const legalHexes = withinRange.filter((hex) => traceSupplyAt(hex, unit.side))
    if (legalHexes.length === 0) {
      /*
       * 9.14d 的重要提示：不存在合法格 ⇒ **无法崩溃**，原地不动 + 翻面 + 按 9.14c 判夺取。
       * 夺取判定需要掷骰与勾选（属 9.14c 的交互），故此处翻面并**在日志里明确挂出**该义务。
       */
      if (!flipExtenderRecordInPlace(unit, unit.hex)) {
        pushLog(
          'warning',
          `算子库缺少 ${extenderLabelOf(unit)} 的运输点数面 ⇒ 翻面未落盘（9.14d）`,
          '9.14d',
        )
        return false
      }
      pushLog(
        'warning',
        `${unit.name} 没有合法崩溃落点 ⇒ 留在原格并翻面到运输点数面；**须按 9.14c 进行夺取判定**（9.14d 重要提示）`,
        '9.14d',
      )
      refreshTraceSupply('9.14d 主动崩溃（无合法落点）')
      return true
    }
    specialPending.value = {
      hex: { col: unit.hex.col, row: unit.hex.row },
      enteringSide: unit.side,
      splits: [],
      items: [
        {
          unitId: unit.instanceId,
          label: unit.name,
          kind: 'extender',
          detail: `9.14d 主动崩溃：位移到特殊拖取距离（${unit.faces.combat.ma} MP）内、且该格有追溯补给的任意格`,
          candidates: legalHexes.map((hex) => ({ col: hex.col, row: hex.row })),
          chosen: null,
        },
      ],
      notes: ['9.14d：主动崩溃替代常规移动；落点由拥有者在地图上点选'],
      dice: {},
    }
    pushLog(
      'info',
      `${unit.name} 主动崩溃（9.14d）：${legalHexes.length} 个合法落点，请在地图上点选落点后确认`,
      '9.14d',
    )
    return true
  }

  /** 供日志用的延补队面额名（`ax-extender-truck` → `truck 延补队`） */
  function extenderLabelOf(unit: ConsoleUnit): string {
    return `${unit.noncombatTransportKind ?? 'truck'} 延补队`
  }

  /* ────────── C8f：16.0b/c 环形工事的修建与缩减（＋专规 1.3a 印刷工事） ────────── */

  /**
   * 16.0b/c：逐格「本回合已提升 / 已降低」的账本（键＝`列.行`）
   *
   * 「每格每回合最多 +1 / −1 级」是**按格按回合**的额度，故需单独记账（换回合即清零）。
   */
  const hedgehogTurnLedger = ref<Record<string, { built: number; reduced: number }>>({})

  /**
   * 16.0b/c 的玩家输入（目标格 / 执行作业的单位 / 付款补给站）
   *
   * ★ 只放**两条途径共用**的输入；途径本身与 13.8d 的工程兵另立两个 ref
   *   （见 `hedgehogExecutorMode` / `hedgehogEngineerId`），免得改一处就动一堆字面量。
   */
  const hedgehogInputs = ref<{ hexText: string; workerIds: string[]; payDumpId: string | null }>({
    hexText: '',
    workerIds: [],
    payDumpId: null,
  })

  /**
   * 16.0b/c 的**执行途径**（16.0b 的条文给了两条）
   *
   * 「需要处于**战斗模式的 1RE 的单位**，且不能移动，才能在**自己所在格**修建或改进一个等级的环形工事。
   *   **一个具有工程能力的单位也可以完成这项工作（13.8d）**。」
   *   ⇒ `inPlace` ＝ 目标格内指定的一小队单位（16.0b 的字面途径）；
   *     `engineer` ＝ 具工程能力的单位按 13.8d 在 **2 格步行 MP** 半径内施工（**不必在目标格内**）。
   * ★ 只有 `engineer` 途径受 13.8d 的「**一格一任务**」约束（那句的主语是"具有工程能力的单位"）。
   */
  const hedgehogExecutorMode = ref<'inPlace' | 'engineer'>('inPlace')

  /** 13.8d 途径下被派去施工的工程兵实例 id */
  const hedgehogEngineerId = ref<string | null>(null)
  /** 16.0b/c 的错误（统一形状：rule + reason） */
  const hedgehogError = ref<{ rule: string; reason: string } | null>(null)

  /** 16.0 / 9.9：该格**当前**工事等级（印刷与摆出取高，与战斗路径同口径） */
  function hedgehogLevelOf(hex: HexRef): number {
    return Math.max(printedHedgehogLevelAt(hex), hedgehogLevelAt(units.value, hex))
  }

  /** 专规 1.3a：该格是否为**印刷永久工事**（永久且**不可降低**） */
  function isPrintedHedgehogAt(hex: HexRef): boolean {
    return printedPermanentHedgehogAt(hex)
  }

  /**
   * 专规 1.3a：地图**印刷工事**的清单（数据层 `map-layers.printedHedgehogs`）
   *
   * 供界面逐格查询：16.0 的等级修正与 9.14e 的归属翻转都以「印刷工事视作一类特殊工事单位」处理。
   */
  const printedHedgehogPositions = computed<HexRef[]>(() =>
    mapLayers.printedHedgehogs.map((item) => ({ col: item.col, row: item.row })),
  )

  /** 该方该等级的工事算子记录（本作上限 1 级，故实际只用到 1 级那枚） */
  function hedgehogRecordFor(level: number): UnitRecordView | null {
    return (
      unitChoices(activeSide.value).find(
        (record) => record.noncombatKind === 'hedgehog' && record.noncombatDetails?.level === level,
      ) ?? null
    )
  }

  /** 目标格的工事状态（16.0b/c 的逐格输入） */
  function hedgehogHexState(hex: HexRef) {
    const key = hexLabel(hex)
    const ledger = hedgehogTurnLedger.value[key] ?? { built: 0, reduced: 0 }
    return {
      level: hedgehogLevelOf(hex),
      isPrintedPermanent: isPrintedHedgehogAt(hex),
      levelsBuiltThisTurn: ledger.built,
      levelsReducedThisTurn: ledger.reduced,
    }
  }

  /** 记一次「本回合该格已提升 / 已降低」 */
  function noteHedgehogLedger(hex: HexRef, kind: 'built' | 'reduced'): void {
    const key = hexLabel(hex)
    const current = hedgehogTurnLedger.value[key] ?? { built: 0, reduced: 0 }
    hedgehogTurnLedger.value = {
      ...hedgehogTurnLedger.value,
      [key]:
        kind === 'built'
          ? { ...current, built: current.built + 1 }
          : { ...current, reduced: current.reduced + 1 },
    }
  }

  /**
   * 从**指定的付款站**扣 SP（1 SP = 4 T，12.1a）；未指定即拒
   *
   * ★ 唯一入口：直接委托 `payConstructionFee`（同一套「只能从己方补给站扣」与找零逻辑），
   *   避免 16.0b 与 15.3 各写一份扣款。
   */
  function paySpFromDump(dumpId: string | null, wantSp: number): boolean {
    return payConstructionFee(dumpId, wantSp * SP_TO_T, '16.0b')
  }

  /**
   * 组装 16.0b/c 的执行者（两条途径，按 `hedgehogExecutorMode` 分派）
   *
   * `engineer` 途径需要目标格才能量 13.8d 的**步行 MP** 半径，故本函数收一个目标格。
   */
  function constructionExecutor(target: HexRef): ConstructionExecutor {
    if (hedgehogExecutorMode.value === 'engineer') {
      return engineerExecutorFor(pickedHedgehogEngineer(), target)
    }
    const workers = hedgehogInputs.value.workerIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
    return {
      kind: 'inPlaceUnits',
      units: workers.map((unit) => ({
        id: unit.instanceId,
        re: unit.re,
        mode: unit.mode.mode,
        movedThisPhase: unit.mpSpent > 0,
      })),
    }
  }

  /** 16.0b/c：`engineer` 途径下被派去施工的工程兵（未指定或找不到 ⇒ null） */
  function pickedHedgehogEngineer(): ConsoleUnit | null {
    const id = hedgehogEngineerId.value
    if (id === null) return null
    return units.value.find((unit) => unit.instanceId === id) ?? null
  }

  /** 16.0b/c：本途径**是否**走 13.8d（决定要不要过 13.8d 的公共前提与一格一任务账本） */
  const hedgehogUsesEngineerRoute = computed<boolean>(
    () => hedgehogExecutorMode.value === 'engineer',
  )

  /** 16.0b/c：目标格（未填或格式不合 ⇒ null；目标格的解析只有这一处） */
  const hedgehogTargetHex = computed<HexRef | null>(
    () => parseHexPath(hedgehogInputs.value.hexText)[0] ?? null,
  )

  /** 13.8d 途径下被派去施工的工程兵（未选或找不到 ⇒ null） */
  const hedgehogEngineer = computed<ConsoleUnit | null>(() => pickedHedgehogEngineer())

  /**
   * 13.8d 途径下：工程兵到目标格的**步行 MP** 距离（**无视敌方 ZOC**；上限 2）
   *
   * ★ 一律按**步行价目**量（用户 2026-09-15 裁定：2 格步行 MA 是**专门针对工程能力**的限制，
   *   与 6.2「按该单位自身机动类型取费」不同）——故这里**不**传机动类型。
   * 任一输入缺失 ⇒ null。界面直接显示它，免得把「解析格号」这类事写进模板。
   */
  const hedgehogEngineerLegRange = computed<number | null>(() => {
    const engineer = hedgehogEngineer.value
    const hex = hedgehogTargetHex.value
    if (engineer === null || hex === null) return null
    return constructionLegMpDistance(engineer.hex, hex)
  })

  /** 16.0b/c：把「本阶段不能再移动」落到被指定的单位上（仅这些单位受约束） */
  function markConstructionWorkersImmobile(ids: readonly string[]): void {
    for (const id of ids) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit !== undefined) unit.movementEnded = true
    }
  }

  /**
   * 16.0b：环形工事**修建 / 改进**（+1 级）
   *
   * 硬条件由引擎判（`planHedgehogBuild`）：移动阶段、执行者合格（**两条途径**见下）、该格本回合未
   * 提升过、未达上限（**专规 1.3b：1 级**）、**苏方在专规 2.3e 起始日之前不得修建**、SP 足够（2 SP/级）。
   * 本处负责：换算子（摆出对应等级的工事算子）＋支付 SP ＋把被指定的单位标为"本阶段不能再移动"。
   *
   * ★ 两条途径（16.0b 原文「一个**具有工程能力**的单位也可以完成这项工作（**13.8d**）」）：
   *   · `inPlace`：目标格内指定的一小队单位（RE 合计 ≥ 1、逐员战斗模式、本阶段未移动）；
   *   · `engineer`：具工程能力的单位在 **2 格步行 MP** 半径内施工（**不必在目标格内**），
   *     并额外受 13.8d 的公共前提约束（**一格一任务**、2 格半径、本阶段未移动）。
   */
  function buildHedgehogNow(): boolean {
    if (!requireAction('move.hedgehog', '修建环形工事')) return false
    const hex = parseHexPath(hedgehogInputs.value.hexText)[0]
    if (hex === undefined) {
      pushLog(
        'warning',
        `目标格号应为「列.行」，收到「${hedgehogInputs.value.hexText}」（16.0b）`,
        '16.0b',
      )
      return false
    }
    const engineer = pickedHedgehogEngineer()
    // 13.8d 的公共前提**只对工程兵途径**生效（「一格一任务」那句的主语是"具有工程能力的单位"）
    if (hedgehogUsesEngineerRoute.value) {
      const gate = constructionGateNow('buildHedgehog', engineer)
      if (gate !== null) {
        hedgehogError.value = { rule: gate.rule, reason: gate.reason }
        pushLog('warning', `修建工事被拒（13.8d）：${gate.reason}（${gate.rule}）`, gate.rule)
        return false
      }
    }
    const dump = spDumps.value.find((item) => item.id === hedgehogInputs.value.payDumpId) ?? null
    const outcome = planHedgehogBuild({
      side: activeSide.value,
      date: date.value,
      executor: constructionExecutor(hex),
      hex: hedgehogHexState(hex),
      availableSp: dump === null ? 0 : holdingsToT({ sp: dump.sp, t: dump.t }) / SP_TO_T,
    })
    if (!outcome.ok) {
      hedgehogError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `修建工事被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const record = hedgehogRecordFor(outcome.data.levelAfter)
    if (record === null) {
      pushLog('warning', `算子库没有 ${outcome.data.levelAfter} 级工事算子（16.0b）`, '16.0b')
      return false
    }
    if (!paySpFromDump(hedgehogInputs.value.payDumpId, outcome.data.costSp)) return false
    // 4.8：一格至多 1 个工事 ⇒ 摆出该等级的算子；8.1e/9.14e 的归属随算子
    units.value = [
      ...units.value,
      toConsoleUnit({ record, instanceId: createId('hog'), hex, side: activeSide.value }),
    ]
    markConstructionWorkersImmobile(outcome.data.immobileUnitIds)
    if (hedgehogUsesEngineerRoute.value) noteConstruction('buildHedgehog', hex)
    noteHedgehogLedger(hex, 'built')
    hedgehogError.value = null
    pushLog(
      'success',
      `${outcome.data.detail}；付款站 ${dump === null ? '—' : hexLabel(dump.hex)}` +
        (hedgehogUsesEngineerRoute.value ? `；施工者 ${engineer?.name ?? '—'}（13.8d 途径）` : ''),
      outcome.rule,
    )
    return true
  }

  /**
   * 16.0c：环形工事**缩减**（−1 级；**免费**）
   *
   * ★ **专规 1.3a：印刷永久工事不可降低**（引擎按 `isPrintedPermanent` 拒）；降到 1 级以下即**移除**；
   * 每格每回合最多 −1 级。
   */
  function reduceHedgehogNow(): boolean {
    if (!requireAction('move.hedgehog', '缩减环形工事')) return false
    const hex = parseHexPath(hedgehogInputs.value.hexText)[0]
    if (hex === undefined) {
      pushLog(
        'warning',
        `目标格号应为「列.行」，收到「${hedgehogInputs.value.hexText}」（16.0c）`,
        '16.0c',
      )
      return false
    }
    const engineer = pickedHedgehogEngineer()
    // 13.8d 的公共前提**只对工程兵途径**生效（同 `buildHedgehogNow`）
    if (hedgehogUsesEngineerRoute.value) {
      const gate = constructionGateNow('reduceHedgehog', engineer)
      if (gate !== null) {
        hedgehogError.value = { rule: gate.rule, reason: gate.reason }
        pushLog('warning', `缩减工事被拒（13.8d）：${gate.reason}（${gate.rule}）`, gate.rule)
        return false
      }
    }
    const outcome = planHedgehogReduce({
      executor: constructionExecutor(hex),
      hex: hedgehogHexState(hex),
    })
    if (!outcome.ok) {
      hedgehogError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `缩减工事被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const placed = units.value.find(
      (unit) => sameHex(unit.hex, hex) && unit.noncombatKind === 'hedgehog',
    )
    if (outcome.data.removes) {
      if (placed !== undefined)
        units.value = units.value.filter((unit) => unit.instanceId !== placed.instanceId)
    } else if (placed !== undefined) {
      placed.noncombatLevel = outcome.data.levelAfter
    }
    markConstructionWorkersImmobile(outcome.data.immobileUnitIds)
    if (hedgehogUsesEngineerRoute.value) noteConstruction('reduceHedgehog', hex)
    noteHedgehogLedger(hex, 'reduced')
    hedgehogError.value = null
    pushLog('success', outcome.data.detail, outcome.rule)
    return true
  }

  /* ────────── C8g：15.3/15.4 空军基地 / 15.2A 简易机场（＋13.8d 施工前提） ────────── */

  /**
   * 13.8d：本**移动阶段**已施工过的格与已用过的任务类型
   *
   * 「具有工程能力的单位**只能在一个格内进行建造**，而且**只能进行一种类型**的建造」——
   * 额度按**移动阶段**计，故换阶段 / 换回合 / 换方 / 重置都清零（新的移动环节＝新的额度）。
   */
  const constructionPhaseLedger = ref<{ hexes: string[]; task: ConstructionTask | null }>({
    hexes: [],
    task: null,
  })

  /** 15.3 / 15.2A 的玩家输入（目标格 / 施工的工程单位 / 付款站） */
  const constructionInputs = ref<{
    hexText: string
    engineerId: string | null
    payDumpId: string | null
  }>({ hexText: '', engineerId: null, payDumpId: null })

  /** 15.3 / 15.2A 的错误（统一形状：rule + reason） */
  const constructionError = ref<{ rule: string; reason: string } | null>(null)

  /**
   * 15.3：**空军基地**每格每回合的已提升级数（15.3「等级每回合只能提升一级」）
   *
   * 与 16.0b/c 的 `hedgehogTurnLedger` 同构：按格按回合记账，换回合即清零。
   */
  const airBaseTurnLedger = ref<Record<string, number>>({})

  /**
   * 14.9f / 15.0b-C / 15.2C：本**移动环节**各格**已空运卸载**的 T
   *
   * 「同一个空军基地在每个移动环节中，只能使用**空运**卸载 2T 乘上其**基地等级**的货物量。」
   * 键＝`${side}:${列}.${行}`（基地会换手，故按归属分开记）；换环节/换阶段即清零
   * （`resetSegmentTransient`），与 `refitDoneBaseIds` 同生命周期。
   */
  const airUnloadLedger = ref<Record<string, number>>({})

  /** 14.9f：本格本环节**已**空运卸载的 T（该格此刻无记录即 0） */
  function airUnloadedTAt(hex: HexRef, side: Side): number {
    return airUnloadLedger.value[`${side}:${hexLabel(hex)}`] ?? 0
  }

  /** 13.8a / 5.5b / 5.10e：该单位此刻是否具备工程能力（印值能力 × 模式） */
  function canEngineerInPhase(unit: ConsoleUnit): boolean {
    if (!unit.engineerCapable) return false
    return isLegal(
      checkLegality(
        buildLegalityRequest({
          action: 'engineer',
          unit,
          context: moveContext.value,
          units: units.value,
          date: date.value,
          phase: phase.value,
        }),
      ),
    )
  }

  /** 13.8d：本阶段可派去施工的本方工程单位（模式门槛走 `checkLegality`，不另写判据） */
  const engineerChoices = computed<ConsoleUnit[]>(() =>
    units.value.filter((unit) => unit.side === activeSide.value && canEngineerInPhase(unit)),
  )

  /** 该格上的空中设施算子（4.8：每格至多 1 个空军基地/简易机场） */
  function airBaseUnitAt(hex: HexRef): ConsoleUnit | undefined {
    return units.value.find((unit) => unit.noncombatKind === 'air_base' && sameHex(unit.hex, hex))
  }

  /** 15.2F：该格是否为**简易机场**（口径同 `airBases`：被声明者等级记 0） */
  function isAirstripAt(hex: HexRef): boolean {
    const base = airBaseUnitAt(hex)
    return base !== undefined && airstripBaseIds.value.includes(base.instanceId)
  }

  /** 15.3：该格当前**空军基地**等级（0 ＝ 尚无基地，或该格是简易机场） */
  function airBaseLevelAt(hex: HexRef): number {
    const base = airBaseUnitAt(hex)
    if (base === undefined) return 0
    return airstripBaseIds.value.includes(base.instanceId) ? 0 : base.noncombatLevel
  }

  /** 4.8 / 15.0a：该格是否已有空中设施（空军基地或简易机场 ⇒ 不可再建） */
  function hexHasAirFacility(hex: HexRef): boolean {
    return airBaseUnitAt(hex) !== undefined
  }

  /**
   * 15.3：**加一级**空军基地的 SP 费用（供界面预显；引擎口径）
   *
   * 「费用为 1SP」「等级每回合只能提升一级」⇒ 单次施工恒为一级的价钱，故直接取 1 级的费用。
   */
  const airBaseBuildCostSpPerLevel = airBaseBuildCostSp(1)

  /** 15.0c：该等级的空军基地算子记录（1–3 级各一枚中立算子） */
  function airBaseRecordFor(level: number): UnitRecordView | null {
    return (
      unitChoices(activeSide.value).find(
        (record) => record.noncombatKind === 'air_base' && record.noncombatDetails?.level === level,
      ) ?? null
    )
  }

  /** 13.8d：指定的施工工程单位（未指定或找不到 ⇒ null） */
  function pickedEngineer(): ConsoleUnit | null {
    const id = constructionInputs.value.engineerId
    if (id === null) return null
    return units.value.find((unit) => unit.instanceId === id) ?? null
  }

  /**
   * 13.8d：施工者在**步行 MP** 口径下到目标格的距离（无视敌方 ZOC）
   *
   * ★ 步行价目是**固定口径**（用户 2026-09-15 裁定），与施工者自身机动类型无关，故不传机动类型。
   * `null` = 半径内不可达 ⇒ 交给引擎当作超距（`Number.POSITIVE_INFINITY`）。
   */
  function constructionLegRangeTo(engineer: ConsoleUnit, hex: HexRef): number {
    return constructionLegMpDistance(engineer.hex, hex) ?? Number.POSITIVE_INFINITY
  }

  /**
   * 13.8d：把一名工程兵组装成引擎的 `engineer` 执行者（**唯一组装点**）
   *
   * 15.3/15.2A（空军基地与简易机场）与 16.0b/c 的工程兵途径共用它——四条施工路径若各写一份
   * 「工程能力 / 本阶段是否已移动 / 到目标格的步行 MP 距离」，迟早会有一条忘记更新。
   */
  function engineerExecutorFor(
    engineer: ConsoleUnit | null,
    target: HexRef,
  ): Extract<ConstructionExecutor, { kind: 'engineer' }> {
    return {
      kind: 'engineer',
      engineerCapable: engineer !== null && engineer.engineerCapable,
      unitId: engineer?.instanceId ?? '',
      movedThisPhase: engineer === null || engineer.mpSpent > 0,
      legMpDistanceToTarget: engineer === null ? 0 : constructionLegRangeTo(engineer, target),
    }
  }

  /**
   * 13.8d 的公共前提（阶段 / 工程能力 / 未移动 / **一格一任务**）
   *
   * 唯一实现是引擎的 `validateConstructionBase`；本处只把盘面事实填进去。
   */
  function constructionGateNow(
    task: ConstructionTask,
    engineer: ConsoleUnit | null,
  ): RuleFailure | null {
    return validateConstructionBase({
      phase: phase.value as GamePhase,
      engineerCapable: engineer !== null && engineer.engineerCapable,
      movedThisPhase: engineer === null || engineer.mpSpent > 0,
      hexesThisPhase: constructionPhaseLedger.value.hexes.length,
      task,
      previousTaskThisPhase: constructionPhaseLedger.value.task,
    })
  }

  /** 记一次本阶段施工（13.8d：一格一任务） */
  function noteConstruction(task: ConstructionTask, hex: HexRef): void {
    const key = hexLabel(hex)
    constructionPhaseLedger.value = {
      hexes: constructionPhaseLedger.value.hexes.includes(key)
        ? [...constructionPhaseLedger.value.hexes]
        : [...constructionPhaseLedger.value.hexes, key],
      task,
    }
  }

  /**
   * 13.8d：本次施工任务应付的**吨位**
   *
   * 「所有修建/改进/修理任务都需要消耗 SP。而缩减/伤害任务是**免费**的」——判据只有一处
   * （引擎的 `constructionTaskCostsSp`）：免费任务一律收 0，收费任务按调用方给的计价单位折算
   * （SP 任务 ×4 转 T，15.2A 的简易机场任务本就以 T 计）。
   */
  function constructionFeeT(task: ConstructionTask, costSp: number, costT: number): number {
    if (!constructionTaskCostsSp(task)) return 0
    return costSp > 0 ? costSp * SP_TO_T : costT
  }

  /**
   * 15.3 / 15.2A 的**唯一**扣款入口
   *
   * 取「指定的己方补给站」付款（12.1b/12.3a：只能从己方补给站扣），必要时找零（12.1a）。
   */
  function payConstructionFee(dumpId: string | null, wantT: number, rule: string): boolean {
    if (wantT <= 0) return true
    const dump = spDumps.value.find((item) => item.id === dumpId) ?? null
    if (dump === null) {
      pushLog('warning', '建造费用须由**己方补给站**支付（12.1b/12.3a）⇒ 请先指定付款站', rule)
      return false
    }
    const payment = planSpPayment({ holdings: { sp: dump.sp, t: dump.t }, wantT })
    if (!payment.ok) {
      pushLog(
        'danger',
        `建造付款失败：${payment.reason}（${payment.rule}）——本次不改动任何账本`,
        payment.rule,
      )
      return false
    }
    setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
    return true
  }

  /** 15.3：把该格的设施换成**该等级**的空军基地算子（升级＝换算子；无则新摆） */
  function placeAirBaseOperator(hex: HexRef, level: number): boolean {
    const record = airBaseRecordFor(level)
    if (record === null) {
      pushLog('warning', `算子库没有 ${level} 级空军基地算子（15.0c）`, '15.3')
      return false
    }
    const existing = airBaseUnitAt(hex)
    if (existing !== undefined) {
      // 简易机场升格为空军基地：撤掉简易机场声明（15.2A）
      airstripBaseIds.value = airstripBaseIds.value.filter((id) => id !== existing.instanceId)
      units.value = units.value.filter((unit) => unit.instanceId !== existing.instanceId)
    }
    units.value = [
      ...units.value,
      toConsoleUnit({ record, instanceId: createId('ab'), hex, side: activeSide.value }),
    ]
    return true
  }

  /**
   * 15.3：**修建 / 改进**空军基地（+1 级，1 SP/级）
   *
   * 硬条件由引擎判（`validateConstructionBase` ＋ `planAirBaseBuild`）：移动阶段、施工者具工程能力
   * 且在 2 格**步行 MP** 半径内、本阶段未移动、本格本阶段未施工过、该格每回合最多 +1 级、
   * 未达 3 级上限、SP 足够（1 SP/级）。
   *
   * ★ 与 15.2A 的分工（判读）：**简易机场的升格走 15.2A 的 3 T**，不走本处 1 SP——
   *   15.2A 为简易机场专设了那条价钱，若允许 1 SP 升格会把专条架空。
   */
  function buildAirBaseNow(): boolean {
    // 13.8d / 15.3：修建空军基地只在移动阶段（判据的下半段问引擎）
    if (!requireAction('move.construction', '修建空军基地')) return false
    const hex = parseHexPath(constructionInputs.value.hexText)[0]
    if (hex === undefined) {
      pushLog(
        'warning',
        `目标格号应为「列.行」，收到「${constructionInputs.value.hexText}」（15.3）`,
        '15.3',
      )
      return false
    }
    const engineer = pickedEngineer()
    const gate = constructionGateNow('buildAirBase', engineer)
    if (gate !== null) {
      constructionError.value = { rule: gate.rule, reason: gate.reason }
      pushLog('warning', `修建空军基地被拒：${gate.reason}（${gate.rule}）`, gate.rule)
      return false
    }
    if (isAirstripAt(hex)) {
      constructionError.value = { rule: '15.2A', reason: 'airstripMustUseAirstripUpgrade' }
      pushLog(
        'warning',
        `${hexLabel(hex)} 是**简易机场**：升格为一级空军基地按 15.2A 的 3 T，不适用 15.3 的 1 SP`,
        '15.2A',
      )
      return false
    }
    const dump =
      spDumps.value.find((item) => item.id === constructionInputs.value.payDumpId) ?? null
    const outcome = planAirBaseBuild({
      executor: engineerExecutorFor(engineer, hex),
      currentLevel: airBaseLevelAt(hex),
      levelsBuiltThisTurn: airBaseTurnLedger.value[hexLabel(hex)] ?? 0,
      availableSp: dump === null ? 0 : holdingsToT({ sp: dump.sp, t: dump.t }) / SP_TO_T,
    })
    if (!outcome.ok) {
      constructionError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `修建空军基地被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const feeT = constructionFeeT('buildAirBase', outcome.data.costSp, 0)
    if (!payConstructionFee(constructionInputs.value.payDumpId, feeT, '15.3')) return false
    if (!placeAirBaseOperator(hex, outcome.data.levelAfter)) return false
    if (engineer !== null) engineer.movementEnded = true
    airBaseTurnLedger.value = {
      ...airBaseTurnLedger.value,
      [hexLabel(hex)]: (airBaseTurnLedger.value[hexLabel(hex)] ?? 0) + 1,
    }
    noteConstruction('buildAirBase', hex)
    constructionError.value = null
    pushLog(
      'success',
      `${hexLabel(hex)} ${outcome.data.detail}；付款站 ${dump === null ? '—' : hexLabel(dump.hex)}；` +
        `施工者 ${engineer === null ? '—' : engineer.name} 本阶段不能再移动`,
      outcome.rule,
    )
    return true
  }

  /**
   * 15.2A：**修建简易机场**（1 T）
   *
   * 「按照 15.3 中的流程，它们的建造费用为 1T」⇒ 时机与执行者与 15.3 相同（移动阶段、具工程能力
   * 单位、13.8d 的一格一任务）。本处落盘方式：摆出 1 级基地算子并**声明为简易机场**
   * （本作单位库无独立简易机场算子，口径同 `toggleAirstripBase`）⇒ 整备 1 架 / 激活堆叠 4 /
   * 无防空值 / 永不缩减（15.2B/E）。
   */
  function buildAirstripNow(): boolean {
    const hex = parseHexPath(constructionInputs.value.hexText)[0]
    if (hex === undefined) {
      pushLog(
        'warning',
        `目标格号应为「列.行」，收到「${constructionInputs.value.hexText}」（15.2A）`,
        '15.2A',
      )
      return false
    }
    const engineer = pickedEngineer()
    const gate = constructionGateNow('buildAirstrip', engineer)
    if (gate !== null) {
      constructionError.value = { rule: gate.rule, reason: gate.reason }
      pushLog('warning', `修建简易机场被拒：${gate.reason}（${gate.rule}）`, gate.rule)
      return false
    }
    const dump =
      spDumps.value.find((item) => item.id === constructionInputs.value.payDumpId) ?? null
    const outcome = planAirstripBuild({
      executor: engineerExecutorFor(engineer, hex),
      hexHasAirFacility: hexHasAirFacility(hex),
      availableT: dump === null ? 0 : dump.sp * SP_TO_T + dump.t,
    })
    if (!outcome.ok) {
      constructionError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `修建简易机场被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    if (
      !payConstructionFee(
        constructionInputs.value.payDumpId,
        constructionFeeT('buildAirstrip', 0, outcome.data.costT),
        '15.2A',
      )
    )
      return false
    if (!placeAirBaseOperator(hex, 1)) return false
    const placed = airBaseUnitAt(hex)
    if (placed !== undefined) airstripBaseIds.value = [...airstripBaseIds.value, placed.instanceId]
    if (engineer !== null) engineer.movementEnded = true
    noteConstruction('buildAirstrip', hex)
    constructionError.value = null
    pushLog(
      'success',
      `${hexLabel(hex)} ${outcome.data.detail}；付款站 ${dump === null ? '—' : hexLabel(dump.hex)}`,
      outcome.rule,
    )
    return true
  }

  /**
   * 15.2A：把**简易机场**升级为一级空军基地（3 T）
   *
   * 15.2E 的另一面：简易机场可被升格，但**永不能被缩减**（`canReduceAirstrip` 恒 false）。
   */
  function upgradeAirstripNow(baseId: string): boolean {
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) {
      pushLog('warning', `找不到空中设施 ${baseId}（15.2A）`, '15.2A')
      return false
    }
    const engineer = pickedEngineer()
    const gate = constructionGateNow('upgradeAirstrip', engineer)
    if (gate !== null) {
      constructionError.value = { rule: gate.rule, reason: gate.reason }
      pushLog('warning', `简易机场升格被拒：${gate.reason}（${gate.rule}）`, gate.rule)
      return false
    }
    const dump =
      spDumps.value.find((item) => item.id === constructionInputs.value.payDumpId) ?? null
    const outcome = planAirstripUpgrade({
      executor: engineerExecutorFor(engineer, base.hex),
      hexHasAirstrip: base.isAirstrip === true,
      availableT: dump === null ? 0 : dump.sp * SP_TO_T + dump.t,
    })
    if (!outcome.ok) {
      constructionError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `简易机场升格被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    if (
      !payConstructionFee(
        constructionInputs.value.payDumpId,
        constructionFeeT('upgradeAirstrip', 0, outcome.data.costT),
        '15.2A',
      )
    )
      return false
    // 15.2A：升格＝撤掉简易机场声明并把等级落到 1 级（整备 2 架、有防空值、可再被改进）
    airstripBaseIds.value = airstripBaseIds.value.filter((id) => id !== baseId)
    const target = units.value.find((unit) => unit.instanceId === baseId)
    if (target !== undefined) target.noncombatLevel = outcome.data.levelAfter
    if (engineer !== null) engineer.movementEnded = true
    noteConstruction('upgradeAirstrip', base.hex)
    constructionError.value = null
    pushLog('success', `${hexLabel(base.hex)} ${outcome.data.detail}`, outcome.rule)
    return true
  }

  /*
   * 15.2E：简易机场**永不能被缩减**（伤害或玩家自愿都不行）
   *
   * ★ 判据只有一处：引擎的 `planAirBaseReduction` 在自家 `canReduceAirstrip()` 的分支里就把简易机场
   *   拒掉（`rule: '15.2E'`），操作台经 `airError` 原样显示。操作台**不另建**一份拒绝，免得两处漂移。
   */

  /**
   * 补给网是否会被这个单位影响（12.3b 的投递 HQ、12.7 的延补队都是**源**）
   *
   * 只有这两类单位的摆上/移除/被摧毁才需要重判，避免每次摆子都白算一遍。
   */
  function affectsSupplyNet(unit: ConsoleUnit): boolean {
    return unit.specialized.includes('hq') || isExtenderUnit(unit)
  }

  /** C8：放弃本次补给检查（中止 12.0 流程；已落盘的结算不自动回滚） */
  function cancelSupply(): void {
    clearSupply()
    pushLog('info', '放弃本次补给检查（12.0 流程中止）', '12.0')
  }

  /** C8：来源类别名（12.3a/b、12.6a①②、12.7、12.6c） */
  function supplySourceKindLabel(kind: SupplySourceKind | BaseSourceKind): string {
    switch (kind) {
      case 'dump':
        return '补给站直接拖取（12.3a）'
      case 'hqThrow':
        return '指挥部投递（12.3b）'
      case 'baseSource':
        return '追溯补给源（12.6a）'
      case 'extender':
        return '延补队（12.7）'
      case 'eatOffTheMap':
        return '吃图上补给（12.6c）'
      case 'edgeRail':
        return '地图边缘铁路格（12.6a①）'
      case 'supplySourceHex':
        return '专规补给源格（12.6a①）'
      case 'detrainable':
        return '火车卸货格（12.6a②）'
    }
  }

  /** C8：来源条目文本（日志与界面；距离/「相邻即可」都是引擎给的结论） */
  function supplySourceLabel(source: SupplySourceOption): string {
    const where = source.hex === null ? '' : `${hexLabel(source.hex)} `
    const distance = source.distanceMp === null ? '' : `｜${source.distanceMp} MP`
    const via = source.viaAdjacency ? '｜相邻即可（12.3c）' : ''
    return `${where}${supplySourceKindLabel(source.kind)}${distance}${via}`
  }

  /** C8：12.6 判定结论的中文名 */
  function supplyStatusLabel(status: string): string {
    return SUPPLY_STATUS_LABELS[status] ?? status
  }

  /* ──────────────── C9 空军交互：14.2f 任务 → 15.1 整备 / 14.11 转移 / 15.4 缩减 ──────────────── */

  /** C9：开/关空军工具（开启时清空上一场；基地声明与飞机保留） */
  function setAirActive(on: boolean): void {
    airActive.value = on
    clearAir()
    pushLog('info', on ? '空军工具已开启（14.0 / 15.0 章）' : '空军工具已关闭', '14.0')
  }

  /** C9：清空本次空军交互（飞机与基地声明保留；换方/换阶段/重置/关闭时调用） */
  function clearAir(): void {
    airMissionAirIds.value = []
    airTargetHex.value = null
    airState.value = null
    airError.value = null
    lastRefit.value = null
    lastTransfer.value = null
    lastReduction.value = null
    // 15.1：整备交互的中间态一并收束（选飞机 / 选补给）
    refitTargetBaseId.value = null
    // 保留「天气是否允许飞行」等盘面事实，其余玩家输入复位
    airInputs.value = {
      ...createAirInputs(),
      flyingAllowed: airInputs.value.flyingAllowed,
      weatherNormal: airInputs.value.weatherNormal,
    }
  }

  /** C9：统一收引擎结论（失败即记 `airError` 与日志并返回 null） */
  function acceptAir<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      airError.value = null
      return outcome.data
    }
    airError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /** C9：14.1a 激活状态写盘（整备 ⇒ 激活；返航 ⇒ 非激活） */
  function setAirStatus(instanceId: string, status: AirStatus): void {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air !== undefined) air.airStatus = status
  }

  /** C9：14.1b 军力损失（每机 2 点；损失第二点即摧毁并**移入死亡堆**——与地面单位同一个堆） */
  function applyAirStepLoss(instanceId: string): void {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air === undefined) return
    air.steps -= 1
    if (air.steps > 0) {
      pushLog('warning', `${air.name} 损失 1 点军力（14.1b；现 ${air.steps} 点）`, '14.1b')
      return
    }
    // 与其他淘汰点同一入口：原先这里只把飞机从 airUnits 里滤掉，死亡堆里查不到它
    eliminateEntry(air, '14.1b', `${air.name} 军力归零，移入死亡堆（14.1b）`)
  }

  /** C9：14.2e 标记该机本阶段已执行过任务 */
  function markAirMissionFlown(instanceId: string): void {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air !== undefined) air.missionsFlownThisPhase += 1
  }

  /** C9：手改某机的激活状态（部署/演示用；规则上的转换由整备 15.1 与返航 14.1c 驱动） */
  function toggleAirUnitStatus(instanceId: string): boolean {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air === undefined) return false
    air.airStatus = air.airStatus === 'active' ? 'inactive' : 'active'
    pushLog('info', `${air.name} → ${airStatusLabel(air.airStatus)}`, '14.1a')
    return true
  }

  /** C9：掷 2 骰（14.4e 防空 / 14.3e 拦截空战），并推进 rng 与计数 */
  function drawAir2d6(): number {
    const draw = roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }

  /** C9：掷 1 骰（14.4f 的损失归属骰 / 14.3e-C 的损失骰） */
  function drawAir1d6(): number {
    const draw = roll1d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }

  /** 9.14：掷 1 骰（9.14b/c 夺取表；与其余掷骰同源，走 `state.rng` 可复算） */
  function drawD6(): number {
    const draw = roll1d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }

  /** C9：切任务类型（14.2e；换类型即作废进行中的流程） */
  function setAirMissionKind(kind: AirMissionKind): void {
    airMissionKind.value = kind
    airState.value = null
    airError.value = null
  }

  /** C9：选定任务格（14.2f-B 的目标；输入 `列.行` 文本） */
  function setAirTargetFromText(text: string): boolean {
    const hex = parseHexPath(text)[0] ?? null
    if (hex === null) {
      pushLog('warning', `任务格格号应为「列.行」（如 36.13），收到「${text}」`, '14.2f-B')
      return false
    }
    airTargetHex.value = hex
    airState.value = null
    airError.value = null
    return true
  }

  /**
   * C9：勾选/取消一架参战飞机（14.2a 的合计上限与 14.2f 的加机窗口都由引擎裁定）
   *
   * ★ 四道闸都取引擎的**唯一实现**，不在界面里自算：
   *   · **14.1a** 非激活飞机不能执行任务（`canFlyMission`；用户 2026-09-18 报告第 8 条：
   *     「可执行空军任务的环节时点击机场，**未激活的飞机应该不可选中**」）；
   *   · **14.2f**「步骤 C 之后不能再向任务中添加飞机」（`canAddAircraftAtStep`）；
   *   · **14.2a** 一次任务合计上限 4 个空军单位（`canJoinMission`）；
   *   · **14.2e** 同一机一阶段只执行一次任务（`canPerformMissionThisPhase`）。
   *   取消勾选任何时候都可以（不加飞机不等于加飞机）。
   */
  function toggleAirMissionUnit(instanceId: string): void {
    if (airMissionAirIds.value.includes(instanceId)) {
      airMissionAirIds.value = airMissionAirIds.value.filter((id) => id !== instanceId)
      airState.value = null
      airError.value = null
      return
    }
    const plane = airUnits.value.find((item) => item.instanceId === instanceId)
    /*
     * 14.1a：**非激活飞机不能执行任务** —— 这道闸放在最前：它是"这架飞机此刻的状态"，
     * 与"任务进行到哪一步"（14.2f）和"编成还剩几个名额"（14.2a）无关。非激活要靠 14.1d 的
     * 整备（15.1，A 段）转激活，故这里照 14.1d 指路。
     */
    if (plane !== undefined && !canFlyMission(plane.airStatus)) {
      airError.value = { rule: '14.1a', reason: `aircraftNotActive:${instanceId}` }
      pushLog(
        'warning',
        `14.1a：${plane.name} 处于**非激活**状态 ⇒ 不能执行任务；` +
          `需在**整备阶段**（15.1，A 段）整备后转激活（14.1d）`,
        '14.1a',
      )
      return
    }
    const step = airState.value?.step
    // 14.2f：「步骤 C 之后不能再添加飞机」；已结束（done）当然也不能
    const canAdd = step === undefined ? true : step === 'done' ? false : canAddAircraftAtStep(step)
    if (!canAdd) {
      airError.value = { rule: '14.2f', reason: `cannotAddAircraftAtStep:${String(step)}` }
      pushLog(
        'warning',
        `14.2f：任务已过**移动**步（当前 ${String(step)}）⇒ 不能再添加飞机；如需改变编成请先放弃本次任务并重新宣布`,
        '14.2f',
      )
      return
    }
    /*
     * 14.7d-B（第五批批 C 切片 3）：「低空扫射必须由**单独一个飞机**完成」
     * ⇒ 任务类型为低空扫射时，编成上限 1 架（放在 14.2a 的 4 架上限之前——更具体的限制优先）。
     */
    if (airMissionKind.value === 'hip_shoot' && airMissionAirIds.value.length >= 1) {
      airError.value = { rule: '14.7d-B', reason: 'hipShootMustBeSingleAircraft' }
      pushLog(
        'warning',
        '14.7d-B：低空扫射必须由**单独一个**飞机完成 ⇒ 不能再加机（如需换机请先取消已选）',
        '14.7d-B',
      )
      return
    }
    const join = canJoinMission(airMissionAirIds.value.length, 1)
    if (!join.ok) {
      airError.value = { rule: join.rule, reason: join.reason }
      pushLog(
        'warning',
        `14.2a：一次任务合计上限 4 个空军单位 ⇒ 不能再加（已选 ${airMissionAirIds.value.length} 架）`,
        '14.2a',
      )
      return
    }
    if (plane !== undefined && !canPerformMissionThisPhase(plane.missionsFlownThisPhase)) {
      airError.value = {
        rule: '14.2e',
        reason: `aircraftAlreadyFlewMissionThisPhase:${instanceId}`,
      }
      pushLog('warning', `${plane.name} 本阶段已执行过一次任务（14.2e：一阶段一次）`, '14.2e')
      return
    }
    airMissionAirIds.value = [...airMissionAirIds.value, instanceId]
    airState.value = null
    airError.value = null
  }

  /**
   * C9：14.3d 的**主动返航**（空战前 / 空战后两个窗口，空战中一律不许）
   *
   * 判据只有引擎一处（`canVoluntarilyReturn`）；本处只把「窗口」与「返航后仍留几架激活」
   * 这两项盘面事实填进去。★ 14.3d-A：空战前允许部分返航，但**至少留 1 架**保持激活并战斗。
   */
  function voluntaryReturnNow(aircraftIds: readonly string[]): boolean {
    const state = airState.value
    if (state === null) {
      airError.value = { rule: '14.3d', reason: 'noMissionInProgress' }
      pushLog('warning', '先宣布任务，再谈主动返航（14.3d）', '14.3d')
      return false
    }
    // 14.3d 的窗口由空战步是否已结算推出：未宣告空战 ⇒ 空战前；已结算 ⇒ 空战后；正在打 ⇒ 空战中
    const window: AirCombatWindow =
      state.combat === null
        ? 'beforeAirCombat'
        : state.airCombat === null
          ? 'duringAirCombat'
          : 'afterAirCombat'
    const flying = airMissionAirUnits.value.filter((air) => air.airStatus === 'active')
    const leaving = flying.filter((air) => aircraftIds.includes(air.instanceId))
    const verdict = canVoluntarilyReturn({
      window,
      friendlyActiveRemainingAfterReturn: flying.length - leaving.length,
    })
    if (!verdict.ok) {
      airError.value = { rule: verdict.rule, reason: verdict.reason }
      pushLog('warning', `主动返航被拒：${verdict.reason}（${verdict.rule}）`, verdict.rule)
      return false
    }
    for (const air of leaving) setAirStatus(air.instanceId, 'inactive')
    airError.value = null
    pushLog(
      'success',
      `14.3d（${verdict.rule}）：${leaving.map((air) => air.name).join('、')} 主动返航 ⇒ 转非激活；` +
        `任务内仍留 ${flying.length - leaving.length} 架激活`,
      verdict.rule,
    )
    return true
  }

  /** C9 14.2e：当前任务类型所属的**环节**（移动 / 轰炸 / 拦截步），供界面标注与路由 */
  const airMissionSegment = computed<AirMissionSegment>(() =>
    missionSegmentOf(airMissionKind.value),
  )

  /** C9：本阶段还能加几架（14.2a 的余量；供界面禁用按钮与提示） */
  const airJoinRemaining = computed<number>(() => {
    const limit = canJoinMission(0, 0)
    const max = limit.ok ? limit.data.limit : 0
    return Math.max(0, max - airMissionAirIds.value.length)
  })

  /**
   * B14（用户口径⑪）：**参战机**的算子图阵列数据（逐机给出可选性与原因）
   *
   * 面板原先是一排文字按钮（名字 + ✓），既看不出是哪一枚算子，也看不出**为什么点不动**。
   * 四道闸都用引擎的唯一实现，本处只把结论逐机摊开：
   *   · **14.1a** 激活状态（`canFlyMission`；非激活飞机不能执行任务，需先按 14.1d 整备 15.1）；
   *   · **14.2f** 加机窗口（`canAddAircraftAtStep`；任务过移动步后不能再加）；
   *   · **14.2a** 一次任务合计上限（`canJoinMission`）；
   *   · **14.2e** 同一机一阶段只执行一次任务（`canPerformMissionThisPhase`）。
   * **已选中的恒可点**（取消勾选不受任何闸限制，见 `toggleAirMissionUnit`）。
   *
   * ★ 14.1a 的「起飞机必须停在本方空军基地格」**不在本闸内**：那条在**宣布任务**时
   *   由 `beginAirMissionNow` 经引擎裁定（此处标不了，也不该由界面去猜）。
   */
  const airMissionJoinChoices = computed<readonly AirMissionJoinChoice[]>(() => {
    const step = airState.value?.step
    const canAdd = step === undefined ? true : step === 'done' ? false : canAddAircraftAtStep(step)
    const limit = canJoinMission(0, 0)
    const max = limit.ok ? limit.data.limit : 0
    const selectedCount = airMissionAirIds.value.length
    return ownAirUnits.value.map((air) => {
      const selected = airMissionAirIds.value.includes(air.instanceId)
      const disabledReason = selected
        ? null
        : !canFlyMission(air.airStatus)
          ? '14.1a：非激活飞机不能执行任务（14.1d：需在整备阶段 15.1 整备后才转激活）'
          : !canAdd
            ? `14.2f：任务已过移动步（当前 ${String(step)}）⇒ 不能再加机`
            : airMissionKind.value === 'hip_shoot' && selectedCount >= 1
              ? '14.7d-B：低空扫射必须由**单独一个**飞机完成 ⇒ 已选 1 架'
              : selectedCount >= max
                ? `14.2a：一次任务合计上限 ${max} 架 ⇒ 已满`
                : canPerformMissionThisPhase(air.missionsFlownThisPhase)
                  ? // 条 19（A1）：**按航程列机** —— 已定任务格时，够不到目标格的机在阵列里灰显（14.1）
                    airTargetHex.value !== null &&
                    airRangeFromBase(air, airTargetHex.value) > air.rangeHexes
                    ? '14.1：该机航程够不到任务格'
                    : null
                  : '14.2e：本机本阶段已执行过一次任务'
      return { air, selected, disabledReason }
    })
  })

  /**
   * 条 19（A1）：**按航程**判断——本方是否有**可出击**的飞机够得到目标格
   *
   * 用于「点地面格出空军对话框」的入口闸门（点一格才决定要不要开空军会话）。
   * 判据与 `barrageAirFacts` 的 `inRange` 同源：`airRangeFromBase(air, hex) <= air.rangeHexes`，
   * 另要求 14.1a 的 `canFlyMission`（非激活不出击）。真正航程校验仍在 `beginAirMissionNow`，
   * 此处只判"这一格值不值得开空军入口"。
   */
  function anyOwnAircraftReaches(hex: HexRef): boolean {
    return ownAirUnits.value.some(
      (air) => canFlyMission(air.airStatus) && airRangeFromBase(air, hex) <= air.rangeHexes,
    )
  }

  /** C9 第 1 步（14.2f-A/B）：宣布任务并分配飞机（含起飞基地归属与航程校验） */
  function beginAirMissionNow(): boolean {
    // 14.2e：任务按**环节**分派（移动环节：低空扫射/空运/空投/基地转移/战机扫荡；轰炸环节：空军轰炸/运输破坏）
    if (!requireAction('air.mission', '宣布空军任务')) return false
    const target = airTargetHex.value
    if (target === null) {
      pushLog('warning', '请先填任务格（14.2f-B）', '14.2f-B')
      return false
    }
    const aircraft = airMissionAirUnits.value
    if (aircraft.length === 0) {
      pushLog('warning', '请先勾选参战飞机（14.2f-A）', '14.2f-A')
      return false
    }
    // 14.10d：**每 1T 补给分别掷骰** ⇒ 按 T 逐件建货物；单位货物逐架建
    const cargo: AirMissionCargo[] = []
    for (let index = 0; index < Math.max(0, Math.trunc(airInputs.value.cargoSpT)); index += 1)
      cargo.push({ id: `sp:${index + 1}`, kind: 'sp', t: 1 })
    for (const unitId of airInputs.value.cargoUnitIds) {
      const unit = units.value.find((entry) => entry.instanceId === unitId)
      if (unit === undefined) continue
      cargo.push({
        id: `unit:${unitId}`,
        kind: 'unit',
        isCombat: unit.isCombat,
        paraCapable: airInputs.value.cargoUnitsParaCapable,
        // 14.9c（第五批批 C 切片 2）：单位货物须**移动模式**、且**步行 MP ≤ 10**
        //（本作"步行 MP"＝战斗面印值 MA；判据在引擎 `missionCargoCheck`）
        mode: unit.mode.mode,
        ma: unit.faces.combat.ma,
      })
    }
    const data = acceptAir(
      beginAirInteraction({
        side: activeSide.value,
        phase: phase.value,
        kind: airMissionKind.value,
        targetHex: target,
        flyingAllowed: airInputs.value.flyingAllowed,
        weatherNormal: airInputs.value.weatherNormal,
        /*
         * 专规 1.5：受限飞行 = **天气允许飞行但天气不正常**（能飞，只是受限）
         * ⇒ 仅移动阶段可执行任务（反应 / 进击不可）。两者是不同的事，不得互相替代。
         */
        weatherLimited: airInputs.value.flyingAllowed && !airInputs.value.weatherNormal,
        aircraft: aircraft.map(toAirMissionAircraftView),
        bases: airBases.value,
        cargo,
        // 14.10b：空投战斗单位须有计划（格 / 制定回合 / 执行回合）
        ...(airMissionKind.value === 'air_drop'
          ? {
              airdropPlan: {
                targetHex: target,
                plannedTurn: airInputs.value.airdropPlannedTurn,
                scheduledTurn: airInputs.value.airdropScheduledTurn,
                currentTurn: turn.value,
              },
            }
          : {}),
      }),
      '宣布任务',
    )
    if (data === null) return false
    airState.value = data
    const assignment = data.assignment
    pushLog(
      'info',
      `宣布任务（14.2f-A）：${airMissionKindLabel(data.kind)} → ${hexLabel(target)}；参战 ${assignment.aircraftIds.length} 架` +
        `（最远 ${assignment.maxDistanceHexes} 格${assignment.allWithinShortRange ? '，全在 10 格内 ⇒ 14.7c 短程修正' : ''}）` +
        (assignment.cargoCapacity > 0 ? `；总运力 ${assignment.cargoCapacity} T` : '') +
        (airTransportProfiles.value.length === 0
          ? ''
          : `；逐机飞法 ${airTransportProfiles.value
              .map(
                (item) =>
                  `${item.aircraftId} 档 ${item.profile}${item.capacityMultiplier === 2 ? '（容量×2）' : ''}`,
              )
              .join('、')}（14.9e）`),
      assignment.rule,
    )
    // ⑭ 接线：空军任务宣布与分配（14.2f-A/B）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airMission',
      rule: assignment.rule,
      data: {
        stage: 'declare',
        kind: data.kind,
        targetHex: { ...target },
        aircraftIds: [...assignment.aircraftIds],
        maxDistanceHexes: assignment.maxDistanceHexes,
        allWithinShortRange: assignment.allWithinShortRange,
        cargoCapacity: assignment.cargoCapacity,
      },
    })
    return true
  }

  /**
   * C9 第 2 步（14.2f-C / 14.3 / 14.3e）：空战环节 + **逐轮推进**
   *
   * ★ 归属权：只有任务格内有**敌方**空军基地、且双方在该格都有**激活**飞机时才会发生空战（14.3）；
   * 参战名单由**盘面上实际摆在该格的飞机**推出（不再手工填数字）。
   * 发生空战时立即按 14.3e 逐轮结算（B 点名 → C 掷骰 → 每对一轮直至一方清空），
   * 返航者回基地转**非激活**（14.1c），损失骰命中者扣 1 点军力（14.1b）。
   */
  /**
   * 14.3e-B：把逐轮点名整理成引擎的 `picks` 参数
   *
   * · 下标＝轮次；某轮某侧没点 ⇒ **不给该字段**（引擎按 ACV 最高自动取，14.3e-B 的缺省口径）；
   * · 第 1 轮的守方点位沿用 `namedDefenderId`（14.5 拦截那处"任务方指定迎战机"是同一件事的
   *   另一个入口，两处指向同一架才不会被玩家看成两套）；
   * · 一行都没点 ⇒ 连 `picks` 都不给（保持修前的全自动行为，纯粹不再多传一个空数组）。
   */
  function airCombatPicksPayload():
    | { picks: { attackerAircraftId?: string; defenderAircraftId?: string }[] }
    | Record<string, never> {
    const rows = airInputs.value.airCombatPicks
    const named = airInputs.value.namedDefenderId
    if (rows.every((row) => row.attackerAircraftId === null && row.defenderAircraftId === null)) {
      return named === null ? {} : { picks: [{ defenderAircraftId: named }] }
    }
    return {
      picks: rows.map((row, index) => ({
        ...(row.attackerAircraftId === null ? {} : { attackerAircraftId: row.attackerAircraftId }),
        ...(row.defenderAircraftId === null
          ? index === 0 && named !== null
            ? { defenderAircraftId: named }
            : {}
          : { defenderAircraftId: row.defenderAircraftId }),
      })),
    }
  }

  function confirmAirCombatNow(): boolean {
    const state = airState.value
    if (state === null) return false
    const target = airTargetHex.value
    if (target === null) {
      pushLog('warning', '请先填任务格（14.2f-B）', '14.2f-B')
      return false
    }
    const enemy = enemySide.value
    const friendlyAircraft = airUnitsInHex(target, activeSide.value)
    const enemyAircraft = airUnitsInHex(target, enemy)
    const enemyAirBaseInHex = airBases.value.some(
      (base) => base.side === enemy && sameHex(base.hex, target),
    )
    const data = acceptAir(
      declareAirCombatStep(state, {
        friendlyAircraft: friendlyAircraft.map(toAirMissionAircraftView),
        enemyActiveCount: enemyAircraft.length,
        enemyCanInitiate: enemyAircraft.some((air) => air.canInitiateAirCombat),
        enemyAirBaseInHex,
      }),
      '空战环节',
    )
    if (data === null) return false
    let next = data.state
    const combat = next.combat
    if (combat === null) {
      airState.value = next
      return true
    }
    if (!combat.occurs) {
      airState.value = next
      pushLog('info', `空战环节（14.2f-C）：${combat.roles.detail}`, combat.roles.rule)
      // ⑭ 接线：空战环节未发生（14.3）入会话日志（本笔不掷骰）
      recordSettlement({
        action: 'airCombat',
        rule: combat.roles.rule,
        data: { occurs: false, detail: combat.roles.detail },
      })
      return true
    }

    // 14.3e：逐轮推进（骰面逐轮现掷；种子化 RNG 存于 state.rng）
    const roles = combat.roles
    if (roles.attackerSide === null || roles.defenderSide === null) {
      airState.value = next
      return true
    }
    const ours = roles.attackerSide === activeSide.value
    const attackerViews = (ours ? friendlyAircraft : enemyAircraft).map(toAirMissionAircraftView)
    const defenderViews = (ours ? enemyAircraft : friendlyAircraft).map(toAirMissionAircraftView)
    // ⑭ 接线：drawAir2d6 / drawAir1d6 只回报数字（不改它们）⇒ 先记下掷骰前的骰源，
    // 按同一颗 PRNG 逐轮复算出骰面（14.3e 每对一轮：2 骰 + 1 损失骰）供会话日志复算
    const rngBefore = rng.value
    const dice: { die: number; lossDie: number }[] = []
    const roundBudget = Math.max(1, attackerViews.length + defenderViews.length)
    for (let index = 0; index < roundBudget; index += 1)
      dice.push({ die: drawAir2d6(), lossDie: drawAir1d6() })
    const rolls: DiceRoll[] = []
    let cursor = rngBefore
    for (let index = 0; index < dice.length; index += 1) {
      const dieDraw = roll2d6(cursor)
      cursor = dieDraw.rng
      rolls.push(dieDraw.value)
      const lossDraw = roll1d6(cursor)
      cursor = lossDraw.rng
      rolls.push(lossDraw.value)
    }
    const resolved = acceptAir(
      resolveAirCombatRounds({
        attackerSide: roles.attackerSide,
        attackerAircraft: attackerViews,
        defenderAircraft: defenderViews,
        // 14.3e-B：逐轮点名（见 airCombatPicksPayload；未点名 ⇒ 引擎按 ACV 最高自动取）
        ...airCombatPicksPayload(),
        dice,
      }),
      '空战逐轮',
    )
    if (resolved === null) return false

    // 应用战果：返航者回基地转非激活（14.1c，其 hex 本来就是基地格）；损失骰命中者扣军力（14.1b）
    for (const round of resolved.rounds) {
      for (const id of [...round.returnedAttackerIds, ...round.returnedDefenderIds])
        setAirStatus(id, 'inactive')
      for (const id of round.stepLossIds) applyAirStepLoss(id)
    }
    next = { ...next, airCombat: resolved }
    airState.value = next
    for (const round of resolved.rounds)
      pushLog(round.stepLossIds.length > 0 ? 'warning' : 'info', round.detail, '14.3e')
    pushLog('info', resolved.detail, resolved.rule)
    // ⑭ 接线：空战逐轮（14.3e）入会话日志；rolls＝逐轮的 2 骰 + 1 损失骰（按实际掷骰顺序）
    recordSettlement({
      action: 'airCombat',
      rule: resolved.rule,
      rolls,
      data: {
        occurs: true,
        rounds: resolved.rounds.length,
        detail: resolved.detail,
      },
    })
    return true
  }

  /** C9：该格内某方的**全部**飞机（9.14f 按每架飞机掷夺取表） */
  function airUnitsAt(hex: HexRef, side: Side): ConsoleAirUnit[] {
    return airUnits.value.filter((air) => air.side === side && sameHex(air.hex, hex))
  }

  /** C9：该格内某方的**激活**飞机（14.1a/14.3：非激活飞机不参加空战） */
  function airUnitsInHex(hex: HexRef, side: Side): ConsoleAirUnit[] {
    return airUnitsAt(hex, side).filter((air) => air.airStatus === 'active' && air.steps > 0)
  }

  /**
   * C9 第 5 步（14.2f-F / 14.10d）：空运/空投的成功检定
   *
   * 表 17-4 的两列由**目标格事实**决定：`Friendly` ＝本阶段开始时该格有己方单位；
   * `Clear` ＝ Open/Village，或任何含空军基地的格（`airTransportTerrainIsClosed`）。
   * 单位货物成功 ⇒ 置于空投格且本阶段移动结束；失败 ⇒ 被摧毁（14.10d）。
   */
  function resolveAirCargoNow(): boolean {
    const state = airState.value
    if (state === null) return false
    /*
     * 14.4g：容量因防空变小、还有**未处理的超出货物**时，先让玩家选定摧毁哪几件 ——
     * 否则会拿"已超容的货物清单"去过 14.10d 的检定（等于把本该摧毁的货物也空投下去）。
     */
    if (airCargoLossPending.value !== null) {
      pushLog(
        'warning',
        `14.4g：先处理货物损失（容量 ${airCargoLossPending.value.capacityAfter} T、超出 ${airCargoLossPending.value.excessT} T）再执行货物检定`,
        '14.4g',
      )
      return false
    }
    if (state.step !== 'resolveMission') {
      pushLog('warning', '空投检定在 14.2f 的 F 步（结算任务）进行', '14.2f-F')
      return false
    }
    if (state.kind !== 'air_transport' && state.kind !== 'air_drop') {
      pushLog('warning', `该任务没有货物（${airMissionKindLabel(state.kind)}）`, '14.10d')
      return false
    }
    const target = airTargetHex.value
    const inputs = airInputs.value
    const closedTerrain = airTransportTerrainIsClosed({
      terrainsInHex: target === null ? [] : terrainsAt(target),
      hasAirBase: target !== null && airBases.value.some((base) => sameHex(base.hex, target)),
    })
    // ⑭ 接线：drawAir2d6 只回报数字（不改它）⇒ 先记下掷骰前的骰源，按同一颗 PRNG 逐件复算骰面
    const rngBefore = rng.value
    const dice = state.assignment.cargo.map(() => inputs.cargoDice ?? drawAir2d6())
    const rolls: DiceRoll[] = []
    if (inputs.cargoDice === null) {
      let cursor = rngBefore
      for (let index = 0; index < dice.length; index += 1) {
        const derived = roll2d6(cursor)
        cursor = derived.rng
        rolls.push(derived.value)
      }
    }
    const drop = acceptAir(
      resolveAirCargoDrop({
        cargo: state.assignment.cargo,
        side: state.side,
        friendlyAtPhaseStart: inputs.targetFriendlyAtPhaseStart,
        closedTerrain,
        ...(inputs.gliderLanding ? { glider: true } : {}),
        ...(inputs.optionalTerrainDrm === 0
          ? {}
          : { optionalTerrainDrm: inputs.optionalTerrainDrm }),
        ...(inputs.enemyCombatUnitInTarget ? { enemyCombatUnitInHex: true } : {}),
        dice,
      }),
      '空投检定',
    )
    if (drop === null) return false
    airState.value = { ...state, cargo: drop }

    // 14.10d：单位货物落地或摧毁（SP 货物走下面的"卸载限额 + 落账"，见 14.9f）
    for (const item of drop.items) {
      const unitId = item.id.startsWith('unit:') ? item.id.slice(5) : null
      if (unitId === null) continue
      const unit = units.value.find((entry) => entry.instanceId === unitId)
      if (unit === undefined) continue
      if (item.fate === 'placed' && target !== null) {
        unit.hex = { ...target }
        if (state.kind === 'air_transport') {
          /*
           * 14.9d（第五批批 C 切片 2）：「战斗单位被空运的阶段中，**最多可移动其 MA 的 1/2**……
           *   这可以在空运任务之前或之后进行（或二者皆有），但消耗的 MA 不能超过 1/2」。
           * ⇒ 把本阶段额度**预提**：落地之后还能再花的 ＝ max(0, MA/2 − 已花)。
           *   ★ 主规则（移动阶段）在此落地；反应/进击阶段的 1/4 MA 与"须被释放预备"分支**未实现**（如实登记）。
           *   ★ 空投维持 14.10d 的"本阶段移动结束"（不适用本条）。
           */
          const ma = unit.faces.move.ma
          const allowAfter = Math.max(0, ma / 2 - Math.min(unit.mpSpent, ma / 2))
          unit.mpSpent = ma - allowAfter
          pushLog(
            'info',
            `${unit.name} 空运抵达 ${hexLabel(target)}（14.9d：本阶段合计至多移动 MA 的 1/2 ⇒ 之后还能移 ${String(allowAfter)} MP）`,
            '14.9d',
          )
        } else {
          unit.movementEnded = true
          pushLog(
            'success',
            `${unit.name} 空投着陆于 ${hexLabel(target)}（本阶段移动结束，14.10d）`,
            '14.10d',
          )
        }
        /*
         * 12.6h：「进行计划中的空投（14.10b）的单位，**在被空投那个回合中不需要追溯补给**」
         *   ⇒ 记下被空投的回合；`refreshTraceSupply` 据此豁免该回合的断补判定（跨回合自然失效）。
         *   ★ 只认**空投**（`air_drop`）：14.9 的空运降落在空军基地格，那里本来就有补给链，不属本条。
         */
        if (state.kind === 'air_drop') unit.airDropExemptTurn = turn.value
        // 专规 3.5：空投/空运落地也算"进入该格"（苏方战斗单位进格即毁建造标记）
        noteUnitEnteredHex(unit, target)
        continue
      }
      // 14.10d：空投失败被摧毁 ⇒ 同样进死亡堆（与战斗/轰炸淘汰同一入口）
      eliminateEntry(unit, '14.10d', `${unit.name} 空投失败，被摧毁（14.10d）`)
    }
    /*
     * 14.9f / 15.0b-C / 15.2C：**空运卸载限额 + 落账**
     *
     * 修前这里只打了日志（注释写着"SP 货物只影响账本，由调用方按需处理"），**没有调用方处理**：
     * 空运来的 SP 既不进 SP 账本、也不受 14.9f 的「每基地每移动环节 等级×2T」限制
     * （该常量 `unloadTPerLevelPerPhase` 当时在全库零消费）⇒ 同一基地同一环节可以无限收油。
     * 现在：按引擎 `planAirUnload` 判限额，**允许的部分**落进目的格的 SP 账本（12.1b），
     * 被拒的部分如实报出（不静默吞掉）。空投按 15.0b-C 无上限。
     */
    if (target !== null) {
      const placedSpT = drop.items.filter(
        (item) => item.id.startsWith('sp:') && item.fate === 'placed',
      ).length
      if (placedSpT > 0) {
        const base = airBases.value.find((entry) => sameHex(entry.hex, target))
        const plan = planAirUnload({
          kind: state.kind === 'air_drop' ? 'air_drop' : 'air_transport',
          baseLevel: base?.level ?? 0,
          isAirstrip: base?.isAirstrip === true,
          usedT: airUnloadedTAt(target, state.side),
          cargoT: placedSpT,
          /*
           * 14.9f / 14.9e-A：**超额部分的运输机在目的地变非激活** ⇒ 可以一并卸载。
           * 判据由**飞法**给出（A 档就是"目的地变非激活"），玩家手勾则作为额外的声明手段保留。
           */
          overLimitAircraftInactive:
            inputs.unloadOverLimitInactive || airOverLimitAircraftInactive.value,
        })
        if (plan.ok) {
          const { allowedT, refusedT } = plan.data
          if (allowedT > 0) {
            addSpAtHex({
              hex: target,
              side: state.side,
              sp: 0,
              t: allowedT,
              source: plan.data.rule,
            })
            airUnloadLedger.value = {
              ...airUnloadLedger.value,
              [`${state.side}:${hexLabel(target)}`]: airUnloadedTAt(target, state.side) + allowedT,
            }
          }
          pushLog(refusedT > 0 ? 'warning' : 'info', plan.data.detail, plan.data.rule)
          if (refusedT > 0)
            pushLog(
              'danger',
              `${refusedT} T 空运补给**未卸载**（14.9f：本格本环节上限已满）⇒ 该批货不能进账；` +
                `若要一并卸下，请勾选「超出部分由目的地变非激活的运输机承运」（14.9e-A）`,
              '14.9f',
            )
        } else {
          pushLog('warning', `空运卸载被判拒：${plan.reason}（${plan.rule}）`, plan.rule)
        }
      }
    }
    for (const item of drop.items)
      pushLog(item.fate === 'placed' ? 'info' : 'warning', item.detail, '14.10d')
    pushLog('info', drop.detail, drop.rule)
    // ⑭ 接线：空运/空投成功检定（14.10d）入会话日志；rolls＝逐件货物的 2 骰（按实际掷骰顺序）
    recordSettlement({
      action: 'airCargo',
      rule: drop.rule,
      rolls,
      data: {
        kind: state.kind,
        items: drop.items.map((item) => ({
          id: item.id,
          fate: item.fate,
          detail: item.detail,
        })),
        detail: drop.detail,
      },
    })
    return true
  }

  /**
   * C9：空军基地被夺取（9.14f，表 17-6）
   *
   * 「可攻击单位进入有敌方基地的格 ⇒ 基地被夺取且**可立即使用**；**无论天气**都要为格内**每架飞机**
   *   掷基地夺取表（+2 该机 Active；+2 由**战后推进**夺取）；幸存飞机**必须**转移到**距离 2 倍内**的
   *   任意友方空军基地并**变为非激活**；若 2 倍距离内没有友方基地则**摧毁**这些飞机。」
   *
   * ★ 归属权：夺取方＝该基地归属方的对手；基地算子翻面即改归属（此后本方才能使用它）。
   * 本动作由界面按钮声明「敌方可攻击单位已进入该格」（9.14 的统一前提）。
   */
  function captureAirBaseNow(
    baseId: string,
    /** 9.14f：是否由**战后推进**夺取（+2 DRM）。缺省取界面输入 */
    byAdvance: boolean = airInputs.value.baseCaptureByAdvance,
  ): boolean {
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    const enteringSide: Side = base.side === 'axis' ? 'soviet' : 'axis'
    const planes = airUnits.value.filter(
      (air) => air.side === base.side && sameHex(air.hex, base.hex),
    )
    const inputs = airInputs.value
    const rngBefore = rng.value
    const result = acceptAir(
      resolveSpecialCombat({
        hex: base.hex,
        enteringSide,
        attackCapableUnitEnters: true,
        phase: phase.value,
        objects: [
          {
            id: base.id,
            kind: 'airBase',
            hex: base.hex,
            owner: base.side,
            level: base.isAirstrip === true ? 0 : base.level,
            ...(base.isAirstrip === true ? { isAirstrip: true } : {}),
          },
        ],
        aircraft: planes.map((air) => ({
          id: air.instanceId,
          active: air.airStatus === 'active',
          roll2d6: inputs.baseCaptureDice ?? drawAir2d6(),
        })),
        capturedByAdvanceAfterCombat: byAdvance,
        aircraftEscape: {
          // 14.11：幸存者可转移到**距离 2 倍内**的任意**友方**空军基地
          // ★ 被夺取的这个基地此刻尚未翻面，必须按 id 排除，否则飞机会「留在原地」而免于处置
          friendlyBases: (side) =>
            airBases.value
              .filter((item) => item.side === side && item.id !== base.id)
              .map((item) => item.hex),
          canTransferTo: (aircraftId, baseHexTo) => {
            const air = airUnits.value.find((item) => item.instanceId === aircraftId)
            if (air === undefined) return false
            return resolveBaseTransfer({
              isFighter: isFighterAircraft(air.aircraftType),
              rangeHexes: air.rangeHexes,
              distanceHexes: hexDistance(air.hex, baseHexTo),
            }).ok
          },
        },
      }),
      '基地夺取（9.14f）',
    )
    if (result === null) return false

    // ⑭ 接线：drawAir2d6 只回报数字（不改它）⇒ 按掷骰前骰源逐机复算表 17-6 的骰面
    const rolls: DiceRoll[] = []
    if (inputs.baseCaptureDice === null) {
      let cursor = rngBefore
      for (let index = 0; index < planes.length; index += 1) {
        const derived = roll2d6(cursor)
        cursor = derived.rng
        rolls.push(derived.value)
      }
    }
    // 基地翻面（归属改为进入方）——此后只有该方才能用它（14.1a/14.1c/15.1/15.4）
    const baseUnit = units.value.find((unit) => unit.instanceId === baseId)
    if (baseUnit !== undefined) baseUnit.side = enteringSide
    // 逐机：先按表 17-6 施加军力损失，再转移/摧毁
    for (const item of result.aircraft) {
      if (item.stepLoss) applyAirStepLoss(item.id)
      const air = airUnits.value.find((entry) => entry.instanceId === item.id)
      if (air === undefined) continue
      if (item.fate === 'destroyed') {
        airUnits.value = airUnits.value.filter((entry) => entry.instanceId !== item.id)
        airMissionAirIds.value = airMissionAirIds.value.filter((id) => id !== item.id)
        pushLog('danger', `${air.name} 无处可转（2 倍距离内无友方基地）⇒ 摧毁（9.14f）`, '9.14f')
        continue
      }
      if (item.hex !== null) {
        air.hex = { ...item.hex }
        air.airStatus = 'inactive'
        pushLog('warning', `${air.name} 转移至 ${hexLabel(item.hex)} 并转非激活（9.14f）`, '9.14f')
      }
    }
    pushLog(
      'danger',
      `${hexLabel(base.hex)} 空军基地被 ${enteringSide === 'axis' ? '轴心国' : '苏联'}夺取（9.14f）；` +
        `格内 ${planes.length} 架飞机已按表 17-6 处置`,
      '9.14f',
    )
    // ⑭ 接线：空军基地夺取（9.14f / 表 17-6）入会话日志；rolls＝逐机夺取表骰
    recordSettlement({
      action: 'airBaseCapture',
      rule: '9.14f',
      rolls,
      data: {
        baseHex: { ...base.hex },
        enteringSide,
        byAdvance,
        aircraft: result.aircraft.map((item) => ({
          id: item.id,
          fate: item.fate,
          stepLoss: item.stepLoss,
          hex: item.hex === null ? null : { ...item.hex },
        })),
      },
    })
    return true
  }

  /* ──────────── 9.14 特殊战斗：进入敌方设施格（落点由玩家选择） ──────────── */

  /**
   * 9.14e + 专规 1.3a：地图印刷工事的**当前归属**账本
   *
   * 地图印刷工事在数据层是**地形**（`map-layers.printedHedgehogs`：永久、不可降低），没有算子可翻面；
   * 但 9.14e 要求「可攻击单位进入 ⇒ 工事被夺取」，故须给它一个可变的归属。
   *  - 开局归属由剧本 `setup.printedHedgehogOwners.axisOwned` 给出（缺省＝苏联；剧本 1 全属苏联，
   *    其余剧本按德军推进线推导，见剧本数据里的 `rule` 原文）；
   *  - 本账本只存**与初设不同**的格（键＝`列.行`），9.14e 翻面时写入，避免与剧本数据重复。
   */
  const printedHedgehogOwners = ref<Record<string, Side>>({})

  /** 剧本给出的印刷工事**开局属德军**的格集合（按数值解析 `列.行`，兼容数据里的补零写法如 `07.08`） */
  const printedHedgehogAxisOwnedAtStart = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const text of scenarioSetup.value?.printedHedgehogOwners?.axisOwned ?? []) {
      const hex = parseHexPath(text)[0]
      if (hex === undefined) continue
      keys.add(hexLabel(hex))
    }
    return keys
  })

  /** 9.14e：某格印刷工事的**当前归属**（翻转账本优先 → 剧本初设 → 缺省苏联） */
  function printedHedgehogOwnerAt(hex: HexRef): Side {
    const flipped = printedHedgehogOwners.value[hexLabel(hex)]
    if (flipped !== undefined) return flipped
    return printedHedgehogAxisOwnedAtStart.value.has(hexLabel(hex)) ? 'axis' : 'soviet'
  }

  /**
   * 9.14：把某格的**设施与后勤目标**整理成引擎的对象视图
   *
   * 数据来源（不臆造）：
   *   - 9.14b 补给站 ← SP 账本（12.1b：任何含 SP 的位置都是补给站；T 总量 = SP×4 + T）
   *   - 9.14c 运输点 ← 摆上的 `transport_point` / `organic_truck` 算子（点数取 `noncombatDetails.transport`，
   *     MA 取当前面）；9.14d 延补队 ← `supply_extender` 算子（拖取距离取当前面 MA）
   *   - 9.14e 环形工事 ← `hedgehog` 算子 **与地图印刷工事**（专规 1.3a；归属取剧本账本/9.14e 翻转结果）
   *   - 9.14f 空军基地 ← 空军基地算子（归属见 `airBases`）
   *
   * 舰船/港口本作不存在（专规 1.1c：双方皆无海运额度，港口仅装饰性）。
   */
  function specialObjectsAt(hex: HexRef): SpecialObjectView[] {
    const objects: SpecialObjectView[] = []
    // 9.14b：SP 账本（一方一条）
    for (const dump of spDumps.value) {
      if (!sameHex(dump.hex, hex)) continue
      objects.push({
        id: dump.id,
        kind: 'dump',
        hex: { col: hex.col, row: hex.row },
        owner: dump.side,
        // 12.1a：1 SP = 4 T
        spT: dump.sp * 4 + dump.t,
      })
    }
    // 9.14c/d：运输点与延补队（算子级）
    for (const unit of units.value) {
      if (!sameHex(unit.hex, hex)) continue
      if (unit.noncombatKind === 'transport_point' || unit.noncombatKind === 'organic_truck') {
        objects.push({
          id: unit.instanceId,
          kind: 'transport',
          hex: { col: hex.col, row: hex.row },
          owner: unit.side,
          transportPoints: Math.max(1, unit.noncombatTransport),
          transportMa: unit.raw.ma,
          organic: unit.noncombatKind === 'organic_truck',
          loadedSpT: unit.loadedSpT,
        })
        continue
      }
      if (unit.noncombatKind === 'supply_extender') {
        objects.push({
          id: unit.instanceId,
          kind: 'extender',
          hex: { col: hex.col, row: hex.row },
          owner: unit.side,
          /*
           * 12.7b：延补队的距离＝其**印值 MA**（印在**战斗面**，`faces.combat.ma`）。
           * ★ 此前写的是 `unit.raw.ma`（**当前面**）——延补队若以移动面摆放，`move.ma = 0`
           *   （实测：ax-extender-truck combat.ma=20 / move.ma=0）⇒ 9.14d 的位移半径会被算成 **0**。
           *   与 `toExtenderView`（12.7a-B 的回连判定用它）统一到同一口径。
           */
          rangeMp: unit.faces.combat.ma,
        })
        continue
      }
      if (unit.noncombatKind === 'hedgehog') {
        objects.push({
          id: unit.instanceId,
          kind: 'hedgehog',
          hex: { col: hex.col, row: hex.row },
          owner: unit.side,
          hedgehogLevel: Math.max(1, unit.noncombatLevel),
        })
      }
    }
    // 9.14e：地图印刷工事（专规 1.3a：永久、不可降低；归属取账本）
    const printed = getPrintedHedgehog(hex.col, hex.row)
    if (printed !== null) {
      objects.push({
        id: `printed-hog:${hexLabel(hex)}`,
        kind: 'hedgehog',
        hex: { col: hex.col, row: hex.row },
        owner: printedHedgehogOwnerAt(hex),
        hedgehogLevel: printed.level,
        permanent: true,
      })
    }
    // 9.14f：空军基地
    for (const base of airBases.value) {
      if (!sameHex(base.hex, hex)) continue
      objects.push({
        id: base.id,
        kind: 'airBase',
        hex: { col: hex.col, row: hex.row },
        owner: base.side,
        level: base.isAirstrip === true ? 0 : base.level,
        ...(base.isAirstrip === true ? { isAirstrip: true } : {}),
      })
    }
    return objects
  }

  /** 9.14：待玩家选择的位移/分配（null＝无待决） */
  const specialPending = ref<SpecialCombatPending | null>(null)

  /**
   * 9.14：跑一次「进入敌方设施格」的处置
   *
   * 触发前提（规则原文）：格内有**进入方的可攻击单位**。流程：
   *   ① 整理对象 → ② 掷夺取表骰（种子化 RNG，可复算）→ ③ 引擎给出结论 →
   *   ④ **能立即定的当场落盘**（dump 夺取+摧毁、基地夺取、工事夺取、运输点中**确定被夺取**者翻面）→
   *   ⑤ **需要玩家定的挂起**：运输点组分配（9.14c 混合类型时由原主挑）与**位移落点**（9.14c/d 由原主选）。
   *
   * @param byAdvance 是否由**战后推进**进入（9.14f 的 +2 DRM 来自此）
   */
  function resolveSpecialCombatAt(hex: HexRef, enteringSide: Side, byAdvance = false): boolean {
    const entered = units.value.some(
      (unit) => unit.side === enteringSide && unit.attackCapable && sameHex(unit.hex, hex),
    )
    if (!entered) return false
    const objects = specialObjectsAt(hex)
    // 只处理**敌方**物件（友军进入自家设施无效果，引擎也会返回 unchanged）
    const enemyObjects = objects.filter((item) => item.owner !== enteringSide)
    if (enemyObjects.length === 0) return false

    // ② 掷骰：只给本格实际出现的组掷（掷骰次数可复算）
    // ⑭ 接线：drawD6 只回报数字（不改它）⇒ 先记下掷骰前的骰源，按同一颗 PRNG 复算骰面
    const rngBefore = rng.value
    const dice: { dump?: number; trucks?: number; wagons?: number } = {}
    if (enemyObjects.some((item) => item.kind === 'dump')) {
      dice.dump = drawD6()
    }
    for (const group of ['trucks', 'wagons'] as const) {
      const present = enemyObjects.some(
        (item) => item.kind === 'transport' && transportGroupOf(item.transportMa ?? 0) === group,
      )
      if (!present) continue
      if (group === 'trucks') dice.trucks = drawD6()
      else dice.wagons = drawD6()
    }
    const rolls: DiceRoll[] = []
    let diceCursor = rngBefore
    for (const value of [dice.dump, dice.trucks, dice.wagons]) {
      if (value === undefined) continue
      const derived = roll1d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }

    const mapHexes = mapLayers.hexes.map((item) => ({ col: item.col, row: item.row }))
    /*
     * 9.14d：追溯补给的**覆盖集**按方各算一次（`createTraceSupplyAt` 内按 side 缓存），
     * 整个 9.14 结算只付一次洪泛成本；之后每个候选格都是 O(1) 查表。
     */
    const traceSupplyAt = createTraceSupplyAt(supplyFacts.value)
    const outcome = acceptCombat(
      resolveSpecialCombat({
        hex,
        enteringSide,
        attackCapableUnitEnters: true,
        phase: phase.value,
        objects,
        dice,
        ...(enemyObjects.some((item) => item.kind === 'extender')
          ? {
              extenderCollapse: {
                // 候选池＝图内全部格；引擎再按**各延补队自身**的特殊拖取距离筛（9.14d）
                candidates: mapHexes,
                /*
                 * 9.14d：落点须「**该格此时拥有追溯补给**」。
                 *
                 * 接的是与补给面板**同一份**追溯事实（12.6a①② / 12.3b / 12.6c），机动类型缺省轮式
                 * （12.3a：计数默认按轮式 MP）。
                 *
                 * ★ 为什么这样接不会慢：`createTraceSupplyAt` 内部走 `traceCoverageHexes`——
                 *   **按方各算一次覆盖集**（从全部源反向洪泛一次），之后每格是 O(1) 查表。
                 *   早先直接逐格调 `hasTraceSupply` 会把上千个候选各洪泛一遍全图（5 秒以上、测试超时），
                 *   那是"查询方向"的问题，不是规则的问题；覆盖集与逐格结论的等价性由
                 *   `tests/engine/trace-supply.test.ts` 逐格断言把关。
                 */
                hasTraceSupplyAt: (factHex, factSide) => traceSupplyAt(factHex, factSide),
              },
            }
          : {}),
      }),
      '9.14 特殊战斗',
    )
    if (outcome === null) return false

    /*
     * 12.7 / 9.14d：本场是否发生**延补队崩溃**。延补队本身是补给源，
     * 崩溃后要么位移到新格（源位置变了）、要么原地翻面并按 9.14c 承受夺取判定（源没了），
     * 两种都改变补给网 ⇒ 必须重判全场。
     */
    const collapsedExtenders = outcome.objects.filter((item) => item.kind === 'extender')
    if (collapsedExtenders.length > 0)
      refreshTraceSupply(`延补队崩溃 ×${collapsedExtenders.length}`)

    // ⑭ 接线：9.14 特殊战斗（夺取表 / 工事 / 空军基地 / 运输点 / 延补队）入会话日志。
    // 本笔只含夺取表骰（dump / trucks / wagons）；空军基地的逐机骰由 `captureAirBaseNow` 另记，
    // 故本笔在处置循环之**前**入账，以保证「夺取表骰 → 基地骰」的骰序与日志顺序一致。
    recordSettlement({
      action: 'specialCombat',
      rule: '9.14',
      rolls,
      data: {
        hex: { col: hex.col, row: hex.row },
        enteringSide,
        byAdvance,
        objects: outcome.objects.map((item) => ({
          id: item.id,
          kind: item.kind,
          result: item.result,
        })),
      },
    })

    const pending: SpecialCombatPending = {
      hex: { col: hex.col, row: hex.row },
      enteringSide,
      splits: [],
      items: [],
      notes: [],
      dice,
    }

    for (const result of outcome.objects) {
      if (result.result === 'unchanged') continue
      if (result.kind === 'dump') {
        if (result.result !== 'captured') continue
        // 9.14b：夺取部分并入进入方的账本（本格新建/合并），其余（原文）**被摧毁**
        const dump = spDumps.value.find((item) => item.id === result.id)
        if (dump === undefined) continue
        const capturedT = result.capturedT ?? 0
        if (capturedT > 0) grantSpDumpT(dump.hex, enteringSide, capturedT)
        spDumps.value = spDumps.value.filter((item) => item.id !== dump.id)
        pushLog('warning', `${hexLabel(dump.hex)}：${result.detail}`, '9.14b')
        pending.notes.push(result.detail)
        continue
      }
      if (result.kind === 'transport') {
        const unit = units.value.find((item) => item.instanceId === result.id)
        if (unit === undefined) continue
        const group = outcome.transportGroups.find(
          (item) => item.group === transportGroupOf(unit.raw.ma),
        )
        if (group === undefined) continue
        // 同一组只处理一次（`objects` 里**每个算子各有一条**结果）
        if (pending.splits.some((item) => item.group.group === group.group)) continue
        const ownerSide: Side = enteringSide === 'axis' ? 'soviet' : 'axis'
        const counters = units.value
          .filter(
            (item) =>
              sameHex(item.hex, hex) &&
              item.side === ownerSide &&
              (item.noncombatKind === 'transport_point' ||
                item.noncombatKind === 'organic_truck') &&
              transportGroupOf(item.raw.ma) === group.group,
          )
          .map((item) => ({
            id: item.instanceId,
            label: item.name,
            points: Math.max(1, item.noncombatTransport),
            loadedT: 0,
          }))
        const plan = planTransportSplit({ group, counters })
        const split: SpecialTransportSplit = {
          group,
          ownerSide,
          counters,
          capturedIds: [...plan.capturedUnitIds],
          exact: plan.exact,
          detail: plan.detail,
        }
        // 确定被夺取者**当场翻面**（归属改进入方）；位移者挂起等玩家点落点
        const captured = new Set(split.capturedIds)
        for (const counter of counters) {
          if (captured.has(counter.id)) continue
          pending.items.push({
            unitId: counter.id,
            label: counter.label,
            kind: 'transport',
            detail: `9.14c：本组掷 ${group.die} → ${group.percent}%；被夺取 ${group.capturedPoints}/${group.totalPoints} 点，其余位移`,
            candidates: transportDisplacementCandidates(hex, mapHexes),
            chosen: null,
          })
        }
        pending.splits.push(split)
        applyTransportSplitSides(pending, split)
        pushLog(
          'warning',
          `${hexLabel(hex)} 运输点夺取（9.14c）：掷 ${group.die} → ${group.percent}%；${plan.detail}`,
          '9.14c',
        )
        if (outcome.capturedTransportMayMoveNow) {
          // 9.14c：移动阶段被夺取的运输点**可以立即移动**（其余阶段不行）——同时入日志，
          //   免得「全部被夺取、无位移待决」时这条规则信息随待决一起消失
          const note = '9.14c：移动阶段被夺取的运输点可以立即移动（其余阶段不行）'
          pending.notes.push(note)
          pushLog('info', note, '9.14c')
        }
        continue
      }
      if (result.kind === 'extender') {
        const unit = units.value.find((item) => item.instanceId === result.id)
        if (unit === undefined) continue
        if (result.hex === null) {
          pushLog('warning', `${unit.name}：${result.detail}`, '9.14d')
          pending.notes.push(result.detail)
          continue
        }
        pending.items.push({
          unitId: unit.instanceId,
          label: unit.name,
          kind: 'extender',
          detail: result.detail,
          candidates: result.legalHexes.map((item) => ({ col: item.col, row: item.row })),
          chosen: result.hex === null ? null : { col: result.hex.col, row: result.hex.row },
        })
        continue
      }
      if (result.kind === 'hedgehog') {
        // 9.14e：工事被夺取（算子型按 21.11c 降 1 级；印刷永久工事按专规 1.3a 只翻归属）
        if (result.id.startsWith('printed-hog:')) {
          printedHedgehogOwners.value = {
            ...printedHedgehogOwners.value,
            [hexLabel(hex)]: enteringSide,
          }
        } else {
          const hog = units.value.find((item) => item.instanceId === result.id)
          if (hog !== undefined) {
            hog.side = enteringSide
            hog.noncombatLevel = result.hedgehogLevelAfter ?? Math.max(0, hog.noncombatLevel - 1)
            if (hog.noncombatLevel <= 0) {
              units.value = units.value.filter((item) => item.instanceId !== hog.instanceId)
            }
          }
        }
        pushLog('warning', `${hexLabel(hex)} 环形工事被夺取（9.14e）：${result.detail}`, '9.14e')
        pending.notes.push(result.detail)
        continue
      }
      if (result.kind === 'airBase') {
        captureAirBaseNow(result.id, byAdvance)
        pending.notes.push(result.detail)
      }
    }

    // 有位移/分配待决 ⇒ 挂起等玩家；否则本次 9.14 已结清
    if (pending.items.length > 0 || pending.splits.some((item) => !item.exact)) {
      specialPending.value = pending
    } else {
      specialPending.value = null
    }
    return true
  }

  /** 9.14c：把当前勾选落到算子归属上（被夺取 ⇒ 归进入方；其余 ⇒ 归原主） */
  function applyTransportSplitSides(
    pending: SpecialCombatPending,
    split: SpecialTransportSplit,
  ): void {
    const captured = new Set(split.capturedIds)
    for (const counter of split.counters) {
      const target = units.value.find((item) => item.instanceId === counter.id)
      if (target === undefined) continue
      target.side = captured.has(counter.id) ? pending.enteringSide : split.ownerSide
    }
  }

  /** 9.14c：改「哪些运输点算子被夺取」（原主的选择；点数须与表值相符，允许最接近） */
  function toggleSpecialCaptured(unitId: string): void {
    const pending = specialPending.value
    if (pending === null) return
    pending.splits = pending.splits.map((split) => {
      if (!split.counters.some((item) => item.id === unitId)) return split
      const capturedIds = split.capturedIds.includes(unitId)
        ? split.capturedIds.filter((id) => id !== unitId)
        : [...split.capturedIds, unitId]
      const chosen = new Set(capturedIds)
      const points = split.counters
        .filter((item) => chosen.has(item.id))
        .reduce((sum, item) => sum + item.points, 0)
      const plan = planTransportSplit({ group: split.group, counters: split.counters })
      const next: SpecialTransportSplit = {
        ...split,
        capturedIds,
        exact: points === split.group.capturedPoints,
        detail: `当前勾选：夺取 ${points} 点（表值 ${split.group.capturedPoints} 点）；引擎建议：${plan.detail}`,
      }
      // 归属随勾选即时翻面（9.14c 由拥有者决定哪些被夺取）
      applyTransportSplitSides(pending, next)
      return next
    })
  }

  /** 9.14c/d：为一项位移选定落点（由地图点格传入） */
  function setSpecialDisplacement(unitId: string, hex: HexRef): boolean {
    const pending = specialPending.value
    if (pending === null) return false
    const item = pending.items.find((entry) => entry.unitId === unitId)
    if (item === undefined) return false
    if (!item.candidates.some((candidate) => sameHex(candidate, hex))) {
      pushLog(
        'warning',
        `${hexLabel(hex)} 不是 ${item.label} 的合法位移落点（9.14c：格距上限内任意格；9.14d：拖取距离内且该格有追溯补给）`,
        item.kind === 'extender' ? '9.14d' : '9.14c',
      )
      return false
    }
    item.chosen = { col: hex.col, row: hex.row }
    pushLog(
      'info',
      `${item.label} 位移落点 → ${hexLabel(hex)}（${item.kind === 'extender' ? '9.14d' : '9.14c'}，由拥有者选择）`,
      item.kind === 'extender' ? '9.14d' : '9.14c',
    )
    return true
  }

  /** 9.14：结束本次特殊战斗（把位移落盘；未选落点者留在原格并记录） */
  function confirmSpecialCombatNow(): boolean {
    const pending = specialPending.value
    if (pending === null) return false
    // 9.14c：原主的勾选若拼不出表值（算子规格所限），如实提示差额，由裁判据情处理
    for (const split of pending.splits) {
      if (split.exact) continue
      pushLog(
        'warning',
        `${hexLabel(pending.hex)} ${split.group.group === 'trucks' ? '卡车' : '马车'}组：` +
          `夺取表 ${split.group.capturedPoints} 点，当前勾选 ${split.capturedIds.length} 个算子` +
          `（受算子规格所限取最接近，9.14c）`,
        '9.14c',
      )
    }
    for (const item of pending.items) {
      const unit = units.value.find((entry) => entry.instanceId === item.unitId)
      if (unit === undefined) continue
      if (item.chosen === null) {
        pushLog(
          'warning',
          `${item.label} 未选落点 ⇒ 留在原格（9.14c/d 的位移由拥有者选择；裁判可稍后手工处理）`,
          item.kind === 'extender' ? '9.14d' : '9.14c',
        )
        continue
      }
      if (item.kind === 'extender') {
        /*
         * 9.14d：「在新的格内，要将延补队**翻面到其常规运输点数的一面**。」
         * 数据层两面是两条记录（`ax-extender-truck` ↔ 5 点卡车运输点数）⇒ 翻面＝**换记录**。
         * 此前只写日志、把翻面留给裁判手工标注；现在落盘（12.7a 末句：崩溃的延补队可作为运输点数用）。
         */
        const flipped = flipExtenderRecordInPlace(unit, {
          col: item.chosen.col,
          row: item.chosen.row,
        })
        pushLog(
          flipped ? 'success' : 'warning',
          `${item.label} 崩溃位移至 ${hexLabel(item.chosen)}（9.14d）` +
            (flipped
              ? '，已翻面到运输点数面'
              : `；算子库缺少 ${extenderLabelOf(unit)} 的运输点数面 ⇒ 翻面未落盘`),
          '9.14d',
        )
        continue
      }
      unit.hex = { col: item.chosen.col, row: item.chosen.row }
      pushLog('success', `${item.label} 转移至 ${hexLabel(item.chosen)}（9.14c）`, '9.14c')
    }
    // ⑭ 接线：9.14 待决收束（位移落盘）入会话日志（本笔不掷骰；夺取表骰已在 specialCombat 记账）
    recordSettlement({
      action: 'specialCombat',
      rule: '9.14',
      data: {
        stage: 'confirm',
        hex: { ...pending.hex },
        enteringSide: pending.enteringSide,
        splits: pending.splits.map((split) => ({
          group: split.group.group,
          capturedIds: [...split.capturedIds],
          exact: split.exact,
        })),
        displacements: pending.items.map((item) => ({
          unitId: item.unitId,
          kind: item.kind,
          chosen: item.chosen === null ? null : { ...item.chosen },
        })),
      },
    })
    specialPending.value = null
    return true
  }

  /** 9.14：放弃本次待决（位移不落盘；已即时落盘者不回滚） */
  function cancelSpecialCombatNow(): void {
    if (specialPending.value === null) return
    specialPending.value = null
    pushLog('info', '9.14 待决已关闭（位移未落盘；已定案的夺取不回滚）', '9.14')
  }

  /** C9 第 3 步（14.2f-D / 14.5）：拦截应答（由对手决定，拦与不拦都不违法） */
  function declareInterceptionNow(): boolean {
    const state = airState.value
    if (state === null) return false
    const response = airInterceptionResponse.value
    if (response === null) {
      pushLog('warning', '请先定任务格（14.2f-B）', '14.2f-B')
      return false
    }
    const inputs = airInputs.value
    const data = acceptAir(
      declareInterceptionStep(state, {
        response,
        declared: inputs.interceptDeclared,
        ...(inputs.interceptorId === null ? {} : { interceptorId: inputs.interceptorId }),
      }),
      '拦截应答',
    )
    if (data === null) return false
    airState.value = data.state
    pushLog(
      'info',
      inputs.interceptDeclared
        ? `拦截方宣布拦截（14.5）：1 架战斗机（不强制）`
        : '拦截方放弃拦截（14.5：不强制拦截）',
      '14.5',
    )
    // ⑭ 接线：拦截应答（14.5）入会话日志（本笔不掷骰；空战骰在 resolveInterceptionCombatNow）
    recordSettlement({
      action: 'airIntercept',
      rule: '14.5',
      data: {
        declared: inputs.interceptDeclared,
        interceptorId: inputs.interceptorId,
      },
    })
    return true
  }

  /** C9：结算 14.5 的拦截空战（14.3e 修正骰 + 损失骰），并把战果落到拦截机 */
  function resolveInterceptionCombatNow(): boolean {
    const state = airState.value
    if (state === null || state.interception === null) return false
    const interceptorId = state.interception.interceptorId
    if (interceptorId === null) {
      pushLog('warning', '拦截方没有宣布拦截（14.5）', '14.5')
      return false
    }
    const interceptor = airUnits.value.find((air) => air.instanceId === interceptorId)
    if (interceptor === undefined) return false
    // 14.3e-B：防守方（任务方）从参战机中指定一架迎战；操作台取名单第一架
    /*
     * 14.3e-B：防守方（任务方）从参战机中**指定一架**迎战。
     * ★ B29 修：修前这里写死"名单第一架" —— 与条文不符（那是玩家的选择），现按点名取；
     *   未点名才回落"名单第一架"（引擎对 null 另有"取 ACV 最高"的缺省，此处与之一致）。
     */
    // 14.3e-B / 14.5：迎战机取"点名的那一架，未点名则 ACV 最高"（与引擎缺省同口径）
    const defender = airInterceptionDefender.value ?? undefined
    if (defender === undefined) {
      pushLog('warning', '任务机名单为空（14.3e-B）', '14.3e-B')
      return false
    }
    // ⑭ 接线：drawAir2d6 / drawAir1d6 只回报数字（不改它们）⇒ 记下掷骰前的骰源，按同法复算骰面
    let diceCursor = rng.value
    const die = airInputs.value.interceptDie ?? drawAir2d6()
    const rolls: DiceRoll[] = []
    if (airInputs.value.interceptDie === null) {
      const derived = roll2d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }
    const lossDie = airInputs.value.interceptLossDie ?? drawAir1d6()
    if (airInputs.value.interceptLossDie === null) {
      const derived = roll1d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }
    const data = acceptAir(
      resolveInterception({
        // 14.1b/14.3e：两侧的 ACV 都取**当前面**（减损机用减损面值）
        interceptor: {
          id: interceptor.instanceId,
          airCombatRating: airCombatRatingOf(interceptor),
        },
        defender: { id: defender.instanceId, airCombatRating: airCombatRatingOf(defender) },
        die,
        lossDie,
      }),
      '拦截空战',
    )
    if (data === null) return false
    airState.value = { ...state, interception: { ...state.interception, combat: data } }
    // 14.5：胜 ⇒ 回起飞基地并保持激活；败（含双方返航）⇒ 非激活
    setAirStatus(interceptor.instanceId, data.interceptorAirStatus)
    // 14.3e-C：损失骰 5–6 ⇒ **返航的单位或单位们**各损 1 点军力（双方返航 ⇒ 两机都掉；
    // 修前用三元式只给一边，与引擎 `stepLossIds` 的口径不符）
    if (data.combat.winnerLossRoll === 'step_loss') {
      for (const id of data.stepLossIds) applyAirStepLoss(id)
    }
    pushLog(data.interceptorWon ? 'success' : 'warning', data.detail, '14.5')
    // ⑭ 接线：拦截空战（14.5 / 14.3e）入会话日志；rolls＝2 骰 + 1 损失骰
    recordSettlement({
      action: 'airInterceptCombat',
      rule: '14.5',
      rolls,
      data: {
        interceptorId,
        defenderId: defender.instanceId,
        die,
        lossDie,
        interceptorWon: data.interceptorWon,
        interceptorAirStatus: data.interceptorAirStatus,
        winnerLossRoll: data.combat.winnerLossRoll,
        abortSide: data.combat.abortSide,
        detail: data.detail,
      },
    })
    return true
  }

  /**
   * 14.4f/14.4g：该任务**此刻**的货物容量（T）
   *
   * 按**仍在任务里的飞机**逐机重算：减损者取减损面印值（14.4f「减少后的数值」），
   * 并沿用分配时算定的距离档位（14.9e-C 的容量翻倍按各机在 `origins` 里的距离判定）。
   * 被防空摧毁的飞机已移出任务名单，故它的容量自然消失 —— 这正是 14.4g 的触发条件。
   */
  const airMissionCargoCapacityNow = computed<number>(() => {
    const state = airState.value
    if (state === null) return 0
    const assignment = state.assignment
    return assignment.origins
      .filter((origin) => assignment.aircraftIds.includes(origin.aircraftId))
      .reduce((sum, origin) => {
        const plane = airUnits.value.find((air) => air.instanceId === origin.aircraftId)
        if (plane === undefined) return sum
        const multiplier = airTransportProfile({
          distanceHexes: origin.distanceHexes,
          rangeHexes: origin.rangeHexes,
        }).capacityMultiplier
        return sum + transportCapacityOf(plane) * multiplier
      }, 0)
  })

  /** 14.4g：待玩家选择的**货物损失**（容量因防空变小、有超出部分时才落值） */
  const airCargoLossPending = ref<{
    capacityAfter: number
    allowedT: number
    excessT: number
    detail: string
  } | null>(null)

  /** 14.4g：玩家勾选要摧毁的货物件 */
  const airCargoLossPicked = ref<string[]>([])

  /** 14.4g：勾选/取消一件要摧毁的货物 */
  function toggleAirCargoLossPick(cargoId: string): void {
    airCargoLossPicked.value = airCargoLossPicked.value.includes(cargoId)
      ? airCargoLossPicked.value.filter((id) => id !== cargoId)
      : [...airCargoLossPicked.value, cargoId]
  }

  /**
   * 14.4g：**落盘货物损失**（把选中的货物从任务货物清单里移除）
   *
   * 判据走引擎（`validateCargoLossChoice`：摧毁量必须覆盖超出部分）；落盘只改 `airState` 的货物清单
   * （SP 货物本来就还没进账本，单位货物落地时才动算子），并记留痕。
   */
  function confirmAirCargoLossNow(): boolean {
    const state = airState.value
    const pending = airCargoLossPending.value
    if (state === null || pending === null) return false
    const cargo = state.assignment.cargo.map((item) => ({
      id: item.id,
      t: item.kind === 'sp' ? (item.t ?? 0) : 0,
    }))
    const verdict = validateCargoLossChoice({
      cargo,
      capacityAfter: pending.capacityAfter,
      destroyedIds: airCargoLossPicked.value,
    })
    if (!verdict.ok) {
      pushLog('danger', `货物损失被拒：${verdict.reason}（${verdict.rule}）`, verdict.rule)
      return false
    }
    const destroyed = new Set(airCargoLossPicked.value)
    const kept = state.assignment.cargo.filter((item) => !destroyed.has(item.id))
    airState.value = {
      ...state,
      assignment: { ...state.assignment, cargo: kept },
      cargo: null,
    }
    pushLog(
      'success',
      `14.4g：${verdict.data.detail}；余下 ${String(kept.length)} 件货物继续本任务`,
      '14.4g',
    )
    // ⑭ 接线：货物损失（14.4g）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airCargoLoss',
      rule: '14.4g',
      data: {
        capacityAfter: pending.capacityAfter,
        allowedT: pending.allowedT,
        excessT: pending.excessT,
        destroyedIds: [...destroyed],
        destroyedT: verdict.data.destroyedT,
        remaining: kept.map((item) => item.id),
        detail: verdict.data.detail,
      },
    })
    airCargoLossPending.value = null
    airCargoLossPicked.value = []
    return true
  }

  /** C9 第 4 步（14.2f-E / 14.4）：防空应答（对手掷骰；命中则按 14.4f 的任务损失表定承受者） */
  function resolveFlakNow(): boolean {
    const state = airState.value
    if (state === null) return false
    const inputs = airInputs.value
    const inPatrolZone = airTargetInEnemyPatrolZone.value
    // ⑭ 接线：drawAir2d6 / drawAir1d6 只回报数字（不改它们）⇒ 记下掷骰前的骰源，按同法复算骰面
    let diceCursor = rng.value
    const die2d6 = inputs.flakDie ?? drawAir2d6()
    const rolls: DiceRoll[] = []
    if (inputs.flakDie === null) {
      const derived = roll2d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }
    const lossDie = inputs.lossDie ?? drawAir1d6()
    if (inputs.lossDie === null) {
      const derived = roll1d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }
    const data = acceptAir(
      resolveFlakStep(state, {
        inEnemyPatrolZone: inPatrolZone,
        missionHasFighter: airMissionHasFighter.value,
        missionAircraft: airMissionAirUnits.value.map((air) => ({
          id: air.instanceId,
          // 14.1b/14.4f：任务损失表的 W/S 按**当前面**轰炸值选（减损机用减损面值）
          barrageStrength: airBarrageStrengthOf(air),
        })),
        targetHasHQ: inputs.targetHasHQ,
        targetAirBaseLevel: airTargetBaseLevel.value,
        // 15.2F：简易机场不能提供任何防空值（14.4e 的基地那一项由 15.0b-B 的唯一实现给出）
        targetBaseIsAirstrip: airTargetBaseIsAirstrip.value,
        printedFlakValue: inputs.printedFlakValue,
        // 14.4e：运输破坏在敌方巡逻区内再 +1（与同组修正累计）
        ...(state.kind === 'trainbusting' && inPatrolZone
          ? { trainbustingInPatrolZone: true }
          : {}),
        die2d6,
        lossDie,
      }),
      '防空',
    )
    if (data === null) return false
    airState.value = data.state
    // 14.4f：命中 ⇒ 该任务机损失 1 点军力
    if (data.flak.hit && data.flak.lossAircraftId !== null)
      applyAirStepLoss(data.flak.lossAircraftId)
    /*
     * 14.4g：**运输任务的货容量因防空变化 ⇒ 重算可用装载量、摧毁超出部分（由玩家选择）**。
     *   · 容量按**此刻仍在任务的飞机**重算（被摧毁的已移出、减损的取减损面印值）；
     *   · 取整按**有利于货物存留**（`planCargoLoss` 的 `ceil`，即 14.9b 明写的例外）；
     *   · 有超出部分 ⇒ 落一个**待决**，玩家选完之前 14.2f-F 的货物检定不许进行。
     */
    if (data.flak.hit && (state.kind === 'air_transport' || state.kind === 'air_drop')) {
      /*
       * 载货 T 的口径与装载时的校验**同一份**：只数 SP 货物的 T（`AirMissionCargo.t`）。
       * ★ 边界：**单位货物的运输当量（4.7 的 RE）未计入** —— 引擎装载时的 14.9a 校验也是这么数的
       *   （`air-interaction.ts` 的 `cargoT`），要一并纳入需先让 `AirMissionCargo` 带上单位的 RE，
       *   属另一批的量（已登记进回执的边界）。
       */
      const cargo = data.state.assignment.cargo.map((item) => ({
        id: item.id,
        t: item.kind === 'sp' ? (item.t ?? 0) : 0,
      }))
      const capacityAfter = airMissionCargoCapacityNow.value
      const plan = planCargoLoss({ cargo, capacityAfter })
      if (plan.ok && plan.data.excessT > 0) {
        airCargoLossPending.value = {
          capacityAfter,
          allowedT: plan.data.allowedT,
          excessT: plan.data.excessT,
          detail: plan.data.detail,
        }
        pushLog(
          'warning',
          `14.4g：${plan.data.detail}；请选择要摧毁哪几件货物，之后再执行 14.2f-F 的货物检定`,
          '14.4g',
        )
      }
    }
    pushLog(data.flak.hit ? 'warning' : 'info', data.flak.detail, data.flak.rule)
    // ⑭ 接线：防空应答（14.4e / 14.4f）入会话日志；rolls＝2 骰 + 1 损失骰
    recordSettlement({
      action: 'airFlak',
      rule: data.flak.rule,
      rolls,
      data: {
        kind: state.kind,
        inEnemyPatrolZone: inPatrolZone,
        die2d6,
        lossDie,
        hit: data.flak.hit,
        lossAircraftId: data.flak.lossAircraftId,
        detail: data.flak.detail,
      },
    })
    return true
  }

  /** C9 第 5 步（14.2f-F）：记录任务本身的结果（如 C7 的轰炸结论） */
  /**
   * B29a：**任务格改成点地图选**（14.2f-B；第 12 处"待点格"）
   *
   * 候选＝任意格（任务格本身没有预筛规则：可以是轰炸目标、可以是巡逻区、也可以是空战发生处）。
   */
  function beginAirTargetHexPickNow(): void {
    beginHexPick({
      label: '空军任务的目标格',
      rule: '14.2f-B',
      candidates: 'any',
      apply: (hex) => {
        airInputs.value = { ...airInputs.value, targetHexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /**
   * B29a：**一次把本次空军任务结算到"返航"**（用户口径 2026-09-16 #3）
   *
   * 「空军任务应该点击机场选中飞机或者多选编队后点击目标格再选择可执行任务，**然后自动结算至
   *   各种单位战果结算**，出现空战或者地面单位受损时会有**可能出现的玩家自选**」。
   *
   * 依次调既有单一实现：空战逐轮（14.3）→ 拦截宣布与拦截空战（14.5）→ 防空（14.4）→
   * 任务结算（14.2f-F），**停在返航（14.2f-G）**——那一步要逐机定目的地并改激活状态，值得看一眼。
   * 需要玩家表态的地方（拦截方是否宣布、14.3e-B 点名谁迎战）一律由**面板输入**决定，本函数不替玩家选；
   * 任何一步被拒即就地停下并保留原因。
   */
  /**
   * 14.2f（批 C 切片 1）：**选任务类型即"宣布 + 自动结算到停返航"**
   *
   * 用户口径（9.16 #3）：「空军任务应"点机场选机 → **点目标格** → **选任务类型** → **自动结算**"」
   * ⇒ 选任务类型就是**最后一步玩家输入**：本函数把「宣布任务」（14.2f-A/B）与
   * 「自动结算」（14.3 → 14.5 → 14.4 → 任务结算）合成**一次**动作，停在 `returnToBase`。
   *
   * ★ 不替玩家做表态：14.5 的拦截宣布、14.3e-B 的点名迎战机、14.9/14.10 的货物仍读面板输入
   *   （`autoResolveAirMissionNow` 的既有口径），只把"骰子与查表"那几步连跑。
   * ★ 条件不足时**如实说缺什么**（先点名参战机 / 先选任务格），不静默什么都不做。
   */
  function runAirMissionNow(): boolean {
    if (airState.value === null) {
      if (airMissionAirIds.value.length === 0) {
        pushLog('warning', '先点名参战飞机（14.2a/14.2d：在基地格内勾选）', '14.2a')
        return false
      }
      if (airTargetHex.value === null) {
        pushLog('warning', '先选任务格（14.2f-B：点地图上的目标格）', '14.2f-B')
        return false
      }
      if (!beginAirMissionNow()) return false
    }
    if (airState.value === null) return false
    return autoResolveAirMissionNow()
  }

  /** 14.2f：切任务类型并**接着跑完**（面板的下拉即调用它 —— 选类型是任务分配的最后一步） */
  function runAirMissionWithKind(kind: AirMissionKind): boolean {
    setAirMissionKind(kind)
    return runAirMissionNow()
  }

  function autoResolveAirMissionNow(): boolean {
    const state = airState.value
    if (state === null) return false
    if (state.step === 'airCombat' && !confirmAirCombatNow()) return false
    if (airState.value?.step === 'interception') {
      if (!declareInterceptionNow()) return false
      if (airState.value?.interception?.declared === true && !resolveInterceptionCombatNow()) {
        return false
      }
    }
    if (airState.value?.step === 'flak' && !resolveFlakNow()) return false
    if (airState.value?.step === 'resolveMission') {
      /*
       * ★ G①（用户 2026-09-18 报的第 1 条）：**轰炸/低空扫射任务在 F 步必须真的进轰炸引擎**。
       *   修前这里无条件调 `confirmAirMissionNow()`（只写一条备注就转返航）⇒ 空军轰炸从未结算，
       *   日志每次都是「任务结算（14.2f-F）：（未填结果）」。
       *   裁击/侦察/空运/空投等**没有轰炸结算**的任务仍走原来那条路（只记结果）。
       */
      const kind = airState.value.kind
      if (kind === 'barrage' || kind === 'hip_shoot') {
        if (!beginAirBarrageNow()) return false
        if (!runBarrageChainNow()) return false
        /*
         * 14.2f-F 的"任务结果"由**轰炸结论**填 —— 修前它是面板上一个空备注框，
         * 于是日志每次都是「（未填结果）」（用户报的"每次都显示未正常结算"）。
         */
        const barrage = barrageState.value
        const summary =
          barrage?.outcome === undefined
            ? `${airMissionKindLabel(kind)}：轰炸已结算`
            : `${airMissionKindLabel(kind)}：列 ${barrage.table.initialColumn} → ${barrage.finalColumn}；${barrage.outcome.value.detail}`
        airInputs.value = { ...airInputs.value, missionNote: summary }
        // 轰炸结算完 ⇒ 任务本身收尾（14.2f-F ⇒ 返航）；收束判定交给函数末尾那一句
        if (!confirmAirMissionNow()) return false
      } else if (!confirmAirMissionNow()) {
        return false
      }
    }
    /*
     * ★ 条 13（A2）：低空扫射（hip_shoot）**全自动到返航并变非激活**。
     *   干净扫射（无拦截/无防空损失、战果落定）的返航目的地缺省即起飞基地（14.1c 合法）⇒
     *   自动补完返航步（`completeAirReturnNow` ⇒ 逐机转非激活），不必玩家再点一次「返航」。
     *   若返航确需玩家决策（起飞基地已不可用等）⇒ `completeAirReturnNow` 返 false，停在 returnToBase。
     *   barrage（14.7b 空军轰炸）**不在此列**——仍停 returnToBase 供核对（沿用既有 G① 口径）。
     */
    if (airState.value?.kind === 'hip_shoot' && airState.value?.step === 'returnToBase') {
      if (!completeAirReturnNow()) return false
    }
    return airState.value?.step === 'returnToBase' || airState.value?.step === 'done'
  }

  /**
   * 14.7b / 10.2：**空军轰炸任务**在 14.2f-F（结算任务）步入轰炸结算链
   *
   * 条文依据：10.2a「空军单位**需要放置在目标上**来结算它们的轰炸」；10.0 的通用流程
   * （加总轰炸值 → 定纵列 → 目标玩家选地形横移 → 2 骰 → 结算）对空军轰炸同样适用；
   * 10.2b 短程 +1 列；**10.2c 空军轰炸没有补给消耗**；14.7「最多四个飞机可以参与同一次轰炸」
   * （超限由引擎的 `barrageEligibility` 拦）。
   *
   * ★ 做法：**复用炮兵那条交互链**（`barrageState`：宣布 → 付款 → 横移 → 骰 → 战果），
   *   只把 kind 设成 `'air'`、参炸机对齐到本任务已宣布的编成 —— 于是"结果真的落 CRT"
   *   与炮兵走同一条路径，不另造第二套结算。
   * ★ 闸门照旧留给引擎/统一闸门：本函数只对齐盘面事实，宣布是否合法由 `beginBarrageNow` 判。
   */
  function beginAirBarrageNow(): boolean {
    const state = airState.value
    const target = airTargetHex.value
    if (state === null || target === null) {
      pushLog('warning', '空军轰炸：请先选定任务格（14.2f-B）', '14.2f-B')
      return false
    }
    if (state.step !== 'resolveMission') {
      pushLog(
        'warning',
        `空军轰炸在 14.2f 的 F 步（结算任务）进行，当前步：${state.step}（14.2f-F）`,
        '14.2f-F',
      )
      return false
    }
    /*
     * 14.7b / 14.7d：**空军轰炸与低空扫射**都走 10.2 的轰炸结算（10.0 的通用流程）——
     *   空军轰炸（14.7b）：10.2a 飞机放在目标上结算、10.2c **无补给消耗**、14.7 最多 4 机；
     *   低空扫射（14.7d）：**单机**（14.7d-B）+ 正确观察员（10.0b）+ 不得运输破坏（14.7d-D）。
     * 两者都把 kind 设成 `'air'` 并复用炮兵那条交互链（宣布 → 付款 → 横移 → 骰 → 战果）。
     */
    if (state.kind !== 'barrage' && state.kind !== 'hip_shoot') {
      pushLog(
        'warning',
        `该任务不是空军轰炸（${airMissionKindLabel(state.kind)}）⇒ 不需要轰炸结算（14.7b）`,
        '14.7b',
      )
      return false
    }
    //
    // ★ 批 A 切片 2：对齐的是**轰炸目标格**，不再去改"战斗目标" ——
    //   空军轰炸借战斗工具的选定是修前的耦合（对局台没有工具时就点不出来）。
    barragePickHex.value = { ...target }
    barrageKind.value = 'air'
    barrageUnitIds.value = []
    barrageAirIds.value = [...state.assignment.aircraftIds]
    // 14.7d：低空扫射的标记随任务类型带入（10.0b 的观察员仍由面板声明）
    barrageInputs.value = { ...barrageInputs.value, hipShoot: state.kind === 'hip_shoot' }
    return beginBarrageNow()
  }

  /**
   * 10.0 / 10.2：把**轰炸交互链**一次跑完（宣布 → 补给 → 横移 → 骰 → 战果）
   *
   * 只服务"自动连跑"的调用方（空军任务的 14.2f-F 步）：每一步的拒绝都会立刻返回 false 并把原因留在
   * `barrageError` 与日志里，绝不吞掉。**横移**（10.0a）是**目标玩家**的选择 ⇒ 自动连跑取
   * "不横移"（合法选择之一）；要自己选横移仍走轰炸面板的逐步按钮（验证页）。
   */
  function runBarrageChainNow(): boolean {
    for (let guard = 0; guard < 8; guard += 1) {
      const step = barrageState.value?.step
      if (step === undefined || barrageState.value?.finished === true) break
      const advanced =
        step === 'supply'
          ? confirmBarrageSupplyStep()
          : step === 'shifts'
            ? confirmBarrageShiftsStep()
            : step === 'dice'
              ? rollBarrageDiceStep()
              : step === 'outcome'
                ? confirmBarrageOutcomeStep()
                : false
      if (!advanced) return false
    }
    return barrageState.value?.finished === true
  }

  function confirmAirMissionNow(): boolean {
    const state = airState.value
    if (state === null) return false
    const note = airInputs.value.missionNote
    const data = acceptAir(confirmMissionStep(state, { note }), '任务结算')
    if (data === null) return false
    airState.value = data.state
    pushLog('success', `任务结算（14.2f-F）：${note === '' ? '（未填结果）' : note}`, '14.2f-F')
    // ⑭ 接线：任务结果记录（14.2f-F）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airMissionResolve',
      rule: '14.2f-F',
      data: {
        kind: state.kind,
        aircraftIds: [...state.assignment.aircraftIds],
        note,
      },
    })
    return true
  }

  /** C9 第 6 步（14.2f-G / 14.1c）：返航（逐机指定目的地，须是**本方**基地且在航程内） */
  function completeAirReturnNow(): boolean {
    const state = airState.value
    if (state === null) return false
    /*
     * 14.9e-A（第五批批 C 切片 2）：**双程档机不返航** —— 它「在目的地空军基地变为非激活」
     * ⇒ 不进 returns（引擎对"出现在 returns 里的 A 档机"直接拒，规则号 14.9e-A），
     * 落位由引擎返回的 `stayedAircraftIds` 处理。
     */
    const aProfileIds = new Set(
      airTransportProfiles.value
        .filter((item) => item.profile === 'A')
        .map((item) => item.aircraftId),
    )
    const returns = state.assignment.origins
      .filter((origin) => !aProfileIds.has(origin.aircraftId))
      .map((origin) => {
        const text = airInputs.value.returnHexText[origin.aircraftId]
        const parsed = text === undefined ? null : (parseHexPath(text)[0] ?? null)
        // 未填即回原起飞基地（合法：14.1c 只要求「距离内的一个友方空军基地」）
        return { aircraftId: origin.aircraftId, baseHex: parsed ?? origin.baseHex }
      })
    const data = acceptAir(completeAirReturnStep(state, { returns, bases: airBases.value }), '返航')
    if (data === null) return false
    airState.value = data.state
    // 14.1c：常规任务返航一律变为非激活（例外只给成功拦截的战斗机与正常距离转移的战斗机）
    for (const id of data.inactiveAircraftIds) setAirStatus(id, 'inactive')
    // 14.9e-A：双程档机留在**目的地（任务格）**（引擎已把它列入 inactive 名单）
    const stayHex = airTargetHex.value
    if (data.stayedAircraftIds.length > 0) {
      for (const id of data.stayedAircraftIds) {
        const air = airUnits.value.find((entry) => entry.instanceId === id)
        if (air !== undefined && stayHex !== null) air.hex = { ...stayHex }
      }
      pushLog(
        'info',
        `14.9e-A：${data.stayedAircraftIds.map((id) => nameOf(id)).join('、')} 双程飞法 ⇒ 在目的地变非激活（不返航）`,
        '14.9e-A',
      )
    }
    // 14.2e：本阶段这些飞机已执行过任务
    for (const origin of state.assignment.origins) markAirMissionFlown(origin.aircraftId)
    if (returns.length > 0)
      pushLog(
        'info',
        `返航（14.1c）：${returns.map((item) => `${hexLabel(item.baseHex)}`).join('、')}；均转非激活`,
        '14.1c',
      )
    // ⑭ 接线：任务返航（14.1c）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airReturn',
      rule: '14.1c',
      data: {
        kind: state.kind,
        returns: returns.map((item) => ({
          aircraftId: item.aircraftId,
          baseHex: { ...item.baseHex },
        })),
        inactiveAircraftIds: [...data.inactiveAircraftIds],
      },
    })
    return true
  }

  /** C9：放弃本次任务（中止 14.2f 流程；已落盘的结算不自动回滚） */
  function cancelAir(): void {
    clearAir()
    pushLog('info', '放弃本次空军任务（14.2f 流程中止）', '14.2f')
  }

  /** C9：声明/取消某基地为**简易机场**（15.2；本作单位库无独立算子，故由玩家声明） */
  function toggleAirstripBase(baseId: string): void {
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) return
    if (airstripBaseIds.value.includes(baseId)) {
      airstripBaseIds.value = airstripBaseIds.value.filter((id) => id !== baseId)
      pushLog('info', `${hexLabel(base.hex)} 复为空军基地（15.0：${base.level} 级）`, '15.0')
      return
    }
    airstripBaseIds.value = [...airstripBaseIds.value, baseId]
    pushLog(
      'info',
      `${hexLabel(base.hex)} 声明为简易机场（15.2：整备 1 架、激活堆叠 4、无防空值、永不缩减）`,
      '15.2',
    )
  }

  /**
   * C9 15.1：整备某基地的非激活飞机（容量＝等级×2、费用 1T、每基地每整备阶段一次）
   *
   * @param aircraftIds 本次要整备的**具体飞机**（用户口径：由玩家勾选）；缺省按 `refitCount` 取前 N 架
   * @param payDumpId   付款补给站（用户口径：由玩家在地图上点选）；缺省用输入框里的 / 最近的
   */
  function refitBaseNow(
    baseId: string,
    aircraftIds?: readonly string[],
    payDumpId?: string | null,
  ): boolean {
    if (!requireAction('air.refit', '整备基地飞机')) return false
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    const inactive = airInactiveAtBase.value(baseId)
    const picked =
      aircraftIds !== undefined && aircraftIds.length > 0
        ? inactive.filter((air) => aircraftIds.includes(air.instanceId))
        : inactive
    const requested =
      aircraftIds !== undefined && aircraftIds.length > 0
        ? picked.length
        : Math.max(1, Math.trunc(airInputs.value.refitCount))
    const pays = airRefitPayDumps.value(baseId)
    const wanted = payDumpId !== undefined ? payDumpId : airInputs.value.refitDumpId
    const chosen = pays.find((dump) => dump.id === wanted) ?? pays[0] ?? null
    const data = acceptAir(
      planBaseRefit({
        base: { ...base, refitDoneThisPhase: refitDoneBaseIds.value.includes(baseId) },
        side: activeSide.value,
        phase: phase.value,
        // 15.1B：只把**勾选的那几架**交给引擎 ⇒ 转激活的就是玩家点的那几架
        inactiveAircraft:
          aircraftIds !== undefined && aircraftIds.length > 0
            ? picked.map((air) => ({ id: air.instanceId, side: air.side }))
            : inactive.map((air) => ({ id: air.instanceId, side: air.side })),
        activeAircraftInBase: activeAircraftInBase(allAirViews.value, base.hex),
        requested,
        // 15.1B：1T —— 由引擎判定的可拖取补给站是否付得出（12.3a）
        availableT: chosen !== null && chosen.sp + chosen.t >= 1 ? 1 : 0,
      }),
      '整备',
    )
    if (data === null) return false
    // 15.1B：付 1T（走 12.1a 的统一扣款入口：必要时找零）
    if (chosen !== null && data.costT > 0) {
      const payment = planSpPayment({ holdings: { sp: chosen.sp, t: chosen.t }, wantT: data.costT })
      if (payment.ok) setSpDumpHoldings(chosen.id, payment.data.holdingsAfter)
    }
    for (const id of data.activateAircraftIds) setAirStatus(id, 'active')
    refitDoneBaseIds.value = [...refitDoneBaseIds.value, baseId]
    lastRefit.value = data
    // 收束交互（整备已落盘 ⇒ 不再处于「选飞机 / 选补给」的中间态）
    refitTargetBaseId.value = null
    airInputs.value = { ...airInputs.value, refitAircraftIds: [], refitDumpId: null }
    pushLog(
      'success',
      `${hexLabel(base.hex)} 整备（15.1）：${data.detail}；转为激活 ${data.activateAircraftIds.length} 架`,
      '15.1',
    )
    // ⑭ 接线：基地整备（15.1）入会话日志（本笔不掷骰；1T 费用已在账本扣除）
    recordSettlement({
      action: 'airRefit',
      rule: '15.1',
      data: {
        baseHex: { ...base.hex },
        costT: data.costT,
        activateAircraftIds: [...data.activateAircraftIds],
        detail: data.detail,
      },
    })
    return true
  }

  /* ── 15.1 整备交互（用户口径：点机场的整备按钮 → 勾选飞机 → 点地图上高亮的补给付款） ── */

  /**
   * 打开某基地的整备交互（＝点机场的「整备」按钮）
   *
   * 只建立中间态（选飞机 / 选补给），不落盘；真正结算在点地图上的补给站时（`pickRefitPayDump`）。
   */
  function beginRefitNow(baseId: string): boolean {
    if (!requireAction('air.refit', '整备基地飞机')) return false
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) {
      pushLog('warning', `找不到空军基地 ${baseId}（15.1）`, '15.1')
      return false
    }
    if (base.side !== activeSide.value) {
      pushLog(
        'warning',
        `${hexLabel(base.hex)} 不是本方空军基地：只能在**本方**基地整备（15.1）`,
        '15.1',
      )
      return false
    }
    if (refitDoneBaseIds.value.includes(baseId)) {
      pushLog(
        'warning',
        `${hexLabel(base.hex)} 本阶段已整备（15.1A：每基地每整备阶段一次）`,
        '15.1A',
      )
      return false
    }
    if (airInactiveAtBase.value(baseId).length === 0) {
      pushLog('warning', `${hexLabel(base.hex)} 没有非激活飞机可整备（15.1B）`, '15.1B')
      return false
    }
    refitTargetBaseId.value = baseId
    airInputs.value = { ...airInputs.value, refitAircraftIds: [], refitDumpId: null }
    pushLog(
      'info',
      `整备（15.1）：在 ${hexLabel(base.hex)} 勾选要整备的飞机，再点地图上高亮的补给站付款（1T）`,
      '15.1',
    )
    return true
  }

  /** 勾选 / 取消勾选一架要整备的飞机（15.1B） */
  function toggleRefitAircraft(instanceId: string): void {
    const current = airInputs.value.refitAircraftIds
    const next = current.includes(instanceId)
      ? current.filter((id) => id !== instanceId)
      : [...current, instanceId]
    airInputs.value = { ...airInputs.value, refitAircraftIds: next }
  }

  /** 关掉整备交互（不改盘面、不扣补给） */
  function cancelRefitNow(): void {
    refitTargetBaseId.value = null
    airInputs.value = { ...airInputs.value, refitAircraftIds: [], refitDumpId: null }
  }

  /**
   * 点地图上高亮的补给站 ⇒ 用这个补给站付 1T 并结算整备（15.1B）
   *
   * 与战斗补给付款同一条路（`pickCombatSupplyDump`）：费用一律走 12.3 的补给渠道。
   */
  function pickRefitPayDump(dumpId: string): boolean {
    const baseId = refitTargetBaseId.value
    if (baseId === null) return false
    const selected = airInputs.value.refitAircraftIds
    if (selected.length === 0) {
      pushLog('warning', '请先勾选要整备的飞机（15.1B）', '15.1B')
      return false
    }
    return refitBaseNow(baseId, selected, dumpId)
  }

  /** C9 14.11：把一架飞机转移到另一个**本方**基地（距离可加倍；战斗机在正常距离内保持激活） */
  function transferAircraftNow(instanceId: string): boolean {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air === undefined) return false
    const fromBase = airBases.value.find((base) => sameHex(base.hex, air.hex))
    if (fromBase === undefined) {
      pushLog('warning', `${air.name} 不在空军基地格内（14.1a）`, '14.1a')
      return false
    }
    const toHex = parseHexPath(airInputs.value.transferToHexText)[0] ?? null
    if (toHex === null) {
      pushLog('warning', '转移目的地应为「列.行」（14.11）', '14.11')
      return false
    }
    const toBase = airBases.value.find((base) => sameHex(base.hex, toHex))
    if (toBase === undefined) {
      pushLog('warning', `${hexLabel(toHex)} 没有空军基地（14.11）`, '14.11')
      return false
    }
    const data = acceptAir(
      planBaseTransfer({
        side: activeSide.value,
        aircraft: {
          id: air.instanceId,
          isFighter: isFighterAircraft(air.aircraftType),
          rangeHexes: air.rangeHexes,
        },
        fromBase,
        toBase,
        activeAircraftAtDestination: activeAircraftInBase(allAirViews.value, toHex),
      }),
      '基地转移',
    )
    if (data === null) return false
    air.hex = { ...toHex }
    air.airStatus = data.airStatus
    lastTransfer.value = data
    pushLog('success', `${air.name} ${data.detail}`, '14.11')
    // ⑭ 接线：飞机转移（14.11）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airTransfer',
      rule: '14.11',
      data: {
        aircraftId: air.instanceId,
        toHex: { ...toHex },
        airStatus: data.airStatus,
        detail: data.detail,
      },
    })
    return true
  }

  /**
   * B14（用户口径⑪）：勾选/取消一名**被指定**执行 15.4 基地缩减的单位
   *
   * 15.4 要求缩减「由格内**被指定**的单位执行」（RE 合计 ≥1 或具工程能力，逐员战斗模式且本阶段未移动），
   * 故「指定哪几枚」是玩家的一步操作 —— 原先面板只会一键「取全部候选」，等于替玩家做了决定。
   * 本函数只改输入清单（`airInputs.reductionUnitIds`），合法性仍由引擎的 `planAirBaseReduction` 判。
   */
  function toggleAirReductionUnit(instanceId: string): void {
    const ids = airInputs.value.reductionUnitIds
    airInputs.value.reductionUnitIds = ids.includes(instanceId)
      ? ids.filter((id) => id !== instanceId)
      : [...ids, instanceId]
  }

  /**
   * C9 15.4：缩减某本方基地一级（不耗 SP；被指定单位本阶段不能再移动）
   *
   * ★ 15.2E（简易机场永不缩减）在这一条链里由引擎判：`planAirBaseReduction` 会返回
   *   `15.2E / airstripCannotBeReduced`，经 `airError` 显示给玩家。
   */
  function reduceBaseNow(baseId: string): boolean {
    // 15.4：基地缩减只在移动阶段（判据的下半段由引擎的 canReduceAirBase 给）
    if (!requireAction('air.baseReduce', '缩减空军基地')) return false
    const base = airBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    const target = units.value.find((unit) => unit.instanceId === baseId)
    if (target === undefined) return false
    const selected = airInputs.value.reductionUnitIds
    const operatingUnits = selected
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
      .map((unit) => ({
        id: unit.instanceId,
        re: unit.re,
        mode: unit.mode.mode,
        // 15.4「且不能移动」：本阶段已耗 MP 即视为移动过
        movedThisPhase: unit.mpSpent > 0,
      }))
    const data = acceptAir(
      planAirBaseReduction({
        side: activeSide.value,
        base: { ...base, reducedThisPhase: reducedBaseIds.value.includes(baseId) },
        phase: phase.value,
        operatingUnits,
      }),
      '基地缩减',
    )
    if (data === null) return false
    target.noncombatLevel = data.levelAfter
    for (const id of data.immobileUnitIds) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit !== undefined) unit.movementEnded = true
    }
    reducedBaseIds.value = [...reducedBaseIds.value, baseId]
    lastReduction.value = data
    pushLog('success', `${hexLabel(base.hex)} ${data.detail}`, '15.4')
    // ⑭ 接线：基地缩减（15.4）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airBaseReduce',
      rule: '15.4',
      data: {
        baseHex: { ...base.hex },
        levelAfter: data.levelAfter,
        immobileUnitIds: [...data.immobileUnitIds],
        detail: data.detail,
      },
    })
    return true
  }

  /** C9：任务类型中文名（14.2e） */
  function airMissionKindLabel(kind: string): string {
    return AIR_MISSION_KIND_LABELS[kind] ?? kind
  }

  /** C9：激活状态中文名（14.1a） */
  function airStatusLabel(status: string): string {
    return AIR_STATUS_LABELS[status] ?? status
  }

  /* ────────── W6 B18：到达、补员与编制调整（13.5 / 13.6 / 13.9 / 20.0 / 专规 1.6 / 2.1 / 2.3b / 2.3c / 2.4） ────────── */

  /**
   * 当前剧本
   *
   * ★ 联调（**单一权威**）：剧本号的唯一权威是**会话 store**（`session.scenarioId`，未开局也存在）；
   * 本处只做投影 ⇒ 换剧本 / 读档后，操作台、容器抽取盒、初设面板**同时**跟随，不可能各存一份。
   * 写入请走 `setScenarioId`（它会在剧本被会话锁定时整段拒绝，不做半更新）。
   */
  const scenarioId = computed<string>(() => session.scenarioId)
  /*
   * 13.3f / 专规 1.2：初始换轨账本由**下方 `refreshScenarioBoundLedgers` 的 watch**（`immediate: true`）
   * 统一落账——本处**不再**各写一遍，避免"多入口各自刷新"再次漏掉某一条路径（读档就是漏网的那条）。
   */
  /** 补员账本（13.5：Pax/Eq 可跨回合保存，Ftr/Tac 不可保存） */
  const replHoldings = ref<ReplHoldings>(emptyReplHoldings())
  /**
   * 死亡堆（13.5a 重建来源；**地面与空军共用**——用户裁定，依据 14.1b 飞机亦可重建）
   *
   * ★ 注意与 1.6a 的**移除**区分：被到达卡 Removal 的算子**离开游戏**（不在这里），
   *   见 `removeFromPlayEverywhere`；两者原先被混为一谈（移除也进死亡堆）。
   */
  const deadPile = ref<DeadPileEntry[]>([])
  /** 永久移除（13.5c：AR 后有黄点者被摧毁即永久移出） */
  const removedForever = ref<ConsoleUnit[]>([])
  /**
   * 拆分单位算子池（20.0g：同国籍共用）
   *
   * 初值 = 专规 1.8a 的**印量上限**（轴 28×AR4 + 2×AR5、苏 6×AR2 + 2×AR3，取自工程库
   * `counter_limits`）；键用单位库 id 的国籍前缀（`ax` / `su`，与 `createBreakdownNow` 的取键同规），
   * 裁判可按实物算子增删。
   */
  const breakdownPool = ref<Record<string, number>>({
    ax: breakdownPoolTotal('axis'),
    su: breakdownPoolTotal('soviet'),
  })
  /** 可变增援的骰面（由裁判填入或点「掷」自动取种子化 RNG） */
  const variableReplInputs = ref({
    supplyDice: 7,
    replDice: 7,
    specialDie: 1,
    variableExitDie: 1,
    randomEventDice: 7,
    autoRoll: true,
    /**
     * 3.6 / 可选规则 4.1b：是否启用 4.1b（8 Jul / 12 Jul 自动发生 Supply Train）
     *
     * 缺省 false ＝ 按通规 3.6 走（只有事件期内掷表）；勾上即按可选规则多那两次自动到货。
     */
    option4_1b: false,
  })

  /**
   * 3.3c：可变撤离是否**已了结**
   *
   * 「轴方在 19 August 之后的每个增援阶段掷 1 骰：1 ? 移除 SS Reich（全部）、6 ? 移除 14 Mtr（全部）、
   *  2–5 ? 下回合再掷」⇒ 一旦掷出 1 或 6，该判定**结束**（不再逐回合掷）。
   * 修前这个 `variableExitResolved` 从未被传入 ⇒ 撤离骰可以无限重复掷。
   */
  const variableExitResolved = ref<boolean>(false)

  /** 3.3c：当前是否处于可变撤离的窗口内（19 Aug 起；供界面提示与按钮可用性） */
  const variableExitOpen = computed<boolean>(() => isVariableExitActive(date.value))
  /** 最近一次可变增援结论（1.6b / 1.6c / 3.3c / 3.6） */
  const lastVariableRepl = ref<VariableReinforcementPlan | null>(null)
  /** 最近一次重建结论（13.5） */
  const lastRebuild = ref<RebuildPlan | null>(null)
  /** 最近一次合并结论（13.9） */
  const lastConsolidation = ref<ConsolidationPlan | null>(null)
  /** 最近一次拆分结论（20.0） */
  const lastBreakdown = ref<{ detail: string; rule: string } | null>(null)
  /** B18 的错误（统一形状：rule + reason） */
  const reinforcementError = ref<{ rule: string; reason: string } | null>(null)
  /** 裁判手改的到达落点（键 = 到达需求下标；缺省用引擎解算的格） */
  const arrivalHexOverrides = ref<Record<number, HexRef>>({})

  /**
   * 专规 1.1b：双方**安全边缘格**（作为补给源的地图边格）
   *
   * 「敌方地面单位不得进入；这些格可以被常规战斗攻击，但不可被突袭（因为可能需要推进）。」
   * 数据即剧本的补给源清单（专规 2.1/3.1），按归属分两组给移动上下文。
   *
   * ★ 2.1a：**已关闭的源不再享受 1.1b 保护**——Entry L（19 Jul 起）与 Entry E 及以西南缘源
   *   （19 Aug 起）关闭后若仍计入，会让轴军进不去本应可进的格（过度限制）。
   */
  const safeEdgeHexesBySide = computed(() => {
    const scenario = scenarios.scenarios.find((item) => item.id === scenarioId.value)
    const openSources = (side: Side, list: readonly string[] | undefined): HexRef[] => {
      const hexes = (list ?? [])
        .map((text) => parseHexPath(text)[0])
        .filter((hex): hex is HexRef => hex !== undefined)
      const statuses = supplySourceStatuses({
        side,
        date: date.value,
        sources: hexes,
        facts: SHUTDOWN_FACTS,
      })
      const open = new Set(statuses.filter((item) => item.open).map((item) => hexLabel(item.hex)))
      return hexes.filter((hex) => open.has(hexLabel(hex)))
    }
    return {
      axis: openSources('axis', scenario?.supplySources?.axisLive),
      soviet: openSources('soviet', scenario?.supplySources?.sovietLive),
    }
  })

  /** 当前剧本的补给源格（2.1 / 3.1；按方取 Live 清单） */
  const scenarioSupplySourceHexes = computed<HexRef[]>(() => {
    const scenario = scenarios.scenarios.find((item) => item.id === scenarioId.value)
    const list =
      activeSide.value === 'axis'
        ? (scenario?.supplySources?.axisLive ?? [])
        : (scenario?.supplySources?.sovietLive ?? [])
    return list
      .map((text) => parseHexPath(text)[0])
      .filter((hex): hex is HexRef => hex !== undefined)
  })

  /** 地图边缘格（13.6b 的后备落点）：至少缺一个邻格的图内格 */
  const mapEdgeHexes = computed<HexRef[]>(() => {
    const inside = new Set(mapLayers.hexes.map((hex) => `${hex.col}.${hex.row}`))
    return mapLayers.hexes
      .filter((hex) =>
        HEX_DIRECTIONS.some((direction) => {
          const candidate = neighbor({ col: hex.col, row: hex.row }, direction)
          return !inside.has(`${candidate.col}.${candidate.row}`)
        }),
      )
      .map((hex) => ({ col: hex.col, row: hex.row }))
  })

  /** 13.6 / 13.6b 的落点事实（引擎不持地图，故由操作台注入） */
  const arrivalFacts = computed<ArrivalPlacementFacts>(() => ({
    entryHexes: (letter) => (mapConfig.entryHexes?.[letter] ?? []).map((hex) => ({ ...hex })),
    isBlocked: (hex) =>
      units.value.some(
        (unit) => unit.side !== activeSide.value && sameHex(unit.hex, hex) && unit.steps > 0,
      ),
    nearestOpenEdgeHex: (from) => {
      const open = mapEdgeHexes.value.filter(
        (hex) =>
          !units.value.some(
            (unit) => unit.side !== activeSide.value && sameHex(unit.hex, hex) && unit.steps > 0,
          ),
      )
      if (open.length === 0) return null
      return [...open].sort((a, b) => hexDistance(from, a) - hexDistance(from, b))[0]!
    },
    friendlyAirBaseHexes: () =>
      airBases.value
        .filter((base) => base.side === activeSide.value)
        .map((base) => ({ ...base.hex })),
    directDrawHqHexes: () =>
      units.value
        .filter(
          (unit) =>
            unit.side === activeSide.value &&
            (unit.specialized.includes('hq') || unit.throwRange !== null),
        )
        .map((unit) => ({ ...unit.hex })),
    edgeSupplySourceHexes: () => scenarioSupplySourceHexes.value.map((hex) => ({ ...hex })),
    westEdgeHexes: () =>
      mapEdgeHexes.value.filter((hex) => isWestEdge(hex)).map((hex) => ({ ...hex })),
    // 北缘＝没有图内北邻（曾用「行号 ≥ 上界 − 1」的近似：多算 52 格、漏 10 格削角北缘）
    isNorthEdge: (hex) => isNorthEdge(hex),
  }))

  /* ────────────────── 批 F 切片 3：到货 SP 的落点（专规 2.1 / 3.1 免费铁运 + 3.6） ────────────────── */

  /**
   * 可卸载**城市**格的**静态**清单（专规 2.1/3.1 的免费铁运只适用城市格）
   *
   * 判据取两样静态事实（都与 13.3c 的第一条同源）：
   *   ① `map-layers.json` 的 `city.level` ∈ {Minor City, Major City}（**村庄不在内** —— 原文写的是
   *      "每个**可卸载城市格**"，村庄虽也是 13.3c 可卸货格，但不吃免费铁运）；
   *   ② 该格**格内有铁路**（13.3c 首句就是 "A **railroad hex** is detrainable…"）——
   *      斯摩棱斯克 34.17 是城市但格内无铁路，故按原文不是可卸货格。
   * 与工程库 `detrainable_hexes.json → free_rail_cap_city=true` 的 9 格逐格一致（用例钉住）。
   *
   * ★ 这只是**静态**筛选；真正能不能放，还要过运行期的 13.3c（受控 / 免 EZOC 铁路路径回补给源）
   *   —— 见下面的 `freeRailCityCandidates`，判据只有 `rail-supply` 那一处，不另立。
   */
  const freeRailCityHexes = computed<FreeRailCandidate[]>(() => {
    const railKeys = new Set<string>()
    for (const edge of mapLayers.edges) {
      if (edge.rail !== true) continue
      railKeys.add(`${edge.a.col}.${edge.a.row}`)
      railKeys.add(`${edge.b.col}.${edge.b.row}`)
    }
    return mapLayers.hexes
      .filter(
        (hex) =>
          hex.city !== undefined &&
          /City/.test(hex.city.level ?? '') &&
          railKeys.has(`${hex.col}.${hex.row}`),
      )
      .map((hex) => ({ hex: { col: hex.col, row: hex.row }, name: hex.city?.name ?? '' }))
  })

  /** 运行期的免费铁运候选＝静态城市格 ∩ 13.3c 的可卸货格（判据同一处：`railSupply`） */
  const freeRailCityCandidates = computed<FreeRailCandidate[]>(() => {
    const detrainable = new Set(detrainableHexes.value.map((hex) => hexLabel(hex)))
    return freeRailCityHexes.value.filter((item) => detrainable.has(hexLabel(item.hex)))
  })

  /** 玩家勾选的免费铁运格（每格 1 SP；换段/落账后清空） */
  const freeRailPicked = ref<HexRef[]>([])
  /** 余额的落点：图边补给源格（缺省取本剧本本方源清单的第一格） */
  const freeRailEdgeHex = ref<HexRef | null>(null)
  /** 落账用的到货 SP 总数（补给表掷出后自动填；裁判也可手改） */
  const supplyArrivalSp = ref<number>(0)
  /** 3.6 补给列车的落点（任一可卸货格；有额外 SP 时必填） */
  const supplyTrainHex = ref<HexRef | null>(null)
  /** 最近一次落账结论（供界面回显） */
  const lastFreeRailPlan = ref<FreeRailPlan | null>(null)
  /** 落账的拒绝原因（rule + reason，与补给/重建同形状） */
  const freeRailError = ref<{ rule: string; reason: string } | null>(null)

  /** 3.6：本回合补给列车给的额外 SP（未掷或非该结果即 0） */
  const supplyTrainSp = computed<number>(() =>
    lastVariableRepl.value?.randomEvent?.kind === 'supplyTrain'
      ? (lastVariableRepl.value.randomEvent.sp ?? 0)
      : 0,
  )

  /** 免费铁运的落点计划（引擎判据；非法即 null，原因在 `freeRailError`） */
  const freeRailPlan = computed<FreeRailPlan | null>(() => {
    const outcome = planFreeRailArrivals({
      sp: Math.max(0, Math.trunc(supplyArrivalSp.value)),
      candidates: freeRailCityCandidates.value,
      detrainableHexes: detrainableHexes.value,
      picked: freeRailPicked.value,
      // 余额的落点缺省取本剧本**本方的图边补给源格第一处**（原文只说"放图边补给源格"，不指定哪一处）
      edgeHex: freeRailEdgeHex.value ?? scenarioSupplySourceHexes.value[0] ?? null,
      edgeSourceHexes: scenarioSupplySourceHexes.value,
      supplyTrainSp: supplyTrainSp.value,
      supplyTrainHex: supplyTrainHex.value,
    })
    if (!outcome.ok) {
      freeRailError.value = { rule: outcome.rule, reason: outcome.reason }
      return null
    }
    freeRailError.value = null
    return outcome.data
  })

  /** 专规 2.1/3.1：勾选/取消一个免费铁运城市格（每格 1 SP） */
  function toggleFreeRailPick(hex: HexRef): void {
    const text = hexLabel(hex)
    const found = freeRailPicked.value.some((item) => hexLabel(item) === text)
    freeRailPicked.value = found
      ? freeRailPicked.value.filter((item) => hexLabel(item) !== text)
      : [...freeRailPicked.value, { ...hex }]
  }

  /** 专规 2.1/3.1：指定余额的落点（图边补给源格） */
  function pickFreeRailEdgeHex(hex: HexRef | null): void {
    freeRailEdgeHex.value = hex === null ? null : { ...hex }
  }

  /** 3.6：指定补给列车的落点（任一可卸货格） */
  function pickSupplyTrainHex(hex: HexRef | null): void {
    supplyTrainHex.value = hex === null ? null : { ...hex }
  }

  /**
   * 专规 2.1 / 3.1 + 3.6：把当日到货 SP **落账**（12.1b 的账本条目）
   *
   * 落盘形态与手工新增、空运卸载完全同一处（`addSpAtHex`），只是多说明来源；
   * 同一格若既有免费铁运又有补给列车，**合并成一条**账本条目（避免同格两条相互矛盾）。
   * 落账后清空勾选与 SP 数，防止重复落账。
   */
  function applySupplyArrivalsNow(): boolean {
    if (!requireAction('rein.supplyArrival', '到货 SP 落位')) return false
    const plan = freeRailPlan.value
    if (plan === null) {
      const error = freeRailError.value
      pushLog(
        'warning',
        `到货 SP 落位被拒绝：${error?.reason ?? '计划不可用'}（${error?.rule ?? '专规 2.1 / 3.1'}）`,
        error?.rule ?? '专规 2.1 / 3.1',
      )
      return false
    }
    if (plan.placements.length === 0) {
      pushLog('warning', '本笔没有可落的 SP（到货 0 且无补给列车）', '专规 2.1 / 3.1')
      return false
    }
    // 同格合并（免费铁运 1 SP 与补给列车的 2 SP 可以落在同一格）
    const byHex = new Map<string, { hex: HexRef; sp: number; reasons: string[] }>()
    for (const item of plan.placements) {
      const text = hexLabel(item.hex)
      const existing = byHex.get(text)
      if (existing === undefined) {
        byHex.set(text, { hex: { ...item.hex }, sp: item.sp, reasons: [item.reason] })
      } else {
        existing.sp += item.sp
        existing.reasons.push(item.reason)
      }
    }
    const labelOfReason = (reason: string): string =>
      reason === 'freeRail'
        ? '免费铁运（专规 2.1/3.1）'
        : reason === 'supplyTrain'
          ? '3.6 补给列车'
          : '图边补给源格'
    for (const entry of byHex.values()) {
      addSpAtHex({
        hex: entry.hex,
        side: activeSide.value,
        sp: entry.sp,
        t: 0,
        source: `到货 SP 落位：${[...new Set(entry.reasons)].map(labelOfReason).join(' + ')}`,
      })
    }
    lastFreeRailPlan.value = plan
    pushLog('success', plan.detail, plan.rule)
    // ⑭ 接线：到货 SP 落位（免费铁运）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyArrival',
      rule: plan.rule,
      data: {
        sp: supplyArrivalSp.value,
        freeSp: plan.freeSp,
        edgeSp: plan.edgeSp,
        supplyTrainSp: plan.supplyTrainSp,
        railCapUsed: plan.railCapUsed,
        placements: plan.placements.map((item) => ({
          hex: hexLabel(item.hex),
          sp: item.sp,
          reason: item.reason,
        })),
        detail: plan.detail,
      },
    })
    freeRailPicked.value = []
    supplyTrainHex.value = null
    supplyArrivalSp.value = 0
    return true
  }

  /** 13.6 / 1.6a：当日到达计划（含投放需求与强制移除） */
  const arrivalPlan = computed<ArrivalPlan | null>(() => {
    const outcome = planArrivals({ side: activeSide.value, date: date.value })
    return outcome.ok ? outcome.data : null
  })

  /** 到达需求的落点解算（下标与 `arrivalPlan.units` 一致；裁判可手改） */
  const arrivalPlacements = computed<readonly ArrivalPlacementResult[]>(() => {
    const plan = arrivalPlan.value
    if (plan === null) return []
    return plan.units.map((unit, index) => {
      const override = arrivalHexOverrides.value[index]
      if (override !== undefined)
        return {
          status: 'placed' as const,
          hex: override,
          rule: '13.6',
          detail: `裁判手改落点为 ${hexLabel(override)}`,
        }
      return resolveArrivalPlacement(unit.placement, arrivalFacts.value)
    })
  })

  /**
   * B34：**图上本方单位**（给"拆分母单位 / 慢动员锁定 / 合并保留·移除"四处阵列当候选）
   *
   * 这只是"盘面上有哪些本方单位"这一份**数据**，不含任何合法性判断 ——
   * 20.0a 的创建时机、13.9 的"两面完全相同、非 DG…"等条件仍由引擎在提交时判，
   * 被拒时照旧给带规则号的一行提示。列**全部**本方单位（含飞行队与运输点数）：
   * 13.9 合并的对象不限于战斗单位，界面不替规则先筛一遍。
   */
  const ownUnitsOnMap = computed<ConsoleUnit[]>(() =>
    units.value.filter((unit) => unit.side === activeSide.value),
  )

  /**
   * 13.5：可重建候选（死亡堆 + 图上有军力损失的己方单位）
   *
   * 死亡堆条目含空军（与地面共用），故类型为 `DeadPileEntry`；
   * 地面重建动作内部会对空军显式拒绝（13.5 地面口径不适用于飞机）。
   */
  const rebuildCandidates = computed<DeadPileEntry[]>(() => [
    ...deadPile.value.filter((unit) => unit.side === activeSide.value),
    ...units.value.filter(
      (unit) => unit.side === activeSide.value && unit.steps < unit.printedSteps,
    ),
  ])

  /** 专规 2.3b：守方本场战斗中的 NKVD 边防团（必须担任行动值单位） */
  const combatNkvdDefenders = computed<ConsoleUnit[]>(() =>
    battleDefenders.value.filter((unit) => isNkvdBorderRegiment(toNkvdDefenseView(unit))),
  )

  /** 专规 2.3b：守方本场是否需要把**全部**选项吃成损失（并禁用 9.10c 忽略） */
  const combatNkvdForcedLosses = computed<boolean>(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined) return false
    return (
      nkvdDefenderOptionOverride({
        defenderArUnitId: state.ar?.defenderUnitId ?? '',
        defenders: combatDefenderViews.value.map(toNkvdDefenseView),
        optionPoints: optionsOf(state.dice.result, 'defender'),
      }) !== null
    )
  })

  /** 统一收 B18 引擎结论（失败即记错误与日志并返回 null） */
  function acceptReinforcement<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      reinforcementError.value = null
      return outcome.data
    }
    reinforcementError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /* ────────────────────────────── B8：环节状态与统一闸门 ────────────────────────────── */

  /**
   * 本段内**当前环节**的序号（0 起）
   *
   * 这是 B6 的环节链第一次成为**状态**：用户口径「玩家每个环节只能执行该环节能进行的操作」，
   * 而"当前在哪一环"必须被记住——否则闸门无从判、流程条也无从显示。
   * 换段 / 换方 / 换回合即归零（见下面的 watch），故它只是**段内**的进度。
   */
  const segmentStepIndex = ref(0)

  /** 本段本方的**全部**环节（唯一出处：`engine/rules/sop-segments`；B 段的链按方不同） */
  const segmentSteps = computed(() => sopStepsOf(phase.value as GamePhase, activeSide.value))

  /**
   * 本段本方**需要玩家过**的环节（滤掉自动的 / 无事可做的 / 尚未实现的）
   *
   * 用户口径：「点击进入下一个阶段后，**自动进行的阶段不需要玩家介入**」——自动环节
   * （B 段的补员表掷骰 / 随机事件 / 可变撤离等）由引擎在推进段时结算并留痕，
   * **不该占一格让玩家点**。故"当前环节"只在**玩家环节**里走。
   * 例：B 段的链是 `掷骰(自动) → 到货 → 重建 → …`，玩家一进 B 段就停在「到货」。
   *
   * ★ **无事可做就跳过**（用户 2026-09-16 裁定②：「如果玩家在自己的突围环节无事可做，那么可以自动跳过」）：
   *   标了 `skipWhenIdle` 的环节（现在只有突围 12.8e —— B47 已给出入口）若**本方无人参与**则自动跳过——
   *   判据就是下面 `stepHasWork`（与闸门**同一条** `participatesIn`）：一个断补单位都没有，
   *   突围环节本就没有可做之事，不该让玩家点一次空环节。
   *
   * ★ 还要跳过 `implemented === false` 的环节（条文有、store 里**没有入口**的那几个：
   *   编队抽取 专规 13.7 / 特殊补员抽取 专规 1.6c）。这一条与"无事可做"**是两回事**：
   *   前者是"这一刻没活"，后者是"这个活还没做出来"。两处都写清，免得把实现缺口当成规则行为。
   *
   * 全自动的段（H 清理 / Turn End / Pre-Turn 的部分）滤完为空 ⇒ `segmentStep` 为 null
   * ⇒ 闸门对一切动作返回"当前段没有环节表"，**正是"这些段没有玩家动作"应有的效果**。
   */
  const playerSegmentSteps = computed(() =>
    segmentSteps.value.filter(
      (step) =>
        step.driver !== 'automatic' &&
        step.implemented !== false &&
        !(step.skipWhenIdle === true && !stepHasWork(step)),
    ),
  )

  /**
   * 本环节**是否有活可做**（只对 `skipWhenIdle` 的环节求值）
   *
   * 判据＝**本环节有谁参与**（B7 的 `participatesIn`，与闸门同源）：有人参与就有活，
   * 没人参与就无事可做。本函数不另立规则——12.8e 的"断补 + 战斗单位 + 移动 MA ≥ 1"就在那条谓词里。
   *
   * ★ **不能**用 `segmentGateQuery`：它含 `segmentStep` 与 `segmentStepPosition`，而本函数正是
   *   `playerSegmentSteps` 的过滤条件 ⇒ 会成环（B47 把突围的 `implemented: false` 翻掉之后，
   *   本函数第一次真的被跑到，环就暴露了：读到的 `playerSegmentSteps` 还是 undefined）。
   *   本函数只问"本环节有谁参与"，故只取 `{phase, segment, side}` 三样，别的一概不碰。
   */
  function stepHasWork(step: SopSegmentStep): boolean {
    const reaction = phase.value === 'reaction'
    const side = reaction ? opponentOf(activeSide.value) : activeSide.value
    /*
     * ★ 条 6（R3）：突围环节（`movement.breakout`）的"有活"判据要比通用的 `participatesIn` 更严。
     * `participatesIn` 只判"断补 + 战斗单位 + 移动 MA≥1"，但**真能突围**还要过 12.8e 的
     * A 路径 / B 15 格 / 首回合 / MA 那一整套 `canBreakout` 判据——否则会出现"本环节出现了，
     * 但点任何一个断补单位都被 `breakoutNow` 拒"的死环节（玩家进得去、出不去）。
     * 故这里改用 `breakoutCandidates`（已含 `canBreakout` 结论）是否有 `ok` 的；
     * 另：有待返场单位（`breakoutReturns`）时也算有活（要把它们按 13.6b 放回）。
     */
    if (step.id === 'movement.breakout') {
      return (
        breakoutCandidates.value.some((candidate) => candidate.ok) ||
        breakoutReturns.value.length > 0
      )
    }
    return units.value.some(
      (unit) =>
        participatesIn({
          unit,
          phase: phase.value as GamePhase,
          segment: step.id,
          activeSide: side,
        }).ok,
    )
  }

  /** 当前环节（序号越界时**夹到最后一环**：换方后链变短也不会读到 undefined） */
  const segmentStep = computed<SopSegmentStep | null>(() => {
    const steps = playerSegmentSteps.value
    if (steps.length === 0) return null
    const index = Math.min(segmentStepIndex.value, steps.length - 1)
    return steps[index] ?? null
  })

  /** 当前环节进度（界面显示「第 n / m 环」） */
  const segmentStepPosition = computed(() => {
    const steps = playerSegmentSteps.value
    return {
      index: steps.length === 0 ? 0 : Math.min(segmentStepIndex.value, steps.length - 1),
      total: steps.length,
    }
  })

  /**
   * 闸门查询（B7 `allowedActionsOf` 的入参）
   *
   * E 反应段由**非**行动方行动（6.3a / 7.0a）⇒ 该段的 `role` 是 `nonActive`、`side` 是对手方；
   * 其余段都是行动方在动。这一句是"谁是这一环的行动者"的**唯一实现**。
   */
  const segmentGateQuery = computed<ActionGateQuery>(() => {
    const reaction = phase.value === 'reaction'
    const position = segmentStepPosition.value
    return {
      phase: phase.value as GamePhase,
      segment: segmentStep.value?.id ?? '',
      role: reaction ? 'nonActive' : 'active',
      side: reaction ? opponentOf(activeSide.value) : activeSide.value,
      /*
       * B37：**段末**声明（`at: 'end'` 那一类时机只在这里放行）
       *
       * 判据＝"现在是本段的**最后一个玩家环节**"。与 20.0d 的段末强制收束（`timing: 'segmentEnd'`）
       * 同一层意思：那些事**不是在某个环节里做的**，而是在段的收尾处结算。
       */
      atSegmentEnd: position.total > 0 && position.index === position.total - 1,
    }
  })

  /**
   * 批 A 切片 2：当前环节是不是**某段的轰炸环节**（SOP：C 段 air & ship only / F 段 artillery only）
   *
   * 判据＝环节 id 以 `.barrage` 结尾（`movement.barrage` / `reaction.barrage` / `combat.barrage` /
   * `exploitation.barrage`）——环节清单本身来自 SOP 数据，故此处不写死段名。
   */
  const isBarrageSegment = computed<boolean>(() =>
    (segmentStep.value?.id ?? '').endsWith('.barrage'),
  )

  /** 批 A 切片 2：当前环节是不是**战斗环节**（`combat.combat` / `exploitation.combat`） */
  const isCombatPickSegment = computed<boolean>(() =>
    (segmentStep.value?.id ?? '').endsWith('.combat'),
  )

  /**
   * 批 A 切片 2：**本环节允许的轰炸来源**（10.0e-F 的段内限制）
   *
   * 判据取自引擎的唯一表 `BARRAGE_SOURCES_BY_PHASE`（SOP 原文：C 段 air & ship only、F 段 artillery only）；
   * 不在轰炸环节时给全量（面板在别的环节仍可查看，最终是否合法由引擎判）。
   */
  const barrageKindsInSegment = computed<readonly BarrageKind[]>(() => {
    /** 全量来源（本作只有这三类：火炮 / 空军 / 海军；海军在本作不适用，保留以照原文） */
    const ALL_KINDS: readonly BarrageKind[] = ['artillery', 'air', 'ship']
    const allowed = BARRAGE_SOURCES_BY_PHASE[phase.value as GamePhase]
    if (allowed === undefined) return ALL_KINDS
    if (!isBarrageSegment.value) return ALL_KINDS
    return ALL_KINDS.filter((kind) => allowed.includes(kind))
  })

  /**
   * 批 A 切片 2：在轰炸环节里**点地图选目标格**（10.0d）
   *
   * 只落"目标格"这一件事：参炸单位的选择仍归会话框/面板（`toggleBarrageUnit`），
   * 宣布是否合法仍归引擎（`beginBarrageNow`）。
   */
  function pickBarrageTargetAt(hex: HexRef): void {
    barragePickHex.value = { ...hex }
    pushLog('info', `轰炸目标格 → ${hexLabel(hex)}（10.0d）`, '10.0d')
  }

  /**
   * 批 A 切片 2：**进入轰炸环节即开好轰炸工具**
   *
   * 用户口径是"由环节驱动" ⇒ 玩家不该先去找开关；离开该环节不动它（可继续在验证页用工具）。
   */
  watch(
    isBarrageSegment,
    (on) => {
      if (on) setBarrageActive(true)
    },
    // ★ flush: 'sync' —— 环节一变就得把工具开好：
    //   否则同一拍里的点击（以及用例）会读到"环节到了、工具还没开"的中间态。
    { flush: 'sync' },
  )

  /**
   * B35（用户口径 2026-09-16 #10）：**此刻"点地图选战斗"是不是本环节允许做的事**
   *
   * 用户口径：「各阶段什么单位能干什么事是按规则定好的，**地图窗口上方的移动和战斗按钮
   * 在对局界面是不需要的**。测试界面才需要。」⇒ 正式界面不再让玩家切"工具"，
   * 改为**从闸门推**：本环节允许 `combat.declare`（9.1 宣布战斗的入口）⇒ 点地图就是选攻方 / 定防御格；
   * 不允许 ⇒ 点地图照常走移动与选中那一路。
   *
   * ★ 判据与 `requireAction` **同一条**（`allowedActionsOf(segmentGateQuery)`），不另写一遍规则；
   *   `tool` 本体保留（引擎验证页与 20+ 流程用例仍靠它显式切换）。
   */
  const combatPickActive = computed<boolean>(() =>
    allowedActionsOf(segmentGateQuery.value).has('combat.declare'),
  )

  /** 最近一次被闸门拒绝的动作（界面就地显示一行；通过时清空） */
  const actionRefusal = ref<{ key: ActionKey; rule: string; reason: string } | null>(null)

  /**
   * 本环节**可参与的算子**（B9：界面"灰色不可点"与"本环节可参与 N 枚"的唯一判据）
   *
   * 判据就是 B7 的 `participatesIn`——**同一条谓词**，界面不再自己判"这枚能不能点"，
   * 否则"能点"与"能选"会各有一套口径。列表按盘面顺序，供渲染层做灰显与拾取过滤。
   */
  const participatingUnitIds = computed<readonly string[]>(() => {
    const query = segmentGateQuery.value
    if (query.segment === '') return []
    return units.value
      .filter(
        (unit) =>
          participatesIn({
            unit,
            phase: query.phase,
            segment: query.segment,
            activeSide: query.side ?? activeSide.value,
            // 9.1c：本战斗环节已攻击过的单位不再可点（用户口径 9.17⑤「只列没攻击过的可攻击单位」）
            attackedUnitIds: attackedUnitIdsThisPhase.value,
          }).ok,
      )
      .map((unit) => unit.instanceId)
  })

  /**
   * 本环节可参与的算子数（流程条的「本环节可参与 N 枚」）
   *
   * ★ 口径说明：这是**可参与的算子数**，不是"必须做的事数"——后者要逐环节定义
   *   （如"B 增援：18 个待部署"），属后续批次；先给一个**同一谓词**算出来的数，
   *   比拍脑袋写一句更贴边，也不会因为两边口径不同而互相打架。
   */
  const participatingUnitCount = computed<number>(() => participatingUnitIds.value.length)

  /**
   * 地图内就地一行的**提示文本**（无提示时 null）
   *
   * 优先级：闸门拒绝（`actionRefusal`，说明"这一步此刻在哪一段哪一环节才能做"）
   * → 移动被拒（`moveBlocked`，说明这一格为什么走不到）。
   * 两者都是"点了没反应"时玩家最需要的一句话，且都自带规则号。
   */
  const mapHint = computed<MapHint | null>(() =>
    mapHintOf({ refusal: actionRefusal.value, moveBlocked: moveBlocked.value }),
  )

  /**
   * 换段 / 换方 / 换回合 ⇒ 环节归零
   *
   * 与"清段内中间态"同一时点（`resetSegmentTransient` 也在这些时点被调用），但这里用 watch
   * 而不是靠调用方记得——**换方时 B 段的链长度会变**，忘记归零会停在越界的环节上。
   */
  watch(
    () => `${turn.value}|${phase.value}|${activeSide.value}`,
    () => {
      segmentStepIndex.value = 0
      actionRefusal.value = null
      /*
       * 9.1c：换回合 / 换段 / 换方 ⇒ 环节归零，账本也必须跟着清 —— 这条 watch 是"环节变了"
       * 的又一条路径（"交给对手"的切方不走 `resetSegmentTransient`），漏了它就会出现
       * "上一方在本环节的攻击记录压着这一方的战斗环节"。
       */
      clearAttackPhaseLedger()
    },
  )

  /** 推进到本段的**下一环节**；已是最后一环则返回 false（由调用方接着推进会话步） */
  function stepToNextSegmentStep(): boolean {
    const position = segmentStepPosition.value
    if (position.total === 0) return false
    if (position.index >= position.total - 1) return false
    segmentStepIndex.value = position.index + 1
    const next = segmentStep.value
    if (next !== null) pushLog('info', `环节 → ${next.label}（${next.rule}）`, '2.2')
    /*
     * 9.1c：账本按**战斗环节**计 ⇒ 环节一换（例如 F 段「炮击 → 战斗」）就是新的一个战斗环节，
     * 上一环的攻击记录不再约束这一环。
     */
    clearAttackPhaseLedger()
    return true
  }

  /** 直接跳到某一环（引擎验证页/测试用；越界即拒绝，不夹取——夹取会掩盖调用方的错） */
  function setSegmentStepIndex(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= playerSegmentSteps.value.length)
      return false
    segmentStepIndex.value = index
    // 9.1c：直跳也是"换环节" ⇒ 账本必须清（否则往回跳一步就能让同一单位再攻击一次）
    clearAttackPhaseLedger()
    return true
  }

  /**
   * **统一闸门**（B8）：这个动作此刻允许做吗
   *
   * 判据链：① Pre-Turn 锁定（2.2）→ ② 本段本方的**当前环节**是否允许该动作族（B7 的 `allowedActionsOf`）。
   * 通过即清空上次的拒绝记录；被拒则**记一句人话 + 规则号**（界面就地冒一行，不弹窗、不换页）。
   *
   * ★ 判据全部来自 `engine/rules/sop-segments` 与 `stores/workbench-model` 的两张纯表，
   *   本函数不自己比较规则号、也不写第二份"哪个动作归哪一段"。
   */
  function requireAction(key: ActionKey, action: string): boolean {
    if (segmentLocked.value) return refuseWhileLocked(action)
    const query = segmentGateQuery.value
    if (query.segment === '') {
      actionRefusal.value = { key, rule: '2.2', reason: 'noSegmentStep' }
      pushLog('warning', `${action}被拒绝：当前段没有环节表（2.2）`, '2.2')
      return false
    }
    if (allowedActionsOf(query).has(key)) {
      actionRefusal.value = null
      return true
    }
    const gate = actionGateOf(key)
    const where = gate.where
      .map((item) => {
        const label = sopStepById(item.segment)?.label ?? item.segment
        return `${PHASE_LABELS[item.phase as ConsolePhase] ?? item.phase} · ${label}`
      })
      .join(' / ')
    const reason = `只能在「${where}」进行`
    actionRefusal.value = { key, rule: gate.rule, reason }
    pushLog('warning', `${action}被拒绝：${reason}（${gate.rule}）`, gate.rule)
    return false
  }

  /**
   * B18：切当前剧本（到达落点、补给源、换轨、胜利格等盘面账本随剧本重取）
   *
   * ★ 联调：剧本号本身写在**会话 store**（唯一权威）；本函数只负责「随剧本重取的盘面账本」。
   * 已被会话锁定（已开局）时**整段拒绝**——否则会出现「剧本号没变、账本却按新剧本重置」的半更新。
   */
  function setScenarioId(next: string): void {
    if (!session.setScenarioId(next)) {
      pushLog(
        'warning',
        `换剧本被拒（${session.error?.reason ?? 'scenarioLockedWhilePlaying'}）：已开局的会话不允许中途换剧本（2.2）`,
        '2.2',
      )
      return
    }
    /*
     * ★ 账本重取**不在这里**：剧本号的唯一权威是会话，凡是写会话的路径都可能换剧本
     *   （本函数、容器盒 `containers.setScenario`、**读档 `session.loadNow`**），
     *   若由各入口自己记得刷新，漏一条就是「剧本号变了、盘面账本还是旧剧本」的半更新
     *   （实测：剧本 3 存档 → 读回后建造标记仍是剧本 1 的 3 枚、换轨账本仍是剧本 1 的 2 格）。
     *   故改由下方 **对 `scenarioId` 的 watch** 统一重取 —— 权威一变即重取，与入口无关。
     */
    pushLog(
      'info',
      `剧本 → ${next}（盘面账本随剧本重取：到达落点、补给源、1.7 补给缓存、3.5 建造标记、` +
        `5.0c 胜利格控制、9.14e 印刷工事归属、专规 1.2 换轨）`,
      '2.1',
    )
  }

  /** B18：手改某条到达需求的落点（13.6：入场格由裁判按卡面判定） */
  function setArrivalHexOverride(index: number, hexText: string): void {
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      pushLog('warning', `落点格式应为「列.行」，收到「${hexText}」`, '13.6')
      return
    }
    arrivalHexOverrides.value = { ...arrivalHexOverrides.value, [index]: hex }
  }

  /** B18：补员账本（13.5） */
  function setReplHoldingsNow(holdings: ReplHoldings): void {
    replHoldings.value = holdings
  }

  function addReplHoldingsNow(delta: Partial<ReplHoldings>): void {
    replHoldings.value = addReplHoldings(replHoldings.value, delta)
    const kept = (['pax', 'eq'] as const).filter((key) => isSavableRepl(key))
    pushLog(
      'info',
      `补员 +${describeCost(delta)}（1.6b；可保存的仅有 ${kept.join(' / ')}，13.5）`,
      '13.5',
    )
  }

  /** 13.5 + 专规 1.6 Notes：清零不可保存的 Ftr / Tac 补员（增援阶段结束时） */
  function clearNonSavableReplNow(): void {
    const before = replHoldings.value
    /*
     * 13.5：**哪些补员可跨回合保存**由引擎的 `isSavableRepl` 判（Pax / Eq 可存、Ftr / Tac 不可），
     * 本处只按它的结论清零；修前这里把「不可保存的是 Ftr/Tac」写死在日志与计数里。
     */
    const doomed: Partial<ReplHoldings> = {}
    for (const key of ['ftr', 'tac', 'pax', 'eq'] as const) {
      if (!isSavableRepl(key)) doomed[key] = 0
    }
    replHoldings.value = clearNonSavableRepl(before)
    const lost = before.ftr + before.tac
    pushLog(
      'info',
      lost === 0
        ? `${Object.keys(doomed).join(' / ')} 补员无剩余（13.5：不可保存）`
        : `${Object.keys(doomed).join(' / ')} 补员清零 ${lost} 点（13.5：只补 1 step 且**不可保存**）`,
      '13.5',
    )
  }

  /**
   * B18：掷可变增援（1.6b 补给表与补员表 / 1.6c 特殊补员 / 3.3c 可变撤离 / 3.6 随机事件）
   *
   * 骰面由 `variableReplInputs` 给出（`autoRoll` 时用种子化 RNG 现掷）；结论落 `lastVariableRepl`，
   * 补员立即入账（Ftr/Tac 仍需在阶段末清零）；SP 与免费重建按 2.1 的落点由裁判投放。
   */
  function rollVariableReplNow(): boolean {
    const inputs = variableReplInputs.value
    // ⑭ 接线：下面两个闭包只回报数字（不改它们）⇒ 先记下掷骰前的骰源，末尾按实际掷骰顺序复算骰面
    const rngBefore = rng.value
    const draw2d6 = (): number => {
      const draw = roll2d6(rng.value)
      rng.value = draw.rng
      drawCount.value += 1
      return draw.value.total
    }
    const draw1d6 = (): number => {
      const draw = roll1d6(rng.value)
      rng.value = draw.rng
      drawCount.value += 1
      return draw.value.total
    }
    const supplyDice = inputs.autoRoll ? draw2d6() : inputs.supplyDice
    const replDice = inputs.autoRoll ? draw2d6() : inputs.replDice
    const specialDie = inputs.autoRoll ? draw1d6() : inputs.specialDie
    const variableExitDie = inputs.autoRoll ? draw1d6() : inputs.variableExitDie
    const randomEventDice = inputs.autoRoll ? draw2d6() : inputs.randomEventDice
    // ⑭ 接线：按实际掷骰顺序复算骰面（补给 2d6 → 补员 2d6 → 特殊 1d6 → 可变撤离 1d6 → 随机事件 2d6）
    const rolls: DiceRoll[] = []
    if (inputs.autoRoll) {
      let cursor = rngBefore
      for (const count of [2, 2, 1, 1, 2]) {
        const derived = count === 2 ? roll2d6(cursor) : roll1d6(cursor)
        cursor = derived.rng
        rolls.push(derived.value)
      }
    }

    const data = acceptReinforcement(
      planVariableReinforcement({
        side: activeSide.value,
        date: date.value,
        supplyDice,
        replDice,
        specialDie,
        variableExitDie,
        randomEventDice,
        // 3.3c：已了结则不再掷（「1 或 6 ⇒ 该单位移除，撤离判定结束」）
        variableExitResolved: variableExitResolved.value,
        // 3.6 / 4.1b：可选规则 4.1b 的 Supply Train（8 Jul / 12 Jul 自动发生）
        option4_1b: inputs.option4_1b,
      }),
      '可变增援',
    )
    if (data === null) return false
    lastVariableRepl.value = data
    // 专规 2.1/3.1：到货 SP 数自动填进落账输入（裁判可手改）—— 否则免费铁运要人再抄一遍数
    supplyArrivalSp.value = data.sp
    // 3.6：补给列车的落点须玩家选（任一可卸货格）；换掷即作废上一次的选择
    supplyTrainHex.value = null
    // 3.3c：掷出 1 或 6 即「该单位移除，撤离判定结束」⇒ 记住已了结，后续回合不再掷
    if (data.variableExit !== null && data.variableExit !== undefined) {
      variableExitResolved.value = true
      pushLog('warning', `3.3c 可变撤离已了结：${data.variableExit.description}`, '3.3c')
    }
    // 补员入账（13.5：Pax/Eq 可保存；Ftr/Tac 不可保存，阶段末由调用方清零）
    addReplHoldingsNow({
      ftr: data.repl.ftr,
      tac: data.repl.tac,
      pax: data.repl.pax,
      eq: data.repl.eq,
    })
    // 3.6：机型结果 ⇒ 该型飞机立即全部转非激活
    if (data.randomEvent?.kind === 'aircraft' && data.randomEvent.aircraftType !== undefined) {
      const type = data.randomEvent.aircraftType
      const hit = airUnits.value.filter(
        (air) => air.side === activeSide.value && air.aircraftType === type,
      )
      for (const air of hit) air.airStatus = 'inactive'
      pushLog(
        'warning',
        `${type} ×${hit.length} 立即转非激活（3.6 随机事件：被派往地图外任务）`,
        '3.6',
      )
    }
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：可变增援（1.6b 补给/补员表 / 1.6c 特殊补员 / 3.3c 可变撤离 / 3.6 随机事件）
    // 入会话日志；rolls＝本笔真实掷出的五颗骰（autoRoll 关闭时为空，由裁判手填）
    recordSettlement({
      action: 'variableRepl',
      rule: data.rule,
      rolls,
      data: {
        autoRoll: inputs.autoRoll,
        supplyDice,
        replDice,
        specialDie,
        variableExitDie,
        randomEventDice,
        repl: {
          ftr: data.repl.ftr,
          tac: data.repl.tac,
          pax: data.repl.pax,
          eq: data.repl.eq,
        },
        randomEventKind: data.randomEvent?.kind ?? null,
        detail: data.detail,
      },
    })
    return true
  }

  /**
   * B18：按到达卡投放一个条目（13.6 / 13.6b / 1.6a）
   *
   * ★ **不做「到达卡条目 → 算子记录」的映射**：本作工程库未落该映射，故由裁判从单位库选算子
   *   （`recordId` 缺省时按 `unitChoices` 的显示名与到达卡 `name` 精确匹配，匹配不到即拒绝并提示）。
   */
  function placeArrivalNow(index: number, recordId?: string, hexText?: string): boolean {
    if (!requireAction('rein.arrival', '到达投放')) return false
    const plan = arrivalPlan.value
    if (plan === null) return false
    const demand = plan.units[index]
    if (demand === undefined) return false
    if (demand.kind === 'sp' || demand.kind === 'unclassified') {
      pushLog(
        'warning',
        `${demand.raw}：该条目不是算子（${demand.kind}），请按卡面在落点手工记账（13.6）`,
        '13.6',
      )
      return false
    }
    const placed = arrivalPlacements.value[index]
    if (placed === undefined || placed.hex === null) {
      reinforcementError.value = { rule: placed?.rule ?? '13.6', reason: 'noPlacementHex' }
      pushLog('danger', `无法投放：${placed?.detail ?? '落点未定'}`, placed?.rule ?? '13.6')
      return false
    }
    const hex = hexText === undefined ? placed.hex : (parseHexPath(hexText)[0] ?? placed.hex)

    const record =
      recordId === undefined
        ? choices.value.find((item) => recordNameOf(item) === (demand.name ?? demand.raw))
        : choices.value.find((item) => item.id === recordId)
    if (record === undefined) {
      reinforcementError.value = { rule: '13.6', reason: `arrivalUnitNotResolved:${demand.raw}` }
      pushLog(
        'danger',
        `单位库里找不到「${demand.name ?? demand.raw}」对应算子 ⇒ 请在**这一条到达需求的"库中型号"里挑一枚**再点投放（13.6：引擎不臆造条目→算子的映射）`,
        '13.6',
      )
      return false
    }

    const unit = toConsoleUnit({
      record,
      instanceId: createId('arr'),
      hex,
      side: activeSide.value,
    })
    // 到达卡 `-N step`：到场即带损
    if (demand.stepsLost > 0) {
      unit.steps = Math.max(0, unit.steps - demand.stepsLost)
    }
    /*
     * 13.6c：**运输点数满载 SP 入场**（用户 2026-09-15 裁定）
     *
     * 「通用的运输点数**有几点运力就是几**（例如该回合有 3 点马车点数增援，就视为装着 3 SP 进场）；
     *   **编内卡车全部只有 1 点运力**（印值 1F-45），故编内卡车恒为 1 SP。」
     * 即：装载量 = 该算子的**运力点数**（`noncombatTransport`）——编内卡车的数据里运力就是 1 ✓。
     * 修前只落一句「请在 SP 账本登记」的提示，把数字留给玩家手填。
     */
    if (demand.loadedWithSp && unit.noncombatTransport > 0) {
      const cargoSp = unit.noncombatTransport
      unit.loadedSpT = cargoSp * SP_TO_T
      pushLog(
        'info',
        `${unit.name} 满载进场：${cargoSp} 点运力 ⇒ 载 ${cargoSp} SP（13.6c）`,
        '13.6c',
      )
    }
    /*
     * 12.5f：「增援单位的**部署不需要燃料补给**，但是**移动离开入场格时**，则需要支付燃料补给。
     *   增援单位在抵达的回合，不会获得『免费的燃料补给』。」
     *
     * ★ 落点即置**未加油**：部署本身不花 MP（故不需燃料），而一旦要消耗 MP 就必须先付——
     *   这正是 12.5f 的两半。此前依赖 `toConsoleUnit` 的便利缺省 `fuelled: true`，
     *   于是刚到的增援可以直接开走、**一分燃料都不付**。
     */
    if (needsFuelToMove(toMoveUnitView(unit))) {
      unit.fuelled = false
      unit.fuelMethod = null
      pushLog(
        'info',
        `${unit.name} 以**未加油**到场：部署不需燃料，但移动离开入场格须先付燃料（12.5f）`,
        '12.5f',
      )
    }
    units.value = [...units.value, unit]

    // 13.6：飞机在**任一友方空军基地**以**激活**状态到达
    if (demand.kind === 'aircraft') {
      const air = toConsoleAirUnit({
        aircraft:
          aircraftChoices(activeSide.value).find(
            (item) => item.aircraftId === record.id || item.name === record.vassalName,
          ) ?? aircraftChoices(activeSide.value)[0]!,
        instanceId: createId('arr-air'),
        hex,
        side: activeSide.value,
        airStatus: 'active',
      })
      airUnits.value = [...airUnits.value, air]
      pushLog(
        'success',
        `${demand.raw} 投放于 ${hexLabel(hex)}（13.6：飞机在友方空军基地以激活状态到达）`,
        '13.6',
      )
      // ⑭ 接线：到达投放（13.6，飞机）入会话日志（本笔不掷骰）
      recordSettlement({
        action: 'arrival',
        rule: '13.6',
        data: {
          index,
          kind: demand.kind,
          raw: demand.raw,
          hex: { ...hex },
          aircraftId: air.instanceId,
        },
      })
      return true
    }

    pushLog(
      'success',
      `${demand.raw} 投放于 ${hexLabel(hex)}` +
        (demand.stepsLost > 0 ? `（到场即带损 ${demand.stepsLost} step）` : '') +
        (demand.loadedWithSp ? '（13.6c：运输点满载 SP 入场，请在 SP 账本登记）' : ''),
      '13.6',
    )
    // ⑭ 接线：到达投放（13.6）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'arrival',
      rule: '13.6',
      data: {
        index,
        kind: demand.kind,
        raw: demand.raw,
        hex: { ...hex },
        unitId: unit.instanceId,
        stepsLost: demand.stepsLost,
        loadedWithSp: demand.loadedWithSp,
      },
    })
    return true
  }

  /**
   * B18：按到达卡执行强制移除（1.6a：立即移出**游戏**，不论处境）
   *
   * ★ 1.6a 原文：「When a unit is called on to be 'Removed' by the arrival charts or else a unit with
   *   identical factors, is **immediately removed from play**, regardless of its current situation
   *   (even if in **the dead pile** or surrounded). Some of these units will return again, but most
   *   are gone for good.」
   *   ⇒ 被移除者**离开游戏**（盘面、空军、**死亡堆**都要清），而不是"进死亡堆"。
   *   修前这里把移除的算子 `push` 进 `deadPile` —— 于是「gone for good」的算子仍留在死亡堆里
   *   可被 13.5 重建 / 1.6c 免费重建返场，与条文相反（且死亡堆计数、重建候选集都被污染）。
   *   ★ 也正因为如此，专规 2.3c 的编制转化「The old unit is a Removal (1.6a)」不走死亡堆。
   */
  function applyArrivalRemovalsNow(): void {
    const plan = arrivalPlan.value
    if (plan === null) return
    for (const removal of plan.removals) {
      // 1.6a：移除「该单位或一个 factors 完全相同的单位」⇒ 按名称匹配盘面算子
      const index = units.value.findIndex(
        (unit) => unit.side === activeSide.value && removal.raw.includes(unit.name),
      )
      if (index < 0) {
        pushLog(
          'warning',
          `${removal.raw}：盘面上没有可移除的同名算子 ⇒ 请手工处理（1.6a 允许用 factors 相同的单位顶替）`,
          '1.6a',
        )
        continue
      }
      const [unit] = units.value.splice(index, 1)
      if (unit === undefined) continue
      // 1.6a：不论处境 ⇒ 同名/同印值的算子若正在死亡堆里也要一并移出游戏
      removeFromPlayEverywhere(unit)
      pushLog('info', `${unit.name} 按到达卡移出游戏（1.6a：立即生效，不论处境）`, '1.6a')
    }
  }

  /**
   * 1.6a：把某算子**移出游戏**（盘面 / 空军 / **死亡堆**都清掉）
   *
   * 与 13.5 的「淘汰进死亡堆」（`eliminateEntry`）相反：被 Removal 的算子**不留在死亡堆**，
   * 故它不会出现在重建候选或 1.6c 的免费重建池里。
   */
  function removeFromPlayEverywhere(unit: ConsoleUnit): void {
    units.value = units.value.filter((item) => item.instanceId !== unit.instanceId)
    airUnits.value = airUnits.value.filter((item) => item.instanceId !== unit.instanceId)
    airMissionAirIds.value = airMissionAirIds.value.filter((id) => id !== unit.instanceId)
    deadPile.value = deadPile.value.filter((item) => item.instanceId !== unit.instanceId)
    if (selectedId.value === unit.instanceId) selectedId.value = null
  }

  /** B18：把算子送进死亡堆（13.5a 重建来源） */
  function sendToDeadPileNow(instanceId: string): void {
    const index = units.value.findIndex((unit) => unit.instanceId === instanceId)
    if (index < 0) return
    const [unit] = units.value.splice(index, 1)
    if (unit === undefined) return
    deadPile.value = [...deadPile.value, unit]
    pushLog('info', `${unit.name} 移入死亡堆（13.5a：死亡堆中的单位可重建）`, '13.5a')
  }

  /**
   * W7 C12：把死亡堆中的单位**放回图上**（1.6c 免费重建返场 / 编队抽签 B 组互换）
   *
   * 与 13.5 的常规重建（`rebuildUnitNow`：须付补员、且校验 HQ 2 格内）区分开：
   * 本动作只做「从死亡堆取出 → 落到指定格（可顺带改军力）」这一件事；
   * **费用与合法性由调用方先用引擎计划判好**（1.6c 免费重建 −1 军力、S3 B 组互换等）。
   */
  function returnFromDeadPileNow(input: {
    instanceId: string
    /** 落点格（列.行；1.6c 允许落在能直接拖取追溯补给的 HQ 或边缘补给源格） */
    hexText: string
    /** 返场后的军力（1.6c：−1 军力返场） */
    steps?: number
  }): boolean {
    const unit = deadPile.value.find((item) => item.instanceId === input.instanceId)
    if (unit === undefined) {
      pushLog('warning', `死亡堆中没有 ${input.instanceId}（13.5）`, '13.5')
      return false
    }
    // 本条是**地面**返场（1.6c 免费重建 / 编队抽签互换）——空军要落到空军基地并转非激活，
    // 口径不同（14.1a），故显式拒绝而不是当地面单位摆到图上
    if (isAirDeadPileEntry(unit)) {
      pushLog(
        'warning',
        `${unit.name} 是空军算子：本入口只做地面返场（空军返场须落空军基地，尚未接线）`,
        '13.5',
      )
      return false
    }
    const hex = parseHexPath(input.hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `返场须给出落点格（13.5a：须与补员同格并在 HQ 2 格内）`, '13.5')
      return false
    }
    deadPile.value = deadPile.value.filter((item) => item.instanceId !== input.instanceId)
    unit.hex = { ...hex }
    // 专规 3.5：死亡堆返场同样是"进入某格"
    noteUnitEnteredHex(unit, hex)
    if (input.steps !== undefined) unit.steps = input.steps
    unit.movementEnded = true
    units.value = [...units.value, unit]
    pushLog(
      'success',
      `${unit.name} 从死亡堆返场 → ${hex.col}.${hex.row}` +
        `${input.steps === undefined ? '' : `（军力 ${input.steps}）`}（1.6c 免费重建 / 编队抽签互换）`,
      '1.6c',
    )
    return true
  }

  /** B18：永久移除（13.5c：AR 后有黄点者被摧毁即永久移出） */
  function removeForeverNow(instanceId: string): void {
    const index = units.value.findIndex((unit) => unit.instanceId === instanceId)
    if (index >= 0) {
      const [unit] = units.value.splice(index, 1)
      if (unit !== undefined) removedForever.value = [...removedForever.value, unit]
    }
    deadPile.value = deadPile.value.filter((unit) => unit.instanceId !== instanceId)
    pushLog('info', `${instanceId} 永久移出游戏（13.5c）`, '13.5c')
  }

  /**
   * B18：重建一个单位（13.5 / 专规 1.6）
   *
   * `rebuildType` 是重建表行键（如 `Infantry Div step`）——本作工程库未落「算子 → 行」映射，
   * 由裁判按重建表选定（引擎只用行键取费用，不猜）。
   */
  function rebuildUnitNow(input: {
    unitId: string
    rebuildType: string
    replHexText?: string
    stepsToRestore?: number
    pairSize?: number
    unitsRequested?: number
  }): boolean {
    if (!requireAction('rein.rebuild', '重建')) return false
    const candidateUnit =
      deadPile.value.find((unit) => unit.instanceId === input.unitId) ??
      units.value.find((unit) => unit.instanceId === input.unitId)
    if (candidateUnit === undefined) {
      pushLog('warning', `找不到待重建单位 ${input.unitId}（13.5b）`, '13.5b')
      return false
    }
    /*
     * 13.5f（第五批批 C 切片 3）：**空军重建接线** —— 飞机走 Ftr/Tac 补员（专规 1.6 Notes：
     * Eq 不重建飞机、Ftr→F 型、Tac→T/S/Tpt 型、只重建一个军力），落点是"**处于追溯补给**的
     * 友方空军基地"、以**激活**状态出现。判据全在引擎 `planRebuild` 的 `isAircraft` 分支。
     */
    const isAir = isAirDeadPileEntry(candidateUnit)
    /*
     * 专规 1.6 placement：处于追溯补给的友方空军基地（12.6 按**格**判）
     * —— 复用与 `refreshTraceSupply` 同一条**掩码集合**范式（`traceCoverageHexes` 一次算全场），
     * 不再逐格调引擎函数（少一次导入、也少 N 次 Dijkstra）。
     */
    const traceCovered = traceCoverageHexes(supplyFacts.value, {
      side: activeSide.value,
      mobility: 'truck',
    })
    const traceSuppliedFriendlyBase = () =>
      airBases.value.find(
        (base) => base.side === activeSide.value && traceCoverageHas(traceCovered, base.hex),
      ) ?? null
    const replHex =
      input.replHexText === undefined ? null : (parseHexPath(input.replHexText)[0] ?? null)
    const hqHexes = arrivalFacts.value.directDrawHqHexes()
    const data = acceptReinforcement(
      planRebuild({
        side: activeSide.value,
        candidate: {
          id: candidateUnit.instanceId,
          side: candidateUnit.side,
          rebuildType: input.rebuildType,
          rebuildable: isAir ? true : candidateUnit.rebuildable !== false,
          isAircraft: isAir,
          ...(isAir ? { aircraftType: candidateUnit.aircraftType } : {}),
          inDeadPile: deadPile.value.some((unit) => unit.instanceId === input.unitId),
          hex: candidateUnit.hex,
          steps: candidateUnit.steps,
          printedSteps: isAir ? airPrintedStepsOf(candidateUnit) : candidateUnit.printedSteps,
          isBreakdown: isAir ? false : candidateUnit.specialized.includes('breakdown'),
          isTruckTransportPoint: isAir ? false : candidateUnit.noncombatKind === 'transport_point',
          ...(!isAir && candidateUnit.destroyedByEnemy === true ? { destroyedByEnemy: true } : {}),
        },
        ...(replHex === null ? {} : { replHex }),
        ...(input.stepsToRestore === undefined ? {} : { stepsToRestore: input.stepsToRestore }),
        ...(input.pairSize === undefined ? {} : { pairSize: input.pairSize }),
        ...(input.unitsRequested === undefined ? {} : { unitsRequested: input.unitsRequested }),
        holdings: replHoldings.value,
        facts: {
          // 13.5a：该格须在「战斗模式的友方 HQ（或 DG 但朝战斗面）」2 格内
          withinHqThrowOfFriendlyHq: (hex) =>
            hqHexes.some((hq) => hexDistance(hq, hex) <= rulesConstants.repl.rebuildHqRangeHexes),
          inUnnegatedEnemyZoc: (hex) => zocOnlySupplyFacts.value.inEnemyZoc(hex, activeSide.value),
          // 专规 1.6 placement：只认**处于追溯补给**的友方空军基地
          hasFriendlyAirBase: () => traceSuppliedFriendlyBase() !== null,
          friendlyAirBaseHex: () => {
            const base = traceSuppliedFriendlyBase()
            return base === null ? null : { ...base.hex }
          },
        },
      }),
      '重建',
    )
    if (data === null) return false
    // 落盘：扣补员、改军力、从死亡堆取回
    replHoldings.value = data.holdingsAfter
    lastRebuild.value = data
    const placement = data.placements[0]
    if (placement !== undefined) {
      const onMap = units.value.find((unit) => unit.instanceId === input.unitId)
      if (onMap === undefined) {
        const revived = deadPile.value.find((unit) => unit.instanceId === input.unitId)
        deadPile.value = deadPile.value.filter((unit) => unit.instanceId !== input.unitId)
        if (revived !== undefined && isAirDeadPileEntry(revived)) {
          // 13.5f：以**激活**状态从死亡堆抵达（新到之机 ⇒ 本阶段任务计数归零）
          revived.hex = { ...placement.hex }
          revived.steps = placement.stepsAfter
          revived.airStatus = 'active'
          revived.missionsFlownThisPhase = 0
          airUnits.value = [...airUnits.value, revived]
        } else if (revived !== undefined) {
          revived.hex = { ...placement.hex }
          revived.steps = placement.stepsAfter
          revived.movementEnded = true
          units.value = [...units.value, revived]
        }
      } else {
        onMap.steps = placement.stepsAfter
      }
    }
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：重建（13.5 / 专规 1.6）入会话日志（本笔不掷骰；费用与落点已由引擎判定）
    recordSettlement({
      action: 'rebuild',
      rule: data.rule,
      data: {
        unitId: input.unitId,
        rebuildType: input.rebuildType,
        detail: data.detail,
        placements: data.placements.map((placement) => ({
          hex: { ...placement.hex },
          stepsAfter: placement.stepsAfter,
        })),
      },
    })
    return true
  }

  /**
   * 专规 3.2（`axis_special.no_consolidation`）：**轴方不得整编**
   *
   * 判据＝这一手是轴方在下（动作方），**或**被合并的算子属轴方 —— 命中任一即拒，并留一条 warning。
   * 正常流程里两条等价（13.9 只合并同方算子）；只挂动作方会在"动作方与算子阵营不一致"的
   * 异常态下漏判，故两条都查。地面 13.9-1 与飞机 13.9-4 共用此处判据，避免两处口径漂移。
   */
  function axisConsolidationRefused(sides: readonly Side[], action: string): boolean {
    if (!sides.includes('axis')) return false
    pushLog(
      'warning',
      `专规 3.2：**轴心国不得整编**（${action}只对苏方开放）—— 本动作被拒，未改动任何账本`,
      '专规 3.2',
    )
    return true
  }

  /** B18：合并两个多军力单位（13.9-1） */
  function consolidateUnitsNow(keepId: string, removeId: string): boolean {
    if (!requireAction('rein.rebuild', '合并整编')) return false
    const keep = units.value.find((unit) => unit.instanceId === keepId)
    const remove = units.value.find((unit) => unit.instanceId === removeId)
    if (keep === undefined || remove === undefined) return false
    if (axisConsolidationRefused([activeSide.value, keep.side, remove.side], '合并多军力单位'))
      return false
    const data = acceptReinforcement(
      planConsolidation({
        kind: 'multiStepUnits',
        phaseIsReinforcement: true,
        keep: toConsolidationGroundView(keep),
        remove: toConsolidationGroundView(remove),
      }),
      '合并',
    )
    if (data === null) return false
    keep.steps = data.keepStepsAfter
    units.value = units.value.filter((unit) => unit.instanceId !== removeId)
    lastConsolidation.value = data
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：合并多军力单位（13.9-1）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'consolidate',
      rule: data.rule,
      data: {
        kind: 'multiStepUnits',
        keepId,
        removeId,
        keepStepsAfter: data.keepStepsAfter,
        detail: data.detail,
      },
    })
    return true
  }

  /** B18：合并两架同类减损飞机（13.9-4：可在任何阶段进行） */
  function consolidateAircraftNow(keepId: string, removeId: string): boolean {
    // 专规 3.2（`axis_special.no_consolidation`）：**轴方不得整编**（飞机同理，13.9-4 也受此限）
    const keep = airUnits.value.find((air) => air.instanceId === keepId)
    const remove = airUnits.value.find((air) => air.instanceId === removeId)
    if (keep === undefined || remove === undefined) return false
    if (axisConsolidationRefused([activeSide.value, keep.side, remove.side], '合并减损飞机'))
      return false
    const view = (air: ConsoleAirUnit, other: ConsoleAirUnit) => ({
      id: air.instanceId,
      // 13.9-4：同型判据看**当前面**的轰炸值（两枚减损机 ⇒ 都取减损面值）
      sameTypeAndValues:
        air.aircraftType === other.aircraftType &&
        airBarrageStrengthOf(air) === airBarrageStrengthOf(other),
      sameStatus: air.airStatus === other.airStatus,
      // 14.1b（第五批批 C 切片 1）：减损判据按**印值军力**（修前硬编码 2 ⇒ 单军力机 IL.2
      // 的 steps=1 被误判为"已减损"、两枚未损 IL.2 竟能合并出 2 点军力）
      reduced: air.steps < airPrintedStepsOf(air),
      locationKey: hexLabel(air.hex),
      steps: air.steps,
      printedSteps: airPrintedStepsOf(air),
    })
    const data = acceptReinforcement(
      planConsolidation({
        kind: 'aircraft',
        keep: view(keep, remove),
        remove: view(remove, keep),
      }),
      '飞机合并',
    )
    if (data === null) return false
    keep.steps = data.keepStepsAfter
    airUnits.value = airUnits.value.filter((air) => air.instanceId !== removeId)
    lastConsolidation.value = data
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：合并同类减损飞机（13.9-4）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'consolidate',
      rule: data.rule,
      data: {
        kind: 'aircraft',
        keepId,
        removeId,
        keepStepsAfter: data.keepStepsAfter,
        detail: data.detail,
      },
    })
    return true
  }

  /** B18：设置某国籍的拆分单位算子池存量（20.0g） */
  function setBreakdownPoolNow(nationality: string, count: number): void {
    breakdownPool.value = { ...breakdownPool.value, [nationality]: Math.max(0, Math.trunc(count)) }
  }

  /** B18：创建拆分单位（20.0a：开始移动 / 战后推进 / 战后撤退） */
  function createBreakdownNow(parentId: string, breakdownRecordId: string): boolean {
    // 20.0a：创建拆分单位只在「开始移动」（C 段）与战后推进/撤退（F/G 段的战斗环节）
    if (!requireAction('move.breakdown', '创建拆分单位')) return false
    const timing: BreakdownCreateTiming =
      phase.value === 'movement' ? 'startMove' : 'advanceAfterCombat'
    const parent = units.value.find((unit) => unit.instanceId === parentId)
    if (parent === undefined) return false
    const nationality = nationalityOfUnit(parent)
    const data = acceptReinforcement(
      planBreakdownCreate({
        parent: toBreakdownSideView(parent, nationality),
        breakdown: {
          ...toBreakdownSideView(parent, nationality),
          id: `breakdown:${breakdownRecordId}`,
          ar: parent.raw.ar,
        },
        timing,
        poolCount: breakdownPool.value[nationality] ?? 0,
        locked: parent.locked,
        count: 1,
      }),
      '创建拆分单位',
    )
    if (data === null) return false
    const record = choices.value.find((item) => item.id === breakdownRecordId)
    if (record === undefined) {
      pushLog('warning', `拆分子清单里没有 ${breakdownRecordId}（20.0g：同国籍池）`, '20.0g')
      return false
    }
    parent.steps = data.parentStepsAfter
    units.value = [
      ...units.value,
      toConsoleUnit({
        record,
        instanceId: createId('brk'),
        hex: { ...parent.hex },
        side: parent.side,
      }),
    ]
    breakdownPool.value = {
      ...breakdownPool.value,
      [nationality]: Math.max(0, (breakdownPool.value[nationality] ?? 0) - 1),
    }
    lastBreakdown.value = data
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：创建拆分单位（20.0a）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'breakdown',
      rule: data.rule,
      data: {
        kind: 'create',
        parentId,
        breakdownRecordId,
        nationality,
        parentStepsAfter: data.parentStepsAfter,
        detail: data.detail,
      },
    })
    return true
  }

  /**
   * B18：吸收拆分单位（20.0d：任何阶段结束时；母单位减损即强制）
   *
   * ★ 两个参数都是**实例 id**（图上算子），不是单位库的记录 id：
   *   母单位用 `units` 里的实例 id；拆分单位必须从**图上已有的拆分单位**里选。
   *   原先界面把「拆分子」下拉绑在单位库记录 id 上（那是 `createBreakdownNow` 需要的口径），
   *   于是这里永远查不到、静默返回 false，玩家点了没有任何反应。
   */
  function absorbBreakdownNow(parentId: string, breakdownId: string): boolean {
    const parent = units.value.find((unit) => unit.instanceId === parentId)
    if (parent === undefined) {
      reinforcementError.value = { rule: '20.0d', reason: `parentNotOnMap:${parentId}` }
      pushLog('warning', `吸收被拒：母单位 ${parentId} 不在图上（20.0d）`, '20.0d')
      return false
    }
    const breakdown = units.value.find((unit) => unit.instanceId === breakdownId)
    if (breakdown === undefined) {
      reinforcementError.value = { rule: '20.0d', reason: `breakdownNotOnMap:${breakdownId}` }
      pushLog(
        'warning',
        `吸收被拒：拆分单位 ${breakdownId} 不在图上（20.0d 须选**图上**的拆分单位实例）`,
        '20.0d',
      )
      return false
    }
    const nationality = nationalityOfUnit(parent)
    const data = acceptReinforcement(
      planBreakdownAbsorb({
        parent: toBreakdownSideView(parent, nationality),
        breakdown: toBreakdownSideView(breakdown, nationality),
        timing: 'segmentEnd',
        stacked: sameHex(parent.hex, breakdown.hex),
        parentReduced: parent.steps < parent.printedSteps,
      }),
      '吸收拆分单位',
    )
    if (data === null) return false
    parent.steps = data.parentStepsAfter
    units.value = units.value.filter((unit) => unit.instanceId !== breakdownId)
    breakdownPool.value = {
      ...breakdownPool.value,
      [nationality]: (breakdownPool.value[nationality] ?? 0) + 1,
    }
    lastBreakdown.value = data
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：吸收拆分单位（20.0d）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'breakdown',
      rule: data.rule,
      data: {
        kind: 'absorb',
        parentId,
        breakdownId,
        nationality,
        parentStepsAfter: data.parentStepsAfter,
        detail: data.detail,
      },
    })
    return true
  }

  /** B18：设置 / 解除 Slow Mobilization 的锁定（专规 2.4） */
  function setUnitLockedNow(instanceId: string, locked: boolean): void {
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return
    unit.locked = locked
    pushLog(
      'info',
      `${unit.name} → ${locked ? '锁定（不能移动、不能拆 breakdown）' : '解锁'}（专规 2.4）`,
      '专规 2.4',
    )
  }

  /** B18：按表 2-2 解锁某集团军的师（专规 2.4；玩家在锁定师中自选） */
  function unlockSlowMobilizationNow(
    army: '30th' | '28th' | '24th',
    unlockRequested: number,
  ): boolean {
    const lockedUnits = units.value.filter((unit) => unit.locked)
    const data = acceptReinforcement(
      planSlowMobilization({
        date: date.value,
        army,
        lockedDivisions: lockedUnits.length,
        unlockRequested,
      }),
      '慢动员解锁',
    )
    if (data === null) return false
    for (const unit of lockedUnits.slice(0, data.unlocked)) unit.locked = false
    pushLog('success', data.detail, data.rule)
    return true
  }

  /* ────────── 专规 2.3c：方面军预备队（＋1.6c 特殊补员的可用期） ────────── */

  /**
   * 专规 2.3c：本回合到期的方面军预备队批次（无 ⇒ null）
   *
   * 归位口径是引擎的 `frontalReservesBatch`（**轨上第一个 ≥ 卡面日期的回合**）——
   * 三批的卡面日期（22 Jul / 1 Aug / 1 Sep）在修正后的轨上都是真实回合（t5 / t8 / t17）。
   */
  const frontalReservesToday = computed<FrontalReservesBatch | null>(() =>
    frontalReservesBatch(date.value),
  )

  /** 2.3c：已领取的批次（键＝批次的**卡面日期**；「必须当即领取、不能保存」⇒ 每批一次） */
  const frontalReservesClaimed = ref<string[]>([])

  /** 2.3c：2 SP 与批次新单位的落点（2.1/3.1：随当日其它到达一起入场） */
  const frontalReservesInputs = ref<{ hexText: string }>({ hexText: '' })

  /** 2.3c 的错误（统一形状） */
  const frontalReservesError = ref<{ rule: string; reason: string } | null>(null)

  /** 2.3c 最近一次领取的结论（供面板回执） */
  const lastFrontalReserves = ref<{
    /** 已在盘面上执行的编制转化（旧单位已移出游戏 / 新单位已摆放） */
    applied: string[]
    /** **无法在盘面上执行**的义务（产物单位库缺该算子 ⇒ 交裁判手工处理） */
    obligations: string[]
    /** 两次免费重建的候选（从死亡堆里挑） */
    freeRebuildCandidates: { label: string; candidates: string[] }[]
    detail: string
  } | null>(null)

  /**
   * 2.3c：把卡面的编制转化单位在**产物单位库**里对上号
   *
   * 卡面写法是「印值 + 类型 + (番号)」，如 `12-1-4 Mtr Div (69)` / `8-1-5 Tk Rgt (114)`；
   * 产物里叫 `Ru 69 Mot Div` / `Ru 114 Tk Rgt`（`Mtr`→`Mot`、`Inf Div`→`Rifle Div`）。
   * 找不到即 `null`——**不臆造算子**，由调用方把卡面原文登记成义务。
   */
  function conversionRecordFor(cardText: string): UnitRecordView | null {
    const match = /^(.*)\(([^)]*)\)$/.exec(cardText.trim())
    if (match === null) return null
    const designation = match[2]!.trim()
    const typeText = match[1]!
      .replace(/^\d+-\d+-\d+\s*/, '')
      .replace(/\bMtr\b/g, 'Mot')
      .replace(/\bInf Div\b/g, 'Rifle Div')
      .trim()
    /*
     * 匹配对象是**算子名**：卡面写的是算子上的名字（`Ru 103 Mot Div`），不是主键
     * （`su-motorized-ru-103-mot-div`）。故同时比 `vassalName`（这正是卡面/算子上的名字来源）
     * 与 `recordNameOf`（显示名；产物里只有少数记录带 nameZh/nameEn，其余回落到主键）。
     */
    const wanted = new RegExp(`(^|\\s)${designation}\\s+${typeText}$`, 'i')
    return (
      unitChoices('soviet').find(
        (record) => wanted.test(record.vassalName ?? '') || wanted.test(recordNameOf(record)),
      ) ?? null
    )
  }

  /**
   * 专规 2.3c：**领取**本回合的方面军预备队
   *
   * 条文：「到货**必须立刻使用，不能保存**。每批方面军预备队包含：**2 SP** 与**一次编制转化**
   * （旧单位按 1.6a Removal 处理，新单位随其它到达的 SP/补员一起摆放）＋**两次免费重建**
   * （一架 IL.2 ＋ 一个 HQ 或火炮单位，玩家择一）。」
   *
   * 本动作：判日（引擎 `claimFrontalReserves`）→ 落 2 SP → 能执行的编制转化就执行
   * （旧单位**移出游戏**、新单位按落点摆放）→ 其余登记为义务（含卡面原文）→ 记会话日志。
   * ★ 免费重建的**选择权在玩家**（从死亡堆里挑），故本动作只给出候选，不代选。
   */
  function claimFrontalReservesNow(): boolean {
    if (!requireAction('rein.frontalReserves', '领取方面军预备队')) return false
    // 判日的**唯一权威**是引擎（`claimFrontalReserves` 内含 2.3c 的日程序列）
    const batch = acceptReinforcement(claimFrontalReserves(date.value), '方面军预备队')
    if (batch === null) {
      frontalReservesError.value = { rule: '2.3c', reason: `noFrontalReservesAtDate:${date.value}` }
      pushLog('warning', `${date.value} 不是方面军预备队的到货日（专规 2.3c）`, '2.3c')
      return false
    }
    if (frontalReservesClaimed.value.includes(batch.date)) {
      frontalReservesError.value = {
        rule: '2.3c',
        reason: `frontalReservesAlreadyClaimed:${batch.date}`,
      }
      pushLog('warning', `${batch.date} 这一批方面军预备队**已经领过**（不能重复，2.3c）`, '2.3c')
      return false
    }
    const hex = parseHexPath(frontalReservesInputs.value.hexText)[0]
    if (hex === undefined) {
      frontalReservesError.value = { rule: '2.3c', reason: 'frontalReservesPlacementRequired' }
      pushLog(
        'warning',
        `2 SP 与该批次的新单位需要落点 ⇒ 请填落点格号（列.行），收到「${frontalReservesInputs.value.hexText}」`,
        '2.3c',
      )
      return false
    }
    // ① 2 SP（12.1a：1 SP = 4 T；落到该格该方的补给账本上）
    grantSpDumpT(hex, 'soviet', batch.sp * SP_TO_T)

    // ② 编制转化：旧单位＝1.6a Removal（**移出游戏**，不进死亡堆）；新单位随到达摆放
    const applied: string[] = []
    const obligations: string[] = []
    const oldRecord = conversionRecordFor(batch.convertFrom)
    if (oldRecord === null) {
      obligations.push(
        `${batch.convertFrom} 须按 1.6a **移出游戏**（产物单位库没有这个算子 ⇒ 请手工处理）`,
      )
    } else {
      /*
       * 1.6a：「不论处境（**即使在死亡堆里**）」⇒ 盘面与死亡堆都要找一遍：
       * 同一个算子不可能同时在场与在堆里，但**可能只在堆里**——修前只扫盘面，于是那一种情形完全漏掉。
       */
      const onMap = units.value.filter(
        (unit) => unit.side === 'soviet' && unit.unitId === oldRecord.id,
      )
      const inPile = deadPile.value.filter(
        (entry): entry is ConsoleUnit =>
          !isAirDeadPileEntry(entry) && entry.unitId === oldRecord.id,
      )
      for (const entry of [...onMap, ...inPile]) removeFromPlayEverywhere(entry)
      const removed = onMap.length + inPile.length
      if (removed === 0) {
        /*
         * ★ 旧单位**本就不在场**（也已在死亡堆清过）⇒ 这是**已了结**的事实，不是「交裁判手工处理」。
         *   修前它被塞进 `obligations`（该字段的语义是「产物单位库缺算子 ⇒ 请手工处理」），
         *   于是面板的「须手工处理」清单里混着一条「无须处理」，与字段注释矛盾。
         */
        applied.push(`${batch.convertFrom} 已不在场（盘面与死亡堆都没有）⇒ 无须移除（1.6a）`)
      } else {
        applied.push(
          `${removed}× ${batch.convertFrom} 按 1.6a 移出游戏` +
            `（盘面 ${onMap.length} / 死亡堆 ${inPile.length}）`,
        )
      }
    }
    const newRecord = conversionRecordFor(batch.convertTo)
    if (newRecord === null) {
      obligations.push(
        `${batch.convertTo} 须随到达摆放（产物单位库没有这个算子 ⇒ 请按卡面印值手工摆放）`,
      )
    } else {
      units.value = [
        ...units.value,
        toConsoleUnit({
          record: newRecord,
          instanceId: createId('fr'),
          hex,
          side: 'soviet',
        }),
      ]
      applied.push(`${recordNameOf(newRecord)} 按落点 ${hexLabel(hex)} 到场`)
    }

    // ③ 两次免费重建：候选只列死亡堆里的，选择权留给玩家
    const freeRebuildCandidates = batch.freeRebuilds.map((label) => ({
      label,
      candidates: deadPile.value
        .filter((entry) => matchesFreeRebuildLabel(entry, label))
        .map((entry) => entry.name),
    }))

    frontalReservesClaimed.value = [...frontalReservesClaimed.value, batch.date]
    frontalReservesError.value = null
    lastFrontalReserves.value = {
      applied,
      obligations,
      freeRebuildCandidates,
      detail:
        `方面军预备队 ${batch.date} 已领：+${batch.sp} SP 落 ${hexLabel(hex)}；` +
        `编制转化 ${batch.convertFrom} → ${batch.convertTo}（${applied.length} 步已落盘）` +
        (obligations.length === 0 ? '' : `；待手工处理 ${obligations.length} 项`),
    }
    pushLog('success', lastFrontalReserves.value.detail, '2.3c')
    recordSettlement({
      action: 'frontalReserves',
      rule: '2.3c',
      data: {
        batchDate: batch.date,
        sp: batch.sp,
        hex: { ...hex },
        convertFrom: batch.convertFrom,
        convertTo: batch.convertTo,
        applied: [...applied],
        obligations: [...obligations],
      },
    })
    return true
  }

  /** 2.3c 的免费重建标签（`IL.2` / `HQ or artillery`）该不该收这个死亡堆算子 */
  function matchesFreeRebuildLabel(entry: DeadPileEntry, label: string): boolean {
    const name = entry.name
    if (/^IL\.2$/i.test(label)) return /IL\.2/i.test(name)
    // 「一个 HQ 或火炮单位」⇒ HQ 或带印刷轰炸值的火炮（飞机不在其列）
    if (isAirDeadPileEntry(entry)) return false
    return entry.specialized.includes('hq') || entry.raw.barrage !== undefined
  }

  /* ────────── W6 B19：Smolensk 专规机制（1.2 / 1.7 / 2.1a / 2.2 / 3.3b / 3.4 / 3.5） ────────── */

  /** 当前剧本的初设栏（`scenarios.setup`：3.5 建造标记 / 1.7 补给缓存等剧本级数值的唯一来源） */
  const scenarioSetup = computed(
    () => scenarios.scenarios.find((item) => item.id === scenarioId.value)?.setup,
  )

  /** 3.4：装甲集群分界线（产品数据 `map-config.panzerGroupBoundary` 第一段：19.19 → 62.23） */
  const panzerGroupBoundary = computed<PanzerGroupBoundary | null>(() => {
    const pair = mapConfig.panzerGroupBoundary?.[0]
    if (pair === undefined) return null
    const [west, east] = pair
    if (west === undefined || east === undefined) return null
    return { west: { ...west }, east: { ...east } }
  })

  /**
   * 批 F 切片 1（专规 3.4 原文「分界线为 **19.19 → 62.23** 的**多轨铁路线**」）：
   * **沿线走的 45 格路径**（从 `map-layers` 的多轨铁路格边推出；不连通即 null）
   *
   * 与判据、渲染**共用同一条路径**（`boundaryLine` / `panzerGroupBoundaryWithPath`）——
   * 修前渲染画的是两端格心之间的一条**直线**、判据按**列线性插值**，而铁路线在 ±1 行内摆动 ⇒ 两处都错。
   */
  const panzerBoundaryPath = computed<readonly HexRef[] | null>(() =>
    panzerGroupBoundary.value === null
      ? null
      : panzerGroupBoundaryPath({
          from: panzerGroupBoundary.value.west,
          to: panzerGroupBoundary.value.east,
          facts: createMultiTrackRailFacts(),
        }),
  )

  /** 3.4：**带路径**的分界线（判据与渲染都读这一份；路径缺失时退回直线口径） */
  const panzerGroupBoundaryWithPath = computed<PanzerGroupBoundary | null>(() => {
    const boundary = panzerGroupBoundary.value
    if (boundary === null) return null
    const path = panzerBoundaryPath.value
    return path === null ? boundary : { ...boundary, path }
  })

  /** 3.4a：Orsha 格（取地图城市名数据，不写死坐标） */
  const orshaHex = computed<HexRef | null>(() => {
    const found = mapLayers.hexes.find((hex) => hex.city?.name === 'Orsha')
    return found === undefined ? null : { col: found.col, row: found.row }
  })

  /**
   * 3.4：算子的装甲集群归属
   *
   * ★ 用户口径：「霍特或古德里安的编队不用玩家设置」——归属已由素材库的**编队目录**定死，
   * 由 `scripts/sync-units.mjs` 落到算子数据（`record.panzerGroup`）。
   * 故此处取「玩家显式声明 ?? 数据默认」：裁判仍可覆盖（罕见情形），但默认无需任何操作。
   */
  const panzerGroupAssignments = ref<Record<string, PanzerGroup>>({})

  /** 3.4：算式子 → 装甲集群（玩家声明优先，否则用算子数据里的默认） */
  function groupOfUnit(unit: ConsoleUnit): PanzerGroup | null {
    return panzerGroupAssignments.value[unit.instanceId] ?? unit.panzerGroup ?? null
  }

  /** 3.4：已归属装甲集群的算子数（默认取自素材编队目录 + 手工声明） */
  const panzerGroupAssignedCount = computed(
    () => units.value.filter((unit) => groupOfUnit(unit) !== null).length,
  )

  /**
   * 3.4：裁判声明的「属多单位编队」实例 id（3.4 只约束多单位编队，步兵师与独立单位不受限）
   *
   * 默认口径与编队数据一致：**凡属某装甲集群的算子即属多单位编队**（编队单位目录里的算子），
   * 故同样不必玩家逐个登记；此数组只用于显式补充。
   */
  const multiUnitFormationIds = ref<string[]>([])

  /** 3.4a：分界线判据所需的单位视图 */
  const panzerGroupUnitViews = computed<PanzerGroupUnitView[]>(() =>
    units.value.map((unit) => ({
      id: unit.instanceId,
      group: groupOfUnit(unit),
      inMultiUnitFormation:
        multiUnitFormationIds.value.includes(unit.instanceId) || unit.panzerGroup != null,
      hex: unit.hex,
    })),
  )

  /**
   * 3.4a：相位末的分界线义务
   *
   * 逐编队给出「须投 DG」的结果（① 与另一集群同堆叠/相邻；② 错误一侧且 Orsha 以东）；
   * 19 August 起（`panzerGroupConstraintEnd`）自动失效。
   */
  const panzerGroupObligations = computed<readonly DividingLineObligation[]>(() => {
    // ★ 批 F 切片 1：判据用**带路径**的那一份（分界线是多轨铁路折线，不是直线）
    const boundary = panzerGroupBoundaryWithPath.value
    const orsha = orshaHex.value
    if (boundary === null || orsha === null) return []
    return dividingLineObligations({
      units: panzerGroupUnitViews.value,
      scope: { boundary, orshaHex: orsha },
      date: date.value,
      adjacent: areAdjacent,
      sameHex,
    })
  })

  /**
   * B37 / 3.4a：**此刻是不是结算分界线义务的时候**（段末）
   *
   * 判据完全走闸门（`exclusive.panzerObligation` → 轴方 C/G 移动环节的**段末**）：
   * 于是"义务清单"不会再在段中老是挂在界面上，玩家也不会在段中以为已经结算过。
   * 义务本身仍由引擎 `dividingLineObligations` 给结论（本投影只说"现在该看它了"）。
   */
  const panzerObligationActive = computed<boolean>(() =>
    allowedActionsOf(segmentGateQuery.value).has('exclusive.panzerObligation'),
  )

  /**
   * B37 / 3.4a：**错误一侧的格**（提示用）
   *
   * 结论取自引擎的 `panzerGroupObligations`（它已经把"19 August 前才生效"与
   * `boundarySideOf` 的判断都做完了）——本处只把**触发条件是"错误一侧"**的那些单位
   * 归到一起、去重成格。等价于"这些格里有站错一侧的编队单位"。
   */
  const panzerWrongSideHexes = computed<readonly HexRef[]>(() => {
    const seen = new Map<string, HexRef>()
    for (const obligation of panzerGroupObligations.value) {
      if (obligation.reason !== 'wrongSideOfLineEastOfOrsha') continue
      for (const unitId of obligation.unitIds) {
        const unit = units.value.find((item) => item.instanceId === unitId)
        if (unit === undefined) continue
        seen.set(`${unit.hex.col}.${unit.hex.row}`, { ...unit.hex })
      }
    }
    return [...seen.values()]
  })

  /**
   * B37 / 3.4：分界线的**渲染投影**（线 + 提示格）
   *
   * ★ 批 F 切片 1：带上 `path`（多轨铁路折线，45 格）——渲染层画的就是它，与判据**同一条路径**。
   */
  const boundaryView = computed<BoundaryLine | null>(() => {
    const boundary = panzerGroupBoundary.value
    if (boundary === null) return null
    return {
      from: { ...boundary.west },
      to: { ...boundary.east },
      ...(panzerBoundaryPath.value === null ? {} : { path: panzerBoundaryPath.value }),
      wrongSideHexes: panzerWrongSideHexes.value,
    }
  })

  /**
   * B37（方案 §3 步骤 2）：**本环节可做的专规动作**（界面据此置顶/自动开窗）
   *
   * 键的取值范围只列**专规面板自己拥有**的动作族（不与别处共用）——
   * 例如 16.0b 的工事、13.8d 的建造虽然也是"专规机制"，但它们的入口在别处面板里，
   * 列进来会让专规窗在本环节无端弹出。
   * 判据＝闸门表（`allowedActionsOf`），每条都带规则号，界面直接显示。
   */
  const EXCLUSIVE_PANEL_KEYS: readonly ActionKey[] = [
    'exclusive.forage',
    'exclusive.panzerObligation',
  ]

  const exclusiveActionsInStep = computed<readonly ActionGate[]>(() => {
    const allowed = allowedActionsOf(segmentGateQuery.value)
    return EXCLUSIVE_PANEL_KEYS.filter((key) => allowed.has(key)).map((key) => actionGateOf(key))
  })

  /**
   * B37 余项：**专规面板的分节置顶判据**（哪一节"本环节该做"）
   *
   * 每节的判据都写在这里（一处），面板只读结果：
   *   · `panzer`（3.4）：段末的分界线义务可结算，**或**还有没登记集群归属的新到 SP（3.4b 要求立即归属）；
   *   · `security`（3.3b）：有城要放标记，或（清理段）有标记要移除；
   *   · `hedgehog`（16.0b/c）、`constructionMarker`（专规 3.5）：本环节的闸门放行（后者还须有枚数）；
   *   · `supplyCache`（1.7）：本环节的闸门放行；
   *   · `airRestriction`（1.2 苏军空军限制）：**纯只读提示** ⇒ 不置顶。
   */
  const exclusiveSectionPins = computed<Record<ExclusiveSection, boolean>>(() => {
    const allowed = allowedActionsOf(segmentGateQuery.value)
    const needs = securityNeeds.value
    return {
      panzer:
        // 3.4a 的分界线义务与 3.4b 的待办是两半：后者只在 3.4b 生效时才算「早该做的」
        allowed.has('exclusive.panzerObligation') ||
        (panzerGroupRulesOn.value && pendingSpGroupAssignment.value.length > 0),
      security:
        (needs?.placeAt.length ?? 0) > 0 ||
        (removalAllowedNow(phase.value) && (needs?.removeAt.length ?? 0) > 0),
      hedgehog: allowed.has('move.hedgehog'),
      constructionMarker: allowed.has('move.construction') && constructionMarkers.value > 0,
      supplyCache: allowed.has('exclusive.forage'),
      airRestriction: false,
    }
  })

  /** 3.4b：Supply Table 到货点数（界面输入，用于展示均分结果） */
  const supplyTableSpInput = ref(7)

  /** 3.4b：均分结果（平均分给 Guderian 与 Hoth，奇数点归 Guderian） */
  const panzerGroupSpSplit = computed(() => splitSupplyTableSp(supplyTableSpInput.value))

  /** 1.7 / 21.10：补给缓存持有量（初值取剧本初设 `setup.supplyCache`，缺省回落专规 1.7 的规则值） */
  const supplyCacheHoldings = ref<SupplyCacheHoldings>(
    initialSupplyCacheHoldings(scenarioSetup.value?.supplyCache),
  )

  /** 1.7 / 21.10：补给缓存的用法输入（界面绑定） */
  const supplyCacheInputs = ref({
    use: 'shells' as SupplyCacheUse,
    hexText: '',
    /** 21.10 Shells：本次 HQ 投递的火炮轰炸成本（T） */
    barrageCostT: 4,
    /** 21.10 Forage：该 HQ 的投递距离（格；13.1b 印值） */
    hqThrowRangeHexes: 5,
    /*
     * 21.10 的「敌军切断该 HQ 补给的第一个回合」**不再由裁判勾选**（批 F 切片 5 删除该字段）：
     * 判据改由 `isFirstTurnOfBeingCut` 按盘面事实算（与 12.8e 同源，见 `cutSinceTurn`）。
     */
    /** 21.10 Shells：该 HQ 是否在追溯补给中（不影响合法性，仅日志） */
    hqDrawsTraceSupply: true,
  })

  /** 1.7：最近一次补给缓存用法结论 */
  const lastSupplyCacheUse = ref<string | null>(null)

  /** 3.5：建造标记剩余枚数（初值取剧本初设 `setup.constructionMarkers`；剧本 1/2 = 3，其余 = 0） */
  const constructionMarkers = ref<number>(scenarioSetup.value?.constructionMarkers ?? 0)

  /** 3.3b：裁判声明的「轴心国控制城市」格键集合（键 = `col.row`；控制状态由裁判维护） */
  const axisControlledCityKeys = ref<string[]>([])

  /** 3.3b：已放置的苏军 Trainbusting 标记（游击队活动） */
  const trainbustingMarks = ref<TrainbustingMarkerView[]>([])

  /** 3.3b：地图上的城市格（产品数据 map-layers 的 `city` 字段） */
  const mapCityHexes = computed<HexRef[]>(() =>
    mapLayers.hexes
      .filter((hex) => hex.city !== undefined)
      .map((hex) => ({ col: hex.col, row: hex.row })),
  )

  /** 3.3b：治安检查的逐城事实（控制＝裁判声明；占据与 ZOC 由盘面推得） */
  const securityCityViews = computed<SecurityCheckCityView[]>(() =>
    mapCityHexes.value.map((hex) => {
      const name = mapLayers.hexes.find((item) => item.col === hex.col && item.row === hex.row)
        ?.city?.name
      return {
        hex,
        ...(name === undefined ? {} : { name }),
        controlledByAxis: axisControlledCityKeys.value.includes(`${hex.col}.${hex.row}`),
        occupiedByAttackCapable: units.value.some(
          (unit) => unit.side === 'axis' && unit.attackCapable && sameHex(unit.hex, hex),
        ),
        coveredByAxisZoc: zocOnlySupplyFacts.value.inEnemyZoc(hex, 'axis'),
        hasTrainbusting: trainbustingMarks.value.some((mark) => sameHex(mark.hex, hex)),
      }
    }),
  )

  /** 3.3b：治安需求结论（需求未满足且无标记 ⇒ 应放置；满足或转苏控 ⇒ 应移除） */
  const securityNeeds = computed<SecurityNeedsResult | null>(() => {
    const outcome = checkSecurityNeeds(securityCityViews.value)
    return outcome.ok ? outcome.data : null
  })

  /** 3.3b 逐城明细的一行（界面用；结论全部来自引擎） */
  interface SecurityCityDetail {
    label: string
    controlledByAxis: boolean
    occupied: boolean
    zoc: boolean
    marked: boolean
    /** 引擎（`checkSecurityNeeds`）给出的动作；`none` ＝ 本回合该城无事可做 */
    action: 'place' | 'remove' | 'none'
    /** 3.3b：该城标记**为何**该移除（`removalReasonOf`；不该移除为 null） */
    removalReason: TrainbustingRemovalReason | null
    /** 3.3b：当前阶段是否允许移除（只在 H 清理段） */
    removalAllowedNow: boolean
  }

  /**
   * 3.3b：**逐城明细**（哪座城需要放标记、哪座该移除、为什么）
   *
   * ★ 动作（place/remove）**不在这里重算**：唯一权威是引擎的 `checkSecurityNeeds`
   *   （本项只把它的 `placeAt`/`removeAt` 映射回逐城行）；「为什么移除」取 `removalReasonOf`，
   *   它的存在就是为了给界面/日志一个与 `checkSecurityNeeds` 同源的**理由**。
   *   修前 `securityCityViews` 导出而界面零引用，玩家只能看到三个计数，看不到是哪座城、
   *   也看不到 H 段才允许移除。
   */
  const securityCityDetails = computed<SecurityCityDetail[]>(() => {
    const needs = securityNeeds.value
    const place = new Set((needs?.placeAt ?? []).map((hex) => hexLabel(hex)))
    const remove = new Set((needs?.removeAt ?? []).map((hex) => hexLabel(hex)))
    const canRemove = removalAllowedNow(phase.value)
    const rows = securityCityViews.value.map((city): SecurityCityDetail => {
      const key = hexLabel(city.hex)
      return {
        label: city.name === undefined ? key : `${key} ${city.name}`,
        controlledByAxis: city.controlledByAxis,
        occupied: city.occupiedByAttackCapable,
        zoc: city.coveredByAxisZoc,
        marked: city.hasTrainbusting,
        action: place.has(key) ? 'place' : remove.has(key) ? 'remove' : 'none',
        removalReason: removalReasonOf(city),
        removalAllowedNow: canRemove,
      }
    })
    // 有事可做的城排前面（同序内保持地图顺序）
    const rank = { place: 0, remove: 1, none: 2 } as const
    return rows.sort((a, b) => rank[a.action] - rank[b.action])
  })

  /** 2.1a：补给源关闭判据的地图事实（模块级常量；南缘＝没有图内南邻） */
  const supplyShutdownFacts = computed<SupplyShutdownFacts>(() => SHUTDOWN_FACTS)

  /** 2.1a：己方补给源当日状态（Entry L 于 19 Jul、Entry E 及以西南缘于 19 Aug 永久关闭） */
  const activeSupplySourceStatuses = computed<readonly SupplySourceStatus[]>(() =>
    supplySourceStatuses({
      side: activeSide.value,
      date: date.value,
      sources: scenarioSupplySourceHexes.value,
      facts: supplyShutdownFacts.value,
    }),
  )

  /** 1.2：当日铁路容量（轴/苏；19 July 提升） */
  const railCapToday = computed(() => railCapacitiesOn(date.value))

  /** 专规时点日历（1.2 / 1.6c / 2.1a / 2.3c / 2.3e / 2.4 / 3.3c / 3.4 / 3.6 / 5.0b） */
  const exclusiveTimings = computed<readonly ExclusiveTimingEntry[]>(() =>
    exclusiveTimingCalendar(),
  )

  /** 当日生效的专规时点（界面提示「今天该做什么」） */
  const todaysTimings = computed<readonly ExclusiveTimingEntry[]>(() => timingsOn(date.value))

  /**
   * 2.2（苏）/ 3.2a（轴）：当前空军任务的**阵营层限制预检**
   *
   * ★ 这里只做**界面预检**（把 `red-air-force.ts` 的统一口径显示给玩家）；
   *   **权威否决**在引擎 `assignAirMission`（`beginAirInteraction`）内，两者共用 `air.ts` 的同一批判据，
   *   故不会出现「两处各判一遍」的口径漂移。
   */
  const redAirForceAdvisory = computed<RuleOutcome<RedAirForceCheckResult> | null>(() => {
    const airPhase = airMissionPhaseOf(phase.value)
    if (airPhase === null) return null
    return checkRedAirForceMission({
      side: activeSide.value,
      phase: airPhase,
      weatherNormal: airInputs.value.weatherNormal,
      missionKind: airMissionKind.value,
      // 2.2b：空投战斗单位属「需计划的任务」（14.10b）
      requiresPlan: airMissionKind.value === 'air_drop',
    })
  })

  /** B19 的错误（统一形状：rule + reason） */
  const exclusiveError = ref<{ rule: string; reason: string } | null>(null)

  /** 统一收 B19 引擎结论（失败即记错误与日志并返回 null） */
  function acceptExclusive<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      exclusiveError.value = null
      return outcome.data
    }
    exclusiveError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /** 3.4：声明某算子的装甲集群归属（null ＝ 撤销声明，不受 3.4 约束） */
  function setPanzerGroupNow(instanceId: string, group: PanzerGroup | null): void {
    const next = { ...panzerGroupAssignments.value }
    if (group === null) delete next[instanceId]
    else next[instanceId] = group
    panzerGroupAssignments.value = next
  }

  /** 3.4：声明某算子是否属多单位编队（只有多单位编队受分界线约束） */
  function setMultiUnitFormationNow(instanceId: string, inFormation: boolean): void {
    multiUnitFormationIds.value = inFormation
      ? [...new Set([...multiUnitFormationIds.value, instanceId])]
      : multiUnitFormationIds.value.filter((id) => id !== instanceId)
  }

  /* ────────── 3.4b：装甲集群的 **SP 归属**与付费限制 ────────── */

  /**
   * 3.4b：各补给站的装甲集群归属（键＝补给站 id）
   *
   * 「**所有新到的轴心国 SP 必须立即归属某一装甲集群**」——故这是**补给站**的属性，
   * 与算子的编队归属（`panzerGroupAssignments`，判 3.4a 分界线用）是两码事：
   * 一处讲「这支部队属于谁」，一处讲「这堆弹药属于谁」。
   */
  const spDumpPanzerGroups = ref<Record<string, PanzerGroup>>({})

  /** 3.4b：该补给站归属的集群（未登记 ⇒ null，即"尚未归属"） */
  function panzerGroupOfDump(dumpId: string | null): PanzerGroup | null {
    if (dumpId === null) return null
    return spDumpPanzerGroups.value[dumpId] ?? null
  }

  /**
   * 3.4b：**在局中新到、尚未归属**装甲集群的轴方补给站 id
   *
   * ★ 这一串的用途是把「新到的 SP」与「初设/裁判已久的 SP」区分开：
   *   `checkPanzerGroupSpPayment` 的 `unassigned` 分支是**绝对拦阻**（在"是否多单位编队"之前就判），
   *   若把它套到**每一座**没登记归属的补给站上，步兵师的普通攻击也会被 3.4b 拦掉——
   *   那条约束只管「新到的轴方 SP 必须立即归属」。故只有经 `addSpDump` 新落的轴方补给站才进这一串。
   */
  /**
   * B50（用户 2026-09-17 口径）：**3.4b 在本局是否生效** —— 日期窗口 × 开局共识（4.1a 可选）
   *
   * 未采纳 ⇒ 不登记待办、不列未归属站、不因"未归属"拒付、专规面板也不出现归属界面
   * （规则不生效时给玩家一套用不上的按钮，比没有更糟）。
   * 判据本身只有一处：引擎 `panzerGroupRulesActive`。
   */
  const panzerGroupRulesOn = computed(() =>
    panzerGroupRulesActive({
      constraintApplies: date.value < PANZER_GROUP_CONSTRAINT_END,
      agreedByConsensus: session.agreedOptionAdoptedOf(PANZER_GROUP_OPTION_ITEM),
    }),
  )

  const pendingSpGroupAssignment = ref<string[]>([])

  /** 3.4b：声明/撤销某补给站的装甲集群归属（null ⇒ 撤销声明） */
  function setDumpPanzerGroupNow(dumpId: string, group: PanzerGroup | null): void {
    const next = { ...spDumpPanzerGroups.value }
    if (group === null) delete next[dumpId]
    else next[dumpId] = group
    spDumpPanzerGroups.value = next
    // 声明过即不再"待归属"（撤销声明会把它放回待归属串）
    pendingSpGroupAssignment.value =
      group === null
        ? [...new Set([...pendingSpGroupAssignment.value, dumpId])]
        : pendingSpGroupAssignment.value.filter((id) => id !== dumpId)
    const dump = spDumps.value.find((item) => item.id === dumpId)
    pushLog(
      'info',
      dump === undefined
        ? `补给站 ${dumpId} 的装甲集群归属 → ${group ?? '（撤销）'}（3.4b）`
        : `${hexLabel(dump.hex)} 的 SP 归属 → ${group === null ? '（撤销声明）' : group === 'guderian' ? 'Guderian（2nd PG）' : 'Hoth（3rd PG）'}（3.4b）`,
      '3.4b',
    )
  }

  /** 3.4b：**尚未归属**装甲集群的轴方补给站（3.4b：新到的轴方 SP 必须立即归属） */
  const panzerGroupUnassignedDumps = computed<SpDump[]>(() =>
    // B50：3.4b 未启用 ⇒ 这张表整体为空（面板据此也隐藏该块）
    !panzerGroupRulesOn.value
      ? []
      : spDumps.value.filter((dump) => dump.side === 'axis' && panzerGroupOfDump(dump.id) === null),
  )

  /**
   * 3.4b：这笔费用能否由该补给站的 SP 支付
   *
   * 「『错误』装甲集群的 SP **不能**用于支付多单位编队的**燃油、战斗或轰炸**成本；除此之外 SP 使用不限。」
   *
   * 唯一判据是引擎的 `checkPanzerGroupSpPayment`；本处只把盘面事实填进去：
   *   · 付费方＝**该补给站登记的**集群（未登记即"尚未归属"）；
   *   · 受益编队＝全部受益单位**共用**的那一个集群——混编、空集或有不属编队者 ⇒ 交 `null`，
   *     引擎据此判「不受限」（3.4：只约束多单位编队）。
   */
  function panzerGroupSpGate(input: {
    /** 付款的补给站（null ＝ 无来源归属可查 ⇒ 不在此处判） */
    dumpId: string | null
    purpose: PanzerGroupSpPurpose
    /** 这笔费用服务的单位（3.4b 的"多单位编队"按**受益方**判） */
    beneficiaryUnitIds: readonly string[]
  }): RuleFailure | null {
    const dump = spDumps.value.find((item) => item.id === input.dumpId) ?? null
    // 3.4 / 3.4b 只约束**轴心国**的 SP 与编队（苏军无装甲集群）
    if (dump === null || dump.side !== 'axis') return null

    const beneficiaries = input.beneficiaryUnitIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
    const groups = new Set(
      beneficiaries
        .map((unit) => groupOfUnit(unit))
        .filter((group): group is PanzerGroup => group !== null),
    )
    const formationGroup = groups.size === 1 ? [...groups][0]! : null
    const inMultiUnitFormation =
      beneficiaries.length > 0 &&
      beneficiaries.every(
        (unit) =>
          groupOfUnit(unit) !== null ||
          multiUnitFormationIds.value.includes(unit.instanceId) ||
          unit.panzerGroup != null,
      )

    const outcome = checkPanzerGroupSpPayment({
      spGroup: panzerGroupOfDump(dump.id),
      formationGroup,
      purpose: input.purpose,
      date: date.value,
      inMultiUnitFormation,
      /*
       * 3.4b：「新到的轴方 SP 必须立即归属」这条**只在它真去替多单位编队付账时才拦**。
       *
       * ★ 两层收窄，都是为了不把条文读成"账簿没登记就不许打仗"：
       *   ① 只有**在局中新落**的轴方补给站才算「新到」（见 `pendingSpGroupAssignment`）——
       *      初设/裁判已久的 SP 按 Setup Note F 早已分配，不该被当成新到的；
       *   ② 只有**多单位编队**的受限用途才拦——步兵师与独立单位的战斗与这座站的归属无关，
       *      因为登记疏漏而拦掉一场普通攻击，那不是 3.4b 的意思。
       */
      unassigned:
        inMultiUnitFormation &&
        panzerGroupOfDump(dump.id) === null &&
        pendingSpGroupAssignment.value.includes(dump.id),
      /* B50：4.1a 可选项 —— 本局未采纳 3.4b 时，整条判据在引擎里提前放行 */
      agreedByConsensus: panzerGroupRulesOn.value,
    })
    return outcome.ok ? null : fail(outcome.rule, outcome.reason)
  }

  /** 3.4b 的拒付消息（把「去哪个界面声明」一并说清，免得只报一个错误码） */
  function panzerGroupSpRefusal(
    failure: RuleFailure,
    purpose: string,
    dumpId: string | null,
  ): string {
    const dump = spDumps.value.find((item) => item.id === dumpId)
    const where = dump === undefined ? '该补给站' : hexLabel(dump.hex)
    const detail =
      failure.reason === 'newSpMustBeAssignedToAPanzerGroup'
        ? `${where} 的 SP **尚未归属**任何装甲集群（3.4b：新到的轴方 SP 必须立即归属）⇒ 先在专规面板为它声明归属`
        : `${where} 的 SP 归属与受益编队不符（3.4b：错误集群的 SP 不能支付${purpose}成本）`
    return `${detail}`
  }

  /** 1.7：补给缓存 +1（专规 1.6c 特殊补员的结果之一） */
  function addSupplyCacheNow(side: 'axis' | 'soviet'): void {
    supplyCacheHoldings.value = addSupplyCache(supplyCacheHoldings.value, side)
    pushLog('info', `${side === 'axis' ? '轴心' : '苏军'}补给缓存 +1（专规 1.6c / 1.7）`, '1.7')
    // ⑭ 接线：补给缓存 +1（专规 1.6c / 1.7）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyCache',
      rule: '1.7',
      side,
      data: { gain: 1, holdings: { ...supplyCacheHoldings.value } },
    })
  }

  /**
   * 1.7 / 21.10：花掉一枚补给缓存
   *
   * - **Shells**：抵付该 HQ 投递的火炮轰炸成本（每标记 2T，成本降到 0 以下不找零）；
   * - **Forage**：在**补给阶段**（D 段）让 HQ 为其投递距离内所有战斗单位提供追溯补给
   *   （仅限断补首回合、不可用于矛头部队）。
   */
  function spendSupplyCacheNow(): boolean {
    // B37：1.7 / 21.10 —— 补给缓存的两个用法都只在**补给段**（引擎 `forageOnlyInSupplyPhase` 同口径）
    if (!requireAction('exclusive.forage', '使用补给缓存')) return false
    const inputs = supplyCacheInputs.value
    const hex = parseHexPath(inputs.hexText)[0]
    if (hex === undefined) {
      exclusiveError.value = { rule: '1.7', reason: `hqHexFormatInvalid:${inputs.hexText}` }
      pushLog('warning', `HQ 格格式应为「列.行」，收到「${inputs.hexText}」（1.7）`, '1.7')
      return false
    }

    let detail: string
    let rule: string
    if (inputs.use === 'shells') {
      const data = acceptExclusive(
        useSupplyCacheAsShells({
          side: activeSide.value,
          holdings: supplyCacheHoldings.value,
          hqHex: hex,
          barrageCostT: inputs.barrageCostT,
          hqDrawsTraceSupply: inputs.hqDrawsTraceSupply,
        }),
        '补给缓存 Shells',
      )
      if (data === null) return false
      detail = data.detail
      rule = data.rule
    } else {
      /*
       * 21.10：「让**被切断的第一个回合**的 HQ 为其投递距离内的所有战斗单位提供追溯补给」——
       * 「第一个回合」的判据取**真跟踪**（与 12.8e 同源：`isFirstTurnOfBeingCut`），
       * 修前这里是面板上一个裁判手勾的复选框（`supplyCacheInputs.firstTurnOfBeingCut`）⇒
       * "自己说自己是首回合就算首回合"。批 F 切片 5 起该字段删除，改由盘面事实算。
       */
      const hqUnit = units.value.find(
        (unit) => unit.side === activeSide.value && isHqUnit(unit) && sameHex(unit.hex, hex),
      )
      if (hqUnit === undefined) {
        exclusiveError.value = { rule: '21.10', reason: `noHqAtHex:${inputs.hexText}` }
        pushLog('warning', `21.10：${inputs.hexText} 没有本方的指挥部 ⇒ Forage 无从谈起`, '21.10')
        return false
      }
      const data = acceptExclusive(
        useSupplyCacheAsForage({
          side: activeSide.value,
          holdings: supplyCacheHoldings.value,
          phase: phase.value,
          hqHex: hex,
          hqThrowRangeHexes: inputs.hqThrowRangeHexes,
          firstTurnOfBeingCut: isFirstTurnOfBeingCut(hqUnit),
        }),
        '补给缓存 Forage',
      )
      if (data === null) return false
      detail = data.detail
      rule = data.rule
    }

    supplyCacheHoldings.value = {
      ...supplyCacheHoldings.value,
      [activeSide.value]: supplyCacheHoldings.value[activeSide.value] - 1,
    }
    lastSupplyCacheUse.value = detail
    pushLog('success', detail, rule)
    // ⑭ 接线：补给缓存用法（专规 1.7 / 21.10 Shells / Forage）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyCache',
      rule,
      data: {
        use: inputs.use,
        hqHex: { ...hex },
        detail,
        holdings: { ...supplyCacheHoldings.value },
      },
    })
    return true
  }

  /**
   * 专规 3.5：**已放置**的建造标记（桥 / 简易机场）
   *
   * 修前只有枚数在动、标记本身没有落盘 ⇒ 既看不见、也不可能被苏方战斗单位摧毁。
   * 一条 `piece` = 盘面上的一枚；"不能移动""不可重建"由本数组体现（移除即移除，不回补枚数）。
   */
  const constructionMarkerPieces = ref<{ id: string; kind: 'bridge' | 'airStrip'; hex: HexRef }[]>(
    [],
  )

  /** 专规 3.5：放置格（原先是组件局部 ref；点地图要写回，故搬进 store） */
  const constructionMarkerHexText = ref('')

  /**
   * 专规 3.5：**苏方战斗单位进入**建造标记格 ⇒ 该标记被摧毁（**不可重建**：枚数不退）
   *
   * 「entered the hex」不限定进入方式 ⇒ 所有"把单位放到某格"的写点都调它：
   * 地面移动落盘 `applyMovePatches`、战斗后推进/撤退 `applyCombatPatches`、空投落地、死亡堆返场。
   * 判定本身在引擎（`isConstructionMarkerDestroyed`），此处只做筛选与落账。
   */
  function noteUnitEnteredHex(unit: ConsoleUnit, hex: HexRef): void {
    if (unit.side !== 'soviet' || !unit.isCombat) return
    const doomed = constructionMarkerPieces.value.filter(
      (piece) =>
        sameHex(piece.hex, hex) &&
        isConstructionMarkerDestroyed({ enteredBySovietCombatUnit: true }),
    )
    if (doomed.length === 0) return
    const doomedIds = new Set(doomed.map((piece) => piece.id))
    constructionMarkerPieces.value = constructionMarkerPieces.value.filter(
      (piece) => !doomedIds.has(piece.id),
    )
    for (const piece of doomed) {
      pushLog(
        'info',
        `${piece.kind === 'bridge' ? '桥' : '简易机场'}（建造标记）在 ${hexLabel(hex)} 被摧毁：苏方战斗单位 ${unit.name} 进入（专规 3.5；不可重建）`,
        '专规 3.5',
      )
    }
  }

  /** 专规 3.5：放置格的待点入口（候选＝**有轴方战斗单位**的格 —— 与引擎的前提同一条） */
  function beginConstructionMarkerHexPickNow(): void {
    beginHexPick({
      label: '放置建造标记的格',
      rule: '专规 3.5',
      candidates: units.value
        .filter((unit) => unit.side === 'axis' && unit.isCombat)
        .map((unit) => unit.hex),
      apply: (hex) => {
        constructionMarkerHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /**
   * 专规 3.5：建造标记的**二选一**（桥 / 简易机场）
   *
   * ★ 批 D 切片 2（**房规①**：值要被 store 动作读、又被界面写 ⇒ 必须是 **store 字段**）——
   *   修前这个选择是 `ExclusiveRulesPanel` 的**组件局部 ref**，而落盘动作 `useConstructionMarkerNow`
   *   在 store 里 ⇒ 界面之外的路径（脚本 / 盒内会话框）拿不到它，等于"两份状态"。
   */
  const constructionMarkerKind = ref<'bridge' | 'airStrip'>('bridge')

  /** 该标记是否**已从盒里拾起**（界面据此高亮；落位成功后清掉） */
  const constructionMarkerPicked = ref(false)

  /**
   * 专规 3.5：**从盒里拾起一枚建造标记并进入落位**（二选一 → 点地图落位）
   *
   * 「盒里拾起（高亮）→ 点地图落位 → 二选一会话框」里的那一次点击：设好 kind、置"已拾起"，
   * 并**当场开好待点格**（候选＝有轴方战斗单位的格，12.3 的同一套 B27 机制）。
   */
  function armConstructionMarkerNow(kind: 'bridge' | 'airStrip'): void {
    constructionMarkerKind.value = kind
    constructionMarkerPicked.value = true
    beginConstructionMarkerHexPickNow()
  }

  /** 3.5：设置建造标记剩余枚数 */
  function setConstructionMarkersNow(count: number): void {
    constructionMarkers.value = Math.max(0, Math.trunc(count))
  }

  /**
   * 3.5：使用一枚建造标记（在**任一轴方移动阶段**、**单位移动之前**，放进有轴方战斗单位的格）
   *
   * 「免费（不耗补给）」；桥按 13.8b 的 HQ 架桥、简易机场按 15.2 的标准简易机场处理。
   * ★ 本动作只做**规则闸门 + 记账**：桥/机场的盘面效果由其所属章节的机制落值。
   */
  function useConstructionMarkerNow(kind: 'bridge' | 'airStrip', hexText: string): boolean {
    if (!requireAction('move.construction', '使用建造标记')) return false
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      exclusiveError.value = { rule: '专规 3.5', reason: `hexFormatInvalid:${hexText}` }
      pushLog('warning', `建造格格式应为「列.行」，收到「${hexText}」（专规 3.5）`, '专规 3.5')
      return false
    }
    const data = acceptExclusive(
      planConstructionMarkerUse({
        kind,
        side: activeSide.value,
        phase: phase.value,
        // 3.5：「单位移动之前」⇒ 本阶段尚无任何单位消耗过 MP
        beforeMovement: units.value.every((unit) => unit.mpSpent === 0),
        hexHasAxisCombatUnit: units.value.some(
          (unit) => unit.side === 'axis' && unit.isCombat && sameHex(unit.hex, hex),
        ),
        markerAvailable: constructionMarkers.value > 0,
      }),
      '放置建造标记',
    )
    if (data === null) return false
    constructionMarkers.value -= 1
    // 专规 3.5：标记**落盘**（原来只减枚数、标记本身没记住 ⇒ 看不见也毁不掉）
    constructionMarkerPieces.value = [
      ...constructionMarkerPieces.value,
      { id: createId('cm'), kind, hex: { ...hex } },
    ]
    // 批 D 切片 2：落位成功 ⇒ 收起"已拾起"的高亮
    constructionMarkerPicked.value = false
    pushLog(
      'success',
      `${data.detail}（置于 ${hexLabel(hex)}；剩余 ${constructionMarkers.value} 枚）`,
      data.rule,
    )
    return true
  }

  /** 3.3b：切换某城的「轴心国控制」声明（键 = `col.row`） */
  function toggleAxisCityControlNow(hexText: string): void {
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      pushLog('warning', `城市格格式应为「列.行」，收到「${hexText}」（3.3b）`, '3.3b')
      return
    }
    const key = `${hex.col}.${hex.row}`
    axisControlledCityKeys.value = axisControlledCityKeys.value.includes(key)
      ? axisControlledCityKeys.value.filter((item) => item !== key)
      : [...axisControlledCityKeys.value, key]
  }

  /**
   * 3.3b：执行治安检查
   *
   * 需求未满足的轴控城市**立即**放置苏军 Trainbusting 标记（「标记可在任意相位放置」）；
   * 需求已满足或该城转苏控的标记**只在 Clean Up Phase（H 段）**移除。
   */
  function applySecurityNeedsNow(): boolean {
    const data = acceptExclusive(checkSecurityNeeds(securityCityViews.value), '治安需求检查')
    if (data === null) return false

    for (const hex of data.placeAt) {
      trainbustingMarks.value = [
        ...trainbustingMarks.value,
        { id: createId('tb'), hex: { ...hex }, side: 'soviet' },
      ]
    }

    const canRemove = removalAllowedNow(phase.value)
    let removedCount = 0
    if (canRemove && data.removeAt.length > 0) {
      const keys = new Set(data.removeAt.map((hex) => `${hex.col}.${hex.row}`))
      trainbustingMarks.value = trainbustingMarks.value.filter((mark) => {
        if (!keys.has(`${mark.hex.col}.${mark.hex.row}`)) return true
        removedCount += 1
        return false
      })
    }

    pushLog(
      'success',
      `治安需求（3.3b）：放置 ${data.placeAt.length} 枚 Trainbusting、` +
        (canRemove
          ? `移除 ${removedCount} 枚`
          : `待移除 ${data.removeAt.length} 枚（须等到 H 清理段）`),
      data.rule,
    )
    // ⑭ 接线：治安需求检查（3.3b）入会话日志（本笔不掷骰；移除须待 H 清理段者如实记录）
    recordSettlement({
      action: 'securityNeeds',
      rule: data.rule,
      data: {
        placeAt: data.placeAt.map((hex) => ({ ...hex })),
        removeAt: data.removeAt.map((hex) => ({ ...hex })),
        removedCount,
        removalAllowed: canRemove,
      },
    })
    return true
  }

  /** 3.3b：某城当前是否已有 Trainbusting 标记 */
  function hasTrainbustingAt(hex: HexRef): boolean {
    return trainbustingMarks.value.some((mark) => sameHex(mark.hex, hex))
  }

  /* ────────── 2.2 末段：H 清理阶段的**通用自动清理** ────────── */

  /**
   * 2.2 / 5.9 / 5.10 / 12.5d / 10.0c-C：执行本人的 H 段通用清理
   *
   * 「当前阶段玩家为他的单位移除所有进击和混乱(DG)标记，并移除(或翻面)他所有的燃料标记；
   *   移除由非阶段玩家生成的运输破坏标记。」
   *
   * 全部判据在引擎 `planCleanUp`（含段闸：非 H 段直接拒绝）；本函数只落盘 + 记账。
   */
  function runCleanUpNow(): boolean {
    /*
     * 20.0d：**阶段末的强制吸收**先结清——「减损的多军力单位在任何阶段结束时，都必须吸收与之堆叠、
     * 且符合吸收规则的拆分单位」。放在 H 段收束之前，是因为 H 段本身也要按 4.8a 判堆叠。
     */
    const absorbed = settleAbsorbObligationsNow()
    if (absorbed > 0)
      pushLog(
        'warning',
        `20.0d：阶段末强制吸收 ${absorbed} 对（减损母单位 × 堆叠的拆分单位）`,
        '20.0d',
      )
    const plan = planCleanUp({
      phase: phase.value,
      side: activeSide.value,
      units: units.value.map((unit) => ({
        id: unit.instanceId,
        side: unit.side,
        dg: unit.mode.dg,
        exploit: unit.mode.exploit,
        fuelled: unit.fuelled,
      })),
      trainbustingMarks: trainbustingMarks.value.map((mark) => ({
        id: mark.id,
        hex: mark.hex,
        side: mark.side,
      })),
    })
    if (!plan.ok) {
      pushLog('warning', `不能执行清理：${plan.reason}（${plan.rule}）`, plan.rule)
      return false
    }
    const data = plan.data
    // 摘标记：只动补丁点到的单位（朝向按 5.9/5.10 保持不变）
    const byId = cleanupPatchById(data)
    for (const unit of units.value) {
      const patch = byId.get(unit.instanceId)
      if (patch === undefined) continue
      if (patch.clearDg) unit.mode.dg = false
      if (patch.clearExploit) unit.mode.exploit = false
      if (patch.clearFuel) {
        // 12.5d：标记摘掉后连同它的记账一并清空，避免残留方法留下误导
        unit.fuelled = false
        unit.fuelMethod = null
      }
    }
    // 10.0c-C / 14.8c：移除**对手**放置的运输破坏标记
    if (data.removeMarkerIds.length > 0) {
      const doomed = new Set(data.removeMarkerIds)
      trainbustingMarks.value = trainbustingMarks.value.filter((mark) => !doomed.has(mark.id))
    }
    /*
     * ★ 12.5d（用户 2026-09-20 裁定）：**燃料窗口的清理就在这一处** —— 与上面 `clearFuel` 同一时点、同一方。
     *   「当前阶段玩家必须在**自己的清理阶段**移除他指挥部的燃料已补给标记，并将他的编队标记翻面至
     *   燃料未补给的一面」⇒ 只有**本方**的清理才作废本方的两个台账；对手的清理阶段一概不动
     *   （反应阶段付的油要活到己方回合的移动阶段，见 `setPhase`/`setTurn` 两处的说明）。
     */
    const cleaningSide = activeSide.value
    const dropSide = <T extends { side: Side }>(ledger: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(ledger).filter(([, entry]) => entry.side !== cleaningSide))
    hqFuelThrows.value = dropSide(hqFuelThrows.value)
    formationFuelThrows.value = dropSide(formationFuelThrows.value)
    pushLog(isCleanUpNoop(data) ? 'info' : 'success', data.detail, data.rule)
    // ⑭ 接线：H 清理段通用清理（2.2 / 5.9 / 5.10 / 12.5d / 10.0c-C）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'cleanUp',
      rule: data.rule,
      data: {
        detail: data.detail,
        patches: data.patches.map((patch) => ({
          unitId: patch.unitId,
          clearDg: patch.clearDg === true,
          clearExploit: patch.clearExploit === true,
          clearFuel: patch.clearFuel === true,
        })),
        removeMarkerIds: [...data.removeMarkerIds],
      },
    })
    /*
     * 5.0a：**末回合的 H 清理段收束**即「最终回合结束」的时点 ⇒ 在此做终局判定
     * （非末回合时 `checkTurnEndVictory` 返回 `ongoing`，随后由 5.0b 的提前决胜兜住）。
     */
    if (atFinalTurn.value) {
      const assessment = assessTurnEndVictoryNow()
      if (assessment.outcome !== 'ongoing')
        pushLog('success', `剧本终局：${assessment.detail}`, assessment.rule)
    }
    return true
  }

  /**
   * 20.0a：该算子是否为**拆分单位**（数据层的 `breakdown` 标签）
   *
   * 唯一判据是 `specialized` 里的标签——不按番号或印值规模推定。
   */
  function isBreakdownRecord(unit: ConsoleUnit): boolean {
    return unit.specialized.includes('breakdown')
  }

  /**
   * 该算子的**国籍**（引擎视图用；取自主键前缀，如 `su-` / `ax-`）
   *
   * 20.0 的拆分/吸收与 S3 的互换都按国籍配对，故这一句只写一处。
   */
  function nationalityOfUnit(unit: ConsoleUnit): string {
    return unit.unitId.split('-')[0] ?? 'unknown'
  }

  /**
   * 20.0d：**阶段末的强制吸收**（在 H 清理段收束之前结清）
   *
   * 「减损的多军力单位在任何阶段结束时，都必须吸收与之堆叠、且符合吸收规则的拆分单位」
   * ⇒ 先按引擎 `breakdownAbsorbObligations` 列出义务，再**逐条强制吸收**
   *   （吸收路径仍是 `absorbBreakdownNow`，与手动的 13.9 吸收同一实现）。
   * 返回吸收成功对数（0 ＝ 无义务）。
   */
  function settleAbsorbObligationsNow(): number {
    const obligations = breakdownAbsorbObligations({
      units: units.value
        .filter((unit) => unit.specialized.includes('breakdown') !== true)
        .map((unit) => toBreakdownSideView(unit, nationalityOfUnit(unit))),
      breakdownsStackedWith: (parentId: string) => {
        const parent = units.value.find((unit) => unit.instanceId === parentId)
        if (parent === undefined) return []
        return units.value
          .filter(
            (unit) =>
              unit.instanceId !== parentId &&
              isBreakdownRecord(unit) &&
              sameHex(unit.hex, parent.hex),
          )
          .map((unit) => toBreakdownSideView(unit, nationalityOfUnit(unit)))
      },
    })
    let settled = 0
    for (const obligation of obligations) {
      pushLog('warning', obligation.detail, obligation.rule)
      for (const breakdownId of obligation.breakdownIds) {
        if (!units.value.some((unit) => unit.instanceId === breakdownId)) continue
        if (absorbBreakdownNow(obligation.parentId, breakdownId)) settled += 1
      }
    }
    return settled
  }

  /* ────────── W6 B20：胜利判定（专规 5.0 / 5.0a / 5.0b / 5.0c） ────────── */

  /**
   * 5.0c：**最后控制者**账本（键 = `col.row`）
   *
   * 5.0c 的「空格由最后一个曾在该格的单位所属方控制」需要历史，操作台只摆当前算子，
   * 故由裁判在每次移动/战斗后点「按盘面刷新」（有可攻击单位者自动归该方），
   * 或直接指定某格归属；引擎侧只接收这一结论（`VictoryControlLookup`）。
   */
  const victoryLastControl = ref<Record<string, Side>>({})

  /** B20 的错误（统一形状：rule + reason） */
  const victoryError = ref<{ rule: string; reason: string } | null>(null)

  /**
   * 联调（**单一权威**）：剧本号一变 ⇒ **随剧本重取的盘面账本**统一重取
   *
   * 为什么是 `watch` 而不是"各入口自己记得刷新"：剧本号的唯一权威是会话
   * （`session.scenarioId`），而写会话的路径有三条以上——`workbench.setScenarioId`、
   * `containers.setScenario`、**`session.loadNow`（读档）**。任何一条漏了刷新，就是
   * "剧本号变了、盘面账本还是旧剧本"的半更新。
   *
   * 实测（修前）：剧本 3 存档 → 新实例读档 ⇒ 四处剧本号都变成 3 ✓，但
   * `constructionMarkers` 仍是剧本 1 的 **3**（剧本 3 应为 0）、`convertedRailHexes`
   * 仍是剧本 1 的 **2 格**（剧本 3 应为 10 格）⇒ 苏军能多建 3 个工事、轴方铁路只放行
   * 剧本 1 的两格（12.6a②/13.3c 的铁路补给判定全错）。
   *
   * `immediate: true` 同时充当**初值**来源（故各账本不再在声明处各写一遍）。
   * 注册点必须在所有被重取的 ref 声明之后 ⇒ 放在本段（最后一个账本 `victoryError` 之后）。
   *
   * ★ `flush: 'sync'`：账本必须与剧本号**同时**更新。默认的 `'pre'` 会把回调排到微任务队列，
   *   于是"剧本号已变成 7、账本还是剧本 1"这个窗口里，任何读账本的 computed（如 `railSupply`
   *   的卸货格）都会算在旧剧本上——而这正是本项要消灭的半更新。刻意用同步 flush 换掉那个窗口。
   */
  function refreshScenarioBoundLedgers(id: string): void {
    const setup = scenarios.scenarios.find((item) => item.id === id)?.setup
    // 13.6：裁判手改的到达落点（剧本换了，落点覆盖作废）
    arrivalHexOverrides.value = {}
    // 1.7 补给缓存 / 3.5 建造标记（专规初设）
    supplyCacheHoldings.value = initialSupplyCacheHoldings(setup?.supplyCache)
    constructionMarkers.value = setup?.constructionMarkers ?? 0
    // 5.0c 胜利格控制账本：由**后面**那个 immediate watch 按剧本与战线播种（此处不能调：
    // `victoryHexes` 尚未声明 ⇒ 会踩 TDZ）
    victoryError.value = null
    // 9.14e 印刷工事归属（剧本 1 全属苏联，其余按德军推进线）
    printedHedgehogOwners.value = {}
    // 13.3f / 专规 1.2 初设换轨（剧本页 `Converted Axis Rails` 的逐格推导）
    seedConvertedRailsNow()
    // 9.14 特殊战斗待决（落点按剧本 4 的拖取距离判，换剧本即作废）
    specialPending.value = null
  }

  watch(scenarioId, (next) => refreshScenarioBoundLedgers(next), {
    immediate: true,
    flush: 'sync',
  })

  /** 5.0c：本剧本胜利条件涉及的格（11 所列格 + 五城格 + 两城格） */
  const victoryHexes = computed<readonly HexRef[]>(() => allVictoryConditionHexes())

  /*
   * B17-1（5.0c）：胜利格控制的**播种**必须排在 `victoryHexes` **之后**——它要用这份清单。
   * ★ 教训：原先我把它塞进上面那个 `immediate: true` 的 watch 里，而那时 `victoryHexes`
   *   还在暂时性死区（TDZ）⇒ 建 store 这一步就抛错，全套用例一起红（660 条）。
   *   计算属性的依赖顺序只能靠"声明顺序"保证，故这里单开一个 watch（同样 immediate + sync）。
   */
  watch(scenarioId, () => seedVictoryControlFromScenario(), { immediate: true, flush: 'sync' })

  /**
   * 5.0c：当前控制查询（格内有**可攻击**单位 ⇒ 该方；空格 ⇒ 最后控制者账本；否则无人控制）
   *
   * ★ 判据只有一处：引擎的 `controlOfHex`（本处只把盘面事实与账本拼成 `VictoryHexFacts`）。
   *   修前这里把「`attackCapableSide ?? lastControllingSide`」又写了一遍。
   */
  const victoryControlOf = computed<VictoryControlLookup>(() => (hex) => {
    const occupant = units.value.find((unit) => unit.attackCapable && sameHex(unit.hex, hex))
    return controlOfHex({
      hex,
      attackCapableSide: occupant?.side ?? null,
      lastControllingSide: victoryLastControl.value[`${hex.col}.${hex.row}`] ?? null,
    })
  })

  /** 5.0c：控制汇总（所列格计数 + 五城/两城是否全部格控制） */
  const victorySummary = computed<VictoryControlSummary>(() =>
    summarizeVictoryControl({ scenarioId: scenarioId.value, controlOf: victoryControlOf.value }),
  )

  /** 本剧本的回合区间（末回合号 + 产品数据自检注记） */
  const victoryTurnRange = computed<ScenarioTurnRange>(() => scenarioTurnRange(scenarioId.value))

  /**
   * 5.0b：**回合开始**检查（任一回合开始、19 August 起；剧本 2/4 无此档）
   *
   * 取引擎的 `checkTurnStartVictory`（5.0b 的入口；修前直接调内部的 `evaluateDecisiveVictory`）。
   */
  const decisiveVictory = computed<VictoryAssessment>(() =>
    checkTurnStartVictory({
      scenarioId: scenarioId.value,
      date: date.value,
      controlOf: victoryControlOf.value,
    }),
  )

  /** 5.0a：最终评估（按当前态势，若此刻即为末回合的结果） */
  const finalVictory = computed<VictoryAssessment>(() =>
    evaluateFinalVictory({ scenarioId: scenarioId.value, controlOf: victoryControlOf.value }),
  )

  /**
   * 5.0a：**回合结束**检查（只在末回合结束时给出终局判定，否则 `ongoing`）
   *
   * 取引擎的 `checkTurnEndVictory`；本项在 H 清理段收束时求值（见 `assessTurnEndVictoryNow`）。
   */
  const turnEndVictory = computed<VictoryAssessment>(() =>
    checkTurnEndVictory({
      scenarioId: scenarioId.value,
      turn: turn.value,
      controlOf: victoryControlOf.value,
    }),
  )

  /**
   * 5.0a / 5.0b 的**流程入口**：回合结束时的判定（在 H 清理段收束时调用）
   *
   * - 末回合 ⇒ `checkTurnEndVictory` 给出终局判定（5.0a）；
   * - 非末回合 ⇒ 该函数返回 `ongoing`，此时再看 5.0b 的提前决胜是否达成（`checkTurnStartVictory`）。
   * 判定结论入会话（`pushVictoryToSessionNow`）与会话日志，供 D2 按规则号检索。
   */
  function assessTurnEndVictoryNow(): VictoryAssessment {
    const end = turnEndVictory.value
    const assessment = end.outcome === 'ongoing' ? decisiveVictory.value : end
    pushVictoryToSessionNow()
    pushLog(
      assessment.outcome === 'ongoing' ? 'info' : 'success',
      `回合结束判定：${assessment.detail}`,
      assessment.rule,
    )
    recordSettlement({
      action: end.outcome === 'ongoing' ? 'decisiveVictory' : 'finalVictory',
      rule: assessment.rule,
      data: {
        level: assessment.level,
        outcome: assessment.outcome,
        winner: assessment.winner,
        listedAxis: assessment.summary.listedBySide.axis,
        listedSoviet: assessment.summary.listedBySide.soviet,
        detail: assessment.detail,
      },
    })
    return assessment
  }

  /** 当前回合计是否为该剧本的最终回合（5.0a 的检查时点） */
  const atFinalTurn = computed<boolean>(() => isScenarioFinalTurn(scenarioId.value, turn.value))

  /**
   * ⑬ 接线：把 **5.0c 的控制事实**与 **5.0a / 5.0b 的判定结论**推给会话
   *
   * 控制事实属于盘面（只有操作台摆着算子），判定由引擎 `victory.ts` 求值；会话层只接收结论。
   * 推过去之后：
   *   - `Records.victoryLocations` 不再是空档 ⇒ 引擎侧的 5.0 判定可直接消费它；
   *   - 5.0b 的提前决胜由判定结论驱动（不再依赖手填开关）；
   *   - 5.0a 的收束条目带上胜方 / Draw 与控制计数。
   *
   * 只登记**当前有主**的胜利格（5.0c 的「最后控制者」账本口径）；无人控制的格不入账，
   * 消费方按「查不到 ⇒ 无人控制」处理（`VictoryLocationState.controlledBy` 不含 null）。
   */
  function pushVictoryToSessionNow(): void {
    const listed = new Set(
      listedVictoryHexes(scenarioId.value).map((hex) => `${hex.col}.${hex.row}`),
    )
    const locations: VictoryLocationState[] = []
    for (const hex of victoryHexes.value) {
      const key = `${hex.col}.${hex.row}`
      const controlledBy = victoryControlOf.value(hex)
      if (controlledBy === null) continue
      locations.push({ hex: { col: hex.col, row: hex.row }, controlledBy, listed: listed.has(key) })
    }
    session.pushVictory({
      locations,
      decisive: decisiveVictory.value,
      final: finalVictory.value,
    })
  }

  /**
   * 5.0c：把盘面上由可攻击单位占据的胜利相关格写入「最后控制者」账本
   *
   * 返回本次真的改了归属的格数（0 = 账本已是当前盘面的样子）。
   * 判据仍是 5.0c 原文：**格内有可攻击单位 ⇒ 该方控制**；空格**不动**（保留最后控制者）。
   */
  function syncVictoryControlFromBoard(): number {
    const next = { ...victoryLastControl.value }
    const flipped: string[] = []
    for (const hex of victoryHexes.value) {
      const occupant = units.value.find((unit) => unit.attackCapable && sameHex(unit.hex, hex))
      if (occupant === undefined) continue
      const key = `${hex.col}.${hex.row}`
      if (next[key] !== occupant.side) {
        next[key] = occupant.side
        flipped.push(
          `${key} → ${occupant.side === 'axis' ? '轴心国' : '苏联'}（${occupant.name} 进入该格）`,
        )
      }
    }
    if (flipped.length === 0) return 0
    victoryLastControl.value = next
    victoryError.value = null
    pushVictoryToSessionNow()
    /*
     * 5.0c：**进入即记账**（用户 2026-09-16 口径）——「单位只要移动进入过该格就视为转换控制方」。
     * 为什么要在**进入的那一刻**记而不是回合末扫一遍：5.0c 的空格判据是「**最后一个**曾在该格的
     * 单位所属方」⇒ 若等到回合末才记，"进过又走了"的格就丢了那次进入（正是最容易出错的一类）。
     */
    pushLog('success', `胜利格控制易手（5.0c）：${flipped.join('；')}`, '5.0c')
    return flipped.length
  }

  /** 5.0c：裁判手动刷新（验证页用；对局台上由下面的**触发**自动做） */
  function refreshVictoryControlNow(): void {
    const changed = syncVictoryControlFromBoard()
    pushLog(
      'info',
      `胜利格控制账本已按盘面刷新（5.0c：格内有可攻击单位者归该方，空格保留最后控制者）｜本次更新 ${changed} 格`,
      '5.0c',
    )
  }

  /**
   * 5.0c **触发**：盘面上任何一枚可攻击单位的**落格变化**都立刻核对胜利格
   *
   * 键里带 `列.行`、`阵营` 与 `是否可攻击` 三项：任一变化（移动/撤退/推进/铁路运货/位移/
   * 初设落子/被消灭后的移除）都会让这个字符串变一次 ⇒ 触发一次核对。
   * 用"整表拼键"而不是逐个动作插入，是为了**不可能漏**：位置改动的地方在 store 里有十几处，
   * 漏一处就会出现"某条路径进格不记控制"这种最难查的错。
   * 非玩家阶段（回放/自动化）同样安全：它只读盘面、只写账本，不掷骰。
   */
  const victoryOccupancyKey = computed<string>(() =>
    units.value
      .map(
        (unit) =>
          `${String(unit.hex.col)}.${String(unit.hex.row)}:${unit.side}:${unit.attackCapable ? 'A' : '-'}`,
      )
      .join('|'),
  )
  watch(
    victoryOccupancyKey,
    () => {
      syncVictoryControlFromBoard()
    },
    // ★ `sync`：控制归属必须在**同一拍**就落账——否则同一 tick 里紧跟其后的判定/结算读到的
    //   还是旧账本（而 5.0c 的"最后控制者"正是靠"进入的那一刻"记账的）。
    //   代价是每次位置变更都要重算一次key（O(单位数)）与扫一遍胜利格（十几格），可忽略。
    { flush: 'sync' },
  )

  /**
   * 5.0c：**初设时胜利点在谁手里**（用户 2026-09-16：「由剧本和战线决定」）
   *
   * 数据来源（不臆造）：
   *   · **战线**：剧本 `setup.printedHedgehogOwners` 的 `axisOwned` 逐格清单——它是剧本页给德军
   *     推进线的逐格落值（与 9.14e 的印刷工事归属**同一条线**，本处复用同一份数据）；
   *   · **其余格**：归苏军（剧本 1/3/5/7 的开局都是苏军守、德军推；数据里的 `rule` 原文即
   *     「其余属苏军」）；
   *   · **已在盘面上的单位**优先：初设落子后若某胜利格上有可攻击单位，就按它那一方（下面的触发会做）。
   */
  function seedVictoryControlFromScenario(): void {
    const seed: Record<string, Side> = {}
    for (const hex of victoryHexes.value) {
      const key = `${hex.col}.${hex.row}`
      seed[key] = printedHedgehogAxisOwnedAtStart.value.has(hexLabel(hex)) ? 'axis' : 'soviet'
    }
    victoryLastControl.value = seed
    victoryError.value = null
  }

  /** 5.0c：裁判指定 / 清除某格的控制方（空格与历史格用；`side=null` 清除） */
  function setVictoryControlNow(hexText: string, side: Side | null): void {
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      victoryError.value = { rule: '5.0c', reason: `hexFormatInvalid:${hexText}` }
      pushLog('warning', `胜利格格式应为「列.行」，收到「${hexText}」（5.0c）`, '5.0c')
      return
    }
    const key = `${hex.col}.${hex.row}`
    const next = { ...victoryLastControl.value }
    if (side === null) delete next[key]
    else next[key] = side
    victoryLastControl.value = next
    victoryError.value = null
    pushVictoryToSessionNow()
    pushLog(
      'info',
      `${hexLabel(hex)} 的控制方 → ${side === null ? '（清除，视为无人控制）' : side === 'axis' ? '轴心国' : '苏联'}（5.0c）`,
      '5.0c',
    )
  }

  /**
   * 5.0a / 5.0b：执行一次胜利检查并记日志
   *
   * `at: 'turnStart'` ⇒ 5.0b（任一回合开始、19 Aug 起）；`at: 'turnEnd'` ⇒ 5.0a（仅最终回合）。
   * 两条规则都不写盘面状态，仅给出结论（引擎不写状态）；此处只负责取结论与提示。
   */
  function checkVictoryNow(at: 'turnStart' | 'turnEnd'): boolean {
    const assessment = at === 'turnStart' ? decisiveVictory.value : finalVictory.value
    const label = at === 'turnStart' ? '回合开始检查（5.0b）' : '回合末检查（5.0a）'
    if (at === 'turnEnd' && !atFinalTurn.value) {
      victoryError.value = { rule: '5.0a', reason: `notFinalTurn:${turn.value}` }
      pushLog(
        'warning',
        `${label}：第 ${turn.value} 回合不是剧本 ${scenarioId.value} 的最终回合（末回合 ${victoryTurnRange.value.lastTurn}）⇒ 5.0a 只在最终回合结束时判定`,
        '5.0a',
      )
      return false
    }
    victoryError.value = null
    // ⑬ 接线：判定结论推给会话（5.0b 的提前决胜 / 5.0a 的收束条目都取它）
    pushVictoryToSessionNow()
    const level =
      assessment.outcome === 'axis'
        ? '轴心国达成'
        : assessment.outcome === 'soviet'
          ? '苏联达成'
          : assessment.outcome === 'draw'
            ? '判定为 Draw'
            : '暂无结论'
    pushLog(
      assessment.outcome === 'ongoing' ? 'info' : 'success',
      `${label}：${level}｜${assessment.detail}`,
      assessment.rule,
    )
    // ⑭ 接线：结论入会话日志（含「暂无结论」，可被 D2 按规则号 5.0a / 5.0b 检索）
    recordSettlement({
      action: at === 'turnStart' ? 'decisiveVictory' : 'finalVictory',
      rule: assessment.rule,
      data: {
        level: assessment.level,
        outcome: assessment.outcome,
        winner: assessment.winner,
        listedAxis: assessment.summary.listedBySide.axis,
        listedSoviet: assessment.summary.listedBySide.soviet,
        listedTotal: assessment.summary.listedTotal,
        detail: assessment.detail,
      },
    })
    return assessment.outcome !== 'ongoing'
  }

  /** 该格可选防御地形（9.3b） */
  function terrainChoicesAt(hex: HexRef): string[] {
    return defenseTerrainChoices(hex)
  }
  function rollDice(): void {
    const draw = roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    pushLog('info', `掷 2d6 = ${draw.value.faces.join('+')} = ${draw.value.total}`, '9.8')
    // ⑭ 接线：通用掷骰不是规则结算，但它同样消耗骰子；不记的话 D2 重放会与序列错位
    recordSettlement({
      action: 'manualRoll',
      rule: '9.8',
      rolls: [draw.value],
      data: { faces: draw.value.faces, total: draw.value.total, manual: true },
    })
  }

  /** 重置局（含重设种子）——局况一并回到初始（第 1 回合 / 轴心国先手 / C 移动段） */
  function resetAll(nextSeed = DEFAULT_SEED): void {
    units.value = []
    selectedId.value = null
    pendingRecord.value = null
    tool.value = 'move'
    battleTarget.value = null
    battleTerrain.value = ''
    battleDefenderArId.value = null
    lastStep.value = null
    lastBattle.value = null
    log.value = []
    // C5：本次移动的记账、悬停与待确认一并清空
    moveInteraction.value = null
    hoverHex.value = null
    pendingZocConfirm.value = null
    moveBlocked.value = null
    // C6：本场战斗的交互状态一并清空（含战斗工具模式复位）
    battleMode.value = 'full'
    clearCombat()
    // C7：本次轰炸的交互状态一并清空（含轰炸工具关闭），已摆放的飞机也一并卸下
    barrageActive.value = false
    airUnits.value = []
    airPlacement.value = { aircraftId: null, hexText: '' }
    clearBarrage()
    // 10.0e-A/B：轰炸账本属**阶段级**事实，`clearBarrage` 不动它 ⇒ 复位时显式清
    clearBarragePhaseLedger()
    // C8：补给交互与 SP 账本、来源声明一并回到初始（工具按「必要模块默认开启」保持开启）
    supplyActive.value = true
    spDumps.value = []
    supplySourceDecls.value = []
    spDumpDraft.value = { hexText: '', sp: 1, t: 0 }
    supplySourceDraft.value = { hexText: '', kind: 'supplySourceHex' }
    clearSupply()
    // C9：空军交互、基地声明与阶段标记一并回到初始（工具按「必要模块默认开启」保持开启）
    airActive.value = true
    airMissionKind.value = 'barrage'
    airstripBaseIds.value = []
    refitDoneBaseIds.value = []
    reducedBaseIds.value = []
    refitTargetBaseId.value = null
    clearAir()
    // 16.0b/c / 15.3 / 13.8d：按格、按回合、按阶段的施工额度一并回到初始
    hedgehogTurnLedger.value = {}
    airBaseTurnLedger.value = {}
    constructionPhaseLedger.value = { hexes: [], task: null }
    constructionError.value = null
    hedgehogError.value = null
    hedgehogInputs.value = { hexText: '', workerIds: [], payDumpId: null }
    hedgehogExecutorMode.value = 'inPlace'
    hedgehogEngineerId.value = null
    constructionInputs.value = { hexText: '', engineerId: null, payDumpId: null }
    // 13.3 铁路运货：容量账本、阶段账本与输入回到初始
    railCapSpentThisTurn.value = []
    railMovedUnitIdsThisPhase.value = []
    railMovedNewTrackThisPhase.value = []
    railMoveInputs.value = { toHexText: '', spAmount: 1, fromDumpId: null }
    railMoveError.value = null
    lastRailMove.value = null
    // W6 B19：专规机制的账本一并回到初设（剧本初设值随 `scenarioId` 重取）
    supplyCacheHoldings.value = initialSupplyCacheHoldings(scenarioSetup.value?.supplyCache)
    constructionMarkers.value = scenarioSetup.value?.constructionMarkers ?? 0
    constructionMarkerPieces.value = []
    constructionMarkerHexText.value = ''
    axisControlledCityKeys.value = []
    trainbustingMarks.value = []
    panzerGroupAssignments.value = {}
    // 3.4b：补给站的装甲集群归属一并清空（新到 SP 的归属不可跨局残留）
    spDumpPanzerGroups.value = {}
    pendingSpGroupAssignment.value = []
    multiUnitFormationIds.value = []
    supplyTableSpInput.value = 7
    lastSupplyCacheUse.value = null
    exclusiveError.value = null
    // W6 B20：胜利格控制账本与错误一并回到初始
    victoryLastControl.value = {}
    victoryError.value = null
    // 9.14：印刷工事归属账本与特殊战斗待决一并回到初始
    printedHedgehogOwners.value = {}
    specialPending.value = null
    // 13.3f / 专规 1.2：换轨账本回到该剧本的初设（重置后账本不得残留上一局的换轨）
    seedConvertedRailsNow()
    gaugeConversionsThisPhase.value = []
    convertedHexesThisPhase.value = []
    railMovedNewTrackThisPhase.value = []
    activeSide.value = 'axis'
    phase.value = 'movement'
    const firstTurn = TURN_TRACK[0]?.turn ?? 1
    turn.value = firstTurn
    seed.value = nextSeed
    rng.value = createRngState(nextSeed)
    drawCount.value = 0
    pushLog('info', `重置：种子 ${nextSeed}（B2 可复算）`)
  }

  /* ── B27b：剩下 6 处「格子编号」的待点入口（值搬进 store，组件只绑字段） ── */

  /**
   * B27b（用户口径 2026-09-16 #9）：这 6 处的**值**原来都躺在组件局部 `ref` 里，
   * 待点格要写回就得有个 store 侧的家 ⇒ 统一搬进来（与 B32 把 `fuelMethod` 搬进 store 同一套做法）。
   * 组件里的文本框留着只作**显示**（点完能看见点的是哪一格），主路径是"点地图选格"。
   *
   * ★ 候选口径：**store 有明确投影的**就铺候选（12.7a 的运输点数格、13.3f-B 的单位所在格、
   *   3.3b 的地图城市格、13.7 的本方单位格）；**条件在引擎侧的**（13.5 补员格、1.6c 返场落点）
   *   用 `'any'`——只把"打格号"换成"点一下"，合法与否仍由引擎在提交时给规则号。
   */
  const rebuildReplHexText = ref('')
  const convertTargetHexText = ref('')
  const railGaugeTargetHexText = ref('')
  const cityControlHexText = ref('')
  const formationMarkerHexText = ref('')
  const deadPileReturnHexText = ref('')

  /**
   * 13.5：重建候选落点（**显式格投影**，R2；取代原先的 `'any'` 任意格）
   *
   * 复用 `planRebuild` 的 ④ 落点判据，按"待重建单位"分类给出真·合法落点：
   *   · 空军（死亡堆）：处于**追溯补给**的友方空军基地（`hasFriendlyAirBase`）；
   *   · 地面**图上带损**单位（不在死亡堆）：重建须与补员**同格** ⇒ 唯一候选＝该单位所在格
   *     （且该格须满足 HQ 2 格内 ∧ 不在未抵消敌 ZOC）；
   *   · 地面**死亡堆**单位：全图扫描——HQ 2 格内 ∧ 不在未抵消敌方 ZOC 内。
   * 候选与 `rebuildUnitNow` 的引擎判定**同源**（同一组 `facts`），故地图高亮的格就是真合法落点。
   */
  function rebuildCandidateHexes(unitId: string): HexRef[] {
    const candidate =
      deadPile.value.find((unit) => unit.instanceId === unitId) ??
      units.value.find((unit) => unit.instanceId === unitId)
    if (candidate === undefined) return []
    const isAir = isAirDeadPileEntry(candidate)
    const inDeadPile = deadPile.value.some((unit) => unit.instanceId === unitId)

    // 空军：友方空军基地（处于追溯补给）
    if (isAir) {
      const traceCovered = traceCoverageHexes(supplyFacts.value, {
        side: activeSide.value,
        mobility: 'truck',
      })
      const base = airBases.value.find(
        (item) => item.side === activeSide.value && traceCoverageHas(traceCovered, item.hex),
      )
      return base === undefined ? [] : [{ ...base.hex }]
    }

    const hqHexes = arrivalFacts.value.directDrawHqHexes()
    const range = rulesConstants.repl.rebuildHqRangeHexes
    const withinHq = (hex: HexRef): boolean => hqHexes.some((hq) => hexDistance(hq, hex) <= range)

    // 地面图上带损：须与补员同格 ⇒ 唯一候选＝单位所在格，且须满足 HQ/ZOC
    if (!inDeadPile && 'hex' in candidate && candidate.hex !== null) {
      const hex = candidate.hex
      const inZoc = zocOnlySupplyFacts.value.inEnemyZoc(hex, activeSide.value)
      return withinHq(hex) && !inZoc ? [{ ...hex }] : []
    }

    // 地面死亡堆：全图扫——HQ 2 格内 ∧ 不在敌方 ZOC 内
    return allMapHexes().filter((hex) => {
      if (!withinHq(hex)) return false
      return !zocOnlySupplyFacts.value.inEnemyZoc(hex, activeSide.value)
    })
  }

  /** 13.5：重建时"补员所在格"——候选＝13.5 投影的合法落点（R2：显式候选，不再 `'any'`） */
  function beginRebuildReplHexPickNow(unitId: string): void {
    const candidates = rebuildCandidateHexes(unitId)
    if (candidates.length === 0) {
      pushLog(
        'warning',
        '没有可重建的合法落点（13.5：须在战斗模式友方 HQ 2 格内、且不在未抵消的敌方 ZOC 内；空军须处于追溯补给的友方基地）',
        '13.5',
      )
      return
    }
    beginHexPick({
      label: '补员所在格（13.5 合法落点）',
      rule: '13.5',
      candidates,
      apply: (hex) => {
        rebuildReplHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /** 12.7a：把运输点数转成延补队的格（候选＝图上本方运输点数所在的格） */
  function beginConvertTargetHexPickNow(): void {
    beginHexPick({
      label: '转换格（运输点数 → 延补队）',
      rule: '12.7a',
      candidates: transportPointsOfSide.value.map((unit) => unit.hex),
      apply: (hex) => {
        convertTargetHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /**
   * 13.3f-B：换轨的铁路格
   *
   * 原文：「一个铁路修理单位只需**移动进入**一个铁路格，就可转换**该铁路格**的轨距。
   * 轨距转换不消耗 SP，也不消耗额外的移动点数」⇒ 候选只给**该单位现在所在的那一格**
   * （13.3g-D 的"每阶段最多 4 格 / 须战斗模式"由引擎在提交时判）。
   */
  function beginRailGaugeTargetHexPickNow(instanceId: string): void {
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) {
      pushLog('warning', `换轨：找不到单位实例 ${instanceId}（13.3f）`, '13.3f')
      return
    }
    beginHexPick({
      label: '换轨的铁路格',
      rule: '13.3f',
      candidates: [unit.hex],
      apply: (hex) => {
        railGaugeTargetHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /** 3.3b：城市控制声明（候选＝地图上标着城市的格；轴控与否由引擎的动作切换） */
  function beginCityControlHexPickNow(): void {
    beginHexPick({
      label: '城市格',
      rule: '3.3b',
      candidates: mapCityHexes.value,
      apply: (hex) => {
        cityControlHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /** 13.7：编队收纳盒的标记格（原文：「至少一个所属单位须与标记同格」⇒ 候选＝图上本方单位格） */
  function beginFormationMarkerHexPickNow(): void {
    beginHexPick({
      label: '编队标记格',
      rule: '13.7',
      candidates: ownUnitsOnMap.value.map((unit) => unit.hex),
      apply: (hex) => {
        formationMarkerHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /** 1.6c：死亡堆返场落点（"能直接拖取追溯补给的 HQ 或边缘补给源格"⇒ 引擎在提交时判） */
  function beginDeadPileReturnHexPickNow(): void {
    beginHexPick({
      label: '死亡堆返场落点',
      rule: '1.6c',
      candidates: 'any',
      apply: (hex) => {
        deadPileReturnHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /* ────────────── P0 修复（B48）：盘面快照 —— 存/读档必须带上盘面 ────────────── */

  /**
   * **盘面快照的字段表**（唯一真源：`snapshotBoard` / `boardSnapshotFits` / `restoreBoard` 都照它走）
   *
   * 为什么要这张表：修前存档只装"会话"（记录轨 / 日志 / 种子 / 形态），而**盘面**（算子、补给站、
   * 飞机、各类账本）全在本 store 里，谁都没存过 ⇒ 读档后"时钟走了、盘面还停在原处"，两者互相矛盾，
   * 而界面还写着"任意环节都可存档"。本表就是"哪些东西属于盘面"的可审查清单。
   *
   * ## 收录判据（三条，缺一不可）
   *   ① 是**盘面上的实体或账本**（不是"手正在做的事"）；
   *   ② 读档后必须与存档那一刻**一致**；
   *   ③ **不是**从会话派生的（派生项随会话本体一起回来）。
   *
   * ## 刻意不收（边界，写在这里以免被当成漏收）
   *   · **会话派生的**：`activeSide` / `phase` / `turn` / `date` / `seed` / `rng` / `drawCount` /
   *     `scenarioId`（含无会话时的 `localActiveSide` / `localPhase` / `localRng` 兜底）——它们读的是
   *     `session.state`，读档时随会话本体回来；重复收反而会打架；
   *   · **交互进行态**（"手正在做的事"）：`selectedId` / `tool` / `hoverHex` / `moveInteraction` /
   *     `pendingZocConfirm` / `movePick` / `pendingRecord` / `pendingHexPick` / 各面板的下拉与草稿
   *     （`*Inputs` / `*Draft` / `supplyUnitId` / `fuelDumpId` / `airPlacement` …）/ 引擎交互状态机
   *     （`combatState` / `barrageState` / `supplyState` / `airState`）/ 中途战斗的选人（`combatTagalongIds`
   *     / `combatSupplyDumpIds` / `combatStartSnapshot` / `overrun*`）——**读档后这些一律回到初始**，
   *     即"读到一半的交互不会跨存档续上"，但盘面本身仍然自洽（这是刻意的边界）；
   *   · **显示用回执**：`last*`（`lastStep` / `lastBattle` / `lastRailMove` / `lastRefit` …）与
   *     界面日志 `log`——日志的**整局审计**是 `session.log`，随会话本体回来。
   *
   * ## 顺序
   * 表里的次序即还原次序：**盘面实体在前、账本在中、"由盘面推导"的账本（`victoryLastControl`）在后**。
   * `restoreBoard` 末尾还会按新盘面重播一次 5.0c 的控制账（幂等；见那里的注释）。
   */
  const boardSnapshotFields = (): readonly (readonly [string, Ref<unknown>])[] => [
    // ① 盘面实体
    ['units', units],
    ['spDumps', spDumps],
    ['airUnits', airUnits],
    ['deadPile', deadPile],
    ['removedForever', removedForever],
    // ② 账本（补员 / 拆解 / 补给缓存 / 装甲集群与编队归属）
    ['replHoldings', replHoldings],
    ['breakdownPool', breakdownPool],
    ['supplyCacheHoldings', supplyCacheHoldings],
    ['supplySourceDecls', supplySourceDecls],
    ['panzerGroupAssignments', panzerGroupAssignments],
    ['spDumpPanzerGroups', spDumpPanzerGroups],
    ['pendingSpGroupAssignment', pendingSpGroupAssignment],
    ['multiUnitFormationIds', multiUnitFormationIds],
    // ②′ 账本（铁路 / 换轨 / 施工 / 机场 / 胜利格 / 印刷工事）
    ['convertedRailHexes', convertedRailHexes],
    ['gaugeConversionsThisPhase', gaugeConversionsThisPhase],
    ['convertedHexesThisPhase', convertedHexesThisPhase],
    ['railMovedNewTrackThisPhase', railMovedNewTrackThisPhase],
    ['railCapSpentThisTurn', railCapSpentThisTurn],
    ['railMovedUnitIdsThisPhase', railMovedUnitIdsThisPhase],
    ['constructionMarkers', constructionMarkers],
    ['constructionMarkerPieces', constructionMarkerPieces],
    ['constructionPhaseLedger', constructionPhaseLedger],
    ['hedgehogTurnLedger', hedgehogTurnLedger],
    ['airBaseTurnLedger', airBaseTurnLedger],
    ['airUnloadLedger', airUnloadLedger],
    ['airstripBaseIds', airstripBaseIds],
    ['refitDoneBaseIds', refitDoneBaseIds],
    ['reducedBaseIds', reducedBaseIds],
    ['axisControlledCityKeys', axisControlledCityKeys],
    ['trainbustingMarks', trainbustingMarks],
    ['printedHedgehogOwners', printedHedgehogOwners],
    ['victoryLastControl', victoryLastControl],
    // ②″ 账本（阶段级：轰炸 / 补给阶段 / 损耗 / 喂饱 / 销毁尝试）
    ['barragedHexesThisPhase', barragedHexesThisPhase],
    ['barragedUnitIdsThisPhase', barragedUnitIdsThisPhase],
    // ②‴ 账本（环节级：9.1c 的攻击账本——不进档的话，读档后当回合的战斗环节会被"重打一次"）
    ['attackedUnitIdsThisPhase', attackedUnitIdsThisPhase],
    ['attackedHexesThisPhase', attackedHexesThisPhase],
    ['supplyPhasePlan', supplyPhasePlan],
    ['supplyPhaseInputs', supplyPhaseInputs],
    ['dumpDestructionAttempts', dumpDestructionAttempts],
    ['attritionInputs', attritionInputs],
    ['attritionResults', attritionResults],
    ['oosFedReByDump', oosFedReByDump],
    // ②‴ 账本（回合级 / 专规）
    ['variableExitResolved', variableExitResolved],
    ['frontalReservesClaimed', frontalReservesClaimed],
    ['fuelPool', fuelPool],
    // ③ 待决与预约
    ['specialPending', specialPending],
    ['breakoutReturns', breakoutReturns],
    ['arrivalHexOverrides', arrivalHexOverrides],
  ]

  /**
   * 快照载荷的版本号（字段表变了就递增；`boardSnapshotFits` 靠它把"别的构建写的档"挡在外面）
   *
   * ★ 2（2026-09-18，批 A 切片 3）：字段表新增 9.1c 的两个攻击账本 ⇒ 按本行的纪律递增。
   *   递增的代价是**旧存档一律拒读**（"先验后改"，不会把盘面读成半截）；不递增则更糟：
   *   旧构建读到含新字段的档会**静默丢掉**这两个账本（它的字段表里没有这两项，逐项在场检查放行）。
   */
  const BOARD_SNAPSHOT_VERSION = 2

  /**
   * 抓取盘面快照
   *
   * 逐字段 `JSON.parse(JSON.stringify(…))` 深拷贝：**与落盘同一套语义**（存档本就是 JSON 文本），
   * 于是"内存里往返一次"与"写文件再读回来"完全同构；也保证快照不会随盘面后续改动而变。
   */
  function snapshotBoard(): unknown {
    const fields: Record<string, unknown> = {}
    for (const [key, source] of boardSnapshotFields()) {
      fields[key] = JSON.parse(JSON.stringify(source.value ?? null)) as unknown
    }
    return { version: BOARD_SNAPSHOT_VERSION, fields }
  }

  /**
   * 这份快照**认识**吗（读档时"先验后改"：不认识就拒读，此刻尚未改动任何状态）
   *
   * 判据两条：
   *   ① **版本号**一致（字段表变了就必须递增它）；
   *   ② 字段表**逐项在场**，且每项的种类与该 ref **自身的种类**相容 —— 防"结构改过却忘了递增
   *      版本号"的档混进来（那种档一落值就把 ref 变成另一个形状）。
   *
   * ★ 种类判据对着的是**字段自身**（"这个 ref 本来装什么"），**不是**比"快照 vs 当前值"：
   *   读档时当前盘面往往已被改动过（用例里就是先把 units 清空再读档），拿两者互比会把
   *   "当前是 null / 快照里有对象"这种**正常**情形判成不认识 ⇒ 合法档被拒。故：
   *   · 该 ref 当前是 `null` ⇒ **不约束**（这一族本就是可空的账本：`supplyPhasePlan` / `specialPending`…）；
   *   · 数组 ⇒ 快照必须是数组（这一类从不为 null，故这条足够严）；
   *   · 非空对象 ⇒ 快照必须是非空对象；标量 ⇒ `typeof` 相同。
   */
  function boardSnapshotFits(board: unknown): boolean {
    if (typeof board !== 'object' || board === null) return false
    const payload = board as { version?: unknown; fields?: unknown }
    if (payload.version !== BOARD_SNAPSHOT_VERSION) return false
    if (typeof payload.fields !== 'object' || payload.fields === null) return false
    const table = payload.fields as Record<string, unknown>
    for (const [key, source] of boardSnapshotFields()) {
      if (!(key in table)) return false
      const shape: unknown = source.value
      const next: unknown = table[key]
      if (shape === null) continue
      if (Array.isArray(shape)) {
        if (!Array.isArray(next)) return false
        continue
      }
      if (typeof shape === 'object') {
        if (typeof next !== 'object' || next === null || Array.isArray(next)) return false
        continue
      }
      if (typeof next !== typeof shape) return false
    }
    return true
  }

  /**
   * 还原盘面（调用前必已 `boardSnapshotFits` 通过；本方法不做半途落值）
   *
   * 末尾按**新盘面**重播一次 5.0c 的控制账：它是由"格内有无可攻击单位"推导的，而同一份盘面在
   * 存档那一刻已经播过 ⇒ 对一致盘面是**幂等**的（返回 0，不写日志）；万一份内控制账与盘面不符
   * （手工改档等），这里会把它纠回盘面口径并留痕。
   */
  function restoreBoard(board: unknown): void {
    const table = (board as { fields: Record<string, unknown> }).fields
    for (const [key, target] of boardSnapshotFields()) {
      target.value = JSON.parse(JSON.stringify(table[key])) as unknown
    }
    syncVictoryControlFromBoard()
    pushLog(
      'info',
      `读档：盘面已还原 ${String(boardSnapshotFields().length)} 项（算子 ${String(units.value.length)} 枚 / 补给站 ${String(spDumps.value.length)} 处 / 飞机 ${String(airUnits.value.length)} 架）`,
    )
  }

  /*
   * P0 修复（B48）：把编解码器**注册给会话层**（存/读档时由会话层回调本对函数）。
   * 注册在 setup 末尾：此刻所有被快照的 ref 都已声明（快照的执行发生在存/读档时）。
   * 若本店从未建立（只建会话层的单测），会话层就没有编解码器 ⇒ 存档退回"只有会话"的旧行为。
   */
  session.setBoardCodec({
    capture: snapshotBoard,
    accepts: boardSnapshotFits,
    restore: restoreBoard,
  })

  return {
    activeSide,
    phase,
    segmentLocked,
    turn,
    date,
    seed,
    rng,
    drawCount,
    units,
    selectedId,
    pendingRecord,
    tool,
    lastStep,
    lastBattle,
    log,
    battleTarget,
    battleTerrain,
    battleDefenderArId,
    battleDefenders,
    // C5 移动交互
    moveInteraction,
    moveUnits,
    activeMoveUnits,
    groupReachable,
    stepPreview,
    hoverNode,
    hoverHex,
    pendingZocConfirm,
    stackSelect,
    // C5 堆叠取子（6.1f / 8.1g / 8.1h）
    movePick,
    movePickHex,
    movePickChoices,
    toggleMovePick,
    setMovePickIds,
    setMovePickOnly,
    beginMovePick,
    setMovePickAll,
    cancelMovePick,
    confirmMovePick,
    moveBlocked,
    fuelPool,
    moveRuntime,
    selectedUnit,
    choices,
    moveContext,
    selectedLegality,
    switchSide,
    setActiveSide,
    setPhase,
    setTurn,
    // B9：本环节可参与的算子（灰显/待办计数）与地图内就地提示
    participatingUnitIds,
    participatingUnitCount,
    mapHint,
    // B8：环节进度与统一闸门（界面查表；不参与环节的动作一律拒绝）
    segmentStep,
    segmentSteps,
    playerSegmentSteps,
    segmentStepPosition,
    segmentStepIndex,
    setSegmentStepIndex,
    stepToNextSegmentStep,
    requireAction,
    actionRefusal,
    // B5：唯一「进入下一环节」（自动段连跑完，停到需要玩家的地方）
    advanceSegmentNow,
    pickRecord,
    setTool,
    combatPickActive,
    placeAt,
    removeAt,
    clickHex,
    // C5 动作
    setHoverHex,
    setStackSelect,
    confirmZocEntry,
    dismissZocConfirm,
    undoLastStep,
    cancelWholeMove,
    // B15a：放弃本次移动**并退出移动态**（会话框的取消 / Esc）
    abortMoveNow,
    finishMove,
    // 6.1f：把某枚从正在移动的堆叠里放下（就地停住，其余继续）
    dropUnitFromMove,
    switchUnitMode,
    flipUnitOrientation,
    // 5.7b：E/G 段释放预备（把预备标记摘掉，回朝向面）
    releaseReserveNow,
    payFuel,
    setFuelPool,
    fuelDumpId,
    fuelSourcePartition,
    fuelMethod,
    // 12.5c（用户 2026-09-17）：点谁就决定能点哪一法（可用性 + 原因）
    fuelMethodChoices,
    // 12.5e：HQ 法的投递基点台账（本阶段每指挥部最多一个位置；清理阶段/换回合清空）
    hqFuelThrows,
    formationFuelThrows,
    formationFuelThrowOf,
    fuelFormationCoverage,
    hqFuelThrowOriginOf,
    fuelMethodEffective,
    fuelDumpChoices,
    fuelTargets,
    // B18b：12.5a「耗油且未加注」的单位与"此刻该付油了吗"（地图据此展开燃料段）
    fuelPendingUnits,
    fuelPaymentDue,
    // B18c（12.0）：受补给单位的候选（只有战斗单位需要追溯补给）
    supplyCheckCandidates,
    fuelDump,
    pickFuelDump,
    barrageSupplyDumpId,
    barrageSupplyDumpChoices,
    // G②（10.1b-A）：这批来源里哪些是经 HQ 投递达成的（付款时据此声明"来自同一指挥部"）
    barrageSupplyHqChoices,
    barrageSupplyDump,
    pickBarrageSupplyDump,
    // B14b：阵列里「点同一座站即取消」（旧下拉的"未声明"空档的替代）
    toggleBarrageSupplyDump,
    setUnitFuelled,
    lockZocNegation,
    openBattle,
    resolveBattleNow,
    terrainChoicesAt,
    // C6 战斗交互
    battleMode,
    combatAttackerIds,
    combatState,
    combatError,
    combatInputs,
    combatAwaitingShiftDie,
    combatSurpriseDie,
    combatAttackers,
    combatDefenderSide,
    combatAttackerViews,
    combatDefenderViews,
    combatFacts,
    combatChecklist,
    combatResolver,
    combatRequirement,
    combatOptionLossTargets,
    optionDraftMode,
    optionDraftPoints,
    optionDraftUsed,
    optionDraftRemaining,
    optionDraftEntries,
    optionDraftRetreatPreview,
    attackerWipedNow,
    setOptionDraftMode,
    applyOptionDraftLoss,
    applyOptionDraftRetreat,
    applyOptionDraftRetreatAt,
    undoOptionDraftLast,
    resetOptionDraft,
    concludeCombatAfterWipe,
    combatCanonicalLosses,
    // 批 F 切片 2（9.11a）：拥有者可以把"多受的那一点"改派给谁（候选与提交分配的唯一出处）
    combatLossSwapChoices,
    combatLossAllocationNow,
    combatSummary,
    combatReview,
    combatAttackerArOptions,
    combatDefenderArOptions,
    combatDefenderArChoices,
    nkvdArRequiredNow,
    overrunParticipantIds,
    toggleOverrunParticipant,
    overrunSplitNow,
    combatDefenderTerrainOptions,
    combatStackTerrainOptions,
    defaultArUnitIdOf,
    autoResolveCombatToOutcome,
    combatLiveStep,
    combatAdvanceMandatory,
    combatRetreatRequirement,
    combatDefendingHexCleared,
    combatAdvanceCandidates,
    // B14c：战后推进的算子图阵列（9.12g-A / 9.12b 两条否决转成人话）
    combatAdvanceChoices,
    // W7 C16：战斗收尾的地图优先交互（9.12 撤退落点 / 9.12g 推进格 / 12.4 补给站）
    combatAdvanceHex,
    combatRetreatPlans,
    // W7 C16 + 9.12d：跟随撤退（未参战战斗单位 / 编内卡车）
    combatTagalongIds,
    combatTagalongCandidates,
    toggleCombatTagalong,
    combatSupplyDumps,
    combatSupplyDumpIds,
    setRetreatDestinationNow,
    clearRetreatDestinationNow,
    advanceNow,
    clearAdvanceNow,
    pickCombatSupplyDump,
    clearCombatSupplyDump,
    setBattleMode,
    clearCombat,
    toggleCombatAttacker,
    // B15b：地图摊开的选择集 → 战斗的参与集合（§4.2 的"选择集＝参与集合"）
    syncCombatParticipants,
    toggleCombatSupplyAttacker,
    selectCombatDefenderHex,
    beginCombatNow,
    confirmCombatSupply,
    declareCombatArStep,
    declareCombatTerrainStep,
    rollCombatSurprise,
    rollCombatShiftDie,
    rollCombatDice,
    confirmCombatLosses,
    confirmCombatOptions,
    confirmCombatRetreats,
    confirmCombatAdvance,
    cancelCombat,
    // W7 C16：移动中的突袭（8.0/8.1）
    overrunContext,
    moveStackHex,
    // 4.5a-A（第六批条 14）：停车 ≠ 丧失突袭资格 ⇒ 这两个是突袭候选的唯一来源
    overrunCandidateUnits,
    overrunStackHex,
    moveMinRemainingMp,
    overrunTargets,
    overrunTargetHexes,
    combatAttackableHexes,
    overrunNow,
    overrunZocHeld,
    settleOverrunMove,
    // C7 轰炸交互
    barrageActive,
    barrageKind,
    barrageTargetKind,
    barrageLossTargets,
    barrageAircraftRollTargets,
    barrageUnitIds,
    barrageState,
    hexPickView,
    // 批 E 切片 2：B27 的通用待点格入口**开放给别的 store**（`containers` 的"西移落点"要用它）
    beginHexPick,
    hexPickHint,
    cancelHexPick,
    pickHexFor,
    beginArrivalHexPickNow,
    beginHedgehogHexPickNow,
    beginSpDumpHexPickNow,
    beginSupplySourceHexPickNow,
    beginRailMoveHexPickNow,
    beginSupplyCacheHexPickNow,
    beginFrontalReservesHexPickNow,
    beginAirPlacementHexPickNow,
    beginAirTransferHexPickNow,
    beginAirTargetHexPickNow,
    autoResolveAirMissionNow,
    // 批 C 切片 1：选任务类型即"宣布 + 自动结算到停返航"（一次动作，不再两次确认）
    runAirMissionNow,
    runAirMissionWithKind,
    beginAirReturnHexPickNow,
    beginAirBaseHexPickNow,
    // B27b：最后 6 处"格子编号" → 点地图（值在 store，组件只绑字段）
    rebuildReplHexText,
    convertTargetHexText,
    railGaugeTargetHexText,
    cityControlHexText,
    formationMarkerHexText,
    deadPileReturnHexText,
    beginRebuildReplHexPickNow,
    beginConvertTargetHexPickNow,
    beginRailGaugeTargetHexPickNow,
    beginCityControlHexPickNow,
    beginFormationMarkerHexPickNow,
    beginDeadPileReturnHexPickNow,
    barrageError,
    barrageInputs,
    // A 组接线：10.0e-A/B 的按阶段轰炸账本（界面显示"本阶段已轰炸 N 格 / M 单位"）
    barragePhaseLedger,
    // 批 A 切片 3：9.1c 的按**环节**攻击账本（界面显示"本环节已攻击 N 单位 / M 格"）
    attackPhaseLedger,
    barrageAwaitingHalfDie,
    barrageUnits,
    // B14b：参炸单位 / 参炸飞机的算子图阵列（含逐枚灰显原因）
    barrageUnitChoices,
    barrageAirChoices,
    barrageTargetHex,
    barrageTargetFacts,
    barrageTargetKindIssue,
    barrageChecklist,
    barrageTerrainLineOptions,
    barrageSummary,
    barrageRequiresDefenderInput,
    // C7 空军（10.2b 短程加成的数据源）
    airUnits,
    barrageAirIds,
    airPlacement,
    airUnitChoices,
    barrageAirCandidates,
    barrageAirUnits,
    barrageAirFacts,
    setBarrageActive,
    // 批 A 切片 2：环节驱动的分派事实（界面只读）
    barrageKindsInSegment,
    isBarrageSegment,
    setBarrageKind,
    setBarrageTargetKind,
    toggleBarrageUnit,
    // B15c：地图摊开的选择集 → 参炸名单 / 退掉尚未宣布的选子（§4.2 + §4.3）
    syncBarrageParticipants,
    clearBarrageSelectionNow,
    addAirUnit,
    removeAirUnit,
    // 14.1b：空军军力损失（归零即与地面单位**共用同一个死亡堆**）
    applyAirStepLoss,
    toggleBarrageAirUnit,
    beginBarrageNow,
    confirmBarrageSupplyStep,
    confirmBarrageShiftsStep,
    rollBarrageDiceStep,
    confirmBarrageOutcomeStep,
    cancelBarrage,
    clearBarrage,
    targetKindLabel,
    // C8 补给交互与 SP 管理
    supplyActive,
    carriedSpDumps,
    allSpDumps,
    spDumps,
    spDumpsOfSide,
    supplySourceDecls,
    supplyUnitId,
    supplyUnit,
    supplyState,
    supplyError,
    supplyInputs,
    supplyPreviewIndex,
    supplyChecklist,
    supplySources,
    supplyFocusSource,
    supplyCoverageHexes,
    supplyPayDumpCandidates, // B14d：阵列里「点同一座付款站即回到自动」
    toggleSupplyPayDump,
    supplyOosPayDump,
    supplySummary,
    // 批 B 切片 2（12.3 用途落地 / 裁定⑤「获取即付款」）：本次应付多少 T 及其费率出处
    supplyPickupRequirement,
    supplyFacts,
    spDumpDraft,
    supplySourceDraft,
    setSupplyActive,
    clearSupply,
    addSpDump,
    removeSpDump,
    landSetupSpDumps,
    clearSpDumps,
    setSpDumpHoldings,
    mergeSpDumpHoldings,
    splitSpDumpHoldings,
    addSupplySource,
    removeSupplySource,
    setSupplyPreview,
    beginSupplyCheckNow,
    chooseSupplySourceNow,
    confirmSupplyPickupNow,
    confirmOosResolutionNow,
    cancelSupply,
    // 12.6 / 12.8：全场追溯补给判定（让断补的减半/无 ZOC/突围资格/图标真正全场生效）
    evaluateTraceSupplyNow,
    // C8b：D 段**补给阶段总计划**（12.1–12.2 / 12.6 / 12.8 / 12.10e / 12.11a）
    supplyPhasePlan,
    supplyPhaseInputs,
    supplyPhaseError,
    supplyPhaseAvailableCap,
    planSupplyPhaseNow,
    clearSupplyPhasePlan,
    applySupplyPhaseRecoveryNow,
    applySupplyPhaseFeedingNow,
    forageHints,
    dumpDestructionAttempts,
    destructDumpNow,
    // 12.8b：断补堆叠的损耗掷骰与分摊
    attritionInputs,
    attritionResults,
    setAttritionDie,
    setAttritionAllocation,
    rollAttritionNow,
    applyAttritionNow,
    unitNameOf,
    // 13.2c：运输点数的合并 / 拆分（含编内卡车不得与常规点数合并的限制）
    transportPointsOfSide,
    transportPointInputs,
    toggleTransportMerge,
    mergeTransportPointsNow,
    splitTransportPointNow,
    // 12.7：延补队 ⇄ 运输点数的双向转换
    convertTransportToExtenderNow,
    flipExtenderToTransport,
    // 9.14d：移动阶段的**主动**崩溃（替代常规移动）
    collapseExtenderNow,
    // 16.0b/c：环形工事的修建与缩减（＋专规 1.3a 印刷工事查询）
    hedgehogInputs,
    hedgehogExecutorMode,
    hedgehogEngineerId,
    hedgehogUsesEngineerRoute,
    hedgehogTargetHex,
    hedgehogEngineer,
    hedgehogEngineerLegRange,
    pickedHedgehogEngineer,
    hedgehogError,
    hedgehogTurnLedger,
    hedgehogLevelOf,
    isPrintedHedgehogAt,
    printedHedgehogPositions,
    buildHedgehogNow,
    reduceHedgehogNow,
    // 15.3 / 15.2A：空军基地与简易机场的修建、升格（13.8d 施工前提一并接上）
    constructionInputs,
    constructionError,
    constructionPhaseLedger,
    airBaseTurnLedger,
    // 14.9f / 15.0b-C：本环节各格已空运卸载的 T（界面据此显示还剩多少额度）
    airUnloadLedger,
    airUnloadedTAt,
    engineerChoices,
    canEngineerInPhase,
    airBaseLevelAt,
    airBaseUnitAt,
    airBaseBuildCostSpPerLevel,
    isAirstripAt,
    hexHasAirFacility,
    constructionLegRangeTo,
    constructionGateNow,
    buildAirBaseNow,
    buildAirstripNow,
    upgradeAirstripNow,
    supplySourceKindLabel,
    supplySourceLabel,
    supplyStatusLabel,
    // C9 空军交互
    airActive,
    beginAirBarrageNow,
    airMissionKind,
    airCargoUnitChoices,
    // B44（14.9e）：逐机档位与"是否有 A 档"（14.9f 的例外据此自动成立）
    airTransportProfiles,
    airOverLimitAircraftInactive,
    // B47（12.8e）：突围候选 / 宣布突围 / 返场落位
    breakoutCandidates,
    // B47（12.8e）：突围骰值输入（裁判订正 / 复算用）
    breakoutInputs,
    breakoutNow,
    breakoutReturns,
    deployBreakoutReturnNow,
    toggleAirCargoUnit,
    airCombatAttackerPlanes,
    airCombatDefenderPlanes,
    airCombatRoundBudget,
    airInterceptionDefender,
    airTargetHex,
    airMissionAirIds,
    airState,
    airError,
    airInputs,
    airBases,
    ownAirBases,
    allAirViews,
    ownAirUnits,
    airMissionAirUnits,
    airMissionHasFighter,
    airChecklist,
    airTargetInEnemyPatrolZone,
    airTargetBaseLevel,
    airEnemyAtTarget,
    capturableEnemyAirBases,
    airInterceptionResponse,
    airInterceptorCandidates,
    airPatrolZoneHexes,
    airEnemyPatrolZoneHexes,
    airInactiveAtBase,
    airRefitPayDumps,
    // 15.1 整备交互（点基地 → 勾飞机 → 点地图上的补给付款）
    refitBase,
    refitCandidates,
    refitSelectedIds,
    refitPayDumps,
    airReductionCandidates,
    railSupply,
    railSupplyFacts,
    detrainableHexes,
    // 批 F 切片 3：到货 SP 的落点（专规 2.1 / 3.1 免费铁运 + 3.6 补给列车）
    freeRailCityHexes,
    freeRailCityCandidates,
    freeRailPicked,
    toggleFreeRailPick,
    freeRailEdgeHex,
    pickFreeRailEdgeHex,
    // 图边补给源格（2.1 / 3.1）：到货余额的落点候选，也是 1.1b 安全边缘格的来源
    scenarioSupplySourceHexes,
    supplyArrivalSp,
    supplyTrainSp,
    supplyTrainHex,
    pickSupplyTrainHex,
    freeRailPlan,
    freeRailError,
    lastFreeRailPlan,
    applySupplyArrivalsNow,
    // C9b：轨距账本（13.3f / 专规 1.2）——「谁能用这条铁路」，与 13.3a 多轨的运量费用无关
    convertedRailHexes,
    printedRailGauge,
    convertedRailGauge,
    railGaugeAt,
    isRailGaugeUsableAt,
    seedConvertedRailsNow,
    clearConvertedRailsNow,
    railMoveError,
    railMoveInputs,
    railCapSpentThisTurn,
    railCapRemaining,
    railCapUsedBy,
    railMoveFacts,
    railPathBetween,
    railMoveNow,
    lastRailMove,
    railMovedUnitIdsThisPhase,
    // 13.2f：运输点数的装载 / 卸载
    transportLoadInputs,
    transportLoadError,
    transportPointActorOf,
    loadTransportPointNow,
    unloadTransportPointNow,
    convertRailGaugeNow,
    gaugeConversionsThisPhase,
    // 13.3g-A：本阶段"刚换过轨的格"与"走过这些格的铁路修理单位"（"不能接力"的判据来源）
    convertedHexesThisPhase,
    railMovedNewTrackThisPhase,
    isRailRepairUnit,
    refitDoneBases,
    reducedBases,
    airstripBaseIds,
    lastRefit,
    lastTransfer,
    lastReduction,
    setAirActive,
    clearAir,
    setAirMissionKind,
    setAirTargetFromText,
    toggleAirMissionUnit,
    voluntaryReturnNow,
    airMissionSegment,
    airJoinRemaining,
    // B14：参战机的算子图阵列（逐机可选性 + 原因）
    airMissionJoinChoices,
    anyOwnAircraftReaches,
    toggleAirReductionUnit,
    missionSegmentOf,
    airTargetBaseIsAirstrip,
    toggleAirUnitStatus,
    beginAirMissionNow,
    confirmAirCombatNow,
    airUnitsAt,
    declareInterceptionNow,
    resolveInterceptionCombatNow,
    resolveFlakNow,
    resolveAirCargoNow,
    // 14.4g：防空致容量变化后的货物损失（重算容量 / 勾选摧毁 / 落盘）
    airMissionCargoCapacityNow,
    airCargoLossPending,
    airCargoLossPicked,
    toggleAirCargoLossPick,
    confirmAirCargoLossNow,
    captureAirBaseNow,
    // 9.14：特殊战斗（夺取表 9.14b/c、延补队 9.14d、工事 9.14e、基地 9.14f）
    specialPending,
    specialObjectsAt,
    printedHedgehogOwnerAt,
    resolveSpecialCombatAt,
    toggleSpecialCaptured,
    setSpecialDisplacement,
    confirmSpecialCombatNow,
    cancelSpecialCombatNow,
    confirmAirMissionNow,
    completeAirReturnNow,
    cancelAir,
    toggleAirstripBase,
    refitBaseNow,
    beginRefitNow,
    toggleRefitAircraft,
    cancelRefitNow,
    pickRefitPayDump,
    transferAircraftNow,
    reduceBaseNow,
    airMissionKindLabel,
    airStatusLabel,
    // W6 B18：到达、补员与编制调整
    scenarioId,
    replHoldings,
    deadPile,
    removedForever,
    breakdownPool,
    returnFromDeadPileNow,
    variableReplInputs,
    variableExitResolved,
    variableExitOpen,
    isSavableRepl,
    breakdownAbsorbObligations,
    assessTurnEndVictoryNow,
    turnEndVictory,
    controlOfHex,
    isBreakdownRecord,
    nationalityOfUnit,
    settleAbsorbObligationsNow,
    lastVariableRepl,
    lastRebuild,
    lastConsolidation,
    lastBreakdown,
    reinforcementError,
    arrivalPlan,
    arrivalPlacements,
    ownUnitsOnMap,
    rebuildCandidates,
    rebuildCandidateHexes,
    combatNkvdDefenders,
    combatNkvdForcedLosses,
    setScenarioId,
    setArrivalHexOverride,
    setReplHoldingsNow,
    clearNonSavableReplNow,
    rollVariableReplNow,
    placeArrivalNow,
    applyArrivalRemovalsNow,
    sendToDeadPileNow,
    removeForeverNow,
    rebuildUnitNow,
    consolidateUnitsNow,
    consolidateAircraftNow,
    setBreakdownPoolNow,
    createBreakdownNow,
    absorbBreakdownNow,
    setUnitLockedNow,
    unlockSlowMobilizationNow,
    // 专规 2.3c：方面军预备队（＋1.6c 特殊补员的可用期提示）
    frontalReservesToday,
    frontalReservesClaimed,
    frontalReservesInputs,
    frontalReservesError,
    lastFrontalReserves,
    claimFrontalReservesNow,
    conversionRecordFor,
    // W6 B19：Smolensk 专规机制
    panzerGroupBoundary,
    // 批 F 切片 1：带多轨铁路折线的分界线（判据与渲染共用；初设的默认归属也读它）
    panzerGroupBoundaryWithPath,
    panzerBoundaryPath,
    orshaHex,
    panzerGroupUnitViews,
    panzerGroupObligations,
    panzerObligationActive,
    panzerWrongSideHexes,
    boundaryView,
    exclusiveActionsInStep,
    exclusiveSectionPins,
    panzerGroupAssignments,
    groupOfUnit,
    spDumpPanzerGroups,
    panzerGroupOfDump,
    setDumpPanzerGroupNow,
    panzerGroupUnassignedDumps,
    pendingSpGroupAssignment,
    panzerGroupRulesOn,
    panzerGroupSpGate,
    panzerGroupSpRefusal,
    panzerGroupAssignedCount,
    multiUnitFormationIds,
    supplyTableSpInput,
    panzerGroupSpSplit,
    supplyCacheHoldings,
    supplyCacheInputs,
    lastSupplyCacheUse,
    constructionMarkers,
    constructionMarkerPieces,
    constructionMarkerHexText,
    // 批 D 切片 2（专规 3.5）：二选一与"已拾起"是 **store 字段**（盒内会话框与面板共用同一份）
    constructionMarkerKind,
    constructionMarkerPicked,
    armConstructionMarkerNow,
    beginConstructionMarkerHexPickNow,
    axisControlledCityKeys,
    trainbustingMarks,
    mapCityHexes,
    securityCityViews,
    securityCityDetails,
    securityNeeds,
    activeSupplySourceStatuses,
    railCapToday,
    exclusiveTimings,
    todaysTimings,
    redAirForceAdvisory,
    exclusiveError,
    setPanzerGroupNow,
    setMultiUnitFormationNow,
    addSupplyCacheNow,
    spendSupplyCacheNow,
    setConstructionMarkersNow,
    useConstructionMarkerNow,
    toggleAxisCityControlNow,
    applySecurityNeedsNow,
    // 2.2 末段：H 清理阶段的通用自动清理
    runCleanUpNow,
    hasTrainbustingAt,
    // W6 B20：胜利判定
    victoryHexes,
    victoryLastControl,
    victoryControlOf,
    victorySummary,
    victoryTurnRange,
    decisiveVictory,
    finalVictory,
    atFinalTurn,
    victoryError,
    refreshVictoryControlNow,
    setVictoryControlNow,
    checkVictoryNow,
    rollDice,
    resetAll,
    pushLog,
    isLegal,
  }
})
